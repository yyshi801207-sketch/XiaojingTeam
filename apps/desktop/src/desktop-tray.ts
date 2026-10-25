/** Application tray controls independent of task presentation. */

import { join } from 'node:path'
import { app, Menu, nativeImage, Tray } from 'electron'

interface DesktopTrayOptions {
  readonly messages: () => { readonly aboutProduct: string; readonly openApplication: string; readonly quitApplication: string }
  readonly showMainWindow: () => void
  readonly quitApplication: () => void
}

/** Keeps the hidden Windows application reachable without another window or state stream. */
export class DesktopTray {
  private tray: Tray | undefined

  constructor(private readonly options: DesktopTrayOptions) {}

  /** Install one tray icon with application open and quit actions. */
  install(): void {
    if (this.tray !== undefined || process.platform !== 'win32') return
    const tray = new Tray(nativeImage.createFromPath(join(app.getAppPath(), 'assets', 'windows-icon.png')))
    this.tray = tray
    const updateMenu = (): void => {
      const messages = this.options.messages()
      tray.setToolTip(messages.aboutProduct)
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: messages.openApplication, click: this.options.showMainWindow },
        { type: 'separator' },
        { label: messages.quitApplication, click: this.options.quitApplication },
      ]))
    }
    tray.on('double-click', this.options.showMainWindow)
    tray.on('right-click', updateMenu)
    updateMenu()
  }

  /** Release the native icon when the shell finishes quitting. */
  dispose(): void {
    this.tray?.destroy()
    this.tray = undefined
  }
}
