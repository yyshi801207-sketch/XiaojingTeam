/** Group cards come from the confirmed worker turn and respect approved artifact bytes. */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MessageId, MessageSourceMap, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import { groupVisualizationCallIds } from '../src/group-file-claim.ts'
import type { ChatDeliveryId, ChatId, ChatRunId } from '../src/chats-types.ts'
import type { BotId } from '../src/types.ts'

const source: MessageSourceMap['katcats-group-relay'] = {
  kind: 'katcats-group-relay', form: 'relay', schemaVersion: 1,
  chatId: brandString<ChatId>('group'), deliveryId: brandString<ChatDeliveryId>('delivery'),
  runId: brandString<ChatRunId>('run'), generation: 1, executionSessionId: brandString<SessionId>('executor'),
  inputMessageId: brandString<MessageId>('input'), outputMessageId: brandString<MessageId>('closing'),
  sender: { botId: brandString<BotId>('author'), name: 'Author', role: '', avatar: { shape: 'classic', color: '#FF2849' } },
}

const fragment = '<section>Approved chart</section>'
const path = 'E:\\group\\viz\\chart.html'

function event(type: string, data: object): SessionEvent {
  return { seq: 1, time: 1, type, data } as SessionEvent
}

function result(turn: number, callId: string, name: string, meta: object, isError = false, args = '{}'): SessionEvent[] {
  return [event('tool/call', { turn, callId, name, arguments: args }),
    event('tool/result', { turn, message: { source: { callId }, isError }, meta })]
}

function turn(items: readonly SessionEvent[]): SessionEvent[] {
  return [event('turn/start', { turn: 1 }),
    event('user/message', { id: source.inputMessageId, source: {
      kind: 'katcats-group-task', chatId: source.chatId, deliveryId: source.deliveryId, runId: source.runId,
      generation: source.generation, target: source.sender, collaborationVersion: 1,
    } }), ...items, event('assistant/message', { turn: 1, message: { id: source.outputMessageId, content: [] } }),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } })]
}

describe('group visualization release', () => {
  it('uses the last successful card from the owned turn without admitting failed or unrelated calls', async () => {
    const events = turn([
      ...result(1, 'plan', 'plan_group_work', { review: { reason: 'none' } }),
      ...result(1, 'first', 'visualize', { kind: 'visualize', path, fragment: '<section>Draft</section>' }),
      ...result(1, 'latest', 'visualize', { kind: 'visualize', path, fragment }),
      ...result(1, 'failed', 'visualize', { kind: 'visualize', path, fragment }, true),
      ...result(1, 'imposter', 'other_tool', { kind: 'visualize', path, fragment }),
      ...result(2, 'later', 'visualize', { kind: 'visualize', path, fragment }),
    ])
    expect(await groupVisualizationCallIds(source, events)).toEqual([brandString<ToolCallId>('latest')])
    expect(await groupVisualizationCallIds({ ...source, chatId: brandString<ChatId>('other-group') }, events)).toEqual([])
    expect(await groupVisualizationCallIds(source, events.slice(0, -1))).toEqual([])
  })

  it('requires the card to match the exact file in the latest approved version', async () => {
    const approved = { status: 'completed', delivery_id: 'child', bot_id: 'reviewer',
      review_candidate: { version: 'version', files: [{ path: 'E:/group/viz/chart.html',
        sha256: createHash('sha256').update(fragment).digest('hex') }] },
      review: { parentDeliveryId: source.deliveryId, deliveryId: 'child', reviewerId: 'reviewer',
        candidateVersion: 'version', verdict: 'approved' } }
    const prepared = [
      ...result(1, 'plan', 'plan_group_work', { review: { reason: 'financial-conclusion', reviewer_bot_id: 'reviewer' } }),
      ...result(1, 'chart', 'visualize', { kind: 'visualize', path, fragment }),
    ]
    const reviewed = [...prepared, ...result(1, 'review', 'request_group_member', approved, false, '{"review_candidate":{}}')]
    expect(await groupVisualizationCallIds(source, turn(prepared))).toEqual([])
    expect(await groupVisualizationCallIds(source, turn(reviewed))).toEqual([brandString<ToolCallId>('chart')])
    const modified = [...reviewed, ...result(1, 'changed', 'visualize', { kind: 'visualize', path, fragment: '<section>Unreviewed change</section>' })]
    expect(await groupVisualizationCallIds(source, turn(modified))).toEqual([])
    const pending = [...reviewed, ...result(1, 'retry', 'request_group_member', {}, true, '{"review_candidate":{}}')]
    expect(await groupVisualizationCallIds(source, turn(pending))).toEqual([])
  })
})
