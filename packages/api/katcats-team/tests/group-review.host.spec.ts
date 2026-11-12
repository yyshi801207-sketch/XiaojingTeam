/** Independent review admits drafts but holds unreviewed or changed final work. */
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { GroupWorkGate } from '../src/group-work.ts'
import { captureGroupReviewCandidate, groupReviewJson, verifyGroupReviewCandidate } from '../src/group-review.ts'
import type { GroupReviewReceipt, GroupReviewedOdooOperation } from '../src/group-review-types.ts'
import type { FinanceConnectorId } from '../src/finance-types.ts'
import type { ChatDeliveryId } from '../src/chats-types.ts'
import type { BotId } from '../src/types.ts'
import { memoryFixture } from './memory-fixture.ts'

const reviewer = brandString<BotId>('reviewer')
const colleague = brandString<BotId>('colleague')
const parent = brandString<ChatDeliveryId>('owner-delivery')
const child = brandString<ChatDeliveryId>('review-delivery')
const signal = () => new AbortController().signal

function gate() { return new GroupWorkGate(true, [reviewer, colleague], { policy: 'review-v1', deliveryId: parent }) }

describe('independent review completion', () => {
  it('rejects the original delegated maker as reviewer and preserves source identity in the version', async () => {
    const h = await memoryFixture()
    const work = gate()
    work.decide({ ownTask: 'Integrate delegated work.', assignments: [], review: { reason: 'explicit-review', reviewerBotId: reviewer } })
    const candidate = await captureGroupReviewCandidate(h.ctx.fs, h.root, { text: 'Delegated result.' }, signal(), 1024,
      { sources: [{ deliveryId: child, botId: reviewer }] })
    expect(() => work.beginReview(reviewer, candidate)).toThrow(/independent reviewer/)
    expect(await verifyGroupReviewCandidate(h.ctx.fs, h.root, candidate, signal(), 1024)).toBe(true)
    expect(await verifyGroupReviewCandidate(h.ctx.fs, h.root,
      { ...candidate, sources: [{ deliveryId: child, botId: colleague }] }, signal(), 1024)).toBe(false)
  })

  it('requires the exact reviewed write and never clears an unknown outcome after a later review', async () => {
    const h = await memoryFixture()
    const work = gate()
    work.decide({ ownTask: 'Create the verified draft voucher.', assignments: [], review: { reason: 'data-change', reviewerBotId: reviewer } })
    const operation: GroupReviewedOdooOperation = { connectorId: brandString<FinanceConnectorId>('connection'), companyId: 7,
      baseUrl: 'https://odoo.example.test', database: 'test', model: 'account.move', method: 'create',
      parametersJson: groupReviewJson({ vals_list: [{ ref: 'draft' }], context: { allowed_company_ids: [7] } }) }
    expect(work.operationDenial(operation)).toContain('actual approved review')
    expect(work.denial('write_file')).toBeUndefined()
    const candidate = await captureGroupReviewCandidate(h.ctx.fs, h.root, {}, signal(), 2048, { odooOperation: operation })
    work.beginReview(reviewer, candidate)
    work.receiveReview({ parentDeliveryId: parent, deliveryId: child, reviewerId: reviewer,
      candidateVersion: candidate.version, verdict: 'approved', findings: 'Destination and voucher lines verified.' })
    expect(work.operationDenial(operation)).toBeUndefined()
    for (const changed of [{ ...operation, companyId: 8 }, { ...operation, method: 'action_post' },
      { ...operation, parametersJson: '{}' }, { ...operation, database: 'other' }]) {
      expect(work.operationDenial(changed)).toContain('differs from the approved candidate')
    }
    expect(groupReviewJson({ z: [2, 1], a: { b: 1, a: 2 } })).toBe(groupReviewJson({ a: { a: 2, b: 1 }, z: [2, 1] }))
    expect(await verifyGroupReviewCandidate(h.ctx.fs, h.root, candidate, signal(), 2048)).toBe(true)
    work.markUnknownOperation()
    expect(work.completionDenial()).toContain('unknown outcome')
    expect(work.operationDenial(operation)).toContain('unknown outcome')
  })

  it('allows a plain conversation and individually scoped work without recruiting a colleague', () => {
    const work = gate()
    expect(work.completionDenial()).toBeUndefined()
    expect(work.denial('write_file')).toContain('First record')
    expect(work.completionDenial()).toContain('Record a plan')
    work.decide({ ownTask: 'Save the requested line.', assignments: [], review: { reason: 'none' } })
    expect(work.denial('write_file')).toBeUndefined()
    expect(work.denial('present')).toBeUndefined()
    expect(work.completionDenial()).toBeUndefined()
  })

  it('allows draft preparation before contributions and review but refuses premature presentation', async () => {
    const h = await memoryFixture()
    const work = gate()
    work.decide({ ownTask: 'Draft a financial conclusion.', assignments: [{ botId: colleague, message: 'Check sources.' }],
      review: { reason: 'financial-conclusion', reviewerBotId: reviewer } })
    expect(work.denial('write_file')).toBeUndefined()
    expect(work.denial('read_file')).toBeUndefined()
    expect(work.denial('present')).toContain('every assigned')
    work.receive(colleague)
    work.receive(reviewer)
    expect(work.completionDenial()).toContain('actual approved review')
    const candidate = await captureGroupReviewCandidate(h.ctx.fs, h.root, { text: 'Confirmed result with evidence.' }, signal(), 1024)
    work.beginReview(reviewer, candidate)
    const receipt: GroupReviewReceipt = { parentDeliveryId: parent, deliveryId: child, reviewerId: reviewer,
      candidateVersion: candidate.version, verdict: 'approved', findings: 'Checked the evidence and arithmetic.' }
    for (const invalid of [{ ...receipt, parentDeliveryId: child }, { ...receipt, reviewerId: colleague },
      { ...receipt, deliveryId: parent }]) {
      expect(() => work.receiveReview(invalid)).toThrow()
      expect(work.denial('present')).toBeDefined()
    }
    work.receiveReview(receipt)
    expect(work.completionDenial()).toBeUndefined()
    expect(work.reviewCandidate).toEqual(candidate)
    work.invalidateReview()
    expect(work.completionDenial()).toContain('actual approved review')
  })

  it('holds rejected work and missing reviewers without inventing an approval', async () => {
    const h = await memoryFixture()
    const missing = gate()
    missing.decide({ ownTask: 'Prepare a report.', assignments: [], review: { reason: 'explicit-review' } })
    expect(missing.denial('write_file')).toBeUndefined()
    expect(missing.completionDenial()).toContain('no reviewer')
    const work = gate()
    work.decide({ ownTask: 'Prepare a report.', assignments: [], review: { reason: 'explicit-review', reviewerBotId: reviewer } })
    const first = await captureGroupReviewCandidate(h.ctx.fs, h.root, { text: 'Incorrect total.' }, signal(), 1024)
    work.beginReview(reviewer, first)
    work.receiveReview({ parentDeliveryId: parent, deliveryId: child, reviewerId: reviewer,
      candidateVersion: first.version, verdict: 'changes_requested', findings: 'The total excludes one row.' })
    expect(work.completionDenial()).toContain('Address the reviewer findings')
    const second = await captureGroupReviewCandidate(h.ctx.fs, h.root, { text: 'Corrected total.' }, signal(), 1024)
    work.beginReview(reviewer, second)
    expect(() => work.receiveReview({ parentDeliveryId: parent, deliveryId: child, reviewerId: reviewer,
      candidateVersion: first.version, verdict: 'approved', findings: 'Old review.' })).toThrow()
    expect(work.completionDenial()).toContain('actual approved review')
  })

  it('rejects self review and retains the approved text and file as one candidate', async () => {
    const h = await memoryFixture()
    const work = gate()
    expect(() => work.decide({ ownTask: 'Review my own work.', assignments: [],
      review: { reason: 'financial-conclusion', reviewerBotId: brandString<BotId>('author') } })).toThrow()
    work.decide({ ownTask: 'Draft a conclusion with its evidence.', assignments: [],
      review: { reason: 'financial-conclusion', reviewerBotId: reviewer } })
    await writeFile(join(h.root, 'evidence.csv'), 'a,b,total\n10,20,30\n')
    const candidate = await captureGroupReviewCandidate(h.ctx.fs, h.root,
      { text: 'The verified total is 30.', files: ['evidence.csv'] }, signal(), 1024)
    work.beginReview(reviewer, candidate)
    work.receiveReview({ parentDeliveryId: parent, deliveryId: child, reviewerId: reviewer,
      candidateVersion: candidate.version, verdict: 'approved', findings: 'The rows support the conclusion.' })
    expect(work.completionDenial()).toBeUndefined()
    expect(work.reviewCandidate).toEqual(candidate)
  })

  it('retains the accepted legacy task admission behavior', () => {
    const legacy = new GroupWorkGate(true, [reviewer])
    expect(() => legacy.decide({ ownTask: 'Draft.', assignments: [] })).toThrow()
    legacy.decide({ ownTask: 'Integrate.', assignments: [{ botId: reviewer, message: 'Check sources.' }] })
    expect(legacy.denial('write_file')).toContain('every member')
    legacy.receive(reviewer)
    expect(legacy.denial('write_file')).toBeUndefined()
  })
})

describe('exact review file candidates', () => {
  it('hashes actual binary files and invalidates approval when bytes change', async () => {
    const h = await memoryFixture()
    await writeFile(join(h.root, 'report.xlsx'), Buffer.from([0, 1, 2, 255]))
    const candidate = await captureGroupReviewCandidate(h.ctx.fs, h.root, { files: ['report.xlsx'] }, signal(), 1024)
    expect(candidate.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(await verifyGroupReviewCandidate(h.ctx.fs, h.root, candidate, signal(), 1024)).toBe(true)
    await writeFile(join(h.root, 'report.xlsx'), Buffer.from([0, 1, 3, 255]))
    expect(await verifyGroupReviewCandidate(h.ctx.fs, h.root, candidate, signal(), 1024)).toBe(false)
  })

  it('rejects traversal, directory links, duplicate aliases, incomplete candidates, and over-budget reads', async () => {
    const h = await memoryFixture()
    const cwd = join(h.root, 'group')
    await mkdir(cwd)
    await writeFile(join(h.root, 'private.txt'), 'Private outside group')
    await writeFile(join(cwd, 'draft.txt'), '123456')
    await symlink(h.root, join(cwd, 'outside'), 'junction')
    for (const files of [['../private.txt'], ['outside/private.txt'], ['draft.txt', './draft.txt'], ['.'], ['missing.txt']]) {
      await expect(captureGroupReviewCandidate(h.ctx.fs, cwd, { files }, signal(), 1024))
        .rejects.toMatchObject({ code: 'KATCATS_CHAT_INVALID_REVIEW' })
    }
    await expect(captureGroupReviewCandidate(h.ctx.fs, cwd, {}, signal(), 1024))
      .rejects.toMatchObject({ code: 'KATCATS_CHAT_INVALID_REVIEW' })
    await expect(captureGroupReviewCandidate(h.ctx.fs, cwd, { text: '123', files: ['draft.txt'] }, signal(), 8)).rejects.toBeDefined()
    const aborted = new AbortController()
    aborted.abort()
    await expect(captureGroupReviewCandidate(h.ctx.fs, cwd, { files: ['draft.txt'] }, aborted.signal, 1024)).rejects.toBeDefined()
  })
})
