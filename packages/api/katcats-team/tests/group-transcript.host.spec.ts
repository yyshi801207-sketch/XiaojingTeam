/** Real Loader and JSONL evidence for group containers that never request a model. */
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { GroupTranscript } from '../src/group-transcript.ts'
import type { ChatDelivery, ChatId, ChatRunId } from '../src/chats-types.ts'
import { memoryFixture, memorySend } from './memory-fixture.ts'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

async function container(script: Parameters<typeof memoryFixture>[0] = [], root?: string) {
  const fixture = await memoryFixture(script, root)
  const sessionId = SessionId('transcript-container')
  if (root === undefined) {
    await fixture.ctx.sessionController.create({ sessionId, cwd: fixture.root })
    const agent = fixture.ctx.agents.get(sessionId)!
    fixture.ctx.sessionTitle.rename(agent.session, 'Synthetic group')
    await fixture.ctx.sessions.flush(agent.session)
  }
  return { ...fixture, transcript: new GroupTranscript(fixture.ctx),
    chat: { id: brandString<ChatId>('transcript-group'), rootSessionId: sessionId } }
}

function human(text = 'Please write one clear headline.'): UserMessage {
  return { id: MessageId('transcript-human'), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

async function memberResult(h: Awaited<ReturnType<typeof container>>) {
  const writer = (await h.ctx.katcatsTeam.createBot({ name: 'Writer' })).bot
  const executorSessionId = SessionId('transcript-member')
  await h.ctx.sessionController.create({ sessionId: executorSessionId, cwd: h.root })
  const worker = h.ctx.agents.get(executorSessionId)!
  await memorySend(worker, 'Write one clear headline for this group.')
  await h.ctx.sessions.flush(worker.session)
  const log = await h.ctx.sessionController.inspect(worker.id)
  const answer = log.events.findLast(event => event.type === 'assistant/message')
  const input = log.events.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
  if (answer?.type !== 'assistant/message') throw new Error('The real member has no response')
  if (input?.type !== 'user/message') throw new Error('The real member has no task input')
  const delivery: ChatDelivery = {
    id: brandString<ChatDelivery['id']>('transcript-delivery'), chatId: h.chat.id,
    runId: brandString<ChatRunId>('transcript-run'), generation: 1, sourceSessionId: h.chat.rootSessionId,
    source: { kind: 'owner-message', messageId: human().id }, pass: null, botId: writer.id, executorSessionId,
    message: 'Write one clear headline for this group.', inputMessageId: input.data.id,
    relayMessageId: MessageId('transcript-relay'), state: 'completed', relayed: false, error: null,
    receipt: { sender: { botId: writer.id, name: writer.name, role: writer.role, avatar: writer.avatar },
      text: answer.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'),
      outputMessageId: answer.data.message.id, turn: answer.data.turn },
  }
  const message: UserMessage = { id: delivery.relayMessageId, role: 'user',
    content: [{ type: 'text', text: delivery.receipt!.text }], source: {
      kind: 'katcats-group-relay', form: 'relay', schemaVersion: 1, chatId: h.chat.id, runId: delivery.runId,
      generation: delivery.generation, deliveryId: delivery.id, sender: delivery.receipt!.sender,
      executionSessionId: executorSessionId, inputMessageId: delivery.inputMessageId,
      outputMessageId: delivery.receipt!.outputMessageId,
    } }
  return { writer, delivery, message }
}

describe('Group transcript publication without a coordinator model', () => {
  it('records task states once with fixed identities, independent of member speech and later renames', async () => {
    const h = await container([textResponse('The actual task result.')])
    const result = await memberResult(h)
    const queued = { ...result.delivery, state: 'accepted' as const, receipt: null }
    await h.transcript.publishTaskStates(h.chat, [queued], [queued], [result.writer])
    await h.transcript.publishTaskStates(h.chat, [{ ...queued, state: 'running' }], [queued], [{ ...result.writer, name: 'Renamed' }])
    await Promise.all([
      h.transcript.publishTaskStates(h.chat, [result.delivery], [result.delivery], []),
      h.transcript.publishTaskStates(h.chat, [result.delivery], [result.delivery], []),
    ])
    const read = await h.ctx.sessionController.inspect(h.chat.rootSessionId)
    const activity = read.events.filter(event => event.type === 'katcats/group-task-lifecycle')
    expect(activity.map(event => ({ status: event.data.status, actor: event.data.actor.kind,
      target: event.data.target.sender?.name, task: event.data.message, parent: event.data.parentDeliveryId,
      speaking: event.surfaceOp !== undefined }))).toMatchInlineSnapshot(`
      [
        {
          "actor": "owner",
          "parent": null,
          "speaking": false,
          "status": "queued",
          "target": "Writer",
          "task": "Write one clear headline for this group.",
        },
        {
          "actor": "owner",
          "parent": null,
          "speaking": false,
          "status": "started",
          "target": "Writer",
          "task": "Write one clear headline for this group.",
        },
        {
          "actor": "owner",
          "parent": null,
          "speaking": false,
          "status": "completed",
          "target": "Writer",
          "task": "Write one clear headline for this group.",
        },
      ]
    `)
    expect(new Set(activity.map(event => event.data.eventId)).size).toBe(3)
    expect(read.events.some(event => event.type === 'user/message' || event.type === 'assistant/message')).toBe(false)
    expect(h.adapter.requests.map(request => request.sessionId)).toEqual([result.delivery.executorSessionId])
    await h.close()
    const cold = await container([], h.root)
    await cold.transcript.publishTaskStates(cold.chat, [result.delivery], [result.delivery], [])
    const restored = await cold.ctx.sessionController.inspect(cold.chat.rootSessionId)
    expect(restored.events.filter(event => event.type === 'katcats/group-task-lifecycle')).toEqual(activity)
    expect(cold.adapter.requests).toEqual([])
  })

  it('retries unconfirmed activity flushes without duplicate task records or spoken replies', async () => {
    const h = await container([textResponse('Actual result.')])
    const result = await memberResult(h)
    const queued = { ...result.delivery, state: 'accepted' as const, receipt: null }
    const remove = h.ctx.on('session/flush', (session) => {
      if (session.id === h.chat.rootSessionId) throw new Error('Synthetic activity flush rejection')
    })
    await expect(h.transcript.publishTaskStates(h.chat, [queued], [queued], [result.writer]))
      .rejects.toMatchObject({ code: 'KATCATS_CHAT_DURABILITY_UNCONFIRMED' })
    remove()
    await h.transcript.publishTaskStates(h.chat, [queued], [queued], [result.writer])
    const log = await h.ctx.sessionController.inspect(h.chat.rootSessionId)
    expect(log.events.filter(event => event.type === 'katcats/group-task-lifecycle')).toHaveLength(1)
    expect(log.events.some(event => event.type === 'user/message')).toBe(false)
  })

  it('distinguishes stopped queues and uncertain dispatched results and refuses another group or altered task', async () => {
    const h = await container([textResponse('Actual result.')])
    const result = await memberResult(h)
    const cancelled = { ...result.delivery, state: 'failed' as const, receipt: null,
      error: { code: 'stopped', message: 'Stopped before dispatch.' } }
    await h.transcript.publishTaskStates(h.chat, [cancelled], [cancelled], [result.writer])
    const unknown = { ...result.delivery, id: brandString<ChatDelivery['id']>('uncertain-delivery'), state: 'unknown' as const,
      receipt: null, error: { code: 'interrupted', message: 'Execution was interrupted.' } }
    await h.transcript.publishTaskStates(h.chat, [unknown], [unknown], [result.writer])
    const log = await h.ctx.sessionController.inspect(h.chat.rootSessionId)
    expect(log.events.flatMap(event => event.type === 'katcats/group-task-lifecycle' ? [event.data.status] : []))
      .toEqual(['queued', 'cancelled', 'queued', 'started', 'unknown'])
    await expect(h.transcript.publishTaskStates({ ...h.chat, id: brandString<ChatId>('foreign-group') }, [unknown], [unknown], []))
      .rejects.toMatchObject({ code: 'KATCATS_CHAT_MESSAGE_MISMATCH' })
    await expect(h.transcript.publishTaskStates(h.chat, [{ ...unknown, message: 'Altered task.' }], [unknown], []))
      .rejects.toMatchObject({ code: 'KATCATS_CHAT_MESSAGE_MISMATCH' })
  })

  it('publishes exact human and real member messages once without creating container model events', async () => {
    const h = await container([textResponse('Reliable teamwork starts with clear ownership.')])
    const before = await h.ctx.sessionController.inspect(h.chat.rootSessionId)
    const result = await memberResult(h)
    await Promise.all([h.transcript.publishUser(h.chat, human()), h.transcript.publishUser(h.chat, human())])
    await Promise.all([h.transcript.publishReceipt(h.chat, result.delivery, result.message),
      h.transcript.publishReceipt(h.chat, result.delivery, result.message)])
    const after = await h.ctx.sessionController.inspect(h.chat.rootSessionId)
    expect(after.events.slice(0, before.events.length)).toEqual(before.events)
    expect(after.events.slice(before.events.length).map(event => event.type)).toEqual(['user/message', 'user/message'])
    expect(after.events.flatMap(event => event.type === 'user/message'
      ? [{ id: event.data.id, source: event.data.source.kind, content: event.data.content }] : []))
      .toMatchInlineSnapshot(`
        [
          {
            "content": [
              {
                "text": "Please write one clear headline.",
                "type": "text",
              },
            ],
            "id": "transcript-human",
            "source": "user",
          },
          {
            "content": [
              {
                "text": "Reliable teamwork starts with clear ownership.",
                "type": "text",
              },
            ],
            "id": "transcript-relay",
            "source": "katcats-group-relay",
          },
        ]
      `)
    expect(h.adapter.requests.map(request => request.sessionId)).toEqual([result.delivery.executorSessionId])
    expect(h.ctx.agents.get(h.chat.rootSessionId)!.inbox.nextStep).toEqual([])
    expect(h.ctx.agents.get(h.chat.rootSessionId)!.inbox.nextTurn).toEqual([])
  })

  it('retries an accepted append after an unconfirmed flush without adding a duplicate', async () => {
    const h = await container()
    const rejectFlush = h.ctx.on('session/flush', (session) => {
      if (session.id === h.chat.rootSessionId) throw new Error('Synthetic disk acknowledgement failure')
    })
    await expect(h.transcript.publishUser(h.chat, human())).rejects.toMatchObject({ code: 'KATCATS_CHAT_DURABILITY_UNCONFIRMED' })
    const agent = h.ctx.agents.get(h.chat.rootSessionId)!
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(1)
    rejectFlush()
    await h.transcript.publishUser(h.chat, human())
    expect((await h.ctx.sessionController.inspect(agent.id)).events.filter(event => event.type === 'user/message')).toHaveLength(1)
    expect(h.adapter.requests).toEqual([])
  })

  it('resumes a cold container lazily and preserves earlier content when replaying stable message IDs', async () => {
    const first = await container([textResponse('An actual historical reply from the previous group implementation.')])
    const agent = first.ctx.agents.get(first.chat.rootSessionId)!
    await memorySend(agent, 'Historical user message.')
    await first.ctx.sessions.flush(agent.session)
    const legacy = await first.ctx.sessionController.inspect(agent.id)
    await first.transcript.publishUser(first.chat, human())
    await first.close()
    const second = await container([], first.root)
    expect(second.ctx.agents.get(first.chat.rootSessionId)).toBeUndefined()
    await second.transcript.publishUser(second.chat, human())
    const restored = await second.ctx.sessionController.inspect(second.chat.rootSessionId)
    expect(restored.events.slice(0, legacy.events.length)).toEqual(legacy.events)
    expect(restored.events.filter(event => event.type === 'user/message' && event.data.id === human().id)).toHaveLength(1)
    expect(restored.events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
    expect(second.adapter.requests).toEqual([])
  })

  it('refuses conflicting stable message IDs and fabricated member relay content', async () => {
    const h = await container([textResponse('The actual member response.')])
    await h.transcript.publishUser(h.chat, human())
    await expect(h.transcript.publishUser(h.chat, human('Different content under the same ID.')))
      .rejects.toMatchObject({ code: 'KATCATS_CHAT_MESSAGE_MISMATCH' })
    const result = await memberResult(h)
    await expect(h.transcript.publishReceipt(h.chat, result.delivery,
      { ...result.message, content: [{ type: 'text', text: 'A fabricated substitute.' }] }))
      .rejects.toMatchObject({ code: 'KATCATS_CHAT_MESSAGE_MISMATCH' })
    await expect(h.transcript.publishReceipt(h.chat, { ...result.delivery, state: 'running' }, result.message))
      .rejects.toMatchObject({ code: 'KATCATS_CHAT_MESSAGE_MISMATCH' })
    const log = await h.ctx.sessionController.inspect(h.chat.rootSessionId)
    expect(log.events.filter(event => event.type === 'user/message')).toHaveLength(1)
  })

  it('refuses a live or cold legacy inbox without consuming or waking its queued work', async () => {
    const first = await container()
    const queued = createUserMessage({ content: [{ type: 'text', text: 'An earlier task requiring owner inspection.' }], source: { kind: 'user' } })
    const agent = first.ctx.agents.get(first.chat.rootSessionId)!
    agent.send(queued, 'next-turn', false)
    await first.ctx.sessions.flush(agent.session)
    await expect(first.transcript.publishUser(first.chat, human())).rejects.toMatchObject({ code: 'KATCATS_CHAT_CONTAINER_BUSY' })
    expect(agent.inbox.nextTurn.map(message => message.id)).toEqual([queued.id])
    expect(first.adapter.requests).toEqual([])
    const coldId = SessionId('transcript-cold-pending')
    await using stored = await first.ctx.sessionPersistence.create({ ...agent.session.header, id: coldId })
    await stored.append(agent.session.snapshotEvents())
    await stored.flush()
    await stored.close()
    await first.close()
    const second = await container([], first.root)
    const coldChat = { ...second.chat, rootSessionId: coldId }
    await expect(second.transcript.publishUser(coldChat, human())).rejects.toMatchObject({ code: 'KATCATS_CHAT_CONTAINER_BUSY' })
    expect(second.ctx.agents.get(coldId)!.inbox.nextTurn.map(message => message.id)).toEqual([queued.id])
    expect(second.adapter.requests).toEqual([])
  })

  it('refuses an occupied maintenance phase and a real model turn instead of waiting for side effects', async () => {
    const h = await container(['hang-slow'])
    const agent = h.ctx.agents.get(h.chat.rootSessionId)!
    const release = Promise.withResolvers<undefined>()
    const maintenance = agent.runMaintenance(() => release.promise)
    await expect(h.transcript.publishUser(h.chat, human())).rejects.toMatchObject({ code: 'KATCATS_CHAT_CONTAINER_BUSY' })
    release.resolve(undefined)
    await maintenance
    const started = Promise.withResolvers<undefined>()
    const remove = h.ctx.on('llm/stream', (request, next) => {
      if (request.sessionId === agent.id) started.resolve(undefined)
      return next()
    })
    try {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'A genuine earlier model task.' }], source: { kind: 'user' } }))
      await started.promise
      await expect(h.transcript.publishUser(h.chat, human())).rejects.toMatchObject({ code: 'KATCATS_CHAT_CONTAINER_BUSY' })
    } finally {
      agent.cancel({ kind: 'user' })
      await agent.whenIdle()
      remove()
    }
    expect((await h.ctx.sessionController.inspect(agent.id)).events.some(event => event.type === 'user/message' && event.data.id === human().id)).toBe(false)
  })
})
