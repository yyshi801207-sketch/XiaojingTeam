/** Restricted Xiaojing application metadata and workspace opener. */

import { contextBridge, ipcRenderer } from 'electron'
import { XIAOJING_DESKTOP_IPC } from './ipc.ts'

/** Expose application metadata only in the application document. */
export function exposeXiaojingDesktopBridge(): void {
  contextBridge.exposeInMainWorld('xiaojingDesktop', {
    getApplicationInfo: () => ipcRenderer.invoke(XIAOJING_DESKTOP_IPC.applicationInfo) as Promise<{ version: string }>,
  })
}

/** Expose the Xiaojing workspace opener only in the application document. */
export function exposeXiaojingOpenPath(): void {
  contextBridge.exposeInMainWorld('__DSH_OPEN_IN_APP__', {
    openPath: (path: string) => ipcRenderer.invoke(XIAOJING_DESKTOP_IPC.openPath, path) as Promise<void>,
  })
}
