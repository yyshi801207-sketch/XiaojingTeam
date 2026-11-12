// @vitest-environment jsdom
/** Saved task browsing and owner commands use the scoped, confirmed directory snapshot. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { ChatActivity, ChatDeliveryId, ChatId, ChatRunId, GroupTicket, GroupTicketId, TeamChat } from '../src/chats-types.ts'
import type { BotId, GroupId, TeamBot } from '../src/types.ts'
import { TaskArchiveAction, type TaskArchiveActions } from '../src/client/TaskArchive.tsx'
import { taskArchiveZh } from '../src/client/task-archive-locales.ts'

beforeEach(() => { vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: false })) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const t = makeTranslate(taskArchiveZh)
const copyText = vi.fn(async (_text: string) => {})
const bot: TeamBot = { id: 'owner' as BotId, kind: 'ordinary', name: '财务主管', role: '',
  avatar: { shape: 'classic', color: '#2288FF' }, model: { kind: 'follow-global' }, groupId: null,
  sessionId: 'owner-private' as SessionId, workDir: '/synthetic' }
const ticket: GroupTicket = { version: 1, id: 'task-a' as GroupTicketId, ownerId: bot.id,
  goal: '核验三月财务数据', acceptance: ['总额与明细一致', '记录原始证据'], stage: '资料核验', nextStep: '核对银行流水',
  state: 'open', blocker: null, artifacts: ['核对说明.md'], messageIds: [], revision: 1 }
const chat: TeamChat = { id: 'finance' as ChatId, name: '财务组', groupId: 'groups' as GroupId,
  rootSessionId: 'root' as SessionId, workDir: '/synthetic', memberIds: [bot.id], managerId: bot.id, memberRoles: [], executors: [],
  relayLimit: 16, generation: 0, status: 'active', pauseReason: null, run: null, error: null, tickets: [ticket] }

it('updates the open archive from saved revisions and retains the selected task', () => {
  const view = render(<TaskArchiveAction chat={chat} bots={[bot]} connected copyText={copyText} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: '任务详情' }))
  const dialog = screen.getByRole('dialog', { name: '任务档案' })
  expect(dialog.textContent).toMatchSnapshot()
  expect(within(dialog).getByRole('article').textContent).toContain('核对银行流水')
  expect(within(within(dialog).getByRole('article')).queryByText('已完成')).toBeNull()
  view.rerender(<TaskArchiveAction chat={{ ...chat, tickets: [{ ...ticket, revision: 2,
    state: 'blocked', blocker: '缺少三月流水', nextStep: '请用户提供完整流水' }] }} bots={[bot]} connected={false} copyText={copyText} t={t} />)
  const detail = within(dialog).getByRole('article')
  expect(detail.textContent).toContain('缺少三月流水')
  expect(detail.textContent).toContain('修订 2')
  expect(detail.textContent).not.toContain('核对银行流水')
  expect(within(dialog).getByText('连接中断 · 显示最后同步记录')).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭任务档案' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('filters by blocker, goal and owner, and resets selection across groups', () => {
  const blocked: GroupTicket = { ...ticket, id: 'task-b' as GroupTicketId, goal: '生成对账报告',
    state: 'blocked', blocker: '等待源文件', ownerId: 'former' as BotId }
  const view = render(<TaskArchiveAction chat={{ ...chat, tickets: [ticket, blocked] }} bots={[bot]} connected room copyText={copyText} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: '任务详情' }))
  fireEvent.click(screen.getByRole('button', { name: '受阻任务' }))
  expect(screen.getByRole('article').textContent).toContain('等待源文件')
  expect(screen.queryByText(ticket.goal)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '全部' }))
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: bot.name } })
  expect(screen.getByRole('article').textContent).toContain(ticket.goal)
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'task-b' } })
  expect(screen.getByRole('article').textContent).toContain('历史成员 · former')
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '没有匹配值' } })
  expect(screen.queryByRole('article')).toBeNull()
  view.rerender(<TaskArchiveAction chat={{ ...chat, id: 'other' as ChatId, name: '另一个群', tickets: [] }} bots={[bot]} connected copyText={copyText} t={t} />)
  expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('')
  expect(screen.getByText('还没有任务档案')).toBeTruthy()
  expect(screen.queryByText(ticket.goal)).toBeNull()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('opens task-local actions without changing selection, and copies the selected record only', () => {
  const other: GroupTicket = { ...ticket, id: 'task-b' as GroupTicketId, goal: '确认四月凭证', nextStep: '读取四月证据' }
  const copy = vi.fn(async (_text: string) => {})
  render(<TaskArchiveAction chat={{ ...chat, tickets: [ticket, other] }} bots={[bot]} connected copyText={copy} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: '任务详情' }))
  const row = screen.getByRole('button', { name: new RegExp(ticket.goal) })
  expect(screen.getByRole('article').textContent).toContain(other.goal)
  fireEvent.contextMenu(row, { clientX: 120, clientY: 140 })
  expect(screen.getByRole('menu').textContent).toMatchSnapshot()
  expect(screen.getByRole('article').textContent).toContain(other.goal)
  fireEvent.click(screen.getByRole('menuitem', { name: '复制任务目标' }))
  expect(copy).toHaveBeenCalledExactlyOnceWith(ticket.goal)
  expect(screen.queryByRole('menu')).toBeNull()
  fireEvent.keyDown(row, { key: 'F10', shiftKey: true })
  fireEvent.click(screen.getByRole('menuitem', { name: '查看任务详情' }))
  expect(screen.getByRole('article').textContent).toContain(ticket.goal)
  fireEvent.contextMenu(row)
  fireEvent.click(screen.getByRole('menuitem', { name: '复制任务 ID' }))
  expect(copy).toHaveBeenLastCalledWith(ticket.id)
  expect(screen.getByRole('dialog', { name: '任务档案' })).toBeTruthy()
})

it('selects the current task over a newer archive and sends its exact revision to resume', async () => {
  const newer: GroupTicket = { ...ticket, id: 'task-b' as GroupTicketId, goal: '核验四月财务数据' }
  const paused: TeamChat = { ...chat, tickets: [ticket, newer], generation: 4, status: 'paused',
    run: { id: 'run-a' as ChatRunId, generation: 4, relayCount: 0 } }
  const activity: ChatActivity = { chatId: chat.id, processing: false, runningBotIds: [], pendingControl: null,
    currentTaskId: ticket.id, taskContinuation: { [ticket.id]: 'resume', [newer.id]: 'busy' } }
  const pending = Promise.withResolvers<TeamChat>()
  const actions = { continueTask: vi.fn<TaskArchiveActions['continueTask']>(() => pending.promise),
    completeTask: vi.fn<TaskArchiveActions['completeTask']>() }
  render(<TaskArchiveAction chat={paused} activity={activity} actions={actions} bots={[bot]} connected copyText={copyText} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: '任务详情' }))
  expect(screen.getByRole('article', { name: ticket.goal })).toBeTruthy()
  expect(screen.getByRole('region', { name: '当前任务' }).textContent).toContain(ticket.goal)
  fireEvent.click(screen.getByRole('button', { name: new RegExp(newer.goal) }))
  expect(screen.getByText('本群正在处理其他工作，空闲后可继续。')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '继续所选任务' })).toBeNull()
  fireEvent.click(within(screen.getByRole('region', { name: '当前任务' })).getByRole('button'))
  const resume = screen.getByRole<HTMLButtonElement>('button', { name: '继续当前任务' })
  fireEvent.click(resume)
  expect(resume.disabled).toBe(true)
  fireEvent.click(resume)
  expect(actions.continueTask).toHaveBeenCalledExactlyOnceWith({
    chatId: chat.id, taskId: ticket.id, expectedRevision: ticket.revision,
    expectedRunId: paused.run?.id, expectedGeneration: paused.generation, requestId: expect.any(String),
  })
  await act(async () => { pending.resolve(paused) })
  expect(screen.getByRole('status').textContent).toBe('已提交继续请求')
})

it('keeps ledger mismatches and unknown outcomes visible without offering a restart', () => {
  const unknown: GroupTicket = { ...ticket, id: 'task-b' as GroupTicketId, goal: '查明上次写入结果' }
  const props = { chat: { ...chat, tickets: [{ ...ticket, financeLabel: '原账套' }, unknown] }, bots: [bot],
    activity: { chatId: chat.id, processing: false, runningBotIds: [], pendingControl: null, currentTaskId: ticket.id,
      taskContinuation: { [ticket.id]: 'scope', [unknown.id]: 'unknown' } } satisfies ChatActivity,
    actions: { continueTask: vi.fn(), completeTask: vi.fn() }, copyText, t }
  const view = render(<TaskArchiveAction {...props} connected />)
  fireEvent.click(screen.getByRole('button', { name: '任务详情' }))
  expect(screen.getByText('原账套')).toBeTruthy()
  expect(screen.getByText('当前账套与任务登记时的范围不一致，或旧记录缺少账套信息。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: new RegExp(unknown.goal) }))
  expect(screen.getByText('上次执行的结果尚未确认。请先核对已有结果。')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '继续所选任务' })).toBeNull()
  view.rerender(<TaskArchiveAction {...props} connected={false} />)
  expect(screen.getByRole('region', { name: '上次同步的当前任务' })).toBeTruthy()
  expect(props.actions.continueTask).not.toHaveBeenCalled()
})

it('starts only the selected archived task when an idle group has no current task', async () => {
  const newer: GroupTicket = { ...ticket, id: 'task-b' as GroupTicketId, goal: '核验四月财务数据' }
  const idle = { ...chat, tickets: [ticket, newer] }
  const activity: ChatActivity = { chatId: chat.id, processing: false, runningBotIds: [], pendingControl: null,
    taskContinuation: { [ticket.id]: 'start', [newer.id]: 'start' } }
  const actions = { continueTask: vi.fn(async () => idle), completeTask: vi.fn() }
  render(<TaskArchiveAction chat={idle} activity={activity} actions={actions} bots={[bot]} connected copyText={copyText} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: '任务详情' }))
  expect(screen.getByText('当前没有指定任务')).toBeTruthy()
  expect(actions.continueTask).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: new RegExp(ticket.goal) }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '继续所选任务' })) })
  expect(actions.continueTask).toHaveBeenCalledExactlyOnceWith({
    chatId: chat.id, taskId: ticket.id, expectedRevision: ticket.revision,
    expectedRunId: null, expectedGeneration: chat.generation, requestId: expect.any(String),
  })
})

it('records explicit acceptance for a delivered revision and displays confirmed completion', async () => {
  const delivered: GroupTicket = { ...ticket, revision: 3, state: 'delivered', delivery: { deliveryId: 'delivery-a' as ChatDeliveryId,
    outputMessageId: 'draft-a' as MessageId, relayMessageId: 'reply-a' as MessageId } }
  const props = { actions: { continueTask: vi.fn(), completeTask: vi.fn(async () => chat) }, bots: [bot], copyText, t }
  const view = render(<TaskArchiveAction {...props} chat={{ ...chat, tickets: [delivered] }} connected={false} />)
  fireEvent.click(screen.getByRole('button', { name: '任务详情' }))
  const accept = screen.getByRole<HTMLButtonElement>('button', { name: '确认验收' })
  expect(accept.disabled).toBe(true)
  view.rerender(<TaskArchiveAction {...props} chat={{ ...chat, tickets: [delivered] }} connected />)
  await act(async () => { fireEvent.click(accept) })
  expect(props.actions.completeTask).toHaveBeenCalledExactlyOnceWith(chat.id, ticket.id, delivered.revision)
  expect(within(screen.getByRole('article')).getByText('待验收')).toBeTruthy()
  view.rerender(<TaskArchiveAction {...props} chat={{ ...chat, tickets: [
    { ...delivered, revision: 4, state: 'completed', completedAt: 1775145600000 },
  ] }} connected />)
  const detail = within(screen.getByRole('article'))
  expect(detail.getByText('已完成')).toBeTruthy()
  expect(detail.getByText('验收时间')).toBeTruthy()
  expect(detail.queryByRole('button', { name: '确认验收' })).toBeNull()
})

it.each([
  { completionKind: 'criteria' as const, state: '按条件完成', timestamp: '完成时间' },
  { completionKind: 'owner' as const, state: '人工验收完成', timestamp: '验收时间' },
  { completionKind: undefined, state: '已完成', timestamp: '验收时间' },
])('distinguishes $completionKind completion from human acceptance while preserving historical labels', ({ completionKind, state, timestamp }) => {
  const completed: GroupTicket = { ...ticket, state: 'completed', completedAt: 1775145600000,
    ...(completionKind === undefined ? {} : { completionKind }) }
  const actions = { continueTask: vi.fn(), completeTask: vi.fn() }
  render(<TaskArchiveAction chat={{ ...chat, tickets: [completed] }} bots={[bot]} actions={actions} connected copyText={copyText} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: '任务详情' }))
  fireEvent.click(screen.getByRole('button', { name: '已完成' }))
  const detail = within(screen.getByRole('article'))
  expect(detail.getByText(state)).toBeTruthy()
  expect(detail.getByText(timestamp)).toBeTruthy()
  expect(screen.getByRole('button', { name: new RegExp(ticket.goal) }).textContent).toContain(state)
  expect(detail.queryByRole('button', { name: '确认验收' })).toBeNull()
  expect(detail.queryByRole('button', { name: /继续/ })).toBeNull()
  expect(actions.completeTask).not.toHaveBeenCalled()
  expect(actions.continueTask).not.toHaveBeenCalled()
  if (completionKind === 'criteria') {
    expect(detail.queryByText('人工验收完成')).toBeNull()
    expect(detail.queryByText('验收时间')).toBeNull()
  }
})
