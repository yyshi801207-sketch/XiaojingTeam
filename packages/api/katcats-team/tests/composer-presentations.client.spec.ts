/** Product hints follow exact private/group Sessions and release their live subscriptions. */
import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ComposerPresentation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { installTeamComposerPresentations, type TeamComposerOptions } from '../src/client/composer-presentations.ts'
import type { TeamView } from '../src/client/model.ts'
import type { ChatView } from '../src/client/chat-model.ts'
import type { BotId, GroupId, TeamBot, TeamSnapshot } from '../src/types.ts'
import type { ChatId, ChatSnapshot, TeamChat } from '../src/chats-types.ts'
import { en, zh } from '../src/client/locales.ts'

const MAIN = 'private-lead' as SessionId
const PRIVATE = 'private-writer' as SessionId
const GROUP = 'room-transcript' as SessionId
const WORKER = 'room-worker' as SessionId
const UNRELATED = 'unrelated-conversation' as SessionId
const main: TeamBot = { id: 'lead' as BotId, kind: 'main', name: 'Lead', role: '',
  avatar: { shape: 'classic', color: '#FF2849' }, model: { kind: 'follow-global' },
  workDir: '/synthetic/lead', groupId: null, sessionId: MAIN }
const writer: TeamBot = { ...main, id: 'writer' as BotId, kind: 'ordinary', name: 'Writer', sessionId: PRIVATE }
const room: TeamChat = { id: 'room' as ChatId, name: 'Room', groupId: 'chats' as GroupId,
  rootSessionId: GROUP, workDir: '/synthetic/room', memberIds: [writer.id], managerId: null,
  memberRoles: [], executors: [{ botId: writer.id, sessionId: WORKER }], relayLimit: 6,
  generation: 0, status: 'active', pauseReason: null, run: null, error: null }
const directorySnapshot: TeamSnapshot = { revision: 0, mainBotId: main.id, groups: [], bots: [main, writer],
  modelCapabilities: { override: true, followGlobal: true } }
const chatSnapshot: ChatSnapshot = { revision: 0, chats: [room], deliveries: [], activities: [], relayLimit: 6 }

function trackedSnapshot<T>(initial: T) {
  const state = createSnapshotStore(initial)
  const listeners = new Set<() => void>()
  const stopped = vi.fn()
  const source: ObservableSnapshot<T> = {
    getSnapshot: () => state.getSnapshot(),
    subscribe: (listener) => {
      listeners.add(listener)
      const unsubscribe = state.subscribe(listener)
      return () => { unsubscribe(); listeners.delete(listener); stopped() }
    },
  }
  return { state, source, stopped, subscriptionCount: () => listeners.size }
}

function setup(failOn?: SessionId) {
  const directory = trackedSnapshot<TeamView>({ phase: 'ready', snapshot: directorySnapshot, catalog: null })
  const chats = trackedSnapshot<ChatView>({ phase: 'ready', snapshot: chatSnapshot })
  const locale = trackedSnapshot<'zh' | 'en'>('zh')
  const translations = { zh: makeTranslate(zh), en: makeTranslate(en) }
  const active = new Map<SessionId, ObservableSnapshot<ComposerPresentation>>()
  const registrations: { id: SessionId; source: ObservableSnapshot<ComposerPresentation>; dispose: ReturnType<typeof vi.fn> }[] = []
  const failure = new Error('Synthetic registration failure')
  const register = vi.fn((id: SessionId, source: ObservableSnapshot<ComposerPresentation>) => {
    if (id === failOn) throw failure
    const dispose = vi.fn(() => { active.delete(id) })
    active.set(id, source)
    registrations.push({ id, source, dispose })
    return dispose
  })
  const options: TeamComposerOptions = { directory: directory.source, chats: chats.source,
    presentation: { register }, t: (key, params) => translations[locale.state.getSnapshot()](key, params),
    subscribeLocale: listener => locale.source.subscribe(listener) }
  const subscriptions = () => [directory, chats, locale].map(source => source.subscriptionCount())
  return { options, directory, chats, locale, register, active, registrations, subscriptions, failure }
}

describe('product Session composer presentations', () => {
  it('registers localized hints and hides the workspace/preset row for exact Bot and group Sessions', () => {
    const h = setup()
    const dispose = installTeamComposerPresentations(h.options)
    expect(h.register.mock.calls.map(([id]) => id)).toEqual([MAIN, PRIVATE, GROUP])
    expect([...h.active].map(([id, source]) => [id, source.getSnapshot()])).toEqual([
      [MAIN, { defaultPlaceholder: '主人，您想创建什么样的 Bot？', hideWorkspaceRow: true }],
      [PRIVATE, { defaultPlaceholder: '主人，有什么需要我帮忙的？', hideWorkspaceRow: true }],
      [GROUP, { defaultPlaceholder: '主人，这次让我们一起完成什么？', hideWorkspaceRow: true }],
    ])
    dispose()
  })

  it('does not register group workers or unrelated Sessions', () => {
    const h = setup()
    const dispose = installTeamComposerPresentations(h.options)
    expect(h.active.has(WORKER)).toBe(false)
    expect(h.active.has(UNRELATED)).toBe(false)
    h.chats.state.set({ phase: 'failed', snapshot: { ...chatSnapshot, revision: 1,
      chats: [{ ...room, executors: [...room.executors, { botId: writer.id, sessionId: UNRELATED }] }] } })
    expect(h.register.mock.calls.map(([id]) => id)).toEqual([MAIN, PRIVATE, GROUP])
    dispose()
  })

  it('updates existing sources when the locale changes without registering them again', () => {
    const h = setup()
    const dispose = installTeamComposerPresentations(h.options)
    const originals = [...h.active]
    const notified = vi.fn()
    const stop = h.active.get(MAIN)!.subscribe(notified)
    h.locale.state.set('en')
    expect(h.register).toHaveBeenCalledTimes(3)
    for (const [id, source] of originals) expect(h.active.get(id)).toBe(source)
    expect(originals.map(([, source]) => source.getSnapshot().defaultPlaceholder)).toEqual([
      en['composer.mainPlaceholder'], en['composer.botPlaceholder'], en['composer.chatPlaceholder'],
    ])
    expect(notified).toHaveBeenCalledOnce()
    expect(originals.every(([, source]) => source.getSnapshot().hideWorkspaceRow === true)).toBe(true)
    stop()
    dispose()
  })

  it('releases removed identities and unregisters all remaining hints and subscriptions on disposal', () => {
    const h = setup()
    const dispose = installTeamComposerPresentations(h.options)
    expect(h.subscriptions()).toEqual([1, 1, 1])
    h.directory.state.set({ phase: 'ready', catalog: null, snapshot: { ...directorySnapshot, revision: 1, bots: [main] } })
    h.chats.state.set({ phase: 'ready', snapshot: { ...chatSnapshot, revision: 1, chats: [] } })
    expect([...h.active.keys()]).toEqual([MAIN])
    expect(h.registrations.slice(1).map(entry => entry.dispose.mock.calls.length)).toEqual([1, 1])
    h.locale.state.set('en')
    expect(h.registrations[1]!.source.getSnapshot().defaultPlaceholder).toBe(zh['composer.botPlaceholder'])
    dispose()
    expect(h.active.size).toBe(0)
    expect(h.subscriptions()).toEqual([0, 0, 0])
    expect(h.registrations.map(entry => entry.dispose.mock.calls.length)).toEqual([1, 1, 1])
    h.directory.state.set({ phase: 'ready', catalog: null, snapshot: directorySnapshot })
    h.chats.state.set({ phase: 'ready', snapshot: chatSnapshot })
    h.locale.state.set('zh')
    expect(h.register).toHaveBeenCalledTimes(3)
  })

  it('releases accepted registrations and all input subscriptions when initial registration partially fails', () => {
    const h = setup(GROUP)
    expect(() => installTeamComposerPresentations(h.options)).toThrow(h.failure)
    expect(h.register).toHaveBeenCalledTimes(3)
    expect(h.registrations.map(entry => entry.id)).toEqual([MAIN, PRIVATE])
    expect(h.registrations.map(entry => entry.dispose.mock.calls.length)).toEqual([1, 1])
    expect(h.active.size).toBe(0)
    expect(h.subscriptions()).toEqual([0, 0, 0])
    h.locale.state.set('en')
    h.directory.state.set({ phase: 'loading', snapshot: null, catalog: null })
    h.chats.state.set({ phase: 'loading', snapshot: null })
    expect(h.register).toHaveBeenCalledTimes(3)
  })
})
