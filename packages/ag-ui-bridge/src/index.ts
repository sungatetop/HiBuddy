/**
 * HiBuddy AG-UI bridge plugin — host half (S3b, ADR-009 §3).
 *
 * Exposes dsh sessions as an AG-UI 1.0 standard endpoint so AG-UI ecosystem
 * frontends (CopilotKit, any HttpAgent client) can drive the same runtime as
 * dsh's native Web UI. Shape: 方案 A — a dsh plugin registers `POST /agui`
 * (HTTP+SSE transport) on the composition webServer; each POST drives one run:
 *
 *   auth fence → validate RunAgentInput → ensure the bridge-owned session
 *   → open SSE → RUN_STARTED → agent.followup(user text)
 *   → SessionEvent feed mapped onto AG-UI events until turn/end closes the run
 *
 * Tool approvals surface as a RUN_FINISHED interrupt outcome and resume via a
 * follow-up POST carrying ResumeEntry answers (S3b-3, ADR-009 §3.3).
 *
 * Trust: every request first goes through the composition `connection`
 * service's rejection fence (Host/Origin + login-token cookie) — the same
 * trust surface as dsh's own routes (ADR-006). The bridge adds a route and
 * nothing else: dsh's native Web UI channels (mux/journal/composer) are
 * untouched, and sessions created outside the bridge are never driven by it
 * (their approvals pass through to the interactive answerer chain untouched).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { mapSessionEvent, newMappingState, terminalOf } from './events.ts'
import { BridgeSessions, detachActive, sessionIdFor } from './sessions.ts'
import type { SessionRecord } from './sessions.ts'
import { answerPendings, cancelPendings, captureApproval } from './approvals.ts'
import { SseSink } from './sse.ts'
import type { RunAgentInput } from './types.ts'

/** Cordis function-plugin name. */
export const name = 'hibuddy-ag-ui-bridge'

/** Route path for the AG-UI HTTP+SSE endpoint. */
export const AGUI_PATH = '/agui'

/** Structural webServer surface used here (avoids a runtime dep on the host package). */
interface WebServerLike {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
}

/** Trust surface consumed here; the browser-side connection package owns the full type. */
interface FenceConnection {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/** RunAgentInput bodies are chat-sized JSON; anything larger is hostile. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** Collect a bounded request body as UTF-8 text; null past the ceiling (stream drained). */
async function readBoundedBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/** Structural validation of the wire input; returns the parsed input or a rejection reason. */
function parseRunInput(text: string): { ok: true; input: RunAgentInput } | { ok: false; message: string } {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, message: 'body must be a JSON object (RunAgentInput)' }
  }
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'body must be a JSON object (RunAgentInput)' }
  }
  const { threadId, runId, messages } = body as Partial<RunAgentInput>
  if (typeof threadId !== 'string' || threadId === '') return { ok: false, message: '"threadId" must be a non-empty string' }
  if (typeof runId !== 'string' || runId === '') return { ok: false, message: '"runId" must be a non-empty string' }
  if (!Array.isArray(messages)) return { ok: false, message: '"messages" must be an array' }
  return { ok: true, input: body as RunAgentInput }
}

/** Visible text of an AG-UI input message: plain string or text content parts joined. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    let text = ''
    for (const part of content) {
      if (typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text') {
        const piece = (part as { text?: unknown }).text
        if (typeof piece === 'string') text += piece
      }
    }
    return text
  }
  return ''
}

/** The last user message's text, or undefined when the input carries none. */
function lastUserText(input: RunAgentInput): string | undefined {
  for (let i = input.messages.length - 1; i >= 0; i -= 1) {
    const message = input.messages[i]
    if (message.role === 'user') {
      const text = messageText(message.content).trim()
      return text === '' ? undefined : text
    }
  }
  return undefined
}

/** Send a run's mapped events, closing the run on the turn's terminal event. */
function pumpSessionEvent(record: SessionRecord, event: SessionEvent, threadId: string): void {
  const run = record.active
  if (run === undefined) return
  if (event.type === 'turn/end') {
    const terminal = terminalOf(event.data.reason, threadId, run.runId)
    run.sink.send(terminal)
    run.sink.close()
    detachActive(record, run.runId)
    return
  }
  for (const mapped of mapSessionEvent(event, run.mapper)) {
    if (!run.sink.send(mapped)) break // client gone: the disconnect handler owns cleanup
  }
}

/** Wire the AG-UI endpoint for every composition that provides the web carrier. */
export function apply(ctx: Context): void {
  const sessions = new BridgeSessions(ctx)

  // One global feed subscription: events of bridge-owned sessions are mapped
  // onto the session's open SSE run; every other session is ignored.
  ctx.on('session/event', (session, event) => {
    const record = sessions.ownsSession(session)
    if (record !== undefined) pumpSessionEvent(record, event, record.threadId)
  })

  // Disposed bridge sessions leave the registry (their pendings die cancelled).
  ctx.on('session/disposed', (session) => {
    const record = sessions.ownsSession(session)
    if (record !== undefined) {
      cancelPendings(record)
      sessions.drop(session)
    }
  })

  // Tail of the approval answerer chain: the coworker answerer runs first
  // (L2 backstop, session grants); what reaches here needs a human decision.
  // Bridge-owned sessions wait for the AG-UI client's resume answer; foreign
  // (native Web UI) sessions delegate onward untouched.
  ctx.on('approval/request', (req, next) => {
    const record = sessions.ownsAgent(req.agent)
    if (record === undefined) return next()
    return captureApproval(record, { toolName: req.toolName, callId: req.callId, reason: req.displayReason?.en ?? req.reason })
  })

  // Deferred until the composition provides the web carrier + trust fence;
  // headless compositions without them never register the route.
  ctx.inject(['webServer', 'connection'], (scope: Context) => {
    const webServer = Reflect.get(scope, 'webServer') as WebServerLike
    const connection = Reflect.get(scope, 'connection') as FenceConnection
    scope.effect(() => webServer.register({
      kind: 'exact',
      path: AGUI_PATH,
      handler: async (req, res) => {
        const rejection = connection.requestRejection(req)
        if (rejection !== undefined) {
          res.statusCode = rejection
          res.end()
          return
        }
        if (req.method !== 'POST') {
          res.statusCode = req.method === 'GET' || req.method === 'HEAD' ? 405 : 404
          res.setHeader('allow', 'POST')
          res.end()
          return
        }
        const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
        if (essence !== 'application/json') {
          jsonError(res, 415, 'unsupported-media-type', 'content-type must be application/json')
          return
        }
        let text: string | null
        try {
          text = await readBoundedBody(req)
        } catch {
          text = null
        }
        const parsed = text === null
          ? { ok: false as const, message: 'request body unreadable or too large' }
          : parseRunInput(text)
        if (!parsed.ok) {
          jsonError(res, 400, 'bad-request', parsed.message)
          return
        }
        const { input } = parsed

        // One open run per session: AG-UI clients are synchronous per thread.
        if (sessions.hasActiveRun(sessionIdFor(input.threadId))) {
          jsonError(res, 409, 'conflict', 'a run is already streaming for this thread')
          return
        }
        let record: SessionRecord
        try {
          record = await sessions.ensure(input.threadId)
        } catch (error) {
          jsonError(res, 500, 'session-error', `failed to open the session: ${String(error)}`)
          return
        }
        if (record.active !== undefined) {
          jsonError(res, 409, 'conflict', 'a run is already streaming for this thread')
          return
        }

        // A resume POST continues an interrupted run (S3b-3): answers go to the
        // captured pendings and the suspended turn continues in place. A fresh
        // user message may ride along; alone it starts an ordinary new run.
        const resumeEntries = Array.isArray(input.resume) ? input.resume : []
        const userText = lastUserText(input)
        if (resumeEntries.length === 0 && userText === undefined) {
          jsonError(res, 400, 'bad-request', '"messages" must contain a user message with text (or "resume" answers)')
          return
        }

        const sink = new SseSink(res)
        const run = { runId: input.runId, sink, mapper: newMappingState() }
        record.active = run
        // A dropped connection must not hold the run slot: detach so later
        // events are dropped instead of written into a dead socket. The turn
        // itself keeps running server-side (no resumption: registered MVP gap).
        req.on('close', () => {
          if (record.active?.runId === run.runId) {
            run.sink.close()
            detachActive(record, run.runId)
          }
        })

        sink.send({ type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId, input })
        const answered = answerPendings(record, resumeEntries)
        if (answered === 0 && resumeEntries.length > 0 && userText === undefined) {
          // Nothing to continue and nothing to start: end the run honestly.
          detachActive(record, run.runId)
          sink.send({ type: 'RUN_ERROR', message: 'resume answered no pending approval', code: 'UNKNOWN_INTERRUPT' })
          sink.close()
          return
        }
        if (userText !== undefined) {
          try {
            record.handle.agent.followup(createUserMessage({
              content: [{ type: 'text', text: userText }],
              source: { kind: 'user' },
            }))
          } catch (error) {
            detachActive(record, run.runId)
            sink.send({ type: 'RUN_ERROR', message: `failed to start the run: ${String(error)}`, code: 'FOLLOWUP_FAILED' })
            sink.close()
          }
        }
      },
    }), `hibuddy-ag-ui-bridge: ${AGUI_PATH}`)
  })
}

/** JSON error body for pre-run rejections (HTTP status, no event stream). */
function jsonError(res: ServerResponse, status: number, code: string, message: string): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ code, message }))
}
