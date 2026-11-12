/** Rebuild completion admission from the exact member input and saved tool results. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { HarnessError, type MessageId, type ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { z } from 'zod'
import type { ChatDelivery, ChatDeliveryId } from './chats-types.ts'
import type { BotId } from './types.ts'
import { GroupWorkGate } from './group-work.ts'
import { groupReviewCandidateSchema, groupReviewReceiptSchema } from './group-review.ts'
import { FINANCE_ORM_UNKNOWN_OUTCOME } from './finance-orm-tool.ts'

const policy = z.object({ reason: z.enum(['none', 'financial-conclusion', 'data-change', 'explicit-review']),
  reviewer_bot_id: z.string().min(1).optional() }).strict()
const planResult = z.object({ chat_id: z.string(), own_task: z.string(),
  assignments: z.array(z.object({ bot_id: z.string(), message: z.string() }).strict()), review: policy.optional() })
const memberResult = z.object({ delivery_id: z.string(), bot_id: z.string(), status: z.enum(['completed', 'passed', 'failed']),
  review_candidate: groupReviewCandidateSchema.optional(), review: groupReviewReceiptSchema.optional() })

/**
 * Restore one delivery's decision without accepting results from another turn or unconfirmed child.
 * @param required - whether this member directly owns the user's substantive task.
 * @param eligible - other current ordinary group members.
 * @param deliveryId - exact delivery being evaluated.
 * @param inputMessageId - exact input that starts the owned worker turn.
 * @param events - persisted executor events, including tool presentation metadata.
 * @param deliveries - durable group deliveries used to verify each actual child receipt.
 * @returns the same gate used for live completion; current file contents still require verification.
 */
export function restoreGroupWorkGate(
  required: boolean, eligible: readonly BotId[], deliveryId: ChatDeliveryId, inputMessageId: MessageId,
  events: readonly SessionEvent[], deliveries: readonly ChatDelivery[],
): GroupWorkGate {
  const gate = new GroupWorkGate(required, eligible, { policy: 'review-v1', deliveryId })
  const calls = new Map<ToolCallId, string>()
  let currentTurn: number | undefined
  let ownedTurn: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') currentTurn = event.data.turn
    if (event.type === 'user/message' && event.data.id === inputMessageId) ownedTurn = currentTurn
    if (ownedTurn === undefined) continue
    if (event.type === 'tool/call' && event.data.turn === ownedTurn) {
      calls.set(event.data.callId, event.data.name)
      gate.denial(event.data.name)
      if (event.data.name === 'request_group_member') {
        let args: unknown
        try { args = JSON.parse(event.data.arguments) } catch (error) {
          throw new HarnessError('The saved member request cannot be read.', 'KATCATS_CHAT_REVIEW_UNCONFIRMED', { cause: error })
        }
        if (typeof args === 'object' && args !== null && 'review_candidate' in args) gate.invalidateReview()
      }
    }
    if (event.type === 'tool/result' && event.data.turn === ownedTurn && event.data.error?.code === FINANCE_ORM_UNKNOWN_OUTCOME) {
      gate.markUnknownOperation()
    }
    if (event.type !== 'tool/result' || event.data.turn !== ownedTurn || event.data.message.isError === true) continue
    const name = calls.get(event.data.message.source.callId)
    if (name === 'plan_group_work') {
      const value = planResult.safeParse(event.data.meta)
      if (!value.success) throw new HarnessError('The saved group decision cannot be verified.', 'KATCATS_CHAT_REVIEW_UNCONFIRMED')
      const plan = value.data
      gate.decide({ ownTask: plan.own_task,
        assignments: plan.assignments.map(task => ({ botId: brandString<BotId>(task.bot_id), message: task.message })),
        ...(plan.review === undefined ? {} : { review: { reason: plan.review.reason,
          ...(plan.review.reviewer_bot_id === undefined ? {} : { reviewerBotId: brandString<BotId>(plan.review.reviewer_bot_id) }) } }),
      })
    }
    if (name !== 'request_group_member') continue
    const value = memberResult.safeParse(event.data.meta)
    if (!value.success) throw new HarnessError('The saved group member result cannot be verified.', 'KATCATS_CHAT_REVIEW_UNCONFIRMED')
    const result = value.data
    if (result.status !== 'completed') continue
    const child = deliveries.find(item => item.id === result.delivery_id && item.botId === result.bot_id
      && item.state === 'completed' && item.receipt !== null && item.source.kind === 'tool'
      && item.source.parentDeliveryId === deliveryId && item.source.callId === event.data.message.source.callId)
    if (child === undefined) throw new HarnessError('The actual group member receipt is missing or unconfirmed.', 'KATCATS_CHAT_REVIEW_UNCONFIRMED')
    // A review child is not the member's separately assigned business result.
    if (result.review_candidate === undefined && result.review === undefined) gate.receive(child.botId)
    if (result.review_candidate !== undefined) gate.beginReview(child.botId, result.review_candidate)
    if (result.review !== undefined) {
      if (result.review.deliveryId !== child.id || result.review.reviewerId !== child.botId) {
        throw new HarnessError('The saved review identifies another member execution.', 'KATCATS_CHAT_REVIEW_UNCONFIRMED')
      }
      gate.receiveReview(result.review)
    }
  }
  return gate
}
