/** Administrative writes retain uncertainty across cancellation and restart until exact readback. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { odooAdminOperationDomain } from '../src/finance-admin-operations.ts'
import XiaojingLedgerSetup from '../src/finance-setup.ts'
import type { FinanceOrmJsonValue } from '../src/finance-types.ts'
import { ledgerSetupBotId, odooAccessBotId } from '../src/types.ts'
import { memoryFixture } from './memory-fixture.ts'

const endpoint = { url: 'https://admin.example.test', database: 'synthetic_admin' }
const apiKey = 'test-administrator-key'
const databaseUuid = '3d333e16-5c1b-4edf-9655-b115f68a5a35'
const signal = new AbortController().signal
const confirm = async () => {}
const companyWrite = { model: 'res.company', method: 'write', params: { ids: [12], vals: { name: 'Renamed' } } }
const companyCreate = { model: 'res.company', method: 'create', params: { vals_list: [{ name: 'New Company' }] } }
type Row = Record<string, FinanceOrmJsonValue>

function mockOdoo() {
  const companies: Row[] = [{ id: 12, name: 'Original', currency_id: [7, 'CNY'] }]
  const users: Row[] = [{ id: 42, name: 'Bookkeeper', company_id: [12, 'Original'], company_ids: [12],
    group_ids: [3], all_group_ids: [3], active: true }]
  const writes: { route: string; body: Row }[] = []
  let nextId = 31
  let failure: 'lost' | 'rejected' | 'validation' | 'ignored' | undefined
  let failReadback = false
  let currentUuid = databaseUuid
  let beforeWrite: (() => Promise<void>) | undefined
  const mock = vi.fn<typeof fetch>(async (url, init) => {
    const route = String(url).split('/json/2/')[1]!
    const body = z.record(z.string(), z.json()).parse(JSON.parse(String(init?.body)))
    const [model, method] = route.split('/')
    if (route === 'res.users/context_get') return Response.json({ uid: 17 })
    if (route === 'res.users/has_group' || route === 'res.company/has_access') return Response.json(true)
    if (route === 'ir.module.module/search_count') return Response.json(1)
    if (route === 'ir.config_parameter/get_param') return Response.json(currentUuid)
    if (route === 'res.users/read' && JSON.stringify(body.fields) === '["login"]') {
      return Response.json([{ id: 17, login: 'admin@example.test' }])
    }
    const rows = model === 'res.company' ? companies : users
    if (method === 'fields_get') {
      return Response.json(Object.fromEntries(z.array(z.string()).parse(body.allfields).map(field => [field, {
        type: field.endsWith('_ids') ? 'many2many' : field.endsWith('_id') ? 'many2one' : field === 'active' ? 'boolean' : 'char',
      }])))
    }
    if (method === 'read') {
      if (failReadback && writes.length) throw new TypeError('Synthetic readback interruption')
      const selected = z.array(z.number()).parse(body.ids)
      return Response.json(rows.filter(row => selected.includes(Number(row.id))))
    }
    if (method === 'search_read') {
      const terms = z.array(z.tuple([z.string(), z.string(), z.json()])).parse(body.domain ?? [])
      return Response.json(rows.filter(row => terms.every(([field, operator, value]) =>
        field === 'user_ids' || operator !== '=' || JSON.stringify(row[field]) === JSON.stringify(value))))
    }
    if (method === 'write' || method === 'create' || method?.startsWith('action_')) {
      await beforeWrite?.()
      writes.push({ route, body })
      if (failure === 'rejected') return Response.json({ name: 'odoo.exceptions.AccessError' }, { status: 403 })
      if (failure === 'validation') return Response.json({ name: 'odoo.exceptions.ValidationError' }, { status: 400 })
      const created: number[] = []
      if (failure !== 'ignored') {
        if (method === 'create') {
          for (const values of z.array(z.record(z.string(), z.json())).parse(body.vals_list)) {
            const id = nextId++
            rows.push({ ...values, id })
            created.push(id)
          }
        } else {
          const selected = z.array(z.number()).parse(body.ids)
          const values = method === 'write' ? z.record(z.string(), z.json()).parse(body.vals) : { active: method === 'action_unarchive' }
          for (const row of rows.filter(row => selected.includes(Number(row.id)))) {
            for (const [field, value] of Object.entries(values)) {
              if (field.endsWith('_ids')) {
                const linked = new Set(z.array(z.number()).parse(row[field] ?? []))
                for (const command of z.array(z.tuple([z.number(), z.number(), z.json()])).parse(value)) {
                  if (command[0] === 4) linked.add(command[1])
                  else if (command[0] === 3) linked.delete(command[1])
                  else { linked.clear(); if (command[0] === 6) z.array(z.number()).parse(command[2]).forEach(id => linked.add(id)) }
                }
                row[field] = [...linked]
              } else row[field] = value
            }
            if (row.group_ids) row.all_group_ids = row.group_ids
          }
        }
      }
      if (failure === 'lost') throw new TypeError('Synthetic lost response after write')
      return Response.json(method === 'create' ? created : true)
    }
    throw new Error('Unexpected mock route ' + route)
  })
  vi.stubGlobal('fetch', mock)
  return { writes, companies, users,
    fail: (value?: typeof failure) => { failure = value },
    failReadback: (value: boolean) => { failReadback = value },
    beforeWrite: (callback: () => Promise<void>) => { beforeWrite = callback },
    changeDatabase: () => { currentUuid = 'a883eb77-7955-4500-b959-df74ff905359' },
  }
}

async function fixture(root?: string) {
  const h = await memoryFixture([], root, {}, { financeConnectors: true })
  await h.ctx.plugin(UserQuestions)
  await h.ctx.plugin(XiaojingLedgerSetup)
  const setup = h.ctx.xiaojingLedgerSetup
  await setup.snapshot()
  if (root === undefined) await setup.saveConnection({ ...endpoint, apiKey }, signal)
  const domain = h.ctx.storageDomain.get(odooAdminOperationDomain.name)!
  const records = () => odooAdminOperationDomain.global.schema.parse(domain.global.get()).operations
  const bots = (await h.ctx.katcatsTeam.snapshot()).bots
  const jing = h.ctx.agents.get(bots.find(bot => bot.id === ledgerSetupBotId)!.sessionId)!
  const ye = h.ctx.agents.get(bots.find(bot => bot.id === odooAccessBotId)!.sessionId)!
  const tool = (name: string, args: object = {}, agent = jing) => h.ctx.tools.execute({
    name, arguments: args, agent, signal, callId: ToolCallId('admin-operation-test'),
  })
  return { ...h, setup, domain, records, tool, jing, ye }
}

afterEach(() => vi.unstubAllGlobals())

describe('durable Odoo administration writes', () => {
  it('saves intent before dispatch and verifies actual permission membership after writing', async () => {
    const odoo = mockOdoo()
    const h = await fixture()
    odoo.beforeWrite(async () => {
      expect(h.records()).toMatchObject([{ status: 'pending', role: 'access',
        witness: { targets: [{ id: 42, values: { name: 'Updated', group_ids: [3, 7] } }] } }])
    })
    const result = await h.setup.adminCall('access', { model: 'res.users', method: 'write',
      params: { ids: [42], vals: { name: 'Updated', group_ids: [[4, 7, 0]] } } }, confirm, signal)
    expect(result.operation).toMatchObject({ status: 'verified', records: [{ id: 42, group_ids: [3, 7], all_group_ids: [3, 7] }] })
    expect(JSON.stringify(result)).not.toContain(apiKey)
    expect(JSON.stringify(result)).not.toContain('beforeIds')
    expect((await h.setup.adminOperations('ledger', signal))).toEqual([])
  })

  it('does not treat a successful response without matching field values as completion', async () => {
    const odoo = mockOdoo()
    odoo.fail('ignored')
    const h = await fixture()
    await expect(h.setup.adminCall('ledger', companyWrite, confirm, signal)).rejects.toMatchObject({ details: { reason: 'unknown-outcome' } })
    const [operation] = await h.setup.adminOperations('ledger', signal)
    expect(operation).toMatchObject({ status: 'unknown', failure: 'readback-mismatch' })
    await expect(h.setup.adminCall('ledger', companyWrite, confirm, signal)).rejects.toMatchObject({ details: { reason: 'unknown-outcome' } })
    expect(odoo.writes).toHaveLength(1)
    expect(await h.setup.adminCall('ledger', { model: 'res.company', method: 'read', params: { ids: [12] } }, confirm, signal))
      .toMatchObject({ data: [{ id: 12, name: 'Original' }] })
    expect(await h.setup.reconcileAdminOperation('ledger', operation!.id, signal)).toMatchObject({ status: 'unknown' })
    odoo.fail()
    expect(await h.setup.adminCall('access', { model: 'res.users', method: 'write', params: { ids: [42], vals: { name: 'Changed' } } }, confirm, signal))
      .toMatchObject({ operation: { status: 'verified' } })
  })

  it('retains a lost write response across restart and reconciles without repeating the mutation', async () => {
    const odoo = mockOdoo()
    odoo.fail('lost')
    const h = await fixture()
    await expect(h.setup.adminCall('ledger', companyWrite, confirm, signal)).rejects.toMatchObject({ details: { reason: 'unknown-outcome' } })
    const [operation] = await h.setup.adminOperations('ledger', signal)
    await h.close()
    const restarted = await fixture(h.root)
    await expect(restarted.setup.adminCall('ledger', companyWrite, confirm, signal)).rejects.toMatchObject({ details: { reason: 'unknown-outcome' } })
    expect(await restarted.setup.reconcileAdminOperation('ledger', operation!.id, signal)).toMatchObject({ status: 'verified', records: [{ name: 'Renamed' }] })
    expect(odoo.writes).toHaveLength(1)
    odoo.fail()
    expect(await restarted.setup.adminCall('ledger', { ...companyWrite, params: { ids: [12], vals: { name: 'Next' } } }, confirm, signal))
      .toMatchObject({ operation: { status: 'verified' } })
  })

  it.each(['rejected', 'validation'] as const)('keeps an explicit %s response retryable', async failure => {
    const odoo = mockOdoo()
    odoo.fail(failure)
    const h = await fixture()
    await expect(h.setup.adminCall('ledger', companyWrite, confirm, signal)).rejects.toMatchObject({ details: {
      reason: failure === 'rejected' ? 'permissions' : 'invalid-input',
    } })
    expect(await h.setup.adminOperations('ledger', signal)).toMatchObject([{ status: 'rejected' }])
    odoo.fail()
    expect(await h.setup.adminCall('ledger', companyWrite, confirm, signal)).toMatchObject({ operation: { status: 'verified' } })
    expect(odoo.writes).toHaveLength(2)
  })

  it('persists cancellation after dispatch as unknown while cancellation before confirmation sends nothing', async () => {
    const odoo = mockOdoo()
    const h = await fixture()
    const controller = new AbortController()
    odoo.beforeWrite(async () => { controller.abort() })
    await expect(h.setup.adminCall('ledger', companyWrite, confirm, controller.signal)).rejects.toMatchObject({ details: { reason: 'unknown-outcome' } })
    expect(await h.setup.adminOperations('ledger', signal)).toMatchObject([{ status: 'unknown' }])
    expect(odoo.writes).toHaveLength(1)
    await expect(h.setup.adminCall('access', { model: 'res.users', method: 'write', params: { ids: [42], vals: { name: 'Never' } } },
      async () => { throw new Error('Owner declined') }, signal)).rejects.toThrow('Owner declined')
    expect(await h.setup.adminOperations('access', signal)).toEqual([])
    expect(odoo.writes).toHaveLength(1)
  })

  it('recovers a crash-pending intent as unknown and refuses the wrong role', async () => {
    mockOdoo()
    const h = await fixture()
    await h.setup.adminCall('ledger', companyWrite, confirm, signal)
    const stored = h.records()[0]!
    await h.domain.global.set({ operations: [{ ...stored, status: 'pending' }] })
    await h.close()
    const restarted = await fixture(h.root)
    expect(await restarted.setup.adminOperations('ledger', signal)).toMatchObject([{ status: 'unknown' }])
    await expect(restarted.setup.reconcileAdminOperation('access', stored.id, signal)).rejects.toMatchObject({ details: { reason: 'not-found' } })
    expect(await restarted.setup.reconcileAdminOperation('ledger', stored.id, signal)).toMatchObject({ status: 'verified' })
  })

  it('does not dispatch when persisting the intent fails', async () => {
    const odoo = mockOdoo()
    const h = await fixture()
    const save = vi.spyOn(h.domain.global, 'set').mockRejectedValueOnce(new Error('Disk full'))
    await expect(h.setup.adminCall('ledger', companyWrite, confirm, signal)).rejects.toMatchObject({ details: { reason: 'storage' } })
    expect(odoo.writes).toEqual([])
    save.mockRestore()
  })

  it('saves acknowledged creation IDs before a failed readback and verifies them after restart', async () => {
    const odoo = mockOdoo()
    odoo.failReadback(true)
    const h = await fixture()
    await expect(h.setup.adminCall('ledger', companyCreate, confirm, signal)).rejects.toMatchObject({ details: { reason: 'unknown-outcome' } })
    const [operation] = await h.setup.adminOperations('ledger', signal)
    expect(operation).toMatchObject({ status: 'unknown', recordIds: [31] })
    await h.close()
    odoo.failReadback(false)
    const restarted = await fixture(h.root)
    expect(await restarted.setup.reconcileAdminOperation('ledger', operation!.id, signal)).toMatchObject({ status: 'verified', recordIds: [31] })
    expect(odoo.writes).toHaveLength(1)
  })

  it('lists uncertain creation candidates and requires explicit tool confirmation to adopt one', async () => {
    const odoo = mockOdoo()
    odoo.companies[0]!.name = 'New Company'
    odoo.fail('lost')
    const h = await fixture()
    await expect(h.setup.adminCall('ledger', companyCreate, confirm, signal)).rejects.toMatchObject({ details: { reason: 'unknown-outcome' } })
    const [operation] = await h.setup.adminOperations('ledger', signal)
    const id = operation!.id
    odoo.companies.push({ id: 32, name: 'New Company' })
    expect(await h.tool('list_odoo_admin_operations')).toMatchObject({ isError: false, value: { operations: [{ id, status: 'unknown' }] } })
    expect(await h.tool('reconcile_odoo_admin_operation', { operation_id: id })).toMatchObject({ isError: false,
      value: { status: 'unknown', candidates: [[31, 32]] } })
    await expect(h.setup.reconcileAdminOperation('ledger', id, signal, [12])).rejects.toMatchObject({ details: { reason: 'invalid-input' } })
    let selected = ['取消']
    const questions: AskUserQuestionItem[] = []
    const stop = h.ctx.on('user-questions/request', async request => {
      expect(request.questions[0]?.id).toBe('odoo-admin-reconcile')
      expect(request.questions[0]?.detail).toContain('New Company')
      questions.push(request.questions[0]!)
      return { answers: [{ id: 'odoo-admin-reconcile', selected }] }
    })
    const reconcile = vi.spyOn(h.setup, 'reconcileAdminOperation')
    try {
      expect(await h.tool('reconcile_odoo_admin_operation', { operation_id: id, adopt_record_ids: [31] })).toMatchObject({ isError: true })
      expect(reconcile.mock.calls.every(args => args[3] === undefined)).toBe(true)
      expect(await h.setup.adminOperations('ledger', signal)).toMatchObject([{ status: 'unknown' }])
      expect(questions[0]?.intent).toBeUndefined()
      expect(questions[0]).toMatchSnapshot({ detail: expect.stringContaining('New Company') })
      selected = ['确认认领记录']
      expect(await h.tool('reconcile_odoo_admin_operation', { operation_id: id, adopt_record_ids: [31] })).toMatchObject({ isError: false,
        value: { status: 'verified', recordIds: [31], records: [{ id: 31, name: 'New Company' }] } })
      expect(odoo.writes).toHaveLength(1)
    } finally { stop(); reconcile.mockRestore() }
  })
})
