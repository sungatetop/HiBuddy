import { useCallback, useMemo, useState } from 'react'
import { HttpAgent } from '@ag-ui/client'
import { CopilotChat, CopilotKitProvider, useDefaultRenderTool, useInterrupt } from '@copilotkit/react-core/v2'

/**
 * CopilotKit v2 minimal consumer of the HiBuddy AG-UI bridge (S6-2).
 *
 * Connection flow (all same-origin through the vite dev proxy):
 *   1. POST-less login: GET /connect?token=… (dsh answers 302 + Set-Cookie;
 *      redirect:'manual' keeps the cookie on the opaqueredirect response).
 *   2. Fence probe: GET /agui must answer 405 (method not allowed) — only a
 *      request past dsh's trust fence reaches the method check; 401/403 mean
 *      the session cookie did not land.
 *   3. Ready: CopilotKitProvider drives a direct HttpAgent at /agui with the
 *      session cookie (same-origin, credentials included).
 */

type Stage = 'idle' | 'connecting' | 'ready'

interface ConnectError {
  title: string
  detail: string
}

/** The single agent id registered with the provider and the chat. */
const AGENT_ID = 'hibuddy'

/** Exchange the startup token for the dsh session cookie. Throws on 401. */
async function exchangeToken(token: string): Promise<void> {
  const res = await fetch(`/connect?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  if (res.status === 401) {
    throw new Error(`启动令牌无效（HTTP ${res.status}）`)
  }
}

/**
 * Past-the-fence probe. 405 proves the cookie works (the fence let the request
 * through to the bridge's method check); 401/403 prove it does not.
 */
async function probeFence(): Promise<number> {
  const res = await fetch('/agui', { method: 'GET' })
  return res.status
}

/**
 * Approval card for bridge tool-approval interrupts. The bridge closes the run
 * with a RUN_FINISHED interrupt outcome; resolve() re-POSTs a ResumeEntry with
 * status "resolved", cancel() with "cancelled" — exactly the two answers the
 * bridge's answerPendings maps onto dsh approval outcomes.
 */
function ChatPanel() {
  // Built-in cards for every tool call the agent makes (glob/read/write/…),
  // so the bridge's TOOL_CALL_* events stay visible in the transcript.
  useDefaultRenderTool()

  useInterrupt({
    render: ({ interrupt, resolve, cancel }) => (
      <div className="approval-card">
        <p className="approval-title">工具审批</p>
        <p className="approval-message">
          {interrupt?.message ?? 'Agent 请求执行一个需要审批的工具'}
        </p>
        <div className="approval-actions">
          <button type="button" className="approve" onClick={() => void resolve()}>
            批准
          </button>
          <button type="button" className="reject" onClick={() => void cancel()}>
            拒绝
          </button>
        </div>
      </div>
    ),
  })

  return (
    <CopilotChat
      agentId={AGENT_ID}
      className="chat"
      labels={{
        chatInputPlaceholder: '给 HiBuddy 发消息…',
        welcomeMessageText: '通过 AG-UI 协议与 HiBuddy 对话',
        chatDisclaimerText: 'AG-UI 桥 demo — 工具审批以中断卡形式出现',
      }}
    />
  )
}

/** Provider + agent: mounted only after the fence probe passes. */
function ChatRoot() {
  // One agent instance for the provider lifetime; threadId/runId are filled in
  // by the AG-UI client per run, so no manual thread management is needed.
  const agent = useMemo(() => new HttpAgent({ url: '/agui' }), [])
  return (
    <CopilotKitProvider
      // agentId here sets the DEFAULT agent: hooks like useInterrupt resolve
      // an unset agentId against it, so it must point at our registration key.
      agentId={AGENT_ID}
      agents__unsafe_dev_only={{ [AGENT_ID]: agent }}
      credentials="include"
    >
      <ChatPanel />
    </CopilotKitProvider>
  )
}

export default function App() {
  const [stage, setStage] = useState<Stage>('idle')
  const [token, setToken] = useState('')
  const [error, setError] = useState<ConnectError | null>(null)

  const connect = useCallback(async () => {
    const trimmed = token.trim()
    if (trimmed === '') {
      setError({ title: '请输入启动令牌', detail: '令牌来自 dsh web 启动时打印的 URL（?token=…）' })
      return
    }
    setStage('connecting')
    setError(null)
    try {
      await exchangeToken(trimmed)
      const status = await probeFence()
      if (status === 405) {
        setStage('ready')
        return
      }
      setStage('idle')
      if (status === 401 || status === 403) {
        setError({ title: '认证未通过', detail: `会话 Cookie 未生效（HTTP ${status}），请重试或检查令牌` })
      } else {
        setError({ title: '意外状态', detail: `探针请求返回 HTTP ${status}（期望 405）` })
      }
    } catch (err) {
      setStage('idle')
      setError({ title: '连接失败', detail: err instanceof Error ? err.message : String(err) })
    }
  }, [token])

  if (stage === 'ready') {
    return (
      <main className="app-shell">
        <ChatRoot />
      </main>
    )
  }

  return (
    <main className="gate">
      <div className="gate-card">
        <h1>HiBuddy × CopilotKit</h1>
        <p className="gate-sub">AG-UI 桥最小消费端（S6-2 demo）</p>
        <input
          type="password"
          value={token}
          placeholder="粘贴 dsh 启动令牌（?token=…）"
          onChange={(event) => setToken(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void connect()
          }}
          autoFocus
        />
        <button type="button" onClick={() => void connect()} disabled={stage === 'connecting'}>
          {stage === 'connecting' ? '连接中…' : '连接'}
        </button>
        {error !== null && (
          <div className="gate-error" role="alert">
            <strong>{error.title}</strong>
            <span>{error.detail}</span>
          </div>
        )}
      </div>
    </main>
  )
}
