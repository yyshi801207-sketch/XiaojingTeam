// @vitest-environment jsdom
/** Ledger provisioning review and credential separation in the connector page. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { LedgerSetupPlan, LedgerSetupPlanId, LedgerSetupSnapshot } from '../src/finance-setup-types.ts'
import { FinanceLedgerSetup, type FinanceSetupActions } from '../src/client/FinanceLedgerSetup.tsx'
import { LedgerSetupDatabaseSettings, type LedgerSetupDatabaseControls } from '../src/client/LedgerSetupDatabaseSettings.tsx'
import { financeEn } from '../src/client/finance-locales.ts'

const t = makeTranslate(financeEn)
const connection = { url: 'https://odoo.example.com', database: 'team', verifiedAt: '2026-11-11T05:00:00Z' }
const plan: LedgerSetupPlan = {
  id: brandString<LedgerSetupPlanId>('plan-123'), revision: 1, name: 'Example Trading',
  countryCode: 'CN', currencyCode: 'CNY', templateCode: 'cn', templateName: 'China - Small Enterprise',
  openingDate: '2026-01-01', mode: 'odoo-template', status: 'draft', createdAt: '2026-11-11T05:15:00Z', customAccountCount: 0,
}
const ready: LedgerSetupPlan = { ...plan, status: 'ready', company: { id: 7, name: plan.name, currency: 'CNY' } }

function openSetup(initial: LedgerSetupSnapshot) {
  const execute = vi.fn<FinanceSetupActions['execute']>().mockResolvedValue({ ok: true, value: initial })
  const uploadChart = vi.fn<FinanceSetupActions['uploadChart']>().mockResolvedValue({ ok: true, value: initial })
  const addConnector = vi.fn<FinanceSetupActions['addConnector']>().mockResolvedValue({ ok: true, value: initial })
  const recoveryCompanies = vi.fn<FinanceSetupActions['recoveryCompanies']>().mockResolvedValue({ ok: true, value: [] })
  const reconcile = vi.fn<FinanceSetupActions['reconcile']>().mockResolvedValue({ ok: true, value: initial })
  const actions = { execute, uploadChart, addConnector, recoveryCompanies, reconcile, reload: vi.fn() }
  const component = (snapshot: LedgerSetupSnapshot) => <FinanceLedgerSetup t={t} view={{ kind: 'ready', revision: 1, snapshot }} actions={actions} />
  const view = render(component(initial))
  return { ...actions, replace: (snapshot: LedgerSetupSnapshot) => view.rerender(component(snapshot)) }
}

function openDatabaseSettings() {
  const connect = vi.fn<LedgerSetupDatabaseControls['connect']>()
  const controls = { t, connect, reload: vi.fn() }
  render(<LedgerSetupDatabaseSettings controls={controls} enabled
    view={{ kind: 'ready', revision: 1, snapshot: { connection, plans: [] } }} />)
  const region = screen.getByRole('region', { name: financeEn['setup.connection'] })
  const summary = region.querySelector('summary')!
  expect(summary.parentElement).toHaveProperty('open', false)
  expect(within(summary).getByText(financeEn['setup.connected'])).toBeTruthy()
  fireEvent.click(summary)
  expect(summary.parentElement).toHaveProperty('open', true)
  return { card: within(region), connect, summary }
}

afterEach(cleanup)

describe('administration Bot database settings', () => {
  it('reconnects using the saved settings and shows the new verification time', async () => {
    const { card, connect, summary } = openDatabaseSettings()
    const pending = Promise.withResolvers<Awaited<ReturnType<LedgerSetupDatabaseControls['connect']>>>()
    connect.mockReturnValueOnce(pending.promise)
    const reconnect = card.getByRole('button', { name: financeEn['setup.reconnect'] })
    const edit = card.getByRole('button', { name: financeEn.edit })
    expect(reconnect.textContent).toBe('')
    expect(reconnect.querySelector('svg')).toBeTruthy()
    fireEvent.click(reconnect)
    expect(reconnect).toHaveProperty('disabled', true)
    expect(edit).toHaveProperty('disabled', true)
    expect(card.getByText(financeEn['setup.connecting'])).toBeTruthy()
    expect(card.queryByLabelText(financeEn['setup.adminKey'])).toBeNull()
    fireEvent.click(reconnect)
    expect(connect).toHaveBeenCalledExactlyOnceWith({ url: connection.url, database: connection.database })

    const verifiedAt = '2026-11-11T05:20:00Z'
    await act(async () => { pending.resolve({ ok: true, value: { connection: { ...connection, verifiedAt }, plans: [] } }) })
    expect(card.getByText(financeEn['setup.connected'])).toBeTruthy()
    expect(card.getByText(financeEn.lastTest).nextElementSibling?.querySelector('time')?.dateTime).toBe(verifiedAt)
    expect(reconnect).toHaveProperty('disabled', false)
    expect(edit).toHaveProperty('disabled', false)
    fireEvent.click(summary)
    expect(summary.parentElement).toHaveProperty('open', false)
    expect(within(summary).getByText(financeEn['setup.connected'])).toBeTruthy()
  })

  it('reports a failed reconnect and keeps the saved database available to retry', async () => {
    const { card, connect } = openDatabaseSettings()
    connect.mockResolvedValueOnce({ ok: false, key: 'error.network' })
    const reconnect = card.getByRole('button', { name: financeEn['setup.reconnect'] })
    await act(async () => { fireEvent.click(reconnect) })
    expect(card.getByText(financeEn['setup.reconnectFailed'])).toBeTruthy()
    expect(card.getByRole('alert').textContent).toBe(financeEn['error.network'])
    expect(card.getByText(connection.url)).toBeTruthy()
    expect(card.getByText(connection.database)).toBeTruthy()
    expect(card.getByText(financeEn.lastTest).nextElementSibling?.querySelector('time')?.dateTime).toBe(connection.verifiedAt)
    expect(reconnect).toHaveProperty('disabled', false)
  })

  it('shows a saved-key placeholder only while editing the same database and address', () => {
    const { card } = openDatabaseSettings()
    fireEvent.click(card.getByRole('button', { name: financeEn.edit }))
    const key = card.getByLabelText(financeEn['setup.adminKey'])
    expect(key).toHaveProperty('value', '')
    expect(key).toHaveProperty('placeholder', financeEn['editor.keySaved'])
    fireEvent.change(card.getByLabelText(financeEn['connection.address']), { target: { value: 'https://other.example.com' } })
    expect(key).toHaveProperty('value', '')
    expect(key).not.toHaveProperty('placeholder', financeEn['editor.keySaved'])
    expect(card.getByRole('button', { name: financeEn['setup.connect'] })).toHaveProperty('disabled', true)
  })
})

describe('ledger setup panel', () => {
  it('requires an explicit company selection before associating an uncertain creation outcome', async () => {
    const uncertain = { ...plan, status: 'uncertain' as const }
    const actions = openSetup({ connection, plans: [uncertain] })
    actions.recoveryCompanies.mockResolvedValueOnce({ ok: true, value: [{ id: 7, name: plan.name, currency: 'CNY' }] })
    fireEvent.click(screen.getByRole('button', { name: financeEn['setup.recover'] }))
    const modal = within(screen.getByRole('dialog'))
    const confirm = modal.getByRole('button', { name: financeEn['setup.recoverConfirm'] })
    expect(confirm).toHaveProperty('disabled', true)
    await act(async () => { fireEvent.click(modal.getByRole('button', { name: financeEn['setup.recoverLookup'] })) })
    expect(actions.recoveryCompanies).toHaveBeenCalledExactlyOnceWith(plan.id, plan.revision)
    expect(confirm).toHaveProperty('disabled', true)
    expect(actions.execute).not.toHaveBeenCalled()
    expect(actions.reconcile).not.toHaveBeenCalled()
    fireEvent.click(modal.getByRole('radio'))
    await act(async () => { fireEvent.click(confirm) })
    expect(actions.reconcile).toHaveBeenCalledExactlyOnceWith(plan.id, plan.revision, 7)
    expect(actions.execute).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps the captured uncertain revision and exposes stale or empty recovery outcomes', async () => {
    const actions = openSetup({ connection, plans: [{ ...plan, status: 'uncertain' }] })
    fireEvent.click(screen.getByRole('button', { name: financeEn['setup.recover'] }))
    const modal = within(screen.getByRole('dialog'))
    await act(async () => { fireEvent.click(modal.getByRole('button', { name: financeEn['setup.recoverLookup'] })) })
    expect(modal.getByRole('status').textContent).toBe(financeEn['setup.recoverEmpty'])
    actions.recoveryCompanies.mockResolvedValueOnce({ ok: true, value: [{ id: 7, name: plan.name, currency: 'CNY' }] })
    await act(async () => { fireEvent.click(modal.getByRole('button', { name: financeEn['setup.recoverLookup'] })) })
    fireEvent.click(modal.getByRole('radio'))
    actions.replace({ connection, plans: [{ ...plan, revision: 2, status: 'blocked', companyId: 7 }] })
    actions.reconcile.mockResolvedValueOnce({ ok: false, key: 'error.in-use' })
    await act(async () => { fireEvent.click(modal.getByRole('button', { name: financeEn['setup.recoverConfirm'] })) })
    expect(actions.reconcile).toHaveBeenCalledExactlyOnceWith(plan.id, 1, 7)
    expect(modal.getByRole('alert').textContent).toBe(financeEn['setup.error.planChanged'])
  })

  it('directs database setup to the Bot settings while keeping the global task list', () => {
    openSetup({ connection: null, plans: [plan] })
    expect(screen.getByText(financeEn['setup.connectionInBot'])).toBeTruthy()
    expect(screen.getByText(plan.name, { selector: 'h3' })).toBeTruthy()
    expect(screen.getByRole('button', { name: financeEn['setup.approve'] })).toHaveProperty('disabled', true)
    expect(screen.queryByRole('button', { name: financeEn['setup.connect'] })).toBeNull()
    expect(screen.queryByLabelText(financeEn['editor.key'])).toBeNull()
  })

  it('executes the standard plan revision the owner reviewed', async () => {
    const view = openSetup({ connection, plans: [plan] })
    fireEvent.click(screen.getByRole('button', { name: financeEn['setup.approve'] }))
    const approval = within(screen.getByRole('dialog', { name: financeEn['setup.executeTitle'] }))
    expect(approval.getByText(plan.templateName)).toBeTruthy()
    view.replace({ connection, plans: [{ ...plan, revision: 2, templateName: 'A different template' }] })
    expect(approval.getByText(plan.templateName)).toBeTruthy()
    await act(async () => fireEvent.click(approval.getByRole('button', { name: financeEn['setup.approve'] })))
    expect(view.execute).toHaveBeenCalledExactlyOnceWith(plan.id, 1)
  })

  it('validates an Excel chart before permitting setup and sends its filename and reviewed revision', async () => {
    const custom: LedgerSetupPlan = { ...plan, mode: 'custom-chart' }
    const view = openSetup({ connection, plans: [custom] })
    const button = screen.getByRole('button', { name: financeEn['setup.approve'] })
    expect(button).toHaveProperty('disabled', true)
    expect(screen.getByText(financeEn['setup.source.custom'])).toBeTruthy()
    const file = new File(['workbook'], 'accounts.xlsx')
    fireEvent.change(screen.getByLabelText(financeEn['setup.upload']), { target: { files: [file] } })
    await vi.waitFor(() => expect(view.uploadChart).toHaveBeenCalledExactlyOnceWith(plan.id, 1, file.name, 'd29ya2Jvb2s='))
    view.replace({ connection, plans: [{ ...custom, revision: 2, customAccountCount: 4,
      customChart: { name: file.name, sha256: 'a'.repeat(64) } }] })
    expect(screen.getByText(file.name)).toBeTruthy()
    expect(button).toHaveProperty('disabled', false)
  })

  it('only allows workbook replacement on a blocked plan when the Host marks it editable', () => {
    const blocked: LedgerSetupPlan = { ...plan, status: 'blocked', mode: 'custom-chart', failure: 'ledger-mismatch' }
    const view = openSetup({ connection, plans: [blocked] })
    expect(screen.queryByRole('button', { name: financeEn['setup.upload'] })).toBeNull()
    view.replace({ connection, plans: [{ ...blocked, customChartEditable: true }] })
    expect(screen.getByRole('button', { name: financeEn['setup.upload'] })).toHaveProperty('disabled', false)
  })

  it('adds a verified ledger to connectors using a dedicated accounting key and access mode', async () => {
    const view = openSetup({ connection, plans: [ready] })
    const finished: LedgerSetupSnapshot = { connection, plans: [{ ...ready, status: 'handed-off' }] }
    view.addConnector.mockResolvedValueOnce({ ok: true, value: finished })
    fireEvent.click(screen.getByRole('button', { name: financeEn['setup.addConnector'] }))
    const form = within(screen.getByRole('dialog', { name: financeEn['setup.addConnector'] }))
    const submit = form.getByRole('button', { name: financeEn['setup.addConnector'] })
    expect(submit).toHaveProperty('disabled', true)
    expect(form.queryByRole('button', { name: /group/i })).toBeNull()
    expect(form.getByRole('button', { name: financeEn.scope }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.change(form.getByLabelText(financeEn['setup.dailyKey']), { target: { value: 'bookkeeping-key' } })
    fireEvent.click(form.getByRole('button', { name: financeEn['scope.full'] }))
    await act(async () => fireEvent.click(submit))
    expect(view.addConnector).toHaveBeenCalledExactlyOnceWith(plan.id, { apiKey: 'bookkeeping-key', accessMode: 'full' })
    expect(screen.queryByRole('dialog')).toBeNull()
    view.replace(finished)
    expect(screen.getByText(financeEn['setup.status.handed-off'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: financeEn['setup.addConnector'] })).toBeNull()
  })

  it('keeps the add form open when the accounting account lacks access', async () => {
    const view = openSetup({ connection, plans: [ready] })
    view.addConnector.mockResolvedValueOnce({ ok: false, key: 'error.permissions' })
    fireEvent.click(screen.getByRole('button', { name: financeEn['setup.addConnector'] }))
    const form = within(screen.getByRole('dialog', { name: financeEn['setup.addConnector'] }))
    const key = form.getByLabelText(financeEn['setup.dailyKey'])
    fireEvent.change(key, { target: { value: 'bookkeeping-key' } })
    const submit = form.getByRole('button', { name: financeEn['setup.addConnector'] })
    await act(async () => fireEvent.click(submit))
    expect(form.getByRole('alert').textContent).toBe(financeEn['setup.error.connectorPermissions'])
    expect(key).toHaveProperty('value', 'bookkeeping-key')
    expect(submit).toHaveProperty('disabled', false)
  })

  it('keeps an uncertain create outcome visible without an execution or connector action', () => {
    openSetup({ connection, plans: [{ ...plan, status: 'uncertain', failure: 'unknown-outcome' }] })
    expect(screen.getByText(financeEn['setup.status.uncertain'])).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe(financeEn['error.unknown-outcome'])
    expect(screen.queryByRole('button', { name: financeEn['setup.approve'] })).toBeNull()
    expect(screen.queryByRole('button', { name: financeEn['setup.retryPlan'] })).toBeNull()
    expect(screen.queryByRole('button', { name: financeEn['setup.addConnector'] })).toBeNull()
  })
})
