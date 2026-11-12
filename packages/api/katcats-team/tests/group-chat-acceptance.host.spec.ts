/** Owner confirmations in the transcript close only their exact published business task. */
import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionPromptRequest, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { memoryFixture } from './memory-fixture.ts'
import { stubFinanceFetch } from './finance-fetch-fixture.ts'

function taskDescription(goal: string) {
  return { goal, acceptance: ['Match the original evidence'], stage: 'Ready', next_step: 'Review the saved result', artifacts: [] }
}

function deliveredTask(goal: string, index: number, requireHumanReview = true) {
  const description = taskDescription(goal)
  return [
    toolCallResponse(`record-${index}`, 'record_group_task', requireHumanReview ? { ...description, human_review_required: true } : description),
    toolCallResponse(`submit-${index}`, 'record_group_task', { ...description, submit_delivery: true }),
    textResponse('The source records match the submitted result.'),
  ]
}

async function fixture(script: Parameters<typeof memoryFixture>[0], financeConnectors = false) {
  const h = await memoryFixture(script, undefined, {}, { financeConnectors })
  const manager = (await h.ctx.katcatsTeam.createBot({ name: 'Manager' })).bot
  const chat = (await h.ctx.katcatsChats.createChat({ name: 'Tasks', memberIds: [manager.id], managerId: manager.id })).chat
  const signal = new AbortController().signal
  const request = (id: string, text: string): SessionPromptRequest => ({
    sessionId: chat.rootSessionId, requestId: brandString<SessionRequestId>(id), mode: 'queue', content: [{ type: 'text', text }],
  })
  const send = (input: SessionPromptRequest) => h.ctx.katcatsChats.sendMessage(input, signal)
  const tasks = async () => (await h.ctx.katcatsChats.snapshot()).chats.find(item => item.id === chat.id)?.tickets ?? []
  const idle = () => expect.poll(async () => (await h.ctx.katcatsChats.snapshot()).activities
    .find(item => item.chatId === chat.id)?.processing, { timeout: 10_000 }).toBe(false)
  const submit = async (id: string, goal: string) => {
    await send(request(id, goal))
    await idle()
    const task = (await tasks()).find(item => item.goal === goal)!
    expect(task.state).toBe('delivered')
    return task
  }
  return { ...h, chat, signal, request, send, tasks, idle, submit }
}

async function loggedConfirmationCount(ctx: Context, request: SessionPromptRequest) {
  const transcript = await ctx.sessionController.inspect(request.sessionId)
  return transcript.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user'
    && 'rpcId' in event.data.source && event.data.source.rpcId === request.requestId).length
}

describe('group chat task acceptance', () => {
  it('persists and replays a standalone acceptance of the sole delivery without dispatching a member', async () => {
    const goal = 'Reconcile the ledger'
    const h = await fixture(deliveredTask(goal, 1))
    const task = await h.submit('initial-request', goal)
    const confirmation = h.request('confirm-ledger', '验收通过。')
    const result = { accepted: true, taskAcceptance: { kind: 'completed', taskId: task.id, goal } }

    expect(await h.send(confirmation)).toEqual(result)
    const [completed] = await h.tasks()
    expect(completed).toMatchObject({ id: task.id, state: 'completed', revision: task.revision + 1, delivery: task.delivery })
    expect(completed?.completedAt).toBeGreaterThan(0)
    expect(await loggedConfirmationCount(h.ctx, confirmation)).toBe(1)
    expect(h.adapter.requests).toHaveLength(3)
    await h.close()

    const reopened = await memoryFixture([], h.root)
    expect(await reopened.ctx.katcatsChats.sendMessage(confirmation, h.signal)).toEqual(result)
    expect(await loggedConfirmationCount(reopened.ctx, confirmation)).toBe(1)
    expect((await reopened.ctx.katcatsChats.snapshot()).chats[0]?.tickets?.[0]).toEqual(completed)
    expect(reopened.adapter.requests).toHaveLength(0)
    await reopened.close()
  })

  it('asks which delivery to accept and binds one exact revision to that confirmation', async () => {
    const firstGoal = 'Review the opening balance'
    const secondGoal = 'Review the closing balance'
    const h = await fixture([...deliveredTask(firstGoal, 1), ...deliveredTask(secondGoal, 2)])
    const first = await h.submit('opening', firstGoal)
    const second = await h.submit('closing', secondGoal)
    const confirmation = h.request('choose-balance', '验收通过')
    const expectedCandidates = [first, second].map(task => ({ taskId: task.id, goal: task.goal, revision: task.revision }))

    const result = await h.send(confirmation)
    expect(result).toMatchObject({ accepted: true, taskAcceptance: { kind: 'choose', chatId: h.chat.id,
      candidates: expect.arrayContaining(expectedCandidates) } })
    expect(await h.tasks()).toEqual([first, second])
    expect(await h.send(confirmation)).toEqual(result)
    expect(await loggedConfirmationCount(h.ctx, confirmation)).toBe(1)

    await expect(h.ctx.katcatsChats.completeTask(h.chat.id, first.id, first.revision - 1, confirmation.requestId)).rejects.toThrow()
    const completed = await h.ctx.katcatsChats.completeTask(h.chat.id, first.id, first.revision, confirmation.requestId)
    expect(completed.chat.tickets).toMatchObject([{ id: first.id, state: 'completed', revision: first.revision + 1 }, second])
    expect((await h.ctx.katcatsChats.completeTask(h.chat.id, first.id, first.revision, confirmation.requestId)).chat.tickets)
      .toEqual(completed.chat.tickets)
    await expect(h.ctx.katcatsChats.completeTask(h.chat.id, second.id, second.revision, confirmation.requestId)).rejects.toThrow()
    expect(await h.tasks()).toEqual(completed.chat.tickets)
    expect(h.adapter.requests).toHaveLength(6)
    await h.close()
  })

  it('keeps a saved chat confirmation from accepting a delivery after the group switches ledgers', async () => {
    const firstGoal = 'Review the opening balance'
    const secondGoal = 'Review the closing balance'
    const h = await fixture([...deliveredTask(firstGoal, 1), ...deliveredTask(secondGoal, 2)], true)
    const first = await h.submit('opening', firstGoal)
    const second = await h.submit('closing', secondGoal)
    const confirmation = h.request('choose-balance', '验收通过')
    expect(await h.send(confirmation)).toMatchObject({ taskAcceptance: { kind: 'choose' } })

    stubFinanceFetch(vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ uid: 1 }))
      .mockResolvedValueOnce(Response.json([{ id: 7, name: 'New ledger company', currency_id: [4, 'CNY'] }]))
      .mockResolvedValueOnce(Response.json([])))
    try {
      const connector = await h.ctx.katcatsTeam.saveFinanceConnector({ name: 'New ledger', url: 'https://ledger.example',
        database: 'ledger_test', companyId: 7, apiKey: '0000111122223333444455556666777788889999' }, h.signal)
      await h.ctx.katcatsChats.bindFinance(h.chat.id, connector.id)
      await expect(h.ctx.katcatsChats.completeTask(h.chat.id, first.id, first.revision, confirmation.requestId)).rejects.toThrow()
      expect(await h.send(h.request('current-ledger', '验收通过'))).toMatchObject({ taskAcceptance: { kind: 'none' } })
      expect(await h.tasks()).toEqual([first, second])
      expect(h.adapter.requests).toHaveLength(6)
    } finally { vi.unstubAllGlobals() }
    await h.close()
  })

  it('does not require another confirmation after ordinary work has completed by its criteria', async () => {
    const goal = 'Review the first statement'
    const h = await fixture([...deliveredTask(goal, 1, false), textResponse('Understood.')])
    await h.send(h.request('statement', goal))
    await h.idle()
    expect((await h.tasks())[0]).toMatchObject({ state: 'completed', completionKind: 'criteria' })
    expect(await h.send(h.request('short-acceptance', '可以了'))).toEqual({ accepted: true })
    await h.idle()
    expect(h.adapter.requests).toHaveLength(4)
    await h.close()
  })

  it('keeps qualified, negative and unrelated short replies on the ordinary chat path', async () => {
    const goal = 'Review the statement'
    const h = await fixture([...deliveredTask(goal, 1), textResponse('Will revise the statement.'),
      textResponse('I will wait for the source records.'), textResponse('Understood.')])
    const task = await h.submit('statement', goal)
    for (const [id, reply] of [
      ['qualified', '验收通过后，再处理下一份。'], ['negative', '验收未通过。'], ['unrelated', '可以了'],
    ] as const) {
      expect(await h.send(h.request(id, reply))).toEqual({ accepted: true })
      await h.idle()
    }
    expect(await h.tasks()).toEqual([task])
    expect(h.adapter.requests).toHaveLength(6)
    await h.close()
  })

  it('retains the human review requirement and never accepts unfinished work', async () => {
    const goal = 'Review accounting records'
    const h = await fixture([
      toolCallResponse('record', 'record_group_task', { ...taskDescription(goal), human_review_required: true }),
      textResponse('The original evidence is still being gathered.'),
      toolCallResponse('blocker', 'report_group_blocker', { reason: 'Missing source records', next_step: 'Ask for the records', effects: 'none' }),
    ])
    await h.send(h.request('initial-request', goal))
    await h.idle()
    const [task] = await h.tasks()
    expect(task).toMatchObject({ state: 'blocked', humanReviewRequired: true })
    const confirmation = h.request('early-review', '人工复核通过')
    expect(await h.send(confirmation)).toMatchObject({ accepted: true, taskAcceptance: { kind: 'none' } })
    expect(await loggedConfirmationCount(h.ctx, confirmation)).toBe(1)
    expect(await h.tasks()).toEqual([task])
    expect(h.adapter.requests).toHaveLength(3)
    await h.close()
  })

  it('requires explicit owner review for a delivery marked for human review', async () => {
    const goal = 'Review the balance comparison'
    const h = await fixture(deliveredTask(goal, 1, true))
    const task = await h.submit('initial-request', goal)
    expect(task.humanReviewRequired).toBe(true)

    expect(await h.send(h.request('short-reply', '可以了'))).toEqual({
      accepted: true, taskAcceptance: { kind: 'choose', chatId: h.chat.id,
        candidates: [{ taskId: task.id, goal, revision: task.revision }] },
    })
    expect(await h.tasks()).toEqual([task])
    expect(await h.send(h.request('explicit-review', '人工复核通过'))).toEqual({
      accepted: true, taskAcceptance: { kind: 'completed', taskId: task.id, goal },
    })
    expect((await h.tasks())[0]).toMatchObject({ state: 'completed', revision: task.revision + 1 })
    expect(h.adapter.requests).toHaveLength(3)
    await h.close()
  })
})
