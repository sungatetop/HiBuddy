/**
 * Single-instance guard for the resident state directory (resident-design.md §8).
 *
 * proper-lockfile with a fixed lock file inside the stateDir; stale detection
 * (S7-A verified) recovers the lock after a crash that never released it.
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import properLockfile from 'proper-lockfile'

/** Raised when the state directory is locked by another live instance. */
export class LockError extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(reason, options)
    this.name = 'LockError'
  }
}

/** Fixed lock file inside the stateDir. */
const LOCK_FILENAME = 'resident.lock'

/** A lock older than this (and not refreshed) is treated as stale, in ms. */
const STALE_MS = 60_000

/** Refresh interval; well below the stale window. */
const UPDATE_MS = 15_000

/** Handle keeping the state directory locked; release on plugin dispose. */
export interface StateLock {
  release(): void
}

/**
 * Acquire the single-instance lock for `stateDir`.
 * @throws LockError when another live instance holds the lock.
 */
export async function acquireStateLock(stateDir: string): Promise<StateLock> {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const lockPath = join(stateDir, LOCK_FILENAME)
  try {
    const release = await properLockfile.lock(stateDir, {
      lockfilePath: lockPath,
      stale: STALE_MS,
      update: UPDATE_MS,
      // A crashed instance leaves a mtime-frozen lock; give stale detection a
      // few chances before declaring double-instance (S7-A validated behavior).
      retries: { retries: 3, factor: 2, minTimeout: 200, maxTimeout: 1000 },
    })
    return { release: () => { release() } }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new LockError(
      `another resident instance appears to be running on "${stateDir}" (lock: ${lockPath}); ` +
        'only one resident orchestrator may own a state directory',
      { cause: error },
    )
  }
}
