/** Publish settled member speech before its tools can request human approval. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError, type MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ChatDelivery, ChatSender } from './chats-types.ts'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from './chats-messages.ts'

interface ProgressCursor {
  turn: number | undefined
  input: { delivery: ChatDelivery; sender: ChatSender; turn: number } | undefined
}

function observe(cursor: ProgressCursor, delivery: ChatDelivery | undefined, event: SessionEvent): UserMessage | undefined {
  if (event.type === 'turn/start') {
    cursor.turn = event.data.turn
    cursor.input = undefined
  }
  if (event.type === 'user/message' && delivery !== undefined && event.data.id === delivery.inputMessageId) {
    const source = event.data.source
    if (source.kind === 'katcats-group-task' && source.chatId === delivery.chatId
      && source.runId === delivery.runId && source.generation === delivery.generation
      && source.deliveryId === delivery.id && source.target.botId === delivery.botId && cursor.turn !== undefined) {
      cursor.input = { delivery, sender: source.target, turn: cursor.turn }
    }
  }
  const input = cursor.input
  if (input === undefined || event.type !== 'assistant/message' || event.data.turn !== input.turn
    || event.data.interrupted === true || !event.data.message.content.some(block => block.type === 'tool-call')) return undefined
  const content = event.data.message.content.filter(block => block.type === 'text')
  if (!content.some(block => block.text.trim().length > 0)) return undefined
  const owned = input.delivery
  return { id: event.data.message.id, role: 'user', content, source: {
    kind: 'katcats-group-relay', form: 'relay', schemaVersion: 1,
    chatId: owned.chatId, runId: owned.runId, generation: owned.generation, deliveryId: owned.id,
    sender: input.sender, executionSessionId: owned.executorSessionId,
    inputMessageId: owned.inputMessageId, outputMessageId: event.data.message.id,
  } }
}

/**
 * Recover public tool-bearing messages from the exact delivery's durable worker turn.
 * Reasoning, interrupted streams, private turns, and final replies are excluded.
 * @param delivery - saved group execution and its actual input identity.
 * @param events - that execution Session's persisted events in sequence order.
 * @returns original assistant IDs and text as group relays; publication remains idempotent by ID.
 */
export function memberProgressMessages(delivery: ChatDelivery, events: readonly SessionEvent[]): readonly UserMessage[] {
  const cursor: ProgressCursor = { turn: undefined, input: undefined }
  const messages: UserMessage[] = []
  for (const event of events) {
    const message = observe(cursor, delivery, event)
    if (message !== undefined) messages.push(message)
  }
  return messages
}

/** Dependencies owned by one live group worker, with no background publication task. */
export interface MemberProgressOptions {
  /** Return the current owned delivery; ordinary or unowned execution returns undefined. */
  readonly current: () => ChatDelivery | undefined
  /** Flush the actual worker Session before any of its public text reaches the group. */
  readonly flush: () => Promise<boolean>
  /** Append and flush the exact original message through the group's serialized transcript writer. */
  readonly publish: (delivery: ChatDelivery, message: UserMessage) => Promise<void>
}

/**
 * Incrementally collect settled public speech and await publication before tool approval or dispatch.
 * The owning worker drains an in-flight hook during cancellation; disposal removes future listeners.
 * @param agent - actual group executor; its private Bot Session is never observed.
 * @param options - current ownership, worker durability, and exact group publication callbacks.
 * @returns the disposer for both scoped listeners.
 */
export function installMemberProgress(agent: Agent, options: MemberProgressOptions): () => void {
  const cursor: ProgressCursor = { turn: undefined, input: undefined }
  const pending = new Map<MessageId, { delivery: ChatDelivery; message: UserMessage }>()
  const stopEvents = agent.ctx.on('session/event', (session, event) => {
    if (session.id !== agent.id) return
    const delivery = options.current()
    const message = observe(cursor, delivery?.executorSessionId === agent.id ? delivery : undefined, event)
    const input = cursor.input
    if (message !== undefined && input !== undefined) pending.set(message.id, { delivery: input.delivery, message })
  })
  const stopTools = agent.ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.agent !== agent || pending.size === 0) return next()
    const batch = [...pending]
    try {
      if (!await options.flush()) throw new Error('The member Session has no durability owner')
      for (const [id, value] of batch) {
        await options.publish(value.delivery, value.message)
        pending.delete(id)
      }
    } catch (error) {
      throw new HarnessError('The member reply could not be confirmed in the group. Its tool was not started; inspect the group before retrying.',
        'KATCATS_CHAT_DURABILITY_UNCONFIRMED', { cause: error })
    }
    return next()
  }, { prepend: true })
  return () => { stopEvents(); stopTools(); pending.clear() }
}
