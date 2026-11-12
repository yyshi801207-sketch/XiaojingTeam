/** Verify file and card ownership against the original completed group turn. */
import type { MessageSourceMap, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { z } from 'zod'
import type {} from './chats-messages.ts'

type Relay = MessageSourceMap['katcats-group-relay']

function claimedTurn(relay: Relay, events: Iterable<SessionEvent>): number | undefined {
  let turn: number | undefined
  let claimed: number | undefined
  let output = false
  for (const event of events) {
    if (event.type === 'turn/start') { turn = event.data.turn; claimed = undefined; output = false }
    if (event.type === 'user/message' && event.data.id === relay.inputMessageId) {
      const source = event.data.source
      if (source.kind === 'katcats-group-task' && source.chatId === relay.chatId
        && source.deliveryId === relay.deliveryId && source.runId === relay.runId
        && source.generation === relay.generation && source.target.botId === relay.sender.botId) claimed = turn
    }
    if (claimed === undefined) continue
    if (event.type === 'assistant/message' && event.data.turn === claimed && event.data.interrupted !== true) {
      output = event.data.message.id === relay.outputMessageId
        && !event.data.message.content.some(block => block.type === 'tool-call')
    }
    if (event.type === 'turn/end' && event.data.turn === claimed && output && event.data.reason.kind === 'completed') return claimed
  }
  return undefined
}

/**
 * Match the persisted group claim to the exact completed closing message.
 * @param relay - Persisted group relay source coordinates.
 * @param events - Original executor's durable events in sequence order.
 * @returns Whether the claimed turn completed with this exact assistant output.
 */
export function groupFileClaimMatches(relay: Relay, events: Iterable<SessionEvent>): boolean {
  return claimedTurn(relay, events) !== undefined
}

const decision = z.object({ review: z.object({
  reason: z.enum(['none', 'financial-conclusion', 'data-change', 'explicit-review']), reviewer_bot_id: z.string().optional(),
}).optional() })
const approval = z.object({
  status: z.literal('completed'), delivery_id: z.string(), bot_id: z.string(),
  review_candidate: z.object({ version: z.string(), files: z.array(z.object({ path: z.string(), sha256: z.string() })) }),
  review: z.object({ parentDeliveryId: z.string(), deliveryId: z.string(), reviewerId: z.string(),
    candidateVersion: z.string(), verdict: z.literal('approved') }),
})
const card = z.object({ kind: z.literal('visualize'), path: z.string().min(1), fragment: z.string().min(1) })

function pathKey(path: string): string { return path.replaceAll('\\', '/') }

/**
 * Select the last successful card per path from the verified member turn.
 * A task with independent review can publish only the exact bytes in its approved candidate.
 * @param relay - Persisted group relay source coordinates.
 * @param events - Original executor's durable events in sequence order.
 * @returns Tool call identities that the group can display through the visualization provider.
 */
export async function groupVisualizationCallIds(relay: Relay, events: readonly SessionEvent[]): Promise<readonly ToolCallId[]> {
  const turn = claimedTurn(relay, events)
  if (turn === undefined) return []
  const input = events.find(event => event.type === 'user/message' && event.data.id === relay.inputMessageId)
  if (input?.type !== 'user/message' || input.data.source.kind !== 'katcats-group-task' || input.data.source.reviewRequest !== undefined) return []
  const calls = new Map<ToolCallId, string>()
  const cards = new Map<string, { id: ToolCallId; fragment: string }>()
  let review: z.infer<typeof decision>['review']
  let approved: z.infer<typeof approval> | undefined
  for (const event of events) {
    if (event.type === 'tool/call' && event.data.turn === turn) {
      calls.set(event.data.callId, event.data.name)
      if (event.data.name === 'request_group_member') {
        let args: unknown
        try { args = JSON.parse(event.data.arguments) } catch { return [] }
        if (typeof args === 'object' && args !== null && 'review_candidate' in args) approved = undefined
      }
    }
    if (event.type !== 'tool/result' || event.data.turn !== turn || event.data.message.isError === true) continue
    const id = event.data.message.source.callId
    const name = calls.get(id)
    if (name === 'plan_group_work') {
      const parsed = decision.safeParse(event.data.meta)
      if (!parsed.success) return []
      review = parsed.data.review
    } else if (name === 'request_group_member') {
      const parsed = approval.safeParse(event.data.meta)
      if (parsed.success) approved = parsed.data
    } else if (name === 'visualize') {
      const parsed = card.safeParse(event.data.meta)
      if (parsed.success) cards.set(pathKey(parsed.data.path), { id, fragment: parsed.data.fragment })
    }
  }
  if (review === undefined || review.reason === 'none') return [...cards.values()].map(item => item.id)
  if (approved === undefined || approved.review.parentDeliveryId !== relay.deliveryId
    || approved.review.deliveryId !== approved.delivery_id || approved.review.reviewerId !== approved.bot_id
    || approved.review.reviewerId !== review.reviewer_bot_id || approved.review.candidateVersion !== approved.review_candidate.version
    || globalThis.crypto?.subtle === undefined) return []
  const allowed: ToolCallId[] = []
  for (const file of approved.review_candidate.files) {
    const item = cards.get(pathKey(file.path))
    if (item === undefined) continue
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(item.fragment))
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    if (sha256 === file.sha256) allowed.push(item.id)
  }
  return allowed
}
