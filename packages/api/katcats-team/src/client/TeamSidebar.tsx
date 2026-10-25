/** Team directory occupying the existing Katcat workspace browsing region. */
import { useCallback, useId, useState } from 'react'
import type { MouseEvent } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button, IconEditOutlineRegular, IconPinFillRegular, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { TeamBot, TeamGroup } from '../types.ts'
import type { TeamChat } from '../chats-types.ts'
import type { TeamView } from './model.ts'
import type { ChatView } from './chat-model.ts'
import type { TeamSidebarActions } from './ui-state.ts'
import type { createSidebarViewStore } from './sidebar-view.ts'
import { CatAvatar } from './avatars.tsx'
import { ChatAvatar } from './ChatAvatar.tsx'
import { chatApprovals } from './chat-approvals.ts'
import { chatSidebarStatus } from './chat-sidebar-status.ts'
import { ChatSidebarStatus } from './ChatSidebarStatus.tsx'
import { EntityMenu } from './EntityMenu.tsx'
import type { EntityMenuActions, SidebarEntity } from './EntityMenu.tsx'
import css from './team.module.css'

/** Sidebar data and mutations are bound by the product registration. */
export interface TeamSidebarInjected {
  readonly hooks: {
    readonly directory: ObservableSnapshot<TeamView>
    readonly chats: ObservableSnapshot<ChatView>
    readonly sidebarOverflow: ObservableSnapshot<boolean>
    readonly workspaces: ObservableSnapshot<WorkspaceSnapshot>
    readonly sidebarSessionStatus: ObservableSnapshot<SessionStatusSnapshot>
  }
  readonly commands: TeamSidebarActions
  readonly entityActions: EntityMenuActions
  readonly observeScrollList: (element: HTMLDivElement | null) => void
  readonly scrollDown: () => void
}

/** Framework-derived owner, locale and private hooks for the team list. */
export type TeamSidebarProps = PropsRuntime<'sidebar.workspaces'> & PropsLocale<'katcats.team'>
  & PropsStore<ReturnType<typeof createSidebarViewStore>> & InjectFace<TeamSidebarInjected>

/**
 * Keep the main member separate from grouped private conversations.
 * @param props - Sidebar geometry, directory hook and narrow commands.
 * @returns The fixed main member followed by logical groups.
 */
export function TeamSidebar({
  wide, expandSidebar, useDirectory, useChats, useSessions, useSidebarSessionStatus, usePanelInfo,
  useStore, useSidebarOverflow, useWorkspaces, actions, commands, entityActions, observeScrollList, scrollDown, t,
}: TeamSidebarProps) {
  const view = useDirectory(value => value)
  const chatView = useChats(value => value)
  const statuses = useSidebarSessionStatus(value => value)
  const collapsedGroups = useStore(value => value.collapsedGroups)
  const moreBelow = useSidebarOverflow(value => value)
  const workspaces = useWorkspaces(value => value)
  const [menu, setMenu] = useState<{ entity: SidebarEntity; anchor: HTMLButtonElement } | null>(null)
  const [groupMenu, setGroupMenu] = useState<{ groupId: TeamGroup['id']; anchor: HTMLButtonElement } | null>(null)
  const [moving, setMoving] = useState(false)
  const [moveFailed, setMoveFailed] = useState(false)
  const [groupMoveFailed, setGroupMoveFailed] = useState(false)
  const listId = useId()
  const snapshot = view.snapshot
  const currentId = useSessions(state => state.ids.find(id => (state.byId[id]?.retainedBy.mainView ?? 0) > 0))
  const conversationVisible = usePanelInfo(value => value.activePanelId === null)
  const main = snapshot?.bots.find(bot => bot.id === snapshot.mainBotId)
  const botGroups = snapshot?.groups.filter(group => group.kind === 'bots') ?? []
  const customGroups = botGroups.filter(group => !group.system)
  const orderedGroups = [
    ...customGroups,
    ...(snapshot?.groups.filter(group => group.kind === 'chats') ?? []),
    ...botGroups.filter(group => group.system),
  ]
  const botEntity = (bot: TeamBot): SidebarEntity => ({ kind: 'bot', id: bot.id, name: bot.name, sessionId: bot.sessionId, currentGroup: bot.groupId })
  const chatEntity = (chat: TeamChat): SidebarEntity => ({ kind: 'chat', id: chat.id, name: chat.name, sessionId: chat.rootSessionId, currentGroup: chat.groupId })
  const menuBot = menu?.entity.kind === 'bot' ? snapshot?.bots.find(bot => bot.kind === 'ordinary' && bot.id === menu.entity.id) : undefined
  const menuChat = menu?.entity.kind === 'chat' ? chatView.snapshot?.chats.find(chat => chat.id === menu.entity.id) : undefined
  const menuEntity = menuBot !== undefined ? botEntity(menuBot) : menuChat !== undefined ? chatEntity(menuChat) : undefined
  const menuGroup = customGroups.find(group => group.id === groupMenu?.groupId)
  const menuGroupIndex = customGroups.findIndex(group => group.id === menuGroup?.id)
  const getMenuAnchor = useCallback(() => menu?.anchor.getBoundingClientRect() ?? null, [menu])
  const getGroupMenuAnchor = useCallback(() => groupMenu?.anchor.getBoundingClientRect() ?? null, [groupMenu])
  const pinned = new Map(workspaces.pinnedSessionIds.map((id, index) => [id, index]))
  const entityReady = view.phase === 'ready' && chatView.phase === 'ready'
  const openMenu = (event: MouseEvent<HTMLButtonElement>, entity: SidebarEntity): void => {
    if (moving) return
    event.preventDefault()
    setMoveFailed(false)
    setGroupMoveFailed(false)
    setGroupMenu(null)
    setMenu({ entity, anchor: event.currentTarget })
  }
  const openGroupMenu = (event: MouseEvent<HTMLButtonElement>, group: TeamGroup): void => {
    if (moving) return
    event.preventDefault()
    setMoveFailed(false)
    setGroupMoveFailed(false)
    setMenu(null)
    setGroupMenu({ groupId: group.id, anchor: event.currentTarget })
  }
  const selectGroupAction = (action: string): void => {
    if (moving || menuGroup === undefined) return
    if (action === 'remove') {
      setGroupMenu(null)
      commands.removeGroup(menuGroup)
      return
    }
    if (action !== 'up' && action !== 'down') return
    setMoving(true)
    setGroupMoveFailed(false)
    void commands.moveGroup({ id: menuGroup.id, direction: action }).then(() => {
      setGroupMenu(null)
    }, () => { setGroupMoveFailed(true) }).finally(() => { setMoving(false) })
  }
  const runEntityAction = (action: (entity: SidebarEntity) => Promise<void>, target?: TeamGroup['id']): void => {
    if (moving || !entityReady || menuEntity === undefined) return
    setMoving(true)
    setMoveFailed(false)
    void action(menuEntity).then(() => {
      if (target !== undefined) actions.setGroupCollapsed(target, false)
      setMenu(null)
    }, () => { setMoveFailed(true) }).finally(() => { setMoving(false) })
  }
  const openEntityDialog = (action: (entity: SidebarEntity) => void): void => {
    if (moving || !entityReady || menuEntity === undefined) return
    setMenu(null)
    action(menuEntity)
  }
  const row = (bot: TeamBot, isMain = false) => (
    <div key={bot.id} className={isMain ? css.mainRow : css.memberRow}>
      <Tooltip label={bot.name} disabled={wide}>
        <button type="button" className={isMain ? css.mainBot : css.botRow}
          data-active={conversationVisible && currentId === bot.sessionId ? '' : undefined}
          data-wide={wide ? '' : undefined}
          aria-label={bot.name} aria-current={conversationVisible && currentId === bot.sessionId ? 'page' : undefined}
          onClick={() => { commands.openBot(bot.id) }}
          onContextMenu={isMain ? undefined : (event) => { openMenu(event, botEntity(bot)) }}>
          <CatAvatar appearance={bot.avatar} size={isMain ? wide ? 96 : 30 : 28} />
          {wide && <span className={css.memberText}>
            <span className={css.memberIdentity}>
              <span className={css.memberName}>{bot.name}</span>
              {isMain && <span className={css.mainBadge}>{t('team.main')}</span>}
              {!isMain && pinned.has(bot.sessionId) && <IconPinFillRegular className={css.pinnedMark} size={12} aria-hidden="true" />}
            </span>
            <span className={css.memberRole}>{isMain ? t('team.mainRole') : bot.role || t('team.general')}</span>
          </span>}
        </button>
      </Tooltip>
      {!isMain && wide && <Tooltip label={t('entity.menu', { name: bot.name })}>
        <button type="button" className={css.memberMenu} aria-label={t('entity.menu', { name: bot.name })}
          aria-haspopup="menu" aria-expanded={menuBot?.id === bot.id} disabled={moving}
          onClick={(event) => { openMenu(event, botEntity(bot)) }}><span aria-hidden="true">···</span></button>
      </Tooltip>}
    </div>
  )
  const chatRow = (chat: TeamChat) => {
    const requests = chatApprovals(chat, statuses)
    const status = chatSidebarStatus(chat, chatView, statuses)
    return <div key={chat.id} className={css.memberRow}>
      <Tooltip label={chat.name} disabled={wide}>
        <button type="button" className={css.botRow} aria-label={chat.name} data-wide={wide ? '' : undefined}
          aria-description={t(`sidebar.chatStatus.${status}`)}
          data-active={conversationVisible && currentId === chat.rootSessionId ? '' : undefined}
          aria-current={conversationVisible && currentId === chat.rootSessionId ? 'page' : undefined}
          onContextMenu={(event) => { openMenu(event, chatEntity(chat)) }}
          onClick={() => { commands.openChat(chat.id) }}>
          <ChatAvatar appearances={snapshot?.bots.filter(bot => chat.memberIds.includes(bot.id)).map(bot => bot.avatar) ?? []} />
          {wide && <span className={css.memberText}>
            <span className={css.memberIdentity}><span className={css.memberName}>{chat.name}</span>
              <ChatSidebarStatus status={status} label={t(`sidebar.chatStatus.${status}`)} />
              {pinned.has(chat.rootSessionId) && <IconPinFillRegular className={css.pinnedMark} size={12} aria-hidden="true" />}</span>
            <span className={css.memberRole}>{requests.length > 0 ? t('approval.pendingCount', { count: requests.length }) : t(`chat.${chat.status}`)}</span>
          </span>}
          {requests.length > 0 && <span className={css.approvalBadge} aria-hidden="true">{requests.length}</span>}
        </button>
      </Tooltip>
      {wide && <Tooltip label={t('entity.menu', { name: chat.name })}>
        <button type="button" className={css.memberMenu} aria-label={t('entity.menu', { name: chat.name })}
          aria-haspopup="menu" aria-expanded={menuChat?.id === chat.id} disabled={moving}
          onClick={(event) => { openMenu(event, chatEntity(chat)) }}><span aria-hidden="true">···</span></button>
      </Tooltip>}
    </div>
  }
  const section = (group: TeamGroup) => {
    const members = snapshot?.bots.filter(bot => bot.kind !== 'main' && bot.groupId === group.id) ?? []
    const chats = chatView.snapshot?.chats.filter(chat => chat.groupId === group.id) ?? []
    const label = group.system ? t(group.kind === 'chats' ? 'team.chats' : 'team.bots') : group.name
    const collapsed = collapsedGroups[group.id] === true
    const contentId = `${listId}-${group.id}`
    const entries = [
      ...members.map(bot => ({ sessionId: bot.sessionId, node: row(bot) })),
      ...chats.map(chat => ({ sessionId: chat.rootSessionId, node: chatRow(chat) })),
    ].sort((a, b) => (pinned.get(a.sessionId) ?? Infinity) - (pinned.get(b.sessionId) ?? Infinity))
    return <section key={group.id} className={css.group} aria-label={label}>
      {wide && <div className={css.groupHeading}>
        <button type="button" className={css.groupToggle} aria-expanded={!collapsed} aria-controls={contentId}
          onClick={() => { actions.setGroupCollapsed(group.id, !collapsed) }}>
          <svg className={css.groupChevron} data-expanded={!collapsed ? '' : undefined} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="m4.5 2.5 3.5 3.5-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg><span className={css.groupName}>{label}</span>
        </button>
        {!group.system && <Tooltip label={t('team.renameGroup')}>
          <button type="button" className={css.iconButton} aria-label={t('team.renameGroup')}
            onClick={() => { commands.renameGroup(group) }}><IconEditOutlineRegular size={13} /></button>
        </Tooltip>}
        {!group.system && <Tooltip label={t('team.groupMenu', { name: group.name })}>
          <button type="button" className={css.iconButton} aria-label={t('team.groupMenu', { name: group.name })}
            aria-haspopup="menu" aria-expanded={menuGroup?.id === group.id} disabled={moving}
            onClick={(event) => { openGroupMenu(event, group) }}><span aria-hidden="true">···</span></button>
        </Tooltip>}
        {group.kind === 'chats' && <Tooltip label={t('chat.new')}>
          <button type="button" className={css.iconButton} aria-label={t('chat.new')} disabled={chatView.phase !== 'ready'}
            onClick={commands.createChat}><span aria-hidden="true">+</span></button>
        </Tooltip>}
        {group.kind === 'bots' && <Tooltip label={t('team.newInGroup', { name: label })}>
          <button type="button" className={css.iconButton} aria-label={t('team.newInGroup', { name: label })}
            onClick={() => { commands.createBot(group.id) }}><span aria-hidden="true">+</span></button>
        </Tooltip>}
      </div>}
      <div id={contentId} hidden={wide && collapsed}>
        {entries.length > 0 ? entries.map(entry => entry.node)
          : wide && (group.kind === 'chats' ? <p className={css.empty}>{t('team.emptyChats')}</p>
            : <button type="button" className={css.emptyAction} onClick={() => { commands.createBot(group.id) }}>{t('team.emptyBots')}</button>)}
      </div>
    </section>
  }
  return <div className={css.sidebar} data-wide={wide ? '' : undefined}>
    {main === undefined ? <div className={css.mainSkeleton} aria-hidden="true" /> : row(main, true)}
    <Tooltip label={t('team.newGroup')} disabled={wide}>
      <button type="button" className={css.newGroup} disabled={snapshot === null}
        aria-label={t('team.newGroup')} onClick={() => { if (!wide) expandSidebar(); commands.createGroup() }}>
        <span aria-hidden="true">+</span>{wide && <span>{t('team.newGroup')}</span>}
      </button>
    </Tooltip>
    {view.phase === 'failed' && <div className={css.queryError} role="status">
      {wide && <span>{t('team.loadFailed')}</span>}
      <Button size="sm" onClick={commands.retry}>{t('team.retry')}</Button>
    </div>}
    <div className={css.listArea}>
      <div className={css.groupList} ref={observeScrollList} tabIndex={0} role="region" aria-label={t('team.list')}>
        <div className={css.groupListContent}>
          {orderedGroups.map(section)}
          {chatView.phase === 'failed' && <div className={css.queryError} role="status">
            {wide && <span>{t('chat.loadFailed')}</span>}<Button size="sm" onClick={commands.retry}>{t('team.retry')}</Button>
          </div>}
          {snapshot === null && <><div className={css.skeletonRow} /><div className={css.skeletonRow} /></>}
        </div>
      </div>
      {moreBelow && <button type="button" className={css.moreBelow} aria-label={t('team.moreBelow')} onClick={scrollDown}>
        {wide && <span>{t('team.moreBelow')}</span>}
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 4.5 3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>}
    </div>
    {moveFailed && <p className={css.empty} role="alert">{t('entity.actionFailed')}</p>}
    {groupMoveFailed && <p className={css.empty} role="alert">{t('team.groupMoveFailed')}</p>}
    {menuEntity !== undefined && <EntityMenu key={`${menuEntity.kind}:${menuEntity.id}`} entity={menuEntity} open
      getAnchorRect={getMenuAnchor} onClose={() => { if (!moving) setMenu(null) }} busy={moving || !entityReady}
      pinned={pinned.has(menuEntity.sessionId)} pinAvailable={workspaces.phase === 'ready' && workspaces.state !== 'error'}
      labels={{ pin: t('entity.pin'), unpin: t('entity.unpin'), moveTo: t('entity.moveTo'), rename: t('entity.rename'), copyId: t('entity.copyId'), remove: t('entity.remove') }}
      targets={snapshot?.groups.filter(group => !group.system || group.kind === (menuEntity.kind === 'bot' ? 'bots' : 'chats'))
        .map(group => ({ id: group.id, name: group.system ? t(group.kind === 'bots' ? 'team.bots' : 'team.chats') : group.name })) ?? []}
      onPin={() => { runEntityAction(entity => entityActions.pin(entity, !pinned.has(entity.sessionId))) }}
      onMove={(groupId) => { runEntityAction(entity => entityActions.move(entity, groupId), groupId) }}
      onRename={() => { openEntityDialog(entityActions.rename) }} onCopyId={() => { runEntityAction(entityActions.copyId) }}
      onRemove={() => { openEntityDialog(entityActions.remove) }} />}
    <Menu open={menuGroup !== undefined} anchor={null} getAnchorRect={getGroupMenuAnchor} portal autoFocus compact
      onClose={() => { setGroupMenu(null) }} onSelect={selectGroupAction} items={[
        { id: 'up', label: t('team.moveGroupUp'), disabled: moving || menuGroupIndex <= 0 },
        { id: 'down', label: t('team.moveGroupDown'), disabled: moving || menuGroupIndex >= customGroups.length - 1 },
        { id: 'remove', label: t('team.removeGroup'), disabled: moving },
      ]} />
  </div>
}
