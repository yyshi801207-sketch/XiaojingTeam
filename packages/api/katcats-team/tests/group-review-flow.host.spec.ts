/** Real group delegation, file review, and completion gates with scripted external model responses. */
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
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
import type { ChatDeliveryId } from '../src/chats-types.ts'
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

function taskRecord(call: string, submit = false, artifacts: string[] = []) {
  return toolCallResponse(call, 'record_group_task', { goal: 'Deliver the verified conclusion.',
    acceptance: ['The exact conclusion is independently reviewed and final files are presented.'],
    stage: submit ? 'delivered' : 'preparing', next_step: submit ? 'Finished.' : 'Prepare and review the conclusion.',
    artifacts, ...(submit ? { submit_delivery: true } : {}) })
}

async function loseDeliveryAcknowledgement(root: string, deliveryId: ChatDeliveryId): Promise<void> {
  const path = join(root, 'storage', `${chatsDomainSpec.name}.json`)
  const journal = z.object({ unit: z.unknown(), global: chatsStateSchema, tables: z.unknown() })
    .parse(JSON.parse(await readFile(path, 'utf8')))
  await writeFile(path, JSON.stringify({ ...journal, global: { ...journal.global,
    chats: journal.global.chats.map(chat => ({ ...chat, ...(chat.tickets === undefined ? {} : {
      tickets: chat.tickets.map(task => {
        if (task.delivery?.deliveryId !== deliveryId) return task
        const { delivery: _delivery, completedAt: _completedAt, completionKind: _completionKind, ...record } = task
        return { ...record, state: 'open', pendingDeliveryId: deliveryId }
      }),
    }) })),
    deliveries: journal.global.deliveries.map(delivery => delivery.id === deliveryId
      ? { ...delivery, state: 'running', receipt: null, relayed: false } : delivery),
  } }))
}

describe('independent group review workflow', () => {
  it('does not count a review reply as the same member’s separately assigned business task, including replay', async () => {
    let reviewerId = ''
    const h = await fixture([
      () => toolCallResponse('plan-distinct', 'plan_group_work', { own_task: 'Prepare the conclusion.',
        assignments: [{ bot_id: reviewerId, message: 'First collect the underlying records.' }],
        review: { reason: 'financial-conclusion', reviewer_bot_id: reviewerId } }),
      () => toolCallResponse('review-only', 'request_group_member', { bot_id: reviewerId, message: 'Review this draft.',
        review_candidate: { text: 'Draft conclusion.' } }),
      toolCallResponse('approve-only', 'submit_group_review', { verdict: 'approved', findings: 'Draft checked.' }),
      textResponse('Review passed.'),
      textResponse('Everything is delivered.'),
      textResponse('Everything is delivered.'),
    ])
    reviewerId = h.reviewer.id
    await h.send()
    const state = await h.ctx.katcatsChats.snapshot()
    const parent = state.deliveries[0]!
    expect(parent.state).toBe('failed')
    const history = await h.ctx.sessionController.inspect(parent.executorSessionId)
    const restored = restoreGroupWorkGate(true, [h.reviewer.id], parent.id, parent.inputMessageId, history.events, state.deliveries)
    expect(restored.completionDenial()).toContain('every assigned member result')
    expect({ parent: parent.state, review: state.deliveries[1]?.state, verdict: restored.reviewReceipt?.verdict })
      .toMatchInlineSnapshot(`
        {
          "parent": "failed",
          "review": "completed",
          "verdict": "approved",
        }
      `)
  })

  it('creates a draft before review and delivers only after the reviewer reads it and approves its exact version', async () => {
    let reviewerId = ''
    const h = await fixture([
      taskRecord('record-plan-financial-work'),
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
      taskRecord('submit-financial-work', true, ['conclusion.md']),
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
        "modelCalls": 11,
        "parentToolResults": [
          {
            "call": "record-plan-financial-work",
            "failed": false,
          },
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
          {
            "call": "submit-financial-work",
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

  it('publishes the exact approved text and presented file when the model rewrites its final answer', async () => {
    let reviewerId = ''
    const approved = 'Verified total: 30.\n\nChecked inputs: 10 and 20.'
    const paraphrase = 'The reviewed total is now 300.'
    const h = await fixture([
      taskRecord('record-plan-canonical'),
      () => toolCallResponse('plan-canonical', 'plan_group_work', { own_task: 'Prepare the verified conclusion.', assignments: [],
        review: { reason: 'financial-conclusion', reviewer_bot_id: reviewerId } }),
      toolCallResponse('write-canonical', 'write', { file_path: 'canonical.md', content: approved }),
      () => toolCallResponse('review-canonical', 'request_group_member', { bot_id: reviewerId,
        message: 'Check the exact text and saved file.', review_candidate: { text: approved, files: ['canonical.md'] } }),
      toolCallResponse('read-canonical', 'read', { file_path: 'canonical.md' }),
      toolCallResponse('approve-canonical', 'submit_group_review', { verdict: 'approved', findings: 'Confirmed the total is 30.' }),
      textResponse('The draft and file are verified.'),
      toolCallResponse('present-canonical', 'present', { files: [{ path: 'canonical.md' }] }),
      taskRecord('submit-canonical', true, ['canonical.md']),
      textResponse(paraphrase),
      textResponse('The reviewed total is now 3,000.'),
    ])
    reviewerId = h.reviewer.id
    await h.send()
    const state = await h.ctx.katcatsChats.snapshot()
    expect(state.chats[0]).toMatchObject({ status: 'active', run: null, error: null })
    expect(state.deliveries.map(delivery => delivery.state)).toEqual(['completed', 'completed'])
    const parent = state.deliveries[0]!
    expect(parent).toMatchObject({ relayed: true, receipt: { text: approved } })
    const history = await h.ctx.sessionController.inspect(parent.executorSessionId)
    expect(history.events.flatMap(event => event.type === 'deliverables/presented'
      ? [{ callId: event.data.callId, files: event.data.files.map(file => basename(file.path)) }] : []))
      .toEqual([{ callId: 'present-canonical', files: ['canonical.md'] }])
    expect(await readFile(join(h.chat.workDir, 'canonical.md'), 'utf8')).toBe(approved)
    expect(history.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'katcats-group-review-notice')).toEqual([])
    const root = await h.ctx.sessionController.inspect(h.chat.rootSessionId)
    expect(root.events.find(event => event.type === 'user/message' && event.data.id === parent.relayMessageId))
      .toMatchObject({ data: { content: [{ type: 'text', text: approved }] } })
    expect(JSON.stringify(root.events)).not.toContain(paraphrase)
    expect(h.adapter.requests).toHaveLength(10)

    await h.close()
    await loseDeliveryAcknowledgement(h.root, parent.id)
    const cold = await memoryFixture([], h.root)
    const restored = await cold.ctx.katcatsChats.snapshot()
    expect(restored.deliveries[0]).toMatchObject({ state: 'completed', relayed: true, receipt: parent.receipt })
    const restoredRoot = await cold.ctx.sessionController.inspect(h.chat.rootSessionId)
    expect(restoredRoot.events.filter(event => event.type === 'user/message' && event.data.id === parent.relayMessageId))
      .toEqual(root.events.filter(event => event.type === 'user/message' && event.data.id === parent.relayMessageId))
    expect(cold.adapter.requests).toEqual([])
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
      taskRecord('record-plan-revision'),
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
      taskRecord('submit-revision', true),
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
    expect(gate.completionDenial()).toBeUndefined()
    expect(gate.reviewCandidate?.text).toBe('10 + 20 = 30.')
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
      taskRecord('record-plan-before-restart'),
      () => toolCallResponse('plan-before-restart', 'plan_group_work', { own_task: 'Prepare a verified file.', assignments: [],
        review: { reason: 'explicit-review', reviewer_bot_id: reviewerId } }),
      toolCallResponse('write-before-restart', 'write', { file_path: 'restart.md', content: 'Checked total: 30.' }),
      () => toolCallResponse('review-before-restart', 'request_group_member', { bot_id: reviewerId,
        message: 'Verify the saved total.', review_candidate: { files: ['restart.md'] } }),
      toolCallResponse('approve-before-restart', 'submit_group_review', { verdict: 'approved', findings: 'The total is 30.' }),
      textResponse('The file is verified.'),
      toolCallResponse('present-before-restart', 'present', { files: [{ path: 'restart.md' }] }),
      taskRecord('submit-before-restart', true, ['restart.md']),
      textResponse('The reviewed file is ready.'),
    ])
    reviewerId = h.reviewer.id
    await h.send()
    const before = await h.ctx.katcatsChats.snapshot()
    const parent = before.deliveries[0]!
    expect(parent).toMatchObject({ state: 'completed', receipt: { text: '' } })
    const other = (await h.ctx.katcatsChats.createChat({ name: 'Independent group', memberIds: [h.author.id] })).chat
    await h.close()
    await loseDeliveryAcknowledgement(h.root, parent.id)
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

  it('corrects once and closes the task when an approved file was never presented', async () => {
    let reviewerId = ''
    const h = await fixture([
      () => toolCallResponse('plan-missing-present', 'plan_group_work', { own_task: 'Prepare a reviewed file.', assignments: [],
        review: { reason: 'explicit-review', reviewer_bot_id: reviewerId } }),
      toolCallResponse('write-missing-present', 'write', { file_path: 'not-presented.md', content: 'Reviewed bytes.' }),
      () => toolCallResponse('request-missing-present', 'request_group_member', { bot_id: reviewerId,
        message: 'Check the file.', review_candidate: { files: ['not-presented.md'] } }),
      toolCallResponse('approve-missing-present', 'submit_group_review', { verdict: 'approved', findings: 'Verified the saved bytes.' }),
      textResponse('The file is verified.'),
      textResponse('The file has been delivered.'),
      request => {
        expect(JSON.stringify(request.messages)).toContain('Use present to register all approved files')
        return textResponse('The file is already delivered.')
      },
    ])
    reviewerId = h.reviewer.id
    await h.send()
    const state = await h.ctx.katcatsChats.snapshot()
    expect(state.chats[0]).toMatchObject({ status: 'active', run: null, error: null })
    const parent = state.deliveries[0]!
    expect(parent).toMatchObject({ state: 'failed', receipt: null, error: { code: 'KATCATS_CHAT_REVIEW_INCOMPLETE' } })
    const history = await h.ctx.sessionController.inspect(parent.executorSessionId)
    expect(history.events.filter(event => event.type === 'deliverables/presented')).toEqual([])
    expect(history.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'katcats-group-review-notice')).toHaveLength(1)
    expect(h.adapter.requests).toHaveLength(7)
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
