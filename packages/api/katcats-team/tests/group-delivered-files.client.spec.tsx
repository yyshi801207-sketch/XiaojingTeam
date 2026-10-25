// @vitest-environment jsdom
/** Original delivery cards keep the producing worker's preview and native authorization. */
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { SlotTestRuntime, stubConfigForm, bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-deliverables/client'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConnectionGeneration, ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import type { MessageId, MessageSourceMap } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import { registerConversationNodes } from '../../../client/ui-chat/src/client/conversation-nodes/register.ts'
import { EMPTY_CHAT_SNAPSHOT } from '../../../client/ui-chat/src/client/contract/snapshot.ts'
import { GroupDeliveredCards, GroupDeliveredFiles, type GroupDeliveredFilesInjected } from '../src/client/GroupDeliveredFiles.tsx'
import { groupFilesClaimMatches, groupFilesTargetAvailable, retainGroupFiles, type GroupFilesTarget } from '../src/client/group-delivered-files.ts'
import type { ChatId, ChatDeliveryId, ChatRunId } from '../src/chats-types.ts'
import type { TeamView } from '../src/client/model.ts'
import type { BotId, TeamBot } from '../src/types.ts'
import { en, zh } from '../src/client/locales.ts'
import { presentationDirectory } from './group-presentation-fixture.client.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const worker = 'editorial-writer' as SessionId
const output = 'actual-final-answer' as MessageId
const sender = { botId: 'writer' as BotId, name: 'Recorded Writer', role: 'Writing',
  avatar: { shape: 'classic' as const, color: '#FF2849' } }
const source: MessageSourceMap['katcats-group-relay'] = { kind: 'katcats-group-relay', form: 'relay', schemaVersion: 1,
  chatId: 'editorial' as ChatId, runId: 'original-run' as ChatRunId, generation: 3,
  deliveryId: 'original-delivery' as ChatDeliveryId, sender, executionSessionId: worker,
  inputMessageId: 'actual-claimed-input' as MessageId, outputMessageId: output }
const target: GroupFilesTarget = { rootSessionId: 'editorial-root' as SessionId,
  messageId: 'confirmed-root-relay' as MessageId, source }

function at(seq: number, type: string, data: unknown): SessionLiveEventEntry {
  return { type: 'event', event: { seq, time: seq * 1000, type, data,
    ...type === 'user/message' || type === 'assistant/message' ? { surfaceOp: 'append' } : {} } as SessionEvent }
}

function history(options: { presented?: boolean; completed?: boolean; closing?: MessageId } = {}): SessionLiveEventEntry[] {
  return [
    at(1, 'turn/start', { turn: 1 }),
    at(2, 'user/message', { id: source.inputMessageId, role: 'user', content: [{ type: 'text', text: 'Make a report' }],
      source: { kind: 'katcats-group-task', form: 'relay', chatId: source.chatId, runId: source.runId,
        generation: source.generation, deliveryId: source.deliveryId, target: sender } }),
    at(3, 'step/start', { turn: 1, step: 1 }),
    at(4, 'assistant/message', { turn: 1, step: 1, stream: [], message: { id: 'tool-step' as MessageId, role: 'assistant',
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      content: [{ type: 'text', text: 'Preparing the report' },
        { type: 'tool-call', id: 'present-call', name: 'present', arguments: '{}' }] } }),
    ...options.presented === false ? [] : [at(5, 'deliverables/presented', { turn: 1, callId: 'present-call', files: [
      { path: '/synthetic/editorial/final.md', description: 'Actual registered report' },
      { path: '/synthetic/editorial/final.pdf', description: 'Actual registered PDF' },
      { path: '/synthetic/editorial/final.md', description: 'Latest report description' },
    ] })],
    at(6, 'step/end', { turn: 1, step: 1 }),
    at(7, 'step/start', { turn: 1, step: 2 }),
    at(8, 'assistant/message', { turn: 1, step: 2, stream: [], message: { id: options.closing ?? output,
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      role: 'assistant', content: [{ type: 'text', text: 'Registered the requested final files.' }] } }),
    at(9, 'step/end', { turn: 1, step: 2 }),
    ...options.completed === false ? [] : [at(10, 'turn/end', { turn: 1, reason: { kind: 'completed' } })],
  ]
}

async function setup(options: { events?: SessionLiveEventEntry[]; pending?: boolean; hasMore?: boolean; progress?: boolean } = {}) {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale('en')
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  runtime.ctx.effect(() => locale.register('katcats.team', { zh, en }))
  const group = presentationDirectory({ executors: [{ botId: sender.botId, sessionId: worker }],
    memberIds: [], showHandoffRecords: false })
  const directory = createSnapshotStore<TeamView>({ phase: 'ready', catalog: null, snapshot: {
    revision: 1, mainBotId: 'main' as BotId, bots: [], groups: [], modelCapabilities: { override: false, followGlobal: false },
  } })
  const connected = createSnapshotStore<ConnectionState | undefined>('connected')
  const generation = createSnapshotStore<ConnectionGeneration | undefined>({ id: 1, host: { home: '/synthetic' } })
  const opening = Promise.withResolvers<undefined>()
  const loadThrough = vi.fn(async () => { await runtime.sessions.replaceEvents(worker, history(), false) })
  await runtime.sessions.add({ id: worker, summary: { cwd: '/synthetic/editorial' },
    events: options.events ?? history(), hasMore: options.hasMore ?? false, session: { loadThrough },
    ...options.pending ? { initialOpen: () => opening.promise } : {} })
  await runtime.sessions.add({ id: target.rootSessionId, summary: { cwd: '/synthetic/root-different' } })
  const conversation = new UiConversation(runtime.ctx, runtime.sessions)
  registerConversationNodes(runtime.ctx)
  runtime.ctx.uiSession.provide({ hooks: ['chat'], resolve: (binding) => {
    const state = conversation.binding(binding).target('chat')
    return { hooks: { chat: { getSnapshot: () => state.getSnapshot() ?? EMPTY_CHAT_SNAPSHOT,
      subscribe: listener => state.subscribe(listener) } } }
  } })
  const openResource = vi.fn()
  runtime.ctx.provide('remote.session', {} as never)
  runtime.ctx.provide('sidebarRightTabs', { register: () => () => {} } as never)
  runtime.ctx.provide('sidebarRight', { openResource } as never)
  runtime.ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(false) },
    get: () => stubConfigForm().scope } as never)
  const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
    void input
    return init?.method === 'POST' ? new Response(null, { status: 204 })
      : Response.json({ name: 'synthetic-desktop', available: true, fileManager: 'explorer' })
  })
  vi.stubGlobal('fetch', fetcher)
  const root = runtime.sessions.retainFor(runtime.ctx, target.rootSessionId)
  await root.ready
  const state = createSnapshotStore({ visible: true, target: options.progress ? { ...target, messageId: output } : target })
  const useView = bindSnapshotSelector(state)
  await runtime.root.declare({ 'katcats.group.delivered-files': { kind: 'single', scope: 'session' } },
    ({ SessionProvider, renderSlot }: PropsRuntime<'root'> & PropsRenderSlots<'katcats.group.delivered-files'>) => {
      const view = useView(value => value)
      return view.visible ? <SessionProvider session={root}>{renderSlot('katcats.group.delivered-files', {
        source: view.target.source, messageId: view.target.messageId,
      })}</SessionProvider> : null
    })
  const retainFiles = vi.fn((value: GroupFilesTarget, signal: AbortSignal) => retainGroupFiles({ sessions: runtime.sessions,
    chats: group.source, directory, connection: { state: connected, generation } }, value, signal))
  runtime.slots.register({ name: 'katcats.group.delivered-files', locale: 'katcats.team',
    children: { 'katcats.group.delivered-cards': { kind: 'single', scope: 'session' } },
    inject: (): GroupDeliveredFilesInjected => ({ hooks: { groupDirectory: group.source, deliveryDirectory: directory,
      deliveryConnection: connected, deliveryGeneration: generation }, retainFiles }),
  }, GroupDeliveredFiles)
  runtime.slots.register({ name: 'katcats.group.delivered-cards' }, GroupDeliveredCards)
  await runtime.mount({ inject: [...inject], apply })
  runtime.slots.inject('deliverables.files.actions', () => runtime.slots.register({ name: 'deliverables.files.actions', id: 'native-test' },
    ({ actionUrl, onAction, available, pending }: PropsRuntime<'deliverables.files.actions'>) =>
      <button data-native-route={actionUrl} disabled={!available || pending} onClick={() => { void onAction('open') }}>Native file action</button>))
  const view = runtime.renderRoot()
  const retained = () => runtime.sessions.retainInfo(worker).getSnapshot().retainedBy.katcatsDeliveredFiles ?? 0
  return { runtime, view, group, directory, connected, generation, opening, state, openResource, fetcher,
    retainFiles, retained, loadThrough }
}

describe('original delivery Factory inside a verified group worker Session', () => {
  it('cold-renders each registered final file once and preserves worker preview and exact native event coordinates', async () => {
    const b = await setup()
    await vi.waitFor(() => { expect(b.view.container.querySelectorAll('[data-presented-file]')).toHaveLength(2) })
    expect(b.retained()).toBe(1)
    expect(b.group.chat.showHandoffRecords).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Preview /synthetic/editorial/final.md in sidebar' }))
    expect(b.openResource).toHaveBeenCalledExactlyOnceWith('dsh-resource://file/session/editorial-writer/final.md')
    await vi.waitFor(() => { expect(screen.getAllByRole<HTMLButtonElement>('button', { name: 'Native file action' })[0]!.disabled).toBe(false) })
    const actions = [...b.view.container.querySelectorAll<HTMLButtonElement>('[data-native-route]')]
    expect(actions.map(button => button.dataset.nativeRoute)).toEqual([
      'api/present.open?sessionId=editorial-writer&seq=5&index=2',
      'api/present.open?sessionId=editorial-writer&seq=5&index=1',
    ])
    fireEvent.click(actions[0]!)
    await vi.waitFor(() => { expect(b.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1) })
    expect(b.fetcher.mock.calls.find(([, init]) => init?.method === 'POST')?.[0]).toBe(actions[0]!.dataset.nativeRoute)
    expect([...b.view.container.querySelectorAll('[data-presented-file]')].map(card => card.textContent)).toMatchSnapshot()
    await act(async () => { await b.runtime.sessions.replaceEvents(worker, history()) })
    expect(b.view.container.querySelectorAll('[data-presented-file]')).toHaveLength(2)
    b.view.unmount()
    expect(b.retained()).toBe(0)
  })

  it('pages the actual claim before showing a cold final result', async () => {
    const b = await setup({ events: history().slice(-4), hasMore: true })
    await vi.waitFor(() => { expect(b.view.container.querySelectorAll('[data-presented-file]')).toHaveLength(2) })
    expect(b.loadThrough).toHaveBeenCalledExactlyOnceWith(1)
  })

  it.each(['unpresented', 'open-turn', 'wrong-closing', 'progress'] as const)('does not promote %s into a final file card', async (kind) => {
    const events = history({ presented: kind !== 'unpresented', completed: kind !== 'open-turn',
      ...kind === 'wrong-closing' ? { closing: 'unrelated-answer' as MessageId } : {} })
    const b = await setup({ events, progress: kind === 'progress' })
    if (kind === 'progress') expect(b.retainFiles).not.toHaveBeenCalled()
    else await vi.waitFor(() => { expect(b.retainFiles).toHaveBeenCalledOnce() })
    await act(async () => { await Promise.resolve() })
    expect(b.view.container.querySelector('[data-presented-file]')).toBeNull()
    expect(b.openResource).not.toHaveBeenCalled()
  })

  it('releases on disconnect and reacquires only the current connection generation', async () => {
    const b = await setup()
    await vi.waitFor(() => { expect(b.retained()).toBe(1) })
    await act(async () => { b.connected.set('disconnected') })
    expect(b.retained()).toBe(0)
    expect(b.view.container.querySelector('[data-presented-file]')).toBeNull()
    await act(async () => { b.generation.set({ id: 2, host: { home: '/synthetic' } }); b.connected.set('connected') })
    await vi.waitFor(() => { expect(b.view.container.querySelectorAll('[data-presented-file]')).toHaveLength(2) })
    expect(b.retained()).toBe(1)
    expect(b.retainFiles).toHaveBeenCalledTimes(2)
  })

  it('cannot attach a late-ready worker after the result unmounts', async () => {
    const b = await setup({ pending: true })
    await vi.waitFor(() => { expect(b.retained()).toBe(1) })
    b.view.unmount()
    expect(b.retained()).toBe(0)
    await act(async () => { b.opening.resolve(undefined) })
    expect(b.view.container.querySelector('[data-presented-file]')).toBeNull()
    expect(b.openResource).not.toHaveBeenCalled()
  })

  it('rejects unavailable, aliased and cross-group scopes before acquiring an executor', async () => {
    const b = await setup()
    await vi.waitFor(() => { expect(b.retained()).toBe(1) })
    const groups = b.group.source.getSnapshot()
    const team = b.directory.getSnapshot()
    expect(groupFilesTargetAvailable(target, groups, team)).toBe(true)
    expect(groupFilesTargetAvailable({ ...target, rootSessionId: 'another-root' as SessionId }, groups, team)).toBe(false)
    const privateBot = { sessionId: worker } as TeamBot
    expect(groupFilesTargetAvailable(target, groups, { ...team, snapshot: { ...team.snapshot!, bots: [privateBot] } })).toBe(false)
    expect(groupFilesTargetAvailable(target, { ...groups, snapshot: { ...groups.snapshot!, chats: [b.group.chat,
      { ...b.group.chat, id: 'another-group' as ChatId, rootSessionId: 'another-root' as SessionId }] } }, team)).toBe(false)
    await act(async () => { b.directory.set({ phase: 'loading', catalog: null, snapshot: team.snapshot }) })
    expect(b.retained()).toBe(0)
    expect(b.view.container.querySelector('[data-presented-file]')).toBeNull()
  })

  it.each(['error', 'aborted', 'blocked'] as const)('does not accept a settled assistant followed by %s as a completed result', (reason) => {
    const entries = history()
    entries[entries.length - 1] = at(10, 'turn/end', { turn: 1, reason: { kind: reason } })
    expect(groupFilesClaimMatches(target, { entries, hasMore: false, change: { kind: 'replace' } } as never)).toBe(false)
  })
})
