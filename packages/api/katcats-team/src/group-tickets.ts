/** Durable business work, independent of dispatch runs and conversational replies. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { HarnessError, type MessageId } from '@deepseek-ai/dsh-llm'
import type { ChatDelivery, ChatInbound, GroupTicket, GroupTicketId, RecordGroupTicket, TeamChat } from './chats-types.ts'
import type { BotId } from './types.ts'
export type { GroupTicket, GroupTicketId, RecordGroupTicket } from './chats-types.ts'

/**
 * Locate the accepted owner input through actual delegation ancestry.
 * @param inbounds - this group's accepted inputs.
 * @param deliveries - this group's retained deliveries.
 * @param delivery - the execution whose business task is needed.
 * @returns original input, or undefined for legacy coordinator work without an owner input.
 */
export function ticketOwnerInput(
  inbounds: readonly ChatInbound[], deliveries: readonly ChatDelivery[], delivery: ChatDelivery,
): ChatInbound | undefined {
  const visited = new Set<ChatDelivery['id']>()
  let current: ChatDelivery | undefined = delivery
  while (current !== undefined) {
    if (visited.has(current.id)) throw new HarnessError('Group task ancestry is cyclic.', 'KATCATS_CHAT_INVALID_SOURCE')
    visited.add(current.id)
    const source: ChatDelivery['source'] = current.source
    if (source.kind === 'owner-message') return inbounds.find(input => input.chatId === delivery.chatId && input.userMessage.id === source.messageId)
    current = source.kind === 'member-reply'
      ? deliveries.find(item => item.chatId === delivery.chatId && item.relayMessageId === source.messageId)
      : deliveries.find(item => item.chatId === delivery.chatId && item.id === source.parentDeliveryId)
  }
  return undefined
}

/**
 * Resolve a task only by saved message identity, never by text equality or latest-task inference.
 * @param chat - owning group with optional legacy task records.
 * @param input - original admitted owner input, or undefined for legacy coordinator work.
 * @returns task explicitly associated with that input, if one exists.
 */
export function ticketForInput(chat: TeamChat, input: ChatInbound | undefined): GroupTicket | undefined {
  return input === undefined ? undefined : chat.tickets?.find(task => task.messageIds.includes(input.userMessage.id))
}

/**
 * Create or continue business work from a direct recipient's explicit classification.
 * Ownership changes only when the manager records an authorized transfer after the previous owner leaves.
 * Delegated workers cannot reclassify their parent's request.
 * @param chat - current owning group.
 * @param input - accepted owner message being classified.
 * @param delivery - authorized direct recipient for this message.
 * @param request - complete task description and optional existing identity.
 * @returns replacement group and the recorded business task.
 */
export function recordGroupTicket(
  chat: TeamChat, input: ChatInbound, delivery: ChatDelivery, request: RecordGroupTicket,
): { chat: TeamChat; ticket: GroupTicket } {
  if (delivery.source.kind !== 'owner-message' || delivery.chatId !== chat.id || input.chatId !== chat.id
    || delivery.source.messageId !== input.userMessage.id || !input.recipients.includes(delivery.botId) || delivery.recoveryOf !== undefined) {
    throw new HarnessError('Only a direct recipient can classify the current owner message.', 'KATCATS_CHAT_TASK_DENIED')
  }
  const current = ticketForInput(chat, input)
  let existing = request.id === undefined ? current : chat.tickets?.find(task => task.id === request.id)
  if (request.id !== undefined && existing === undefined) throw new HarnessError('Choose an existing task in this group.', 'KATCATS_CHAT_TASK_NOT_FOUND')
  if (current !== undefined && existing?.id !== current.id) {
    throw new HarnessError('This message already belongs to another task. Keep its saved association.', 'KATCATS_CHAT_TASK_CONFLICT')
  }
  if (existing !== undefined && existing.ownerId !== delivery.botId) {
    const ownerText = input.userMessage.content.filter(part => part.type === 'text').map(part => part.text).join('\n').trim()
    if (request.takeOverOwner !== true || request.id !== existing.id || chat.managerId !== delivery.botId
      || chat.memberIds.includes(existing.ownerId) || input.userMessage.source.kind !== 'user'
      || ownerText.length === 0 || request.ownerTransferQuote?.trim() !== ownerText || request.submitDelivery === true
      || existing.goal !== request.goal || (existing.acceptance.length > 0 && JSON.stringify(existing.acceptance) !== JSON.stringify(request.acceptance))
      || (existing.financeScope ?? null) !== (input.financeScope ?? null)) {
      throw new HarnessError('Ask the recorded task owner to update this task. If that owner has left, the current group manager may take over only after the human explicitly authorizes it: pass this task_id, take_over_owner and the complete owner_transfer_quote, preserving its goal and criteria.',
        'KATCATS_CHAT_TASK_DENIED')
    }
    const reassigned = reassignGroupTicket(chat, existing.id, existing.revision, delivery.botId)
    if (reassigned === undefined) throw new HarnessError('Only unfinished tasks can be reassigned to the current group manager.', 'KATCATS_CHAT_TASK_DENIED')
    chat = reassigned
    const id = existing.id
    existing = reassigned.tickets!.find(task => task.id === id)!
  }
  if (existing?.state === 'completed') {
    throw new HarnessError('This task is complete. Record new work as a new task.', 'KATCATS_CHAT_TASK_CONFLICT')
  }
  if (request.submitDelivery === true && current?.acceptance.length === 0) {
    throw new HarnessError('This task has no recorded acceptance criteria. First call record_group_task with its task_id, concrete criteria and no submit_delivery. After satisfying them, submit the same task_id and unchanged criteria.',
      'KATCATS_CHAT_INVALID_INPUT')
  }
  if (request.submitDelivery === true && (current === undefined
    || current.goal !== request.goal || current.acceptance.length !== request.acceptance.length
    || current.acceptance.some((criterion, index) => criterion !== request.acceptance[index]))) {
    throw new HarnessError('Submit the recorded goal and acceptance criteria unchanged. Record any changes separately before delivery.',
      'KATCATS_CHAT_INVALID_INPUT')
  }
  const ticket: GroupTicket = {
    version: 1, id: existing?.id ?? brandString<GroupTicketId>('task-' + input.userMessage.id),
    ownerId: existing?.ownerId ?? delivery.botId, goal: request.goal, acceptance: request.acceptance,
    stage: request.stage, nextStep: request.nextStep,
    artifacts: request.takeOverOwner === true ? [...new Set([...(existing?.artifacts ?? []), ...request.artifacts])] : request.artifacts,
    state: 'open', blocker: null,
    ...(existing?.financeScope === undefined ? {} : { financeScope: existing.financeScope }),
    ...(existing?.financeLabel === undefined ? {} : { financeLabel: existing.financeLabel }),
    ...(request.humanReviewRequired === true || existing?.humanReviewRequired === true ? { humanReviewRequired: true } : {}),
    ...(request.submitDelivery === true ? { pendingDeliveryId: delivery.id } : {}),
    messageIds: existing === undefined ? [input.userMessage.id]
      : existing.messageIds.includes(input.userMessage.id) ? existing.messageIds : [...existing.messageIds, input.userMessage.id],
    revision: (existing?.revision ?? 0) + 1,
  }
  return { ticket, chat: { ...chat, tickets: [...(chat.tickets ?? []).filter(value => value.id !== ticket.id), ticket] } }
}

/**
 * Require an explicit task submission at turn completion, after file presentation is allowed.
 * @param chat - Owning group with the latest task records.
 * @param input - Original accepted owner message for this execution.
 * @param delivery - Member execution about to finish.
 * @returns One corrective instruction, or undefined for a submitted task or non-task reply.
 */
export function groupTicketCompletionIssue(chat: TeamChat, input: ChatInbound | undefined,
  delivery: ChatDelivery): string | undefined {
  if (input?.coordinationVersion !== 1 || delivery.source.kind !== 'owner-message' || delivery.recoveryOf !== undefined) return undefined
  const task = ticketForInput(chat, input)
  if (task === undefined || task.state === 'completed' || input.taskAcceptance?.kind === 'completed'
    || task.pendingDeliveryId === delivery.id) return undefined
  if (task.acceptance.length === 0) {
    return `Task ${task.id} has no recorded acceptance criteria. Call record_group_task with this task_id and concrete criteria before submitting; do not invent completed checks. Then meet those criteria, finish any required review, present final files, and submit_delivery with the same task_id and unchanged criteria.`
  }
  return `Task ${task.id} has not been submitted for delivery. After meeting its saved criteria and required review, register final files with present and call record_group_task with this task_id, unchanged goal and acceptance criteria, and submit_delivery: true. If work remains blocked, use report_group_blocker and explain the next step; do not claim completion.`
}

/**
 * Reassign unfinished work only after an explicit owner selection has been authorized by the caller.
 * @param chat - Group containing the task and current members.
 * @param taskId - Exact unfinished task chosen by the owner.
 * @param expectedRevision - Revision the owner inspected before confirming.
 * @param newOwnerId - Current group member explicitly selected to continue work.
 * @returns Replacement group preserving saved scope and task evidence, or undefined for a stale selection.
 */
export function reassignGroupTicket(chat: TeamChat, taskId: GroupTicketId, expectedRevision: number,
  newOwnerId: BotId): TeamChat | undefined {
  const task = chat.tickets?.find(item => item.id === taskId)
  if (task === undefined || task.revision !== expectedRevision || !chat.memberIds.includes(newOwnerId)
    || (task.state !== 'open' && task.state !== 'blocked')) return undefined
  if (task.ownerId === newOwnerId) return chat
  const { pendingDeliveryId: _pending, delivery: _delivery, ...record } = task
  const reassigned: GroupTicket = { ...record, ownerId: newOwnerId, revision: task.revision + 1 }
  return { ...chat, tickets: chat.tickets!.map(item => item === task ? reassigned : item) }
}

/**
 * Complete submitted work after publication, or retain it for explicitly requested human acceptance.
 * @param chat - Group owning the saved task.
 * @param input - Accepted owner message that led to the delivery.
 * @param delivery - Completed delivery whose public relay has been flushed.
 * @returns The updated group, or the original group for an unrelated result.
 */
export function markGroupTicketDelivered(chat: TeamChat, input: ChatInbound | undefined, delivery: ChatDelivery): TeamChat {
  const ticket = ticketForInput(chat, input)
  const receipt = delivery.receipt
  if (ticket?.state !== 'open' || ticket.pendingDeliveryId !== delivery.id || ticket.ownerId !== delivery.botId
    || chat.id !== delivery.chatId || delivery.source.kind !== 'owner-message' || delivery.recoveryOf !== undefined
    || delivery.source.messageId !== input?.userMessage.id || ticket.messageIds.at(-1) !== delivery.source.messageId
    || ticket.acceptance.length === 0 || delivery.state !== 'completed' || !delivery.relayed || receipt === null) {
    return chat
  }
  const { pendingDeliveryId: _pending, ...record } = ticket
  const delivered: GroupTicket = {
    ...record, state: ticket.humanReviewRequired === true ? 'delivered' : 'completed', revision: ticket.revision + 1,
    ...(ticket.humanReviewRequired === true ? {} : { completedAt: Date.now(), completionKind: 'criteria' as const }),
    delivery: { deliveryId: delivery.id, outputMessageId: receipt.outputMessageId, relayMessageId: delivery.relayMessageId },
  }
  return { ...chat, tickets: chat.tickets?.map(task => task === ticket ? delivered : task) ?? [delivered] }
}

/**
 * Save owner acceptance of the exact delivered revision that was inspected.
 * @param chat - Group owning the task.
 * @param taskId - Selected task identity.
 * @param expectedRevision - Revision displayed to the owner before confirmation.
 * @param completedAt - UTC acceptance time in epoch milliseconds.
 * @param acceptanceMessageId - Saved owner message that accepted the result from chat, when present.
 * @returns The updated group, the original group for an identical acceptance retry, or undefined for a stale or ineligible selection.
 */
export function completeGroupTicket(chat: TeamChat, taskId: GroupTicketId, expectedRevision: number, completedAt: number,
  acceptanceMessageId?: MessageId): TeamChat | undefined {
  const ticket = chat.tickets?.find(task => task.id === taskId)
  if (ticket?.state === 'completed' && ticket.revision === expectedRevision + 1) return chat
  if (ticket?.state !== 'delivered' || ticket.delivery === undefined || ticket.revision !== expectedRevision) return undefined
  const completed: GroupTicket = { ...ticket, state: 'completed', completedAt, completionKind: 'owner', revision: ticket.revision + 1,
    messageIds: acceptanceMessageId === undefined ? ticket.messageIds : [...ticket.messageIds, acceptanceMessageId] }
  return { ...chat, tickets: chat.tickets?.map(task => task === ticket ? completed : task) ?? [completed] }
}
