/**
 * Butler tool face (ADR-011 §2.3, D6 as amended by genui-agui-optimization.md
 * G4) — the SMALL tool set the resident butler runs with. It deliberately
 * contains no filesystem, shell or web tool: the butler talks, delegates and
 * monitors; all execution belongs to worker sessions. The exception is the
 * no-op data tool `render_ui` (generative UI): pure-JSON instructions, no
 * execution surface, persisted and announced in the ledger by the host.
 *
 * Mounted inside the `hibbuddy-butler` preset's agent scope, so scoped
 * registration keeps these tools invisible to worker sessions and the
 * regular chat sessions.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertPlainArrays, RENDER_UI_DESCRIPTION, RENDER_UI_PARAMETERS } from '@hibuddy/web-ui'
import { normalizeRevision, validateInstruction } from '@hibuddy/web-ui/genui-schema'
import type { ResidentButler } from './butler.ts'
import { getResidentService } from './service-ref.ts'

/** Cordis function-plugin name. */
export const name = 'hibbuddy-butler-tools'

/** Tool registration only; the resident service is resolved lazily per call. */
export const inject = ['tools']

/** One text block for the model-facing result rendering. */
function text(value: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text' as const, text: value }]
}

/** Shared guidance for the attachments parameter. */
const ATTACHMENT_HINT =
  'Local files must live under a registered workspace (use list_workspaces; worker output lands in ' +
  '<workspace>/resident-work/). Remote http(s) URLs are also accepted. Images/video/audio preview ' +
  'inline; everything else shows as a downloadable file card. kind is inferred from the extension.'

/** The butler service, or a clear failure when the host half is not ready. */
function requireService(): ResidentButler {
  const service = getResidentService()
  if (service === undefined) {
    throw new Error('resident service is not ready; the host half has not started the butler yet')
  }
  return service
}

/** The butler's tool set over the resident service. */
export function createButlerTools() {
  const sendMessageToUser = defineTool({
    name: 'send_message_to_user',
    description:
      'Send a message to the user. THIS IS YOUR ONLY WAY TO SPEAK TO THE USER — plain assistant text is invisible. ' +
      'Use kind "text" for normal chat, "question" when you need a reply, "report" for task results, ' +
      '"system" for notices (errors, degraded sources). Text is rendered as Markdown (headings, lists, ' +
      'code, links, tables). Attach images/videos/audio/documents with attachments. ' +
      'Non-blocking: it returns once the message is recorded.',
    parameters: {
      text: { type: 'string', required: true, description: 'Markdown message body shown in the chat bubble.' },
      kind: {
        type: 'string',
        enum: ['text', 'question', 'report', 'system'],
        description: 'Message kind; defaults to "text".',
      },
      reply_to: {
        type: 'string',
        description: 'Id of the message being answered, when replying to a question (optional).',
      },
      session_id: {
        type: 'string',
        description:
          'Worker session this message is about (optional). The chat shows an "open session" link on the bubble.',
      },
      attachments: {
        type: 'array',
        description: `Files or media to send with the message (optional). ${ATTACHMENT_HINT}`,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', description: 'Absolute path of a file under a registered workspace.' },
            url: { type: 'string', description: 'http(s) URL of a remote file (alternative to path).' },
            name: { type: 'string', description: 'Display name; defaults to the file name.' },
            kind: {
              type: 'string',
              enum: ['image', 'video', 'audio', 'file'],
              description: 'Media kind; inferred from the extension when omitted.',
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: {
            type: 'boolean',
            enum: [true, false],
            required: true,
            description: 'Whether the message was recorded in the ledger.',
          },
          id: { type: 'string', required: true, description: 'Message id in the ledger.' },
          attachments: { type: 'integer', required: true, description: 'Attachment count recorded.' },
          error: { type: 'string', description: 'Reason when ok=false (retry, do not assume success).' },
        },
      },
      render: (_args, value) =>
        text(
          value.ok
            ? `消息已发送（${value.id}${value.attachments > 0 ? `，${value.attachments} 个附件` : ''}）。`
            : `消息未能记录：${value.error ?? '未知原因'}。`,
        ),
    },
    async execute(args) {
      const outcome = requireService().sendMessage({
        text: args.text,
        kind: (args.kind ?? 'text') as 'text' | 'question' | 'report' | 'system',
        ...(args.reply_to !== undefined ? { replyTo: args.reply_to } : {}),
        ...(args.session_id !== undefined ? { sessionId: args.session_id } : {}),
        ...(args.attachments !== undefined && args.attachments.length > 0
          ? { attachments: args.attachments }
          : {}),
      })
      // The ledger write can fail (store error); report it so the butler can
      // retry instead of believing a message was sent (perception B12′ §5.5).
      if (!outcome.recorded) {
        return { ok: false as const, id: outcome.id, attachments: 0, error: '消息未落库' }
      }
      return { ok: true as const, id: outcome.id, attachments: args.attachments?.length ?? 0 }
    },
  })

  const listWorkspaces = defineTool({
    name: 'list_workspaces',
    description:
      'List the dsh workspaces this product knows about (id, title, path). ' +
      'Use it before delegating when the user names a project/workspace, then pass the workspace to create_session.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workspaces: {
            type: 'json',
            required: true,
            description: 'Array of {id, title, path}.',
          },
        },
      },
      render: (_args, value) => {
        const workspaces = (value as { workspaces?: Array<{ id: string; title: string; path: string }> }).workspaces ?? []
        if (workspaces.length === 0) return text('当前没有注册工作区（create_session 将退回默认工作目录）。')
        return text(
          ['可用工作区：', ...workspaces.map((entry) => `- ${entry.title}：${entry.path}（id ${entry.id}）`)].join('\n'),
        )
      },
    },
    async execute() {
      const workspaces: Array<Record<string, string>> = requireService().listWorkspaces().map((workspace) => ({
        id: workspace.id,
        title: workspace.title,
        path: workspace.path,
      }))
      return { workspaces }
    },
  })

  const createSession = defineTool({
    name: 'create_session',
    description:
      'Delegate a goal to a NEW worker session (a real dsh session, not a subagent). ' +
      'Returns immediately with the deterministic session id; the scheduler starts it within a second. ' +
      'Pass workspace (id/title/path) to make the worker execute inside that workspace; omitted = the butler\'s bound workspace. ' +
      'When you tell the user about this task, pass the returned sessionId as send_message_to_user.session_id so they can open it. ' +
      'The worker executes autonomously — monitor it with get_session/list_sessions and steer it with send_to_session.',
    parameters: {
      goal: {
        type: 'string',
        required: true,
        description: 'Self-contained goal for the worker: what to do, constraints, and what a good result looks like.',
      },
      title: {
        type: 'string',
        description: 'Short human-readable label for the task (optional).',
      },
      workspace: {
        type: 'string',
        description:
          'Target workspace (id, title, or canonical path) — the worker works under <workspace>/resident-work/. ' +
          'Use list_workspaces to discover them; omit to use the butler\'s default workspace (optional).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ticketId: { type: 'string', required: true, description: 'Delegation ledger id.' },
          sessionId: { type: 'string', required: true, description: 'Worker session id.' },
          state: { type: 'string', required: true, description: 'Always "pending" at creation.' },
          workspace: { type: 'string', description: 'Workspace path the worker will execute under.' },
        },
      },
      render: (args, value) =>
        text(
          `已指派任务（会话 ${value.sessionId}${value.workspace !== undefined ? `，工作区 ${value.workspace}` : ''}）：` +
            args.goal.slice(0, 80),
        ),
    },
    async execute(args) {
      return requireService().createSession({
        goal: args.goal,
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.workspace !== undefined ? { workspace: args.workspace } : {}),
      })
    },
  })

  const sendToSession = defineTool({
    name: 'send_to_session',
    description:
      'Send an instruction to a live worker session. Use it to refine the goal, add constraints, ' +
      'or answer a question the worker asked. Works while the worker is running (queued into its turn).',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Worker session id.' },
      message: { type: 'string', required: true, description: 'Instruction text.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'Whether the instruction was accepted.' },
          error: { type: 'string', description: 'Reason when ok=false.' },
        },
      },
      render: (_args, value) => text(value.ok ? '指令已送达。' : `指令未送达：${value.error ?? '未知原因'}`),
    },
    async execute(args) {
      return requireService().sendToSession(args.sessionId, args.message)
    },
  })

  const getSession = defineTool({
    name: 'get_session',
    description: 'Read one worker session status and its latest report/summary (never the full log).',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Worker session id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true, description: 'False when the id is unknown.' },
          sessionId: { type: 'string', description: 'Echo of the id.' },
          ticketId: { type: 'string', description: 'Delegation ledger id.' },
          goal: { type: 'string', description: 'Delegated goal.' },
          state: { type: 'string', description: 'Ticket state (pending/working/completed/failed/stopped…).' },
          lastReport: { type: 'string', description: 'Latest worker report.' },
          summary: { type: 'string', description: 'Latest ticket summary.' },
        },
      },
      render: (_args, value) =>
        text(
          value.found
            ? `会话 ${value.sessionId}：${value.state ?? '未知'}${value.lastReport ? `\n最近报告：${value.lastReport}` : ''}`
            : '未找到该会话。',
        ),
    },
    async execute(args) {
      const info = requireService().getSession(args.sessionId)
      if (info === undefined) return { found: false as const }
      return {
        found: true as const,
        sessionId: info.sessionId,
        ticketId: info.ticketId,
        goal: info.goal,
        state: info.state,
        ...(info.lastReport !== undefined ? { lastReport: info.lastReport } : {}),
        ...(info.summary !== undefined ? { summary: info.summary } : {}),
      }
    },
  })

  const listSessions = defineTool({
    name: 'list_sessions',
    description: 'List delegated worker sessions with their states and latest reports.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessions: {
            type: 'json',
            required: true,
            description: 'Array of {sessionId, ticketId, goal, state, workspace?, lastReport?, summary?}.',
          },
        },
      },
      render: (_args, value) => {
        const sessions = (value as {
          sessions?: Array<{ sessionId: string; state: string; goal: string; workspace?: string }>
        }).sessions ?? []
        if (sessions.length === 0) return text('当前没有已指派会话。')
        return text(
          [
            `共 ${sessions.length} 个已指派会话：`,
            ...sessions.map(
              (session) =>
                `- ${session.sessionId}｜${session.state}｜${session.goal.slice(0, 60)}` +
                `${session.workspace !== undefined ? `｜工作区 ${session.workspace}` : ''}`,
            ),
          ].join('\n'),
        )
      },
    },
    async execute() {
      const sessions: Array<Record<string, string>> = requireService().listSessions().map((session) => ({
        sessionId: session.sessionId,
        ticketId: session.ticketId,
        goal: session.goal,
        state: session.state,
        ...(session.workspace !== undefined ? { workspace: session.workspace } : {}),
        ...(session.lastReport !== undefined ? { lastReport: session.lastReport } : {}),
        ...(session.summary !== undefined ? { summary: session.summary } : {}),
      }))
      return { sessions }
    },
  })

  const cancelSession = defineTool({
    name: 'cancel_session',
    description: 'Stop a worker session and mark its delegation stopped. Only use it when the user asked to stop or the work is clearly obsolete.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Worker session id.' },
      reason: { type: 'string', description: 'Short reason recorded in the ledger (optional).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'Whether the session was stopped.' },
          error: { type: 'string', description: 'Reason when ok=false.' },
        },
      },
      render: (_args, value) => text(value.ok ? '已叫停该任务。' : `未能叫停：${value.error ?? '未知原因'}`),
    },
    async execute(args) {
      return requireService().cancelSession(args.sessionId)
    },
  })

  const resolveApproval = defineTool({
    name: 'resolve_approval',
    description:
      'Decide a pending worker approval. Safe/low-risk actions may be decided directly (delegation). ' +
      'Dangerous escalations (danger-full-access, sandbox escalation) REQUIRE the user first: ' +
      'ask with send_message_to_user kind=question and wait for the reply — otherwise this call fails.',
    parameters: {
      requestId: { type: 'string', required: true, description: 'Approval id from the 【审批请求】 event.' },
      decision: {
        type: 'string',
        enum: ['approved', 'rejected'],
        required: true,
        description: 'approved = allow this one call; rejected = deny it.',
      },
      reason: { type: 'string', description: 'Short reason recorded in the audit trail (optional).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'Whether the decision was accepted.' },
          error: { type: 'string', description: 'Reason when ok=false.' },
        },
      },
      render: (_args, value) => text(value.ok ? '审批决定已提交。' : `决定未生效：${value.error ?? '未知原因'}`),
    },
    async execute(args) {
      return requireService().resolveApproval(args.requestId, args.decision === 'approved')
    },
  })

  const renderUi = defineTool({
    name: 'render_ui',
    // Same contract as the regular-session face (shared schema/description);
    // the butler face adds ledger persistence + announcement (G4).
    description:
      RENDER_UI_DESCRIPTION +
      '\nBUTLER FACE: the host persists the instruction and shows it to the user as an interactive card ' +
      'in the conversation automatically — do NOT repeat its content via send_message_to_user. ' +
      'Always pass target "inline" (this conversation has no side canvas).',
    parameters: RENDER_UI_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: {
            type: 'boolean',
            enum: [true],
            required: true,
            description: 'The instruction was accepted, persisted, and announced in the conversation.',
          },
          id: { type: 'string', required: true, description: 'Echo of the instruction id.' },
          revision: { type: 'integer', required: true, description: 'The revision recorded for this instruction.' },
          messageId: { type: 'string', required: true, description: 'Ledger message id the surface reference rides on.' },
        },
      },
      render: (args, value) =>
        text(`UI "${value.id}"（${args.component}，revision ${value.revision}）已出现在对话中（消息 ${value.messageId}），用户可直接交互。`),
    },
    async execute(args, exec) {
      // Host-side shape gate + strict contract gate, identical to the
      // regular-session face: violations settle as teaching tool errors.
      assertPlainArrays(args.component, args.props, args.data)
      const errors = validateInstruction(args)
      if (errors.length > 0) {
        throw new TypeError(
          `render_ui validation failed: ${errors.join('; ')}. Fix the listed fields and re-emit the complete instruction.`,
        )
      }
      const service = requireService()
      // Revision registration (G1/G2), same as the regular-session face: the
      // butler pump's send-back gate reads the registry, the persisted store
      // row (written by renderUi below) is the post-restart fallback.
      const sessionId = exec.agent?.session.id
      if (sessionId !== undefined) {
        service.genuiRevisions()?.record(sessionId, args.id, normalizeRevision(args.revision))
      }
      const outcome = service.renderUi({
        id: args.id,
        component: args.component,
        summary: args.summary,
        ...(args.revision !== undefined ? { revision: args.revision } : {}),
        ...(args.target !== undefined ? { target: args.target } : {}),
        ...(args.props !== undefined ? { props: args.props } : {}),
        ...(args.data !== undefined ? { data: args.data } : {}),
        ...(args.provenance !== undefined ? { provenance: args.provenance } : {}),
      })
      return { ok: true as const, id: outcome.id, revision: outcome.revision, messageId: outcome.messageId }
    },
  })

  return [
    sendMessageToUser,
    listWorkspaces,
    createSession,
    sendToSession,
    getSession,
    listSessions,
    cancelSession,
    resolveApproval,
    renderUi,
  ]
}

/** Registers the butler tools in the calling agent scope. */
export function apply(ctx: Context): void {
  for (const tool of createButlerTools()) ctx.tools.register(tool)
}
