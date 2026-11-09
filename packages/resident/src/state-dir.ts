/**
 * stateDir deployment gate (resident-design.md §8, decision D3).
 *
 * The resident layer is only meaningful with durable state (tickets, sources,
 * notifications survive restarts), so an unconfigured state directory must
 * stop the plugin at startup — refuse to boot rather than run half-alive.
 *
 * Accepted forms for `resident.stateDir`:
 * - `${DSH_HOME}/state/resident` — placeholder resolved against the harness
 *   home (honours $DSH_HOME, defaults to ~/.dsh). The portable form the
 *   HiBuddy profile ships.
 * - `~/...` — expanded against the OS home (same helper dsh uses).
 * - an absolute path — used as-is.
 * Anything else (missing/empty/relative) is a gate failure.
 */

import { expandHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { isAbsolute, resolve } from 'node:path'

/** Placeholder referring to the harness home inside a configured stateDir. */
export const DSH_HOME_PLACEHOLDER = '${DSH_HOME}'

/** Plugin configuration of the resident orchestrator. */
export interface ResidentConfig {
  /** Durable-state root (SQLite DB, locks, per-ticket work dirs live under it). */
  stateDir?: string
  /**
   * Workspace the butler binds to (id, title, or canonical path). Omitted =
   * the first registered dsh workspace (the user's most recent project).
   */
  workspace?: string
}

/** Failure of the stateDir gate, with a user-facing reason. */
export class StateDirError extends Error {
  constructor(reason: string) {
    super(`@hibuddy/resident refuses to start: ${reason}`)
    this.name = 'StateDirError'
  }
}

/**
 * Validate the raw plugin config and resolve the absolute stateDir.
 * @param config - raw config object as passed by the patch row (may be absent).
 * @returns the resolved absolute stateDir.
 * @throws StateDirError when the gate rejects the configuration.
 */
export function resolveStateDir(config: ResidentConfig | undefined): string {
  const raw = config?.stateDir
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new StateDirError(
      '"resident.stateDir" is not configured — the resident layer has no meaning without durable state. ' +
        'Set it in the profile patch, e.g. stateDir: "${DSH_HOME}/state/resident".',
    )
  }
  const expanded = raw.includes(DSH_HOME_PLACEHOLDER)
    ? raw.replaceAll(DSH_HOME_PLACEHOLDER, resolveDshHome())
    : expandHomePath(raw)
  if (!isAbsolute(expanded)) {
    throw new StateDirError(
      `"resident.stateDir" must be an absolute path (or use \${DSH_HOME} / ~), got: ${raw}`,
    )
  }
  return resolve(expanded)
}
