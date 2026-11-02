/**
 * Shell-side lifecycle for the HiBuddy desktop host (ADR-004 D1/D5/D6): spawns
 * the Electron binary in Node mode (`ELECTRON_RUN_AS_NODE=1`) running the
 * `@hibuddy/desktop-host` entry, validates its IPC events, and escalates
 * termination on teardown. P0 protocol subset of dsh's desktop host channel.
 */

import { spawn, type ChildProcess } from 'node:child_process'

export interface HostReady {
  readonly url: string
}

export interface HostQuitInspection {
  readonly activeTasks: boolean
  readonly scheduledTasks: boolean
}

/** Host failure reported over IPC before the process exited. */
export class HostFatalError extends Error {
  constructor(message: string, readonly diagnostic: string | undefined) {
    super(message)
  }
}

type HostEvent =
  | { readonly type: 'starting'; readonly runId: string }
  | { readonly type: 'ready'; readonly url: string }
  | { readonly type: 'fatal'; readonly message: string; readonly diagnostic?: string }
  | { readonly type: 'shutdown-complete' }
  | { readonly type: 'quit-inspection'; readonly requestId: number; readonly activeTasks: boolean
    ; readonly scheduledTasks: boolean; readonly error?: string }

const MAX_HOST_DIAGNOSTIC_CHARS = 64 * 1024
/** A slower host counts as unknown work and the shell asks before quitting (dsh parity). */
export const QUIT_INSPECTION_DEADLINE_MS = 2_000
const SHUTDOWN_GRACE_MS = 10_000
const KILL_GRACE_MS = 5_000

function isHostEvent(message: unknown): message is HostEvent {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  const candidate = message as Record<string, unknown>
  switch (candidate.type) {
    case 'starting':
      return typeof candidate.runId === 'string'
    case 'ready':
      return typeof candidate.url === 'string'
    case 'fatal':
      return typeof candidate.message === 'string'
      && (candidate.diagnostic === undefined || typeof candidate.diagnostic === 'string')
    case 'shutdown-complete':
      return true
    case 'quit-inspection':
      return Number.isSafeInteger(candidate.requestId)
      && typeof candidate.activeTasks === 'boolean' && typeof candidate.scheduledTasks === 'boolean'
      && (candidate.error === undefined || typeof candidate.error === 'string')
    default:
      return false
  }
}

async function exitsWithin(exit: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => { resolve(false) }, milliseconds)
    timer.unref()
  })
  try {
    return await Promise.race([exit.then(() => true), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** One HiBuddy web backend running under the Electron executable in Node mode. */
export class HostProcess {
  private child: ChildProcess | undefined
  private readyResolve!: (ready: HostReady) => void
  private readyReject!: (error: Error) => void
  private readonly readyPromise = new Promise<HostReady>((resolve, reject) => {
    this.readyResolve = resolve
    this.readyReject = reject
  })
  private exitPromise: Promise<void> | undefined
  private stdout = ''
  private stderr = ''
  private failureReported = false
  private stopping = false
  private nextControlId = 1
  private readonly controlRequests = new Map<number, {
    resolve: (response: HostEvent) => void
    reject: (error: Error) => void
  }>()

  /**
   * @param node - Absolute Electron executable to run in Node mode.
   * @param hostEntry - Absolute path of the built @hibuddy/desktop-host entry.
   * @param projectDir - Host working directory (.env project layer and process cwd).
   * @param onFailure - Receives the first unexpected child failure, including after readiness.
   */
  constructor(
    private readonly node: string,
    private readonly hostEntry: string,
    private readonly projectDir: string,
    private readonly onFailure?: (error: Error) => void,
  ) {}

  /** Start this child once and await its web application URL. */
  async start(): Promise<HostReady> {
    if (this.child !== undefined) return this.readyPromise
    const child = spawn(this.node, ['--expose-internals', this.hostEntry], {
      cwd: this.projectDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    this.child = child
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-MAX_HOST_DIAGNOSTIC_CHARS) })
    // Collect instead of piping to process.stdout: in the packaged GUI shell the
    // parent's stdout is unwritable (Windows GUI subsystem, no console), and the
    // resulting backpressure would deadlock the child on its first console.log.
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { this.stdout = (this.stdout + chunk).slice(-MAX_HOST_DIAGNOSTIC_CHARS) })
    child.on('message', (message: unknown) => {
      if (!isHostEvent(message)) {
        this.fail(new Error('hibuddy desktop host sent an invalid IPC event'))
        child.kill('SIGTERM')
        return
      }
      if (message.type === 'ready') this.readyResolve({ url: message.url })
      else if (message.type === 'fatal') this.fail(new HostFatalError(message.message, message.diagnostic))
      else if (message.type === 'shutdown-complete') {
        if (this.stopping) this.shutdownCompleted = true
        else this.fail(new Error('hibuddy desktop host acknowledged an unrequested shutdown'))
      } else if (message.type === 'quit-inspection') {
        const request = this.controlRequests.get(message.requestId)
        if (message.error === undefined) request?.resolve(message)
        else request?.reject(new Error(message.error))
      }
    })
    child.once('error', (error) => { this.fail(error) })
    this.exitPromise = new Promise<void>((resolve) => {
      child.once('close', (code) => {
        const diagnostic = [this.stderr.trim(), this.stdout.trim()].filter(part => part !== '').join('\n--- host stdout ---\n')
        const suffix = diagnostic === '' ? '' : `: ${diagnostic}`
        if (code !== 0 && code !== null) this.fail(new Error(`hibuddy desktop host exited with ${String(code)}${suffix}`))
        else this.fail(new Error(`hibuddy desktop host stopped${suffix}`))
        resolve()
      })
    })
    return this.readyPromise
  }

  private shutdownCompleted = false

  /**
   * Ask the host what quitting now would interrupt; rejects on the deadline and the shell then asks before quitting.
   */
  async inspectQuit(): Promise<HostQuitInspection> {
    const response = await this.control({ type: 'quit-inspection' }, QUIT_INSPECTION_DEADLINE_MS, 'hibuddy desktop quit: inspection timed out')
    if (response.type !== 'quit-inspection') throw new Error('hibuddy desktop quit: host answered with a different control response')
    return { activeTasks: response.activeTasks, scheduledTasks: response.scheduledTasks }
  }

  /**
   * Request teardown and await child exit, escalating termination when needed.
   */
  async stop(): Promise<void> {
    const child = this.child
    if (child === undefined) return
    this.stopping = true
    if (child.connected) child.send({ type: 'shutdown' }, (error) => { if (error !== null) this.fail(error) })
    const exited = this.exitPromise ?? Promise.resolve()
    if (!await exitsWithin(exited, SHUTDOWN_GRACE_MS)) child.kill('SIGTERM')
    if (!await exitsWithin(exited, KILL_GRACE_MS)) {
      child.kill('SIGKILL')
      if (!await exitsWithin(exited, KILL_GRACE_MS)) {
        throw new Error('hibuddy desktop host did not exit after SIGKILL')
      }
    }
    this.child = undefined
  }

  private async control(
    request: { readonly type: 'quit-inspection' },
    deadlineMs: number, deadlineMessage: string,
  ): Promise<HostEvent> {
    const child = this.child
    if (child === undefined || !child.connected || this.failureReported || this.stopping) {
      throw new Error('hibuddy desktop: host is unavailable')
    }
    const requestId = this.nextControlId++
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<HostEvent>((resolve, reject) => {
        this.controlRequests.set(requestId, { resolve, reject })
        timer = setTimeout(() => {
          this.controlRequests.get(requestId)?.reject(new Error(deadlineMessage))
        }, deadlineMs)
        child.send({ ...request, requestId }, (error) => { if (error !== null) reject(error) })
      })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      this.controlRequests.delete(requestId)
    }
  }

  private fail(error: Error): void {
    this.readyReject(error)
    for (const request of this.controlRequests.values()) request.reject(error)
    this.controlRequests.clear()
    if (!this.failureReported && !this.stopping) {
      this.failureReported = true
      try { this.onFailure?.(error) } catch (listenerError) {
        console.error('hibuddy desktop host failure listener failed', listenerError)
      }
    }
  }
}
