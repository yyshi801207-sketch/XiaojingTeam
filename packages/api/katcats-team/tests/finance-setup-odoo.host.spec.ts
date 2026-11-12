/** Odoo ledger setup requests use the approved database, company and chart. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createOdooSetupCompany, findOdooSetupCompanies, getOdooSetupChoices, importOdooSetupAccounts, initializeOdooExistingSetupCompany, initializeOdooSetupCompany,
  OdooSetupAccountConflict, verifyOdooSetupAccounts, verifyOdooSetupCandidate, verifyOdooSetupCompany, verifyOdooSetupConnection, verifyOdooSetupHandoffUser,
} from '../src/finance-setup-odoo.ts'

const endpoint = { url: 'https://test-odoo.example/odoo', database: 'test_ledger' }
const key = '1111222233334444555566667777888899990000'
const options = { timeoutMs: 1_000 }
const dbUuid = 'bbab10bb-0e5b-4e96-aeb2-9d45f4fb22cd'
const company = {
  id: 23, name: 'Test Company', country_id: [47, 'China'], currency_id: [24, 'CNY'],
  parent_id: false, child_ids: [], chart_template: 'cn', account_opening_date: '2026-02-01',
  country_code: 'CN', account_fiscal_country_id: [47, 'China'],
}
const target = {
  companyId: company.id, countryId: 47, currencyId: 24, openingDate: '2026-02-01', templateCode: 'cn',
}
const draft = { name: company.name, countryId: target.countryId, currencyId: target.currencyId, openingDate: target.openingDate }
const uid = { uid: 4 }
const cnTemplate = { name: 'China - Small Business', country_id: 47, visible: true, installed: true }
const templates = [{ account_templates: { cn: cnTemplate } }]
const ledgerCounts = [36, 6, 1, 2, true, true] as const
const scope = { allowed_company_ids: [company.id] }

function respond(...bodies: readonly unknown[]) {
  const fetchMock = vi.fn<typeof fetch>()
  for (const body of bodies) fetchMock.mockResolvedValueOnce(Response.json(body))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function requests(mock: ReturnType<typeof respond>): readonly { route: string; body: unknown }[] {
  return mock.mock.calls.map(([url, init]) => {
    if (typeof init?.body !== 'string') throw new Error('Expected JSON request body')
    return { route: String(url).split('/json/2/')[1]!, body: JSON.parse(init.body) }
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('Odoo ledger setup', () => {
  it('lists recovery candidates by saved identity without writing or adopting a name match', async () => {
    const fetchMock = respond(uid, [company, { ...company, id: 24 }])
    await expect(findOdooSetupCompanies(endpoint, key, { name: company.name, taxId: 'TEST-CN' }, options))
      .resolves.toEqual([{ id: 23, name: company.name, currency: 'CNY' }, { id: 24, name: company.name, currency: 'CNY' }])
    expect(requests(fetchMock)).toEqual([
      { route: 'res.users/context_get', body: {} },
      { route: 'res.company/search_read', body: {
        domain: [['user_ids', 'in', [4]], '|', ['name', '=', company.name], ['vat', '=', 'TEST-CN']],
        fields: ['id', 'name', 'currency_id'], context: { active_test: false }, order: 'id', limit: 101,
      } },
    ])
  })

  it.each([
    [{ ...company, name: 'Another Company' }, 'ledger-mismatch'],
    [{ ...company, country_id: [9, 'Other'] }, 'ledger-mismatch'],
    [{ ...company, currency_id: [8, 'USD'] }, 'ledger-mismatch'],
    [{ ...company, chart_template: 'other' }, 'ledger-mismatch'],
    [{ ...company, parent_id: 1 }, 'invalid-response'],
    [{ ...company, child_ids: [2] }, 'invalid-response'],
  ])('rejects mismatched selected company properties without a mutation', async (found, reason) => {
    const fetchMock = respond(uid, [found])
    await expect(verifyOdooSetupCandidate(endpoint, key, { ...target, name: company.name }, options))
      .rejects.toMatchObject({ reason })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('checks the exact tax identifier and all accounting moves before adopting an existing company', async () => {
    const fetchMock = respond(uid, [company], [{ id: company.id, vat: 'DIFFERENT' }])
    await expect(verifyOdooSetupCandidate(endpoint, key, { ...target, name: company.name, taxId: 'TEST-CN' }, options))
      .rejects.toMatchObject({ reason: 'ledger-mismatch' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const active = respond(uid, [company], 1)
    await expect(verifyOdooSetupCandidate(endpoint, key, { ...target, name: company.name }, options))
      .rejects.toMatchObject({ reason: 'ledger-mismatch' })
    expect(requests(active)[2]).toMatchObject({ route: 'account.move/search_count', body: {
      context: { ...scope, active_test: false }, domain: [['company_id', '=', company.id]],
    } })
  })

  it('refuses pre-existing accounts without the selected template', async () => {
    const fetchMock = respond(uid, [{ ...company, chart_template: false }], 0, 3)
    await expect(verifyOdooSetupCandidate(endpoint, key, { ...target, name: company.name }, options))
      .rejects.toMatchObject({ reason: 'ledger-mismatch' })
    expect(requests(fetchMock)[3]).toMatchObject({ route: 'account.account/search_count', body: { context: { ...scope, active_test: false } } })
  })

  it('sets the approved opening date on an empty existing company and initializes without creating another company', async () => {
    const empty = { ...company, chart_template: false, account_opening_date: false }
    const fetchMock = respond(uid, [empty], 0, 0, true,
      uid, [{ ...empty, account_opening_date: target.openingDate }], templates, 0, 0, null, uid, [company], ...ledgerCounts)
    await expect(initializeOdooExistingSetupCompany(endpoint, key, { ...target, name: company.name }, options))
      .resolves.toMatchObject({ company: { id: company.id }, accounts: 36 })
    expect(requests(fetchMock).filter(call => /\/(create|write|try_loading)$/.test(call.route))).toEqual([
      { route: 'res.company/write', body: { ids: [company.id], vals: { account_opening_date: target.openingDate }, context: scope } },
      { route: 'account.chart.template/try_loading', body: { template_code: 'cn', company: company.id, context: scope, install_demo: false } },
    ])
  })

  it('does not initialize a template after an unconfirmed opening-date update', async () => {
    const fetchMock = respond(uid, [{ ...company, chart_template: false, account_opening_date: false }], 0, 0, null)
    await expect(initializeOdooExistingSetupCompany(endpoint, key, { ...target, name: company.name }, options))
      .rejects.toMatchObject({ reason: 'unknown-outcome' })
    expect(requests(fetchMock).at(-1)?.route).toBe('res.company/write')
  })

  it('validates identity, settings and company creation access without requiring a company', async () => {
    const fetchMock = respond(uid, true, true, 1, dbUuid.toUpperCase())
    await expect(verifyOdooSetupConnection(endpoint, key, options)).resolves.toEqual({ userId: 4, databaseUuid: dbUuid })
    expect(requests(fetchMock)).toEqual([
      { route: 'res.users/context_get', body: {} },
      { route: 'res.users/has_group', body: { ids: [4], group_ext_id: 'base.group_system' } },
      { route: 'res.company/has_access', body: { operation: 'create' } },
      { route: 'ir.module.module/search_count', body: { domain: [['name', '=', 'account'], ['state', '=', 'installed']] } },
      { route: 'ir.config_parameter/get_param', body: { key: 'database.uuid' } },
    ])
  })

  it('refuses to verify setup credentials without the settings role', async () => {
    const fetchMock = respond(uid, false, true, 1)
    await expect(verifyOdooSetupConnection(endpoint, key, options)).rejects.toMatchObject({ reason: 'permissions' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('lists installed standard and custom templates for the chosen country', async () => {
    const fetchMock = respond([{ id: 47, code: 'CN', name: 'China' }], [{ id: 24, name: 'CNY' }], [
      ...templates,
      { account_templates: { cn_custom: { ...cnTemplate, name: 'Custom chart' }, cn_hidden: { ...cnTemplate, visible: false } } },
      { account_templates: { us: { ...cnTemplate, name: 'United States', country_id: 3 } } },
      { account_templates: { cn_uninstalled: { ...cnTemplate, installed: false } } },
      { account_templates: { generic_coa: { ...cnTemplate, name: 'Generic Chart', country_id: null } } },
      { account_templates: {} },
    ])
    await expect(getOdooSetupChoices(endpoint, key, { countryCode: 'cn', currencyCode: 'cny' }, options)).resolves.toEqual({
      country: { id: 47, code: 'CN', name: 'China' }, currency: { id: 24, code: 'CNY' },
      templates: [{ code: 'cn', name: cnTemplate.name }, { code: 'cn_custom', name: 'Custom chart' }],
    })
    expect(requests(fetchMock)[2]).toMatchObject({
      route: 'ir.module.module/search_read',
      body: { domain: [['state', '=', 'installed']], fields: ['account_templates'] },
    })
  })

  it('keeps the available Chinese charts when Odoo returns numeric visibility and empty module metadata', async () => {
    respond([{ id: 47, code: 'CN', name: 'China' }], [{ id: 24, name: 'CNY' }], [
      { account_templates: {
        cn_common: { ...cnTemplate, name: 'China - Common', visible: 0 },
        cn_hidden: { country_id: 47, installed: true, visible: 0 },
        cn_uninstalled: { country_id: 47, installed: false, visible: 1 },
        us: { country_id: 3, installed: true, visible: 1 },
        cn: { ...cnTemplate, visible: 1 },
      } },
      { account_templates: false },
      { account_templates: null },
      { account_templates: { cn_custom: { ...cnTemplate, name: 'Custom chart', visible: true } } },
    ])
    await expect(getOdooSetupChoices(endpoint, key, { countryCode: 'CN', currencyCode: 'CNY' }, options))
      .resolves.toMatchObject({ templates: [{ code: 'cn', name: cnTemplate.name }, { code: 'cn_custom', name: 'Custom chart' }] })
  })

  it('resolves RMB to the standard CNY record before querying templates', async () => {
    const fetchMock = respond([{ id: 47, code: 'CN', name: 'China' }], [{ id: 24, name: 'CNY' }], templates)
    await expect(getOdooSetupChoices(endpoint, key, { countryCode: 'CN', currencyCode: ' rmb ' }, options))
      .resolves.toMatchObject({ currency: { id: 24, code: 'CNY' } })
    expect(requests(fetchMock).filter(request => request.route === 'res.currency/search_read')).toEqual([
      expect.objectContaining({ body: expect.objectContaining({ domain: [['name', '=', 'CNY']] }) }),
    ])
  })

  it.each(['RMB', 'CNY'])('uses the legacy RMB currency for %s when the database lacks a CNY record', async currencyCode => {
    const fetchMock = respond([{ id: 47, code: 'CN', name: 'China' }], [], [{ id: 25, name: 'RMB' }], templates)
    await expect(getOdooSetupChoices(endpoint, key, { countryCode: 'CN', currencyCode }, options))
      .resolves.toMatchObject({ currency: { id: 25, code: 'RMB' } })
    expect(requests(fetchMock).filter(request => request.route === 'res.currency/search_read')).toEqual([
      expect.objectContaining({ body: expect.objectContaining({ domain: [['name', '=', 'CNY']] }) }),
      expect.objectContaining({ body: expect.objectContaining({ domain: [['name', '=', 'RMB']] }) }),
    ])
  })

  it('creates only the approved company and lets the selected chart initialize later', async () => {
    const fetchMock = respond(0, [company.id])
    await expect(createOdooSetupCompany(endpoint, key, { ...draft, taxId: 'CNTEST' }, options)).resolves.toBe(company.id)
    expect(requests(fetchMock)).toEqual([
      { route: 'res.company/search_count', body: {
        domain: ['|', ['name', '=', company.name], ['vat', '=', 'CNTEST']], context: { active_test: false },
      } },
      { route: 'res.company/create', body: {
        vals_list: [{
          name: company.name, country_id: 47, currency_id: 24, vat: 'CNTEST', parent_id: false,
          account_opening_date: '2026-02-01',
        }],
        context: { chart_template_load: true },
      } },
    ])
  })

  it('stops when the approved name or tax ID already exists', async () => {
    const fetchMock = respond(1)
    await expect(createOdooSetupCompany(endpoint, key, draft, options)).rejects.toMatchObject({ reason: 'company' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('requires reconciliation when the write has no confirmed company ID', async () => {
    const fetchMock = respond(0, null)
    await expect(createOdooSetupCompany(endpoint, key, draft, options)).rejects.toMatchObject({ reason: 'unknown-outcome' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('loads the approved chart on an empty target and checks the resulting ledger', async () => {
    const fetchMock = respond(uid, [{ ...company, chart_template: false }], templates, 0, 0, null, uid, [company], ...ledgerCounts)
    await expect(initializeOdooSetupCompany(endpoint, key, target, options)).resolves.toEqual({
      company: { id: company.id, name: company.name, currency: 'CNY' }, templateCode: 'cn',
      accounts: 36, journals: 6, taxes: 2, canCreateEntries: true,
    })
    expect(requests(fetchMock)[5]).toEqual({ route: 'account.chart.template/try_loading', body: {
      template_code: 'cn', company: company.id, context: scope, install_demo: false,
    } })
    expect(requests(fetchMock).slice(7).map(request => request.body)).toEqual(
      Array.from({ length: 7 }, () => expect.objectContaining({ context: scope })),
    )
  })

  it.each([
    [{ ...company, chart_template: 'cn_other' }, 'ledger-mismatch'],
    [{ ...company, child_ids: [24] }, 'invalid-response'],
    [{ ...company, currency_id: [25, 'USD'] }, 'ledger-mismatch'],
  ])('rejects an unexpected company or configured chart before sending a write', async (found, reason) => {
    const fetchMock = respond(uid, [found])
    await expect(initializeOdooSetupCompany(endpoint, key, target, options)).rejects.toMatchObject({ reason })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('checks the day-to-day credential membership and creation permission in the new company', async () => {
    const operator = { uid: 42 }
    const fetchMock = respond(operator, [company], [], operator, true)
    await expect(verifyOdooSetupHandoffUser(endpoint, key, { companyId: company.id, requireCreate: true }, options))
      .resolves.toBe(42)
    expect(requests(fetchMock)[1]).toMatchObject({ route: 'res.company/search_read', body: {
      domain: [['user_ids', 'in', [42]], ['id', '=', company.id]], context: scope,
    } })
    expect(requests(fetchMock)[4]).toEqual({ route: 'account.move/has_access', body: { operation: 'create', context: scope } })
  })

  it('withholds readiness when no miscellaneous journal is available', async () => {
    respond(uid, [company], 36, 6, 0, 2, true, true)
    await expect(verifyOdooSetupCompany(endpoint, key, target, options)).rejects.toMatchObject({ reason: 'ledger-unverified' })
  })

  it('reuses matching workbook rows and batches only missing accounts into the target company', async () => {
    const cash = { code: '001.01', name: 'Cash on hand', accountType: 'asset_cash', reconcile: false }
    const bank = { code: '002.01', name: 'Bank', accountType: 'asset_cash', reconcile: false }
    const toOdoo = (id: number, row: typeof cash) => ({
      id, code: row.code, name: row.name, account_type: row.accountType,
      reconcile: row.reconcile, company_ids: [company.id], active: true,
    })
    const cashRow = toOdoo(10, cash)
    const fetchMock = respond(uid, [company], 0, [cashRow], [11], [cashRow, toOdoo(11, bank)])
    await expect(importOdooSetupAccounts(endpoint, key, { companyId: company.id, rows: [cash, bank] }, options))
      .resolves.toBeUndefined()
    expect(requests(fetchMock)[4]).toEqual({ route: 'account.account/create', body: {
      vals_list: [{ code: '002.01', name: 'Bank', account_type: 'asset_cash', reconcile: false, company_ids: [[6, 0, [company.id]]] }],
      context: scope,
    } })
    expect(requests(fetchMock)[5]).toMatchObject({ route: 'account.account/search_read', body: {
      domain: [['company_ids', 'in', [company.id]], ['code', 'in', ['001.01', '002.01']]],
      context: { ...scope, active_test: false },
    } })
  })

  it('reports an existing account conflict before adding any custom rows', async () => {
    const fetchMock = respond(uid, [company], 0, [{
      id: 10, code: '001', name: 'Different name', account_type: 'asset_cash',
      reconcile: false, company_ids: [company.id], active: true,
    }])
    await expect(importOdooSetupAccounts(endpoint, key, {
      companyId: company.id, rows: [{ code: '001', name: 'Cash', accountType: 'asset_cash', reconcile: false }],
    }, options)).rejects.toBeInstanceOf(OdooSetupAccountConflict)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('rechecks custom accounts without writes and distinguishes a post-import mismatch from a replaceable conflict', async () => {
    const approved = { code: '001', name: 'Cash', accountType: 'asset_cash', reconcile: false }
    const row = { id: 10, code: '001', name: 'Cash', account_type: 'asset_cash',
      reconcile: false, company_ids: [company.id], active: true }
    const fetchMock = respond([row], [], [{ ...row, name: 'Changed after setup' }])
    const input = { companyId: company.id, rows: [approved] }
    await expect(verifyOdooSetupAccounts(endpoint, key, input, options)).resolves.toBeUndefined()
    await expect(verifyOdooSetupAccounts(endpoint, key, input, options)).rejects.toMatchObject({ reason: 'ledger-unverified' })
    const mismatch = verifyOdooSetupAccounts(endpoint, key, input, options)
    await expect(mismatch).rejects.toMatchObject({ reason: 'ledger-mismatch' })
    await expect(mismatch).rejects.not.toBeInstanceOf(OdooSetupAccountConflict)
    expect(requests(fetchMock).map(request => request.route)).toEqual(Array(3).fill('account.account/search_read'))
  })
})
