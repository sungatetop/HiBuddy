/**
 * SSE sink for one AG-UI run (AG-UI HTTP+SSE binding, spec 1.0 transports/http-sse).
 *
 * Contract details this class pins down:
 * - each SSE event's `data` payload is exactly one protocol event as JSON;
 * - the producer MUST frame with LF line endings;
 * - comment lines (`: keep-alive`) may be sent at any cadence as heartbeats;
 * - the response body closes after the run's terminal event.
 */

import type { ServerResponse } from 'node:http'
import type { AguiEvent } from './types.ts'

/** Heartbeat cadence for idle streams (comment frames, ignored by consumers). */
const KEEP_ALIVE_MS = 15_000

/** One open SSE response carrying exactly one run. */
export class SseSink {
  private readonly res: ServerResponse
  private heartbeat: NodeJS.Timeout | undefined
  private closed = false

  constructor(res: ServerResponse) {
    this.res = res
    res.statusCode = 200
    res.setHeader('content-type', 'text/event-stream; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('connection', 'keep-alive')
    res.setHeader('x-accel-buffering', 'no')
    res.flushHeaders()
    this.heartbeat = setInterval(() => {
      if (!this.closed) this.res.write(': keep-alive\n\n')
    }, KEEP_ALIVE_MS)
    this.heartbeat.unref()
  }

  /** Write one protocol event; returns false once the underlying stream is gone. */
  send(event: AguiEvent): boolean {
    if (this.closed) return false
    const payload = event.timestamp === undefined ? { timestamp: Date.now(), ...event } : event
    return this.res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }

  /** Close the response body (terminal event already sent or client gone). */
  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.res.end()
  }
}
