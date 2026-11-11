import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SourceInstance, Trigger } from './domain.ts'
import { FilterPipeline, type Assessment, type AssessmentInput, type Assessor } from './filter.ts'
import { fingerprintOf } from './monitor.ts'
import { MessageService } from './messages.ts'
import { Store } from './store.ts'
import {
  aggregateFingerprint,
  fingerprintOfFile,
  isNoise,
  parseWatchConfig,
  parseWatchCursor,
  WorkspaceWatchSource,
  type DirWatcher,
  type WorkspaceChangePayload,
} from './workspace-watch.ts'

let dir: string
/** The watched root — a subdir of dir, so store files (orchestrator.sqlite*)
 *  living in `dir` never pollute the sweep. */
let watchDir: string
let store: Store
const PAST = '2020-01-01T00:00:00.000Z'

/** Controllable fake watcher factory: records opens, fires onChange manually. */
function fakeWatchFactory() {
  const opened: string[] = []
  const callbacks = new Map<string, () => void>()
  const factory = (watchedPath: string, onChange: () => void): DirWatcher => {
    opened.push(watchedPath)
    callbacks.set(watchedPath, onChange)
    return { close: () => callbacks.delete(watchedPath) }
  }
  return { factory, opened, fire: (watchedPath: string) => callbacks.get(watchedPath)?.() }
}

function makeSource(options: { roots?: string[]; sweepIntervalMs?: number; watchFactory?: ReturnType<typeof fakeWatchFactory>['factory'] }): WorkspaceWatchSource {
  return new WorkspaceWatchSource(store, {
    roots: () => options.roots ?? [dir],
    sweepIntervalMs: options.sweepIntervalMs ?? 60_000,
    ...(options.watchFactory !== undefined ? { watchFactory: options.watchFactory } : {}),
  })
}

function seedWatch(id = 'w1', path = watchDir, config: Record<string, unknown> = {}): SourceInstance {
  store.upsertSource({
    id,
    kind: 'watch',
    enabled: true,
    config: { path, condition: '出现新文件或文件被修改时', ...config },
    nextRunAt: PAST,
  })
  return store.getSource(id)!
}

/** Arm + run one scan pass (nextRunAt reset → due); triggers are persisted
 *  first, mirroring the real emit wiring in index.ts. */
async function scan(source: WorkspaceWatchSource, instance: SourceInstance): Promise<Trigger[]> {
  const collected: Trigger[] = []
  store.upsertSource({ ...store.getSource(instance.id)!, nextRunAt: PAST })
  const current = store.getSource(instance.id)!
  source.start(current, (trigger) => {
    store.saveTrigger(trigger)
    collected.push(trigger)
  })
  await source.tick()
  source.stop(instance.id)
  return collected
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'resident-watch-'))
  watchDir = join(dir, 'ws')
  mkdirSync(watchDir)
  store = Store.open(dir)
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('watch: fingerprints and parsing', () => {
  it('builds stable per-file fingerprints and a change-sensitive aggregate', () => {
    const base = fingerprintOfFile('out/report.md', 100, 1000)
    expect(base).toBe(fingerprintOfFile('out/report.md', 100, 1000))
    expect(base).not.toBe(fingerprintOfFile('out/report.md', 101, 1000))
    expect(base).not.toBe(fingerprintOfFile('out/other.md', 100, 1000))

    const aggregate = aggregateFingerprint([base, 'aaa'])
    expect(aggregate).toBe(aggregateFingerprint(['aaa', base])) // order-insensitive
    expect(aggregate).not.toBe(aggregateFingerprint([base, 'bbb']))
  })

  it('parses config and cursor tolerantly', () => {
    expect(parseWatchConfig({ path: 'p', condition: 'c', name: 'n', goal: 'g' })).toEqual({
      path: 'p',
      condition: 'c',
      name: 'n',
      goal: 'g',
    })
    expect(parseWatchConfig({ path: 'p' })).toBeUndefined()
    expect(parseWatchConfig({ condition: 'c' })).toBeUndefined()
    expect(parseWatchConfig(null)).toBeUndefined()
    expect(parseWatchCursor({ fingerprints: { a: '1', bad: 2 }, lastScanAt: 't' })).toEqual({
      fingerprints: { a: '1' },
      lastScanAt: 't',
    })
    expect(parseWatchCursor('junk')).toEqual({})
  })

  it('filters structural noise (D4)', () => {
    expect(isNoise('.env', false)).toBe(true)
    expect(isNoise('node_modules', true)).toBe(true)
    expect(isNoise('.git', true)).toBe(true)
    expect(isNoise('~$report.docx', false)).toBe(true)
    expect(isNoise('build.tmp', false)).toBe(true)
    expect(isNoise('Thumbs.db', false)).toBe(true)
    // build outputs are NOT noise — "watch build artifacts" is the use case
    expect(isNoise('dist', true)).toBe(false)
    expect(isNoise('report.pdf', false)).toBe(false)
  })
})

describe('watch: scans, cursor and triggers', () => {
  it('baseline sweep builds the cursor without triggering', async () => {
    writeFileSync(join(watchDir, 'existing.txt'), 'hello')
    const source = makeSource({})
    const triggers = await scan(source, seedWatch())

    expect(triggers).toHaveLength(0)
    const cursor = parseWatchCursor(store.getSource('w1')!.cursor)
    const stats = statSync(join(watchDir, 'existing.txt'))
    expect(cursor.fingerprints).toEqual({
      'existing.txt': fingerprintOfFile('existing.txt', stats.size, stats.mtimeMs),
    })
    expect(cursor.lastScanAt).toBeTruthy()
  })

  it('triggers on added and modified files, then converges (no re-fire)', async () => {
    writeFileSync(join(watchDir, 'base.txt'), 'seed')
    const source = makeSource({})
    await scan(source, seedWatch())

    writeFileSync(join(watchDir, 'added.pdf'), 'new file here')
    writeFileSync(join(watchDir, 'base.txt'), 'seed-changed-longer') // size change → new fingerprint
    const triggers = await scan(source, store.getSource('w1')!)

    expect(triggers).toHaveLength(1)
    const payload = triggers[0]!.payload as WorkspaceChangePayload
    expect(triggers[0]!.untrusted).toBe(true)
    expect(payload.total).toBe(2)
    expect(payload.events.map((e) => e.change).sort()).toEqual(['added', 'modified'])
    expect(payload.rationale).toContain('新增 1 个')
    expect(payload.rationale).toContain('修改 1 个')

    // No further writes → next sweep emits nothing (cursor converged).
    const quiet = await scan(source, store.getSource('w1')!)
    expect(quiet).toHaveLength(0)
  })

  it('restart with the persisted cursor does not replay old changes', async () => {
    const source = makeSource({})
    await scan(source, seedWatch())
    writeFileSync(join(watchDir, 'late.txt'), 'data')
    await scan(source, store.getSource('w1')!) // fires once
    expect(store.listTriggers()).toHaveLength(1)

    // A fresh source (process restart) resumes from the same store cursor.
    const restarted = makeSource({})
    const triggers = await scan(restarted, store.getSource('w1')!)
    expect(triggers).toHaveLength(0)
  })

  it('dropped files leave the cursor (convergence, no leak)', async () => {
    writeFileSync(join(watchDir, 'gone.txt'), 'x')
    const source = makeSource({})
    await scan(source, seedWatch())
    rmSync(join(watchDir, 'gone.txt'))
    await scan(source, store.getSource('w1')!)
    expect(parseWatchCursor(store.getSource('w1')!.cursor).fingerprints).toEqual({})
  })

  it('skips hidden, temp and node_modules entries; follows no symlinks', async () => {
    const source = makeSource({})
    await scan(source, seedWatch()) // baseline

    writeFileSync(join(watchDir, '.hidden'), 'h')
    writeFileSync(join(watchDir, 'draft.tmp'), 't')
    mkdirSync(join(watchDir, 'node_modules'))
    writeFileSync(join(watchDir, 'node_modules', 'pkg.js'), 'nm')
    try {
      symlinkSync(join(watchDir, 'base.txt') /* absent is fine */, join(watchDir, 'link.txt'))
    } catch {
      // Windows symlink needs privileges — the noise assertions still hold
    }
    const triggers = await scan(source, store.getSource('w1')!)
    expect(triggers).toHaveLength(0)
    const tracked = Object.keys(parseWatchCursor(store.getSource('w1')!.cursor).fingerprints ?? {})
    expect(tracked.every((p) => !p.includes('node_modules') && !p.startsWith('.') && !p.endsWith('.tmp') && !p.includes('link.txt'))).toBe(true)
  })

  it('aggregates many changes into one trigger with capped details (D5)', async () => {
    const source = makeSource({})
    await scan(source, seedWatch())
    for (let i = 0; i < 25; i++) writeFileSync(join(watchDir, `f${String(i).padStart(2, '0')}.txt`), `content ${i}`)
    const triggers = await scan(source, store.getSource('w1')!)

    expect(triggers).toHaveLength(1)
    const payload = triggers[0]!.payload as WorkspaceChangePayload
    expect(payload.total).toBe(25)
    expect(payload.events).toHaveLength(20)
    expect(payload.rationale).toContain('仅显示前 20 项')
  })

  it('pulls the next scan forward on watcher events (D1) with debounce', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeWatchFactory()
      const source = makeSource({ watchFactory: fake.factory, sweepIntervalMs: 60_000 })
      const instance = seedWatch()
      source.start(instance, () => undefined)

      // The watcher opens on the first successful scan (not on start — start
      // runs before the workspace registry is ready on the real host).
      await source.tick()
      expect(fake.opened).toEqual([watchDir])

      // Not yet due (nextRunAt = now + sweepInterval after the baseline would
      // be set by a scan; here it is still PAST → due immediately, so set a
      // future nextRunAt to prove pull-forward matters).
      store.upsertSource({ ...store.getSource('w1')!, nextRunAt: new Date(Date.now() + 60_000).toISOString() })
      fake.fire(watchDir)
      expect(Date.parse(store.getSource('w1')!.nextRunAt!)).toBeLessThanOrEqual(Date.now())

      // Debounce: a burst of events inside 1s pulls forward only once — the
      // timestamp stays in the already-pulled position (not re-advanced).
      const pulled = store.getSource('w1')!.nextRunAt!
      fake.fire(dir)
      fake.fire(dir)
      expect(store.getSource('w1')!.nextRunAt).toBe(pulled)

      source.stopAll()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('watch: config validation (D2)', () => {
  it('refuses paths outside registered workspaces (slow retry, no scan)', async () => {
    const outside = join(dir, '..', 'watch-outside-probe')
    mkdirSync(outside, { recursive: true })
    const source = makeSource({ roots: [join(dir, 'subworkspace')] })
    mkdirSync(join(dir, 'subworkspace'))
    writeFileSync(join(outside, 'secret.txt'), 's')
    try {
      const triggers = await scan(source, seedWatch('w-out', outside))
      expect(triggers).toHaveLength(0)
      expect(parseWatchCursor(store.getSource('w-out')!.cursor).fingerprints).toBeUndefined()
      // slow retry (~60s), not the normal sweep cadence — re-check scheduled
      const delayMs = Date.parse(store.getSource('w-out')!.nextRunAt!) - Date.now()
      expect(delayMs).toBeGreaterThan(55_000)
      expect(delayMs).toBeLessThan(65_000)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('degrades to sweep-only when the watcher cannot open', async () => {
    const boom = (): DirWatcher => {
      throw new Error('no recursive watch here')
    }
    const source = makeSource({ watchFactory: boom })
    writeFileSync(join(watchDir, 'later.txt'), 'x')
    await scan(source, seedWatch()) // baseline still works (sweep path)
    writeFileSync(join(watchDir, 'later.txt'), 'x-more')
    const triggers = await scan(source, store.getSource('w1')!)
    expect(triggers).toHaveLength(1) // correctness never depends on the watcher
  })
})

describe('watch: pipeline integration (D6)', () => {
  function assessorWith(verdicts: Assessment[]): Assessor & { inputs: AssessmentInput[] } {
    const inputs: AssessmentInput[] = []
    let i = 0
    return {
      inputs,
      assess(_sourceId, input) {
        inputs.push(input)
        return Promise.resolve(verdicts[i++] ?? { act: false, reason: 'exhausted' })
      },
    }
  }

  function makePipeline(assessor: Assessor, observeMode = true): FilterPipeline {
    return new FilterPipeline(store, { assessor, observeMode: () => observeMode, notifier: new MessageService(store) })
  }

  it('watch payload passes the gate into assessment with untrusted, monitor behavior unchanged, junk dropped', async () => {
    const assessor = assessorWith([{ act: false, reason: 'r' }])
    const pipeline = makePipeline(assessor)

    seedWatch('w1')
    const watchTrigger: Trigger = {
      id: 'trg_w',
      sourceId: 'w1',
      at: new Date().toISOString(),
      untrusted: true,
      payload: {
        path: dir,
        condition: '出现新文件时',
        fingerprint: aggregateFingerprint(['a']),
        total: 1,
        events: [{ path: 'a.txt', change: 'added', size: 5, mtime: new Date().toISOString() }],
        rationale: '工作区「w1」发生文件变更：新增 1 个：新增 a.txt（5B）。',
      },
    }
    expect(await pipeline.handle(watchTrigger)).toBe('skipped')
    expect(assessor.inputs[0]!.untrusted).toBe(true)
    expect(assessor.inputs[0]!.condition).toBe('出现新文件时')

    // Monitor payload shape still routes (no untrusted flag set).
    store.upsertSource({ id: 'm1', kind: 'monitor', enabled: true, config: { target: 't', condition: 'c', intervalMs: 60_000 } })
    const monitorTrigger: Trigger = {
      id: 'trg_m',
      sourceId: 'm1',
      at: new Date().toISOString(),
      payload: { target: 't', condition: 'c', fingerprint: fingerprintOf('A'), rationale: 'hit' },
    }
    expect(await pipeline.handle(monitorTrigger)).toBe('skipped')
    expect(assessor.inputs[1]!.untrusted).toBeUndefined()

    // Junk payload dropped before any assessment.
    expect(await pipeline.handle({ ...watchTrigger, id: 'trg_j', payload: { hello: 1 } })).toBe('dropped')
    expect(assessor.inputs).toHaveLength(2)
  })

  it('auto mode creates an inferred ticket for a watch hit (goal override respected)', async () => {
    const assessor = assessorWith([{ act: true, reason: '值得关注' }])
    const pipeline = makePipeline(assessor, false)
    seedWatch('w1', dir, { goal: '整理新文件' })

    const watchTrigger: Trigger = {
      id: 'trg_w',
      sourceId: 'w1',
      at: new Date().toISOString(),
      untrusted: true,
      payload: {
        path: dir,
        condition: '出现新文件时',
        fingerprint: aggregateFingerprint(['a']),
        total: 1,
        events: [{ path: 'a.txt', change: 'added', size: 5, mtime: new Date().toISOString() }],
        rationale: '新增 1 个：新增 a.txt（5B）。',
      },
    }
    expect(await pipeline.handle(watchTrigger)).toBe('acted')

    const tickets = store.listTickets()
    expect(tickets).toHaveLength(1)
    expect(tickets[0]).toMatchObject({ mandate: 'inferred', origin: 'monitor:w1', goal: '整理新文件' })
    const events = store.listMessages().filter((m) => m.kind === 'event')
    expect(events[0]!.data).toMatchObject({ code: 'source_triggered', sourceId: 'w1' })
    expect(events[0]!.title).toBe('目录变更并创建任务')
  })

  it('observe mode records the would-act report with watch wording', async () => {
    const assessor = assessorWith([{ act: true, reason: '先观察' }])
    const pipeline = makePipeline(assessor, true)
    seedWatch('w1')

    const watchTrigger: Trigger = {
      id: 'trg_w',
      sourceId: 'w1',
      at: new Date().toISOString(),
      untrusted: true,
      payload: {
        path: dir,
        condition: '出现新文件时',
        fingerprint: aggregateFingerprint(['a']),
        total: 3,
        events: [{ path: 'a.txt', change: 'added', size: 5, mtime: new Date().toISOString() }],
        rationale: '新增 3 个（明细截断）：新增 a.txt（5B）。',
      },
    }
    expect(await pipeline.handle(watchTrigger)).toBe('observed')
    const reports = store.listMessages().filter((m) => m.kind === 'event')
    expect(reports).toHaveLength(1)
    expect(reports[0]!.idempotencyKey).toBe(`monitor:w1:would-act:${aggregateFingerprint(['a'])}`)
    expect(reports[0]!.title).toBe('观察模式：目录变更，未执行行动')
    expect(reports[0]!.text).toContain('工作区目录')
  })
})
