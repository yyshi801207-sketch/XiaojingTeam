// @vitest-environment jsdom
/** Sidebar organization over synthetic members and browser-local preferences. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { BotId, GroupId, TeamBot, TeamSnapshot } from '../src/types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { ChatDelivery, ChatDeliveryId, ChatId, ChatRunId, TeamChat } from '../src/chats-types.ts'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { TeamSidebar } from '../src/client/TeamSidebar.tsx'
import type { TeamSidebarProps } from '../src/client/TeamSidebar.tsx'
import type { TeamView } from '../src/client/model.ts'
import type { ChatView } from '../src/client/chat-model.ts'
import { createSidebarOverflow, createSidebarViewStore } from '../src/client/sidebar-view.ts'
import { zh } from '../src/client/locales.ts'

const ordinary = 'ordinary' as GroupId
const custom = 'content' as GroupId
const chatGroup = 'chats' as GroupId
const main: TeamBot = { id: 'main' as BotId, kind: 'main', name: 'Katcats', role: '', avatar: { shape: 'fluffy', color: '#2288FF' },
  model: { kind: 'follow-global' }, workDir: '/synthetic/main', groupId: null, sessionId: 'main-session' as SessionId }
const writer: TeamBot = { ...main, id: 'writer' as BotId, kind: 'ordinary', name: 'Writer', groupId: ordinary, sessionId: 'writer-session' as SessionId }
const snapshot: TeamSnapshot = { revision: 0, mainBotId: main.id, bots: [main, writer],
  modelCapabilities: { override: true, followGlobal: true },
  groups: [{ id: chatGroup, name: 'Chats', kind: 'chats', system: true },
    { id: custom, name: 'Content', kind: 'bots', system: false },
    { id: ordinary, name: 'Ordinary', kind: 'bots', system: true }] }
const chat: TeamChat = { id: 'editorial' as ChatId, name: 'Editorial', groupId: chatGroup, rootSessionId: 'chat-session' as SessionId,
  workDir: '/synthetic/chats/editorial', memberIds: [writer.id], managerId: null, memberRoles: [], executors: [], relayLimit: 6,
  generation: 0, status: 'active', pauseReason: null, run: null, error: null }
const t = makeTranslate(zh)

function setup() {
  const directory = createSnapshotStore<TeamView>({ phase: 'ready', snapshot, catalog: null })
  const chats = createSnapshotStore<ChatView>({ phase: 'ready', snapshot: { revision: 0, chats: [], deliveries: [], activities: [], relayLimit: 6 } })
  const view = createSidebarViewStore().create()
  const overflow = createSnapshotStore(false)
  const statuses = createSnapshotStore<SessionStatusSnapshot>(new Map())
  const workspaces = createSnapshotStore<WorkspaceSnapshot>({ items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null })
  const commands = { openBot: vi.fn(), moveBot: vi.fn<(id: BotId, groupId: GroupId) => Promise<void>>().mockResolvedValue(undefined),
    openChat: vi.fn(), createChat: vi.fn(), createBot: vi.fn(), createGroup: vi.fn(), renameGroup: vi.fn(), removeGroup: vi.fn(),
    moveGroup: vi.fn<TeamSidebarProps['commands']['moveGroup']>().mockResolvedValue(undefined), retry: vi.fn() }
  const entityActions = { pin: vi.fn<TeamSidebarProps['entityActions']['pin']>().mockResolvedValue(undefined),
    move: vi.fn<TeamSidebarProps['entityActions']['move']>().mockResolvedValue(undefined), rename: vi.fn(),
    copyId: vi.fn<TeamSidebarProps['entityActions']['copyId']>().mockResolvedValue(undefined), remove: vi.fn() }
  const props = {
    wide: true, expandSidebar: vi.fn(), commands, entityActions, t,
    useDirectory: bindSnapshotSelector(directory), useChats: bindSnapshotSelector(chats),
    useWorkspaces: bindSnapshotSelector(workspaces),
    useStore: bindSnapshotSelector(view), actions: view.actions, useSidebarOverflow: bindSnapshotSelector(overflow),
    observeScrollList: vi.fn(), scrollDown: vi.fn(),
    useSessions: (select: (value: { ids: string[]; byId: Record<string, never> }) => unknown) => select({ ids: [], byId: {} }),
    useSidebarSessionStatus: bindSnapshotSelector(statuses),
    useSessionStatus: bindSnapshotSelector(statuses),
    usePanelInfo: (select: (value: { activePanelId: null }) => unknown) => select({ activePanelId: null }),
  } as TeamSidebarProps
  return { props, directory, chats, view, overflow, statuses, workspaces, commands, entityActions }
}

beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear() })

describe('team sidebar', () => {
  it('keeps the saved main appearance and orders custom groups, group chats, then ungrouped members', () => {
    const { props } = setup()
    render(<TeamSidebar {...props} />)
    const avatar = screen.getByRole('button', { name: main.name }).querySelector('svg')
    expect(avatar?.getAttribute('width')).toBe('96')
    expect(avatar?.style.getPropertyValue('--katcats-avatar-color')).toBe(main.avatar.color)
    expect(screen.getByRole('button', { name: writer.name }).querySelector('svg')?.getAttribute('width')).toBe('28')
    expect(screen.queryByRole('button', { name: t('entity.menu', { name: main.name }) })).toBeNull()
    expect(screen.getAllByRole('region').map(region => region.getAttribute('aria-label'))).toEqual([
      zh['team.list'], 'Content', zh['team.chats'], zh['team.bots'],
    ])
    const createGroup = screen.getByRole('button', { name: zh['team.newGroup'] })
    const mainButton = screen.getByRole('button', { name: main.name })
    expect(mainButton.compareDocumentPosition(createGroup) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(createGroup.compareDocumentPosition(screen.getByRole('region', { name: 'Content' })) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    const badge = within(mainButton).getByText(zh['team.main'])
    expect(badge.previousElementSibling).toBe(within(mainButton).getByText(main.name))
    expect(badge.parentElement?.parentElement?.textContent).toContain(zh['team.mainRole'])
  })

  it('opens group creation from the top action and keeps each group plus bound to that group', () => {
    const { props, commands } = setup()
    render(<TeamSidebar {...props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['team.newGroup'] }))
    expect(commands.createGroup).toHaveBeenCalledOnce()
    expect(commands.createBot).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: t('team.newInGroup', { name: 'Content' }) }))
    expect(commands.createBot).toHaveBeenCalledExactlyOnceWith(custom)
    fireEvent.click(screen.getByRole('button', { name: t('team.newInGroup', { name: zh['team.bots'] }) }))
    expect(commands.createBot).toHaveBeenLastCalledWith(ordinary)
  })

  it('folds sections independently and keeps the group create control separate from the toggle', () => {
    const { props, commands } = setup()
    render(<TeamSidebar {...props} />)
    const toggle = screen.getByRole('button', { name: zh['team.bots'] })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle)
    expect(screen.queryByRole('button', { name: writer.name })).toBeNull()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: t('team.newInGroup', { name: zh['team.bots'] }) }))
    expect(commands.createBot).toHaveBeenCalledExactlyOnceWith(ordinary)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('button', { name: 'Content' }).getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: zh['team.chats'] }))
    expect(screen.getByRole('button', { name: zh['team.chats'] }).getAttribute('aria-expanded')).toBe('false')
  })

  it('remembers folds across a new store instance without saving member records', async () => {
    const first = createSidebarViewStore().create()
    first.actions.setGroupCollapsed(custom, true)
    await waitFor(() => { expect(localStorage.getItem('katcats.sidebar.view.v1')).toContain(custom) })
    const next = createSidebarViewStore().create()
    expect(next.getSnapshot().collapsedGroups[custom]).toBe(true)
    expect(next.getSnapshot().collapsedGroups[ordinary]).toBeUndefined()
  })

  it('moves an ordinary member through the existing identity and group command, and can return it to Ordinary Bots', async () => {
    const { props, directory, entityActions, view } = setup()
    render(<TeamSidebar {...props} />)
    fireEvent.click(screen.getByRole('button', { name: t('entity.menu', { name: writer.name }) }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh['entity.moveTo'] }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Content' }))
    await waitFor(() => { expect(entityActions.move).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'bot', id: writer.id, sessionId: writer.sessionId }), custom) })
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
    expect(view.getSnapshot().collapsedGroups[custom]).toBe(false)
    act(() => { directory.set({ ...directory.getSnapshot(), snapshot: { ...snapshot, bots: [main, { ...writer, groupId: custom }] } }) })
    fireEvent.contextMenu(screen.getByRole('button', { name: writer.name }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh['entity.moveTo'] }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh['team.bots'] }))
    await waitFor(() => { expect(entityActions.move).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'bot', id: writer.id }), ordinary) })
    expect(directory.getSnapshot().snapshot?.bots[1]?.sessionId).toBe(writer.sessionId)
    expect(directory.getSnapshot().snapshot?.bots[1]?.workDir).toBe(writer.workDir)
  })

  it('reports a refused move and keeps the member in its saved group', async () => {
    const { props, directory, entityActions } = setup()
    entityActions.move.mockRejectedValueOnce(new Error('synthetic save failure'))
    render(<TeamSidebar {...props} />)
    fireEvent.click(screen.getByRole('button', { name: t('entity.menu', { name: writer.name }) }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh['entity.moveTo'] }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Content' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', zh['entity.actionFailed'])
    expect(directory.getSnapshot().snapshot?.bots[1]?.groupId).toBe(ordinary)
    expect(screen.getByRole('menuitem', { name: 'Content' })).toBeTruthy()
  })

  it('shares custom groups with group chats and limits the move submenu to permitted destinations', async () => {
    const { props, directory, chats, entityActions } = setup()
    chats.set({ ...chats.getSnapshot(), snapshot: { ...chats.getSnapshot().snapshot!, chats: [chat] } })
    render(<TeamSidebar {...props} />)
    fireEvent.contextMenu(screen.getByRole('button', { name: chat.name }))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      zh['entity.pin'], zh['entity.moveTo'], zh['entity.rename'], zh['entity.copyId'], zh['entity.remove'],
    ])
    fireEvent.click(screen.getByRole('menuitem', { name: zh['entity.moveTo'] }))
    expect(screen.queryByRole('menuitem', { name: zh['team.bots'] })).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: zh['team.chats'] }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Content' }))
    await waitFor(() => { expect(entityActions.move).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'chat', id: chat.id, sessionId: chat.rootSessionId }), custom) })
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
    act(() => {
      directory.set({ ...directory.getSnapshot(), snapshot: { ...snapshot, bots: [main, { ...writer, groupId: custom }] } })
      chats.set({ ...chats.getSnapshot(), snapshot: { ...chats.getSnapshot().snapshot!, chats: [{ ...chat, groupId: custom }] } })
    })
    const shared = within(screen.getByRole('region', { name: 'Content' }))
    expect(shared.getByRole('button', { name: writer.name })).toBeTruthy()
    expect(shared.getByRole('button', { name: chat.name })).toBeTruthy()
    expect(within(screen.getByRole('region', { name: zh['team.chats'] })).queryByRole('button', { name: chat.name })).toBeNull()
  })

  it('routes rename, copy and deletion to the selected entity owner without changing directory records', async () => {
    const { props, directory, chats, entityActions } = setup()
    chats.set({ ...chats.getSnapshot(), snapshot: { ...chats.getSnapshot().snapshot!, chats: [chat] } })
    render(<TeamSidebar {...props} />)
    fireEvent.click(screen.getByRole('button', { name: t('entity.menu', { name: writer.name }) }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh['entity.rename'] }))
    expect(entityActions.rename).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'bot', id: writer.id }))
    fireEvent.click(screen.getByRole('button', { name: t('entity.menu', { name: chat.name }) }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh['entity.copyId'] }))
    await waitFor(() => { expect(entityActions.copyId).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'chat', id: chat.id, sessionId: chat.rootSessionId })) })
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
    fireEvent.contextMenu(screen.getByRole('button', { name: chat.name }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh['entity.remove'] }))
    expect(entityActions.remove).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'chat', id: chat.id }))
    expect(directory.getSnapshot().snapshot?.bots).toContain(writer)
    expect(chats.getSnapshot().snapshot?.chats).toContain(chat)
    expect(screen.getByRole('button', { name: chat.name })).toBeTruthy()
  })

  it('derives pin actions and list order from the public workspace stream, including unpin and not-ready states', async () => {
    const { props, directory, workspaces, entityActions } = setup()
    const editor = { ...writer, id: 'editor' as BotId, name: 'Editor', sessionId: 'editor-session' as SessionId }
    directory.set({ ...directory.getSnapshot(), snapshot: { ...snapshot, bots: [main, editor, writer] } })
    render(<TeamSidebar {...props} />)
    const names = () => within(screen.getByRole('region', { name: zh['team.bots'] })).getAllByRole('button').map(button => button.getAttribute('aria-label')).filter(name => name === editor.name || name === writer.name)
    expect(names()).toEqual([editor.name, writer.name])
    fireEvent.contextMenu(screen.getByRole('button', { name: writer.name }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh['entity.pin'] }))
    await waitFor(() => { expect(entityActions.pin).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'bot', id: writer.id }), true) })
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
    expect(names()).toEqual([editor.name, writer.name])
    act(() => { workspaces.set({ ...workspaces.getSnapshot(), pinnedSessionIds: [writer.sessionId] }) })
    expect(names()).toEqual([writer.name, editor.name])
    fireEvent.contextMenu(screen.getByRole('button', { name: writer.name }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh['entity.unpin'] }))
    await waitFor(() => { expect(entityActions.pin).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'bot', id: writer.id }), false) })
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
    act(() => { workspaces.set({ ...workspaces.getSnapshot(), phase: 'pending', state: 'loading' }) })
    fireEvent.contextMenu(screen.getByRole('button', { name: writer.name }))
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: zh['entity.unpin'] }).disabled).toBe(true)
  })

  it('invalidates an open entity menu when its saved entity disappears', () => {
    const { props, directory } = setup()
    render(<TeamSidebar {...props} />)
    fireEvent.contextMenu(screen.getByRole('button', { name: writer.name }))
    expect(screen.getByRole('menu')).toBeTruthy()
    act(() => { directory.set({ ...directory.getSnapshot(), snapshot: { ...snapshot, bots: [main] } }) })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('offers only custom groups a menu with bounded moves and explicit deletion', () => {
    const { props, commands } = setup()
    render(<TeamSidebar {...props} />)
    expect(screen.queryByRole('button', { name: t('team.groupMenu', { name: 'Ordinary' }) })).toBeNull()
    expect(screen.queryByRole('button', { name: t('team.groupMenu', { name: 'Chats' }) })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('team.groupMenu', { name: 'Content' }) }))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      zh['team.moveGroupUp'], zh['team.moveGroupDown'], zh['team.removeGroup'],
    ])
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: zh['team.moveGroupUp'] }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: zh['team.moveGroupDown'] }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('menuitem', { name: zh['team.removeGroup'] }))
    expect(commands.removeGroup).toHaveBeenCalledExactlyOnceWith(snapshot.groups.find(group => group.id === custom))
    expect(commands.moveGroup).not.toHaveBeenCalled()
  })

  it('moves a custom group through its menu while keeping the system sections fixed', async () => {
    const { props, directory, commands } = setup()
    const research = { id: 'research' as GroupId, name: 'Research', kind: 'bots', system: false } as const
    directory.set({ ...directory.getSnapshot(), snapshot: { ...snapshot, groups: [...snapshot.groups, research] } })
    render(<TeamSidebar {...props} />)
    fireEvent.click(screen.getByRole('button', { name: t('team.groupMenu', { name: 'Content' }) }))
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: zh['team.moveGroupUp'] }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: zh['team.moveGroupDown'] }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('menuitem', { name: zh['team.moveGroupDown'] }))
    await waitFor(() => { expect(commands.moveGroup).toHaveBeenCalledExactlyOnceWith({ id: custom, direction: 'down' }) })
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
    act(() => { directory.set({ ...directory.getSnapshot(), snapshot: { ...snapshot,
      groups: [snapshot.groups[0]!, research, snapshot.groups[2]!, snapshot.groups[1]!] } }) })
    expect(screen.getAllByRole('region').map(region => region.getAttribute('aria-label'))).toEqual([
      zh['team.list'], 'Research', 'Content', zh['team.chats'], zh['team.bots'],
    ])
    fireEvent.click(screen.getByRole('button', { name: t('team.groupMenu', { name: 'Content' }) }))
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: zh['team.moveGroupDown'] }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: zh['team.moveGroupUp'] }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('menuitem', { name: zh['team.moveGroupUp'] }))
    await waitFor(() => { expect(commands.moveGroup).toHaveBeenLastCalledWith({ id: custom, direction: 'up' }) })
  })

  it('keeps the saved order and menu available when a group move is refused', async () => {
    const { props, directory, commands } = setup()
    const research = { id: 'research' as GroupId, name: 'Research', kind: 'bots', system: false } as const
    directory.set({ ...directory.getSnapshot(), snapshot: { ...snapshot, groups: [...snapshot.groups, research] } })
    const before = directory.getSnapshot().snapshot
    commands.moveGroup.mockRejectedValueOnce(new Error('synthetic order save failure'))
    render(<TeamSidebar {...props} />)
    fireEvent.click(screen.getByRole('button', { name: t('team.groupMenu', { name: 'Content' }) }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh['team.moveGroupDown'] }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', zh['team.groupMoveFailed'])
    expect(directory.getSnapshot().snapshot).toEqual(before)
    expect(screen.getByRole('menuitem', { name: zh['team.moveGroupDown'] })).toBeTruthy()
  })

  it('renders the lower-content hint only from actual overflow and invokes the scroll action', () => {
    const { props, overflow } = setup()
    render(<TeamSidebar {...props} />)
    expect(screen.queryByRole('button', { name: zh['team.moreBelow'] })).toBeNull()
    act(() => { overflow.set(true) })
    fireEvent.click(screen.getByRole('button', { name: zh['team.moreBelow'] }))
    expect(props.scrollDown).toHaveBeenCalledOnce()
    act(() => { overflow.set(false) })
    expect(screen.queryByRole('button', { name: zh['team.moreBelow'] })).toBeNull()
  })

  it('places a live status mark beside each group name and exposes its description without changing navigation', () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    const { props, chats, statuses, commands } = setup()
    chats.set({ phase: 'ready', snapshot: { ...chats.getSnapshot().snapshot!, chats: [chat] } })
    render(<TeamSidebar {...props} />)
    const row = screen.getByRole('button', { name: chat.name })
    const icon = within(row).getByRole('img', { name: zh['sidebar.chatStatus.idle'] })
    expect(icon.previousElementSibling?.textContent).toBe(chat.name)
    const workerId = 'editorial-writer' as SessionId
    const running: TeamChat = { ...chat, generation: 1, run: { id: 'run' as ChatRunId, generation: 1, relayCount: 1 },
      executors: [{ botId: writer.id, sessionId: workerId }] }
    const delivery: ChatDelivery = { id: 'task' as ChatDeliveryId, chatId: chat.id, runId: running.run!.id, generation: 1,
      sourceSessionId: chat.rootSessionId, source: { kind: 'owner-message', messageId: 'owner' as MessageId }, botId: writer.id,
      executorSessionId: workerId, message: 'Write the report', inputMessageId: 'input' as MessageId, relayMessageId: 'relay' as MessageId,
      state: 'running', receipt: null, pass: null, relayed: false, error: null }
    act(() => {
      statuses.set(new Map([[workerId, { running: true, pendingInteraction: undefined, completionUnread: false }]]))
      chats.set({ phase: 'ready', snapshot: { ...chats.getSnapshot().snapshot!, chats: [running], deliveries: [delivery] } })
    })
    expect(within(row).getByRole('img', { name: zh['sidebar.chatStatus.running'] })).toBe(icon)
    expect(icon.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(row.getAttribute('aria-description')).toBe(zh['sidebar.chatStatus.running'])
    fireEvent.mouseEnter(icon)
    expect(screen.getByRole('tooltip', { hidden: true }).textContent).toBe(zh['sidebar.chatStatus.running'])
    fireEvent.click(row)
    expect(commands.openChat).toHaveBeenCalledExactlyOnceWith(chat.id)
  })
})

it('tracks viewport, content growth and scrolling, then releases its observers on detach', () => {
  let resize: (() => void) | undefined
  const disconnect = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe() {}
    disconnect = disconnect
  })
  const reducedMotion = vi.fn(() => ({ matches: true }))
  vi.stubGlobal('matchMedia', reducedMotion)
  const list = document.createElement('div')
  list.append(document.createElement('div'))
  Object.defineProperties(list, { clientHeight: { value: 100, configurable: true }, scrollHeight: { value: 300, configurable: true } })
  const scrollBy = vi.fn()
  list.scrollBy = scrollBy
  const overflow = createSidebarOverflow()
  overflow.attach(list)
  expect(overflow.source.getSnapshot()).toBe(true)
  list.scrollTop = 200
  list.dispatchEvent(new Event('scroll'))
  expect(overflow.source.getSnapshot()).toBe(false)
  Object.defineProperty(list, 'scrollHeight', { value: 400 })
  resize?.()
  expect(overflow.source.getSnapshot()).toBe(true)
  overflow.scrollDown()
  expect(scrollBy).toHaveBeenCalledWith({ top: 75, behavior: 'auto' })
  overflow.dispose()
  expect(disconnect).toHaveBeenCalledOnce()
  expect(overflow.source.getSnapshot()).toBe(false)
})
