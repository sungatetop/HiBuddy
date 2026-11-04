/** `hibuddy-byok` namespace dictionaries: Models-page extension cards (FR-06). */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'verify.title': '连接校验',
  'verify.idle': '发起一次最小请求，验证当前密钥与端点是否可用。',
  'verify.checking': '正在校验连接…',
  'verify.ok': '连接正常（{model}）',
  'verify.button': '测试连接',
  'verify.retry': '重新测试',
  'verify.reason.invalid_key': 'API 密钥无效或已被撤销，请检查密钥后重新保存。',
  'verify.reason.quota': '账户余额不足或请求过于频繁（限流），请检查提供商控制台。',
  'verify.reason.network': '无法连接到提供商端点，请检查网络或 base URL。',
  'verify.reason.not_configured': '该提供商尚未配置完整（缺少密钥或模型目录为空）。',
  'verify.reason.unknown': '校验失败：{detail}',
  'recommend.title': 'HiBuddy 推荐配置',
  'recommend.body': '首选 DeepSeek 官方 API（产品默认路由）。国内可达备选：MiniMax 中国站（minimax-cn）、月之暗面 Kimi（moonshotai-cn）、通义千问（qwen-token-plan-cn）——在上方「添加模型提供商 → 第三方模型提供商」目录中选择。',
  'recommend.privacy': 'API 密钥仅保存在本机 dsh 凭证库，界面与日志永不明文显示。',
} satisfies Record<string, string>

/** BYOK dictionary key union. */
export type ByokLocaleKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en: Record<ByokLocaleKey, string> = {
  'verify.title': 'Connection check',
  'verify.idle': 'Sends one minimal request to verify the current key and endpoint.',
  'verify.checking': 'Checking connection…',
  'verify.ok': 'Connection OK ({model})',
  'verify.button': 'Test connection',
  'verify.retry': 'Test again',
  'verify.reason.invalid_key': 'The API key is invalid or revoked; check the key and save again.',
  'verify.reason.quota': 'Insufficient balance or rate limited; check the provider console.',
  'verify.reason.network': 'Could not reach the provider endpoint; check the network or base URL.',
  'verify.reason.not_configured': 'This provider is not fully configured (missing key or empty model catalog).',
  'verify.reason.unknown': 'Check failed: {detail}',
  'recommend.title': 'HiBuddy recommended setup',
  'recommend.body': 'DeepSeek official API is the recommended default (the product\'s default route). Reachable alternatives in mainland China: MiniMax China (minimax-cn), MoonshotAI Kimi (moonshotai-cn), Alibaba Qwen (qwen-token-plan-cn) — pick them under "Add model provider → Third-party model provider" above.',
  'recommend.privacy': 'API keys are stored only in the local dsh credential store and never appear in plain text in the UI or logs.',
}
