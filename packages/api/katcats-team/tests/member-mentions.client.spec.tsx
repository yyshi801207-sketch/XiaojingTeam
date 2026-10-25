// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CandidateRequest, InputTriggerCandidate, InputTriggerPick } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { UserTextTransformContext } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { BotId, TeamBot, TeamSnapshot } from '../src/types.ts'
import type { ChatId, ChatSnapshot, TeamChat } from '../src/chats-types.ts'
import type { TeamView } from '../src/client/model.ts'
import type { ChatView } from '../src/client/chat-model.ts'
import { createMemberMentionSource, MemberMentionLabel, memberMentionRule } from '../src/client/member-mentions.tsx'
import { formatMemberMention, parseMemberMention } from '../src/member-mentions.ts'

afterEach(cleanup)
const sid = (value: string) => brandString<SessionId>(value)
const bid = (value: string) => brandString<BotId>(value)
function bot(id: string, name: string, kind: TeamBot['kind'] = 'ordinary'): TeamBot {
  return { id: bid(id), name, kind, role: `${name} responsibility`, avatar: { shape: 'classic', color: '#FF2849' },
    model: { kind: 'follow-global' }, workDir: `E:/synthetic/bots/${id}`, groupId: null, sessionId: sid(`${id}-private`) }
}
function chat(id: string, members: readonly TeamBot[]): TeamChat {
  return { id: brandString<ChatId>(id), name: id, groupId: brandString<TeamChat['groupId']>('group-chats'),
    rootSessionId: sid(`${id}-root`), workDir: `E:/synthetic/chats/${id}`, memberIds: members.map(value => value.id),
    managerId: null, memberRoles: [], executors: members.map(value => ({ botId: value.id, sessionId: sid(`${id}-${value.id}-worker`) })),
    relayLimit: 6, generation: 0, status: 'active', pauseReason: null, run: null, error: null }
}
function fixture(ready = true) {
  const main = bot('main', 'Katcats', 'main')
  const writer = bot('writer', '写作助手')
  const reviewer = bot('reviewer', '资料助理')
  const outside = bot('outside', '群外 Bot')
  const a = chat('chat-a', [writer, reviewer, main])
  const b = chat('chat-b', [outside])
  const team: TeamSnapshot = { revision: 1, mainBotId: main.id, groups: [], bots: [main, writer, reviewer, outside],
    modelCapabilities: { override: true, followGlobal: true } }
  const groups: ChatSnapshot = { revision: 1, chats: [a, b], deliveries: [], activities: [], relayLimit: 6 }
  const directory = createSnapshotStore<TeamView>({ phase: ready ? 'ready' : 'loading', snapshot: ready ? team : null, catalog: null })
  const chats = createSnapshotStore<ChatView>({ phase: ready ? 'ready' : 'loading', snapshot: ready ? groups : null })
  const source = createMemberMentionSource({ directory, chats,
    unavailableReason: () => 'The selected group member is no longer available' })
  return { main, writer, reviewer, outside, a, b, team, groups, directory, chats, source }
}
const request = (query = ''): CandidateRequest => ({ query, position: 'inline', drilled: false, signal: new AbortController().signal })
const pick = (candidate: InputTriggerCandidate, sessionId: SessionId): InputTriggerPick => ({ candidate,
  session: { sessionId }, position: 'inline', via: 'menu', action: 'pick', span: { start: 0, end: 1, draftRev: 1 } })

describe('current-group member source', () => {
  it('offers only current ordinary members and renders the approved avatar without exposing paths or Session ids', async () => {
    const h = fixture()
    try {
      const rows = await h.source.candidates({ sessionId: h.a.rootSessionId }, request())
      expect(rows.map(row => row.name)).toEqual(['写作助手', '资料助理'])
      expect(JSON.stringify(rows)).not.toContain('synthetic')
      expect(JSON.stringify(rows)).not.toContain('private')
      expect(JSON.stringify(rows)).not.toContain('worker')
      const Icon = rows[0]!.icon
      if (Icon === undefined || typeof Icon === 'string') throw new Error('Expected an approved member avatar')
      const view = render(<Icon size={24} />)
      expect(view.container.querySelector('svg')?.getAttribute('width')).toBe('24')
      expect(view.container.querySelector('path')).not.toBeNull()
      expect(h.source.exclusive({ sessionId: h.a.rootSessionId })).toBe(true)
      expect(h.source.exclusive({ sessionId: h.writer.sessionId })).toBe(false)
      expect((await h.source.candidates({ sessionId: h.b.rootSessionId }, request())).map(row => row.name)).toEqual(['群外 Bot'])
      expect(await h.source.candidates({ sessionId: h.writer.sessionId }, request())).toEqual([])
    } finally { h.source.dispose() }
  })

  it('keeps discovery empty until both initial directories are available and waits again after reconnect', async () => {
    const h = fixture(false)
    try {
      expect(h.source.exclusive({ sessionId: h.a.rootSessionId })).toBe(true)
      expect(await h.source.candidates({ sessionId: h.a.rootSessionId }, request())).toEqual([])
      h.directory.set({ phase: 'ready', snapshot: h.team, catalog: null })
      expect(await h.source.candidates({ sessionId: h.a.rootSessionId }, request())).toEqual([])
      h.chats.set({ phase: 'ready', snapshot: h.groups })
      expect(await h.source.candidates({ sessionId: h.a.rootSessionId }, request())).toHaveLength(2)
      h.source.invalidate()
      h.chats.set({ phase: 'ready', snapshot: h.groups })
      expect(h.source.exclusive({ sessionId: h.a.rootSessionId })).toBe(true)
      expect(await h.source.candidates({ sessionId: h.a.rootSessionId }, request())).toEqual([])
      h.directory.set({ phase: 'ready', snapshot: h.team, catalog: null })
      expect(await h.source.candidates({ sessionId: h.a.rootSessionId }, request())).toHaveLength(2)
      h.chats.set({ phase: 'failed', snapshot: h.groups })
      expect(await h.source.candidates({ sessionId: h.a.rootSessionId }, request())).toEqual([])
    } finally { h.source.dispose() }
  })

  it('disambiguates duplicate names by stable menu order and group-local responsibilities while retaining distinct Bot ids', async () => {
    const h = fixture()
    try {
      const team = { ...h.team, bots: h.team.bots.map(value => value.kind === 'ordinary' ? { ...value, name: '小编' } : value) }
      h.directory.set({ phase: 'ready', snapshot: team, catalog: null })
      h.chats.set({ phase: 'ready', snapshot: { ...h.groups, chats: [{ ...h.a,
        memberRoles: [{ botId: h.writer.id, role: '写稿' }, { botId: h.reviewer.id, role: '审稿' }] }, h.b] } })
      const rows = await h.source.candidates({ sessionId: h.a.rootSessionId }, request())
      expect(rows.map(row => [row.name, row.description])).toEqual([['小编 · 1', '写稿'], ['小编 · 2', '审稿']])
      expect(rows.map(row => parseMemberMention(row.value!)?.botId)).toEqual([h.writer.id, h.reviewer.id])
      expect((await h.source.candidates({ sessionId: h.a.rootSessionId }, request('审稿'))).map(row => row.name)).toEqual(['小编 · 2'])
    } finally { h.source.dispose() }
  })

  it('refuses stale and cross-group picks and notifies an open menu when a member is removed', async () => {
    const h = fixture()
    try {
      const [row] = await h.source.candidates({ sessionId: h.a.rootSessionId }, request())
      if (row === undefined) throw new Error('Expected writer')
      const selected = h.source.onPick(pick(row, h.a.rootSessionId))
      expect(selected).toMatchObject({ insert: { source: 'katcats-member', label: '写作助手' } })
      expect(h.source.onPick(pick(row, h.b.rootSessionId))).toBeUndefined()
      const changed = vi.fn()
      const off = h.source.subscribeLexicon!({ sessionId: h.a.rootSessionId }, changed)
      h.chats.set({ phase: 'ready', snapshot: { ...h.groups, chats: [{ ...h.a, memberIds: [h.reviewer.id] }, h.b] } })
      expect(changed).toHaveBeenCalledOnce()
      expect(h.source.onPick(pick(row, h.a.rootSessionId))).toBeUndefined()
      expect((await h.source.candidates({ sessionId: h.a.rootSessionId }, request())).map(value => value.name)).toEqual(['资料助理'])
      off()
      await expect(h.source.codec!.serialize(row.value!, request().signal)).rejects.toThrow('no longer available')
    } finally { h.source.dispose() }
  })

  it('serializes current names, rejects unavailable data and malformed values, and never turns member tokens into Session references', async () => {
    const h = fixture()
    try {
      const reference = formatMemberMention({ chatId: h.a.id, botId: h.writer.id, label: h.writer.name })
      h.directory.set({ phase: 'ready', snapshot: { ...h.team,
        bots: h.team.bots.map(value => value.id === h.writer.id ? { ...value, name: '新名字' } : value) }, catalog: null })
      expect(await h.source.codec!.serialize(reference, request().signal)).toBe(formatMemberMention({ chatId: h.a.id, botId: h.writer.id, label: '新名字' }))
      expect(h.source.codec!.clipboardText(reference)).toBe(reference)
      await expect(h.source.codec!.serialize('@[name](dsh-session:private)', request().signal)).rejects.toThrow('no longer available')
      const aborted = new AbortController()
      aborted.abort(new Error('Canceled submit'))
      await expect(h.source.codec!.serialize(reference, aborted.signal)).rejects.toThrow('Canceled submit')
      expect(await h.source.candidates({ sessionId: h.a.rootSessionId }, { ...request(), signal: aborted.signal })).toEqual([])
      h.source.invalidate()
      await expect(h.source.codec!.serialize(reference, request().signal)).rejects.toThrow('no longer available')
    } finally { h.source.dispose() }
  })

  it('stops notifying subscribers after disposal and preserves persisted display labels after member removal', async () => {
    const h = fixture()
    const changed = vi.fn()
    h.source.subscribeLexicon!({ sessionId: h.a.rootSessionId }, changed)
    h.source.dispose()
    h.chats.set({ phase: 'ready', snapshot: { ...h.groups, chats: [] } })
    h.directory.set({ phase: 'failed', snapshot: h.team, catalog: null })
    expect(changed).not.toHaveBeenCalled()
    const text = formatMemberMention({ chatId: h.a.id, botId: h.writer.id, label: h.writer.name })
    const context: UserTextTransformContext = { read: () => undefined }
    const node = memberMentionRule.match(text, 0, context)
    if (node?.id !== 'katcats-member') throw new Error('Expected a product member reference')
    render(<MemberMentionLabel node={node} />)
    expect(screen.getByText('@写作助手').textContent).toMatchInlineSnapshot('"@写作助手"')
    expect(screen.queryByText(/katcats-member:/u)).toBeNull()
    expect(memberMentionRule.match('@[old](dsh-session:old) @draft.md', 0, context)).toBeUndefined()
  })
})
