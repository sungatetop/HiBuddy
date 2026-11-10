import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachmentHref, prepareAttachments } from './attachments.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'resident-att-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('prepareAttachments', () => {
  it('classifies a local file by extension and records its size', () => {
    const file = join(root, 'chart.png')
    writeFileSync(file, Buffer.alloc(16))

    const [attachment] = prepareAttachments([{ path: file }], [root])
    expect(attachment).toMatchObject({
      kind: 'image',
      name: 'chart.png',
      mime: 'image/png',
      size: 16,
      path: file,
    })
    expect(attachment!.id.startsWith('att_')).toBe(true)
    expect(attachmentHref(attachment!)).toContain('/resident/api/attachment?id=')
  })

  it('detects video, audio and document kinds', () => {
    const files = ['clip.mp4', 'voice.mp3', 'report.pdf']
    for (const name of files) writeFileSync(join(root, name), 'x')

    const prepared = prepareAttachments(files.map((name) => ({ path: join(root, name) })), [root])
    expect(prepared.map((entry) => entry.kind)).toEqual(['video', 'audio', 'file'])
  })

  it('accepts remote http(s) urls and uses their last path segment as the name', () => {
    const [attachment] = prepareAttachments([{ url: 'https://example.com/media/photo.webp' }], [])
    expect(attachment).toMatchObject({ kind: 'image', name: 'photo.webp', url: 'https://example.com/media/photo.webp' })
    expect(attachmentHref(attachment!)).toBe('https://example.com/media/photo.webp')
  })

  it('lets an explicit kind override the extension', () => {
    const file = join(root, 'payload.bin')
    writeFileSync(file, 'x')
    const [attachment] = prepareAttachments([{ path: file, kind: 'audio', name: '录音' }], [root])
    expect(attachment).toMatchObject({ kind: 'audio', name: '录音' })
  })

  it('rejects files outside the registered workspace roots', () => {
    const other = mkdtempSync(join(tmpdir(), 'resident-outside-'))
    const file = join(other, 'secret.txt')
    writeFileSync(file, 'x')
    try {
      expect(() => prepareAttachments([{ path: file }], [root])).toThrow(/不在任何工作区/)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('rejects relative paths, missing files, and malformed requests', () => {
    expect(() => prepareAttachments([{ path: 'relative.png' }], [root])).toThrow(/绝对路径/)
    expect(() => prepareAttachments([{ path: join(root, 'missing.png') }], [root])).toThrow(/不存在/)
    expect(() => prepareAttachments([{}], [root])).toThrow(/path 或 url/)
    expect(() => prepareAttachments([{ path: join(root, 'a.png'), url: 'https://x.test/a.png' }], [root])).toThrow(
      /只能提供/,
    )
    expect(() => prepareAttachments([{ url: 'file:///etc/passwd' }], [root])).toThrow(/http\/https/)
  })

  it('accepts nested files under a workspace but not a sibling prefix', () => {
    const nested = join(root, 'resident-work', 'tkt_1')
    mkdirSync(nested, { recursive: true })
    const file = join(nested, 'out.txt')
    writeFileSync(file, 'ok')
    expect(prepareAttachments([{ path: file }], [root])).toHaveLength(1)

    const sibling = `${root}-sibling`
    mkdirSync(sibling, { recursive: true })
    const outside = join(sibling, 'out.txt')
    writeFileSync(outside, 'no')
    try {
      expect(() => prepareAttachments([{ path: outside }], [root])).toThrow(/不在任何工作区/)
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })
})
