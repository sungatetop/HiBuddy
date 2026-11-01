/**
 * HiBuddy web-UI customization, client half (skeleton).
 *
 * Register HiBuddy UI via ctx.slots.inject() into official declaration slots
 * (settings cards, workbench panels). References (thirdparty/deepseek-harness,
 * read-only): docs/cookbook/adding-a-settings-card.md, docs/subsystems/slots.md.
 * The `dsh.client.inject` edges are informational only; add the package names
 * of declaring packages here when the first slot contribution lands.
 */
export const inject = ['slots']

export function apply(): void {}
