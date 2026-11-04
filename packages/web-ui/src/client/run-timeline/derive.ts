/**
 * Run-timeline derivation (PRD FR-08, S5-2): pure projection from the client
 * session event window to per-turn run timelines.
 *
 * A Run is one conversation turn: the queued input the turn claimed (the
 * prompt), the steps the agent loop executed (tool calls with arguments and
 * result summaries), the assistant outputs with their token accounting, and
 * the terminal status (turn/end reason). The projection is pure so the tab
 * body re-derives on every event-window publication (live append falls out —
 * the window grows as the run progresses) and the Markdown exporter consumes
 * the same structure.
 */
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ApprovalDecisionRecord } from './decisions.ts'

/** Terminal status of one run, projected from the `turn/end` reason. */
export type RunStatus =
  | { kind: 'running' }
  | { kind: 'completed' }
  | { kind: 'aborted' }
  | { kind: 'blocked' }
  | { kind: 'max-tokens' }
  | { kind: 'interrupted' }
  | { kind: 'forked' }
  | { kind: 'error'; message: string }

/** One timeline row of a run. */
export type RunTimelineItem =
  | { kind: 'prompt'; seq: number; at: number; text: string }
  | { kind: 'step'; seq: number; at: number; step: number }
  | {
      kind: 'tool'
      seq: number
      at: number
      callId: string
      name: string
      /** Raw argument JSON exactly as the model produced it. */
      argsRaw: string
      status: 'running' | 'ok' | 'error'
      resultAt?: number
      durationMs?: number
      /** Joined text of the result's text blocks (truncated). */
      resultSummary?: string
      /** Failure reason carried outside the model-facing message. */
      errorReason?: string
      /** Card decision recorded at press time, when one was observed. */
      decision?: ApprovalDecisionRecord
    }
  | {
      kind: 'output'
      seq: number
      at: number
      step: number
      text: string
      outputTokens?: number
      interrupted?: true
    }

/** One run: a turn's prompt, timeline rows, and terminal status. */
export interface RunTimeline {
  readonly turn: number
  readonly startedAt: number
  readonly endedAt?: number
  readonly status: RunStatus
  /** First human prompt of the turn (empty for continuation turns). */
  readonly prompt: string
  readonly items: readonly RunTimelineItem[]
}

/** Upper bound for joined summaries the UI shows inline. */
export const SUMMARY_LIMIT = 1200

/** One-line result bound for the run summary (FR-02): the full text stays in the timeline. */
export const RUN_RESULT_LIMIT = 200

/** No-event bound after which a running run reads as possibly stuck (PRD FR-02 rule 5). */
export const STALL_THRESHOLD_MS = 120_000

/** Tool-call counts of one run, by observed status. */
export interface RunToolStats {
  total: number
  ok: number
  error: number
  running: number
}

/** Run 摘要 (PRD FR-02: goal, result, tool-call statistics, duration). */
export interface RunSummary {
  /** First human prompt of the turn — the run's goal. */
  readonly goal: string
  /** Final assistant output, clamped to one display line ('' while none yet). */
  readonly result: string
  readonly tools: RunToolStats
  /** Wall-clock duration so far: `endedAt - startedAt`, else `now - startedAt`. */
  readonly durationMs: number
}

/** Build the run summary from the derived timeline (pure; `now` injectable for tests). */
export function summarizeRun(run: RunTimeline, now = Date.now()): RunSummary {
  let result = ''
  for (const item of run.items) {
    if (item.kind === 'output' && item.text !== '') result = item.text
  }
  const tools = { total: 0, ok: 0, error: 0, running: 0 }
  for (const item of run.items) {
    if (item.kind !== 'tool') continue
    tools.total += 1
    tools[item.status] += 1
  }
  return {
    goal: run.prompt,
    result: clamp(result, RUN_RESULT_LIMIT),
    tools,
    durationMs: Math.max(0, (run.endedAt ?? now) - run.startedAt),
  }
}

/**
 * Milliseconds since the run's last observed event (prompt/step/tool/output
 * rows all carry an event time). Non-running runs report 0 — the stalled
 * reading only applies while a run is still open (the UI gates on status).
 */
export function runStallMs(run: RunTimeline, now = Date.now()): number {
  if (run.status.kind !== 'running') return 0
  let last = run.startedAt
  for (const item of run.items) {
    if (item.at > last) last = item.at
  }
  return Math.max(0, now - last)
}

/** Text of a content-block list: joined `text` blocks, defensively read. */
function textOf(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string' && text.length > 0) parts.push(text)
    }
  }
  return parts.join('\n')
}

/** Truncate one-line summaries to the display bound. */
function clamp(text: string, limit = SUMMARY_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/** Whether a user message came from a human (not a synthetic injection). */
function isHumanPrompt(data: unknown): boolean {
  const source = (data as { source?: { kind?: unknown } } | null)?.source
  return typeof source === 'object' && source !== null && (source as { kind?: unknown }).kind === 'user'
}

/** Mutable per-turn accumulator used while scanning the window. */
interface MutableRun {
  turn: number
  startedAt: number
  endedAt?: number
  status: RunStatus
  prompt: string
  items: RunTimelineItem[]
}

/** Derive every run present in the (contiguous) event window, in turn order. */
export function deriveRunTimelines(
  entries: readonly SessionEventLikeEntry[],
  decisions: ReadonlyMap<string, ApprovalDecisionRecord> = new Map(),
): readonly RunTimeline[] {
  const runs = new Map<number, MutableRun>()
  let current: MutableRun | undefined
  const toolByCallId = new Map<string, Extract<RunTimelineItem, { kind: 'tool' }>>()
  for (const entry of entries) {
    if (entry.type !== 'event') continue // live chunks are transient stream rows, not timeline facts
    const event = entry.event
    const data = event.data as Record<string, unknown>
    switch (event.type) {
      case 'turn/start': {
        const turn = data.turn as number
        current = { turn, startedAt: event.time, status: { kind: 'running' }, prompt: '', items: [] }
        runs.set(turn, current)
        break
      }
      case 'turn/end': {
        const run = runs.get(data.turn as number)
        if (run === undefined) break
        const reason = (data.reason ?? {}) as { kind?: string; error?: { message?: unknown } }
        switch (reason.kind) {
          case 'completed': run.status = { kind: 'completed' }; break
          case 'aborted': run.status = { kind: 'aborted' }; break
          case 'blocked': run.status = { kind: 'blocked' }; break
          case 'max-tokens': run.status = { kind: 'max-tokens' }; break
          case 'interrupted': run.status = { kind: 'interrupted' }; break
          case 'forked': run.status = { kind: 'forked' }; break
          case 'error': {
            const message = typeof reason.error?.message === 'string' ? reason.error.message : 'unknown error'
            run.status = { kind: 'error', message }
            break
          }
          default: run.status = { kind: 'interrupted' }
        }
        run.endedAt = event.time
        if (current?.turn === run.turn) current = undefined
        break
      }
      case 'user/message': {
        // A queued human message admitted into the open turn; synthetic
        // injections (agent.inject contexts) carry other source kinds.
        if (current === undefined || !isHumanPrompt(data)) break
        const text = clamp(textOf(data.content), 400)
        if (current.prompt === '') current.prompt = text
        current.items.push({ kind: 'prompt', seq: event.seq, at: event.time, text })
        break
      }
      case 'step/start': {
        const run = runs.get(data.turn as number)
        if (run === undefined) break
        run.items.push({ kind: 'step', seq: event.seq, at: event.time, step: data.step as number })
        break
      }
      case 'tool/call': {
        const run = runs.get(data.turn as number)
        if (run === undefined) break
        const item: Extract<RunTimelineItem, { kind: 'tool' }> = {
          kind: 'tool',
          seq: event.seq,
          at: event.time,
          callId: data.callId as string,
          name: data.name as string,
          argsRaw: typeof data.arguments === 'string' ? data.arguments : '',
          status: 'running',
          decision: decisions.get(data.callId as string),
        }
        run.items.push(item)
        toolByCallId.set(item.callId, item)
        break
      }
      case 'tool/result': {
        const callId = (data.message as { toolCallId?: unknown } | null)?.toolCallId
        if (typeof callId !== 'string') break
        const item = toolByCallId.get(callId)
        if (item === undefined) break
        const message = data.message as { isError?: boolean }
        item.status = message.isError === true ? 'error' : 'ok'
        item.resultAt = event.time
        item.durationMs = Math.max(0, event.time - item.at)
        const summary = textOf((data.message as { content?: unknown }).content)
        if (summary.length > 0) item.resultSummary = clamp(summary)
        const failure = data.error as { reason?: unknown } | undefined
        if (typeof failure?.reason === 'string') item.errorReason = clamp(failure.reason, 300)
        if (item.decision === undefined) item.decision = decisions.get(callId)
        break
      }
      case 'assistant/message': {
        const run = runs.get(data.turn as number)
        if (run === undefined) break
        const text = textOf((data.message as { content?: unknown }).content)
        if (text.length === 0 && data.interrupted !== true) break
        const usage = data.usage as { outputTokens?: unknown } | undefined
        run.items.push({
          kind: 'output',
          seq: event.seq,
          at: event.time,
          step: data.step as number,
          text,
          outputTokens: typeof usage?.outputTokens === 'number' ? usage.outputTokens : undefined,
          interrupted: data.interrupted === true ? true : undefined,
        })
        break
      }
      default: break
    }
  }
  return [...runs.values()].map((run) => ({ ...run, items: [...run.items] }))
}
