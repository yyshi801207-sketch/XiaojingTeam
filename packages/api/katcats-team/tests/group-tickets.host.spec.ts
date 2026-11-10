/** Business work survives turns; confirmed blockers create bounded, recoverable explanations. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { memoryFixture } from './memory-fixture.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { ChatsRuntime } from '../src/chats-runtime.ts'
import { chatsDomainSpec } from '../src/chats-storage.ts'
import type { GroupTicketId } from '../src/group-tickets.ts'

afterEach(() => vi.restoreAllMocks())

const description = { goal: 'Reconcile the supplied figures', acceptance: ['Match the original evidence'],
  stage: 'Checking originals', next_step: 'Read the evidence', artifacts: [] }

async function fixture(script: Parameters<typeof memoryFixture>[0] = []) {
  const h = await memoryFixture(script)
  const manager = (await h.ctx.katcatsTeam.createBot({ name: 'Manager' })).bot
  const worker = (await h.ctx.katcatsTeam.createBot({ name: 'Worker' })).bot
  const chat = (await h.ctx.katcatsChats.createChat({ name: 'Tasks', memberIds: [manager.id, worker.id], managerId: manager.id })).chat
  let index = 0
  const send = (text: string) => h.ctx.katcatsChats.sendMessage({ sessionId: chat.rootSessionId,
    requestId: brandString<SessionRequestId>('ticket-input-' + String(index++)), mode: 'queue', content: [{ type: 'text', text }] }, new AbortController().signal)
  const idle = () => expect.poll(async () => (await h.ctx.katcatsChats.snapshot()).activities
    .find(activity => activity.chatId === chat.id)?.processing, { timeout: 10_000 }).toBe(false)
  return { ...h, manager, worker, chat, send, idle }
}

describe('durable business tasks', () => {
  it('continues the same task across runs and restart without treating a conversational reply as acceptance', async () => {
    let taskId = ''
    const h = await fixture([
      toolCallResponse('record', 'record_group_task', description),
      textResponse('I need the original evidence.'),
      () => toolCallResponse('continue', 'record_group_task', { ...description, task_id: taskId, goal: 'Reconcile corrected 317.00' }),
      textResponse('The correction is saved; the work is still open.'),
    ])
    await h.send('Reconcile 300.00'); await h.idle()
    taskId = (await h.ctx.katcatsChats.snapshot()).chats[0]!.tickets![0]!.id
    await h.send('Correction: 317.00'); await h.idle()
    const snapshot = await h.ctx.katcatsChats.snapshot()
    expect(snapshot.chats[0]!.tickets).toHaveLength(1)
    expect(snapshot.chats[0]!.tickets![0]).toMatchObject({ id: taskId, goal: 'Reconcile corrected 317.00', state: 'open', revision: 2 })
    expect(snapshot.chats[0]!.tickets![0]!.messageIds).toHaveLength(2)
    expect(new Set(snapshot.deliveries.map(delivery => delivery.runId)).size).toBe(2)
    const log = await h.ctx.sessionController.inspect(snapshot.deliveries[0]!.executorSessionId)
    expect(JSON.stringify(log.events)).toContain('Reconcile corrected 317.00')
    await h.close()
    const cold = await memoryFixture([], h.root)
    expect((await cold.ctx.katcatsChats.snapshot()).chats[0]!.tickets).toEqual(snapshot.chats[0]!.tickets)
    expect(cold.adapter.requests).toHaveLength(0)
    expect(snapshot.chats[0]!.tickets!.map(task => ({ goal: task.goal, state: task.state,
      messages: task.messageIds.length, acceptance: task.acceptance }))).toMatchInlineSnapshot(`
      [
        {
          "acceptance": [
            "Match the original evidence",
          ],
          "goal": "Reconcile corrected 317.00",
          "messages": 2,
          "state": "open",
        },
      ]
    `)
  })

  it.each([false, true])('sends a directly addressed blocker to the manager once; recorded task=%s', async (recorded) => {
    const h = await fixture([
      ...(recorded ? [toolCallResponse('record', 'record_group_task', description)] : []),
      toolCallResponse('block', 'report_group_blocker', { reason: 'Authentication refused', next_step: 'Update whitelist', effects: 'none' }),
      (request) => {
        expect(JSON.stringify(request.messages)).toContain('Responsible-member blocker follow-up')
        expect(JSON.stringify(request.messages)).toContain('Update whitelist')
        return textResponse('Authentication was refused. Update the whitelist before sending a new instruction.')
      },
    ])
    await h.send('@Worker perform the operation'); await h.idle()
    const state = await h.ctx.katcatsChats.snapshot()
    expect(state.deliveries.map(delivery => [delivery.botId, delivery.state])).toEqual([
      [h.worker.id, 'failed'], [h.manager.id, 'completed'],
    ])
    expect(state.deliveries[0]!.takeover).toEqual({ version: 1, botId: h.manager.id, state: 'handled' })
    expect(state.deliveries[1]!.recoveryOf).toBe(state.deliveries[0]!.id)
    expect(state.chats[0]!.run).toBeNull()
    expect(h.adapter.requests).toHaveLength(recorded ? 3 : 2)
  })

  it('refuses another delegation from an explanation follow-up instead of repeating the failed work', async () => {
    let workerId = ''
    const h = await fixture([
      toolCallResponse('block', 'report_group_blocker', { reason: 'Permission denied', next_step: 'Ask owner to grant access', effects: 'none' }),
      () => toolCallResponse('retry', 'request_group_member', { bot_id: workerId, message: 'Repeat the operation' }),
      (request) => {
        expect(JSON.stringify(request.messages)).toContain('This follow-up only explains a saved blocker')
        return textResponse('Access is missing. Grant access, then send a new instruction.')
      },
    ])
    workerId = h.worker.id
    await h.send('@Worker perform the operation'); await h.idle()
    const state = await h.ctx.katcatsChats.snapshot()
    expect(state.deliveries).toHaveLength(2)
    expect(state.deliveries[0]!.takeover?.state).toBe('handled')
    expect(h.adapter.requests).toHaveLength(3)
  })

  it.each([false, true])('retains a pending explanation across restart; stopped=%s never wakes it', async (stop) => {
    const kick = vi.spyOn(ChatsRuntime.prototype, 'kick').mockImplementation(() => {})
    const h = await fixture()
    await h.send('@Worker perform the operation')
    const actions = h.ctx.katcatsChats['runtimeActions']()
    const saved = await actions.read(h.chat.id)
    const input = saved.inbounds[0]!
    const accepted = await actions.acceptDelivery({ chatId: h.chat.id, runId: input.runId, generation: input.generation,
      sourceSessionId: h.chat.rootSessionId, source: { kind: 'owner-message', messageId: input.userMessage.id },
      botId: h.worker.id, message: 'Perform the operation' })
    await actions.markRunning(accepted.id)
    await actions.failDelivery(accepted.id, { code: 'KATCATS_CHAT_TASK_BLOCKED', message: 'Missing prerequisite; supply it first.' }, false)
    if (stop) await actions.stopped(h.chat.id, { runId: input.runId, generation: input.generation })
    await h.close(); kick.mockRestore()
    const cold = await memoryFixture([textResponse('A prerequisite is missing. Supply it before retrying.')], h.root)
    const restored = await cold.ctx.katcatsChats.snapshot()
    expect(restored.deliveries[0]!.takeover?.state).toBe(stop ? 'stopped' : 'pending')
    expect(cold.adapter.requests).toHaveLength(0)
    if (!stop) {
      const chat = restored.chats[0]!
      await cold.ctx.katcatsChats.resume({ id: chat.id, expectedGeneration: chat.generation, expectedRunId: chat.run?.id ?? null })
      await expect.poll(async () => (await cold.ctx.katcatsChats.snapshot()).activities[0]?.processing, { timeout: 10_000 }).toBe(false)
      expect((await cold.ctx.katcatsChats.snapshot()).deliveries[0]!.takeover?.state).toBe('handled')
      expect(cold.adapter.requests).toHaveLength(1)
    }
  })

  it('does not classify a foreign task or publish a task record after a failed directory write', async () => {
    vi.spyOn(ChatsRuntime.prototype, 'kick').mockImplementation(() => {})
    const h = await fixture()
    await h.send('Reconcile this document')
    const actions = h.ctx.katcatsChats['runtimeActions']()
    const input = (await actions.read(h.chat.id)).inbounds[0]!
    const delivery = await actions.acceptDelivery({ chatId: h.chat.id, runId: input.runId, generation: input.generation,
      sourceSessionId: h.chat.rootSessionId, source: { kind: 'owner-message', messageId: input.userMessage.id }, botId: h.manager.id, message: 'Reconcile' })
    await actions.markRunning(delivery.id)
    const request = { goal: description.goal, acceptance: description.acceptance, stage: description.stage,
      nextStep: description.next_step, artifacts: [] }
    await expect(actions.recordTicket(delivery.id, { ...request, id: brandString<GroupTicketId>('foreign-task') }, () => {}))
      .rejects.toThrow('existing task in this group')
    const domain = h.ctx.storageDomain.get(chatsDomainSpec.name)!
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Synthetic disk failure'))
    await expect(actions.recordTicket(delivery.id, request, () => {})).rejects.toThrow('Synthetic disk failure')
    expect((await actions.read(h.chat.id)).chat.tickets).toBeUndefined()
  })
})
