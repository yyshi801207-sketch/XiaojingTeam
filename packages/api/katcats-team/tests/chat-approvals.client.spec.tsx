// @vitest-environment jsdom
/** Group decisions answer original worker requests without granting coordinator authority. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { PendingApproval } from '../../../client/ui-approval/src/client/contract/slots.ts'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { BotId, GroupId, TeamBot } from '../src/types.ts'
import type { ChatId, ChatRunId, ChatSnapshot, TeamChat } from '../src/chats-types.ts'
import type { TeamView } from '../src/client/model.ts'
import type { ChatView } from '../src/client/chat-model.ts'
import { ChatApprovals, type ChatApprovalsInjected, type ChatApprovalsProps } from '../src/client/ChatApprovals.tsx'
import { ChatControls, type ChatControlsProps } from '../src/client/ChatControls.tsx'
import { chatApprovals } from '../src/client/chat-approvals.ts'
import { zh } from '../src/client/locales.ts'

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: false }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const t = makeTranslate(zh)
const workerId = 'editorial-writer' as SessionId
const writer: TeamBot = { id: 'writer' as BotId, kind: 'ordinary', name: 'Writer', role: 'Write',
  avatar: { shape: 'classic', color: '#2288FF' }, model: { kind: 'follow-global' }, groupId: 'bots' as GroupId,
  sessionId: 'writer-private' as SessionId, workDir: '/synthetic/writer' }
const chat: TeamChat = { id: 'editorial' as ChatId, name: 'Editorial', groupId: 'chats' as GroupId,
  rootSessionId: 'editorial-root' as SessionId, workDir: '/synthetic/editorial', memberIds: [writer.id],
  managerId: null, memberRoles: [], executors: [{ botId: writer.id, sessionId: workerId }],
  status: 'active', pauseReason: null, run: { id: 'run' as ChatRunId, generation: 1, relayCount: 0 },
  generation: 1, relayLimit: 6, error: null }
const snapshot: ChatSnapshot = { revision: 1, chats: [chat], deliveries: [], relayLimit: 6,
  activities: [{ chatId: chat.id, processing: true, runningBotIds: [writer.id], pendingControl: null }] }

function bench(request: Partial<ConstructorParameters<typeof PendingApproval>[1]> = {}) {
  const pending = new PendingApproval(workerId, { toolName: 'shell', ...request })
  const statuses = createSnapshotStore<SessionStatusSnapshot>(new Map([[workerId, {
    running: true, pendingInteraction: pending, completionUnread: false,
  }]]))
  const result = pending.result.finally(() => { statuses.set(new Map()) })
  void result.catch(() => { /* Individual tests assert the original rejection. */ })
  const groups = createSnapshotStore<ChatView>({ phase: 'ready', snapshot })
  const directory = createSnapshotStore<TeamView>({ phase: 'ready', catalog: null, snapshot: {
    revision: 1, mainBotId: 'main' as BotId, groups: [], bots: [writer], modelCapabilities: { override: true, followGlobal: false },
  } })
  const readOperation = vi.fn<ChatApprovalsInjected['readOperation']>(async () => '{"command":"synthetic command"}')
  const props = { sessionId: chat.rootSessionId, useChats: bindSnapshotSelector(groups), useDirectory: bindSnapshotSelector(directory),
    useSessionStatus: bindSnapshotSelector(statuses), resolveReason: (value: NonNullable<PendingApproval['displayReason']>) => value['zh'] ?? value.en,
    readOperation, t } as ChatApprovalsProps
  return { props, pending, result, statuses, groups, readOperation }
}

describe('visible group worker approval requests', () => {
  it('marks the saved manager only in this group approval identity and withdraws the marker while the directory reconnects', () => {
    const fixture = bench()
    fixture.groups.set({ phase: 'ready', snapshot: { ...snapshot, chats: [{ ...chat, managerId: writer.id }] } })
    const view = render(<ChatApprovals {...fixture.props} />)
    expect(screen.getByRole('img', { name: zh['chat.managerBadge'] })).toBeTruthy()
    expect(view.container.querySelector('[data-katcats-manager-avatar]')?.getAttribute('data-katcats-manager-avatar')).toBe(writer.id)
    act(() => { fixture.groups.set({ phase: 'loading', snapshot: { ...snapshot, chats: [{ ...chat, managerId: writer.id }] } }) })
    expect(screen.queryByRole('img', { name: zh['chat.managerBadge'] })).toBeNull()
    expect(screen.getByRole('button', { name: zh['approval.allowOnce'] })).toBeTruthy()
    fixture.pending.abort('cancelled')
  })

  it('answers the original execution once and keeps private Bot and coordinator identities distinct', async () => {
    const fixture = bench({ reason: 'Original audit reason', displayReason: { en: 'Request', zh: '原始请求说明' } })
    const answer = vi.spyOn(fixture.pending, 'answer')
    render(<ChatApprovals {...fixture.props} />)
    expect(chatApprovals(chat, fixture.statuses.getSnapshot())[0]?.pending).toBe(fixture.pending)
    expect(fixture.pending.sessionId).toBe(workerId)
    expect(fixture.pending.sessionId).not.toBe(writer.sessionId)
    expect(fixture.pending.sessionId).not.toBe(chat.rootSessionId)
    expect(screen.getByText('原始请求说明')).toBeTruthy()
    expect(fixture.pending.reason).toBe('Original audit reason')
    fireEvent.click(screen.getByRole('button', { name: zh['approval.allowOnce'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['approval.allowOnce'] }))
    await expect(fixture.result).resolves.toBe('allowed-once')
    expect(answer).toHaveBeenCalledExactlyOnceWith('allowed-once')
    await waitFor(() => { expect(screen.queryByLabelText(zh['approval.groupRequests'])).toBeNull() })
  })

  it('rejects explicitly without treating an unrelated Enter key as an approval', async () => {
    const fixture = bench()
    render(<ChatApprovals {...fixture.props} />)
    fireEvent.keyDown(screen.getByRole('group', { name: t('approval.memberRequest', { name: writer.name }) }), { key: 'Enter' })
    expect(fixture.pending.answerable).toBe(true)
    expect(screen.queryByRole('button', { name: zh['approval.allowExecution'] })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh['approval.reject'] }))
    await expect(fixture.result).resolves.toBe('rejected')
  })

  it('offers only the execution-scoped authorization supplied by the original requester', async () => {
    const fixture = bench({ reusable: { label: 'Original range', displayLabel: { en: 'Read files', zh: '读取任务目录' } } })
    render(<ChatApprovals {...fixture.props} />)
    expect(screen.getByText(t('approval.executionScope', { scope: '读取任务目录' }))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['approval.allowExecution'] }))
    await expect(fixture.result).resolves.toBe('allowed-session')
    expect(fixture.pending.reusable?.label).toBe('Original range')
  })

  it.each(['cancelled', 'expired'])('withdraws an original %s request without sending any approval', async reason => {
    const controller = new AbortController()
    const fixture = bench({ signal: controller.signal })
    const answer = vi.spyOn(fixture.pending, 'answer')
    render(<ChatApprovals {...fixture.props} />)
    const failure = new Error(reason)
    await act(async () => { controller.abort(failure); await expect(fixture.result).rejects.toBe(failure) })
    expect(answer).not.toHaveBeenCalled()
    expect(screen.queryByLabelText(zh['approval.groupRequests'])).toBeNull()
  })

  it('keeps Stop available while a worker awaits approval and removes its cancelled request', async () => {
    const controller = new AbortController()
    const fixture = bench({ signal: controller.signal })
    const control = vi.fn(async () => {
      controller.abort(new Error('group stopped'))
      await fixture.result.catch(() => { /* Stop waits for the original request's cancellation. */ })
      fixture.groups.set({ phase: 'ready', snapshot: { ...snapshot, chats: [{ ...chat, status: 'stopped', run: null }] } })
    })
    const controlProps = { sessionId: chat.rootSessionId, useSessionStatus: fixture.props.useSessionStatus,
      useGroupQuestions: bindSnapshotSelector(createSnapshotStore([])),
      useChats: fixture.props.useChats, useDirectory: fixture.props.useDirectory, control, t } as ChatControlsProps
    render(<><ChatApprovals {...fixture.props} /><ChatControls {...controlProps} /></>)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['chat.stop'] }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: zh['chat.stop'] }))
    await waitFor(() => { expect(screen.getByText(zh['chat.stopped'])).toBeTruthy() })
    expect(screen.queryByLabelText(zh['approval.groupRequests'])).toBeNull()
    expect(control).toHaveBeenCalledExactlyOnceWith('stop', { id: chat.id, expectedRunId: chat.run!.id, expectedGeneration: 1 })
  })

  it('does not route another group or private Bot request into the selected group', () => {
    const fixture = bench()
    const other = { ...chat, executors: [{ botId: writer.id, sessionId: 'other-worker' as SessionId }] }
    expect(chatApprovals(other, fixture.statuses.getSnapshot())).toEqual([])
    const view = render(<ChatApprovals {...fixture.props} sessionId={writer.sessionId} />)
    expect(screen.queryByLabelText(zh['approval.groupRequests'])).toBeNull()
    view.rerender(<ChatApprovals {...fixture.props} />)
    expect(screen.getByLabelText(zh['approval.groupRequests'])).toBeTruthy()
    fixture.pending.abort(new Error('test teardown'))
  })

  it('loads exact correlated operation arguments without selecting the worker and cancels on card disposal', async () => {
    const fixture = bench({ callId: 'original-call' as ToolCallId })
    const view = render(<ChatApprovals {...fixture.props} />)
    await waitFor(() => { expect(screen.getByText('{"command":"synthetic command"}')).toBeTruthy() })
    expect(screen.getByText(zh['approval.viewOperation']).closest('details')?.open).toBe(false)
    expect(fixture.readOperation).toHaveBeenCalledExactlyOnceWith(fixture.pending, expect.any(AbortSignal))
    const signal = fixture.readOperation.mock.calls[0]?.[1]
    view.unmount()
    expect(signal?.aborted).toBe(true)
    expect(fixture.pending.answerable).toBe(true)
    fixture.pending.abort(new Error('test teardown'))
  })
})
