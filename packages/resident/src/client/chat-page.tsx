/**
 * WeChat-style butler chat (ADR-011 D11) — the product's only user-facing
 * surface. A single-column bubble stream: the user on the right, the butler on
 * the left, timestamps grouped by day/gap, a "处理中" bar while the butler turn
 * runs, and a bottom composer. The page renders ONLY ledger rows, so assistant
 * text, tool calls and worker activity can never leak into the conversation.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { fetchChat, sendChat, type ChatMessage } from './api.ts'
import { TaskDrawer } from './drawer.tsx'

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
  rowLeft: { display: 'flex', justifyContent: 'flex-start' } as CSSProperties,
  rowRight: { display: 'flex', justifyContent: 'flex-end' } as CSSProperties,
  bubble: {
    maxWidth: '72%',
    padding: '9px 12px',
    borderRadius: 8,
    fontSize: 14,
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    boxShadow: '0 1px 1px rgba(0,0,0,0.04)',
  } as CSSProperties,
  bubbleLeft: { background: '#ffffff' } as CSSProperties,
  bubbleRight: { background: '#95ec69' } as CSSProperties,
  bubbleApproval: { background: '#fff7e6', border: '1px solid #ffd8a8' } as CSSProperties,
  bubbleTitle: { fontSize: 12, fontWeight: 600, color: '#8a6d3b', marginBottom: 4 } as CSSProperties,
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

/** Renders the chat page into the layout's keyed `main` panel. */
export function ChatPage(_props: PropsRuntime<'main'>): ReactNode {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [working, setWorking] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [drawer, setDrawer] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let disposed = false
    const load = async (): Promise<void> => {
      try {
        const snapshot = await fetchChat()
        if (disposed) return
        setMessages(snapshot.messages)
        setWorking(snapshot.status.state === 'working')
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

  useEffect(() => {
    const node = listRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [messages, working])

  const submit = async (): Promise<void> => {
    const text = draft.trim()
    if (text === '') return
    setDraft('')
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
        </div>
        <button type="button" style={styles.tasksButton} onClick={() => setDrawer(true)}>
          任务
        </button>
      </div>

      <div ref={listRef} style={styles.list}>
        {messages.length === 0 ? <div style={styles.empty}>{GREETING}</div> : null}
        {messages.map((message, index) => {
          const label = boundaryLabel(message, messages[index - 1])
          const mine = message.direction === 'in'
          const approval = message.kind === 'approval'
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
                  {message.text}
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
      {drawer ? <TaskDrawer onClose={() => setDrawer(false)} /> : null}
    </div>
  )
}
