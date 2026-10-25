// @vitest-environment jsdom
/** Group list marks follow real public execution and human-interaction carriers. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionStatus, SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { PendingApproval } from '../../../client/ui-approval/src/client/contract/slots.ts'
import { PendingQuestion } from '../../../client/ui-user-questions/src/client/contract/slots.ts'
import type { BotId, GroupId } from '../src/types.ts'
import type { ChatDelivery, ChatDeliveryId, ChatId, ChatRunId, ChatSnapshot, TeamChat } from '../src/chats-types.ts'
import type { ChatView } from '../src/client/chat-model.ts'
import { chatSidebarStatus } from '../src/client/chat-sidebar-status.ts'
import { createSidebarSessionStatus } from '../src/client/sidebar-session-status.ts'
import { ChatSidebarStatus } from '../src/client/ChatSidebarStatus.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)
const t = makeTranslate(zh)
const botId = 'writer' as BotId
const workerId = 'editorial-writer' as SessionId
const chat: TeamChat = { id: 'editorial' as ChatId, name: 'Editorial', groupId: 'chats' as GroupId,
  rootSessionId: 'editorial-root' as SessionId, workDir: '/synthetic/editorial', memberIds: [botId], managerId: null,
  memberRoles: [], executors: [{ botId, sessionId: workerId }], relayLimit: 6,
  generation: 1, status: 'active', pauseReason: null, error: null,
  run: { id: 'run' as ChatRunId, generation: 1, relayCount: 1 } }
const delivery: ChatDelivery = { id: 'delivery' as ChatDeliveryId, chatId: chat.id, runId: chat.run!.id,
  generation: 1, sourceSessionId: chat.rootSessionId, source: { kind: 'owner-message', messageId: 'owner' as MessageId },
  botId, executorSessionId: workerId, message: 'Prepare the report', inputMessageId: 'input' as MessageId,
  relayMessageId: 'relay' as MessageId, state: 'running', receipt: null, pass: null, relayed: false, error: null }
const complete: ChatDelivery = { ...delivery, state: 'completed', relayed: true,
  receipt: { sender: { botId, name: 'Writer', role: 'Write reports', avatar: { shape: 'classic', color: '#FF2849' } },
    text: 'The report is ready.', outputMessageId: 'output' as MessageId, turn: 1 } }
const idle = new Map() satisfies SessionStatusSnapshot
function view(group = chat, deliveries: readonly ChatDelivery[] = [delivery], extra: Partial<ChatSnapshot> = {}): ChatView {
  return { phase: 'ready', snapshot: { revision: 1, chats: [group], deliveries, relayLimit: 6, activities: [], ...extra } }
}
function statuses(pendingInteraction?: SessionStatus['pendingInteraction']): SessionStatusSnapshot {
  return new Map([[workerId, { running: true, pendingInteraction, completionUnread: false }]])
}

describe('truthful group sidebar state', () => {
  it('keeps new groups idle and requires all current saved results to be published before completion', () => {
    const finished = { ...chat, run: null }
    expect(chatSidebarStatus(finished, view(finished, []), idle)).toBe('idle')
    expect(chatSidebarStatus(finished, view(finished, [{ ...complete, generation: 0 }]), idle)).toBe('idle')
    expect(chatSidebarStatus(chat, view(chat, [complete]), idle)).toBe('preparing')
    expect(chatSidebarStatus(finished, view(finished, [{ ...complete, relayed: false }]), idle)).toBe('preparing')
    expect(chatSidebarStatus(finished, view(finished, [{ ...complete, receipt: null }]), idle)).toBe('attention')
    expect(chatSidebarStatus(finished, view(finished, [complete, { ...delivery, id: 'next' as ChatDeliveryId, state: 'accepted' }]), idle)).toBe('preparing')
    expect(chatSidebarStatus(finished, view(finished, [complete, { ...delivery, id: 'pass' as ChatDeliveryId, state: 'passed', pass: { turn: 2, callId: 'pass' as ToolCallId } }]), idle)).toBe('completed')
    expect(chatSidebarStatus(finished, view(finished, [{ ...delivery, state: 'passed', pass: { turn: 1, callId: 'pass' as ToolCallId } }]), idle)).toBe('idle')
  })

  it('distinguishes real execution from dispatch, stopped work, unknown results and stale directory data', () => {
    expect(chatSidebarStatus(chat, view(), idle)).toBe('preparing')
    expect(chatSidebarStatus(chat, view(), statuses())).toBe('running')
    expect(chatSidebarStatus(chat, view(chat, [delivery], { activities: [{ chatId: chat.id, processing: true, runningBotIds: [botId], pendingControl: null }] }), idle)).toBe('running')
    expect(chatSidebarStatus({ ...chat, status: 'paused' }, view(), idle)).toBe('paused')
    expect(chatSidebarStatus({ ...chat, status: 'paused' }, view(), statuses())).toBe('running')
    expect(chatSidebarStatus({ ...chat, status: 'stopped', run: null }, view(chat, [complete]), idle)).toBe('stopped')
    for (const state of ['failed', 'unknown'] as const) {
      expect(chatSidebarStatus({ ...chat, run: null }, view(chat, [{ ...delivery, state }]), idle)).toBe('attention')
    }
    expect(chatSidebarStatus({ ...chat, error: { code: 'save-failed', message: 'Saved result unconfirmed' } }, view(), idle)).toBe('attention')
    expect(chatSidebarStatus(chat, { ...view(chat, [complete]), phase: 'loading' }, idle)).toBe('syncing')
    expect(chatSidebarStatus(chat, { ...view(chat, [complete]), phase: 'failed' }, idle)).toBe('syncing')
    expect(chatSidebarStatus(chat, view(chat, [complete], { activities: [{ chatId: chat.id, processing: true, runningBotIds: [], pendingControl: 'stop' }] }), idle)).toBe('updating')
  })

  it('isolates approvals by group, generation, membership and exact execution Session', async () => {
    const approval = new PendingApproval(workerId, { toolName: 'shell' })
    const pending = statuses(approval)
    expect(chatSidebarStatus(chat, view(), pending)).toBe('approval')
    expect(chatSidebarStatus(chat, view(chat, [{ ...delivery, generation: 0 }]), pending)).toBe('preparing')
    expect(chatSidebarStatus(chat, view(chat, [{ ...delivery, state: 'completed' }]), pending)).toBe('preparing')
    expect(chatSidebarStatus(chat, view(chat, [{ ...delivery, chatId: 'other-group' as ChatId }]), pending)).toBe('preparing')
    expect(chatSidebarStatus({ ...chat, memberIds: [] }, view(), pending)).toBe('preparing')
    expect(chatSidebarStatus({ ...chat, executors: [{ botId, sessionId: 'writer-private' as SessionId }] }, view(), pending)).toBe('preparing')
    const elsewhere = new Map([['writer-private' as SessionId, pending.get(workerId)!], ['other-group-writer' as SessionId, pending.get(workerId)!]])
    expect(chatSidebarStatus(chat, view(), elsewhere)).toBe('preparing')
    await approval.answer('allowed-once')
    expect(chatSidebarStatus(chat, view(), pending)).toBe('running')
  })

  it('never treats continued, closed or read-only questions as a blocking confirmation', () => {
    const question = new PendingQuestion(workerId, [{ id: 'continue', question: 'Continue?', header: 'Review' }])
    const channel = { deadline: undefined, resolve: vi.fn(), reject: vi.fn(), delegate: vi.fn() }
    question.attachWaterfall(channel)
    expect(chatSidebarStatus(chat, view(), statuses(question))).toBe('confirmation')
    question.setState('continued')
    expect(chatSidebarStatus(chat, view(), statuses(question))).toBe('running')
    question.setState('open')
    question.close()
    expect(chatSidebarStatus(chat, view(), statuses(question))).toBe('running')
    const review = new PendingQuestion(workerId, [], 'review' as ToolCallId, undefined, [])
    expect(chatSidebarStatus(chat, view(), statuses(review))).toBe('running')
  })
})

it('records real status transitions and reacts to the public question carrier without a Session map replacement', () => {
  const groups = createSnapshotStore(view({ ...chat, run: null }, []))
  const source = createSnapshotStore<SessionStatusSnapshot>(idle)
  const adapter = createSidebarSessionStatus(source)
  const useGroups = bindSnapshotSelector(groups)
  const useStatuses = bindSnapshotSelector(adapter.source)
  function Status() {
    const current = useGroups(value => value)
    const sessions = useStatuses(value => value)
    const status = chatSidebarStatus(current.snapshot!.chats[0]!, current, sessions)
    return <ChatSidebarStatus status={status} label={t(`sidebar.chatStatus.${status}`)} />
  }
  const rendered = render(<Status />)
  const history: { status: string | undefined; label: string | null; spinning: boolean }[] = []
  const capture = () => {
    const icon = screen.getByRole('img')
    history.push({ status: icon.dataset['chatStatus'], label: icon.getAttribute('aria-label'), spinning: icon.querySelector('[data-state="ongoing"]') !== null })
  }
  capture()
  act(() => { groups.set(view()); source.set(statuses()) })
  capture()
  const question = new PendingQuestion(workerId, [{ id: 'outline', question: 'Approve the outline?', header: 'Outline' }])
  act(() => { source.set(statuses(question)) })
  const original = source.getSnapshot()
  const channel = { deadline: undefined, resolve: vi.fn(), reject: vi.fn(), delegate: vi.fn() }
  act(() => { question.attachWaterfall(channel) })
  expect(source.getSnapshot()).toBe(original)
  capture()
  act(() => { question.takeTime() })
  capture()
  act(() => { question.setState('continued'); question.detachWaterfall(channel) })
  capture()
  act(() => { source.set(idle); groups.set(view({ ...chat, run: null }, [complete])) })
  capture()
  act(() => { groups.set(view({ ...chat, status: 'stopped', run: null }, [complete])) })
  capture()
  expect(history).toMatchInlineSnapshot(`
    [
      {
        "label": "等待新消息",
        "spinning": false,
        "status": "idle",
      },
      {
        "label": "群成员正在执行任务",
        "spinning": true,
        "status": "running",
      },
      {
        "label": "有成员等待你的确认",
        "spinning": false,
        "status": "confirmation",
      },
      {
        "label": "有成员等待你的确认",
        "spinning": false,
        "status": "confirmation",
      },
      {
        "label": "群成员正在执行任务",
        "spinning": true,
        "status": "running",
      },
      {
        "label": "本轮协作已完成，成员结果已保存",
        "spinning": false,
        "status": "completed",
      },
      {
        "label": "本轮协作已停止",
        "spinning": false,
        "status": "stopped",
      },
    ]
  `)
  expect(en['sidebar.chatStatus.confirmation']).toBe('A member is waiting for your confirmation')
  rendered.unmount()
  const last = adapter.source.getSnapshot()
  adapter.dispose()
  source.set(statuses(question))
  question.close()
  expect(adapter.source.getSnapshot()).toBe(last)
})
