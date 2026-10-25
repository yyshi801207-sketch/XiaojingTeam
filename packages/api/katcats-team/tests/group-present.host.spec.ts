/** Real file creation and presentation in group workers; only external model responses are scripted. */
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import * as Present from '@deepseek-ai/dsh-tool-present'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import * as FileTools from '@deepseek-ai/dsh-tool-fs'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import ApprovalService, { type ApprovalAnswer } from '@deepseek-ai/dsh-user-approval'
import type { TeamChat } from '../src/chats-types.ts'
import { groupFileClaimMatches } from '../src/group-file-claim.ts'
import { memoryFixture } from './memory-fixture.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

function batch(...responses: StreamChunk[][]): StreamChunk[] {
  let offset = 0
  const output: StreamChunk[] = []
  for (const response of responses) {
    const chunks = response.filter(chunk => chunk.type !== 'finish' && chunk.type !== 'usage')
    output.push(...chunks.map(chunk => 'index' in chunk ? { ...chunk, index: chunk.index + offset } : chunk))
    offset += Math.max(...chunks.map(chunk => 'index' in chunk ? chunk.index + 1 : 0))
  }
  return [...output, { type: 'finish', reason: { kind: 'tool-calls' } }]
}

function write(callId: string, file: string, content: string): StreamChunk[] {
  return toolCallResponse(callId, 'write', { file_path: file, content })
}

function present(callId: string, file: string): StreamChunk[] {
  return toolCallResponse(callId, 'present', { files: [{ path: file, description: `Final ${file}` }] })
}

async function settled(ctx: Context, chat: TeamChat): Promise<void> {
  const controller = new AbortController()
  try {
    for await (const frame of ctx.katcatsChats.follow(controller.signal)) {
      if (frame.value.activities.find(activity => activity.chatId === chat.id)?.processing === false) return
    }
    throw new Error('The synthetic file-delivery group closed before its work settled')
  } finally { controller.abort() }
}

async function send(ctx: Context, chat: TeamChat, text: string, requestId: string): Promise<void> {
  await ctx.katcatsChats.sendMessage({ sessionId: chat.rootSessionId, mode: 'queue',
    requestId: brandString<SessionRequestId>(requestId), content: [{ type: 'text', text }],
  }, new AbortController().signal)
  await settled(ctx, chat)
}

async function fixture(script: Parameters<typeof memoryFixture>[0]) {
  const h = await memoryFixture(script)
  Object.assign(h.ctx.loader.builtins, { 'present-directory': WorkingDirectory, 'present-files': FileTools, 'present-delivery': Present })
  await h.ctx.loader.create({ name: 'cordis:present-directory', config: { defaultDirectory: h.root } })
  await h.ctx.loader.create({ name: 'cordis:present-files', config: { read: false, readImage: false, write: true, edit: false } })
  await h.ctx.loader.create({ name: 'cordis:present-delivery', config: { maxFiles: 8 } })
  await h.ctx.loader.await()
  const a = (await h.ctx.katcatsTeam.createBot({ name: 'A' })).bot
  const b = (await h.ctx.katcatsTeam.createBot({ name: 'B' })).bot
  const chat = (await h.ctx.katcatsChats.createChat({ name: 'Actual final files', memberIds: [a.id, b.id], managerId: a.id })).chat
  const workerA = chat.executors.find(executor => executor.botId === a.id)!.sessionId
  return { ...h, a, b, chat, workerA }
}

describe('group final file registration', () => {
  it('presents the already finished second file on a new broadcast request without manufacturing another work split', async () => {
    const h = await fixture([
      batch(write('write-first', 'first.md', 'FIRST_CONFIRMED_ARTICLE'), write('write-second', 'second.md', 'SECOND_CONFIRMED_ARTICLE')),
      present('present-first', 'first.md'), textResponse('The first complete article is delivered; the second file is also finished.'),
      present('present-second', 'second.md'), textResponse('The second finished article is now delivered without rewriting it.'),
      toolCallResponse('b-no-new-work', 'pass_group_turn', {}),
    ])
    await send(h.ctx, h.chat, '@A Save the two finished articles and deliver the first file.', 'first-file')
    await send(h.ctx, h.chat, 'Please also deliver the second finished file; do not rewrite it.', 'second-file')
    expect(await readFile(join(h.chat.workDir, 'first.md'), 'utf8')).toBe('FIRST_CONFIRMED_ARTICLE')
    expect(await readFile(join(h.chat.workDir, 'second.md'), 'utf8')).toBe('SECOND_CONFIRMED_ARTICLE')
    const history = await h.ctx.sessionController.inspect(h.workerA)
    const second = history.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'present-second')
    expect(second).toMatchObject({ data: { message: { isError: false } } })
    expect(history.events.filter(event => event.type === 'tool/call' && event.data.name === 'plan_group_work')).toEqual([])
    const presented = history.events.filter(event => event.type === 'deliverables/presented')
    expect(presented.map(event => ({ turn: event.data.turn, callId: event.data.callId,
      files: event.data.files.map(file => ({ ...file, path: basename(file.path) })) }))).toMatchInlineSnapshot(`
        [
          {
            "callId": "present-first",
            "files": [
              {
                "description": "Final first.md",
                "path": "first.md",
              },
            ],
            "turn": 1,
          },
          {
            "callId": "present-second",
            "files": [
              {
                "description": "Final second.md",
                "path": "second.md",
              },
            ],
            "turn": 2,
          },
        ]
      `)
    expect(h.adapter.requests[0]!.messages.flatMap(message => message.content.flatMap(block => block.type === 'text'
      ? block.text.split('\n').filter(line => line.startsWith('Deliver the actual requested work:')) : [])))
      .toMatchInlineSnapshot(`
        [
          "Deliver the actual requested work: provide usable full text for writing tasks rather than only a status or an offer to write later. When the requested deliverable is a file, use present to register its actual existing final file and give a brief summary. Delivering an already finished file again needs no new plan or rewrite; unfinished plans and same-step dependency rules still apply.",
        ]
      `)
    const done = await h.ctx.katcatsChats.snapshot()
    expect(done.chats[0]).toMatchObject({ status: 'active', run: null, error: null })
    for (const delivery of done.deliveries.filter(value => value.botId === h.a.id)) {
      expect(history.events.some(event => event.type === 'assistant/message' && event.data.interrupted !== true
        && event.data.message.id === delivery.receipt?.outputMessageId
        && event.data.message.content.every(block => block.type !== 'tool-call'))).toBe(true)
    }
    const groupHistory = await h.ctx.sessionController.inspect(h.chat.rootSessionId)
    const fileRelays = groupHistory.events.flatMap(event => event.type === 'user/message'
      && event.data.source.kind === 'katcats-group-relay' && event.data.source.executionSessionId === h.workerA
      && event.data.id !== event.data.source.outputMessageId
      ? [event.data.source] : [])
    expect(fileRelays).toHaveLength(2)
    for (const source of fileRelays) expect(groupFileClaimMatches(source, history.events)).toBe(true)
    expect(h.adapter.requests.some(request => request.sessionId === h.chat.rootSessionId)).toBe(false)
    await h.close()
    const cold = await memoryFixture([], h.root)
    expect((await cold.ctx.sessionController.inspect(h.workerA)).events.filter(event => event.type === 'deliverables/presented')).toEqual(presented)
    expect(cold.adapter.requests).toEqual([])
  })

  it('keeps a declared plan and same-step delegation blocked until actual member results are read', async () => {
    let bId = ''
    const h = await fixture([
      write('write-existing', 'finished.md', 'THE_PREVIOUSLY_SAVED_FILE'), textResponse('The previous file is saved.'),
      () => toolCallResponse('plan-review', 'plan_group_work', { own_task: 'Check the existing final delivery.',
        assignments: [{ bot_id: bId, message: 'Verify the exact saved file.' }] }),
      present('present-before-review', 'finished.md'),
      () => batch(present('present-before-request-in-batch', 'finished.md'),
        toolCallResponse('request-review', 'request_group_member', { bot_id: bId, message: 'Verify the exact saved file.' })),
      textResponse('B verified the saved file and returned its actual result.'),
      present('present-after-review', 'finished.md'), textResponse('The reviewed existing file is delivered.'),
    ])
    bId = h.b.id
    await send(h.ctx, h.chat, '@A Save this previously completed file.', 'existing-file')
    await send(h.ctx, h.chat, 'Ask B to review the existing file before delivering it.', 'review-file')
    const history = await h.ctx.sessionController.inspect(h.workerA)
    for (const callId of ['present-before-review', 'present-before-request-in-batch']) {
      expect(history.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === callId))
        .toMatchObject({ data: { message: { isError: true } } })
    }
    const failed = history.events.filter(event => event.type === 'tool/result' && event.data.message.isError)
    expect(JSON.stringify(failed)).toContain('Request every member in your recorded work split')
    expect(JSON.stringify(failed)).toContain('Read the requested member results in your next response')
    expect(history.events.flatMap(event => event.type === 'deliverables/presented' ? [event.data.callId] : []))
      .toEqual(['present-after-review'])
    expect((await h.ctx.katcatsChats.snapshot()).deliveries.every(delivery => delivery.state === 'completed')).toBe(true)
  })

  it('retains the original missing-file and regular-file validation without demanding new group work', async () => {
    const h = await fixture([
      present('present-missing', 'missing.md'), present('present-directory', '.'),
      textResponse('No final file was registered because both paths were invalid.'),
      toolCallResponse('b-invalid-files-pass', 'pass_group_turn', {}),
    ])
    await send(h.ctx, h.chat, 'Deliver the saved final file without making a new one.', 'invalid-files')
    const history = await h.ctx.sessionController.inspect(h.workerA)
    const results = history.events.filter(event => event.type === 'tool/result')
    expect(results.every(event => event.data.message.isError)).toBe(true)
    expect(JSON.stringify(results)).toContain('file not found')
    expect(JSON.stringify(results)).toContain('not a regular file')
    expect(JSON.stringify(results)).not.toContain('First use plan_group_work')
    expect(history.events.filter(event => event.type === 'deliverables/presented')).toEqual([])
  })

  it.each(['deny', 'stop'] as const)('does not register a file when its original approval is %s', async (action) => {
    const h = await fixture([
      write('write-protected', 'protected.md', 'PRESERVED_FILE'), textResponse('The existing file is saved.'),
      present('present-protected', 'protected.md'), textResponse('This file has not been registered for delivery.'),
      toolCallResponse('b-permission-pass', 'pass_group_turn', {}),
    ])
    h.ctx.loader.builtins['present-approval'] = ApprovalService
    await h.ctx.loader.create({ name: 'cordis:present-approval' })
    await h.ctx.loader.await()
    const shown = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<ApprovalAnswer>()
    h.ctx.on('tools/pre-execute', async (exec, next) => {
      const previous = await next()
      return exec.name === 'present' && previous.kind === 'allow' ? { kind: 'ask', reason: 'Approve this exact final file registration.' } : previous
    })
    h.ctx.on('approval/request', () => { shown.resolve(undefined); return answer.promise })
    try {
      await send(h.ctx, h.chat, '@A Save the completed file.', 'save-protected')
      await h.ctx.katcatsChats.sendMessage({ sessionId: h.chat.rootSessionId, mode: 'queue',
        requestId: brandString<SessionRequestId>('register-protected'), content: [{ type: 'text', text: 'Deliver the existing finished file.' }],
      }, new AbortController().signal)
      await shown.promise
      const waiting = await h.ctx.sessionController.inspect(h.workerA)
      expect(waiting.events.some(event => event.type === 'approval/asked')).toBe(true)
      expect(waiting.events.some(event => event.type === 'approval/decided')).toBe(false)
      expect(waiting.events.some(event => event.type === 'deliverables/presented')).toBe(false)
      if (action === 'deny') answer.resolve('rejected')
      else {
        const chat = (await h.ctx.katcatsChats.snapshot()).chats[0]!
        await h.ctx.katcatsChats.stop({ id: chat.id, expectedRunId: chat.run!.id, expectedGeneration: chat.generation })
        answer.resolve('allowed-once')
      }
      await settled(h.ctx, h.chat)
      expect((await h.ctx.sessionController.inspect(h.workerA)).events.some(event => event.type === 'deliverables/presented')).toBe(false)
      expect(await readFile(join(h.chat.workDir, 'protected.md'), 'utf8')).toBe('PRESERVED_FILE')
    } finally { answer.resolve('rejected') }
  })
})
