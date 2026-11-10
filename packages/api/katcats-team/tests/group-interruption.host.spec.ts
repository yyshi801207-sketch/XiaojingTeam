/** Real Loader interruption and retained file evidence; only external model responses are scripted. */
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { defineTool } from '@deepseek-ai/dsh-tools'
import ApprovalService, { type ApprovalAnswer } from '@deepseek-ai/dsh-user-approval'
import type { TeamChat } from '../src/chats-types.ts'
import { chatsDomainSpec, chatsStateSchema } from '../src/chats-storage.ts'
import { memoryFixture, memorySend } from './memory-fixture.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

function currentTask(options: GenerateOptions): string {
  const task = options.messages.filter(message => message.role === 'user' && message.source?.kind === 'katcats-group-task').at(-1)
  if (task === undefined) return ''
  const introduction = task.content[0]
  const source = introduction?.type === 'text' ? /^Current task source: (.+)$/m.exec(introduction.text)?.[1] : undefined
  if (source !== undefined) {
    const start = task.content.findIndex(block => block.type === 'text' && block.text.startsWith(`\n[${source}] `))
    if (start < 0) throw new Error('The current synthetic task source is absent')
    const blocks = task.content.slice(start + 1)
    const end = blocks.findIndex(block => block.type === 'text' && block.text.startsWith('\n['))
    return blocks.slice(0, end < 0 ? undefined : end).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  }
  return task.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    .split('The following is the saved public group conversation.')[0]!
}

function routinePlan(): StreamChunk[] {
  return toolCallResponse('plan-interruption-work', 'plan_group_work', { own_task: 'Prepare the requested synthetic document.',
    assignments: [], review: { reason: 'none' } })
}

async function send(ctx: Context, chat: TeamChat, text: string, id: string, mode: 'queue' | 'steer' = 'steer') {
  return ctx.katcatsChats.sendMessage({ sessionId: chat.rootSessionId,
    requestId: brandString<SessionRequestId>(id), mode, content: [{ type: 'text', text }],
  }, new AbortController().signal)
}

async function settled(ctx: Context, chat: TeamChat): Promise<void> {
  const controller = new AbortController()
  try {
    for await (const frame of ctx.katcatsChats.follow(controller.signal)) {
      if (frame.value.activities.find(activity => activity.chatId === chat.id)?.processing === false) return
    }
    throw new Error('The interrupted group closed before its owned work settled')
  } finally { controller.abort() }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

function untilReleased(signal: AbortSignal | undefined, released: Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { reject(new Error('Synthetic cooperative work observed cancellation')) }
    if (signal?.aborted) { abort(); return }
    signal?.addEventListener('abort', abort, { once: true })
    void released.then(() => { signal?.removeEventListener('abort', abort); resolve() })
  })
}

function holdResponse(ctx: Context, sessionId: SessionId, taskIncludes: string, skip = 0) {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let held = false
  let matching = 0
  let requestSignal: AbortSignal | undefined
  const remove = ctx.on('llm/stream', (request, next) => {
    const stream = next()
    if (request.sessionId !== sessionId || held || !currentTask(request).includes(taskIncludes)) return stream
    if (matching++ < skip) return stream
    held = true
    requestSignal = request.signal
    return (async function* () {
      for await (const chunk of stream) {
        if (chunk.type === 'finish') {
          entered.resolve(undefined)
          await untilReleased(request.signal, release.promise)
        }
        yield chunk
      }
    })()
  })
  return { entered: entered.promise, release: () => { release.resolve(undefined) }, signal: () => requestSignal, remove }
}

interface Members {
  readonly a: { readonly id: string; readonly sessionId: SessionId }
  readonly b: { readonly id: string; readonly sessionId: SessionId }
  readonly c: { readonly id: string; readonly sessionId: SessionId }
}

async function fixture(route: (members: Members, options: GenerateOptions) => StreamChunk[]) {
  const h = await memoryFixture(Array.from({ length: 30 }, () => (options: GenerateOptions) => route(members, options)))
  const a = (await h.ctx.katcatsTeam.createBot({ name: 'A' })).bot
  const b = (await h.ctx.katcatsTeam.createBot({ name: 'B' })).bot
  const c = (await h.ctx.katcatsTeam.createBot({ name: 'C' })).bot
  const chat = (await h.ctx.katcatsChats.createChat({ name: 'Owner interruption', memberIds: [a.id, b.id, c.id], relayLimit: 40 })).chat
  const worker = (id: typeof a.id) => chat.executors.find(executor => executor.botId === id)!.sessionId
  const members: Members = { a: { id: a.id, sessionId: worker(a.id) }, b: { id: b.id, sessionId: worker(b.id) },
    c: { id: c.id, sessionId: worker(c.id) } }
  const writes: { readonly sessionId: SessionId; readonly path: string; readonly content: string }[] = []
  h.ctx.effect(() => h.ctx.tools.register(defineTool({
    name: 'interruption_write', description: 'Write one actual synthetic task document into its owned workspace.',
    parameters: { file: { type: 'string', enum: ['old.md', 'source.md', 'new.md'], required: true },
      content: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      if (exec.agent?.session.header.cwd === undefined) throw new Error('The document writer has no owned working directory')
      const path = join(exec.agent.session.header.cwd, args.file)
      await writeFile(path, args.content)
      writes.push({ sessionId: exec.agent.id, path, content: args.content })
      return { path }
    },
  })))
  const savedInputs = () => chatsStateSchema.parse(h.ctx.storageDomain.get(chatsDomainSpec.name)!.global.get()).inbounds
  return { ...h, a, b, c, chat, members, writes, savedInputs }
}

function oldWrite(): StreamChunk[] {
  return toolCallResponse('old-write', 'interruption_write', { file: 'old.md', content: 'STALE_PRESENTATION' }, 'I am preparing the earlier document.')
}

async function rootReplies(ctx: Context, chat: TeamChat) {
  return (await ctx.sessionController.inspect(chat.rootSessionId)).events.flatMap(event =>
    event.type === 'user/message' && event.data.source.kind === 'katcats-group-relay' ? [event.data] : [])
}

describe('normal group sending interrupts only the owned old work', () => {
  it('continues the actual old next step when a temporary interrupt gate ends with a rejected replacement write', async () => {
    let originalSteps = 0
    const h = await fixture((_members, options) => {
      if (currentTask(options).includes('FAILED_REPLACEMENT')) throw new Error('A rejected replacement must never reach a model')
      originalSteps += 1
      if (originalSteps === 1) return routinePlan()
      if (originalSteps === 2) return toolCallResponse('hold-original-step', 'interruption_wait', {})
      if (originalSteps === 3) return toolCallResponse('still-valid-write', 'interruption_write',
        { file: 'old.md', content: 'ORIGINAL_TASK_COMPLETED_AFTER_REJECTED_REPLACEMENT' })
      return textResponse('A completed the still-valid original task after the replacement was not accepted.')
    })
    const toolEntered = Promise.withResolvers<undefined>()
    const releaseTool = Promise.withResolvers<undefined>()
    const writeEntered = Promise.withResolvers<undefined>()
    const rejectWrite = Promise.withResolvers<undefined>()
    const nextStepEntered = Promise.withResolvers<undefined>()
    h.ctx.effect(() => h.ctx.tools.register(defineTool({
      name: 'interruption_wait', description: 'Wait for the synthetic owner-admission race before finishing this tool.', parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] },
      execute: async (_args, exec) => {
        toolEntered.resolve(undefined)
        await untilReleased(exec.signal, releaseTool.promise)
        return {}
      },
    })))
    const agent = h.ctx.agents.get(h.members.a.sessionId)!
    const remove = agent.ctx.on('agent/pre-step', (payload, next) => {
      if (payload.step === 3) nextStepEntered.resolve(undefined)
      return next()
    }, { prepend: true })
    try {
      await send(h.ctx, h.chat, '@A ORIGINAL_TASK: finish this valid original document.', 'failed-gate-original')
      await toolEntered.promise
      const before = (await h.ctx.katcatsChats.snapshot()).chats[0]!
      vi.spyOn(h.ctx.storageDomain.get(chatsDomainSpec.name)!.global, 'set').mockImplementationOnce(async () => {
        writeEntered.resolve(undefined)
        await rejectWrite.promise
        throw new Error('Synthetic replacement storage rejected before commit')
      })
      const replacement = send(h.ctx, h.chat, '@A FAILED_REPLACEMENT: this input will fail to save.', 'failed-gate-replacement')
      const rejected = expect(replacement).rejects.toThrow('Synthetic replacement storage rejected before commit')
      await writeEntered.promise
      releaseTool.resolve(undefined)
      await nextStepEntered.promise
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      rejectWrite.resolve(undefined)
      await rejected
      await settled(h.ctx, h.chat)
      const saved = await h.ctx.katcatsChats.snapshot()
      expect(h.savedInputs().map(input => input.requestId)).toEqual(['failed-gate-original'])
      expect(saved.chats[0]).toMatchObject({ generation: before.generation, status: 'active', pauseReason: null, run: null })
      expect(saved.deliveries.map(delivery => delivery.state)).toEqual(['completed'])
      expect(h.writes.map(write => write.content)).toEqual(['ORIGINAL_TASK_COMPLETED_AFTER_REJECTED_REPLACEMENT'])
      expect(await readFile(join(h.chat.workDir, 'old.md'), 'utf8')).toBe('ORIGINAL_TASK_COMPLETED_AFTER_REJECTED_REPLACEMENT')
      const log = await h.ctx.sessionController.inspect(h.members.a.sessionId)
      expect(log.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'blocked')).toBe(false)
      expect(h.adapter.requests).toHaveLength(4)
    } finally { releaseTool.resolve(undefined); rejectWrite.resolve(undefined); remove() }
  })

  it('cancels a generated old model tool batch and answers the new instruction without a budget pause', async () => {
    let oldCalls = 0
    const h = await fixture((members, options) => {
      expect(options.sessionId).toBe(members.a.sessionId)
      if (currentTask(options).includes('NEW_OUTLINE')) return textResponse('A is following NEW_OUTLINE; no old presentation was written.')
      return ++oldCalls === 1 ? oldWrite() : textResponse('The old presentation was written.')
    })
    const held = holdResponse(h.ctx, h.members.a.sessionId, 'OLD_PRESENTATION')
    try {
      await send(h.ctx, h.chat, '@A OLD_PRESENTATION: prepare the old presentation.', 'old-start')
      await held.entered
      const old = (await h.ctx.katcatsChats.snapshot()).chats[0]!
      await send(h.ctx, h.chat, '@A NEW_OUTLINE: stop making that presentation and answer with the new outline.', 'new-direction')
      await expect.poll(() => held.signal()?.aborted, { timeout: 750 }).toBe(true)
      await settled(h.ctx, h.chat)
      expect(h.writes).toEqual([])
      expect(await exists(join(h.chat.workDir, 'old.md'))).toBe(false)
      expect(h.adapter.requests).toHaveLength(2)
      const snapshot = await h.ctx.katcatsChats.snapshot()
      expect(snapshot.chats[0]?.generation).toBeGreaterThan(old.generation)
      expect(snapshot.chats[0]).toMatchObject({ status: 'active', pauseReason: null, run: null })
      expect(snapshot.deliveries.filter(delivery => delivery.state === 'completed').map(delivery => delivery.receipt?.text))
        .toEqual(['A is following NEW_OUTLINE; no old presentation was written.'])
      expect(h.adapter.requests.some(request => request.sessionId === h.chat.rootSessionId)).toBe(false)
    } finally { held.release(); held.remove() }
  })

  it('keeps explicit queue mode queued and allows its original work to finish before answering the queued owner', async () => {
    let oldCalls = 0
    const h = await fixture((_members, options) => currentTask(options).includes('QUEUED_QUESTION')
      ? textResponse('The queued question is answered after the actual old document.')
      : ++oldCalls === 1 ? routinePlan() : oldCalls === 2 ? oldWrite() : textResponse('The old document is complete.'))
    const held = holdResponse(h.ctx, h.members.a.sessionId, 'OLD_PRESENTATION', 1)
    try {
      await send(h.ctx, h.chat, '@A OLD_PRESENTATION: prepare the document.', 'queue-original', 'queue')
      await held.entered
      await send(h.ctx, h.chat, '@A QUEUED_QUESTION: answer after the previous work.', 'queued-question', 'queue')
      expect(held.signal()?.aborted).toBe(false)
      expect(h.adapter.requests).toHaveLength(2)
      expect(h.writes).toEqual([])
      held.release()
      await settled(h.ctx, h.chat)
      expect(h.writes.map(write => write.content)).toEqual(['STALE_PRESENTATION'])
      expect((await rootReplies(h.ctx, h.chat)).map(reply => reply.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')))
        .toContain('The queued question is answered after the actual old document.')
    } finally { held.release(); held.remove() }
  })

  it('cancels the waiting parent and approval-owned B before C starts, and ignores a late approval allow', async () => {
    let aOldCalls = 0
    const h = await fixture((members, options) => {
      if (currentTask(options).includes('NEW_DIRECTION')) return textResponse('A accepted NEW_DIRECTION and left the former member task stopped.')
      if (options.sessionId === members.b.sessionId) return toolCallResponse('b-old-write', 'interruption_write', { file: 'old.md', content: 'STALE_B_WRITE' })
      expect(options.sessionId).toBe(members.a.sessionId)
      if (++aOldCalls > 1) return textResponse('A old work ended.')
      const first = toolCallResponse('ask-b', 'request_group_member', { bot_id: members.b.id, message: 'OLD_MEMBER_TASK: write the old document.' })
      const second = toolCallResponse('ask-c', 'request_group_member', { bot_id: members.c.id, message: 'Continue the old document.' })
      return [...first.filter(chunk => chunk.type !== 'finish'),
        ...second.map(chunk => 'index' in chunk ? { ...chunk, index: chunk.index + 1 } : chunk)]
    })
    h.ctx.loader.builtins['interruption-approval'] = ApprovalService
    await h.ctx.loader.create({ name: 'cordis:interruption-approval' })
    await h.ctx.loader.await()
    const asked = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<ApprovalAnswer>()
    h.ctx.on('tools/pre-execute', async (exec, next) => {
      const previous = await next()
      return exec.name === 'interruption_write' && exec.agent?.id === h.members.b.sessionId && previous.kind === 'allow'
        ? { kind: 'ask', reason: 'Approve only the original B document.' } : previous
    })
    h.ctx.on('approval/request', () => { asked.resolve(undefined); return answer.promise })
    try {
      await send(h.ctx, h.chat, '@A OLD_PRESENTATION: ask B and C for the document.', 'nested-old')
      await asked.promise
      await send(h.ctx, h.chat, '@A NEW_DIRECTION: cancel that task and answer this instead.', 'nested-replacement')
      await expect.poll(() => h.adapter.requests.filter(request => currentTask(request).includes('NEW_DIRECTION')).length,
        { timeout: 750 }).toBe(1)
      answer.resolve('allowed-once')
      await settled(h.ctx, h.chat)
      expect(h.writes).toEqual([])
      expect(h.adapter.requests.map(request => request.sessionId))
        .toEqual([h.members.a.sessionId, h.members.b.sessionId, h.members.a.sessionId])
      const snapshot = await h.ctx.katcatsChats.snapshot()
      expect(snapshot.deliveries.some(delivery => delivery.botId === h.c.id)).toBe(false)
      expect(snapshot.deliveries.filter(delivery => delivery.state === 'completed').map(delivery => delivery.receipt?.text))
        .toEqual(['A accepted NEW_DIRECTION and left the former member task stopped.'])
    } finally { answer.resolve('rejected') }
  })

  it('does not cancel the replacement again on an identical request retry, and rejects changed retry content', async () => {
    const h = await fixture((_members, options) => currentTask(options).includes('SECOND_TASK')
      ? textResponse('A completed the exact second task once.') : oldWrite())
    const oldHeld = holdResponse(h.ctx, h.members.a.sessionId, 'FIRST_TASK')
    const newHeld = holdResponse(h.ctx, h.members.a.sessionId, 'SECOND_TASK')
    try {
      await send(h.ctx, h.chat, '@A FIRST_TASK.', 'dedup-old')
      await oldHeld.entered
      await send(h.ctx, h.chat, '@A SECOND_TASK.', 'dedup-new')
      await expect.poll(() => h.adapter.requests.filter(request => currentTask(request).includes('SECOND_TASK')).length,
        { timeout: 750 }).toBe(1)
      await newHeld.entered
      const before = (await h.ctx.katcatsChats.snapshot()).chats[0]!
      await send(h.ctx, h.chat, '@A SECOND_TASK.', 'dedup-new')
      expect(newHeld.signal()?.aborted).toBe(false)
      expect((await h.ctx.katcatsChats.snapshot()).chats[0]?.generation).toBe(before.generation)
      expect(h.savedInputs().map(input => input.requestId)).toEqual(['dedup-old', 'dedup-new'])
      await expect(send(h.ctx, h.chat, '@A CHANGED_TASK.', 'dedup-new')).rejects.toThrow('cannot change')
      expect(newHeld.signal()?.aborted).toBe(false)
      newHeld.release()
      await settled(h.ctx, h.chat)
      expect(h.adapter.requests).toHaveLength(2)
      expect(h.writes).toEqual([])
    } finally { oldHeld.release(); newHeld.release(); oldHeld.remove(); newHeld.remove() }
  })

  it('interrupts only this group while the same Bot continues its private chat and another group', async () => {
    const h = await fixture((_members, options) => {
      if (options.sessionId === privateSession) return textResponse('PRIVATE_RESULT_STAYS_PRIVATE')
      if (options.sessionId === otherWorker) return textResponse('OTHER_GROUP_RESULT_STAYS_IN_OTHER_GROUP')
      return currentTask(options).includes('NEW_DIRECTION') ? textResponse('A followed the changed direction in its first group.') : oldWrite()
    })
    const privateSession: SessionId = h.a.sessionId
    const other = (await h.ctx.katcatsChats.createChat({ name: 'The same A in a second group', memberIds: [h.a.id], relayLimit: 40 })).chat
    const otherWorker: SessionId = other.executors[0]!.sessionId
    const oldHeld = holdResponse(h.ctx, h.members.a.sessionId, 'OLD_FIRST_GROUP')
    const privateHeld = holdResponse(h.ctx, privateSession, '')
    const otherHeld = holdResponse(h.ctx, otherWorker, 'OTHER_GROUP')
    try {
      await send(h.ctx, h.chat, '@A OLD_FIRST_GROUP.', 'isolated-old')
      await oldHeld.entered
      const privateWork = memorySend(h.ctx.agents.get(privateSession)!, 'Keep this private work running.')
      await privateHeld.entered
      await send(h.ctx, other, '@A OTHER_GROUP: finish this independent request.', 'other-group-input')
      await otherHeld.entered
      await send(h.ctx, h.chat, '@A NEW_DIRECTION: answer only the changed first-group request.', 'isolated-new')
      await expect.poll(() => oldHeld.signal()?.aborted, { timeout: 750 }).toBe(true)
      await settled(h.ctx, h.chat)
      expect(privateHeld.signal()?.aborted).toBe(false)
      expect(otherHeld.signal()?.aborted).toBe(false)
      expect(h.ctx.agents.get(privateSession)?.status).toBe('running')
      expect((await h.ctx.katcatsChats.snapshot()).deliveries.find(delivery => delivery.chatId === other.id)?.state).toBe('running')
      privateHeld.release()
      otherHeld.release()
      await privateWork
      await settled(h.ctx, other)
      expect(h.writes).toEqual([])
      expect(JSON.stringify(await rootReplies(h.ctx, h.chat))).not.toContain('PRIVATE_RESULT_STAYS_PRIVATE')
      expect(JSON.stringify(await rootReplies(h.ctx, h.chat))).not.toContain('OTHER_GROUP_RESULT_STAYS_IN_OTHER_GROUP')
      expect(JSON.stringify(await rootReplies(h.ctx, other))).toContain('OTHER_GROUP_RESULT_STAYS_IN_OTHER_GROUP')
      expect(JSON.stringify(await rootReplies(h.ctx, other))).not.toContain('NEW_DIRECTION')
    } finally {
      for (const held of [oldHeld, privateHeld, otherHeld]) { held.release(); held.remove() }
    }
  })

  it('retains an actual completed B file and published receipt when A is interrupted before its later write', async () => {
    let aCalls = 0
    let bCalls = 0
    const h = await fixture((members, options) => {
      if (currentTask(options).includes('KEEP_SOURCE')) {
        expect(JSON.stringify(options.messages)).toContain('B finished its source file: ./source.md contains ACTUAL_B_SOURCE_PRESERVED.')
        return textResponse('A kept the completed source and is following KEEP_SOURCE.')
      }
      if (options.sessionId === members.b.sessionId) return ++bCalls === 1
        ? toolCallResponse('actual-source', 'interruption_write', { file: 'source.md', content: 'ACTUAL_B_SOURCE_PRESERVED' })
        : textResponse('B finished its source file: ./source.md contains ACTUAL_B_SOURCE_PRESERVED.')
      if (++aCalls === 1) return toolCallResponse('ask-b', 'request_group_member', { bot_id: members.b.id, message: 'Write the real source file.' })
      return aCalls === 2 ? oldWrite() : textResponse('The old A work is complete.')
    })
    const held = holdResponse(h.ctx, h.members.a.sessionId, 'OLD_DELIVERY', 1)
    try {
      await send(h.ctx, h.chat, '@A OLD_DELIVERY: ask B for source and produce the presentation.', 'preserve-old')
      await held.entered
      const before = (await h.ctx.katcatsChats.snapshot()).deliveries.find(delivery => delivery.botId === h.b.id)!
      expect(before).toMatchObject({ state: 'completed', relayed: true })
      const publicBefore = (await rootReplies(h.ctx, h.chat)).find(reply => reply.id === before.relayMessageId)
      expect(publicBefore).toBeDefined()
      expect(await readFile(join(h.chat.workDir, 'source.md'), 'utf8')).toBe('ACTUAL_B_SOURCE_PRESERVED')
      await send(h.ctx, h.chat, '@A KEEP_SOURCE: retain that completed source; replace the presentation with a short outline.', 'preserve-new')
      await expect.poll(() => held.signal()?.aborted, { timeout: 750 }).toBe(true)
      await settled(h.ctx, h.chat)
      expect(await readFile(join(h.chat.workDir, 'source.md'), 'utf8')).toBe('ACTUAL_B_SOURCE_PRESERVED')
      expect(await exists(join(h.chat.workDir, 'old.md'))).toBe(false)
      expect((await h.ctx.katcatsChats.snapshot()).deliveries.find(delivery => delivery.id === before.id)).toEqual(before)
      expect((await rootReplies(h.ctx, h.chat)).find(reply => reply.id === before.relayMessageId)).toEqual(publicBefore)
      expect(h.writes.map(write => write.content)).toEqual(['ACTUAL_B_SOURCE_PRESERVED'])
      await h.close()
      const cold = await memoryFixture([], h.root)
      expect(cold.adapter.requests).toEqual([])
      expect((await cold.ctx.katcatsChats.snapshot()).deliveries.find(delivery => delivery.id === before.id)).toEqual(before)
      expect(await readFile(join(h.chat.workDir, 'source.md'), 'utf8')).toBe('ACTUAL_B_SOURCE_PRESERVED')
    } finally { held.release(); held.remove() }
  })

  it('keeps an already-started file effect as uncertain history while the replacement runs without pretending to roll it back', async () => {
    let originalSteps = 0
    const h = await fixture((_members, options) => currentTask(options).includes('REPLACEMENT')
      ? textResponse('A is following REPLACEMENT; the already-started old file remains for inspection.')
      : ++originalSteps === 1 ? routinePlan() : toolCallResponse('effect-before-cancel', 'interruption_uncertain_effect', {}))
    const entered = Promise.withResolvers<undefined>()
    const cleanup = Promise.withResolvers<undefined>()
    let effectSignal: AbortSignal | undefined
    h.ctx.effect(() => h.ctx.tools.register(defineTool({
      name: 'interruption_uncertain_effect', description: 'Write an actual file, then wait cooperatively before its outcome can be confirmed.',
      parameters: {}, output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] },
      execute: async (_args, exec) => {
        await writeFile(join(h.chat.workDir, 'already-started.md'), 'ACTUAL_EFFECT_BEFORE_CANCELLATION')
        effectSignal = exec.signal
        entered.resolve(undefined)
        await untilReleased(exec.signal, cleanup.promise)
        return {}
      },
    })))
    try {
      await send(h.ctx, h.chat, '@A ORIGINAL_EFFECT: work on the old file.', 'effect-old')
      await entered.promise
      const old = (await h.ctx.katcatsChats.snapshot()).deliveries[0]!
      await send(h.ctx, h.chat, '@A REPLACEMENT: stop the old work; report the retained actual progress.', 'effect-new')
      await expect.poll(() => effectSignal?.aborted, { timeout: 750 }).toBe(true)
      await settled(h.ctx, h.chat)
      expect(await readFile(join(h.chat.workDir, 'already-started.md'), 'utf8')).toBe('ACTUAL_EFFECT_BEFORE_CANCELLATION')
      const snapshot = await h.ctx.katcatsChats.snapshot()
      expect(snapshot.deliveries.find(delivery => delivery.id === old.id)).toMatchObject({ state: 'unknown', receipt: null })
      expect(snapshot.deliveries.filter(delivery => delivery.state === 'completed').map(delivery => delivery.receipt?.text))
        .toEqual(['A is following REPLACEMENT; the already-started old file remains for inspection.'])
      expect(snapshot.chats[0]).toMatchObject({ status: 'active', run: null })
    } finally { cleanup.resolve(undefined) }
  })

  it('serializes two rapid steering submissions, runs the newest input and never replays old tasks after cold reopen', async () => {
    const h = await fixture((_members, options) => currentTask(options).includes('THIRD_NEWEST')
      ? textResponse('Only THIRD_NEWEST is the current owner direction.')
      : oldWrite())
    const firstHeld = holdResponse(h.ctx, h.members.a.sessionId, 'FIRST_OLD')
    const secondHeld = holdResponse(h.ctx, h.members.a.sessionId, 'SECOND_INTERMEDIATE')
    try {
      await send(h.ctx, h.chat, '@A FIRST_OLD.', 'rapid-first')
      await firstHeld.entered
      await Promise.all([
        send(h.ctx, h.chat, '@A SECOND_INTERMEDIATE.', 'rapid-second'),
        send(h.ctx, h.chat, '@A THIRD_NEWEST.', 'rapid-third'),
      ])
      await expect.poll(() => firstHeld.signal()?.aborted, { timeout: 750 }).toBe(true)
      await expect.poll(() => h.adapter.requests.some(request => currentTask(request).includes('THIRD_NEWEST')),
        { timeout: 750 }).toBe(true)
      await settled(h.ctx, h.chat)
      expect(h.writes).toEqual([])
      expect(h.savedInputs().map(input => input.requestId)).toEqual(['rapid-first', 'rapid-second', 'rapid-third'])
      const before = await h.ctx.katcatsChats.snapshot()
      expect(before.deliveries.filter(delivery => delivery.state === 'completed').map(delivery => delivery.receipt?.text))
        .toEqual(['Only THIRD_NEWEST is the current owner direction.'])
      expect(before.chats[0]).toMatchObject({ status: 'active', run: null })
      const replies = await rootReplies(h.ctx, h.chat)
      await h.close()
      const cold = await memoryFixture([], h.root)
      expect(cold.adapter.requests).toEqual([])
      expect((await cold.ctx.katcatsChats.snapshot()).deliveries).toEqual(before.deliveries)
      expect(await rootReplies(cold.ctx, h.chat)).toEqual(replies)
    } finally { firstHeld.release(); secondHeld.release(); firstHeld.remove(); secondHeld.remove() }
  })
})
