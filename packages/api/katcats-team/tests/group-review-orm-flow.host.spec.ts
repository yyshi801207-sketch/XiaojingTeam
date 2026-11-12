/** Reviewed group ORM writes retain their exact authorization and uncertain outcomes across restart. */
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import Approval, { type ApprovalAnswer } from '@deepseek-ai/dsh-user-approval'
import { FINANCE_ORM_UNKNOWN_OUTCOME } from '../src/finance-orm-tool.ts'
import { memoryFixture } from './memory-fixture.ts'
import { stubFinanceFetch } from './finance-fetch-fixture.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

afterEach(() => { vi.unstubAllGlobals() })

it.each(['confirmed', 'unknown'] as const)('keeps group writes reviewed and %s after dispatch', async outcome => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ uid: 2 }))
    .mockResolvedValueOnce(Response.json([{ id: 7, name: 'Fixture company', currency_id: [4, 'CNY'] }]))
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(Response.json([{ id: 13, state: 'draft' }]))
  if (outcome === 'confirmed') fetcher.mockResolvedValueOnce(Response.json(true))
    .mockResolvedValueOnce(Response.json([{ id: 13, state: 'posted' }]))
  else fetcher.mockRejectedValueOnce(new TypeError('Synthetic lost write response'))
  stubFinanceFetch(fetcher)
  let reviewerId = ''
  const operation = { model: 'account.move', method: 'action_post', parameters_json: '{"ids":[13]}' }
  const record = (id: string, submit = false) => toolCallResponse(id, 'record_group_task', {
    goal: 'Post voucher 13.', acceptance: ['The actual posted voucher is independently reviewed.'],
    stage: submit ? 'delivered' : 'preparing', next_step: submit ? 'Finished.' : 'Review and post.',
    artifacts: [], ...(submit ? { submit_delivery: true } : {}),
  })
  const h = await memoryFixture([
    record('record-write'),
    () => toolCallResponse('plan-write', 'plan_group_work', { own_task: 'Post voucher 13.', assignments: [],
      review: { reason: 'data-change', reviewer_bot_id: reviewerId } }),
    toolCallResponse('read-before-review', 'call_group_odoo_orm', { model: 'account.move', method: 'read',
      parameters_json: '{"ids":[13],"fields":["state"]}' }),
    toolCallResponse('unreviewed-write', 'call_group_odoo_orm', { ...operation, summary: 'Post voucher 13.' }),
    () => toolCallResponse('request-write-review', 'request_group_member', { bot_id: reviewerId,
      message: 'Check this precise posting request.', review_candidate: { odoo_operation: operation } }),
    toolCallResponse('approve-write-review', 'submit_group_review', { verdict: 'approved', findings: 'Voucher 13 and destination verified.' }),
    textResponse('The posting request is approved.'),
    toolCallResponse('changed-write', 'call_group_odoo_orm', { ...operation, parameters_json: '{"ids":[14]}', summary: 'Post voucher 14.' }),
    toolCallResponse('reviewed-write', 'call_group_odoo_orm', { ...operation, summary: 'Post voucher 13.' }),
    ...(outcome === 'unknown' ? [] : [
      toolCallResponse('read-posted-result', 'call_group_odoo_orm', { model: 'account.move', method: 'read',
        parameters_json: '{"ids":[13],"fields":["state"]}' }),
      () => toolCallResponse('request-final-review', 'request_group_member', { bot_id: reviewerId,
        message: 'Verify the posting receipt.', review_candidate: { text: 'Voucher 13 was posted.' } }),
      toolCallResponse('approve-final-review', 'submit_group_review', { verdict: 'approved', findings: 'The posting receipt confirms voucher 13.' }),
      textResponse('The actual posting is verified.'),
      record('submit-write', true),
      textResponse('Voucher 13 was posted.'),
    ]),
  ], undefined, {}, { financeConnectors: true })
  h.ctx.loader.builtins['group-write-approval'] = Approval
  await h.ctx.loader.create({ name: 'cordis:group-write-approval' })
  await h.ctx.loader.await()
  const approvals = vi.fn(async (): Promise<ApprovalAnswer> => 'allowed-once')
  h.ctx.on('approval/request', approvals)
  const author = (await h.ctx.katcatsTeam.createBot({ name: 'Author' })).bot
  const reviewer = (await h.ctx.katcatsTeam.createBot({ name: 'Reviewer' })).bot
  reviewerId = reviewer.id
  const chat = (await h.ctx.katcatsChats.createChat({ name: 'Reviewed writes', memberIds: [author.id, reviewer.id], managerId: author.id })).chat
  const connector = await h.ctx.katcatsTeam.saveFinanceConnector({ name: 'Synthetic ledger', url: 'https://odoo.example',
    database: 'test', companyId: 7, apiKey: '1111222233334444555566667777888899990000', accessMode: 'full' }, new AbortController().signal)
  await h.ctx.katcatsChats.bindFinance(chat.id, connector.id)
  const abort = new AbortController()
  try {
    await h.ctx.katcatsChats.sendMessage({ sessionId: chat.rootSessionId, mode: 'queue',
      requestId: brandString<SessionRequestId>('reviewed-write-owner'), content: [{ type: 'text', text: 'Post voucher 13.' }] }, abort.signal)
    for await (const frame of h.ctx.katcatsChats.follow(abort.signal)) {
      if (frame.value.activities.find(activity => activity.chatId === chat.id)?.processing === false) break
    }
  } finally { abort.abort() }
  const state = await h.ctx.katcatsChats.snapshot()
  const parent = state.deliveries[0]!
  const log = await h.ctx.sessionController.inspect(parent.executorSessionId)
  const expectedRequests = outcome === 'confirmed' ? 6 : 5
  expect(fetcher).toHaveBeenCalledTimes(expectedRequests)
  expect(approvals).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[4]?.[0]).toBe('https://odoo.example/json/2/account.move/action_post')
  expect(JSON.parse(String(fetcher.mock.calls[4]?.[1]?.body))).toEqual({ ids: [13], context: { allowed_company_ids: [7] } })
  expect(log.events.flatMap(event => event.type === 'tool/result'
    && ['read-before-review', 'unreviewed-write', 'changed-write'].includes(event.data.message.source.callId)
    ? [{ call: event.data.message.source.callId, failed: event.data.message.isError === true }] : []))
    .toMatchInlineSnapshot(`
      [
        {
          "call": "read-before-review",
          "failed": false,
        },
        {
          "call": "unreviewed-write",
          "failed": true,
        },
        {
          "call": "changed-write",
          "failed": true,
        },
      ]
    `)
  expect(parent).toMatchObject(outcome === 'confirmed'
    ? { state: 'completed', receipt: { text: 'Voucher 13 was posted.' } }
    : { state: 'unknown', receipt: null, error: { code: FINANCE_ORM_UNKNOWN_OUTCOME } })
  if (outcome === 'confirmed') expect(state.chats[0]?.tickets?.[0]?.state).toBe('completed')
  await h.close()
  const cold = await memoryFixture([], h.root, {}, { financeConnectors: true })
  expect((await cold.ctx.katcatsChats.snapshot()).deliveries[0]).toMatchObject({ state: parent.state, receipt: parent.receipt })
  expect(cold.adapter.requests).toHaveLength(0)
  expect(fetcher).toHaveBeenCalledTimes(expectedRequests)
})
