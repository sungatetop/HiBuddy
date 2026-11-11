import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanArtifacts } from './artifacts.ts'

/** Reference instant the tests age files against. */
const NOW = Date.parse('2026-11-11T08:00:00Z')

/** Writes a file and pins its mtime to `mtimeMs` (deterministic aging). */
function writeAged(dir: string, name: string, mtimeMs: number, content = 'x'): void {
  const path = join(dir, name)
  writeFileSync(path, content)
  utimesSync(path, new Date(mtimeMs), new Date(mtimeMs))
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'resident-artifacts-'))
}

describe('scanArtifacts', () => {
  it('returns files modified at/after sinceMs, newest first', () => {
    const dir = freshDir()
    try {
      writeAged(dir, 'old.txt', NOW - 10_000) // before the cutoff: skipped
      writeAged(dir, 'new.txt', NOW + 1_000)
      writeAged(dir, 'mid.txt', NOW + 500)
      expect(scanArtifacts(dir, NOW).map((a) => a.name)).toEqual(['new.txt', 'mid.txt'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('classifies artifact kinds by extension', () => {
    const dir = freshDir()
    try {
      writeAged(dir, 'chart.png', NOW + 1, 'png')
      writeAged(dir, 'clip.mp4', NOW + 2, 'mp4')
      writeAged(dir, 'data.zip', NOW + 3, 'zip')
      const artifacts = scanArtifacts(dir, NOW)
      expect(artifacts.find((a) => a.name === 'chart.png')!.kind).toBe('image')
      expect(artifacts.find((a) => a.name === 'clip.mp4')!.kind).toBe('video')
      expect(artifacts.find((a) => a.name === 'data.zip')!.kind).toBe('file')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips hidden and temporary files, and symbolic links', () => {
    const dir = freshDir()
    try {
      writeAged(dir, '.hidden', NOW + 1)
      writeAged(dir, '~$lock.docx', NOW + 1)
      writeAged(dir, 'note.tmp', NOW + 1)
      const target = join(dir, 'outside.txt')
      writeAged(dir, 'outside.txt', NOW + 1)
      let linked = false
      try {
        symlinkSync(target, join(dir, 'link.txt'))
        linked = true
      } catch {
        // Windows may require privileges to create symlinks — skip that assert.
      }
      const names = scanArtifacts(dir, NOW).map((a) => a.name)
      expect(names).not.toContain('.hidden')
      expect(names).not.toContain('~$lock.docx')
      expect(names).not.toContain('note.tmp')
      if (linked) expect(names).not.toContain('link.txt')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('caps the result at 20 and ignores files deeper than depth 4', () => {
    const dir = freshDir()
    try {
      let deep = dir
      for (let i = 0; i < 6; i++) deep = join(deep, `d${i}`) // depth 6 > 4
      mkdirSync(deep, { recursive: true })
      writeAged(deep, 'deep.txt', NOW + 1)
      for (let i = 0; i < 210; i++) writeAged(dir, `f${i}.txt`, NOW + 1)
      const artifacts = scanArtifacts(dir, NOW)
      expect(artifacts).toHaveLength(20)
      expect(artifacts.some((a) => a.name === 'deep.txt')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('degrades to [] for a missing or unreadable root', () => {
    expect(scanArtifacts(join(tmpdir(), 'resident-artifacts-missing'), NOW)).toEqual([])
  })
})
