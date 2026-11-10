/**
 * SQLite persistence for the resident orchestrator (resident-design.md §8).
 *
 * Path = `<stateDir>/orchestrator.sqlite`, journal mode WAL. The schema is
 * versioned via the `schema_version` table: newer databases refuse to open on
 * an older binary, older databases migrate forward inside one transaction.
 * Audit events (approvals, tool calls) stay in dsh's native session JSONL —
 * this store only holds orchestration state.
 *
 * The prototype (thirdparty/dsh-superagent-prototype) validated node:sqlite on
 * the dsh host; here the personal scenario uses explicit columns instead of
 * JSON blobs so panel queries stay simple and testable.
 */

import { mkdirSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type {
  AttachmentKind,
  ButlerState,
  Message,
  MessageAttachment,
  MessageData,
  MessageDirection,
  MessageKind,
  SourceInstance,
  Ticket,
  TicketRun,
  TicketState,
  Trigger,
  WorkerSession,
} from './domain.ts'

/** Current schema version; bump and add a migration step for every change. */
export const SCHEMA_VERSION = 5

/** Name of the SQLite file inside the stateDir. */
export const DB_FILENAME = 'orchestrator.sqlite'

/** Raised when the database cannot be opened or migrated; message is user-facing. */
export class StoreError extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(reason, options)
    this.name = 'StoreError'
  }
}

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS source_instances (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL,
  cursor TEXT,
  next_run_at TEXT,
  degraded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS source_instances_next_run
  ON source_instances(next_run_at) WHERE next_run_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  at TEXT NOT NULL,
  payload TEXT NOT NULL,
  untrusted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS triggers_at ON triggers(at);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  mandate TEXT NOT NULL,
  origin TEXT NOT NULL,
  state TEXT NOT NULL,
  period TEXT,
  next_run_at TEXT,
  plan TEXT,
  summary TEXT,
  session_id TEXT,
  interrupted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tickets_state ON tickets(state);
CREATE INDEX IF NOT EXISTS tickets_next_run
  ON tickets(next_run_at) WHERE next_run_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS ticket_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS ticket_runs_ticket ON ticket_runs(ticket_id);

CREATE TABLE IF NOT EXISTS worker_sessions (
  ticket_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  last_report TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  ticket_id TEXT,
  type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

/**
 * v2 (ADR-011): the conversation ledger replaces the one-way notification
 * table. `messages` is the only user-facing data source; `butler_state` keeps
 * the resident butler session and its turn state.
 */
const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT,
  text TEXT NOT NULL,
  ticket_id TEXT,
  session_id TEXT,
  source_id TEXT,
  reply_to TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  read INTEGER NOT NULL DEFAULT 0,
  delivered INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS messages_pending_inbound
  ON messages(created_at) WHERE direction = 'in' AND consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS butler_state (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  last_active_at TEXT
);
`

/** v1 → v2 notification rows become outbound messages (types map onto kinds). */
const MIGRATE_V2 = `
INSERT OR IGNORE INTO messages
  (id, direction, kind, title, text, ticket_id, idempotency_key, read, delivered, created_at)
SELECT
  id,
  'out',
  CASE type
    WHEN 'awaiting_approval' THEN 'approval'
    WHEN 'result' THEN 'report'
    ELSE type
  END,
  title,
  body,
  ticket_id,
  idempotency_key,
  read,
  delivered,
  created_at
FROM notifications;
DROP TABLE notifications;
`

/**
 * v3 (ADR-011 delegation workspace): a ticket records the canonical workspace
 * path its worker executes under. NULL keeps the legacy behaviour (the
 * process-level workspace root).
 */
const MIGRATE_V3 = `ALTER TABLE tickets ADD COLUMN workspace TEXT;`

/**
 * v4 (WeChat-style message surface): messages carry attachments — images,
 * videos, audio and documents. Rows live in their own table so the host can
 * serve one by id without scanning message JSON; the chat API hydrates them
 * back onto each message.
 */
const MIGRATE_V4 = `
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT,
  url TEXT,
  mime TEXT,
  size INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message_id);
`

/**
 * v5 (perception B12′): `messages.data` carries machine-readable envelope
 * metadata (receipt outcome/runId/artifacts, event code/trust, approval id).
 * The chat UI and AG-UI never render it — it feeds the butler's model context.
 */
const MIGRATE_V5 = `ALTER TABLE messages ADD COLUMN data TEXT;`

interface TicketRow {
  id: string
  goal: string
  mandate: 'explicit' | 'inferred'
  origin: string
  state: string
  period: string | null
  next_run_at: string | null
  plan: string | null
  summary: string | null
  workspace: string | null
  session_id: string | null
  interrupted: number
  created_at: string
  updated_at: string
}

function rowToTicket(row: TicketRow): Ticket {
  return {
    id: row.id,
    goal: row.goal,
    mandate: row.mandate,
    origin: row.origin,
    state: row.state as TicketState,
    ...(row.period ? { period: JSON.parse(row.period) as Ticket['period'] } : {}),
    nextRunAt: row.next_run_at,
    ...(row.plan !== null ? { plan: row.plan } : {}),
    ...(row.summary !== null ? { summary: row.summary } : {}),
    ...(row.workspace !== null ? { workspace: row.workspace } : {}),
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
    ...(row.interrupted ? { interrupted: true } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToMessage(row: Record<string, SQLInputValue>): Message {
  const refs = {
    ...(row.ticket_id !== null ? { ticketId: String(row.ticket_id) } : {}),
    ...(row.session_id !== null ? { sessionId: String(row.session_id) } : {}),
    ...(row.source_id !== null ? { sourceId: String(row.source_id) } : {}),
    ...(row.reply_to !== null ? { replyTo: String(row.reply_to) } : {}),
  }
  return {
    id: String(row.id),
    direction: String(row.direction) as MessageDirection,
    kind: String(row.kind) as MessageKind,
    ...(row.title !== null ? { title: String(row.title) } : {}),
    text: String(row.text),
    ...(Object.keys(refs).length > 0 ? { refs } : {}),
    ...(row.data !== null ? { data: JSON.parse(String(row.data)) as MessageData } : {}),
    idempotencyKey: String(row.idempotency_key),
    read: Number(row.read) === 1,
    delivered: Number(row.delivered) === 1,
    consumedAt: row.consumed_at === null ? null : String(row.consumed_at),
    createdAt: String(row.created_at),
  }
}

function rowToAttachment(row: Record<string, SQLInputValue>): MessageAttachment {
  return {
    id: String(row.id),
    kind: String(row.kind) as AttachmentKind,
    name: String(row.name),
    ...(row.path !== null ? { path: String(row.path) } : {}),
    ...(row.url !== null ? { url: String(row.url) } : {}),
    ...(row.mime !== null ? { mime: String(row.mime) } : {}),
    ...(row.size !== null ? { size: Number(row.size) } : {}),
  }
}

/**
 * Open (or create) the orchestrator database and expose typed repositories.
 * Instances are cheap to create in tests and expensive enough in production
 * that the plugin keeps exactly one, closed on context dispose.
 */
export class Store {
  readonly db: DatabaseSync

  private constructor(db: DatabaseSync) {
    this.db = db
  }

  /**
   * Open the database at `<stateDir>/orchestrator.sqlite`, applying pragmas
   * and schema migrations. The directory is created with owner-only rights.
   * @throws StoreError when the schema is newer than this binary or migration fails.
   */
  static open(stateDir: string): Store {
    const path = join(stateDir, DB_FILENAME)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(path)
    const store = new Store(db)
    try {
      chmodSync(path, 0o600)
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON')
      store.migrate()
      return store
    } catch (error) {
      db.close()
      throw error
    }
  }

  /** Reads the stored schema version (0 = fresh database). */
  schemaVersion(): number {
    const has = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
      .get()
    if (!has) return 0
    const row = this.db.prepare('SELECT version FROM schema_version').get() as
      | { version: number }
      | undefined
    return row?.version ?? 0
  }

  /** Applies migrations inside one transaction; leaves the file untouched on failure. */
  private migrate(): void {
    const version = this.schemaVersion()
    if (version > SCHEMA_VERSION) {
      throw new StoreError(
        `orchestrator database schema v${version} is newer than this build supports (v${SCHEMA_VERSION}); ` +
          'upgrade HiBuddy before reusing this state directory',
      )
    }
    if (version === SCHEMA_VERSION) return
    try {
      this.transaction(() => {
        this.db.exec(SCHEMA_V1)
        if (version < 2) {
          this.db.exec(SCHEMA_V2)
          // Fresh databases also pass through V1, so the source table exists.
          this.db.exec(MIGRATE_V2)
        }
        if (version < 3) this.db.exec(MIGRATE_V3)
        if (version < 4) this.db.exec(MIGRATE_V4)
        if (version < 5) this.db.exec(MIGRATE_V5)
        this.db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
        const existing = this.db.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as {
          n: number
        }
        if (existing.n === 0) {
          this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION)
        } else {
          this.db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION)
        }
      })
    } catch (error) {
      throw new StoreError(
        `orchestrator database migration from v${version} to v${SCHEMA_VERSION} failed: ` +
          (error instanceof Error ? error.message : String(error)),
        { cause: error },
      )
    }
  }

  /**
   * Runs `operation` inside a transaction (nested calls become savepoints);
   * a failure rolls the level back and rethrows.
   */
  transaction<T>(operation: () => T): T {
    if (this.inTransaction) {
      const name = `resident_sp_${this.depth++}`
      this.db.exec(`SAVEPOINT ${name}`)
      try {
        const value = operation()
        this.db.exec(`RELEASE ${name}`)
        return value
      } catch (error) {
        this.db.exec(`ROLLBACK TO ${name}`)
        this.db.exec(`RELEASE ${name}`)
        throw error
      } finally {
        this.depth--
      }
    }
    this.inTransaction = true
    try {
      this.db.exec('BEGIN')
      const value = operation()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // connection already unwinding; the outer failure matters more
      }
      throw error
    } finally {
      this.inTransaction = false
    }
  }

  private depth = 0
  private inTransaction = false

  close(): void {
    this.db.close()
  }

  // ── source_instances ────────────────────────────────────────────────────

  upsertSource(source: SourceInstance): void {
    this.db
      .prepare(
        `INSERT INTO source_instances (id, kind, enabled, config, cursor, next_run_at, degraded)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, enabled=excluded.enabled,
           config=excluded.config, cursor=excluded.cursor, next_run_at=excluded.next_run_at,
           degraded=excluded.degraded`,
      )
      .run(
        source.id,
        source.kind,
        source.enabled ? 1 : 0,
        JSON.stringify(source.config ?? null),
        source.cursor === undefined ? null : JSON.stringify(source.cursor),
        source.nextRunAt ?? null,
        source.degraded ? 1 : 0,
      )
  }

  getSource(id: string): SourceInstance | undefined {
    const row = this.db.prepare('SELECT * FROM source_instances WHERE id = ?').get(id) as
      | Record<string, SQLInputValue>
      | undefined
    if (!row) return undefined
    return {
      id: String(row.id),
      kind: String(row.kind),
      enabled: Number(row.enabled) === 1,
      config: JSON.parse(String(row.config)),
      ...(row.cursor !== null ? { cursor: JSON.parse(String(row.cursor)) } : {}),
      nextRunAt: row.next_run_at === null ? null : String(row.next_run_at),
      degraded: Number(row.degraded) === 1,
    }
  }

  listSources(): SourceInstance[] {
    const rows = this.db
      .prepare('SELECT id FROM source_instances ORDER BY rowid')
      .all() as Array<{ id: string }>
    return rows.map((row) => this.getSource(row.id)!)
  }

  // ── triggers ────────────────────────────────────────────────────────────

  saveTrigger(trigger: Trigger): void {
    this.db
      .prepare(
        'INSERT INTO triggers (id, source_id, at, payload, untrusted) VALUES (?, ?, ?, ?, ?)' +
          ' ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, at=excluded.at',
      )
      .run(
        trigger.id,
        trigger.sourceId,
        trigger.at,
        JSON.stringify(trigger.payload ?? null),
        trigger.untrusted ? 1 : 0,
      )
  }

  listTriggers(sourceId?: string): Trigger[] {
    const rows = (
      sourceId
        ? this.db.prepare('SELECT * FROM triggers WHERE source_id = ? ORDER BY at').all(sourceId)
        : this.db.prepare('SELECT * FROM triggers ORDER BY at').all()
    ) as Array<Record<string, SQLInputValue>>
    return rows.map((row) => ({
      id: String(row.id),
      sourceId: String(row.source_id),
      at: String(row.at),
      payload: JSON.parse(String(row.payload)),
      untrusted: Number(row.untrusted) === 1,
    }))
  }

  // ── tickets ─────────────────────────────────────────────────────────────

  upsertTicket(ticket: Ticket): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO tickets (id, goal, mandate, origin, state, period, next_run_at, plan,
            summary, workspace, session_id, interrupted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET goal=excluded.goal, mandate=excluded.mandate,
           origin=excluded.origin, state=excluded.state, period=excluded.period,
           next_run_at=excluded.next_run_at, plan=excluded.plan, summary=excluded.summary,
           workspace=excluded.workspace,
           session_id=excluded.session_id, interrupted=excluded.interrupted,
           updated_at=excluded.updated_at`,
      )
      .run(
        ticket.id,
        ticket.goal,
        ticket.mandate,
        ticket.origin,
        ticket.state,
        ticket.period ? JSON.stringify(ticket.period) : null,
        ticket.nextRunAt ?? null,
        ticket.plan ?? null,
        ticket.summary ?? null,
        ticket.workspace ?? null,
        ticket.sessionId ?? null,
        ticket.interrupted ? 1 : 0,
        ticket.createdAt ?? now,
        ticket.updatedAt ?? now,
      )
  }

  getTicket(id: string): Ticket | undefined {
    const row = this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as
      | TicketRow
      | undefined
    return row ? rowToTicket(row) : undefined
  }

  listTickets(state?: TicketState): Ticket[] {
    const rows = (
      state
        ? this.db.prepare('SELECT * FROM tickets WHERE state = ? ORDER BY rowid').all(state)
        : this.db.prepare('SELECT * FROM tickets ORDER BY rowid').all()
    ) as unknown as TicketRow[]
    return rows.map(rowToTicket)
  }

  // ── ticket_runs ─────────────────────────────────────────────────────────

  startRun(ticketId: string, startedAt: string, detail?: string): number {
    const result = this.db
      .prepare('INSERT INTO ticket_runs (ticket_id, started_at, detail) VALUES (?, ?, ?)')
      .run(ticketId, startedAt, detail ?? null)
    return Number(result.lastInsertRowid)
  }

  finishRun(runId: number, finishedAt: string, outcome: string, detail?: string): void {
    this.db
      .prepare('UPDATE ticket_runs SET finished_at = ?, outcome = ?, detail = ? WHERE id = ?')
      .run(finishedAt, outcome, detail ?? null, runId)
  }

  listRuns(ticketId: string): TicketRun[] {
    const rows = this.db
      .prepare('SELECT * FROM ticket_runs WHERE ticket_id = ? ORDER BY id')
      .all(ticketId) as Array<Record<string, SQLInputValue>>
    return rows.map((row) => ({
      id: Number(row.id),
      ticketId: String(row.ticket_id),
      startedAt: String(row.started_at),
      finishedAt: row.finished_at === null ? null : String(row.finished_at),
      outcome: row.outcome === null ? null : String(row.outcome),
      detail: row.detail === null ? undefined : String(row.detail),
    }))
  }

  // ── worker_sessions ─────────────────────────────────────────────────────

  upsertWorkerSession(session: WorkerSession): void {
    this.db
      .prepare(
        `INSERT INTO worker_sessions (ticket_id, session_id, state, last_report, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(ticket_id) DO UPDATE SET session_id=excluded.session_id,
           state=excluded.state, last_report=excluded.last_report, updated_at=excluded.updated_at`,
      )
      .run(
        session.ticketId,
        session.sessionId,
        session.state,
        session.lastReport ?? null,
        new Date().toISOString(),
      )
  }

  getWorkerSession(ticketId: string): WorkerSession | undefined {
    const row = this.db
      .prepare('SELECT * FROM worker_sessions WHERE ticket_id = ?')
      .get(ticketId) as Record<string, SQLInputValue> | undefined
    if (!row) return undefined
    return {
      ticketId: String(row.ticket_id),
      sessionId: String(row.session_id),
      state: String(row.state),
      ...(row.last_report !== null ? { lastReport: String(row.last_report) } : {}),
      updatedAt: String(row.updated_at),
    }
  }

  listWorkerSessions(): WorkerSession[] {
    const rows = this.db.prepare('SELECT * FROM worker_sessions ORDER BY rowid').all() as Array<
      Record<string, SQLInputValue>
    >
    return rows.map((row) => ({
      ticketId: String(row.ticket_id),
      sessionId: String(row.session_id),
      state: String(row.state),
      ...(row.last_report !== null ? { lastReport: String(row.last_report) } : {}),
      updatedAt: String(row.updated_at),
    }))
  }

  // ── messages (ADR-011: the conversation ledger) ──────────────────────────

  /**
   * Persists a message; a repeated idempotency key is dropped (FR-10 rule 3).
   * @returns true when the message was newly recorded.
   */
  addMessage(message: Message): boolean {
    return this.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT INTO messages (id, direction, kind, title, text, ticket_id, session_id,
              source_id, reply_to, idempotency_key, read, delivered, consumed_at, created_at, data)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(idempotency_key) DO NOTHING`,
        )
        .run(
          message.id,
          message.direction,
          message.kind,
          message.title ?? null,
          message.text,
          message.refs?.ticketId ?? null,
          message.refs?.sessionId ?? null,
          message.refs?.sourceId ?? null,
          message.refs?.replyTo ?? null,
          message.idempotencyKey,
          message.read ? 1 : 0,
          message.delivered ? 1 : 0,
          message.consumedAt ?? null,
          message.createdAt,
          message.data === undefined ? null : JSON.stringify(message.data),
        )
      if (Number(result.changes) === 0) return false
      const insertAttachment = this.db.prepare(
        `INSERT INTO attachments (id, message_id, kind, name, path, url, mime, size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const attachment of message.attachments ?? []) {
        insertAttachment.run(
          attachment.id,
          message.id,
          attachment.kind,
          attachment.name,
          attachment.path ?? null,
          attachment.url ?? null,
          attachment.mime ?? null,
          attachment.size ?? null,
          message.createdAt,
        )
      }
      return true
    })
  }

  /** Hydrates the attachment rows for a list of message ids. */
  private attachmentsByMessage(ids: readonly string[]): Map<string, MessageAttachment[]> {
    const grouped = new Map<string, MessageAttachment[]>()
    if (ids.length === 0) return grouped
    const placeholders = ids.map(() => '?').join(', ')
    const rows = this.db
      .prepare(`SELECT * FROM attachments WHERE message_id IN (${placeholders}) ORDER BY rowid`)
      .all(...ids) as Array<Record<string, SQLInputValue>>
    for (const row of rows) {
      const messageId = String(row.message_id)
      const list = grouped.get(messageId) ?? []
      list.push(rowToAttachment(row))
      grouped.set(messageId, list)
    }
    return grouped
  }

  /** One attachment by id (the host's file-serving route); with its owner message. */
  getAttachment(id: string): (MessageAttachment & { messageId: string }) | undefined {
    const row = this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as
      | Record<string, SQLInputValue>
      | undefined
    return row === undefined ? undefined : { ...rowToAttachment(row), messageId: String(row.message_id) }
  }

  listMessages(
    options: {
      direction?: MessageDirection
      unreadOnly?: boolean
      undeliveredOnly?: boolean
      /** Oldest-first when true (chat replay); newest-first by default (inbox). */
      oldestFirst?: boolean
      limit?: number
    } = {},
  ): Message[] {
    const { direction, unreadOnly = false, undeliveredOnly = false, oldestFirst = false } = options
    const limit = options.limit ?? 200
    const filters = [
      direction ? 'direction = ?' : undefined,
      unreadOnly ? 'read = 0' : undefined,
      undeliveredOnly ? 'delivered = 0' : undefined,
    ].filter(Boolean)
    const where = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : ''
    const order = oldestFirst ? 'ASC' : 'DESC'
    const params: SQLInputValue[] = []
    if (direction) params.push(direction)
    params.push(limit)
    const rows = this.db
      .prepare(`SELECT * FROM messages${where} ORDER BY rowid ${order} LIMIT ?`)
      .all(...params) as Array<Record<string, SQLInputValue>>
    return this.hydrateAttachments(rows.map(rowToMessage))
  }

  /** Inbound messages no butler turn has consumed yet, oldest first (the queue). */
  listPendingInbound(limit = 100): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE direction = 'in' AND consumed_at IS NULL
         ORDER BY rowid ASC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, SQLInputValue>>
    return this.hydrateAttachments(rows.map(rowToMessage))
  }

  /** Attaches the attachment rows to messages loaded from the ledger. */
  private hydrateAttachments(messages: Message[]): Message[] {
    if (messages.length === 0) return messages
    const grouped = this.attachmentsByMessage(messages.map((message) => message.id))
    if (grouped.size === 0) return messages
    return messages.map((message) => {
      const attachments = grouped.get(message.id)
      return attachments === undefined ? message : { ...message, attachments }
    })
  }

  countPendingInbound(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE direction = 'in' AND consumed_at IS NULL")
      .get() as { n: number }
    return row.n
  }

  /** Marks inbound rows consumed by a butler turn (the queue cursor). */
  markInboundConsumed(ids: readonly string[], at: string): number {
    if (ids.length === 0) return 0
    const statement = this.db.prepare(
      'UPDATE messages SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL',
    )
    let changed = 0
    this.transaction(() => {
      for (const id of ids) changed += Number(statement.run(at, id).changes)
    })
    return changed
  }

  markMessageRead(id: string): void {
    this.db.prepare('UPDATE messages SET read = 1 WHERE id = ?').run(id)
  }

  /** Unread count — the chat badge source. */
  countUnreadMessages(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE read = 0').get() as {
      n: number
    }
    return row.n
  }

  /** Delivery state — false only while the row is recorded but not yet pushed. */
  markMessageDelivered(id: string, delivered = true): void {
    this.db.prepare('UPDATE messages SET delivered = ? WHERE id = ?').run(delivered ? 1 : 0, id)
  }

  markAllMessagesRead(): void {
    this.db.prepare('UPDATE messages SET read = 1').run()
  }

  /** Clears delivery flags so restart can re-reach the user (§8 step 3). */
  redeliverMessages(predicate: (m: Message) => boolean): number {
    const pending = this.listMessages({ limit: 1000 }).filter((m) => !m.read && predicate(m))
    for (const message of pending) {
      this.db.prepare('UPDATE messages SET delivered = 0 WHERE id = ?').run(message.id)
    }
    return pending.length
  }

  // ── butler_state ────────────────────────────────────────────────────────

  getButlerState(): ButlerState | undefined {
    const row = this.db.prepare("SELECT * FROM butler_state WHERE id = 'butler'").get() as
      | Record<string, SQLInputValue>
      | undefined
    if (!row) return undefined
    return {
      sessionId: String(row.session_id),
      state: String(row.state),
      lastActiveAt: row.last_active_at === null ? null : String(row.last_active_at),
    }
  }

  upsertButlerState(state: ButlerState): void {
    this.db
      .prepare(
        `INSERT INTO butler_state (id, session_id, state, last_active_at) VALUES ('butler', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, state=excluded.state,
           last_active_at=excluded.last_active_at`,
      )
      .run(state.sessionId, state.state, state.lastActiveAt ?? null)
  }

  // ── settings ────────────────────────────────────────────────────────────

  getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row ? (JSON.parse(row.value) as T) : undefined
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?)' +
          ' ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value))
  }
}
