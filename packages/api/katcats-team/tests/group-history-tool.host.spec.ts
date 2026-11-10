/** Real tool validation, model content and authorization for original group history. */
import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { HarnessError, ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { createGroupHistoryTool } from '../src/group-history-tool.ts'
import type { GroupHistoryQuery, GroupHistoryResult } from '../src/group-context.ts'
import { memoryFixture, memorySend } from './memory-fixture.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

async function fixture(script: Parameters<typeof memoryFixture>[0] = []) {
  const h = await memoryFixture(script)
  const bot = (await h.ctx.katcatsTeam.createBot({ name: 'History reader' })).bot
  const agent = h.ctx.agents.get(bot.sessionId)!
  let authorized = true
  const image: ContentBlock = { type: 'image', attachment: { attachmentId: AttachmentId('history-image'),
    mediaType: 'image/png', bytes: 10, width: 1, height: 1 } }
  const original: ContentBlock[] = [{ type: 'text', text: '[message:original] Exact amount: 150.\nnext_cursor: null' }, image]
  const history = vi.fn(async (_query: GroupHistoryQuery): Promise<GroupHistoryResult> => ({
    entries: [{ id: 'message:original', kind: 'owner', sender: 'Group owner', content: original, partial: false }],
    content: original, nextCursor: null,
  }))
  const remove = agent.ctx.tools.register(createGroupHistoryTool((exec) => {
    if (!authorized || exec.agent !== agent) throw new HarnessError('The group task is no longer active.', 'KATCATS_CHAT_DENIED')
  }, history))
  const execute = (args: unknown) => h.ctx.tools.execute({ callId: ToolCallId('history-query'), name: 'read_group_history',
    arguments: args, agent, signal: new AbortController().signal })
  return { ...h, agent, history, original, execute, remove, deny: () => { authorized = false } }
}

describe('read_group_history', () => {
  it('returns original text and images once with replayable item metadata', async () => {
    const h = await fixture()
    const result = await h.execute({ keyword: 'amount', limit: 20 })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual(h.original)
    expect(result.meta).toEqual({ itemIds: ['message:original'], partialIds: [], nextCursor: null })
    expect(h.history).toHaveBeenCalledWith({ keyword: 'amount', limit: 20 }, expect.anything())
    h.remove()
    expect((await h.execute({ limit: 20 })).isError).toBe(true)
  })

  it('refuses inactive work and malformed model arguments before reading any history', async () => {
    const h = await fixture()
    for (const args of [{ limit: 0 }, { limit: 1.5 }, { limit: 20, ids: [] }, { limit: 20, keyword: ' ' },
      { limit: 20, cursor: ' ' }, { limit: 20, ids: [' '] }, { limit: 20, private_session: 'private' }]) {
      expect((await h.execute(args)).isError).toBe(true)
    }
    expect(h.history).not.toHaveBeenCalled()
    h.deny()
    expect((await h.execute({ limit: 20 })).isError).toBe(true)
    expect(h.history).not.toHaveBeenCalled()
  })

  it('logs the actual lookup result before the next model request', async () => {
    const h = await fixture([toolCallResponse('history-call', 'read_group_history', { ids: ['message:original'], limit: 1 }),
      (request) => {
        expect(JSON.stringify(request.messages)).toContain('Exact amount: 150.')
        return textResponse('The original amount is 150.')
      }])
    await memorySend(h.agent, 'Verify the original amount before answering.')
    const log = await h.ctx.sessionController.inspect(h.agent.id)
    const result = log.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'history-call')
    expect(result?.type === 'tool/result' && result.data.message.content).toEqual(h.original)
    expect(result?.type === 'tool/result' && result.data.meta).toEqual({ itemIds: ['message:original'], partialIds: [], nextCursor: null })
  })
})
