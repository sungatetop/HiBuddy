/**
 * WeChat-style butler chat (ADR-011 D11) — the product's only user-facing
 * surface. A single-column bubble stream: the user on the right, the butler on
 * the left, timestamps grouped by day/gap, a "处理中" bar while the butler turn
 * runs, and a bottom composer. The page renders ONLY ledger rows, so assistant
 * text, tool calls and worker activity can never leak into the conversation.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  attachmentSrc,
  fetchChat,
  markRead,
  sendChat,
  type ChatAttachment,
  type ChatMessage,
} from './api.ts'
import { TaskDrawer } from './drawer.tsx'
import { GenuiBubble } from './genui-bubble.tsx'
import { Markdown } from './markdown.tsx'
import { CanvasPreview } from './preview.tsx'

/** Injected shell capability: open one worker session in the main panel. */
interface ChatInjected {
  openSession: (sessionId: string) => void
}

/** Chat page props (runtime share + injected navigation callback). */
type ChatProps = PropsRuntime<'main'> & InjectFace<ChatInjected>

/** Greeting shown before the first exchange. */
const GREETING = '你好，我是你的管家。告诉我你想完成什么，我会安排并跟进。'

const styles = {
  page: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    background: '#ededed',
    color: '#191919',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  } as CSSProperties,
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 20px',
    background: '#f7f7f7',
    borderBottom: '1px solid #e2e2e2',
    flex: 'none',
  } as CSSProperties,
  title: { fontSize: 15, fontWeight: 600 } as CSSProperties,
  subtitle: { fontSize: 12, color: '#8a8a8a' } as CSSProperties,
  quiet: { fontSize: 11, color: '#c2803a', marginTop: 2 } as CSSProperties,
  list: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: '18px 20px 8px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  } as CSSProperties,
  time: { alignSelf: 'center', fontSize: 11, color: '#9a9a9a', margin: '6px 0' } as CSSProperties,
  loadEarlier: {
    alignSelf: 'center',
    padding: '4px 14px',
    borderRadius: 12,
    border: '1px solid #dcdcdc',
    background: '#ffffff',
    color: '#576b95',
    fontSize: 12,
    cursor: 'pointer',
  } as CSSProperties,
  rowLeft: { display: 'flex', justifyContent: 'flex-start' } as CSSProperties,
  rowRight: { display: 'flex', justifyContent: 'flex-end' } as CSSProperties,
  bubble: {
    maxWidth: '72%',
    padding: '9px 12px',
    borderRadius: 8,
    fontSize: 14,
    lineHeight: 1.55,
    wordBreak: 'break-word',
    boxShadow: '0 1px 1px rgba(0,0,0,0.04)',
  } as CSSProperties,
  plainText: { whiteSpace: 'pre-wrap' } as CSSProperties,
  bubbleLeft: { background: '#ffffff' } as CSSProperties,
  bubbleRight: { background: '#95ec69' } as CSSProperties,
  bubbleApproval: { background: '#fff7e6', border: '1px solid #ffd8a8' } as CSSProperties,
  bubbleTitle: { fontSize: 12, fontWeight: 600, color: '#8a6d3b', marginBottom: 4 } as CSSProperties,
  sessionLink: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    marginTop: 6,
    padding: '3px 10px',
    borderRadius: 12,
    border: '1px solid #d9e6dc',
    background: '#f2faf4',
    color: '#1d7a3c',
    fontSize: 12,
    cursor: 'pointer',
  } as CSSProperties,
  pending: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 20px',
    fontSize: 12,
    color: '#8a8a8a',
    background: '#f4f4f4',
  } as CSSProperties,
  dot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: '#12b76a',
    display: 'inline-block',
  } as CSSProperties,
  composer: {
    flex: 'none',
    display: 'flex',
    alignItems: 'flex-end',
    gap: 10,
    padding: '12px 16px',
    background: '#f7f7f7',
    borderTop: '1px solid #e2e2e2',
  } as CSSProperties,
  input: {
    flex: 1,
    resize: 'none',
    minHeight: 40,
    maxHeight: 140,
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid #dcdcdc',
    font: 'inherit',
    fontSize: 14,
    lineHeight: 1.45,
    outline: 'none',
    background: '#ffffff',
  } as CSSProperties,
  button: {
    padding: '9px 18px',
    borderRadius: 8,
    border: 'none',
    background: '#07c160',
    color: '#ffffff',
    fontSize: 14,
    cursor: 'pointer',
  } as CSSProperties,
  error: { padding: '4px 20px 8px', fontSize: 12, color: '#d92d20' } as CSSProperties,
  empty: { fontSize: 13, color: '#8a8a8a', alignSelf: 'center', marginTop: 24, textAlign: 'center' } as CSSProperties,
  tasksButton: {
    padding: '6px 14px',
    borderRadius: 6,
    border: '1px solid #dcdcdc',
    background: '#ffffff',
    color: '#333333',
    fontSize: 13,
    cursor: 'pointer',
  } as CSSProperties,
  attachments: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 } as CSSProperties,
  image: {
    maxWidth: 260,
    maxHeight: 260,
    borderRadius: 6,
    display: 'block',
    cursor: 'zoom-in',
    background: '#f2f2f2',
  } as CSSProperties,
  video: { maxWidth: 280, borderRadius: 6, display: 'block', background: '#000000' } as CSSProperties,
  audio: { width: 240 } as CSSProperties,
  fileCard: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 10px',
    borderRadius: 6,
    background: 'rgba(255,255,255,0.85)',
    border: '1px solid #e2e2e2',
    color: '#191919',
    textDecoration: 'none',
  } as CSSProperties,
  fileIcon: {
    flex: 'none',
    width: 34,
    height: 40,
    borderRadius: 4,
    background: '#eef2f6',
    color: '#5c6b7a',
    fontSize: 10,
    fontWeight: 600,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  } as CSSProperties,
  fileBody: { flex: 1, minWidth: 0 } as CSSProperties,
  fileName: {
    fontSize: 13,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as CSSProperties,
  fileMeta: { fontSize: 11, color: '#8a8a8a', marginTop: 2 } as CSSProperties,
  fileActions: { flex: 'none', display: 'flex', gap: 8 } as CSSProperties,
  fileAction: { fontSize: 12, color: '#07c160', textDecoration: 'none', border: 'none', background: 'none', cursor: 'pointer', padding: 0 } as CSSProperties,
}

/** Human-readable byte size. */
function sizeLabel(size: number | undefined): string {
  if (size === undefined) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** Extension badge text for the file card. */
function fileBadge(name: string): string {
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1).toUpperCase() : 'FILE'
  return extension.length > 4 ? extension.slice(0, 4) : extension
}

/** Whether the message carries a generative-UI reference attachment. */
function hasUiAttachment(message: { attachments?: ChatAttachment[] }): boolean {
  return (message.attachments ?? []).some((attachment) => attachment.kind === 'ui')
}

/** One attachment rendered per its media kind (image/video/audio/file/ui). */
function AttachmentView({
  attachment,
  onPreview,
}: {
  attachment: ChatAttachment
  onPreview: (attachment: ChatAttachment) => void
}): ReactNode {
  const src = attachmentSrc(attachment)
  // Generative-UI reference (G4): the interactive surface renders inline; the
  // instruction JSON is fetched from the ui-instruction route it points at.
  if (attachment.kind === 'ui') {
    return <GenuiBubble src={src} name={attachment.name} />
  }
  if (attachment.kind === 'image') {
    return (
      <img
        src={src}
        alt={attachment.name}
        title={attachment.name}
        loading="lazy"
        style={styles.image}
        onClick={() => onPreview(attachment)}
      />
    )
  }
  if (attachment.kind === 'video') {
    return <video src={src} controls preload="metadata" style={styles.video} />
  }
  if (attachment.kind === 'audio') {
    return <audio src={src} controls preload="metadata" style={styles.audio} />
  }
  return (
    <div style={styles.fileCard}>
      <div style={styles.fileIcon}>{fileBadge(attachment.name)}</div>
      <div style={styles.fileBody}>
        <div style={styles.fileName} title={attachment.name}>
          {attachment.name}
        </div>
        <div style={styles.fileMeta}>{sizeLabel(attachment.size) || attachment.mime || '文件'}</div>
      </div>
      <div style={styles.fileActions}>
        <button type="button" style={styles.fileAction} onClick={() => onPreview(attachment)}>
          打开
        </button>
        <a
          href={`${src}${src.includes('?') ? '&' : '?'}download=1`}
          download={attachment.name}
          style={styles.fileAction}
        >
          下载
        </a>
      </div>
    </div>
  )
}

/** Local-time label for a message boundary (day or 5-minute gap). */
function boundaryLabel(current: ChatMessage, previous: ChatMessage | undefined): string | undefined {
  const at = new Date(current.createdAt)
  if (previous === undefined) return at.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const before = new Date(previous.createdAt)
  const sameDay = at.toDateString() === before.toDateString()
  if (!sameDay) return at.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  if (at.getTime() - before.getTime() > 5 * 60 * 1000) {
    return at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return undefined
}

/** Size of one "load earlier" history page. */
const EARLIER_PAGE = 60
/** Distance from the list bottom (px) that still counts as "at the bottom". */
const AT_BOTTOM_PX = 64

/** Merges the poll's newest window with the history pages the user loaded.
 *
 * Dedupe by id (a row lands in both the older pages and the poll window once
 * new traffic pushes it out of the window's edge), keeps not-yet-landed
 * optimistic rows (`local-*` ids whose direction+text has no durable twin
 * yet), and sorts oldest-first for rendering.
 */
function mergeTranscript(
  windowMessages: ChatMessage[],
  older: ChatMessage[],
  current: ChatMessage[],
): ChatMessage[] {
  const byId = new Map<string, ChatMessage>()
  for (const message of older) byId.set(message.id, message)
  for (const message of windowMessages) byId.set(message.id, message)
  const landed = new Set(windowMessages.map((message) => `${message.direction}\u0000${message.text}`))
  const merged: ChatMessage[] = []
  for (const message of byId.values()) {
    if (message.id.startsWith('local-') && landed.has(`${message.direction}\u0000${message.text}`)) continue
    merged.push(message)
  }
  return merged.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

/** Renders the chat page into the layout's keyed `main` panel. */
export function ChatPage({ openSession }: ChatProps): ReactNode {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [working, setWorking] = useState(false)
  const [quiet, setQuiet] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [drawer, setDrawer] = useState(false)
  const [preview, setPreview] = useState<ChatAttachment | undefined>(undefined)
  const [hasMore, setHasMore] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)
  /** Outbound ids already marked read, so the poll never re-sends them. */
  const markedRef = useRef<ReadonlySet<string>>(new Set())
  /** The poll's newest-window rows (older history lives in `olderRef`). */
  const windowRef = useRef<ChatMessage[]>([])
  /** History pages the user loaded via "load earlier" (kept newest-last). */
  const olderRef = useRef<ChatMessage[]>([])
  /** Whether the viewport hugs the list bottom — only then the poll follows it. */
  const atBottomRef = useRef(true)
  /** Set on an explicit send: the next layout pass scrolls to bottom regardless. */
  const forceBottomRef = useRef(false)
  /** Previous scrollHeight during a prepend; the next layout pass restores the anchor. */
  const anchorRef = useRef<number | null>(null)

  useEffect(() => {
    let disposed = false
    const load = async (): Promise<void> => {
      try {
        const snapshot = await fetchChat()
        if (disposed) return
        windowRef.current = snapshot.messages
        setHasMore(snapshot.hasMore)
        setMessages((current) => mergeTranscript(snapshot.messages, olderRef.current, current))
        setWorking(snapshot.status.state === 'working')
        setQuiet(snapshot.status.quiet === true)
        // Mark the visible outbound rows read (fire-and-forget). The poll is
        // the only read source: whatever the UI has shown is "seen" (B12′ §5.5).
        const visible = [...olderRef.current, ...snapshot.messages]
        const fresh = visible
          .filter((message) => message.direction === 'out' && !markedRef.current.has(message.id))
          .map((message) => message.id)
        if (fresh.length > 0) {
          markedRef.current = new Set([...markedRef.current, ...fresh])
          void markRead(fresh).catch(() => undefined)
        }
        setError(undefined)
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    void load()
    const timer = setInterval(() => void load(), 2000)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [])

  /** Fetches one older page; the layout pass keeps the viewport anchored. */
  const loadEarlier = async (): Promise<void> => {
    if (loadingEarlier) return
    const oldest = messages.find((message) => !message.id.startsWith('local-'))
    if (oldest === undefined) return
    setLoadingEarlier(true)
    try {
      const page = await fetchChat({ limit: EARLIER_PAGE, before: oldest.id })
      if (page.messages.length === 0) {
        setHasMore(false)
        return
      }
      anchorRef.current = listRef.current?.scrollHeight ?? null
      olderRef.current = [...page.messages, ...olderRef.current]
      setHasMore(page.hasMore)
      setMessages((current) => mergeTranscript(windowRef.current, olderRef.current, current))
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoadingEarlier(false)
    }
  }

  useEffect(() => {
    const node = listRef.current
    if (node === null) return
    if (anchorRef.current !== null) {
      // Prepend (history page): grow kept at the top — hold the viewport.
      node.scrollTop += node.scrollHeight - anchorRef.current
      anchorRef.current = null
      return
    }
    if (forceBottomRef.current || atBottomRef.current) {
      node.scrollTop = node.scrollHeight
      forceBottomRef.current = false
    }
  }, [messages, working])

  const submit = async (): Promise<void> => {
    const text = draft.trim()
    if (text === '') return
    setDraft('')
    // An explicit send always brings the viewport back to the bottom.
    forceBottomRef.current = true
    // Optimistic bubble; the next poll replaces it with the durable row.
    setMessages((current) => [
      ...current,
      { id: `local-${Date.now()}`, direction: 'in', kind: 'text', text, createdAt: new Date().toISOString() },
    ])
    setWorking(true)
    try {
      await sendChat(text)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setWorking(false)
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <div style={styles.title}>管家</div>
          <div style={styles.subtitle}>替你指挥任务、监控进度、汇报结果</div>
          {quiet ? <div style={styles.quiet}>免打扰中 · 新消息仅落库不推送</div> : null}
        </div>
        <button type="button" style={styles.tasksButton} onClick={() => setDrawer(true)}>
          任务
        </button>
      </div>

      <div
        ref={listRef}
        style={styles.list}
        onScroll={() => {
          const node = listRef.current
          if (node === null) return
          atBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < AT_BOTTOM_PX
        }}
      >
        {hasMore ? (
          <button
            type="button"
            style={styles.loadEarlier}
            disabled={loadingEarlier}
            onClick={() => void loadEarlier()}
          >
            {loadingEarlier ? '加载中…' : '加载更早消息'}
          </button>
        ) : null}
        {messages.length === 0 ? <div style={styles.empty}>{GREETING}</div> : null}
        {messages.map((message, index) => {
          const label = boundaryLabel(message, messages[index - 1])
          const mine = message.direction === 'in'
          const approval = message.kind === 'approval'
          const linkedSession = mine ? undefined : message.refs?.sessionId
          return (
            <div key={message.id} style={{ display: 'contents' }}>
              {label !== undefined ? <div style={styles.time}>{label}</div> : null}
              <div style={mine ? styles.rowRight : styles.rowLeft}>
                <div
                  style={{
                    ...styles.bubble,
                    ...(mine ? styles.bubbleRight : styles.bubbleLeft),
                    ...(approval ? styles.bubbleApproval : {}),
                  }}
                >
                  {message.title !== undefined && !mine ? <div style={styles.bubbleTitle}>{message.title}</div> : null}
                  {/* A kind='ui' attachment carries the card chrome itself — the
                      ledger text (its summary) would duplicate the card title. */}
                  {!mine && !approval && hasUiAttachment(message) ? null : mine || approval ? (
                    <div style={styles.plainText}>{message.text}</div>
                  ) : (
                    <Markdown>{message.text}</Markdown>
                  )}
                  {message.attachments !== undefined && message.attachments.length > 0 ? (
                    <div style={styles.attachments}>
                      {message.attachments.map((attachment) => (
                        <AttachmentView
                          key={attachment.id}
                          attachment={attachment}
                          onPreview={setPreview}
                        />
                      ))}
                    </div>
                  ) : null}
                  {linkedSession !== undefined ? (
                    <button
                      type="button"
                      style={styles.sessionLink}
                      title={linkedSession}
                      onClick={() => openSession(linkedSession)}
                    >
                      打开 worker 会话
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {working ? (
        <div style={styles.pending}>
          <span style={styles.dot} />
          管家正在处理…
        </div>
      ) : null}
      {error !== undefined ? <div style={styles.error}>{error}</div> : null}

      <div style={styles.composer}>
        <textarea
          style={styles.input}
          value={draft}
          placeholder="给管家发消息…"
          rows={1}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submit()
            }
          }}
        />
        <button style={styles.button} onClick={() => void submit()} disabled={draft.trim() === ''}>
          发送
        </button>
      </div>
      {drawer ? <TaskDrawer onClose={() => setDrawer(false)} openSession={openSession} /> : null}
      {preview !== undefined ? (
        <CanvasPreview attachment={preview} onClose={() => setPreview(undefined)} />
      ) : null}
    </div>
  )
}
