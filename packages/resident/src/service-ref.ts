/**
 * Service handoff between the resident host half and the butler tools plugin.
 *
 * The tools plugin mounts inside the `hibbuddy-butler` preset's agent scope,
 * which dsh activates eagerly — possibly before the host half's `apply` has
 * created the butler. A cordis `inject` dependency on an imperatively provided
 * service would then order (or fail) the preset activation. A module-level
 * singleton keeps the two halves decoupled: the tools are registered at
 * activation time and resolve the service lazily on every call.
 */

import type { ResidentButler } from './butler.ts'

let current: ResidentButler | undefined

/** Called by the host half once the butler is constructed. */
export function setResidentService(service: ResidentButler): void {
  current = service
}

/** Cleared on host dispose so a reload starts from a clean slate. */
export function clearResidentService(): void {
  current = undefined
}

/** Resolves the service, or undefined while the host half is still starting. */
export function getResidentService(): ResidentButler | undefined {
  return current
}
