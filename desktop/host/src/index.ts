/**
 * HiBuddy desktop host (ADR-004): runs as an Electron-binary-in-Node-mode child
 * (`ELECTRON_RUN_AS_NODE=1`), boots the named `hibuddy` profile from
 * `$DSH_HOME/profiles/hibuddy` through dsh's public `runProfile` — the same
 * resolution path as the CLI and Web server, so plugin installs and layered
 * patches stay one source of truth — and reports the authenticated web URL back
 * to the shell over Node IPC.
 *
 * Wire protocol (shell ⇄ host), the P0 subset of dsh's desktop protocol:
 *   host → shell: starting{runId} · ready{url} · fatal{message,diagnostic}
 *                 · shutdown-complete · quit-inspection{requestId,activeTasks,scheduledTasks}
 *   shell → host: shutdown · quit-inspection{requestId}
 */

import { randomUUID } from 'node:crypto'
import { inspect } from 'node:util'
import { pathToFileURL } from 'node:url'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-workspace'

const PROFILE = 'hibuddy'
const HOST_BIND_ARGS = ['--no-open', '--host', '127.0.0.1', '--port', '0'] as const

/** What quitting the host now would interrupt (mirrors dsh's desktop quit inspection). */
interface QuitInspection {
  readonly activeTasks: boolean
  readonly scheduledTasks: boolean
}

type HostEvent =
  | { readonly type: 'starting'; readonly runId: string }
  | { readonly type: 'ready'; readonly url: string }
  | { readonly type: 'fatal'; readonly message: string; readonly diagnostic: string }
  | { readonly type: 'shutdown-complete' }
  | ({ readonly type: 'quit-inspection'; readonly requestId: number } & Partial<QuitInspection>
    & { readonly error?: string })

function send(message: HostEvent): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.connected || process.send === undefined) { resolve(); return }
    process.send(message, (error) => { if (error === null) resolve(); else reject(error) })
  })
}

/**
 * Whether stopping now would interrupt work: a generating or tool-running agent
 * (including queued turns), or a running/stopping background job.
 */
function hasActiveTasks(liveAgents: ReturnType<Context['agents']['list']>, jobs: Context['jobs']): boolean {
  return liveAgents.some(agent => agent.status === 'running'
    || agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0)
    || [undefined, ...liveAgents].some(agent => jobs.list(agent?.id)
      .some(job => job.status === 'running' || job.status === 'stopping'))
}

/** Register the quit inspector on the booted profile context. */
function installQuitInspection(ctx: Context): () => Promise<QuitInspection> {
  let stopped = false
  ctx.effect(() => () => { stopped = true })
  return async () => {
    if (stopped) throw new Error('hibuddy desktop quit: host is stopping')
    const agents = ctx.get('agents')
    const jobs = ctx.get('jobs')
    if (agents === undefined || jobs === undefined) throw new Error('hibuddy desktop quit: task services are unavailable')
    const liveAgents = agents.list()
    const activeTasks = hasActiveTasks(liveAgents, jobs)
    let scheduledTasks = false
    for (const agent of liveAgents) {
      const activity = await ctx.waterfall('workspace/session-activity', { sessionId: agent.id }, () => Promise.resolve([]))
      if (activity.some(entry => entry.kind === 'schedule')) { scheduledTasks = true; break }
    }
    return { activeTasks, scheduledTasks }
  }
}

async function main(): Promise<void> {
  const runId = randomUUID()
  await send({ type: 'starting', runId })

  const environment = loadLayeredEnv(PROFILE)
  const application = runProfile({
    environment,
    profile: PROFILE,
    patchFiles: [],
    args: [...HOST_BIND_ARGS],
  })

  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => stopping ??= (async () => {
    // Startup failure keeps its own fatal-diagnostic exit; shutdown only owns a booted tree.
    const running = await application.catch(() => undefined)
    await running?.shutdown.shutdown(0)
    await send({ type: 'shutdown-complete' })
    if (process.connected) process.disconnect()
    // An open handle left by a disposed plugin would otherwise keep this process alive
    // past the shell's graceful deadline.
    if (running !== undefined) process.exit()
  })()

  process.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    if (message.type === 'shutdown') { void stop(); return }
    if (message.type === 'quit-inspection' && Number.isSafeInteger((message as unknown as { requestId?: unknown }).requestId)) {
      const requestId = (message as unknown as { requestId: number }).requestId
      void (async () => {
        try {
          if (stopping !== undefined) throw new Error('hibuddy desktop quit: host is stopping')
          const inspection = await inspectQuit()
          await send({ type: 'quit-inspection', requestId, ...inspection })
        } catch (error) {
          // The shell treats an unknown state as interruptible work and asks before quitting.
          await send({ type: 'quit-inspection', requestId, activeTasks: true, scheduledTasks: false,
            error: error instanceof Error ? error.message : String(error) })
        }
      })().catch((error: unknown) => { console.error(error) })
    }
  })
  process.once('disconnect', () => { void stop() })

  const { ctx } = await application
  const inspectQuit = installQuitInspection(ctx)
  const url = ctx.connection.authenticatedUrl(`${ctx.webServer.protocol}//127.0.0.1:${String(ctx.webServer.port)}`)
  await send({ type: 'ready', url })
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntry) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    // The shell receives the complete inspected error here, not through stderr:
    // stderr bytes and this IPC message race.
    const diagnostic = inspect(error)
    void send({ type: 'fatal', message, diagnostic }).finally(() => {
      process.exitCode = 1
      if (process.connected) process.disconnect()
    })
  })
}
