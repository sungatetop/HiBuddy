/**
 * Two-stage filtering with observe mode (resident-design.md §6).
 *
 * Stage 1 — gate (deterministic, free): source enabled, no open ticket from
 * the same monitor already covering the situation, hit payload well-formed.
 * Stage 2 — assessment (LLM): only monitor hits reach it (they are all
 * `inferred` mandate candidates; user-created tickets carry an explicit
 * mandate and never pass through here). The assessment weighs the condition,
 * the check evidence, and related ticket context, then decides whether
 * creating a work item is warranted.
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
    const payload = trigger.payload as Partial<MonitorHitPayload> | null
    if (
      typeof payload?.target !== 'string' ||
      typeof payload.condition !== 'string' ||
      typeof payload.fingerprint !== 'string' ||
      typeof payload.rationale !== 'string'
    ) {
      return 'dropped'
    }
    const source = this.store.getSource(trigger.sourceId)
    if (!source || !source.enabled) return 'dropped'

    const related = this.store.listTickets().filter((t) => t.origin === `monitor:${trigger.sourceId}`)
    if (related.some((t) => OPEN_STATES.has(t.state))) return 'skipped'

    // ── assessment (LLM, inferred candidates only) ──────────────────────────
    const assessor = this.options.assessor
    if (!assessor) {
      console.warn('[hibuddy-resident] no assessor configured; monitor hit not assessed')
      return 'skipped'
    }
    const assessment = await assessor.assess(trigger.sourceId, {
      condition: payload.condition,
      rationale: payload.rationale,
      relatedTickets: related.slice(-5).map(({ id, state, summary }) => ({ id, state, summary })),
    })
    if (!assessment.act) return 'skipped'

    // ── observe vs act ───────────────────────────────────────────────────────
    if (this.options.observeMode()) {
      // Observe mode: record the would-act verdict only (design §6). The
      // idempotency key dedupes re-hits of the same fingerprint.
      this.notifier.postInbound({
        kind: 'event',
        refs: { sourceId: trigger.sourceId },
        idempotencyKey: `monitor:${trigger.sourceId}:would-act:${payload.fingerprint}`,
        title: '观察模式：监控命中，未执行行动',
        text:
          `检查目标「${payload.target}」满足条件「${payload.condition}」。\n` +
          `检查依据：${payload.rationale}\n` +
          `研判：${assessment.reason}\n` +
          '（观察模式：请判断是否需要告知用户；如需行动，征得用户同意后再 create_session。）',
      })
      return 'observed'
    }

    // Auto mode: inferred-mandate ticket, immediately due — the scheduler's
    // slot gate still serializes it against other worker rounds (§5).
    const config = parseMonitorConfig(source.config)
    const goal =
      config?.goal ??
      `监控命中：检查目标「${payload.target}」满足条件「${payload.condition}」。` +
        `检查依据：${payload.rationale}。研判：${assessment.reason}。` +
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
    // shows the new ticket by its `monitor:<sourceId>` origin).
    if (!this.notifier.isQuiet()) {
      this.notifier.postInbound({
        kind: 'event',
        refs: { sourceId: trigger.sourceId, ticketId },
        idempotencyKey: `monitor:${trigger.sourceId}:triggered:${payload.fingerprint}`,
        title: '监控命中并创建任务',
        text:
          `检查目标「${payload.target}」满足条件「${payload.condition}」。\n` +
          `检查依据：${payload.rationale}。研判：${assessment.reason}。\n` +
          `已创建任务 ${ticketId}（来源 ${trigger.sourceId}，指纹 ${payload.fingerprint.slice(0, 12)}…）。`,
        data: { code: 'monitor_triggered', sourceId: trigger.sourceId, ticketId },
      })
    }
    return 'acted'
  }
}
