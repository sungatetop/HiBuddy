/**
 * `hibuddy-quota` namespace dictionaries: the frame-wide quota notice card copy.
 */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  title: '模型额度不足',
  hint: '前往「设置 → 模型」更换供应商或模型，或补充账户额度后重试。',
  goSettings: '去设置',
  dismiss: '知道了',
} satisfies Record<string, string>

/** Quota dictionary key union. */
export type QuotaLocaleKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en: Record<QuotaLocaleKey, string> = {
  title: 'Model quota exhausted',
  hint: 'Open Settings → Models to switch provider or model, or top up your account and retry.',
  goSettings: 'Open settings',
  dismiss: 'Got it',
}
