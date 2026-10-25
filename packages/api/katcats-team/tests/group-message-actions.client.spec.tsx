// @vitest-environment jsdom
/** Acknowledgements belong to exact retained group bindings and never become member speech. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate, SlotTestRuntime, sessionSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConnectionGeneration, ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ComposerBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { BotId, GroupId, TeamBot } from '../src/types.ts'
import type { ChatId, TeamChat } from '../src/chats-types.ts'
import type { ChatView } from '../src/client/chat-model.ts'
import type { TeamView } from '../src/client/model.ts'
import { createGroupMessageFeedback } from '../src/client/group-message-feedback.ts'
import { GroupMessageActions, GroupMessageFeedback, type GroupMessageActionsProps } from '../src/client/GroupMessageActions.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)
const root = 'editorial-root' as SessionId
const writer: TeamBot = { id: 'writer' as BotId, kind: 'ordinary', name: 'Writer', role: 'Writing',
  avatar: { shape: 'classic', color: '#FF2849' }, model: { kind: 'follow-global' }, groupId: 'bots' as GroupId,
  workDir: '/synthetic/writer', sessionId: 'writer-private' as SessionId }
const chat: TeamChat = { id: 'editorial' as ChatId, groupId: 'chats' as GroupId, name: 'Editorial', rootSessionId: root,
  managerId: writer.id, memberRoles: [], workDir: '/synthetic/editorial', memberIds: [writer.id],
  executors: [{ botId: writer.id, sessionId: 'editorial-writer' as SessionId }],
  status: 'active', pauseReason: null, run: null, error: null, generation: 0, relayLimit: 16 }
const request = (requestId = 'one', mode: SessionPromptRequest['mode'] = 'queue'): SessionPromptRequest => ({
  sessionId: root, requestId: requestId as SessionPromptRequest['requestId'], mode,
  content: [{ type: 'text', text: 'Follow up without discarding the current task.' }],
})

async function setup() {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  await runtime.sessions.add({ id: root })
  const reference = runtime.sessions.retainFor(runtime.ctx, root)
  const binding = await reference.ready
  const connection = createSnapshotStore<ConnectionState | undefined>('connected')
  const generation = createSnapshotStore<ConnectionGeneration | undefined>({ id: 1, host: { home: '/synthetic' } })
  const feedback = createGroupMessageFeedback({ binding: id => runtime.sessions.binding(id),
    connection: { state: connection, generation } })
  onTestFinished(() => { feedback.dispose() })
  const chats = createSnapshotStore<ChatView>({ phase: 'ready', snapshot: {
    revision: 1, chats: [chat], deliveries: [], activities: [], relayLimit: 16,
  } })
  const directory = createSnapshotStore<TeamView>({ phase: 'ready', catalog: null, snapshot: {
    revision: 1, mainBotId: 'main' as BotId, bots: [writer], groups: [],
    modelCapabilities: { override: false, followGlobal: false },
  } })
  const input = createSnapshotStore<InputState>({ draft: 'A follow-up', attachmentIds: [], draftRev: 1,
    phase: 'plain', occurrences: [], queue: [] })
  const session = createSnapshotStore(sessionSnapshot(root))
  const interrupt = vi.fn()
  const block = createSnapshotStore<ComposerBlock | undefined>(undefined)
  const props = { sessionId: root, useChats: bindSnapshotSelector(chats), useDirectory: bindSnapshotSelector(directory),
    useConnection: bindSnapshotSelector(connection), useConnectionGeneration: bindSnapshotSelector(generation),
    useGroupMessageReceipt: bindSnapshotSelector(feedback.source(binding)), useInput: bindSnapshotSelector(input),
    useSession: bindSnapshotSelector(session), useComposerBlock: bindSnapshotSelector(block),
    useAccess: () => true, interrupt, t: makeTranslate(zh) } as GroupMessageActionsProps
  return { runtime, reference, binding, connection, generation, feedback, chats, directory, input, session, interrupt, block, props }
}

describe('group admission feedback', () => {
  it('waits for durable acceptance, deduplicates one request and lets only the latest pending request publish', async () => {
    const b = await setup()
    const source = b.feedback.source(b.binding)
    const changed = vi.fn()
    const stop = source.subscribe(changed)
    onTestFinished(stop)
    render(<GroupMessageFeedback {...b.props} />)
    const first = b.feedback.submitting(request())
    expect(screen.queryByRole('status')).toBeNull()
    act(first)
    expect(screen.getByRole('status').textContent).toBe(zh['chat.messageQueued'])
    changed.mockClear()
    act(b.feedback.submitting(request()))
    expect(changed).not.toHaveBeenCalled()
    const second = b.feedback.submitting(request('two'))
    const third = b.feedback.submitting(request('three', 'steer'))
    act(second)
    expect(source.getSnapshot()).toBeNull()
    act(third)
    expect(source.getSnapshot()?.requestId).toBe('three')
    expect(screen.getByRole('status').textContent).toBe(zh['chat.messageAdjusted'])
  })

  it.each(['disconnect', 'generation', 'released', 'disposed'] as const)('does not publish an acknowledgement after %s', async (reason) => {
    const b = await setup()
    const accepted = b.feedback.submitting(request())
    if (reason === 'disconnect') b.connection.set('disconnected')
    if (reason === 'generation') b.generation.set({ id: 2, host: { home: '/synthetic-next' } })
    if (reason === 'released') b.reference.release()
    if (reason === 'disposed') b.feedback.dispose()
    accepted()
    expect(b.feedback.source(b.binding).getSnapshot()).toBeNull()
  })

  it('keeps two group bindings independent and does not acquire a Session or subscribe while hidden', async () => {
    const b = await setup()
    const secondId = 'second-root' as SessionId
    await b.runtime.sessions.add({ id: secondId })
    const second = b.runtime.sessions.retainFor(b.runtime.ctx, secondId)
    const binding = await second.ready
    const received = b.feedback.submitting(request())
    received()
    expect(b.feedback.source(binding).getSnapshot()).toBeNull()
    const view = render(<GroupMessageFeedback {...b.props} />)
    expect(screen.getByRole('status')).toBeTruthy()
    view.unmount()
    b.reference.release()
    expect(b.runtime.sessions.binding(root)).toBeUndefined()
    second.release()
  })

  it('localizes receipt, uses only actual current members, and preserves paused and unconfirmed guidance', async () => {
    const b = await setup()
    b.feedback.submitting(request())()
    const view = render(<GroupMessageFeedback {...b.props} />)
    const update = (value: TeamChat, runningBotIds: readonly BotId[] = []) => {
      act(() => { b.chats.set({ phase: 'ready', snapshot: { ...b.chats.getSnapshot().snapshot!, chats: [value],
        activities: [{ chatId: chat.id, processing: true, runningBotIds, pendingControl: null }] } }) })
    }
    update(chat, [writer.id, 'outsider' as BotId])
    expect(screen.getByText('当前由 Writer 处理。')).toBeTruthy()
    expect(screen.queryByText(/outsider/u)).toBeNull()
    update({ ...chat, status: 'paused', pauseReason: 'owner' })
    expect(screen.getByText(zh['chat.messagePaused'])).toBeTruthy()
    update({ ...chat, status: 'paused', pauseReason: 'unknown-result', error: { code: 'KATCATS_CHAT_OUTCOME_UNKNOWN', message: 'Unconfirmed' } })
    expect(screen.queryByText(zh['chat.messagePaused'])).toBeNull()
    expect(screen.getByText(zh['chat.messagePausedUnconfirmed'])).toBeTruthy()
    view.rerender(<GroupMessageFeedback {...b.props} t={makeTranslate(en)} />)
    expect(screen.getByRole('status').textContent).toBe(en['chat.messageQueued'])
    expect(screen.getByText(en['chat.messagePausedUnconfirmed'])).toBeTruthy()
    expect([screen.getByRole('status').textContent, screen.getByText(en['chat.messagePausedUnconfirmed']).textContent]).toMatchInlineSnapshot(`
      [
        "Received and added to the group message queue.",
        "This group is paused with an unconfirmed result. Inspect saved results before deciding what to do next.",
      ]
    `)
    act(() => { b.connection.set('disconnected') })
    expect(view.container.textContent).toBe('')
  })

  it('does not label retained failed directories, unrelated private chats or internal executors as accepted group input', async () => {
    const b = await setup()
    b.feedback.submitting(request())()
    const view = render(<GroupMessageFeedback {...b.props} />)
    act(() => { b.chats.set({ ...b.chats.getSnapshot(), phase: 'failed' }) })
    expect(screen.queryByRole('status')).toBeNull()
    act(() => { b.chats.set({ ...b.chats.getSnapshot(), phase: 'ready' }) })
    for (const sessionId of [writer.sessionId, chat.executors[0]!.sessionId]) {
      view.rerender(<GroupMessageFeedback {...b.props} sessionId={sessionId} />)
      expect(view.container.textContent).toBe('')
    }
  })
})

describe('explicit group interruption', () => {
  it('uses the supplied original-editor action without clearing or reconstructing mentions or attachments', async () => {
    const b = await setup()
    const content: InputState = { ...b.input.getSnapshot(), draft: '@Writer follow up', attachmentIds: ['file' as InputState['attachmentIds'][number]] }
    b.input.set(content)
    render(<GroupMessageActions {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['chat.interruptAndAdjust'] }))
    expect(b.interrupt).toHaveBeenCalledExactlyOnceWith()
    expect(b.input.getSnapshot()).toBe(content)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it.each(['empty', 'claim', 'submitting', 'command', 'opening', 'removed', 'disconnected', 'directory', 'access', 'blocked'] as const)(
    'refuses the explicit action while %s and leaves ordinary input untouched', async (reason) => {
      const b = await setup()
      if (reason === 'empty') b.input.set({ ...b.input.getSnapshot(), draft: '  ' })
      if (reason === 'claim') b.input.set({ ...b.input.getSnapshot(), phase: 'claimed' })
      if (reason === 'submitting') b.input.set({ ...b.input.getSnapshot(), phase: 'submitting' })
      if (reason === 'command') b.input.set({ ...b.input.getSnapshot(), draft: '/permission read-only' })
      if (reason === 'opening') b.session.set({ ...b.session.getSnapshot(), openState: 'loading' })
      if (reason === 'removed') b.session.set({ ...b.session.getSnapshot(), removed: true })
      if (reason === 'disconnected') b.connection.set('disconnected')
      if (reason === 'directory') b.chats.set({ ...b.chats.getSnapshot(), phase: 'loading' })
      if (reason === 'blocked') b.block.set({ reason: 'Synthetic unavailable model' })
      render(<GroupMessageActions {...b.props} {...reason === 'access' ? { useAccess: () => false } : {}} />)
      const button = screen.getByRole<HTMLButtonElement>('button', { name: zh['chat.interruptAndAdjust'] })
      expect(button.disabled).toBe(true)
      fireEvent.click(button)
      expect(b.interrupt).not.toHaveBeenCalled()
    },
  )

  it('leaves private Bots and hidden group executors with their original composer controls', async () => {
    const b = await setup()
    const view = render(<GroupMessageActions {...b.props} sessionId={writer.sessionId} />)
    expect(view.container.textContent).toBe('')
    view.rerender(<GroupMessageActions {...b.props} sessionId={chat.executors[0]!.sessionId} />)
    expect(view.container.textContent).toBe('')
  })
})
