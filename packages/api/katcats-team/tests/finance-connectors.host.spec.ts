/** Persisted Odoo connectors and group and Bot bindings over the real storage and credentials facilities. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import type { ChatId } from '../src/chats-types.ts'
import type { BotId } from '../src/types.ts'
import { FinanceConnections } from '../src/finance-connectors.ts'
import { harness } from './member-fixture.ts'

const apiKey = '1111222233334444555566667777888899990000'
const draft = { url: 'https://odoo.example', database: 'test_ledger', apiKey, name: 'Test Ledger', companyId: 7 }
const company = { id: 7, name: 'Test Company', currency: 'CNY' }
const chatId = brandString<ChatId>('test-ledger-group')
const otherChatId = brandString<ChatId>('unbound-group')
const botId = brandString<BotId>(chatId)
const directUrl = 'https://direct.odoo.example'
const identityRoute = '/json/2/ir.config_parameter/get_param'
const databaseUuid = 'f25889ba-b43e-11ef-9218-2c9bba0cfd71'
const differentDatabaseUuid = '2b02ec8e-b43f-11ef-8b79-4da5958f7893'
const verificationCallCount = 4
const bookkeeperLogin = 'bookkeeper@example.test'

async function setup(root?: string) {
  const h = await harness(root)
  await h.ctx.plugin(CredentialsLocal, { path: join(h.root, 'credentials.yaml'), watch: false })
  const finance = new FinanceConnections(h.ctx, h.ctx.credentials, 1_000)
  h.ctx.effect(() => () => finance.close())
  await finance.ready
  return { ...h, finance }
}

function queueVerification(fetchMock: Mock<typeof fetch>, login = bookkeeperLogin) {
  fetchMock
    .mockResolvedValueOnce(Response.json({ uid: 21 }))
    .mockResolvedValueOnce(Response.json([{ id: 7, name: 'Test Company', currency_id: [4, 'CNY'] }]))
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(Response.json([{ id: 21, login }]))
}

function mockVerification(login = bookkeeperLogin) {
  const fetchMock = vi.fn<typeof fetch>()
  queueVerification(fetchMock, login)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function mockAddressChange(oldUuid: string | null, newUuid: string) {
  const fetchMock = vi.fn<typeof fetch>(async (request, options) => {
    const url = new URL(String(request))
    expect(options?.headers).toMatchObject({ Authorization: 'Bearer ' + apiKey, 'X-Odoo-Database': draft.database })
    if (url.pathname === identityRoute) {
      expect(options?.body).toBe(JSON.stringify({ key: 'database.uuid' }))
      if (url.origin === draft.url) {
        if (oldUuid === null) throw new TypeError('fetch failed')
        return Response.json(oldUuid)
      }
      expect(url.origin).toBe(directUrl)
      return Response.json(newUuid)
    }
    expect(url.origin).toBe(directUrl)
    switch (url.pathname) {
      case '/json/2/res.users/context_get': return Response.json({ uid: 21 })
      case '/json/2/res.users/read': return Response.json([{ id: 21, login: bookkeeperLogin }])
      case '/json/2/res.company/search_read': return Response.json([{ id: 7, name: 'Test Company', currency_id: [4, 'CNY'] }])
      case '/json/2/account.move/search_read':
      case '/json/2/account.account/search_read': return Response.json([])
      case '/json/2/account.account/search_count': return Response.json(0)
      default: throw new Error(`Unexpected finance request ${url.pathname}`)
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const failure = (reason: string) => ({ code: 'xiaojing/finance-connector', details: { reason } })

afterEach(() => vi.unstubAllGlobals())

describe('finance connector persistence', () => {
  it('restores a legacy group binding and verifies account metadata with the saved credential', async () => {
    const fetchMock = mockVerification()
    const h = await setup()
    const saved = await h.finance.save(draft)
    expect(saved).toMatchObject({ name: draft.name, company, failure: null, account: { login: bookkeeperLogin } })
    await h.finance.bind(chatId, saved.id)
    expect(JSON.stringify(saved)).not.toContain(apiKey)
    const storagePath = join(h.root, 'storage', 'xiaojing_finance_connectors.json')
    const stored = await readFile(storagePath, 'utf8')
    expect(stored).not.toContain(apiKey)
    expect(stored).toContain('xiaojing-finance/key-')
    await h.close()

    const legacy: { global: { botBindings?: unknown; connectors: { accessMode?: unknown; account?: unknown }[] } } = JSON.parse(stored)
    delete legacy.global.botBindings
    delete legacy.global.connectors[0]?.accessMode
    delete legacy.global.connectors[0]?.account
    await writeFile(storagePath, JSON.stringify(legacy) + '\n')
    const reopened = await setup(h.root)
    const snapshot = await reopened.finance.snapshot()
    const { account, ...legacyConnector } = saved
    expect(snapshot).toEqual({ connectors: [legacyConnector] })
    expect(saved.accessMode).toBe('read-only')
    expect(JSON.stringify(snapshot)).not.toContain('xiaojing-finance/')
    expect(await reopened.finance.getBinding(chatId)).toBe(saved.id)
    expect(await reopened.finance.getBinding(otherChatId)).toBeNull()
    expect(await reopened.finance.getBotBinding(botId)).toBeNull()
    await expect(reopened.finance.queryBot(botId, { kind: 'accounts' })).rejects.toMatchObject(failure('unbound'))
    await expect(reopened.finance.query(otherChatId, { kind: 'accounts' })).rejects.toMatchObject(failure('unbound'))

    fetchMock
      .mockResolvedValueOnce(Response.json([{
        id: 1, code: '1001', name: 'Cash', account_type: 'asset_cash', company_ids: [7],
      }]))
      .mockResolvedValueOnce(Response.json(1))
    await expect(reopened.finance.query(chatId, { kind: 'accounts' })).resolves.toMatchObject({
      company, rows: [{ id: 1, code: '1001', name: 'Cash' }], total: 1,
    })
    expect(fetchMock.mock.calls[verificationCallCount]).toMatchObject([
      'https://odoo.example/json/2/account.account/search_read',
      { headers: { Authorization: 'Bearer ' + apiKey, 'X-Odoo-Database': 'test_ledger' } },
    ])
    queueVerification(fetchMock)
    await expect(reopened.finance.test(saved.id)).resolves.toMatchObject({ account })
  })

  it('permits built-in reads but blocks mutations on a read-only connector', async () => {
    const fetchMock = mockVerification()
    const h = await setup()
    const saved = await h.finance.save(draft)
    await h.finance.bind(chatId, saved.id)
    const approve = vi.fn(async () => {})
    await expect(h.finance.callOrmGroup(chatId, { model: 'res.partner', method: 'write', params: {} }, approve))
      .rejects.toMatchObject(failure('permissions'))
    expect(approve).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(verificationCallCount)
    for (const [method, params, data] of [
      ['search_count', { domain: [] }, 12], ['search', { domain: [] }, [5]],
      ['read', { ids: [5], fields: ['id'] }, [{ id: 5 }]], ['name_search', { name: 'Synthetic' }, [[5, 'Synthetic']]],
    ] as const) {
      fetchMock.mockResolvedValueOnce(Response.json(data))
      await expect(h.finance.callOrmGroup(chatId, { model: 'res.partner', method, params }, approve))
        .resolves.toMatchObject({ connector: { id: saved.id }, company, model: 'res.partner', method, data })
    }
    expect(approve).not.toHaveBeenCalled()
  })

  it('waits for approval before dispatch and denies a write after its binding changes', async () => {
    const fetchMock = mockVerification()
    const h = await setup()
    const saved = await h.finance.save({ ...draft, accessMode: 'full' })
    await h.finance.bindBot(botId, saved.id)
    const request = { model: 'res.partner', method: 'write', params: { ids: [15], vals: { name: 'Synthetic' } } }
    await expect(h.finance.callOrmBot(botId, request, undefined)).rejects.toMatchObject(failure('permissions'))
    const requested = Promise.withResolvers<void>()
    const permission = Promise.withResolvers<void>()
    const authorize = vi.fn(async (connector: typeof saved) => {
      expect(connector).toEqual(saved)
      expect(JSON.stringify(connector)).not.toContain(apiKey)
      requested.resolve()
      await permission.promise
    })
    const pending = h.finance.callOrmBot(botId, request, authorize)
    await requested.promise
    expect(fetchMock).toHaveBeenCalledTimes(verificationCallCount)
    await h.finance.bindBot(botId, null)
    permission.resolve()
    await expect(pending).rejects.toMatchObject(failure('unbound'))
    expect(fetchMock).toHaveBeenCalledTimes(verificationCallCount)
    await h.finance.bindBot(botId, saved.id)
    fetchMock.mockResolvedValueOnce(Response.json(true))
    await expect(h.finance.callOrmBot(botId, request, authorize)).resolves.toMatchObject({ data: true })
    expect(fetchMock).toHaveBeenCalledTimes(verificationCallCount + 1)
  })

  it.each([{ accessMode: 'read-only' }, { apiKey: 'replacement-credential' }] as const)(
    'invalidates an approval when the connector changes before dispatch (%j)', async (change) => {
      const fetchMock = mockVerification()
      const h = await setup()
      const saved = await h.finance.save({ ...draft, accessMode: 'full' })
      await h.finance.bind(chatId, saved.id)
      const authorize = vi.fn(async () => {
        queueVerification(fetchMock)
        await h.finance.save({ id: saved.id, url: saved.url, database: saved.database, name: saved.name,
          companyId: saved.company.id, ...change })
      })
      await expect(h.finance.callOrmGroup(chatId, { model: 'res.partner', method: 'unlink', params: { ids: [15] } }, authorize))
        .rejects.toMatchObject(failure('unbound'))
      expect(fetchMock.mock.calls.map(call => call[0])).not.toContain('https://odoo.example/json/2/res.partner/unlink')
      expect(fetchMock).toHaveBeenCalledTimes(2 * verificationCallCount)
    },
  )

  it('rechecks approved work after waiting behind another write without dispatching an invalidated candidate', async () => {
    const fetchMock = mockVerification()
    const h = await setup()
    const saved = await h.finance.save({ ...draft, accessMode: 'full' })
    await h.finance.bind(chatId, saved.id)
    const request = { model: 'res.partner', method: 'write', params: { ids: [15], vals: { name: 'Synthetic' } } }
    const dispatched = Promise.withResolvers<void>()
    const firstResponse = Promise.withResolvers<Response>()
    fetchMock.mockImplementationOnce(async () => {
      dispatched.resolve()
      return firstResponse.promise
    })
    const firstWrite = h.finance.callOrmGroup(chatId, request, async () => {})
    await dispatched.promise
    let candidateCurrent = true
    const approved = Promise.withResolvers<void>()
    const invalidated = new Error('Reviewed candidate changed while waiting for dispatch')
    const recheck = vi.fn(async () => {
      if (!candidateCurrent) throw invalidated
    })
    const pending = h.finance.callOrmGroup(chatId, request, async () => {
      approved.resolve()
      return recheck
    })
    const rejection = expect(pending).rejects.toBe(invalidated)
    await approved.promise
    expect(recheck).not.toHaveBeenCalled()
    candidateCurrent = false
    firstResponse.resolve(Response.json(true))
    await expect(firstWrite).resolves.toMatchObject({ data: true })
    await rejection
    expect(recheck).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(verificationCallCount + 1)
  })

  it('restores a Bot binding independently from a group with the same identifier', async () => {
    const fetchMock = mockVerification()
    const h = await setup()
    const saved = await h.finance.save(draft)
    await h.finance.bindBot(botId, saved.id)
    await expect(h.finance.remove(saved.id)).rejects.toMatchObject(failure('in-use'))
    await expect(h.finance.save({ ...draft, id: saved.id, companyId: 9 })).rejects.toMatchObject(failure('in-use'))
    await h.close()

    const reopened = await setup(h.root)
    expect(await reopened.finance.getBotBinding(botId)).toBe(saved.id)
    expect(await reopened.finance.getBinding(chatId)).toBeNull()
    await expect(reopened.finance.query(chatId, { kind: 'accounts' })).rejects.toMatchObject(failure('unbound'))
    expect(fetchMock).toHaveBeenCalledTimes(verificationCallCount)
    fetchMock.mockResolvedValueOnce(Response.json([])).mockResolvedValueOnce(Response.json(0))
    await expect(reopened.finance.queryBot(botId, { kind: 'accounts' })).resolves.toMatchObject({
      connector: { id: saved.id }, company, total: 0,
    })

    await reopened.finance.bind(chatId, saved.id)
    await reopened.finance.pruneBotBindings([])
    expect(await reopened.finance.getBotBinding(botId)).toBeNull()
    expect(await reopened.finance.getBinding(chatId)).toBe(saved.id)
    await expect(reopened.finance.queryBot(botId, { kind: 'accounts' })).rejects.toMatchObject(failure('unbound'))
    expect(fetchMock).toHaveBeenCalledTimes(verificationCallCount + 2)
  })

  it('keeps export scopes separate and refuses a dataset if the group binding changes during the read', async () => {
    const fetchMock = mockVerification()
    const h = await setup()
    const saved = await h.finance.save(draft)
    const query = { kind: 'entries', from: '2026-02-01', to: '2026-02-28', state: 'posted' } as const
    await h.finance.bindBot(botId, saved.id)
    await expect(h.finance.exportGroupRows(chatId, query)).rejects.toMatchObject(failure('unbound'))
    expect(fetchMock).toHaveBeenCalledTimes(verificationCallCount)
    await h.finance.bind(chatId, saved.id)

    const requested = Promise.withResolvers<void>()
    const reading = Promise.withResolvers<Response>()
    fetchMock.mockImplementationOnce(() => { requested.resolve(); return reading.promise })
      .mockResolvedValueOnce(Response.json(0))
    const exporting = h.finance.exportGroupRows(chatId, query)
    await requested.promise
    await h.finance.bind(chatId, null)
    reading.resolve(Response.json([]))
    await expect(exporting).rejects.toMatchObject(failure('unbound'))

    fetchMock.mockResolvedValueOnce(Response.json([])).mockResolvedValueOnce(Response.json(0))
    await expect(h.finance.exportBotRows(botId, query)).resolves.toMatchObject({
      connector: { id: saved.id }, company, query, rows: [], total: 0,
    })
    expect(fetchMock).toHaveBeenCalledTimes(verificationCallCount + 4)
  })

  it('blocks changes to the database and company and removal while a group uses the connector', async () => {
    const fetchMock = mockVerification()
    const h = await setup()
    const saved = await h.finance.save(draft)
    await h.finance.bind(chatId, saved.id)
    for (const change of [{ database: 'other_ledger' }, { companyId: 9 }]) {
      await expect(h.finance.save({ ...draft, id: saved.id, ...change })).rejects.toMatchObject(failure('in-use'))
    }
    await expect(h.finance.remove(saved.id)).rejects.toMatchObject(failure('in-use'))
    expect(fetchMock).toHaveBeenCalledTimes(verificationCallCount)
    expect(await h.finance.snapshot()).toEqual({ connectors: [saved] })
    expect(await h.finance.getBinding(chatId)).toBe(saved.id)
  })

  it('requires a new key before testing a different database even for an unbound connector', async () => {
    const fetchMock = mockVerification()
    const h = await setup()
    const saved = await h.finance.save(draft)
    const changedEndpoint = { id: saved.id, url: draft.url, database: 'other_ledger' }
    await expect(h.finance.discover(changedEndpoint)).rejects.toMatchObject(failure('credential'))
    await expect(h.finance.save({ ...changedEndpoint, name: draft.name, companyId: 7 }))
      .rejects.toMatchObject(failure('credential'))
    expect(fetchMock).toHaveBeenCalledTimes(verificationCallCount)
    expect(await h.finance.snapshot()).toEqual({ connectors: [saved] })
  })

  it('accepts a replacement address with an explicitly entered key when the connection is unbound', async () => {
    mockVerification()
    const h = await setup()
    const saved = await h.finance.save(draft)
    const replacementLogin = 'replacement@example.test'
    const fetchMock = mockVerification(replacementLogin)
    const replacementKey = 'aaaabbbbccccddddeeeeffff0000111122223333'

    await expect(h.finance.save({ ...draft, id: saved.id, url: directUrl, apiKey: replacementKey }))
      .resolves.toMatchObject({ id: saved.id, url: directUrl, company, failure: null, account: { login: replacementLogin } })
    expect(fetchMock.mock.calls).toHaveLength(verificationCallCount)
    expect(fetchMock.mock.calls[0]).toMatchObject([
      directUrl + '/json/2/res.users/context_get', { headers: { Authorization: 'Bearer ' + replacementKey } },
    ])
  })

  it('moves a bound ledger to its verified new address with the saved key and keeps its task scope after reopening', async () => {
    mockVerification()
    const h = await setup()
    const saved = await h.finance.save(draft)
    await h.finance.bind(chatId, saved.id)
    await h.finance.bindBot(botId, saved.id)
    const scope = h.finance.groupTaskScope(chatId)
    expect(scope).toMatchObject({ key: expect.any(String), label: company.name })
    const changedEndpoint = { id: saved.id, url: directUrl, database: draft.database }
    const fetchMock = mockAddressChange(databaseUuid, databaseUuid)

    await expect(h.finance.discover(changedEndpoint)).resolves.toEqual([company])
    expect(await h.finance.snapshot()).toEqual({ connectors: [saved] })
    const updated = await h.finance.save({ ...changedEndpoint, name: saved.name, companyId: company.id })
    expect(updated).toMatchObject({ id: saved.id, url: directUrl, company, failure: null })
    expect(JSON.stringify(updated)).not.toContain(apiKey)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(expect.arrayContaining([
      draft.url + identityRoute, directUrl + identityRoute,
    ]))
    expect(h.finance.groupTaskScope(chatId)).toEqual(scope)
    await h.close()

    const reopened = await setup(h.root)
    await expect(reopened.finance.snapshot()).resolves.toEqual({ connectors: [updated] })
    expect(await reopened.finance.getBinding(chatId)).toBe(saved.id)
    expect(await reopened.finance.getBotBinding(botId)).toBe(saved.id)
    expect(reopened.finance.groupTaskScope(chatId)).toEqual(scope)
    await expect(reopened.finance.query(chatId, { kind: 'accounts' })).resolves.toMatchObject({ company, total: 0 })
    await expect(reopened.finance.queryBot(botId, { kind: 'accounts' })).resolves.toMatchObject({ company, total: 0 })
  })

  it('requires a fresh write approval after a verified address change', async () => {
    mockVerification()
    const h = await setup()
    const saved = await h.finance.save({ ...draft, accessMode: 'full' })
    await h.finance.bind(chatId, saved.id)
    const fetchMock = mockAddressChange(databaseUuid, databaseUuid)
    const request = { model: 'res.partner', method: 'write', params: { ids: [1], vals: { name: 'Synthetic' } } }
    const changeAddress = async () => {
      await h.finance.save({ id: saved.id, url: directUrl, database: saved.database, name: saved.name, companyId: company.id })
    }

    await expect(h.finance.callOrmGroup(chatId, request, changeAddress)).rejects.toMatchObject(failure('unbound'))
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/res.partner/write'))).toBe(false)
    fetchMock.mockResolvedValueOnce(Response.json(true))
    await expect(h.finance.callOrmGroup(chatId, request, async () => {})).resolves.toMatchObject({ data: true })
    expect(fetchMock.mock.lastCall?.[0]).toBe(directUrl + '/json/2/res.partner/write')
  })

  it.each([
    { oldUuid: databaseUuid, newUuid: differentDatabaseUuid, reason: 'ledger-mismatch' },
    { oldUuid: null, newUuid: databaseUuid, reason: 'ledger-unverified' },
  ])('retains the saved address and bindings when verification returns $reason', async ({ oldUuid, newUuid, reason }) => {
    mockVerification()
    const h = await setup()
    const saved = await h.finance.save(draft)
    await h.finance.bind(chatId, saved.id)
    await h.finance.bindBot(botId, saved.id)
    const scope = h.finance.groupTaskScope(chatId)
    const changedEndpoint = { id: saved.id, url: directUrl, database: draft.database }
    const fetchMock = mockAddressChange(oldUuid, newUuid)

    await expect(h.finance.discover(changedEndpoint)).rejects.toMatchObject(failure(reason))
    await expect(h.finance.save({ ...changedEndpoint, name: saved.name, companyId: company.id }))
      .rejects.toMatchObject(failure(reason))
    if (oldUuid === null) expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([draft.url + identityRoute, draft.url + identityRoute])
    await expect(h.finance.snapshot()).resolves.toEqual({ connectors: [saved] })
    expect(await h.finance.getBinding(chatId)).toBe(saved.id)
    expect(await h.finance.getBotBinding(botId)).toBe(saved.id)
    expect(h.finance.groupTaskScope(chatId)).toEqual(scope)
  })

  it('keeps the previous key and binding usable when saving a replacement fails', async () => {
    mockVerification()
    const h = await setup()
    const saved = await h.finance.save(draft)
    await h.finance.bind(chatId, saved.id)
    const domain = h.ctx.storageDomain.get('xiaojing_finance_connectors')
    if (!domain) throw new Error('Expected the open finance storage domain')
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Synthetic storage failure'))

    const fetchMock = mockVerification()
    await expect(h.finance.save({
      ...draft, id: saved.id, apiKey: 'aaaabbbbccccddddeeeeffff0000111122223333',
    })).rejects.toMatchObject(failure('storage'))
    expect(await h.finance.snapshot()).toEqual({ connectors: [saved] })
    expect(await h.finance.getBinding(chatId)).toBe(saved.id)
    fetchMock.mockResolvedValueOnce(Response.json([])).mockResolvedValueOnce(Response.json(0))
    await expect(h.finance.query(chatId, { kind: 'accounts' })).resolves.toMatchObject({ total: 0 })
    expect(fetchMock.mock.calls[verificationCallCount]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer ' + apiKey })
  })

  it('persists a safe failure status without losing the binding or continuing to send requests', async () => {
    const fetchMock = mockVerification()
    const h = await setup()
    const saved = await h.finance.save(draft)
    await h.finance.bind(chatId, saved.id)
    fetchMock.mockResolvedValueOnce(Response.json({ name: 'odoo.exceptions.AccessDenied', message: apiKey }, { status: 403 }))
    const failed = await h.finance.test(saved.id)
    expect(failed).toMatchObject({ id: saved.id, company, failure: 'authentication' })
    expect(failed.account).toBeUndefined()
    expect(failed.lastTestAt >= saved.lastTestAt).toBe(true)
    expect(JSON.stringify(failed)).not.toContain(apiKey)
    await h.close()

    const reopened = await setup(h.root)
    expect(await reopened.finance.snapshot()).toEqual({ connectors: [failed] })
    expect(await reopened.finance.getBinding(chatId)).toBe(saved.id)
    await expect(reopened.finance.query(chatId, { kind: 'accounts' })).rejects.toMatchObject(failure('authentication'))
    await expect(reopened.finance.bind(otherChatId, saved.id)).rejects.toMatchObject(failure('credential'))
    expect(fetchMock).toHaveBeenCalledTimes(verificationCallCount + 1)

    mockVerification()
    await expect(reopened.finance.test(saved.id)).resolves.toMatchObject({
      id: saved.id, failure: null, account: { login: bookkeeperLogin },
    })
    expect(await reopened.finance.getBinding(chatId)).toBe(saved.id)
  })

  it('follows access failure and recovery across group and Bot queries without rewriting the explicit test', async () => {
    const fetchMock = mockVerification()
    const h = await setup()
    const saved = await h.finance.save(draft)
    await h.finance.bind(chatId, saved.id)
    await h.finance.bindBot(botId, saved.id)
    const storagePath = join(h.root, 'storage', 'xiaojing_finance_connectors.json')
    const before = await readFile(storagePath, 'utf8')
    const lifetime = new AbortController()
    const feed = h.finance.follow(lifetime.signal)[Symbol.asyncIterator]()
    try {
      await expect(feed.next()).resolves.toMatchObject({ value: { connectors: [saved] } })
      fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
      await expect(h.finance.query(chatId, { kind: 'accounts' })).rejects.toMatchObject(failure('network'))
      await expect(feed.next()).resolves.toMatchObject({ value: { connectors: [{ ...saved,
        accessHealth: { outcome: 'unreachable', checkedAt: expect.any(String) } }] } })
      fetchMock.mockResolvedValueOnce(Response.json(4))
      await expect(h.finance.callOrmBot(botId, { model: 'res.partner', method: 'search_count', params: { domain: [] } }, undefined))
        .resolves.toMatchObject({ data: 4 })
      const recovered = { connectors: [{ ...saved, accessHealth: { outcome: 'reachable', checkedAt: expect.any(String) } }] }
      await expect(feed.next()).resolves.toMatchObject({ value: recovered })
      await expect(h.finance.snapshot()).resolves.toMatchObject(recovered)
      expect(await readFile(storagePath, 'utf8')).toBe(before)
    } finally {
      lifetime.abort()
      await feed.return?.()
    }
  })

  it('allows a bound write after a transient manual test failure and distinguishes an uncertain write outcome', async () => {
    const fetchMock = mockVerification()
    const h = await setup()
    const saved = await h.finance.save({ ...draft, accessMode: 'full' })
    await h.finance.bind(chatId, saved.id)
    fetchMock.mockResolvedValueOnce(Response.json({}, { status: 504 }))
    const test = await h.finance.test(saved.id)
    expect(test.failure).toBe('timeout')
    const request = { model: 'res.partner', method: 'write', params: { ids: [1], vals: { name: 'Synthetic' } } }
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    await expect(h.finance.callOrmGroup(chatId, request, async () => {})).rejects.toMatchObject(failure('unknown-outcome'))
    await expect(h.finance.snapshot()).resolves.toMatchObject({ connectors: [{ ...test, accessHealth: { outcome: 'unreachable' } }] })
    fetchMock.mockResolvedValueOnce(Response.json([])).mockResolvedValueOnce(Response.json(0))
    await expect(h.finance.exportGroupRows(chatId, { kind: 'entries', from: '2026-02-01', to: '2026-02-28', state: 'posted' }))
      .resolves.toMatchObject({ total: 0 })
    await expect(h.finance.snapshot()).resolves.toMatchObject({ connectors: [{ ...test, accessHealth: { outcome: 'reachable' } }] })
    mockVerification()
    const retested = await h.finance.test(saved.id)
    expect(retested.failure).toBeNull()
    expect(await h.finance.snapshot()).toEqual({ connectors: [retested] })
  })

  it('returns and follows the same access observation as a successful or timed out explicit test', async () => {
    mockVerification()
    const h = await setup()
    const saved = await h.finance.save(draft)
    expect(saved.accessHealth).toBeUndefined()
    const lifetime = new AbortController()
    const feed = h.finance.follow(lifetime.signal)[Symbol.asyncIterator]()
    try {
      await expect(feed.next()).resolves.toEqual({ done: false, value: { connectors: [saved] } })
      const fetchMock = mockVerification()
      const success = await h.finance.test(saved.id)
      expect(success.failure).toBeNull()
      expect(success.accessHealth).toEqual({ checkedAt: success.lastTestAt, outcome: 'reachable' })
      await expect(feed.next()).resolves.toEqual({ done: false, value: { connectors: [success] } })
      await expect(h.finance.snapshot()).resolves.toEqual({ connectors: [success] })

      fetchMock.mockResolvedValueOnce(Response.json({}, { status: 504 }))
      const timeout = await h.finance.test(saved.id)
      expect(timeout.failure).toBe('timeout')
      expect(timeout.accessHealth).toEqual({ checkedAt: timeout.lastTestAt, outcome: 'unreachable' })
      await expect(feed.next()).resolves.toEqual({ done: false, value: { connectors: [timeout] } })
      await expect(h.finance.snapshot()).resolves.toEqual({ connectors: [timeout] })
    } finally {
      lifetime.abort()
      await feed.return?.()
    }
  })

  it('discards a late access observation after the connector has been reverified with a different key', async () => {
    const fetchMock = mockVerification()
    const h = await setup()
    const saved = await h.finance.save(draft)
    await h.finance.bind(chatId, saved.id)
    const started = Promise.withResolvers<void>()
    const oldFetch = Promise.withResolvers<Response>()
    fetchMock.mockImplementationOnce(() => { started.resolve(); return oldFetch.promise })
    const pending = h.finance.query(chatId, { kind: 'accounts' })
    await started.promise
    mockVerification()
    const updated = await h.finance.save({ ...draft, id: saved.id, apiKey: 'synthetic-replacement' })
    oldFetch.reject(new TypeError('fetch failed'))
    await expect(pending).rejects.toMatchObject(failure('network'))
    expect(await h.finance.snapshot()).toEqual({ connectors: [updated] })
  })
})
