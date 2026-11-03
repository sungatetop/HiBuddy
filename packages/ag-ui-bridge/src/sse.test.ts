/**
 * Contract tests for the SSE sink (implementation-plan S3b task 5: SSE 编码).
 * The HTTP+SSE binding is the wire contract AG-UI clients parse — these tests
 * pin the framing (one JSON event per `data:` frame, LF endings, timestamp
 * injection, keep-alive comments) so a transport regression is caught without
 * booting a host.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import type { ServerResponse } from 'node:http'
import { SseSink } from './sse.ts'

/** Recorder standing in for the raw ServerResponse the sink writes into. */
function mockRes() {
  const writes: string[] = []
  const headers = new Map<string, string>()
  const res = {
    statusCode: 0,
    setHeader(key: string, value: string) { headers.set(key, value) },
    flushHeaders() {},
    write(chunk: string) { writes.push(chunk); return true },
    end() { writes.push('__end__') },
  }
  return { res: res as unknown as ServerResponse, writes, headers }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('SseSink（HTTP+SSE 绑定契约）', () => {
  it('sets the event-stream headers and 200 before any payload', () => {
    const { res, headers } = mockRes()
    new SseSink(res)
    expect(res.statusCode).toBe(200)
    expect(headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    expect(headers.get('cache-control')).toBe('no-store')
    expect(headers.get('connection')).toBe('keep-alive')
    expect(headers.get('x-accel-buffering')).toBe('no')
  })

  it('frames one event per data payload with LF endings and an injected timestamp', () => {
    const { res, writes } = mockRes()
    const sink = new SseSink(res)
    expect(sink.send({ type: 'STEP_STARTED', stepName: 'step-1' })).toBe(true)
    expect(writes).toHaveLength(1)
    expect(writes[0].endsWith('\n\n')).toBe(true)
    expect(writes[0]).not.toContain('\r')
    expect(writes[0].startsWith('data: ')).toBe(true)
    const payload = JSON.parse(writes[0].slice('data: '.length))
    expect(payload).toEqual({ timestamp: expect.any(Number), type: 'STEP_STARTED', stepName: 'step-1' })
    sink.close()
  })

  it('keeps an event-provided timestamp instead of overwriting it', () => {
    const { res, writes } = mockRes()
    const sink = new SseSink(res)
    sink.send({ type: 'STEP_STARTED', stepName: 's', timestamp: 1234 })
    expect(JSON.parse(writes[0].slice(6)).timestamp).toBe(1234)
    sink.close()
  })

  it('rejects writes after close and stays idempotent', () => {
    const { res, writes } = mockRes()
    const sink = new SseSink(res)
    sink.close()
    expect(sink.send({ type: 'STEP_STARTED', stepName: 's' })).toBe(false)
    expect(sink.close()).toBeUndefined()
    expect(writes).toEqual(['__end__'])
  })

  it('writes keep-alive comment frames at the 15s cadence and stops them on close', () => {
    vi.useFakeTimers()
    const { res, writes } = mockRes()
    const sink = new SseSink(res)
    vi.advanceTimersByTime(15_000)
    expect(writes).toEqual([': keep-alive\n\n'])
    sink.close()
    vi.advanceTimersByTime(60_000)
    expect(writes.filter(frame => frame !== '__end__')).toEqual([': keep-alive\n\n'])
  })
})
