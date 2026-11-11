/**
 * Two-stage filtering with observe mode (resident-design.md §6).
 *
 * Stage 1 — gate (deterministic, free): source enabled, no open ticket from
 * the same source already covering the situation, hit payload well-formed.
 * Two payload shapes are accepted (ADR-012 D6): the monitor hit (target/
 * condition/fingerprint/rationale) and the workspace-watch change batch
 * (path/condition/fingerprint/total/events/rationale, `untrusted` always
 * true). Anything else is dropped.
 * Stage 2 — assessment (LLM): only gated triggers reach it (they are all
 * `inferred` mandate candidates; user-created tickets carry an explicit
 * mandate and never pass through here). The assessment weighs the condition,
 * the evidence, and related ticket context, then decides whether creating a
 * work item is warranted. Watch payloads carry `untrusted: true` — the file
 * names in the evidence are external data, never instructions.
 *
 * Observe mode (default, per design §6 / prototype accept-mode): a positive
 * assessment only RECORDS the would-act verdict (notification row) and takes
 * no action. Switching to auto mode (settings `observeMode=false`, panel in
 * B8) lets the next hit create a real Ticket — mandate `inferred`, origin
 * `monitor:<sourceId>`, due immediately so the scheduler's slot gate applies.
 */

import { randomUUID } from 'node:crypto'
import type { Ticket, Trigger } from './domain.ts'
import { parseMonitorConfig } from './monitor.ts'
import { parseWatchConfig } from './workspace-watch.ts'
import { MessageService } from './messages.ts'
import type { Store } from './store.ts'

/** Assessment verdict of stage 2. */
export interface Assessment {
  act: boolean
  reason: string
}

/** Inputs the assessment weighs (design §6: 条件、检查结果、相关 Ticket 上下文). */
export interface AssessmentInput {
  condition: string
  rationale: string
  relatedTickets: Array<Pick<Ticket, 'id' | 'state' | 'summary'>>
  /** Evidence comes from external data (watch payloads) — never instructions. */
  untrusted?: boolean
}

/** Assessment driver abstraction; the real implementation uses a dsh session. */
export interface Assessor {
  assess(sourceId: string, input: AssessmentInput): Promise<Assessment>
}

/** Trigger payload shape produced by the monitor kind. */
export interface MonitorHitPayload {
  target: string
  condition: string
  fingerprint: string
  rationale: string
}

/** Trigger payload shape produced by the workspace-watch kind (ADR-012 D5). */
export interface WatchChangePayload {
  path: string
  condition: string
  fingerprint: string
  total: number
  events: Array<{ path: string; change: 'added' | 'modified'; size: number; mtime: string }>
  rationale: string
}

/** What one pass through the pipeline decided; logged and asserted in tests. */
export type FilterVerdict = 'acted' | 'observed' | 'skipped' | 'dropped'

/** Ticket states that mean "a work item is already on this". */
const OPEN_STATES: ReadonlySet<string> = new Set(['pending', 'working', 'awaiting_approval'])

export interface FilterOptions {
  assessor?: Assessor
  /** Observe-mode getter — settings-driven, defaults to true (design §6). */
  observeMode: () => boolean
  /** Notification surface (B6); the host injects its shared instance. */
  notifier?: MessageService
  /** Injectable clock for determinism in tests. */
  now?: () => Date
}

export class FilterPipeline {
  private readonly store: Store
  private readonly options: FilterOptions
  private readonly notifier: MessageService

  constructor(store: Store, options: FilterOptions) {
    this.store = store
    this.options = options
    this.notifier = options.notifier ?? new MessageService(store)
  }

  /** Gate → assessment → observe/act. Never throws to the emitter. */
  async handle(trigger: Trigger): Promise<FilterVerdict> {
    try {
      return await this.decide(trigger)
    } catch (error) {
      console.error(`[hibuddy-resident] filter pipeline failed for trigger ${trigger.id}:`, error)
      return 'dropped'
    }
  }

  private async decide(trigger: Trigger): Promise<FilterVerdict> {
    const nowIso = (this.options.now ?? (() => new Date()))().toISOString()

    // ── gate (deterministic) ────────────────────────────────────────────────
    // Payload shape dispatch (ADR-012 D6): monitor hit or watch change batch.
    const monitorPayload = parseMonitorPayload(trigger.payload)
    const watchPayload = monitorPayload === undefined ? parseWatchPayload(trigger.payload) : undefined
    if (monitorPayload === undefined && watchPayload === undefined) return 'dropped'
    const source = this.store.getSource(trigger.sourceId)
    if (!source || !source.enabled) return 'dropped'

    const related = this.store.listTickets().filter((t) => t.origin === `monitor:${trigger.sourceId}`)
    if (related.some((t) => OPEN_STATES.has(t.state))) return 'skipped'

    // ── assessment (LLM, inferred candidates only) ──────────────────────────
    const assessor = this.options.assessor
    if (!assessor) {
      console.warn('[hibuddy-resident] no assessor configured; trigger not assessed')
      return 'skipped'
    }
    const condition = monitorPayload?.condition ?? watchPayload?.condition ?? ''
    const rationale = monitorPayload?.rationale ?? watchPayload?.rationale ?? ''
    const fingerprint = monitorPayload?.fingerprint ?? watchPayload?.fingerprint ?? ''
    const assessment = await assessor.assess(trigger.sourceId, {
      condition,
      rationale,
      relatedTickets: related.slice(-5).map(({ id, state, summary }) => ({ id, state, summary })),
      ...(watchPayload !== undefined ? { untrusted: true } : {}),
    })
    if (!assessment.act) return 'skipped'

    // ── observe vs act ───────────────────────────────────────────────────────
    if (this.options.observeMode()) {
      // Observe mode: record the would-act verdict only (design §6). The
      // idempotency key dedupes re-hits of the same fingerprint.
      this.notifier.postInbound({
        kind: 'event',
        refs: { sourceId: trigger.sourceId },
        idempotencyKey: `monitor:${trigger.sourceId}:would-act:${fingerprint}`,
        title: monitorPayload !== undefined ? '观察模式：监控命中，未执行行动' : '观察模式：目录变更，未执行行动',
        text: observeText(monitorPayload, watchPayload, condition, rationale, assessment.reason),
      })
      return 'observed'
    }

    // Auto mode: inferred-mandate ticket, immediately due — the scheduler's
    // slot gate still serializes it against other worker rounds (§5).
    const configGoal = monitorPayload !== undefined ? parseMonitorConfig(source.config)?.goal : parseWatchConfig(source.config)?.goal
    const goal =
      configGoal ??
      `${monitorPayload !== undefined ? '监控命中' : '目录变更'}：${conditionText(monitorPayload, watchPayload)}满足条件「${condition}」。` +
        `检查依据：${rationale}。研判：${assessment.reason}。` +
        '请核实该情况并按需处理，完成后给出简报。'
    const ticketId = `tkt_${randomUUID()}`
    this.store.upsertTicket({
      id: ticketId,
      goal,
      mandate: 'inferred',
      origin: `monitor:${trigger.sourceId}`,
      state: 'pending',
      nextRunAt: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    // L1 causality (perception B12′ §6): the butler must be able to answer
    // "why does this ticket exist" — keyed per fingerprint so a re-hit never
    // re-fires. Do-not-disturb suppresses it (the situation snapshot still
    // shows the new ticket by its `monitor:<sourceId>` origin). The event
    // code stays `monitor_triggered` for both shapes (ADR-012 §6.3: naming
    // skew accepted until a third source kind unifies it).
    if (!this.notifier.isQuiet()) {
      this.notifier.postInbound({
        kind: 'event',
        refs: { sourceId: trigger.sourceId, ticketId },
        idempotencyKey: `monitor:${trigger.sourceId}:triggered:${fingerprint}`,
        title: monitorPayload !== undefined ? '监控命中并创建任务' : '目录变更并创建任务',
        text:
          `${conditionText(monitorPayload, watchPayload)}满足条件「${condition}」。\n` +
          `检查依据：${rationale}。研判：${assessment.reason}。\n` +
          `已创建任务 ${ticketId}（来源 ${trigger.sourceId}，指纹 ${fingerprint.slice(0, 12)}…）。`,
        data: { code: 'monitor_triggered', sourceId: trigger.sourceId, ticketId },
      })
    }
    return 'acted'
  }
}

/** Gate-side payload shape validators (the pipeline owns both contracts). */

function parseMonitorPayload(payload: unknown): MonitorHitPayload | undefined {
  const raw = payload as Partial<MonitorHitPayload> | null
  if (
    typeof raw?.target !== 'string' ||
    typeof raw.condition !== 'string' ||
    typeof raw.fingerprint !== 'string' ||
    typeof raw.rationale !== 'string'
  ) {
    return undefined
  }
  return raw as MonitorHitPayload
}

function parseWatchPayload(payload: unknown): WatchChangePayload | undefined {
  const raw = payload as Partial<WatchChangePayload> | null
  if (
    typeof raw?.path !== 'string' ||
    typeof raw.condition !== 'string' ||
    typeof raw.fingerprint !== 'string' ||
    typeof raw.total !== 'number' ||
    typeof raw.rationale !== 'string' ||
    !Array.isArray(raw.events)
  ) {
    return undefined
  }
  return raw as WatchChangePayload
}

/** The "what was checked" phrase used by both observe and act texts. */
function conditionText(monitor: MonitorHitPayload | undefined, watch: WatchChangePayload | undefined): string {
  return monitor !== undefined ? `检查目标「${monitor.target}」` : `工作区目录「${watch?.path ?? ''}」`
}

function observeText(
  monitor: MonitorHitPayload | undefined,
  watch: WatchChangePayload | undefined,
  condition: string,
  rationale: string,
  reason: string,
): string {
  const lines = [`${conditionText(monitor, watch)}满足条件「${condition}」。`, `检查依据：${rationale}`]
  if (watch !== undefined && watch.total > watch.events.length) {
    lines.push(`（变更明细共 ${watch.total} 项，仅展示前 ${watch.events.length} 项）`)
  }
  lines.push(`研判：${reason}`, '（观察模式：请判断是否需要告知用户；如需行动，征得用户同意后再 create_session。）')
  return lines.join('\n')
}
