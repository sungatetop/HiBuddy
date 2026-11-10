/**
 * AG-UI endpoint at the butler layer (ADR-011 D10 / §4.5).
 *
 * `/agui` exposes exactly ONE agent — the resident butler. An AG-UI frontend
 * posts a RunAgentInput whose last user message becomes an inbound ledger row;
 * every outbound row the butler (or an approval card) records during that turn
 * is streamed back as TEXT_MESSAGE_START/CONTENT/END, and the run finishes once
 * the butler pump went idle. Worker sessions and tool calls never cross this
 * boundary: their topology stays internal.
 *
 * Approval decisions also happen in the conversation (D9), so `resume` is not
 * consumed here — the endpoint answers only user text.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { attachmentHref } from './attachments.ts'
import type { ResidentButler } from './butler.ts'
import type { Message } from './domain.ts'

/** Route path of the butler-level AG-UI endpoint. */
export const BUTLER_AGUI_PATH = '/agui'

/** RunAgentInput bodies are chat-sized JSON; anything larger is hostile. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** Longest a single AG-UI run may stay open before the stream closes. */
const RUN_TIMEOUT_MS = 10 * 60 * 1000

/** Structural web-carrier surface (avoids a runtime dep on the host package). */
interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Trust fence face: same rejection codes dsh's own routes use. */
interface FenceConnection {
  requestRejection(req: IncomingMessage): number | undefined
}

/** Minimal RunAgentInput subset read here. */
interface RunAgentInput {
  threadId: string
  runId: string
  messages: Array<{ role: string; content?: unknown }>
}

function jsonError(res: ServerResponse, status: number, code: string, message: string): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ code, message }))
}

/** Reads a bounded request body as UTF-8 text; null past the ceiling. */
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

/** Structural validation of the wire input. */
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

/** Visible text of one AG-UI input message. */
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

/** One open SSE response carrying exactly one butler run. */
class SseRun {
  private readonly res: ServerResponse
  private closed = false

  constructor(res: ServerResponse) {
    this.res = res
    res.statusCode = 200
    res.setHeader('content-type', 'text/event-stream; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('connection', 'keep-alive')
    res.setHeader('x-accel-buffering', 'no')
    res.flushHeaders()
  }

  send(event: Record<string, unknown>): boolean {
    if (this.closed) return false
    return this.res.write(`data: ${JSON.stringify({ timestamp: Date.now(), ...event })}\n\n`)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.res.end()
  }
}

/** Streams one outbound ledger row as an AG-UI assistant text message. */
function streamMessage(sink: SseRun, message: Message): void {
  const blocks = [message.title === undefined ? message.text : `${message.title}\n\n${message.text}`]
  // Attachments ride along as Markdown so any AG-UI frontend can render them;
  // local files point at the host's attachment route (same origin as /agui).
  for (const attachment of message.attachments ?? []) {
    const href = attachmentHref(attachment)
    if (href === undefined) continue
    blocks.push(attachment.kind === 'image' ? `![${attachment.name}](${href})` : `[${attachment.name}](${href})`)
  }
  const text = blocks.join('\n\n')
  sink.send({ type: 'TEXT_MESSAGE_START', messageId: message.id, role: 'assistant' })
  sink.send({ type: 'TEXT_MESSAGE_CONTENT', messageId: message.id, delta: text })
  sink.send({ type: 'TEXT_MESSAGE_END', messageId: message.id })
}

/**
 * Registers `POST /agui` once the composition provides the web carrier + trust
 * fence. The per-session debug bridge lives at a different path (profile
 * patch), so this route owns the product endpoint.
 * @param ctx - root or injected scope providing webServer/connection.
 * @param current - resolves the live butler (undefined before start).
 */
export function registerResidentAgui(ctx: Context, current: () => ResidentButler | undefined): void {
  ctx.inject(['webServer', 'connection'], (scope: Context) => {
    const webServer = Reflect.get(scope, 'webServer') as WebServerLike
    const connection = Reflect.get(scope, 'connection') as FenceConnection
    /** Single user, single butler: at most one AG-UI run at a time. */
    let running = false

    scope.effect(() =>
      webServer.register({
        kind: 'exact',
        path: BUTLER_AGUI_PATH,
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
          const userText = lastUserText(input)
          if (userText === undefined) {
            jsonError(res, 400, 'bad-request', '"messages" must contain a user message with text')
            return
          }
          const butler = current()
          if (butler === undefined) {
            jsonError(res, 503, 'butler-not-ready', 'the resident butler is not running')
            return
          }
          if (running) {
            jsonError(res, 409, 'conflict', 'a butler run is already streaming')
            return
          }

          running = true
          const sink = new SseRun(res)
          let detached = false
          req.on('close', () => {
            detached = true
            sink.close()
          })
          const unsubscribe = butler.onOutbound((message) => {
            if (!detached) streamMessage(sink, message)
          })
          const release = (): void => {
            unsubscribe()
            running = false
            sink.close()
          }

          sink.send({ type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId, input })
          butler.postUserMessage(userText)
          const timeout = new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, RUN_TIMEOUT_MS)
            timer.unref?.()
          })
          await Promise.race([butler.whenIdle(), timeout])
          if (!detached) {
            sink.send({ type: 'RUN_FINISHED', threadId: input.threadId, runId: input.runId })
          }
          release()
        },
      }),
      `hibbuddy-resident: ${BUTLER_AGUI_PATH}`,
    )
  })
}
