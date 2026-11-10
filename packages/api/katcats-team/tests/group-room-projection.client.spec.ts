/** Read-only room replay across group isolation, retries and saved member output. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, type MessageId } from '@deepseek-ai/dsh-llm'
import type { ChatDelivery, ChatDeliveryId, ChatId, ChatRunId, ChatSender, ChatSnapshot, TeamChat } from '../src/chats-types.ts'
import type { ChatTaskEventId, ChatTaskLifecycle } from '../src/chats-task-events.ts'
import type { BotId, GroupId, TeamBot } from '../src/types.ts'
import { projectGroupRoom } from '../src/client/group-room-model.ts'

beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(1000) })
afterEach(() => { vi.restoreAllMocks() })

function fixture() {
  const root = Session.create(SessionId('group-root'))
  const sender: ChatSender = { botId: brandString<BotId>('lead'), name: 'Lead', role: 'Coordinate',
    avatar: { shape: 'classic', color: '#10B8A6' } }
  const peer: ChatSender = { ...sender, botId: brandString<BotId>('reviewer'), name: 'Reviewer' }
  const chat: TeamChat = { id: brandString<ChatId>('group'), name: 'Website', rootSessionId: root.id, groupId: brandString<GroupId>('groups'),
    workDir: '/synthetic/group', memberIds: [sender.botId, peer.botId], managerId: sender.botId, memberRoles: [],
    executors: [{ botId: sender.botId, sessionId: SessionId('lead-worker') }, { botId: peer.botId, sessionId: SessionId('review-worker') }],
    relayLimit: 16, generation: 1, status: 'active', pauseReason: null, error: null,
    run: { id: brandString<ChatRunId>('run'), generation: 1, relayCount: 0 } }
  const bots: TeamBot[] = [sender, peer].map(item => ({ id: item.botId, name: item.name, role: item.role, avatar: item.avatar,
    kind: 'ordinary', model: { kind: 'follow-global' }, workDir: '/synthetic/private', groupId: null, sessionId: SessionId('private-' + item.botId) }))
  const snapshot: ChatSnapshot = { chats: [chat], deliveries: [], revision: 1, relayLimit: 16,
    activities: [{ chatId: chat.id, processing: true, runningBotIds: [sender.botId], pendingControl: null }] }
  const base: ChatTaskLifecycle = { schemaVersion: 1, eventId: brandString<ChatTaskEventId>('event-1'), chatId: chat.id, rootSessionId: root.id,
    runId: chat.run!.id, generation: 1, deliveryId: brandString<ChatDeliveryId>('parent'), parentDeliveryId: null,
    actor: { kind: 'owner' }, target: { kind: 'member', botId: sender.botId, sender }, message: 'Build the website',
    status: 'queued', recovered: false, error: null }
  let tick = 0
  const append = (changes: Partial<ChatTaskLifecycle> = {}) => root.append('katcats/group-task-lifecycle', {
    ...base, eventId: brandString<ChatTaskEventId>(`event-${++tick}`), ...changes,
  })
  const entries = () => root.snapshotEvents().map(event => ({ type: 'event' as const, event }))
  const project = (cursor: number | null = null, overrides: Partial<Parameters<typeof projectGroupRoom>[0]> = {}) => projectGroupRoom({
    chat, bots, snapshot, entries: entries(), cursor, connected: true, waiting: new Map(), ...overrides,
  })
  const reply = (text: string) => root.append('user/message', { ...createUserMessage({ content: [{ type: 'text', text }], source: {
    kind: 'katcats-group-relay', form: 'relay', schemaVersion: 1, chatId: chat.id, runId: base.runId, generation: 1,
    deliveryId: base.deliveryId, sender, executionSessionId: SessionId('lead-worker'),
    inputMessageId: brandString<MessageId>('input'), outputMessageId: brandString<MessageId>('output'),
  } }), id: brandString<MessageId>(`reply-${++tick}`) }, { surfaceOp: 'append' })
  return { root, chat, bots, snapshot, sender, peer, base, append, entries, project, reply }
}

describe('group room projection', () => {
  it('records a real handoff and waiting parent without synthesizing extra tasks', () => {
    const h = fixture()
    h.append(); h.append({ status: 'started' })
    h.append({ deliveryId: brandString<ChatDeliveryId>('child'), parentDeliveryId: h.base.deliveryId,
      actor: h.base.target, target: { kind: 'member', botId: h.peer.botId, sender: h.peer }, message: 'Check the implementation' })
    const room = h.project()
    expect(room.tasks).toHaveLength(2)
    expect(room.members.find(item => item.id === h.sender.botId)?.phase).toBe('dependency')
    expect(room.tasks[1]?.from).toBe(h.sender.botId)
    expect(room).toMatchSnapshot()
  })

  it('excludes another group, wrong roots and duplicate lifecycle records', () => {
    const h = fixture()
    h.append({ eventId: brandString<ChatTaskEventId>('same') }); h.append({ eventId: brandString<ChatTaskEventId>('same') })
    h.append({ chatId: brandString<ChatId>('other') }); h.append({ rootSessionId: SessionId('private-lead') })
    const room = h.project()
    expect(room.transitions).toHaveLength(1)
    expect(room.tasks).toHaveLength(1)
  })

  it('replays only events at the cursor, not current completion, receipts or questions', () => {
    const h = fixture()
    h.append()
    const cursor = h.entries().at(-1)!.event.seq
    h.append({ status: 'completed' }); h.reply('Final output')
    const room = h.project(cursor, { waiting: new Map([[h.sender.botId, 'approval']]) })
    expect(room.tasks[0]?.status).toBe('queued')
    expect(room.members[0]?.phase).toBe('queued')
    expect(room.replies).toEqual([])
    expect(h.project().replies[0]?.text).toBe('Final output')
  })

  it('keeps equal text from separate message identities and does not call a pass an approval', () => {
    const h = fixture()
    h.append({ status: 'passed' }); h.reply('Same text'); h.reply('Same text')
    const room = h.project(null, { snapshot: { ...h.snapshot, activities: [] } })
    expect(room.replies).toHaveLength(2)
    expect(room.tasks[0]?.status).toBe('passed')
  })

  it('shows saved unpublished output only live, and exposes failure without claiming success', () => {
    const h = fixture()
    h.append({ status: 'unknown', recovered: true, error: { code: 'unknown', message: 'Inspect the saved output' } })
    const delivery: ChatDelivery = { id: h.base.deliveryId, chatId: h.chat.id, runId: h.base.runId, generation: 1,
      botId: h.sender.botId, sourceSessionId: h.root.id, source: { kind: 'owner-message', messageId: brandString<MessageId>('owner') },
      executorSessionId: SessionId('lead-worker'), message: h.base.message, inputMessageId: brandString<MessageId>('input'),
      relayMessageId: brandString<MessageId>('pending-relay'), state: 'unknown', pass: null, relayed: false,
      receipt: { sender: h.sender, text: 'Saved partial result', outputMessageId: brandString<MessageId>('output'), turn: 1 },
      error: { code: 'unknown', message: 'Inspect the saved output' } }
    const snapshot = { ...h.snapshot, deliveries: [delivery], activities: [] }
    expect(h.project(null, { snapshot }).replies[0]?.seq).toBe(0)
    const replay = h.project(h.entries().at(-1)!.event.seq, { snapshot })
    expect(replay.replies).toEqual([])
    expect(replay.tasks[0]?.status).toBe('unknown')
  })

  it('recomputes after history replacement, and reports disconnected or pending states explicitly', () => {
    const h = fixture()
    h.append({ status: 'started' })
    expect(h.project(null, { waiting: new Map([[h.sender.botId, 'question']]) }).members[0]?.phase).toBe('question')
    expect(h.project(null, { connected: false }).members.every(member => member.phase === 'syncing')).toBe(true)
    const empty = h.project(null, { entries: [], snapshot: null })
    expect(empty.tasks).toEqual([])
    expect(empty.members[0]?.phase).toBe('idle')
  })
})
