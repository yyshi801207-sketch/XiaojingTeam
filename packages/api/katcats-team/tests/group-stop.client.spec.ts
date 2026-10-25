// @vitest-environment jsdom
/** Fixed group Escape targets a real member run while its container has no model turn. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { Shortcuts, ShortcutContext, ShortcutGesture } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { BotId, GroupId } from '../src/types.ts'
import type { ChatId, ChatRunId, TeamChat } from '../src/chats-types.ts'
import type { ChatView } from '../src/client/chat-model.ts'
import { installGroupStopShortcut } from '../src/client/group-stop-shortcut.ts'

const disposers: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const release of disposers.splice(0).reverse()) await release()
  document.body.replaceChildren()
})

async function bench() {
  const runtime = await SlotTestRuntime.create()
  disposers.push(() => runtime.dispose())
  await runtime.sessions.add({ id: 'group-container', snapshot: { running: false } })
  const reference = runtime.sessions.retain('group-container' as SessionId)
  await reference.ready
  const chat: TeamChat = { id: 'chat' as ChatId, groupId: 'chats' as GroupId, name: 'Group',
    rootSessionId: reference.sessionId, managerId: null, memberRoles: [], workDir: '/synthetic/group',
    memberIds: ['writer' as BotId], executors: [], status: 'active', pauseReason: null, error: null,
    generation: 2, relayLimit: 6, run: { id: 'run' as ChatRunId, generation: 2, relayCount: 1 } }
  const chats = createSnapshotStore<ChatView>({ phase: 'ready', snapshot: { revision: 1,
    chats: [chat], deliveries: [], relayLimit: 6,
    activities: [{ chatId: chat.id, processing: true, runningBotIds: ['writer' as BotId], pendingControl: null }] } })
  let listener: Parameters<Shortcuts['observeFixedInput']>[0] | undefined
  const shortcuts: Pick<Shortcuts, 'observeFixedInput' | 'stopSequenceMs'> = { stopSequenceMs: 500,
    observeFixedInput: callback => { listener = callback; return () => { listener = undefined } } }
  const cancel = vi.fn(async (_id: SessionId) => {})
  const failed = vi.fn()
  const dispose = installGroupStopShortcut(shortcuts, runtime.sessions, chats, runtime.ctx.uiSession, cancel, failed)
  disposers.push(dispose)
  const root = document.createElement('div')
  root.dataset.conversationSession = reference.sessionId
  root.dataset.conversationRegion = 'chat'
  const composer = document.createElement('div')
  composer.dataset.conversationRegion = 'composer'
  const input = document.createElement('textarea')
  composer.append(input)
  root.append(composer)
  document.body.append(root)
  const press = (gesture: Partial<ShortcutGesture> = {}, target: Element = input, context: Partial<ShortcutContext> = {}) => {
    const consume = vi.fn()
    listener?.({ type: 'keydown', gesture: { code: 'Escape', control: false, alt: false, shift: false,
      meta: false, repeat: false, composing: false, defaultPrevented: false, ...gesture },
    context: { region: 'editable', modal: null, target, ...context }, consume })
    return consume
  }
  return { runtime, reference, chat, chats, root, composer, input, cancel, failed, dispose, press,
    reset: () => { listener?.({ type: 'reset' }) } }
}

describe('group-container stop input', () => {
  it('stops actual member work with two Escapes without inventing a container turn', async () => {
    const b = await bench()
    expect(b.reference.binding.session.getSnapshot().running).toBe(false)
    expect(b.reference.binding.eventSource.getSnapshot().entries).toHaveLength(0)
    expect(b.press()).toHaveBeenCalledTimes(1)
    expect(b.cancel).not.toHaveBeenCalled()
    b.press()
    expect(b.cancel).toHaveBeenCalledExactlyOnceWith(b.reference.sessionId)
  })

  it('does not combine gestures owned by composition, modifiers, modals, approvals or another view', async () => {
    const b = await bench()
    for (const field of ['repeat', 'composing', 'defaultPrevented', 'control', 'alt', 'shift', 'meta'] as const) {
      b.press()
      expect(b.press({ [field]: true })).not.toHaveBeenCalled()
      b.press()
      expect(b.cancel).not.toHaveBeenCalled()
      b.reset()
    }
    for (const invalidate of [() => b.press({}, b.input, { modal: 'settings' }),
      () => b.press({}, b.input, { region: 'terminal' }), () => b.press({}, b.root),
      () => b.press({}, document.body), () => b.press({ code: 'KeyA' })]) {
      b.press(); invalidate(); b.press()
      expect(b.cancel).not.toHaveBeenCalled()
      b.reset()
    }
    const approval = document.createElement('div')
    approval.dataset.katcatsApproval = 'original-worker-request'
    const button = document.createElement('button')
    approval.append(button); b.composer.append(approval)
    expect(b.press({}, button)).not.toHaveBeenCalled()
    b.root.dataset.conversationSession = 'private-bot'
    expect(b.press()).not.toHaveBeenCalled()
  })

  it('resets the first press when the run generation changes or activity stops', async () => {
    const b = await bench()
    b.press()
    b.chats.set({ ...b.chats.getSnapshot(), snapshot: { ...b.chats.getSnapshot().snapshot!,
      chats: [{ ...b.chat, generation: 3, run: { id: 'new-run' as ChatRunId, generation: 3, relayCount: 0 } }] } })
    b.press()
    expect(b.cancel).not.toHaveBeenCalled()
    b.chats.set({ ...b.chats.getSnapshot(), snapshot: { ...b.chats.getSnapshot().snapshot!, activities: [] } })
    expect(b.press()).not.toHaveBeenCalled()
    expect(b.cancel).not.toHaveBeenCalled()
  })

  it('does not duplicate a pending stop and awaits cancellation before teardown finishes', async () => {
    const b = await bench()
    const gate = Promise.withResolvers<void>()
    disposers.push(() => { gate.resolve() })
    b.cancel.mockImplementation(() => gate.promise)
    b.press(); b.press()
    expect(b.press()).not.toHaveBeenCalled()
    expect(b.cancel).toHaveBeenCalledTimes(1)
    const closing = b.dispose()
    expect(b.press()).not.toHaveBeenCalled()
    gate.resolve()
    await closing
  })

  it('reports a failed stop without changing another group status', async () => {
    const b = await bench()
    b.cancel.mockRejectedValueOnce(new Error('Remote unavailable'))
    const before = b.chats.getSnapshot()
    b.press(); b.press()
    await expect.poll(() => b.failed.mock.calls.length).toBe(1)
    expect(b.chats.getSnapshot()).toBe(before)
  })
})
