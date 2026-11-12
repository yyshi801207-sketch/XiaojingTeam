/** Full Odoo access remains bound to the owner’s ledger and its approval request. */
import { afterEach, expect, it, vi } from 'vitest'
import Approval, { type ApprovalAnswer } from '@deepseek-ai/dsh-user-approval'
import { memoryFixture, memorySend } from './memory-fixture.ts'
import { stubFinanceFetch } from './finance-fetch-fixture.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { FINANCE_ORM_UNKNOWN_OUTCOME } from '../src/finance-orm-tool.ts'

afterEach(() => { vi.unstubAllGlobals() })

it('queries supplier records and executes a public Odoo action only after confirmation', async () => {
  const key = '0000111122223333444455556666777788889999'
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ uid: 2 }))
    .mockResolvedValueOnce(Response.json([{ id: 7, name: 'Fixture company', currency_id: [4, 'CNY'] }]))
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(Response.json([{ id: 29, name: 'Example Supplier' }]))
    .mockResolvedValueOnce(Response.json(true))
    .mockResolvedValueOnce(Response.json([37]))
  stubFinanceFetch(fetcher)
  const call = 'call_bot_odoo_orm'
  const action = { model: 'account.move', method: 'action_post', parameters_json: '{"ids":[13]}', summary: '确认过账凭证 13。' }
  const draft = { move_type: 'entry', date: '2026-02-11', journal_id: 5,
    line_ids: [[0, 0, { account_id: 3, debit: 100 }], [0, 0, { account_id: 8, credit: 100 }]] }
  const draftBody = { vals_list: [draft], context: { allowed_company_ids: [7] } }
  const h = await memoryFixture([
    toolCallResponse('new-orm-finance-bot', 'create_finance_bot', { name: '会计', preset: 'general-ledger' }),
    textResponse('会计已创建。'),
    toolCallResponse('find-supplier', call, { model: 'res.partner', method: 'search_read',
      parameters_json: '{"domain":[["supplier_rank",">",0]],"fields":["id","name"],"limit":10}' }),
    textResponse('已查询到供应商。'),
    toolCallResponse('declined-post', call, action),
    textResponse('该凭证未执行过账。'),
    toolCallResponse('confirmed-post', call, action),
    textResponse('过账成功。'),
    toolCallResponse('confirmed-create', call, { model: 'account.move', method: 'create',
      parameters_json: JSON.stringify({ vals: draft }), summary: '确认创建凭证草稿。' }),
    textResponse('已创建凭证草稿。'),
  ], undefined, {}, { financeConnectors: true })
  h.ctx.loader.builtins['orm-approval'] = Approval
  await h.ctx.loader.create({ name: 'cordis:orm-approval' })
  await h.ctx.loader.await()
  const approvals = vi.fn(async (request: { reason?: string }): Promise<ApprovalAnswer> => {
    expect(request.reason).toContain('Fixture company')
    if (approvals.mock.calls.length === 3) {
      expect(fetcher).toHaveBeenCalledTimes(5)
      const [, , operation, ...params] = request.reason?.split('\n') ?? []
      expect(operation).toBe('account.move.create')
      expect(JSON.parse(params.join('\n'))).toEqual(draftBody)
      return 'allowed-once'
    }
    expect(request.reason).toContain('account.move.action_post')
    return approvals.mock.calls.length === 1 ? 'rejected' : 'allowed-once'
  })
  h.ctx.on('approval/request', approvals)
  const team = h.ctx.katcatsTeam
  const directory = await team.snapshot()
  const main = directory.bots.find(bot => bot.id === directory.mainBotId)
  const mainAgent = main && h.ctx.agents.get(main.sessionId)
  if (mainAgent === undefined) throw new Error('Missing main agent')
  await memorySend(mainAgent, '创建会计 Bot，放到未分组。')
  const bot = (await team.snapshot()).bots.find(item => item.name === '会计')
  const agent = bot && h.ctx.agents.get(bot.sessionId)
  if (bot === undefined || agent === undefined) throw new Error('Missing finance agent')
  const connector = await team.saveFinanceConnector({ name: '测试账套', url: 'https://odoo.example',
    database: 'finance_test', companyId: 7, apiKey: key, accessMode: 'full' }, new AbortController().signal)
  await team.bindFinanceBot(bot.id, connector.id)

  await memorySend(agent, '查询供应商。')
  expect(approvals).not.toHaveBeenCalled()
  expect(fetcher.mock.calls[3]?.[0]).toBe('https://odoo.example/json/2/res.partner/search_read')
  await memorySend(agent, '过账凭证 13。')
  expect(approvals).toHaveBeenCalledTimes(1)
  expect(fetcher).toHaveBeenCalledTimes(4)
  await memorySend(agent, '请再次发起凭证 13 的过账确认。')
  expect(approvals).toHaveBeenCalledTimes(2)
  expect(fetcher).toHaveBeenCalledTimes(5)
  const dispatched = fetcher.mock.calls[4]
  expect(dispatched?.[0]).toBe('https://odoo.example/json/2/account.move/action_post')
  expect(JSON.parse(String(dispatched?.[1]?.body))).toMatchObject({ ids: [13], context: { allowed_company_ids: [7] } })

  await memorySend(agent, '创建一张凭证草稿。')
  expect(approvals).toHaveBeenCalledTimes(3)
  expect(fetcher).toHaveBeenCalledTimes(6)
  const created = fetcher.mock.calls[5]
  expect(created?.[0]).toBe('https://odoo.example/json/2/account.move/create')
  expect(JSON.parse(String(created?.[1]?.body))).toEqual(draftBody)
  const { events } = await h.ctx.sessionController.inspect(bot.sessionId)
  expect(events.filter(event => event.type === 'tool/result' && event.data.message.toolCallId === 'declined-post'))
    .toMatchObject([{ data: { message: { isError: true } } }])
  expect(events.filter(event => event.type === 'tool/result' && event.data.message.toolCallId === 'confirmed-create'))
    .toMatchObject([{ data: { message: { content: [{ type: 'text', text: expect.stringContaining('"data":[37]') }] } } }])
  expect(JSON.stringify(events)).toContain('Example Supplier')
  expect(JSON.stringify(events)).not.toContain(key)
})

it.each([
  { method: 'write', failure: 'network', code: FINANCE_ORM_UNKNOWN_OUTCOME },
  { method: 'write', failure: 'rejected', code: 'KATCATS_ODOO_CALL' },
  { method: 'search_read', failure: 'network', code: 'KATCATS_ODOO_CALL' },
])('persists $method/$failure as $code without repeating the request', async ({ method, failure, code }) => {
  const key = '1111222233334444555566667777888899990000'
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ uid: 2 }))
    .mockResolvedValueOnce(Response.json([{ id: 7, name: 'Fixture company', currency_id: [4, 'CNY'] }]))
    .mockResolvedValueOnce(Response.json([]))
  if (failure === 'network') fetcher.mockRejectedValueOnce(new TypeError('simulated lost response'))
  else fetcher.mockResolvedValueOnce(Response.json({ name: 'odoo.exceptions.ValidationError' }, { status: 400 }))
  stubFinanceFetch(fetcher)
  const h = await memoryFixture([
    toolCallResponse('new-outcome-bot', 'create_finance_bot', { name: '会计', preset: 'general-ledger' }),
    textResponse('会计已创建。'),
    toolCallResponse('observe-outcome', 'call_bot_odoo_orm', { model: 'res.partner', method,
      parameters_json: JSON.stringify(method === 'write' ? { ids: [15], vals: { name: 'Synthetic supplier' } } : { fields: ['id', 'name'] }),
      summary: '核对供应商。' }),
    textResponse('操作未确认完成，请先核对账套记录。'),
  ], undefined, {}, { financeConnectors: true })
  h.ctx.loader.builtins['orm-outcome-approval'] = Approval
  await h.ctx.loader.create({ name: 'cordis:orm-outcome-approval' })
  await h.ctx.loader.await()
  const approvals = vi.fn(async (): Promise<ApprovalAnswer> => 'allowed-once')
  h.ctx.on('approval/request', approvals)
  const team = h.ctx.katcatsTeam
  const directory = await team.snapshot()
  const main = directory.bots.find(bot => bot.id === directory.mainBotId)
  const mainAgent = main && h.ctx.agents.get(main.sessionId)
  if (mainAgent === undefined) throw new Error('Missing main agent')
  await memorySend(mainAgent, '创建会计 Bot，放到未分组。')
  const bot = (await team.snapshot()).bots.find(item => item.name === '会计')
  const agent = bot && h.ctx.agents.get(bot.sessionId)
  if (bot === undefined || agent === undefined) throw new Error('Missing finance agent')
  const connector = await team.saveFinanceConnector({ name: '测试账套', url: 'https://odoo.example',
    database: 'finance_test', companyId: 7, apiKey: key, accessMode: 'full' }, new AbortController().signal)
  await team.bindFinanceBot(bot.id, connector.id)

  await memorySend(agent, '处理供应商。')
  const { events } = await h.ctx.sessionController.inspect(bot.sessionId)
  expect(events.filter(event => event.type === 'tool/result' && event.data.message.toolCallId === 'observe-outcome'))
    .toMatchObject([{ data: { error: { code }, message: { isError: true } } }])
  if (code === FINANCE_ORM_UNKNOWN_OUTCOME) {
    expect(events.flatMap(event => event.type === 'tool/result' && event.data.message.toolCallId === 'observe-outcome'
      ? [{ error: event.data.error, content: event.data.message.content }] : [])).toMatchInlineSnapshot(`
        [
          {
            "content": [
              {
                "text": "Error: Odoo may have applied the operation. Check the records in Odoo before attempting it again.",
                "type": "text",
              },
            ],
            "error": {
              "code": "KATCATS_ODOO_UNKNOWN_OUTCOME",
              "name": "HarnessError",
            },
          },
        ]
      `)
  }
  expect(approvals).toHaveBeenCalledTimes(method === 'write' ? 1 : 0)
  expect(fetcher).toHaveBeenCalledTimes(4)
  expect(fetcher.mock.calls[3]?.[0]).toBe(`https://odoo.example/json/2/res.partner/${method}`)
  expect(JSON.stringify(events)).not.toContain(key)
})
