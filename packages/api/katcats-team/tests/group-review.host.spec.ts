/** Independent review admits drafts but holds unreviewed or changed final work. */
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { GroupWorkGate } from '../src/group-work.ts'
import { captureGroupReviewCandidate, verifyGroupReviewCandidate } from '../src/group-review.ts'
import type { GroupReviewReceipt } from '../src/group-review-types.ts'
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
  it('allows a plain conversation and individually scoped work without recruiting a colleague', () => {
    const work = gate()
    expect(work.completionDenial('Hello.')).toBeUndefined()
    expect(work.denial('write_file')).toContain('First record')
    expect(work.completionDenial('Done.')).toContain('Record a plan')
    work.decide({ ownTask: 'Save the requested line.', assignments: [], review: { reason: 'none' } })
    expect(work.denial('write_file')).toBeUndefined()
    expect(work.denial('present')).toBeUndefined()
    expect(work.completionDenial('Saved.')).toBeUndefined()
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
    expect(work.completionDenial(candidate.text!)).toBeUndefined()
    expect(work.completionDenial('A different financial conclusion.')).toContain('exact reviewed text')
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

  it('rejects self review and retains reviewed text requirements when files accompany the conclusion', async () => {
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
    expect(work.completionDenial('The verified total is 30.')).toBeUndefined()
    expect(work.completionDenial('The verified total is 30. All compliance checks have also passed.'))
      .toContain('exact reviewed text')
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
