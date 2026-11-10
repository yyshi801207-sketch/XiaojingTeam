/** Real Loader, tool policy, approval, and JSONL evidence for early public member speech. */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import ApprovalService, { type ApprovalAnswer } from '@deepseek-ai/dsh-user-approval'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ChatDelivery, TeamChat } from '../src/chats-types.ts'
import { installMemberProgress, memberProgressMessages } from '../src/chats-member-progress.ts'
import { memoryFixture, memorySend } from './memory-fixture.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const publicText = 'I will inspect the draft first, then prepare the final document.'
const privateReasoning = 'PRIVATE_REASONING_SENTINEL'

function routinePlan(id = 'plan-document-review'): StreamChunk[] {
  return toolCallResponse(id, 'plan_group_work', { own_task: 'Inspect the synthetic draft without changing data.',
    assignments: [], review: { reason: 'none' } })
}

function response(callId = 'review-one', text = publicText): StreamChunk[] {
  const chunks = toolCallResponse(callId, 'progress_review', { document: 'draft.md' }, text)
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: privateReasoning },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: privateReasoning } },
    ...chunks.map(chunk => 'index' in chunk ? { ...chunk, index: chunk.index + 1 } : chunk),
  ]
}

async function send(ctx: Context, chat: TeamChat, id = 'progress-owner'): Promise<void> {
  await ctx.katcatsChats.sendMessage({ sessionId: chat.rootSessionId,
    requestId: brandString<SessionRequestId>(id), mode: 'queue',
    content: [{ type: 'text', text: '@Writer Review this draft and report the final result.' }],
  }, new AbortController().signal)
}

async function settled(ctx: Context, chat: TeamChat): Promise<void> {
  const controller = new AbortController()
  try {
    for await (const frame of ctx.katcatsChats.follow(controller.signal)) {
      if (frame.value.activities.find(activity => activity.chatId === chat.id)?.processing === false) return
    }
    throw new Error('The group closed before the member settled')
  } finally { controller.abort() }
}

function control(chat: TeamChat) {
  return { id: chat.id, expectedRunId: chat.run?.id ?? null, expectedGeneration: chat.generation }
}

async function messages(ctx: Context, chat: TeamChat): Promise<readonly UserMessage[]> {
  return (await ctx.sessionController.inspect(chat.rootSessionId)).events.flatMap(event =>
    event.type === 'user/message' && event.data.source.kind === 'katcats-group-relay' ? [event.data] : [])
}

async function fixture(script: Parameters<typeof memoryFixture>[0]) {
  const h = await memoryFixture(script)
  h.ctx.loader.builtins['progress-approval'] = ApprovalService
  await h.ctx.loader.create({ name: 'cordis:progress-approval' })
  await h.ctx.loader.await()
  const writer = (await h.ctx.katcatsTeam.createBot({ name: 'Writer' })).bot
  const chat = (await h.ctx.katcatsChats.createChat({ name: 'Early public speech', memberIds: [writer.id] })).chat
  const shown = Promise.withResolvers<undefined>()
  const answer = Promise.withResolvers<ApprovalAnswer>()
  let calls = 0
  h.ctx.effect(() => h.ctx.tools.register(defineTool({
    name: 'progress_review', description: 'Review the selected synthetic document after owner approval.',
    parameters: { document: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { reviewed: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: () => { calls += 1; return Promise.resolve({ reviewed: true }) },
  })))
  h.ctx.on('tools/pre-execute', async (exec, next) => {
    const previous = await next()
    return exec.name === 'progress_review' && exec.agent?.id === chat.executors[0]?.sessionId && previous.kind === 'allow'
      ? { kind: 'ask', reason: 'The owner must approve this document review.' } : previous
  })
  h.ctx.on('approval/request', () => { shown.resolve(undefined); return answer.promise })
  return { ...h, writer, chat, shown, answer, calls: () => calls }
}

describe('Public member speech before real tool approval', () => {
  it('shows the actual public text while permission approval is still unanswered, then keeps a separate final reply', async () => {
    const h = await fixture([routinePlan(), response(), textResponse('The reviewed final document is ready.')])
    try {
      await send(h.ctx, h.chat)
      await h.shown.promise
      const pending = await h.ctx.katcatsChats.snapshot()
      const early = await messages(h.ctx, h.chat)
      expect(h.calls()).toBe(0)
      expect(pending.deliveries[0]?.state).toBe('running')
      const guidance = h.adapter.requests[0]?.messages.filter(message => message.role === 'system')
        .flatMap(message => message.content.flatMap(block => block.type === 'text' ? block.text.split('\n') : []))
        .find(line => line.startsWith('Before using tools or requesting approval'))
      expect(guidance).toMatchInlineSnapshot('"Before using tools or requesting approval for a task, briefly acknowledge the request and say what you will do next. Report only actual progress; do not claim success or say another member has been assigned before the request succeeds."')
      expect(early.map(message => message.content)).toEqual([[{ type: 'text', text: publicText }]])
      expect(early[0]?.source).toMatchObject({ sender: { name: 'Writer', botId: h.writer.id },
        outputMessageId: early[0]?.id, executionSessionId: h.chat.executors[0]?.sessionId })
      await h.ctx.sessions.flush(h.ctx.agents.get(h.chat.executors[0]!.sessionId)!.session)
      const worker = await h.ctx.sessionController.inspect(h.chat.executors[0]!.sessionId)
      expect(worker.events.some(event => event.type === 'approval/asked')).toBe(true)
      expect(worker.events.some(event => event.type === 'approval/decided')).toBe(false)
      expect(JSON.stringify(early)).not.toContain(privateReasoning)
      h.answer.resolve('allowed-once')
      await settled(h.ctx, h.chat)
      expect(h.calls()).toBe(1)
      const final = await messages(h.ctx, h.chat)
      expect(final.map(message => ({ speaker: message.source.kind === 'katcats-group-relay' ? message.source.sender.name : '',
        text: message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') })))
        .toMatchInlineSnapshot(`
          [
            {
              "speaker": "Writer",
              "text": "I will inspect the draft first, then prepare the final document.",
            },
            {
              "speaker": "Writer",
              "text": "The reviewed final document is ready.",
            },
          ]
        `)
      expect(new Set(final.map(message => message.id)).size).toBe(2)
      expect(h.adapter.requests.some(request => request.sessionId === h.chat.rootSessionId)).toBe(false)
      const root = await h.ctx.sessionController.inspect(h.chat.rootSessionId)
      expect(root.events.some(event => event.type === 'turn/start')).toBe(false)
    } finally { h.answer.resolve('rejected') }
  })

  it('keeps already spoken text after rejection and cold replay without re-executing or duplicating the final reply', async () => {
    const h = await fixture([routinePlan(), response(), textResponse('The owner declined the review; no document was changed.')])
    await send(h.ctx, h.chat)
    await h.shown.promise
    expect(await messages(h.ctx, h.chat)).toHaveLength(1)
    h.answer.resolve('rejected')
    await settled(h.ctx, h.chat)
    const before = await messages(h.ctx, h.chat)
    expect(before).toHaveLength(2)
    expect(h.calls()).toBe(0)
    await h.close()
    const cold = await memoryFixture([], h.root)
    expect(await messages(cold.ctx, h.chat)).toEqual(before)
    expect(cold.adapter.requests).toEqual([])
  })

  it('retains the public reply after Stop during approval, with no fabricated final result or cold redispatch', async () => {
    const h = await fixture([routinePlan(), response()])
    try {
      await send(h.ctx, h.chat)
      await h.shown.promise
      const before = await messages(h.ctx, h.chat)
      expect(before).toHaveLength(1)
      const current = (await h.ctx.katcatsChats.snapshot()).chats.find(chat => chat.id === h.chat.id)!
      await h.ctx.katcatsChats.stop(control(current))
      expect(h.calls()).toBe(0)
      expect(await messages(h.ctx, h.chat)).toEqual(before)
      expect((await h.ctx.katcatsChats.snapshot()).deliveries[0]?.state).toBe('unknown')
      await h.close()
      const cold = await memoryFixture([], h.root)
      expect(await messages(cold.ctx, h.chat)).toEqual(before)
      expect(cold.adapter.requests).toEqual([])
    } finally { h.answer.resolve('rejected') }
  })

  it('recovers only exact group tool-bearing messages and excludes private, reasoning-only, and final output', async () => {
    const h = await fixture([routinePlan(), response(), textResponse('Final public result.')])
    await send(h.ctx, h.chat)
    await h.shown.promise
    h.answer.resolve('allowed-once')
    await settled(h.ctx, h.chat)
    const saved = await h.ctx.katcatsChats.snapshot()
    const delivery = saved.deliveries[0]!
    const log = await h.ctx.sessionController.inspect(delivery.executorSessionId)
    const recovered = memberProgressMessages(delivery, log.events)
    expect(recovered).toHaveLength(1)
    expect(recovered).toEqual((await messages(h.ctx, h.chat)).slice(0, 1))
    expect(memberProgressMessages({ ...delivery, inputMessageId: brandString<ChatDelivery['inputMessageId']>('a-different-private-input') }, log.events)).toEqual([])
    const interrupted = log.events.map(event => event.type === 'assistant/message'
      ? { ...event, data: { ...event.data, interrupted: true as const } } : event)
    expect(memberProgressMessages(delivery, interrupted)).toEqual([])
    expect(JSON.stringify(recovered)).not.toContain(privateReasoning)
    expect(JSON.stringify(recovered)).not.toContain('Final public result.')
  })

  it('does not dispatch a tool when the early public reply cannot reach a confirmed group flush', async () => {
    const h = await fixture([routinePlan(), response(), textResponse('The review was not started because its public update could not be saved.')])
    const remove = h.ctx.on('session/flush', (session) => {
      if (session.id === h.chat.rootSessionId && session.snapshotEvents().some(event =>
        event.type === 'user/message' && event.data.source.kind === 'katcats-group-relay')) {
        throw new Error('Synthetic group publication medium failure')
      }
    })
    try {
      await send(h.ctx, h.chat)
      await settled(h.ctx, h.chat)
      expect(h.calls()).toBe(0)
      const worker = await h.ctx.sessionController.inspect(h.chat.executors[0]!.sessionId)
      expect(worker.events.some(event => event.type === 'approval/asked')).toBe(false)
      expect(worker.events.some(event => event.type === 'tool/result' && event.data.message.isError === true)).toBe(true)
    } finally { remove(); h.answer.resolve('rejected') }
    await h.close()
    const cold = await memoryFixture([], h.root)
    const recovered = await messages(cold.ctx, h.chat)
    expect(recovered.filter(message => message.content.some(block => block.type === 'text' && block.text === publicText)))
      .toHaveLength(1)
    expect(cold.adapter.requests).toEqual([])
  })

  it('publishes a shared assistant message only once when its parallel tool calls both require approval', async () => {
    const chunks = response()
    const second = toolCallResponse('review-two', 'progress_review', { document: 'second.md' })
      .filter(chunk => chunk.type !== 'usage' && chunk.type !== 'finish')
      .map(chunk => 'index' in chunk ? { ...chunk, index: chunk.index + 3 } : chunk)
    const h = await fixture([routinePlan(), [...chunks.filter(chunk => chunk.type !== 'finish'), ...second,
      { type: 'finish', reason: { kind: 'tool-calls' } }], textResponse('Both selected drafts were reviewed.')])
    try {
      await send(h.ctx, h.chat)
      await h.shown.promise
      expect(await messages(h.ctx, h.chat)).toHaveLength(1)
      expect(h.calls()).toBe(0)
      h.answer.resolve('allowed-once')
      await settled(h.ctx, h.chat)
      expect(h.calls()).toBe(2)
      const actual = await messages(h.ctx, h.chat)
      expect(actual).toHaveLength(2)
      expect(actual.filter(message => message.content.some(block => block.type === 'text' && block.text === publicText)))
        .toHaveLength(1)
    } finally { h.answer.resolve('rejected') }
  })

  it('removes both scoped hooks on disposal and never observes another member private Session', async () => {
    const h = await memoryFixture([textResponse('First private answer.'), textResponse('Second private answer.')])
    const a = (await h.ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const b = (await h.ctx.katcatsTeam.createBot({ name: 'B' })).bot
    const privateA = h.ctx.agents.get(a.sessionId)!
    let observed = 0
    const dispose = installMemberProgress(privateA, {
      current: () => { observed += 1; return undefined },
      flush: () => h.ctx.sessions.flush(privateA.session),
      publish: () => { throw new Error('Private output must not be published') },
    })
    await memorySend(h.ctx.agents.get(b.sessionId)!, 'Private B input.')
    expect(observed).toBe(0)
    dispose()
    await memorySend(privateA, 'Private A after hook disposal.')
    expect(observed).toBe(0)
  })

  it('keeps successive task identities separate instead of replaying an earlier acknowledgement', async () => {
    const secondText = 'I will compare the revised draft with the first result.'
    const h = await fixture([routinePlan(), response(), textResponse('First result.'),
      routinePlan('plan-second-review'), response('second-task', secondText), textResponse('Second result.')])
    await send(h.ctx, h.chat)
    await h.shown.promise
    h.answer.resolve('allowed-once')
    await settled(h.ctx, h.chat)
    await send(h.ctx, h.chat, 'second-owner')
    await settled(h.ctx, h.chat)
    const actual = await messages(h.ctx, h.chat)
    expect(actual.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])))
      .toEqual([publicText, 'First result.', secondText, 'Second result.'])
    expect(new Set(actual.map(message => message.id)).size).toBe(4)
    const byDelivery = actual.map(message => message.source.kind === 'katcats-group-relay' ? message.source.deliveryId : '')
    expect(byDelivery[0]).toBe(byDelivery[1])
    expect(byDelivery[2]).toBe(byDelivery[3])
    expect(byDelivery[0]).not.toBe(byDelivery[2])
  })

  it('does not invent an acknowledgement when the model emits no public text before approval', async () => {
    const h = await fixture([routinePlan(), toolCallResponse('silent-tool', 'progress_review', { document: 'draft.md' }), textResponse('The actual final result.')])
    try {
      await send(h.ctx, h.chat)
      await h.shown.promise
      expect(await messages(h.ctx, h.chat)).toEqual([])
      expect(h.calls()).toBe(0)
      h.answer.resolve('allowed-once')
      await settled(h.ctx, h.chat)
      expect(await messages(h.ctx, h.chat)).toHaveLength(1)
    } finally { h.answer.resolve('rejected') }
  })
})
