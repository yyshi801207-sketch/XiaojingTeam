/** Verify final group output against its original durable worker turn. */
import type { MessageSourceMap } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {} from './chats-messages.ts'

/**
 * Match a real group claim and completed closing reply without trusting path text.
 * @param relay - Persisted group relay source coordinates.
 * @param events - Original executor's durable events in sequence order.
 * @returns Whether the claimed turn completed with this exact assistant output.
 */
export function groupFileClaimMatches(relay: MessageSourceMap['katcats-group-relay'], events: Iterable<SessionEvent>): boolean {
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
    if (event.type === 'turn/end' && event.data.turn === claimed && output && event.data.reason.kind === 'completed') return true
  }
  return false
}
