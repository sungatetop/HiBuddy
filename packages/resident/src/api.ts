/**
 * Resident chat data API (ADR-011 D2/D11): the WeChat-style client panel reads
 * and writes the conversation ledger through these same-origin routes.
 *
 * Routes (all behind dsh's trust fence, same as the AG-UI bridge):
 * - `GET  /resident/api/messages` → `{ messages, status, unread }`
 * - `POST /resident/api/messages` `{ text }` → `202 { ok: true }`
 * - `GET  /resident/api/attachment?id=` → bytes (Range-capable media stream)
 * - `GET  /resident/api/sessions` → `{ sessions, approvals }` (task drawer)
 * - `GET  /resident/api/settings` → settings snapshot
 * - `POST /resident/api/settings` `{ patch }` → saved snapshot (explicit save)
 *
 * The UI only ever sees ledger rows: user messages and the butler's outbound
 * messages (plus approval cards). Assistant text, tool calls and worker
 * activity are never exposed — that is the product's "thinking is invisible".
 */

import { createReadStream, statSync, type Stats } from 'node:fs'
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

/** One byte range of an attachment response; `'invalid'` means unsatisfiable. */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | undefined {
  if (header === undefined || !header.startsWith('bytes=')) return undefined
  const [rawStart, rawEnd] = header.slice('bytes='.length).split('-', 2)
  const start = rawStart === '' ? Number.NaN : Number(rawStart)
  const end = rawEnd === undefined || rawEnd === '' ? Number.NaN : Number(rawEnd)
  // Suffix range (`bytes=-500`) and open range (`bytes=500-`) both allowed.
  if (Number.isNaN(start) && Number.isNaN(end)) return 'invalid'
  const begin = Number.isNaN(start) ? Math.max(0, size - end) : start
  const finish = Number.isNaN(end) ? size - 1 : Math.min(end, size - 1)
  if (!Number.isFinite(begin) || !Number.isFinite(finish) || begin > finish || begin >= size) return 'invalid'
  return { start: begin, end: finish }
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

    // Attachment media route: serves a registered attachment by id. Only ids
    // present in the ledger are reachable, so path traversal is impossible;
    // Range support lets <video>/<audio> seek.
    route('/resident/api/attachment', 'GET', (req, res, butler) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const id = url.searchParams.get('id')
      if (id === null || id === '') {
        json(res, 400, { error: 'id is required' })
        return
      }
      const attachment = butler.attachment(id)
      if (attachment === undefined) {
        json(res, 404, { error: 'attachment not found' })
        return
      }
      if (attachment.url !== undefined) {
        res.statusCode = 302
        res.setHeader('location', attachment.url)
        res.end()
        return
      }
      if (attachment.path === undefined) {
        json(res, 404, { error: 'attachment has no file' })
        return
      }
      let stats: Stats
      try {
        stats = statSync(attachment.path)
      } catch {
        json(res, 410, { error: 'attachment file is gone' })
        return
      }
      if (!stats.isFile()) {
        json(res, 410, { error: 'attachment is not a file' })
        return
      }
      const inline = attachment.kind === 'image' || attachment.kind === 'video' || attachment.kind === 'audio'
      const disposition = url.searchParams.get('download') === '1' || !inline ? 'attachment' : 'inline'
      res.setHeader('content-type', attachment.mime ?? 'application/octet-stream')
      res.setHeader('x-content-type-options', 'nosniff')
      // Sandboxed responses ensure a direct navigation to an SVG/HTML file
      // cannot run script in the product origin.
      res.setHeader('content-security-policy', 'sandbox')
      res.setHeader('cache-control', 'private, max-age=60')
      res.setHeader(
        'content-disposition',
        `${disposition}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
      )
      res.setHeader('accept-ranges', 'bytes')
      const range = parseRange(req.headers.range, stats.size)
      if (range === 'invalid') {
        res.statusCode = 416
        res.setHeader('content-range', `bytes */${stats.size}`)
        res.end()
        return
      }
      if (range !== undefined) {
        res.statusCode = 206
        res.setHeader('content-length', range.end - range.start + 1)
        res.setHeader('content-range', `bytes ${range.start}-${range.end}/${stats.size}`)
        if (req.method === 'HEAD') {
          res.end()
          return
        }
        createReadStream(attachment.path, { start: range.start, end: range.end }).pipe(res)
        return
      }
      res.setHeader('content-length', stats.size)
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      createReadStream(attachment.path).pipe(res)
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
