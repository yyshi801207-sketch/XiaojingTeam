// @vitest-environment jsdom
/** Group answers use the real question provider under the original executor Session. */
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { SlotTestRuntime, bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-user-questions/client'
import type { PendingQuestion, QuestionAnswer } from '@deepseek-ai/dsh-client-ui-user-questions/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionGeneration, ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { TypertClientEventListener } from '@deepseek-ai/dsh-typert-protocol'
import { ChatQuestions, GroupQuestionPanel, type ChatQuestionsInjected } from '../src/client/ChatQuestions.tsx'
import { createGroupQuestions, groupQuestionAvailable, retainGroupQuestion } from '../src/client/chat-questions.ts'
import type { ChatView } from '../src/client/chat-model.ts'
import type { TeamView } from '../src/client/model.ts'
import type { BotId, GroupId, TeamBot } from '../src/types.ts'
import type { ChatId, TeamChat } from '../src/chats-types.ts'
import { en, zh } from '../src/client/locales.ts'

beforeEach(() => { vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: false })) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const workerId = 'editorial-writer' as SessionId
const callId = 'original-question' as ToolCallId
const writer: TeamBot = { id: 'writer' as BotId, kind: 'ordinary', name: 'Writer', role: 'Write',
  avatar: { shape: 'classic', color: '#2288FF' }, model: { kind: 'follow-global' }, groupId: 'bots' as GroupId,
  sessionId: 'writer-private' as SessionId, workDir: '/synthetic/writer' }
const chat: TeamChat = { id: 'editorial' as ChatId, name: 'Editorial', groupId: 'chats' as GroupId,
  rootSessionId: 'editorial-root' as SessionId, workDir: '/synthetic/editorial', memberIds: [writer.id],
  managerId: writer.id, memberRoles: [], executors: [{ botId: writer.id, sessionId: workerId }],
  status: 'active', pauseReason: null, run: null, generation: 1, relayLimit: 6, error: null }
const question: PendingQuestion['questions'] = [{ id: 'mode', question: 'Choose the website style',
  options: [{ label: 'Clean' }, { label: 'Playful' }] }]

async function setup(options: {
  questions?: PendingQuestion['questions']
  blocking?: boolean
  named?: boolean
  fail?: boolean
  ordinaryComposer?: boolean
} = {}) {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale('en')
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  runtime.ctx.effect(() => locale.register('common', { en: commonEn, zh: commonZh }))
  runtime.ctx.effect(() => locale.register('katcats.team', { en, zh }))
  new UiConversation(runtime.ctx, runtime.sessions)
  await runtime.sessions.add({ id: chat.rootSessionId })
  await runtime.sessions.add({ id: workerId })
  await runtime.sessions.add({ id: writer.sessionId })
  const root = runtime.sessions.retainFor(runtime.ctx, chat.rootSessionId)
  const worker = runtime.sessions.retainFor(runtime.ctx, workerId)
  const privateSession = runtime.sessions.retainFor(runtime.ctx, writer.sessionId)
  await Promise.all([root.ready, worker.ready, privateSession.ready])
  const groups = createSnapshotStore<ChatView>({ phase: 'ready', snapshot: { revision: 1, chats: [chat],
    deliveries: [], activities: [], relayLimit: 6 } })
  const directory = createSnapshotStore<TeamView>({ phase: 'ready', catalog: null, snapshot: {
    revision: 1, mainBotId: 'main' as BotId, bots: [writer], groups: [], modelCapabilities: { override: false, followGlobal: false },
  } })
  const connected = createSnapshotStore<ConnectionState | undefined>('connected')
  const generation = createSnapshotStore<ConnectionGeneration | undefined>({ id: 1, host: { home: '/synthetic' } })
  const connection = { state: connected, generation }
  const questions = createGroupQuestions(runtime.ctx.uiSession.sessionStatus, groups, connected, (pending) => {
    if (pending.callId !== undefined) runtime.ctx.get('userQuestionPanels')?.reveal(pending.sessionId, pending.callId)
  })
  runtime.ctx.effect(() => questions.dispose)
  const answer = vi.fn(async (_sessionId: SessionId, _callId: ToolCallId, _answer: QuestionAnswer) => {
    if (options.fail) return { ok: false as const, error: { message: 'Synthetic answer failure' } }
    return { ok: true as const, value: true }
  })
  runtime.remote.provideNamespaces({ userQuestions: { answer } })
  let request: TypertClientEventListener<'user-questions/request'> | undefined
  const originalOn = runtime.remote.$on.bind(runtime.remote)
  vi.spyOn(runtime.remote, '$on').mockImplementation((event, listener) => {
    if (event === 'user-questions/request') request = listener as TypertClientEventListener<'user-questions/request'>
    return originalOn(event, listener)
  })
  const selected = createSnapshotStore(options.ordinaryComposer === true ? worker : root)
  const useSelected = bindSnapshotSelector(selected)
  const useStatus = bindSnapshotSelector(runtime.ctx.uiSession.sessionStatus)
  const unusedChatHook = (): never => { throw new Error('The question dock does not render chat nodes') }
  await runtime.root.declare({ 'conversation.input.dock': { kind: 'list', scope: 'session' },
    'conversation.composer': { kind: 'chain', scope: 'session' },
    'conversation.chat.node': { kind: 'keyed', scope: 'session',
      inject: { hooks: { turnData: () => unusedChatHook, disclosure: () => unusedChatHook, groupAction: () => unusedChatHook } } } },
  ({ SessionProvider, renderSlot, renderSlotChain }: PropsRuntime<'root'>
    & PropsRenderSlots<'conversation.input.dock' | 'conversation.composer'>) => {
    const current = useSelected(value => value)
    const pendingInteraction = useStatus(value => value.get(current.sessionId)?.pendingInteraction)
    if (options.ordinaryComposer === true) return <SessionProvider session={current}>{renderSlotChain('conversation.composer', {
      sessionId: current.sessionId, session: current.binding.session.getSnapshot(), pendingInteraction,
    })}</SessionProvider>
    return <SessionProvider session={current}>{renderSlot('conversation.input.dock', {
      session: current.binding.session.getSnapshot(),
      input: { draft: '', attachmentIds: [], draftRev: 0, phase: 'plain', occurrences: [], queue: [] },
    })}</SessionProvider>
  })
  const retainQuestion = vi.fn<ChatQuestionsInjected['retainQuestion']>((target, signal) => retainGroupQuestion({
    sessions: runtime.sessions, chats: groups, directory, questions: questions.source, connection,
  }, target, signal))
  const revealQuestion = vi.fn<ChatQuestionsInjected['revealQuestion']>(target => target.pending.callId !== undefined
    && (runtime.ctx.get('userQuestionPanels')?.reveal(target.pending.sessionId, target.pending.callId) ?? false))
  const unregister = runtime.slots.register({ name: 'conversation.input.dock', id: 'group-questions', locale: 'katcats.team',
    children: { 'katcats.group.question-panel': { kind: 'single', scope: 'session' } },
    inject: (): ChatQuestionsInjected => ({ hooks: { chats: groups, directory, groupQuestions: questions.source,
      questionConnection: connected, questionGeneration: generation }, retainQuestion, revealQuestion }),
  }, ChatQuestions)
  runtime.slots.register({ name: 'katcats.group.question-panel', locale: 'katcats.team' }, GroupQuestionPanel)
  const provider = await runtime.mount({ inject: [...inject], apply })
  const abort = new AbortController()
  let result: Promise<QuestionAnswer> | undefined
  if (options.blocking) {
    if (request === undefined) throw new Error('Question provider did not subscribe')
    await act(async () => {
      result = request?.call(worker.binding.ctx, { questions: [...(options.questions ?? question)], signal: abort.signal,
        ...options.named === false ? {} : { wait: { callId } } }, async () => { throw new Error('Question was delegated') })
      void result?.catch(() => { /* Individual cancellation tests inspect the original outcome. */ })
    })
  } else {
    await runtime.sessions.setProjection(workerId, 'userQuestions', {
      active: [{ callId, questions: options.questions ?? question, state: 'continued' }], settled: [],
    })
  }
  const view = runtime.renderRoot()
  await vi.waitFor(() => { expect(screen.getByText((options.questions ?? question)[0]!.question)).toBeTruthy() })
  const pending = questions.source.getSnapshot()[0]?.pending
  if (pending === undefined) throw new Error('Missing original question')
  onTestFinished(() => { abort.abort(); unregister() })
  return { runtime, groups, directory, connected, generation, questions, pending, root, worker, privateSession,
    selected, answer, revealQuestion, retainQuestion, view, abort, result, provider }
}

describe('original question Factory shared by group docks and the ordinary composer', () => {
  it('keeps the ordinary composer answering through the same provider Factory', async () => {
    const b = await setup({ ordinaryComposer: true })
    fireEvent.click(screen.getByRole('radio', { name: 'Clean' }))
    await vi.waitFor(() => { expect(screen.getByRole('radio', { name: 'Clean' }).getAttribute('aria-checked')).toBe('true') })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await vi.waitFor(() => { expect(b.answer).toHaveBeenCalledExactlyOnceWith(workerId, callId, {
      answers: [{ id: 'mode', selected: ['Clean'] }],
    }) })
    expect(b.retainQuestion).not.toHaveBeenCalled()
  })

  it('answers an original single choice under the executor, never the group root or private Bot', async () => {
    const b = await setup()
    expect(b.pending.sessionId).toBe(workerId)
    expect(b.retainQuestion.mock.calls[0]?.[0].pending).toBe(b.pending)
    expect(b.view.container.textContent).toContain('Writer')
    fireEvent.click(screen.getByRole('radio', { name: 'Clean' }))
    await vi.waitFor(() => { expect(screen.getByRole('radio', { name: 'Clean' }).getAttribute('aria-checked')).toBe('true') })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await vi.waitFor(() => { expect(b.answer).toHaveBeenCalledExactlyOnceWith(workerId, callId, {
      answers: [{ id: 'mode', selected: ['Clean'] }],
    }) })
    await b.runtime.sessions.setProjection(workerId, 'userQuestions', { active: [], settled: [] })
    await vi.waitFor(() => { expect(screen.queryByText('Choose the website style')).toBeNull() })
  })

  it('preserves drafts when a named panel closes, then resumes and answers the same request', async () => {
    const b = await setup()
    fireEvent.click(screen.getByRole('radio', { name: 'Playful' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close the panel — reopen it from the tool call' }))
    await vi.waitFor(() => { expect(screen.getByRole('button', { name: en['question.resume'] })).toBeTruthy() })
    expect(b.questions.source.getSnapshot()[0]?.pending).toBe(b.pending)
    fireEvent.click(screen.getByRole('button', { name: en['question.resume'] }))
    await vi.waitFor(() => { expect(screen.getByRole('radio', { name: 'Playful' }).getAttribute('aria-checked')).toBe('true') })
    expect(b.revealQuestion.mock.calls[0]?.[0].pending).toBe(b.pending)
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await vi.waitFor(() => { expect(b.answer).toHaveBeenCalledExactlyOnceWith(workerId, callId, { answers: [{ id: 'mode', selected: ['Playful'] }] }) })
  })

  it('uses the provider multi-select and free-text batch without changing answer values', async () => {
    const b = await setup({ questions: [{ id: 'features', question: 'Choose features', multiSelect: true,
      options: [{ label: 'Search' }, { label: 'News' }] }, { id: 'detail', question: 'Additional requirements' }] })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Search' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'News' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.change(screen.getByPlaceholderText('Type your answer'), { target: { value: 'Keep the original logo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await vi.waitFor(() => { expect(b.answer).toHaveBeenCalledExactlyOnceWith(workerId, callId, {
      answers: [{ id: 'features', selected: ['Search', 'News'] }, { id: 'detail', selected: [], custom: 'Keep the original logo' }],
    }) })
  })

  it('shows a failed original answer and leaves the provider draft available for retry', async () => {
    const b = await setup({ fail: true })
    fireEvent.click(screen.getByRole('radio', { name: 'Clean' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await vi.waitFor(() => { expect(screen.getByText('Synthetic answer failure')).toBeTruthy() })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Submit' }).disabled).toBe(false)
    expect(b.questions.source.getSnapshot()[0]?.pending).toBe(b.pending)
  })

  it('removes a hidden original request when the parent cancels it', async () => {
    const b = await setup({ blocking: true })
    fireEvent.click(screen.getByRole('button', { name: 'Close the panel — reopen it from the tool call' }))
    await vi.waitFor(() => { expect(screen.getByRole('button', { name: en['question.resume'] })).toBeTruthy() })
    await act(async () => { b.abort.abort(); await expect(b.result).rejects.toMatchObject({ code: 'ASK_ABORTED' }) })
    expect(b.questions.source.getSnapshot()).toEqual([])
    expect(screen.queryByRole('button', { name: en['question.resume'] })).toBeNull()
    expect(b.answer).not.toHaveBeenCalled()
  })

  it('cancels an unnamed blocking request through the existing question control', async () => {
    const b = await setup({ blocking: true, named: false })
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss all questions' }))
    await expect(b.result).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    await vi.waitFor(() => { expect(b.questions.source.getSnapshot()).toEqual([]) })
  })

  it('restores a hidden blocking question after disconnection without changing its carrier or answer channel', async () => {
    const b = await setup({ blocking: true })
    expect(b.questions.source.getSnapshot()[0]?.waiting).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Close the panel — reopen it from the tool call' }))
    await vi.waitFor(() => { expect(screen.getByRole('button', { name: en['question.resume'] })).toBeTruthy() })
    expect(b.questions.source.getSnapshot()[0]?.waiting).toBe(true)
    const readyGroups = b.groups.getSnapshot()
    await act(async () => { b.groups.set({ ...readyGroups, phase: 'loading' }) })
    expect(b.questions.source.getSnapshot()[0]?.pending).toBe(b.pending)
    await act(async () => { b.groups.set(readyGroups) })
    await vi.waitFor(() => { expect(screen.getByRole('button', { name: en['question.resume'] })).toBeTruthy() })
    await act(async () => { b.connected.set('disconnected') })
    expect(b.questions.source.getSnapshot()).toEqual([])
    expect(b.runtime.sessions.retainInfo(workerId).getSnapshot().retainedBy.katcatsQuestion ?? 0).toBe(0)
    await act(async () => { b.connected.set('connected') })
    await vi.waitFor(() => { expect(screen.getByText('Choose the website style')).toBeTruthy() })
    expect(b.questions.source.getSnapshot()[0]?.pending).toBe(b.pending)
    fireEvent.click(screen.getByRole('radio', { name: 'Clean' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await expect(b.result).resolves.toEqual({ answers: [{ id: 'mode', selected: ['Clean'] }] })
    await vi.waitFor(() => { expect(b.questions.source.getSnapshot()).toEqual([]) })
  })

  it('isolates group and private sessions, and releases references on disconnect or group removal', async () => {
    const b = await setup()
    const target = { rootSessionId: chat.rootSessionId, botId: writer.id, pending: b.pending }
    expect(groupQuestionAvailable({ ...target, rootSessionId: writer.sessionId },
      b.groups.getSnapshot(), b.directory.getSnapshot())).toBe(false)
    const currentGroups = b.groups.getSnapshot().snapshot
    if (currentGroups === null) throw new Error('Missing test group')
    const other = { ...chat, id: 'other' as ChatId, rootSessionId: 'other-root' as SessionId,
      executors: [{ botId: writer.id, sessionId: 'other-worker' as SessionId }] }
    expect(groupQuestionAvailable({ ...target, rootSessionId: other.rootSessionId },
      { phase: 'ready', snapshot: { ...currentGroups, chats: [chat, other] } }, b.directory.getSnapshot())).toBe(false)
    expect(groupQuestionAvailable(target, { phase: 'ready', snapshot: {
      ...currentGroups, chats: [chat, { ...other, executors: chat.executors }],
    } }, b.directory.getSnapshot())).toBe(false)
    await act(async () => { b.selected.set(b.privateSession) })
    expect(screen.queryByText('Choose the website style')).toBeNull()
    await act(async () => { b.selected.set(b.root) })
    await vi.waitFor(() => { expect(screen.getByText('Choose the website style')).toBeTruthy() })
    await act(async () => { b.connected.set('disconnected') })
    expect(b.questions.source.getSnapshot()).toEqual([])
    expect(b.runtime.sessions.retainInfo(workerId).getSnapshot().retainedBy.katcatsQuestion ?? 0).toBe(0)
    await act(async () => { b.connected.set('connected') })
    await vi.waitFor(() => { expect(screen.getByText('Choose the website style')).toBeTruthy() })
    await act(async () => { b.groups.set({ phase: 'ready', snapshot: { revision: 2, chats: [], deliveries: [], activities: [], relayLimit: 6 } }) })
    expect(b.questions.source.getSnapshot()).toEqual([])
    expect(b.runtime.sessions.retainInfo(workerId).getSnapshot().retainedBy.katcatsQuestion ?? 0).toBe(0)
  })
})
