// @vitest-environment jsdom
/** Saved task browsing stays group-local and follows confirmed directory updates. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatId, GroupTicket, GroupTicketId, TeamChat } from '../src/chats-types.ts'
import type { BotId, GroupId, TeamBot } from '../src/types.ts'
import { TaskArchiveAction } from '../src/client/TaskArchive.tsx'
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
  fireEvent.click(screen.getByRole('button', { name: '任务档案' }))
  const dialog = screen.getByRole('dialog', { name: '任务档案' })
  expect(dialog.textContent).toMatchSnapshot()
  expect(within(dialog).getByRole('article').textContent).toContain('核对银行流水')
  expect(within(dialog).queryByText('已完成')).toBeNull()
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
  fireEvent.click(screen.getByRole('button', { name: '任务档案' }))
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
  fireEvent.click(screen.getByRole('button', { name: '任务档案' }))
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
