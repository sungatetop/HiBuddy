/**
 * HiBuddy browser-brand plugin, node half. The empty apply gives Loader a
 * host-side row while the browser half ships through `exports["./client"]`
 * (same layout as the official @deepseek-ai/dsh-client-ui-brand-official).
 */

/** Host plugin body — this package contributes browser presentation only. */
export function apply(): void {}
