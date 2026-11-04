/**
 * Run Markdown export (FR-08 rule 3, S5-2): document structure, fenced-arg
 * JSON pretty-printing, fence-guard against embedded backticks, and the
 * approval/error annotations.
 */
import { describe, expect, it } from 'vitest'
import { deriveRunTimelines } from './derive.ts'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { runMarkdown, type RunExportText } from './markdown.ts'
import { en } from './locales.ts'

let seq = 0

function ev(type: string, data: Record<string, unknown>, time = 1000): SessionEventLikeEntry {
  return { type: 'event', event: { type, seq: ++seq, time, data } } as unknown as SessionEventLikeEntry
}

const t: RunExportText = (key) => en[key]

describe('runMarkdown', () => {
  it('renders header meta, a tool section with pretty args, and the output block', () => {
    seq = 0
    const [run] = deriveRunTimelines([
      ev('turn/start', { turn: 9 }, 1_000),
      ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '列一下目录' }] }, 1_100),
      ev('step/start', { turn: 9, step: 1 }, 1_200),
      ev('tool/call', { turn: 9, step: 1, callId: 'c9', name: 'bash', arguments: '{"cmd":"ls"}' }, 1_300),
      ev('tool/result', { message: { toolCallId: 'c9', isError: false, content: [{ type: 'text', text: 'a.txt' }] } }, 1_400),
      ev('assistant/message', { turn: 9, step: 1, message: { content: [{ type: 'text', text: '目录里有 a.txt' }] }, usage: { outputTokens: 7 } }, 1_500),
      ev('turn/end', { turn: 9, reason: { kind: 'completed' } }, 1_600),
    ])
    const md = runMarkdown(run, 'session-x', t, en['status.completed'])
    expect(md).toContain('# HiBuddy Run record — Turn 9')
    expect(md).toContain('`session-x`')
    // FR-02 summary section: goal / result / tool stats / duration.
    expect(md).toContain('## Summary')
    expect(md).toContain('- Goal: 列一下目录')
    expect(md).toContain('- Result: 目录里有 a.txt')
    expect(md).toContain('- Tool calls: 1 (1 ✓ / 0 ✗)')
    expect(md).toContain('- Duration: 600ms')
    expect(md.indexOf('## Summary')).toBeLessThan(md.indexOf('## Timeline'))
    expect(md).toContain('### Step 1')
    expect(md).toContain('**Tool call** `bash` — ✓')
    expect(md).toContain('Duration: 100ms')
    expect(md).toContain('"cmd": "ls"') // pretty-printed JSON
    expect(md).toContain('- Result summary: a.txt')
    expect(md).toContain('Output tokens: 7')
    expect(md).toContain('目录里有 a.txt')
  })

  it('annotates errors and approval decisions, echoing unparsable args verbatim', () => {
    seq = 0
    const [run] = deriveRunTimelines(
      [
        ev('turn/start', { turn: 10 }, 2_000),
        ev('tool/call', { turn: 10, step: 1, callId: 'c10', name: 'bash', arguments: 'not-json{' }, 2_100),
        ev('tool/result', { message: { toolCallId: 'c10', isError: true, content: [] }, error: { reason: 'denied' } }, 2_200),
        ev('turn/end', { turn: 10, reason: { kind: 'error', error: { message: 'stopped', code: 'E' } } }, 2_300),
      ],
      new Map([['c10', { decision: 'rejected', toolName: 'bash', at: 2_150 }]]),
    )
    const md = runMarkdown(run, 's', t, en['status.error'])
    expect(md).toContain('✗')
    expect(md).toContain('(denied)')
    expect(md).toContain('- Approval: rejected')
    expect(md).toContain('not-json{')
    expect(md).toContain('stopped')
  })

  it('keeps embedded triple backticks from breaking the arg fence', () => {
    seq = 0
    const [run] = deriveRunTimelines([
      ev('turn/start', { turn: 11 }, 3_000),
      ev('tool/call', { turn: 11, step: 1, callId: 'c11', name: 'write', arguments: '{"code":"```js\\nconst a=1\\n```"}' }, 3_100),
      ev('turn/end', { turn: 11, reason: { kind: 'completed' } }, 3_200),
    ])
    const md = runMarkdown(run, 's', t, en['status.completed'])
    // All fences sit inside the indented list context (indent() pads every
    // non-empty line), so match fence lines with leading whitespace.
    const fences = md.match(/^[ ]*`{3,}/gm) ?? []
    // Every fence line in the document is at least 4 backticks (guard bumped
    // past the embedded ```), so the args block stays one fenced section.
    expect(fences.length).toBeGreaterThan(0)
    for (const fence of fences) expect(fence.length).toBeGreaterThanOrEqual(4)
  })
})
