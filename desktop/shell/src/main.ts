/**
 * HiBuddy desktop shell entry (ADR-004): Electron main process owning the
 * window, tray, single-instance lock, and the RunAsNode host lifecycle. The
 * renderer loads the host's authenticated loopback URL directly (P0), with a
 * navigation gate; all Node authority stays in the host child process.
 */

import { app, BrowserWindow, dialog, shell } from 'electron'
import { appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HostProcess, HostFatalError } from './host-process.js'
import { createTray } from './tray.js'

const here = dirname(fileURLToPath(import.meta.url))
// Dev layout: <repo>/desktop/shell/lib/main.js → host entry and repo root are relative.
// Packaged builds override both via env (wired in S1-D).
const hostEntry = process.env.HIBUDDY_HOST_ENTRY ?? join(here, '../../host/lib/index.js')
const projectDir = process.env.HIBUDDY_PROJECT_DIR ?? join(here, '../../..')

let mainWindow: BrowserWindow | undefined
let host: HostProcess | undefined
let quitting = false
/** Origin of the host's authenticated URL; renderer navigation must stay on it. */
let allowedOrigin: string | undefined

const logFile = join(app.getPath('userData'), 'shell.log')
function log(message: string): void {
  try { appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`) } catch { /* diagnostics only */ }
  console.log(`[hibuddy-shell] ${message}`)
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'HiBuddy',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  })
  // Navigation gate (ADR-004 D4): stay on the host's loopback origin; open everything else externally.
  const external = (url: string): boolean => {
    try {
      return allowedOrigin === undefined || new URL(url).origin !== allowedOrigin
    } catch {
      return true
    }
  }
  window.webContents.on('will-navigate', (event, url) => {
    if (!external(url)) return
    event.preventDefault()
    void shell.openExternal(url)
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!external(url)) return { action: 'allow' }
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.once('ready-to-show', () => window.show())
  window.on('close', (event) => {
    // Closing the window means quitting: run the inspection flow, cancel keeps the window.
    if (!quitting) {
      event.preventDefault()
      void quitFlow()
    }
  })
  return window
}

async function quitFlow(): Promise<void> {
  if (quitting) return
  quitting = true
  try {
    if (host !== undefined) {
      let activeTasks = false
      try {
        activeTasks = (await host.inspectQuit()).activeTasks
      } catch {
        // Unknown state counts as interruptible work: ask before quitting.
        activeTasks = true
      }
      if (activeTasks) {
        const { response } = await dialog.showMessageBox({
          type: 'warning',
          title: 'HiBuddy',
          message: '任务正在进行',
          detail: '退出 HiBuddy 会中断正在运行的任务。确定要退出吗？',
          buttons: ['取消', '退出'],
          defaultId: 0,
          cancelId: 0,
        })
        if (response === 0) { quitting = false; return }
      }
      await host.stop()
    }
  } catch (error) {
    console.error('hibuddy desktop: quit flow failed', error)
  }
  app.exit(0)
}

async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  app.on('second-instance', () => {
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  await app.whenReady()
  log(`shell starting; hostEntry=${hostEntry}; projectDir=${projectDir}`)
  createTray({
    onOpen: () => {
      if (mainWindow !== undefined && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus() }
    },
    onQuit: () => { void quitFlow() },
  })

  host = new HostProcess(process.execPath, hostEntry, projectDir, (error) => {
    // Unexpected host failure after readiness: report once and leave.
    const detail = error instanceof HostFatalError && error.diagnostic !== undefined
      ? `${error.message}\n\n${error.diagnostic}`
      : error.message
    console.error('hibuddy desktop host failure:', detail)
    void dialog.showMessageBox({
      type: 'error',
      title: 'HiBuddy',
      message: 'HiBuddy 后端已停止',
      detail: detail.slice(0, 4000),
      buttons: ['确定'],
    }).finally(() => app.exit(1))
  })

  mainWindow = createWindow()
  // Loading placeholder until the host reports its authenticated URL.
  await mainWindow.loadURL('data:text/html,<title>HiBuddy</title><body style="font-family:system-ui;background:#0b0e14;color:#8a93a6;display:grid;place-items:center;height:96vh"><div>HiBuddy 正在启动…</div></body>')
  try {
    log('spawning host')
    const ready = await host.start()
    log(`host ready: ${ready.url}`)
    allowedOrigin = new URL(ready.url).origin
    await mainWindow.loadURL(ready.url)
    log('renderer loaded host URL')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const diagnostic = error instanceof HostFatalError && error.diagnostic !== undefined ? `\n\n${error.diagnostic}` : ''
    log(`host failed to start: ${message}${diagnostic.slice(0, 2000)}`)
    console.error('hibuddy desktop host failed to start:', message, diagnostic)
    await dialog.showMessageBox({
      type: 'error',
      title: 'HiBuddy',
      message: 'HiBuddy 启动失败',
      detail: `${message}${diagnostic}`.slice(0, 4000),
      buttons: ['确定'],
    })
    app.exit(1)
  }

  app.on('window-all-closed', () => {
    // Safety net only: the window close handler owns the quit flow; if all windows
    // vanish without it (e.g. a crashed renderer), tear down as well.
    void quitFlow()
  })
}

// This file only ever loads as the Electron main entry (package.json "main");
// unlike a Node CLI there is no argv[1]-based self-execution check.
// Electron's process.argv[1] is the app path as typed (e.g. "."), not this file.
void main()
