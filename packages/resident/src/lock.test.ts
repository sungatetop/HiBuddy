import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireStateLock, LockError } from './lock.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'resident-lock-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('acquireStateLock', () => {
  it('acquires once and releases cleanly', async () => {
    const lock = await acquireStateLock(dir)
    expect(() => lock.release()).not.toThrow()
  })

  it('rejects a second live holder of the same stateDir', async () => {
    const first = await acquireStateLock(dir)
    await expect(acquireStateLock(dir)).rejects.toThrow(LockError)
    await expect(acquireStateLock(dir)).rejects.toThrow(/only one resident orchestrator/)
    first.release()
    // after release the directory is lockable again
    const second = await acquireStateLock(dir)
    second.release()
  })

  it('allows independent state directories to lock concurrently', async () => {
    const other = join(dir, 'other')
    const a = await acquireStateLock(dir)
    const b = await acquireStateLock(other)
    a.release()
    b.release()
  })
})
