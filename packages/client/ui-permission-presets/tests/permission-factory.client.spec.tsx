// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { RemoteError, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { remoteDefaultResponses } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/remote-default-responses.ts'
import { RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject } from '../src/client/index.ts'
import { PermissionSelect } from '../src/client/PermissionSelect.tsx'
import type { PermissionCatalog } from '@deepseek-ai/dsh-permission-presets/client'

afterEach(cleanup)

const CATALOG: PermissionCatalog = {
  defaultPreset: 'workspace-write',
  defaultOptions: [{ value: 'read-only', name: 'read-only' }, { value: 'workspace-write', name: 'workspace-write' }],
  options: [
    { value: 'read-only', name: 'read-only' },
    { value: 'workspace-write', name: 'workspace-write' },
    { value: 'danger-full-access', name: 'danger-full-access' },
    { value: 'auto', name: 'auto' },
  ],
}

async function setup() {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const ctx = runtime.ctx
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  ctx.provide('connection', { generation: {
    getSnapshot: () => ({ id: 1, host: { home: '/fixture', isLoopback: true } }),
    subscribe: () => () => {},
  } } as never)
  ctx.provide('commandUi', { decorate: () => () => {}, dismiss: () => {} } as never)
  const mock = RemoteMock.create().load(remoteDefaultResponses)
  onTestFinished(() => { mock.assertNoUnmatched() })
  let catalog = CATALOG
  const readCatalog = vi.fn(async () => ({ ok: true as const, value: catalog }))
  runtime.remote.provideNamespaces({ settings: mock.remote.settings, permissionPresets: { catalog: readCatalog } })
  const calls: { id: string; line: string }[] = []
  let result: 'success' | 'rejected' | 'unmatched' = 'success'
  const command = (id: string) => async (line: string) => {
    calls.push({ id, line })
    return result === 'rejected'
      ? { ok: false as const, error: new RemoteError('gateway/internal', 'Fixture command rejected', {}) }
      : { ok: true as const, value: { matched: result !== 'unmatched' } }
  }
  const firstId = await runtime.sessions.add({ id: 'private-a', session: { command: command('private-a') } })
  const secondId = await runtime.sessions.add({ id: 'group-worker-b', session: { command: command('group-worker-b') } })
  await runtime.sessions.setProjection(firstId, 'permissions', { currentValue: 'workspace-write' })
  await runtime.sessions.setProjection(secondId, 'permissions', { currentValue: 'read-only' })
  const first = runtime.sessions.retainFor(ctx, firstId)
  const second = runtime.sessions.retainFor(ctx, secondId)
  type RootProps = PropsRuntime<'root'> & PropsRenderFactories
    & PropsRenderSlots<'conversation.input.permission' | 'settings.general.item'>
  await runtime.root.declare({
    'settings.general.item': { kind: 'list', scope: 'root' },
    'conversation.input.permission': { kind: 'single', scope: 'session' },
  }, ({ renderFactorySlot, renderSlot, SessionProvider }: RootProps) => {
    const [reference, setReference] = useState(first)
    const [locked, setLocked] = useState(false)
    return <>
      <button type="button" onClick={() => { setReference(second) }}>Switch Session</button>
      <button type="button" onClick={() => { setLocked(value => !value) }}>Toggle lock</button>
      <SessionProvider session={reference}>
        <section data-testid="factory">{renderFactorySlot('permission.select', { locked })}</section>
        <section data-testid="composer">{renderSlot('conversation.input.permission', { locked })}</section>
      </SessionProvider>
    </>
  })
  await runtime.mount({ inject: [...settingsInject], apply: settingsApply })
  const feature = await runtime.mount({ inject: [...inject], apply })
  const view = runtime.renderRoot()
  await vi.waitFor(() => { expect(readCatalog).toHaveBeenCalledOnce() })
  return {
    runtime, view, feature, calls, readCatalog, firstId, secondId,
    setResult: (next: typeof result) => { result = next },
    setCatalog: async (next: PermissionCatalog) => {
      catalog = next
      await act(async () => { runtime.remote.emit('permission-presets/catalog-changed', []) })
    },
    trigger: () => within(view.getByTestId('factory')).getByRole<HTMLButtonElement>('button', { name: /^访问模式/u }),
  }
}

describe('public current-Session permission Factory', () => {
  it('renders the original selector beside its composer entry with one shared catalog and Session projection', async () => {
    const b = await setup()
    expect(b.runtime.factoryOf('permission.select').component).toBe(PermissionSelect)
    expect(b.readCatalog).toHaveBeenCalledOnce()
    expect({ factory: b.trigger().textContent,
      composer: within(b.view.getByTestId('composer')).getByRole('button').textContent }).toMatchInlineSnapshot(`
        {
          "composer": "工作区内修改",
          "factory": "工作区内修改",
        }
      `)
    fireEvent.click(b.trigger())
    fireEvent.click(screen.getByRole('menuitem', { name: '仅可查看' }))
    await act(async () => {})
    expect(b.calls).toEqual([{ id: 'private-a', line: '/permission read-only' }])
    await b.runtime.sessions.setProjection(b.firstId, 'permissions', { currentValue: 'read-only' })
    expect(within(b.view.getByTestId('composer')).getByRole('button').textContent).toBe('仅可查看')
    expect(b.readCatalog).toHaveBeenCalledOnce()
  })

  it('keeps Full access acknowledgement and cancellation before writing only the bound Session', async () => {
    const b = await setup()
    const choose = () => {
      fireEvent.click(b.trigger())
      fireEvent.click(screen.getByRole('menuitem', { name: '完全权限' }))
    }
    choose()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '启用完全权限' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(b.calls).toEqual([])
    choose()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '启用完全权限' }))
    await act(async () => {})
    expect(b.calls).toEqual([{ id: 'private-a', line: '/permission danger-full-access' }])
  })

  it('drops a pending confirmation when the Session changes and writes the new exact scope', async () => {
    const b = await setup()
    fireEvent.click(b.trigger())
    fireEvent.click(screen.getByRole('menuitem', { name: '完全权限' }))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(b.view.getByRole('button', { name: 'Switch Session' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(b.trigger().textContent).toBe('仅可查看')
    fireEvent.click(b.trigger())
    fireEvent.click(screen.getByRole('menuitem', { name: '工作区内修改' }))
    await act(async () => {})
    expect(b.calls).toEqual([{ id: 'group-worker-b', line: '/permission workspace-write' }])
  })

  it('revokes Auto confirmation when the shared process catalog withdraws the option', async () => {
    const b = await setup()
    fireEvent.click(b.trigger())
    fireEvent.click(screen.getByRole('menuitem', { name: '自动审查 EXP' }))
    fireEvent.click(screen.getByRole('checkbox'))
    await b.setCatalog({ ...CATALOG, options: CATALOG.options.filter(option => option.value !== 'auto') })
    await vi.waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(b.calls).toEqual([])
    expect(b.trigger().textContent).toBe('工作区内修改')
  })

  it.each(['rejected', 'unmatched'] as const)('clears optimistic selection after a %s command without changing another Session', async (result) => {
    const b = await setup()
    b.setResult(result)
    fireEvent.click(b.trigger())
    fireEvent.click(screen.getByRole('menuitem', { name: '仅可查看' }))
    await act(async () => {})
    expect(b.trigger().textContent).toBe('工作区内修改')
    expect(b.trigger().disabled).toBe(false)
    expect(b.calls).toEqual([{ id: 'private-a', line: '/permission read-only' }])
  })

  it('closes risk confirmation when locked and removes the control when its capability disappears', async () => {
    const b = await setup()
    fireEvent.click(b.trigger())
    fireEvent.click(screen.getByRole('menuitem', { name: '完全权限' }))
    fireEvent.click(b.view.getByRole('button', { name: 'Toggle lock' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(b.trigger().disabled).toBe(true)
    await b.runtime.sessions.setProjection(b.firstId, 'permissions', undefined)
    expect(b.view.getByTestId('factory').textContent).toBe('')
    expect(b.calls).toEqual([])
  })

  it('unregisters the Factory and catalog listeners with the original plugin lifetime', async () => {
    const b = await setup()
    await b.feature.dispose()
    expect(() => b.runtime.factoryOf('permission.select')).toThrow('no definition')
    expect(b.view.getByTestId('factory').textContent).toBe('')
    const calls = b.readCatalog.mock.calls.length
    await b.setCatalog(CATALOG)
    expect(b.readCatalog).toHaveBeenCalledTimes(calls)
  })
})
