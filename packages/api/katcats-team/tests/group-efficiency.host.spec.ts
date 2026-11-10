/** Same-input routing and prompt-volume comparison; scripted usage is never reported as billing evidence. */
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { chatsDomainSpec, chatsStateSchema } from '../src/chats-storage.ts'
import type { TeamChat } from '../src/chats-types.ts'
import type { TeamBot } from '../src/types.ts'
import { memoryFixture } from './memory-fixture.ts'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

async function idle(ctx: Context, chat: TeamChat): Promise<void> {
  const controller = new AbortController()
  try {
    for await (const frame of ctx.katcatsChats.follow(controller.signal)) {
      if (frame.value.activities.find(activity => activity.chatId === chat.id)?.processing === false) return
    }
    throw new Error('The synthetic group closed before becoming idle')
  } finally { controller.abort() }
}

function requestText(request: GenerateOptions): string {
  return request.messages.findLast(message => message.role === 'user' && message.source?.kind === 'katcats-group-task')
    ?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? ''
}

async function scenario(legacy: boolean) {
  let round = 0
  const respond = (request: GenerateOptions): StreamChunk[] => {
    const marker = `CURRENT_REQUEST_${String(round)}`
    expect(requestText(request)).toContain(marker)
    if (!legacy) expect(requestText(request).split(marker)).toHaveLength(2)
    // These values belong to the deterministic model fixture, not provider token accounting.
    return textResponse(`Acknowledged ${marker}; next workshop starts at ${String(9 + round)}:00.`)
  }
  const h = await memoryFixture(Array.from({ length: 60 }, () => respond))
  const members: TeamBot[] = []
  for (let index = 0; index < 8; index++) members.push((await h.ctx.katcatsTeam.createBot({ name: `Member ${String(index + 1)}` })).bot)
  const chat = (await h.ctx.katcatsChats.createChat({ name: 'Workshop coordination', memberIds: members.map(bot => bot.id),
    managerId: members[0]!.id })).chat
  const started = performance.now()
  for (round = 0; round < 6; round++) {
    const previous = (await h.ctx.katcatsChats.snapshot()).chats[0]!
    await h.ctx.katcatsChats.pause({ id: chat.id, expectedRunId: previous.run?.id ?? null, expectedGeneration: previous.generation })
    const marker = `CURRENT_REQUEST_${String(round)}`
    const text = `${marker}: The next workshop starts at ${String(9 + round)}:00; replace any previous workshop time. Acknowledge this change.\n`
      + Array.from({ length: 20 }, (_, index) => `Workshop reference ${String(index)}: discuss clear ownership, concise handoffs and evidence-backed delivery.`).join('\n')
    await h.ctx.katcatsChats.sendMessage({ sessionId: chat.rootSessionId, mode: 'queue',
      requestId: brandString<SessionRequestId>(`efficiency-round-${String(round)}`), content: [{ type: 'text', text }] }, new AbortController().signal)
    await idle(h.ctx, chat)
    if (legacy) {
      const domain = h.ctx.storageDomain.get(chatsDomainSpec.name)!
      const saved = chatsStateSchema.parse(domain.global.get())
      // Recreate an already accepted pre-upgrade input; the production legacy path resumes its fixed recipient list.
      await domain.global.set({ ...saved, inbounds: saved.inbounds.map(({ collaborationVersion: _version, ...input }) => ({ ...input,
        recipients: members.map(bot => bot.id) })) })
    }
    const paused = (await h.ctx.katcatsChats.snapshot()).chats[0]!
    await h.ctx.katcatsChats.resume({ id: chat.id, expectedRunId: paused.run!.id, expectedGeneration: paused.generation })
    await idle(h.ctx, chat)
    const done = await h.ctx.katcatsChats.snapshot()
    expect(done.chats[0]).toMatchObject({ status: 'active', run: null, error: null })
    expect(done.deliveries.every(delivery => delivery.state === 'completed' && delivery.relayed)).toBe(true)
  }
  const elapsedMs = Number((performance.now() - started).toFixed(2))
  const requests = h.adapter.requests
  const managerSession = chat.executors.find(executor => executor.botId === members[0]!.id)!.sessionId
  const report = {
    members: members.length, ownerMessages: round,
    modelCalls: requests.length,
    uninvolvedMemberCalls: requests.filter(request => request.sessionId !== managerSession).length,
    serializedMessageChars: requests.reduce((sum, request) => sum + JSON.stringify(request.messages).length, 0),
    newlyInjectedTaskChars: requests.reduce((sum, request) => sum + requestText(request).length, 0),
    elapsedMs,
  }
  const final = await h.ctx.katcatsChats.snapshot()
  expect(final.deliveries.filter(delivery => delivery.receipt?.text.includes('CURRENT_REQUEST_5')).length).toBe(legacy ? 8 : 1)
  await h.close()
  return report
}

describe('group collaboration efficiency evidence', () => {
  it('reduces unrelated calls and repeated prompt text for the same eight-member six-message conversation', async () => {
    const before = await scenario(true)
    const after = await scenario(false)
    expect(before.modelCalls).toBe(48)
    expect(after.modelCalls).toBe(6)
    expect(after.uninvolvedMemberCalls).toBe(0)
    expect(after.newlyInjectedTaskChars).toBeLessThan(before.newlyInjectedTaskChars)
    expect(after.serializedMessageChars).toBeLessThan(before.serializedMessageChars)
    console.info('GROUP_EFFICIENCY_EVIDENCE ' + JSON.stringify({ basis: 'scripted model; actual request counts and characters, not token billing', before, after }))
  }, 60000)
})
