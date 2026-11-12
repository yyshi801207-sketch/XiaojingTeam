/** Odoo JSON-2 request, accounting scope and error behavior. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverOdooCompanies, financeOdooAccountSchema, normalizeFinanceEndpoint, prepareOdooOrmCall, runOdooExport, runOdooOrmCall, runOdooQuery, verifyOdooCompany, verifyOdooConnector } from '../src/finance-odoo.ts'

const endpoint = { url: 'http://127.0.0.1:18069/odoo/', database: 'test_ledger' }
const key = '1111222233334444555566667777888899990000'
const company = { id: 7, name: 'Test Company', currency: 'CNY' }
const options = { timeoutMs: 1_000 }
const entries = { kind: 'entries', from: '2026-02-01', to: '2026-02-28', state: 'posted' } as const
const draftMove = {
  move_type: 'entry', journal_id: 5, date: '2026-02-11', ref: 'Synthetic reference',
  line_ids: [[0, 0, { account_id: 3, debit: 100.25 }], [0, 0, { account_id: 8, credit: 100.25 }]],
}

function entry(id: number) {
  return {
    id, move_id: [4, 'MISC/001'], date: '2026-02-11', parent_state: 'posted', account_id: [3, '1001 Cash'],
    name: 'Test line', debit: 100.25, credit: 0, company_id: [7, 'Test Company'],
  }
}

function respond(...bodies: readonly unknown[]) {
  const fetchMock = vi.fn<typeof fetch>()
  for (const body of bodies) fetchMock.mockResolvedValueOnce(Response.json(body))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function requestBody(fetchMock: ReturnType<typeof respond>, index: number): unknown {
  const body = fetchMock.mock.calls[index]?.[1]?.body
  if (typeof body !== 'string') throw new Error('Expected a JSON request body')
  return JSON.parse(body)
}

afterEach(() => vi.unstubAllGlobals())

describe('Odoo 19 JSON-2 connector', () => {
  it('calls a public ORM route using only the bound company and connector', async () => {
    const fetchMock = respond([{ id: 15, name: 'Synthetic contact' }])
    const request = prepareOdooOrmCall({ model: 'res.partner', method: 'search_read',
      params: { fields: ['id', 'name'], domain: [['active', '=', true]] } })
    await expect(runOdooOrmCall(endpoint, key, company, request, options)).resolves.toEqual([{ id: 15, name: 'Synthetic contact' }])
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:18069/odoo/json/2/res.partner/search_read')
    expect(requestBody(fetchMock, 0)).toEqual({ context: { allowed_company_ids: [7] },
      fields: ['id', 'name'], domain: [['active', '=', true]], limit: 100 })
  })

  it('passes a wizard record selection alongside the bound company context', async () => {
    const fetchMock = respond({ type: 'ir.actions.act_window_close' })
    const request = prepareOdooOrmCall({ model: 'account.payment.register', method: 'action_create_payments',
      params: { ids: [5], context: { active_id: 15, active_ids: [15, 16], active_model: 'account.move' } } })
    await expect(runOdooOrmCall(endpoint, key, company, request, options)).resolves.toEqual({ type: 'ir.actions.act_window_close' })
    expect(requestBody(fetchMock, 0)).toEqual({ ids: [5], context: {
      active_id: 15, active_ids: [15, 16], active_model: 'account.move', allowed_company_ids: [7],
    } })
  })

  it.each([
    { vals: draftMove },
    { values: [draftMove] },
    { vals_list: [draftMove] },
  ])('sends voucher creation with the canonical values list', async (params) => {
    const fetchMock = respond([17])
    const request = prepareOdooOrmCall({ model: 'account.move', method: 'create',
      params: { ...params, context: { active_model: 'account.move' } } })
    await expect(runOdooOrmCall(endpoint, key, company, request, options)).resolves.toEqual([17])
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:18069/odoo/json/2/account.move/create')
    expect(requestBody(fetchMock, 0)).toEqual({
      vals_list: [draftMove], context: { active_model: 'account.move', allowed_company_ids: [7] },
    })
  })

  it.each([
    {},
    { vals: draftMove, values: [draftMove] },
    { vals_list: [draftMove], ids: [17] },
    { vals_list: [] },
    { vals_list: [null] },
  ])('rejects an ambiguous or invalid voucher create request before dispatch', (params) => {
    const fetchMock = respond()
    expect(() => prepareOdooOrmCall({ model: 'account.move', method: 'create', params }))
      .toThrow(expect.objectContaining({ reason: 'invalid-input' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    { model: 'res.partner/../res.users', method: 'write', params: {} },
    { model: 'res.partner', method: '_write', params: {} },
    { model: 'res.partner', method: 'write', params: { context: { allowed_company_ids: [9] } } },
    { model: 'res.partner', method: 'write', params: { context: { active_ids: [-1] } } },
    { model: 'res.partner', method: 'search_read', params: { limit: 101 } },
    { model: 'res.partner', method: 'read', params: { ids: Array.from({ length: 101 }, (_, index) => index + 1) } },
    { model: 'res.partner', method: 'write', params: { vals: { name: 'a'.repeat(66_000) } } },
  ])('rejects an invalid route or parameter object before contacting Odoo', (request) => {
    const fetchMock = respond()
    expect(() => prepareOdooOrmCall(request)).toThrow(expect.objectContaining({ reason: 'invalid-input' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a lost mutation response as unknown without retrying', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('simulated disconnection'))
    vi.stubGlobal('fetch', fetchMock)
    const request = prepareOdooOrmCall({ model: 'res.partner', method: 'write', params: { ids: [15], vals: { name: 'Synthetic' } } })
    await expect(runOdooOrmCall(endpoint, key, company, request, options)).rejects.toMatchObject({ reason: 'unknown-outcome' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(requestBody(fetchMock, 0)).toEqual({ ids: [15], vals: { name: 'Synthetic' }, context: { allowed_company_ids: [7] } })
  })

  it('reports a rejected mutation without exposing the upstream error body', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ name: 'odoo.exceptions.UserError',
      message: 'private diagnostics' }, { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)
    const request = prepareOdooOrmCall({ model: 'res.partner', method: 'unlink', params: { ids: [15] } })
    await expect(runOdooOrmCall(endpoint, key, company, request, options)).rejects.toMatchObject({
      reason: 'invalid-input', message: expect.not.stringContaining('private diagnostics'),
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    [422, 'werkzeug.exceptions.UnprocessableEntity', 'invalid-input'],
    [422, 'odoo.exceptions.ValidationError', 'invalid-input'],
    [422, 'odoo.exceptions.UserError', 'invalid-input'],
    [403, 'odoo.exceptions.AccessError', 'permissions'],
    [502, 'proxy.Unavailable', 'unknown-outcome'],
  ])('classifies voucher create rejection with HTTP %i and %s', async (status, name, reason) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({
      name, message: 'Private diagnostics for key ' + key, debug: 'Private traceback',
    }, { status }))
    vi.stubGlobal('fetch', fetchMock)
    const request = prepareOdooOrmCall({ model: 'account.move', method: 'create', params: { vals_list: [draftMove] } })
    await expect(runOdooOrmCall(endpoint, key, company, request, options)).rejects.toMatchObject({
      reason, message: expect.not.stringMatching(new RegExp(key + '|Private')),
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('normalizes HTTPS and HTTP loopback addresses and rejects ambiguous destinations', () => {
    expect(normalizeFinanceEndpoint(endpoint)).toEqual({ ...endpoint, url: 'http://127.0.0.1:18069/odoo' })
    expect(normalizeFinanceEndpoint({ ...endpoint, url: 'http://[::1]:8069' }).url).toBe('http://[::1]:8069')
    expect(normalizeFinanceEndpoint({ ...endpoint, url: ' https://odoo.example/ ' }).url).toBe('https://odoo.example')
    for (const url of [
      'http://odoo.example', 'http://127.0.0.1.evil.example', 'file:///tmp/odoo',
      'https://alice:password@odoo.example', 'https://odoo.example?', 'https://odoo.example/#',
    ]) {
      expect(() => normalizeFinanceEndpoint({ ...endpoint, url })).toThrow(expect.objectContaining({ reason: 'invalid-address' }))
    }
    expect(() => normalizeFinanceEndpoint({ ...endpoint, database: 'wrong\r\nheader' }))
      .toThrow(expect.objectContaining({ reason: 'database' }))
  })

  it('discovers only companies assigned to the authenticated user', async () => {
    const fetchMock = respond({ uid: 21 }, [{ id: 7, name: 'Test Company', currency_id: [4, 'CNY'] }])
    await expect(discoverOdooCompanies(endpoint, key, options)).resolves.toEqual([company])
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:18069/odoo/json/2/res.users/context_get')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://127.0.0.1:18069/odoo/json/2/res.company/search_read')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST', redirect: 'manual', credentials: 'omit',
      headers: { Authorization: 'Bearer ' + key, 'X-Odoo-Database': 'test_ledger' },
      body: '{}',
    })
    expect(requestBody(fetchMock, 1)).toMatchObject({
      domain: [['user_ids', 'in', [21]]], fields: ['id', 'name', 'currency_id'],
    })
  })

  it('verifies accounting access for an empty company using the selected company in both queries', async () => {
    const fetchMock = respond({ uid: 21 }, [{ id: 7, name: 'Test Company', currency_id: [4, 'CNY'] }], [])
    await expect(verifyOdooCompany(endpoint, key, 7, options)).resolves.toEqual(company)
    expect(requestBody(fetchMock, 1)).toMatchObject({
      context: { allowed_company_ids: [7] }, domain: [['user_ids', 'in', [21]], ['id', '=', 7]],
    })
    expect(requestBody(fetchMock, 2)).toMatchObject({
      context: { allowed_company_ids: [7] }, domain: [['company_id', '=', 7]], fields: ['id', 'company_id'],
    })
  })

  it('stops verification when the selected company is unavailable', async () => {
    const fetchMock = respond({ uid: 21 }, [])
    await expect(verifyOdooCompany(endpoint, key, 7, options)).rejects.toMatchObject({ reason: 'company' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('verifies the authenticated login after the selected company and voucher-read checks', async () => {
    const login = 'bookkeeper@example.test'
    const fetchMock = respond({ uid: 21 }, [{ id: 7, name: 'Test Company', currency_id: [4, 'CNY'] }], [],
      [{ id: 21, login }])
    await expect(verifyOdooConnector(endpoint, key, 7, options)).resolves.toEqual({
      company, account: { login },
    })
    expect(fetchMock.mock.calls[3]?.[0]).toBe('http://127.0.0.1:18069/odoo/json/2/res.users/read')
    expect(requestBody(fetchMock, 3)).toEqual({ ids: [21], fields: ['login'] })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it.each([
    { id: 22, login: 'another@example.test' },
    { id: 21, login: key },
  ])('keeps a verified connection when optional metadata cannot be trusted', async selfRecord => {
    respond({ uid: 21 }, [{ id: 7, name: 'Test Company', currency_id: [4, 'CNY'] }], [], [selfRecord])
    await expect(verifyOdooConnector(endpoint, key, 7, options)).resolves.toEqual({ company })
  })

  it('keeps a verified connection when Odoo denies optional login lookup', async () => {
    const fetchMock = respond({ uid: 21 }, [{ id: 7, name: 'Test Company', currency_id: [4, 'CNY'] }], [])
    fetchMock.mockResolvedValueOnce(Response.json({}, { status: 403 }))
    await expect(verifyOdooConnector(endpoint, key, 7, options)).resolves.toEqual({ company })
  })

  it('keeps the stored login when decoding an account with retired permission fields', () => {
    const login = 'bookkeeper@example.test'
    expect(financeOdooAccountSchema.parse({ login, permissions: ['journal-entry-read'] })).toEqual({ login })
  })

  it('propagates caller cancellation during login lookup', async () => {
    const controller = new AbortController()
    const fetchMock = respond({ uid: 21 }, [{ id: 7, name: 'Test Company', currency_id: [4, 'CNY'] }], [])
    fetchMock.mockImplementationOnce(async () => {
      controller.abort()
      throw controller.signal.reason
    })
    await expect(verifyOdooConnector(endpoint, key, 7, { ...options, signal: controller.signal }))
      .rejects.toMatchObject({ reason: 'cancelled' })
  })

  it('queries chart accounts with the Odoo 19 company_ids field and the same count filters', async () => {
    const fetchMock = respond([{ id: 1, code: '1001', name: 'Cash', account_type: 'asset_cash', company_ids: [7, 9] }], 3)
    await expect(runOdooQuery(endpoint, key, company, { kind: 'accounts', search: ' Cash ', limit: 1, offset: 2 }, options))
      .resolves.toMatchObject({ rows: [{ id: 1, code: '1001', name: 'Cash', accountType: 'asset_cash' }], total: 3 })
    const scope = {
      context: { allowed_company_ids: [7] },
      domain: [['company_ids', 'in', [7]], '|', ['code', 'ilike', 'Cash'], ['name', 'ilike', 'Cash']],
    }
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:18069/odoo/json/2/account.account/search_read',
      'http://127.0.0.1:18069/odoo/json/2/account.account/search_count',
    ])
    expect(requestBody(fetchMock, 0)).toMatchObject({ ...scope, offset: 2, limit: 1, order: 'code, id' })
    expect(requestBody(fetchMock, 1)).toEqual(scope)
  })

  it('rejects results that belong to another company', async () => {
    const fetchMock = respond([{ id: 1, code: 'BNK', name: 'Bank', type: 'bank', company_id: [9, 'Other Company'] }])
    await expect(runOdooQuery(endpoint, key, company, { kind: 'journals' }, options))
      .rejects.toMatchObject({ reason: 'invalid-response' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('filters journal entries by company, date and posting state and preserves source currency', async () => {
    const fetchMock = respond([{
      id: 4, name: 'MISC/001', ref: false, date: '2026-02-11', state: 'posted',
      journal_id: [3, 'Miscellaneous'], amount_total: 40.25, currency_id: [1, 'USD'], company_id: [7, 'Test Company'],
    }], 1)
    const result = await runOdooQuery(endpoint, key, company, { kind: 'moves', from: '2026-02-01', to: '2026-02-28', state: 'posted' }, options)
    expect(result.rows).toEqual([{
      id: 4, number: 'MISC/001', reference: null, date: '2026-02-11', state: 'posted',
      journal: 'Miscellaneous', amountTotal: 40.25, currency: 'USD',
    }])
    expect(requestBody(fetchMock, 0)).toMatchObject({
      context: { allowed_company_ids: [7] },
      domain: [['company_id', '=', 7], ['date', '>=', '2026-02-01'], ['date', '<=', '2026-02-28'], ['state', '=', 'posted']],
    })
  })

  it('only reads lines after finding the parent entry in the selected company', async () => {
    const fetchMock = respond([])
    await expect(runOdooQuery(endpoint, key, company, { kind: 'move-lines', moveId: 4 }, options))
      .rejects.toMatchObject({ reason: 'not-found' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(requestBody(fetchMock, 0)).toMatchObject({ domain: [['company_id', '=', 7], ['id', '=', 4]] })
  })

  it('reads lines for the parent entry and labels debit and credit in company currency', async () => {
    const fetchMock = respond([{ id: 4, company_id: [7, 'Test Company'] }], [{
      id: 5, move_id: [4, 'MISC/001'], date: '2026-02-11', parent_state: 'posted',
      account_id: [3, '1001 Cash'], name: 'Test line', debit: 100.25, credit: 0, company_id: [7, 'Test Company'],
    }], 1)
    const result = await runOdooQuery(endpoint, key, company, { kind: 'move-lines', moveId: 4 }, options)
    expect(result.rows).toEqual([{
      id: 5, moveId: 4, number: 'MISC/001', date: '2026-02-11', state: 'posted', accountId: 3, account: '1001 Cash',
      description: 'Test line', debit: 100.25, credit: 0, currency: 'CNY',
    }])
    expect(requestBody(fetchMock, 1)).toMatchObject({
      context: { allowed_company_ids: [7] }, domain: [['company_id', '=', 7], ['move_id', '=', 4]],
    })
  })

  it('reads journal items directly by company, date, posting state and search', async () => {
    const fetchMock = respond([entry(5)], 1)
    const result = await runOdooQuery(endpoint, key, company, { ...entries, search: ' MISC/001 ' }, options)
    expect(result.rows).toEqual([{
      id: 5, moveId: 4, number: 'MISC/001', date: '2026-02-11', state: 'posted', accountId: 3, account: '1001 Cash',
      description: 'Test line', debit: 100.25, credit: 0, currency: 'CNY',
    }])
    const scope = {
      context: { allowed_company_ids: [7] },
      domain: [
        ['company_id', '=', 7], ['date', '>=', '2026-02-01'], ['date', '<=', '2026-02-28'], ['parent_state', '=', 'posted'],
        '|', ['name', 'ilike', 'MISC/001'], ['move_id.name', 'ilike', 'MISC/001'],
      ],
    }
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:18069/odoo/json/2/account.move.line/search_read',
      'http://127.0.0.1:18069/odoo/json/2/account.move.line/search_count',
    ])
    expect(requestBody(fetchMock, 0)).toMatchObject({ ...scope, offset: 0, limit: 20, order: 'date, id' })
    expect(requestBody(fetchMock, 1)).toEqual(scope)
  })

  it.each([
    { date: '2026-03-01' }, { parent_state: 'draft' }, { company_id: [9, 'Other Company'] },
  ])('rejects journal items outside the selected scope (%j)', async (outsideScope) => {
    const fetchMock = respond([{ ...entry(5), ...outsideScope }])
    await expect(runOdooQuery(endpoint, key, company, entries, options)).rejects.toMatchObject({ reason: 'invalid-response' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('collects all matching journal items in stable order across pages', async () => {
    const fetchMock = respond(Array.from({ length: 100 }, (_, index) => entry(index + 1)), 101, [entry(101)], 101)
    const result = await runOdooExport(endpoint, key, company, entries, options)
    expect(result).toMatchObject({ total: 101, query: entries })
    expect(result.rows.map(row => row.id)).toEqual(Array.from({ length: 101 }, (_, index) => index + 1))
    expect(requestBody(fetchMock, 0)).toMatchObject({ offset: 0, limit: 100, order: 'date, id' })
    expect(requestBody(fetchMock, 2)).toMatchObject({ offset: 100, limit: 100, order: 'date, id' })
    expect(requestBody(fetchMock, 1)).toEqual(requestBody(fetchMock, 3))
  })

  it.each([
    { rows: [entry(101)], total: 102 },
    { rows: [entry(100)], total: 101 },
    { rows: [], total: 101 },
  ])('fails export when the reported count or page coverage changes', async ({ rows, total }) => {
    const fetchMock = respond(Array.from({ length: 100 }, (_, index) => entry(index + 1)), 101, rows, total)
    await expect(runOdooExport(endpoint, key, company, entries, options)).rejects.toMatchObject({ reason: 'invalid-response' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('reports the size limit without returning a truncated export', async () => {
    const fetchMock = respond([], 10_101)
    await expect(runOdooExport(endpoint, key, company, entries, options)).rejects.toMatchObject({
      reason: 'invalid-input', message: expect.stringContaining('10,100'),
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('computes turnover totals on Odoo for the full posted scope independently of the page', async () => {
    const fetchMock = respond([{
      company_id: [7, 'Test Company'], account_id: [3, '1001 Cash'], 'debit:sum': 0.15, 'credit:sum': 0,
    }], [{ 'account_id:count_distinct': 5, 'debit:sum': 532.42, 'credit:sum': 532.42 }])
    const result = await runOdooQuery(endpoint, key, company, {
      kind: 'turnover', from: '2026-02-01', to: '2026-02-28', offset: 3, limit: 1,
    }, options)
    expect(result).toMatchObject({
      rows: [{ accountId: 3, account: '1001 Cash', debit: 0.15, credit: 0, currency: 'CNY' }],
      total: 5, totals: { debit: 532.42, credit: 532.42 },
    })
    const scope = {
      context: { allowed_company_ids: [7] },
      domain: [['company_id', '=', 7], ['parent_state', '=', 'posted'], ['account_id', '!=', false], ['date', '>=', '2026-02-01'], ['date', '<=', '2026-02-28']],
    }
    expect(requestBody(fetchMock, 0)).toMatchObject({
      ...scope, groupby: ['company_id', 'account_id'], aggregates: ['debit:sum', 'credit:sum'], offset: 3, limit: 1,
    })
    expect(requestBody(fetchMock, 1)).toEqual({
      ...scope, groupby: [], aggregates: ['debit:sum', 'credit:sum', 'account_id:count_distinct'],
    })
  })

  it('uses zero totals for a company without posted activity in the period', async () => {
    respond([], [{ 'account_id:count_distinct': 0, 'debit:sum': false, 'credit:sum': false }])
    await expect(runOdooQuery(endpoint, key, company, { kind: 'turnover', from: '2026-02-01', to: '2026-02-28' }, options))
      .resolves.toMatchObject({ rows: [], total: 0, totals: { debit: 0, credit: 0 } })
  })

  it('rejects invalid calendar dates, offsets and page sizes before any request', async () => {
    const fetchMock = respond()
    await expect(runOdooQuery(endpoint, key, company, { kind: 'turnover', from: '2026-02-30', to: '2026-03-01' }, options))
      .rejects.toMatchObject({ reason: 'invalid-input' })
    await expect(runOdooQuery(endpoint, key, company, { kind: 'accounts', offset: 10_001 }, options))
      .rejects.toMatchObject({ reason: 'invalid-input' })
    await expect(runOdooQuery(endpoint, key, company, { kind: 'journals', limit: 101 }, options))
      .rejects.toMatchObject({ reason: 'invalid-input' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects redirects without sending the API key to another address', async () => {
    const fetchMock = respond()
    fetchMock.mockResolvedValueOnce(Response.redirect('https://other.example/json/2'))
    await expect(discoverOdooCompanies(endpoint, key, options)).rejects.toMatchObject({ reason: 'invalid-address' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('manual')
  })

  it('classifies auth failures without exposing upstream diagnostics', async () => {
    const fetchMock = respond()
    fetchMock.mockResolvedValueOnce(Response.json({
      name: 'odoo.exceptions.AccessDenied', message: key, debug: 'private database traceback',
    }, { status: 403 }))
    await expect(discoverOdooCompanies(endpoint, key, options)).rejects.toMatchObject({
      reason: 'authentication', message: 'Odoo rejected the API key. Check that the key is active and belongs to this database.',
    })
  })

  it('separates endpoint, database and accounting permission failures', async () => {
    const fetchMock = respond()
    fetchMock
      .mockResolvedValueOnce(Response.json({ name: 'werkzeug.exceptions.NotFound' }, { status: 404 }))
      .mockResolvedValueOnce(new Response('Database not found', { status: 404 }))
      .mockResolvedValueOnce(Response.json({ uid: 21 }))
      .mockResolvedValueOnce(Response.json([{ id: 7, name: 'Test Company', currency_id: [4, 'CNY'] }]))
      .mockResolvedValueOnce(Response.json({ name: 'odoo.exceptions.AccessError' }, { status: 403 }))
    await expect(discoverOdooCompanies(endpoint, key, options)).rejects.toMatchObject({ reason: 'unsupported' })
    await expect(discoverOdooCompanies(endpoint, key, options)).rejects.toMatchObject({ reason: 'database' })
    await expect(verifyOdooCompany(endpoint, key, 7, options)).rejects.toMatchObject({ reason: 'permissions' })
  })

  it('rejects unexpected payloads, overlarge responses and successful responses that echo the key', async () => {
    const fetchMock = respond({ not_uid: 21 }, { uid: 21, echo: key }, { uid: 21, oversized: 'x'.repeat(512 * 1024) })
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(discoverOdooCompanies(endpoint, key, options)).rejects.toMatchObject({ reason: 'invalid-response' })
    }
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('honors an already cancelled operation without sending a request', async () => {
    const fetchMock = respond()
    await expect(discoverOdooCompanies(endpoint, key, { ...options, signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ reason: 'cancelled' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('classifies an operation timeout and stops dependent queries', async () => {
    const fetchMock = respond()
    fetchMock.mockImplementationOnce(async (_input, init) => {
      await new Promise<void>((resolve) => init?.signal?.addEventListener('abort', () => resolve(), { once: true }))
      init?.signal?.throwIfAborted()
      return Response.json({ uid: 21 })
    })
    await expect(discoverOdooCompanies(endpoint, key, { timeoutMs: 5 })).rejects.toMatchObject({ reason: 'timeout' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
