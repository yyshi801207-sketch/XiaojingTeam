import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { MenuItemConstructorOptions } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopTray } from '../src/desktop-tray.ts'

const native = vi.hoisted(() => ({
  trays: [] as Array<{ image: unknown; events: EventEmitter; destroy: ReturnType<typeof vi.fn> }>,
  menu: vi.fn<(items: MenuItemConstructorOptions[]) => MenuItemConstructorOptions[]>(items => items),
}))
vi.mock('electron', () => ({
  app: { getAppPath: () => '/team' },
  Menu: { buildFromTemplate: native.menu },
  nativeImage: { createFromPath: (path: string) => ({ path }) },
  Tray: class {
    readonly events = new EventEmitter()
    readonly destroy = vi.fn()
    constructor(readonly image: unknown) { native.trays.push(this) }
    on(event: string, listener: () => void) { this.events.on(event, listener) }
    setToolTip() {}
    setContextMenu() {}
  },
}))
afterEach(() => { native.trays.length = 0; vi.clearAllMocks(); vi.unstubAllGlobals() })

it('keeps one Windows tray with open and quit actions and releases it on disposal', () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  const open = vi.fn()
  const quit = vi.fn()
  const tray = new DesktopTray({
    messages: () => ({ aboutProduct: 'Team', openApplication: 'Open', quitApplication: 'Quit' }),
    showMainWindow: open, quitApplication: quit,
  })
  tray.install()
  tray.install()
  expect(native.trays).toHaveLength(1)
  expect(native.trays[0]!.image).toEqual({ path: join('/team', 'assets', 'windows-icon.png') })
  const items = native.menu.mock.lastCall![0]
  expect(items.map(item => item.label ?? item.type)).toEqual(['Open', 'separator', 'Quit'])
  expect(items[0]!.click).toBe(open)
  expect(items[2]!.click).toBe(quit)
  native.trays[0]!.events.emit('double-click')
  expect(open).toHaveBeenCalledOnce()
  tray.dispose()
  tray.dispose()
  expect(native.trays[0]!.destroy).toHaveBeenCalledOnce()
})

it('refreshes tray labels from the current locale before opening its menu', () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  let openApplication = 'Open'
  const tray = new DesktopTray({
    messages: () => ({ aboutProduct: 'Team', openApplication, quitApplication: 'Quit' }),
    showMainWindow: vi.fn(), quitApplication: vi.fn(),
  })
  tray.install()
  openApplication = '打开'
  native.trays[0]!.events.emit('right-click')
  expect(native.menu.mock.lastCall![0][0]!.label).toBe('打开')
  tray.dispose()
})

it.each(['darwin', 'linux'])('does not create a Windows tray on %s', (platform) => {
  vi.stubGlobal('process', { ...process, platform })
  const tray = new DesktopTray({
    messages: () => ({ aboutProduct: 'Team', openApplication: 'Open', quitApplication: 'Quit' }),
    showMainWindow: vi.fn(), quitApplication: vi.fn(),
  })
  tray.install()
  tray.dispose()
  expect(native.trays).toEqual([])
})
