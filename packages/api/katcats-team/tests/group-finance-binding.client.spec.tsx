// @vitest-environment jsdom
/** Group ledger settings show only verified alternatives and retain the committed selection on failure. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { brandString } from '@deepseek-ai/dsh-brand'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ChatId } from '../src/chats-types.ts'
import type { BotId } from '../src/types.ts'
import type { FinanceConnector, FinanceConnectorId } from '../src/finance-types.ts'
import { FinanceBinding } from '../src/client/FinanceBinding.tsx'
import type { FinanceCatalog } from '../src/client/FinanceConnectorsPage.tsx'
import { zh } from '../src/client/locales.ts'

beforeEach(() => { vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: false })) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const chatId = brandString<ChatId>('test-group')
const verified: FinanceConnector = { id: brandString<FinanceConnectorId>('verified-connector'), type: 'odoo',
  name: 'Odoo 测试', url: 'https://odoo.example', database: 'fixture', company: { id: 1, name: '测试账套', currency: 'CNY' },
  lastTestAt: '2026-11-10T00:00:00Z', failure: null, capabilities: ['journals'] }
const connectFixture = async () => verified

async function expandFinanceBinding(): Promise<void> {
  const card = screen.getByRole('region', { name: '财务连接' })
  const disclosure = card.querySelector('summary')
  if (disclosure === null) throw new Error('Missing finance disclosure')
  fireEvent.click(disclosure)
  await waitFor(() => { expect(disclosure.nextElementSibling).not.toBeNull() })
}

it('supports parent-controlled expansion and preserves an uncommitted ledger selection', async () => {
  const onOpenChange = vi.fn()
  const bind = vi.fn(async () => {})
  const actions = { load: async () => ({ connectors: [verified], connectorId: verified.id }), bind, connect: connectFixture }
  const props = { ownerId: chatId, scope: 'group' as const, active: true, busy: false, actions, t: makeTranslate(zh) }
  const { rerender } = render(<FinanceBinding {...props} disclosure={{ open: false, onOpenChange }} />)
  await screen.findByText('上次验证通过')
  const card = screen.getByRole('region', { name: '财务连接' })
  const details = card.querySelector('details')!
  fireEvent.click(details.querySelector('summary')!)
  expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(true)
  expect(details.open).toBe(false)
  rerender(<FinanceBinding {...props} disclosure={{ open: true, onOpenChange }} />)
  fireEvent.click(screen.getByRole('button', { name: '更换或解绑' }))
  fireEvent.click(screen.getByRole('button', { name: '选择账套' }))
  fireEvent.click(screen.getByText('未绑定'))
  rerender(<FinanceBinding {...props} disclosure={{ open: false, onOpenChange }} />)
  expect(screen.queryByRole('button', { name: '选择账套' })).toBeNull()
  rerender(<FinanceBinding {...props} disclosure={{ open: true, onOpenChange }} />)
  expect(screen.getByRole('button', { name: '选择账套' }).textContent).toContain('未绑定')
  fireEvent.click(screen.getByRole('button', { name: '保存绑定' }))
  await waitFor(() => { expect(bind).toHaveBeenCalledExactlyOnceWith(chatId, null) })
})

it('retains the selected company until the owner’s binding change is confirmed', async () => {
  const unverified: FinanceConnector = { ...verified, id: brandString<FinanceConnectorId>('unverified-connector'),
    name: '未验证连接', failure: 'network' }
  const bind = vi.fn(async () => {}).mockRejectedValueOnce(new Error('Unavailable'))
  render(<FinanceBinding ownerId={chatId} scope="group" active busy={false} t={makeTranslate(zh)}
    actions={{ load: async () => ({ connectors: [verified, unverified], connectorId: verified.id }), bind, connect: connectFixture }} />)
  expect((await screen.findByText('上次验证通过')).getAttribute('data-tone')).toBe('neutral')
  await expandFinanceBinding()
  expect(screen.getByRole('img', { name: 'Odoo' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '选择账套' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '更换或解绑' }))
  fireEvent.click(screen.getByRole('button', { name: '选择账套' }))
  expect(screen.queryByRole('menuitem', { name: /未验证连接/ })).toBeNull()
  fireEvent.click(screen.getByText('未绑定'))
  fireEvent.click(screen.getByRole('button', { name: '保存绑定' }))
  await screen.findByRole('alert')
  expect(screen.getByText('上次验证通过')).toBeTruthy()
  expect(bind).toHaveBeenCalledExactlyOnceWith(chatId, null)
  fireEvent.click(screen.getByRole('button', { name: '保存绑定' }))
  expect(await screen.findByText('绑定已保存。')).toBeTruthy()
  expect(screen.getByText('未绑定账套')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '连接' })).toBeNull()
  expect(screen.getByRole('region', { name: '财务连接' }).getAttribute('data-finance-state')).toBe('unbound')
  expect(screen.queryByText('最近验证')).toBeNull()
  expect(screen.queryByRole('img', { name: 'Odoo' })).toBeNull()
  const chooser = screen.getByRole('button', { name: '选择账套' })
  expect(screen.getByText(zh['chat.financeHint']).id).toBe(chooser.getAttribute('aria-describedby'))
})

it.each(['group', 'bot'] as const)('shows the login and access mode for a %s ledger binding', async scope => {
  const ownerId = scope === 'group' ? chatId : brandString<BotId>('test-bot')
  const catalog = createSnapshotStore<FinanceCatalog>({ kind: 'ready', revision: 1, connectors: [verified] })
  render(<FinanceBinding ownerId={ownerId} scope={scope} active busy={false} t={makeTranslate(zh)}
    actions={{ catalog, load: async () => ({ connectors: [verified], connectorId: verified.id }),
      bind: vi.fn(async () => {}), connect: connectFixture }} />)
  await expandFinanceBinding()
  const login = await screen.findByText(zh['odoo.login'])
  expect(login.nextElementSibling?.querySelector('bdi')?.textContent).toBe(zh['odoo.notVerified'])
  expect(login.nextElementSibling?.querySelector('small')?.textContent).toBe(zh['odoo.readOnly'])

  const account = { login: 'bookkeeper@example.com' }
  act(() => { catalog.set({ kind: 'ready', revision: 1, connectors: [
    { ...verified, name: verified.company.name, account, accessMode: 'full' },
  ] }) })
  expect(login.nextElementSibling?.querySelector('bdi')?.textContent).toBe(account.login)
  expect(login.nextElementSibling?.querySelector('small')?.textContent).toBe(zh['odoo.readWrite'])
  expect(screen.getAllByText(verified.company.name)).toHaveLength(1)
  expect(screen.getByText(verified.company.currency)).toBeTruthy()
  expect(screen.queryByText('已验证权限')).toBeNull()

  const hint = zh[scope === 'bot' ? 'bot.financeHint' : 'chat.financeHint']
  expect(screen.queryByText(hint)).toBeNull()
  const edit = screen.getByRole('button', { name: zh['chat.financeEditBinding'] })
  expect(edit.textContent).toBe('')
  expect(edit.querySelector('svg')).toBeTruthy()
  fireEvent.click(edit)
  expect(screen.getByRole('button', { name: zh['chat.financeCancelEdit'] })).toBe(edit)
  const chooser = screen.getByRole('button', { name: zh['chat.financeSelect'] })
  const picker = document.getElementById(edit.getAttribute('aria-controls') ?? '')
  expect(picker?.contains(chooser)).toBe(true)
  expect(edit.parentElement?.parentElement).toBe(picker?.parentElement)
  expect(chooser.textContent).toBe(verified.company.name)
  expect(chooser.hasAttribute('aria-describedby')).toBe(false)
  expect(screen.queryByText(hint)).toBeNull()
})

it('shows the recorded verification time when a bound ledger needs retesting', async () => {
  const failed: FinanceConnector = { ...verified, failure: 'network', lastTestAt: '2026-11-11T01:30:00Z' }
  render(<FinanceBinding ownerId={chatId} scope="group" active busy={false} t={makeTranslate(zh)}
    actions={{ load: async () => ({ connectors: [failed], connectorId: failed.id }), bind: vi.fn(async () => {}), connect: connectFixture }} />)

  expect((await screen.findByText('待重新验证')).getAttribute('data-tone')).toBe('warning')
  await expandFinanceBinding()
  expect(screen.queryByText('上次验证通过')).toBeNull()
  expect(screen.getByText('测试账套')).toBeTruthy()
  expect(screen.getByText('最近验证').parentElement?.querySelector('time')?.dateTime).toBe(failed.lastTestAt)
})

it('shows the last access failure separately from the successful verification', async () => {
  const checkedAt = '2026-11-10T13:06:00Z'
  const catalog = createSnapshotStore<FinanceCatalog>({ kind: 'ready', revision: 1, connectors: [verified] })
  render(<FinanceBinding ownerId={chatId} scope="group" active busy={false} t={makeTranslate(zh)}
    actions={{ catalog, load: async () => ({ connectors: [verified], connectorId: verified.id }), bind: vi.fn(async () => {}), connect: connectFixture }} />)
  expect(await screen.findByText('上次验证通过')).toBeTruthy()
  await expandFinanceBinding()
  fireEvent.click(screen.getByRole('button', { name: '更换或解绑' }))

  const unreachable: FinanceConnector = { ...verified, accessHealth: { outcome: 'unreachable', checkedAt } }
  act(() => { catalog.set({ kind: 'ready', revision: 1, connectors: [unreachable] }) })
  expect(screen.getByText('最近访问失败').getAttribute('data-tone')).toBe('warning')
  expect(screen.getByRole('region', { name: '财务连接' }).getAttribute('data-finance-state')).toBe('unreachable')
  expect(screen.queryByText('上次验证通过')).toBeNull()
  const verification = screen.getByText('最近验证')
  const access = screen.getByText('最近访问')
  expect(verification.parentElement).toBe(access.parentElement)
  expect(verification.parentElement).toBe(verification.parentElement?.parentElement?.lastElementChild)
  expect(verification.nextElementSibling?.querySelector('time')?.dateTime).toBe(verified.lastTestAt)
  expect(access.nextElementSibling?.querySelector('time')?.dateTime).toBe(checkedAt)
  expect(access.nextElementSibling?.textContent).toContain('失败')
  expect(screen.getByRole('button', { name: '取消更改' })).toBeTruthy()

  const reachable: FinanceConnector = { ...verified, failure: 'network', lastTestAt: checkedAt,
    accessHealth: { outcome: 'reachable', checkedAt: '2026-11-10T13:15:00Z' } }
  act(() => { catalog.set({ kind: 'ready', revision: 1, connectors: [reachable] }) })
  expect(screen.getByText('已连接').getAttribute('data-tone')).toBe('success')
  expect(screen.getByText('最近验证').nextElementSibling?.textContent).toContain('未通过')
})

it.each(['group', 'bot'] as const)('keeps the connected %s access color across disclosure and clears it on lost access', async scope => {
  const ownerId = scope === 'group' ? chatId : brandString<BotId>('test-bot')
  const checkedAt = '2026-11-10T13:06:00Z'
  const reachable: FinanceConnector = { ...verified, accessHealth: { outcome: 'reachable', checkedAt } }
  const pending = Promise.withResolvers<FinanceConnector>()
  const connect = vi.fn(() => pending.promise)
  const catalog = createSnapshotStore<FinanceCatalog>({ kind: 'ready', revision: 1, connectors: [reachable] })
  const actions = { catalog, load: async () => ({ connectors: [reachable], connectorId: reachable.id }), bind: vi.fn(async () => {}), connect }
  const t = makeTranslate(zh)
  const { rerender } = render(<FinanceBinding ownerId={ownerId} scope={scope} active busy={false} actions={actions} t={t} />)
  await screen.findByText('已连接')
  const card = screen.getByRole('region', { name: '财务连接' })
  const disclosure = card.querySelector('summary')
  if (disclosure === null) throw new Error('Missing finance disclosure')
  expect(card.getAttribute('data-finance-state')).toBe('reachable')
  expect(card.hasAttribute('data-finance-access')).toBe(false)
  expect(within(disclosure).queryByRole('button')).toBeNull()
  expect(disclosure.parentElement).toHaveProperty('open', false)
  expect(within(card).queryByRole('button', { name: '更换或解绑' })).toBeNull()
  await expandFinanceBinding()
  expect(within(card).getByRole('button', { name: '更换或解绑' })).toBeTruthy()
  const reconnect = within(card).getByRole('button', { name: zh['chat.financeReconnect'] })
  expect(reconnect.textContent).toBe('')
  expect(reconnect.querySelector('svg')).toBeTruthy()
  fireEvent.click(reconnect)
  expect(connect).toHaveBeenCalledExactlyOnceWith(ownerId, reachable.id)
  expect(within(card).getByRole('button', { name: zh['chat.financeConnecting'] })).toHaveProperty('disabled', true)
  await act(async () => { pending.resolve(reachable) })

  const writeEnabled: FinanceConnector = { ...reachable, accessMode: 'full' }
  act(() => { catalog.set({ kind: 'ready', revision: 1, connectors: [writeEnabled] }) })
  expect(card.getAttribute('data-finance-access')).toBe('full')
  fireEvent.click(disclosure)
  await waitFor(() => { expect(within(card).queryByRole('button', { name: '更换或解绑' })).toBeNull() })
  expect(within(disclosure).getByText('已连接')).toBeTruthy()
  expect(card.getAttribute('data-finance-access')).toBe('full')

  act(() => { catalog.set({ kind: 'ready', revision: 1, connectors: [
    { ...writeEnabled, accessHealth: { outcome: 'unreachable', checkedAt } },
  ] }) })
  expect(card.getAttribute('data-finance-state')).toBe('unreachable')
  expect(card.hasAttribute('data-finance-access')).toBe(false)
  act(() => { catalog.set({ kind: 'ready', revision: 1, connectors: [writeEnabled] }) })
  rerender(<FinanceBinding ownerId={ownerId} scope={scope} active={false} busy={false} actions={actions} t={t} />)
  expect(card.getAttribute('data-finance-state')).toBe('ready')
  expect(card.hasAttribute('data-finance-access')).toBe(false)
  expect(within(disclosure).getByText('最近访问成功')).toBeTruthy()
})

it('checks the bound connector, keeps a failed check retryable, and only turns green after confirmation', async () => {
  const pending = Promise.withResolvers<FinanceConnector>()
  const failedAt = '2026-11-10T13:06:00Z'
  const recoveredAt = '2026-11-10T13:07:00Z'
  const failure: FinanceConnector = { ...verified, failure: 'network', lastTestAt: failedAt,
    accessHealth: { checkedAt: failedAt, outcome: 'unreachable' } }
  const confirmed: FinanceConnector = { ...verified, lastTestAt: recoveredAt,
    accessHealth: { checkedAt: recoveredAt, outcome: 'reachable' } }
  const connect = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(confirmed)
  render(<FinanceBinding ownerId={chatId} scope="group" active busy={false} t={makeTranslate(zh)}
    actions={{ load: async () => ({ connectors: [verified], connectorId: verified.id }), bind: vi.fn(async () => {}), connect }} />)
  const card = screen.getByRole('region', { name: '财务连接' })
  await expandFinanceBinding()
  fireEvent.click(await screen.findByRole('button', { name: '连接' }))
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '正在连接…' }).disabled).toBe(true)
  expect(card.getAttribute('data-finance-state')).toBe('ready')
  expect(connect).toHaveBeenCalledExactlyOnceWith(chatId, verified.id)

  await act(async () => { pending.resolve(failure) })
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', zh['chat.financeConnectNetwork'])
  expect(card.getAttribute('data-finance-state')).toBe('unreachable')
  fireEvent.click(screen.getByRole('button', { name: '连接' }))
  expect(await screen.findByText('已连接')).toBeTruthy()
  expect(card.getAttribute('data-finance-state')).toBe('reachable')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: '重新连接' })).toBeTruthy()
})

it('keeps a newer shared access observation when an older connect response arrives', async () => {
  const pending = Promise.withResolvers<FinanceConnector>()
  const catalog = createSnapshotStore<FinanceCatalog>({ kind: 'ready', revision: 1, connectors: [verified] })
  const connect = vi.fn(() => pending.promise)
  render(<FinanceBinding ownerId={chatId} scope="group" active busy={false} t={makeTranslate(zh)}
    actions={{ catalog, load: async () => ({ connectors: [verified], connectorId: verified.id }), bind: vi.fn(async () => {}), connect }} />)
  await expandFinanceBinding()
  fireEvent.click(await screen.findByRole('button', { name: '连接' }))
  const latest: FinanceConnector = { ...verified, accessHealth: { checkedAt: '2026-11-10T13:07:00Z', outcome: 'unreachable' } }
  act(() => { catalog.set({ kind: 'ready', revision: 1, connectors: [latest] }) })
  const checkedAt = '2026-11-10T13:06:00Z'
  await act(async () => {
    pending.resolve({ ...verified, lastTestAt: checkedAt, accessHealth: { checkedAt, outcome: 'reachable' } })
  })
  expect(screen.getByText('最近访问失败')).toBeTruthy()
  expect(screen.queryByText('已连接')).toBeNull()
  expect(screen.getByText('最近访问').nextElementSibling?.querySelector('time')?.dateTime).toBe(latest.accessHealth?.checkedAt)
})

it('discards a pending connection result after changing the owner', async () => {
  const pending = Promise.withResolvers<FinanceConnector>()
  const other = brandString<ChatId>('other-group')
  const otherConnector: FinanceConnector = { ...verified, id: brandString<FinanceConnectorId>('other'), company: { ...verified.company, name: '另一个账套' } }
  const connect = vi.fn(() => pending.promise)
  const t = makeTranslate(zh)
  const actions = { connect, bind: vi.fn(async () => {}), load: async (owner: ChatId) => ({
    connectors: [owner === chatId ? verified : otherConnector], connectorId: owner === chatId ? verified.id : otherConnector.id,
  }) }
  const { rerender } = render(<FinanceBinding ownerId={chatId} scope="group" active busy={false} actions={actions} t={t} />)
  await expandFinanceBinding()
  fireEvent.click(await screen.findByRole('button', { name: '连接' }))
  rerender(<FinanceBinding ownerId={other} scope="group" active busy={false} actions={actions} t={t} />)
  expect(await screen.findByText('另一个账套')).toBeTruthy()
  const checkedAt = '2026-11-10T13:06:00Z'
  await act(async () => {
    pending.resolve({ ...verified, lastTestAt: checkedAt, accessHealth: { checkedAt, outcome: 'reachable' } })
  })
  expect(screen.queryByText('已连接')).toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '连接' }).disabled).toBe(false)
})

it('collapses the chooser after binding and after switching the company', async () => {
  const second: FinanceConnector = { ...verified, id: brandString<FinanceConnectorId>('second-connector'),
    name: 'Odoo 二号', company: { ...verified.company, id: 2, name: '第二账套' } }
  const bind = vi.fn(async () => {})
  render(<FinanceBinding ownerId={chatId} scope="group" active busy={false} t={makeTranslate(zh)}
    actions={{ load: async () => ({ connectors: [verified, second], connectorId: null }), bind, connect: connectFixture }} />)

  await expandFinanceBinding()
  fireEvent.click(await screen.findByRole('button', { name: '选择账套' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Odoo 测试 · 测试账套' }))
  fireEvent.click(screen.getByRole('button', { name: '保存绑定' }))
  await screen.findByRole('button', { name: '更换或解绑' })
  expect(screen.queryByRole('button', { name: '选择账套' })).toBeNull()
  expect(screen.getByText('测试账套')).toBeTruthy()
  expect(bind).toHaveBeenCalledExactlyOnceWith(chatId, verified.id)

  fireEvent.click(screen.getByRole('button', { name: '更换或解绑' }))
  fireEvent.click(screen.getByRole('button', { name: '选择账套' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Odoo 二号 · 第二账套' }))
  fireEvent.click(screen.getByRole('button', { name: '取消更改' }))
  expect(screen.queryByRole('button', { name: '选择账套' })).toBeNull()
  expect(screen.getByText('测试账套')).toBeTruthy()
  expect(bind).toHaveBeenCalledTimes(1)

  fireEvent.click(screen.getByRole('button', { name: '更换或解绑' }))
  const chooser = screen.getByRole('button', { name: '选择账套' })
  expect(chooser.textContent).toBe('Odoo 测试 · 测试账套')
  fireEvent.click(chooser)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Odoo 二号 · 第二账套' }))
  fireEvent.click(screen.getByRole('button', { name: '保存绑定' }))
  await screen.findByRole('button', { name: '更换或解绑' })
  expect(screen.queryByRole('button', { name: '选择账套' })).toBeNull()
  expect(screen.getByText('第二账套')).toBeTruthy()
  expect(bind).toHaveBeenLastCalledWith(chatId, second.id)
})
