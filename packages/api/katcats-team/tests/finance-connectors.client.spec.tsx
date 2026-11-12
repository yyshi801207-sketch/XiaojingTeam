/** Finance connector form and Host-generation isolation. */
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ComponentProps } from 'react'
import { Context } from '@deepseek-ai/cordis'
import type { ConnectionGeneration } from '@deepseek-ai/dsh-client-connection/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { FinanceConnector, FinanceConnectorId, FinanceConnectorSnapshot } from '../src/finance-types.ts'
import type { LedgerSetupPlan, LedgerSetupPlanId, LedgerSetupSnapshot } from '../src/finance-setup-types.ts'
import { FinanceConnectorsPage, type FinanceCatalog, type FinancePageInjected } from '../src/client/FinanceConnectorsPage.tsx'
import { financeEn } from '../src/client/finance-locales.ts'
import { installFinancePage, type FinanceRemote, type FinanceSetupRemote } from '../src/client/finance-page.tsx'

const connector: FinanceConnector = {
  id: 'finance-test' as FinanceConnectorId, type: 'odoo', name: 'Finance test',
  url: 'https://odoo.example.com', database: 'test_ledger',
  company: { id: 7, name: 'Example Holdings', currency: 'CNY' },
  lastTestAt: '2026-11-10T08:00:00Z', failure: null, capabilities: ['accounts'],
}

function openCatalog(connectors: readonly FinanceConnector[] = []) {
  const catalog = createSnapshotStore<FinanceCatalog>({ kind: 'ready', revision: 1, connectors })
  const secondCompany = { id: 8, name: 'Example Trading', currency: 'USD' }
  const discover = vi.fn<FinancePageInjected['discover']>().mockResolvedValue({ ok: true, value: [connector.company, secondCompany] })
  const save = vi.fn<FinancePageInjected['save']>().mockResolvedValue({ ok: true, value: connector })
  const test = vi.fn<FinancePageInjected['test']>().mockResolvedValue({ ok: true, value: connector })
  const props = {
    t: makeTranslate(financeEn),
    useFinanceCatalog: bindSnapshotSelector(catalog),
    useFinanceSetup: () => ({ kind: 'disabled' }),
    setup: null,
    reload: vi.fn(),
    test,
    remove: vi.fn(),
    discover,
    save,
  } as ComponentProps<typeof FinanceConnectorsPage>
  render(<FinanceConnectorsPage {...props} />)
  return { catalog, discover, save, test }
}

function connectionSummary(name = connector.name): HTMLElement {
  const summary = screen.getByText(name).closest('summary')
  if (summary === null) throw new Error('Missing connector disclosure')
  return summary
}

async function expandConnection() {
  fireEvent.click(connectionSummary())
  return screen.findByRole('button', { name: financeEn.edit })
}

afterEach(cleanup)

describe('finance connector page', () => {
  it('requires a discovered company before saving and clears the API key after success', async () => {
    const { discover, save } = openCatalog()
    fireEvent.click(screen.getByRole('button', { name: financeEn.add }))
    fireEvent.change(screen.getByLabelText(financeEn['editor.name']), { target: { value: connector.name } })
    fireEvent.change(screen.getByPlaceholderText(financeEn['editor.addressPlaceholder']), { target: { value: connector.url } })
    fireEvent.change(screen.getByLabelText(financeEn.database), { target: { value: connector.database } })
    fireEvent.change(screen.getByLabelText(financeEn['editor.key']), { target: { value: 'test-secret' } })
    const submit = screen.getByRole('button', { name: financeEn['editor.save'] })
    expect(submit).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: financeEn['editor.find'] }))
    const selection = await screen.findByRole('button', { name: financeEn['editor.select'] })
    expect(discover).toHaveBeenCalledExactlyOnceWith({ url: connector.url, database: connector.database, apiKey: 'test-secret' })
    fireEvent.click(selection)
    fireEvent.click(screen.getByRole('menuitem', { name: connector.company.name }))
    await act(async () => fireEvent.click(submit))
    expect(save).toHaveBeenCalledExactlyOnceWith({
      name: connector.name, url: connector.url, database: connector.database, apiKey: 'test-secret', companyId: connector.company.id,
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: financeEn.add }))
    expect(screen.getByLabelText(financeEn['editor.key'])).toHaveProperty('value', '')
  })

  it('starts with compact independent connection rows and reveals their management actions', async () => {
    const other = { ...connector, id: 'other-finance-test' as FinanceConnectorId, name: 'Second connection' }
    const { test } = openCatalog([connector, other])
    const summary = connectionSummary()
    expect(summary.parentElement).toHaveProperty('open', false)
    expect(connectionSummary(other.name).parentElement).toHaveProperty('open', false)
    expect(summary.textContent).toBe(connector.name + financeEn['status.ready'])
    expect(screen.queryByText(financeEn.database)).toBeNull()
    expect(screen.queryByRole('button', { name: financeEn.edit })).toBeNull()

    await expandConnection()
    expect(summary.parentElement).toHaveProperty('open', true)
    expect(connectionSummary(other.name).parentElement).toHaveProperty('open', false)
    expect(screen.getByText(financeEn.database)).toBeTruthy()
    expect(summary.querySelector('button')).toBeNull()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: financeEn.test })))
    expect(test).toHaveBeenCalledExactlyOnceWith(connector.id)
    fireEvent.click(screen.getByRole('button', { name: financeEn['remove.short'] }))
    expect(screen.getByRole('dialog', { name: financeEn.remove })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: financeEn['editor.cancel'] }))

    fireEvent.click(summary)
    await waitFor(() => { expect(screen.queryByRole('button', { name: financeEn.edit })).toBeNull() })
    expect(summary.parentElement).toHaveProperty('open', false)
  })

  it('can explicitly switch a saved connection to full ORM operations using its existing key', async () => {
    const { save } = openCatalog([connector])
    fireEvent.click(await expandConnection())
    const readOnly = screen.getByRole('button', { name: financeEn.scope })
    const full = screen.getByRole('button', { name: financeEn['scope.full'] })
    expect(readOnly.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(full)
    expect(full.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText(financeEn['editor.fullHint'])).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: financeEn['editor.save'] })))
    expect(save).toHaveBeenCalledExactlyOnceWith({ id: connector.id, url: connector.url, database: connector.database,
      name: connector.name, companyId: connector.company.id, accessMode: 'full' })
  })

  it('verifies and saves a new address using the saved key and company', async () => {
    const { discover, save } = openCatalog([connector])
    const url = 'https://direct.example.com'
    fireEvent.click(await expandConnection())
    fireEvent.change(screen.getByLabelText(financeEn.address), { target: { value: url } })

    expect(screen.getByLabelText(financeEn['editor.key'])).toHaveProperty('value', '')
    expect(screen.getByText(financeEn['editor.keyExisting'])).toBeTruthy()
    const submit = screen.getByRole('button', { name: financeEn['editor.save'] })
    expect(submit).toHaveProperty('disabled', false)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: financeEn['editor.find'] })))
    expect(discover).toHaveBeenCalledExactlyOnceWith({ id: connector.id, url, database: connector.database })
    await act(async () => fireEvent.click(submit))
    expect(save).toHaveBeenCalledExactlyOnceWith({ id: connector.id, url, database: connector.database,
      name: connector.name, companyId: connector.company.id })
  })

  it('shows a rejected save beside the action buttons and preserves the address edit', async () => {
    const { save } = openCatalog([connector])
    save.mockResolvedValueOnce({ ok: false, key: 'error.ledger-unverified' })
    fireEvent.click(await expandConnection())
    const address = screen.getByLabelText(financeEn.address)
    const url = 'https://direct.example.com'
    fireEvent.change(address, { target: { value: url } })
    const submit = screen.getByRole('button', { name: financeEn['editor.save'] })
    await act(async () => fireEvent.click(submit))

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe(financeEn['error.ledger-unverified'])
    expect(alert.closest('form')).toBeNull()
    expect(submit.getAttribute('aria-describedby')).toBe(alert.id)
    expect(address).toHaveProperty('value', url)
    expect(screen.getByLabelText(financeEn['editor.key'])).toHaveProperty('value', '')
    expect(submit).toHaveProperty('disabled', false)
  })

  it('shows a company lookup error next to the verification button', async () => {
    const { discover } = openCatalog([connector])
    discover.mockResolvedValueOnce({ ok: false, key: 'error.network' })
    fireEvent.click(await expandConnection())
    const find = screen.getByRole('button', { name: financeEn['editor.find'] })
    await act(async () => fireEvent.click(find))

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe(financeEn['error.network'])
    expect(alert.closest('fieldset')).toBe(find.closest('fieldset'))
    expect(find.getAttribute('aria-describedby')).toBe(alert.id)
  })

  it('requires a new key and company lookup after changing the database', async () => {
    openCatalog([connector])
    fireEvent.click(await expandConnection())
    const database = screen.getByLabelText(financeEn.database)
    fireEvent.change(database, { target: { value: 'other_ledger' } })
    const find = screen.getByRole('button', { name: financeEn['editor.find'] })
    const submit = screen.getByRole('button', { name: financeEn['editor.save'] })
    expect(screen.queryByText(financeEn['editor.keyExisting'])).toBeNull()
    expect(find).toHaveProperty('disabled', true)
    expect(submit).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText(financeEn['editor.key']), { target: { value: 'replacement-key' } })
    expect(find).toHaveProperty('disabled', false)
    expect(submit).toHaveProperty('disabled', true)
  })

  it('shows the connection mode alongside the Odoo login without duplicating it in the heading', async () => {
    const { catalog } = openCatalog([connector])
    await expandConnection()
    const accountValue = () => screen.getByText(financeEn['connection.login']).nextElementSibling
    expect(accountValue()?.querySelector('bdi')?.textContent).toBe(financeEn['odoo.notVerified'])
    expect(accountValue()?.querySelector('small')?.textContent).toBe(financeEn['odoo.readOnly'])
    const account = { login: 'bookkeeper@example.com' }
    act(() => { catalog.set({ kind: 'ready', revision: 1, connectors: [{ ...connector, account, accessMode: 'full' }] }) })
    expect(accountValue()?.querySelector('bdi')?.textContent).toBe(account.login)
    expect(accountValue()?.querySelector('small')?.textContent).toBe(financeEn['odoo.readWrite'])
    expect(screen.queryByText('Verified permissions')).toBeNull()
    expect(connectionSummary().textContent).not.toContain(financeEn['odoo.readWrite'])
  })

  it('shows the latest access in the expanded header and keeps the verification date in the footer', async () => {
    const checkedAt = '2026-11-10T13:06:00Z'
    const unavailable: FinanceConnector = { ...connector, accessHealth: { outcome: 'unreachable', checkedAt } }
    const { catalog } = openCatalog([unavailable])
    expect(screen.getByText(financeEn['status.unreachable']).getAttribute('data-tone')).toBe('warning')
    expect(screen.queryByText(financeEn['status.ready'])).toBeNull()
    expect(screen.queryByText(financeEn.lastAccess)).toBeNull()
    await expandConnection()
    const verification = screen.getByText(financeEn.lastTest)
    const access = screen.getByText(financeEn.lastAccess)
    expect(verification.parentElement).toBe(verification.parentElement?.parentElement?.lastElementChild)
    expect(access.closest('summary')).toBe(connectionSummary())
    expect(verification.nextElementSibling?.querySelector('time')?.dateTime).toBe(connector.lastTestAt)
    expect(access.parentElement?.querySelector('time')?.dateTime).toBe(checkedAt)

    const recoveredAt = '2026-11-10T13:16:00Z'
    const restored: FinanceConnector = { ...connector, accessHealth: { outcome: 'reachable', checkedAt: recoveredAt } }
    act(() => { catalog.set({ kind: 'ready', revision: 1, connectors: [restored] }) })
    expect(screen.getByText(financeEn['status.reachable']).getAttribute('data-tone')).toBe('success')
    expect(screen.getByText(financeEn.lastAccess).parentElement?.querySelector('time')?.dateTime).toBe(recoveredAt)
  })

  it('drops a credential form when the active catalog is replaced', async () => {
    const { catalog, discover } = openCatalog([connector])
    expect(screen.getByText(financeEn['status.ready'])).toBeTruthy()
    fireEvent.click(await expandConnection())
    fireEvent.change(screen.getByLabelText(financeEn['editor.key']), { target: { value: 'old-host-secret' } })
    act(() => { catalog.set({ kind: 'ready', revision: 2, connectors: [connector] }) })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(await expandConnection())
    expect(screen.getByLabelText(financeEn['editor.key'])).toHaveProperty('value', '')
    expect(discover).not.toHaveBeenCalled()
  })
})

it('shows the sidebar only for the active finance-enabled Host and positions it after plugins', async () => {
  const ctx = new Context()
  const generation = createSnapshotStore<ConnectionGeneration | undefined>({ id: 1, host: { home: '/fake' } })
  const first = Promise.withResolvers<FinanceConnectorSnapshot | null>()
  const changed = Promise.withResolvers<FinanceConnectorSnapshot | null>()
  const followFinance = vi.fn<FinanceRemote['followFinance']>()
    .mockImplementationOnce(async function* () { yield await first.promise })
    .mockImplementationOnce(async function* () { yield null })
    .mockImplementationOnce(async function* (signal) {
      yield { connectors: [connector] }
      yield await changed.promise
      if (signal === undefined || signal.aborted) return
      await new Promise<void>(resolve => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    })
    .mockImplementation(async function* () { yield null })
  const entries = new Set<{ name: string; order?: number }>()
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('slots', {
    inject: (_name: string, register: () => () => void) => ctx.effect(register),
    register: (entry: { name: string; order?: number }) => {
      entries.add(entry)
      return () => { entries.delete(entry) }
    },
  } as never)
  const connect = (id: number): void => { generation.set({ id, host: { home: '/fake' } }) }

  try {
    const { catalog } = installFinancePage(ctx, {
      financeSnapshot: vi.fn(), followFinance,
      discoverFinanceCompanies: vi.fn(), saveFinanceConnector: vi.fn(),
      testFinanceConnector: vi.fn(), deleteFinanceConnector: vi.fn(),
    }, generation)
    connect(2)
    first.resolve({ connectors: [connector] })
    await first.promise
    expect(entries.size).toBe(0)
    connect(3)
    await vi.waitFor(() => {
      expect([...entries].find(entry => entry.name === 'sidebar.panellist')?.order).toBe(5)
    })
    const before = catalog.getSnapshot()
    if (before.kind !== 'ready') throw new Error('Missing enabled catalog')
    const unreachable: FinanceConnector = { ...connector, accessHealth: { outcome: 'unreachable', checkedAt: '2026-11-10T13:06:00Z' } }
    changed.resolve({ connectors: [unreachable] })
    await vi.waitFor(() => { expect(catalog.getSnapshot()).toEqual({ ...before, connectors: [unreachable] }) })
    connect(4)
    await vi.waitFor(() => { expect(entries.size).toBe(0) })
  } finally {
    await ctx.fiber.dispose()
  }
})

it('reopens the setup stream for each Host and fences stale snapshots and save replies', async () => {
  const ctx = new Context()
  const generation = createSnapshotStore<ConnectionGeneration | undefined>({ id: 1, host: { home: '/old' } })
  const old: LedgerSetupSnapshot = { connection: { url: 'https://old.example.com', database: 'old', verifiedAt: connector.lastTestAt }, plans: [] }
  const current: LedgerSetupSnapshot = { connection: { url: 'https://new.example.com', database: 'new', verifiedAt: connector.lastTestAt }, plans: [] }
  const staleFrame = Promise.withResolvers<LedgerSetupSnapshot>()
  const staleReply = Promise.withResolvers<RemoteResult<LedgerSetupSnapshot>>()
  const active = (signal: AbortSignal | undefined): Promise<void> => signal === undefined || signal.aborted
    ? Promise.resolve() : new Promise(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }) })
  const follow = vi.fn<FinanceSetupRemote['follow']>()
    .mockImplementationOnce(async function* () { yield old; yield await staleFrame.promise })
    .mockImplementationOnce(async function* (signal) { yield current; await active(signal) })
    .mockImplementation(async function* () { throw new RemoteError('gateway/service-unavailable', 'setup unavailable', { endpoint: 'xiaojingLedgerSetup/follow' }) })
  const saveConnection = vi.fn<FinanceSetupRemote['saveConnection']>().mockReturnValue(staleReply.promise)
  let face: FinancePageInjected | undefined
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('slots', {
    inject: (_name: string, register: () => () => void) => ctx.effect(register),
    register: (entry: { name: string; inject?: () => FinancePageInjected }) => {
      if (entry.name === 'main') face = entry.inject?.()
      return () => {}
    },
  } as never)
  try {
    const setup = installFinancePage(ctx, {
      financeSnapshot: vi.fn(),
      followFinance: async function* (signal) { yield { connectors: [connector] }; await active(signal) },
      discoverFinanceCompanies: vi.fn(), saveFinanceConnector: vi.fn(),
      testFinanceConnector: vi.fn(), deleteFinanceConnector: vi.fn(),
    }, generation, { follow, saveConnection, execute: vi.fn(), uploadChart: vi.fn(), addConnector: vi.fn(), recoveryCompanies: vi.fn(), reconcile: vi.fn() })
    const read = () => face?.hooks.financeSetup.getSnapshot()
    await vi.waitFor(() => { expect(read()).toMatchObject({ kind: 'ready', snapshot: old }) })
    const pending = setup.setupDatabase?.connect({ url: old.connection!.url, database: 'old', apiKey: 'old-secret' })
    expect(saveConnection).toHaveBeenCalledOnce()
    generation.set({ id: 2, host: { home: '/new' } })
    await vi.waitFor(() => { expect(read()).toMatchObject({ kind: 'ready', snapshot: current }) })
    staleFrame.resolve(old)
    staleReply.resolve({ ok: true, value: old })
    await expect(pending).resolves.toEqual({ ok: false, key: 'error.outcome' })
    expect(read()).toMatchObject({ kind: 'ready', snapshot: current })
    generation.set({ id: 3, host: { home: '/older' } })
    await vi.waitFor(() => {
      expect(follow).toHaveBeenCalledTimes(3)
      expect(read()).toEqual({ kind: 'disabled' })
      expect(face?.hooks.financeCatalog.getSnapshot()).toMatchObject({ kind: 'ready' })
    })
  } finally {
    staleFrame.resolve(old)
    staleReply.resolve({ ok: true, value: old })
    await ctx.fiber.dispose()
  }
})

it('updates available ledgers from the finance stream after registering a verified ledger', async () => {
  const ctx = new Context()
  const generation = createSnapshotStore<ConnectionGeneration | undefined>({ id: 1, host: { home: '/team' } })
  const connection = { url: connector.url, database: connector.database, verifiedAt: connector.lastTestAt }
  const ready: LedgerSetupPlan = {
    id: 'plan-123' as LedgerSetupPlanId, revision: 1, name: connector.company.name,
    countryCode: 'CN', currencyCode: 'CNY', templateCode: 'cn', templateName: 'China',
    openingDate: '2026-01-01', mode: 'odoo-template', status: 'ready', createdAt: connector.lastTestAt,
    customAccountCount: 0, company: connector.company,
  }
  const added: LedgerSetupSnapshot = { connection, plans: [{ ...ready, status: 'handed-off' }] }
  const catalogChanged = Promise.withResolvers<FinanceConnectorSnapshot>()
  const stop = (signal?: AbortSignal): Promise<void> => signal === undefined || signal.aborted
    ? Promise.resolve() : new Promise(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }) })
  const addConnector = vi.fn<FinanceSetupRemote['addConnector']>()
    .mockResolvedValueOnce({ ok: true, value: { connection, plans: [ready] } })
    .mockImplementationOnce(async () => {
      catalogChanged.resolve({ connectors: [connector] })
      return { ok: true, value: added }
    })
  let face: FinancePageInjected | undefined
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('slots', {
    inject: (_name: string, register: () => () => void) => ctx.effect(register),
    register: (entry: { name: string; inject?: () => FinancePageInjected }) => {
      if (entry.name === 'main') face = entry.inject?.()
      return () => {}
    },
  } as never)
  try {
    const { catalog, setupView } = installFinancePage(ctx, {
      financeSnapshot: vi.fn(),
      followFinance: async function* (signal) { yield { connectors: [] }; yield await catalogChanged.promise; await stop(signal) },
      discoverFinanceCompanies: vi.fn(), saveFinanceConnector: vi.fn(),
      testFinanceConnector: vi.fn(), deleteFinanceConnector: vi.fn(),
    }, generation, {
      follow: async function* (signal) { yield { connection, plans: [ready] }; await stop(signal) },
      saveConnection: vi.fn(), execute: vi.fn(), uploadChart: vi.fn(), addConnector, recoveryCompanies: vi.fn(), reconcile: vi.fn(),
    })
    await vi.waitFor(() => { expect(setupView.getSnapshot()).toMatchObject({ kind: 'ready' }) })
    const input = { accessMode: 'read-only', apiKey: 'bookkeeping-key' } as const
    await expect(face?.setup?.addConnector(ready.id, input)).resolves.toEqual({ ok: false, key: 'setup.error.connectorUnverified' })
    expect(face?.hooks.financeNotice.getSnapshot()).toBeNull()
    await expect(face?.setup?.addConnector(ready.id, input)).resolves.toEqual({ ok: true, value: added })
    expect(addConnector).toHaveBeenLastCalledWith(ready.id, input)
    expect(face?.hooks.financeNotice.getSnapshot()).toMatchObject({ key: 'setup.addConnectorDone', success: true })
    await vi.waitFor(() => { expect(catalog.getSnapshot()).toMatchObject({ kind: 'ready', connectors: [connector] }) })
  } finally {
    catalogChanged.resolve({ connectors: [] })
    await ctx.fiber.dispose()
  }
})
