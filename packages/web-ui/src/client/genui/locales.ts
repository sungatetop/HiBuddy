/** `hibuddy-genui` namespace dictionaries: the generative-UI toolview copy. */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  preparing: '正在生成界面…',
  unknown: '模型请求了未注册的组件，已显示原始指令。',
  degraded: '组件渲染失败，已降级为静态内容。',
  formRequired: '请填写必填项后再提交。',
  formFilled: '已填写内容（回传功能将在下个版本接入会话）',
  canvasOpen: '打开画布',
  canvasEmpty: '暂无画布内容：Agent 调用 render_ui（target=canvas）后，界面在此驻留，跨轮次可见。',
  canvasVersion: '版本 {i}/{n}',
  canvasLatest: '最新',
  canvasTurn: '来自第 {n} 轮',
} satisfies Record<string, string>

/** Generative-UI dictionary key union. */
export type GenuiLocaleKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en: Record<GenuiLocaleKey, string> = {
  preparing: 'Generating UI…',
  unknown: 'The model requested an unregistered component; showing the raw instruction.',
  degraded: 'The component failed to render; showing static content instead.',
  formRequired: 'Please fill in the required fields before submitting.',
  formFilled: 'Submitted values (conversation round-trip lands in the next iteration)',
  canvasOpen: 'Open canvas',
  canvasEmpty: 'No canvas content yet: once the agent calls render_ui (target=canvas), the surface docks here and stays across turns.',
  canvasVersion: 'Version {i}/{n}',
  canvasLatest: 'Latest',
  canvasTurn: 'from turn {n}',
}
