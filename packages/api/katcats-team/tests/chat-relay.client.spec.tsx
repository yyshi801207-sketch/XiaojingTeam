// @vitest-environment jsdom
/** Durable member identity survives pending admission, replay and independent group windows. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MarkdownDelegateProvider } from '@deepseek-ai/dsh-client-ui-primitives'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ConversationNodeDefinition, ConversationViewDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode, ChatNode, ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { messageDefinition } from '../../../client/ui-chat/src/client/conversation-nodes/message.ts'
import { chatViewDefinition } from '../../../client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { processGroupDefinition } from '../../../client/ui-chat/src/client/conversation-nodes/process-groups.ts'
import { turnProcessDefinition } from '../../../client/ui-chat/src/client/conversation-nodes/turn-process.ts'
import type { BotId } from '../src/types.ts'
import type { ChatDeliveryId, ChatId, ChatRunId } from '../src/chats-types.ts'
import type { FinanceConnectorId } from '../src/finance-types.ts'
import { chatRelayDefinition } from '../src/client/chat-relay.ts'
import { ChatRelayMessage, type ChatRelayMessageProps } from '../src/client/ChatRelayMessage.tsx'
import { en, zh } from '../src/client/locales.ts'
import { presentationDirectory } from './group-presentation-fixture.client.ts'

afterEach(() => { window.getSelection()?.removeAllRanges(); cleanup() })
const { useGroupDirectory } = presentationDirectory()
const relayActions = { copyRelayText: vi.fn(), openRelayMember: vi.fn() }
const relay: UserMessage = {
  id: 'relay-message' as MessageId, role: 'user', content: [{ type: 'text', text: '**Actual member result**\n\n[Reference](https://example.com)' }],
  source: { kind: 'katcats-group-relay', form: 'relay', schemaVersion: 1, chatId: 'editorial' as ChatId, runId: 'run' as ChatRunId,
    generation: 1, deliveryId: 'delivery' as ChatDeliveryId, sender: { botId: 'writer' as BotId, name: 'Recorded Writer',
      role: 'Research', avatar: { shape: 'round', color: '#2288FF' } }, executionSessionId: 'group-writer' as SessionId,
    inputMessageId: 'task' as MessageId, outputMessageId: 'answer' as MessageId },
}

function entry(seq: number, type: string, data: object): SessionLiveEventEntry {
  return { type: 'event', event: { seq, time: 1_700_000_000_000 + seq, type, data,
    ...type === 'user/message' ? { surfaceOp: 'append' } : {} } as SessionEvent }
}
const queued = (seq = 1, message = relay) => entry(seq, 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [message] })
const consumed = (seq = 3, message = relay) => entry(seq, 'user/message', message)

function engine() {
  const definitions = { entries: (): readonly ConversationNodeDefinition[] => [messageDefinition, chatRelayDefinition, turnProcessDefinition], fallbackEntry: () => undefined }
  const views = { entries: (): readonly ConversationViewDefinition[] => [chatViewDefinition] }
  const groups = { entries: () => [processGroupDefinition], forTarget: (target: string) => target === 'chat' ? processGroupDefinition : undefined }
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
function relayNodes(assembler: ConversationNodeAssembler) {
  return [...snapshot(assembler).nodes.values()].filter(isRelayNode)
}

function isRelayNode(node: ChatConversationViewNode): node is ChatNode<'katcats-relay'> {
  return node.kind === 'katcats-relay'
}

describe('member relay projection', () => {
  it('renders the recorded main Bot’s connection welcome in the chat without a model turn or file cards', () => {
    const directory = presentationDirectory()
    const welcome: UserMessage = {
      id: 'finance-connected' as MessageId, role: 'user', content: [{ type: 'text', text: 'Recorded connection' }],
      source: { kind: 'katcats-group-finance-connected', form: 'notice', summary: 'Finance connection established',
        chatId: directory.chat.id, sender: { botId: 'main' as BotId, name: '小兢会计', role: '',
          avatar: { shape: 'classic', color: '#222222' } }, connectorId: 'new-connector' as FinanceConnectorId,
        connectorName: '鸿优嘉', companyName: '苏州鸿优嘉', currency: 'RMB' },
    }
    const assembler = engine()
    assembler.replaceWindow([consumed(1, welcome)], false)
    expect(snapshot(assembler).timeline.turnOrder).toEqual([])
    const node = relayNodes(assembler)[0]!
    expect(relayNodes(assembler)).toHaveLength(1)
    const renderSlot = vi.fn(() => null)
    const props = { node, sessionId: directory.chat.rootSessionId, useGroupDirectory: directory.useGroupDirectory,
      ...relayActions, renderSlot, t: makeTranslate(zh) } as ChatRelayMessageProps
    const view = render(<ChatRelayMessage {...props} />)
    const body = view.container.querySelector('[data-katcats-message-body]')
    expect([screen.getByText('小兢会计').textContent, body?.textContent]).toMatchInlineSnapshot(`
      [
        "小兢会计",
        "本群已连接账套「鸿优嘉」（苏州鸿优嘉 · RMB）。现在可以在群里查凭证、核对分录或导出账套数据。",
      ]
    `)
    expect(renderSlot).not.toHaveBeenCalled()
    view.rerender(<ChatRelayMessage {...props} t={makeTranslate(en)} />)
    expect(body?.textContent).toBe('This group is now connected to the ledger “鸿优嘉” (苏州鸿优嘉 · RMB). Ask the group to find vouchers, check entries, or export ledger data.')
  })

  it('shows file cards without an empty message bubble for a file-only result', () => {
    const assembler = engine()
    assembler.replaceWindow([consumed(1, { ...relay, content: [{ type: 'text', text: '' }] })], false)
    const renderSlot = vi.fn(() => <button>Reviewed report.xlsx</button>)
    const props = { node: relayNodes(assembler)[0]!, useGroupDirectory, ...relayActions, renderSlot, t: makeTranslate(zh) } as ChatRelayMessageProps
    const view = render(<ChatRelayMessage {...props} />)
    expect(view.container.querySelector('[data-katcats-message-body]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Reviewed report.xlsx' })).toBeTruthy()
    expect(renderSlot).toHaveBeenCalledExactlyOnceWith('katcats.group.delivered-files', { messageId: relay.id, source: relay.source })
  })

  it('marks only the current manager by Bot identity in this exact group, preserving historical sender names', () => {
    const assembler = engine()
    assembler.replaceWindow([consumed()], false)
    const directory = presentationDirectory({ managerId: 'writer' as BotId })
    const props = { node: relayNodes(assembler)[0]!, sessionId: directory.chat.rootSessionId,
      useGroupDirectory: directory.useGroupDirectory, ...relayActions, renderSlot: () => null, t: makeTranslate(zh) } as ChatRelayMessageProps
    const view = render(<ChatRelayMessage {...props} />)
    expect(screen.getByRole('img', { name: zh['chat.managerBadge'] })).toBeTruthy()
    expect(view.container.querySelector('[data-katcats-manager-avatar]')?.getAttribute('data-katcats-manager-avatar')).toBe('writer')
    expect(screen.getByText('Recorded Writer')).toBeTruthy()
    const saved = directory.source.getSnapshot().snapshot!
    act(() => { directory.source.set({ phase: 'ready', snapshot: { ...saved,
      chats: [{ ...directory.chat, managerId: 'reviewer' as BotId }] } }) })
    expect(view.container.querySelector('[data-katcats-manager-avatar]')).toBeNull()
    expect(screen.getByText('Recorded Writer')).toBeTruthy()
    act(() => { directory.source.set({ phase: 'ready', snapshot: saved }) })
    expect(screen.getByRole('img', { name: zh['chat.managerBadge'] })).toBeTruthy()
    view.rerender(<ChatRelayMessage {...props} sessionId={'writer-private' as SessionId} />)
    expect(view.container.querySelector('[data-katcats-manager-avatar]')).toBeNull()
    view.rerender(<ChatRelayMessage {...props} />)
    act(() => { directory.source.set({ phase: 'loading', snapshot: saved }) })
    expect(view.container.querySelector('[data-katcats-manager-avatar]')).toBeNull()
    act(() => { directory.source.set({ phase: 'ready', snapshot: { ...saved,
      chats: [{ ...directory.chat, id: 'other-group' as ChatId }] } }) })
    expect(view.container.querySelector('[data-katcats-manager-avatar]')).toBeNull()
  })

  it('shows a human and distinct member messages in a container without model turns', () => {
    if (relay.source.kind !== 'katcats-group-relay') throw new Error('missing synthetic sender')
    const reviewer: UserMessage = { ...relay, id: 'reviewer-message' as MessageId,
      content: [{ type: 'text', text: 'Review complete' }], source: { ...relay.source,
        sender: { ...relay.source.sender, botId: 'reviewer' as BotId, name: 'Recorded Reviewer',
          avatar: { shape: 'classic', color: '#FF2849' } } } }
    const records = [entry(1, 'user/message', { id: 'human' as MessageId, role: 'user',
      source: { kind: 'user' }, content: [{ type: 'text', text: 'Hello members' }] }), consumed(2), consumed(3, reviewer)]
    const live = engine()
    live.replaceWindow(records, false)
    expect(snapshot(live).timeline.turnOrder).toEqual([])
    const members = relayNodes(live)
    expect(members.map(node => node.data.source.sender.name)).toEqual(['Recorded Writer', 'Recorded Reviewer'])
    expect(live.grouped('chat')?.entries.filter(item => item.kind === 'node')).toHaveLength(3)
    const cold = engine()
    cold.replaceWindow(records, false)
    expect(relayNodes(cold)).toEqual(members)
  })

  it('keeps a completed member reply outside closed Turn and tool disclosures', () => {
    const assembler = engine()
    assembler.replaceWindow([
      entry(1, 'turn/start', { turn: 1 }),
      entry(2, 'step/start', { turn: 1, step: 1 }),
      entry(3, 'tool/call', { turn: 1, step: 1, callId: 'delegate', name: 'delegate_to_bot', args: {} }),
      queued(4), consumed(5),
      entry(6, 'step/end', { turn: 1, step: 1 }),
      entry(7, 'turn/end', { turn: 1 }),
    ], false)
    const node = relayNodes(assembler)[0]!
    expect(node.data.consumed).toBe(true)
    expect(node.groupTree).toBe('turn')
    expect(snapshot(assembler).timeline.turns.get(1)?.status).toBe('closed')
    expect(assembler.grouped('chat')?.entries).toContainEqual({ kind: 'node', key: node.key })
    const cold = engine()
    cold.replaceWindow([consumed(5), entry(7, 'turn/end', { turn: 1 })], true)
    const replayed = relayNodes(cold)[0]!
    expect(replayed.groupTree).toBe('turn')
    expect(cold.grouped('chat')?.entries).toContainEqual({ kind: 'node', key: replayed.key })
  })

  it('shows a completed member result before coordinator admission and updates the same node on consumption', () => {
    const assembler = engine()
    assembler.replaceWindow([queued()], false)
    const pending = relayNodes(assembler)[0]!
    expect(pending.data).toMatchObject({ messageId: relay.id, consumed: false, text: '**Actual member result**\n\n[Reference](https://example.com)' })
    assembler.append(consumed())
    assembler.flush()
    const complete = relayNodes(assembler)
    expect(complete).toHaveLength(1)
    expect(complete[0]?.key).toBe(pending.key)
    expect(complete[0]?.data.consumed).toBe(true)
    expect([...snapshot(assembler).nodes.values()].some(node => node.kind === 'user' || node.kind === 'context' || node.kind === 'assistant-step')).toBe(false)
  })

  it('preserves consumed state when recovery requeues the same message and cold-replays one stable identity', () => {
    const records = [queued(), consumed(), queued(4)]
    const live = engine()
    live.replaceWindow(records, false)
    expect(relayNodes(live)).toHaveLength(1)
    expect(relayNodes(live)[0]?.data.consumed).toBe(true)
    const cold = engine()
    cold.replaceWindow(records, false)
    expect(relayNodes(cold)).toEqual(relayNodes(live))
  })

  it('renders a loaded consumed message even when its older inbox insertion is outside the history window', () => {
    const assembler = engine()
    assembler.replaceWindow([consumed()], true)
    expect(relayNodes(assembler)).toHaveLength(1)
    expect(relayNodes(assembler)[0]?.data).toMatchObject({ messageId: relay.id, consumed: true })
    assembler.prepend([queued()], false)
    assembler.flush()
    expect(relayNodes(assembler)).toHaveLength(1)
    expect(relayNodes(assembler)[0]?.data.consumed).toBe(true)
  })

  it('keeps separate groups and private human messages in their own conversation windows', () => {
    const groupA = engine()
    groupA.replaceWindow([queued()], false)
    const other = { ...relay, id: 'other-message' as MessageId,
      source: relay.source.kind === 'katcats-group-relay' ? { ...relay.source, chatId: 'other-group' as ChatId } : relay.source }
    const groupB = engine()
    groupB.replaceWindow([queued(1, other)], false)
    expect(relayNodes(groupA)[0]?.data.source.chatId).toBe('editorial')
    expect(relayNodes(groupB)[0]?.data.source.chatId).toBe('other-group')
    const privateChat = engine()
    privateChat.replaceWindow([entry(1, 'user/message', { ...relay, source: { kind: 'user' } })], false)
    expect(relayNodes(privateChat)).toHaveLength(0)
    expect([...snapshot(privateChat).nodes.values()].map(node => node.kind)).toEqual(['user'])
  })

  it('rejects unsupported batched relay splices instead of silently hiding later member results', () => {
    const assembler = engine()
    expect(() => assembler.replaceWindow([entry(1, 'agent/inbox/spliced', { target: 'next-step', start: 0,
      inserted: [relay, { ...relay, id: 'second-relay' as MessageId }] })], false)).toThrow('separate inbox splices')
  })

  it('opens member deliverables through the enclosing Session delegate without retaining a replaced opener', () => {
    const assembler = engine()
    const message = { ...relay, content: [{ type: 'text' as const,
      text: '[Final delivery](./acceptance-final.md#L7-L9) and [Absolute delivery](E:/Projects/Katcats.AI/run/tmp/synthetic/acceptance-final.md)' }] }
    assembler.replaceWindow([consumed(1, message)], false)
    const props = { node: relayNodes(assembler)[0]!, useGroupDirectory, ...relayActions, renderSlot: () => null, t: makeTranslate(zh) } as ChatRelayMessageProps
    const open = vi.fn<(path: string, options?: { line?: number }) => void>()
    const view = render(<MarkdownDelegateProvider openFile={open}><ChatRelayMessage {...props} /></MarkdownDelegateProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Final delivery' }))
    expect(open).toHaveBeenCalledExactlyOnceWith('./acceptance-final.md', { line: 7 })
    fireEvent.click(screen.getByRole('button', { name: 'Absolute delivery' }))
    expect(open).toHaveBeenLastCalledWith('E:/Projects/Katcats.AI/run/tmp/synthetic/acceptance-final.md', undefined)
    expect(view.container.querySelector('[data-katcats-message-body]')?.querySelectorAll('button')).toHaveLength(2)
    const replacement = vi.fn<(path: string, options?: { line?: number }) => void>()
    view.rerender(<MarkdownDelegateProvider openFile={replacement}><ChatRelayMessage {...props} /></MarkdownDelegateProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Final delivery' }))
    expect(replacement).toHaveBeenCalledExactlyOnceWith('./acceptance-final.md', { line: 7 })
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('uses the recorded sender and approved avatar while safely rendering member Markdown', () => {
    const assembler = engine()
    assembler.replaceWindow([queued()], false)
    const node = relayNodes(assembler)[0]!
    const props = { node, useGroupDirectory, ...relayActions, renderSlot: () => null, t: makeTranslate(zh) } as ChatRelayMessageProps
    const view = render(<ChatRelayMessage {...props} />)
    expect(screen.getByRole('group', { name: 'Recorded Writer 的群消息' })).toBeTruthy()
    expect(screen.getByLabelText(/^发言时间：/)).toBeTruthy()
    expect(view.container.querySelector('time')?.getAttribute('datetime')).toBe(new Date(node.data.time).toISOString())
    expect(screen.getByRole('link', { name: 'Reference' }).getAttribute('href')).toBe('https://example.com')
    expect(view.container.querySelector('svg')?.style.getPropertyValue('--katcats-avatar-color')).toBe('#2288FF')
    expect(view.container.querySelector('strong')?.textContent).toBe('Recorded Writer')
    const bubble = view.container.querySelector('[data-katcats-message-body]')
    expect(bubble?.querySelector('a')?.textContent).toBe('Reference')
    expect(bubble?.textContent).not.toContain('Recorded Writer')
    expect(bubble?.querySelector('time')).toBeNull()
    expect(bubble?.contains(view.container.querySelector('svg'))).toBe(false)
    assembler.append(consumed())
    assembler.flush()
    view.rerender(<ChatRelayMessage {...props} node={relayNodes(assembler)[0]!} />)
    expect(screen.queryByRole('status')).toBeNull()
    expect(view.container.querySelector('time')?.getAttribute('datetime')).toBe(new Date(node.data.time).toISOString())
    expect(view.container.querySelectorAll('[data-katcats-relay]')).toHaveLength(1)
  })
})

describe('member message context actions', () => {
  function setup(text?: string) {
    const assembler = engine()
    assembler.replaceWindow([consumed(1, text === undefined ? relay
      : { ...relay, content: [{ type: 'text', text }] })], false)
    const directory = presentationDirectory()
    const actions = { copyRelayText: vi.fn(), openRelayMember: vi.fn() }
    const props = { node: relayNodes(assembler)[0]!, sessionId: directory.chat.rootSessionId,
      useGroupDirectory: directory.useGroupDirectory, ...actions, renderSlot: () => null, t: makeTranslate(zh) } as ChatRelayMessageProps
    const view = render(<ChatRelayMessage {...props} />)
    const bubble = view.container.querySelector<HTMLElement>('[data-katcats-message-body]')!
    return { ...view, bubble, directory, props, actions }
  }

  it('widens and tints a reply only while its exact group is bound to a ledger', () => {
    const b = setup('| Date | Reference | Debit | Credit |\n| --- | --- | --- | --- |\n| 2026-11-10 | Voucher | 8 | 8 |')
    const saved = b.directory.source.getSnapshot().snapshot!
    const row = b.container.querySelector<HTMLElement>('[data-katcats-relay]')!
    expect(row.hasAttribute('data-katcats-reply-layout')).toBe(false)
    act(() => { b.directory.source.set({ phase: 'ready', snapshot: { ...saved, financeChatIds: ['other-group' as ChatId] } }) })
    expect(row.hasAttribute('data-katcats-reply-layout')).toBe(false)

    act(() => { b.directory.source.set({ phase: 'ready', snapshot: { ...saved, financeChatIds: [b.directory.chat.id] } }) })
    expect(row.getAttribute('data-katcats-reply-layout')).toBe('wide')
    expect(row.style.getPropertyValue('--katcats-relay-color')).toBe(b.props.node.data.source.sender.avatar.color)
    expect(screen.getByText('Recorded Writer')).toBeTruthy()
    expect(screen.getByLabelText('Recorded Writer')).toBeTruthy()
    expect(screen.getByRole('table').parentElement?.classList.contains('md-table-wide')).toBe(true)
    fireEvent.contextMenu(b.bubble)
    fireEvent.click(screen.getByRole('menuitem', { name: zh['chat.copyMessage'] }))
    expect(b.actions.copyRelayText).toHaveBeenCalledExactlyOnceWith(b.props.node.data.text)

    b.rerender(<ChatRelayMessage {...b.props} sessionId={'other-root' as SessionId} />)
    expect(row.hasAttribute('data-katcats-reply-layout')).toBe(false)
    b.rerender(<ChatRelayMessage {...b.props} />)
    expect(row.getAttribute('data-katcats-reply-layout')).toBe('wide')
    act(() => { b.directory.source.set({ phase: 'ready', snapshot: saved }) })
    expect(row.hasAttribute('data-katcats-reply-layout')).toBe(false)
    expect(row.style.getPropertyValue('--katcats-relay-color')).toBe('')
  })

  it('copies the original Markdown or exact message identity from a compact, localized menu', () => {
    const b = setup()
    fireEvent.contextMenu(b.bubble, { clientX: 120, clientY: 160 })
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toMatchInlineSnapshot(`
      [
        "复制消息",
        "复制消息 ID",
      ]
    `)
    fireEvent.click(screen.getByRole('menuitem', { name: zh['chat.copyMessage'] }))
    expect(b.actions.copyRelayText).toHaveBeenCalledExactlyOnceWith(b.props.node.data.text)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.keyDown(b.bubble, { key: 'F10', shiftKey: true })
    fireEvent.click(screen.getByRole('menuitem', { name: zh['chat.copyMessageId'] }))
    expect(b.actions.copyRelayText).toHaveBeenLastCalledWith('relay-message')
    b.rerender(<ChatRelayMessage {...b.props} t={makeTranslate(en)} />)
    fireEvent.contextMenu(b.bubble)
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Copy message', 'Copy message ID'])
  })

  it('opens the current member from their name and copies the recorded name from their avatar', () => {
    const b = setup()
    fireEvent.contextMenu(screen.getByText('Recorded Writer'))
    fireEvent.click(screen.getByRole('menuitem', { name: zh['chat.openMember'] }))
    expect(b.actions.openRelayMember).toHaveBeenCalledExactlyOnceWith('writer')
    const avatar = screen.getByLabelText('Recorded Writer')
    fireEvent.keyDown(avatar, { key: 'ContextMenu' })
    fireEvent.click(screen.getByRole('menuitem', { name: zh['chat.copyMemberName'] }))
    expect(b.actions.copyRelayText).toHaveBeenCalledExactlyOnceWith('Recorded Writer')
  })

  it.each(['removed', 'loading', 'other-session'] as const)('keeps historical member identity copyable but disables opening while %s', reason => {
    const b = setup()
    if (reason === 'other-session') b.rerender(<ChatRelayMessage {...b.props} sessionId={'other-root' as SessionId} />)
    else {
      const saved = b.directory.source.getSnapshot().snapshot!
      act(() => { b.directory.source.set(reason === 'loading' ? { phase: 'loading', snapshot: saved }
        : { phase: 'ready', snapshot: { ...saved, chats: [{ ...b.directory.chat, memberIds: [] }] } }) })
    }
    fireEvent.contextMenu(screen.getByText('Recorded Writer'))
    const open = screen.getByRole<HTMLButtonElement>('menuitem', { name: zh['chat.openMember'] })
    expect(open.disabled).toBe(true)
    fireEvent.click(open)
    expect(b.actions.openRelayMember).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: zh['chat.copyMemberName'] }))
    expect(b.actions.copyRelayText).toHaveBeenCalledExactlyOnceWith('Recorded Writer')
  })

  it('preserves the native menu for selected message text and links', () => {
    const b = setup()
    const selection = window.getSelection()!
    selection.removeAllRanges()
    const range = document.createRange()
    range.selectNodeContents(b.bubble)
    selection.addRange(range)
    expect(fireEvent.contextMenu(b.bubble)).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
    selection.removeAllRanges()
    expect(fireEvent.contextMenu(screen.getByRole('link', { name: 'Reference' }))).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('copies the durable ID of a file-only message from the member menu', () => {
    const b = setup('')
    fireEvent.contextMenu(screen.getByText('Recorded Writer'))
    expect(screen.queryByRole('menuitem', { name: zh['chat.copyMessage'] })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: zh['chat.copyMessageId'] }))
    expect(b.actions.copyRelayText).toHaveBeenCalledExactlyOnceWith('relay-message')
  })
})
