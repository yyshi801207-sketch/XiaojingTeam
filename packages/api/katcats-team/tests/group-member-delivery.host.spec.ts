/** Real Loader, nested member execution and file dependencies; only external models are scripted. */
import { randomUUID } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { defineTool } from '@deepseek-ai/dsh-tools'
import ApprovalService, { type ApprovalAnswer } from '@deepseek-ai/dsh-user-approval'
import type { ChatSnapshot, TeamChat } from '../src/chats-types.ts'
import { memoryFixture } from './memory-fixture.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const reportName = 'final-presentation.md'
const guardReason = 'Read the requested member results in your next response before using other tools.'

function batch(calls: readonly StreamChunk[][]): StreamChunk[] {
  const result: StreamChunk[] = []
  let offset = 0
  for (const response of calls) {
    const chunks = response.filter(chunk => chunk.type !== 'finish' && chunk.type !== 'usage')
    result.push(...chunks.map(chunk => 'index' in chunk ? { ...chunk, index: chunk.index + offset } : chunk))
    offset += Math.max(...chunks.map(chunk => 'index' in chunk ? chunk.index + 1 : 0))
  }
  return [...result, { type: 'finish', reason: { kind: 'tool-calls' } }]
}

async function send(ctx: Context, chat: TeamChat,
  text = '@A Ask B and C for their actual data, then produce the final presentation document.', id = 'nested-delivery-owner',
  mode: 'queue' | 'steer' = 'queue',
): Promise<void> {
  await ctx.katcatsChats.sendMessage({ sessionId: chat.rootSessionId,
    requestId: brandString<SessionRequestId>(id), mode, content: [{ type: 'text', text }],
  }, new AbortController().signal)
}

async function settled(ctx: Context, id: TeamChat['id']): Promise<void> {
  const controller = new AbortController()
  try {
    for await (const frame of ctx.katcatsChats.follow(controller.signal)) {
      if (frame.value.activities.find(activity => activity.chatId === id)?.processing === false) return
    }
    throw new Error('The group closed before its nested work settled')
  } finally { controller.abort() }
}

function control(chat: TeamChat) {
  return { id: chat.id, expectedRunId: chat.run?.id ?? null, expectedGeneration: chat.generation }
}

async function observed(ctx: Context, predicate: (snapshot: ChatSnapshot) => boolean): Promise<ChatSnapshot> {
  const controller = new AbortController()
  try {
    for await (const frame of ctx.katcatsChats.follow(controller.signal)) {
      if (predicate(frame.value)) return frame.value
    }
    throw new Error('The group closed before the expected nested task state')
  } finally { controller.abort() }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

interface ScriptState {
  readonly a: { id: string; sessionId: SessionId }
  readonly b: { id: string; sessionId: SessionId }
  readonly c: { id: string; sessionId: SessionId }
  readonly tokens: Map<string, string>
  readonly steps: string[]
}

async function fixture(script: (state: () => ScriptState) => Parameters<typeof memoryFixture>[0], approval = false) {
  const h = await memoryFixture(script(() => state))
  const a = (await h.ctx.katcatsTeam.createBot({ name: 'A' })).bot
  const b = (await h.ctx.katcatsTeam.createBot({ name: 'B' })).bot
  const c = (await h.ctx.katcatsTeam.createBot({ name: 'C' })).bot
  const chat = (await h.ctx.katcatsChats.createChat({ name: 'Actual file dependencies', memberIds: [a.id, b.id, c.id] })).chat
  const worker = (id: typeof a.id) => chat.executors.find(executor => executor.botId === id)!.sessionId
  const state: ScriptState = { a: { id: a.id, sessionId: worker(a.id) }, b: { id: b.id, sessionId: worker(b.id) },
    c: { id: c.id, sessionId: worker(c.id) }, tokens: new Map(), steps: [] }
  const privateEvents = [a, b, c].map(bot => ({ id: bot.sessionId,
    events: h.ctx.agents.get(bot.sessionId)!.session.snapshotEvents() }))
  const written: { sessionId: SessionId; path: string; content: string }[] = []
  h.ctx.effect(() => h.ctx.tools.register(defineTool({
    name: 'delivery_produce_source', description: 'Collect unique synthetic source data and write its actual group file.',
    parameters: { producer: { type: 'string', enum: ['B', 'C'], required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      path: { type: 'string', required: true }, token: { type: 'string', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, exec) => {
      const expected = args.producer === 'B' ? state.b : state.c
      expect(exec.agent?.id).toBe(expected.sessionId)
      expect(exec.agent?.session.header.cwd).toBe(chat.workDir)
      exec.signal.throwIfAborted()
      const token = `${args.producer}_REAL_${randomUUID()}`
      const name = `${args.producer.toLowerCase()}-source.json`
      const path = join(chat.workDir, name)
      const content = JSON.stringify({ producer: args.producer, token })
      await writeFile(path, content)
      state.tokens.set(args.producer, token)
      state.steps.push(`${args.producer}:file-written`)
      written.push({ sessionId: expected.sessionId, path, content })
      return { path: name, token }
    },
  })))
  h.ctx.effect(() => h.ctx.tools.register(defineTool({
    name: 'delivery_write_report', description: 'Write the final presentation document using confirmed source results.',
    parameters: { content: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, exec) => {
      expect(exec.agent?.id).toBe(state.a.sessionId)
      exec.signal.throwIfAborted()
      const path = join(chat.workDir, reportName)
      await writeFile(path, args.content)
      state.steps.push('A:report-written')
      written.push({ sessionId: state.a.sessionId, path, content: args.content })
      return { path: reportName }
    },
  })))
  h.ctx.on('session/event', (session, event) => {
    if (session.id !== chat.rootSessionId || event.type !== 'user/message'
      || event.data.source.kind !== 'katcats-group-relay') return
    const sender = event.data.source.sender.name
    const token = state.tokens.get(sender)
    if (token !== undefined && event.data.content.some(part => part.type === 'text' && part.text.includes(token))) {
      state.steps.push(`${sender}:reply-published`)
    }
  })
  const shown = Promise.withResolvers<undefined>()
  const answer = Promise.withResolvers<ApprovalAnswer>()
  if (approval) {
    h.ctx.loader.builtins['delivery-approval'] = ApprovalService
    await h.ctx.loader.create({ name: 'cordis:delivery-approval' })
    await h.ctx.loader.await()
    h.ctx.on('tools/pre-execute', async (exec, next) => {
      const previous = await next()
      return exec.name === 'delivery_produce_source' && exec.agent?.id === state.b.sessionId && previous.kind === 'allow'
        ? { kind: 'ask', reason: 'Approve the nested B source collection.' } : previous
    })
    h.ctx.on('approval/request', () => { shown.resolve(undefined); return answer.promise })
  }
  return { ...h, a, b, c, chat, state, privateEvents, written, shown, answer }
}

function requestBoth(state: ScriptState): StreamChunk[] {
  return batch([
    toolCallResponse('request-b', 'request_group_member', { bot_id: state.b.id, message: 'Collect B data and return its exact token.' },
      'I will ask B and C for their actual source data, then assemble the final presentation.'),
    toolCallResponse('request-c', 'request_group_member', { bot_id: state.c.id, message: 'Collect C data and return its exact token.' }),
    toolCallResponse('premature-report', 'delivery_write_report', { content: 'UNVERIFIED_EARLY_PRESENTATION' }),
  ])
}

function requestB(state: ScriptState): StreamChunk[] {
  return toolCallResponse('request-b', 'request_group_member', { bot_id: state.b.id, message: 'Collect B data and return its exact token.' })
}

function memberSource(state: ScriptState, name: 'B' | 'C', options: GenerateOptions): StreamChunk[] {
  expect(options.sessionId).toBe(name === 'B' ? state.b.sessionId : state.c.sessionId)
  if (name === 'C') expect(state.steps).toContain('B:reply-published')
  return toolCallResponse(`collect-${name.toLowerCase()}`, 'delivery_produce_source', { producer: name },
    `I will collect the actual ${name} source file before returning its data.`)
}

function memberReply(state: ScriptState, name: 'B' | 'C', options: GenerateOptions): StreamChunk[] {
  expect(options.sessionId).toBe(name === 'B' ? state.b.sessionId : state.c.sessionId)
  const token = state.tokens.get(name)
  expect(token).toBeDefined()
  return textResponse(`${name} source is complete: ${token!}. File: ./${name.toLowerCase()}-source.json`)
}

describe('completed group-member dependencies before file delivery', () => {
  it.each(['valid', 'blank-message', 'unknown-field'] as const)(
    'blocks the write-first batch before a %s member request, including parameter rejection before child admission', async (kind) => {
      const h = await fixture(state => [
        (options) => {
          expect(options.sessionId).toBe(state().a.sessionId)
          const args = { bot_id: state().b.id, message: kind === 'blank-message' ? '   ' : 'Collect B data and return its exact token.',
            ...kind === 'unknown-field' ? { unexpected: 'not a supported field' } : {} }
          return batch([
            toolCallResponse('write-before-request', 'delivery_write_report', { content: 'UNVERIFIED_EARLY_PRESENTATION' }),
            toolCallResponse('request-b', 'request_group_member', args),
          ])
        },
        ...(kind === 'valid' ? [
          (options: GenerateOptions) => memberSource(state(), 'B', options),
          (options: GenerateOptions) => memberReply(state(), 'B', options),
        ] : []),
        (options) => {
          expect(options.sessionId).toBe(state().a.sessionId)
          return textResponse(kind === 'valid' ? `A received B's actual source token: ${state().tokens.get('B')!}.`
            : 'The member request was rejected. No member result or final presentation has been produced.')
        },
      ])
      await send(h.ctx, h.chat, '@A Ask B for its real data before making the presentation.')
      await settled(h.ctx, h.chat.id)
      expect(h.written.map(entry => entry.sessionId)).toEqual(kind === 'valid' ? [h.state.b.sessionId] : [])
      expect(await exists(join(h.chat.workDir, reportName))).toBe(false)
      const log = await h.ctx.sessionController.inspect(h.state.a.sessionId)
      const early = log.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'write-before-request')
      expect(early).toMatchObject({ data: { message: { isError: true } } })
      expect(JSON.stringify(early)).toContain(guardReason)
      const result = log.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'request-b')
      expect(result).toMatchObject({ data: { message: { isError: kind !== 'valid' } } })
      const saved = await h.ctx.katcatsChats.snapshot()
      expect(saved.deliveries.map(delivery => delivery.botId)).toEqual(kind === 'valid' ? [h.a.id, h.b.id] : [h.a.id])
      expect(saved.deliveries.every(delivery => delivery.state === 'completed')).toBe(true)
      if (kind === 'valid') expect(JSON.stringify(result)).toContain(h.state.tokens.get('B'))
    },
  )

  it('awaits B then C, rejects the same-response early report and writes the next-step report from their real results', async () => {
    const h = await fixture(state => [
      (options) => { expect(options.sessionId).toBe(state().a.sessionId); return requestBoth(state()) },
      options => memberSource(state(), 'B', options), options => memberReply(state(), 'B', options),
      options => memberSource(state(), 'C', options), options => memberReply(state(), 'C', options),
      (options) => {
        expect(options.sessionId).toBe(state().a.sessionId)
        const messages = JSON.stringify(options.messages)
        const b = messages.match(/B_REAL_[a-f0-9-]+/)?.[0]
        const c = messages.match(/C_REAL_[a-f0-9-]+/)?.[0]
        expect(b).toBeDefined()
        expect(c).toBeDefined()
        expect(b).toBe(state().tokens.get('B'))
        expect(c).toBe(state().tokens.get('C'))
        expect(messages).toContain(guardReason)
        expect(state().steps).toEqual(['B:file-written', 'B:reply-published', 'C:file-written', 'C:reply-published'])
        return toolCallResponse('confirmed-report', 'delivery_write_report', { content: `# Confirmed presentation\nB: ${b!}\nC: ${c!}\n` })
      },
      textResponse(`The confirmed presentation is ready: [Final presentation](./${reportName}).`),
    ], true)
    try {
      await send(h.ctx, h.chat)
      await h.shown.promise
      expect(h.adapter.requests.map(request => request.sessionId)).toEqual([h.state.a.sessionId, h.state.b.sessionId])
      expect(h.written).toEqual([])
      expect(await exists(join(h.chat.workDir, reportName))).toBe(false)
      const pendingB = await h.ctx.sessionController.inspect(h.state.b.sessionId)
      expect(pendingB.events.some(event => event.type === 'approval/asked')).toBe(true)
      expect(pendingB.events.some(event => event.type === 'approval/decided')).toBe(false)
      h.answer.resolve('allowed-once')
      await settled(h.ctx, h.chat.id)
      const file = await readFile(join(h.chat.workDir, reportName), 'utf8')
      expect(file).toContain(h.state.tokens.get('B'))
      expect(file).toContain(h.state.tokens.get('C'))
      expect(file).not.toContain('UNVERIFIED')
      expect(h.written.map(entry => entry.sessionId)).toEqual([h.state.b.sessionId, h.state.c.sessionId, h.state.a.sessionId])
      expect(h.state.steps.at(-1)).toBe('A:report-written')
      for (const producer of ['B', 'C']) {
        expect(JSON.parse(await readFile(join(h.chat.workDir, `${producer.toLowerCase()}-source.json`), 'utf8')))
          .toEqual({ producer, token: h.state.tokens.get(producer) })
      }
      const aLog = await h.ctx.sessionController.inspect(h.state.a.sessionId)
      const premature = aLog.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'premature-report')
      expect(premature).toMatchObject({ data: { message: { isError: true } } })
      const directory = await h.ctx.katcatsChats.snapshot()
      expect(directory.deliveries.map(delivery => ({ member: delivery.botId, state: delivery.state, relayed: delivery.relayed })))
        .toEqual([h.a, h.b, h.c].map(member => ({ member: member.id, state: 'completed', relayed: true })))
      for (const [callId, member] of [['request-b', h.b], ['request-c', h.c]] as const) {
        const event = aLog.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === callId)
        if (event?.type !== 'tool/result') throw new Error('The parent has no confirmed member result')
        expect(event.data.message.isError).toBe(false)
        const payload: unknown = JSON.parse(event.data.message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'))
        expect(payload).toMatchObject({ chat_id: h.chat.id, bot_id: member.id, status: 'completed',
          message_id: directory.deliveries.find(delivery => delivery.botId === member.id)?.relayMessageId })
        if (typeof payload !== 'object' || payload === null || !('reply' in payload)) throw new Error('The member result has no reply')
        expect(payload.reply).toContain(h.state.tokens.get(member.name))
      }
      for (const previous of h.privateEvents) {
        expect(h.ctx.agents.get(previous.id)!.session.snapshotEvents()).toEqual(previous.events)
      }
      expect(h.adapter.requests.some(request => request.sessionId === h.chat.rootSessionId)).toBe(false)
      const root = await h.ctx.sessionController.inspect(h.chat.rootSessionId)
      expect(root.events.some(event => event.type === 'turn/start' || event.type === 'request/header')).toBe(false)
      const replies = root.events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'katcats-group-relay'
        ? [{ sender: event.data.source.sender.name, text: event.data.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') }] : [])
      expect(replies.filter(reply => reply.text.includes('_REAL_')).map(reply => reply.sender)).toEqual(['B', 'C'])
      expect(replies.at(-1)?.sender).toBe('A')
      expect(replies.at(-1)?.text).toContain(`./${reportName}`)
    } finally { h.answer.resolve('rejected') }
  })

  it('stops a nested member waiting for approval without executing parent side effects or replaying after cold reopen', async () => {
    const h = await fixture(state => [
      (options) => { expect(options.sessionId).toBe(state().a.sessionId); return requestBoth(state()) },
      options => memberSource(state(), 'B', options),
    ], true)
    try {
      await send(h.ctx, h.chat)
      await h.shown.promise
      const current = (await h.ctx.katcatsChats.snapshot()).chats.find(chat => chat.id === h.chat.id)!
      await h.ctx.katcatsChats.stop(control(current))
      await settled(h.ctx, h.chat.id)
      expect(h.written).toEqual([])
      expect(h.adapter.requests.map(request => request.sessionId)).toEqual([h.state.a.sessionId, h.state.b.sessionId])
      expect(await exists(join(h.chat.workDir, reportName))).toBe(false)
      const stopped = await h.ctx.katcatsChats.snapshot()
      expect(stopped.chats[0]).toMatchObject({ status: 'stopped', run: null })
      expect(stopped.deliveries.every(delivery => delivery.state !== 'running' && delivery.state !== 'accepted')).toBe(true)
      await h.close()
      const cold = await memoryFixture([], h.root)
      expect(cold.adapter.requests).toEqual([])
      expect((await cold.ctx.katcatsChats.snapshot()).chats[0]).toMatchObject({ status: 'stopped', run: null })
      expect(await exists(join(h.chat.workDir, reportName))).toBe(false)
    } finally { h.answer.resolve('rejected') }
  })

  it('does not continue to C or write A deliverables when the awaited B model genuinely fails', async () => {
    const h = await fixture(state => [
      (options) => { expect(options.sessionId).toBe(state().a.sessionId); return requestBoth(state()) },
      (options) => {
        expect(options.sessionId).toBe(state().b.sessionId)
        throw new Error('Synthetic B provider failure before any confirmed result')
      },
    ])
    await send(h.ctx, h.chat)
    await settled(h.ctx, h.chat.id)
    expect(h.written).toEqual([])
    expect(await exists(join(h.chat.workDir, reportName))).toBe(false)
    expect(h.adapter.requests.map(request => request.sessionId)).toEqual([h.state.a.sessionId, h.state.b.sessionId])
    const snapshot = await h.ctx.katcatsChats.snapshot()
    expect(snapshot.chats[0]?.status).toBe('paused')
    expect(snapshot.deliveries.every(delivery => delivery.state !== 'completed')).toBe(true)
    expect(snapshot.deliveries.some(delivery => delivery.botId === h.c.id)).toBe(false)
  })

  it('keeps the parent tool pending at its dispatch budget and continues the same accepted B task after Continue', async () => {
    const h = await fixture(state => [
      (options) => { expect(options.sessionId).toBe(state().a.sessionId); return requestB(state()) },
      options => memberSource(state(), 'B', options), options => memberReply(state(), 'B', options),
      (options) => {
        expect(options.sessionId).toBe(state().a.sessionId)
        expect(JSON.stringify(options.messages)).toContain(state().tokens.get('B'))
        return textResponse('A received the actual B file after the owner continued the same task.')
      },
    ])
    await h.ctx.katcatsChats.updateChat({ id: h.chat.id, relayLimit: 1 })
    await send(h.ctx, h.chat, '@A Ask B for its real data.')
    const held = await observed(h.ctx, snapshot => snapshot.chats[0]?.pauseReason === 'relay-limit')
    expect(held.chats[0]).toMatchObject({ status: 'paused', run: { relayCount: 1 } })
    expect(held.deliveries.map(delivery => ({ botId: delivery.botId, state: delivery.state })))
      .toEqual([{ botId: h.a.id, state: 'running' }, { botId: h.b.id, state: 'accepted' }])
    expect(held.activities[0]?.processing).toBe(true)
    expect(h.adapter.requests.map(request => request.sessionId)).toEqual([h.state.a.sessionId])
    expect(h.written).toEqual([])
    const parent = await h.ctx.sessionController.inspect(h.state.a.sessionId)
    expect(parent.events.some(event => event.type === 'tool/result' && event.data.message.toolCallId === 'request-b')).toBe(false)
    await h.ctx.katcatsChats.resume(control(held.chats[0]!))
    await settled(h.ctx, h.chat.id)
    const finished = await h.ctx.katcatsChats.snapshot()
    expect(finished.deliveries.map(delivery => delivery.id)).toEqual(held.deliveries.map(delivery => delivery.id))
    expect(finished.deliveries.every(delivery => delivery.state === 'completed' && delivery.relayed)).toBe(true)
    expect(finished.chats[0]).toMatchObject({ status: 'active', pauseReason: null, run: null, error: null })
    expect(h.written.map(entry => entry.sessionId)).toEqual([h.state.b.sessionId])
    expect(h.adapter.requests.map(request => request.sessionId))
      .toEqual([h.state.a.sessionId, h.state.b.sessionId, h.state.b.sessionId, h.state.a.sessionId])
    const completedParent = await h.ctx.sessionController.inspect(h.state.a.sessionId)
    const results = completedParent.events.filter(event => event.type === 'tool/result' && event.data.message.toolCallId === 'request-b')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ data: { message: { isError: false } } })
  })

  it('preserves a manually paused nested member through approval and resumes its next model step and waiting parent', async () => {
    const h = await fixture(state => [
      (options) => { expect(options.sessionId).toBe(state().a.sessionId); return requestB(state()) },
      options => memberSource(state(), 'B', options), options => memberReply(state(), 'B', options),
      (options) => {
        expect(options.sessionId).toBe(state().a.sessionId)
        expect(JSON.stringify(options.messages)).toContain(state().tokens.get('B'))
        return textResponse('A received the same nested B result after the manual pause.')
      },
    ], true)
    try {
      await send(h.ctx, h.chat, '@A Ask B for its real data.')
      await h.shown.promise
      const running = (await h.ctx.katcatsChats.snapshot()).chats[0]!
      await h.ctx.katcatsChats.pause(control(running))
      h.answer.resolve('allowed-once')
      await expect.poll(async () => (await h.ctx.sessionController.inspect(h.state.b.sessionId)).events.some(event =>
        event.type === 'tool/result' && event.data.message.toolCallId === 'collect-b')).toBe(true)
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      const held = await h.ctx.katcatsChats.snapshot()
      expect(held.chats[0]).toMatchObject({ status: 'paused', pauseReason: 'owner', run: { id: running.run!.id } })
      expect(held.deliveries.every(delivery => delivery.state === 'running')).toBe(true)
      expect(h.adapter.requests.map(request => request.sessionId)).toEqual([h.state.a.sessionId, h.state.b.sessionId])
      expect(h.written.map(entry => entry.sessionId)).toEqual([h.state.b.sessionId])
      expect((await h.ctx.sessionController.inspect(h.state.a.sessionId)).events.some(event =>
        event.type === 'tool/result' && event.data.message.toolCallId === 'request-b')).toBe(false)
      await h.ctx.katcatsChats.resume(control(held.chats[0]!))
      await settled(h.ctx, h.chat.id)
      const finished = await h.ctx.katcatsChats.snapshot()
      expect(finished.deliveries.map(delivery => delivery.id)).toEqual(held.deliveries.map(delivery => delivery.id))
      expect(finished.deliveries.every(delivery => delivery.state === 'completed' && delivery.relayed)).toBe(true)
      expect(h.adapter.requests.map(request => request.sessionId))
        .toEqual([h.state.a.sessionId, h.state.b.sessionId, h.state.b.sessionId, h.state.a.sessionId])
      expect(h.written).toHaveLength(1)
    } finally { h.answer.resolve('rejected') }
  })

  it('supersedes an accepted budget-waiting child on explicit steering without running stale child or parent side effects', async () => {
    const h = await fixture(state => [
      (options) => { expect(options.sessionId).toBe(state().a.sessionId); return requestBoth(state()) },
      (options) => {
        expect(options.sessionId).toBe(state().a.sessionId)
        expect(JSON.stringify(options.messages)).toContain('Answer the new owner question instead.')
        return textResponse('A is answering the new owner question; the earlier member work was not started.')
      },
    ])
    await h.ctx.katcatsChats.updateChat({ id: h.chat.id, relayLimit: 1 })
    await send(h.ctx, h.chat)
    const held = await observed(h.ctx, snapshot => snapshot.chats[0]?.pauseReason === 'relay-limit')
    const oldChild = held.deliveries.find(delivery => delivery.botId === h.b.id)!
    expect(oldChild.state).toBe('accepted')
    expect(h.adapter.requests).toHaveLength(1)
    await send(h.ctx, h.chat, '@A Answer the new owner question instead.', 'replacement-owner-input', 'steer')
    await settled(h.ctx, h.chat.id)
    const finished = await h.ctx.katcatsChats.snapshot()
    expect(h.adapter.requests.map(request => request.sessionId)).toEqual([h.state.a.sessionId, h.state.a.sessionId])
    expect(h.written).toEqual([])
    expect(await exists(join(h.chat.workDir, reportName))).toBe(false)
    expect(finished.deliveries.find(delivery => delivery.id === oldChild.id))
      .toMatchObject({ state: 'failed', error: { code: 'superseded' }, receipt: null })
    expect(finished.deliveries.some(delivery => delivery.botId === h.c.id)).toBe(false)
    expect(finished.deliveries.filter(delivery => delivery.state === 'completed').map(delivery => delivery.receipt?.text))
      .toEqual(['A is answering the new owner question; the earlier member work was not started.'])
    expect(finished.chats[0]?.generation).toBe(held.chats[0]!.generation + 1)
    expect(finished.chats[0]).toMatchObject({ status: 'active', pauseReason: null, run: null })
  })

  it('lets B directly return to its waiting ancestor when requesting the already busy A is rejected', async () => {
    const h = await fixture(state => [
      (options) => { expect(options.sessionId).toBe(state().a.sessionId); return requestB(state()) },
      (options) => {
        expect(options.sessionId).toBe(state().b.sessionId)
        return toolCallResponse('request-busy-ancestor', 'request_group_member', { bot_id: state().a.id, message: 'Please answer before I reply.' })
      },
      (options) => {
        expect(options.sessionId).toBe(state().b.sessionId)
        expect(JSON.stringify(options.messages)).toContain('This member is already working.')
        return textResponse('B has its own result and is returning it directly to waiting A.')
      },
      (options) => {
        expect(options.sessionId).toBe(state().a.sessionId)
        expect(JSON.stringify(options.messages)).toContain('B has its own result and is returning it directly to waiting A.')
        return textResponse('A received B directly, with no circular wait.')
      },
    ])
    await send(h.ctx, h.chat, '@A Ask B to help.')
    await settled(h.ctx, h.chat.id)
    const finished = await h.ctx.katcatsChats.snapshot()
    expect(finished.chats[0]).toMatchObject({ status: 'active', pauseReason: null, error: null, run: null })
    expect(finished.deliveries.map(delivery => ({ botId: delivery.botId, state: delivery.state })))
      .toEqual([{ botId: h.a.id, state: 'completed' }, { botId: h.b.id, state: 'completed' }])
    expect(h.adapter.requests.map(request => request.sessionId))
      .toEqual([h.state.a.sessionId, h.state.b.sessionId, h.state.b.sessionId, h.state.a.sessionId])
    const bLog = await h.ctx.sessionController.inspect(h.state.b.sessionId)
    expect(bLog.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'request-busy-ancestor'))
      .toMatchObject({ data: { message: { isError: true } } })
  })

  it('allows the same B in another group to answer while its first group executor awaits approval', async () => {
    let otherWorker: SessionId | undefined
    const h = await fixture(state => [
      (options) => { expect(options.sessionId).toBe(state().a.sessionId); return requestB(state()) },
      options => memberSource(state(), 'B', options),
      (options) => {
        expect(options.sessionId).toBe(otherWorker)
        expect(options.sessionId).not.toBe(state().b.sessionId)
        return textResponse('B independently answered the other group while its first group was waiting for approval.')
      },
      options => memberReply(state(), 'B', options),
      (options) => { expect(options.sessionId).toBe(state().a.sessionId); return textResponse('A has the first group result.') },
    ], true)
    try {
      const other = (await h.ctx.katcatsChats.createChat({ name: 'Independent B group', memberIds: [h.b.id] })).chat
      otherWorker = other.executors[0]!.sessionId
      await send(h.ctx, h.chat, '@A Ask B for its real data.')
      await h.shown.promise
      await send(h.ctx, other, '@B Answer this separate group now.', 'independent-group-owner')
      await settled(h.ctx, other.id)
      const during = await h.ctx.katcatsChats.snapshot()
      expect(during.deliveries.find(delivery => delivery.chatId === other.id))
        .toMatchObject({ state: 'completed', relayed: true, executorSessionId: otherWorker })
      expect(during.deliveries.filter(delivery => delivery.chatId === h.chat.id).every(delivery => delivery.state === 'running')).toBe(true)
      expect(h.written).toEqual([])
      const firstRoot = await h.ctx.sessionController.inspect(h.chat.rootSessionId)
      expect(JSON.stringify(firstRoot.events)).not.toContain('B independently answered the other group')
      const secondRoot = await h.ctx.sessionController.inspect(other.rootSessionId)
      expect(JSON.stringify(secondRoot.events)).not.toContain('Collect B data and return its exact token.')
      h.answer.resolve('allowed-once')
      await settled(h.ctx, h.chat.id)
      expect(h.written.map(entry => entry.sessionId)).toEqual([h.state.b.sessionId])
      expect(h.adapter.requests.map(request => request.sessionId))
        .toEqual([h.state.a.sessionId, h.state.b.sessionId, otherWorker, h.state.b.sessionId, h.state.a.sessionId])
      for (const previous of h.privateEvents) {
        expect(h.ctx.agents.get(previous.id)!.session.snapshotEvents()).toEqual(previous.events)
      }
    } finally { h.answer.resolve('rejected') }
  })
})
