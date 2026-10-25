/** Serialized dispatch admission over synthetic group storage, without running member models. */
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import Commands from '@deepseek-ai/dsh-commands'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import KatcatsChats from '../src/chats.ts'
import { ChatsRuntime } from '../src/chats-runtime.ts'
import type { ChatRuntimeActions } from '../src/chats-runtime-types.ts'
import { chatsDomainSpec, chatsStateSchema } from '../src/chats-storage.ts'
import type { ChatDelivery, TeamChat } from '../src/chats-types.ts'
import { harness } from './member-fixture.ts'

async function setup(relayLimit = 8, providedRoot?: string) {
  vi.spyOn(ChatsRuntime.prototype, 'kick').mockImplementation(() => {})
  const h = await harness(providedRoot)
  await h.ctx.plugin(AttachmentLocal, { dshHome: join(h.root, 'home') })
  await h.ctx.plugin(CredentialsLocal, { path: join(h.root, 'credentials.yaml'), watch: false })
  await h.ctx.plugin(Connection)
  await h.ctx.plugin(Commands)
  await h.ctx.plugin(FileUploads)
  await h.ctx.plugin(KatcatsChats, { workspaceRoot: join(h.root, 'workspaces'), relayLimit })
  const chats = h.ctx.katcatsChats
  await chats.snapshot()
  // These are the real serialized directory operations supplied to the owned runtime.
  const actions: ChatRuntimeActions = chats['runtimeActions']()
  const state = () => chatsStateSchema.parse(h.ctx.storageDomain.get(chatsDomainSpec.name)!.global.get())
  async function admit(chat: TeamChat, request = 'domain-owner-input') {
    await chats.sendMessage({ sessionId: chat.rootSessionId, requestId: brandString<SessionRequestId>(request),
      mode: 'queue', content: [{ type: 'text', text: 'Work together on the saved task.' }] }, new AbortController().signal)
    const saved = await actions.read(chat.id)
    const input = saved.inbounds.at(-1)!
    return Promise.all(input.recipients.map(botId => actions.acceptDelivery({
      chatId: chat.id, runId: input.runId, generation: input.generation, sourceSessionId: chat.rootSessionId,
      source: { kind: 'owner-message', messageId: input.userMessage.id }, botId, message: 'Do your part.',
    })))
  }
  return { ...h, chats, actions, state, admit }
}

describe('group dispatch directory ownership', () => {
  it('serializes rapid steering only within its group and exposes the admitted handover while another group accepts input', async () => {
    const h = await setup()
    const a = (await h.team.createBot({ name: 'A' })).bot
    const chat = (await h.chats.createChat({ name: 'Steering', memberIds: [a.id] })).chat
    const other = (await h.chats.createChat({ name: 'Independent', memberIds: [a.id] })).chat
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const runtime = h.chats['runtime']
    const original = runtime.interrupt.bind(runtime)
    const interrupt = vi.spyOn(runtime, 'interrupt').mockImplementationOnce(async (...args) => {
      await original(...args)
      entered.resolve(undefined)
      await release.promise
    })
    const request = { sessionId: chat.rootSessionId, requestId: brandString<SessionRequestId>('first-steering'),
      mode: 'steer' as const, content: [{ type: 'text' as const, text: 'First instruction.' }] }
    const first = h.chats.sendMessage(request, new AbortController().signal)
    const second = h.chats.sendMessage({ ...request, requestId: brandString<SessionRequestId>('second-steering'),
      content: [{ type: 'text', text: 'Latest instruction.' }] }, new AbortController().signal)
    await entered.promise
    try {
      expect((await h.chats.snapshot()).activities.find(activity => activity.chatId === chat.id)?.pendingControl).toBe('stop')
      expect(h.state().inbounds.filter(input => input.chatId === chat.id)).toHaveLength(1)
      await h.chats.sendMessage({ ...request, sessionId: other.rootSessionId,
        requestId: brandString<SessionRequestId>('independent-steering') }, new AbortController().signal)
      expect((await h.actions.read(other.id)).inbounds).toHaveLength(1)
      expect(h.state().inbounds.filter(input => input.chatId === chat.id)).toHaveLength(1)
    } finally { release.resolve(undefined) }
    await Promise.all([first, second])
    const saved = await h.actions.read(chat.id)
    expect(saved.chat.generation).toBe(2)
    expect(saved.inbounds.map(input => input.requestId)).toEqual([request.requestId, 'second-steering'])
    expect(new Set(saved.inbounds.map(input => input.userMessage.id)).size).toBe(2)
    expect((await h.chats.snapshot()).activities.every(activity => activity.pendingControl === null)).toBe(true)
    await h.chats.sendMessage(request, new AbortController().signal)
    expect(interrupt).toHaveBeenCalledTimes(3)
    expect((await h.actions.read(chat.id)).chat.generation).toBe(2)
    expect(h.adapter.requests).toEqual([])
  })

  it('leaves the old run intact when replacement storage fails and accepts the same request on retry', async () => {
    const h = await setup()
    const a = (await h.team.createBot({ name: 'A' })).bot
    const chat = (await h.chats.createChat({ name: 'Failed steering', memberIds: [a.id] })).chat
    await h.admit(chat)
    const before = h.state()
    const domain = h.ctx.storageDomain.get(chatsDomainSpec.name)!
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Fixture steering storage failed'))
    const request = { sessionId: chat.rootSessionId, requestId: brandString<SessionRequestId>('failed-steering'),
      mode: 'steer' as const, content: [{ type: 'text' as const, text: 'Replace the previous task.' }] }
    await expect(h.chats.sendMessage(request, new AbortController().signal)).rejects.toThrow('Fixture steering storage failed')
    expect(h.state()).toEqual(before)
    expect((await h.chats.snapshot()).activities[0]?.pendingControl).toBeNull()
    await expect(h.chats.sendMessage(request, new AbortController().signal)).resolves.toEqual({ accepted: true })
    const saved = await h.actions.read(chat.id)
    expect(saved.chat.generation).toBe(before.chats.find(value => value.id === chat.id)!.generation + 1)
    expect(saved.inbounds.filter(input => input.requestId === request.requestId)).toHaveLength(1)
    expect(saved.deliveries[0]).toMatchObject({ state: 'failed', error: { code: 'superseded' } })
    expect(h.adapter.requests).toEqual([])
  })

  it('retains a durable replacement when task publication fails and retries its saved input without interrupting again', async () => {
    const h = await setup()
    const a = (await h.team.createBot({ name: 'A' })).bot
    const chat = (await h.chats.createChat({ name: 'Saved steering', memberIds: [a.id] })).chat
    await h.admit(chat)
    const before = (await h.actions.read(chat.id)).chat
    const interrupt = vi.spyOn(ChatsRuntime.prototype, 'interrupt')
    vi.spyOn(ChatsRuntime.prototype, 'publishTaskStates').mockRejectedValueOnce(new Error('Fixture task projection failed'))
    const request = { sessionId: chat.rootSessionId, requestId: brandString<SessionRequestId>('saved-steering'),
      mode: 'steer' as const, content: [{ type: 'text' as const, text: 'This instruction was saved.' }] }
    await expect(h.chats.sendMessage(request, new AbortController().signal)).rejects.toThrow('Fixture task projection failed')
    const saved = await h.actions.read(chat.id)
    expect(saved.chat).toMatchObject({ generation: before.generation + 1, status: 'paused', pauseReason: 'interruption-unconfirmed' })
    expect(saved.inbounds.filter(input => input.requestId === request.requestId)).toHaveLength(1)
    const input = saved.inbounds.find(input => input.requestId === request.requestId)!
    expect((await h.chats.snapshot()).activities[0]?.pendingControl).toBeNull()
    await expect(h.chats.sendMessage(request, new AbortController().signal)).resolves.toEqual({ accepted: true })
    const retried = await h.actions.read(chat.id)
    expect(retried.chat.generation).toBe(saved.chat.generation)
    expect(retried.inbounds.filter(value => value.requestId === request.requestId)).toEqual([{ ...input, state: 'published' }])
    expect(interrupt).toHaveBeenCalledTimes(1)
    expect(h.adapter.requests).toEqual([])
  })

  it('admits simultaneous running deliveries to distinct executors in one group', async () => {
    const h = await setup()
    const a = (await h.team.createBot({ name: 'A' })).bot
    const b = (await h.team.createBot({ name: 'B' })).bot
    const chat = (await h.chats.createChat({ name: 'Team', memberIds: [a.id, b.id] })).chat
    const deliveries = await h.admit(chat)
    const running = await Promise.all(deliveries.map(delivery => h.actions.markRunning(delivery.id)))
    expect(running.map(delivery => delivery.state)).toEqual(['running', 'running'])
    expect(new Set(running.map(delivery => delivery.executorSessionId)).size).toBe(2)
    expect(h.state().deliveries).toEqual(running)
    expect((await h.actions.read(chat.id)).chat.run?.relayCount).toBe(2)
    expect(h.adapter.requests).toEqual([])
  })

  it('refuses a second dispatch to the same executor without consuming budget or changing its journal', async () => {
    const h = await setup()
    const a = (await h.team.createBot({ name: 'A' })).bot
    const b = (await h.team.createBot({ name: 'B' })).bot
    const chat = (await h.chats.createChat({ name: 'Team', memberIds: [a.id, b.id] })).chat
    const initial = await h.admit(chat)
    const parent = await h.actions.markRunning(initial.find(delivery => delivery.botId === b.id)!.id)
    const duplicateExecutor = await h.actions.acceptDelivery({
      chatId: chat.id, runId: parent.runId, generation: parent.generation, sourceSessionId: parent.executorSessionId,
      source: { kind: 'tool', turn: 1, step: 1, callId: brandString<ToolCallId>('request-a-again'), parentDeliveryId: parent.id },
      botId: a.id, message: 'Another task for A.',
    })
    const target = initial.find(delivery => delivery.botId === a.id)!
    await h.actions.markRunning(target.id)
    const before = h.state()
    await expect(h.actions.markRunning(duplicateExecutor.id)).rejects.toMatchObject({ code: 'gateway/bad-request',
      message: 'This group member must finish its current task before another task starts' })
    expect(h.state()).toEqual(before)
    expect(h.state().deliveries.find(delivery => delivery.id === duplicateExecutor.id)?.state).toBe('accepted')
    expect((await h.actions.read(chat.id)).chat.run?.relayCount).toBe(2)
  })

  it('serializes concurrent budget checks while allowing the same Bot in another group to run', async () => {
    const h = await setup(2)
    const bots = await Promise.all(['A', 'B', 'C'].map(async name => (await h.team.createBot({ name })).bot))
    const chat = (await h.chats.createChat({ name: 'Limited', memberIds: bots.map(bot => bot.id) })).chat
    const other = (await h.chats.createChat({ name: 'Other', memberIds: [bots[0]!.id] })).chat
    const deliveries = await h.admit(chat)
    const outcomes = await Promise.allSettled(deliveries.map(delivery => h.actions.markRunning(delivery.id)))
    expect(outcomes.map(result => result.status)).toEqual(['fulfilled', 'fulfilled', 'rejected'])
    const limited = await h.actions.read(chat.id)
    expect(limited.chat).toMatchObject({ status: 'paused', pauseReason: 'relay-limit', run: { relayCount: 2 } })
    expect(limited.deliveries.map(delivery => delivery.state)).toEqual(['running', 'running', 'accepted'])
    const separate = (await h.admit(other, 'other-owner-input'))[0]!
    await expect(h.actions.markRunning(separate.id)).resolves.toMatchObject({ state: 'running', botId: bots[0]!.id })
    expect((await h.actions.read(other.id)).chat.run?.relayCount).toBe(1)
    expect((await h.actions.read(chat.id)).deliveries).toEqual(limited.deliveries)
    expect(h.adapter.requests).toEqual([])
  })

  it('invalidates only a stopped group and never labels already dispatched work as cancelled or completed', async () => {
    const h = await setup()
    const bots = await Promise.all(['A', 'B', 'C'].map(async name => (await h.team.createBot({ name })).bot))
    const chat = (await h.chats.createChat({ name: 'Stopped', memberIds: bots.map(bot => bot.id) })).chat
    const other = (await h.chats.createChat({ name: 'Other', memberIds: [bots[0]!.id] })).chat
    const deliveries = await h.admit(chat)
    await Promise.all(deliveries.slice(0, 2).map(delivery => h.actions.markRunning(delivery.id)))
    const separate = (await h.admit(other, 'separate-owner-input'))[0]!
    await h.actions.markRunning(separate.id)
    const beforeOther = await h.actions.read(other.id)
    const before = (await h.actions.read(chat.id)).chat
    await h.actions.stopped(chat.id, { runId: before.run!.id, generation: before.generation })
    const stopped = await h.actions.read(chat.id)
    expect(stopped.chat).toMatchObject({ status: 'stopped', run: null, generation: before.generation + 1 })
    expect(stopped.deliveries.map(delivery => delivery.state)).toEqual(['running', 'running', 'failed'])
    expect(stopped.deliveries[2]).toMatchObject({ error: { code: 'stopped' }, receipt: null })
    await expect(h.actions.markRunning(deliveries[2]!.id)).rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(await h.actions.read(other.id)).toEqual(beforeOther)
    expect(h.adapter.requests).toEqual([])
  })

  it('queues a new owner input during a budget pause without replacing running or accepted member work', async () => {
    const h = await setup(1)
    const a = (await h.team.createBot({ name: 'A' })).bot
    const b = (await h.team.createBot({ name: 'B' })).bot
    const chat = (await h.chats.createChat({ name: 'Budget wait', memberIds: [a.id, b.id] })).chat
    const deliveries = await h.admit(chat)
    await h.actions.markRunning(deliveries[0]!.id)
    await expect(h.actions.markRunning(deliveries[1]!.id)).rejects.toMatchObject({ code: 'gateway/bad-request' })
    const before = await h.actions.read(chat.id)
    expect(before.chat).toMatchObject({ status: 'paused', pauseReason: 'relay-limit' })
    await h.chats.sendMessage({ sessionId: chat.rootSessionId,
      requestId: brandString<SessionRequestId>('owner-after-budget-pause'), mode: 'queue',
      content: [{ type: 'text', text: 'Please preserve this next instruction.' }] }, new AbortController().signal)
    const queued = await h.actions.read(chat.id)
    expect(queued.chat).toEqual(before.chat)
    expect(queued.deliveries).toEqual(before.deliveries)
    expect(queued.deliveries[0]).toMatchObject({ state: 'running', receipt: null })
    expect(queued.deliveries[1]).toMatchObject({ state: 'accepted', receipt: null })
    expect(queued.inbounds).toHaveLength(2)
    expect(queued.inbounds[1]).toMatchObject({ runId: queued.chat.run!.id, generation: queued.chat.generation,
      state: 'published', userMessage: { content: [{ type: 'text', text: 'Please preserve this next instruction.' }] } })
    expect(h.adapter.requests).toEqual([])
  })

  it('reopens multiple running executors as unknown without resetting data or starting another model', async () => {
    const first = await setup()
    const a = (await first.team.createBot({ name: 'A' })).bot
    const b = (await first.team.createBot({ name: 'B' })).bot
    const chat = (await first.chats.createChat({ name: 'Restart', memberIds: [a.id, b.id] })).chat
    const deliveries = await first.admit(chat)
    await Promise.all(deliveries.map(delivery => first.actions.markRunning(delivery.id)))
    await first.close()
    const second = await setup(8, first.root)
    const reopened = await second.actions.read(chat.id)
    expect(reopened.chat).toMatchObject({ id: chat.id, status: 'paused', pauseReason: 'restart' })
    expect(reopened.deliveries.map((delivery: ChatDelivery) => ({ id: delivery.id, state: delivery.state, receipt: delivery.receipt })))
      .toEqual(deliveries.map(delivery => ({ id: delivery.id, state: 'unknown', receipt: null })))
    expect(second.adapter.requests).toEqual([])
  })

  it('preserves queued owner inputs through budget pauses and refuses to advance unknown outcomes', async () => {
    const h = await setup(1)
    const a = (await h.team.createBot({ name: 'A' })).bot
    const b = (await h.team.createBot({ name: 'B' })).bot
    const chat = (await h.chats.createChat({ name: 'Queued before pause', memberIds: [a.id, b.id] })).chat
    const deliveries = await h.admit(chat)
    await h.actions.markRunning(deliveries[0]!.id)
    await h.chats.sendMessage({ sessionId: chat.rootSessionId,
      requestId: brandString<SessionRequestId>('owner-before-budget-pause'), mode: 'queue',
      content: [{ type: 'text', text: 'This followup arrives before the automatic pause.' }] }, new AbortController().signal)
    const active = await h.actions.read(chat.id)
    const expected = { runId: active.chat.run!.id, generation: active.chat.generation }
    const before = h.state()
    await expect(h.actions.advanceOwnerRun(chat.id, expected)).resolves.toBe(false)
    expect(h.state()).toEqual(before)
    await expect(h.actions.markRunning(deliveries[1]!.id)).rejects.toMatchObject({ code: 'gateway/bad-request' })
    const paused = h.state()
    await expect(h.actions.advanceOwnerRun(chat.id, expected)).resolves.toBe(false)
    expect(h.state()).toEqual(paused)
    const retained = await h.actions.read(chat.id)
    expect(retained.chat).toMatchObject({ status: 'paused', pauseReason: 'relay-limit', generation: active.chat.generation,
      run: { id: expected.runId, relayCount: 1 } })
    expect(retained.deliveries[0]).toMatchObject({ id: deliveries[0]!.id, state: 'running', receipt: null })
    expect(retained.deliveries[1]).toMatchObject({ id: deliveries[1]!.id, state: 'accepted', receipt: null })
    expect(retained.inbounds[1]).toMatchObject({ runId: expected.runId, generation: expected.generation })

    const uncertain = (await h.chats.createChat({ name: 'Unknown cannot advance', memberIds: [a.id, b.id] })).chat
    const work = await h.admit(uncertain, 'uncertain-owner-input')
    await h.actions.markRunning(work[0]!.id)
    await h.chats.sendMessage({ sessionId: uncertain.rootSessionId,
      requestId: brandString<SessionRequestId>('uncertain-queued-followup'), mode: 'queue',
      content: [{ type: 'text', text: 'Do not conceal an unknown result by advancing.' }] }, new AbortController().signal)
    const saved = (await h.actions.read(uncertain.id)).chat
    const expectedUnknown = { runId: saved.run!.id, generation: saved.generation }
    await h.actions.failDelivery(work[0]!.id, { code: 'fixture-unknown', message: 'The dispatched result is unconfirmed.' }, true)
    await h.actions.pause(uncertain.id, 'relay-limit', expectedUnknown)
    const beforeUnknown = h.state()
    await expect(h.actions.advanceOwnerRun(uncertain.id, expectedUnknown)).resolves.toBe(false)
    expect(h.state()).toEqual(beforeUnknown)
    expect((await h.actions.read(uncertain.id)).deliveries[0]?.state).toBe('unknown')
    expect(h.adapter.requests).toEqual([])
  })
})
