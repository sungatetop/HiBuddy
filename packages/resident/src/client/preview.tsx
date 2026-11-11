/**
 * Unified canvas preview (2026-11-10) — ONE full-screen canvas reused by every
 * "open" action in the butler chat: images are drawn onto it, text files are
 * rendered as paginated text; anything else falls back to download. Videos and
 * audio stay as inline controls in the bubble (they already play in place).
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { attachmentSrc, type ChatAttachment } from './api.ts'

/** Source-like extensions previewable inside the canvas (paginated text). */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'yml', 'yaml',
  'xml', 'html', 'htm', 'ini', 'conf', 'cfg', 'toml', 'sql', 'env',
  'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'less',
  'sh', 'bat', 'ps1', 'psm1', 'gitignore', 'editorconfig',
])

/** Text files larger than this are not fetched into the canvas (download instead). */
const TEXT_MAX_BYTES = 2 * 1024 * 1024

const TEXT_FONT = '12px ui-monospace, "Cascadia Code", Consolas, monospace'
const TEXT_LINE_HEIGHT = 20
const PADDING_X = 28
const PADDING_Y = 24

export type PreviewKind = 'image' | 'text' | 'unsupported'

/** What the unified canvas can show for one attachment. */
export function previewKindOf(attachment: ChatAttachment): PreviewKind {
  if (attachment.kind === 'image') return 'image'
  const dot = attachment.name.lastIndexOf('.')
  const extension = dot > 0 ? attachment.name.slice(dot + 1).toLowerCase() : ''
  return TEXT_EXTENSIONS.has(extension) ? 'text' : 'unsupported'
}

const styles = {
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 1000,
    background: 'rgba(0,0,0,0.85)',
    display: 'flex',
    flexDirection: 'column',
  } as CSSProperties,
  canvas: {
    flex: 1,
    minHeight: 0,
    display: 'block',
    width: '100%',
    cursor: 'zoom-out',
  } as CSSProperties,
  toolbar: {
    flex: 'none',
    height: 48,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '0 16px',
    background: '#2a2a2a',
    color: '#eeeeee',
    fontSize: 13,
  } as CSSProperties,
  toolbarLeft: { display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 } as CSSProperties,
  fileName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '46vw',
  } as CSSProperties,
  pages: { flex: 'none', fontSize: 12, color: '#9a9a9a' } as CSSProperties,
  toolbarRight: { display: 'flex', alignItems: 'center', gap: 10, flex: 'none' } as CSSProperties,
  toolButton: {
    padding: '5px 12px',
    borderRadius: 6,
    border: '1px solid #4a4a4a',
    background: '#3a3a3a',
    color: '#eeeeee',
    fontSize: 12,
    cursor: 'pointer',
    flex: 'none',
  } as CSSProperties,
  toolLink: {
    padding: '5px 12px',
    borderRadius: 6,
    border: '1px solid #4a4a4a',
    background: '#3a3a3a',
    color: '#eeeeee',
    fontSize: 12,
    textDecoration: 'none',
    flex: 'none',
  } as CSSProperties,
}

/** Greedy word-wrap of every line against `maxWidth`, preserving empty lines. */
function wrapLines(ctx: CanvasRenderingContext2D, lines: readonly string[], maxWidth: number): string[] {
  const out: string[] = []
  for (const line of lines) {
    if (line === '' || ctx.measureText(line).width <= maxWidth) {
      out.push(line)
      continue
    }
    let current = ''
    for (const char of line) {
      const candidate = current + char
      if (ctx.measureText(candidate).width > maxWidth) {
        out.push(current)
        current = char
      } else {
        current = candidate
      }
    }
    out.push(current)
  }
  return out
}

type Loaded =
  | { kind: 'image'; bitmap: HTMLImageElement }
  | { kind: 'text'; lines: string[] }
  | { kind: 'error'; text: string }

/**
 * Full-screen preview layer. A single canvas is reused for every open action;
 * content changes (image vs text vs unsupported) only swap what is drawn.
 */
export function CanvasPreview({
  attachment,
  onClose,
}: {
  attachment: ChatAttachment
  onClose: () => void
}): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [kind] = useState<PreviewKind>(() => previewKindOf(attachment))
  const [loaded, setLoaded] = useState<Loaded | undefined>(() =>
    kind === 'unsupported' ? { kind: 'error', text: '该文件类型暂不支持预览，请下载后查看' } : undefined,
  )
  const [page, setPage] = useState(1)
  const [pageCount, setPageCount] = useState(1)
  const [, setTick] = useState(0)

  const src = attachmentSrc(attachment)
  const downloadHref = `${src}${src.includes('?') ? '&' : '?'}download=1`

  // Load the content once (image decode / text fetch).
  useEffect(() => {
    let disposed = false
    if (kind === 'image') {
      const image = new Image()
      image.onload = () => {
        if (!disposed) {
          setLoaded({ kind: 'image', bitmap: image })
          setTick((value) => value + 1)
        }
      }
      image.onerror = () => {
        if (!disposed) setLoaded({ kind: 'error', text: '图片无法解码，请下载后查看' })
      }
      image.src = src
      return () => {
        disposed = true
        image.onload = null
        image.onerror = null
      }
    }
    if (kind === 'text') {
      setLoaded(undefined)
      void (async () => {
        try {
          const response = await fetch(src, { credentials: 'same-origin' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const length = Number(response.headers.get('content-length') ?? 0)
          const body = await response.text()
          if (length > TEXT_MAX_BYTES || body.length > TEXT_MAX_BYTES * 2) {
            if (!disposed) setLoaded({ kind: 'error', text: '文件过大，请下载后查看' })
            return
          }
          if (!disposed) {
            setLoaded({ kind: 'text', lines: body.split(/\r?\n/) })
            setPage(1)
            setTick((value) => value + 1)
          }
        } catch (error) {
          if (!disposed) {
            setLoaded({
              kind: 'error',
              text: `加载失败：${error instanceof Error ? error.message : String(error)}`,
            })
          }
        }
      })()
      return () => {
        disposed = true
      }
    }
    return undefined
  }, [kind, src])

  // Keep the backing store at the display resolution.
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr))
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr))
      setTick((value) => value + 1)
    }
    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  // Draw the current frame onto the single canvas.
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.width / dpr
    const h = canvas.height / dpr
    ctx.save()
    ctx.scale(dpr, dpr)
    ctx.fillStyle = '#1e1e1e'
    ctx.fillRect(0, 0, w, h)

    if (loaded === undefined) {
      ctx.fillStyle = '#8a8a8a'
      ctx.font = '13px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('正在加载…', w / 2, h / 2)
      ctx.restore()
      return
    }
    if (loaded.kind === 'error') {
      ctx.fillStyle = '#d9923c'
      ctx.font = '13px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(loaded.text, w / 2, h / 2)
      ctx.restore()
      return
    }
    if (loaded.kind === 'image') {
      const image = loaded.bitmap
      const scale = Math.min(w / image.naturalWidth, h / image.naturalHeight)
      const drawW = image.naturalWidth * scale
      const drawH = image.naturalHeight * scale
      ctx.drawImage(image, (w - drawW) / 2, (h - drawH) / 2, drawW, drawH)
      ctx.restore()
      return
    }

    // Paginated text.
    const lineHeight = TEXT_LINE_HEIGHT
    ctx.font = TEXT_FONT
    ctx.fillStyle = '#e6e6e6'
    const maxWidth = w - PADDING_X * 2
    const usableH = h - PADDING_Y * 2
    const linesPerPage = Math.max(1, Math.floor(usableH / lineHeight))
    const allLines = wrapLines(ctx, loaded.lines, maxWidth)
    const total = Math.max(1, Math.ceil(allLines.length / linesPerPage))
    setPageCount(total)
    const current = Math.min(page, total)
    const start = (current - 1) * linesPerPage
    const end = Math.min(start + linesPerPage, allLines.length)
    for (let i = start; i < end; i++) {
      ctx.fillText(allLines[i]!, PADDING_X, PADDING_Y + (i - start) * lineHeight + lineHeight * 0.8)
    }
    ctx.restore()
  }, [loaded, page, kind, src])

  return (
    <div style={styles.overlay} onClick={onClose}>
      <canvas
        ref={canvasRef}
        style={styles.canvas}
        onClick={(event) => event.stopPropagation()}
        onWheel={(event) => {
          if (kind !== 'text') return
          event.stopPropagation()
          if (event.deltaY > 0) setPage((value) => Math.min(pageCount, value + 1))
          else setPage((value) => Math.max(1, value - 1))
        }}
      />
      <div style={styles.toolbar} onClick={(event) => event.stopPropagation()}>
        <div style={styles.toolbarLeft}>
          <span style={styles.fileName} title={attachment.name}>
            {attachment.name}
          </span>
          {kind === 'text' ? (
            <span style={styles.pages}>
              第 {page} / {pageCount} 页
            </span>
          ) : null}
        </div>
        <div style={styles.toolbarRight}>
          {kind === 'text' ? (
            <>
              <button
                type="button"
                style={styles.toolButton}
                disabled={page <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                上一页
              </button>
              <button
                type="button"
                style={styles.toolButton}
                disabled={page >= pageCount}
                onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
              >
                下一页
              </button>
            </>
          ) : null}
          <a style={styles.toolLink} href={downloadHref} download={attachment.name}>
            下载
          </a>
          <button type="button" style={styles.toolButton} onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
