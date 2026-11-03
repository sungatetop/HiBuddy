/**
 * Session grant API on the composition webServer (`ctx.webServer.register`).
 *
 * The browser approval card (`@hibuddy/web-ui`, S3-2) POSTs here when the user
 * picks 「本会话内免再询」, then answers the pending request `allowed-once`
 * through the normal remote waterfall. The next escalated call for the same
 * session × tool hits the grant in the approval answerer and never prompts.
 *
 * Security: every route first asks the composition `connection` service for a
 * rejection (Host/Origin fence + login-token cookie) — same trust surface as
 * the official open-in-app routes. Grants for L2 tools are refused outright
 * (SR-01: 免再询不可用于代码执行). Registration is deferred via `ctx.inject`:
 * compositions without a webServer/connection (headless CLI) never register
 * the API, while the approval answerer keeps working.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { L2_TOOLS } from './grading.ts'
import type { ApprovalSessionState } from './state.ts'

/** Route path for the session grant collection. */
export const GRANTS_PATH = '/hibuddy/approvals/grants'

/** Structural webServer surface used here (avoids a runtime dep on the host package). */
interface WebServerLike {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
}

/** Trust surface consumed here; the browser-side connection package owns the full type. */
interface FenceConnection {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/** Grant bodies are tiny JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 16 * 1024

/** JSON response (no-store: grant state is live). */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

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

/** Validate one grant body at the wire: JSON object with non-empty string fields. */
function parseGrantBody(text: string): { sessionId: string; toolName: string } | null {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  const { sessionId, toolName } = body as { sessionId?: unknown; toolName?: unknown }
  if (typeof sessionId !== 'string' || sessionId === '') return null
  if (typeof toolName !== 'string' || toolName === '') return null
  return { sessionId, toolName }
}

/** Register GET/POST/DELETE `/hibuddy/approvals/grants` behind the trust fence. */
export function registerGrantsApi(ctx: Context, state: ApprovalSessionState): void {
  // Deferred until the composition provides the web carrier + trust fence;
  // headless compositions without them simply never register the API while
  // the approval answerer keeps working.
  ctx.inject(['webServer', 'connection'], (scope: Context) => {
    const webServer = Reflect.get(scope, 'webServer') as WebServerLike
    const connection = Reflect.get(scope, 'connection') as FenceConnection
    const rejected = (req: IncomingMessage, res: ServerResponse): boolean => {
      const rejection = connection.requestRejection(req)
      if (rejection === undefined) return false
      res.statusCode = rejection
      res.end()
      return true
    }
    scope.effect(() => webServer.register({
    kind: 'exact',
    path: GRANTS_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method === 'GET') {
        sendJson(res, 200, { grants: state.listGrants() })
        return
      }
      if (req.method === 'POST') {
        const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
        if (essence !== 'application/json') {
          sendJson(res, 415, { code: 'unsupported-media-type', message: 'content-type must be application/json' })
          return
        }
        let text: string | null
        try {
          text = await readBoundedBody(req)
        } catch {
          sendJson(res, 400, { code: 'bad-request', message: 'request body unreadable' })
          return
        }
        const parsed = text === null ? null : parseGrantBody(text)
        if (parsed === null) {
          sendJson(res, 400, { code: 'bad-request', message: 'body must be JSON with non-empty string "sessionId" and "toolName"' })
          return
        }
        if (L2_TOOLS.has(parsed.toolName)) {
          sendJson(res, 403, { code: 'forbidden', message: 'code execution (L2) cannot be granted for a session' })
          return
        }
        state.grant(parsed.sessionId, parsed.toolName)
        sendJson(res, 200, { ok: true })
        return
      }
      if (req.method === 'DELETE') {
        const url = new URL(String(req.url), 'http://localhost')
        const sessionId = url.searchParams.get('sessionId')
        const toolName = url.searchParams.get('toolName')
        if (sessionId === null || sessionId === '' || toolName === null || toolName === '') {
          sendJson(res, 400, { code: 'bad-request', message: 'sessionId and toolName query parameters are required' })
          return
        }
        const removed = state.revoke(sessionId, toolName)
        sendJson(res, removed ? 200 : 404, { ok: removed })
        return
      }
      res.statusCode = 405
      res.setHeader('allow', 'GET, POST, DELETE')
      res.end()
    },
    }), `hibuddy-coworker: ${GRANTS_PATH}`)
  })
}
