/**
 * Task drawer (ADR-011 D11 / resident-design §10): the butler's operational
 * surface beside the chat — delegated work items, pending approvals, and the
 * resident settings (explicit save). It never shows worker transcripts: a row
 * is goal + state + last summary only.
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import {
  fetchSessions,
  fetchSettings,
  saveSettings,
  type PendingApproval,
  type ResidentSettings,
  type SessionInfo,
} from './api.ts'

const STATE_LABELS: Record<string, string> = {
  pending: '排队中',
  working: '执行中',
  awaiting_approval: '等待审批',
  completed: '已完成',
  failed: '失败',
  stopped: '已叫停',
}

const styles = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.22)',
    display: 'flex',
    justifyContent: 'flex-end',
    zIndex: 30,
  } as CSSProperties,
  panel: {
    width: 'min(420px, 92vw)',
    height: '100%',
    background: '#ffffff',
    borderLeft: '1px solid #e2e2e2',
    display: 'flex',
    flexDirection: 'column',
  } as CSSProperties,
  head: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 16px',
    borderBottom: '1px solid #ececec',
  } as CSSProperties,
  heading: { fontSize: 15, fontWeight: 600 } as CSSProperties,
  tabs: { display: 'flex', gap: 6, padding: '10px 16px 0' } as CSSProperties,
  tab: {
    padding: '6px 12px',
    borderRadius: 6,
    fontSize: 13,
    cursor: 'pointer',
    border: '1px solid transparent',
    background: 'transparent',
    color: '#555555',
  } as CSSProperties,
  tabActive: { background: '#f2f2f2', borderColor: '#e2e2e2', color: '#191919' } as CSSProperties,
  body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 16px 20px' } as CSSProperties,
  card: {
    border: '1px solid #ececec',
    borderRadius: 8,
    padding: '10px 12px',
    marginBottom: 10,
    background: '#fafafa',
  } as CSSProperties,
  goal: { fontSize: 13, fontWeight: 600, marginBottom: 4 } as CSSProperties,
  meta: { fontSize: 12, color: '#8a8a8a', lineHeight: 1.6 } as CSSProperties,
  badge: {
    display: 'inline-block',
    fontSize: 11,
    padding: '1px 8px',
    borderRadius: 10,
    background: '#eef6ef',
    color: '#1d7a3c',
    marginLeft: 6,
  } as CSSProperties,
  warnBadge: { background: '#fff2e0', color: '#a05a00' } as CSSProperties,
  empty: { fontSize: 13, color: '#8a8a8a', padding: '16px 0', textAlign: 'center' } as CSSProperties,
  field: { marginBottom: 14 } as CSSProperties,
  label: { display: 'block', fontSize: 13, marginBottom: 6, color: '#333333' } as CSSProperties,
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '7px 10px',
    borderRadius: 6,
    border: '1px solid #dcdcdc',
    fontSize: 13,
  } as CSSProperties,
  row: { display: 'flex', gap: 10, alignItems: 'center' } as CSSProperties,
  foot: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
    padding: '12px 16px',
    borderTop: '1px solid #ececec',
  } as CSSProperties,
  primary: {
    padding: '8px 18px',
    borderRadius: 6,
    border: 'none',
    background: '#07c160',
    color: '#ffffff',
    fontSize: 13,
    cursor: 'pointer',
  } as CSSProperties,
  secondary: {
    padding: '8px 18px',
    borderRadius: 6,
    border: '1px solid #d9d9d9',
    background: '#ffffff',
    color: '#333333',
    fontSize: 13,
    cursor: 'pointer',
  } as CSSProperties,
  error: { fontSize: 12, color: '#d92d20', marginBottom: 10 } as CSSProperties,
  link: {
    border: 'none',
    background: 'transparent',
    color: '#576b95',
    fontSize: 12,
    cursor: 'pointer',
    padding: 0,
  } as CSSProperties,
}

interface DrawerProps {
  onClose: () => void
}

/** The task/settings drawer body. */
export function TaskDrawer({ onClose }: DrawerProps): ReactNode {
  const [tab, setTab] = useState<'tasks' | 'settings'>('tasks')
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [approvals, setApprovals] = useState<PendingApproval[]>([])
  const [settings, setSettings] = useState<ResidentSettings | undefined>(undefined)
  const [draft, setDraft] = useState<ResidentSettings | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let disposed = false
    const load = async (): Promise<void> => {
      try {
        const [snapshot, current] = await Promise.all([fetchSessions(), fetchSettings()])
        if (disposed) return
        setSessions(snapshot.sessions)
        setApprovals(snapshot.approvals)
        setSettings(current)
        setDraft((previous) => previous ?? current)
        setError(undefined)
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    void load()
    const timer = setInterval(() => void load(), 3000)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [])

  const save = async (): Promise<void> => {
    if (draft === undefined) return
    try {
      const next = await saveSettings(draft)
      setSettings(next)
      setDraft(next)
      setSaved(true)
      setError(undefined)
      setTimeout(() => setSaved(false), 1500)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const patchDraft = (change: Partial<ResidentSettings>): void => {
    setDraft((current) => (current === undefined ? current : { ...current, ...change }))
  }

  return (
    <div style={styles.backdrop} onClick={onClose} role="presentation">
      <div style={styles.panel} onClick={(event) => event.stopPropagation()}>
        <div style={styles.head}>
          <div style={styles.heading}>任务与设置</div>
          <button type="button" style={styles.link} onClick={onClose}>
            关闭
          </button>
        </div>
        <div style={styles.tabs}>
          <button
            type="button"
            style={{ ...styles.tab, ...(tab === 'tasks' ? styles.tabActive : {}) }}
            onClick={() => setTab('tasks')}
          >
            工作项
          </button>
          <button
            type="button"
            style={{ ...styles.tab, ...(tab === 'settings' ? styles.tabActive : {}) }}
            onClick={() => setTab('settings')}
          >
            设置
          </button>
        </div>

        <div style={styles.body}>
          {error !== undefined ? <div style={styles.error}>{error}</div> : null}

          {tab === 'tasks' ? (
            <>
              {approvals.length > 0 ? (
                <>
                  <div style={{ ...styles.meta, marginBottom: 8 }}>待你确认的审批</div>
                  {approvals.map((approval) => (
                    <div key={approval.id} style={styles.card}>
                      <div style={styles.goal}>
                        {approval.toolName}
                        <span style={{ ...styles.badge, ...styles.warnBadge }}>待审批</span>
                      </div>
                      <div style={styles.meta}>{approval.reason}</div>
                      <div style={styles.meta}>审批编号：{approval.id}</div>
                    </div>
                  ))}
                </>
              ) : null}
              {sessions.length === 0 ? (
                <div style={styles.empty}>还没有委派过任务。直接对管家说出目标即可。</div>
              ) : (
                sessions
                  .slice()
                  .reverse()
                  .map((session) => (
                    <div key={session.sessionId} style={styles.card}>
                      <div style={styles.goal}>
                        {session.goal || session.ticketId}
                        <span style={styles.badge}>{STATE_LABELS[session.state] ?? session.state}</span>
                      </div>
                      <div style={styles.meta}>会话：{session.sessionId}</div>
                      {session.workspace !== undefined ? (
                        <div style={styles.meta}>工作区：{session.workspace}</div>
                      ) : null}
                      {session.summary !== undefined ? <div style={styles.meta}>{session.summary}</div> : null}
                      {session.lastReport !== undefined ? (
                        <div style={{ ...styles.meta, marginTop: 4 }}>{session.lastReport}</div>
                      ) : null}
                    </div>
                  ))
              )}
            </>
          ) : draft === undefined ? (
            <div style={styles.empty}>加载中…</div>
          ) : (
            <>
              <div style={styles.field}>
                <label style={styles.label}>免打扰时段（留空表示关闭）</label>
                <div style={styles.row}>
                  <input
                    style={styles.input}
                    value={draft.quietHours?.start ?? ''}
                    placeholder="22:00"
                    onChange={(event) =>
                      patchDraft({
                        quietHours: {
                          start: event.target.value,
                          end: draft.quietHours?.end ?? '',
                        },
                      })
                    }
                  />
                  <input
                    style={styles.input}
                    value={draft.quietHours?.end ?? ''}
                    placeholder="07:00"
                    onChange={(event) =>
                      patchDraft({
                        quietHours: {
                          start: draft.quietHours?.start ?? '',
                          end: event.target.value,
                        },
                      })
                    }
                  />
                </div>
              </div>
              <div style={styles.field}>
                <label style={styles.label}>并行 worker 上限</label>
                <input
                  style={styles.input}
                  type="number"
                  min={0}
                  max={8}
                  value={draft.workerSlots}
                  onChange={(event) => patchDraft({ workerSlots: Number(event.target.value) })}
                />
              </div>
              <div style={styles.field}>
                <label style={styles.label}>
                  <input
                    type="checkbox"
                    checked={draft.observeMode}
                    onChange={(event) => patchDraft({ observeMode: event.target.checked })}
                  />{' '}
                  观察模式（监控命中只汇报，不自动行动）
                </label>
              </div>
              <div style={styles.field}>
                <label style={styles.label}>
                  <input
                    type="checkbox"
                    checked={draft.approvalDelegation}
                    onChange={(event) => patchDraft({ approvalDelegation: event.target.checked })}
                  />{' '}
                  允许管家代管低危审批（关闭后全部征求你的确认）
                </label>
              </div>
              {settings !== undefined ? (
                <div style={styles.meta}>当前保存值：{settings.approvalDelegation ? '代管开启' : '全部确认'}</div>
              ) : null}
            </>
          )}
        </div>

        {tab === 'settings' ? (
          <div style={styles.foot}>
            {saved ? <span style={{ ...styles.meta, alignSelf: 'center' }}>已保存</span> : null}
            <button type="button" style={styles.secondary} onClick={() => setDraft(settings)}>
              放弃修改
            </button>
            <button type="button" style={styles.primary} onClick={() => void save()} disabled={draft === undefined}>
              保存
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
