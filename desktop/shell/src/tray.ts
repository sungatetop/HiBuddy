/** HiBuddy tray (Windows-resident): Open/Quit, mirroring dsh's minimal tray. */

import { Menu, Tray, nativeImage } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface TrayActions {
  readonly onOpen: () => void
  readonly onQuit: () => void
}

export function createTray(actions: TrayActions): Tray {
  const here = dirname(fileURLToPath(import.meta.url))
  const icon = nativeImage.createFromPath(join(here, '../assets/hibuddy.png'))
  const tray = new Tray(icon)
  tray.setToolTip('HiBuddy')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 HiBuddy', click: actions.onOpen },
    { type: 'separator' },
    { label: '退出', click: actions.onQuit },
  ]))
  tray.on('click', actions.onOpen)
  return tray
}
