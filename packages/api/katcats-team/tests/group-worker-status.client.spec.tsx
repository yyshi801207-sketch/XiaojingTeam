// @vitest-environment jsdom
/** Visible workers reflect exact group activity and original approval ownership. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { PendingApproval } from '../../../client/ui-approval/src/client/contract/slots.ts'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { BotId, TeamBot } from '../src/types.ts'
import type { TeamView } from '../src/client/model.ts'
import { GroupWorkerStatus, type GroupWorkerStatusItem } from '../src/client/GroupWorkerStatus.tsx'
import { ChatControls, type ChatControlsProps } from '../src/client/ChatControls.tsx'
import { en, zh } from '../src/client/locales.ts'
import { presentationDirectory } from './group-presentation-fixture.client.ts'

const writer: TeamBot = { id: 'writer' as BotId, kind: 'ordinary', name: 'Writer', role: 'Write',
  avatar: { shape: 'classic', color: '#2288FF' }, model: { kind: 'follow-global' }, groupId: null,
  sessionId: 'writer-private' as SessionId, workDir: '/synthetic/writer' }
const reviewer: TeamBot = { ...writer, id: 'reviewer' as BotId, name: 'Reviewer', sessionId: 'reviewer-private' as SessionId }
const members: readonly GroupWorkerStatusItem[] = [{ bot: writer, phase: 'working' }, { bot: reviewer, phase: 'approval' }]
const t = makeTranslate(zh)
let media: EventTarget & { matches: boolean }

beforeEach(() => {
  media = Object.assign(new EventTarget(), { matches: false })
  vi.stubGlobal('matchMedia', () => media)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const visible = (container: HTMLElement) => container.querySelector('[data-katcats-working-member]')?.getAttribute('data-katcats-working-member')

describe('compact live group status', () => {
  it('rotates actual members at four seconds while a single member remains fixed and never uses a live announcement', () => {
    vi.useFakeTimers()
    const view = render(<GroupWorkerStatus members={members} managerId={writer.id} t={t} />)
    expect(visible(view.container)).toBe(writer.id)
    expect(screen.getByRole('group').getAttribute('aria-live')).toBe('off')
    expect(screen.queryByRole('status')).toBeNull()
    expect(view.container.textContent).toMatchInlineSnapshot('"Writer正在处理1/2"')
    act(() => { vi.advanceTimersByTime(4_000) })
    expect(visible(view.container)).toBe(reviewer.id)
    expect(view.container.textContent).toMatchInlineSnapshot('"Reviewer等待审批2/2"')
    act(() => { vi.advanceTimersByTime(4_000) })
    expect(visible(view.container)).toBe(writer.id)
    view.rerender(<GroupWorkerStatus members={[members[0]!]} managerId={writer.id} t={t} />)
    expect(vi.getTimerCount()).toBe(0)
    act(() => { vi.advanceTimersByTime(20_000) })
    expect(visible(view.container)).toBe(writer.id)
    expect(view.container.textContent).toBe('Writer正在处理')
  })

  it('pauses rotation on hover and keyboard focus and releases its timer on disposal', () => {
    vi.useFakeTimers()
    const view = render(<GroupWorkerStatus members={members} managerId={null} t={t} />)
    const status = screen.getByRole('group')
    fireEvent.mouseEnter(status)
    act(() => { vi.advanceTimersByTime(12_000) })
    expect(visible(view.container)).toBe(writer.id)
    fireEvent.mouseLeave(status)
    act(() => { vi.advanceTimersByTime(4_000) })
    expect(visible(view.container)).toBe(reviewer.id)
    fireEvent.focus(status)
    act(() => { vi.advanceTimersByTime(12_000) })
    expect(visible(view.container)).toBe(reviewer.id)
    fireEvent.blur(status, { relatedTarget: document.body })
    act(() => { vi.advanceTimersByTime(4_000) })
    expect(visible(view.container)).toBe(writer.id)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the four-second cadence through equivalent directory refreshes and resets when member order changes', () => {
    vi.useFakeTimers()
    const view = render(<GroupWorkerStatus members={members} managerId={null} t={t} />)
    const refresh = () => {
      view.rerender(<GroupWorkerStatus members={members.map(member => ({ ...member, bot: { ...member.bot } }))}
        managerId={null} t={t} />)
    }
    act(() => { vi.advanceTimersByTime(2_000) })
    refresh()
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(visible(view.container)).toBe(reviewer.id)
    refresh()
    act(() => { vi.advanceTimersByTime(2_000) })
    refresh()
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(visible(view.container)).toBe(writer.id)
    act(() => { vi.advanceTimersByTime(2_000) })
    view.rerender(<GroupWorkerStatus members={[members[1]!, members[0]!]} managerId={null} t={t} />)
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(visible(view.container)).toBe(writer.id)
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(visible(view.container)).toBe(reviewer.id)
  })

  it('stops on hidden documents and presents all real members statically when reduced motion changes', () => {
    vi.useFakeTimers()
    const hidden = vi.spyOn(document, 'visibilityState', 'get')
    const view = render(<GroupWorkerStatus members={members} managerId={null} t={t} />)
    act(() => { hidden.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')) })
    expect(vi.getTimerCount()).toBe(0)
    act(() => { vi.advanceTimersByTime(8_000) })
    expect(visible(view.container)).toBe(writer.id)
    act(() => { hidden.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')) })
    expect(vi.getTimerCount()).toBe(1)
    act(() => { media.matches = true; media.dispatchEvent(new Event('change')) })
    expect(vi.getTimerCount()).toBe(0)
    expect(view.container.querySelectorAll('[data-katcats-working-member]')).toHaveLength(2)
    expect(view.container.textContent).toBe('Writer正在处理Reviewer等待审批')
    expect(screen.getByRole('group').hasAttribute('tabindex')).toBe(false)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('removes departed workers immediately and localizes the stable accessible member summary', () => {
    vi.useFakeTimers()
    const english = makeTranslate(en)
    const view = render(<GroupWorkerStatus members={members} managerId={null} t={english} />)
    act(() => { vi.advanceTimersByTime(4_000) })
    expect(visible(view.container)).toBe(reviewer.id)
    view.rerender(<GroupWorkerStatus members={[members[0]!]} managerId={null} t={english} />)
    expect(visible(view.container)).toBe(writer.id)
    expect(screen.getByRole('group').getAttribute('aria-label')).toBe('Writer: Working')
    view.rerender(<GroupWorkerStatus members={[]} managerId={null} t={english} />)
    expect(view.container.textContent).toBe('')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('maps an approval only to its original executor and never labels queued or other-group members as working', () => {
    media.matches = true
    const writerExecutor = 'editorial-writer' as SessionId
    const reviewerExecutor = 'editorial-reviewer' as SessionId
    const group = presentationDirectory({ managerId: writer.id, executors: [
      { botId: writer.id, sessionId: writerExecutor }, { botId: reviewer.id, sessionId: reviewerExecutor },
    ] })
    const saved = group.source.getSnapshot().snapshot!
    group.source.set({ phase: 'ready', snapshot: { ...saved,
      activities: [{ chatId: group.chat.id, runningBotIds: [writer.id, reviewer.id], processing: true, pendingControl: null }] } })
    const directory = createSnapshotStore<TeamView>({ phase: 'ready', catalog: null, snapshot: {
      revision: 1, mainBotId: 'main' as BotId, bots: [writer, reviewer], groups: [], modelCapabilities: { override: true, followGlobal: false },
    } })
    const approval = new PendingApproval(reviewerExecutor, { toolName: 'write' })
    void approval.result.catch(() => { /* This presentation fixture cancels its own original request during cleanup. */ })
    const statuses = createSnapshotStore<SessionStatusSnapshot>(new Map([[reviewerExecutor, {
      running: true, pendingInteraction: approval, completionUnread: false,
    }]]))
    const props = { sessionId: group.chat.rootSessionId, useChats: group.useGroupDirectory,
      useDirectory: bindSnapshotSelector(directory), useSessionStatus: bindSnapshotSelector(statuses),
      control: vi.fn(async () => {}), t } as ChatControlsProps
    const view = render(<ChatControls {...props} />)
    expect(screen.queryByText(zh['chat.active'])).toBeNull()
    expect(screen.queryByText(zh['chat.processing'])).toBeNull()
    expect(screen.queryByText(t('chat.coordinator', { name: writer.name }))).toBeNull()
    expect(view.container.querySelector('[data-katcats-working-member="writer"]')?.textContent).toBe('Writer正在处理')
    expect(view.container.querySelector('[data-katcats-working-member="reviewer"]')?.textContent).toBe('Reviewer等待审批')
    act(() => { statuses.set(new Map([[writer.sessionId, { running: true, pendingInteraction: approval, completionUnread: false }]])) })
    expect(view.container.textContent).not.toContain('等待审批')
    act(() => { group.source.set({ phase: 'ready', snapshot: { ...saved, activities: [{ chatId: group.chat.id,
      runningBotIds: [], processing: true, pendingControl: null }] } }) })
    expect(view.container.querySelector('[data-katcats-worker-status]')).toBeNull()
    expect(screen.getByText(zh['chat.preparing'])).toBeTruthy()
    act(() => { group.source.set({ phase: 'failed', snapshot: saved }) })
    expect(view.container.querySelector('[data-katcats-working-member]')).toBeNull()
    approval.abort('cancelled')
  })
})
