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

function entryRow(name: string): HTMLElement {
  const row = screen.getByRole('button', { name }).closest<HTMLElement>('[data-sidebar-sort-entry]')
  if (row === null) throw new Error(`Missing sidebar sorting row: ${name}`)
  return row
}

/** Geometry stays aligned with the current DOM order because jsdom does not perform layout. */
function measureSidebar(): HTMLElement {
  const list = screen.getByRole('region', { name: zh['team.list'] })
  vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 1000))
  Object.defineProperties(list, { clientHeight: { configurable: true, value: 1000 },
    scrollHeight: { configurable: true, value: 1000 } })
  list.querySelectorAll('section').forEach((section, groupIndex) => {
    section.querySelectorAll<HTMLElement>('[data-sidebar-sort-entry]').forEach((row) => {
      vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => {
        const index = [...section.querySelectorAll('[data-sidebar-sort-entry]')].indexOf(row)
        return new DOMRect(0, 100 + groupIndex * 220 + index * 48, 400, 40)
      })
    })
  })
  return list
}

/** Supply pointer metadata directly so the mouse-event fallback works in jsdom versions without PointerEvent. */
function pointer(target: HTMLElement | Window, type: string, clientY: number, clientX = 40): void {
  if (type === 'pointerdown' && target instanceof HTMLButtonElement) {
    Object.assign(target, { setPointerCapture: vi.fn(), hasPointerCapture: () => false, releasePointerCapture: vi.fn() })
  }
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY })
  Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: 'mouse' }, isPrimary: { value: true } })
  fireEvent(target, event)
}

function pressEntry(name: string): void {
  pointer(screen.getByRole('button', { name }), 'pointerdown', entryRow(name).getBoundingClientRect().top + 20)
}

function moveEntryTo(name: string): void {
  pointer(window, 'pointermove', entryRow(name).getBoundingClientRect().top + 35)
}

function releaseEntryAt(name: string): void {
  pointer(window, 'pointerup', entryRow(name).getBoundingClientRect().top + 35)
}

function entryIds(groupName: string): (string | null)[] {
  return [...screen.getByRole('region', { name: groupName }).querySelectorAll('[data-sidebar-sort-entry]')]
    .map(row => row.getAttribute('data-sidebar-sort-entry'))
}

function setup() {
  const directory = createSnapshotStore<TeamView>({ phase: 'ready', snapshot, catalog: null })
  const chats = createSnapshotStore<ChatView>({ phase: 'ready', snapshot: { revision: 0, chats: [], deliveries: [], activities: [], relayLimit: 6 } })
  const view = createSidebarViewStore().create()
  const overflow = createSnapshotStore(false)
  const reveal = createSnapshotStore<{ sessionId: SessionId; groupId: GroupId; sequence: number } | null>(null)
  const sessions = createSnapshotStore<{ ids: SessionId[]; byId: Record<string, { retainedBy: { mainView?: number } }> }>({ ids: [], byId: {} })
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
    useSidebarReveal: bindSnapshotSelector(reveal),
    observeScrollList: vi.fn(), scrollDown: vi.fn(),
    useSessions: bindSnapshotSelector(sessions),
    useSidebarSessionStatus: bindSnapshotSelector(statuses),
    useSessionStatus: bindSnapshotSelector(statuses),
    usePanelInfo: (select: (value: { activePanelId: null }) => unknown) => select({ activePanelId: null }),
  } as TeamSidebarProps
  return { props, directory, chats, view, overflow, reveal, sessions, statuses, workspaces, commands, entityActions }
}

beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear() })

describe('team sidebar', () => {
  it.each([
    ['directory', 'loading'], ['directory', 'failed'], ['chats', 'loading'], ['chats', 'failed'],
  ] as const)('waits for a fresh %s snapshot while it is %s before enabling entity actions', (owner, phase) => {
    const { props, directory, chats, entityActions } = setup()
    if (owner === 'directory') directory.set({ ...directory.getSnapshot(), phase })
    else chats.set({ ...chats.getSnapshot(), phase })
    render(<TeamSidebar {...props} />)
    fireEvent.contextMenu(screen.getByRole('button', { name: writer.name }))
    expect(screen.getAllByRole<HTMLButtonElement>('menuitem').every(item => item.disabled)).toBe(true)
    fireEvent.click(screen.getByRole('menuitem', { name: zh['entity.rename'] }))
    expect(entityActions.rename).not.toHaveBeenCalled()
    act(() => {
      if (owner === 'directory') directory.set({ ...directory.getSnapshot(), phase: 'ready' })
      else chats.set({ ...chats.getSnapshot(), phase: 'ready' })
    })
    expect(screen.getAllByRole<HTMLButtonElement>('menuitem').every(item => !item.disabled)).toBe(true)
    fireEvent.click(screen.getByRole('menuitem', { name: zh['entity.rename'] }))
    expect(entityActions.rename).toHaveBeenCalledOnce()
  })

  it('places Bot and chat context actions at the pointer and restores keyboard focus on Escape', () => {
    const { props, chats, commands } = setup()
    chats.set({ ...chats.getSnapshot(), snapshot: { ...chats.getSnapshot().snapshot!, chats: [chat] } })
    render(<TeamSidebar {...props} />)
    for (const name of [writer.name, chat.name]) {
      const row = screen.getByRole('button', { name })
      fireEvent.contextMenu(row, { clientX: 460, clientY: 250 })
      expect(screen.getByRole('menu').style).toMatchObject({ left: '460px', top: '254px' })
      expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[0])
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
      expect(screen.queryByRole('menu')).toBeNull()
      expect(document.activeElement).toBe(row)
      fireEvent.keyDown(row, { key: 'F10', shiftKey: true })
      expect(screen.getByRole('menu')).toBeTruthy()
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    }
    expect(commands.openBot).not.toHaveBeenCalled()
    expect(commands.openChat).not.toHaveBeenCalled()
  })

  it('opens a custom section menu at the pointer or by menu key without collapsing the section', () => {
    const { props, view } = setup()
    render(<TeamSidebar {...props} />)
    const section = screen.getByRole('button', { name: 'Content' })
    fireEvent.contextMenu(section, { clientX: 180, clientY: 260 })
    expect(screen.getByRole('menu').style).toMatchObject({ left: '180px', top: '264px' })
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(document.activeElement).toBe(section)
    fireEvent.keyDown(section, { key: 'ContextMenu' })
    expect(screen.getByRole('menuitem', { name: zh['team.removeGroup'] })).toBeTruthy()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(view.getSnapshot().collapsedGroups[custom]).not.toBe(true)
    fireEvent.keyDown(section, { key: 'F10', shiftKey: true, isComposing: true })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.contextMenu(screen.getByRole('button', { name: zh['team.bots'] }))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens headquarters beside the main badge without opening a conversation, including a collapsed sidebar', () => {
    const { props, commands } = setup()
    const openHeadquarters = vi.fn()
    const view = render(<TeamSidebar {...props} openHeadquarters={openHeadquarters} />)
    const entry = screen.getByRole('button', { name: zh['team.headquarters'] })
    const identity = screen.getByRole('button', { name: `${main.name} ${zh['team.main']}` })
    expect(identity.nextElementSibling).toBe(entry)
    expect(entry.closest('button button')).toBeNull()
    fireEvent.click(entry)
    expect(openHeadquarters).toHaveBeenCalledOnce()
    expect(commands.openBot).not.toHaveBeenCalled()
    fireEvent.click(identity)
    expect(commands.openBot).toHaveBeenCalledExactlyOnceWith(main.id)
    view.rerender(<TeamSidebar {...props} openHeadquarters={openHeadquarters} wide={false} />)
    fireEvent.click(screen.getByRole('button', { name: zh['team.headquarters'] }))
    expect(openHeadquarters).toHaveBeenCalledTimes(2)
    expect(commands.openBot).toHaveBeenCalledOnce()
    view.rerender(<TeamSidebar {...props} />)
    expect(screen.queryByRole('button', { name: zh['team.headquarters'] })).toBeNull()
  })

  it('remembers the compact main Bot while keeping its conversation and headquarters accessible', () => {
    const { props, commands } = setup()
    const openHeadquarters = vi.fn()
    const rendered = render(<TeamSidebar {...props} openHeadquarters={openHeadquarters} />)
    const portrait = () => screen.getByRole('button', { name: main.name }).querySelector('img')
    expect(portrait()?.getAttribute('width')).toBe('96')
    fireEvent.click(screen.getByRole('button', { name: zh['team.collapseMain'] }))
    expect(portrait()?.getAttribute('width')).toBe('28')
    expect(screen.queryByText(zh['team.mainRole'])).toBeNull()
    expect(screen.getByRole('button', { name: zh['team.expandMain'] }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('button', { name: 'Writer' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['team.headquarters'] }))
    expect(openHeadquarters).toHaveBeenCalledOnce()
    expect(commands.openBot).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: `${main.name} ${zh['team.main']}` }))
    expect(commands.openBot).toHaveBeenCalledExactlyOnceWith(main.id)
    const reopened = createSidebarViewStore().create()
    expect(reopened.getSnapshot().mainCollapsed).toBe(true)
    const restoredProps = { ...props, useStore: bindSnapshotSelector(reopened), actions: reopened.actions }
    rendered.rerender(<TeamSidebar {...restoredProps} openHeadquarters={openHeadquarters} wide={false} />)
    expect(portrait()?.getAttribute('width')).toBe('30')
    expect(screen.queryByRole('button', { name: zh['team.expandMain'] })).toBeNull()
    rendered.rerender(<TeamSidebar {...restoredProps} openHeadquarters={openHeadquarters} />)
    expect(portrait()?.getAttribute('width')).toBe('28')
    fireEvent.click(screen.getByRole('button', { name: zh['team.expandMain'] }))
    expect(portrait()?.getAttribute('width')).toBe('96')
    expect(screen.getByText(zh['team.mainRole'])).toBeTruthy()
    expect(reopened.getSnapshot().mainCollapsed).toBe(false)
  })

  it('counts each Bot and chat as one section entry, then updates member counts from saved membership', () => {
    const { props, directory, chats } = setup()
    render(<TeamSidebar {...props} />)
    const count = (name: string) => screen.getByRole('button', { name }).querySelector('[aria-hidden="true"]:last-child')?.textContent
    expect(count('Content')).toBe('(0)')
    expect(count(zh['team.chats'])).toBe('(0)')
    expect(count(zh['team.bots'])).toBe('(1)')
    const second = { ...chat, id: 'second' as ChatId, name: 'Second', memberIds: [main.id, writer.id] }
    act(() => {
      directory.set({ ...directory.getSnapshot(), snapshot: { ...snapshot, bots: [main, { ...writer, groupId: custom }] } })
      chats.set({ ...chats.getSnapshot(), snapshot: { ...chats.getSnapshot().snapshot!,
        chats: [{ ...chat, groupId: custom }, second] } })
    })
    expect(count('Content')).toBe('(2)')
    expect(count(zh['team.chats'])).toBe('(1)')
    expect(count(zh['team.bots'])).toBe('(0)')
    expect(screen.getByRole('button', { name: chat.name }).textContent).toContain('(1)')
    expect(screen.getByRole('button', { name: second.name }).textContent).toContain('(2)')
    act(() => { chats.set({ ...chats.getSnapshot(), snapshot: { ...chats.getSnapshot().snapshot!, chats: [{ ...chat, groupId: custom }] } }) })
    expect(count('Content')).toBe('(2)')
    expect(count(zh['team.chats'])).toBe('(0)')
  })

  it('unfolds and centers a newly selected Bot by scrolling only the sidebar list', () => {
    const { props, directory, view, reveal, sessions } = setup()
    directory.set({ ...directory.getSnapshot(), snapshot: { ...snapshot, bots: [main, { ...writer, groupId: custom }] } })
    view.actions.setGroupCollapsed(custom, true)
    render(<TeamSidebar {...props} />)
    const list = screen.getByRole('region', { name: zh['team.list'] }) as HTMLDivElement
    const row = list.querySelector<HTMLButtonElement>(`[data-session-id="${writer.sessionId}"]`)!
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 100 } as DOMRect)
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ top: 130, bottom: 160 } as DOMRect)
    act(() => {
      sessions.set({ ids: [writer.sessionId], byId: { [writer.sessionId]: { retainedBy: { mainView: 1 } } } })
      reveal.set({ sessionId: writer.sessionId, groupId: custom, sequence: 1 })
    })
    expect(view.getSnapshot().collapsedGroups[custom]).toBe(false)
    expect(list.scrollTop).toBe(95)
    act(() => { directory.set({ ...directory.getSnapshot(), snapshot: { ...directory.getSnapshot().snapshot!, revision: 1 } }) })
    expect(list.scrollTop).toBe(95)
    expect(document.body.scrollTop).toBe(0)
  })

  it('centers a newly selected group chat above the current list viewport', () => {
    const { props, chats, view, reveal, sessions } = setup()
    chats.set({ ...chats.getSnapshot(), snapshot: { ...chats.getSnapshot().snapshot!, chats: [chat] } })
    view.actions.setGroupCollapsed(chatGroup, true)
    render(<TeamSidebar {...props} />)
    const list = screen.getByRole('region', { name: zh['team.list'] }) as HTMLDivElement
    const row = list.querySelector<HTMLButtonElement>(`[data-session-id="${chat.rootSessionId}"]`)!
    list.scrollTop = 100
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 100 } as DOMRect)
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ top: -30, bottom: 20 } as DOMRect)
    act(() => {
      sessions.set({ ids: [chat.rootSessionId], byId: { [chat.rootSessionId]: { retainedBy: { mainView: 1 } } } })
      reveal.set({ sessionId: chat.rootSessionId, groupId: chatGroup, sequence: 1 })
    })
    expect(view.getSnapshot().collapsedGroups[chatGroup]).toBe(false)
    expect(list.scrollTop).toBe(45)
  })

  it('centers a new Bot even when its row is already inside the viewport behind More', () => {
    const { props, overflow, reveal, sessions } = setup()
    overflow.set(true)
    render(<TeamSidebar {...props} />)
    const list = screen.getByRole('region', { name: zh['team.list'] }) as HTMLDivElement
    const row = list.querySelector<HTMLButtonElement>(`[data-session-id="${writer.sessionId}"]`)!
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 100 } as DOMRect)
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ top: 60, bottom: 90 } as DOMRect)
    act(() => {
      sessions.set({ ids: [writer.sessionId], byId: { [writer.sessionId]: { retainedBy: { mainView: 1 } } } })
      reveal.set({ sessionId: writer.sessionId, groupId: ordinary, sequence: 1 })
    })
    expect(list.scrollTop).toBe(25)
    expect(document.body.scrollTop).toBe(0)
  })

  it('shows the supplied main portrait and orders custom groups, group chats, then ungrouped members', () => {
    const { props } = setup()
    render(<TeamSidebar {...props} />)
    const avatar = screen.getByRole('button', { name: main.name }).querySelector('img')
    expect(avatar?.getAttribute('width')).toBe('96')
    expect(avatar?.getAttribute('src')).toContain('main-bot-avatar.png')
    expect(screen.getByRole('button', { name: main.name }).querySelector('svg')).toBeNull()
    expect(screen.getByRole('button', { name: writer.name }).querySelector('svg')?.getAttribute('width')).toBe('28')
    expect(screen.queryByRole('button', { name: t('entity.menu', { name: main.name }) })).toBeNull()
    expect(screen.getAllByRole('region').map(region => region.getAttribute('aria-label'))).toEqual([
      zh['team.list'], 'Content', zh['team.chats'], zh['team.bots'],
    ])
    const createGroup = screen.getByRole('button', { name: zh['team.newGroup'] })
    const mainButton = screen.getByRole('button', { name: main.name })
    expect(mainButton.compareDocumentPosition(createGroup) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(createGroup.compareDocumentPosition(screen.getByRole('region', { name: 'Content' })) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    const identity = screen.getByRole('button', { name: `${main.name} ${zh['team.main']}` })
    const badge = within(identity).getByText(zh['team.main'])
    expect(badge.previousElementSibling).toBe(within(identity).getByText(main.name))
    expect(identity.parentElement?.parentElement?.textContent).toContain(zh['team.mainRole'])
  })

  it('keeps the same main portrait at the narrow sidebar size', () => {
    const { props } = setup()
    const view = render(<TeamSidebar {...props} />)
    const source = screen.getByRole('button', { name: main.name }).querySelector('img')?.getAttribute('src')
    view.rerender(<TeamSidebar {...props} wide={false} />)
    const avatar = screen.getByRole('button', { name: main.name }).querySelector('img')
    expect(avatar?.getAttribute('width')).toBe('30')
    expect(avatar?.getAttribute('src')).toBe(source)
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
    expect(icon.previousElementSibling?.textContent).toBe(`(${chat.memberIds.length})`)
    expect(icon.previousElementSibling?.previousElementSibling?.textContent).toBe(chat.name)
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
    expect(row.getAttribute('aria-description')).toBe(`${zh['sidebar.chatStatus.running']} · ${zh['sidebar.reorder']}`)
    fireEvent.mouseEnter(icon)
    expect(screen.getByRole('tooltip', { hidden: true }).textContent).toBe(zh['sidebar.chatStatus.running'])
    fireEvent.click(row)
    expect(commands.openChat).toHaveBeenCalledExactlyOnceWith(chat.id)
  })
})

describe('sidebar entry dragging', () => {
  const editor: TeamBot = { ...writer, id: 'editor' as BotId, name: 'Editor', sessionId: 'editor-session' as SessionId }
  const reviewer: TeamBot = { ...writer, id: 'reviewer' as BotId, name: 'Reviewer', sessionId: 'reviewer-session' as SessionId }

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  it('reorders a Bot and chat together in either direction and restores their positions after reopening', async () => {
    const { props, directory, chats, view, commands, entityActions } = setup()
    const bots = [main, { ...writer, groupId: custom }, { ...editor, groupId: custom }]
    directory.set({ ...directory.getSnapshot(), snapshot: { ...snapshot, bots } })
    chats.set({ ...chats.getSnapshot(), snapshot: { ...chats.getSnapshot().snapshot!, chats: [{ ...chat, groupId: custom }] } })
    const mounted = render(<TeamSidebar {...props} />)
    const list = measureSidebar()
    const writerRow = entryRow(writer.name)
    const chatRow = entryRow(chat.name)
    expect(entryIds('Content')).toEqual([writer.sessionId, editor.sessionId, chat.rootSessionId])
    pressEntry(writer.name)
    expect(writerRow.hasAttribute('data-sort-active')).toBe(false)
    moveEntryTo(chat.name)
    expect(writerRow.getAttribute('data-sort-active')).toBe('true')
    expect(list.getAttribute('data-sidebar-sorting')).toBe('true')
    expect(writerRow.style.getPropertyValue('--sidebar-sort-y')).not.toBe('')
    expect(chatRow.style.getPropertyValue('--sidebar-sort-y')).toBe('-48px')
    expect(entryIds('Content')).toEqual([writer.sessionId, editor.sessionId, chat.rootSessionId])
    expect(view.getSnapshot().entryOrder?.[custom]).toBeUndefined()
    releaseEntryAt(chat.name)
    expect(entryIds('Content')).toEqual([editor.sessionId, chat.rootSessionId, writer.sessionId])
    expect(writerRow.hasAttribute('data-sort-active')).toBe(false)
    expect(list.hasAttribute('data-sidebar-sorting')).toBe(false)
    pressEntry(chat.name)
    pointer(window, 'pointermove', entryRow(editor.name).getBoundingClientRect().top + 5)
    pointer(window, 'pointerup', entryRow(editor.name).getBoundingClientRect().top + 5)
    expect(entryIds('Content')).toEqual([chat.rootSessionId, editor.sessionId, writer.sessionId])
    expect(commands.openBot).not.toHaveBeenCalled()
    expect(commands.openChat).not.toHaveBeenCalled()
    expect(entityActions.move).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
    await waitFor(() => { expect(localStorage.getItem('katcats.sidebar.view.v1')).toContain(chat.rootSessionId) })
    mounted.unmount()
    const reopened = createSidebarViewStore().create()
    render(<TeamSidebar {...props} useStore={bindSnapshotSelector(reopened)} actions={reopened.actions} />)
    expect(entryIds('Content')).toEqual([chat.rootSessionId, editor.sessionId, writer.sessionId])
    expect(directory.getSnapshot().snapshot?.bots).toEqual(bots)
  })

  it('keeps pinned entries first, permits sorting within pins, and rejects drops across the pin boundary', () => {
    const { props, directory, view, workspaces } = setup()
    directory.set({ ...directory.getSnapshot(), snapshot: { ...snapshot, bots: [main, writer, editor, reviewer] } })
    workspaces.set({ ...workspaces.getSnapshot(), pinnedSessionIds: [writer.sessionId, editor.sessionId] })
    render(<TeamSidebar {...props} />)
    measureSidebar()
    pressEntry(writer.name)
    moveEntryTo(editor.name)
    releaseEntryAt(editor.name)
    expect(entryIds(zh['team.bots'])).toEqual([editor.sessionId, writer.sessionId, reviewer.sessionId])
    const saved = view.getSnapshot().entryOrder
    const reviewerRow = entryRow(reviewer.name)
    pressEntry(editor.name)
    moveEntryTo(reviewer.name)
    expect(reviewerRow.hasAttribute('data-sort-shifting')).toBe(false)
    releaseEntryAt(reviewer.name)
    expect(view.getSnapshot().entryOrder).toEqual(saved)
    expect(workspaces.getSnapshot().pinnedSessionIds).toEqual([writer.sessionId, editor.sessionId])
  })

  it.each(['escape', 'pointercancel', 'blur'] as const)('cancels row movements on %s without saving', (cancel) => {
    const { props, directory, view } = setup()
    directory.set({ ...directory.getSnapshot(), snapshot: { ...snapshot, bots: [main, writer, editor] } })
    render(<TeamSidebar {...props} />)
    const list = measureSidebar()
    pressEntry(writer.name)
    moveEntryTo(editor.name)
    expect(list.getAttribute('data-sidebar-sorting')).toBe('true')
    if (cancel === 'escape') fireEvent.keyDown(window, { key: 'Escape' })
    else if (cancel === 'blur') fireEvent.blur(window)
    else pointer(window, 'pointercancel', 0)
    expect(list.hasAttribute('data-sidebar-sorting')).toBe(false)
    expect(entryRow(writer.name).style.getPropertyValue('--sidebar-sort-y')).toBe('')
    expect(entryRow(editor.name).style.getPropertyValue('--sidebar-sort-y')).toBe('')
    releaseEntryAt(editor.name)
    expect(view.getSnapshot().entryOrder).toBeUndefined()
    expect(entryIds(zh['team.bots'])).toEqual([writer.sessionId, editor.sessionId])
  })

  it('rejects pointer releases without a gesture or outside the original group', () => {
    const { props, directory, chats, view, commands } = setup()
    directory.set({ ...directory.getSnapshot(), snapshot: { ...snapshot, bots: [main, writer, editor] } })
    chats.set({ ...chats.getSnapshot(), snapshot: { ...chats.getSnapshot().snapshot!, chats: [chat] } })
    render(<TeamSidebar {...props} />)
    measureSidebar()
    moveEntryTo(editor.name)
    releaseEntryAt(editor.name)
    expect(view.getSnapshot().entryOrder).toBeUndefined()
    const chatRow = entryRow(chat.name)
    pressEntry(writer.name)
    moveEntryTo(chat.name)
    expect(chatRow.hasAttribute('data-sort-shifting')).toBe(false)
    releaseEntryAt(chat.name)
    expect(view.getSnapshot().entryOrder).toBeUndefined()
    expect(commands.moveBot).not.toHaveBeenCalled()
    expect(commands.openBot).not.toHaveBeenCalled()
    expect(commands.openChat).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps normal clicks below the movement threshold and suppresses the click generated after a completed drag', () => {
    const { props, directory, view, commands } = setup()
    directory.set({ ...directory.getSnapshot(), snapshot: { ...snapshot, bots: [main, writer, editor] } })
    render(<TeamSidebar {...props} />)
    const list = measureSidebar()
    const writerButton = screen.getByRole<HTMLButtonElement>('button', { name: writer.name })
    expect(writerButton.draggable).toBe(false)
    pressEntry(writer.name)
    const top = entryRow(writer.name).getBoundingClientRect().top
    pointer(window, 'pointermove', top + 23)
    pointer(window, 'pointerup', top + 23)
    expect(list.hasAttribute('data-sidebar-sorting')).toBe(false)
    fireEvent.click(writerButton, { detail: 1 })
    expect(commands.openBot).toHaveBeenCalledExactlyOnceWith(writer.id)
    expect(view.getSnapshot().entryOrder).toBeUndefined()
    commands.openBot.mockClear()
    pressEntry(writer.name)
    moveEntryTo(editor.name)
    releaseEntryAt(editor.name)
    fireEvent.click(writerButton, { detail: 1 })
    expect(commands.openBot).not.toHaveBeenCalled()
    pressEntry(writer.name)
    pointer(window, 'pointerup', entryRow(writer.name).getBoundingClientRect().top + 20)
    fireEvent.click(writerButton, { detail: 1 })
    expect(commands.openBot).toHaveBeenCalledExactlyOnceWith(writer.id)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it.each([
    ['directory', 'loading'], ['directory', 'failed'], ['chats', 'loading'], ['chats', 'failed'],
    ['workspaces', 'pending'], ['workspaces', 'error'],
  ] as const)('disables dragging while %s is %s and leaves the main Bot fixed', (owner, phase) => {
    const { props, directory, chats, workspaces, view } = setup()
    directory.set({ ...directory.getSnapshot(), snapshot: { ...snapshot, bots: [main, writer, editor] } })
    if (owner === 'directory') directory.set({ ...directory.getSnapshot(), phase: phase === 'loading' ? 'loading' : 'failed' })
    else if (owner === 'chats') chats.set({ ...chats.getSnapshot(), phase: phase === 'loading' ? 'loading' : 'failed' })
    else workspaces.set({ ...workspaces.getSnapshot(), phase: phase === 'pending' ? 'pending' : 'ready',
      state: phase === 'pending' ? 'loading' : 'error' })
    render(<TeamSidebar {...props} />)
    const list = measureSidebar()
    const writerButton = screen.getByRole<HTMLButtonElement>('button', { name: writer.name })
    expect(writerButton.draggable).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: main.name }).draggable).toBe(false)
    pressEntry(writer.name)
    moveEntryTo(editor.name)
    releaseEntryAt(editor.name)
    expect(list.hasAttribute('data-sidebar-sorting')).toBe(false)
    expect(view.getSnapshot().entryOrder).toBeUndefined()
  })

  it.each(['moved', 'deleted'] as const)('does not save stale positions when the dragged member is %s during the drag', (change) => {
    const { props, directory, view } = setup()
    directory.set({ ...directory.getSnapshot(), snapshot: { ...snapshot, bots: [main, writer, editor] } })
    render(<TeamSidebar {...props} />)
    const list = measureSidebar()
    const editorRow = entryRow(editor.name)
    pressEntry(writer.name)
    moveEntryTo(editor.name)
    act(() => {
      directory.set({ ...directory.getSnapshot(), snapshot: { ...snapshot,
        bots: change === 'deleted' ? [main, editor] : [main, { ...writer, groupId: custom }, editor] } })
    })
    expect(editorRow.style.getPropertyValue('--sidebar-sort-y')).toBe('')
    expect(list.hasAttribute('data-sidebar-sorting')).toBe(false)
    releaseEntryAt(editor.name)
    expect(view.getSnapshot().entryOrder).toBeUndefined()
    expect(entryIds(zh['team.bots'])).toEqual([editor.sessionId])
  })
})

it('exposes the scroll edge while dragging and restores the overflow button after cancellation', () => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const { props, directory, overflow } = setup()
  const editor = { ...writer, id: 'editor' as BotId, name: 'Editor', sessionId: 'editor-session' as SessionId }
  directory.set({ ...directory.getSnapshot(), snapshot: { ...snapshot, bots: [main, writer, editor] } })
  overflow.set(true)
  render(<TeamSidebar {...props} />)
  measureSidebar()
  expect(screen.getByRole('button', { name: zh['team.moreBelow'] })).toBeDefined()
  pressEntry(writer.name)
  moveEntryTo(editor.name)
  expect(screen.queryByRole('button', { name: zh['team.moreBelow'] })).toBeNull()
  pointer(window, 'pointercancel', 0)
  expect(screen.getByRole('button', { name: zh['team.moreBelow'] })).toBeDefined()
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
