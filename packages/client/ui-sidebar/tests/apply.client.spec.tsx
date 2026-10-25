import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
/** Sidebar shell slot registration and its Session/layout callbacks. */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { SidebarRootInjected } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { HeaderLeadingControls } from '../src/client/HeaderLeadingControls.tsx'
import * as hostPlugin from '@deepseek-ai/dsh-client-ui-sidebar'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { SIDEBAR_PRESENTATION_GLOBAL } from '../src/presentation-config.ts'

const owners = new Set<Fiber>()
afterEach(async () => {
  try {
    for (const owner of owners) await owner.dispose()
  } finally {
    owners.clear()
    vi.unstubAllGlobals()
  }
})

function SidebarFrame({ renderSlot }: PropsRenderSlots<'sidebar'>) {
  return renderSlot('sidebar', { collapsed: false, width: 300 })
}

async function bench(declare = true) {
  const root = new Context()
  let ctx: Context | undefined
  const owner = root.plugin((owned: Context) => { ctx = owned })
  owners.add(owner)
  await owner.await()
  if (ctx === undefined) throw new Error('the sidebar fixture owner did not activate')
  await ctx.plugin(SlotRegistry).await()
  const layout = { toggleSidebar: vi.fn(), selectPanel: vi.fn() }
  const uiWorkspace = { startSession: vi.fn() }
  ctx.provide('shortcuts', { catalog: createSnapshotStore([]) } as never)
  ctx.provide('layout', layout)
  ctx.provide('uiWorkspace', uiWorkspace as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const slots = ctx.get('slots') as SlotRegistry
  if (declare) {
    slots.register(
      { name: 'root', children: {
        'sidebar': { kind: 'single', scope: 'root' },
        'main': { kind: 'keyed', scope: 'root' },
        'shell.leading': { kind: 'single', scope: 'root' },
      } },
      SidebarFrame,
    )
  }
  return { ctx, slots, layout, uiWorkspace }
}

describe('ui-sidebar apply', () => {
  it('publishes only the public Host options and unregisters its bootstrap listener on disposal', async () => {
    const b = await bench()
    const config = { primaryActionLabel: { en: 'Create helper' },
      panelNavigation: { label: { en: 'More' }, defaultExpanded: false },
      footerActionsPlacement: 'after-panels' as const, unrelated: 'must stay Host-side' }
    const host = b.ctx.plugin(hostPlugin, config)
    await host.await()
    const rows: IndexInjection[] = []
    b.ctx.emit('webserver/index-inject', rows)
    expect(rows).toEqual([{ kind: 'global', name: SIDEBAR_PRESENTATION_GLOBAL, value: {
      primaryActionLabel: config.primaryActionLabel, panelNavigation: config.panelNavigation,
      footerActionsPlacement: config.footerActionsPlacement,
    } }])
    await host.dispose()
    const after: IndexInjection[] = []
    b.ctx.emit('webserver/index-inject', after)
    expect(after).toEqual([])
  })

  it('keeps the default presentation when the page has no Host bootstrap and the Client entry supplies only its name', async () => {
    const b = await bench()
    const activate: (ctx: Context, entry: { name: string }) => void = apply
    await b.ctx.plugin({ inject: [...inject], apply(ctx: Context) {
      activate(ctx, { name: 'sidebar-client-module' })
    } }).await()
    const injected = (b.slots.entries('sidebar')[0]!.inject as () => SidebarRootInjected)()
    expect(injected.hooks.presentation.getSnapshot()).toEqual({})
  })

  it.each([
    { primaryActionLabel: { zh: 'No English fallback' } },
    { panelNavigation: { label: { en: 'More' }, defaultExpanded: 'false' } },
    { footerActionsPlacement: 'elsewhere' },
  ])('rejects invalid page bootstrap before mounting sidebar effects: %j', async (payload) => {
    const b = await bench()
    vi.stubGlobal(SIDEBAR_PRESENTATION_GLOBAL, payload)
    expect(() => { apply(b.ctx) }).toThrow()
    expect(b.slots.entries('sidebar')).toEqual([])
  })

  it('declares only the services it uses', () => {
    expect(inject).toEqual(['slots', 'layout', 'uiWorkspace', 'locale', 'shortcuts'])
  })

  it('registers the shell and declares its child seats', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.slots.entries('sidebar')).toHaveLength(1)
    expect(b.slots.spec('sidebar.brand.mark')).toEqual({ kind: 'single', scope: 'root' })
    expect(b.slots.spec('sidebar.brand.name')).toEqual({ kind: 'single', scope: 'root' })
    expect(b.slots.spec('sidebar.workspaces')).toEqual({ kind: 'single', scope: 'root' })
    expect(b.slots.spec('sidebar.settings')).toEqual({ kind: 'single', scope: 'root' })
    expect(b.slots.spec('sidebar.footer.action')).toEqual({ kind: 'list', scope: 'root' })
    expect(b.slots.spec('sidebar.panellist')).toEqual({ kind: 'list', scope: 'root' })
    // Copy rides the standard locale seat, not the inject face.
    expect(b.slots.entries('sidebar')[0]!.locale).toBe('sidebar')
    // The window-chrome occupant reuses the shell's inject face and locale.
    const leading = b.slots.entries('shell.leading')
    expect(leading).toHaveLength(1)
    expect(leading[0]!.component).toBe(HeaderLeadingControls)
    expect(leading[0]!.locale).toBe('sidebar')
    expect(leading[0]!.inject).toBe(b.slots.entries('sidebar')[0]!.inject)
    const injected = (b.slots.entries('sidebar')[0]!.inject as () => SidebarRootInjected)()
    expect(Object.keys(injected)).toEqual(['startSession', 'toggleSidebar', 'selectPanel', 'hooks'])
    expect(injected.hooks.panels.getSnapshot()).toEqual([])
    expect(b.slots.entries('main')).toEqual([])
    // Both arms delegate to the Workspace UI's shared New Session action.
    injected.startSession('workspace' as never)
    expect(b.uiWorkspace.startSession).toHaveBeenCalledWith('workspace')
    injected.startSession()
    expect(b.uiWorkspace.startSession).toHaveBeenLastCalledWith(undefined)
    injected.toggleSidebar()
    expect(b.layout.toggleSidebar).toHaveBeenCalledOnce()
    const panelId = 'custom-panel' as MainPanelId
    injected.selectPanel(panelId)
    expect(b.layout.selectPanel).toHaveBeenCalledExactlyOnceWith(panelId)
    expectTypeOf<Parameters<SidebarRootInjected['selectPanel']>[0]>().toEqualTypeOf<MainPanelId>()
  })

  it('waits for the sidebar declaration before registering', async () => {
    const b = await bench(false)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('sidebar')).toHaveLength(0)
    const disposeRoot = b.slots.register({
      name: 'root',
      children: { sidebar: { kind: 'single', scope: 'root' } },
    }, SidebarFrame)
    expect(b.slots.entries('sidebar')).toHaveLength(1)
    disposeRoot()
    await fiber.dispose()
  })

  it('projects plugin-owned panel entries and removes them with their owner', async () => {
    const b = await bench()
    const sidebar = b.ctx.plugin({ inject: [...inject], apply })
    await sidebar.await()
    const injected = (b.slots.entries('sidebar')[0]!.inject as () => SidebarRootInjected)()
    const panel = b.ctx.plugin({
      inject: ['slots'],
      apply(ctx: Context) {
        ctx.slots.register({ name: 'main', key: 'custom-panel' }, () => 'Custom panel')
        ctx.slots.register({
          name: 'sidebar.panellist', id: 'custom-panel', order: 20, label: 'Custom panel',
        }, () => null)
      },
    })
    try {
      await panel.await()
      await vi.waitFor(() => {
        expect(injected.hooks.panels.getSnapshot()).toEqual([
          { id: 'custom-panel', order: 20, label: 'Custom panel' },
        ])
      })
      expect(b.slots.entries('main').map(entry => entry.options.key)).toEqual(['custom-panel'])
      await panel.dispose()
      await vi.waitFor(() => { expect(injected.hooks.panels.getSnapshot()).toEqual([]) })
      expect(b.slots.entries('main')).toEqual([])
    } finally {
      await panel.dispose()
      await sidebar.dispose()
    }
  })

  it('removes the entry and child declaration on teardown', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    expect(b.slots.entries('sidebar')).toHaveLength(0)
    expect(b.slots.entries('shell.leading')).toHaveLength(0)
    expect(b.slots.spec('sidebar.brand.mark')).toBeUndefined()
    expect(b.slots.spec('sidebar.brand.name')).toBeUndefined()
    expect(b.slots.spec('sidebar.workspaces')).toBeUndefined()
    expect(b.slots.spec('sidebar.footer.action')).toBeUndefined()
    expect(b.slots.spec('sidebar.panellist')).toBeUndefined()
    expect(b.slots.entries('main')).toHaveLength(0)
  })
})
