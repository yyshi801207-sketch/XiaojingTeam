/** Real member failures remain reportable without approving unfinished work. */
import { describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { memoryFixture } from './memory-fixture.ts'
import { chatsDomainSpec, chatsStateSchema } from '../src/chats-storage.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

async function fixture(script: Parameters<typeof memoryFixture>[0]) {
  const h = await memoryFixture(script)
  const manager = (await h.ctx.katcatsTeam.createBot({ name: 'Manager' })).bot
  const worker = (await h.ctx.katcatsTeam.createBot({ name: 'Worker' })).bot
  const reviewer = (await h.ctx.katcatsTeam.createBot({ name: 'Reviewer' })).bot
  const chat = (await h.ctx.katcatsChats.createChat({ name: 'Blocked work',
    memberIds: [manager.id, worker.id, reviewer.id], managerId: manager.id })).chat
  let index = 0
  const send = async () => {
    await h.ctx.katcatsChats.sendMessage({ sessionId: chat.rootSessionId, mode: 'queue',
      requestId: brandString<SessionRequestId>('blocker-' + String(index++)), content: [{ type: 'text', text: 'Handle this task.' }],
    }, new AbortController().signal)
    await expect.poll(async () => (await h.ctx.katcatsChats.snapshot()).activities
      .find(activity => activity.chatId === chat.id)?.processing, { timeout: 10_000 }).toBe(false)
  }
  return { ...h, manager, worker, reviewer, chat, send }
}

describe('group blocker handling', () => {
  it.each(['authentication refused', 'permission denied', 'missing input', 'service unavailable', 'review unavailable'])(
    'returns %s to the manager without cancelling it or approving a deliverable', async (reason) => {
      let workerId = ''
      const h = await fixture([
        () => toolCallResponse('delegate', 'request_group_member', { bot_id: workerId, message: 'Perform the task.' }),
        toolCallResponse('blocked', 'report_group_blocker', { reason, next_step: 'Ask the owner to resolve the prerequisite.', effects: 'none' }, reason),
        request => {
          expect(JSON.stringify(request.messages)).toContain('KATCATS_CHAT_TASK_BLOCKED')
          expect(JSON.stringify(request.messages)).toContain(reason)
          return toolCallResponse('report', 'report_group_blocker', { reason, next_step: 'Resolve prerequisite, then send a new instruction.', effects: 'none' },
            'The task is blocked. Resolve the prerequisite before continuing.')
        },
        textResponse('I can respond to your next message.'),
      ])
      workerId = h.worker.id
      await h.send()
      let state = await h.ctx.katcatsChats.snapshot()
      expect(state.chats[0]?.status).toBe('active')
      expect(state.deliveries.map(d => [d.state, d.receipt, d.error?.code])).toEqual([
        ['failed', null, 'KATCATS_CHAT_TASK_BLOCKED'], ['failed', null, 'KATCATS_CHAT_TASK_BLOCKED'],
      ])
      const parent = state.deliveries[0]!
      const log = await h.ctx.sessionController.inspect(parent.executorSessionId)
      expect(log.events.filter(e => e.type === 'turn/end').map(e => e.data.reason.kind)).toEqual(['completed'])
      const root = await h.ctx.sessionController.inspect(h.chat.rootSessionId)
      expect(JSON.stringify(root.events)).toContain('Resolve the prerequisite before continuing.')
      await h.send()
      state = await h.ctx.katcatsChats.snapshot()
      expect(state.deliveries.at(-1)?.state).toBe('completed')
      expect(h.adapter.requests).toHaveLength(4)
    },
  )

  it('returns incomplete review to the manager while retaining the failed child and review requirement', async () => {
    let workerId = '', reviewerId = ''
    const h = await fixture([
      () => toolCallResponse('delegate', 'request_group_member', { bot_id: workerId, message: 'Prepare a reviewed conclusion.' }),
      () => toolCallResponse('plan', 'plan_group_work', { own_task: 'Prepare conclusion', assignments: [],
        review: { reason: 'financial-conclusion', reviewer_bot_id: reviewerId } }),
      textResponse('Unreviewed conclusion.'), textResponse('Still unreviewed.'),
      request => {
        expect(JSON.stringify(request.messages)).toContain('KATCATS_CHAT_REVIEW_INCOMPLETE')
        return toolCallResponse('report', 'report_group_blocker', { reason: 'Review has not completed.', next_step: 'Arrange independent review.', effects: 'none' },
          'The result is not approved; independent review is still needed.')
      },
    ])
    workerId = h.worker.id; reviewerId = h.reviewer.id
    await h.send()
    const state = await h.ctx.katcatsChats.snapshot()
    expect(state.chats[0]?.status).toBe('active')
    expect(state.deliveries.map(d => d.error?.code)).toEqual(['KATCATS_CHAT_TASK_BLOCKED', 'KATCATS_CHAT_REVIEW_INCOMPLETE'])
    expect(state.deliveries.every(d => d.receipt === null)).toBe(true)
    expect(h.adapter.requests).toHaveLength(5)
  })

  it('settles a directly assigned review failure without pausing the group', async () => {
    let reviewerId = ''
    const h = await fixture([
      () => toolCallResponse('plan-direct-review', 'plan_group_work', { own_task: 'Prepare a conclusion.', assignments: [],
        review: { reason: 'explicit-review', reviewer_bot_id: reviewerId } }),
      textResponse('The unreviewed conclusion is approved.'),
      request => {
        expect(JSON.stringify(request.messages)).toContain('actual approved review')
        return textResponse('The unreviewed conclusion is still approved.')
      },
      textResponse('I can respond to the next instruction.'),
    ])
    reviewerId = h.reviewer.id
    await h.send()
    const state = await h.ctx.katcatsChats.snapshot()
    expect(state.chats[0]).toMatchObject({ status: 'active', run: null, error: null })
    expect(state.deliveries).toHaveLength(1)
    expect(state.deliveries[0]).toMatchObject({
      state: 'failed', receipt: null, error: { code: 'KATCATS_CHAT_REVIEW_INCOMPLETE' },
    })
    const parent = await h.ctx.sessionController.inspect(state.deliveries[0]!.executorSessionId)
    expect(parent.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'katcats-group-review-notice')).toHaveLength(1)
    const root = await h.ctx.sessionController.inspect(h.chat.rootSessionId)
    expect(root.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'katcats-group-relay')).toEqual([])
    expect(root.events).toContainEqual(expect.objectContaining({
      type: 'katcats/group-task-lifecycle',
      data: expect.objectContaining({ deliveryId: state.deliveries[0]!.id, status: 'failed',
        error: expect.objectContaining({ code: 'KATCATS_CHAT_REVIEW_INCOMPLETE' }) }),
    }))
    expect(h.adapter.requests).toHaveLength(3)

    await h.send()
    const next = await h.ctx.katcatsChats.snapshot()
    expect(next.chats[0]).toMatchObject({ status: 'active', run: null, error: null })
    expect(next.deliveries.at(-1)).toMatchObject({
      state: 'completed', receipt: { text: 'I can respond to the next instruction.' },
    })
    expect(h.adapter.requests).toHaveLength(4)
  })

  it('rejects a waiting ancestor as reviewer before freezing the plan, allowing an available reviewer instead', async () => {
    let managerId = '', workerId = '', reviewerId = ''
    const h = await fixture([
      () => toolCallResponse('delegate', 'request_group_member', { bot_id: workerId, message: 'Prepare reviewed work.' }),
      () => toolCallResponse('cyclic-plan', 'plan_group_work', { own_task: 'Review work', assignments: [],
        review: { reason: 'explicit-review', reviewer_bot_id: managerId } }),
      request => {
        expect(JSON.stringify(request.messages)).toContain('reviewer is working or waiting')
        return toolCallResponse('available-plan', 'plan_group_work', { own_task: 'Review work', assignments: [],
          review: { reason: 'explicit-review', reviewer_bot_id: reviewerId } })
      },
      () => toolCallResponse('review', 'request_group_member', { bot_id: reviewerId, message: 'Check draft.', review_candidate: { text: 'Verified text.' } }),
      toolCallResponse('approve', 'submit_group_review', { verdict: 'approved', findings: 'Checked draft.' }),
      textResponse('Approved.'), textResponse('Verified text.'), textResponse('The member returned reviewed work.'),
    ])
    managerId = h.manager.id; workerId = h.worker.id; reviewerId = h.reviewer.id
    await h.send()
    const state = await h.ctx.katcatsChats.snapshot()
    expect(state.deliveries.map(d => d.state)).toEqual(['completed', 'completed', 'completed'])
    expect(h.adapter.requests).toHaveLength(8)
  })

  it('keeps uncertain effects paused instead of retrying or treating a blocker report as completion', async () => {
    let workerId = ''
    const h = await fixture([
      () => toolCallResponse('delegate', 'request_group_member', { bot_id: workerId, message: 'Perform operation.' }),
      toolCallResponse('uncertain', 'report_group_blocker', { reason: 'Connection lost after submission.', next_step: 'Inspect the remote result before any retry.', effects: 'unknown' }),
    ])
    workerId = h.worker.id
    await h.send()
    const state = await h.ctx.katcatsChats.snapshot()
    expect(state.chats[0]?.status).toBe('paused')
    expect(state.deliveries.every(d => d.receipt === null)).toBe(true)
    expect(state.deliveries[1]?.state).toBe('unknown')
    expect(h.adapter.requests).toHaveLength(2)
  })

  it('restores a saved blocker after an interrupted journal acknowledgement without claiming completion', async () => {
    const h = await fixture([toolCallResponse('block', 'report_group_blocker', {
      reason: 'Missing prerequisite', next_step: 'Supply prerequisite', effects: 'partial',
    }, 'Work remains incomplete; saved drafts are retained.')])
    await h.send()
    const before = await h.ctx.katcatsChats.snapshot()
    const parent = before.deliveries[0]!
    await h.close()
    const path = join(h.root, 'storage', `${chatsDomainSpec.name}.json`)
    const saved = z.object({ unit: z.unknown(), global: chatsStateSchema, tables: z.unknown() })
      .parse(JSON.parse(await readFile(path, 'utf8')))
    await writeFile(path, JSON.stringify({ ...saved, global: { ...saved.global,
      deliveries: saved.global.deliveries.map(d => d.id === parent.id ? { ...d, state: 'running', error: null } : d),
    } }))
    const cold = await memoryFixture([], h.root)
    const restored = await cold.ctx.katcatsChats.snapshot()
    expect(restored.deliveries[0]).toMatchObject({ state: 'failed', receipt: null, error: parent.error })
    expect(cold.adapter.requests).toHaveLength(0)
    expect({ state: restored.deliveries[0]?.state, receipt: restored.deliveries[0]?.receipt,
      code: restored.deliveries[0]?.error?.code, modelCalls: cold.adapter.requests.length }).toMatchInlineSnapshot(`
      {
        "code": "KATCATS_CHAT_TASK_BLOCKED",
        "modelCalls": 0,
        "receipt": null,
        "state": "failed",
      }
    `)
  })
})
