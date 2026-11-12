/** Dedicated finance Bot creation, private ledger access, export, and group scope separation. */
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import ExcelJS from 'exceljs'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import * as FileTools from '@deepseek-ai/dsh-tool-fs'
import * as Present from '@deepseek-ai/dsh-tool-present'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import type { TeamChat } from '../src/chats-types.ts'
import type { FinanceConnectorId } from '../src/finance-types.ts'
import type { BotId } from '../src/types.ts'
import { memoryFixture, memorySend } from './memory-fixture.ts'
import { stubFinanceFetch } from './finance-fetch-fixture.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    katcatsCashierFixture: { readonly kind: 'katcats-cashier-fixture' }
  }
}

const finance = { financeConnectors: true }
const key = '0000111122223333444455556666777788889999'
const createCashier = 'create_finance_bot'
const queryBot = 'query_bot_finance'
const exportBot = 'export_bot_finance'
const queryGroup = 'query_group_finance'

afterEach(() => { vi.unstubAllGlobals() })

async function runGroup(h: Awaited<ReturnType<typeof memoryFixture>>, chat: TeamChat, requestId: string): Promise<void> {
  const controller = new AbortController()
  try {
    await h.ctx.katcatsChats.sendMessage({ sessionId: chat.rootSessionId, mode: 'queue',
      requestId: brandString<SessionRequestId>(requestId), content: [{ type: 'text', text: 'List journals in this group.' }] },
    controller.signal)
    for await (const frame of h.ctx.katcatsChats.follow(controller.signal)) {
      if (frame.value.activities.find(activity => activity.chatId === chat.id)?.processing === false) return
    }
    throw new Error('Cashier group did not settle')
  } finally { controller.abort() }
}

async function bindAndObserveGroupFinance(
  h: Awaited<ReturnType<typeof memoryFixture>>, chat: TeamChat, connectorId: FinanceConnectorId | null,
): Promise<void> {
  const controller = new AbortController()
  const stream = h.ctx.katcatsChats.follow(AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]))[Symbol.asyncIterator]()
  try {
    const initial = await stream.next()
    if (initial.done) throw new Error('Group finance follow ended before the snapshot')
    expect(initial.value.value.financeChatIds ?? []).toEqual(connectorId === null ? [chat.id] : [])

    const updated = stream.next()
    await h.ctx.katcatsChats.bindFinance(chat.id, connectorId)
    const frame = await updated
    if (frame.done) throw new Error('Group finance follow ended before publishing the changed binding')
    expect(frame.value.type).toBe('replace')
    expect(frame.value.value.financeChatIds ?? []).toEqual(connectorId === null ? [] : [chat.id])
  } finally {
    controller.abort()
    await stream.return?.()
  }
}

it('restores a cashier’s owner-bound private ledger and delivers a local document with ordinary tools', async () => {
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ uid: 1 }))
    .mockResolvedValueOnce(Response.json([{ id: 7, name: 'Ledger Company', currency_id: [4, 'CNY'] }]))
    .mockResolvedValueOnce(Response.json([]))
  stubFinanceFetch(fetchMock)
  const initial = await memoryFixture([
    toolCallResponse('create-writer', 'create_bot', { name: 'Treasury Writer', role: 'Draft editorial copy about financial topics.' }),
    toolCallResponse('create-cashier', createCashier, { name: 'Ledger Cashier' }),
    textResponse('The writer and cashier are ready.'),
  ], undefined, {}, finance)
  const team = initial.ctx.katcatsTeam
  const before = await team.snapshot()
  const main = before.bots.find(bot => bot.id === before.mainBotId)
  const mainAgent = main && initial.ctx.agents.get(main.sessionId)
  if (mainAgent === undefined) throw new Error('Missing main fixture Agent')
  await memorySend(mainAgent, 'Create an editorial writer and a cashier that can look up vouchers.')
  expect(initial.adapter.requests[0]?.tools?.map(tool => tool.name)).toContain(createCashier)

  const { bots } = await team.snapshot()
  const writer = bots.find(bot => bot.name === 'Treasury Writer')
  const cashier = bots.find(bot => bot.name === 'Ledger Cashier')
  if (writer === undefined || cashier === undefined) throw new Error('The main Agent did not create both Bots')
  expect(writer.financePreset).toBeUndefined()
  expect(cashier.financePreset).toBe('cashier')
  const writerAgent = initial.ctx.agents.get(writer.sessionId)
  if (writerAgent === undefined) throw new Error('Missing writer fixture Agent')
  expect(initial.ctx.tools.get(queryBot, writerAgent)).toBeUndefined()
  expect(initial.ctx.tools.get(exportBot, writerAgent)).toBeUndefined()
  expect(initial.ctx.tools.get(createCashier, writerAgent)).toBeUndefined()
  expect(initial.ctx.tools.get(queryBot, mainAgent)).toBeUndefined()
  expect(initial.ctx.tools.get(exportBot, mainAgent)).toBeUndefined()

  const connector = await team.saveFinanceConnector({
    name: 'Cashier test', url: 'https://odoo.example', database: 'ledger_test', companyId: 7, apiKey: key,
  }, new AbortController().signal)
  await expect(team.bindFinanceBot(writer.id, connector.id))
    .rejects.toMatchObject({ code: 'xiaojing/finance-connector', details: { reason: 'permissions' } })
  fetchMock
    .mockResolvedValueOnce(Response.json({ uid: 2 }))
    .mockResolvedValueOnce(Response.json([{ id: 9, name: 'Group Company', currency_id: [4, 'CNY'] }]))
    .mockResolvedValueOnce(Response.json([]))
  const groupConnector = await team.saveFinanceConnector({
    name: 'Group ledger test', url: 'https://groups.odoo.example', database: 'group_test', companyId: 9, apiKey: key,
  }, new AbortController().signal)
  expect(await team.financeBotBinding(cashier.id)).toBeNull()
  const nonOwner = initial.ctx.extend({
    invocation: { peer: { principal: { kind: 'katcats-cashier-fixture' } },
      request: { namespace: 'katcatsTeam', method: 'bindFinanceBot' } },
  })
  await expect(nonOwner.katcatsTeam.bindFinanceBot(cashier.id, connector.id)).rejects.toMatchObject({ code: 'remote-access/denied' })
  expect(await team.financeBotBinding(cashier.id)).toBeNull()
  await team.bindFinanceBot(cashier.id, connector.id)
  const role = 'Review cleared receipts and summarize sales journal entries.'
  const updated = await team.updateBot({ id: cashier.id, role })
  expect(updated.bot).toEqual({ ...cashier, role })
  expect(await team.financeBotBinding(cashier.id)).toBe(connector.id)
  const { chat } = await initial.ctx.katcatsChats.createChat({ name: 'Cashier group without a ledger', memberIds: [cashier.id] })
  expect(await initial.ctx.katcatsChats.financeBinding(chat.id)).toBeNull()
  await initial.close()

  const filename = 'journal-summary.md'
  const document = '# Journal summary\n\nSALE — Sales\n'
  const reopened = await memoryFixture([
    toolCallResponse('private-query', queryBot, { kind: 'journals' }),
    toolCallResponse('write-summary', 'write', { file_path: filename, content: document }),
    toolCallResponse('present-summary', 'present', { files: [{ path: filename }] }),
    textResponse('The sales journal summary is attached.'),
    toolCallResponse('plan-group', 'plan_group_work', { own_task: 'Check group ledger availability', assignments: [], review: { reason: 'none' } }),
    toolCallResponse('group-query', queryGroup, { kind: 'journals' }),
    textResponse('Bind a group ledger before querying here.'),
    toolCallResponse('plan-bound-group', 'plan_group_work', { own_task: 'List group journals', assignments: [], review: { reason: 'none' } }),
    toolCallResponse('bound-group-query', queryGroup, { kind: 'journals' }),
    textResponse('The group ledger has one bank journal.'),
    textResponse('The current private ledger is Group Company.'),
    textResponse('The private ledger is unbound.'),
  ], initial.root, {}, finance)
  Object.assign(reopened.ctx.loader.builtins, {
    'cashier-working-directory': WorkingDirectory, 'cashier-file-tools': FileTools, 'cashier-present': Present,
  })
  await reopened.ctx.loader.create({ name: 'cordis:cashier-working-directory', config: { defaultDirectory: reopened.root } })
  await reopened.ctx.loader.create({ name: 'cordis:cashier-file-tools', config: { read: true, readImage: false, write: true, edit: true } })
  await reopened.ctx.loader.create({ name: 'cordis:cashier-present', config: { maxFiles: 8 } })
  await reopened.ctx.loader.await()
  expect(await reopened.ctx.katcatsTeam.financeBotBinding(cashier.id)).toBe(connector.id)
  expect((await reopened.ctx.katcatsTeam.snapshot()).bots.find(bot => bot.id === cashier.id)).toEqual(updated.bot)
  const resolved = await reopened.ctx.sessionController.resolveAgent(cashier.sessionId)
  if (!('agent' in resolved)) throw new Error('Missing recovered private cashier Agent', { cause: resolved.error })
  expect(reopened.ctx.tools.get(queryBot, resolved.agent)).toBeDefined()
  expect(reopened.ctx.tools.get(queryGroup, resolved.agent)).toBeUndefined()
  fetchMock
    .mockResolvedValueOnce(Response.json([{ id: 17, code: 'SALE', name: 'Sales', type: 'sale', company_id: [7, 'Ledger Company'] }]))
    .mockResolvedValueOnce(Response.json(1))
  await expect(reopened.ctx.sessionController.prompt({
    sessionId: cashier.sessionId, mode: 'queue',
    requestId: brandString<SessionRequestId>('cashier-private-test'),
    content: [{ type: 'text', text: 'List journals in your private ledger and attach a Markdown summary.' }],
  }, new AbortController().signal)).resolves.toEqual({ accepted: true })
  await resolved.agent.whenIdle()
  expect(fetchMock).toHaveBeenCalledTimes(8)
  const privateLog = await reopened.ctx.sessionController.inspect(cashier.sessionId)
  const result = privateLog.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'private-query')
  expect(result?.type === 'tool/result' && result.data.message.isError).not.toBe(true)
  expect(result?.type === 'tool/result' && result.data.message.content).toEqual([{
    type: 'text', text: JSON.stringify({ connector: { id: connector.id, name: connector.name, type: 'odoo' },
      company: { id: 7, name: 'Ledger Company', currency: 'CNY' }, query: { kind: 'journals' },
      rows: [{ id: 17, code: 'SALE', name: 'Sales', type: 'sale' }], total: 1 }),
  }])
  const privateTools = reopened.adapter.requests.find(request => request.sessionId === cashier.sessionId)?.tools?.map(tool => tool.name)
  expect(privateTools).toEqual(expect.arrayContaining([queryBot, exportBot, 'read', 'edit', 'write', 'present']))
  const path = join(cashier.workDir, filename)
  expect(await readFile(path, 'utf8')).toBe(document)
  expect(privateLog.events.filter(event => event.type === 'deliverables/presented')).toMatchObject([
    { data: { callId: 'present-summary', files: [{ path }] } },
  ])
  expect(JSON.stringify(privateLog.events)).not.toContain(key)

  await runGroup(reopened, chat, 'cashier-unbound-group-test')
  const groupTools = reopened.adapter.requests.filter(request => request.sessionId === chat.executors[0]!.sessionId)
    .flatMap(request => request.tools?.map(tool => tool.name) ?? [])
  expect(groupTools).toContain(queryGroup)
  expect(groupTools).not.toContain(queryBot)
  expect(groupTools).not.toContain(exportBot)
  expect(fetchMock).toHaveBeenCalledTimes(8)
  const groupLog = await reopened.ctx.sessionController.inspect(chat.executors[0]!.sessionId)
  const denial = groupLog.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'group-query')
  expect(denial?.type === 'tool/result' && denial.data.message.isError).toBe(true)
  expect(denial?.type === 'tool/result' && JSON.stringify(denial.data.message.content)).toContain('Bind a verified finance connection')

  await bindAndObserveGroupFinance(reopened, chat, groupConnector.id)
  await reopened.ctx.katcatsTeam.bindFinanceBot(cashier.id, groupConnector.id)
  await reopened.ctx.katcatsTeam.bindFinanceBot(cashier.id, connector.id)
  expect(await reopened.ctx.katcatsChats.financeBinding(chat.id)).toBe(groupConnector.id)
  fetchMock
    .mockResolvedValueOnce(Response.json([{ id: 21, code: 'BANK', name: 'Bank', type: 'bank', company_id: [9, 'Group Company'] }]))
    .mockResolvedValueOnce(Response.json(1))
  await runGroup(reopened, chat, 'cashier-bound-group-test')
  expect(fetchMock).toHaveBeenCalledTimes(10)
  const boundLog = await reopened.ctx.sessionController.inspect(chat.executors[0]!.sessionId)
  const boundResult = boundLog.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'bound-group-query')
  expect(boundResult?.type === 'tool/result' && boundResult.data.message.content).toEqual([{
    type: 'text', text: JSON.stringify({ connector: { id: groupConnector.id, name: groupConnector.name, type: 'odoo' },
      company: { id: 9, name: 'Group Company', currency: 'CNY' }, query: { kind: 'journals' },
      rows: [{ id: 21, code: 'BANK', name: 'Bank', type: 'bank' }], total: 1 }),
  }])
  expect(JSON.stringify(boundLog.events)).not.toContain(key)
  await bindAndObserveGroupFinance(reopened, chat, null)

  await reopened.ctx.katcatsTeam.bindFinanceBot(cashier.id, groupConnector.id)
  await memorySend(resolved.agent, 'Which private ledger is active?')
  await reopened.ctx.katcatsTeam.bindFinanceBot(cashier.id, null)
  await memorySend(resolved.agent, 'Is a private ledger bound now?')
  const [changed, unbound] = reopened.adapter.requests.slice(-2).map(request => request.messages
    .filter(message => message.role === 'user' && message.source?.kind === 'runtime-context')
    .at(-1)?.content)
  expect(JSON.stringify(changed)).toContain('Group Company')
  expect(JSON.stringify(changed)).not.toContain('Ledger Company')
  expect(JSON.stringify(unbound)).toContain('Current finance ledger for this conversation is unbound')
  expect(await reopened.ctx.katcatsChats.financeBinding(chat.id)).toBeNull()
})

it('exports the private Bot’s company entries into a persisted Excel file card', async () => {
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ uid: 1 }))
    .mockResolvedValueOnce(Response.json([{ id: 7, name: '财务公司', currency_id: [4, 'CNY'] }]))
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(Response.json([{
      id: 32, move_id: [9, '凭证-009'], date: '2026-01-08', parent_state: 'posted',
      account_id: [12, '银行存款, "对账"'], name: '=1+2', debit: 15.25, credit: 0, company_id: [7, '财务公司'],
    }]))
    .mockResolvedValueOnce(Response.json(1))
  stubFinanceFetch(fetchMock)
  const h = await memoryFixture([
    toolCallResponse('create-export-cashier', createCashier, { name: '导出出纳' }),
    textResponse('已创建导出出纳。'),
    textResponse('已确认范围为 2026 年 1 月的已过账分录。'),
    toolCallResponse('export-with-path', exportBot, { kind: 'entries', from: '2026-01-01', to: '2026-01-31', path: '../outside.xlsx' }),
    toolCallResponse('export-entries', exportBot, { kind: 'entries', from: '2026-01-01', to: '2026-01-31' }),
    textResponse('已导出一条分录。'),
  ], undefined, {}, finance)
  const team = h.ctx.katcatsTeam
  const before = await team.snapshot()
  const main = before.bots.find(bot => bot.id === before.mainBotId)
  const mainAgent = main && h.ctx.agents.get(main.sessionId)
  if (mainAgent === undefined) throw new Error('Missing main fixture Agent')
  await memorySend(mainAgent, '请创建一位能够导出凭证分录的出纳。')
  const cashier = (await team.snapshot()).bots.find(bot => bot.name === '导出出纳')
  const agent = cashier && h.ctx.agents.get(cashier.sessionId)
  if (cashier === undefined || agent === undefined) throw new Error('Missing export cashier Agent')
  const connector = await team.saveFinanceConnector({
    name: '一月账套', url: 'https://odoo.example', database: 'ledger_test', companyId: 7, apiKey: key,
  }, new AbortController().signal)
  await team.bindFinanceBot(cashier.id, connector.id)
  const scope = '导出范围是 2026 年 1 月的已过账分录，先确认。'
  await memorySend(agent, scope)
  await memorySend(agent, '导出')

  const request = h.adapter.requests.find(request => request.sessionId === cashier.sessionId
    && request.messages.some(message => message.content.some(block => block.type === 'text' && block.text === '导出')))
  expect(request?.tools?.map(tool => tool.name).filter(name => name.endsWith('_finance')).sort()).toEqual([exportBot, queryBot])
  expect(request?.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))).toContain(scope)
  const calls = fetchMock.mock.calls.slice(3)
  expect(calls.map(([url]) => url)).toEqual([
    'https://odoo.example/json/2/account.move.line/search_read',
    'https://odoo.example/json/2/account.move.line/search_count',
  ])
  for (const [, options] of calls) {
    expect(JSON.parse(String(options?.body))).toMatchObject({
      context: { allowed_company_ids: [7] },
      domain: expect.arrayContaining([
        ['company_id', '=', 7], ['parent_state', '=', 'posted'], ['date', '>=', '2026-01-01'], ['date', '<=', '2026-01-31'],
      ]),
    })
  }

  await h.close()
  const cold = await memoryFixture([], h.root, {}, finance)
  const { events } = await cold.ctx.sessionController.inspect(cashier.sessionId)
  const presentations = events.filter(event => event.type === 'deliverables/presented')
  expect(presentations).toHaveLength(1)
  const presentation = presentations[0]!
  expect(presentation.data).toMatchObject({ callId: 'export-entries', turn: 2 })
  expect(presentation.data.files).toHaveLength(1)
  const file = presentation.data.files[0]!
  const filename = basename(file.path)
  expect(filename).toMatch(/^凭证分录-[0-9a-f-]{36}\.xlsx$/u)
  expect(file.path).toBe(join(cashier.workDir, filename))
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(file.path)
  const worksheet = workbook.getWorksheet('凭证分录')
  if (worksheet === undefined) throw new Error('Missing journal entries worksheet')
  expect(worksheet.rowCount).toBe(2)
  expect(worksheet.getRow(1).values).toEqual([
    undefined, '公司', '账套', '凭证号', '记账日期', '状态', '会计科目', '分录摘要', '借方金额', '贷方金额', '币别',
  ])
  expect(worksheet.getRow(2).values).toEqual([
    undefined, '财务公司', '一月账套', '凭证-009', '2026-01-08', 'posted', '银行存款, "对账"', '=1+2', 15.25, 0, 'CNY',
  ])
  expect(worksheet.getCell('G2').type).toBe(ExcelJS.ValueType.String)
  const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'export-entries')
  expect(result).toMatchObject({ data: { message: { isError: false, content: [{
    type: 'text', text: JSON.stringify({ filename, row_count: 1, company: '财务公司', ledger: '一月账套' }),
  }] } } })
  expect(events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'export-with-path'))
    .toMatchObject({ data: { message: { isError: true } } })
  expect(JSON.stringify(events)).not.toContain(key)
  expect(cold.adapter.requests).toEqual([])
})

it('creates a complete team from finance templates and keeps the editorial batch ordinary', async () => {
  const members = [
    { name: '出纳', preset: 'cashier' },
    { name: '总账', preset: 'general-ledger' },
    { name: '报表', preset: 'reporting' },
    { name: '税务', preset: 'tax' },
    { name: '成本', preset: 'cost' },
    { name: '审计', preset: 'audit' },
    { name: '财务分析', preset: 'analysis' },
    { name: '财务资料', preset: 'documents' },
  ] as const
  let memberIds: readonly BotId[] = []
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ uid: 1 }))
    .mockResolvedValueOnce(Response.json([{ id: 7, name: 'Ledger Company', currency_id: [4, 'CNY'] }]))
    .mockResolvedValueOnce(Response.json([]))
  stubFinanceFetch(fetchMock)
  const initial = await memoryFixture([
    toolCallResponse('create-finance-team', 'create_finance_bots', { bots: members }),
    toolCallResponse('create-editorial-team', 'create_bots', { bots: [{ name: '财务文案', role: '撰写财务活动的宣传文案。' }] }),
    textResponse('The eight finance specialists and the writer are ready.'),
    () => toolCallResponse('create-finance-group', 'create_group_chat', { name: '财务团队', member_ids: memberIds }),
    textResponse('The finance group is ready.'),
  ], undefined, {}, finance)
  const team = initial.ctx.katcatsTeam
  const before = await team.snapshot()
  const main = before.bots.find(bot => bot.id === before.mainBotId)
  const mainAgent = main && initial.ctx.agents.get(main.sessionId)
  if (mainAgent === undefined) throw new Error('Missing main fixture Agent')
  await expect(initial.ctx.tools.execute({
    name: 'create_finance_bots', agent: mainAgent, callId: ToolCallId('invalid-finance-batch'),
    signal: new AbortController().signal,
    arguments: { bots: [
      { name: '不应创建的出纳', preset: 'cashier' },
      { name: '无法分配的税务', preset: 'tax', group_id: 'missing-fixture-group' },
    ] },
  })).resolves.toMatchObject({ isError: true, error: { info: { code: 'KATCATS_TOOL_INVALID_INPUT' } } })
  expect(await team.snapshot()).toEqual(before)
  await memorySend(mainAgent, '请创建出纳、总账、报表、税务、成本、审计、财务分析和财务资料八个财务岗位，再创建一位写宣传文案的财务文案。')
  const createRequest = initial.adapter.requests[0]
  const guidance = createRequest?.messages
    .flatMap(message => message.content.flatMap(block => block.type === 'text' ? block.text.split('\n') : []))
    .find(line => line.includes('create_finance_bots call'))
  expect(guidance).toBeDefined()
  expect({
    guidance: guidance?.split(/(?<=\.) /u),
    tools: createRequest?.tools?.map(tool => tool.name).filter(name => name.includes('finance')).sort(),
  }).toMatchInlineSnapshot(`
    {
      "guidance": [
        "For a finance team doing accounting, create the new ledger-facing members in one create_finance_bots call, choosing a fixed template for each, then use their saved IDs to create the group.",
        "For a single ledger-facing Bot use create_finance_bot with the matching preset.",
        "Finance-themed writing and publicity use ordinary creation.",
        "Split mixed teams into separate finance and ordinary batches.",
        "Ask about duties when ledger access is ambiguous.",
        "A group ledger is shared inside its group.",
        "The owner may also bind one ledger in each dedicated finance Bot’s settings for its private chat.",
        "When replacing existing ordinary members with dedicated finance Bots, confirm with the owner first.",
      ],
      "tools": [
        "create_finance_bot",
        "create_finance_bots",
      ],
    }
  `)

  const { bots } = await team.snapshot()
  const specialists = bots.filter(bot => bot.financePreset !== undefined)
  expect(specialists).toHaveLength(members.length)
  expect(specialists.map(bot => ({ name: bot.name, preset: bot.financePreset }))).toEqual(expect.arrayContaining([...members]))
  memberIds = specialists.map(bot => bot.id)
  const tax = specialists.find(bot => bot.financePreset === 'tax')
  const writer = bots.find(bot => bot.name === '财务文案')
  if (tax === undefined || writer === undefined) throw new Error('The main Agent did not create the tax specialist and writer')
  expect(writer.financePreset).toBeUndefined()
  const writerAgent = initial.ctx.agents.get(writer.sessionId)
  if (writerAgent === undefined) throw new Error('Missing writer fixture Agent')
  expect(initial.ctx.tools.get('create_finance_bots', writerAgent)).toBeUndefined()
  expect(initial.ctx.tools.get(queryBot, writerAgent)).toBeUndefined()

  await memorySend(mainAgent, '把刚创建的八位财务专员组建为财务团队。')
  const group = (await initial.ctx.katcatsChats.snapshot()).chats.find(chat => chat.name === '财务团队')
  expect(group?.memberIds).toEqual(memberIds)
  const connector = await team.saveFinanceConnector({
    name: 'Finance test', url: 'https://odoo.example', database: 'ledger_test', companyId: 7, apiKey: key,
  }, new AbortController().signal)
  await expect(team.bindFinanceBot(writer.id, connector.id))
    .rejects.toMatchObject({ code: 'xiaojing/finance-connector', details: { reason: 'permissions' } })
  await team.bindFinanceBot(tax.id, connector.id)
  await initial.close()

  const reopened = await memoryFixture([
    toolCallResponse('tax-query', queryBot, { kind: 'journals' }),
    textResponse('The ledger has one sales journal.'),
  ], initial.root, {}, finance)
  const restored = (await reopened.ctx.katcatsTeam.snapshot()).bots.filter(bot => memberIds.includes(bot.id))
  expect(restored.map(bot => ({ name: bot.name, preset: bot.financePreset }))).toEqual(expect.arrayContaining([...members]))
  expect(await reopened.ctx.katcatsTeam.financeBotBinding(tax.id)).toBe(connector.id)
  const resolved = await reopened.ctx.sessionController.resolveAgent(tax.sessionId)
  if (!('agent' in resolved)) throw new Error('Missing restored tax specialist Agent', { cause: resolved.error })
  expect(reopened.ctx.tools.get(queryBot, resolved.agent)).toBeDefined()
  fetchMock
    .mockResolvedValueOnce(Response.json([{ id: 17, code: 'SALE', name: 'Sales', type: 'sale', company_id: [7, 'Ledger Company'] }]))
    .mockResolvedValueOnce(Response.json(1))
  await memorySend(resolved.agent, '列出我绑定账套的日记账。')
  expect(fetchMock).toHaveBeenCalledTimes(5)
  const taxLog = await reopened.ctx.sessionController.inspect(tax.sessionId)
  const result = taxLog.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'tax-query')
  expect(result?.type === 'tool/result' && result.data.message.content).toEqual([{
    type: 'text', text: JSON.stringify({ connector: { id: connector.id, name: connector.name, type: 'odoo' },
      company: { id: 7, name: 'Ledger Company', currency: 'CNY' }, query: { kind: 'journals' },
      rows: [{ id: 17, code: 'SALE', name: 'Sales', type: 'sale' }], total: 1 }),
  }])
})
