/** Finance tools derive their ledger from the active group and log the read result. */
import { basename, join } from 'node:path'
import ExcelJS from 'exceljs'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import * as Present from '@deepseek-ai/dsh-tool-present'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import type { TeamChat } from '../src/chats-types.ts'
import { memoryFixture } from './memory-fixture.ts'
import { stubFinanceFetch } from './finance-fetch-fixture.ts'
import { systemText } from './member-fixture.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const capability = { financeConnectors: true }
const key = '0000111122223333444455556666777788889999'
const tool = 'query_group_finance'

afterEach(() => { vi.unstubAllGlobals() })

async function runGroup(ctx: Context, chat: TeamChat, label: string): Promise<void> {
  const controller = new AbortController()
  try {
    await ctx.katcatsChats.sendMessage({ sessionId: chat.rootSessionId, mode: 'queue',
      requestId: brandString<SessionRequestId>(label), content: [{ type: 'text', text: label }] }, controller.signal)
    for await (const frame of ctx.katcatsChats.follow(controller.signal)) {
      if (frame.value.activities.find(activity => activity.chatId === chat.id)?.processing === false) return
    }
    throw new Error('Group closed before its task settled')
  } finally { controller.abort() }
}

it('welcomes each successful explicit group connection as the main Bot and keeps it in that group', async () => {
  const fetchMock = vi.fn<typeof fetch>()
  stubFinanceFetch(fetchMock)
  const queueVerification = (id: number, name: string, currency: string) => {
    fetchMock.mockResolvedValueOnce(Response.json({ uid: 1 }))
      .mockResolvedValueOnce(Response.json([{ id, name, currency_id: [4, currency] }]))
      .mockResolvedValueOnce(Response.json([]))
  }
  const h = await memoryFixture([], undefined, {}, capability)
  const team = h.ctx.katcatsTeam
  const groups = h.ctx.katcatsChats
  const signal = new AbortController().signal
  const { bot } = await team.createBot({ name: 'Ledger reader' })
  const { chat } = await groups.createChat({ name: 'Bound ledger', memberIds: [bot.id] })
  const { chat: other } = await groups.createChat({ name: 'Other group', memberIds: [bot.id] })
  const main = (await team.snapshot()).bots.find(candidate => candidate.kind === 'main')!
  expect(chat.memberIds).not.toContain(main.id)

  queueVerification(7, 'First Company', 'CNY')
  const first = await team.saveFinanceConnector({
    name: 'First ledger', url: 'https://first.example', database: 'ledger_test', companyId: 7, apiKey: key,
  }, signal)
  queueVerification(8, 'Second Company', 'USD')
  const second = await team.saveFinanceConnector({
    name: 'Second ledger', url: 'https://second.example', database: 'ledger_test', companyId: 8, apiKey: key,
  }, signal)
  await groups.bindFinance(chat.id, first.id)
  await expect(groups.connectFinance(chat.id, second.id, signal)).rejects.toMatchObject({ details: { reason: 'unbound' } })
  expect(fetchMock).toHaveBeenCalledTimes(6)

  queueVerification(7, 'First Company', 'CNY')
  await team.testFinanceConnector(first.id, signal)
  queueVerification(7, 'First Company', 'CNY')
  await expect(groups.connectFinance(chat.id, first.id, signal)).resolves.toMatchObject({ failure: null, accessHealth: { outcome: 'reachable' } })

  await groups.bindFinance(chat.id, second.id)
  fetchMock.mockRejectedValueOnce(new TypeError('offline'))
  await expect(groups.connectFinance(chat.id, second.id, signal)).resolves.toMatchObject({ failure: 'network' })
  queueVerification(8, 'Second Company', 'USD')
  await expect(groups.connectFinance(chat.id, second.id, signal)).resolves.toMatchObject({ failure: null, accessHealth: { outcome: 'reachable' } })

  const waiting = Promise.withResolvers<void>()
  const verification = Promise.withResolvers<Response>()
  fetchMock.mockImplementationOnce(() => { waiting.resolve(); return verification.promise })
    .mockResolvedValueOnce(Response.json([{ id: 8, name: 'Second Company', currency_id: [4, 'USD'] }]))
    .mockResolvedValueOnce(Response.json([]))
  const pending = groups.connectFinance(chat.id, second.id, signal)
  const stale = expect(pending).rejects.toMatchObject({ details: { reason: 'unbound' } })
  await waiting.promise
  const bind = vi.spyOn(team.finance!, 'bind')
  try {
    const changed = groups.bindFinance(chat.id, first.id)
    await vi.waitFor(() => expect(bind).toHaveBeenCalledWith(chat.id, first.id))
    verification.resolve(Response.json({ uid: 1 }))
    await changed
    await stale
  } finally {
    verification.resolve(Response.json({ uid: 1 }))
    bind.mockRestore()
  }

  expect(h.adapter.requests).toHaveLength(0)
  expect((await groups.snapshot()).deliveries).toEqual([])
  await h.close()
  const reopened = await memoryFixture([], h.root, {}, capability)
  const welcomes = async (chat: TeamChat) => (await reopened.ctx.sessionController.inspect(chat.rootSessionId)).events
    .flatMap(event => event.type === 'user/message' && event.data.source.kind === 'katcats-group-finance-connected'
      ? [event.data.source] : [])
  const sender = { botId: main.id, name: main.name, role: main.role, avatar: main.avatar }
  expect(await welcomes(chat)).toMatchObject([
    { chatId: chat.id, sender, connectorId: first.id, connectorName: 'First ledger', companyName: 'First Company', currency: 'CNY' },
    { chatId: chat.id, sender, connectorId: second.id, connectorName: 'Second ledger', companyName: 'Second Company', currency: 'USD' },
  ])
  expect(await welcomes(other)).toEqual([])
})

it('restores a bound ledger, isolates groups and private chats, and removes the binding with the group', async () => {
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ uid: 1 }))
    .mockResolvedValueOnce(Response.json([{ id: 7, name: 'Ledger Company', currency_id: [4, 'CNY'] }]))
    .mockResolvedValueOnce(Response.json([]))
  stubFinanceFetch(fetchMock)
  const initial = await memoryFixture([], undefined, {}, capability)
  const { bot } = await initial.ctx.katcatsTeam.createBot({ name: 'Ledger reader' })
  const { chat: bound } = await initial.ctx.katcatsChats.createChat({ name: 'Bound ledger', memberIds: [bot.id] })
  const { chat: other } = await initial.ctx.katcatsChats.createChat({ name: 'Other group', memberIds: [bot.id] })
  const connector = await initial.ctx.katcatsTeam.saveFinanceConnector({
    name: 'Accounting test', url: 'https://odoo.example', database: 'ledger_test', companyId: 7, apiKey: key,
  }, new AbortController().signal)
  await initial.ctx.katcatsChats.bindFinance(bound.id, connector.id)
  expect(initial.ctx.tools.get(tool, initial.ctx.agents.get(bot.sessionId))).toBeUndefined()
  expect(initial.ctx.tools.get(tool, initial.ctx.agents.get(bound.rootSessionId))).toBeUndefined()
  await initial.close()

  const reopened = await memoryFixture([
    toolCallResponse('plan-foreign', 'plan_group_work', { own_task: 'Check ledger availability', assignments: [], review: { reason: 'none' } }),
    toolCallResponse('foreign-query', tool, { kind: 'journals' }),
    textResponse('This group has no ledger.'),
    toolCallResponse('plan-ledger', 'plan_group_work', { own_task: 'List journals', assignments: [], review: { reason: 'none' } }),
    toolCallResponse('ledger-query', tool, { kind: 'journals' }),
    textResponse('The ledger has one sales journal.'),
  ], initial.root, {}, capability)
  expect(await reopened.ctx.katcatsChats.financeBinding(bound.id)).toBe(connector.id)
  expect(await reopened.ctx.katcatsChats.financeBinding(other.id)).toBeNull()
  await runGroup(reopened.ctx, other, 'Check the journal list here')
  expect(fetchMock).toHaveBeenCalledTimes(3)
  const foreignLog = await reopened.ctx.sessionController.inspect(other.executors[0]!.sessionId)
  const denial = foreignLog.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'foreign-query')
  expect(denial?.type === 'tool/result' && JSON.stringify(denial.data.message.content)).toContain('Bind a verified finance connection')

  fetchMock
    .mockResolvedValueOnce(Response.json([{ id: 17, code: 'SALE', name: 'Sales', type: 'sale', company_id: [7, 'Ledger Company'] }]))
    .mockResolvedValueOnce(Response.json(1))
  await runGroup(reopened.ctx, bound, 'Check the bound journal list')
  expect(fetchMock).toHaveBeenCalledTimes(5)
  const log = await reopened.ctx.sessionController.inspect(bound.executors[0]!.sessionId)
  const result = log.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'ledger-query')
  expect(result?.type === 'tool/result' && result.data.message.content).toEqual([{
    type: 'text', text: JSON.stringify({ connector: { id: connector.id, name: connector.name, type: 'odoo' }, company: { id: 7, name: 'Ledger Company', currency: 'CNY' },
      query: { kind: 'journals' }, rows: [{ id: 17, code: 'SALE', name: 'Sales', type: 'sale' }], total: 1 }),
  }])
  expect(JSON.stringify(log.events)).not.toContain(key)
  await reopened.ctx.katcatsChats.deleteChat({ id: bound.id })
  await expect(reopened.ctx.katcatsChats.financeBinding(bound.id)).rejects.toMatchObject({ code: 'gateway/bad-request' })
  await expect(reopened.ctx.katcatsTeam.deleteFinanceConnector(connector.id)).resolves.toBeUndefined()
})

it('refreshes the ledger in the next group request after switching accounts in an existing conversation', async () => {
  const fetchMock = vi.fn<typeof fetch>()
  for (const [id, name] of [[7, 'Company Alpha'], [9, 'Company Beta']] as const) {
    fetchMock.mockResolvedValueOnce(Response.json({ uid: 1 }))
      .mockResolvedValueOnce(Response.json([{ id, name, currency_id: [4, 'CNY'] }]))
      .mockResolvedValueOnce(Response.json([]))
  }
  stubFinanceFetch(fetchMock)
  const h = await memoryFixture([
    toolCallResponse('record-alpha', 'record_group_task', { goal: 'Reconcile Alpha vouchers',
      acceptance: ['Match the source entries'], stage: 'waiting for documents', next_step: 'Check Alpha vouchers', artifacts: [] }),
    textResponse('Earlier ledger: Company Alpha.'),
    (request) => {
      const relay = request.messages.findLast(message => message.role === 'user' && message.source?.kind === 'katcats-group-task')
      expect(JSON.stringify(relay?.content)).toContain('Recent task index: []')
      return toolCallResponse('search-current-tasks', 'find_group_tasks', { query: 'Reconcile Alpha vouchers' })
    },
    toolCallResponse('plan-new-ledger', 'plan_group_work', { own_task: 'List current journals', assignments: [], review: { reason: 'none' } }),
    toolCallResponse('query-new-ledger', tool, { kind: 'journals' }),
    textResponse('Current ledger: Company Beta.'),
  ], undefined, {}, capability)
  const team = h.ctx.katcatsTeam
  const signal = new AbortController().signal
  const alpha = await team.saveFinanceConnector({
    name: 'Ledger Alpha', url: 'https://alpha.odoo.example', database: 'alpha', companyId: 7, apiKey: key,
  }, signal)
  const beta = await team.saveFinanceConnector({
    name: 'Ledger Beta', url: 'https://beta.odoo.example', database: 'beta', companyId: 9, apiKey: key,
  }, signal)
  const { bot } = await team.createBot({ name: 'Ledger reader' })
  const { chat } = await h.ctx.katcatsChats.createChat({ name: 'Switch ledger', memberIds: [bot.id] })
  await h.ctx.katcatsChats.bindFinance(chat.id, alpha.id)
  await runGroup(h.ctx, chat, 'Identify the ledger')
  const old = (await h.ctx.katcatsChats.snapshot()).chats[0]!
  const task = old.tickets![0]!
  expect(task.financeLabel).toBe('Company Alpha')

  await h.ctx.katcatsChats.bindFinance(chat.id, beta.id)
  const switched = await h.ctx.katcatsChats.snapshot()
  expect(switched.activities[0]?.taskContinuation?.[task.id]).toBe('scope')
  await expect(h.ctx.katcatsChats.continueTask({ chatId: chat.id, taskId: task.id,
    expectedRevision: task.revision, expectedRunId: null, expectedGeneration: old.generation,
    requestId: brandString<SessionRequestId>('retry-alpha-task') }, signal)).rejects.toThrow('cannot continue')
  fetchMock.mockResolvedValueOnce(Response.json([])).mockResolvedValueOnce(Response.json(0))
  await runGroup(h.ctx, chat, 'List journals in the current ledger')

  const ledgerContexts = h.adapter.requests.map(request => request.messages
    .filter(message => message.role === 'user' && message.source?.kind === 'runtime-context')
    .at(-1)?.content)
  const before = ledgerContexts[0]
  const after = ledgerContexts[2]
  expect(JSON.stringify(before)).toContain('Company Alpha')
  expect(JSON.stringify(after)).toContain('Company Beta')
  expect(JSON.stringify(after)).not.toContain('Company Alpha')
  expect(JSON.stringify(h.adapter.requests[2]?.messages)).toContain('Earlier ledger: Company Alpha.')
  expect(fetchMock.mock.calls.slice(6).map(([url]) => String(url))).toEqual([
    'https://beta.odoo.example/json/2/account.journal/search_read',
    'https://beta.odoo.example/json/2/account.journal/search_count',
  ])

  const log = await h.ctx.sessionController.inspect(chat.executors[0]!.sessionId)
  const search = log.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'search-current-tasks')
  expect(search?.type === 'tool/result' && search.data.message.content).toEqual([
    { type: 'text', text: JSON.stringify({ tasks: [], matches: 0, more: false }) },
  ])
  const current = log.events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'runtime-context'
    && event.data.source.form === 'snapshot' ? event.data.source.sections : [])
    .findLast(section => section.name === 'xiaojing:finance-ledger')?.text.replace(beta.id, '<connector>')
  expect(current).toMatchInlineSnapshot(
    `"Current finance ledger for this conversation (saved settings): {"connector":{"id":"<connector>","name":"Ledger Beta","type":"odoo"},"company":{"id":9,"name":"Company Beta","currency":"CNY"},"accessMode":"read-only"}. Use this company when identifying the active ledger, including on simple replies. Treat earlier finance replies, figures, files and record IDs as historical. For current data or a follow-up using earlier IDs, query the active ledger again. Verify current connectivity through a successful finance tool call before claiming it."`,
  )
  expect(JSON.stringify(log.events)).not.toContain(key)
})

it('saves the group export as an Excel draft and delivers it only when the member presents it', async () => {
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ uid: 1 }))
    .mockResolvedValueOnce(Response.json([{ id: 7, name: 'Ledger Company', currency_id: [4, 'CNY'] }]))
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(Response.json([{
      id: 5, move_id: [4, 'MISC/001'], date: '2026-02-11', parent_state: 'posted',
      account_id: [3, '1001 Cash'], name: 'Source line', debit: 100.25, credit: 0, company_id: [7, 'Ledger Company'],
    }]))
    .mockResolvedValueOnce(Response.json(1))
  stubFinanceFetch(fetchMock)
  const h = await memoryFixture([
    toolCallResponse('plan-group-export', 'plan_group_work', {
      own_task: 'Export the posted source ledger rows.', assignments: [], review: { reason: 'none' },
    }),
    toolCallResponse('group-export-draft', 'export_group_finance', {
      kind: 'entries', from: '2026-02-01', to: '2026-02-28',
    }),
    request => {
      const result = request.messages.find(message => message.role === 'tool' && message.toolCallId === 'group-export-draft')
      if (result?.role !== 'tool' || result.isError) throw new Error('Expected the group export tool to return a saved workbook')
      const text = result.content.find(block => block.type === 'text')?.text
      if (text === undefined) throw new Error('Missing group export result')
      const metadata = z.object({ filename: z.string().regex(/^凭证分录-[0-9a-f-]{36}\.xlsx$/u),
        row_count: z.literal(1), company: z.literal('Ledger Company'), ledger: z.literal('Group Ledger') }).strict().parse(JSON.parse(text))
      return toolCallResponse('present-group-export', 'present', { files: [{ path: metadata.filename }] })
    },
    textResponse('The February ledger export is ready.'),
  ], undefined, {}, capability)
  Object.assign(h.ctx.loader.builtins, { 'export-directory': WorkingDirectory, 'export-present': Present })
  await h.ctx.loader.create({ name: 'cordis:export-directory', config: { defaultDirectory: h.root } })
  await h.ctx.loader.create({ name: 'cordis:export-present', config: { maxFiles: 8 } })
  await h.ctx.loader.await()
  const { bot } = await h.ctx.katcatsTeam.createBot({ name: 'Ledger reader' })
  const { chat } = await h.ctx.katcatsChats.createChat({ name: 'Ledger export group', memberIds: [bot.id] })
  const connector = await h.ctx.katcatsTeam.saveFinanceConnector({
    name: 'Group Ledger', url: 'https://odoo.example', database: 'ledger_test', companyId: 7, apiKey: key,
  }, new AbortController().signal)
  await h.ctx.katcatsChats.bindFinance(chat.id, connector.id)
  expect(h.ctx.tools.get('export_group_finance', h.ctx.agents.get(bot.sessionId))).toBeUndefined()
  expect(h.ctx.tools.get('export_group_finance', h.ctx.agents.get(chat.rootSessionId))).toBeUndefined()

  await runGroup(h.ctx, chat, 'Export the posted February ledger lines')
  const { events } = await h.ctx.sessionController.inspect(chat.executors[0]!.sessionId)
  const presentations = events.filter(event => event.type === 'deliverables/presented')
  expect(presentations.map(event => event.data.callId)).toEqual(['present-group-export'])
  const file = presentations[0]?.data.files[0]
  if (file === undefined) throw new Error('Missing delivered group workbook')
  expect(file.path).toBe(join(chat.workDir, basename(file.path)))
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(file.path)
  const worksheet = workbook.getWorksheet('凭证分录')
  expect(worksheet?.getRow(2).values).toEqual([
    undefined, 'Ledger Company', 'Group Ledger', 'MISC/001', '2026-02-11', 'posted', '1001 Cash', 'Source line', 100.25, 0, 'CNY',
  ])
  expect((await h.ctx.katcatsChats.snapshot()).deliveries).toMatchObject([
    { chatId: chat.id, state: 'completed', receipt: { text: 'The February ledger export is ready.' } },
  ])
  expect(fetchMock.mock.calls.slice(3).map(([url]) => url)).toEqual([
    'https://odoo.example/json/2/account.move.line/search_read',
    'https://odoo.example/json/2/account.move.line/search_count',
  ])
  expect(fetchMock.mock.calls[3]?.[1]?.body).toContain('["company_id","=",7]')
  expect(JSON.stringify(events)).not.toContain(key)
})

it('uses the bound Odoo ledger for a stock query even when the saved role describes accounting work', async () => {
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ uid: 1 }))
    .mockResolvedValueOnce(Response.json([{ id: 7, name: 'Ledger Company', currency_id: [4, 'CNY'] }]))
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(Response.json([{ id: 17, quantity: 8 }]))
  stubFinanceFetch(fetchMock)
  const h = await memoryFixture([
    toolCallResponse('plan-stock', 'plan_group_work', { own_task: 'Read available stock', assignments: [], review: { reason: 'none' } }),
    toolCallResponse('read-stock', 'call_group_odoo_orm', {
      model: 'stock.quant', method: 'search_read', parameters_json: '{"fields":["quantity"],"limit":10}',
    }),
    textResponse('Found 8 in the inventory record.'),
  ], undefined, {}, capability)
  const { bot } = await h.ctx.katcatsTeam.createBot({ name: 'Ledger reader' })
  const { chat } = await h.ctx.katcatsChats.createChat({
    name: 'Stock lookup group', memberIds: [bot.id],
  })
  await h.ctx.katcatsChats.updateChat({ id: chat.id, memberRoles: [{ botId: bot.id, role: '日常只读核对凭证' }] })
  const connector = await h.ctx.katcatsTeam.saveFinanceConnector({
    name: 'Group Ledger', url: 'https://odoo.example', database: 'ledger_test', companyId: 7, apiKey: key,
  }, new AbortController().signal)
  await h.ctx.katcatsChats.bindFinance(chat.id, connector.id)

  await runGroup(h.ctx, chat, '查库存')
  const system = h.adapter.requests.flatMap(systemText).join('\n')
  expect(system).toContain('日常只读核对凭证')
  expect(system).toContain('Do not treat a role description as the connector')
  expect(fetchMock).toHaveBeenCalledTimes(4)
  expect(fetchMock.mock.calls[3]?.[0]).toBe('https://odoo.example/json/2/stock.quant/search_read')
  expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toMatchObject({ context: { allowed_company_ids: [7] } })
  const { events } = await h.ctx.sessionController.inspect(chat.executors[0]!.sessionId)
  expect(events.filter(event => event.type === 'tool/result' && event.data.message.toolCallId === 'read-stock'))
    .toMatchObject([{ data: { message: { content: [{ text: expect.stringContaining('"quantity":8') }] } } }])
  expect(JSON.stringify(events)).not.toContain(key)
})
