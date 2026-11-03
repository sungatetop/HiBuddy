/**
 * HiBuddy AG-UI bridge plugin — host half (S3b, ADR-009 §3).
 *
 * Exposes dsh sessions as an AG-UI 1.0 standard endpoint so AG-UI ecosystem
 * frontends (CopilotKit, any HttpAgent client) can drive the same runtime as
 * dsh's native Web UI. Shape:方案 A — a dsh plugin registers `POST /agui`
 * (HTTP+SSE transport) on the composition webServer; runs map dsh
 * SessionEvents to AG-UI protocol events; tool approvals surface as a
 * RUN_FINISHED interrupt outcome and resume via a follow-up POST carrying
 * ResumeEntry answers (ADR-009 §3.3: AG-UI resume does not map dsh's native
 * continuation — the bridge synthesizes it).
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

/** Wire the AG-UI endpoint for every composition that provides the web carrier. */
export function apply(ctx: Context): void {
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
          res.statusCode = 415
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ code: 'unsupported-media-type', message: 'content-type must be application/json' }))
          return
        }
        let text: string | null
        try {
          text = await readBoundedBody(req)
        } catch {
          text = null
        }
        const parsed = text === null ? { ok: false as const, message: 'request body unreadable or too large' } : parseRunInput(text)
        if (!parsed.ok) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ code: 'bad-request', message: parsed.message }))
          return
        }
        // Transport smoke path (S3b-1): the input round-trips as one minimal
        // run. S3b-2/3 replace this with real session driving + mapping.
        const sink = new SseSink(res)
        sink.send({ type: 'RUN_STARTED', threadId: parsed.input.threadId, runId: parsed.input.runId, input: parsed.input })
        sink.send({ type: 'RUN_FINISHED', threadId: parsed.input.threadId, runId: parsed.input.runId })
        sink.close()
      },
    }), `hibuddy-ag-ui-bridge: ${AGUI_PATH}`)
  })
}
