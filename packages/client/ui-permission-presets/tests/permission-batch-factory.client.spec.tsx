// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { remoteDefaultResponses } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/remote-default-responses.ts'
import { RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PermissionCatalog } from '@deepseek-ai/dsh-permission-presets/client'
import { apply, inject } from '../src/client/index.ts'

afterEach(cleanup)

const CATALOG: PermissionCatalog = {
  defaultPreset: 'workspace-write',
  defaultOptions: [{ value: 'read-only', name: 'read-only' }, { value: 'workspace-write', name: 'workspace-write' }],
  options: [
    { value: 'read-only', name: 'read-only' },
    { value: 'workspace-write', name: 'workspace-write' },
    { value: 'danger-full-access', name: 'danger-full-access' },
    { value: 'auto', name: 'auto' },
    { value: 'xiaojing-no-approval', name: 'xiaojing-no-approval' },
    { value: 'custom-mode', name: 'Team operator' },
  ],
}

async function setup(options: {
  locale?: 'en' | 'zh'
  currentValue?: string | null
  onSelect?: (preset: string) => Promise<void>
  peer?: boolean
} = {}) {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const ctx = runtime.ctx
  const locale = new LocaleRuntime(ctx)
  locale.setLocale(options.locale ?? 'zh')
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
  const command = vi.fn(async () => ({ ok: true as const, value: { matched: true } }))
  await runtime.sessions.add({ id: 'unrelated-private-session', session: { command } })
  const onSelect = vi.fn(options.onSelect ?? (async (_preset: string): Promise<void> => {}))
  type RootProps = PropsRuntime<'root'> & PropsRenderFactories & PropsRenderSlots<'settings.general.item'>
  await runtime.root.declare({
    'settings.general.item': { kind: 'list', scope: 'root' },
  }, ({ renderFactorySlot }: RootProps) => {
    const [currentValue, setCurrentValue] = useState<string | null>(options.currentValue === undefined ? 'workspace-write' : options.currentValue)
    const [locked, setLocked] = useState(false)
    const [visible, setVisible] = useState(true)
    const [targetKey, setTargetKey] = useState('group-a:worker-a,worker-b,worker-c')
    const [allowNoApproval, setAllowNoApproval] = useState(true)
    return <>
      <button type="button" onClick={() => { setCurrentValue(null) }}>Show mixed</button>
      <button type="button" onClick={() => { setCurrentValue('custom-mode') }}>Show custom</button>
      <button type="button" onClick={() => { setCurrentValue('read-only') }}>Accept read-only</button>
      <button type="button" onClick={() => { setLocked(value => !value) }}>Toggle lock</button>
      <button type="button" onClick={() => { setVisible(value => !value) }}>Toggle visibility</button>
      <button type="button" onClick={() => { setTargetKey('group-b:worker-d,worker-e,worker-f') }}>Switch targets</button>
      <button type="button" onClick={() => { setAllowNoApproval(value => !value) }}>Toggle automatic approval</button>
      <section data-testid="factory">{visible && renderFactorySlot('permission.select-batch', {
        locked, currentValue, targetKey, targetCount: 3, targetLabel: '月结讨论群', allowNoApproval, onSelect,
      })}</section>
      {options.peer && <section data-testid="peer">{renderFactorySlot('permission.select-batch', {
        locked: false, currentValue: 'custom-mode', targetKey: 'peer-group', targetCount: 1,
        targetLabel: '预算讨论群', allowNoApproval: false, onSelect,
      })}</section>}
    </>
  })
  await runtime.mount({ inject: [...settingsInject], apply: settingsApply })
  const feature = await runtime.mount({ inject: [...inject], apply })
  const view = runtime.renderRoot()
  await vi.waitFor(() => { expect(readCatalog).toHaveBeenCalledOnce() })
  onTestFinished(() => { expect(command).not.toHaveBeenCalled() })
  return {
    runtime, feature, view, onSelect, readCatalog,
    trigger: () => within(view.getByTestId('factory')).getByRole<HTMLButtonElement>('button'),
    setCatalog: async (next: PermissionCatalog) => {
      catalog = next
      await act(async () => { runtime.remote.emit('permission-presets/catalog-changed', []) })
    },
  }
}

function choose(b: Awaited<ReturnType<typeof setup>>, label: string): void {
  fireEvent.click(b.trigger())
  fireEvent.click(screen.getByRole('menuitem', { name: label }))
}

function dialogSnapshot(dialog: HTMLElement) {
  return {
    title: within(dialog).getByRole('heading').textContent,
    paragraphs: [...dialog.querySelectorAll('p')].map(node => node.textContent),
    acknowledgement: within(dialog).getByRole('checkbox').closest('label')?.textContent,
    buttons: within(dialog).getAllByRole('button').map(button => ({
      text: button.textContent || button.getAttribute('aria-label'),
      disabled: (button as HTMLButtonElement).disabled,
    })),
  }
}

describe('public batch permission Factory', () => {
  it('renders controlled uniform, mixed and host-defined labels without a Session provider', async () => {
    const b = await setup({ peer: true })
    expect(b.trigger().textContent).toBe('工作区内修改')
    expect(within(b.view.getByTestId('peer')).getByRole('button').textContent).toBe('Team operator')
    fireEvent.click(b.view.getByRole('button', { name: 'Show mixed' }))
    expect(b.trigger().textContent).toBe('各不相同')
    fireEvent.click(b.trigger())
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toContain('Team operator')
    fireEvent.pointerDown(document.body)
    fireEvent.click(b.view.getByRole('button', { name: 'Show custom' }))
    expect(b.trigger().textContent).toBe('Team operator')
    expect(b.readCatalog).toHaveBeenCalledOnce()
    expect(b.onSelect).not.toHaveBeenCalled()
  })

  it('submits each ordinary choice once and displays the controlled host value after settlement', async () => {
    const b = await setup()
    choose(b, '仅可查看')
    await act(async () => {})
    expect(b.onSelect).toHaveBeenCalledExactlyOnceWith('read-only')
    expect(b.trigger().textContent).toBe('工作区内修改')
    fireEvent.click(b.view.getByRole('button', { name: 'Accept read-only' }))
    expect(b.trigger().textContent).toBe('仅可查看')
    choose(b, '仅可查看')
    await act(async () => {})
    expect(b.onSelect).toHaveBeenCalledTimes(2)
    expect(b.onSelect).toHaveBeenLastCalledWith('read-only')
  })

  it.each([
    ['danger-full-access', '完全权限', '启用完全权限'],
    ['auto', '自动审查 EXP', '启用自动审查'],
    ['xiaojing-no-approval', '自动审批(实验性)', '启用自动审批'],
  ])('requires fresh acknowledgement for %s before invoking the owner once', async (preset, label, enableLabel) => {
    const b = await setup()
    choose(b, label)
    let dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('月结讨论群')
    expect(dialog.textContent).toContain('3')
    expect(dialog.textContent).not.toMatch(/本会话|不会影响其他会话|其他会话不受影响/u)
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: enableLabel }).disabled).toBe(true)
    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(b.onSelect).not.toHaveBeenCalled()
    choose(b, label)
    dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole<HTMLInputElement>('checkbox').checked).toBe(false)
    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(within(dialog).getByRole('button', { name: enableLabel }))
    await act(async () => {})
    expect(b.onSelect).toHaveBeenCalledExactlyOnceWith(preset)
  })

  it.each(['Switch targets', 'Toggle lock', 'Toggle visibility', 'Toggle automatic approval'])(
    'revokes an automatic-approval confirmation when the owner invokes %s', async (button) => {
      const b = await setup()
      choose(b, '自动审批(实验性)')
      fireEvent.click(screen.getByRole('checkbox'))
      fireEvent.click(b.view.getByRole('button', { name: button }))
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(b.onSelect).not.toHaveBeenCalled()
      if (button === 'Toggle visibility') {
        fireEvent.click(b.view.getByRole('button', { name: button }))
        choose(b, '自动审批(实验性)')
        expect(screen.getByRole<HTMLInputElement>('checkbox').checked).toBe(false)
      }
    },
  )

  it('withdraws a risk confirmation with its catalog option', async () => {
    const b = await setup()
    choose(b, '自动审查 EXP')
    fireEvent.click(screen.getByRole('checkbox'))
    await b.setCatalog({ ...CATALOG, options: CATALOG.options.filter(option => option.value !== 'auto') })
    await vi.waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(b.onSelect).not.toHaveBeenCalled()
  })

  it('requires a new acknowledgement after a complete catalog refresh with the same preset keys', async () => {
    const b = await setup()
    choose(b, '完全权限')
    fireEvent.click(screen.getByRole('checkbox'))
    await b.setCatalog({ ...CATALOG, options: CATALOG.options.map(option => ({ ...option })) })
    await vi.waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(b.onSelect).not.toHaveBeenCalled()
    choose(b, '完全权限')
    expect(screen.getByRole<HTMLInputElement>('checkbox').checked).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '启用完全权限' }).disabled).toBe(true)
  })

  it('omits automatic approval when the owner disallows it for Finance members', async () => {
    const b = await setup()
    fireEvent.click(b.view.getByRole('button', { name: 'Toggle automatic approval' }))
    fireEvent.click(b.trigger())
    expect(screen.queryByRole('menuitem', { name: '自动审批(实验性)' })).toBeNull()
  })

  it.each(['resolve', 'reject'] as const)('stays disabled until the owner callback %ss and then restores the controlled value', async (outcome) => {
    const pending = Promise.withResolvers<undefined>()
    const b = await setup({ onSelect: () => pending.promise })
    choose(b, '仅可查看')
    expect(b.onSelect).toHaveBeenCalledExactlyOnceWith('read-only')
    expect(b.trigger().disabled).toBe(true)
    await act(async () => {
      if (outcome === 'resolve') pending.resolve(undefined)
      else pending.reject(new Error('A member permission update failed'))
      await pending.promise.catch(() => {})
    })
    expect(b.trigger().disabled).toBe(false)
    expect(b.trigger().textContent).toBe('工作区内修改')
    expect(b.onSelect).toHaveBeenCalledTimes(1)
  })

  it.each(['zh', 'en'] as const)('renders complete %s batch automatic-approval risk copy', async (locale) => {
    const b = await setup({ locale })
    choose(b, locale === 'zh' ? '自动审批(实验性)' : 'Automatic approval (experimental)')
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('月结讨论群')
    expect(dialog.textContent).toContain('3')
    expect(dialog.textContent).not.toMatch(/本会话|不会影响其他会话|其他会话不受影响|this session|Other sessions are unaffected/iu)
    expect(dialog.textContent).toContain(locale === 'zh' ? '待审批' : 'Pending approvals')
    if (locale === 'zh') expect(dialogSnapshot(dialog)).toMatchInlineSnapshot(`
      {
        "acknowledgement": "我允许所选成员自动执行上述操作",
        "buttons": [
          {
            "disabled": false,
            "text": "关闭",
          },
          {
            "disabled": false,
            "text": "取消",
          },
          {
            "disabled": true,
            "text": "启用自动审批",
          },
        ],
        "paragraphs": [
          "将此权限应用到“月结讨论群”中 3 位成员的本群执行会话，不改变成员私聊或其他群。成员将逐个更新；后续失败或取消不会自动撤销已完成的更改。
      所选成员及其子任务的全部工具操作将自动批准，包括命令执行、文件修改与删除、网页提交和上传，当前待审批操作也会继续。可随时切回其他权限模式；浏览器连接和 Windows 提权仍受系统授权限制。",
        ],
        "title": "确认启用自动审批(实验性)？",
      }
    `)
    else expect(dialogSnapshot(dialog)).toMatchInlineSnapshot(`
      {
        "acknowledgement": "I authorize the selected members to perform these operations automatically",
        "buttons": [
          {
            "disabled": false,
            "text": "Close",
          },
          {
            "disabled": false,
            "text": "Cancel",
          },
          {
            "disabled": true,
            "text": "Enable automatic approval",
          },
        ],
        "paragraphs": [
          "Apply this permission to 3 member execution sessions in “月结讨论群”. Private chats and other groups are unchanged. Members are updated one at a time; later failure or cancellation does not automatically revert completed changes.
      Automatically approve all tool operations for the selected members and their subtasks, including commands, file changes and deletion, web submissions, and uploads. Pending approvals will proceed too. Switch back at any time; browser connections and Windows elevation remain subject to system authorization.",
        ],
        "title": "Enable automatic approval (experimental)?",
      }
    `)
  })

  it('unregisters the batch Factory and catalog listeners with the permission plugin', async () => {
    const b = await setup()
    choose(b, '完全权限')
    await b.feature.dispose()
    expect(() => b.runtime.factoryOf('permission.select-batch')).toThrow('no definition')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(b.view.getByTestId('factory').textContent).toBe('')
    const reads = b.readCatalog.mock.calls.length
    await b.setCatalog(CATALOG)
    expect(b.readCatalog).toHaveBeenCalledTimes(reads)
    expect(b.onSelect).not.toHaveBeenCalled()
  })
})
