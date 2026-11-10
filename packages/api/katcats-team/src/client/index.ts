/** Katcats product contributions over the existing Katcat shell and DSH services. */
import type { Context } from '@deepseek-ai/cordis'
import katcatsRemote from '@deepseek-ai/dsh-client-katcats-team/remote'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { RemoteSnapshotStream, RemoteStreamCarrierError, type ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-commands/remote'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-shortcuts/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceCategoryState } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { BotId, CreateBotRequest, GroupId, TeamBot, TeamFrame, UpdateBotRequest } from '../types.ts'
import type { ChatId, ChatFrame, TeamChat } from '../chats-types.ts'
import type { MemoryFrame } from '../memory-types.ts'
import { remoteErrorOf, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { TeamClientModel, TeamRequestSupersededError, type TeamRemote } from './model.ts'
import { ChatClientModel, type ChatRemote } from './chat-model.ts'
import { createTeamUi } from './ui-state.ts'
import { TeamSidebar, type TeamSidebarInjected } from './TeamSidebar.tsx'
import { TeamOverlays, type TeamOverlaysInjected } from './Overlays.tsx'
import { BotSettings, type BotSettingsInjected } from './BotSettings.tsx'
import { BotModelControl, type BotModelControlInjected, type BotSettingsRequest } from './BotModelControl.tsx'
import { BotHeaderAction } from './BotHeaderAction.tsx'
import { GroupRoomAction, type GroupRoomInjected } from './GroupRoom.tsx'
import { roomEn, roomZh } from './room-locales.ts'
import { observeRoomActivity } from './room-activity.ts'
import { Headquarters, type HeadquartersInjected } from './Headquarters.tsx'
import { createHeadquartersState } from './headquarters-state.ts'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { BotFolderInfo } from './BotFolderInfo.tsx'
import { MainBotWelcome } from './MainBotWelcome.tsx'
import { SettingsPermissionPicker, type PermissionSessionRetainer } from './PermissionSettings.tsx'
import { createGroupPermissionBatch } from './group-permission-batch.ts'
import { ChatFolderInfo } from './ChatFolderInfo.tsx'
import { ChatSettings, type ChatSettingsInjected } from './ChatForms.tsx'
import { ChatControls, type ChatControlsInjected } from './ChatControls.tsx'
import { ChatOverlay, type ChatOverlayInjected } from './ChatOverlay.tsx'
import { chatRelayDefinition } from './chat-relay.ts'
import { ChatRelayMessage, type ChatRelayActionsInjected } from './ChatRelayMessage.tsx'
import type { GroupIdentityInjected } from './group-manager.ts'
import { GroupDeliveredCards, GroupDeliveredFiles, type GroupDeliveredFilesInjected } from './GroupDeliveredFiles.tsx'
import { retainGroupFiles } from './group-delivered-files.ts'
import { chatTaskLifecycleDefinition } from './chat-task-lifecycle.ts'
import { GroupTaskLifecycle } from './GroupTaskLifecycle.tsx'
import { TASKS_NS, taskZh, taskEn } from './task-locales.ts'
import { ChatApprovals, type ChatApprovalsInjected } from './ChatApprovals.tsx'
import { readApprovalOperation } from './chat-approvals.ts'
import { ChatQuestions, GroupQuestionPanel, type ChatQuestionsInjected } from './ChatQuestions.tsx'
import { createGroupQuestions, groupQuestionAvailable, retainGroupQuestion } from './chat-questions.ts'
import { installGroupTransports } from './group-transports.ts'
import { createGroupMessageFeedback } from './group-message-feedback.ts'
import { GroupMessageActions, GroupMessageFeedback, type GroupMessageActionsInjected } from './GroupMessageActions.tsx'
import { installGroupStopShortcut } from './group-stop-shortcut.ts'
import { MemoryPanel, type MemoryPanelInjected, type MemoryRemote, type MemorySubscription } from './MemoryPanel.tsx'
import { en, zh, type TeamKey } from './locales.ts'
import { createSidebarOverflow, createSidebarViewStore } from './sidebar-view.ts'
import { createSidebarSessionStatus } from './sidebar-session-status.ts'
import { ScheduleClientModel } from './schedule-model.ts'
import { ScheduleList, ScheduleManager, type ScheduleViewsInjected } from './ScheduleViews.tsx'
import { SCHEDULE_NS, scheduleEn, scheduleZh } from './schedule-locales.ts'
import { createMemberMentionSource, memberMentionRule, MemberMentionLabel } from './member-mentions.tsx'
import { installTeamComposerPresentations } from './composer-presentations.ts'
import './user-message-theme.module.css'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-schedule/client'
import type {} from '@deepseek-ai/dsh-client-ui-schedule/src/client/definition.ts'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
export type {} from './chat-relay.ts'
export type {} from './chat-approvals.ts'

const NS = 'katcats.team'
const CATEGORY = 'katcats-team'
const SETTINGS_KIND = 'katcats-bot-settings'
const SETTINGS_ID = '@deepseek-ai/dsh-client-katcats-team/settings'
const CHAT_SETTINGS_KIND = 'katcats-chat-settings'
const CHAT_SETTINGS_ID = '@deepseek-ai/dsh-client-katcats-team/chat-settings'
const MEMORY_KIND = 'katcats-memory'
const MEMORY_ID = '@deepseek-ai/dsh-client-katcats-team/memory'
const SCHEDULES_KIND = 'katcats-schedules'
const SCHEDULES_ID = '@deepseek-ai/dsh-client-katcats-team/schedules'

/** The product mounts its own generated namespace before consuming it. */
export const inject = ['remote']

const UI_INJECT = [
  'slots', 'locale', 'remote.katcatsTeam', 'remote.katcatsChats', 'remote.katcatsMemory', 'remote.session', 'uiWorkspace', 'uiConversation',
  'workspaceCategories', 'sidebarRight', 'sidebarRightTabs', 'sessions', 'workspaces', 'conversation', 'shortcuts', 'uiSession',
  'remote.schedule', 'remote.commands', 'remoteAccess', 'inputTriggers', 'composerPresentation', 'connection',
  'modelDirectories',
]

/**
 * Mount the generated member Remote and its dependent product interface.
 * @param ctx - Client plugin context with the public Remote mounting service.
 */
export async function apply(ctx: Context): Promise<void> {
  const dispose = await ctx.remote.$mount(katcatsRemote)
  ctx.effect(() => dispose, 'katcats-team: generated Remote')
  await ctx.inject(UI_INJECT, mountUI)
}

function mountUI(ctx: Context): void {
  ctx.effect(() => {
    document.body.setAttribute('data-katcats-user-bubbles', '')
    return () => { document.body.removeAttribute('data-katcats-user-bubbles') }
  }, 'katcats-team: user message palette')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'katcats-team: dictionaries')
  ctx.effect(() => ctx.locale.register('katcats.room', { zh: roomZh, en: roomEn }), 'katcats-team: room dictionaries')
  const t = ctx.locale.bind(NS)
  const remote = ctx.remote as ClientRemote & {
    readonly katcatsTeam: TeamRemote
    readonly katcatsChats: ChatRemote
    readonly katcatsMemory: MemoryRemote
  }
  const connection = ctx.get('connection') as ConnectionHandle
  const model = new TeamClientModel(remote.katcatsTeam)
  const chats = new ChatClientModel(remote.katcatsChats)
  const messageFeedback = createGroupMessageFeedback({ binding: id => ctx.sessions.binding(id), connection })
  ctx.effect(() => () => { messageFeedback.dispose() }, 'katcats-team: scoped group admission notices')
  ctx.effect(() => installTeamComposerPresentations({
    directory: model.state, chats: chats.state, presentation: ctx.composerPresentation, t,
    subscribeLocale: listener => ctx.locale.subscribe(listener),
  }), 'katcats-team: dedicated input hints')
  ctx.effect(() => {
    const source = createMemberMentionSource({
      directory: model.state, chats: chats.state, unavailableReason: () => t('mention.unavailable'),
    })
    let unregister: () => void
    try { unregister = ctx.inputTriggers.registerSource(source) }
    catch (error) { source.dispose(); throw error }
    const stopReset = ctx.on('connection/reset', () => { source.invalidate() })
    return () => { stopReset(); unregister(); source.dispose() }
  }, 'katcats-team: current group member mentions')
  ctx.uiConversation.userText.register(memberMentionRule)
  ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
    name: 'conversation.user.text.node', key: 'katcats-member', locale: NS,
  }, MemberMentionLabel))
  ctx.uiConversation.events.register(chatRelayDefinition)
  ctx.uiConversation.events.register(chatTaskLifecycleDefinition)
  ctx.effect(() => ctx.locale.register(TASKS_NS, { zh: taskZh, en: taskEn }), 'katcats-team: group task activity copy')
  const ui = createTeamUi()
  const sidebarView = createSidebarViewStore()
  const sidebarOverflow = createSidebarOverflow()
  const sidebarReveal = createSnapshotStore<{ sessionId: SessionId; groupId: GroupId; sequence: number } | null>(null)
  let revealSequence = 0
  ctx.effect(() => () => { sidebarOverflow.dispose() }, 'katcats-team: sidebar overflow')
  const sidebarSessionStatus = createSidebarSessionStatus(ctx.uiSession.sessionStatus)
  ctx.effect(() => () => { sidebarSessionStatus.dispose() }, 'katcats-team: sidebar interactions')
  ctx.effect(() => ctx.locale.register(SCHEDULE_NS, { zh: scheduleZh, en: scheduleEn }), 'katcats-team: automation copy')
  const scheduleT = ctx.locale.bind(SCHEDULE_NS)
  const schedules = new ScheduleClientModel({
    catalog: () => ctx.remote.schedule.catalog(),
    subscribeChanged: listener => ctx.remote.$on('schedule/changed', listener),
    subscribeReset: listener => ctx.on('connection/reset', listener),
  })
  ctx.effect(() => () => { schedules.dispose() }, 'katcats-team: automation catalog')
  const scheduleInjected: ScheduleViewsInjected = {
    hooks: { schedules: schedules.state, directory: model.state, chats: chats.state },
    reload: () => schedules.reload(),
    openTask: (task) => { ctx.sidebarRight.openTab('scheduleTask', { params: { sessionId: task.sessionId, id: task.id } }) },
  }
  ctx.effect(() => installGroupTransports({
    sessions: ctx.sessions, chats: chats.state, remote: remote.katcatsChats,
    block: (id, blocked) => { ctx.conversation.blocks.setOwned('katcats-group-transport', id,
      blocked ? { reason: t('chat.transportUnavailable') } : undefined) },
    failed: () => { ui.notify('chat.transportUnavailable', false) },
    submitting: messageFeedback.submitting,
  }), 'katcats-team: group Session delivery')
  ctx.effect(() => installGroupStopShortcut(ctx.shortcuts, ctx.sessions, chats.state, ctx.uiSession, async (id) => {
    const session = ctx.sessions.binding(id)?.session
    if (session === undefined) throw new Error('Group Session is unavailable')
    const result = await session.cancel()
    if (!result.ok) throw result.error
  }, () => { ui.notify('chat.controlFailed', false) }), 'katcats-team: group Escape cancellation')
  const settingsRequest = createSnapshotStore<BotSettingsRequest | null>(null)
  const memorySubscriptions = new Set<MemorySubscription>()
  let disposed = false
  let firstSnapshot = true
  let initialCatalogRequested = false
  let initialTeamReceived = false
  let initialChatsReceived = false
  let navigation = 0
  let stopWaitingForSession: (() => void) | undefined
  const previousCategory = ctx.workspaceCategories.store.getSnapshot().activeCategoryId
  const categorySource = createSnapshotStore<WorkspaceCategoryState>({
    label: t('team.label'), workspaceIds: [], newSessionDisabledWorkspaceIds: [],
  })
  ctx.effect(() => ctx.workspaceCategories.register({
    id: CATEGORY, order: -100, source: categorySource,
    activate: () => { requestCreate(); return Promise.resolve() },
  }), 'katcats-team: new conversation action')
  ctx.workspaceCategories.setActiveCategory(CATEGORY)
  ctx.effect(() => ctx.locale.subscribe(() => {
    categorySource.set({ ...categorySource.getSnapshot(), label: t('team.label') })
  }), 'katcats-team: category label')
  ctx.effect(() => {
    const synchronize = (): void => {
      const members = new Set([
        ...model.state.getSnapshot().snapshot?.bots.map(bot => bot.sessionId) ?? [],
        ...chats.state.getSnapshot().snapshot?.chats.map(chat => chat.rootSessionId) ?? [],
      ])
      const workspaceIds = ctx.workspaces.list.getSnapshot().items
        .filter(workspace => workspace.sessionIds.some(id => members.has(id))).map(workspace => workspace.workspaceId)
      const previous = categorySource.getSnapshot()
      if (workspaceIds.length === previous.workspaceIds.length
        && workspaceIds.every((id, index) => id === previous.workspaceIds[index])) return
      categorySource.set({ ...previous, workspaceIds, newSessionDisabledWorkspaceIds: workspaceIds })
    }
    const stopMembers = model.state.subscribe(synchronize)
    const stopChats = chats.state.subscribe(synchronize)
    const stopWorkspaces = ctx.workspaces.list.subscribe(synchronize)
    synchronize()
    return () => { stopMembers(); stopChats(); stopWorkspaces() }
  }, 'katcats-team: directory Workspace membership')

  const openSettings = (): void => {
    if (disposed) return
    settingsRequest.set(null)
    const chat = chats.state.getSnapshot().snapshot?.chats.some(item => item.rootSessionId === selectedSession()) === true
    try { ctx.sidebarRight.openTab(chat ? CHAT_SETTINGS_KIND : SETTINGS_KIND) }
    catch (_error) { ui.notify(chat ? 'chat.settingsFailed' : 'team.settingsFailed', false) }
  }
  const openMemory = (): void => {
    if (disposed) return
    try { ctx.sidebarRight.openTab(MEMORY_KIND) }
    catch (_error) { ui.notify('memory.openFailed', false) }
  }
  const openSchedules = (sessionId: SessionId): void => {
    if (disposed || selectedSession() !== sessionId) return
    ctx.sidebarRight.openTab(SCHEDULES_KIND)
  }
  const selectedSession = () => {
    const current = ctx.sessions.list.getSnapshot()
    return current.ids.find(id => (current.byId[id]?.retainedBy.mainView ?? 0) > 0)
  }
  const retainPermissionSession: PermissionSessionRetainer = (target, signal) => {
    const directory = model.state.getSnapshot()
    const groups = chats.state.getSnapshot()
    const chat = groups.snapshot?.chats.find(item => item.id === target.chatId)
    const member = directory.snapshot?.bots.find(bot => bot.id === target.botId && bot.kind === 'ordinary')
    if (disposed || signal.aborted || connection.state.getSnapshot() !== 'connected'
      || directory.phase !== 'ready' || groups.phase !== 'ready' || member === undefined || chat === undefined
      || !chat.memberIds.includes(member.id) || target.sessionId === chat.rootSessionId
      || directory.snapshot?.bots.some(bot => bot.sessionId === target.sessionId)
      || !chat.executors.some(executor => executor.botId === member.id && executor.sessionId === target.sessionId)) {
      throw new Error('Group permission Session is unavailable')
    }
    return ctx.sessions.retain(target.sessionId, { source: 'katcatsPermissions', signal })
  }
  const completeSettings = (request: BotSettingsRequest): void => {
    const pending = settingsRequest.getSnapshot()
    if (disposed || pending?.sequence !== request.sequence || pending.sessionId !== request.sessionId) return
    settingsRequest.set(null)
    if (request.sequence !== navigation || selectedSession() !== request.sessionId
      || ctx.sidebarRight.mounted.getSnapshot() !== request.sessionId) return
    if (pending.intent === 'collapse') {
      try { if (ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded() }
      catch (_error) { ui.notify('team.settingsFailed', false) }
      return
    }
    openSettings()
  }
  const openConversation = (sessionId: SessionId, fromStartup = false, revealGroup?: GroupId, waitForSession = false): void => {
    if (disposed) return
    stopWaitingForSession?.()
    stopWaitingForSession = undefined
    if (revealGroup === undefined && sidebarReveal.getSnapshot() !== null) sidebarReveal.set(null)
    firstSnapshot = false
    const request = ++navigation
    settingsRequest.set(null)
    const selected = selectedSession()
    let completed = false
    let stopWait: (() => void) | undefined
    const clearWait = (): void => {
      stopWait?.()
      if (stopWaitingForSession === clearWait) stopWaitingForSession = undefined
    }
    const failed = (): void => {
      clearWait()
      if (!completed && !disposed && request === navigation) ui.notify('team.openFailed', false)
    }
    const complete = (): void => {
      if (completed || disposed || request !== navigation || selectedSession() !== selected) return
      if (!ctx.sessions.list.getSnapshot().ids.includes(sessionId)) {
        if (!waitForSession) failed()
        return
      }
      clearWait()
      try {
        ctx.workspaceCategories.setActiveCategory(CATEGORY)
        ctx.uiWorkspace.openSession(sessionId)
        if (revealGroup !== undefined) sidebarReveal.set({ sessionId, groupId: revealGroup, sequence: ++revealSequence })
      } catch (_error) {
        if (fromStartup && request === navigation) firstSnapshot = true
        failed()
        return
      }
      completed = true
      settingsRequest.set({ sessionId, sequence: request, intent: fromStartup ? 'collapse' : 'reveal' })
      void ctx.modelDirectories.loadCatalog().catch(() => { /* The shared catalog retains its last usable choices. */ })
    }
    if (ctx.sessions.list.getSnapshot().ids.includes(sessionId)) complete()
    else {
      if (waitForSession) {
        stopWait = ctx.sessions.list.subscribe(complete)
        stopWaitingForSession = clearWait
      }
      void ctx.sessions.refresh().then(complete, failed)
    }
  }
  const openBot = (id: BotId): void => {
    const bot = model.state.getSnapshot().snapshot?.bots.find(candidate => candidate.id === id)
    if (bot !== undefined) openConversation(bot.sessionId)
  }
  const notifyCopy = (success: boolean): void => {
    if (!disposed) ui.notify(success ? 'copy.copied' : 'copy.failed', success)
  }
  const copyText = async (text: string): Promise<void> => {
    if (disposed) return
    try { await navigator.clipboard.writeText(text) }
    catch (_error) {
      notifyCopy(false)
      return
    }
    notifyCopy(true)
  }
  const openChat = (id: ChatId): void => {
    const chat = chats.state.getSnapshot().snapshot?.chats.find(candidate => candidate.id === id)
    if (chat !== undefined) openConversation(chat.rootSessionId)
  }
  const openCreatedBot = (bot: TeamBot): void => {
    openConversation(bot.sessionId, false, bot.groupId ?? undefined, true)
  }
  const openCreatedChat = (chat: TeamChat): void => {
    openConversation(chat.rootSessionId, false, chat.groupId, true)
  }
  const requestCreate = (groupId?: GroupId): void => {
    const snapshot = model.state.getSnapshot().snapshot
    if (snapshot === null || disposed) return
    const target = groupId ?? snapshot.groups.find(group => group.system && group.kind === 'bots')?.id
    ui.createBot(target)
  }
  ctx.effect(() => {
    const synchronize = (): void => { model.setCatalog(ctx.modelDirectories.catalogState.getSnapshot().value) }
    const stop = ctx.modelDirectories.catalogState.subscribe(synchronize)
    synchronize()
    void ctx.modelDirectories.loadCatalog().catch(() => { /* The shared catalog retains its last usable choices. */ })
    return stop
  }, 'katcats-team: shared model choices')
  const save = async (request: UpdateBotRequest): Promise<void> => {
    try {
      await model.updateBot(request)
      if (!disposed) ui.notify('team.saved', true)
    } catch (error) {
      if (!disposed) ui.notify(error instanceof TeamRequestSupersededError ? 'team.outcomeUnknown' : 'team.saveFailed', false)
      throw error
    }
  }
  ctx.slots.inject('conversation.hero.brand.content', () => {
    let release: (() => void) | undefined
    const synchronize = (): void => {
      const directory = model.state.getSnapshot().snapshot
      const main = directory?.bots.find(bot => bot.id === directory.mainBotId)
      const visible = main !== undefined && main.sessionId === selectedSession()
      if (visible && release === undefined) {
        release = ctx.slots.register({
          name: 'conversation.hero.brand.content', priority: -100, locale: NS,
          inject: () => ({ hooks: { directory: model.state } }),
        }, MainBotWelcome)
      } else if (!visible) { release?.(); release = undefined }
    }
    const stopMembers = model.state.subscribe(synchronize)
    const stopSessions = ctx.sessions.list.subscribe(synchronize)
    synchronize()
    return () => { stopMembers(); stopSessions(); release?.() }
  })
  ctx.slots.inject('conversation.input.permission', () => {
    let release: (() => void) | undefined
    const synchronize = (): void => {
      const selected = selectedSession()
      const member = model.state.getSnapshot().snapshot?.bots.some(bot => bot.sessionId === selected) === true
      const chat = chats.state.getSnapshot().snapshot?.chats.some(item => item.rootSessionId === selected) === true
      if ((member || chat) && release === undefined) {
        release = ctx.slots.register({ name: 'conversation.input.permission', priority: -100 }, HiddenComposerPermission)
      } else if (!member && !chat) { release?.(); release = undefined }
    }
    const stopMembers = model.state.subscribe(synchronize)
    const stopChats = chats.state.subscribe(synchronize)
    const stopSessions = ctx.sessions.list.subscribe(synchronize)
    synchronize()
    return () => { stopMembers(); stopChats(); stopSessions(); release?.() }
  })
  ctx.slots.inject('conversation.hero.workspace', () => {
    let release: (() => void) | undefined
    let occupant: 'bot' | 'chat' | undefined
    const synchronize = (): void => {
      const selected = selectedSession()
      const member = model.state.getSnapshot().snapshot?.bots.some(bot => bot.sessionId === selected) === true
      const chat = chats.state.getSnapshot().snapshot?.chats.some(item => item.rootSessionId === selected) === true
      const next = member ? 'bot' : chat ? 'chat' : undefined
      if (next === occupant) return
      release?.()
      release = undefined
      occupant = next
      if (next === 'bot') {
        release = ctx.slots.register({
          name: 'conversation.hero.workspace', priority: -100, locale: NS,
          inject: () => ({ hooks: { directory: model.state } }),
        }, BotFolderInfo)
      } else if (next === 'chat') {
        release = ctx.slots.register({ name: 'conversation.hero.workspace', priority: -100, locale: NS,
          inject: () => ({ hooks: { chats: chats.state } }) }, ChatFolderInfo)
      }
    }
    const stopMembers = model.state.subscribe(synchronize)
    const stopChats = chats.state.subscribe(synchronize)
    const stopSessions = ctx.sessions.list.subscribe(synchronize)
    synchronize()
    return () => { stopMembers(); stopChats(); stopSessions(); release?.() }
  })
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: MEMORY_ID, kind: MEMORY_KIND, priority: 'builtin', title: () => t('memory.title'),
  }), 'katcats-team: memory tab')
  const memoryCommand = async (request: Promise<RemoteResult<unknown>>): Promise<void> => {
    const result = await request
    if (!result.ok) throw result.error
  }
  const watchMemory: MemoryPanelInjected['watch'] = (request, replace, failed) => {
    const stream = remote.$stream<MemoryFrame>({
      name: 'Katcats saved memories', open: signal => remote.katcatsMemory.follow(request, signal),
      ended: accepted => accepted ? new RemoteStreamCarrierError('Memory stream ended') : new Error('Memory stream has no snapshot'),
    })
    const controller = new RemoteSnapshotStream<Extract<MemoryFrame, { type: 'snapshot' }>, Extract<MemoryFrame, { type: 'replace' }>>(stream, {
      name: 'Katcats saved memories', isSnapshot: (frame): frame is Extract<MemoryFrame, { type: 'snapshot' }> => frame.type === 'snapshot',
      replace: (frame) => { replace(frame.value) }, update: (frame) => { replace(frame.value) }, failed,
    })
    const subscription: MemorySubscription = {
      dispose: async () => { await controller.dispose(); memorySubscriptions.delete(subscription) },
    }
    memorySubscriptions.add(subscription)
    controller.start()
    return subscription
  }
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: MEMORY_ID, locale: NS,
    inject: (): MemoryPanelInjected => ({ hooks: { directory: model.state, chats: chats.state }, watch: watchMemory,
      saveMemory: request => memoryCommand(remote.katcatsMemory.save(request)),
      editMemory: request => memoryCommand(remote.katcatsMemory.edit(request)),
      deleteMemory: request => memoryCommand(remote.katcatsMemory.delete(request)),
      shareMemory: request => memoryCommand(remote.katcatsMemory.share(request)),
    }),
  }, MemoryPanel))
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: SETTINGS_ID, kind: SETTINGS_KIND, priority: 'builtin', title: () => t('bot.settings'), keepMounted: true,
    initialWidth: 'minimum',
  }), 'katcats-team: settings tab')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: CHAT_SETTINGS_ID, kind: CHAT_SETTINGS_KIND, priority: 'builtin', title: () => t('chat.settings'), keepMounted: true,
    initialWidth: 'minimum',
  }), 'katcats-team: group settings tab')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: SCHEDULES_ID, kind: SCHEDULES_KIND, priority: 'builtin', title: () => scheduleT('title'),
  }), 'katcats-team: automation tab')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: SCHEDULES_ID, locale: SCHEDULE_NS,
    inject: (): ScheduleViewsInjected => scheduleInjected,
  }, ScheduleList))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: 'schedules' as MainPanelId, priority: -100, locale: SCHEDULE_NS,
    inject: (): ScheduleViewsInjected => scheduleInjected,
  }, ScheduleManager))
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: CHAT_SETTINGS_ID, locale: NS,
    children: { 'katcats.settings.permission': { kind: 'single', scope: 'session' } },
    inject: (sessionId: SessionId): ChatSettingsInjected => {
      const batch = createGroupPermissionBatch({
        rootSessionId: sessionId, directory: model.state, chats: chats.state, connection,
        retain: retainPermissionSession, binding: id => ctx.sessions.binding(id),
        capability: id => ctx.remoteAccess.source('session', id, 'commands/execute'),
        execute: (id, line, signal) => remote.commands.execute(id, line, [], signal),
      })
      return {
        hooks: { directory: model.state, chats: chats.state, connection: connection.state, permissionBatch: batch.state },
        activatePermissionBatch: batch.activate, applyPermissionBatch: batch.apply, cancelPermissionBatch: batch.cancel,
        openMemory, openSchedules, retainPermissionSession, copyText,
        save: async (request) => {
          try { await chats.update(request); if (!disposed) ui.notify('chat.saved', true) }
          catch (error) {
            if (!disposed) ui.notify(error instanceof TeamRequestSupersededError ? 'team.outcomeUnknown' : 'team.saveFailed', false)
            throw error
          }
        },
      }
    },
  }, ChatSettings))
  ctx.slots.inject('katcats.settings.permission', () => ctx.slots.register({
    name: 'katcats.settings.permission', locale: NS,
  }, SettingsPermissionPicker))
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: SETTINGS_ID, locale: NS,
    inject: (): BotSettingsInjected => ({
      hooks: { directory: model.state, connection: connection.state }, save, openMemory, openSchedules,
    }),
  }, BotSettings))
  ctx.slots.inject('conversation.input.model', () => ctx.slots.register({
    name: 'conversation.input.model', priority: -100, locale: NS,
    inject: (): BotModelControlInjected => ({
      hooks: { directory: model.state, chats: chats.state, settingsRequest }, openSettings, completeSettings,
    }),
  }, BotModelControl))
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: 'katcats-team.identity', order: -100, locale: NS,
    inject: () => ({ hooks: { directory: model.state, chats: chats.state }, openSettings }),
  }, BotHeaderAction))
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
    name: 'sidebar.workspaces', priority: -100, locale: NS, store: sidebarView,
    inject: (): TeamSidebarInjected => ({
      hooks: { directory: model.state, chats: chats.state, sidebarOverflow: sidebarOverflow.source, sidebarReveal,
        workspaces: ctx.workspaces.list, sidebarSessionStatus: sidebarSessionStatus.source },
      entityActions: {
        pin: async (entity, pinned) => {
          if (pinned) await ctx.uiWorkspace.pinSession(entity.sessionId)
          else await ctx.uiWorkspace.unpinSession(entity.sessionId)
        },
        move: async (entity, groupId) => {
          if (entity.kind === 'bot') await save({ id: entity.id, groupId })
          else await chats.update({ id: entity.id, groupId })
        },
        rename: ui.renameEntity,
        copyId: async (entity) => {
          await navigator.clipboard.writeText(entity.sessionId)
          if (!disposed) ui.notify('entity.copied', true)
        },
        remove: ui.deleteEntity,
      },
      observeScrollList: sidebarOverflow.attach,
      scrollDown: sidebarOverflow.scrollDown,
      openHeadquarters: () => { headquarters.open() },
      commands: {
        openBot,
        openChat,
        createChat: ui.createChat,
        createBot: requestCreate,
        createGroup: ui.createGroup,
        renameGroup: ui.renameGroup,
        removeGroup: ui.removeGroup,
        moveGroup: request => model.moveGroup(request),
        moveBot: (id, groupId) => save({ id, groupId }),
        retry: () => { void restart() },
      },
    }),
  }, TeamSidebar))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'katcats-team.dialogs', locale: NS,
    inject: (): TeamOverlaysInjected => ({
      hooks: { teamUi: ui.source }, close: ui.closeDialog, dismissNotice: ui.dismissNotice,
      createBot: async (request: CreateBotRequest) => {
        try {
          const bot = await model.createBot(request)
          if (disposed) return
          ui.closeDialog()
          ui.notify('team.created', true, bot.name)
          openCreatedBot(bot)
        } catch (error) { if (!disposed) ui.notify(error instanceof TeamRequestSupersededError ? 'team.outcomeUnknown' : 'team.createFailed', false) }
      },
      createGroup: async (name) => {
        try {
          await model.createGroup({ name })
          if (disposed) return
          ui.closeDialog()
          ui.notify('team.groupCreated', true)
        } catch (error) { if (!disposed) ui.notify(error instanceof TeamRequestSupersededError ? 'team.outcomeUnknown' : 'team.createFailed', false) }
      },
      renameGroup: async (request) => {
        try {
          await model.updateGroup(request)
          if (disposed) return
          ui.closeDialog()
          ui.notify('team.groupSaved', true)
        } catch (error) { if (!disposed) ui.notify(error instanceof TeamRequestSupersededError ? 'team.outcomeUnknown' : 'team.saveFailed', false) }
      },
      removeGroup: async (request) => {
        const name = model.state.getSnapshot().snapshot?.groups.find(group => group.id === request.id)?.name
        try {
          await model.removeGroup(request)
          if (disposed) return
          ui.closeDialog()
          ui.notify('team.groupRemoved', true, name)
        } catch (error) {
          if (!disposed) ui.notify(error instanceof TeamRequestSupersededError ? 'team.outcomeUnknown' : 'team.groupRemoveFailed', false)
        }
      },
      renameEntity: async (entity, name) => {
        try {
          if (entity.kind === 'bot') await model.updateBot({ id: entity.id, name })
          else await chats.update({ id: entity.id, name })
          if (disposed) return
          ui.closeDialog()
          ui.notify('entity.saved', true)
        } catch (error) {
          if (!disposed) ui.notify(error instanceof TeamRequestSupersededError ? 'team.outcomeUnknown' : 'team.saveFailed', false)
        }
      },
      deleteEntity: async (entity) => {
        const sessionId = entity.kind === 'bot'
          ? model.state.getSnapshot().snapshot?.bots.find(bot => bot.id === entity.id)?.sessionId
          : chats.state.getSnapshot().snapshot?.chats.find(chat => chat.id === entity.id)?.rootSessionId
        try {
          if (entity.kind === 'bot') await model.deleteBot({ id: entity.id })
          else await chats.deleteChat({ id: entity.id })
          if (disposed) return
          ui.closeDialog()
          ui.notify('entity.deleted', true, entity.name)
          if (sessionId !== undefined && selectedSession() === sessionId) {
            const main = model.state.getSnapshot().snapshot?.mainBotId
            if (main !== undefined) openBot(main)
          }
        } catch (error) {
          if (!disposed) ui.notify(entityDeletionFailure(error), false)
        }
      },
    }),
  }, TeamOverlays))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'katcats-team.chat-dialog', locale: NS,
    inject: (): ChatOverlayInjected => ({
      hooks: { teamUi: ui.source, directory: model.state, chats: chats.state }, close: ui.closeDialog,
      create: async (request) => {
        try {
          const chat = await chats.create(request)
          if (disposed) return
          ui.closeDialog()
          ui.notify('team.created', true, chat.name)
          openCreatedChat(chat)
        } catch (error) { if (!disposed) ui.notify(error instanceof TeamRequestSupersededError ? 'team.outcomeUnknown' : 'team.createFailed', false) }
      },
    }),
  }, ChatOverlay))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'katcats-team.worker-approvals', order: -200, locale: NS,
    inject: (): ChatApprovalsInjected => ({
      hooks: { directory: model.state, chats: chats.state },
      resolveReason: reason => ctx.locale.resolveText(reason),
      readOperation: (pending, signal) => pending.callId === undefined ? Promise.resolve(undefined)
        : readApprovalOperation(ctx.sessions, ctx.uiConversation, pending.sessionId, pending.callId, signal),
    }),
  }, ChatApprovals))
  const groupQuestions = createGroupQuestions(ctx.uiSession.sessionStatus, chats.state, connection.state, (pending) => {
    if (pending.callId !== undefined) ctx.get('userQuestionPanels')?.reveal(pending.sessionId, pending.callId)
  })
  ctx.effect(() => groupQuestions.dispose, 'katcats-team: original group questions')

  const roomActivityLifetime = new AbortController()
  ctx.effect(() => () => { roomActivityLifetime.abort() }, 'katcats-team: room execution subscriptions')
  const watchRoomActivity: GroupRoomInjected['watchRoomActivity'] = (chatId, signal) => observeRoomActivity({
    sessions: ctx.sessions, chats: chats.state, connection,
  }, chatId, AbortSignal.any([signal, roomActivityLifetime.signal]))
  const headquarters = createHeadquartersState(watchRoomActivity)
  ctx.effect(() => headquarters.dispose, 'katcats-team: headquarters selection subscriptions')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'katcats-team.headquarters', locale: 'katcats.room',
    inject: (): HeadquartersInjected => ({
      hooks: { headquarters: headquarters.source, directory: model.state, chats: chats.state,
        connection: connection.state, statuses: ctx.uiSession.sessionStatus },
      close: headquarters.close, select: headquarters.select, copyText,
      openChat: id => { headquarters.close(); openChat(id) },
      openBot: id => { headquarters.close(); openBot(id) },
    }),
  }, Headquarters))
  const emptyRoomEvents = createSnapshotStore<SessionEventWindow>({ entries: [], hasMore: false,
    revision: 0, change: { kind: 'replace', entries: [] } })
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: 'katcats-team.dispatch-room', order: -90, locale: 'katcats.room',
    inject: (sessionId: SessionId): GroupRoomInjected => {
      const binding = ctx.sessions.binding(sessionId)
      return {
        hooks: { chats: chats.state, directory: model.state, roomEvents: binding?.eventSource ?? emptyRoomEvents,
          roomConnection: connection.state, roomStatuses: ctx.uiSession.sessionStatus, groupQuestions: groupQuestions.source },
        watchRoomActivity, copyText,
        loadRoomHistory: async () => {
          if (binding === undefined || disposed || ctx.sessions.binding(sessionId) !== binding
            || connection.state.getSnapshot() !== 'connected') throw new Error('Group history unavailable')
          await binding.session.loadThrough(0 as SessionSeq)
        },
      }
    },
  }, GroupRoomAction))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'katcats-team.worker-questions', order: -190, locale: NS,
    children: { 'katcats.group.question-panel': { kind: 'single', scope: 'session' } },
    inject: (): ChatQuestionsInjected => ({
      hooks: { directory: model.state, chats: chats.state, groupQuestions: groupQuestions.source,
        questionConnection: connection.state, questionGeneration: connection.generation },
      retainQuestion: (target, signal) => retainGroupQuestion({ sessions: ctx.sessions, chats: chats.state,
        directory: model.state, questions: groupQuestions.source, connection }, target, signal),
      revealQuestion: target => !disposed && connection.state.getSnapshot() === 'connected'
        && groupQuestionAvailable(target, chats.state.getSnapshot(), model.state.getSnapshot())
        && groupQuestions.source.getSnapshot().some(item => item.pending === target.pending)
        && target.pending.callId !== undefined
        && (ctx.get('userQuestionPanels')?.reveal(target.pending.sessionId, target.pending.callId) ?? false),
    }),
  }, ChatQuestions))
  ctx.slots.inject('katcats.group.question-panel', () => ctx.slots.register({
    name: 'katcats.group.question-panel', locale: NS,
  }, GroupQuestionPanel))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'katcats-team.chat-controls', order: -100, locale: NS,
    inject: (): ChatControlsInjected => ({ hooks: { directory: model.state, chats: chats.state, groupQuestions: groupQuestions.source }, control: async (action, request) => {
      try { await chats.control(action, request) }
      catch (error) { if (!disposed) ui.notify(error instanceof TeamRequestSupersededError ? 'team.outcomeUnknown' : 'chat.controlFailed', false); throw error }
    } }),
  }, ChatControls))
  const groupMessageInjected = (sessionId: SessionId): GroupMessageActionsInjected => {
    const binding = ctx.sessions.binding(sessionId)
    return {
      hooks: { chats: chats.state, directory: model.state, connection: connection.state,
        connectionGeneration: connection.generation, groupMessageReceipt: messageFeedback.source(binding),
        composerBlock: ctx.conversation.blocks.storeFor(sessionId) },
      interrupt: () => {
        const groups = chats.state.getSnapshot()
        if (disposed || binding === undefined || ctx.sessions.binding(sessionId) !== binding
          || connection.generation.getSnapshot() === undefined
          || connection.state.getSnapshot() !== 'connected' || groups.phase !== 'ready'
          || ctx.conversation.blocks.storeFor(sessionId).getSnapshot() !== undefined
          || !ctx.remoteAccess.source('session', sessionId, 'session/prompt').getSnapshot()
          || !groups.snapshot?.chats.some(chat => chat.rootSessionId === sessionId)) return
        ctx.conversation.input.for(binding.ctx).submit('steer', 'click')
      },
    }
  }
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'katcats-team.interrupt-and-adjust', order: 100, locale: NS,
    inject: groupMessageInjected,
  }, GroupMessageActions))
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock', id: 'katcats-team.message-receipt', order: -100, locale: NS,
    inject: groupMessageInjected,
  }, GroupMessageFeedback))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'katcats-relay', locale: NS,
    children: { 'katcats.group.delivered-files': { kind: 'single', scope: 'session' } },
    inject: (): ChatRelayActionsInjected & GroupIdentityInjected => ({
      hooks: { groupDirectory: chats.state },
      copyRelayText: (text) => { void copyText(text) },
      openRelayMember: (id) => {
        if (disposed) return
        const directory = model.state.getSnapshot()
        if (directory.phase !== 'ready' || !directory.snapshot?.bots.some(bot => bot.id === id)) {
          ui.notify('team.openFailed', false)
          return
        }
        openBot(id)
      },
    }),
  }, ChatRelayMessage))
  ctx.slots.inject('katcats.group.delivered-files', () => ctx.slots.register({
    name: 'katcats.group.delivered-files', locale: NS,
    children: { 'katcats.group.delivered-cards': { kind: 'single', scope: 'session' } },
    inject: (): GroupDeliveredFilesInjected => ({
      hooks: { groupDirectory: chats.state, deliveryDirectory: model.state,
        deliveryConnection: connection.state, deliveryGeneration: connection.generation },
      retainFiles: (target, signal) => retainGroupFiles({ sessions: ctx.sessions, chats: chats.state, directory: model.state,
        connection }, target, signal),
    }),
  }, GroupDeliveredFiles))
  ctx.slots.inject('katcats.group.delivered-cards', () => ctx.slots.register({
    name: 'katcats.group.delivered-cards',
  }, GroupDeliveredCards))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'katcats-task', locale: TASKS_NS,
    inject: () => ({ hooks: { groupDirectory: chats.state } }),
  }, GroupTaskLifecycle))

  const initialSelection = (): void => {
    const team = model.state.getSnapshot()
    const group = chats.state.getSnapshot()
    const directory = team.snapshot
    const groups = group.snapshot
    if (disposed || !firstSnapshot || !initialTeamReceived || !initialChatsReceived || directory === null || groups === null) return
    if (team.phase !== 'ready' || group.phase !== 'ready' || connection.state.getSnapshot() !== 'connected') return
    const main = directory.bots.find(bot => bot.id === directory.mainBotId)
    if (main === undefined) return
    const sessions = ctx.sessions.list.getSnapshot()
    if (sessions.phase === 'ready' && sessions.ids.includes(main.sessionId)) {
      openConversation(main.sessionId, true)
      return
    }
    if (initialCatalogRequested) return
    initialCatalogRequested = true
    const request = navigation
    void ctx.sessions.refresh().then(() => {
      if (!disposed && firstSnapshot && request === navigation) {
        initialSelection()
        if (firstSnapshot) ui.notify('team.openFailed', false)
      }
    }, () => {
      if (!disposed && firstSnapshot && request === navigation) ui.notify('team.openFailed', false)
    })
  }
  ctx.effect(() => {
    const stopSessions = ctx.sessions.list.subscribe(initialSelection)
    const stopConnection = connection.state.subscribe(initialSelection)
    return () => { stopSessions(); stopConnection() }
  }, 'katcats-team: main Bot startup selection')

  const createControl = () => {
    const stream = remote.$stream<TeamFrame>({
      name: 'Katcats team directory', open: signal => remote.katcatsTeam.follow(signal),
      ended: accepted => accepted ? new RemoteStreamCarrierError('Team directory stream ended') : new Error('Team directory has no snapshot'),
    })
    return new RemoteSnapshotStream<Extract<TeamFrame, { type: 'snapshot' }>, Exclude<TeamFrame, { type: 'snapshot' }>>(stream, {
      name: 'Katcats team directory', isSnapshot: (frame): frame is Extract<TeamFrame, { type: 'snapshot' }> => frame.type === 'snapshot',
      replace: (frame) => {
        initialTeamReceived = true
        model.replace(frame.value)
        initialSelection()
      },
      update: (frame) => {
        const known = new Set(model.state.getSnapshot().snapshot?.bots.map(bot => bot.id) ?? [])
        model.replace(frame.value)
        const created = frame.value.bots.filter(bot => bot.kind === 'ordinary' && !known.has(bot.id))
        if (created.length > 0) openCreatedBot(created[0]!)
      },
      failed: () => { model.failed() },
    })
  }
  const createChatControl = () => {
    const stream = remote.$stream<ChatFrame>({
      name: 'Katcats group directory', open: signal => remote.katcatsChats.follow(signal),
      ended: accepted => accepted ? new RemoteStreamCarrierError('Group directory stream ended') : new Error('Group directory has no snapshot'),
    })
    return new RemoteSnapshotStream<Extract<ChatFrame, { type: 'snapshot' }>, Exclude<ChatFrame, { type: 'snapshot' }>>(stream, {
      name: 'Katcats group directory', isSnapshot: (frame): frame is Extract<ChatFrame, { type: 'snapshot' }> => frame.type === 'snapshot',
      replace: (frame) => { initialChatsReceived = true; chats.replace(frame.value); initialSelection() },
      update: (frame) => {
        const known = new Set(chats.state.getSnapshot().snapshot?.chats.map(chat => chat.id) ?? [])
        chats.replace(frame.value)
        const created = frame.value.chats.filter(chat => !known.has(chat.id))
        if (created.length > 0) openCreatedChat(created[0]!)
      }, failed: () => { chats.failed() },
    })
  }
  let control = createControl()
  let chatControl = createChatControl()
  const restart = async (): Promise<void> => {
    await control.dispose()
    await chatControl.dispose()
    if (disposed) return
    initialCatalogRequested = false
    initialTeamReceived = false
    initialChatsReceived = false
    control = createControl()
    chatControl = createChatControl()
    control.start()
    chatControl.start()
    ctx.modelDirectories.refreshCatalog()
  }
  ctx.on('connection/reset', () => {
    navigation++
    stopWaitingForSession?.()
    stopWaitingForSession = undefined
    initialCatalogRequested = false
    initialTeamReceived = false
    initialChatsReceived = false
    settingsRequest.set(null)
    model.resetGeneration()
    chats.resetGeneration()
    control.restart()
    chatControl.restart()
  })
  control.start()
  chatControl.start()
  ctx.effect(() => async () => {
    disposed = true
    stopWaitingForSession?.()
    stopWaitingForSession = undefined
    settingsRequest.set(null)
    model.dispose()
    chats.dispose()
    if (ctx.workspaceCategories.store.getSnapshot().activeCategoryId === CATEGORY) {
      const available = ctx.workspaceCategories.store.getSnapshot().categories.some(category => category.id === previousCategory)
      ctx.workspaceCategories.setActiveCategory(available ? previousCategory : undefined)
    }
    await control.dispose()
    await chatControl.dispose()
    await Promise.all([...memorySubscriptions].map(subscription => subscription.dispose()))
  }, 'katcats-team: model lifetime')
}

function HiddenComposerPermission() { return null }

function entityDeletionFailure(error: unknown): TeamKey {
  if (error instanceof TeamRequestSupersededError) return 'team.outcomeUnknown'
  const failure = remoteErrorOf(error)
  if (failure?.code !== 'katcats/organization') return 'entity.deleteFailed'
  const reason = failure.details.reason
  if (reason === 'bot-main') return 'entity.deleteMain'
  if (reason === 'bot-in-group') return 'entity.deleteInGroup'
  if (reason === 'active-automations') return 'entity.deleteScheduled'
  if (reason === 'bot-running') return 'entity.deleteRunning'
  if (reason === 'chat-busy' || reason === 'session-active') return 'entity.deleteBusy'
  return 'entity.deleteFailed'
}
