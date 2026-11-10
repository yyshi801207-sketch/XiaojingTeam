/** Real Loader requests and durable group logs verify incremental delivery across member handoffs and restart. */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { createUserMessage, type ContentBlock, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { CompactionId } from '@deepseek-ai/dsh-compaction'
import type { TeamChat } from '../src/chats-types.ts'
import { memoryFixture } from './memory-fixture.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

function text(content: readonly ContentBlock[]): string {
  return content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

function latestInput(request: GenerateOptions): string {
  const message = request.messages.findLast(item => item.role === 'user' && item.source?.kind === 'katcats-group-task')
  if (message === undefined) throw new Error('Missing actual group input')
  return text(message.content)
}

async function send(ctx: Context, chat: TeamChat, prompt: string, id: string): Promise<void> {
  await ctx.katcatsChats.sendMessage({ sessionId: chat.rootSessionId, mode: 'queue',
    requestId: brandString<SessionRequestId>(id), content: [{ type: 'text', text: prompt }] }, new AbortController().signal)
  const controller = new AbortController()
  try {
    for await (const frame of ctx.katcatsChats.follow(controller.signal)) {
      if (frame.value.activities.find(activity => activity.chatId === chat.id)?.processing === false) {
        expect(frame.value.chats.find(item => item.id === chat.id)).toMatchObject({ status: 'active', error: null, run: null })
        return
      }
    }
    throw new Error('The group closed before its task settled')
  } finally { controller.abort() }
}

function projectedInputs(events: readonly SessionEvent[]): string[] {
  return events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'katcats-group-task'
    ? [text(event.data.content).replace(/message:[a-f\d-]{36}/g, 'message:OWNER')] : [])
}

describe('persisted incremental group requests', () => {
  it('keeps current corrections complete, reads older originals in the actual tool log, and resumes coverage after restart', async () => {
    const firstPrompt = 'ORIGINAL_LIMIT is 100; keep this original source for later verification.'
    const correction = 'LATEST_CORRECTION: the limit is 150. Verify the previous original before acknowledging this change.'
    const h = await memoryFixture([
      (request) => {
        expect(latestInput(request).split(firstPrompt)).toHaveLength(2)
        return textResponse('Initial instruction received.')
      },
      (request) => {
        expect(latestInput(request)).toContain(correction)
        expect(latestInput(request)).not.toContain(firstPrompt)
        expect(latestInput(request)).not.toContain('Initial instruction received.')
        return toolCallResponse('read-original', 'read_group_history', { keyword: 'ORIGINAL_LIMIT', limit: 1 })
      },
      (request) => {
        const result = request.messages.find(message => message.role === 'tool' && message.toolCallId === 'read-original')
        expect(result === undefined ? '' : text(result.content)).toContain(firstPrompt)
        return textResponse('The original is retained. Latest instruction received.')
      },
    ])
    const owner = (await h.ctx.katcatsTeam.createBot({ name: 'Coordinator' })).bot
    const observer = (await h.ctx.katcatsTeam.createBot({ name: 'Observer' })).bot
    const chat = (await h.ctx.katcatsChats.createChat({ name: 'Incremental evidence', memberIds: [owner.id, observer.id], managerId: owner.id })).chat
    const executor = chat.executors.find(item => item.botId === owner.id)!.sessionId
    await send(h.ctx, chat, firstPrompt, 'context-first')
    await send(h.ctx, chat, correction, 'context-correction')
    expect(h.adapter.requests.map(request => request.sessionId)).toEqual([executor, executor, executor])
    const before = await h.ctx.sessionController.inspect(executor)
    const lookup = before.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'read-original')
    expect(lookup?.type === 'tool/result' ? text(lookup.data.message.content) : '').toContain(firstPrompt)
    expect(lookup?.type === 'tool/result' && lookup.data.meta).toMatchObject({ partialIds: [], nextCursor: null })
    expect(projectedInputs(before.events)).toMatchInlineSnapshot(`
      [
        "Current group: Incremental evidence
      Current task source: message:OWNER
      Public group context follows. It contains no private member conversation.
      Earlier history may be archived or summarized. Use read_group_history for original requirements, corrections, numbers, evidence or unresolved details before relying on a summary.
      Archived public items: 0
      This owner message is not classified. For substantive work, use record_group_task to create work or explicitly continue an existing task. Do not guess an ambiguous continuation; ask the owner. Unclassified messages remain shared context so corrections are not silently lost. Use find_group_tasks to find older tasks. Recent task index: []
      Actual saved group outcomes: []
      An unknown outcome does not confirm success. Verify saved work before claiming completion.

      [message:OWNER] Group owner:

      ORIGINAL_LIMIT is 100; keep this original source for later verification.",
        "Current group: Incremental evidence
      Current task source: message:OWNER
      Public group context follows. It contains no private member conversation.
      Earlier history may be archived or summarized. Use read_group_history for original requirements, corrections, numbers, evidence or unresolved details before relying on a summary.
      Archived public items: 0
      This owner message is not classified. For substantive work, use record_group_task to create work or explicitly continue an existing task. Do not guess an ambiguous continuation; ask the owner. Unclassified messages remain shared context so corrections are not silently lost. Use find_group_tasks to find older tasks. Recent task index: []
      Actual saved group outcomes: []
      An unknown outcome does not confirm success. Verify saved work before claiming completion.

      [message:OWNER] Group owner:

      LATEST_CORRECTION: the limit is 150. Verify the previous original before acknowledging this change.",
      ]
    `)
    await h.close()

    const resumed = await memoryFixture([(request) => {
      expect(latestInput(request)).toContain('THIRD_REQUEST: acknowledge the saved conversation.')
      expect(latestInput(request)).not.toContain(firstPrompt)
      expect(latestInput(request)).not.toContain(correction)
      expect(latestInput(request)).not.toContain('Latest instruction received.')
      return textResponse('Resumed conversation acknowledged.')
    }], h.root)
    await send(resumed.ctx, chat, 'THIRD_REQUEST: acknowledge the saved conversation.', 'context-after-restart')
    expect(resumed.adapter.requests.map(request => request.sessionId)).toEqual([executor])
    const after = await resumed.ctx.sessionController.inspect(executor)
    const inputs = after.events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'katcats-group-task'
      ? [event.data.source.context] : [])
    expect(inputs).toHaveLength(3)
    expect(inputs.every(manifest => manifest?.deliveredIds.length === 1 && manifest.archivedIds.length === 0)).toBe(true)
    const replay = Session.create(executor, after.events)
    expect(replay.deriveMessages().some(message => message.role === 'tool' && message.toolCallId === 'read-original')).toBe(true)
  })

  it('does not inject saved child results, its own public speech or its own handoff again on the next owner turn', async () => {
    let colleagueId = ''
    const h = await memoryFixture([
      toolCallResponse('read-colleague-id', 'list_group_members', {}),
      () => toolCallResponse('ask-colleague', 'request_group_member', { bot_id: colleagueId, message: 'EXACT_HANDOFF: report your synthetic label.' },
        'OWN_PROGRESS: asking the colleague now.'),
      textResponse('COLLEAGUE_REPLY: unique confirmed label.'),
      (request) => {
        expect(text(request.messages.flatMap(message => message.content)).match(/COLLEAGUE_REPLY/g)).toHaveLength(1)
        return textResponse('OWN_FINAL: colleague result received.')
      },
      (request) => {
        const input = latestInput(request)
        expect(input).not.toContain('COLLEAGUE_REPLY')
        expect(input).not.toContain('OWN_PROGRESS')
        expect(input).not.toContain('OWN_FINAL')
        expect(input).not.toContain('EXACT_HANDOFF')
        expect(input).toContain('NEXT_OWNER: acknowledge this next message.')
        return textResponse('Next message acknowledged.')
      },
      (request) => {
        const input = latestInput(request)
        expect(input.match(/COLLEAGUE_REPLY/g)).toHaveLength(1)
        expect(input).not.toContain('OWN_PROGRESS')
        expect(input).not.toContain('OWN_FINAL')
        return textResponse('Restored colleague evidence acknowledged.')
      },
    ])
    const owner = (await h.ctx.katcatsTeam.createBot({ name: 'Coordinator' })).bot
    const colleague = (await h.ctx.katcatsTeam.createBot({ name: 'Colleague' })).bot
    colleagueId = colleague.id
    const chat = (await h.ctx.katcatsChats.createChat({ name: 'Handoff evidence', memberIds: [owner.id, colleague.id], managerId: owner.id })).chat
    await send(h.ctx, chat, 'Ask the colleague for its synthetic label, then acknowledge receipt.', 'handoff-first')
    const ownExecutor = chat.executors.find(item => item.botId === owner.id)!.sessionId
    const agent = h.ctx.agents.get(ownExecutor)!
    const result = agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'ask-colleague')!
    const summary = agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Colleague evidence summarized.' }],
      source: { kind: 'compact-checkpoint', compactionId: brandString<CompactionId>('child-result-summary') },
    }), { surfaceOp: { op: 'replace', startSeq: result.seq, endSeq: result.seq }, sourceEventSeqs: [result.seq] })
    await send(h.ctx, chat, 'NEXT_OWNER: acknowledge this next message.', 'handoff-next')
    expect(h.adapter.requests).toHaveLength(5)
    const log = await h.ctx.sessionController.inspect(ownExecutor)
    const entered = log.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'katcats-group-task')
    expect(entered).toHaveLength(2)
    expect(entered[1]?.type === 'user/message' && entered[1].data.source.kind === 'katcats-group-task'
      && entered[1].data.source.context?.deliveredIds).toHaveLength(1)
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'The old evidence was removed.' }], source: { kind: 'user' } }),
      { surfaceOp: { op: 'replace', startSeq: summary.seq, endSeq: summary.seq }, sourceEventSeqs: [summary.seq] })
    await send(h.ctx, chat, 'THIRD_OWNER: acknowledge the available evidence.', 'handoff-pruned')
    expect(h.adapter.requests).toHaveLength(6)
  })
})
