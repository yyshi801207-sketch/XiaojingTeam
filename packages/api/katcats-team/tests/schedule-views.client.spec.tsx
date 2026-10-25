// @vitest-environment jsdom
/** Observable task ownership, searching and original-Session detail navigation. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule/client'
import { ScheduleList, ScheduleManager, type ScheduleListProps, type ScheduleManagerProps } from '../src/client/ScheduleViews.tsx'
import type { ScheduleView } from '../src/client/schedule-model.ts'
import type { TeamView } from '../src/client/model.ts'
import type { ChatView } from '../src/client/chat-model.ts'
import { scheduleEn, scheduleZh } from '../src/client/schedule-locales.ts'
import { chatSnapshot, editorial, tasks, teamSnapshot, writer } from './schedule-fixture.client.ts'

afterEach(cleanup)
const t = makeTranslate(scheduleZh)
function harness() {
  const schedules = createSnapshotStore<ScheduleView>({ phase: 'ready', records: tasks })
  const directory = createSnapshotStore<TeamView>({ phase: 'ready', snapshot: teamSnapshot, catalog: null })
  const chats = createSnapshotStore<ChatView>({ phase: 'ready', snapshot: chatSnapshot })
  const openTask = vi.fn<(task: ScheduleCatalogEntry) => void>()
  const reload = vi.fn(async () => {})
  const props = { useSchedules: bindSnapshotSelector(schedules), useDirectory: bindSnapshotSelector(directory),
    useChats: bindSnapshotSelector(chats), openTask, reload, t } as ScheduleManagerProps
  return { schedules, directory, chats, openTask, reload, props }
}

describe('linked automation views', () => {
  it('shows every retained task once in the aggregate, and group executor tasks only in their group', () => {
    const h = harness()
    render(<ScheduleManager {...h.props} />)
    expect(screen.getAllByRole('button', { name: /^查看「/ })).toHaveLength(tasks.length)
    const group = screen.getByRole('region', { name: t('chat', { name: editorial.name }) })
    expect(within(group).getByRole('button', { name: t('detail', { name: 'Former member task' }) })).toBeTruthy()
    const privateBot = screen.getByRole('region', { name: t('bot', { name: writer.name }) })
    expect(within(privateBot).getAllByRole('button')).toHaveLength(1)
    expect(within(privateBot).queryByText('Editorial draft')).toBeNull()
    expect(screen.getByRole('region', { name: scheduleZh.unlinked }).textContent).toContain('Legacy unlinked')
  })

  it('opens original worker-bound task details and never uses the current root as a replacement binding', () => {
    const h = harness()
    render(<ScheduleList {...h.props as ScheduleListProps} sessionId={editorial.rootSessionId} />)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByText(scheduleZh.search)).toBeNull()
    expect(screen.getAllByRole('button', { name: /^查看「/ })).toHaveLength(3)
    expect(screen.queryByText('Research draft')).toBeNull()
    expect(screen.queryByText('Private draft')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('detail', { name: 'Editorial draft' }) }))
    expect(h.openTask).toHaveBeenCalledExactlyOnceWith(tasks[3])
    expect(h.openTask.mock.calls[0]?.[0].sessionId).toBe(editorial.executors[0]!.sessionId)
    expect(screen.getByText(scheduleZh.chatNotice)).toBeTruthy()
  })

  it('uses the shared records in both views after a task edit or deletion', () => {
    const h = harness()
    render(<><ScheduleManager {...h.props} /><ScheduleList {...h.props as ScheduleListProps} sessionId={writer.sessionId} /></>)
    expect(screen.getAllByText('Private draft')).toHaveLength(2)
    act(() => { h.schedules.set({ phase: 'ready', records: tasks.filter(task => task.sessionId !== writer.sessionId) }) })
    expect(screen.queryByText('Private draft')).toBeNull()
    const scoped = screen.getByRole('region', { name: t('scopedTitle', { name: writer.name }) })
    expect(within(scoped).queryByRole('textbox')).toBeNull()
    expect(within(scoped).getByText(scheduleZh.empty)).toBeTruthy()
  })

  it('filters by owner name and status while leaving the task catalog unchanged', () => {
    const h = harness()
    render(<ScheduleManager {...h.props} />)
    fireEvent.change(screen.getByLabelText(scheduleZh.search), { target: { value: 'Research' } })
    expect(screen.getAllByRole('button', { name: /^查看「/ })).toHaveLength(1)
    expect(screen.getByText('Research draft')).toBeTruthy()
    fireEvent.change(screen.getByLabelText(scheduleZh.search), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: scheduleZh.inactive }))
    expect(screen.getAllByRole('button', { name: /^查看「/ })).toHaveLength(1)
    expect(screen.getByText('Legacy unlinked')).toBeTruthy()
    expect(h.schedules.getSnapshot().records).toBe(tasks)
  })

  it('preserves retained rows through failure, offers retry and avoids false unlinked ownership while directories load', () => {
    const h = harness()
    h.schedules.set({ phase: 'failed', records: tasks })
    const view = render(<ScheduleManager {...h.props} />)
    expect(screen.getByRole('alert').textContent).toBe(scheduleZh.failed)
    expect(screen.getByText('Private draft')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: scheduleZh.refresh }))
    expect(h.reload).toHaveBeenCalledOnce()
    act(() => { h.directory.set({ phase: 'loading', snapshot: null, catalog: null }) })
    expect(screen.queryByRole('region', { name: scheduleZh.unlinked })).toBeNull()
    expect(screen.queryByRole('button', { name: t('detail', { name: 'Legacy unlinked' }) })).toBeNull()
    view.rerender(<ScheduleManager {...h.props} t={makeTranslate(scheduleEn)} />)
    expect(screen.getByRole('status').textContent).toBe(scheduleEn.loading)
  })
})
