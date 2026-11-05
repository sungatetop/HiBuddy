import { describe, expect, it } from 'vitest'
import { resolveStateDir, StateDirError } from './state-dir.ts'
import { isAbsolute, resolve } from 'node:path'

describe('resolveStateDir — stateDir deployment gate (D3)', () => {
  it('rejects a missing config object', () => {
    expect(() => resolveStateDir(undefined)).toThrow(StateDirError)
  })

  it('rejects a missing / empty / non-string stateDir', () => {
    expect(() => resolveStateDir({})).toThrow(StateDirError)
    expect(() => resolveStateDir({ stateDir: '' })).toThrow(StateDirError)
    expect(() => resolveStateDir({ stateDir: '   ' })).toThrow(StateDirError)
    expect(() => resolveStateDir({ stateDir: 42 as unknown as string })).toThrow(StateDirError)
  })

  it('rejects relative paths', () => {
    expect(() => resolveStateDir({ stateDir: 'state/resident' })).toThrow(StateDirError)
    expect(() => resolveStateDir({ stateDir: './resident' })).toThrow(StateDirError)
  })

  it('resolves the ${DSH_HOME} placeholder against the harness home', () => {
    const dir = resolveStateDir({ stateDir: '${DSH_HOME}/state/resident' })
    expect(isAbsolute(dir)).toBe(true)
    expect(dir).toContain('state')
  })

  it('expands a leading ~ against the OS home', () => {
    const dir = resolveStateDir({ stateDir: '~/.dsh/state/resident' })
    expect(isAbsolute(dir)).toBe(true)
    expect(dir).not.toContain('~')
  })

  it('accepts an absolute path as-is (normalized)', () => {
    const absolute = resolve('C:', 'abs', 'resident-state')
    expect(resolveStateDir({ stateDir: absolute })).toBe(resolve(absolute))
  })

  it('error message names the config key and the remedy', () => {
    try {
      resolveStateDir(undefined)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(StateDirError)
      expect((error as Error).message).toContain('resident.stateDir')
      expect((error as Error).message).toContain('refuses to start')
    }
  })
})
