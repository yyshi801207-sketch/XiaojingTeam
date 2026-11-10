/** Durable business work, independent of dispatch runs and conversational replies. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ChatDelivery, ChatInbound, GroupTicket, GroupTicketId, RecordGroupTicket, TeamChat } from './chats-types.ts'
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
 * Existing task ownership is preserved. Delegated workers cannot reclassify their parent's request.
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
    || !input.recipients.includes(delivery.botId) || delivery.recoveryOf !== undefined) {
    throw new HarnessError('Only a direct recipient can classify the current owner message.', 'KATCATS_CHAT_TASK_DENIED')
  }
  const current = ticketForInput(chat, input)
  const existing = request.id === undefined ? current : chat.tickets?.find(task => task.id === request.id)
  if (request.id !== undefined && existing === undefined) throw new HarnessError('Choose an existing task in this group.', 'KATCATS_CHAT_TASK_NOT_FOUND')
  if (current !== undefined && existing?.id !== current.id) {
    throw new HarnessError('This message already belongs to another task. Keep its saved association.', 'KATCATS_CHAT_TASK_CONFLICT')
  }
  if (existing !== undefined && existing.ownerId !== delivery.botId) {
    throw new HarnessError('Ask the recorded task owner to update this task.', 'KATCATS_CHAT_TASK_DENIED')
  }
  const ticket: GroupTicket = {
    version: 1, id: existing?.id ?? brandString<GroupTicketId>('task-' + input.userMessage.id),
    ownerId: existing?.ownerId ?? delivery.botId, goal: request.goal, acceptance: request.acceptance,
    stage: request.stage, nextStep: request.nextStep, artifacts: request.artifacts,
    state: 'open', blocker: null,
    messageIds: existing === undefined ? [input.userMessage.id]
      : existing.messageIds.includes(input.userMessage.id) ? existing.messageIds : [...existing.messageIds, input.userMessage.id],
    revision: (existing?.revision ?? 0) + 1,
  }
  return { ticket, chat: { ...chat, tickets: [...(chat.tickets ?? []).filter(value => value.id !== ticket.id), ticket] } }
}
