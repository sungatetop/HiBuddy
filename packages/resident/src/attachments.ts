/**
 * Message attachments (ADR-011 message surface, WeChat parity).
 *
 * The butler may attach images, videos, audio or documents to an outbound
 * message. Attachments are either a LOCAL FILE or a REMOTE URL:
 *
 * - Local files must live under a registered workspace root (the only place
 *   workers produce output). That whitelist keeps a prompt-injected worker
 *   from making the butler leak arbitrary files by path.
 * - Remote URLs must be http(s); the client loads them directly.
 *
 * The resolved row is stored in `attachments` and served by the host at
 * `/resident/api/attachment?id=<id>` (see api.ts), so the client never needs
 * the original filesystem path — and the serve route only knows registered
 * ids, which rules out path traversal.
 */

import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { basename, extname, normalize, resolve, sep } from 'node:path'
import type { AttachmentKind, MessageAttachment } from './domain.ts'

/** Kinds accepted on the tool surface. */
export const ATTACHMENT_KINDS: readonly AttachmentKind[] = ['image', 'video', 'audio', 'file']

/** One attachment as the butler states it (`send_message_to_user.attachments[]`). */
export interface AttachmentRequest {
  /** Local file path (must sit under a workspace root). */
  path?: string
  /** Remote http(s) URL. */
  url?: string
  /** Display name; defaults to the basename / URL last segment. */
  name?: string
  /** Overrides extension-based detection (image/video/audio/file). */
  kind?: AttachmentKind
}

/** MIME types for the extensions we expect to see from workers. */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

/** Media kind implied by an extension (everything else is a plain file). */
export function kindOfExtension(extension: string): AttachmentKind {
  const ext = extension.toLowerCase()
  const mime = MIME_BY_EXT[ext]
  if (mime === undefined) return 'file'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'file'
}

/** MIME type implied by an extension, when known. */
export function mimeOfExtension(extension: string): string | undefined {
  return MIME_BY_EXT[extension.toLowerCase()]
}

/** Normalized comparison form for Windows paths (case-insensitive, no trailing sep). */
export function canonical(path: string): string {
  const normalized = normalize(resolve(path))
  return (process.platform === 'win32' ? normalized.toLowerCase() : normalized).replace(
    new RegExp(`\\${sep}+$`),
    '',
  )
}

/** True when `target` is the root itself or sits anywhere beneath it. */
export function inside(root: string, target: string): boolean {
  const base = canonical(root)
  const candidate = canonical(target)
  return candidate === base || candidate.startsWith(`${base}${sep}`)
}

/** True for an absolute-looking local path on this platform. */
function looksLocal(path: string): boolean {
  return process.platform === 'win32' ? /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\') : path.startsWith('/')
}

/**
 * Validates the model-supplied attachment list and resolves it into rows ready
 * to persist. Throws a user-facing (Chinese) error on the first bad entry so
 * the butler can correct its call.
 * @param requests - raw `attachments` tool argument.
 * @param roots - workspace roots local paths must live under.
 */
export function prepareAttachments(requests: unknown, roots: readonly string[]): MessageAttachment[] {
  if (requests === undefined || requests === null) return []
  if (!Array.isArray(requests)) throw new Error('attachments 必须是数组')
  return requests.map((entry, index) => prepareOne(entry, index, roots))
}

function prepareOne(entry: unknown, index: number, roots: readonly string[]): MessageAttachment {
  const label = `第 ${index + 1} 个附件`
  if (typeof entry !== 'object' || entry === null) throw new Error(`${label}必须是对象（{path} 或 {url}）`)
  const request = entry as AttachmentRequest
  const path = typeof request.path === 'string' ? request.path.trim() : ''
  const url = typeof request.url === 'string' ? request.url.trim() : ''
  if ((path === '') === (url === '')) throw new Error(`${label}必须且只能提供 path 或 url 之一`)

  const explicitKind =
    request.kind === undefined
      ? undefined
      : ATTACHMENT_KINDS.includes(request.kind)
        ? request.kind
        : undefined
  if (request.kind !== undefined && explicitKind === undefined) {
    throw new Error(`${label}的 kind 无效（可选：${ATTACHMENT_KINDS.join(' / ')}）`)
  }

  if (url !== '') {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error(`${label}的 url 不是合法地址`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`${label}只支持 http/https 链接`)
    }
    const extension = extname(parsed.pathname)
    const decoded = (() => {
      try {
        return decodeURIComponent(basename(parsed.pathname))
      } catch {
        return basename(parsed.pathname)
      }
    })()
    const name = request.name?.trim() || decoded || parsed.hostname
    return {
      id: `att_${randomUUID()}`,
      kind: explicitKind ?? kindOfExtension(extension),
      name,
      url: parsed.toString(),
      ...(mimeOfExtension(extension) !== undefined ? { mime: mimeOfExtension(extension)! } : {}),
    }
  }

  if (!looksLocal(path)) throw new Error(`${label}的 path 必须是绝对路径`)
  const canonicalPath = resolve(path)
  if (!roots.some((root) => inside(root, canonicalPath))) {
    throw new Error(
      `${label}不在任何工作区内（仅允许工作区目录下的文件）：${canonicalPath}；` +
        `可用工作区：${roots.length === 0 ? '无' : roots.join('、')}`,
    )
  }
  let stats
  try {
    stats = statSync(canonicalPath)
  } catch {
    throw new Error(`${label}的文件不存在：${canonicalPath}`)
  }
  if (!stats.isFile()) throw new Error(`${label}不是文件：${canonicalPath}`)

  const extension = extname(canonicalPath)
  return {
    id: `att_${randomUUID()}`,
    kind: explicitKind ?? kindOfExtension(extension),
    name: request.name?.trim() || basename(canonicalPath),
    path: canonicalPath,
    ...(mimeOfExtension(extension) !== undefined ? { mime: mimeOfExtension(extension)! } : {}),
    size: stats.size,
  }
}

/** URL the chat client uses to preview one attachment (local files only). */
export function attachmentHref(attachment: MessageAttachment): string | undefined {
  if (attachment.url !== undefined) return attachment.url
  if (attachment.path === undefined) return undefined
  return `/resident/api/attachment?id=${encodeURIComponent(attachment.id)}`
}
