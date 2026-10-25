/** Queued owner questions acknowledge without cancelling real nested group work. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import ApprovalService, { type ApprovalAnswer } from '@deepseek-ai/dsh-user-approval'
import type { TeamChat } from '../src/chats-types.ts'
import { memoryFixture } from './memory-fixture.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

function currentTask(request: GenerateOptions): string {
  return request.messages.findLast(message => message.role === 'user' && message.source?.kind === 'katcats-group-task')
    ?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    .split('The following is the saved public group conversation.')[0] ?? ''
}

async function send(ctx: Context, chat: TeamChat, text: string, requestId: string) {
  return ctx.katcatsChats.sendMessage({ sessionId: chat.rootSessionId, mode: 'queue',
    requestId: brandString<SessionRequestId>(requestId), content: [{ type: 'text', text }],
  }, new AbortController().signal)
}

async function settled(ctx: Context, chat: TeamChat): Promise<void> {
  const controller = new AbortController()
  try {
    for await (const frame of ctx.katcatsChats.follow(controller.signal)) {
      if (frame.value.activities.find(activity => activity.chatId === chat.id)?.processing === false) return
    }
    throw new Error('The synthetic queued group closed before its work settled')
  } finally { controller.abort() }
}

async function budgetPaused(ctx: Context, chat: TeamChat): Promise<TeamChat> {
  const controller = new AbortController()
  try {
    for await (const frame of ctx.katcatsChats.follow(controller.signal)) {
      const current = frame.value.chats.find(value => value.id === chat.id)
      if (current?.status === 'paused' && current.pauseReason === 'relay-limit') return current
    }
    throw new Error('The synthetic group closed before its budget pause')
  } finally { controller.abort() }
}

describe('ordinary owner follow-ups preserve current group work', () => {
  it('acknowledges two queued questions and their retry during B approval, then lets A answer after the actual result', async () => {
    const written: string[] = []
    const h = await memoryFixture([
      (request) => {
        expect(request.sessionId).toBe(workerA)
        expect(currentTask(request)).toContain('ORIGINAL_TASK')
        return toolCallResponse('ask-b', 'request_group_member', { bot_id: b.id, message: 'Save the actual B result and return it.' },
          'I will ask B for its saved result and finish the original task after receiving it.')
      },
      (request) => {
        expect(request.sessionId).toBe(workerB)
        return toolCallResponse('b-write', 'queue_fixture_write', {}, 'I will write the requested B file.')
      },
      (request) => {
        expect(request.sessionId).toBe(workerB)
        expect(written).toEqual(['B_RESULT_SAVED'])
        return textResponse('B_RESULT_SAVED is ready in [B result](./b-result.md).')
      },
      (request) => {
        expect(request.sessionId).toBe(workerA)
        expect(currentTask(request)).toContain('ORIGINAL_TASK')
        expect(JSON.stringify(request.messages)).toContain('B_RESULT_SAVED is ready')
        return textResponse('The original task is complete with the actual B result.')
      },
      (request) => {
        expect(request.sessionId).toBe(workerA)
        expect(currentTask(request)).toContain('FOLLOWUP_ONE')
        expect(JSON.stringify(request.messages)).toContain('The original task is complete with the actual B result.')
        return textResponse('FOLLOWUP_ONE: B finished the saved file; its task was preserved.')
      },
      (request) => {
        expect(request.sessionId).toBe(workerA)
        expect(currentTask(request)).toContain('FOLLOWUP_TWO')
        return textResponse('FOLLOWUP_TWO: the original saved B result remains available.')
      },
    ])
    const a = (await h.ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const b = (await h.ctx.katcatsTeam.createBot({ name: 'B' })).bot
    const chat = (await h.ctx.katcatsChats.createChat({ name: 'Preserved work and queued questions', memberIds: [a.id, b.id], managerId: a.id })).chat
    const workerA = chat.executors.find(executor => executor.botId === a.id)!.sessionId
    const workerB = chat.executors.find(executor => executor.botId === b.id)!.sessionId
    const privateEvents = [a, b].map(bot => ({ id: bot.sessionId, events: h.ctx.agents.get(bot.sessionId)!.session.snapshotEvents() }))
    h.ctx.effect(() => h.ctx.tools.register(defineTool({ name: 'queue_fixture_write', description: 'Write the original B group file.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async (_args, exec) => {
        expect(exec.agent?.id).toBe(workerB)
        exec.signal.throwIfAborted()
        await writeFile(join(chat.workDir, 'b-result.md'), 'B_RESULT_SAVED')
        written.push('B_RESULT_SAVED')
        return 'B_RESULT_SAVED'
      },
    })))
    h.ctx.loader.builtins['queue-approval'] = ApprovalService
    await h.ctx.loader.create({ name: 'cordis:queue-approval' })
    await h.ctx.loader.await()
    const shown = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<ApprovalAnswer>()
    h.ctx.on('tools/pre-execute', async (exec, next) => {
      const previous = await next()
      return exec.name === 'queue_fixture_write' && previous.kind === 'allow'
        ? { kind: 'ask', reason: 'Allow the original B group file.' } : previous
    })
    h.ctx.on('approval/request', () => { shown.resolve(undefined); return answer.promise })
    try {
      await send(h.ctx, chat, '@A ORIGINAL_TASK: ask B to save its actual result.', 'original-task')
      await shown.promise
      const before = await h.ctx.katcatsChats.snapshot()
      const first = before.chats[0]!
      expect(before.deliveries.map(delivery => delivery.state)).toEqual(['running', 'running'])
      expect(await send(h.ctx, chat, '@A FOLLOWUP_ONE: is B still working?', 'followup-one')).toEqual({ accepted: true })
      expect(await send(h.ctx, chat, '@A FOLLOWUP_TWO: keep the saved work.', 'followup-two')).toEqual({ accepted: true })
      expect(await send(h.ctx, chat, '@A FOLLOWUP_ONE: is B still working?', 'followup-one')).toEqual({ accepted: true })
      const pending = await h.ctx.katcatsChats.snapshot()
      expect(pending.chats[0]).toMatchObject({ status: 'active', pauseReason: null, generation: first.generation, run: { id: first.run!.id } })
      expect(pending.deliveries.map(delivery => delivery.id)).toEqual(before.deliveries.map(delivery => delivery.id))
      expect(pending.activities[0]).toMatchObject({ processing: true, pendingControl: null })
      expect(h.adapter.requests.map(request => request.sessionId)).toEqual([workerA, workerB])
      expect(h.adapter.requests.every(request => request.signal?.aborted !== true)).toBe(true)
      expect(written).toEqual([])
      const approval = await h.ctx.sessionController.inspect(workerB)
      expect(approval.events.some(event => event.type === 'approval/asked')).toBe(true)
      expect(approval.events.some(event => event.type === 'approval/decided')).toBe(false)
      const acknowledged = await h.ctx.sessionController.inspect(chat.rootSessionId)
      expect(acknowledged.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(3)
      answer.resolve('allowed-once')
      await settled(h.ctx, chat)
      const done = await h.ctx.katcatsChats.snapshot()
      expect(done.chats[0]).toMatchObject({ status: 'active', pauseReason: null, run: null, error: null })
      expect(done.deliveries.every(delivery => delivery.state === 'completed' && delivery.relayed)).toBe(true)
      expect(written).toEqual(['B_RESULT_SAVED'])
      expect(await readFile(join(chat.workDir, 'b-result.md'), 'utf8')).toBe('B_RESULT_SAVED')
      expect(h.adapter.requests.map(request => request.sessionId)).toEqual([workerA, workerB, workerB, workerA, workerA, workerA])
      expect(h.adapter.requests.some(request => request.sessionId === chat.rootSessionId)).toBe(false)
      for (const prior of privateEvents) expect(h.ctx.agents.get(prior.id)!.session.snapshotEvents()).toEqual(prior.events)
      const root = await h.ctx.sessionController.inspect(chat.rootSessionId)
      const replies = root.events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'katcats-group-relay'
        ? [{ name: event.data.source.sender.name, text: event.data.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') }] : [])
      expect(replies.filter(reply => reply.text.startsWith('FOLLOWUP_'))).toEqual([
        { name: 'A', text: 'FOLLOWUP_ONE: B finished the saved file; its task was preserved.' },
        { name: 'A', text: 'FOLLOWUP_TWO: the original saved B result remains available.' },
      ])
      expect(root.events.some(event => event.type === 'turn/start')).toBe(false)
    } finally { answer.resolve('rejected') }
  })

  it('starts a fresh run for an ordinary queued message after Stop and again after the completed run', async () => {
    const h = await memoryFixture(['hang', textResponse('The stopped group answers its new ordinary message.'), textResponse('The next ordinary message is also answered.')])
    const a = (await h.ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const chat = (await h.ctx.katcatsChats.createChat({ name: 'Stopped and finished groups', memberIds: [a.id] })).chat
    await send(h.ctx, chat, 'ORIGINAL_RUNNING_TASK', 'original-running-task')
    await expect.poll(() => h.adapter.requests.length).toBe(1)
    const active = (await h.ctx.katcatsChats.snapshot()).chats[0]!
    await h.ctx.katcatsChats.stop({ id: chat.id, expectedRunId: active.run!.id, expectedGeneration: active.generation })
    const stopped = (await h.ctx.katcatsChats.snapshot()).chats[0]!
    expect(stopped).toMatchObject({ status: 'stopped', run: null })
    expect(await send(h.ctx, chat, 'NEW_AFTER_STOP', 'after-stop')).toEqual({ accepted: true })
    await settled(h.ctx, chat)
    const first = (await h.ctx.katcatsChats.snapshot()).chats[0]!
    expect(first).toMatchObject({ status: 'active', pauseReason: null, run: null })
    expect(first.generation).toBe(stopped.generation + 1)
    expect(await send(h.ctx, chat, 'NEW_AFTER_COMPLETION', 'after-completion')).toEqual({ accepted: true })
    await settled(h.ctx, chat)
    const final = await h.ctx.katcatsChats.snapshot()
    expect(final.chats[0]).toMatchObject({ status: 'active', pauseReason: null, run: null })
    expect(final.chats[0]!.generation).toBe(first.generation + 1)
    expect(final.deliveries.filter(delivery => delivery.state === 'completed').map(delivery => delivery.receipt?.text)).toEqual([
      'The stopped group answers its new ordinary message.', 'The next ordinary message is also answered.',
    ])
    expect(h.adapter.requests).toHaveLength(3)
    expect(h.adapter.requests[0]!.signal?.aborted).toBe(true)
  })

  it('acknowledges a queued message while owner-paused and waits for Continue before asking a model', async () => {
    const h = await memoryFixture([textResponse('A answers only after the owner continues the paused group.')])
    const a = (await h.ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const chat = (await h.ctx.katcatsChats.createChat({ name: 'Owner-paused queue', memberIds: [a.id] })).chat
    await h.ctx.katcatsChats.pause({ id: chat.id, expectedRunId: null, expectedGeneration: chat.generation })
    expect(await send(h.ctx, chat, 'QUEUED_WHILE_PAUSED', 'paused-question')).toEqual({ accepted: true })
    await settled(h.ctx, chat)
    const paused = (await h.ctx.katcatsChats.snapshot()).chats[0]!
    expect(paused).toMatchObject({ status: 'paused', pauseReason: 'owner', error: null })
    expect(h.adapter.requests).toEqual([])
    const history = await h.ctx.sessionController.inspect(chat.rootSessionId)
    expect(history.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
    await h.ctx.katcatsChats.resume({ id: chat.id, expectedRunId: paused.run!.id, expectedGeneration: paused.generation })
    await settled(h.ctx, chat)
    expect((await h.ctx.katcatsChats.snapshot()).chats[0]).toMatchObject({ status: 'active', run: null, pauseReason: null })
    expect(h.adapter.requests).toHaveLength(1)
    expect(currentTask(h.adapter.requests[0]!)).toContain('QUEUED_WHILE_PAUSED')
  })

  it('keeps queued questions paused after an unknown result and does not retry that work when a new stopped run begins', async () => {
    const h = await memoryFixture([
      () => { throw new Error('Synthetic provider failed after accepting the original group request') },
      (request) => {
        expect(currentTask(request)).toContain('FRESH_AFTER_INSPECTION_AND_STOP')
        return textResponse('A answers the explicitly new message without repeating the unconfirmed task.')
      },
    ])
    const a = (await h.ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const chat = (await h.ctx.katcatsChats.createChat({ name: 'Unknown result queue', memberIds: [a.id] })).chat
    await send(h.ctx, chat, 'UNCONFIRMED_ORIGINAL', 'unconfirmed-original')
    await settled(h.ctx, chat)
    const uncertain = await h.ctx.katcatsChats.snapshot()
    const original = uncertain.chats[0]!
    expect(original).toMatchObject({ status: 'paused', pauseReason: 'unknown-result' })
    expect(uncertain.deliveries[0]).toMatchObject({ state: 'unknown', receipt: null })
    expect(await send(h.ctx, chat, 'QUEUED_AFTER_UNKNOWN', 'queued-after-unknown')).toEqual({ accepted: true })
    await settled(h.ctx, chat)
    const queued = (await h.ctx.katcatsChats.snapshot()).chats[0]!
    expect(queued).toMatchObject({ status: 'paused', pauseReason: 'unknown-result', generation: original.generation, run: { id: original.run!.id } })
    expect(h.adapter.requests).toHaveLength(1)
    await expect(h.ctx.katcatsChats.resume({ id: chat.id, expectedRunId: queued.run!.id, expectedGeneration: queued.generation }))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(h.adapter.requests).toHaveLength(1)
    await h.ctx.katcatsChats.stop({ id: chat.id, expectedRunId: queued.run!.id, expectedGeneration: queued.generation })
    await send(h.ctx, chat, 'FRESH_AFTER_INSPECTION_AND_STOP', 'fresh-after-stop')
    await settled(h.ctx, chat)
    const done = await h.ctx.katcatsChats.snapshot()
    expect(done.chats[0]).toMatchObject({ status: 'active', pauseReason: null, run: null })
    expect(done.deliveries[0]).toMatchObject({ id: uncertain.deliveries[0]!.id, state: 'unknown', receipt: null })
    expect(done.deliveries.filter(delivery => delivery.state === 'completed')).toHaveLength(1)
    expect(h.adapter.requests).toHaveLength(2)
  })

  it.each(['before-budget', 'after-budget'] as const)('preserves the waiting parent and child when a question arrives %s until Continue', async (timing) => {
    const h = await memoryFixture([
      () => toolCallResponse('budget-ask-b', 'request_group_member', { bot_id: b.id, message: 'Return the real B result for the original task.' }),
      (request) => { expect(request.sessionId).toBe(workerB); return textResponse('B completed the original budget-held task.') },
      (request) => {
        expect(request.sessionId).toBe(workerA)
        expect(JSON.stringify(request.messages)).toContain('B completed the original budget-held task.')
        return textResponse('A finished the original task with B, after Continue.')
      },
      (request) => {
        expect(request.sessionId).toBe(workerA)
        expect(currentTask(request)).toContain('QUEUED_BUDGET_QUESTION')
        return textResponse('A now answers the queued question without abandoning B.')
      },
    ])
    const a = (await h.ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const b = (await h.ctx.katcatsTeam.createBot({ name: 'B' })).bot
    const chat = (await h.ctx.katcatsChats.createChat({ name: 'Budget preserves queued questions', memberIds: [a.id, b.id], relayLimit: 1 })).chat
    const workerA = chat.executors.find(executor => executor.botId === a.id)!.sessionId
    const workerB = chat.executors.find(executor => executor.botId === b.id)!.sessionId
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const remove = h.ctx.on('llm/stream', (request, next) => {
      const stream = next()
      if (timing !== 'before-budget' || request.sessionId !== workerA || h.adapter.requests.length !== 0) return stream
      return (async function* () {
        for await (const chunk of stream) {
          if (chunk.type === 'finish') { entered.resolve(undefined); await release.promise }
          yield chunk
        }
      })()
    })
    try {
      await send(h.ctx, chat, '@A ORIGINAL_BUDGET_TASK: ask B, then finish.', 'original-budget-task')
      if (timing === 'before-budget') {
        await entered.promise
        expect(await send(h.ctx, chat, '@A QUEUED_BUDGET_QUESTION: how is it going?', 'queued-budget-question')).toEqual({ accepted: true })
        release.resolve(undefined)
      }
      const held = await budgetPaused(h.ctx, chat)
      if (timing === 'after-budget') {
        expect(await send(h.ctx, chat, '@A QUEUED_BUDGET_QUESTION: how is it going?', 'queued-budget-question')).toEqual({ accepted: true })
      }
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      const waiting = await h.ctx.katcatsChats.snapshot()
      expect(waiting.chats[0]).toMatchObject({ status: 'paused', pauseReason: 'relay-limit', generation: held.generation,
        run: { id: held.run!.id, relayCount: 1 } })
      expect(waiting.deliveries.map(delivery => delivery.state)).toEqual(['running', 'accepted'])
      expect(h.adapter.requests.map(request => request.sessionId)).toEqual([workerA])
      expect(h.adapter.requests[0]!.signal?.aborted).toBe(false)
      await h.ctx.katcatsChats.resume({ id: chat.id, expectedRunId: held.run!.id, expectedGeneration: held.generation })
      await settled(h.ctx, chat)
      const done = await h.ctx.katcatsChats.snapshot()
      expect(done.deliveries.slice(0, 2).map(delivery => delivery.id)).toEqual(waiting.deliveries.map(delivery => delivery.id))
      expect(done.deliveries.every(delivery => delivery.state === 'completed' && delivery.relayed)).toBe(true)
      expect(done.deliveries.filter(delivery => delivery.state === 'completed').map(delivery => delivery.receipt?.text)).toEqual([
        'A finished the original task with B, after Continue.', 'B completed the original budget-held task.',
        'A now answers the queued question without abandoning B.',
      ])
      expect(done.chats[0]).toMatchObject({ status: 'active', pauseReason: null, run: null, error: null })
      expect(h.adapter.requests.map(request => request.sessionId)).toEqual([workerA, workerB, workerA, workerA])
    } finally { release.resolve(undefined); remove() }
  })
})
