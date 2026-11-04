/** `hibuddy-genui` namespace dictionaries: the generative-UI toolview copy. */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  preparing: '正在生成界面…',
  unknown: '模型请求了未注册的组件，已显示原始指令。',
  degraded: '组件渲染失败，已降级为静态内容。',
  formRequired: '请填写必填项后再提交。',
  formSent: '已提交给 Agent，下一轮回复将引用该内容。',
  formSendFailed: '回传会话失败，请重试。',
  canvasOpen: '打开画布',
  canvasEmpty: '暂无画布内容：Agent 调用 render_ui（target=canvas）后，界面在此驻留，跨轮次可见。',
  canvasVersion: '版本 {i}/{n}',
  canvasLatest: '最新',
  canvasTurn: '来自第 {n} 轮',
  canvasInteractions: '交互记录',
  stateTitle: '共享状态',
  stateEmpty: '暂无共享状态：Agent 调用 shared_state 写入，或你在下方编辑后，键值在此出现。',
  stateKeyPh: '键（如 todo）',
  stateValuePh: '值（JSON 或文本）',
  stateSave: '写入',
  stateSent: '已发给 Agent 写入共享状态，下一轮生效。',
  stateHint: '双方可编辑：你的写入由 Agent 代记（来源标为 user），冲突时以时间新者为准并提示。',
} satisfies Record<string, string>

/** Generative-UI dictionary key union. */
export type GenuiLocaleKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en: Record<GenuiLocaleKey, string> = {
  preparing: 'Generating UI…',
  unknown: 'The model requested an unregistered component; showing the raw instruction.',
  degraded: 'The component failed to render; showing static content instead.',
  formRequired: 'Please fill in the required fields before submitting.',
  formSent: 'Submitted to the agent; the next reply will reflect it.',
  formSendFailed: 'Send-back failed; please retry.',
  canvasOpen: 'Open canvas',
  canvasEmpty: 'No canvas content yet: once the agent calls render_ui (target=canvas), the surface docks here and stays across turns.',
  canvasVersion: 'Version {i}/{n}',
  canvasLatest: 'Latest',
  canvasTurn: 'from turn {n}',
  canvasInteractions: 'Interactions',
  stateTitle: 'Shared state',
  stateEmpty: 'No shared state yet: agent shared_state writes and your own edits below appear here.',
  stateKeyPh: 'key (e.g. todo)',
  stateValuePh: 'value (JSON or text)',
  stateSave: 'Write',
  stateSent: 'Sent to the agent; it takes effect next turn.',
  stateHint: 'Both sides edit: your write is journaled by the agent (source "user"); on conflict the newest write wins and is reported.',
}
