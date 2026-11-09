/**
 * Resident chat data API (ADR-011 D2/D11): the WeChat-style client panel reads
 * and writes the conversation ledger through these same-origin routes.
 *
 * Routes (all behind dsh's trust fence, same as the AG-UI bridge):
 * - `GET  /resident/api/messages` → `{ messages, status, unread }`
 * - `POST /resident/api/messages` `{ text }` → `202 { ok: true }`
 * - `GET  /resident/api/sessions` → `{ sessions, approvals }` (task drawer)
 * - `GET  /resident/api/settings` → settings snapshot
 * - `POST /resident/api/settings` `{ patch }` → saved snapshot (explicit save)
 *
 * The UI only ever sees ledger rows: user messages and the butler's outbound
 * messages (plus approval cards). Assistant text, tool calls and worker
 * activity are never exposed — that is the product's "thinking is invisible".
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { ResidentButler } from './butler.ts'
import type { ResidentSettings } from './domain.ts'

/** Maximum accepted user message length (characters). */
const MAX_TEXT = 8000

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

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/** Reads a bounded JSON body; returns undefined on overflow or bad JSON. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 64 * 1024) return undefined
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    return undefined
  }
}

/**
 * Registers the chat data routes once the composition provides the web
 * carrier + trust fence (headless compositions never register them).
 * @param ctx - root or injected scope providing webServer/connection.
 * @param current - resolves the live butler (may be undefined before start).
 */
export function registerResidentApi(ctx: Context, current: () => ResidentButler | undefined): void {
  ctx.inject(['webServer', 'connection'], (scope: Context) => {
    const webServer = Reflect.get(scope, 'webServer') as WebServerLike
    const connection = Reflect.get(scope, 'connection') as FenceConnection

    /** Registers one exact route behind the trust fence, with a not-ready guard. */
    const route = (
      path: string,
      methods: string,
      handler: (req: IncomingMessage, res: ServerResponse, butler: ResidentButler) => Promise<void> | void,
    ): void => {
      scope.effect(() =>
        webServer.register({
          kind: 'exact',
          path,
          handler: async (req, res) => {
            const rejection = connection.requestRejection(req)
            if (rejection !== undefined) {
              res.statusCode = rejection
              res.end()
              return
            }
            const butler = current()
            if (butler === undefined) {
              json(res, 503, { error: 'resident-butler-not-ready' })
              return
            }
            if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
              res.statusCode = 405
              res.setHeader('allow', methods)
              res.end()
              return
            }
            await handler(req, res, butler)
          },
        }),
        `hibuddy-resident: ${path} API`,
      )
    }

    route('/resident/api/messages', 'GET, POST', async (req, res, butler) => {
      if (req.method === 'GET' || req.method === 'HEAD') {
        json(res, 200, {
          messages: butler.messages(),
          status: butler.status(),
          unread: butler.unreadCount(),
        })
        return
      }
      const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
      if (essence !== 'application/json') {
        json(res, 415, { error: 'content-type must be application/json' })
        return
      }
      const body = await readJson(req)
      const text = typeof body === 'object' && body !== null ? (body as { text?: unknown }).text : undefined
      if (typeof text !== 'string' || text.trim() === '') {
        json(res, 400, { error: 'text is required' })
        return
      }
      butler.postUserMessage(text.trim().slice(0, MAX_TEXT))
      json(res, 202, { ok: true })
    })

    // Task drawer: delegated worker sessions + approvals waiting on a decision.
    route('/resident/api/sessions', 'GET', (_req, res, butler) => {
      json(res, 200, { sessions: butler.listSessions(), approvals: butler.pendingApprovals() })
    })

    // Settings page: read the snapshot; POST saves the patch explicitly.
    route('/resident/api/settings', 'GET, POST', async (req, res, butler) => {
      if (req.method === 'GET' || req.method === 'HEAD') {
        json(res, 200, butler.settings())
        return
      }
      const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
      if (essence !== 'application/json') {
        json(res, 415, { error: 'content-type must be application/json' })
        return
      }
      const body = await readJson(req)
      const patch = typeof body === 'object' && body !== null ? (body as { patch?: unknown }).patch : undefined
      if (typeof patch !== 'object' || patch === null) {
        json(res, 400, { error: 'patch is required' })
        return
      }
      json(res, 200, butler.saveSettings(patch as ResidentSettings))
    })
  })
}
