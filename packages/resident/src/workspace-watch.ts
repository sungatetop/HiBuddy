/**
 * Workspace-watch event source — the L2 perception surface's first SourceKind
 * (ADR-012; butler-perception-design §7).
 *
 * Watches file additions/modifications inside a registered dsh workspace.
 * DECISION D1: `fs.watch` is NOT the source of truth — it only pulls the
 * instance's next scan forward (debounced); the facts always come from a
 * deterministic directory sweep (fingerprints, dedup, trigger emission). A
 * platform without recursive watch (Linux) silently degrades to sweep-only.
 *
 * DECISION D2: the watch path must live under a registered dsh workspace root
 * (canonical + prefix boundary, same discipline as attachments). Configs that
 * fail validation retry on a slow cadence (no backoff — a panel bug, not a
 * transient failure), mirroring the monitor source.
 *
 * DECISION D3: per-file fingerprint = sha256(relPath + size + mtimeMs)[:16];
 * the cursor persists a path→fingerprint map that converges with each sweep
 * (disappeared paths drop out), so a restart never replays old changes.
 *
 * DECISION D4: noise filtering is deterministic — symlinks, hidden entries,
 * structural noise (node_modules/.git/...), temp/incomplete patterns; files
 * only (a directory appears through its first file); depth ≤ 4 and the
 * tracked set is capped (over-cap files are invisible and noted once).
 *
 * DECISION D5: one sweep's changes aggregate into a SINGLE trigger — details
 * capped at 20 rows (mtime desc) + total count + an aggregate fingerprint
 * (sorted per-file fingerprints hashed together); `untrusted` is set because
 * file names themselves may carry injection payloads.
 */

import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readdirSync, watch as fsWatch, type FSWatcher } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { inside } from './attachments.ts'
import type { SourceInstance, Trigger } from './domain.ts'
import type { SourceKind, TriggerEmitter } from './sources.ts'
import type { Store } from './store.ts'

/** Fallback sweep cadence when no watcher fires (or none could be opened). */
export const SWEEP_INTERVAL_MS = 60_000

/** Minimum gap between watcher-triggered pull-forwards (debounce). */
export const WATCH_DEBOUNCE_MS = 1_000

/** Retry cadence while the instance config cannot be used at all. */
const INVALID_CONFIG_RETRY_MS = 60_000

/** Sweep depth cap (artifacts.ts precedent). */
const MAX_DEPTH = 4

/** Sweep breadth cap; beyond this the walk stops. */
const MAX_FILES_SCANNED = 5000

/** Cursor/trigger tracking cap; over-cap files stay invisible (D4). */
const MAX_TRACKED = 2000

/** Change-detail rows per aggregated trigger; the rest are counted only. */
const MAX_EVENTS = 20

/** Structural noise directories (never watched through). */
const NOISE_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', '__pycache__', '.cache'])

/** Temp / incomplete files that never reach the model. */
const NOISE_FILE_PATTERNS: RegExp[] = [/^~\$/, /\.tmp$/i, /\.swp$/, /\.part$/, /\.crdownload$/i, /^thumbs\.db$/i, /^\.ds_store$/i]

/** Watch instance configuration (stored as `source_instances.config`). */
export interface WorkspaceWatchConfig {
  /** Display name (panel, notifications). */
  name?: string
  /** Directory to watch; must live under a registered dsh workspace root. */
  path: string
  /** Natural-language condition weighed by the assessment ("when to care"). */
  condition: string
  /** Ticket goal override for auto-mode; default derived from the changes. */
  goal?: string
}

/** Watch read position (stored as `source_instances.cursor`). */
export interface WorkspaceWatchCursor {
  /** Absent before the first sweep — the first sweep only builds the baseline. */
  fingerprints?: Record<string, string>
  lastScanAt?: string
}

/** Validate a raw instance config; undefined when unusable. */
export function parseWatchConfig(config: unknown): WorkspaceWatchConfig | undefined {
  if (typeof config !== 'object' || config === null) return undefined
  const raw = config as Record<string, unknown>
  if (typeof raw.path !== 'string' || raw.path.trim() === '') return undefined
  if (typeof raw.condition !== 'string' || raw.condition.trim() === '') return undefined
  const parsed: WorkspaceWatchConfig = { path: raw.path, condition: raw.condition }
  if (typeof raw.name === 'string' && raw.name.trim() !== '') parsed.name = raw.name
  if (typeof raw.goal === 'string' && raw.goal.trim() !== '') parsed.goal = raw.goal
  return parsed
}

/** Parse a stored cursor; tolerant of foreign/legacy shapes. */
export function parseWatchCursor(cursor: unknown): WorkspaceWatchCursor {
  if (typeof cursor !== 'object' || cursor === null) return {}
  const raw = cursor as Record<string, unknown>
  const parsed: WorkspaceWatchCursor = {}
  if (typeof raw.lastScanAt === 'string') parsed.lastScanAt = raw.lastScanAt
  if (typeof raw.fingerprints === 'object' && raw.fingerprints !== null) {
    const map: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw.fingerprints as Record<string, unknown>)) {
      if (typeof value === 'string') map[key] = value
    }
    parsed.fingerprints = map
  }
  return parsed
}

/** Aggregated change payload emitted as the trigger payload (D5). */
export interface WorkspaceChangePayload {
  /** Watch root as configured (display form). */
  path: string
  condition: string
  /** Aggregate fingerprint over all changed files (idempotency key source). */
  fingerprint: string
  /** Total changed files (events array is capped at 20). */
  total: number
  /** Change details, most recent first. */
  events: Array<{ path: string; change: 'added' | 'modified'; size: number; mtime: string }>
  /** Human-readable evidence summary for the assessment. */
  rationale: string
}

/** One per-file fingerprint (D3: relPath + size + mtimeMs). */
export function fingerprintOfFile(relativePath: string, size: number, mtimeMs: number): string {
  return createHash('sha256').update(`${relativePath}|${size}|${mtimeMs}`).digest('hex').slice(0, 16)
}

/** Aggregate fingerprint: per-file fingerprints sorted, joined, hashed (D5). */
export function aggregateFingerprint(perFile: readonly string[]): string {
  return createHash('sha256').update([...perFile].sort().join('\n')).digest('hex').slice(0, 16)
}

/** Deterministic noise filter (D4): true = skip this entry entirely. */
export function isNoise(name: string, isDirectory: boolean): boolean {
  if (name.startsWith('.')) return true
  if (isDirectory) return NOISE_DIRS.has(name)
  return NOISE_FILE_PATTERNS.some((pattern) => pattern.test(name))
}

/** A live directory watcher; `close` must be idempotent. */
export interface DirWatcher {
  close(): void
}

/**
 * Watcher factory abstraction. The default uses `fs.watch(recursive)` and
 * swallows its errors (the sweep remains the source of truth); a platform
 * without recursive support throws synchronously — the source degrades to
 * sweep-only. Tests inject a fake to drive onChange deterministically.
 */
export type WatchFactory = (dir: string, onChange: () => void) => DirWatcher

export function defaultWatchFactory(dir: string, onChange: () => void): DirWatcher {
  const watcher: FSWatcher = fsWatch(dir, { recursive: true }, () => onChange())
  watcher.on('error', () => {
    // Watcher loss must never break the host — the sweep still runs.
  })
  return { close: () => watcher.close() }
}

export interface WorkspaceWatchSourceOptions {
  /** Canonical dsh workspace roots the watch path must live under (D2). */
  roots: () => readonly string[]
  /** Poll cadence in ms (default 1000 — an indexed query, monitor precedent). */
  tickMs?: number
  /** Fallback sweep interval override (tests). */
  sweepIntervalMs?: number
  /** Watcher factory override (tests). */
  watchFactory?: WatchFactory
  /** Injectable clock for determinism in tests. */
  now?: () => Date
}

/** One discovered file (relative path + metadata), in sweep order. */
interface DiscoveredFile {
  relativePath: string
  size: number
  mtimeMs: number
}

/**
 * The registered `watch` kind. Same skeleton as MonitorSource: armed map +
 * shared tick over `source_instances.next_run_at` + in-flight guard; on top
 * of that one `fs.watch(recursive)` handle per armed instance pulls scans
 * forward (D1).
 */
export class WorkspaceWatchSource implements SourceKind {
  readonly kind = 'watch'

  private readonly store: Store
  private readonly options: WorkspaceWatchSourceOptions
  private readonly tickMs: number
  private readonly sweepIntervalMs: number
  private readonly now: () => Date
  private readonly armed = new Map<string, TriggerEmitter>()
  private readonly inflight = new Set<string>()
  private readonly watchers = new Map<string, DirWatcher>()
  /** Last watcher-triggered pull-forward per instance (debounce state). */
  private readonly lastPull = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(store: Store, options: WorkspaceWatchSourceOptions) {
    this.store = store
    this.options = options
    this.tickMs = options.tickMs ?? 1000
    this.sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS
    this.now = options.now ?? (() => new Date())
  }

  start(instance: SourceInstance, emit: TriggerEmitter): void {
    this.armed.set(instance.id, emit)
    this.ensureTimer()
    // NOTE: the watcher is NOT opened here. startAll runs during plugin apply,
    // before the butler (and its workspace registry) is ready — `roots()` is
    // necessarily empty at that point, so the D2 check would fail and the
    // watcher would never open. Instead the first successful scan opens it
    // (ensureWatcher, idempotent); the deterministic sweep is the source of
    // truth either way (D1).
  }

  stop(instanceId: string): void {
    this.armed.delete(instanceId)
    this.closeWatcher(instanceId)
    if (this.armed.size === 0 && this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** Disarm everything (dispose path / test teardown). */
  stopAll(): void {
    this.armed.clear()
    for (const id of [...this.watchers.keys()]) this.closeWatcher(id)
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** True while the instance is armed (tests / panel diagnostics). */
  isArmed(instanceId: string): boolean {
    return this.armed.has(instanceId)
  }

  /** Start the shared tick timer once; scan crashes never kill the host. */
  private ensureTimer(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        console.error('[hibuddy-resident] watch tick failed:', error)
      })
    }, this.tickMs)
    this.timer.unref?.()
  }

  /**
   * One scheduling pass over armed instances. Returns a promise that settles
   * with all scans launched by this pass (tests await it for determinism).
   */
  async tick(): Promise<void> {
    const nowIso = this.now().toISOString()
    const launched: Array<Promise<void>> = []
    for (const [id, emit] of this.armed) {
      if (this.inflight.has(id)) continue
      const instance = this.store.getSource(id)
      if (!instance || !instance.enabled) continue
      if (instance.nextRunAt && instance.nextRunAt > nowIso) continue
      this.inflight.add(id)
      launched.push(
        this.scanInstance(instance, emit)
          .catch((error) => {
            console.error(`[hibuddy-resident] watch ${id} scan crashed:`, errorMessage(error))
          })
          .finally(() => this.inflight.delete(id)),
      )
    }
    await Promise.allSettled(launched)
  }

  /**
   * Open the fs watcher for a valid, in-workspace instance (D1/D2). Idempotent
   * per instance; called from the scan path so a workspace registered (or the
   * butler cache loaded) after plugin apply still gets its watcher.
   */
  private ensureWatcher(instance: SourceInstance): void {
    if (this.watchers.has(instance.id)) return
    const config = parseWatchConfig(instance.config)
    if (!config || !this.insideWorkspace(config.path)) return
    try {
      const watcher = (this.options.watchFactory ?? defaultWatchFactory)(config.path, () => this.pullForward(instance.id))
      this.watchers.set(instance.id, watcher)
    } catch (error) {
      // Linux without recursive watch (or a vanished dir): sweep-only, D1/A2.
      console.warn(`[hibuddy-resident] watch ${instance.id} fell back to sweep-only: ${errorMessage(error)}`)
    }
  }

  private closeWatcher(instanceId: string): void {
    this.watchers.get(instanceId)?.close()
    this.watchers.delete(instanceId)
    this.lastPull.delete(instanceId)
  }

  /**
   * Watcher callback (D1): pull the instance's next scan to now, debounced.
   * Reads the CURRENT row first — armed snapshots go stale on cursor writes.
   */
  private pullForward(instanceId: string): void {
    const nowMs = this.now().getTime()
    const last = this.lastPull.get(instanceId)
    if (last !== undefined && nowMs - last < WATCH_DEBOUNCE_MS) return
    this.lastPull.set(instanceId, nowMs)
    const current = this.store.getSource(instanceId)
    if (!current || !current.enabled || !this.armed.has(instanceId)) return
    this.store.upsertSource({ ...current, nextRunAt: new Date(nowMs).toISOString() })
  }

  /** One scan round: validate → sweep → diff cursor → aggregate → emit. */
  private async scanInstance(instance: SourceInstance, emit: TriggerEmitter): Promise<void> {
    const now = this.now()
    const nowIso = now.toISOString()
    const config = parseWatchConfig(instance.config)
    const cursor = parseWatchCursor(instance.cursor)

    if (!config) {
      console.warn(`[hibuddy-resident] watch ${instance.id} has an invalid config; retrying in ${INVALID_CONFIG_RETRY_MS / 1000}s`)
      this.saveSource(instance, cursor, nowIso, INVALID_CONFIG_RETRY_MS, instance.degraded === true)
      return
    }
    if (!this.insideWorkspace(config.path)) {
      // D2 violation (or workspace unregistered since): not a transient
      // failure — slow retry, no backoff, surfaced via the log.
      console.warn(`[hibuddy-resident] watch ${instance.id} path is outside every registered workspace; retrying in ${INVALID_CONFIG_RETRY_MS / 1000}s`)
      this.saveSource(instance, cursor, nowIso, INVALID_CONFIG_RETRY_MS, instance.degraded === true)
      return
    }

    let files: DiscoveredFile[]
    let truncated: boolean
    try {
      ({ files, truncated } = this.sweep(config.path))
    } catch (error) {
      // Vanished directory etc. — treat as a failed scan (slow retry, no
      // backoff: the path is user config, not a flaky remote).
      console.warn(`[hibuddy-resident] watch ${instance.id} sweep failed: ${errorMessage(error)}`)
      this.saveSource(instance, cursor, nowIso, INVALID_CONFIG_RETRY_MS, instance.degraded === true)
      return
    }
    // Scan succeeded → the path is valid and in-workspace right now: safe to
    // open (or keep) the watcher (D1/D2).
    this.ensureWatcher(instance)

    // Baseline: the first sweep only builds the cursor (ADR §5).
    const tracked: Record<string, string> = {}
    for (const file of files.slice(0, MAX_TRACKED)) {
      tracked[file.relativePath] = fingerprintOfFile(file.relativePath, file.size, file.mtimeMs)
    }
    if (cursor.fingerprints === undefined) {
      this.saveSource(instance, { fingerprints: tracked, lastScanAt: nowIso }, nowIso, this.sweepIntervalMs, false)
      return
    }

    // Diff against the cursor (D3): added = new path, modified = new
    // fingerprint; disappeared paths simply drop out of the next cursor.
    const changes: Array<{ file: DiscoveredFile; change: 'added' | 'modified'; fingerprint: string }> = []
    const perFile: string[] = []
    for (const file of files.slice(0, MAX_TRACKED)) {
      const fingerprint = tracked[file.relativePath]!
      const previous = cursor.fingerprints[file.relativePath]
      if (previous === undefined) changes.push({ file, change: 'added', fingerprint })
      else if (previous !== fingerprint) changes.push({ file, change: 'modified', fingerprint })
    }
    for (const change of changes) perFile.push(change.fingerprint)
    const changed = changes.length > 0

    this.saveSource(instance, { fingerprints: tracked, lastScanAt: nowIso }, nowIso, this.sweepIntervalMs, false)
    if (!changed) return

    changes.sort((a, b) => b.file.mtimeMs - a.file.mtimeMs)
    const label = config.name ?? instance.id
    const counts = {
      added: changes.filter((c) => c.change === 'added').length,
      modified: changes.filter((c) => c.change === 'modified').length,
    }
    const detail = changes
      .slice(0, MAX_EVENTS)
      .map((c) => `${c.change === 'added' ? '新增' : '修改'} ${c.file.relativePath}（${formatSize(c.file.size)}）`)
      .join('、')
    const rationale =
      `工作区「${label}」发生文件变更：新增 ${counts.added} 个、修改 ${counts.modified} 个` +
      (truncated || changes.length > MAX_EVENTS ? `（明细已截断，仅显示前 ${Math.min(MAX_EVENTS, changes.length)} 项）` : '') +
      `：${detail}。` +
      (truncated ? '（注意：目录文件数超过监视上限，超出部分未纳入监视。）' : '')

    const trigger: Trigger = {
      id: `trg_${randomUUID()}`,
      sourceId: instance.id,
      at: nowIso,
      payload: {
        path: config.path,
        condition: config.condition,
        fingerprint: aggregateFingerprint(perFile),
        total: changes.length,
        events: changes.slice(0, MAX_EVENTS).map((c) => ({
          path: c.file.relativePath,
          change: c.change,
          size: c.file.size,
          mtime: new Date(c.file.mtimeMs).toISOString(),
        })),
        rationale,
      } satisfies WorkspaceChangePayload,
      untrusted: true,
    }
    emit(trigger)
  }

  /** Deterministic sweep (D4): walk once, sorted, capped, noise-free. */
  private sweep(root: string): { files: DiscoveredFile[]; truncated: boolean } {
    const files: DiscoveredFile[] = []
    let truncated = false

    const visit = (dir: string, depth: number): void => {
      if (truncated || depth > MAX_DEPTH) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return // unreadable subtree — skipped, not fatal
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (isNoise(entry.name, entry.isDirectory())) continue
        const full = join(dir, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          visit(full, depth + 1)
        } else if (entry.isFile()) {
          if (files.length >= MAX_FILES_SCANNED) {
            truncated = true
            return
          }
          let stats
          try {
            stats = lstatSync(full) // file may vanish mid-sweep — skip it
          } catch {
            continue
          }
          files.push({
            relativePath: relative(root, full).split(sep).join('/'),
            size: stats.size,
            mtimeMs: stats.mtimeMs,
          })
        }
      }
    }

    visit(root, 0)
    return { files, truncated }
  }

  /** D2 gate: the configured path must sit under a registered workspace root. */
  private insideWorkspace(path: string): boolean {
    const roots = this.options.roots()
    return roots.some((root) => inside(root, path))
  }

  /** Persist cursor + schedule advance in one row update (monitor precedent). */
  private saveSource(
    instance: SourceInstance,
    cursor: WorkspaceWatchCursor,
    nowIso: string,
    delayMs: number,
    degraded: boolean,
  ): void {
    this.store.upsertSource({
      ...instance,
      cursor,
      degraded,
      nextRunAt: new Date(Date.parse(nowIso) + delayMs).toISOString(),
    })
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
