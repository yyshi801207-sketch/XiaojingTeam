/** Real group delegation, file review, and completion gates with scripted external model responses. */
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import * as FileTools from '@deepseek-ai/dsh-tool-fs'
import * as Present from '@deepseek-ai/dsh-tool-present'
import ApprovalService, { type ApprovalAnswer } from '@deepseek-ai/dsh-user-approval'
import { FsError } from '@deepseek-ai/dsh-fs'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import { restoreGroupWorkGate } from '../src/group-work-replay.ts'
import { chatsDomainSpec, chatsStateSchema } from '../src/chats-storage.ts'
import { memoryFixture } from './memory-fixture.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

async function fixture(script: Parameters<typeof memoryFixture>[0]) {
  const h = await memoryFixture(script)
  Object.assign(h.ctx.loader.builtins, { 'review-directory': WorkingDirectory, 'review-files': FileTools, 'review-present': Present })
  await h.ctx.loader.create({ name: 'cordis:review-directory', config: { defaultDirectory: h.root } })
  await h.ctx.loader.create({ name: 'cordis:review-files', config: { read: true, readImage: false, write: true, edit: false } })
  await h.ctx.loader.create({ name: 'cordis:review-present', config: { maxFiles: 8 } })
  await h.ctx.loader.await()
  const author = (await h.ctx.katcatsTeam.createBot({ name: 'Author' })).bot
  const reviewer = (await h.ctx.katcatsTeam.createBot({ name: 'Reviewer' })).bot
  const unused = (await h.ctx.katcatsTeam.createBot({ name: 'Unneeded' })).bot
  const chat = (await h.ctx.katcatsChats.createChat({ name: 'Reviewed deliverables',
    memberIds: [author.id, reviewer.id, unused.id], managerId: author.id })).chat
  const send = async () => {
    await h.ctx.katcatsChats.sendMessage({ sessionId: chat.rootSessionId, mode: 'queue',
      requestId: brandString<SessionRequestId>('reviewed-delivery-request'),
      content: [{ type: 'text', text: 'Prepare the financial conclusion and independently review the exact file before delivery.' }],
    }, new AbortController().signal)
    const controller = new AbortController()
    try {
      for await (const frame of h.ctx.katcatsChats.follow(controller.signal)) {
        if (frame.value.activities.find(activity => activity.chatId === chat.id)?.processing === false) return
      }
      throw new Error('The review group closed before settling')
    } finally { controller.abort() }
  }
  return { ...h, author, reviewer, unused, chat, send }
}

describe('independent group review workflow', () => {
  it('creates a draft before review and delivers only after the reviewer reads it and approves its exact version', async () => {
    let reviewerId = ''
    const h = await fixture([
      () => toolCallResponse('plan-financial-work', 'plan_group_work', { own_task: 'Draft the conclusion.', assignments: [],
        review: { reason: 'financial-conclusion', reviewer_bot_id: reviewerId } }),
      toolCallResponse('write-draft', 'write', { file_path: 'conclusion.md', content: 'Rows 10 + 20 = total 30.' }),
      toolCallResponse('premature-present', 'present', { files: [{ path: 'conclusion.md' }] }),
      () => toolCallResponse('request-exact-review', 'request_group_member', { bot_id: reviewerId,
        message: 'Read the actual file and check the sum.', review_candidate: { files: ['conclusion.md'] } }),
      toolCallResponse('review-read-file', 'read', { file_path: 'conclusion.md' }),
      request => {
        expect(JSON.stringify(request.messages)).toContain('Rows 10 + 20 = total 30.')
        return toolCallResponse('approve-exact-review', 'submit_group_review',
          { verdict: 'approved', findings: 'Read the actual file and checked 10 + 20 = 30.' })
      },
      textResponse('Reviewed the saved conclusion; the sum is supported.'),
      toolCallResponse('approved-present', 'present', { files: [{ path: 'conclusion.md' }] }),
      textResponse('The independently reviewed conclusion is delivered.'),
    ])
    reviewerId = h.reviewer.id
    await h.send()
    const state = await h.ctx.katcatsChats.snapshot()
    expect(state.deliveries.map(delivery => [delivery.botId, delivery.state])).toEqual([
      [h.author.id, 'completed'], [h.reviewer.id, 'completed'],
    ])
    const parent = state.deliveries[0]!
    const history = await h.ctx.sessionController.inspect(parent.executorSessionId)
    const presentations = history.events.flatMap(event => event.type === 'deliverables/presented' ? [event.data.callId] : [])
    expect(presentations).toEqual(['approved-present'])
    expect(await readFile(join(h.chat.workDir, 'conclusion.md'), 'utf8')).toBe('Rows 10 + 20 = total 30.')
    const restored = restoreGroupWorkGate(true, [h.reviewer.id, h.unused.id], parent.id, parent.inputMessageId,
      history.events, state.deliveries)
    expect(restored.completionDenial()).toBeUndefined()
    expect(restored.reviewReceipt).toMatchObject({ parentDeliveryId: parent.id,
      deliveryId: state.deliveries[1]!.id, reviewerId: h.reviewer.id, verdict: 'approved' })
    expect(() => restoreGroupWorkGate(true, [h.reviewer.id], parent.id, parent.inputMessageId,
      history.events, [parent])).toThrow(/receipt/)
    const withoutSavedResult = history.events.filter(event => event.type !== 'tool/result'
      || event.data.message.source.callId !== 'request-exact-review')
    expect(restoreGroupWorkGate(true, [h.reviewer.id], parent.id, parent.inputMessageId,
      withoutSavedResult, state.deliveries).completionDenial()).toContain('actual approved review')
    const unknownChild = state.deliveries.map(delivery => delivery.id === parent.id ? delivery
      : { ...delivery, state: 'unknown' as const, receipt: null })
    expect(() => restoreGroupWorkGate(true, [h.reviewer.id], parent.id, parent.inputMessageId,
      history.events, unknownChild)).toThrow(/receipt/)
    const root = await h.ctx.sessionController.inspect(h.chat.rootSessionId)
    expect(root.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'katcats-group-relay')).toHaveLength(2)
    expect({
      parentToolResults: history.events.flatMap(event => event.type === 'tool/result'
        ? [{ call: event.data.message.source.callId, failed: event.data.message.isError === true }] : []),
      presentations,
      states: state.deliveries.map(delivery => delivery.state),
      modelCalls: h.adapter.requests.length,
    }).toMatchInlineSnapshot(`
      {
        "modelCalls": 9,
        "parentToolResults": [
          {
            "call": "plan-financial-work",
            "failed": false,
          },
          {
            "call": "write-draft",
            "failed": false,
          },
          {
            "call": "premature-present",
            "failed": true,
          },
          {
            "call": "request-exact-review",
            "failed": false,
          },
          {
            "call": "approved-present",
            "failed": false,
          },
        ],
        "presentations": [
          "approved-present",
        ],
        "states": [
          "completed",
          "completed",
        ],
      }
    `)
  })

  it('withholds a claimed final answer when review never happened and corrects the model only once', async () => {
    let reviewerId = ''
    const h = await fixture([
      () => toolCallResponse('plan-needs-review', 'plan_group_work', { own_task: 'Prepare an important conclusion.', assignments: [],
        review: { reason: 'explicit-review', reviewer_bot_id: reviewerId } }),
      textResponse('The final conclusion is approved.'),
      request => {
        expect(JSON.stringify(request.messages)).toContain('actual approved review')
        return textResponse('The final conclusion is approved.')
      },
    ])
    reviewerId = h.reviewer.id
    await h.send()
    const state = await h.ctx.katcatsChats.snapshot()
    expect(state.deliveries).toHaveLength(1)
    expect(state.deliveries[0]).toMatchObject({ state: 'failed', receipt: null, error: { code: 'KATCATS_CHAT_REVIEW_INCOMPLETE' } })
    expect(h.adapter.requests).toHaveLength(3)
    const root = await h.ctx.sessionController.inspect(h.chat.rootSessionId)
    expect(root.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'katcats-group-relay')).toEqual([])
  })

  it('requires a revised candidate to pass after the reviewer requests changes', async () => {
    let reviewerId = ''
    const h = await fixture([
      () => toolCallResponse('plan-revision', 'plan_group_work', { own_task: 'Compute the total.', assignments: [],
        review: { reason: 'financial-conclusion', reviewer_bot_id: reviewerId } }),
      () => toolCallResponse('request-first-review', 'request_group_member', { bot_id: reviewerId,
        message: 'Check the sum.', review_candidate: { text: '10 + 20 = 20.' } }),
      toolCallResponse('reject-first-review', 'submit_group_review',
        { verdict: 'changes_requested', findings: 'The correct sum is 30, not 20.' }),
      textResponse('Change the total to 30.'),
      textResponse('10 + 20 = 20.'),
      request => {
        expect(JSON.stringify(request.messages)).toContain('Address the reviewer findings')
        return toolCallResponse('request-revised-review', 'request_group_member', { bot_id: reviewerId,
          message: 'Check the corrected sum.', review_candidate: { text: '10 + 20 = 30.' } })
      },
      toolCallResponse('approve-revised-review', 'submit_group_review',
        { verdict: 'approved', findings: 'Recomputed both inputs and confirmed 30.' }),
      textResponse('The revised total is verified.'),
      textResponse('10 + 20 = 30.'),
    ])
    reviewerId = h.reviewer.id
    await h.send()
    const state = await h.ctx.katcatsChats.snapshot()
    expect(state.deliveries.map(delivery => delivery.state)).toEqual(['completed', 'completed', 'completed'])
    const parent = state.deliveries[0]!
    expect(parent.receipt?.text).toBe('10 + 20 = 30.')
    const history = await h.ctx.sessionController.inspect(parent.executorSessionId)
    const gate = restoreGroupWorkGate(true, [h.reviewer.id], parent.id, parent.inputMessageId, history.events, state.deliveries)
    expect(gate.reviewReceipt).toMatchObject({ verdict: 'approved', deliveryId: state.deliveries[2]!.id })
    expect(gate.completionDenial('10 + 20 = 30.')).toBeUndefined()
    expect(history.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'katcats-group-review-notice')).toHaveLength(1)
  })

  it('does not accept an ordinary colleague reply or an unauthorized verdict as independent review', async () => {
    let reviewerId = ''
    const h = await fixture([
      () => toolCallResponse('plan-ordinary-response', 'plan_group_work', { own_task: 'Prepare the conclusion.', assignments: [],
        review: { reason: 'explicit-review', reviewer_bot_id: reviewerId } }),
      () => toolCallResponse('request-ordinary-response', 'request_group_member', { bot_id: reviewerId, message: 'Discuss the conclusion.' }),
      toolCallResponse('unauthorized-verdict', 'submit_group_review', { verdict: 'approved', findings: 'I agree.' }),
      textResponse('I agree with the conclusion.'),
      textResponse('The conclusion is approved.'),
      textResponse('The conclusion is approved.'),
    ])
    reviewerId = h.reviewer.id
    await h.send()
    const state = await h.ctx.katcatsChats.snapshot()
    expect(state.deliveries[0]).toMatchObject({ state: 'failed', receipt: null, error: { code: 'KATCATS_CHAT_REVIEW_INCOMPLETE' } })
    expect(state.deliveries[1]).toMatchObject({ state: 'completed', receipt: { text: 'I agree with the conclusion.' } })
    const history = await h.ctx.sessionController.inspect(state.deliveries[1]!.executorSessionId)
    expect(history.events.find(event => event.type === 'tool/result'
      && event.data.message.source.callId === 'unauthorized-verdict')).toMatchObject({ data: { message: { isError: true } } })
  })

  it('invalidates earlier approval when a later review attempt fails before accepting a child', async () => {
    let reviewerId = ''
    const h = await fixture([
      () => toolCallResponse('plan-failed-revision', 'plan_group_work', { own_task: 'Check the conclusion.', assignments: [],
        review: { reason: 'explicit-review', reviewer_bot_id: reviewerId } }),
      () => toolCallResponse('request-valid-review', 'request_group_member', { bot_id: reviewerId,
        message: 'Check the total.', review_candidate: { text: 'Verified total: 30.' } }),
      toolCallResponse('approve-original', 'submit_group_review', { verdict: 'approved', findings: 'The total is 30.' }),
      textResponse('Verified the original conclusion.'),
      () => toolCallResponse('request-missing-revision', 'request_group_member', { bot_id: reviewerId,
        message: 'Review the revision.', review_candidate: { files: ['not-created.md'] } }),
      textResponse('Verified total: 30.'),
      textResponse('Verified total: 30.'),
    ])
    reviewerId = h.reviewer.id
    await h.send()
    const state = await h.ctx.katcatsChats.snapshot()
    expect(state.deliveries).toHaveLength(2)
    expect(state.deliveries[0]).toMatchObject({ state: 'failed', receipt: null, error: { code: 'KATCATS_CHAT_REVIEW_INCOMPLETE' } })
    const parent = state.deliveries[0]!
    const history = await h.ctx.sessionController.inspect(parent.executorSessionId)
    expect(restoreGroupWorkGate(true, [h.reviewer.id], parent.id, parent.inputMessageId,
      history.events, state.deliveries).completionDenial()).toContain('actual approved review')
  })

  it.each(['unchanged', 'changed', 'missing', 'io-error'] as const)(
    'rechecks durable review evidence on restart when candidate is %s', async candidateState => {
    let reviewerId = ''
    const h = await fixture([
      () => toolCallResponse('plan-before-restart', 'plan_group_work', { own_task: 'Prepare a verified file.', assignments: [],
        review: { reason: 'explicit-review', reviewer_bot_id: reviewerId } }),
      toolCallResponse('write-before-restart', 'write', { file_path: 'restart.md', content: 'Checked total: 30.' }),
      () => toolCallResponse('review-before-restart', 'request_group_member', { bot_id: reviewerId,
        message: 'Verify the saved total.', review_candidate: { files: ['restart.md'] } }),
      toolCallResponse('approve-before-restart', 'submit_group_review', { verdict: 'approved', findings: 'The total is 30.' }),
      textResponse('The file is verified.'),
      textResponse('The reviewed file is ready.'),
    ])
    reviewerId = h.reviewer.id
    await h.send()
    const before = await h.ctx.katcatsChats.snapshot()
    const parent = before.deliveries[0]!
    expect(parent.state).toBe('completed')
    const other = (await h.ctx.katcatsChats.createChat({ name: 'Independent group', memberIds: [h.author.id] })).chat
    await h.close()
    // Reproduce a persisted executor completion whose group-journal acknowledgement was lost.
    const journalPath = join(h.root, 'storage', `${chatsDomainSpec.name}.json`)
    const journal = z.object({ unit: z.unknown(), global: chatsStateSchema, tables: z.unknown() })
      .parse(JSON.parse(await readFile(journalPath, 'utf8')))
    await writeFile(journalPath, JSON.stringify({ ...journal, global: { ...journal.global,
      deliveries: journal.global.deliveries.map(delivery => delivery.id === parent.id
        ? { ...delivery, state: 'running', receipt: null, relayed: false } : delivery),
    } }))
    if (candidateState === 'changed') await writeFile(join(h.chat.workDir, 'restart.md'), 'Unreviewed total: 300.')
    if (candidateState === 'missing') await unlink(join(h.chat.workDir, 'restart.md'))
    const fault = candidateState === 'io-error'
      ? vi.spyOn(FsLocal.prototype, 'readBytes').mockRejectedValue(new FsError('SYNTHETIC_PRIVATE_IO_DETAIL', 'FS_IO_ERROR'))
      : undefined
    try {
      const cold = await memoryFixture([], h.root)
      const restored = await cold.ctx.katcatsChats.snapshot()
      expect(restored.deliveries[0]).toMatchObject(candidateState === 'unchanged'
        ? { state: 'completed', relayed: true, receipt: parent.receipt }
        : candidateState === 'io-error'
          ? { state: 'unknown', receipt: null, relayed: false, error: { code: 'KATCATS_CHAT_REVIEW_UNCONFIRMED' } }
          : { state: 'failed', receipt: null, relayed: false, error: { code: 'KATCATS_CHAT_REVIEW_INCOMPLETE' } })
      expect(restored.chats.find(chat => chat.id === other.id)).toMatchObject({ status: 'active', run: null, error: null })
      expect(JSON.stringify(restored)).not.toContain('SYNTHETIC_PRIVATE_IO_DETAIL')
      expect(cold.adapter.requests).toEqual([])
    } finally { fault?.mockRestore() }
  })

  it('rechecks reviewed file bytes after approval waiting and blocks an unreviewed replacement', async () => {
    let reviewerId = ''
    const h = await fixture([
      () => toolCallResponse('plan-approval-race', 'plan_group_work', { own_task: 'Prepare a reviewed file.', assignments: [],
        review: { reason: 'explicit-review', reviewer_bot_id: reviewerId } }),
      toolCallResponse('write-approval-race', 'write', { file_path: 'approval.md', content: 'Reviewed bytes.' }),
      () => toolCallResponse('request-approval-race', 'request_group_member', { bot_id: reviewerId,
        message: 'Check the file.', review_candidate: { files: ['approval.md'] } }),
      toolCallResponse('approve-file-before-presentation', 'submit_group_review', { verdict: 'approved', findings: 'Verified the file.' }),
      textResponse('The saved bytes are reviewed.'),
      toolCallResponse('present-after-approval-race', 'present', { files: [{ path: 'approval.md' }] }),
      textResponse('The file is delivered.'),
      textResponse('The file is delivered.'),
    ])
    reviewerId = h.reviewer.id
    h.ctx.loader.builtins['review-approval'] = ApprovalService
    await h.ctx.loader.create({ name: 'cordis:review-approval' })
    await h.ctx.loader.await()
    const shown = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<ApprovalAnswer>()
    h.ctx.on('tools/pre-execute', async (exec, next) => {
      const previous = await next()
      return exec.name === 'present' && previous.kind === 'allow'
        ? { kind: 'ask', reason: 'Approve the reviewed file.' } : previous
    })
    h.ctx.on('approval/request', () => { shown.resolve(undefined); return answer.promise })
    const sending = h.send()
    try {
      await shown.promise
      await writeFile(join(h.chat.workDir, 'approval.md'), 'Replaced while approval was pending.')
      answer.resolve('allowed-once')
      await sending
      const state = await h.ctx.katcatsChats.snapshot()
      const history = await h.ctx.sessionController.inspect(state.deliveries[0]!.executorSessionId)
      expect(history.events.filter(event => event.type === 'deliverables/presented')).toEqual([])
      expect(state.deliveries[0]).toMatchObject({ state: 'failed', receipt: null, error: { code: 'KATCATS_CHAT_REVIEW_INCOMPLETE' } })
    } finally { answer.resolve('rejected') }
  })
})
