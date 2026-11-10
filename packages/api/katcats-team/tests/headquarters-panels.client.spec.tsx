// @vitest-environment jsdom
/** Global personnel filtering and live overview presentation. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { BotId, GroupId, TeamBot, TeamSnapshot } from '../src/types.ts'
import type { ChatId, TeamChat } from '../src/chats-types.ts'
import { HeadquartersPeople } from '../src/client/HeadquartersPeople.tsx'
import { HeadquartersOverview } from '../src/client/HeadquartersOverview.tsx'
import { projectHeadquarters } from '../src/client/headquarters-model.ts'
import { roomZh } from '../src/client/room-locales.ts'

beforeEach(() => { vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: false })) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

const t = makeTranslate(roomZh)
const bot = (id: string, name: string): TeamBot => ({ id: id as BotId, name, kind: id === 'main' ? 'main' : 'ordinary',
  role: 'Synthetic responsibility', avatar: { shape: 'classic', color: '#10B8A6' }, model: { kind: 'follow-global' },
  workDir: '/synthetic/private', groupId: null, sessionId: `private-${id}` as SessionId })
const main = bot('main', '主 Bot'), shared = bot('shared', '共享成员'), visitor = bot('visitor', '独立成员')
const group = (id: string): TeamChat => ({ id: id as ChatId, name: id, groupId: 'groups' as GroupId,
  rootSessionId: `root-${id}` as SessionId, memberIds: [shared.id], managerId: shared.id,
  memberRoles: [{ botId: shared.id, role: `职责-${id}` }], executors: [{ botId: shared.id, sessionId: `worker-${id}` as SessionId }],
  workDir: `/synthetic/${id}`, relayLimit: 6, status: 'active', pauseReason: null, error: null, run: null, generation: 1 })

it('lists every Bot by membership while keeping the unique total and group-local details', () => {
  const directory: TeamSnapshot = { revision: 1, mainBotId: main.id, groups: [], bots: [main, shared, visitor],
    modelCapabilities: { override: true, followGlobal: true } }
  const data = projectHeadquarters(directory, { revision: 1, chats: [group('财务部'), group('研发部')],
    deliveries: [], activities: [], relayLimit: 6 }, true)
  const close = vi.fn()
  const copyText = vi.fn(async (_text: string) => {})
  render(<HeadquartersPeople directory={directory} data={data} selected={'财务部' as ChatId}
    activity={{ connected: true, members: [{ botId: shared.id, sessionId: 'worker-财务部' as SessionId,
      state: 'ready', rows: [], permission: 'workspace-write' }] }} statuses={new Map()} connected close={close} openBot={vi.fn()} copyText={copyText} t={t} />)
  const dialog = screen.getByRole('dialog', { name: '人员管理' })
  expect(within(dialog).getByText('3 位 Bot · 按身份去重')).toBeTruthy()
  expect(within(dialog).getAllByText('共享成员')).toHaveLength(2)
  expect(within(dialog).getByText('独立成员')).toBeTruthy()
  const finance = within(dialog).getByRole('region', { name: '财务部' })
  const research = within(dialog).getByRole('region', { name: '研发部' })
  expect(finance.textContent).toContain('职责-财务部')
  expect(finance.textContent).toContain(roomZh['people.workspaceWrite'])
  expect(research.textContent).not.toContain(roomZh['people.workspaceWrite'])
  expect(research.textContent).toContain(roomZh['people.unavailable'])
  expect(dialog.textContent).toMatchSnapshot()
  fireEvent.contextMenu(within(finance).getByRole('article'))
  fireEvent.click(screen.getByRole('menuitem', { name: '复制名称' }))
  expect(copyText).toHaveBeenCalledExactlyOnceWith(shared.name)
  fireEvent.keyDown(within(finance).getByRole('article'), { key: 'F10', shiftKey: true })
  fireEvent.click(screen.getByRole('menuitem', { name: '查看成员详情' }))
  expect(within(finance).getByText('/synthetic/财务部')).toBeTruthy()
  expect(within(research).queryByText('/synthetic/研发部')).toBeNull()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '独立成员' } })
  expect(screen.queryAllByText('共享成员')).toHaveLength(0)
  expect(screen.getByText('独立成员')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '关闭人员管理' }))
  expect(close).toHaveBeenCalledOnce()
})

it('shows a local ticking clock, replaces disconnected totals and disposes the timer', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 10, 2, 11, 58, 59))
  const onPeople = vi.fn()
  const view = render(<HeadquartersOverview busy={2} active={1} connected onPeople={onPeople} t={t} />)
  expect(view.container.querySelector('time')?.textContent).toBe('11:58')
  expect(view.container.textContent).toContain('2 位 Bot 在忙')
  fireEvent.click(screen.getByRole('button', { name: '人员管理' }))
  expect(onPeople).toHaveBeenCalledOnce()
  act(() => { vi.advanceTimersByTime(1000) })
  expect(view.container.querySelector('time')?.textContent).toBe('11:59')
  view.rerender(<HeadquartersOverview busy={2} active={1} connected={false} onPeople={onPeople} t={t} />)
  expect(view.container.textContent).toContain('— 位 Bot 在忙')
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})
