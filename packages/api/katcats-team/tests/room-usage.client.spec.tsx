// @vitest-environment jsdom
/** Reported group-run usage stays separate from private work and incomplete accounting. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type { RetryId } from '@deepseek-ai/dsh-llm-retry/types'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { BotId } from '../src/types.ts'
import type { ChatId, ChatRunId, ChatDeliveryId } from '../src/chats-types.ts'
import { projectRoomUsage, totalRoomUsage } from '../src/client/room-usage-model.ts'
import { RoomUsage } from '../src/client/RoomUsage.tsx'
import { roomZh } from '../src/client/room-locales.ts'

afterEach(cleanup)
const chatId = 'group' as ChatId, runId = 'run' as ChatRunId
const usage: TokenUsage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 0,
  totalTokens: 170, reasoningTokens: 10 }
function task(session: Session, group = chatId, run = runId) {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'synthetic task' }],
    source: { kind: 'katcats-group-task', form: 'relay', chatId: group, runId: run, generation: 1,
      deliveryId: 'delivery' as ChatDeliveryId,
      target: { botId: 'bot' as BotId, name: 'Bot', role: 'Review', avatar: { shape: 'classic', color: '#2288FF' } } } }), { surfaceOp: 'append' })
}
function reply(session: Session, step: number, value: TokenUsage | undefined = usage) {
  session.append('assistant/message', { turn: 1, step, stream: [],
    message: createAssistantMessage({ content: [], source: { provider: 'fixture', model: 'fixture' } }),
    ...(value === undefined ? {} : { usage: value }) }, { surfaceOp: 'append' })
}
function entries(session: Session) { return session.snapshotEvents().map(event => ({ type: 'event' as const, event })) }

describe('group run token usage', () => {
  it('deduplicates settlements and counts explicit retry attempts without adding reasoning twice', () => {
    const session = Session.create(SessionId('worker'))
    task(session)
    session.append('assistant/attempt', { turn: 1, step: 1, stream: [{ type: 'chunk', time: 1000, chunk: { type: 'usage', usage } }] })
    reply(session, 1)
    session.append('llm/retry-started', { retryId: 'retry' as RetryId, turn: 1, step: 1, retry: 1 })
    reply(session, 1)
    const log = entries(session)
    const samples = projectRoomUsage([...log, ...log], chatId)
    expect(totalRoomUsage(samples)).toEqual({ calls: 2, missing: 0, input: 200, output: 40, cacheRead: 100, cacheWrite: 0, total: 340 })
    expect(samples.every(sample => sample.runId === runId)).toBe(true)
    expect(totalRoomUsage(samples)).toMatchSnapshot()
  })
  it('separates runs and leaves other-group or missing input identities unassigned', () => {
    const session = Session.create(SessionId('worker'))
    reply(session, 1)
    task(session)
    reply(session, 2)
    task(session, chatId, 'next' as ChatRunId)
    reply(session, 3)
    task(session, 'other-group' as ChatId)
    reply(session, 4)
    const samples = projectRoomUsage(entries(session), chatId)
    expect(samples.map(sample => sample.runId)).toEqual([null, runId, 'next', null])
    expect(totalRoomUsage(samples.filter(sample => sample.runId === runId)).total).toBe(170)
  })
  it('keeps unreported totals, cache buckets and interrupted usage explicitly unknown', () => {
    expect(totalRoomUsage([{ runId, usage: { inputTokens: 10, outputTokens: 2 } }]))
      .toMatchObject({ total: null, cacheRead: null, cacheWrite: null })
    expect(totalRoomUsage([{ runId, usage: null }])).toMatchObject({ calls: 1, missing: 1, total: null })
    expect(totalRoomUsage([{ runId, usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } }]).total).toBe(19)
  })
  it('shows reported member usage, hides fees and does not leak live totals into replay', () => {
    const props = { snapshot: { connected: true, members: [{ botId: 'bot' as BotId,
      sessionId: SessionId('worker'), state: 'ready' as const,
      rows: [], usage: [{ runId, usage }], hasMore: true }] },
    projection: { members: [], tasks: [], transitions: [], timeline: [], replies: [] },
    runId, replay: false, running: false, t: makeTranslate(roomZh) }
    const view = render(<RoomUsage {...props} />)
    expect(screen.getAllByText('170')).toHaveLength(2)
    expect(screen.getByText('仅含已加载且已返回的用量，部分记录可能缺失')).toBeTruthy()
    expect(screen.queryByText('费用')).toBeNull()
    view.rerender(<RoomUsage {...props} replay />)
    expect(screen.queryByText('170')).toBeNull()
    expect(screen.getByText('回放时不展示当前实时用量')).toBeTruthy()
  })
})
