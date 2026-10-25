/** A confirmed pass and a pause before the next member must not strand future controls. */
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionPromptRequest, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { TeamChat } from '../src/chats-types.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { memoryFixture } from './memory-fixture.ts'

function control(chat: TeamChat) {
  return { id: chat.id, expectedRunId: chat.run?.id ?? null, expectedGeneration: chat.generation }
}

async function settled(ctx: Context, chat: TeamChat): Promise<void> {
  const controller = new AbortController()
  try {
    for await (const frame of ctx.katcatsChats.follow(controller.signal)) {
      if (frame.value.activities.find(activity => activity.chatId === chat.id)?.processing === false) return
    }
    throw new Error('Synthetic group closed before processing settled')
  } finally { controller.abort() }
}

function prompt(chat: TeamChat, id: string, mode: SessionPromptRequest['mode'] = 'steer'): SessionPromptRequest {
  return { sessionId: chat.rootSessionId, requestId: brandString<SessionRequestId>(id), mode,
    content: [{ type: 'text', text: `Hello everyone. ${id}` }] }
}

describe('pass then owner pause and subsequent controls', () => {
  it.each(['resume', 'stop-and-steer'] as const)('allows %s after the responsible member passes and the next member is queued', async (action) => {
    let passes = 0
    const h = await memoryFixture(Array.from({ length: 8 }, () => request => request.sessionId === workerA
      ? toolCallResponse(`pass-${++passes}`, 'pass_group_turn', {})
      : textResponse('B actually answers the current group greeting.')))
    const a = (await h.ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const b = (await h.ctx.katcatsTeam.createBot({ name: 'B' })).bot
    const chat = (await h.ctx.katcatsChats.createChat({ name: 'Pause and pass', memberIds: [a.id, b.id], managerId: a.id })).chat
    const workerA = chat.executors.find(executor => executor.botId === a.id)!.sessionId
    const workerB = chat.executors.find(executor => executor.botId === b.id)!.sessionId
    let paused = false
    let pause: Promise<unknown> | undefined
    const remove = h.ctx.on('session/event', (session, event) => {
      if (session.id !== chat.rootSessionId || event.type !== 'katcats/group-task-lifecycle'
        || event.data.target.botId !== b.id || event.data.status !== 'queued' || paused) return
      paused = true
      pause = h.ctx.katcatsChats.pause({ id: chat.id, expectedRunId: event.data.runId, expectedGeneration: event.data.generation })
    })
    try {
      await h.ctx.katcatsChats.sendMessage(prompt(chat, 'first-greeting'), new AbortController().signal)
      await settled(h.ctx, chat)
      await pause
      const held = await h.ctx.katcatsChats.snapshot()
      expect(held.chats[0]).toMatchObject({ status: 'paused', pauseReason: 'owner' })
      expect(held.deliveries.map(delivery => delivery.state)).toEqual(['passed', 'accepted'])
      expect(h.adapter.requests.map(request => request.sessionId)).toEqual([workerA])
      if (action === 'resume') {
        await h.ctx.katcatsChats.resume(control(held.chats[0]!))
      } else {
        await h.ctx.katcatsChats.stop(control(held.chats[0]!))
        const stopped = await h.ctx.katcatsChats.snapshot()
        expect(stopped.chats[0]).toMatchObject({ status: 'stopped', run: null })
        expect(stopped.deliveries.map(delivery => delivery.state)).toEqual(['passed', 'failed'])
        expect(stopped.activities[0]).toMatchObject({ processing: false, pendingControl: null })
        await h.ctx.katcatsChats.sendMessage(prompt(chat, 'new-greeting'), new AbortController().signal)
      }
      await settled(h.ctx, chat)
      const done = await h.ctx.katcatsChats.snapshot()
      expect(done.chats[0]).toMatchObject({ status: 'active', pauseReason: null, run: null })
      expect(done.activities[0]).toMatchObject({ processing: false, pendingControl: null })
      expect(done.deliveries.at(-1)).toMatchObject({ botId: b.id, state: 'completed', relayed: true,
        receipt: { text: 'B actually answers the current group greeting.' } })
      expect(h.adapter.requests.map(request => request.sessionId)).toEqual(action === 'resume'
        ? [workerA, workerB] : [workerA, workerA, workerB])
      const history = await h.ctx.sessionController.inspect(chat.rootSessionId)
      expect(history.events.filter(event => event.type === 'user/message'
        && event.data.source.kind === 'katcats-group-relay')).toHaveLength(1)
      expect(history.events.some(event => event.type === 'turn/start')).toBe(false)
    } finally { remove() }
  })
})
