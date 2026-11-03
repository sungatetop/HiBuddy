/** `hibuddy-genui` namespace dictionaries: the generative-UI toolview copy. */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  preparing: '正在生成界面…',
  unknown: '模型请求了未注册的组件，已显示原始指令。',
  degraded: '组件渲染失败，已降级为静态内容。',
} satisfies Record<string, string>

/** Generative-UI dictionary key union. */
export type GenuiLocaleKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en: Record<GenuiLocaleKey, string> = {
  preparing: 'Generating UI…',
  unknown: 'The model requested an unregistered component; showing the raw instruction.',
  degraded: 'The component failed to render; showing static content instead.',
}
