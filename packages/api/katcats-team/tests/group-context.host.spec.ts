/** Public history selection preserves task evidence while avoiding repeated transcript injection. */
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId, type ContentBlock, type MessageId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { CompactionId } from '@deepseek-ai/dsh-compaction'
import { buildGroupContext, queryGroupHistory } from '../src/group-context.ts'
import type { ChatDelivery, ChatInbound, ChatSender, TeamChat } from '../src/chats-types.ts'
import type { ChatRuntimeSnapshot } from '../src/chats-runtime-types.ts'
import { recordGroupTicket } from '../src/group-tickets.ts'

const botId = brandString<ChatSender['botId']>('writer')
const sender: ChatSender = { botId, name: 'Writer', role: 'Writer', avatar: { shape: 'classic', color: '#10B8A6' } }

function fixture() {
  const root = Session.create(SessionId('public-group'))
  const executor = Session.create(SessionId('writer-group'))
  const chat: TeamChat = { id: brandString<TeamChat['id']>('group'), name: 'Accounting', groupId: brandString<TeamChat['groupId']>('groups'),
    rootSessionId: root.id, workDir: 'E:/synthetic-group', memberIds: [botId], managerId: botId, memberRoles: [],
    executors: [{ botId, sessionId: executor.id }], relayLimit: 16, generation: 1, status: 'active', pauseReason: null,
    run: { id: brandString<ChatDelivery['runId']>('run'), generation: 1, relayCount: 0 }, error: null }
  const inbounds: ChatInbound[] = []
  const deliveries: ChatDelivery[] = []
  const snapshot: ChatRuntimeSnapshot = { chat, bots: [], inbounds, deliveries }
  function owner(text: string, content: ContentBlock[] = [{ type: 'text', text }]) {
    const suffix = String(inbounds.length)
    const userMessage = { ...createUserMessage({ content, source: { kind: 'user' } }), id: brandString<MessageId>('owner-' + suffix) }
    root.append('user/message', userMessage, { surfaceOp: 'append' })
    const inbound: ChatInbound = { requestId: brandString<SessionRequestId>('request-' + suffix), requestDigest: suffix,
      chatId: chat.id, runId: chat.run!.id, generation: 1, userMessage, recipients: [botId], addressing: 'broadcast', state: 'published' }
    inbounds.push(inbound)
    const delivery: ChatDelivery = { id: brandString<ChatDelivery['id']>('delivery-' + suffix), chatId: chat.id, runId: chat.run!.id,
      generation: 1, sourceSessionId: root.id, source: { kind: 'owner-message', messageId: userMessage.id }, botId,
      executorSessionId: executor.id, message: text, inputMessageId: brandString<MessageId>('worker-' + suffix),
      relayMessageId: brandString<MessageId>('reply-' + suffix), state: 'accepted', receipt: null, pass: null, relayed: false, error: null }
    deliveries.push(delivery)
    return delivery
  }
  const input = (delivery: ChatDelivery) => ({ delivery, snapshot, rootEvents: root.snapshotEvents() })
  const build = (delivery: ChatDelivery, bootstrapMessageCount = 2) => buildGroupContext({ ...input(delivery),
    executorEvents: executor.snapshotEvents(), executorSurfaceSeqs: executor.surface.nodes, bootstrapMessageCount })
  const enter = (delivery: ChatDelivery, built: ReturnType<typeof build>) => executor.append('user/message', { ...createUserMessage({
    content: built.content, source: { kind: 'katcats-group-task', form: 'relay',
      chatId: chat.id, runId: delivery.runId, generation: 1, deliveryId: delivery.id, target: sender, context: built.context },
  }), id: delivery.inputMessageId }, { surfaceOp: 'append' })
  return { root, executor, snapshot, owner, input, build, enter, deliveries }
}

function text(content: readonly ContentBlock[]): string { return content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') }

describe('incremental public group context', () => {
  it('injects the bound task and shared corrections, retaining other tasks for explicit original-history lookup', () => {
    const h = fixture()
    const first = h.owner('Task A: use 300.00')
    h.owner('Shared constraint: preserve original evidence')
    const other = h.owner('Task B: unrelated website specification')
    const correction = h.owner('Task A correction: use 317.00')
    h.owner('Not yet visible: later queued instructions')
    const request = { goal: 'Check figures', acceptance: ['Check originals'], stage: 'checking', nextStep: 'Read originals', artifacts: [] }
    const a = recordGroupTicket(h.snapshot.chat, h.snapshot.inbounds[0]!, first, request)
    const b = recordGroupTicket(a.chat, h.snapshot.inbounds[2]!, other, { ...request, goal: 'Build website' })
    const continued = recordGroupTicket(b.chat, h.snapshot.inbounds[3]!, correction, { ...request, id: a.ticket.id })
    const snapshot = { ...h.snapshot, chat: continued.chat }
    const built = buildGroupContext({ ...h.input(correction), snapshot, executorEvents: [], executorSurfaceSeqs: [], bootstrapMessageCount: 20 })
    expect(text(built.content)).toContain('Task A: use 300.00')
    expect(text(built.content)).toContain('Task A correction: use 317.00')
    expect(text(built.content)).toContain('Shared constraint: preserve original evidence')
    expect(text(built.content)).not.toContain('unrelated website specification')
    expect(text(built.content)).not.toContain('later queued instructions')
    expect(built.context.archivedIds).not.toContain('message:owner-2')
    const lookup = queryGroupHistory({ ...h.input(correction), snapshot, query: { keyword: 'website', limit: 20 }, maxResults: 20, maxChars: 16000 })
    expect(text(lookup.content)).toContain('Task B: unrelated website specification')
    expect(built.context.deliveredIds).toMatchInlineSnapshot(`
      [
        "message:owner-0",
        "message:owner-1",
        "message:owner-3",
      ]
    `)
  })

  it('bootstraps recent history, archives older originals, then delivers only new history and the current task', () => {
    const h = fixture()
    h.owner('old requirement')
    h.owner('recent requirement')
    const current = h.owner('current instruction')
    const first = h.build(current)
    expect(first.context).toEqual({ schemaVersion: 1, rootSessionId: h.root.id,
      deliveredIds: ['message:owner-1', 'message:owner-2'], archivedIds: ['message:owner-0'] })
    expect(text(first.content)).not.toContain('old requirement')
    expect(text(first.content).match(/current instruction/g)).toHaveLength(1)
    h.enter(current, first)
    const next = h.owner('new instruction')
    const delta = h.build(next)
    expect(delta.context.deliveredIds).toEqual(['message:owner-3'])
    expect(delta.context.archivedIds).toEqual([])
    expect(text(delta.content)).not.toContain('recent requirement')
    expect(text(delta.content)).not.toContain('current instruction')
  })

  it('does not advance coverage before a prepared input enters the executor and restores coverage after cold replay', () => {
    const h = fixture()
    h.owner('first')
    const current = h.owner('second')
    const prepared = h.build(current)
    expect(h.build(current).context).toEqual(prepared.context)
    h.enter(current, prepared)
    const restored = Session.create(h.executor.id, structuredClone(h.executor.snapshotEvents()))
    const next = h.owner('third')
    const delta = buildGroupContext({ ...h.input(next), executorEvents: restored.snapshotEvents(),
      executorSurfaceSeqs: restored.surface.nodes, bootstrapMessageCount: 2 })
    expect(delta.context.deliveredIds).toEqual(['message:owner-2'])
  })

  it('keeps coverage through retained nested summaries but invalidates it after an unrelated replacement', () => {
    const h = fixture()
    h.owner('original earlier value')
    const current = h.owner('original latest value')
    const entered = h.enter(current, h.build(current))
    const compact = (seq: typeof entered.seq, id: string) => h.executor.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Summary keeps the important values.' }],
      source: { kind: 'compact-checkpoint', compactionId: brandString<CompactionId>(id) },
    }), { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
    const summary = compact(entered.seq, 'compact-first')
    const secondSummary = compact(summary.seq, 'compact-second')
    const next = h.owner('new after summary')
    expect(h.build(next).context.deliveredIds).toEqual(['message:owner-2'])
    h.executor.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Pruned conversation.' }], source: { kind: 'user' } }),
      { surfaceOp: { op: 'replace', startSeq: secondSummary.seq, endSeq: secondSummary.seq }, sourceEventSeqs: [secondSummary.seq] })
    expect(h.build(next).context.deliveredIds).toEqual(['message:owner-1', 'message:owner-2'])
  })

  it('does not mark future queued owner messages covered even when their events precede later visible history', () => {
    const h = fixture()
    const active = h.owner('active requirement')
    const queued = h.owner('future requirement')
    const first = h.build(active)
    expect(text(first.content)).not.toContain('future requirement')
    h.enter(active, first)
    expect(text(h.build(queued).content)).toContain('future requirement')
  })

  it('includes an unpublished confirmed receipt once, retains unknown outcomes and keeps equal messages with distinct IDs', () => {
    const h = fixture()
    const first = h.owner('same instruction')
    h.deliveries[0] = { ...first, state: 'completed', receipt: { sender, text: 'EXACT_RESULT_591', outputMessageId: brandString<MessageId>('output'), turn: 1 } }
    const second = h.owner('same instruction')
    const built = h.build(second, 20)
    expect(text(built.content).match(/EXACT_RESULT_591/g)).toHaveLength(1)
    expect(text(built.content).match(/same instruction/g)).toHaveLength(2)
    expect(built.context.deliveredIds).toContain('message:reply-0')
    h.root.append('user/message', { ...createUserMessage({ content: [{ type: 'text', text: 'EXACT_RESULT_591' }], source: {
      kind: 'katcats-group-relay', form: 'relay', schemaVersion: 1, chatId: h.snapshot.chat.id, runId: first.runId, generation: 1,
      deliveryId: first.id, sender, executionSessionId: h.executor.id, inputMessageId: first.inputMessageId,
      outputMessageId: brandString<MessageId>('output'),
    } }), id: first.relayMessageId }, { surfaceOp: 'append' })
    expect(text(h.build(second, 20).content).match(/EXACT_RESULT_591/g)).toHaveLength(1)
    h.deliveries[0] = { ...first, state: 'unknown', error: { code: 'unconfirmed', message: 'Inspect saved work.' } }
    expect(text(h.build(second).content)).toContain('"status":"unknown"')
  })

  it.each(['recorded', 'legacy'])('keeps its own reply covered with %s inputs and compaction, but restores it after unrelated replacement', (mode) => {
    const h = fixture()
    const first = h.owner('first instruction')
    if (mode === 'recorded') h.enter(first, h.build(first))
    const message = createAssistantMessage({ content: [{ type: 'text', text: 'OWN_CONFIRMED_RESULT' }],
      source: { provider: 'fixture', model: 'fixture' } })
    const reply = h.executor.append('assistant/message', { turn: 1, step: 1, message, stream: [] }, { surfaceOp: 'append' })
    h.deliveries[0] = { ...first, state: 'completed', receipt: { sender, text: 'OWN_CONFIRMED_RESULT', outputMessageId: message.id, turn: 1 } }
    const second = h.owner('second instruction')
    expect(text(h.build(second).content)).not.toContain('OWN_CONFIRMED_RESULT')
    expect(h.build(second).context.archivedIds).not.toContain('message:' + first.relayMessageId)
    const compacted = h.executor.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Summary of own result.' }],
      source: { kind: 'compact-checkpoint', compactionId: brandString<CompactionId>('own-reply-summary') },
    }), { surfaceOp: { op: 'replace', startSeq: reply.seq, endSeq: reply.seq }, sourceEventSeqs: [reply.seq] })
    expect(text(h.build(second).content)).not.toContain('OWN_CONFIRMED_RESULT')
    h.executor.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Unrelated replacement.' }], source: { kind: 'user' } }),
      { surfaceOp: { op: 'replace', startSeq: compacted.seq, endSeq: compacted.seq }, sourceEventSeqs: [compacted.seq] })
    expect(text(h.build(second).content).match(/OWN_CONFIRMED_RESULT/g)).toHaveLength(1)
  })

  it.each([false, true])('inherits actual history tool coverage only for a complete original (partial=%s)', (partial) => {
    const h = fixture()
    const first = h.owner('first instruction')
    h.enter(first, h.build(first))
    h.deliveries[0] = { ...first, state: 'completed', receipt: { sender, text: 'RETRIEVED_PUBLIC_RESULT',
      outputMessageId: brandString<MessageId>('saved-result'), turn: 1 } }
    const callId = ToolCallId('read-saved-history')
    h.executor.append('tool/call', { turn: 1, step: 1, callId, name: 'read_group_history', arguments: '{"limit":1}' })
    h.executor.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, isError: false,
      content: [{ type: 'text', text: partial ? 'RETRIEVED_' : 'RETRIEVED_PUBLIC_RESULT' }] }),
      meta: { itemIds: ['message:reply-0'], partialIds: partial ? ['message:reply-0'] : [], nextCursor: partial ? 'more' : null },
    }, { surfaceOp: 'append' })
    const next = h.owner('next instruction')
    expect(text(h.build(next).content).includes('RETRIEVED_PUBLIC_RESULT')).toBe(partial)
  })

  it('does not repeat retained own progress, even while its final outcome remains unconfirmed', () => {
    const h = fixture()
    const first = h.owner('first instruction')
    h.enter(first, h.build(first))
    const message = createAssistantMessage({ content: [{ type: 'text', text: 'OWN_SAVED_PROGRESS' }],
      source: { provider: 'fixture', model: 'fixture' } })
    h.executor.append('assistant/message', { turn: 1, step: 1, message, stream: [] }, { surfaceOp: 'append' })
    h.root.append('user/message', { ...createUserMessage({ content: message.content, source: { kind: 'katcats-group-relay', form: 'relay',
      schemaVersion: 1, chatId: h.snapshot.chat.id, runId: first.runId, generation: 1, deliveryId: first.id, sender,
      executionSessionId: h.executor.id, inputMessageId: first.inputMessageId, outputMessageId: message.id } }), id: message.id }, { surfaceOp: 'append' })
    h.deliveries[0] = { ...first, state: 'unknown', error: { code: 'unconfirmed', message: 'Inspect saved work.' } }
    const second = h.owner('second instruction')
    expect(text(h.build(second).content)).not.toContain('OWN_SAVED_PROGRESS')
    expect(text(h.build(second).content)).toContain('"status":"unknown"')
  })

  it('does not inherit unrelated group manifests or legacy unmarked inputs', () => {
    const h = fixture()
    const first = h.owner('first')
    h.executor.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Legacy context' }], source: {
      kind: 'katcats-group-task', form: 'relay', chatId: h.snapshot.chat.id, runId: first.runId, generation: 1,
      deliveryId: first.id, target: sender,
    } }), { surfaceOp: 'append' })
    const next = h.owner('next')
    expect(h.build(next).context.deliveredIds).toEqual(['message:owner-0', 'message:owner-1'])
    expect(() => h.build({ ...next, executorSessionId: SessionId('private-session') })).toThrow('does not belong')
  })
})

describe('original public group history lookup', () => {
  it('preserves current image and file identities once and excludes queued and foreign-group records from lookup', () => {
    const h = fixture()
    const image: ContentBlock = { type: 'image', attachment: { attachmentId: brandString<AttachmentId>('current-image'),
      mediaType: 'image/png', bytes: 20, width: 10, height: 10 } }
    const file: ContentBlock = { type: 'file', attachment: { attachmentId: brandString<AttachmentId>('current-file'), name: 'evidence.csv', bytes: 30 } }
    const current = h.owner('current evidence', [{ type: 'text', text: 'CURRENT_REQUIREMENT' }, image, file])
    h.owner('QUEUED_NOT_YET_VISIBLE')
    h.root.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'FOREIGN_GROUP_REPLY' }], source: {
      kind: 'katcats-group-relay', form: 'relay', schemaVersion: 1, chatId: brandString<TeamChat['id']>('other-group'), runId: current.runId,
      generation: 1, deliveryId: current.id, sender, executionSessionId: h.executor.id, inputMessageId: current.inputMessageId,
      outputMessageId: brandString<MessageId>('foreign-output'),
    } }), { surfaceOp: 'append' })
    const built = h.build(current)
    expect(text(built.content).match(/CURRENT_REQUIREMENT/g)).toHaveLength(1)
    expect(built.content.filter(block => block.type === 'image' || block.type === 'file')).toEqual([image, file])
    const page = queryGroupHistory({ ...h.input(current), query: { limit: 20 }, maxResults: 20, maxChars: 16000 })
    expect(page.entries.map(entry => entry.id)).toEqual(['message:owner-0'])
    expect(text(page.content)).not.toContain('QUEUED_NOT_YET_VISIBLE')
    expect(text(page.content)).not.toContain('FOREIGN_GROUP_REPLY')
  })

  it('rejects an undersized page instead of exceeding its configured text bound, including an empty search', () => {
    const h = fixture()
    const current = h.owner('saved public text')
    for (const keyword of ['saved', 'no match']) {
      expect(() => queryGroupHistory({ ...h.input(current), query: { keyword, limit: 1 }, maxResults: 20, maxChars: 1 }))
        .toThrow('too small for its header and cursor')
    }
  })

  it('retrieves archived originals by stable ID and keyword and refuses foreign private content', () => {
    const h = fixture()
    h.owner('old limit is 100')
    h.owner('limit corrected to 150')
    const current = h.owner('prepare report')
    const page = queryGroupHistory({ ...h.input(current), query: { keyword: 'limit', limit: 1 }, maxResults: 20, maxChars: 16000 })
    expect(page.entries.map(entry => entry.id)).toEqual(['message:owner-1'])
    expect(text(page.content)).toContain('limit corrected to 150')
    const older = queryGroupHistory({ ...h.input(current), query: { keyword: 'limit', cursor: page.nextCursor!, limit: 1 }, maxResults: 20, maxChars: 16000 })
    expect(older.entries.map(entry => entry.id)).toEqual(['message:owner-0'])
    expect(older.nextCursor).toBeNull()
    const exact = queryGroupHistory({ ...h.input(current), query: { ids: ['message:owner-0'], limit: 20 }, maxResults: 20, maxChars: 16000 })
    expect(exact.entries).toHaveLength(1)
    expect(text(exact.content)).toContain('old limit is 100')
    expect(() => queryGroupHistory({ ...h.input(current), query: { cursor: '{invalid', limit: 20 }, maxResults: 20, maxChars: 16000 })).toThrow('cursor is invalid')
    expect(() => queryGroupHistory({ ...h.input(current), query: { cursor: '{"id":"message:private","block":0,"offset":0}', limit: 20 }, maxResults: 20, maxChars: 16000 })).toThrow('outside the current query')
  })

  it('pages oversized text without losing characters and preserves original image references', () => {
    const h = fixture()
    const body = '费用核对：每一项需要保留。'.repeat(1500)
    const image: ContentBlock = { type: 'image', attachment: { attachmentId: brandString<AttachmentId>('image-original'),
      mediaType: 'image/png', bytes: 200, width: 20, height: 10 } }
    const current = h.owner('large source', [{ type: 'text', text: body }, image])
    let cursor: string | undefined
    let restored = ''
    const images: ContentBlock[] = []
    let pages = 0
    do {
      const page = queryGroupHistory({ ...h.input(current), query: { limit: 20, ...(cursor === undefined ? {} : { cursor }) },
        maxResults: 20, maxChars: 600 })
      expect(page.content.reduce((length, block) => length + (block.type === 'text' ? block.text.length : 0), 0)).toBeLessThanOrEqual(600)
      restored += page.entries.flatMap(entry => entry.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('')
      images.push(...page.entries.flatMap(entry => entry.content).filter(block => block.type === 'image'))
      if (pages === 0) expect(page.entries[0]!.partial).toBe(true)
      cursor = page.nextCursor ?? undefined
      pages++
      expect(pages).toBeLessThan(100)
    } while (cursor !== undefined)
    expect(restored).toBe(body)
    expect(images).toEqual([image])
    expect(pages).toBeGreaterThan(1)
  })
})
