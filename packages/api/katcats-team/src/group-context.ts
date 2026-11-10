/** Select public group context and page original history without entering private member conversations. */
import { HarnessError, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-compaction'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ChatDelivery, ChatInbound } from './chats-types.ts'
import type { ChatRuntimeSnapshot } from './chats-runtime-types.ts'
import type { GroupContextManifest } from './chats-messages.ts'
import { ticketForInput } from './group-tickets.ts'

/** One original public item, or an explicitly partial page of that item. */
export interface GroupHistoryEntry {
  readonly id: string
  readonly kind: 'owner' | 'reply' | 'handoff'
  readonly sender: string
  readonly content: readonly ContentBlock[]
  readonly partial: boolean
}

/** History filters intersect; cursor continues the same filter, and limit counts original items. */
export interface GroupHistoryQuery {
  readonly ids?: readonly string[]
  readonly keyword?: string
  readonly cursor?: string
  readonly limit: number
}

/** Logged tool content includes exact text segments, original images and an explicit continuation cursor. */
export interface GroupHistoryResult {
  readonly entries: readonly GroupHistoryEntry[]
  readonly nextCursor: string | null
  readonly content: ContentBlock[]
}

interface PublicHistoryInput {
  readonly delivery: ChatDelivery
  readonly snapshot: ChatRuntimeSnapshot
  readonly rootEvents: readonly SessionEvent[]
}

interface Cursor {
  readonly id: string
  readonly block: number
  readonly offset: number
}

function sourceOwner(snapshot: ChatRuntimeSnapshot, delivery: ChatDelivery): ChatInbound | undefined {
  const visited = new Set<ChatDelivery['id']>()
  let current: ChatDelivery | undefined = delivery
  while (current !== undefined) {
    if (visited.has(current.id)) throw new HarnessError('The saved group task ancestry is cyclic.', 'KATCATS_CHAT_INVALID_SOURCE')
    visited.add(current.id)
    const source: ChatDelivery['source'] = current.source
    if (source.kind === 'owner-message') return snapshot.inbounds.find(inbound => inbound.userMessage.id === source.messageId)
    current = source.kind === 'member-reply'
      ? snapshot.deliveries.find(candidate => candidate.relayMessageId === source.messageId)
      : snapshot.deliveries.find(candidate => candidate.id === source.parentDeliveryId)
  }
  return undefined
}

function publicHistory(input: PublicHistoryInput): { entries: GroupHistoryEntry[]; owner: ChatInbound | undefined; allowed: Set<string> } {
  const { delivery, snapshot, rootEvents } = input
  if (delivery.chatId !== snapshot.chat.id || !snapshot.chat.memberIds.includes(delivery.botId)
    || !snapshot.chat.executors.some(executor => executor.botId === delivery.botId && executor.sessionId === delivery.executorSessionId)) {
    throw new HarnessError('This task does not belong to a current member of this group.', 'KATCATS_CHAT_DENIED')
  }
  const owner = sourceOwner(snapshot, delivery)
  const ownerIndex = owner === undefined ? snapshot.inbounds.length - 1 : snapshot.inbounds.indexOf(owner)
  const allowed = new Set<string>(snapshot.inbounds.slice(0, ownerIndex + 1)
    .filter(inbound => inbound.state === 'published').map(inbound => inbound.userMessage.id))
  const ownedInputs = new Set(snapshot.inbounds.map(inbound => inbound.userMessage.id))
  const permitted = (candidate: ChatDelivery) => {
    const origin = sourceOwner(snapshot, candidate)
    return candidate.chatId === snapshot.chat.id && (origin === undefined || allowed.has(origin.userMessage.id))
  }
  const entries: GroupHistoryEntry[] = []
  const ids = new Set<string>()
  const add = (entry: GroupHistoryEntry) => {
    if (!ids.has(entry.id)) { entries.push(entry); ids.add(entry.id) }
  }
  for (const event of rootEvents) {
    if (event.type === 'katcats/group-task-lifecycle') {
      const task = event.data
      if (task.chatId !== snapshot.chat.id || task.rootSessionId !== snapshot.chat.rootSessionId || task.actor.kind !== 'member') continue
      const candidate = snapshot.deliveries.find(item => item.id === task.deliveryId && item.botId === task.target.botId
        && item.runId === task.runId && item.generation === task.generation)
      if (candidate === undefined || !permitted(candidate)) continue
      add({ id: 'handoff:' + candidate.id, kind: 'handoff',
        sender: (task.actor.sender?.name ?? task.actor.botId) + ' to ' + (task.target.sender?.name ?? task.target.botId),
        content: [{ type: 'text', text: task.message }], partial: false })
    } else if (event.type === 'user/message' && event.surfaceOp === 'append') {
      const source = event.data.source
      if (source.kind === 'user' && (allowed.has(event.data.id) || !ownedInputs.has(event.data.id))) {
        add({ id: 'message:' + event.data.id, kind: 'owner', sender: 'Group owner', content: event.data.content, partial: false })
      } else if (source.kind === 'katcats-group-relay' && source.chatId === snapshot.chat.id) {
        const candidate = snapshot.deliveries.find(item => item.id === source.deliveryId)
        if (candidate !== undefined && permitted(candidate)) add({ id: 'message:' + event.data.id, kind: 'reply',
          sender: source.sender.name, content: event.data.content, partial: false })
      }
    }
  }
  for (const candidate of snapshot.deliveries) {
    if (candidate.state !== 'completed' || candidate.receipt === null || !permitted(candidate)) continue
    add({ id: 'message:' + candidate.relayMessageId, kind: 'reply', sender: candidate.receipt.sender.name,
      content: [{ type: 'text', text: candidate.receipt.text }], partial: false })
  }
  return { entries, owner, allowed }
}

function retainedCoverage(input: PublicHistoryInput, events: readonly SessionEvent[], nodes: readonly SessionSeq[]) {
  const { snapshot, delivery, rootEvents } = input
  const records = new Map(events.map(event => [event.seq, event]))
  const ownReplies = new Map<string, string>()
  for (const candidate of snapshot.deliveries) {
    if (candidate.chatId === snapshot.chat.id && candidate.botId === delivery.botId
      && candidate.executorSessionId === delivery.executorSessionId && candidate.state === 'completed' && candidate.receipt !== null) {
      ownReplies.set(candidate.receipt.outputMessageId, 'message:' + candidate.relayMessageId)
    }
  }
  for (const event of rootEvents) {
    if (event.type !== 'user/message') continue
    const source = event.data.source
    if (source.kind === 'katcats-group-relay' && source.chatId === snapshot.chat.id
      && source.executionSessionId === delivery.executorSessionId && source.sender.botId === delivery.botId) {
      ownReplies.set(source.outputMessageId, 'message:' + event.data.id)
    }
  }
  const toolCalls = new Map(events.flatMap(event => event.type === 'tool/call' ? [[event.data.callId, event.data.name] as const] : []))
  const visited = new Set<SessionSeq>()
  const delivered = new Set<string>()
  const archived = new Set<string>()
  let established = false
  const pending = [...nodes]
  while (pending.length > 0) {
    const seq = pending.pop()
    if (seq === undefined) break
    if (visited.has(seq)) continue
    visited.add(seq)
    const event = records.get(seq)
    if (event?.type === 'assistant/message' && event.surfaceOp === 'append') {
      const id = ownReplies.get(event.data.message.id)
      if (id !== undefined) delivered.add(id)
      for (const block of event.data.message.content) {
        if (block.type !== 'tool-call' || block.name !== 'request_group_member') continue
        const child = snapshot.deliveries.find(candidate => candidate.chatId === snapshot.chat.id
          && candidate.sourceSessionId === delivery.executorSessionId && candidate.source.kind === 'tool'
          && candidate.source.callId === block.id)
        if (child !== undefined) delivered.add('handoff:' + child.id)
      }
    } else if (event?.type === 'tool/result' && event.surfaceOp === 'append' && event.data.message.isError !== true) {
      const meta = event.data.meta
      const toolName = toolCalls.get(event.data.message.toolCallId)
      if (toolName === 'request_group_member' && typeof meta === 'object' && meta !== null && 'delivery_id' in meta && 'message_id' in meta
        && 'chat_id' in meta && meta.chat_id === snapshot.chat.id && 'status' in meta && meta.status === 'completed') {
        const child = snapshot.deliveries.find(candidate => candidate.id === meta.delivery_id && candidate.chatId === snapshot.chat.id
          && candidate.state === 'completed' && candidate.receipt !== null && candidate.relayMessageId === meta.message_id
          && candidate.source.kind === 'tool' && candidate.source.callId === event.data.message.toolCallId
          && candidate.sourceSessionId === delivery.executorSessionId)
        if (child !== undefined) delivered.add('message:' + child.relayMessageId)
      } else if (toolName === 'read_group_history' && typeof meta === 'object' && meta !== null
        && 'itemIds' in meta && Array.isArray(meta.itemIds) && 'partialIds' in meta && Array.isArray(meta.partialIds)) {
        for (const id of meta.itemIds) if (typeof id === 'string' && !meta.partialIds.includes(id)) delivered.add(id)
      }
    }
    if (event?.type !== 'user/message') continue
    const source = event.data.source
    if (source.kind === 'katcats-group-task' && event.surfaceOp === 'append' && source.chatId === snapshot.chat.id
      && source.context?.schemaVersion === 1 && source.context.rootSessionId === snapshot.chat.rootSessionId) {
      established = true
      for (const id of source.context.deliveredIds) delivered.add(id)
      for (const id of source.context.archivedIds) archived.add(id)
    } else if (source.kind === 'compact-checkpoint' && event.surfaceOp !== 'append') {
      for (const sourceSeq of event.sourceEventSeqs ?? []) pending.push(sourceSeq)
    }
  }
  return { established, delivered, archived }
}

function heading(entry: GroupHistoryEntry): string {
  return '\n[' + entry.id + '] ' + (entry.kind === 'handoff' ? 'Saved public handoff ' + entry.sender
    : entry.kind === 'owner' ? entry.sender : entry.sender + ' replied') + ':\n'
}

/**
 * Build one logged member input from recent bootstrap history or uncovered public items.
 * Retained task inputs, own replies, member results and complete history lookups establish coverage.
 * Compaction checkpoints inherit that coverage; arbitrary replacements and prunes do not.
 * @param input - admitted delivery, public transcript, current executor surface and configured bootstrap size.
 * @returns input blocks and the non-cumulative manifest stored on that same user message.
 */
export function buildGroupContext(input: PublicHistoryInput & {
  readonly executorEvents: readonly SessionEvent[]
  readonly executorSurfaceSeqs: readonly SessionSeq[]
  readonly bootstrapMessageCount: number
}): { content: ContentBlock[]; context: GroupContextManifest } {
  const { delivery, snapshot } = input
  const history = publicHistory(input)
  const { owner, allowed } = history
  const ticket = ticketForInput(snapshot.chat, owner)
  const belongs = (origin: ChatInbound | undefined) => {
    const other = ticketForInput(snapshot.chat, origin)
    return ticket === undefined || other === undefined || ticket.id === other.id
  }
  const entries = history.entries.filter((entry) => {
    const origin = entry.kind === 'owner' ? snapshot.inbounds.find(item => 'message:' + item.userMessage.id === entry.id)
      : snapshot.deliveries.find(item => (entry.kind === 'reply' ? 'message:' + item.relayMessageId : 'handoff:' + item.id) === entry.id)
    return belongs(origin === undefined ? undefined : 'userMessage' in origin ? origin : sourceOwner(snapshot, origin))
  })
  const coverage = retainedCoverage(input, input.executorEvents, input.executorSurfaceSeqs)
  const required = new Set<string>(owner === undefined ? [] : ['message:' + owner.userMessage.id])
  let ancestor: ChatDelivery | undefined = delivery
  const seen = new Set<ChatDelivery['id']>()
  while (ancestor !== undefined && !seen.has(ancestor.id)) {
    seen.add(ancestor.id)
    if (ancestor.source.kind !== 'tool') break
    required.add('handoff:' + ancestor.id)
    const parentId: ChatDelivery['id'] | undefined = ancestor.source.parentDeliveryId
    ancestor = snapshot.deliveries.find(candidate => candidate.id === parentId)
  }
  const recent = new Set(entries.slice(-input.bootstrapMessageCount).map(entry => entry.id))
  const selected = entries.filter(entry => required.has(entry.id) || !coverage.delivered.has(entry.id)
    && (coverage.established ? !coverage.archived.has(entry.id) : recent.has(entry.id)))
  const selectedIds = new Set(selected.map(entry => entry.id))
  const archived = coverage.established ? [] : entries.filter(entry => !selectedIds.has(entry.id)
    && !coverage.delivered.has(entry.id)).map(entry => entry.id)
  const isOwner = delivery.source.kind === 'owner-message'
  const taskId = isOwner ? owner === undefined ? undefined : 'message:' + owner.userMessage.id : 'handoff:' + delivery.id
  const content: ContentBlock[] = [{ type: 'text', text: [
    'Current group: ' + snapshot.chat.name,
    taskId !== undefined && selectedIds.has(taskId) ? 'Current task source: ' + taskId
      : 'Current task or question: ' + delivery.message,
    'Public group context follows. It contains no private member conversation.',
    'Earlier history may be archived or summarized. Use read_group_history for original requirements, corrections, numbers, evidence or unresolved details before relying on a summary.',
    'Archived public items: ' + String(coverage.archived.size + archived.length),
  ].join('\n') }]
  if (delivery.recoveryOf !== undefined) content.push({ type: 'text', text: 'Responsible-member blocker follow-up: ' + delivery.message })
  if (owner?.coordinationVersion === 1) {
    content.push({ type: 'text', text: ticket === undefined
      ? 'This owner message is not classified. For substantive work, use record_group_task to create work or explicitly continue an existing task. '
        + 'Do not guess an ambiguous continuation; ask the owner. Unclassified messages remain shared context so corrections are not silently lost. '
        + 'Use find_group_tasks to find older tasks. Recent task index: '
        + JSON.stringify((snapshot.chat.tickets ?? []).slice(-input.bootstrapMessageCount)
          .map(task => ({ id: task.id, ownerId: task.ownerId, goal: task.goal, state: task.state })))
      : 'Saved business task (a member turn finishing does not mean this task is accepted): ' + JSON.stringify(ticket)
        + '\nOther task bodies are omitted from this input. read_group_history can retrieve permitted originals when explicitly needed; previously retained Session context is not erased.' })
  }
  const outcomes = snapshot.deliveries.filter(candidate => candidate.id !== delivery.id && candidate.chatId === snapshot.chat.id)
    .filter((candidate) => {
      const origin = sourceOwner(snapshot, candidate)
      return (origin === undefined || allowed.has(origin.userMessage.id))
        && belongs(origin)
        && (origin?.userMessage.id === owner?.userMessage.id || candidate.state === 'unknown' || candidate.state === 'failed')
    }).map(candidate => ({ delivery_id: candidate.id, bot_id: candidate.botId, status: candidate.state,
      message_id: candidate.receipt === null ? null : 'message:' + candidate.relayMessageId, error: candidate.error }))
  content.push({ type: 'text', text: 'Actual saved group outcomes: ' + JSON.stringify(outcomes)
    + '\nAn unknown outcome does not confirm success. Verify saved work before claiming completion.' })
  for (const entry of selected) content.push({ type: 'text', text: heading(entry) }, ...entry.content)
  return { content, context: { schemaVersion: 1, rootSessionId: snapshot.chat.rootSessionId,
    deliveredIds: selected.map(entry => entry.id), archivedIds: archived } }
}

function encodeCursor(cursor: Cursor): string { return JSON.stringify(cursor) }

function decodeCursor(value: string): Cursor {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch (error) {
    throw new HarnessError('The group history cursor is invalid. Start a new history query.', 'KATCATS_CHAT_HISTORY_CURSOR', { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null || !('id' in parsed) || typeof parsed.id !== 'string'
    || !('block' in parsed) || typeof parsed.block !== 'number' || !Number.isSafeInteger(parsed.block) || parsed.block < 0
    || !('offset' in parsed) || typeof parsed.offset !== 'number' || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) {
    throw new HarnessError('The group history cursor is invalid. Start a new history query.', 'KATCATS_CHAT_HISTORY_CURSOR')
  }
  return { id: parsed.id, block: parsed.block, offset: parsed.offset }
}

/**
 * Page authorized original history newest first, preserving images and exposing exact text continuation.
 * @param input - current delivery authority, public events, parsed query and configured result/text limits.
 * @returns bounded text blocks, original image blocks and the cursor for the next page when available.
 */
export function queryGroupHistory(input: PublicHistoryInput & {
  readonly query: GroupHistoryQuery
  readonly maxResults: number
  readonly maxChars: number
}): GroupHistoryResult {
  const { query } = input
  const requested = query.ids === undefined ? undefined : new Set(query.ids)
  const keyword = query.keyword?.trim().toLocaleLowerCase()
  const all = publicHistory(input).entries.reverse().filter(entry => (requested === undefined || requested.has(entry.id))
    && (keyword === undefined || keyword.length === 0 || entry.content.some(block => block.type === 'text'
      && block.text.toLocaleLowerCase().includes(keyword))))
  const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor)
  let index = cursor === undefined ? 0 : all.findIndex(entry => entry.id === cursor.id)
  if (index < 0) throw new HarnessError('The group history cursor is outside the current query. Start a new history query.', 'KATCATS_CHAT_HISTORY_CURSOR')
  let blockIndex = cursor?.block ?? 0
  let offset = cursor?.offset ?? 0
  const first = all[index]
  const firstBlock = first?.content[blockIndex]
  if (first !== undefined && (blockIndex >= first.content.length || offset > (firstBlock?.type === 'text'
    ? firstBlock.text.length : 0))) {
    throw new HarnessError('The group history cursor is outside its original message.', 'KATCATS_CHAT_HISTORY_CURSOR')
  }
  const header = 'Saved public group history, newest first. Partial entries continue at next_cursor.\n'
  const footer = (next: string | null) => '\nnext_cursor: ' + (next === null ? 'null' : next)
  const reserve = Math.max(footer(null).length, ...all.slice(index).map(entry => footer(encodeCursor({ id: entry.id,
    block: entry.content.length, offset: Math.max(0, ...entry.content.map(block => block.type === 'text' ? block.text.length : 0)) })).length))
  const entries: GroupHistoryEntry[] = []
  const content: ContentBlock[] = [{ type: 'text', text: header }]
  let remaining = input.maxChars - header.length - reserve
  if (remaining < 0) {
    throw new HarnessError('The configured group history page is too small for its header and cursor.', 'KATCATS_CHAT_HISTORY_PAGE_TOO_SMALL')
  }
  const limit = Math.min(query.limit, input.maxResults)
  while (index < all.length && entries.length < limit) {
    const entry = all[index]
    if (entry === undefined) break
    const label = heading(entry)
    if (remaining <= label.length) break
    remaining -= label.length
    content.push({ type: 'text', text: label })
    const parts: ContentBlock[] = []
    const startedPartial = blockIndex > 0 || offset > 0
    while (blockIndex < entry.content.length) {
      const block = entry.content[blockIndex]
      if (block === undefined) break
      if (block.type !== 'text') { parts.push(block); blockIndex++; continue }
      const length = Math.min(remaining, block.text.length - offset)
      if (length > 0) parts.push({ ...block, text: block.text.slice(offset, offset + length) })
      remaining -= length
      offset += length
      if (offset < block.text.length) break
      blockIndex++
      offset = 0
    }
    const partial = startedPartial || blockIndex < entry.content.length
    entries.push({ ...entry, content: parts, partial })
    content.push(...parts)
    if (blockIndex < entry.content.length) break
    index++
    blockIndex = 0
    offset = 0
  }
  const next = all[index]
  const nextCursor = next === undefined ? null : encodeCursor({ id: next.id, block: blockIndex, offset })
  if (next !== undefined && entries.length === 0) {
    throw new HarnessError('The configured group history page is too small for this message label.', 'KATCATS_CHAT_HISTORY_PAGE_TOO_SMALL')
  }
  content.push({ type: 'text', text: footer(nextCursor) })
  return { entries, nextCursor, content }
}
