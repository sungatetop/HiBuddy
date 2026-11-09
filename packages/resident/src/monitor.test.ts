import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Trigger } from './domain.ts'
import {
  backoffDelayMs,
  fingerprintOf,
  MIN_CHECK_INTERVAL_MS,
  MonitorSource,
  parseMonitorConfig,
  parseMonitorCursor,
  type MonitorCheckResult,
  type MonitorChecker,
} from './monitor.ts'
import { Store } from './store.ts'

const MIN = 60_000

let dir: string
let store: Store
/** Fake clock, advanced by tests. */
let currentMs: number
/** Every MonitorSource created in a test; stopped in afterEach to avoid timer leaks. */
let sources: MonitorSource[] = []

/** Scriptable checker: a queue of outcomes (result or error) per call. */
function fakeChecker(script: Array<MonitorCheckResult | Error>): MonitorChecker & { calls: string[] } {
  const calls: string[] = []
  let i = 0
  return {
    calls,
    check(sourceId) {
      calls.push(sourceId)
      const next = script[i++]
      if (next instanceof Error) return Promise.reject(next)
      return Promise.resolve(next)
    },
  }
}

function makeSource(checker: MonitorChecker, options = {}): MonitorSource {
  const source = new MonitorSource(store, checker, { now: () => new Date(currentMs), ...options })
  sources.push(source)
  return source
}

/** Insert an enabled monitor instance due right now. */
function seedMonitor(id: string, intervalMs = MIN, config: unknown = undefined): void {
  store.upsertSource({
    id,
    kind: 'monitor',
    enabled: true,
    config: config ?? { name: 'demo', target: 'file:///w.txt', condition: '包含 HIT', intervalMs },
    nextRunAt: new Date(currentMs).toISOString(),
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'resident-monitor-'))
  store = Store.open(dir)
  currentMs = Date.parse('2026-11-06T12:00:00.000Z')
  sources = []
})

afterEach(() => {
  for (const source of sources) source.stopAll()
  store.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('monitor config and helpers', () => {
  it('parses a valid config and rejects unusable ones', () => {
    expect(parseMonitorConfig({ target: 'a', condition: 'b', intervalMs: MIN })).toMatchObject({
      target: 'a',
      condition: 'b',
      intervalMs: MIN,
    })
    expect(parseMonitorConfig({ target: 'a', condition: 'b', intervalMs: MIN_CHECK_INTERVAL_MS - 1 })).toBeUndefined()
    expect(parseMonitorConfig({ target: '', condition: 'b', intervalMs: MIN })).toBeUndefined()
    expect(parseMonitorConfig({ target: 'a', condition: 'b', intervalMs: 'x' })).toBeUndefined()
    expect(parseMonitorConfig(null)).toBeUndefined()
  })

  it('parses cursors tolerantly', () => {
    expect(parseMonitorCursor({ fingerprint: 'f', failureCount: 2 })).toEqual({ fingerprint: 'f', failureCount: 2 })
    expect(parseMonitorCursor('junk')).toEqual({})
    expect(parseMonitorCursor({ failureCount: -3 })).toEqual({ failureCount: 0 })
  })

  it('doubles the backoff per failure and caps it', () => {
    expect(backoffDelayMs(MIN, 1)).toBe(MIN)
    expect(backoffDelayMs(MIN, 2)).toBe(2 * MIN)
    expect(backoffDelayMs(MIN, 3)).toBe(4 * MIN)
    expect(backoffDelayMs(MIN, 10)).toBe(30 * MIN) // capped
    expect(backoffDelayMs(MIN, 10, 2 * MIN)).toBe(2 * MIN) // injectable cap
  })

  it('fingerprints are stable and short', () => {
    expect(fingerprintOf('abc')).toBe(fingerprintOf('abc'))
    expect(fingerprintOf('abc')).not.toBe(fingerprintOf('abd'))
    expect(fingerprintOf('abc')).toHaveLength(16)
  })
})

describe('monitor source: checks, dedup, hits', () => {
  it('checks a due instance and emits a trigger on the first hit', async () => {
    seedMonitor('m1')
    const checker = fakeChecker([{ fingerprintInput: 'snapshot A', conditionMet: true, rationale: '文件包含 HIT' }])
    const emitted: Trigger[] = []
    const source = makeSource(checker)
    source.start(store.getSource('m1')!, (t) => emitted.push(t))

    await source.tick()

    expect(checker.calls).toEqual(['m1'])
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.sourceId).toBe('m1')
    expect(emitted[0]!.payload).toMatchObject({
      target: 'file:///w.txt',
      condition: '包含 HIT',
      fingerprint: fingerprintOf('snapshot A'),
      rationale: '文件包含 HIT',
    })
    const row = store.getSource('m1')!
    expect(parseMonitorCursor(row.cursor).fingerprint).toBe(fingerprintOf('snapshot A'))
    expect(parseMonitorCursor(row.cursor).failureCount).toBe(0)
    expect(row.nextRunAt).toBe(new Date(currentMs + MIN).toISOString())
  })

  it('never re-triggers an unchanged snapshot', async () => {
    seedMonitor('m1')
    const checker = fakeChecker([
      { fingerprintInput: 'same', conditionMet: true, rationale: 'r1' },
      { fingerprintInput: 'same', conditionMet: true, rationale: 'r2' },
    ])
    const emitted: Trigger[] = []
    const source = makeSource(checker)
    source.start(store.getSource('m1')!, (t) => emitted.push(t))

    await source.tick()
    currentMs += MIN
    await source.tick()

    expect(checker.calls).toHaveLength(2)
    expect(emitted).toHaveLength(1) // second check: same fingerprint → silent
    expect(store.listTriggers('m1')).toHaveLength(0) // emits go through the wired callback only
  })

  it('emits again when the snapshot changes and the condition holds', async () => {
    seedMonitor('m1')
    const checker = fakeChecker([
      { fingerprintInput: 'A', conditionMet: true, rationale: '' },
      { fingerprintInput: 'A', conditionMet: true, rationale: '' },
      { fingerprintInput: 'B', conditionMet: true, rationale: '' },
    ])
    const emitted: Trigger[] = []
    const source = makeSource(checker)
    source.start(store.getSource('m1')!, (t) => emitted.push(t))

    await source.tick()
    currentMs += MIN
    await source.tick()
    currentMs += MIN
    await source.tick()

    expect(emitted).toHaveLength(2)
    expect((emitted[1]!.payload as { fingerprint: string }).fingerprint).toBe(fingerprintOf('B'))
  })

  it('stays silent when the condition does not hold but still advances the fingerprint', async () => {
    seedMonitor('m1')
    const checker = fakeChecker([
      { fingerprintInput: 'A', conditionMet: false, rationale: '没有 HIT' },
    ])
    const emitted: Trigger[] = []
    const source = makeSource(checker)
    source.start(store.getSource('m1')!, (t) => emitted.push(t))

    await source.tick()

    expect(emitted).toHaveLength(0)
    expect(parseMonitorCursor(store.getSource('m1')!.cursor).fingerprint).toBe(fingerprintOf('A'))
  })
})

describe('monitor source: failure backoff and degraded flag', () => {
  it('backs off exponentially on failures and degrades after N with one system record', async () => {
    seedMonitor('m1')
    const checker = fakeChecker([new Error('boom'), new Error('boom'), new Error('boom'), new Error('boom')])
    const source = makeSource(checker)
    source.start(store.getSource('m1')!, () => {})

    await source.tick()
    expect(store.getSource('m1')!.degraded).toBe(false)
    expect(store.getSource('m1')!.nextRunAt).toBe(new Date(currentMs + MIN).toISOString())

    currentMs += MIN
    await source.tick()
    expect(store.getSource('m1')!.nextRunAt).toBe(new Date(currentMs + 2 * MIN).toISOString())

    currentMs += 2 * MIN
    await source.tick()
    expect(store.getSource('m1')!.degraded).toBe(true)
    const systems = store.listMessages().filter((m) => m.kind === 'system')
    expect(systems).toHaveLength(0)
    const events = store.listMessages().filter((m) => m.kind === 'event')
    expect(events).toHaveLength(1)
    expect(events[0]!.idempotencyKey).toBe('monitor:m1:degraded')
    expect(store.getSource('m1')!.nextRunAt).toBe(new Date(currentMs + 4 * MIN).toISOString())

    // already degraded → no duplicate record; backoff keeps growing
    currentMs += 4 * MIN
    await source.tick()
    expect(store.listMessages().filter((m) => m.kind === 'event')).toHaveLength(1)
    expect(store.getSource('m1')!.nextRunAt).toBe(new Date(currentMs + 8 * MIN).toISOString())
  })

  it('recovers from degraded on a successful check', async () => {
    seedMonitor('m1')
    const checker = fakeChecker([
      new Error('boom'),
      new Error('boom'),
      new Error('boom'),
      { fingerprintInput: 'ok', conditionMet: false, rationale: '' },
    ])
    const source = makeSource(checker)
    source.start(store.getSource('m1')!, () => {})
    for (let i = 0; i < 3; i++) {
      await source.tick()
      currentMs += backoffDelayMs(MIN, i + 1)
    }
    expect(store.getSource('m1')!.degraded).toBe(true)

    await source.tick()
    const row = store.getSource('m1')!
    expect(row.degraded).toBe(false)
    expect(parseMonitorCursor(row.cursor).failureCount).toBe(0)
    expect(row.nextRunAt).toBe(new Date(currentMs + MIN).toISOString())
  })
})

describe('monitor source: gating and lifecycle', () => {
  it('skips disabled instances without checking', async () => {
    seedMonitor('m1')
    store.upsertSource({ ...store.getSource('m1')!, enabled: false })
    const checker = fakeChecker([{ fingerprintInput: 'A', conditionMet: true, rationale: '' }])
    const source = makeSource(checker)
    source.start(store.getSource('m1')!, () => {})

    await source.tick()

    expect(checker.calls).toHaveLength(0)
    // re-enabled → the next tick checks again
    store.upsertSource({ ...store.getSource('m1')!, enabled: true })
    await source.tick()
    expect(checker.calls).toHaveLength(1)
  })

  it('reschedules invalid configs on a slow cadence without checking', async () => {
    seedMonitor('m1', MIN, { target: 'x' }) // missing condition
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const checker = fakeChecker([])
    const source = makeSource(checker)
    source.start(store.getSource('m1')!, () => {})

    await source.tick()

    expect(checker.calls).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(store.getSource('m1')!.nextRunAt).toBe(new Date(currentMs + 60_000).toISOString())
  })

  it('never re-enters a check while it is in flight', async () => {
    seedMonitor('m1')
    let release!: (r: MonitorCheckResult) => void
    const gate = new Promise<MonitorCheckResult>((resolve) => {
      release = resolve
    })
    const checker: MonitorChecker & { calls: number } = {
      calls: 0,
      check: () => {
        checker.calls += 1
        return gate
      },
    }
    const source = makeSource(checker)
    source.start(store.getSource('m1')!, () => {})

    const first = source.tick() // hangs on the gated check
    await Promise.resolve()
    const second = source.tick() // must skip the in-flight instance
    release({ fingerprintInput: 'A', conditionMet: false, rationale: '' })
    await Promise.all([first, second])

    expect(checker.calls).toBe(1)
  })

  it('stops polling an instance on stop() and tears the timer down when empty', () => {
    vi.useFakeTimers()
    try {
      const source = makeSource(fakeChecker([]))
      seedMonitor('m1')
      source.start(store.getSource('m1')!, () => {})
      expect(vi.getTimerCount()).toBe(1)
      source.stop('m1')
      expect(vi.getTimerCount()).toBe(0)
      expect(source.isArmed('m1')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('enforces the minimum interval floor', () => {
    expect(MIN_CHECK_INTERVAL_MS).toBe(1_000)
  })
})
