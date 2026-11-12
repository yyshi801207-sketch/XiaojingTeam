/** Model-classified owner acceptance, constrained to a previously published task revision. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { HarnessError, type MessageId } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ChatDelivery, ChatInbound, GroupTaskAcceptance, GroupTicket, GroupTicketId, TeamChat } from './chats-types.ts'
import { completeGroupTicket } from './group-tickets.ts'

/** Exact delivered task selected from an actual owner acceptance message. */
export interface GroupSemanticAcceptanceRequest {
  readonly taskId: GroupTicketId
  readonly expectedRevision: number
  /** Full text of the current owner message, not a selected affirmative fragment. */
  readonly acceptanceQuote: string
}

/** Persisted execution and transcript evidence checked under the chat mutation lock. */
export interface GroupSemanticAcceptanceContext {
  readonly chat: TeamChat
  readonly input: ChatInbound
  readonly delivery: ChatDelivery
  readonly deliveries: readonly ChatDelivery[]
  /** Public transcript message identities in their committed event order. */
  readonly publishedMessageIds: readonly MessageId[]
  readonly currentFinanceScope: string | null
  readonly request: GroupSemanticAcceptanceRequest
  readonly completedAt: number
}

/**
 * Accept an earlier delivered revision using the direct recipient's interpretation of the owner message.
 * Intent is classified by the model; this check enforces source, scope, revision and publication order.
 * @param context - Current committed group state and actual owner message.
 * @returns Group and acceptance outcome to persist atomically with the original input.
 */
export function acceptGroupTaskFromMessage(context: GroupSemanticAcceptanceContext): {
  chat: TeamChat; ticket: GroupTicket; acceptance: GroupTaskAcceptance
} {
  const { chat, input, delivery, deliveries, publishedMessageIds, currentFinanceScope, request } = context
  const text = input.userMessage.content.filter(part => part.type === 'text').map(part => part.text).join('\n').trim()
  if (input.chatId !== chat.id || delivery.chatId !== chat.id || input.state !== 'published'
    || input.userMessage.source.kind !== 'user' || delivery.source.kind !== 'owner-message'
    || delivery.source.messageId !== input.userMessage.id || delivery.recoveryOf !== undefined
    || !input.recipients.includes(delivery.botId) || delivery.state !== 'running'
    || text.length === 0 || request.acceptanceQuote.trim() !== text) {
    throw new HarnessError('Use only the complete current owner message to accept a previously delivered task.', 'KATCATS_CHAT_TASK_DENIED')
  }
  const task = chat.tickets?.find(item => item.id === request.taskId)
  if (task === undefined) throw new HarnessError('Choose an existing delivered task in this group.', 'KATCATS_CHAT_TASK_NOT_FOUND')
  if (input.financeScope !== currentFinanceScope || (task.financeScope ?? null) !== currentFinanceScope) {
    throw new HarnessError('This confirmation and task must belong to the currently connected ledger.', 'KATCATS_CHAT_TASK_CONFLICT')
  }
  if (input.taskAcceptance?.kind === 'completed' && input.taskAcceptance.taskId === task.id
    && task.state === 'completed' && task.revision === request.expectedRevision + 1
    && task.messageIds.includes(input.userMessage.id)) {
    return { chat, ticket: task, acceptance: input.taskAcceptance }
  }
  if (input.taskAcceptance !== undefined || task.state !== 'delivered' || task.delivery === undefined
    || task.revision !== request.expectedRevision || task.messageIds.includes(input.userMessage.id)) {
    throw new HarnessError('This task is not the unchanged delivery awaiting acceptance. Read the task index again.', 'KATCATS_CHAT_TASK_CONFLICT')
  }
  const receipt = deliveries.find(item => item.id === task.delivery?.deliveryId && item.chatId === chat.id)
  const relayIndex = publishedMessageIds.indexOf(task.delivery.relayMessageId)
  const inputIndex = publishedMessageIds.indexOf(input.userMessage.id)
  if (receipt?.state !== 'completed' || !receipt.relayed || receipt.receipt?.outputMessageId !== task.delivery.outputMessageId
    || receipt.relayMessageId !== task.delivery.relayMessageId || relayIndex < 0 || inputIndex <= relayIndex
    || deliveries.some(item => item.chatId === chat.id && item.id !== delivery.id
      && (item.state === 'accepted' || item.state === 'running'))) {
    throw new HarnessError('Wait for a published result and finished group work before accepting it. Ask the owner to confirm the specific result when unclear.',
      'KATCATS_CHAT_TASK_CONFLICT')
  }
  const updated = completeGroupTicket(chat, task.id, request.expectedRevision, context.completedAt, input.userMessage.id)
  const completed = updated?.tickets?.find(item => item.id === task.id)
  if (updated === undefined || completed === undefined) throw new Error('Validated task acceptance could not be applied')
  return { chat: updated, ticket: completed, acceptance: { kind: 'completed', taskId: task.id, goal: task.goal } }
}

/**
 * Offer semantic acceptance without starting a second classifier or trusting assistant completion text.
 * @param admit - Validate the current execution and cancellation.
 * @param accept - Persist acceptance under the group mutation lock.
 * @returns Tool whose call and outcome remain in the member Session log.
 */
export function createGroupSemanticAcceptanceTool(admit: (exec: ToolRunContext) => void,
  accept: (request: GroupSemanticAcceptanceRequest, exec: ToolRunContext) => Promise<GroupTicket>): ToolDefinition {
  return defineTool({
    name: 'accept_group_task',
    description: 'Record the human owner\'s clear acceptance of an already published group task. Understand the CURRENT original owner message in context; do not require a fixed phrase. Read find_group_tasks to select the exact delivered task and revision. Use only for an independent acceptance instruction, never an assistant\'s own claim, a delegated message, thanks alone, a proposal, a conditional or negative response, or confirmation of a different operation. For tasks requiring human review, the owner must clearly confirm they reviewed and accepted this result. If the meaning or target is ambiguous, ask the owner to choose the task and confirm acceptance, or use the task archive confirmation; do not guess. This does not authorize Odoo writes or approve a draft. Do not create or submit a new task for an acceptance-only message.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Previously delivered task in this group and current ledger.' },
      expected_revision: { type: 'number', required: true, description: 'Exact delivered revision read from the task index.' },
      acceptance_quote: { type: 'string', required: true, description: 'Full original text of the current human owner message, copied verbatim. Never quote only an affirmative fragment.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      task_id: { type: 'string', required: true }, revision: { type: 'number', required: true },
      state: { type: 'string', required: true }, goal: { type: 'string', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }], presentationMeta: (_args, value) => value },
    execute: async (args, exec) => {
      admit(exec)
      if (Object.keys(args).some(key => !['task_id', 'expected_revision', 'acceptance_quote'].includes(key))
        || args.task_id.trim().length === 0 || args.acceptance_quote.trim().length === 0
        || !Number.isSafeInteger(args.expected_revision) || args.expected_revision <= 0) {
        throw new HarnessError('Provide the delivered task ID, exact positive revision and complete owner acceptance message.', 'KATCATS_CHAT_INVALID_INPUT')
      }
      const task = await accept({ taskId: brandString<GroupTicketId>(args.task_id.trim()),
        expectedRevision: args.expected_revision, acceptanceQuote: args.acceptance_quote }, exec)
      return { task_id: task.id, revision: task.revision, state: task.state, goal: task.goal }
    },
    presentCall: () => ({ card: 'generic', title: 'Record owner acceptance', kind: 'edit' }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'Acceptance was not recorded' : 'Owner acceptance recorded', content: result.content }),
  })
}
