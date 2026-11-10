// @vitest-environment jsdom
/** Opening, renaming and closing a group room never mutate its tasks. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Session } from '@deepseek-ai/dsh-session'
import type { ChatDeliveryId, ChatId, ChatRunId, GroupTicket, GroupTicketId, TeamChat } from '../src/chats-types.ts'
import type { ChatTaskEventId } from '../src/chats-task-events.ts'
import type { BotId, GroupId, TeamBot } from '../src/types.ts'
import type { ChatView } from '../src/client/chat-model.ts'
import type { TeamView } from '../src/client/model.ts'
import { GroupRoomAction, type GroupRoomProps } from '../src/client/GroupRoom.tsx'
import { roomZh } from '../src/client/room-locales.ts'
import type { RoomActivitySnapshot } from '../src/client/room-activity.ts'

vi.mock('../src/client/RoomScene.tsx', () => ({ default: (props: { cameraTarget: string | null; cameraMode: number; visitors: readonly TeamBot[] }) =>
  <div data-testid="room-scene" data-camera={props.cameraTarget ?? 'overview'} data-mode={props.cameraMode}
    data-visitors={props.visitors.map(bot => bot.id).join(',')} /> }))
beforeEach(() => { vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: false })) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const chat: TeamChat = { id: 'finance' as ChatId, name: '财务部', groupId: 'groups' as GroupId,
  rootSessionId: 'root' as SessionId, workDir: '/synthetic', memberIds: [], managerId: null, memberRoles: [], executors: [],
  relayLimit: 16, generation: 0, status: 'active', pauseReason: null, run: null, error: null }

function setup(sessionId = chat.rootSessionId) {
  const chats = createSnapshotStore<ChatView>({ phase: 'ready', snapshot: { revision: 1, chats: [chat], deliveries: [], activities: [], relayLimit: 16 } })
  const window = createSnapshotStore<SessionEventWindow>({ entries: [], revision: 0, hasMore: true, change: { kind: 'replace', entries: [] } })
  const loadRoomHistory = vi.fn(async () => {})
  const directory = createSnapshotStore<TeamView>({ phase: 'ready', snapshot: null, catalog: null })
  const activity = createSnapshotStore<RoomActivitySnapshot>({ connected: true, members: [] })
  const watchRoomActivity = vi.fn<GroupRoomProps['watchRoomActivity']>(() => activity)
  const copyText = vi.fn(async (_text: string) => {})
  const props = { sessionId, t: makeTranslate(roomZh), useChats: bindSnapshotSelector(chats),
    useDirectory: bindSnapshotSelector(directory),
    useRoomEvents: bindSnapshotSelector(window), useRoomConnection: bindSnapshotSelector(createSnapshotStore('connected')),
    useRoomStatuses: bindSnapshotSelector(createSnapshotStore(new Map())), useGroupQuestions: bindSnapshotSelector(createSnapshotStore([])),
    loadRoomHistory, watchRoomActivity, copyText } as GroupRoomProps
  render(<GroupRoomAction {...props} />)
  return { chats, window, directory, activity, loadRoomHistory, watchRoomActivity, copyText }
}

describe('group room action', () => {
  it('keeps historical handoff names copyable without claiming an unavailable member can be inspected', async () => {
    const h = setup()
    const root = Session.create(chat.rootSessionId)
    root.append('katcats/group-task-lifecycle', { schemaVersion: 1, eventId: 'event' as ChatTaskEventId,
      chatId: chat.id, rootSessionId: chat.rootSessionId, runId: 'run' as ChatRunId, generation: 1,
      deliveryId: 'delivery' as ChatDeliveryId, parentDeliveryId: null, actor: { kind: 'owner' },
      target: { kind: 'member', botId: 'former' as BotId, sender: { botId: 'former' as BotId, name: '历史财务成员',
        role: '核验资料', avatar: { shape: 'classic', color: '#2288FF' } } },
      message: '核对明细', status: 'completed', recovered: false, error: null })
    const entries = root.snapshotEvents().map(event => ({ type: 'event' as const, event }))
    act(() => { h.window.set({ ...h.window.getSnapshot(), entries }) })
    fireEvent.click(screen.getByRole('button', { name: '调度室' }))
    await screen.findByTestId('room-scene')
    const records = within(screen.getByRole('log', { name: '交接记录' }))
    const name = records.getByText('历史财务成员')
    fireEvent.contextMenu(name)
    expect(screen.getByRole('menuitem', { name: '查看成员详情' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('menuitem', { name: '复制名称' }))
    expect(h.copyText).toHaveBeenCalledExactlyOnceWith('历史财务成员')
    expect(screen.queryByRole('dialog', { name: '人员管理' })).toBeNull()
    fireEvent.keyDown(name, { key: 'ContextMenu' })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByTestId('room-scene')).toBeTruthy()
  })
  it('shows saved task updates inside the room and closes only the archive on Escape', async () => {
    const h = setup()
    fireEvent.click(screen.getByRole('button', { name: '调度室' }))
    await screen.findByTestId('room-scene')
    fireEvent.click(screen.getByRole('button', { name: '任务档案' }))
    expect(screen.getByText('还没有任务档案')).toBeTruthy()
    const ticket: GroupTicket = { version: 1, id: 'task-a' as GroupTicketId, ownerId: 'owner' as BotId,
      goal: '核对资料', acceptance: ['检查原文'], stage: '核验中', nextStep: '读取凭证',
      state: 'open', blocker: null, artifacts: [], messageIds: [], revision: 1 }
    act(() => { h.chats.set({ phase: 'ready', snapshot: { ...h.chats.getSnapshot().snapshot!,
      chats: [{ ...chat, tickets: [ticket] }] } }) })
    expect(within(screen.getByRole('dialog', { name: '任务档案' })).getByText('读取凭证')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '任务档案' })).toBeNull()
    expect(screen.getByTestId('room-scene')).toBeTruthy()
    expect(h.watchRoomActivity.mock.calls[0]?.[1].aborted).toBe(false)
  })
  it('cycles native camera modes and closes with Escape without stopping group work', async () => {
    const h = setup()
    fireEvent.click(screen.getByRole('button', { name: '调度室' }))
    const scene = await screen.findByTestId('room-scene')
    expect(screen.getByRole('region', { name: '任务进度' }).textContent).toMatchSnapshot()
    fireEvent.click(screen.getByRole('button', { name: '视角 全景' }))
    expect(scene.getAttribute('data-mode')).toBe('1')
    fireEvent.click(screen.getByRole('button', { name: '视角 巡游' }))
    expect(scene.getAttribute('data-mode')).toBe('2')
    fireEvent.click(screen.getByRole('button', { name: '视角 俯视' }))
    expect(scene.getAttribute('data-mode')).toBe('0')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('room-scene')).toBeNull()
    expect(h.chats.getSnapshot().snapshot?.chats[0]?.status).toBe('active')
    expect(h.watchRoomActivity.mock.calls[0]?.[1].aborted).toBe(true)
  })
  it('is absent in a private conversation and does not mount a hidden scene', () => {
    setup('private' as SessionId)
    expect(screen.queryByRole('button', { name: '调度室' })).toBeNull()
    expect(screen.queryByTestId('room-scene')).toBeNull()
  })
  it('uses the current group name, removes the department strip and releases the scene on close', async () => {
    const h = setup()
    expect(screen.queryByTestId('room-scene')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '调度室' }))
    expect(await screen.findByTestId('room-scene')).toBeTruthy()
    expect(h.watchRoomActivity).toHaveBeenCalledOnce()
    expect(screen.getByRole('heading', { name: '财务部调度室' })).toBeTruthy()
    const records = screen.getByRole('log', { name: '交接记录' })
    const activity = screen.getByRole('log', { name: '实时执行日志' })
    activity.scrollTop = 45
    Object.defineProperty(records, 'scrollHeight', { value: 2000 })
    fireEvent.click(screen.getByRole('button', { name: '到底部' }))
    expect(records.scrollTop).toBe(2000)
    fireEvent.click(screen.getByRole('button', { name: '到顶部' }))
    expect(records.scrollTop).toBe(0)
    expect(activity.scrollTop).toBe(45)
    expect(screen.getByRole('complementary').scrollTop).toBe(0)
    expect(screen.getByRole('complementary').textContent).toMatchSnapshot()
    expect(screen.queryByText('协作概览')).toBeNull()
    const heading = screen.getByRole('heading', { name: '财务部调度室' }).parentElement!
    expect(within(heading).getByLabelText('本轮时长')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '本群用量' })).queryByText('本轮时长')).toBeNull()
    expect(screen.queryByText('部门进度')).toBeNull()
    act(() => { h.chats.set({ phase: 'ready', snapshot: { ...h.chats.getSnapshot().snapshot!, chats: [{ ...chat, name: '研发部' }] } }) })
    expect(screen.getByRole('heading', { name: '研发部调度室' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '返回群聊' }))
    expect(screen.queryByTestId('room-scene')).toBeNull()
    expect(h.watchRoomActivity.mock.calls[0]?.[1].aborted).toBe(true)
    expect(h.loadRoomHistory).not.toHaveBeenCalled()
  })
  it('loads older records only on request and reports a failed load without dispatching anything', async () => {
    const h = setup()
    h.loadRoomHistory.mockRejectedValueOnce(new Error('offline'))
    fireEvent.click(screen.getByRole('button', { name: '调度室' }))
    fireEvent.click(screen.getByRole('button', { name: '加载更早记录' }))
    expect((await screen.findByRole('alert')).textContent).toContain('历史加载失败')
    expect(h.loadRoomHistory).toHaveBeenCalledTimes(1)
  })
  it('keeps visitors out of group personnel and supports searchable people and camera selection', async () => {
    const h = setup()
    const member: TeamBot = { id: 'member' as BotId, name: '负责人', role: '核验交付', kind: 'ordinary',
      avatar: { shape: 'classic', color: '#2288FF' },
      model: { kind: 'override', provider: 'synthetic-provider', model: 'synthetic-model', reasoningEffort: 'high' }, workDir: '/private-folder',
      groupId: null, sessionId: 'private-member' as SessionId }
    const visitor: TeamBot = { ...member, id: 'visitor' as BotId, name: '访客甲', sessionId: 'private-visitor' as SessionId }
    act(() => {
      h.directory.set({ phase: 'ready', catalog: null, snapshot: { revision: 1, mainBotId: member.id, groups: [],
        bots: [member, visitor], modelCapabilities: { override: true, followGlobal: true } } })
      h.chats.set({ ...h.chats.getSnapshot(), snapshot: { ...h.chats.getSnapshot().snapshot!,
        chats: [{ ...chat, memberIds: [member.id], managerId: member.id,
          executors: [{ botId: member.id, sessionId: 'group-worker' as SessionId }] }] } })
      h.activity.set({ connected: true, members: [{ botId: member.id, sessionId: 'group-worker' as SessionId,
        state: 'ready', rows: [], permission: 'workspace-write' }] })
    })
    fireEvent.click(screen.getByRole('button', { name: '调度室' }))
    const scene = await screen.findByTestId('room-scene')
    expect(scene.getAttribute('data-visitors')).toBe('visitor')
    fireEvent.click(screen.getByRole('button', { name: '个人' }))
    expect(scene.getAttribute('data-camera')).toBe('member')
    fireEvent.change(screen.getByRole('combobox', { name: '选择 Bot' }), { target: { value: 'visitor' } })
    expect(scene.getAttribute('data-camera')).toBe('visitor')
    fireEvent.click(screen.getByRole('button', { name: '全景' }))
    expect(scene.getAttribute('data-camera')).toBe('overview')
    fireEvent.click(screen.getByRole('button', { name: '人员管理' }))
    let people = within(screen.getByRole('dialog', { name: '人员管理' }))
    expect(screen.getByRole('dialog', { name: '人员管理' }).textContent).toMatchSnapshot()
    expect(people.getByText('核验交付')).toBeTruthy()
    expect(people.queryByText('访客甲')).toBeNull()
    expect(people.getByText('工作区读写')).toBeTruthy()
    expect(people.getByText('synthetic-model')).toBeTruthy()
    const card = people.getByRole('article')
    fireEvent.contextMenu(card, { clientX: 120, clientY: 160 })
    expect(screen.getByRole('menu').textContent).toMatchSnapshot()
    fireEvent.click(screen.getByRole('menuitem', { name: '复制名称' }))
    expect(h.copyText).toHaveBeenCalledExactlyOnceWith(member.name)
    expect(people.getByRole('button', { name: '详情' })).toBeTruthy()
    fireEvent.keyDown(card, { key: 'ContextMenu' })
    fireEvent.click(screen.getByRole('menuitem', { name: '查看成员详情' }))
    expect(people.getByRole('heading', { name: '职责说明' })).toBeTruthy()
    expect(people.getAllByText('核验交付')).toHaveLength(2)
    expect(people.getByText('synthetic-provider')).toBeTruthy()
    expect(people.getByText(chat.workDir)).toBeTruthy()
    expect(people.queryByText('/private-folder')).toBeNull()
    act(() => { h.activity.set({ ...h.activity.getSnapshot(), connected: false }) })
    expect(people.queryByText('工作区读写')).toBeNull()
    expect(people.getAllByText('暂未读取')).toHaveLength(2)
    fireEvent.click(people.getByRole('button', { name: '在场景中查看' }))
    expect(scene.getAttribute('data-camera')).toBe('member')
    fireEvent.click(screen.getByRole('button', { name: '人员管理' }))
    people = within(screen.getByRole('dialog', { name: '人员管理' }))
    fireEvent.click(people.getByRole('button', { name: '群成员 0' }))
    expect(people.getByText('未找到匹配的成员')).toBeTruthy()
    fireEvent.click(people.getByRole('button', { name: '全部 1' }))
    fireEvent.change(people.getByRole('textbox'), { target: { value: '不存在' } })
    expect(people.queryByText('核验交付')).toBeNull()
    fireEvent.click(people.getByRole('button', { name: '关闭人员管理' }))
    expect(screen.getByRole('heading', { name: '财务部调度室' })).toBeTruthy()
  })
})
