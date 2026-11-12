/** Odoo administration policy keeps the two role surfaces separate. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  listOdooAdminCompanies, odooAdminBody, prepareOdooAdminCall, runOdooAdminCall, verifyOdooAdminCompany,
} from '../src/finance-admin-odoo.ts'

const endpoint = { url: 'https://odoo.example', database: 'synthetic_admin' }
const key = 'synthetic-odoo-admin-key'
const options = { timeoutMs: 1_000 }
const company = { id: 31, name: 'Synthetic Company', currency_id: [7, 'CNY'] }
const companyView = { id: company.id, name: company.name, currency: 'CNY' }

function respond(...bodies: readonly unknown[]) {
  const mock = vi.fn<typeof fetch>()
  for (const body of bodies) mock.mockResolvedValueOnce(Response.json(body))
  vi.stubGlobal('fetch', mock)
  return mock
}

function requests(mock: ReturnType<typeof respond>) {
  return mock.mock.calls.map(([url, init]) => {
    if (typeof init?.body !== 'string') throw new Error('Expected JSON-2 request')
    return { route: String(url).split('/json/2/')[1], body: JSON.parse(init.body) }
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('Odoo administration roles', () => {
  it('permits stock company and ledger administration while excluding access administration', () => {
    const companyCreate = prepareOdooAdminCall('ledger', {
      model: 'res.company', method: 'create', params: { vals_list: [{ name: 'New Company', currency_id: 7 }] },
    })
    expect(companyCreate).toMatchObject({ role: 'ledger', model: 'res.company', method: 'create', mutating: true })
    expect(odooAdminBody(companyCreate)).toEqual({
      vals_list: [{ name: 'New Company', currency_id: 7 }], context: { chart_template_load: true },
    })
    expect(prepareOdooAdminCall('ledger', {
      model: 'hr.department', method: 'write', params: { ids: [2], vals: { name: 'Finance', company_id: 31 } },
    })).toMatchObject({ mutating: true })
    expect(() => prepareOdooAdminCall('ledger', {
      model: 'res.users', method: 'search_read', params: {},
    })).toThrow(expect.objectContaining({ reason: 'permissions' }))
    expect(() => prepareOdooAdminCall('access', {
      model: 'res.company', method: 'write', params: { ids: [31], vals: { name: 'Replacement' } },
    })).toThrow(expect.objectContaining({ reason: 'permissions' }))
    expect(() => prepareOdooAdminCall('access', {
      model: 'account.account', method: 'search_count', params: {},
    })).toThrow(expect.objectContaining({ reason: 'permissions' }))
  })

  it.each([
    { model: 'res.users.apikeys', method: 'search_read', params: {} },
    { model: 'ir.config_parameter', method: 'get_param', params: { key: 'database.uuid' } },
    { model: 'res.users', method: 'action_reset_password', params: { ids: [3] } },
    { model: 'res.users', method: 'search_read', params: { fields: ['login', 'password'] } },
    { model: 'res.users', method: 'search_read', params: { fields: ['api_key_ids'] } },
    { model: 'res.users', method: 'search_count', params: { domain: [['password', 'ilike', '%']] } },
    { model: 'res.users', method: 'search', params: { domain: [['partner_id.user_ids.api_key_ids', '!=', false]] } },
    { model: 'res.groups', method: 'search_read', params: { order: 'name, api_key_duration desc' } },
    { model: 'res.users', method: 'fields_get', params: { allfields: ['new_password'] } },
    { model: 'res.users', method: 'create', params: { vals_list: [{ login: 'new', password: 'hidden' }] } },
    { model: 'res.groups', method: 'write', params: { ids: [4], vals: { user_ids: [[0, 0, { login: 'new', password: 'hidden' }]] } } },
  ])('rejects credentials, unsanctioned methods and indirect probes ($model/$method)', request => {
    expect(() => prepareOdooAdminCall('access', request))
      .toThrow(expect.objectContaining({ reason: expect.stringMatching(/permissions|invalid-input/) }))
  })

  it.each([
    { model: 'account.account', method: 'search_count', params: {} },
    { model: 'hr.department', method: 'write', params: { ids: [2], vals: { name: 'Finance' } } },
  ])('requires an explicit company for $model/$method', request => {
    const call = prepareOdooAdminCall('ledger', request)
    expect(() => odooAdminBody(call)).toThrow(expect.objectContaining({ reason: 'invalid-input' }))
    expect(odooAdminBody(call, company.id)).toMatchObject({ context: { allowed_company_ids: [company.id] } })
  })

  it('permits explicit membership updates and constructs the exact selected-company body', () => {
    const call = prepareOdooAdminCall('access', {
      model: 'res.users', method: 'write', params: { ids: [42], vals: {
        active: true, group_ids: [[4, 7, 0], [3, 8, 0]], company_ids: [[6, 0, [31, 32]]],
      } },
    })
    expect(odooAdminBody(call, company.id)).toEqual({
      ids: [42], vals: { active: true, group_ids: [[4, 7, 0], [3, 8, 0]], company_ids: [[6, 0, [31, 32]]] },
      context: { allowed_company_ids: [company.id] },
    })
    expect(() => odooAdminBody(call, 0)).toThrow(expect.objectContaining({ reason: 'invalid-input' }))
    for (const context of [{ allowed_company_ids: [company.id] }, { active_id: company.id }]) {
      expect(() => prepareOdooAdminCall('access', {
        model: 'res.users', method: 'search_read', params: { context },
      })).toThrow(expect.objectContaining({ reason: 'invalid-input' }))
    }
  })

  it('requests explicit user fields and removes unrelated fields returned by the server', async () => {
    const fetchMock = respond([{ id: 42, name: 'Bookkeeper', password: 'server-side-only', api_key_ids: [100] }])
    const call = prepareOdooAdminCall('access', { model: 'res.users', method: 'search_read', params: {} })
    await expect(runOdooAdminCall(endpoint, key, call, options)).resolves.toEqual([{ id: 42, name: 'Bookkeeper' }])
    expect(requests(fetchMock)).toEqual([{ route: 'res.users/search_read', body: { limit: 100, fields: ['id', 'name'] } }])
  })

  it('rejects nested record data under an otherwise allowed scalar field', async () => {
    respond([{ id: 42, name: { label: 'Bookkeeper', password: 'server-side-only' } }])
    const call = prepareOdooAdminCall('access', { model: 'res.users', method: 'search_read', params: {} })
    await expect(runOdooAdminCall(endpoint, key, call, options)).rejects.toMatchObject({
      reason: 'invalid-response', message: expect.not.stringContaining('server-side-only'),
    })
  })

  it('returns only safe metadata for authorized fields', async () => {
    const fetchMock = respond({ group_ids: { string: 'Groups', type: 'many2many', default: 'server-side-only' },
      api_key_ids: { string: 'Keys', type: 'one2many' } })
    const call = prepareOdooAdminCall('access', {
      model: 'res.users', method: 'fields_get', params: { allfields: ['group_ids'], attributes: ['string', 'type'] },
    })
    await expect(runOdooAdminCall(endpoint, key, call, options)).resolves.toEqual({ group_ids: { string: 'Groups', type: 'many2many' } })
    expect(requests(fetchMock)).toEqual([{ route: 'res.users/fields_get', body: { allfields: ['group_ids'], attributes: ['string', 'type'] } }])
  })

  it('lists companies assigned to the administrator without binding a finance ledger', async () => {
    const fetchMock = respond({ uid: 17 }, [{ ...company, unrelated: 'ignored' }], { uid: 17 }, [])
    await expect(listOdooAdminCompanies(endpoint, key, options)).resolves.toEqual([companyView])
    await expect(listOdooAdminCompanies(endpoint, key, options)).resolves.toEqual([])
    expect(requests(fetchMock)[1]).toEqual({ route: 'res.company/search_read', body: {
      domain: [['user_ids', 'in', [17]]], fields: ['id', 'name', 'currency_id'], order: 'name, id', limit: 101,
    } })
  })

  it('verifies the company used in confirmation and rechecks membership before dispatch', async () => {
    const fetchMock = respond({ uid: 17 }, [company], { uid: 17 }, [company], 2)
    await expect(verifyOdooAdminCompany(endpoint, key, company.id, options)).resolves.toEqual(companyView)
    const call = prepareOdooAdminCall('ledger', { model: 'account.account', method: 'search_count',
      params: { domain: [['company_ids', 'in', [company.id]]] } })
    await expect(runOdooAdminCall(endpoint, key, call, options, company.id)).resolves.toBe(2)
    expect(requests(fetchMock)[3]).toMatchObject({ route: 'res.company/search_read', body: {
      domain: [['user_ids', 'in', [17]], ['id', '=', company.id]],
      context: { allowed_company_ids: [company.id] },
    } })
    expect(requests(fetchMock)[4]).toEqual({ route: 'account.account/search_count', body: odooAdminBody(call, company.id) })
  })

  it('does not dispatch a scoped operation after the company becomes unavailable', async () => {
    const fetchMock = respond({ uid: 17 }, [])
    const call = prepareOdooAdminCall('ledger', {
      model: 'res.company', method: 'write', params: { ids: [company.id], vals: { name: 'Renamed Company' } },
    })
    await expect(runOdooAdminCall(endpoint, key, call, options, company.id)).rejects.toMatchObject({ reason: 'company' })
    expect(requests(fetchMock).map(request => request.route)).toEqual(['res.users/context_get', 'res.company/search_read'])
  })

  it('does not report a malformed response to a dispatched mutation as success', async () => {
    const fetchMock = respond({ detail: 'server-side-only' })
    const call = prepareOdooAdminCall('access', {
      model: 'res.users', method: 'write', params: { ids: [42], vals: { active: false } },
    })
    await expect(runOdooAdminCall(endpoint, key, call, options)).rejects.toMatchObject({
      reason: 'unknown-outcome', message: expect.not.stringContaining('server-side-only'),
    })
    expect(requests(fetchMock)).toEqual([{ route: 'res.users/write', body: odooAdminBody(call) }])
  })
})
