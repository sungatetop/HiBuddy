/**
 * Monitor event source (resident-design.md §4.2, OpenMuse Monitor blueprint).
 *
 * Each monitor instance checks its target (file/URL) on a fixed interval via
 * an injected checker — a lightweight short dsh session (session-check.ts)
 * that reads the target and evaluates the natural-language condition. A hit
 * (condition held on a changed snapshot) emits a Trigger into the two-stage
 * filter (filter.ts); an unchanged snapshot never re-triggers (fingerprint
 * dedup, §4.2).
 *
 * Failure handling: consecutive failures double the next check delay up to a
 * cap (退避), and after N consecutive failures the instance is marked
 * `degraded` with a one-shot system notification through the notification
 * surface (B6: persist before deliver, FR-10 rule 3). A later successful
 * check resets the failure counter and clears the degraded flag, so a source
 * recovers on its own — the panel (B8) only displays the state.
 *
 * Instances poll `source_instances.next_run_at` (same index discipline as the
 * ticket scheduler); a check in flight is never re-entered, and disabled or
 * deleted instances are skipped without being armed-out (the panel can toggle
 * `enabled` live).
 */

import { createHash, randomUUID } from 'node:crypto'
import type { SourceInstance, Trigger } from './domain.ts'
import { MessageService } from './messages.ts'
import type { SourceKind, TriggerEmitter } from './sources.ts'
import type { Store } from './store.ts'

/** Smallest legal check interval; panels must not offer faster cadences. */
export const MIN_CHECK_INTERVAL_MS = 1_000

/** Upper bound for the exponential failure backoff (design §4.2 "上限封顶"). */
export const DEFAULT_BACKOFF_CAP_MS = 30 * 60_000

/** Consecutive failures before the instance is flagged degraded (§4.2). */
export const DEGRADED_AFTER_FAILURES = 3

/** Retry cadence while the instance config cannot even be parsed. */
const INVALID_CONFIG_RETRY_MS = 60_000

/** Monitor instance configuration (stored as `source_instances.config`). */
export interface MonitorConfig {
  /** Display name (panel, notifications). */
  name?: string
  /** File path or URL to read on every check. */
  target: string
  /** Natural-language condition evaluated against the target snapshot. */
  condition: string
  /** Check interval in ms (≥ MIN_CHECK_INTERVAL_MS). */
  intervalMs: number
  /** Ticket goal override for auto-mode hits; default derived from the hit. */
  goal?: string
}

/** Monitor read position (stored as `source_instances.cursor`). */
export interface MonitorCursor {
  /** Fingerprint of the last snapshot; absent before the first check. */
  fingerprint?: string
  lastCheckAt?: string
  /** Consecutive failed checks (backoff driver; reset on success). */
  failureCount?: number
}

/** Validate a raw instance config; undefined when unusable. */
export function parseMonitorConfig(config: unknown): MonitorConfig | undefined {
  if (typeof config !== 'object' || config === null) return undefined
  const raw = config as Record<string, unknown>
  const target = raw.target
  const condition = raw.condition
  const intervalMs = raw.intervalMs
  if (typeof target !== 'string' || target.trim() === '') return undefined
  if (typeof condition !== 'string' || condition.trim() === '') return undefined
  if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs) || intervalMs < MIN_CHECK_INTERVAL_MS) {
    return undefined
  }
  const parsed: MonitorConfig = { target, condition, intervalMs }
  if (typeof raw.name === 'string' && raw.name.trim() !== '') parsed.name = raw.name
  if (typeof raw.goal === 'string' && raw.goal.trim() !== '') parsed.goal = raw.goal
  return parsed
}

/** Parse a stored cursor; tolerant of foreign/legacy shapes. */
export function parseMonitorCursor(cursor: unknown): MonitorCursor {
  if (typeof cursor !== 'object' || cursor === null) return {}
  const raw = cursor as Record<string, unknown>
  const parsed: MonitorCursor = {}
  if (typeof raw.fingerprint === 'string') parsed.fingerprint = raw.fingerprint
  if (typeof raw.lastCheckAt === 'string') parsed.lastCheckAt = raw.lastCheckAt
  if (typeof raw.failureCount === 'number' && Number.isFinite(raw.failureCount)) {
    parsed.failureCount = Math.max(0, Math.floor(raw.failureCount))
  }
  return parsed
}

/**
 * Exponential backoff: `interval × 2^(failures−1)`, capped. failureCount ≥ 1.
 */
export function backoffDelayMs(intervalMs: number, failureCount: number, capMs = DEFAULT_BACKOFF_CAP_MS): number {
  const exp = Math.max(0, failureCount - 1)
  return Math.min(intervalMs * 2 ** exp, capMs)
}

/** Stable short fingerprint of a snapshot summary (dedup key, §4.2). */
export function fingerprintOf(snapshot: string): string {
  return createHash('sha256').update(snapshot).digest('hex').slice(0, 16)
}

/** Structured verdict of one check (produced by the check session). */
export interface MonitorCheckResult {
  /** Snapshot summary; its stable hash is the dedup fingerprint. */
  fingerprintInput: string
  conditionMet: boolean
  rationale: string
}

/** Check driver abstraction; the real implementation opens a dsh session. */
export interface MonitorChecker {
  check(sourceId: string, config: MonitorConfig): Promise<MonitorCheckResult>
}

export interface MonitorSourceOptions {
  /** Poll cadence in ms (default 1000 — an indexed query). */
  tickMs?: number
  backoffCapMs?: number
  degradedAfterFailures?: number
  /** Notification surface (B6); the host injects its shared instance. */
  notifier?: MessageService
  /** Injectable clock for determinism in tests. */
  now?: () => Date
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * The registered `monitor` kind. Arms/disarms instances via the SourceKind
 * interface; one shared timer drives all armed instances, each check runs
 * detached and guarded by the in-flight set.
 */
export class MonitorSource implements SourceKind {
  readonly kind = 'monitor'

  private readonly store: Store
  private readonly checker: MonitorChecker
  private readonly tickMs: number
  private readonly backoffCapMs: number
  private readonly degradedAfterFailures: number
  private readonly notifier: MessageService
  private readonly now: () => Date
  private readonly armed = new Map<string, TriggerEmitter>()
  private readonly inflight = new Set<string>()
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(store: Store, checker: MonitorChecker, options: MonitorSourceOptions = {}) {
    this.store = store
    this.checker = checker
    this.tickMs = options.tickMs ?? 1000
    this.backoffCapMs = options.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS
    this.degradedAfterFailures = options.degradedAfterFailures ?? DEGRADED_AFTER_FAILURES
    this.notifier = options.notifier ?? new MessageService(store)
    this.now = options.now ?? (() => new Date())
  }

  start(instance: SourceInstance, emit: TriggerEmitter): void {
    this.armed.set(instance.id, emit)
    if (this.timer === undefined) {
      this.timer = setInterval(() => {
        void this.tick().catch((error) => {
          // a broken tick must never kill the host; the next tick retries
          console.error('[hibuddy-resident] monitor tick failed:', error)
        })
      }, this.tickMs)
      this.timer.unref?.()
    }
  }

  stop(instanceId: string): void {
    this.armed.delete(instanceId)
    if (this.armed.size === 0 && this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** Disarm everything (dispose path / test teardown). */
  stopAll(): void {
    this.armed.clear()
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** True while at least one instance is armed (tests / panel diagnostics). */
  isArmed(instanceId: string): boolean {
    return this.armed.has(instanceId)
  }

  /**
   * One scheduling pass over armed instances. Returns a promise that settles
   * with all checks launched by this pass (the live timer ignores it; tests
   * await it for determinism).
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
        this.checkInstance(instance, emit)
          .catch((error) => {
            console.error(`[hibuddy-resident] monitor ${id} check crashed:`, errorMessage(error))
          })
          .finally(() => this.inflight.delete(id)),
      )
    }
    await Promise.allSettled(launched)
  }

  /** One check round: run → fingerprint dedup → save cursor → emit on hit. */
  private async checkInstance(instance: SourceInstance, emit: TriggerEmitter): Promise<void> {
    const now = this.now()
    const nowIso = now.toISOString()
    const config = parseMonitorConfig(instance.config)
    const cursor = parseMonitorCursor(instance.cursor)

    if (!config) {
      // Panel bug, not a transient failure: do not count it into the backoff,
      // just retry on a slow cadence and surface once via the log.
      console.warn(`[hibuddy-resident] monitor ${instance.id} has an invalid config; retrying in ${INVALID_CONFIG_RETRY_MS / 1000}s`)
      this.saveSource(instance, cursor, nowIso, INVALID_CONFIG_RETRY_MS, instance.degraded === true)
      return
    }

    const label = config.name ?? instance.id
    try {
      const result = await this.checker.check(instance.id, config)
      const fingerprint = fingerprintOf(result.fingerprintInput)
      const changed = cursor.fingerprint === undefined || cursor.fingerprint !== fingerprint
      this.saveSource(
        instance,
        { ...cursor, fingerprint, lastCheckAt: nowIso, failureCount: 0 },
        nowIso,
        config.intervalMs,
        false,
      )
      if (result.conditionMet && changed) {
        emit({
          id: `trg_${randomUUID()}`,
          sourceId: instance.id,
          at: nowIso,
          payload: {
            target: config.target,
            condition: config.condition,
            fingerprint,
            rationale: result.rationale,
          },
        })
      }
    } catch (error) {
      const failureCount = (cursor.failureCount ?? 0) + 1
      const degraded = failureCount >= this.degradedAfterFailures
      const delay = backoffDelayMs(config.intervalMs, failureCount, this.backoffCapMs)
      this.saveSource(instance, { ...cursor, lastCheckAt: nowIso, failureCount }, nowIso, delay, degraded)
      if (degraded && !instance.degraded) {
        // One-shot system record through the message ledger (§9); the
        // idempotency key keeps it one-shot per degradation episode.
        this.notifier.postOutbound({
          kind: 'system',
          refs: { sourceId: instance.id },
          idempotencyKey: `monitor:${instance.id}:degraded`,
          title: `监控「${label}」连续检查失败，已标记降级`,
          text: `连续 ${failureCount} 次检查失败（最近错误：${truncate(errorMessage(error))}）。已按退避策略降低检查频率，检查恢复后会自动解除降级。`,
        })
      }
    }
  }

  /** Persist cursor + schedule advance in one row update. */
  private saveSource(
    instance: SourceInstance,
    cursor: MonitorCursor,
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
