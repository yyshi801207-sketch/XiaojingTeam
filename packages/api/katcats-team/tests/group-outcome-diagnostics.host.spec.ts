/** Real Loader outcome diagnostics preserve uncertainty without exposing provider exception text. */
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ChatFailure, TeamChat } from '../src/chats-types.ts'
import { memoryFixture } from './memory-fixture.ts'
import { maxTokensResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const sensitiveError = 'SYNTHETIC_PROVIDER_SECRET_DO_NOT_PUBLISH'

const cases = [
  { kind: 'error', code: 'KATCATS_CHAT_MEMBER_ERROR',
    message: 'The member execution failed before confirming completion. Inspect saved group results before retrying.' },
  { kind: 'malformed-response', code: 'KATCATS_CHAT_MEMBER_MALFORMED_RESPONSE',
    message: 'The model response format was invalid. The member result is unconfirmed; inspect saved group results before retrying.' },
  { kind: 'max-tokens', code: 'KATCATS_CHAT_MEMBER_MAX_TOKENS',
    message: 'The member reached its output limit before confirming completion. Inspect saved group results before retrying.' },
  { kind: 'aborted', code: 'KATCATS_CHAT_MEMBER_ABORTED',
    message: 'The member execution was cancelled before confirming completion. Inspect saved group results before retrying.' },
  { kind: 'blocked', code: 'KATCATS_CHAT_MEMBER_BLOCKED',
    message: 'The member could not enter its next step. Its work is unconfirmed; inspect saved group results before retrying.' },
] as const

async function settled(h: Awaited<ReturnType<typeof memoryFixture>>, chat: TeamChat): Promise<void> {
  const controller = new AbortController()
  try {
    for await (const frame of h.ctx.katcatsChats.follow(controller.signal)) {
      if (frame.value.activities.find(activity => activity.chatId === chat.id)?.processing === false) return
    }
    throw new Error('The synthetic group closed before its diagnostic settled')
  } finally { controller.abort() }
}

describe('unconfirmed group outcome diagnostics', () => {
  it.each(cases)('retains the actual $kind reason without retrying, completing or exposing exception text', async (scenario) => {
    const h = await memoryFixture(scenario.kind === 'malformed-response'
      ? [() => { throw new LlmError(sensitiveError, 'MALFORMED_RESPONSE') }]
      : scenario.kind === 'error' ? [() => { throw new Error(sensitiveError + ': MALFORMED_RESPONSE') }]
        : scenario.kind === 'max-tokens' ? [maxTokensResponse('An unfinished deliverable must not be reported as complete.')]
          : scenario.kind === 'blocked' ? [toolCallResponse('diagnostic-recall', 'recall', {})] : ['hang'])
    const bot = (await h.ctx.katcatsTeam.createBot({ name: 'Diagnostic member' })).bot
    const chat = (await h.ctx.katcatsChats.createChat({ name: 'Synthetic diagnostic', memberIds: [bot.id] })).chat
    const executorId = chat.executors[0]!.sessionId
    if (scenario.kind === 'blocked') {
      const agent = h.ctx.agents.get(executorId)
      if (agent === undefined) throw new Error('The synthetic executor was not loaded')
      h.ctx.effect(() => agent.ctx.on('agent/pre-step', (payload, next) => payload.step === 2
        ? Promise.resolve({ kind: 'reject' }) : next()))
    }
    const privateBefore = (await h.ctx.sessionController.inspect(bot.sessionId)).events
    await h.ctx.katcatsChats.sendMessage({ sessionId: chat.rootSessionId,
      requestId: brandString<SessionRequestId>('diagnostic-owner'), mode: 'queue',
      content: [{ type: 'text', text: 'Produce one result for this group.' }],
    }, new AbortController().signal)
    if (scenario.kind === 'aborted') {
      await expect.poll(() => h.adapter.requests.length).toBe(1)
      const agent = h.ctx.agents.get(executorId)
      if (agent === undefined) throw new Error('The synthetic executor was not loaded')
      agent.cancel({ kind: 'user' }, { keepInbox: true })
    }
    await settled(h, chat)
    const snapshot = await h.ctx.katcatsChats.snapshot()
    const expected: ChatFailure = { code: scenario.code, message: scenario.message }
    expect(snapshot.deliveries).toHaveLength(1)
    expect(snapshot.deliveries[0]).toMatchObject({ state: 'unknown', receipt: null, relayed: false, error: expected })
    expect(snapshot.chats[0]).toMatchObject({ status: 'paused', pauseReason: 'unknown-result', error: expected })
    const worker = await h.ctx.sessionController.inspect(executorId)
    expect(worker.events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind))
      .toEqual([scenario.kind === 'malformed-response' ? 'error' : scenario.kind])
    const group = await h.ctx.sessionController.inspect(chat.rootSessionId)
    expect(JSON.stringify({ snapshot, group: group.events })).not.toContain(sensitiveError)
    expect(group.events.some(event => event.type === 'user/message' && event.data.source.kind === 'katcats-group-relay')).toBe(false)
    expect((await h.ctx.sessionController.inspect(bot.sessionId)).events).toEqual(privateBefore)
    await expect(h.ctx.katcatsChats.resume({ id: chat.id, expectedRunId: snapshot.chats[0]!.run?.id ?? null,
      expectedGeneration: snapshot.chats[0]!.generation })).rejects.toThrow('An earlier member outcome is unknown')
    expect(h.adapter.requests).toHaveLength(1)
    await h.close()
    const cold = await memoryFixture([], h.root)
    const reopened = await cold.ctx.katcatsChats.snapshot()
    expect(reopened.deliveries[0]).toMatchObject({ state: 'unknown', receipt: null, error: expected })
    expect(cold.adapter.requests).toEqual([])
    const coldEvents = (await cold.ctx.sessionController.inspect(chat.rootSessionId)).events
    expect(coldEvents.slice(0, group.events.length)).toEqual(group.events)
    expect(coldEvents.slice(group.events.length).map(event => ({ type: event.type, data: event.data })))
      .toEqual([{ type: 'session/end-seed', data: {} }])
    expect({ workerEnd: worker.events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind),
      state: snapshot.deliveries[0]!.state, error: snapshot.deliveries[0]!.error,
      taskErrors: group.events.flatMap(event => event.type === 'katcats/group-task-lifecycle' && event.data.error !== null
        ? [{ status: event.data.status, error: event.data.error }] : []),
      modelCalls: h.adapter.requests.length, coldModelCalls: cold.adapter.requests.length,
    }).toMatchSnapshot()
  })
})
