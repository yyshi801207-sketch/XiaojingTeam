// @vitest-environment jsdom
/** Product registration connects generic New Session actions to cancellable member creation. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ConnectionGeneration, ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import type { WorkspaceId, WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { ModelDirectoryResolver } from '../../../client/ui-model-selection/src/client/service.ts'
import { allowAllAccess, bindSnapshotSelector, conversationSnapshot, makeTranslate, sessionSnapshot,
  SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { SlotCore, type GlobalStandardProps, type PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ScheduleCatalogEntry, ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import { WorkspaceCategoryRegistry } from '../../../client/ui-workspace/src/client/category-registry.ts'
import { InputBar, type InputBarProps } from '../../../client/ui-conversation/src/client/skeleton/InputBar.tsx'
import { zh as conversationZh } from '../../../client/ui-conversation/src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import '../../../client/ui-conversation/tests/control-row-dom.ts'
import type { BotId, GroupId, TeamBot, TeamFrame, TeamSnapshot } from '../src/types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamOverlaysInjected, TeamOverlaysProps } from '../src/client/Overlays.tsx'
import type { TeamSidebarInjected } from '../src/client/TeamSidebar.tsx'
import type { SidebarEntity } from '../src/client/EntityMenu.tsx'
import type { TeamRemote } from '../src/client/model.ts'
import type { ChatRemote } from '../src/client/chat-model.ts'
import type { MemoryRemote } from '../src/client/MemoryPanel.tsx'
import type { ChatFrame, ChatId, ChatSnapshot, TeamChat } from '../src/chats-types.ts'
import { ChatOverlay, type ChatOverlayInjected, type ChatOverlayProps } from '../src/client/ChatOverlay.tsx'
import { ChatSettings, type ChatSettingsInjected } from '../src/client/ChatForms.tsx'
import { ChatFolderInfo, type ChatFolderInfoProps } from '../src/client/ChatFolderInfo.tsx'
import { BotSettings, type BotSettingsInjected, type BotSettingsProps } from '../src/client/BotSettings.tsx'
import { BotModelControl, type BotModelControlInjected, type BotModelControlProps } from '../src/client/BotModelControl.tsx'
import { BotFolderInfo, type BotFolderInfoProps } from '../src/client/BotFolderInfo.tsx'
import { MainBotWelcome } from '../src/client/MainBotWelcome.tsx'
import { GroupMessageActions, type GroupMessageActionsInjected } from '../src/client/GroupMessageActions.tsx'
import { ScheduleList, ScheduleManager, type ScheduleListProps, type ScheduleManagerProps, type ScheduleViewsInjected } from '../src/client/ScheduleViews.tsx'
import { SCHEDULE_NS } from '../src/client/schedule-locales.ts'
import { GroupRoomAction, type GroupRoomInjected } from '../src/client/GroupRoom.tsx'
import { Headquarters, type HeadquartersInjected } from '../src/client/Headquarters.tsx'
import { ChatRelayMessage, type ChatRelayActionsInjected } from '../src/client/ChatRelayMessage.tsx'

const controls = vi.hoisted(() => ({ entries: [] as {
  replace: (frame: TeamFrame | ChatFrame) => void
  update: (frame: TeamFrame | ChatFrame) => void
  failed: (error: unknown) => void
  restart: ReturnType<typeof vi.fn<() => void>>
}[] }))
vi.mock('@deepseek-ai/dsh-api-gateway/client', async original => ({
  ...await original<typeof import('@deepseek-ai/dsh-api-gateway/client')>(),
  RemoteSnapshotStream: class {
    private readonly control: typeof controls.entries[number]
    constructor(_stream: object, options: Omit<typeof controls.entries[number], 'restart'>) {
      this.control = { ...options, restart: vi.fn() }
      controls.entries.push(this.control)
    }
    start() {}
    restart() { this.control.restart() }
    async dispose() {}
  },
}))
import { apply, inject } from '../src/client/index.ts'
import { TeamOverlays } from '../src/client/Overlays.tsx'
import { zh } from '../src/client/locales.ts'

type OverlayTestProps = Pick<TeamOverlaysProps,
  'useTeamUi' | 'close' | 'createBot' | 'createGroup' | 'renameGroup' | 'removeGroup' | 'renameEntity' | 'deleteEntity' | 'dismissNotice' | 't'>
const OverlayUnderTest = TeamOverlays as (props: OverlayTestProps) => ReturnType<typeof TeamOverlays>

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
afterEach(() => {
  cleanup()
  controls.entries.length = 0
  if (clipboardDescriptor === undefined) Reflect.deleteProperty(navigator, 'clipboard')
  else Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
})

const snapshot: TeamSnapshot = {
  revision: 0, mainBotId: 'main' as BotId, modelCapabilities: { override: false, followGlobal: false },
  bots: [{ id: 'main' as BotId, kind: 'main', name: 'Katcats', role: '', avatar: { shape: 'classic', color: '#FF2849' },
    model: { kind: 'follow-global' }, groupId: null, sessionId: 'main-session' as SessionId, workDir: '/synthetic/main' }],
  groups: [{ id: 'ordinary' as GroupId, name: 'Ordinary', kind: 'bots', system: true }, { id: 'chats' as GroupId, name: 'Chats', kind: 'chats', system: true }],
}

const emptyChats: ChatSnapshot = { revision: 0, chats: [], deliveries: [], relayLimit: 6, activities: [] }
const groupChat: TeamChat = {
  id: 'editorial' as ChatId, name: 'Editorial', groupId: 'chats' as GroupId, rootSessionId: 'editorial-root' as SessionId,
  managerId: null, memberRoles: [],
  workDir: '/synthetic/chats/editorial', memberIds: ['main' as BotId, 'writer' as BotId],
  executors: [{ botId: 'writer' as BotId, sessionId: 'editorial-worker' as SessionId }], status: 'active',
  pauseReason: null, run: null, error: null, generation: 0, relayLimit: 6,
}
const withGroup: ChatSnapshot = { ...emptyChats, revision: 1, chats: [groupChat] }
const ordinaryBot: TeamBot = {
  ...snapshot.bots[0]!, id: 'writer' as BotId, kind: 'ordinary', name: 'Writer',
  groupId: snapshot.groups[0]!.id, sessionId: 'writer-private' as SessionId, workDir: '/synthetic/writer',
}
const withOrdinaryBot: TeamSnapshot = { ...snapshot, revision: 1, bots: [...snapshot.bots, ordinaryBot] }
const ordinaryEntity: SidebarEntity = { kind: 'bot', id: ordinaryBot.id, name: ordinaryBot.name,
  sessionId: ordinaryBot.sessionId, currentGroup: ordinaryBot.groupId }
const groupEntity: SidebarEntity = { kind: 'chat', id: groupChat.id, name: groupChat.name,
  sessionId: groupChat.rootSessionId, currentGroup: groupChat.groupId }

function sessionList(bots: readonly Pick<TeamBot, 'sessionId' | 'name'>[], selected?: SessionId): SessionListState {
  return {
    ids: bots.map(bot => bot.sessionId), phase: 'ready', projectionsBySession: {},
    byId: Object.fromEntries(bots.map(bot => [bot.sessionId, {
      id: bot.sessionId, displayTitle: bot.name, blank: true, running: false,
      retainedBy: bot.sessionId === selected ? { mainView: 1 } : {}, updatedAt: 0,
    }])),
  }
}

async function boot(initialSessions = sessionList(snapshot.bots), autoSnapshot = true, initialChats: ChatSnapshot | null = emptyChats,
  realQuestionSlots = false) {
  const ctx = new Context()
  const categories = new WorkspaceCategoryRegistry()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  const questionSlots = new SlotCore()
  if (realQuestionSlots) {
    questionSlots.register({ name: 'root', children: {
      'conversation.composer': { kind: 'chain', scope: 'session' },
      'conversation.input.dock': { kind: 'list', scope: 'session' },
    } }, (_props: PropsRenderSlots<'conversation.composer' | 'conversation.input.dock'>) => null)
    questionSlots.register({ name: 'conversation.composer', select: () => null }, () => null)
  }
  const entries: { name: string; key?: string; priority?: number; inject?: () => object; component?: unknown }[] = []
  const slots = {
    inject: (_name: string, register: () => () => void) => ctx.effect(register),
    register: (entry: { name: string; key?: string; priority?: number; inject?: () => object }, component?: unknown) => {
      const release = realQuestionSlots && (entry.name === 'conversation.input.dock' || entry.name === 'katcats.group.question-panel')
        ? questionSlots.register(entry as never, component as never) : undefined
      const registered = { ...entry, component }
      entries.push(registered)
      return () => { release?.(); entries.splice(entries.indexOf(registered), 1) }
    },
  }
  const remote: TeamRemote = {
    snapshot: vi.fn<TeamRemote['snapshot']>().mockResolvedValue({ ok: true, value: snapshot }),
    follow: async function* () { yield { type: 'snapshot', value: snapshot } },
    createBot: vi.fn(), updateBot: vi.fn(), deleteBot: vi.fn(), createGroup: vi.fn(), updateGroup: vi.fn(), moveGroup: vi.fn(), removeGroup: vi.fn(),
  }
  const chatRemote: ChatRemote = {
    sendMessage: vi.fn(), cancelSession: vi.fn(),
    snapshot: vi.fn<ChatRemote['snapshot']>().mockResolvedValue({ ok: true, value: emptyChats }),
    follow: async function* () { yield { type: 'snapshot', value: emptyChats } },
    createChat: vi.fn(), updateChat: vi.fn(), deleteChat: vi.fn(), pause: vi.fn(), resume: vi.fn(), stop: vi.fn(),
  }
  const session = {
    modelCatalog: vi.fn<() => Promise<RemoteResult<ModelCatalog>>>().mockResolvedValue({ ok: true,
      value: { default: { provider: 'mock', model: 'base' }, groups: [], failures: [], routableProviders: [] } }),
    selectModel: vi.fn(),
  }
  const memoryRemote: MemoryRemote = { list: vi.fn(), follow: async function* () {},
    save: vi.fn(), edit: vi.fn(), delete: vi.fn(), share: vi.fn() }
  const sessionCreate = vi.fn()
  const sessions = createSnapshotStore(initialSessions)
  const mountedSidebar = createSnapshotStore<SessionId | undefined>(
    initialSessions.ids.find(id => (initialSessions.byId[id]?.retainedBy.mainView ?? 0) > 0))
  const adoptedSurfaces = new Set(initialSessions.ids)
  const sidebarExpanded = new Map<SessionId, boolean>()
  const isSidebarExpanded = vi.fn(() => {
    const id = mountedSidebar.getSnapshot()
    return id !== undefined && adoptedSurfaces.has(id) && sidebarExpanded.get(id) === true
  })
  const toggleSidebar = vi.fn(() => {
    const id = mountedSidebar.getSnapshot()
    if (id === undefined || !adoptedSurfaces.has(id)) throw new Error('sidebarRight: no session surface is mounted')
    sidebarExpanded.set(id, !isSidebarExpanded())
  })
  const openSettingsTab = vi.fn(() => {
    const id = mountedSidebar.getSnapshot()
    if (id === undefined || !adoptedSurfaces.has(id)) throw new Error('sidebarRight: no session surface is mounted')
    sidebarExpanded.set(id, true)
  })
  const workspaces = createSnapshotStore<WorkspaceSnapshot>({
    items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  })
  const workspaceOpen = vi.fn()
  const pinSession = vi.fn<(sessionId: SessionId) => Promise<void>>().mockResolvedValue(undefined)
  const unpinSession = vi.fn<(sessionId: SessionId) => Promise<void>>().mockResolvedValue(undefined)
  const disposeRemote = vi.fn(async () => { ctx.reflect.provide('remote.katcatsTeam', undefined); ctx.reflect.provide('remote.katcatsChats', undefined); ctx.reflect.provide('remote.katcatsMemory', undefined) })
  const mountRemote = vi.fn(async () => {
    ctx.reflect.provide('remote.katcatsTeam', remote)
    ctx.reflect.provide('remote.katcatsChats', chatRemote)
    ctx.reflect.provide('remote.katcatsMemory', memoryRemote)
    return disposeRemote
  })
  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale)
  const connection = createSnapshotStore<ConnectionState | undefined>('connected')
  const connectionGeneration = createSnapshotStore<ConnectionGeneration | undefined>({ id: 1, host: { home: '/synthetic' } })
  ctx.provide('connection', { state: connection, generation: connectionGeneration } as never)
  ctx.provide('remoteAccess', { source: () => createSnapshotStore(true) } as never)
  ctx.provide('uiConversation', { events: { register: vi.fn() }, userText: { register: vi.fn() } } as never)
  ctx.provide('inputTriggers', { registerSource: vi.fn(() => () => {}) } as never)
  ctx.provide('composerPresentation', { register: vi.fn(() => () => {}) } as never)
  const schedule = { catalog: vi.fn<() => Promise<RemoteResult<ScheduleCatalogEntry[]>>>().mockResolvedValue({ ok: true, value: [] }) }
  const scheduleChanged = new Set<() => void>()
  const remoteListeners = new Map<string, Set<() => void>>([['schedule/changed', scheduleChanged]])
  const remoteOn = vi.fn((name: string, listener: () => void) => {
    const listeners = remoteListeners.get(name) ?? new Set<() => void>()
    remoteListeners.set(name, listeners)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  })
  ctx.provide('remote', { katcatsTeam: remote, katcatsChats: chatRemote, katcatsMemory: memoryRemote, session,
    schedule, $on: remoteOn, $mount: mountRemote, $stream: vi.fn(() => ({})) } as never)
  ctx.reflect.provide('remote.session', session)
  ctx.reflect.provide('remote.schedule', schedule)
  ctx.reflect.provide('remote.commands', { execute: vi.fn() })
  ctx.provide('workspaceCategories', categories)
  const sessionOpen = vi.fn((sessionId: SessionId) => {
    const current = sessions.getSnapshot()
    if (!current.ids.includes(sessionId)) throw new Error(`synthetic unknown Session: ${sessionId}`)
    sessions.set({ ...current, byId: Object.fromEntries(current.ids.map(id => [id, {
      ...current.byId[id]!, retainedBy: id === sessionId ? { mainView: 1 } : {},
    }])) })
    mountedSidebar.set(sessionId)
  })
  ctx.provide('uiWorkspace', { openSession: sessionOpen, openWorkspace: workspaceOpen, pinSession, unpinSession } as never)
  ctx.provide('sidebarRight', {
    openTab: openSettingsTab, mounted: mountedSidebar, isExpanded: isSidebarExpanded, toggleExpanded: toggleSidebar,
  } as never)
  ctx.provide('sidebarRightTabs', { register: vi.fn(() => () => {}) } as never)
  ctx.provide('workspaces', { list: workspaces } as never)
  const blockComposer = vi.fn()
  const submitInput = vi.fn()
  const scopedInput = vi.fn(() => ({ submit: submitInput }))
  ctx.provide('conversation', { blocks: { setOwned: blockComposer,
    storeFor: () => createSnapshotStore(undefined) }, input: { for: scopedInput } } as never)
  ctx.provide('shortcuts', { stopSequenceMs: 500, observeFixedInput: vi.fn(() => () => {}) } as never)
  ctx.provide('uiSession', { sessionStatus: createSnapshotStore<SessionStatusSnapshot>(new Map()) } as never)
  const refreshSessions = vi.fn(async () => {})
  const registerTransport = vi.fn<ISessions['registerTransport']>(() => async () => {})
  const retainSession = vi.fn<ISessions['retain']>()
  ctx.provide('sessions', {
    create: sessionCreate, list: sessions, refresh: refreshSessions, registerTransport, binding: vi.fn(), retain: retainSession,
  } as never)
  await ctx.plugin(ModelDirectoryResolver).await()
  const fiber = ctx.plugin({ inject, apply })
  await fiber.await()
  if (initialChats !== null) controls.entries[1]!.replace({ type: 'snapshot', value: initialChats })
  if (autoSnapshot) controls.entries[0]!.replace({ type: 'snapshot', value: snapshot })
  const overlay = entries.find(entry => entry.name === 'shell.overlay')!.inject!() as TeamOverlaysInjected
  const sidebar = entries.find(entry => entry.name === 'sidebar.workspaces')!.inject!() as TeamSidebarInjected
  const settings = entries.find(entry => entry.name === 'sidebar.right.pane.tab' && entry.component === BotSettings)!.inject!() as BotSettingsInjected
  const modelControl = entries.find(entry => entry.name === 'conversation.input.model')!.inject!() as BotModelControlInjected
  const chatOverlay = entries.find(entry => entry.name === 'shell.overlay' && entry.component === ChatOverlay)!.inject!() as ChatOverlayInjected
  return { ctx, categories, remote, chatRemote, session, sessionCreate, locale, overlay, sidebar, settings, modelControl,
    chatOverlay,
    mountRemote, disposeRemote, entries, sessions, refreshSessions, workspaces, workspaceOpen, sessionOpen, pinSession, unpinSession,
    mountedSidebar, adoptedSurfaces, sidebarExpanded, toggleSidebar, openSettingsTab, registerTransport, retainSession, connection,
    connectionGeneration, scopedInput, submitInput,
    blockComposer, schedule, scheduleChanged, remoteOn, remoteListeners, questionSlots }
}

function modelProps(b: Awaited<ReturnType<typeof boot>>, sessionId: SessionId): BotModelControlProps {
  return { sessionId, useDirectory: bindSnapshotSelector(b.modelControl.hooks.directory), useChats: bindSnapshotSelector(b.modelControl.hooks.chats), useProjection: () => undefined,
    useSettingsRequest: bindSnapshotSelector(b.modelControl.hooks.settingsRequest), openSettings: b.modelControl.openSettings,
    completeSettings: b.modelControl.completeSettings, t: b.locale.bind('katcats.team') } as BotModelControlProps
}

function composerProps(b: Awaited<ReturnType<typeof boot>>, sessionId: SessionId): InputBarProps {
  const entry = b.entries.find(item => item.name === 'conversation.input.model')!
  const ModelControl = entry.component as typeof BotModelControl
  return {
    sessionId, variant: 'hero', SessionProvider: ({ children }) => children,
    useSession: bindSnapshotSelector(createSnapshotStore(sessionSnapshot(sessionId))),
    useSessions: bindSnapshotSelector(b.sessions), useWorkspaces: bindSnapshotSelector(b.workspaces),
    usePanelInfo: selector => selector({ activePanelId: null }),
    useSessionStatus: bindSnapshotSelector(createSnapshotStore<SessionStatusSnapshot>(new Map())),
    useSessionRetainInfo: () => undefined,
    useResource: (() => ({ status: 'none', value: undefined, failure: undefined })) as GlobalStandardProps['useResource'],
    ...allowAllAccess,
    useProjection: () => undefined,
    useConversation: bindSnapshotSelector(createSnapshotStore(conversationSnapshot())),
    useInput: selector => selector({ draft: '', attachmentIds: [], draftRev: 0, phase: 'plain', occurrences: [], queue: [] }),
    inputActions: undefined, keyboard: undefined,
    addFiles: () => null, useFileUploads: bindSnapshotSelector(createSnapshotStore({})),
    retryFileUpload: undefined, removeAttachment: () => {}, resolveDraftAttachments: () => [],
    toggleCommandMenu: vi.fn(), stop: vi.fn(),
    useBusyEnter: bindSnapshotSelector(createSnapshotStore<'queue' | 'steer'>('queue')),
    useStopShortcut: bindSnapshotSelector(createSnapshotStore<readonly string[]>([])),
    useNotices: selector => selector(null), useLexicon: selector => selector(new Map()),
    useMenuLauncher: bindSnapshotSelector(createSnapshotStore<string | null>(null)),
    t: makeTranslate(conversationZh, commonZh),
    renderSlot: ((name, owner) => name === 'conversation.input.model'
      ? <ModelControl {...modelProps(b, sessionId)} {...owner} /> : null) as InputBarProps['renderSlot'],
  }
}

describe('Katcats shell integration', () => {
  it.each(['before', 'after'] as const)('recovers both directories when their opening snapshot arrives %s connection reset', async (arrival) => {
    const b = await boot(sessionList(withOrdinaryBot.bots), false, null)
    try {
      if (arrival === 'before') {
        controls.entries[0]!.replace({ type: 'snapshot', value: withOrdinaryBot })
        controls.entries[1]!.replace({ type: 'snapshot', value: withGroup })
      }
      b.ctx.emit('connection/reset')
      expect(controls.entries[0]!.restart).toHaveBeenCalledOnce()
      expect(controls.entries[1]!.restart).toHaveBeenCalledOnce()
      expect(b.sidebar.hooks.directory.getSnapshot().phase).toBe('loading')
      expect(b.sidebar.hooks.chats.getSnapshot().phase).toBe('loading')

      controls.entries[0]!.replace({ type: 'snapshot', value: withOrdinaryBot })
      expect(b.sidebar.hooks.directory.getSnapshot().phase).toBe('ready')
      expect(b.sidebar.hooks.chats.getSnapshot().phase).toBe('loading')
      controls.entries[1]!.replace({ type: 'snapshot', value: withGroup })
      expect(b.sidebar.hooks.directory.getSnapshot()).toMatchObject({ phase: 'ready', snapshot: withOrdinaryBot })
      expect(b.sidebar.hooks.chats.getSnapshot()).toMatchObject({ phase: 'ready', snapshot: withGroup })
    } finally { await b.ctx.fiber.dispose() }
  })

  it('keeps retained directories loading when a previous connection mutation settles before fresh snapshots', async () => {
    const b = await boot(sessionList(withOrdinaryBot.bots), false, null)
    try {
      controls.entries[0]!.replace({ type: 'snapshot', value: withOrdinaryBot })
      controls.entries[1]!.replace({ type: 'snapshot', value: withGroup })
      const pending = Promise.withResolvers<Awaited<ReturnType<TeamRemote['updateBot']>>>()
      vi.mocked(b.remote.updateBot).mockReturnValueOnce(pending.promise)
      const moving = b.sidebar.entityActions.move(ordinaryEntity, snapshot.groups[0]!.id)
      b.ctx.emit('connection/reset')
      pending.resolve({ ok: true, value: { bot: ordinaryBot, snapshot: { ...withOrdinaryBot, revision: 99 } } })
      await expect(moving).rejects.toThrow('connection changed')
      expect(b.sidebar.hooks.directory.getSnapshot()).toMatchObject({ phase: 'loading', snapshot: withOrdinaryBot })
      expect(b.sidebar.hooks.chats.getSnapshot()).toMatchObject({ phase: 'loading', snapshot: withGroup })
    } finally { await b.ctx.fiber.dispose() }
  })

  it('reports clipboard success and refusal consistently from messages, settings and both room views', async () => {
    const b = await boot()
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      const relay = b.entries.find(entry => entry.component === ChatRelayMessage)!.inject!() as ChatRelayActionsInjected
      const headquarters = b.entries.find(entry => entry.component === Headquarters)!.inject!() as HeadquartersInjected
      const settings = b.entries.find(entry => entry.component === ChatSettings)!.inject as (id: SessionId) => ChatSettingsInjected
      const room = b.entries.find(entry => entry.component === GroupRoomAction)!.inject as (id: SessionId) => GroupRoomInjected
      relay.copyRelayText('Recorded message body')
      await waitFor(() => { expect(b.overlay.hooks.teamUi.getSnapshot().notice).toMatchObject({ key: 'copy.copied', success: true }) })
      await settings(groupChat.rootSessionId).copyText('Recorded task goal')
      await room(groupChat.rootSessionId).copyText('Recorded member name')
      await headquarters.copyText('Recorded task ID')
      expect(writeText.mock.calls.map(([text]) => text)).toEqual([
        'Recorded message body', 'Recorded task goal', 'Recorded member name', 'Recorded task ID',
      ])
      writeText.mockRejectedValueOnce(new Error('synthetic clipboard permission refused'))
      await headquarters.copyText('Restricted text')
      expect(b.overlay.hooks.teamUi.getSnapshot().notice).toMatchObject({ key: 'copy.failed', success: false })
      expect(b.remote.updateBot).not.toHaveBeenCalled()
      expect(b.chatRemote.updateChat).not.toHaveBeenCalled()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('ignores late clipboard feedback and further actions after plugin disposal', async () => {
    const b = await boot()
    let finish!: () => void
    const writeText = vi.fn<(text: string) => Promise<void>>(() => new Promise(resolve => { finish = resolve }))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const headquarters = b.entries.find(entry => entry.component === Headquarters)!.inject!() as HeadquartersInjected
    const pending = headquarters.copyText('Pending copy')
    await b.ctx.fiber.dispose()
    finish()
    await pending
    await headquarters.copyText('Disposed copy')
    expect(writeText).toHaveBeenCalledExactlyOnceWith('Pending copy')
    expect(b.overlay.hooks.teamUi.getSnapshot().notice).toBeNull()
  })

  it('opens an existing member from a message and visibly rejects a member removed from the directory', async () => {
    const b = await boot(sessionList([...snapshot.bots, ordinaryBot]))
    try {
      controls.entries[0]!.update({ type: 'replace', value: withOrdinaryBot })
      const relay = b.entries.find(entry => entry.component === ChatRelayMessage)!.inject!() as ChatRelayActionsInjected
      b.sessionOpen.mockClear()
      relay.openRelayMember(ordinaryBot.id)
      expect(b.sessionOpen).toHaveBeenCalledExactlyOnceWith(ordinaryBot.sessionId)
      controls.entries[0]!.update({ type: 'replace', value: { ...snapshot, revision: 2 } })
      relay.openRelayMember(ordinaryBot.id)
      expect(b.sessionOpen).toHaveBeenCalledOnce()
      expect(b.overlay.hooks.teamUi.getSnapshot().notice).toMatchObject({ key: 'team.openFailed', success: false })
    } finally { await b.ctx.fiber.dispose() }
  })

  it('mounts the actual group question registrations alongside an already-owned ordinary composer', async () => {
    const b = await boot(sessionList(snapshot.bots), true, emptyChats, true)
    try {
      expect(b.questionSlots.entriesOfSlot('conversation.composer')).toHaveLength(1)
      expect(b.questionSlots.entriesOfSlot('conversation.input.dock').map(entry => entry.options.id))
        .toEqual(['katcats-team.worker-approvals', 'katcats-team.worker-questions', 'katcats-team.chat-controls'])
      expect(b.questionSlots.entriesOfSlot('katcats.group.question-panel')).toHaveLength(1)
      expect(b.sidebar.hooks.directory.getSnapshot().snapshot?.mainBotId).toBe(snapshot.mainBotId)
    } finally { await b.ctx.fiber.dispose() }
    expect(b.questionSlots.entriesOfSlot('katcats.group.question-panel')).toHaveLength(0)
    expect(b.questionSlots.entriesOfSlot('conversation.composer')).toHaveLength(1)
  })

  it.each([ordinaryEntity, groupEntity])('pins, unpins and copies the public $kind conversation without using a worker', async (entity) => {
    const b = await boot()
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      controls.entries[0]!.update({ type: 'replace', value: withOrdinaryBot })
      controls.entries[1]!.update({ type: 'replace', value: withGroup })
      expect(b.sidebar.hooks.workspaces).toBe(b.workspaces)
      b.sessionOpen.mockClear()
      await b.sidebar.entityActions.pin(entity, true)
      await b.sidebar.entityActions.pin(entity, false)
      await b.sidebar.entityActions.copyId(entity)
      expect(b.pinSession).toHaveBeenCalledExactlyOnceWith(entity.sessionId)
      expect(b.unpinSession).toHaveBeenCalledExactlyOnceWith(entity.sessionId)
      expect(writeText).toHaveBeenCalledExactlyOnceWith(entity.sessionId)
      expect(writeText).not.toHaveBeenCalledWith(groupChat.executors[0]!.sessionId)
      expect(b.workspaces.getSnapshot().pinnedSessionIds).toEqual([])
      expect(b.overlay.hooks.teamUi.getSnapshot().notice).toMatchObject({ key: 'entity.copied', success: true })
      expect(b.sessionOpen).not.toHaveBeenCalled()
      expect(b.remote.updateBot).not.toHaveBeenCalled()
      expect(b.chatRemote.updateChat).not.toHaveBeenCalled()
      expect(b.sessionCreate).not.toHaveBeenCalled()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('propagates unavailable pin and clipboard actions without optimistic state or a copied-success notice', async () => {
    const b = await boot()
    const clipboardError = new Error('synthetic clipboard unavailable')
    const writeText = vi.fn<(text: string) => Promise<void>>().mockRejectedValue(clipboardError)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      controls.entries[0]!.update({ type: 'replace', value: withOrdinaryBot })
      b.pinSession.mockRejectedValueOnce(new Error('synthetic pin refused'))
      await expect(b.sidebar.entityActions.pin(ordinaryEntity, true)).rejects.toThrow('synthetic pin refused')
      await expect(b.sidebar.entityActions.copyId(ordinaryEntity)).rejects.toBe(clipboardError)
      expect(b.workspaces.getSnapshot().pinnedSessionIds).toEqual([])
      expect(b.overlay.hooks.teamUi.getSnapshot().notice).toBeNull()
      expect(b.sidebar.hooks.directory.getSnapshot().snapshot).toEqual(withOrdinaryBot)
    } finally { await b.ctx.fiber.dispose() }
  })

  it.each([ordinaryEntity, groupEntity])('retains current navigation when deleting an unselected $kind entity', async (entity) => {
    const b = await boot()
    try {
      controls.entries[0]!.update({ type: 'replace', value: withOrdinaryBot })
      controls.entries[1]!.update({ type: 'replace', value: withGroup })
      b.sessionOpen.mockClear()
      const selected = b.mountedSidebar.getSnapshot()
      b.sidebar.entityActions.remove(entity)
      if (entity.kind === 'bot') {
        vi.mocked(b.remote.deleteBot).mockResolvedValueOnce({ ok: true, value: { ...snapshot, revision: 2 } })
      } else {
        vi.mocked(b.chatRemote.deleteChat).mockResolvedValueOnce({ ok: true, value: { ...emptyChats, revision: 2 } })
      }
      render(<OverlayUnderTest useTeamUi={bindSnapshotSelector(b.overlay.hooks.teamUi)}
        {...b.overlay} t={b.locale.bind('katcats.team')} />)
      fireEvent.click(screen.getByRole('button', { name: zh[entity.kind === 'bot' ? 'team.deleteBot' : 'team.deleteChat'] }))
      await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
      expect(entity.kind === 'bot' ? b.remote.deleteBot : b.chatRemote.deleteChat)
        .toHaveBeenCalledExactlyOnceWith({ id: entity.id })
      expect(b.sessionOpen).not.toHaveBeenCalled()
      expect(b.mountedSidebar.getSnapshot()).toBe(selected)
      expect(b.sessionCreate).not.toHaveBeenCalled()
    } finally { await b.ctx.fiber.dispose() }
  })

  it.each([ordinaryEntity, groupEntity])('does not undo newer navigation when pending $kind deletion finishes', async (entity) => {
    const b = await boot()
    try {
      controls.entries[0]!.update({ type: 'replace', value: withOrdinaryBot })
      controls.entries[1]!.update({ type: 'replace', value: withGroup })
      b.sessions.set(sessionList([...withOrdinaryBot.bots,
        { name: groupChat.name, sessionId: groupChat.rootSessionId }], entity.sessionId))
      let finish!: () => void
      if (entity.kind === 'bot') {
        vi.mocked(b.remote.deleteBot).mockImplementationOnce(() => new Promise((resolve) => {
          finish = () => { resolve({ ok: true, value: { ...snapshot, revision: 2 } }) }
        }))
      } else {
        vi.mocked(b.chatRemote.deleteChat).mockImplementationOnce(() => new Promise((resolve) => {
          finish = () => { resolve({ ok: true, value: { ...emptyChats, revision: 2 } }) }
        }))
      }
      b.sidebar.entityActions.remove(entity)
      const pending = b.overlay.deleteEntity(entity)
      b.sidebar.commands.openBot(snapshot.mainBotId)
      b.sessionOpen.mockClear()
      finish()
      await pending
      expect(b.sessionOpen).not.toHaveBeenCalled()
      expect(b.mountedSidebar.getSnapshot()).toBe(snapshot.bots[0]!.sessionId)
      expect(b.overlay.hooks.teamUi.getSnapshot().dialog).toBeNull()
    } finally { await b.ctx.fiber.dispose() }
  })

  it.each([
    { entity: ordinaryEntity, reason: 'bot-running', key: 'entity.deleteRunning' },
    { entity: groupEntity, reason: 'chat-busy', key: 'entity.deleteBusy' },
    { entity: groupEntity, reason: 'session-active', key: 'entity.deleteBusy' },
    { entity: groupEntity, reason: 'active-automations', key: 'entity.deleteScheduled' },
    { entity: ordinaryEntity, reason: 'delete-incomplete', key: 'entity.deleteFailed' },
  ] as const)('keeps the $entity.kind dialog and saved rows when the Host refuses $reason', async ({ entity, reason, key }) => {
    const b = await boot()
    try {
      controls.entries[0]!.update({ type: 'replace', value: withOrdinaryBot })
      controls.entries[1]!.update({ type: 'replace', value: withGroup })
      b.sessionOpen.mockClear()
      b.sidebar.entityActions.remove(entity)
      const error = new RemoteError('katcats/organization', 'synthetic internal detail; never show raw text', { reason })
      if (entity.kind === 'bot') vi.mocked(b.remote.deleteBot).mockResolvedValueOnce({ ok: false, error })
      else vi.mocked(b.chatRemote.deleteChat).mockResolvedValueOnce({ ok: false, error })
      render(<OverlayUnderTest useTeamUi={bindSnapshotSelector(b.overlay.hooks.teamUi)}
        {...b.overlay} t={b.locale.bind('katcats.team')} />)
      fireEvent.click(screen.getByRole('button', { name: zh[entity.kind === 'bot' ? 'team.deleteBot' : 'team.deleteChat'] }))
      await waitFor(() => { expect(screen.getByText(zh[key])).toBeTruthy() })
      expect(screen.queryByText(error.message)).toBeNull()
      expect(screen.getByRole('dialog')).toBeTruthy()
      expect(b.overlay.hooks.teamUi.getSnapshot().dialog).toMatchObject({ kind: 'delete-entity', entity })
      expect(b.sidebar.hooks.directory.getSnapshot().snapshot).toEqual(withOrdinaryBot)
      expect(b.sidebar.hooks.chats.getSnapshot().snapshot).toEqual(withGroup)
      expect(b.sessionOpen).not.toHaveBeenCalled()
    } finally { await b.ctx.fiber.dispose() }
  })

  it.each(['bot', 'chat'] as const)('routes the %s name-only dialog to its own saved record', async (kind) => {
    const b = await boot()
    try {
      const writer: TeamBot = { ...snapshot.bots[0]!, kind: 'ordinary', id: 'writer' as BotId,
        name: 'Writer', groupId: snapshot.groups[0]!.id, sessionId: 'writer-session' as SessionId }
      const team = { ...snapshot, revision: 1, bots: [...snapshot.bots, writer] }
      controls.entries[0]!.update({ type: 'replace', value: team })
      controls.entries[1]!.update({ type: 'replace', value: withGroup })
      const entity = kind === 'bot' ? { ...writer, kind, currentGroup: writer.groupId }
        : { ...groupChat, kind, sessionId: groupChat.rootSessionId, currentGroup: groupChat.groupId }
      b.sidebar.entityActions.rename(entity)
      expect(b.overlay.hooks.teamUi.getSnapshot().dialog).toMatchObject({ kind: 'rename-entity', entity })
      if (kind === 'bot') vi.mocked(b.remote.updateBot).mockResolvedValueOnce({ ok: true, value: {
        bot: { ...writer, name: 'Renamed' }, snapshot: { ...team, revision: 2, bots: [...snapshot.bots, { ...writer, name: 'Renamed' }] },
      } })
      else vi.mocked(b.chatRemote.updateChat).mockResolvedValueOnce({ ok: true, value: {
        chat: { ...groupChat, name: 'Renamed' }, snapshot: { ...withGroup, revision: 2, chats: [{ ...groupChat, name: 'Renamed' }] },
      } })
      await b.overlay.renameEntity(entity, 'Renamed')
      expect(kind === 'bot' ? b.remote.updateBot : b.chatRemote.updateChat).toHaveBeenCalledExactlyOnceWith({ id: entity.id, name: 'Renamed' })
      expect(kind === 'bot' ? b.chatRemote.updateChat : b.remote.updateBot).not.toHaveBeenCalled()
      expect(b.overlay.hooks.teamUi.getSnapshot()).toMatchObject({ dialog: null, notice: { key: 'entity.saved', success: true } })
    } finally { await b.ctx.fiber.dispose() }
  })

  it.each(['bot', 'chat'] as const)('confirms actual %s deletion and returns its selected conversation to the main Bot', async (kind) => {
    const b = await boot()
    try {
      const writer: TeamBot = { ...snapshot.bots[0]!, kind: 'ordinary', id: 'writer' as BotId,
        name: 'Writer', groupId: snapshot.groups[0]!.id, sessionId: 'writer-session' as SessionId }
      const team = { ...snapshot, revision: 1, bots: [...snapshot.bots, writer] }
      controls.entries[0]!.update({ type: 'replace', value: team })
      controls.entries[1]!.update({ type: 'replace', value: withGroup })
      const entity = kind === 'bot' ? { ...writer, kind, currentGroup: writer.groupId }
        : { ...groupChat, kind, sessionId: groupChat.rootSessionId, currentGroup: groupChat.groupId }
      b.sessions.set(sessionList([...snapshot.bots, writer, { name: groupChat.name, sessionId: groupChat.rootSessionId }], entity.sessionId))
      b.sidebar.entityActions.remove(entity)
      expect(b.remote.deleteBot).not.toHaveBeenCalled()
      expect(b.chatRemote.deleteChat).not.toHaveBeenCalled()
      expect(b.overlay.hooks.teamUi.getSnapshot().dialog).toMatchObject({ kind: 'delete-entity', entity })
      if (kind === 'bot') vi.mocked(b.remote.deleteBot).mockResolvedValueOnce({ ok: true, value: { ...snapshot, revision: 2 } })
      else vi.mocked(b.chatRemote.deleteChat).mockResolvedValueOnce({ ok: true, value: { ...emptyChats, revision: 2 } })
      await b.overlay.deleteEntity(entity)
      expect(kind === 'bot' ? b.remote.deleteBot : b.chatRemote.deleteChat).toHaveBeenCalledExactlyOnceWith({ id: entity.id })
      expect(b.overlay.hooks.teamUi.getSnapshot()).toMatchObject({ dialog: null,
        notice: { key: 'entity.deleted', success: true, name: entity.name } })
      expect(b.ctx.uiWorkspace.openSession).toHaveBeenLastCalledWith(snapshot.bots[0]!.sessionId)
      expect(b.sessionCreate).not.toHaveBeenCalled()
    } finally { await b.ctx.fiber.dispose() }
  })

  it.each(['bot-in-group', 'active-automations'] as const)('keeps a refused entity deletion and localizes %s', async (reason) => {
    const b = await boot()
    try {
      const entity = { ...snapshot.bots[0]!, kind: 'bot' as const, currentGroup: null }
      b.sidebar.entityActions.remove(entity)
      vi.mocked(b.remote.deleteBot).mockResolvedValueOnce({ ok: false,
        error: new RemoteError('katcats/organization', 'synthetic rejected deletion', { reason }) })
      await b.overlay.deleteEntity(entity)
      expect(b.overlay.hooks.teamUi.getSnapshot().dialog).toMatchObject({ kind: 'delete-entity', entity })
      expect(b.overlay.hooks.teamUi.getSnapshot().notice).toMatchObject({
        key: reason === 'bot-in-group' ? 'entity.deleteInGroup' : 'entity.deleteScheduled', success: false,
      })
      expect(b.sidebar.hooks.directory.getSnapshot().snapshot).toEqual(snapshot)
    } finally { await b.ctx.fiber.dispose() }
  })

  it('uses the registered group commands and accepts one directory replacement without creating Sessions', async () => {
    const b = await boot()
    try {
      const editorial = { id: 'editorial' as GroupId, name: 'Editorial', kind: 'bots', system: false } as const
      const research = { id: 'research' as GroupId, name: 'Research', kind: 'bots', system: false } as const
      const writer: TeamBot = { ...snapshot.bots[0]!, id: 'writer' as BotId, kind: 'ordinary', name: 'Writer',
        groupId: editorial.id, sessionId: 'writer-session' as SessionId, workDir: '/synthetic/writer' }
      const before = { ...snapshot, revision: 1, groups: [...snapshot.groups, editorial, research], bots: [...snapshot.bots, writer] }
      controls.entries[0]!.update({ type: 'replace', value: before })
      const moved = { ...before, revision: 2, groups: [...snapshot.groups, research, editorial] }
      vi.mocked(b.remote.moveGroup).mockResolvedValueOnce({ ok: true, value: moved })
      await b.sidebar.commands.moveGroup({ id: research.id, direction: 'up' })
      expect(b.remote.moveGroup).toHaveBeenCalledExactlyOnceWith({ id: research.id, direction: 'up' })
      expect(b.sidebar.hooks.directory.getSnapshot().snapshot).toEqual(moved)

      b.sidebar.commands.removeGroup(editorial)
      expect(b.remote.removeGroup).not.toHaveBeenCalled()
      render(<OverlayUnderTest useTeamUi={bindSnapshotSelector(b.overlay.hooks.teamUi)} {...b.overlay} t={b.locale.bind('katcats.team')} />)
      const removed = { ...moved, revision: 3, groups: moved.groups.filter(group => group.id !== editorial.id),
        bots: moved.bots.map(bot => bot.id === writer.id ? { ...bot, groupId: snapshot.groups[0]!.id } : bot) }
      vi.mocked(b.remote.removeGroup).mockResolvedValueOnce({ ok: true, value: removed })
      fireEvent.click(screen.getByRole('button', { name: zh['team.removeGroup'] }))
      await waitFor(() => { expect(b.remote.removeGroup).toHaveBeenCalledExactlyOnceWith({ id: editorial.id }) })
      await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
      expect(b.sidebar.hooks.directory.getSnapshot().snapshot).toEqual(removed)
      expect(b.overlay.hooks.teamUi.getSnapshot().notice).toMatchObject({ key: 'team.groupRemoved', success: true, name: editorial.name })
      expect(b.sessionCreate).not.toHaveBeenCalled()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('keeps a refused deletion open with the saved group and reports an uncertain replaced-connection result', async () => {
    const b = await boot()
    try {
      const group = { id: 'editorial' as GroupId, name: 'Editorial', kind: 'bots', system: false } as const
      const before = { ...snapshot, revision: 1, groups: [...snapshot.groups, group] }
      controls.entries[0]!.update({ type: 'replace', value: before })
      b.sidebar.commands.removeGroup(group)
      vi.mocked(b.remote.removeGroup).mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'synthetic deletion failed', {}) })
      await b.overlay.removeGroup({ id: group.id })
      expect(b.overlay.hooks.teamUi.getSnapshot().dialog).toMatchObject({ kind: 'remove-group', group })
      expect(b.overlay.hooks.teamUi.getSnapshot().notice).toMatchObject({ key: 'team.groupRemoveFailed', success: false })
      expect(b.sidebar.hooks.directory.getSnapshot().snapshot).toEqual(before)

      let finish!: (value: Awaited<ReturnType<TeamRemote['removeGroup']>>) => void
      vi.mocked(b.remote.removeGroup).mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
      const removing = b.overlay.removeGroup({ id: group.id })
      await b.ctx.emit('connection/reset')
      finish({ ok: true, value: { ...snapshot, revision: 2 } })
      await removing
      expect(b.overlay.hooks.teamUi.getSnapshot().dialog).toMatchObject({ kind: 'remove-group', group })
      expect(b.overlay.hooks.teamUi.getSnapshot().notice).toMatchObject({ key: 'team.outcomeUnknown', success: false })
      expect(b.sidebar.hooks.directory.getSnapshot().snapshot).toEqual(before)
    } finally { await b.ctx.fiber.dispose() }
  })

  it('shadows the existing automation main panel through the public keyed-slot priority and restores its original view on unload', async () => {
    const b = await boot()
    try {
      const product = b.entries.find(entry => entry.component === ScheduleManager)!
      expect(product).toMatchObject({ name: 'main', key: 'schedules', priority: -100 })
      const injected = product.inject!() as ScheduleViewsInjected
      const core = new SlotCore()
      const Root = (_props: PropsRenderSlots<'main'>) => null
      const Original = () => null
      const closeRoot = core.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' } } }, Root)
      const closeOriginal = core.register({ name: 'main', key: 'schedules' as MainPanelId }, Original)
      const closeProduct = core.register({ name: 'main', key: 'schedules' as MainPanelId, ...(product.priority === undefined ? {} : { priority: product.priority }),
        locale: SCHEDULE_NS, inject: () => injected }, ScheduleManager)
      expect(core.entriesOfSlot('main')[0]?.component).toBe(ScheduleManager)
      expect(core.entries('main')).toHaveLength(2)
      closeProduct()
      expect(core.entriesOfSlot('main')[0]?.component).toBe(Original)
      closeOriginal(); closeRoot()
      expect(core.entriesOfSlot('main')).toEqual([])
    } finally { await b.ctx.fiber.dispose() }
  })

  it('shares the automation catalog across registered scoped and aggregate views and opens worker tasks with the original binding', async () => {
    const b = await boot(sessionList([...snapshot.bots, { name: groupChat.name, sessionId: groupChat.rootSessionId }]), true, withGroup)
    const task: ScheduleCatalogEntry = { id: 'worker-schedule' as ScheduleId, kind: 'at', title: 'Editorial review',
      prompt: 'Read and review the shared draft', scheduledAt: '2099-01-01T00:00:00.000Z', status: 'active',
      sessionId: groupChat.executors[0]!.sessionId }
    try {
      const main = b.entries.find(entry => entry.component === ScheduleManager)!.inject!() as ScheduleViewsInjected
      const scoped = b.entries.find(entry => entry.component === ScheduleList)!.inject!() as ScheduleViewsInjected
      expect(main.hooks.schedules).toBe(scoped.hooks.schedules)
      expect(b.schedule.catalog).not.toHaveBeenCalled()
      b.schedule.catalog.mockResolvedValueOnce({ ok: true, value: [task] })
      const bound = { useSchedules: bindSnapshotSelector(main.hooks.schedules), useDirectory: bindSnapshotSelector(main.hooks.directory),
        useChats: bindSnapshotSelector(main.hooks.chats), reload: main.reload, openTask: main.openTask, t: b.locale.bind(SCHEDULE_NS) }
      const view = render(<><ScheduleManager {...bound as ScheduleManagerProps} />
        <ScheduleList {...bound as ScheduleListProps} sessionId={groupChat.rootSessionId} /></>)
      await waitFor(() => { expect(screen.getAllByText(task.title)).toHaveLength(2) })
      expect(b.schedule.catalog).toHaveBeenCalledOnce()
      expect(b.remoteOn.mock.calls.filter(([name]) => name === 'schedule/changed'))
        .toEqual([['schedule/changed', expect.any(Function)]])
      fireEvent.click(screen.getAllByRole('button', { name: b.locale.bind(SCHEDULE_NS)('detail', { name: task.title }) })[0]!)
      expect(b.openSettingsTab).toHaveBeenCalledExactlyOnceWith('scheduleTask', { params: { sessionId: task.sessionId, id: task.id } })
      b.schedule.catalog.mockResolvedValueOnce({ ok: true, value: [] })
      act(() => { for (const changed of b.scheduleChanged) changed() })
      await waitFor(() => { expect(screen.queryByText(task.title)).toBeNull() })
      view.unmount()
      expect(b.scheduleChanged.size).toBe(0)
      expect(b.sessionCreate).not.toHaveBeenCalled()
      expect(b.chatRemote.sendMessage).not.toHaveBeenCalled()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('opens the scoped automation list only for the currently selected settings Session', async () => {
    const b = await boot()
    try {
      const main = snapshot.bots[0]!
      b.settings.openSchedules(main.sessionId)
      expect(b.openSettingsTab).toHaveBeenCalledExactlyOnceWith('katcats-schedules')
      b.sessions.set(sessionList(snapshot.bots))
      b.settings.openSchedules(main.sessionId)
      expect(b.openSettingsTab).toHaveBeenCalledOnce()
      expect(b.schedule.catalog).not.toHaveBeenCalled()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('connects only group-container Sessions to product send and cancel handlers', async () => {
    const b = await boot(sessionList([...snapshot.bots, { name: groupChat.name, sessionId: groupChat.rootSessionId }]), true, withGroup)
    try {
      expect(b.registerTransport).toHaveBeenCalledTimes(1)
      expect(b.registerTransport.mock.calls[0]?.[0]).toBe(groupChat.rootSessionId)
      const transport = b.registerTransport.mock.calls[0]?.[1]
      if (transport === undefined) throw new Error('missing group transport')
      vi.mocked(b.chatRemote.sendMessage).mockResolvedValueOnce({ ok: true, value: { accepted: true } })
      vi.mocked(b.chatRemote.cancelSession).mockResolvedValueOnce({ ok: true, value: { accepted: true } })
      const request = { sessionId: groupChat.rootSessionId,
        requestId: 'container-request' as Parameters<ChatRemote['sendMessage']>[0]['requestId'],
        mode: 'queue' as const, content: [{ type: 'text' as const, text: 'Hello members' }] }
      const caller = new AbortController()
      await transport.prompt(request, caller.signal)
      expect(b.chatRemote.sendMessage).toHaveBeenCalledExactlyOnceWith(request, caller.signal)
      await transport.cancel({ sessionId: groupChat.rootSessionId })
      expect(b.chatRemote.cancelSession).toHaveBeenCalledExactlyOnceWith({ sessionId: groupChat.rootSessionId })
      expect(b.registerTransport.mock.calls.some(([id]) => id === snapshot.bots[0]?.sessionId)).toBe(false)
    } finally { await b.ctx.fiber.dispose() }
  })

  it('mounts its own namespace before dependent UI and unregisters it on disposal', async () => {
    const b = await boot()
    expect(inject).toEqual(['remote'])
    expect(b.mountRemote).toHaveBeenCalledOnce()
    expect(b.ctx.get('remote.katcatsChats')).toBe(b.chatRemote)
    expect(b.entries.some(entry => entry.name === 'conversation.session.header.actions')).toBe(true)
    expect(b.entries.some(entry => entry.name === 'conversation.session.header.actions'
      && entry.component === GroupRoomAction)).toBe(true)
    expect(b.entries.some(entry => entry.name === 'conversation.session.header.lineage')).toBe(false)
    await b.ctx.fiber.dispose()
    expect(b.disposeRemote).toHaveBeenCalledOnce()
    expect(b.entries).toEqual([])
  })

  it('creates a group through its own dialog and opens first-blank settings from the real composer lifecycle', async () => {
    const b = await boot()
    try {
      const main = snapshot.bots[0]!
      const writer = { ...main, id: 'writer' as BotId, kind: 'ordinary' as const, groupId: snapshot.groups[0]!.id,
        name: 'Writer', sessionId: 'writer-private' as SessionId }
      controls.entries[0]!.update({ type: 'replace', value: { ...snapshot, revision: 1, bots: [main, writer] } })
      vi.mocked(b.chatRemote.createChat).mockResolvedValueOnce({ ok: true, value: { chat: groupChat, snapshot: withGroup } })
      b.refreshSessions.mockImplementationOnce(async () => { b.sessions.set(sessionList([main, writer,
        { name: groupChat.name, sessionId: groupChat.rootSessionId }], main.sessionId)) })
      b.sidebar.commands.createChat()
      const props = { close: b.chatOverlay.close, create: b.chatOverlay.create,
        useTeamUi: bindSnapshotSelector(b.chatOverlay.hooks.teamUi), useDirectory: bindSnapshotSelector(b.chatOverlay.hooks.directory),
        useChats: bindSnapshotSelector(b.chatOverlay.hooks.chats), t: b.locale.bind('katcats.team') } as ChatOverlayProps
      const dialog = render(<ChatOverlay {...props} />)
      fireEvent.change(screen.getByLabelText(zh['chat.name']), { target: { value: groupChat.name } })
      fireEvent.click(screen.getByRole('checkbox', { name: writer.name }))
      fireEvent.click(screen.getByRole('button', { name: zh['team.create'] }))
      await waitFor(() => { expect(b.ctx.uiWorkspace.openSession).toHaveBeenLastCalledWith(groupChat.rootSessionId) })
      expect(b.sidebar.hooks.sidebarReveal.getSnapshot()).toMatchObject({
        sessionId: groupChat.rootSessionId, groupId: groupChat.groupId,
      })
      expect(b.chatRemote.createChat).toHaveBeenCalledExactlyOnceWith({ name: groupChat.name, memberIds: [writer.id], managerId: null, relayLimit: 6 })
      expect(b.openSettingsTab).not.toHaveBeenCalled()
      expect(b.remote.createBot).not.toHaveBeenCalled()
      dialog.unmount()
      b.adoptedSurfaces.add(groupChat.rootSessionId)
      render(<InputBar {...composerProps(b, groupChat.rootSessionId)} />)
      expect(b.openSettingsTab).toHaveBeenCalledExactlyOnceWith('katcats-chat-settings')
      expect(b.modelControl.hooks.settingsRequest.getSnapshot()).toBeNull()
      expect(b.sessionCreate).not.toHaveBeenCalled()
      expect(b.workspaceOpen).not.toHaveBeenCalled()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('defaults to the main Bot instead of restoring a group, then allows explicit group navigation', async () => {
    const b = await boot(sessionList([...snapshot.bots, { name: groupChat.name, sessionId: groupChat.rootSessionId }],
      groupChat.rootSessionId), false, withGroup)
    try {
      controls.entries[0]!.replace({ type: 'snapshot', value: snapshot })
      expect(b.ctx.uiWorkspace.openSession).toHaveBeenCalledExactlyOnceWith(snapshot.bots[0]!.sessionId)
      b.sidebar.commands.openChat(groupChat.id)
      b.modelControl.openSettings()
      expect(b.openSettingsTab).toHaveBeenCalledExactlyOnceWith('katcats-chat-settings')
    } finally { await b.ctx.fiber.dispose() }
  })

  it('includes only a group root Workspace and keeps its shared folder popup read-only', async () => {
    const b = await boot()
    try {
      controls.entries[1]!.update({ type: 'replace', value: withGroup })
      b.sessions.set(sessionList([...snapshot.bots, { name: groupChat.name, sessionId: groupChat.rootSessionId }], snapshot.bots[0]!.sessionId))
      const workspace: WorkspaceView = { workspaceId: 'editorial-workspace' as WorkspaceId, path: groupChat.workDir,
        title: groupChat.name, sessionIds: [groupChat.rootSessionId], createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z' }
      b.workspaces.set({ ...b.workspaces.getSnapshot(), items: [workspace] })
      expect(b.categories.store.getSnapshot().categories.find(item => item.id === 'katcats-team')?.workspaceIds).toEqual([workspace.workspaceId])
      b.sidebar.commands.openChat(groupChat.id)
      const entry = b.entries.find(item => item.name === 'conversation.hero.workspace')!
      expect(entry.component).toBe(ChatFolderInfo)
      const injected = entry.inject!() as { hooks: { chats: typeof b.modelControl.hooks.chats } }
      const onPick = vi.fn()
      render(<ChatFolderInfo {...{ open: true, onClose: vi.fn(), onPick, anchorRef: { current: document.createElement('button') },
        useSessions: bindSnapshotSelector(b.sessions), useChats: bindSnapshotSelector(injected.hooks.chats),
        t: b.locale.bind('katcats.team') } as ChatFolderInfoProps} />)
      expect(screen.getByRole('group', { name: zh['chat.folder'] }).textContent).toContain(groupChat.workDir)
      expect(screen.queryByRole('menuitem')).toBeNull()
      expect(onPick).not.toHaveBeenCalled()
      expect(b.workspaceOpen).not.toHaveBeenCalled()
      expect(b.sessionCreate).not.toHaveBeenCalled()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('delegates the shared new-session action to a create dialog and cancellation creates nothing', async () => {
    const b = await boot()
    try {
      expect(b.categories.store.getSnapshot().activeCategoryId).toBe('katcats-team')
      await b.categories.activate('katcats-team')
      const props: OverlayTestProps = { ...b.overlay, useTeamUi: bindSnapshotSelector(b.overlay.hooks.teamUi), t: b.locale.bind('katcats.team') }
      render(<OverlayUnderTest {...props} />)
      expect(screen.getByRole('dialog', { name: zh['team.newBot'] })).toBeTruthy()
      fireEvent.change(screen.getByLabelText(zh['bot.name']), { target: { value: 'Discard me' } })
      fireEvent.click(screen.getByRole('button', { name: zh['team.cancel'] }))
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(b.remote.createBot).not.toHaveBeenCalled()
      expect(b.sessionCreate).not.toHaveBeenCalled()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('creates and opens a member only after the Host confirms it is saved', async () => {
    const b = await boot()
    try {
      const bot = { ...snapshot.bots[0]!, id: 'writer' as BotId, kind: 'ordinary' as const, name: 'Writer', groupId: snapshot.groups[0]!.id,
        sessionId: 'writer-session' as SessionId, workDir: '/synthetic/writer' }
      b.refreshSessions.mockImplementationOnce(async () => { b.sessions.set(sessionList([...snapshot.bots, bot], snapshot.bots[0]!.sessionId)) })
      vi.mocked(b.remote.createBot).mockResolvedValueOnce({ ok: true, value: { bot, snapshot: { ...snapshot, revision: 1, bots: [...snapshot.bots, bot] } } })
      await act(async () => { await b.overlay.createBot({ name: 'Writer', groupId: snapshot.groups[0]!.id }) })
      expect(b.ctx.uiWorkspace.openSession).toHaveBeenLastCalledWith(bot.sessionId)
      expect(b.sidebar.hooks.sidebarReveal.getSnapshot()).toMatchObject({ sessionId: bot.sessionId, groupId: bot.groupId })
      expect(b.overlay.hooks.teamUi.getSnapshot().notice).toMatchObject({ key: 'team.created', name: 'Writer', success: true })
    } finally { await b.ctx.fiber.dispose() }
  })

  it('selects tool-created members in order and switches to the saved group, without reopening old rows on snapshots', async () => {
    const b = await boot()
    try {
      const reviewer = { ...ordinaryBot, id: 'reviewer' as BotId, name: 'Reviewer', sessionId: 'reviewer-private' as SessionId }
      const withTwoBots = { ...withOrdinaryBot, revision: 2, bots: [reviewer, ...withOrdinaryBot.bots] }
      b.sessions.set(sessionList([...snapshot.bots, ordinaryBot, reviewer,
        { name: groupChat.name, sessionId: groupChat.rootSessionId }], snapshot.bots[0]!.sessionId))
      controls.entries[0]!.update({ type: 'replace', value: withOrdinaryBot })
      expect(b.sessionOpen).toHaveBeenLastCalledWith(ordinaryBot.sessionId)
      expect(b.sidebar.hooks.sidebarReveal.getSnapshot()).toMatchObject({
        sessionId: ordinaryBot.sessionId, groupId: ordinaryBot.groupId,
      })
      controls.entries[0]!.update({ type: 'replace', value: withTwoBots })
      expect(b.sessionOpen).toHaveBeenLastCalledWith(reviewer.sessionId)
      controls.entries[1]!.update({ type: 'replace', value: withGroup })
      expect(b.sessionOpen).toHaveBeenLastCalledWith(groupChat.rootSessionId)
      expect(b.sidebar.hooks.sidebarReveal.getSnapshot()).toMatchObject({
        sessionId: groupChat.rootSessionId, groupId: groupChat.groupId,
      })
      b.sessionOpen.mockClear()
      controls.entries[0]!.update({ type: 'replace', value: { ...withTwoBots, revision: 3 } })
      controls.entries[1]!.update({ type: 'replace', value: { ...withGroup, revision: 2 } })
      controls.entries[0]!.replace({ type: 'snapshot', value: withTwoBots })
      controls.entries[1]!.replace({ type: 'snapshot', value: withGroup })
      expect(b.sessionOpen).not.toHaveBeenCalled()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('selects the newest entry when one directory update includes several new Bots or chats', async () => {
    const b = await boot()
    try {
      const reviewer = { ...ordinaryBot, id: 'reviewer' as BotId, name: 'Reviewer', sessionId: 'reviewer-private' as SessionId }
      const newestChat = { ...groupChat, id: 'newest-chat' as ChatId, name: 'Newest chat', rootSessionId: 'newest-chat-session' as SessionId }
      b.sessions.set(sessionList([...snapshot.bots, ordinaryBot, reviewer,
        { name: groupChat.name, sessionId: groupChat.rootSessionId },
        { name: newestChat.name, sessionId: newestChat.rootSessionId }], snapshot.bots[0]!.sessionId))
      controls.entries[0]!.update({ type: 'replace', value: { ...snapshot, revision: 1, bots: [snapshot.bots[0]!, reviewer, ordinaryBot] } })
      expect(b.sessionOpen).toHaveBeenLastCalledWith(reviewer.sessionId)
      controls.entries[1]!.update({ type: 'replace', value: { ...withGroup, chats: [newestChat, groupChat] } })
      expect(b.sessionOpen).toHaveBeenLastCalledWith(newestChat.rootSessionId)
    } finally { await b.ctx.fiber.dispose() }
  })

  it('waits for a tool-created Session to appear and yields if the user navigates elsewhere first', async () => {
    const b = await boot()
    try {
      controls.entries[0]!.update({ type: 'replace', value: withOrdinaryBot })
      await Promise.resolve()
      expect(b.sessionOpen).toHaveBeenCalledExactlyOnceWith(snapshot.bots[0]!.sessionId)
      expect(b.overlay.hooks.teamUi.getSnapshot().notice).toBeNull()
      b.sessions.set(sessionList([...snapshot.bots, ordinaryBot], snapshot.bots[0]!.sessionId))
      expect(b.sessionOpen).toHaveBeenLastCalledWith(ordinaryBot.sessionId)

      const reviewer = { ...ordinaryBot, id: 'reviewer' as BotId, name: 'Reviewer', sessionId: 'reviewer-private' as SessionId }
      controls.entries[0]!.update({ type: 'replace', value: { ...withOrdinaryBot, revision: 2,
        bots: [...withOrdinaryBot.bots, reviewer] } })
      b.sidebar.commands.openBot(snapshot.mainBotId)
      b.sessionOpen.mockClear()
      b.sessions.set(sessionList([...snapshot.bots, ordinaryBot, reviewer], snapshot.bots[0]!.sessionId))
      expect(b.sessionOpen).not.toHaveBeenCalled()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('opens new blank member settings through the real Hero composer model slot after surface adoption', async () => {
    const b = await boot()
    try {
      const bot = { ...snapshot.bots[0]!, id: 'writer' as BotId, kind: 'ordinary' as const, name: 'Writer', groupId: snapshot.groups[0]!.id,
        sessionId: 'writer-session' as SessionId, workDir: '/synthetic/writer' }
      b.refreshSessions.mockImplementationOnce(async () => { b.sessions.set(sessionList([...snapshot.bots, bot], snapshot.bots[0]!.sessionId)) })
      vi.mocked(b.remote.createBot).mockResolvedValueOnce({ ok: true, value: { bot, snapshot: { ...snapshot, revision: 1, bots: [...snapshot.bots, bot] } } })
      await b.overlay.createBot({ name: 'Writer' })
      await Promise.resolve()
      expect(b.ctx.uiWorkspace.openSession).toHaveBeenLastCalledWith(bot.sessionId)
      expect(b.adoptedSurfaces.has(bot.sessionId)).toBe(false)
      expect(b.openSettingsTab).not.toHaveBeenCalled()
      expect(b.overlay.hooks.teamUi.getSnapshot().notice).toMatchObject({ key: 'team.created', success: true })

      b.adoptedSurfaces.add(bot.sessionId)
      const props = composerProps(b, bot.sessionId)
      const view = render(<InputBar {...props} />)
      expect(b.openSettingsTab).toHaveBeenCalledExactlyOnceWith('katcats-bot-settings')
      expect(b.modelControl.hooks.settingsRequest.getSnapshot()).toBeNull()
      view.rerender(<InputBar {...props} variant="composer" />)
      expect(b.openSettingsTab).toHaveBeenCalledOnce()
      expect(b.overlay.hooks.teamUi.getSnapshot().notice).toMatchObject({ key: 'team.created', success: true })
    } finally { await b.ctx.fiber.dispose() }
  })

  it('ignores settings requests from earlier navigation, changed selection and replaced connections', async () => {
    const b = await boot()
    try {
      const main = snapshot.bots[0]!
      const old = b.modelControl.hooks.settingsRequest.getSnapshot()!
      expect(old.intent).toBe('collapse')
      b.sidebar.commands.openBot(main.id)
      const latest = b.modelControl.hooks.settingsRequest.getSnapshot()!
      expect(latest.intent).toBe('reveal')
      b.modelControl.completeSettings(old)
      expect(b.modelControl.hooks.settingsRequest.getSnapshot()).toBe(latest)
      expect(b.openSettingsTab).not.toHaveBeenCalled()
      expect(b.toggleSidebar).not.toHaveBeenCalled()

      b.sessions.set(sessionList(snapshot.bots))
      b.modelControl.completeSettings(latest)
      expect(b.openSettingsTab).not.toHaveBeenCalled()
      expect(b.modelControl.hooks.settingsRequest.getSnapshot()).toBeNull()

      b.sidebar.commands.openBot(main.id)
      const beforeReset = b.modelControl.hooks.settingsRequest.getSnapshot()!
      await b.ctx.emit('connection/reset')
      b.modelControl.completeSettings(beforeReset)
      expect(b.modelControl.hooks.settingsRequest.getSnapshot()).toBeNull()
      expect(b.openSettingsTab).not.toHaveBeenCalled()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('reports a settings failure independently after the member conversation was selected', async () => {
    const b = await boot()
    try {
      b.sidebar.commands.openBot(snapshot.mainBotId)
      b.openSettingsTab.mockImplementationOnce(() => { throw new Error('synthetic settings failure') })
      render(<BotModelControl {...modelProps(b, snapshot.bots[0]!.sessionId)} />)
      expect(b.overlay.hooks.teamUi.getSnapshot().notice).toMatchObject({ key: 'team.settingsFailed', success: false })
      expect(b.sessionOpen).toHaveBeenCalledTimes(2)
      expect(b.sessionOpen).toHaveBeenLastCalledWith(snapshot.bots[0]!.sessionId)
      expect(b.sessions.getSnapshot().byId[snapshot.bots[0]!.sessionId]?.retainedBy.mainView).toBe(1)
      expect(b.modelControl.hooks.settingsRequest.getSnapshot()).toBeNull()
      expect(b.openSettingsTab).toHaveBeenCalledOnce()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('keeps the create dialog and current member after a rejected save', async () => {
    const b = await boot()
    try {
      await b.categories.activate('katcats-team')
      vi.mocked(b.remote.createBot).mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'synthetic write failure', {}) })
      await b.overlay.createBot({ name: 'Writer' })
      expect(b.overlay.hooks.teamUi.getSnapshot().dialog?.kind).toBe('bot')
      expect(b.overlay.hooks.teamUi.getSnapshot().notice).toMatchObject({ key: 'team.createFailed', success: false })
      expect(b.ctx.uiWorkspace.openSession).toHaveBeenCalledExactlyOnceWith(snapshot.bots[0]!.sessionId)
    } finally { await b.ctx.fiber.dispose() }
  })

  it('does not close or announce success for a save from a replaced connection', async () => {
    const b = await boot()
    try {
      await b.categories.activate('katcats-team')
      let finish!: (value: Awaited<ReturnType<TeamRemote['createBot']>>) => void
      vi.mocked(b.remote.createBot).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
      const creating = b.overlay.createBot({ name: 'Writer' })
      await b.ctx.emit('connection/reset')
      finish({ ok: true, value: { bot: snapshot.bots[0]!, snapshot } })
      await creating
      expect(b.overlay.hooks.teamUi.getSnapshot().dialog?.kind).toBe('bot')
      expect(b.overlay.hooks.teamUi.getSnapshot().notice).toMatchObject({ key: 'team.outcomeUnknown', success: false })
      expect(b.ctx.uiWorkspace.openSession).toHaveBeenCalledExactlyOnceWith(snapshot.bots[0]!.sessionId)
    } finally { await b.ctx.fiber.dispose() }
  })

  it('waits for a known Session before opening the main member from an early team snapshot', async () => {
    const b = await boot({ ...sessionList([]), phase: 'pending' }, false)
    try {
      let finish!: () => void
      b.refreshSessions.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
      controls.entries[0]!.replace({ type: 'snapshot', value: snapshot })
      expect(b.ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
      b.sessions.set(sessionList(snapshot.bots))
      finish()
      await Promise.resolve()
      expect(b.ctx.uiWorkspace.openSession).toHaveBeenCalledExactlyOnceWith(snapshot.bots[0]!.sessionId)
    } finally { await b.ctx.fiber.dispose() }
  })

  it.each(['ordinary', 'agent', 'worker', 'removed'] as const)('opens the main Bot over a restored %s Session', async (kind) => {
    const restored = kind === 'ordinary' ? ordinaryBot : { name: kind, sessionId: `${kind}-session` as SessionId }
    const b = await boot(sessionList([...snapshot.bots, restored], restored.sessionId), false)
    try {
      controls.entries[0]!.replace({ type: 'snapshot', value: withOrdinaryBot })
      expect(b.sessionOpen).toHaveBeenCalledExactlyOnceWith(snapshot.bots[0]!.sessionId)
      expect(b.mountedSidebar.getSnapshot()).toBe(snapshot.bots[0]!.sessionId)
      expect(b.sessionCreate).not.toHaveBeenCalled()
    } finally { await b.ctx.fiber.dispose() }
  })

  it.each([false, true])('starts with the main settings collapsed when its saved expanded state is %s', async (expanded) => {
    const b = await boot()
    try {
      const main = snapshot.bots[0]!
      b.sidebarExpanded.set(main.sessionId, expanded)
      expect(b.modelControl.hooks.settingsRequest.getSnapshot()).toMatchObject({ sessionId: main.sessionId, intent: 'collapse' })
      const props = composerProps(b, main.sessionId)
      const view = render(<InputBar {...props} />)
      expect(b.sidebarExpanded.get(main.sessionId)).toBe(false)
      expect(b.openSettingsTab).not.toHaveBeenCalled()
      expect(b.toggleSidebar).toHaveBeenCalledTimes(expanded ? 1 : 0)
      expect(b.modelControl.hooks.settingsRequest.getSnapshot()).toBeNull()
      b.modelControl.openSettings()
      view.rerender(<InputBar {...props} variant="composer" />)
      act(() => { controls.entries[0]!.replace({ type: 'snapshot', value: { ...snapshot, revision: 1 } }) })
      expect(b.sidebarExpanded.get(main.sessionId)).toBe(true)
      expect(b.openSettingsTab).toHaveBeenCalledExactlyOnceWith('katcats-bot-settings')
      expect(b.toggleSidebar).toHaveBeenCalledTimes(expanded ? 1 : 0)
    } finally { await b.ctx.fiber.dispose() }
  })

  it('lets an explicit settings action cancel a pending startup collapse', async () => {
    const b = await boot()
    try {
      const main = snapshot.bots[0]!
      const startup = b.modelControl.hooks.settingsRequest.getSnapshot()!
      b.modelControl.openSettings()
      expect(b.modelControl.hooks.settingsRequest.getSnapshot()).toBeNull()
      b.modelControl.completeSettings(startup)
      render(<BotModelControl {...modelProps(b, main.sessionId)} />)
      expect(b.sidebarExpanded.get(main.sessionId)).toBe(true)
      expect(b.openSettingsTab).toHaveBeenCalledExactlyOnceWith('katcats-bot-settings')
      expect(b.toggleSidebar).not.toHaveBeenCalled()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('reports a failed startup collapse without opening settings or replacing the main conversation', async () => {
    const b = await boot()
    try {
      const main = snapshot.bots[0]!
      b.sidebarExpanded.set(main.sessionId, true)
      b.toggleSidebar.mockImplementationOnce(() => { throw new Error('synthetic sidebar unavailable') })
      render(<BotModelControl {...modelProps(b, main.sessionId)} />)
      expect(b.overlay.hooks.teamUi.getSnapshot().notice).toMatchObject({ key: 'team.settingsFailed', success: false })
      expect(b.openSettingsTab).not.toHaveBeenCalled()
      expect(b.sessionOpen).toHaveBeenCalledExactlyOnceWith(main.sessionId)
      expect(b.modelControl.hooks.settingsRequest.getSnapshot()).toBeNull()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('opens the main Bot when the group directory arrives after the team directory', async () => {
    const b = await boot(sessionList(snapshot.bots), true, null)
    try {
      expect(b.sessionOpen).not.toHaveBeenCalled()
      controls.entries[1]!.replace({ type: 'snapshot', value: emptyChats })
      expect(b.sessionOpen).toHaveBeenCalledExactlyOnceWith(snapshot.bots[0]!.sessionId)
    } finally { await b.ctx.fiber.dispose() }
  })

  it('keeps the startup choice retryable when opening the known main Session fails', async () => {
    const b = await boot(sessionList(snapshot.bots), false)
    try {
      b.sessionOpen.mockImplementationOnce(() => { throw new Error('synthetic main surface unavailable') })
      controls.entries[0]!.replace({ type: 'snapshot', value: snapshot })
      expect(b.overlay.hooks.teamUi.getSnapshot().notice).toMatchObject({ key: 'team.openFailed', success: false })
      b.sessions.set(sessionList(snapshot.bots))
      expect(b.sessionOpen).toHaveBeenCalledTimes(2)
      expect(b.mountedSidebar.getSnapshot()).toBe(snapshot.bots[0]!.sessionId)
    } finally { await b.ctx.fiber.dispose() }
  })

  it('waits for a usable team stream if its first snapshot failed before the group directory arrived', async () => {
    const b = await boot(sessionList(snapshot.bots), true, null)
    try {
      controls.entries[0]!.failed(new Error('synthetic stream unavailable'))
      controls.entries[1]!.replace({ type: 'snapshot', value: emptyChats })
      expect(b.sessionOpen).not.toHaveBeenCalled()
      controls.entries[0]!.replace({ type: 'snapshot', value: snapshot })
      expect(b.sessionOpen).toHaveBeenCalledExactlyOnceWith(snapshot.bots[0]!.sessionId)
    } finally { await b.ctx.fiber.dispose() }
  })

  it('waits for a connected carrier before opening the main conversation', async () => {
    const b = await boot(sessionList(snapshot.bots), false)
    try {
      b.connection.set(undefined)
      controls.entries[0]!.replace({ type: 'snapshot', value: snapshot })
      expect(b.sessionOpen).not.toHaveBeenCalled()
      b.connection.set('connected')
      expect(b.sessionOpen).toHaveBeenCalledExactlyOnceWith(snapshot.bots[0]!.sessionId)
    } finally { await b.ctx.fiber.dispose() }
  })

  it('waits for a ready catalog even when it already contains the main Session', async () => {
    const b = await boot({ ...sessionList(snapshot.bots), phase: 'pending' }, false)
    try {
      let finish!: () => void
      b.refreshSessions.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
      controls.entries[0]!.replace({ type: 'snapshot', value: snapshot })
      expect(b.sessionOpen).not.toHaveBeenCalled()
      b.sessions.set(sessionList(snapshot.bots))
      finish()
      await Promise.resolve()
      expect(b.sessionOpen).toHaveBeenCalledExactlyOnceWith(snapshot.bots[0]!.sessionId)
    } finally { await b.ctx.fiber.dispose() }
  })

  it('opens the main Bot after a native startup selection races its catalog refresh', async () => {
    const b = await boot(sessionList([]), false)
    try {
      let finish!: () => void
      b.refreshSessions.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
      controls.entries[0]!.replace({ type: 'snapshot', value: snapshot })
      const native = { name: 'Native Agent', sessionId: 'native-agent' as SessionId }
      b.sessions.set(sessionList([native], native.sessionId))
      expect(b.refreshSessions).toHaveBeenCalledOnce()
      b.sessions.set(sessionList([...snapshot.bots, native], native.sessionId))
      finish()
      await Promise.resolve()
      expect(b.sessionOpen).toHaveBeenCalledExactlyOnceWith(snapshot.bots[0]!.sessionId)
      expect(b.mountedSidebar.getSnapshot()).toBe(snapshot.bots[0]!.sessionId)
    } finally { await b.ctx.fiber.dispose() }
  })

  it('retries a failed startup catalog refresh without consuming the main Bot selection', async () => {
    const b = await boot(sessionList([]), false)
    try {
      b.refreshSessions.mockRejectedValueOnce(new Error('synthetic startup catalog unavailable'))
      controls.entries[0]!.replace({ type: 'snapshot', value: snapshot })
      await Promise.resolve()
      expect(b.overlay.hooks.teamUi.getSnapshot().notice).toMatchObject({ key: 'team.openFailed', success: false })
      expect(b.sessionOpen).not.toHaveBeenCalled()
      b.sidebar.commands.retry()
      await waitFor(() => { expect(controls.entries).toHaveLength(4) })
      controls.entries[2]!.replace({ type: 'snapshot', value: snapshot })
      b.sessions.set(sessionList(snapshot.bots))
      expect(b.sessionOpen).not.toHaveBeenCalled()
      controls.entries[3]!.replace({ type: 'snapshot', value: emptyChats })
      expect(b.sessionOpen).toHaveBeenCalledExactlyOnceWith(snapshot.bots[0]!.sessionId)
    } finally { await b.ctx.fiber.dispose() }
  })

  it('preserves explicit member navigation while startup catalog refresh is pending', async () => {
    const b = await boot(sessionList([ordinaryBot]), false)
    try {
      let finish!: () => void
      b.refreshSessions.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
      controls.entries[0]!.replace({ type: 'snapshot', value: withOrdinaryBot })
      b.sidebar.commands.openBot(ordinaryBot.id)
      b.sessions.set(sessionList(withOrdinaryBot.bots, ordinaryBot.sessionId))
      finish()
      await Promise.resolve()
      controls.entries[0]!.replace({ type: 'snapshot', value: withOrdinaryBot })
      expect(b.sessionOpen).toHaveBeenCalledExactlyOnceWith(ordinaryBot.sessionId)
    } finally { await b.ctx.fiber.dispose() }
  })

  it('preserves explicit member selection before the initial group directory arrives', async () => {
    const b = await boot(sessionList(withOrdinaryBot.bots), false, null)
    try {
      controls.entries[0]!.replace({ type: 'snapshot', value: withOrdinaryBot })
      b.sidebar.commands.openBot(ordinaryBot.id)
      controls.entries[1]!.replace({ type: 'snapshot', value: emptyChats })
      expect(b.sessionOpen).toHaveBeenCalledExactlyOnceWith(ordinaryBot.sessionId)
    } finally { await b.ctx.fiber.dispose() }
  })

  it('keeps explicit group navigation after directory updates and reconnection', async () => {
    const b = await boot(sessionList([...snapshot.bots, { name: groupChat.name, sessionId: groupChat.rootSessionId }]), true, withGroup)
    try {
      b.sidebar.commands.openChat(groupChat.id)
      b.sessionOpen.mockClear()
      b.ctx.emit('connection/reset')
      controls.entries[0]!.replace({ type: 'snapshot', value: snapshot })
      controls.entries[1]!.replace({ type: 'snapshot', value: withGroup })
      b.sessions.set(sessionList([...snapshot.bots, { name: groupChat.name, sessionId: groupChat.rootSessionId }], groupChat.rootSessionId))
      expect(b.sessionOpen).not.toHaveBeenCalled()
      expect(b.mountedSidebar.getSnapshot()).toBe(groupChat.rootSessionId)
    } finally { await b.ctx.fiber.dispose() }
  })

  it('releases pending startup selection when the product is disposed', async () => {
    const b = await boot(sessionList([]), false)
    let finish!: () => void
    b.refreshSessions.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    controls.entries[0]!.replace({ type: 'snapshot', value: snapshot })
    await b.ctx.fiber.dispose()
    b.sessions.set(sessionList(snapshot.bots))
    finish()
    await Promise.resolve()
    expect(b.sessionOpen).not.toHaveBeenCalled()
  })

  it('preserves a successful creation when its conversation catalog refresh fails', async () => {
    const b = await boot()
    try {
      const bot = { ...snapshot.bots[0]!, id: 'writer' as BotId, kind: 'ordinary' as const, name: 'Writer',
        groupId: snapshot.groups[0]!.id, sessionId: 'writer-session' as SessionId, workDir: '/synthetic/writer' }
      vi.mocked(b.remote.createBot).mockResolvedValueOnce({ ok: true, value: { bot, snapshot: { ...snapshot, revision: 1, bots: [...snapshot.bots, bot] } } })
      b.refreshSessions.mockRejectedValueOnce(new Error('synthetic catalog unavailable'))
      await b.overlay.createBot({ name: 'Writer' })
      expect(b.overlay.hooks.teamUi.getSnapshot().dialog).toBeNull()
      expect(b.overlay.hooks.teamUi.getSnapshot().notice).toMatchObject({ key: 'team.openFailed', success: false })
      expect(b.sidebar.hooks.directory.getSnapshot().snapshot?.bots.some(member => member.id === bot.id)).toBe(true)
      expect(b.ctx.uiWorkspace.openSession).toHaveBeenCalledExactlyOnceWith(snapshot.bots[0]!.sessionId)
    } finally { await b.ctx.fiber.dispose() }
  })

  it('does not complete pending startup navigation after the connection changes', async () => {
    const b = await boot({ ...sessionList([]), phase: 'pending' }, false)
    try {
      let finish!: () => void
      b.refreshSessions.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
      controls.entries[0]!.replace({ type: 'snapshot', value: snapshot })
      await b.ctx.emit('connection/reset')
      b.sessions.set(sessionList(snapshot.bots))
      finish()
      await Promise.resolve()
      expect(b.ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
      controls.entries[0]!.replace({ type: 'snapshot', value: snapshot })
      expect(b.sessionOpen).not.toHaveBeenCalled()
      controls.entries[1]!.replace({ type: 'snapshot', value: emptyChats })
      expect(b.sessionOpen).toHaveBeenCalledExactlyOnceWith(snapshot.bots[0]!.sessionId)
    } finally { await b.ctx.fiber.dispose() }
  })

  it('submits explicit group interruption through the exact retained editor and rejects stale or private scopes', async () => {
    const b = await boot(sessionList([...snapshot.bots, { name: groupChat.name, sessionId: groupChat.rootSessionId }]),
      true, withGroup)
    const runtime = await SlotTestRuntime.create()
    try {
      await runtime.sessions.add({ id: groupChat.rootSessionId })
      const reference = runtime.sessions.retainFor(runtime.ctx, groupChat.rootSessionId)
      const binding = await reference.ready
      const lookup = vi.spyOn(b.ctx.sessions, 'binding')
        .mockImplementation(id => id === groupChat.rootSessionId ? binding : undefined)
      const entry = b.entries.find(item => item.component === GroupMessageActions)
      if (entry?.inject === undefined) throw new Error('Missing group editor action registration')
      const injectAction = entry.inject as (id: SessionId) => GroupMessageActionsInjected
      const action = injectAction(groupChat.rootSessionId)
      action.interrupt()
      expect(b.scopedInput).toHaveBeenCalledExactlyOnceWith(binding.ctx)
      expect(b.submitInput).toHaveBeenCalledExactlyOnceWith('steer', 'click')
      b.submitInput.mockClear()
      injectAction(snapshot.bots[0]!.sessionId).interrupt()
      b.connection.set('disconnected')
      b.connectionGeneration.set(undefined)
      action.interrupt()
      expect(b.submitInput).not.toHaveBeenCalled()
      b.connection.set('connected')
      b.connectionGeneration.set({ id: 2, host: { home: '/synthetic-next' } })
      action.interrupt()
      expect(b.submitInput).toHaveBeenCalledExactlyOnceWith('steer', 'click')
      b.submitInput.mockClear()
      reference.release()
      const replacement = runtime.sessions.retainFor(runtime.ctx, groupChat.rootSessionId)
      lookup.mockReturnValue(await replacement.ready)
      action.interrupt()
      expect(b.submitInput).not.toHaveBeenCalled()
    } finally { await runtime.dispose(); await b.ctx.fiber.dispose() }
  })

  it('hides the composer model action and saves model selection only through Bot settings', async () => {
    const b = await boot()
    try {
      const base = snapshot.bots[0]!
      const supported = { ...snapshot, revision: 1, modelCapabilities: { override: true, followGlobal: false } }
      controls.entries[0]!.update({ type: 'replace', value: supported })
      b.session.modelCatalog.mockResolvedValue({ ok: true, value: {
        default: { provider: 'mock', model: 'base' }, routableProviders: ['mock'], failures: [],
        groups: [{ id: 'mock', name: 'Mock', models: [{ id: 'base', name: 'Base' }, { id: 'writer', name: 'Writer' }] }],
      } })
      act(() => { for (const changed of b.remoteListeners.get('llm/adapters-updated') ?? []) changed() })
      b.sidebar.commands.openBot(base.id)
      await Promise.resolve()
      const projection = () => ({ next: { provider: 'mock', model: 'base' } })
      const t = b.locale.bind('katcats.team')
      const controlProps = { ...modelProps(b, base.sessionId), useProjection: projection }
      const composer = render(<BotModelControl {...controlProps} />)
      expect(composer.container.innerHTML).toBe('')
      expect(b.ctx.sidebarRight.openTab).toHaveBeenLastCalledWith('katcats-bot-settings')
      composer.unmount()
      const updated = { ...base, model: { kind: 'override' as const, provider: 'mock', model: 'writer' } }
      vi.mocked(b.remote.updateBot).mockResolvedValueOnce({ ok: true, value: {
        bot: updated, snapshot: { ...supported, revision: 2, bots: [updated] },
      } })
      const settingsProps = { sessionId: base.sessionId, useDirectory: bindSnapshotSelector(b.settings.hooks.directory),
        useConnection: bindSnapshotSelector(b.connection), useTabInfo: () => ({ tab: { visible: true } }), renderFactorySlot: () => null,
        useProjection: projection, save: b.settings.save, t } as BotSettingsProps
      render(<BotSettings {...settingsProps} />)
      fireEvent.click(screen.getByLabelText(zh['bot.model']))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Mock / Writer' }))
      fireEvent.click(screen.getByRole('button', { name: zh['bot.save'] }))
      await waitFor(() => { expect(b.remote.updateBot).toHaveBeenCalledWith(expect.objectContaining({
        id: base.id, model: { kind: 'override', provider: 'mock', model: 'writer' },
      })) })
      expect(b.session.selectModel).not.toHaveBeenCalled()
    } finally { await b.ctx.fiber.dispose() }
  })

  it.each(['llm/adapters-updated', 'settings/document-updated', 'credentials/record-updated', 'credentials/reference-updated'])(
    'offers newly authorized models to any Bot after %s without changing other model policies', async (event) => {
      const b = await boot(sessionList(withOrdinaryBot.bots))
      try {
        const main = snapshot.bots[0]!
        const writer: TeamBot = { ...ordinaryBot, model: { kind: 'override', provider: 'mock', model: 'writer' } }
        const supported: TeamSnapshot = { ...withOrdinaryBot, modelCapabilities: { override: true, followGlobal: true },
          bots: [main, writer] }
        controls.entries[0]!.update({ type: 'replace', value: supported })
        const available: ModelCatalog = { default: { provider: 'mock', model: 'base' }, failures: [],
          routableProviders: ['mock', 'openai-codex'], groups: [
            { id: 'mock', name: 'Mock', models: [{ id: 'base', name: 'Base' }, { id: 'writer', name: 'Writer' }] },
            { id: 'openai-codex', name: 'ChatGPT', models: [{ id: 'gpt-fixture', name: 'GPT fixture' }] },
          ] }
        const settingsProps = { sessionId: main.sessionId, useDirectory: bindSnapshotSelector(b.settings.hooks.directory),
          useConnection: bindSnapshotSelector(b.connection), useTabInfo: () => ({ tab: { visible: true } }), renderFactorySlot: () => null,
          useProjection: () => ({ next: available.default }), save: b.settings.save, t: b.locale.bind('katcats.team') } as BotSettingsProps
        render(<BotSettings {...settingsProps} />)
        b.session.modelCatalog.mockResolvedValueOnce({ ok: true, value: available })
        act(() => { for (const changed of b.remoteListeners.get(event) ?? []) changed() })
        await waitFor(() => { expect(b.settings.hooks.directory.getSnapshot().catalog).toEqual(available) })
        const updated: TeamBot = { ...main, model: { kind: 'override', provider: 'openai-codex', model: 'gpt-fixture' } }
        vi.mocked(b.remote.updateBot).mockResolvedValueOnce({ ok: true, value: {
          bot: updated, snapshot: { ...supported, revision: 2, bots: [updated, writer] },
        } })
        fireEvent.click(screen.getByLabelText(zh['bot.model']))
        expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toMatchInlineSnapshot(`
          [
            "跟随主模型（默认）",
            "使用当前基础模型",
            "Mock / Base",
            "Mock / Writer",
            "ChatGPT / GPT fixture",
          ]
        `)
        fireEvent.click(screen.getByRole('menuitem', { name: 'ChatGPT / GPT fixture' }))
        fireEvent.click(screen.getByRole('button', { name: zh['bot.save'] }))
        await waitFor(() => { expect(b.remote.updateBot).toHaveBeenCalledExactlyOnceWith({
          id: main.id, model: { kind: 'override', provider: 'openai-codex', model: 'gpt-fixture' },
        }) })
        expect(b.settings.hooks.directory.getSnapshot().snapshot?.bots.find(bot => bot.id === writer.id)).toEqual(writer)
        expect(b.settings.hooks.directory.getSnapshot().catalog?.default).toEqual({ provider: 'mock', model: 'base' })
        expect(b.session.selectModel).not.toHaveBeenCalled()
        expect(b.session.modelCatalog).toHaveBeenCalledTimes(2)
      } finally { await b.ctx.fiber.dispose() }
    },
  )

  it('keeps the newest shared model catalog when an earlier authorization read completes later', async () => {
    const b = await boot()
    try {
      const earlier = Promise.withResolvers<RemoteResult<ModelCatalog>>()
      const latest = Promise.withResolvers<RemoteResult<ModelCatalog>>()
      const old = b.settings.hooks.directory.getSnapshot().catalog!
      const fresh: ModelCatalog = { ...old, groups: [{ id: 'openai-codex', name: 'ChatGPT',
        models: [{ id: 'gpt-fixture', name: 'GPT fixture' }] }], routableProviders: ['openai-codex'] }
      b.session.modelCatalog.mockReturnValueOnce(earlier.promise).mockReturnValueOnce(latest.promise)
      act(() => { for (const changed of b.remoteListeners.get('credentials/record-updated') ?? []) changed() })
      act(() => { for (const changed of b.remoteListeners.get('llm/adapters-updated') ?? []) changed() })
      latest.resolve({ ok: true, value: fresh })
      await waitFor(() => { expect(b.settings.hooks.directory.getSnapshot().catalog).toEqual(fresh) })
      earlier.resolve({ ok: true, value: old })
      await earlier.promise
      await Promise.resolve()
      expect(b.settings.hooks.directory.getSnapshot().catalog).toEqual(fresh)
      expect(b.remote.updateBot).not.toHaveBeenCalled()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('clears previous-Host model choices on reconnect and ignores pending choices after disposal', async () => {
    const b = await boot()
    const pending = Promise.withResolvers<RemoteResult<ModelCatalog>>()
    const retained = b.settings.hooks.directory.getSnapshot().catalog!
    b.session.modelCatalog.mockReturnValueOnce(pending.promise)
    b.ctx.emit('connection/reset')
    expect(b.settings.hooks.directory.getSnapshot().catalog).toBeNull()
    await b.ctx.fiber.dispose()
    const closed = b.settings.hooks.directory.getSnapshot()
    pending.resolve({ ok: true, value: retained })
    await pending.promise
    await Promise.resolve()
    expect(b.settings.hooks.directory.getSnapshot()).toEqual(closed)
  })

  it('registers the main introduction only for the main Bot and restores other hero content on navigation', async () => {
    const b = await boot()
    try {
      const welcome = () => b.entries.filter(entry => entry.name === 'conversation.hero.brand.content')
      expect(welcome().map(entry => entry.component)).toEqual([MainBotWelcome])
      controls.entries[0]!.update({ type: 'replace', value: withOrdinaryBot })
      b.sessions.set(sessionList(withOrdinaryBot.bots, snapshot.bots[0]!.sessionId))
      b.sidebar.commands.openBot(ordinaryBot.id)
      expect(welcome()).toEqual([])
      b.sidebar.commands.openBot(snapshot.mainBotId)
      expect(welcome().map(entry => entry.component)).toEqual([MainBotWelcome])
      b.sessions.set(sessionList(snapshot.bots))
      expect(welcome()).toEqual([])
    } finally { await b.ctx.fiber.dispose() }
  })

  it('hides composer permissions only for product conversations and releases the override elsewhere', async () => {
    const b = await boot()
    try {
      const permission = () => b.entries.filter(entry => entry.name === 'conversation.input.permission')
      expect(permission()).toHaveLength(1)
      const outsider = { name: 'Other Session', sessionId: 'outside-team' as SessionId }
      b.sessions.set(sessionList([...snapshot.bots, outsider], outsider.sessionId))
      expect(permission()).toEqual([])
      b.sidebar.commands.openBot(snapshot.mainBotId)
      expect(permission()).toHaveLength(1)
    } finally { await b.ctx.fiber.dispose() }
  })

  it('retains only a current group member executor for permission settings and rechecks connection freshness', async () => {
    const b = await boot()
    try {
      controls.entries[0]!.update({ type: 'replace', value: withOrdinaryBot })
      controls.entries[1]!.update({ type: 'replace', value: withGroup })
      const injected = b.entries.find(entry => entry.component === ChatSettings)!.inject!() as ChatSettingsInjected
      const signal = new AbortController().signal
      const target = { chatId: groupChat.id, botId: ordinaryBot.id, sessionId: groupChat.executors[0]!.sessionId }
      injected.retainPermissionSession(target, signal)
      expect(b.retainSession).toHaveBeenCalledExactlyOnceWith(target.sessionId, { source: 'katcatsPermissions', signal })
      b.retainSession.mockClear()
      for (const sessionId of [ordinaryBot.sessionId, snapshot.bots[0]!.sessionId, groupChat.rootSessionId, 'another-group-worker' as SessionId]) {
        expect(() => injected.retainPermissionSession({ ...target, sessionId }, signal)).toThrow('unavailable')
      }
      expect(() => injected.retainPermissionSession({ ...target, botId: snapshot.mainBotId }, signal)).toThrow('unavailable')
      b.connection.set(undefined)
      expect(() => injected.retainPermissionSession(target, signal)).toThrow('unavailable')
      b.connection.set('connected')
      b.ctx.emit('connection/reset')
      expect(() => injected.retainPermissionSession(target, signal)).toThrow('unavailable')
      controls.entries[0]!.replace({ type: 'snapshot', value: withOrdinaryBot })
      expect(() => injected.retainPermissionSession(target, signal)).toThrow('unavailable')
      controls.entries[1]!.replace({ type: 'snapshot', value: withGroup })
      injected.retainPermissionSession(target, signal)
      expect(b.retainSession).toHaveBeenCalledOnce()
      b.retainSession.mockClear()
      controls.entries[1]!.update({ type: 'replace', value: {
        ...withGroup, revision: 2, chats: [{ ...groupChat, memberIds: [] }],
      } })
      expect(() => injected.retainPermissionSession(target, signal)).toThrow('unavailable')
      expect(b.retainSession).not.toHaveBeenCalled()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('tracks actual team Workspace membership independently of logical sidebar groups', async () => {
    const b = await boot()
    try {
      const main = snapshot.bots[0]!
      const writer = { ...main, id: 'writer' as BotId, kind: 'ordinary' as const, groupId: snapshot.groups[0]!.id,
        sessionId: 'writer-session' as SessionId, workDir: '/synthetic/writer', name: 'Writer' }
      const row = (bot: TeamBot): WorkspaceView => ({
        workspaceId: `workspace-${bot.id}` as WorkspaceId, path: bot.workDir, title: bot.name,
        sessionIds: [bot.sessionId], createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z',
      })
      const mainWorkspace = row(main)
      const writerWorkspace = row(writer)
      b.workspaces.set({ ...b.workspaces.getSnapshot(), items: [mainWorkspace, writerWorkspace] })
      const category = () => b.categories.store.getSnapshot().categories.find(item => item.id === 'katcats-team')!
      expect(category().workspaceIds).toEqual([mainWorkspace.workspaceId])
      controls.entries[0]!.update({ type: 'replace', value: { ...snapshot, revision: 1, bots: [main, writer] } })
      expect(category().workspaceIds).toEqual([mainWorkspace.workspaceId, writerWorkspace.workspaceId])
      expect(category().newSessionDisabledWorkspaceIds).toEqual(category().workspaceIds)
      b.workspaces.set({ ...b.workspaces.getSnapshot(), items: [writerWorkspace] })
      expect(category().workspaceIds).toEqual([writerWorkspace.workspaceId])
      expect(b.workspaceOpen).not.toHaveBeenCalled()
      expect(b.sessionCreate).not.toHaveBeenCalled()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('shows a read-only folder for Bot Sessions and releases its picker override outside the team', async () => {
    const b = await boot()
    try {
      const entry = () => b.entries.find(item => item.name === 'conversation.hero.workspace')
      const injected = entry()!.inject!() as Pick<BotSettingsInjected, 'hooks'>
      const onClose = vi.fn()
      const onPick = vi.fn()
      const props = { open: true, onClose, onPick, anchorRef: { current: document.createElement('button') },
        useSessions: bindSnapshotSelector(b.sessions), useDirectory: bindSnapshotSelector(injected.hooks.directory),
        t: b.locale.bind('katcats.team') } as BotFolderInfoProps
      render(<BotFolderInfo {...props} />)
      expect(screen.getByRole('group', { name: zh['bot.folder'] }).textContent).toContain(snapshot.bots[0]!.workDir)
      expect(screen.queryByRole('menuitem')).toBeNull()
      const outsider = { ...snapshot.bots[0]!, sessionId: 'outside-team' as SessionId }
      act(() => { b.sessions.set(sessionList([...snapshot.bots, outsider], outsider.sessionId)) })
      expect(entry()).toBeUndefined()
      expect(screen.queryByRole('group', { name: zh['bot.folder'] })).toBeNull()
      act(() => { b.sessions.set(sessionList(snapshot.bots, snapshot.bots[0]!.sessionId)) })
      expect(entry()).toBeDefined()
      expect(onPick).not.toHaveBeenCalled()
      expect(b.workspaceOpen).not.toHaveBeenCalled()
      expect(b.sessionCreate).not.toHaveBeenCalled()
      expect(b.ctx.uiWorkspace.openSession).toHaveBeenCalledExactlyOnceWith(snapshot.bots[0]!.sessionId)
    } finally { await b.ctx.fiber.dispose() }
  })
})
