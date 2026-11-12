/** Chat intent can accept only a prior, exact, published task in the current ledger. */
import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, type MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { acceptGroupTaskFromMessage, type GroupSemanticAcceptanceContext } from '../src/group-semantic-acceptance.ts'
import { groupTicketCompletionIssue, markGroupTicketDelivered, recordGroupTicket, reassignGroupTicket } from '../src/group-tickets.ts'
import type { ChatDelivery, ChatDeliveryId, ChatId, ChatRunId, GroupTicket, GroupTicketId, TeamChat } from '../src/chats-types.ts'
import type { BotId, GroupId } from '../src/types.ts'
import { memoryFixture } from './memory-fixture.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { ChatsRuntime } from '../src/chats-runtime.ts'
import { chatsDomainSpec } from '../src/chats-storage.ts'

function fixture(): GroupSemanticAcceptanceContext {
  const manager = brandString<BotId>('manager')
  const chatId = brandString<ChatId>('chat')
  const userMessage = createUserMessage({ content: [{ type: 'text', text: '这份核对结果我已经逐项看过，内容符合要求，这项工作可以收尾了。' }], source: { kind: 'user' } })
  const delivery: ChatDelivery = { id: brandString<ChatDeliveryId>('current'), chatId,
    runId: brandString<ChatRunId>('current-run'), generation: 2, sourceSessionId: brandString<SessionId>('root'),
    source: { kind: 'owner-message', messageId: userMessage.id }, botId: manager, executorSessionId: brandString<SessionId>('worker'),
    message: 'Confirm prior delivery', inputMessageId: brandString<MessageId>('worker-input'),
    relayMessageId: brandString<MessageId>('future-relay'), state: 'running', receipt: null, pass: null, relayed: false, error: null }
  const prior: ChatDelivery = { ...delivery, id: brandString<ChatDeliveryId>('previous'), generation: 1,
    source: { kind: 'owner-message', messageId: brandString<MessageId>('original') }, state: 'completed', relayed: true,
    relayMessageId: brandString<MessageId>('published'), receipt: { outputMessageId: brandString<MessageId>('result'), turn: 1,
      text: 'Checked result', sender: { botId: manager, name: 'Manager', role: '', avatar: { shape: 'classic', color: '#FF2849' } } } }
  const task: GroupTicket = { version: 1, id: brandString<GroupTicketId>('task-original'), ownerId: manager,
    goal: 'Check results', acceptance: ['Match evidence'], stage: 'Ready', nextStep: 'Owner acceptance', state: 'delivered',
    blocker: null, financeScope: 'ledger-a', humanReviewRequired: true, artifacts: [], revision: 3,
    messageIds: [brandString<MessageId>('original')], delivery: { deliveryId: prior.id, outputMessageId: prior.receipt!.outputMessageId,
      relayMessageId: prior.relayMessageId } }
  const chat: TeamChat = { id: chatId, name: 'Group', groupId: brandString<GroupId>('folder'),
    rootSessionId: delivery.sourceSessionId, workDir: 'work', memberIds: [manager, brandString<BotId>('replacement')],
    managerId: manager, memberRoles: [], executors: [], relayLimit: 8, generation: 2, status: 'active', pauseReason: null,
    run: { id: delivery.runId, generation: 2, relayCount: 1 }, error: null, tickets: [task] }
  return { chat, delivery, deliveries: [prior, delivery], currentFinanceScope: 'ledger-a', completedAt: 100,
    publishedMessageIds: [prior.relayMessageId, userMessage.id], request: { taskId: task.id, expectedRevision: 3,
      acceptanceQuote: '这份核对结果我已经逐项看过，内容符合要求，这项工作可以收尾了。' },
    input: { chatId, runId: delivery.runId, generation: 2, requestId: brandString<SessionRequestId>('confirmation'), requestDigest: '',
      userMessage, recipients: [manager], addressing: 'broadcast', coordinationVersion: 1, state: 'published', financeScope: 'ledger-a' } }
}

describe('semantic task acceptance evidence', () => {
  it('keeps both the task and owner input unchanged when acceptance persistence fails', async () => {
    const record = { goal: 'Verify balances', acceptance: ['Balances match'], stage: 'Ready', next_step: 'Human acceptance',
      artifacts: [], human_review_required: true }
    const h = await memoryFixture([toolCallResponse('record', 'record_group_task', record),
      toolCallResponse('submit', 'record_group_task', { ...record, submit_delivery: true }), textResponse('Balances match.')])
    const bot = (await h.ctx.katcatsTeam.createBot({ name: 'Manager' })).bot
    const chat = (await h.ctx.katcatsChats.createChat({ name: 'Balances', memberIds: [bot.id], managerId: bot.id })).chat
    const send = (id: string, text: string) => h.ctx.katcatsChats.sendMessage({ sessionId: chat.rootSessionId,
      requestId: brandString<SessionRequestId>(id), mode: 'queue', content: [{ type: 'text', text }] }, new AbortController().signal)
    await send('original', record.goal)
    await expect.poll(async () => (await h.ctx.katcatsChats.snapshot()).activities[0]?.processing, { timeout: 10_000 }).toBe(false)
    const task = (await h.ctx.katcatsChats.snapshot()).chats[0]!.tickets![0]!
    const kick = vi.spyOn(ChatsRuntime.prototype, 'kick').mockImplementation(() => {})
    try {
      const quote = '我核对了余额，结果符合要求，这项任务通过验收。'
      await send('semantic', quote)
      const actions = h.ctx.katcatsChats['runtimeActions']()
      const input = (await actions.read(chat.id)).inbounds.at(-1)!
      const execution = await actions.acceptDelivery({ chatId: chat.id, runId: input.runId, generation: input.generation,
        sourceSessionId: chat.rootSessionId, source: { kind: 'owner-message', messageId: input.userMessage.id }, botId: bot.id, message: quote })
      await actions.markRunning(execution.id)
      const request = { taskId: task.id, expectedRevision: task.revision, acceptanceQuote: quote }
      const storage = h.ctx.storageDomain.get(chatsDomainSpec.name)!
      const failure = vi.spyOn(storage.global, 'set').mockRejectedValueOnce(new Error('Acceptance storage unavailable'))
      await expect(actions.acceptTask(execution.id, request, () => {})).rejects.toThrow('Acceptance storage unavailable')
      expect((await actions.read(chat.id)).chat.tickets![0]).toEqual(task)
      expect((await actions.read(chat.id)).inbounds.at(-1)!.taskAcceptance).toBeUndefined()
      failure.mockRestore()
      expect(await actions.acceptTask(execution.id, request, () => {})).toMatchObject({ state: 'completed', completionKind: 'owner' })
    } finally {
      kick.mockRestore()
      await h.close()
    }
  })

  it('lets the current member classify a natural confirmation and persists completion across restart', async () => {
    let acceptedTask: GroupTicket | undefined
    const quote = '这份核对结果我已经逐项看过，内容符合要求，这项工作可以收尾了。'
    const record = { goal: 'Reconcile source figures', acceptance: ['Match source records'], stage: 'Ready', next_step: 'Human review', artifacts: [], human_review_required: true }
    const h = await memoryFixture([
      toolCallResponse('record-task', 'record_group_task', record),
      toolCallResponse('submit-task', 'record_group_task', { ...record, submit_delivery: true }),
      textResponse('Source figures have been checked. Please review the result.'),
      (request) => {
        expect(JSON.stringify(request.messages)).toContain(quote)
        return toolCallResponse('owner-acceptance', 'accept_group_task', {
          task_id: acceptedTask!.id, expected_revision: acceptedTask!.revision, acceptance_quote: quote,
        })
      },
      textResponse('Your acceptance is recorded and this task is complete.'),
    ])
    const bot = (await h.ctx.katcatsTeam.createBot({ name: 'Manager' })).bot
    const chat = (await h.ctx.katcatsChats.createChat({ name: 'Review', memberIds: [bot.id], managerId: bot.id })).chat
    const request = (id: string, text: string) => ({ sessionId: chat.rootSessionId,
      requestId: brandString<SessionRequestId>(id), mode: 'queue' as const, content: [{ type: 'text' as const, text }] })
    const signal = new AbortController().signal
    const idle = () => expect.poll(async () => (await h.ctx.katcatsChats.snapshot()).activities
      .find(item => item.chatId === chat.id)?.processing, { timeout: 10_000 }).toBe(false)
    await h.ctx.katcatsChats.sendMessage(request('initial', record.goal), signal)
    await idle()
    acceptedTask = (await h.ctx.katcatsChats.snapshot()).chats[0]!.tickets![0]!
    expect(acceptedTask.state).toBe('delivered')
    const confirmation = request('semantic-confirmation', quote)
    await h.ctx.katcatsChats.sendMessage(confirmation, signal)
    await idle()
    const completed = (await h.ctx.katcatsChats.snapshot()).chats[0]!.tickets![0]!
    expect(completed).toMatchObject({ id: acceptedTask.id, state: 'completed', completionKind: 'owner', revision: acceptedTask.revision + 1 })
    expect(h.adapter.requests).toHaveLength(5)
    await h.close()
    const cold = await memoryFixture([], h.root)
    expect((await cold.ctx.katcatsChats.snapshot()).chats[0]!.tickets![0]).toEqual(completed)
    expect(await cold.ctx.katcatsChats.sendMessage(confirmation, signal)).toMatchObject({
      taskAcceptance: { kind: 'completed', taskId: completed.id },
    })
    expect(cold.adapter.requests).toHaveLength(0)
    await cold.close()
  })

  it('retains the human message and exact delivery, and permits an identical durable retry', () => {
    const context = fixture()
    const result = acceptGroupTaskFromMessage(context)
    expect(result.ticket).toMatchObject({ state: 'completed', completionKind: 'owner', revision: 4, completedAt: 100,
      delivery: context.chat.tickets![0]!.delivery })
    expect(result.ticket.messageIds.at(-1)).toBe(context.input.userMessage.id)
    const retry = acceptGroupTaskFromMessage({ ...context, chat: result.chat,
      input: { ...context.input, taskAcceptance: result.acceptance } })
    expect(retry.chat).toBe(result.chat)
    expect(groupTicketCompletionIssue(result.chat, { ...context.input, taskAcceptance: result.acceptance }, context.delivery)).toBeUndefined()
  })

  it.each([
    ['an affirmative fragment', (c: GroupSemanticAcceptanceContext) => ({ ...c, request: { ...c.request, acceptanceQuote: '符合要求' } })],
    ['assistant-produced content', (c: GroupSemanticAcceptanceContext) => ({ ...c, input: { ...c.input,
      userMessage: { ...c.input.userMessage, source: { kind: 'model' as const, provider: 'test', model: 'test' } } } })],
    ['delegated content', (c: GroupSemanticAcceptanceContext) => ({ ...c, delivery: { ...c.delivery,
      source: { kind: 'member-reply' as const, messageId: c.input.userMessage.id } } })],
    ['another ledger', (c: GroupSemanticAcceptanceContext) => ({ ...c, currentFinanceScope: 'ledger-b' })],
    ['a stale revision', (c: GroupSemanticAcceptanceContext) => ({ ...c, request: { ...c.request, expectedRevision: 2 } })],
    ['an unpublished result', (c: GroupSemanticAcceptanceContext) => ({ ...c,
      deliveries: c.deliveries.map(d => d.id === c.delivery.id ? d : { ...d, relayed: false }) })],
    ['a result published after the user message', (c: GroupSemanticAcceptanceContext) => ({ ...c,
      publishedMessageIds: [...c.publishedMessageIds].reverse() })],
    ['other unfinished work', (c: GroupSemanticAcceptanceContext) => ({ ...c,
      deliveries: [...c.deliveries, { ...c.delivery, id: brandString<ChatDeliveryId>('other'), state: 'accepted' as const }] })],
    ['a confirmation already used elsewhere', (c: GroupSemanticAcceptanceContext) => ({ ...c, input: { ...c.input,
      taskAcceptance: { kind: 'completed' as const, taskId: brandString<GroupTicketId>('other-task'), goal: 'Other work' } } })],
  ])('rejects %s without changing the task', (_name, change) => {
    const context = fixture()
    expect(() => acceptGroupTaskFromMessage(change(context))).toThrow()
    expect(context.chat.tickets![0]!.state).toBe('delivered')
  })
})

describe('task submission recovery', () => {
  it('repairs legacy empty criteria under the same task, then submits and completes after publication', () => {
    const context = fixture()
    const original = context.chat.tickets![0]!
    const { delivery: _receipt, humanReviewRequired: _human, ...record } = original
    const task: GroupTicket = { ...record, state: 'open', acceptance: [], messageIds: [context.input.userMessage.id] }
    const chat = { ...context.chat, tickets: [task] }
    const request = { id: task.id, goal: task.goal, acceptance: ['Match evidence'], stage: 'Ready', nextStep: 'Publish', artifacts: [] }
    expect(() => recordGroupTicket(chat, context.input, context.delivery, { ...request, submitDelivery: true })).toThrow('no recorded acceptance criteria')
    expect(groupTicketCompletionIssue(chat, context.input, context.delivery)).toContain('no recorded acceptance criteria')
    const prepared = recordGroupTicket(chat, context.input, context.delivery, request)
    const submitted = recordGroupTicket(prepared.chat, context.input, context.delivery, { ...request, submitDelivery: true })
    expect(submitted.ticket.id).toBe(task.id)
    const receipt = { ...context.delivery, state: 'completed' as const, relayed: true, receipt: context.deliveries[0]!.receipt }
    const completed = markGroupTicketDelivered(submitted.chat, context.input, receipt)
    expect(completed.tickets![0]).toMatchObject({ id: task.id, state: 'completed', completionKind: 'criteria' })
    expect(completed.tickets![0]!.messageIds).toEqual([context.input.userMessage.id])
    expect(markGroupTicketDelivered(submitted.chat, context.input, { ...receipt, relayed: false })).toBe(submitted.chat)
    expect(markGroupTicketDelivered({ ...submitted.chat, tickets: [{ ...submitted.ticket, acceptance: [] }] }, context.input, receipt)
      .tickets![0]!.state).toBe('open')
  })

  it('reassigns only the selected unfinished revision to a current member and invalidates its unfulfilled submission', () => {
    const context = fixture()
    const task = { ...context.chat.tickets![0]!, state: 'blocked' as const, blocker: 'Original owner left',
      pendingDeliveryId: context.delivery.id }
    const chat = { ...context.chat, tickets: [task] }
    const replacement = chat.memberIds[1]!
    const updated = reassignGroupTicket(chat, task.id, task.revision, replacement)!
    expect(updated.tickets![0]).toMatchObject({ ownerId: replacement, state: 'blocked', financeScope: task.financeScope,
      revision: task.revision + 1, messageIds: task.messageIds, acceptance: task.acceptance })
    expect(updated.tickets![0]!.pendingDeliveryId).toBeUndefined()
    expect(updated.tickets![0]!.delivery).toBeUndefined()
    expect(reassignGroupTicket(chat, task.id, task.revision - 1, replacement)).toBeUndefined()
    expect(reassignGroupTicket(chat, task.id, task.revision, brandString<BotId>('outsider'))).toBeUndefined()
    expect(reassignGroupTicket(context.chat, task.id, task.revision, replacement)).toBeUndefined()
  })

  it('requires the human transfer message before the manager can resume a departed owner’s task', () => {
    const context = fixture()
    const task: GroupTicket = { ...context.chat.tickets![0]!, ownerId: brandString<BotId>('departed'), state: 'blocked',
      blocker: 'Owner unavailable', artifacts: ['saved-evidence.xlsx'] }
    const chat = { ...context.chat, tickets: [task] }
    const input = { ...context.input, userMessage: { ...context.input.userMessage,
      content: [{ type: 'text' as const, text: '请财务主管接手这份核对任务，继续原来的工作。' }] } }
    const request = { id: task.id, goal: task.goal, acceptance: task.acceptance, stage: 'Resume evidence review',
      nextStep: 'Read saved evidence', artifacts: [] }
    expect(() => recordGroupTicket(chat, input, context.delivery, request)).toThrow('explicitly authorizes')
    const authorized = { ...request, takeOverOwner: true as const, ownerTransferQuote: '请财务主管接手这份核对任务，继续原来的工作。' }
    expect(() => recordGroupTicket(chat, input, context.delivery, { ...authorized, ownerTransferQuote: '接手' })).toThrow()
    expect(() => recordGroupTicket(chat, input, context.delivery, { ...authorized, goal: 'Different goal' })).toThrow()
    expect(() => recordGroupTicket({ ...chat, memberIds: [...chat.memberIds, task.ownerId] }, input, context.delivery, authorized)).toThrow()
    const resumed = recordGroupTicket(chat, input, context.delivery, authorized)
    expect(resumed.ticket).toMatchObject({ id: task.id, ownerId: context.delivery.botId, state: 'open', goal: task.goal,
      acceptance: task.acceptance, financeScope: task.financeScope, artifacts: task.artifacts })
    expect(resumed.ticket.messageIds).toEqual([...task.messageIds, input.userMessage.id])
    expect(resumed.ticket.delivery).toBeUndefined()
  })
})
