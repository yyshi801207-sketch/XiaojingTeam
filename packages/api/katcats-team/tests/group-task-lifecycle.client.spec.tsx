// @vitest-environment jsdom
/** Durable handoffs render in the original group timeline without interpreting generated text. */
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ConversationNodeDefinition, ConversationViewDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode, ChatNode, ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import { makeTranslate, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { MarkdownDelegateProvider } from '@deepseek-ai/dsh-client-ui-primitives'
import { messageDefinition } from '../../../client/ui-chat/src/client/conversation-nodes/message.ts'
import { chatViewDefinition } from '../../../client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { processGroupDefinition } from '../../../client/ui-chat/src/client/conversation-nodes/process-groups.ts'
import { turnProcessDefinition } from '../../../client/ui-chat/src/client/conversation-nodes/turn-process.ts'
import type { BotId } from '../src/types.ts'
import type { ChatDeliveryId, ChatId, ChatRunId } from '../src/chats-types.ts'
import type { ChatTaskEventId, ChatTaskLifecycle, ChatTaskStatus } from '../src/chats-task-events.ts'
import { chatTaskLifecycleDefinition } from '../src/client/chat-task-lifecycle.ts'
import { chatRelayDefinition } from '../src/client/chat-relay.ts'
import { GroupTaskLifecycle } from '../src/client/GroupTaskLifecycle.tsx'
import type { GroupTaskLifecycleProps } from '../src/client/GroupTaskLifecycle.tsx'
import { ChatRelayMessage, type ChatRelayMessageProps } from '../src/client/ChatRelayMessage.tsx'
import { zh } from '../src/client/locales.ts'
import { taskEn, taskZh, type TaskKey } from '../src/client/task-locales.ts'
import { presentationDirectory } from './group-presentation-fixture.client.ts'
import { ChatClientModel, type ChatRemote } from '../src/client/chat-model.ts'

afterEach(cleanup)
const { useGroupDirectory } = presentationDirectory()

const task: ChatTaskLifecycle = {
  schemaVersion: 1, eventId: 'delivery:queued' as ChatTaskEventId, chatId: 'editorial' as ChatId,
  rootSessionId: 'editorial-root' as SessionId, runId: 'run-1' as ChatRunId, generation: 1,
  deliveryId: 'delivery' as ChatDeliveryId, parentDeliveryId: null,
  actor: { kind: 'owner' },
  target: { kind: 'member', botId: 'writer' as BotId, sender: {
    botId: 'writer' as BotId, name: 'Writer', role: 'Writes the final article', avatar: { shape: 'round', color: '#2288FF' },
  } },
  message: 'Write a final article and save it as delivery.md.\nUse only the verified sources.', status: 'queued',
  recovered: false, error: null,
}

function entry(seq: number, type: string, data: object): SessionLiveEventEntry {
  return { type: 'event', event: { seq, time: 1_700_000_000_000 + seq, type, data,
    ...type === 'katcats/group-task-lifecycle' ? { ignorable: true } : {},
    ...type === 'user/message' ? { surfaceOp: 'append' } : {},
  } as SessionEvent }
}

function stage(seq: number, status: ChatTaskStatus, patch: Partial<ChatTaskLifecycle> = {}): SessionLiveEventEntry {
  const deliveryId = patch.deliveryId ?? task.deliveryId
  return entry(seq, 'katcats/group-task-lifecycle', {
    ...task, ...patch, eventId: `${deliveryId}:${status}` as ChatTaskEventId, status,
  })
}

function engine() {
  const definitions = { entries: (): readonly ConversationNodeDefinition[] => [
    messageDefinition, chatTaskLifecycleDefinition, chatRelayDefinition, turnProcessDefinition,
  ], fallbackEntry: () => undefined }
  const views = { entries: (): readonly ConversationViewDefinition[] => [chatViewDefinition] }
  const groups = { entries: () => [processGroupDefinition],
    forTarget: (target: string) => target === 'chat' ? processGroupDefinition : undefined }
  const assembler = new ConversationNodeAssembler(definitions, views, groups)
  assembler.activateTarget('chat')
  return assembler
}

function snapshot(assembler: ConversationNodeAssembler): ChatSnapshot {
  assembler.activateTarget('chat')
  assembler.flush()
  const value = assembler.snapshot('chat') as ChatSnapshot | undefined
  if (value === undefined) throw new Error('Synthetic Chat view is not registered')
  return value
}

function taskNodes(assembler: ConversationNodeAssembler): ChatNode<'katcats-task'>[] {
  return [...snapshot(assembler).nodes.values()].filter((node: ChatConversationViewNode): node is ChatNode<'katcats-task'> =>
    node.kind === 'katcats-task')
}

function renderTask(node: ChatNode<'katcats-task'>, locale: Record<TaskKey, string> = taskZh, sessionId = task.rootSessionId) {
  const props = { node, sessionId, useGroupDirectory, t: makeTranslate(locale) } as GroupTaskLifecycleProps
  return { props, view: render(<GroupTaskLifecycle {...props} />) }
}

describe('group task event projection', () => {
  it('aggregates a real delivery while preserving its first chat position and all observed stages', () => {
    const assembler = engine()
    assembler.replaceWindow([stage(1, 'queued')], false)
    const first = taskNodes(assembler)[0]!
    assembler.append(stage(2, 'started'))
    assembler.append(stage(3, 'completed'))
    const nodes = taskNodes(assembler)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]!.key).toBe(first.key)
    expect(nodes[0]!.anchorSeq).toBe(1)
    expect(nodes[0]!.data).toMatchObject({ task: { status: 'completed', deliveryId: 'delivery' } })
    expect(nodes[0]!.data.stages.map(item => item.status)).toMatchInlineSnapshot(`
      [
        "queued",
        "started",
        "completed",
      ]
    `)
    expect(snapshot(assembler).timeline.turnOrder).toEqual([])
  })

  it('replays durable history to the same task records and deduplicates repeated event identities', () => {
    const records = [stage(1, 'queued'), stage(2, 'started'), stage(3, 'completed'), stage(4, 'queued')]
    const live = engine()
    live.replaceWindow(records.slice(0, 2), false)
    live.append(records[2]!)
    live.append(records[3]!)
    const cold = engine()
    cold.replaceWindow(records, false)
    expect(taskNodes(cold)).toEqual(taskNodes(live))
    expect(taskNodes(live)[0]!.data.task.status).toBe('completed')
    expect(taskNodes(live)[0]!.data.stages).toHaveLength(3)
  })

  it('shows only loaded stages when the earlier task history is outside the window and merges prepended history', () => {
    const assembler = engine()
    assembler.replaceWindow([stage(3, 'completed')], true)
    expect(taskNodes(assembler)[0]!.data.stages.map(item => item.status)).toEqual(['completed'])
    assembler.prepend([stage(1, 'queued'), stage(2, 'started')], false)
    const node = taskNodes(assembler)[0]!
    expect(node.anchorSeq).toBe(1)
    expect(node.data.stages.map(item => item.status)).toEqual(['queued', 'started', 'completed'])
  })

  it('keeps owner dispatch and member-to-member handoffs as separate deliveries', () => {
    const assembler = engine()
    assembler.replaceWindow([stage(1, 'queued'), stage(2, 'started'), stage(3, 'queued', {
      deliveryId: 'review-delivery' as ChatDeliveryId, parentDeliveryId: task.deliveryId, actor: task.target,
      target: { ...task.target, botId: 'reviewer' as BotId, sender: task.target.sender === null ? null
        : { ...task.target.sender, botId: 'reviewer' as BotId, name: 'Reviewer' } }, message: 'Verify the final article.',
    })], false)
    const nodes = taskNodes(assembler)
    expect(nodes.map(node => [node.data.task.deliveryId, node.data.task.actor.kind, node.data.task.target.sender?.name]))
      .toMatchInlineSnapshot(`
        [
          [
            "delivery",
            "owner",
            "Writer",
          ],
          [
            "review-delivery",
            "member",
            "Reviewer",
          ],
        ]
      `)
    expect(nodes[1]!.data.task.parentDeliveryId).toBe(task.deliveryId)
  })

  it('does not turn generated delegation claims or private user messages into task records', () => {
    const assembler = engine()
    assembler.replaceWindow([
      entry(1, 'user/message', { id: 'private-message', role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: 'I assigned a task to Writer. 已派给 Writer。' }] }),
    ], false)
    expect(taskNodes(assembler)).toHaveLength(0)
    expect(chatTaskLifecycleDefinition.match({ type: 'assistant/attempt', seq: 2, time: 2, data: {} } as SessionEvent)).toBeNull()
  })

  it('keeps task records outside closed model Turn and tool disclosures', () => {
    const assembler = engine()
    assembler.replaceWindow([
      entry(1, 'turn/start', { turn: 1 }), entry(2, 'step/start', { turn: 1, step: 1 }),
      entry(3, 'tool/call', { turn: 1, step: 1, callId: 'delegate', name: 'delegate_to_bot', args: {} }),
      stage(4, 'queued'), stage(5, 'started'), stage(6, 'completed'),
      entry(7, 'step/end', { turn: 1, step: 1 }), entry(8, 'turn/end', { turn: 1 }),
    ], false)
    const node = taskNodes(assembler)[0]!
    expect(node.groupTree).toBe('turn')
    expect(assembler.grouped('chat')?.entries).toContainEqual({ kind: 'node', key: node.key })
  })

  it('keeps groups, runs and generations separate even if delivery IDs collide', () => {
    const assembler = engine()
    assembler.replaceWindow([stage(1, 'queued'),
      stage(2, 'queued', { chatId: 'other' as ChatId, rootSessionId: 'other-root' as SessionId }),
      stage(3, 'queued', { runId: 'run-2' as ChatRunId }), stage(4, 'queued', { generation: 2 }),
    ], false)
    expect(taskNodes(assembler)).toHaveLength(4)
    expect(new Set(taskNodes(assembler).map(node => node.key)).size).toBe(4)
  })

  it('keeps the real member reply as its own chat bubble after the task handoff record', () => {
    if (task.target.sender === null) throw new Error('Synthetic target identity missing')
    const reply: UserMessage = { id: 'actual-member-reply' as MessageId, role: 'user',
      content: [{ type: 'text', text: 'Final article saved: [delivery.md](./delivery.md)' }],
      source: { kind: 'katcats-group-relay', form: 'relay', schemaVersion: 1, chatId: task.chatId,
        runId: task.runId, generation: task.generation, deliveryId: task.deliveryId, sender: task.target.sender,
        executionSessionId: 'group-writer' as SessionId, inputMessageId: 'worker-input' as MessageId,
        outputMessageId: 'worker-output' as MessageId } }
    const assembler = engine()
    assembler.replaceWindow([stage(1, 'queued'), stage(2, 'started'),
      entry(3, 'user/message', reply), stage(4, 'completed')], false)
    const nodes = [...snapshot(assembler).nodes.values()]
    expect(nodes.map(node => node.kind)).toEqual(['katcats-task', 'katcats-relay'])
    expect(taskNodes(assembler)[0]!.data.task.message).toBe(task.message)
    expect(nodes.find(node => node.kind === 'katcats-relay')?.data).toMatchObject({
      text: 'Final article saved: [delivery.md](./delivery.md)', source: { sender: { name: 'Writer' } },
    })
    expect(assembler.grouped('chat')?.entries.filter(item => item.kind === 'node')).toHaveLength(2)
  })
})

describe('group task record', () => {
  it('updates historical and later task cards through real keyed Slots after an acknowledged directory save', async () => {
    const runtime = await SlotTestRuntime.create()
    onTestFinished(() => runtime.dispose())
    const locale = new LocaleRuntime(runtime.ctx)
    locale.setLocale('zh')
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    runtime.ctx.effect(() => locale.register('katcats.team', { zh, en: zh }))
    runtime.ctx.effect(() => locale.register('katcats.tasks', { zh: taskZh, en: taskEn }))
    let saved = presentationDirectory().source.getSnapshot().snapshot!
    const unused = async (): Promise<never> => { throw new Error('Unexpected synthetic group operation') }
    const remote: ChatRemote = {
      sendMessage: unused, cancelSession: unused, snapshot: async () => ({ ok: true, value: saved }),
      async *follow() { yield { type: 'snapshot', value: saved } },
      createChat: unused, deleteChat: unused, pause: unused, resume: unused, stop: unused,
      updateChat: async (request) => {
        const chat = { ...saved.chats[0]!, showHandoffRecords: request.showHandoffRecords !== false }
        saved = { ...saved, revision: saved.revision + 1, chats: [chat] }
        return { ok: true, value: { chat, snapshot: saved } }
      },
    }
    const model = new ChatClientModel(remote)
    onTestFinished(() => { model.dispose() })
    model.replace(saved)
    await runtime.sessions.add({ id: task.rootSessionId })
    const reference = runtime.sessions.retainFor(runtime.ctx, task.rootSessionId)
    await reference.ready
    const assembler = engine()
    if (task.target.sender === null) throw new Error('Synthetic sender missing')
    assembler.replaceWindow([stage(1, 'queued', { actor: task.target }), entry(2, 'user/message', {
      id: 'slot-member-reply' as MessageId, role: 'user', content: [{ type: 'text', text: 'Actual member reply stays visible.' }],
      source: { kind: 'katcats-group-relay', form: 'relay', schemaVersion: 1, chatId: task.chatId,
        runId: task.runId, generation: task.generation, deliveryId: task.deliveryId, sender: task.target.sender,
        executionSessionId: 'slot-worker' as SessionId, inputMessageId: 'slot-worker-input' as MessageId,
        outputMessageId: 'slot-worker-output' as MessageId },
    })], false)
    let refresh = (): void => {}
    const owner = { openFile: vi.fn(), inspectCall: undefined, forkAt: vi.fn(),
      loadImage: async () => '', fileMentions: () => undefined }
    const context = { turnData: undefined, disclosureReset: createSnapshotStore(0),
      useGroupAction: () => { throw new Error('Synthetic task renderer does not need group action') } }
    const unusedHook = (): never => { throw new Error('Product task nodes do not consume the base Chat hooks') }
    const isTask = (node: ChatConversationViewNode): node is ChatNode<'katcats-task'> => node.kind === 'katcats-task'
    const isReply = (node: ChatConversationViewNode): node is ChatNode<'katcats-relay'> => node.kind === 'katcats-relay'
    type RootProps = PropsRuntime<'root'> & PropsRenderSlots<'conversation.chat.node'>
    await runtime.root.declare({ 'conversation.chat.node': { kind: 'keyed', scope: 'session',
      inject: { hooks: { turnData: () => unusedHook, disclosure: () => unusedHook, groupAction: () => unusedHook } } } },
    ({ renderSlot, SessionProvider }: RootProps) => {
      const [, setRevision] = useState(0)
      refresh = () => { setRevision(value => value + 1) }
      return <SessionProvider session={reference}>{[...snapshot(assembler).nodes.values()].map(node =>
        isTask(node) ? renderSlot('conversation.chat.node', { ...owner, node },
          { entryKey: 'katcats-task', hookContext: context })
          : isReply(node) ? renderSlot('conversation.chat.node', { ...owner, node },
            { entryKey: 'katcats-relay', hookContext: context }) : null)}</SessionProvider>
    })
    runtime.slots.register({ name: 'conversation.chat.node', key: 'katcats-task', locale: 'katcats.tasks',
      inject: () => ({ hooks: { groupDirectory: model.state } }) }, GroupTaskLifecycle)
    runtime.slots.register({ name: 'conversation.chat.node', key: 'katcats-relay', locale: 'katcats.team',
      children: { 'katcats.group.delivered-files': { kind: 'single', scope: 'session' } },
      inject: () => ({ hooks: { groupDirectory: model.state }, copyRelayText: vi.fn(), openRelayMember: vi.fn() }) }, ChatRelayMessage)
    let view = runtime.renderRoot()
    const visible = () => ({ handoffs: view.container.querySelectorAll('[data-katcats-handoff]').length,
      records: view.container.querySelectorAll('[data-katcats-task]').length,
      replies: view.container.querySelectorAll('[data-katcats-relay]').length })
    expect(visible()).toEqual({ handoffs: 1, records: 1, replies: 1 })
    await act(async () => { await model.update({ id: task.chatId, showHandoffRecords: false }) })
    expect(visible()).toEqual({ handoffs: 0, records: 0, replies: 1 })
    act(() => {
      assembler.append(stage(3, 'completed', { actor: task.target }))
      assembler.append(stage(4, 'queued', { actor: task.target, deliveryId: 'slot-next-delivery' as ChatDeliveryId }))
      refresh()
    })
    expect(visible()).toEqual({ handoffs: 0, records: 0, replies: 1 })
    view.unmount()
    view = runtime.renderRoot()
    expect(visible()).toEqual({ handoffs: 0, records: 0, replies: 1 })
    await act(async () => { await model.update({ id: task.chatId, showHandoffRecords: true }) })
    expect(visible()).toEqual({ handoffs: 2, records: 2, replies: 1 })
    expect(view.container.querySelector('[data-katcats-message-body]')?.textContent).toBe('Actual member reply stays visible.')
    expect(taskNodes(assembler)[0]!.data.stages.map(value => value.status)).toEqual(['queued', 'completed'])
  })

  it('hides existing and new handoff cards while retaining actual replies and restores all recorded stages', () => {
    if (task.target.sender === null) throw new Error('Synthetic sender missing')
    const assembler = engine()
    const patch = { actor: task.target }
    const reply: UserMessage = { id: 'visible-member-reply' as MessageId, role: 'user',
      content: [{ type: 'text', text: 'The actual member reply stays visible.' }],
      source: { kind: 'katcats-group-relay', form: 'relay', schemaVersion: 1, chatId: task.chatId,
        runId: task.runId, generation: task.generation, deliveryId: task.deliveryId, sender: task.target.sender,
        executionSessionId: 'writer-worker' as SessionId, inputMessageId: 'worker-input' as MessageId,
        outputMessageId: 'worker-output' as MessageId } }
    assembler.replaceWindow([stage(1, 'queued', patch), stage(2, 'started', patch), entry(3, 'user/message', reply)], false)
    const directory = presentationDirectory()
    const draw = () => <>{[...snapshot(assembler).nodes.values()].map(node => node.kind === 'katcats-task'
      ? <GroupTaskLifecycle key={node.key} {...{ node, sessionId: task.rootSessionId,
        useGroupDirectory: directory.useGroupDirectory, t: makeTranslate(taskZh) } as GroupTaskLifecycleProps} />
      : node.kind === 'katcats-relay' ? <ChatRelayMessage key={node.key} {...{ node, sessionId: task.rootSessionId,
        useGroupDirectory: directory.useGroupDirectory, copyRelayText: vi.fn(), openRelayMember: vi.fn(), renderSlot: () => null,
        t: makeTranslate(zh) } as ChatRelayMessageProps} /> : null)}</>
    const view = render(draw())
    const visible = () => ({ handoffs: view.container.querySelectorAll('[data-katcats-handoff]').length,
      records: view.container.querySelectorAll('[data-katcats-task]').length,
      replies: view.container.querySelectorAll('[data-katcats-relay]').length,
      reply: view.container.querySelector('[data-katcats-message-body]')?.textContent,
    })
    const before = visible()
    const saved = directory.source.getSnapshot().snapshot!
    act(() => { directory.source.set({ phase: 'ready', snapshot: { ...saved,
      chats: [{ ...directory.chat, showHandoffRecords: false }] } }) })
    const hidden = visible()
    assembler.append(stage(4, 'completed', patch))
    assembler.append(stage(5, 'queued', { ...patch, deliveryId: 'later-handoff' as ChatDeliveryId }))
    view.rerender(draw())
    const stillHidden = visible()
    expect(taskNodes(assembler)).toHaveLength(2)
    expect(taskNodes(assembler)[0]!.data.stages.map(value => value.status)).toEqual(['queued', 'started', 'completed'])
    act(() => { directory.source.set({ phase: 'ready', snapshot: { ...saved,
      chats: [{ ...directory.chat, showHandoffRecords: true }] } }) })
    expect({ before, hidden, stillHidden, reopened: visible() }).toMatchInlineSnapshot(`
      {
        "before": {
          "handoffs": 1,
          "records": 1,
          "replies": 1,
          "reply": "The actual member reply stays visible.",
        },
        "hidden": {
          "handoffs": 0,
          "records": 0,
          "replies": 1,
          "reply": "The actual member reply stays visible.",
        },
        "reopened": {
          "handoffs": 2,
          "records": 2,
          "replies": 1,
          "reply": "The actual member reply stays visible.",
        },
        "stillHidden": {
          "handoffs": 0,
          "records": 0,
          "replies": 1,
          "reply": "The actual member reply stays visible.",
        },
      }
    `)
  })

  it('keeps another group visible and retains the exact saved display preference during reconnects', () => {
    const assembler = engine()
    assembler.replaceWindow([stage(1, 'queued', { actor: task.target })], false)
    const directory = presentationDirectory({ showHandoffRecords: false })
    const props = { node: taskNodes(assembler)[0]!, sessionId: task.rootSessionId,
      useGroupDirectory: directory.useGroupDirectory, t: makeTranslate(taskZh) } as GroupTaskLifecycleProps
    const view = render(<GroupTaskLifecycle {...props} />)
    expect(view.container.querySelector('[data-katcats-task]')).toBeNull()
    const saved = directory.source.getSnapshot().snapshot!
    act(() => { directory.source.set({ phase: 'failed', snapshot: saved }) })
    expect(view.container.querySelector('[data-katcats-task]')).toBeNull()
    const otherId = 'other-group' as ChatId
    const otherRoot = 'other-root' as SessionId
    const node = { ...props.node, data: { ...props.node.data,
      task: { ...props.node.data.task, chatId: otherId, rootSessionId: otherRoot } } }
    act(() => { directory.source.set({ phase: 'ready', snapshot: { ...saved,
      chats: [...saved.chats, { ...directory.chat, id: otherId, rootSessionId: otherRoot, showHandoffRecords: true }] } }) })
    view.rerender(<GroupTaskLifecycle {...props} node={node} sessionId={otherRoot} />)
    expect(view.container.querySelector('[data-katcats-task]')).not.toBeNull()
    view.rerender(<GroupTaskLifecycle {...props} node={node} sessionId={'private-session' as SessionId} />)
    expect(view.container.querySelector('[data-katcats-task]')).toBeNull()
  })

  it('marks the current manager in a handoff and both task identities without changing the captured names or message', () => {
    const assembler = engine()
    assembler.replaceWindow([stage(1, 'queued', { actor: task.target,
      target: { ...task.target, botId: 'reviewer' as BotId,
        sender: task.target.sender === null ? null : { ...task.target.sender, botId: 'reviewer' as BotId, name: 'Reviewer' } } })], false)
    const directory = presentationDirectory({ managerId: 'writer' as BotId })
    const props = { node: taskNodes(assembler)[0]!, sessionId: task.rootSessionId,
      useGroupDirectory: directory.useGroupDirectory, t: makeTranslate(taskZh) } as GroupTaskLifecycleProps
    const view = render(<GroupTaskLifecycle {...props} />)
    expect(view.container.querySelectorAll('[data-katcats-manager-avatar="writer"]')).toHaveLength(2)
    expect(view.container.querySelectorAll('[data-katcats-manager-avatar="reviewer"]')).toHaveLength(0)
    expect(screen.getByRole('region', { name: 'Writer交给Reviewer的内容' })).toBeTruthy()
    const saved = directory.source.getSnapshot().snapshot!
    act(() => { directory.source.set({ phase: 'ready', snapshot: { ...saved,
      chats: [{ ...directory.chat, managerId: 'reviewer' as BotId }] } }) })
    expect(view.container.querySelectorAll('[data-katcats-manager-avatar="writer"]')).toHaveLength(0)
    expect(view.container.querySelectorAll('[data-katcats-manager-avatar="reviewer"]')).toHaveLength(1)
    expect(props.node.data.task.message).toBe(task.message)
    act(() => { directory.source.set({ phase: 'failed', snapshot: saved }) })
    expect(view.container.querySelectorAll('[data-katcats-manager-avatar]')).toHaveLength(0)
  })

  it('shows recorded participants, full task instructions and visible stage progression', () => {
    const assembler = engine()
    assembler.replaceWindow([stage(1, 'queued'), stage(2, 'started'), stage(3, 'completed')], false)
    const { view } = renderTask(taskNodes(assembler)[0]!)
    const record = screen.getByRole('article', { name: '你交给Writer的群任务' })
    expect(within(record).getAllByRole('listitem').map(item => item.querySelector('span')?.textContent))
      .toMatchInlineSnapshot(`
        [
          "已排队",
          "已开始",
          "已完成",
        ]
      `)
    expect(record.querySelector('svg')?.style.getPropertyValue('--katcats-avatar-color')).toBe('#2288FF')
    const details = record.querySelector('details')!
    expect(details.open).toBe(false)
    fireEvent.click(details.querySelector('summary')!)
    expect(details.open).toBe(true)
    expect(details.querySelector('p')?.textContent).toBe(task.message)
    expect(record.querySelectorAll('time')).toHaveLength(3)
    expect(view.container.querySelector('time')?.dateTime).toBe(new Date(1_700_000_000_001).toISOString())
    expect(record.getAttribute('data-state')).toBe('completed')
  })

  it('shows actual member-to-member allocation without inventing a coordinator', () => {
    const assembler = engine()
    assembler.replaceWindow([stage(1, 'queued', { actor: task.target,
      target: { ...task.target, botId: 'reviewer' as BotId,
        sender: task.target.sender === null ? null : { ...task.target.sender, name: 'Reviewer' } } })], false)
    const { view } = renderTask(taskNodes(assembler)[0]!)
    expect(screen.getByRole('article', { name: 'Writer交给Reviewer的群任务' })).toBeTruthy()
    expect(view.container.querySelectorAll('svg')).toHaveLength(3)
    expect(view.container.textContent).not.toContain('协调')
  })

  it('shows the complete persisted member handoff as Markdown by default while the independent task is still queued', () => {
    const assembler = engine()
    const text = '# 待复核稿件\n\n完整正文的开头。\n\n' + '这是已经交给同事的实际稿件段落。\n\n'.repeat(20)
      + '**完整正文的末尾 HANDOFF_END_817**\n\n| 项目 | 结论 |\n| --- | --- |\n| 范围 | 待核对 |\n\n```ts\nconst draft = "not-yet-reviewed"\n```'
    assembler.replaceWindow([stage(1, 'queued', { actor: task.target, message: text,
      target: { ...task.target, sender: task.target.sender === null ? null : { ...task.target.sender, name: 'Reviewer' } } })], false)
    const { view } = renderTask(taskNodes(assembler)[0]!)
    const handoff = screen.getByRole('region', { name: 'Writer交给Reviewer的内容' })
    expect(handoff.querySelector('details')?.open).toBe(true)
    expect(within(handoff).getByRole('heading', { name: '待复核稿件' })).toBeTruthy()
    expect(within(handoff).getByText('完整正文的末尾 HANDOFF_END_817')).toBeTruthy()
    expect(within(handoff).getByRole('table')).toBeTruthy()
    expect(handoff.querySelector('pre code')?.textContent).toContain('not-yet-reviewed')
    expect(within(handoff).getByText('交接记录')).toBeTruthy()
    const record = screen.getByRole('article', { name: 'Writer交给Reviewer的群任务' })
    expect(record.getAttribute('data-state')).toBe('queued')
    expect(record.textContent).not.toContain('HANDOFF_END_817')
    expect(view.container.querySelector('[data-katcats-relay]')).toBeNull()
    expect(view.container.textContent).not.toContain(taskZh['state.completed'])
    expect({ defaultOpen: handoff.querySelector('details')?.open,
      heading: handoff.querySelector('h1')?.textContent, tail: handoff.querySelector('strong:last-child')?.textContent,
      table: handoff.querySelector('table')?.textContent, source: within(handoff).getByText('交接记录').textContent,
      actualState: record.getAttribute('data-state'), artificialSpeech: view.container.querySelector('[data-katcats-relay]') !== null,
    }).toMatchInlineSnapshot(`
      {
        "actualState": "queued",
        "artificialSpeech": false,
        "defaultOpen": true,
        "heading": "待复核稿件",
        "source": "交接记录",
        "table": "项目结论范围待核对",
        "tail": "完整正文的末尾 HANDOFF_END_817",
      }
    `)
  })

  it('uses the enclosing Session file delegate for handoff links and releases a replaced opener', () => {
    const assembler = engine()
    assembler.replaceWindow([stage(1, 'started', { actor: task.target,
      message: '[稿件](./handoff-draft.md#L7-L9) and [绝对路径](E:/Projects/Katcats.AI/run/tmp/synthetic/handoff-draft.md)' })], false)
    const props = { node: taskNodes(assembler)[0]!, sessionId: task.rootSessionId, useGroupDirectory,
      t: makeTranslate(taskZh) } as GroupTaskLifecycleProps
    const open = vi.fn<(path: string, options?: { line?: number }) => void>()
    const view = render(<MarkdownDelegateProvider openFile={open}><GroupTaskLifecycle {...props} /></MarkdownDelegateProvider>)
    fireEvent.click(screen.getByRole('button', { name: '稿件' }))
    expect(open).toHaveBeenCalledExactlyOnceWith('./handoff-draft.md', { line: 7 })
    fireEvent.click(screen.getByRole('button', { name: '绝对路径' }))
    expect(open).toHaveBeenLastCalledWith('E:/Projects/Katcats.AI/run/tmp/synthetic/handoff-draft.md', undefined)
    const replacement = vi.fn<(path: string, options?: { line?: number }) => void>()
    view.rerender(<MarkdownDelegateProvider openFile={replacement}><GroupTaskLifecycle {...props} /></MarkdownDelegateProvider>)
    fireEvent.click(screen.getByRole('button', { name: '稿件' }))
    expect(replacement).toHaveBeenCalledExactlyOnceWith('./handoff-draft.md', { line: 7 })
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('keeps a reader-collapsed handoff collapsed across real lifecycle updates and restores full text on demand', () => {
    const assembler = engine()
    assembler.replaceWindow([stage(1, 'queued', { actor: task.target, message: '完整交接正文 HANDOFF_REOPEN_628' })], false)
    const { props, view } = renderTask(taskNodes(assembler)[0]!)
    const details = view.container.querySelector('details')!
    expect(details.open).toBe(true)
    fireEvent.click(details.querySelector('summary')!)
    expect(details.open).toBe(false)
    assembler.append(stage(2, 'started', { actor: task.target, message: '完整交接正文 HANDOFF_REOPEN_628' }))
    view.rerender(<GroupTaskLifecycle {...props} node={taskNodes(assembler)[0]!} />)
    expect(details.open).toBe(false)
    fireEvent.click(details.querySelector('summary')!)
    expect(details.open).toBe(true)
    expect(within(details).getByText('完整交接正文 HANDOFF_REOPEN_628')).toBeTruthy()
  })

  it('does not repeat owner input as a member handoff, and hides member handoffs outside their exact transcript', () => {
    const assembler = engine()
    assembler.replaceWindow([stage(1, 'queued')], false)
    const { props, view } = renderTask(taskNodes(assembler)[0]!)
    expect(view.container.querySelector('[data-katcats-handoff]')).toBeNull()
    assembler.append(stage(2, 'queued', { deliveryId: 'member-handoff' as ChatDeliveryId, actor: task.target }))
    const member = taskNodes(assembler)[1]!
    view.rerender(<GroupTaskLifecycle {...props} node={member} sessionId={'private-session' as SessionId} />)
    expect(view.container.textContent).toBe('')
    view.rerender(<GroupTaskLifecycle {...props} node={member} />)
    expect(view.container.querySelectorAll('[data-katcats-handoff]')).toHaveLength(1)
  })

  it('localizes the handoff source and keeps embedded HTML inactive through the standard Markdown renderer', () => {
    const assembler = engine()
    assembler.replaceWindow([stage(1, 'queued', { actor: task.target,
      message: 'Actual handoff\n\n<img src=x onerror=alert(1)>\n<script>secret()</script>' })], false)
    const { view } = renderTask(taskNodes(assembler)[0]!, taskEn)
    expect(screen.getByRole('region', { name: 'Content handed from Writer to Writer' })).toBeTruthy()
    expect(screen.getByText('Handoff record')).toBeTruthy()
    expect(view.container.querySelector('script,img,[onerror]')).toBeNull()
  })

  it('labels restored stages instead of presenting recovery-write timestamps as execution times', () => {
    const assembler = engine()
    assembler.replaceWindow([stage(1, 'queued', { recovered: true }), stage(2, 'started', { recovered: true }),
      stage(3, 'completed')], false)
    const node = taskNodes(assembler)[0]!
    expect(node.data.stages.map(item => item.recovered)).toEqual([true, true, false])
    const { view } = renderTask(node)
    const stages = view.getAllByRole('listitem')
    expect(stages.slice(0, 2).map(item => ({ restored: item.textContent?.includes(taskZh['task.recovered']),
      time: item.querySelector('time')?.dateTime ?? null }))).toMatchInlineSnapshot(`
        [
          {
            "restored": true,
            "time": null,
          },
          {
            "restored": true,
            "time": null,
          },
        ]
      `)
    expect(stages[2]!.querySelector('time')?.dateTime).toBe(new Date(1_700_000_000_003).toISOString())
  })

  it.each(['failed', 'cancelled', 'unknown', 'passed'] as const)('renders observed %s distinctly without claiming completion', (status) => {
    const assembler = engine()
    const error = status === 'failed' ? { code: 'synthetic', message: 'Recorded execution failure' } : null
    assembler.replaceWindow([stage(1, 'queued'), stage(2, status, { error })], false)
    const { view } = renderTask(taskNodes(assembler)[0]!)
    expect(view.container.querySelector('article')?.getAttribute('data-state')).toBe(status)
    expect(view.container.textContent).not.toContain(taskZh['state.completed'])
    if (status === 'unknown') {
      expect(screen.getByText(taskZh['task.unknownHint'])).toBeTruthy()
      expect(view.container.textContent).not.toContain(taskZh['state.cancelled'])
    }
    if (status === 'passed') expect(screen.getByText(taskZh['task.passedHint'])).toBeTruthy()
    if (status === 'failed') expect(screen.getByText('任务未完成：Recorded execution failure')).toBeTruthy()
    if (status === 'cancelled') expect(view.container.textContent).toContain('派发前已取消')
  })

  it.each(['writer-private', 'other-group-root', undefined])('hides the record in non-owning Session %s', (sessionId) => {
    const assembler = engine()
    assembler.replaceWindow([stage(1, 'queued')], false)
    const { props, view } = renderTask(taskNodes(assembler)[0]!)
    view.rerender(<GroupTaskLifecycle {...props} sessionId={sessionId as SessionId} />)
    expect(view.container.textContent).toBe('')
  })

  it('localizes historical initiators and removed members without reading their private histories', () => {
    const assembler = engine()
    assembler.replaceWindow([stage(1, 'queued', { actor: { kind: 'legacy-coordinator' }, target: { ...task.target, sender: null } })], false)
    const { view } = renderTask(taskNodes(assembler)[0]!, taskEn)
    expect(screen.getByRole('article', { name: 'Group task from Historical coordinator to Removed member' })).toBeTruthy()
    expect(view.container.querySelector('svg')).toBeNull()
    expect(view.container.textContent).toContain('Queued')
    expect(view.container.textContent).not.toContain('undefined')
  })

  it('renders task and error text as text, without executing or interpreting embedded markup', () => {
    const assembler = engine()
    assembler.replaceWindow([stage(1, 'failed', { message: '<img src=x onerror=alert(1)>',
      error: { code: 'synthetic', message: '<script>secret()</script>' } })], false)
    const { view } = renderTask(taskNodes(assembler)[0]!)
    expect(view.container.querySelector('img,script,a')).toBeNull()
    expect(view.container.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(view.container.textContent).toContain('<script>secret()</script>')
  })
})
