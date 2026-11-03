/** `hibuddy-approval` namespace dictionaries: the enhanced approval card copy. */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  waiting: '等待审批',
  'detail.aria': '审批详情',
  escalation: '工具 {toolName} 请求越权执行',
  impact: '该操作将作用于当前工作区。批准仅对本次调用生效；拒绝后模型会收到拒绝原因并调整方案。',
  grantable: '「本会话免再询」为工具 {toolName} 记录本会话内的授权：本会话中后续同类调用不再询问，新会话恢复询问。',
  args: '调用参数',
  reject: '拒绝',
  approve: '批准',
  allowSession: '本会话免再询',
  grantFailed: '免再询授权失败，请重试或改用「批准」。',
} satisfies Record<string, string>

/** Approval dictionary key union. */
export type ApprovalLocaleKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en: Record<ApprovalLocaleKey, string> = {
  waiting: 'Waiting for approval',
  'detail.aria': 'Approval details',
  escalation: 'Tool {toolName} requests privileged execution',
  impact: 'This operation acts on the current workspace. Approving covers this call only; rejecting returns the reason to the model so it can adjust.',
  grantable: '"Skip asking this session" records a session-scoped grant for tool {toolName}: further calls in this session run without asking; a new session asks again.',
  args: 'Call arguments',
  reject: 'Reject',
  approve: 'Approve',
  allowSession: 'Skip asking this session',
  grantFailed: 'The grant request failed; retry, or use "Approve" for this call only.',
}
