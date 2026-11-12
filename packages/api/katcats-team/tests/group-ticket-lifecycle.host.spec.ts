/** Business task submission and acceptance survive restarts with an exact publication receipt. */
import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { ChatsRuntime } from '../src/chats-runtime.ts'
import { chatsDomainSpec } from '../src/chats-storage.ts'
import { markGroupTicketDelivered } from '../src/group-tickets.ts'
import { memoryFixture } from './memory-fixture.ts'

const description = {
  goal: 'Reconcile the supplied figures',
  acceptance: ['Match the original evidence'],
  stage: 'Checking originals',
  next_step: 'Read the evidence',
  artifacts: [],
}
const submission = {
  ...description,
  stage: 'Ready to publish',
  next_step: 'Review the saved result',
  submit_delivery: true,
}

async function startTask(script: Parameters<typeof memoryFixture>[0]) {
  const h = await memoryFixture(script)
  const manager = (await h.ctx.katcatsTeam.createBot({ name: 'Manager' })).bot
  const chat = (await h.ctx.katcatsChats.createChat({ name: 'Tasks', memberIds: [manager.id], managerId: manager.id })).chat
  await h.ctx.katcatsChats.sendMessage({
    sessionId: chat.rootSessionId,
    requestId: brandString<SessionRequestId>('archive-lifecycle-input'),
    mode: 'queue',
    content: [{ type: 'text', text: description.goal }],
  }, new AbortController().signal)
  const idle = () => expect.poll(async () => (await h.ctx.katcatsChats.snapshot()).activities
    .find(activity => activity.chatId === chat.id)?.processing, { timeout: 10_000 }).toBe(false)
  return { ...h, chat, manager, idle }
}

describe('business task publication and acceptance', () => {
  it('requires the exact published result and retains the acceptance across restarts', async () => {
    const h = await startTask([
      toolCallResponse('record', 'record_group_task', { ...description, human_review_required: true }),
      toolCallResponse('submit', 'record_group_task', submission),
      textResponse('The original evidence matches the reconciled figures.'),
    ])
    await h.idle()
    const snapshot = await h.ctx.katcatsChats.snapshot()
    const task = snapshot.chats[0]!.tickets![0]!
    const delivery = snapshot.deliveries[0]!
    expect(task).toMatchObject({
      state: 'delivered',
      revision: 3,
      delivery: { deliveryId: delivery.id, outputMessageId: delivery.receipt!.outputMessageId, relayMessageId: delivery.relayMessageId },
    })
    expect(task.pendingDeliveryId).toBeUndefined()
    expect(delivery.relayed).toBe(true)
    await h.close()

    const cold = await memoryFixture([], h.root)
    expect((await cold.ctx.katcatsChats.snapshot()).chats[0]!.tickets![0]).toEqual(task)
    expect(cold.adapter.requests).toHaveLength(0)
    await expect(cold.ctx.katcatsChats.completeTask(h.chat.id, task.id, task.revision - 1)).rejects.toThrow('This task changed')
    const completed = (await cold.ctx.katcatsChats.completeTask(h.chat.id, task.id, task.revision)).chat.tickets![0]!
    expect(completed).toMatchObject({ state: 'completed', revision: task.revision + 1, delivery: task.delivery })
    expect(completed.completedAt).toBeGreaterThan(0)
    expect((await cold.ctx.katcatsChats.completeTask(h.chat.id, task.id, task.revision)).chat.tickets![0]).toEqual(completed)
    await cold.close()

    const reopened = await memoryFixture([], h.root)
    expect((await reopened.ctx.katcatsChats.snapshot()).chats[0]!.tickets![0]).toEqual(completed)
    expect(reopened.adapter.requests).toHaveLength(0)
    await reopened.close()
  })

  it('completes ordinary submitted work after publication without waiting for a human acceptance message', async () => {
    const h = await startTask([
      toolCallResponse('record', 'record_group_task', description),
      toolCallResponse('submit', 'record_group_task', submission),
      textResponse('The evidence matches the submitted figures.'),
    ])
    await h.idle()
    const task = (await h.ctx.katcatsChats.snapshot()).chats[0]!.tickets![0]!
    expect(task).toMatchObject({ state: 'completed', completionKind: 'criteria', revision: 3 })
    expect(task.delivery).toBeDefined()
    expect(task.completedAt).toBeGreaterThan(0)
    expect(task.messageIds).toHaveLength(1)
    await h.close()
    const cold = await memoryFixture([], h.root)
    expect((await cold.ctx.katcatsChats.snapshot()).chats[0]!.tickets![0]).toEqual(task)
    await cold.close()
  })

  it('clears an unfulfilled submission when the same execution reports a blocker', async () => {
    const h = await startTask([
      toolCallResponse('record', 'record_group_task', description),
      toolCallResponse('submit', 'record_group_task', submission),
      toolCallResponse('block', 'report_group_blocker', { reason: 'Evidence missing', next_step: 'Ask for the original', effects: 'none' }),
    ])
    await h.idle()
    const task = (await h.ctx.katcatsChats.snapshot()).chats[0]!.tickets![0]!
    expect(task).toMatchObject({ state: 'blocked', revision: 3 })
    expect(task.pendingDeliveryId).toBeUndefined()
    expect(task.delivery).toBeUndefined()
    await expect(h.ctx.katcatsChats.completeTask(h.chat.id, task.id, task.revision)).rejects.toThrow('no published delivery')
    await h.close()
  })

  it('keeps the task open when the publication marker fails to persist', async () => {
    vi.spyOn(ChatsRuntime.prototype, 'kick').mockImplementation(() => {})
    try {
      const h = await startTask([])
      const actions = h.ctx.katcatsChats['runtimeActions']()
      const input = (await actions.read(h.chat.id)).inbounds[0]!
      const delivery = await actions.acceptDelivery({
        chatId: h.chat.id, runId: input.runId, generation: input.generation,
        sourceSessionId: h.chat.rootSessionId, source: { kind: 'owner-message', messageId: input.userMessage.id },
        botId: h.manager.id, message: description.goal,
      })
      await actions.markRunning(delivery.id)
      const record = {
        goal: description.goal, acceptance: description.acceptance, stage: description.stage,
        nextStep: description.next_step, artifacts: [],
      }
      const task = await actions.recordTicket(delivery.id, record, () => {})
      await expect(actions.recordTicket(delivery.id, { ...record, id: task.id, goal: 'Changed goal', submitDelivery: true }, () => {}))
        .rejects.toThrow('acceptance criteria unchanged')
      const pending = await actions.recordTicket(delivery.id, { ...record, id: task.id, submitDelivery: true }, () => {})
      const confirmed = await actions.completeDelivery(delivery.id, {
        sender: { botId: h.manager.id, name: h.manager.name, role: h.manager.role, avatar: h.manager.avatar },
        text: 'The original evidence matches the reconciled figures.',
        outputMessageId: brandString<typeof delivery.relayMessageId>('saved-task-output'),
        turn: 1,
      })
      const newer = { ...(await actions.read(h.chat.id)).chat, tickets: [{
        ...pending, messageIds: [...pending.messageIds, brandString<typeof input.userMessage.id>('newer-owner-message')],
      }] }
      expect(markGroupTicketDelivered(newer, input, { ...confirmed, relayed: true })).toBe(newer)
      const domain = h.ctx.storageDomain.get(chatsDomainSpec.name)!
      vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Synthetic disk failure'))
      await expect(actions.markRelayed(delivery.id)).rejects.toThrow('Synthetic disk failure')
      expect((await actions.read(h.chat.id)).chat.tickets![0]).toEqual(pending)
      await expect(h.ctx.katcatsChats.completeTask(h.chat.id, task.id, pending.revision)).rejects.toThrow('no published delivery')
      await actions.markRelayed(delivery.id)
      const published = (await actions.read(h.chat.id)).chat.tickets![0]!
      expect(published).toMatchObject({ state: 'completed', completionKind: 'criteria', revision: pending.revision + 1, delivery: { deliveryId: delivery.id } })
      await h.close()
    } finally {
      vi.restoreAllMocks()
    }
  })
})
