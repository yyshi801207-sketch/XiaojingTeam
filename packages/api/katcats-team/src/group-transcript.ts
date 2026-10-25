/** Append real group messages without driving the group's container Agent. */
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { HarnessError, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatDelivery, ChatSender, TeamChat } from './chats-types.ts'
import type { TeamBot } from './types.ts'
import type { ChatTaskActor, ChatTaskEventId, ChatTaskLifecycle, ChatTaskMember, ChatTaskStatus } from './chats-task-events.ts'
import type {} from './chats-messages.ts'

type GroupContainer = Pick<TeamChat, 'id' | 'rootSessionId'>

function member(id: TeamBot['id'], bots: readonly TeamBot[], recorded?: ChatSender): ChatTaskMember {
  const bot = bots.find(candidate => candidate.id === id)
  return { kind: 'member', botId: id, sender: recorded ?? (bot === undefined ? null
    : { botId: bot.id, name: bot.name, role: bot.role, avatar: bot.avatar }) }
}

function states(delivery: ChatDelivery): readonly ChatTaskStatus[] {
  switch (delivery.state) {
    case 'accepted': return ['queued']
    case 'running': return ['queued', 'started']
    case 'completed': return ['queued', 'started', 'completed']
    case 'passed': return ['queued', 'started', 'passed']
    case 'unknown': return ['queued', 'started', 'unknown']
    case 'failed': return ['queued', delivery.error?.code === 'stopped' || delivery.error?.code === 'superseded'
      || delivery.error?.code === 'member-removed' ? 'cancelled' : 'failed']
    default: return assertNever(delivery.state)
  }
}

function taskIdentity(chat: GroupContainer, delivery: ChatDelivery, deliveries: readonly ChatDelivery[], bots: readonly TeamBot[]) {
  const source = delivery.source
  const parent = source.kind === 'tool' ? deliveries.find(item => item.id === source.parentDeliveryId)
    : source.kind === 'member-reply' ? deliveries.find(item => item.relayMessageId === source.messageId) : undefined
  const actor: ChatTaskActor = source.kind === 'owner-message' ? { kind: 'owner' }
    : parent === undefined ? { kind: 'legacy-coordinator' } : member(parent.botId, bots, parent.receipt?.sender)
  return { schemaVersion: 1 as const, chatId: chat.id, rootSessionId: chat.rootSessionId,
    runId: delivery.runId, generation: delivery.generation, deliveryId: delivery.id,
    parentDeliveryId: parent?.id ?? null, actor, target: member(delivery.botId, bots, delivery.receipt?.sender), message: delivery.message }
}

function busy(): HarnessError {
  return new HarnessError('This group has an earlier conversation running or queued. Pause or stop it before publishing new group messages.',
    'KATCATS_CHAT_CONTAINER_BUSY')
}

function requireEmptyInbox(agent: Agent): void {
  if (agent.inbox.nextStep.length > 0 || agent.inbox.nextTurn.length > 0) throw busy()
}

function requireClosedTurn(events: readonly SessionEvent[]): void {
  let open = false
  for (const event of events) {
    if (event.type === 'turn/start') open = true
    else if (event.type === 'turn/end') open = false
  }
  if (open) throw busy()
}

/**
 * Serialize group transcript writes through public idle maintenance and flush each accepted message.
 * An append followed by an unconfirmed flush remains in memory; retrying its exact ID flushes it again.
 * The caller owns inbound authorization, member execution, pending intents, and shutdown ordering.
 * @param ctx - Host context carrying Agent and Session controller services.
 */
export class GroupTranscript {
  private readonly tails = new Map<SessionId, Promise<void>>()

  constructor(private readonly ctx: Context) {}

  /**
   * Persist an already admitted human message without queueing or waking the container.
   * @param chat - group identity and its existing container Session.
   * @param message - actual human message with a stable ID retained by the caller's durable intent.
   * @returns fulfillment only after the message's Session flush succeeds.
   */
  publishUser(chat: GroupContainer, message: UserMessage): Promise<void> {
    if (message.source.kind !== 'user') {
      return Promise.reject(new HarnessError('A group user message must retain its human source.', 'KATCATS_CHAT_MESSAGE_MISMATCH'))
    }
    return this.publish(chat, message)
  }

  /**
   * Persist a real completed member receipt under its stable relay ID without a coordinator request.
   * @param chat - receiving group and its existing container Session.
   * @param delivery - confirmed member outcome whose sender and output identities are retained.
   * @param message - relay carrying exactly that outcome's text and recorded source.
   * @returns fulfillment only after the receipt's Session flush succeeds.
   */
  publishReceipt(chat: GroupContainer, delivery: ChatDelivery, message: UserMessage): Promise<void> {
    const receipt = delivery.receipt
    const source = message.source
    if (delivery.chatId !== chat.id || delivery.state !== 'completed' || receipt === null || receipt.sender.botId !== delivery.botId
      || message.id !== delivery.relayMessageId || source.kind !== 'katcats-group-relay'
      || source.chatId !== chat.id || source.deliveryId !== delivery.id
      || source.runId !== delivery.runId || source.generation !== delivery.generation
      || source.executionSessionId !== delivery.executorSessionId || source.inputMessageId !== delivery.inputMessageId
      || source.outputMessageId !== receipt.outputMessageId || !isDeepStrictEqual(source.sender, receipt.sender)
      || !isDeepStrictEqual(message.content, [{ type: 'text', text: receipt.text }])) {
      return Promise.reject(new HarnessError('The group relay does not match its confirmed member result.', 'KATCATS_CHAT_MESSAGE_MISMATCH'))
    }
    return this.publish(chat, message)
  }

  /**
   * Publish a persisted public member text segment before that member's tools run.
   * The caller validates the segment against its claimed worker turn; this is not a completion receipt.
   * @param chat - exact group container receiving the public segment.
   * @param delivery - actual dispatched task whose worker produced the segment.
   * @param message - text-only relay retaining the worker's actual assistant message identity.
   * @returns resolution after an idempotent transcript append and confirmed flush.
   */
  publishMemberProgress(chat: GroupContainer, delivery: ChatDelivery, message: UserMessage): Promise<void> {
    const source = message.source
    if (delivery.chatId !== chat.id || delivery.state === 'accepted' || source.kind !== 'katcats-group-relay'
      || source.chatId !== chat.id || source.deliveryId !== delivery.id || source.runId !== delivery.runId
      || source.generation !== delivery.generation || source.executionSessionId !== delivery.executorSessionId
      || source.inputMessageId !== delivery.inputMessageId || source.sender.botId !== delivery.botId
      || message.id !== source.outputMessageId || message.content.some(block => block.type !== 'text')
      || !message.content.some(block => block.type === 'text' && block.text.trim().length > 0)) {
      return Promise.reject(new HarnessError('The group progress does not match its dispatched member task.', 'KATCATS_CHAT_MESSAGE_MISMATCH'))
    }
    return this.publish(chat, message)
  }

  /**
   * Publish committed directory states as stable, non-speaking group activity.
   * Missing states are reconstructed from the durable delivery; existing identities stay fixed.
   * @param chat - the exact group container receiving these records.
   * @param changed - committed deliveries whose observed states need publication.
   * @param deliveries - this group's journal, including parents authorizing member handoffs.
   * @param bots - current Bot identities; historical receipt identities remain usable after removal.
   * @param recovering - whether this is cold journal reconciliation rather than a live transition.
   * @returns fulfillment only after every missing state and the transcript flush succeed.
   */
  publishTaskStates(
    chat: GroupContainer, changed: readonly ChatDelivery[], deliveries: readonly ChatDelivery[],
    bots: readonly TeamBot[], recovering = false,
  ): Promise<void> {
    return this.maintain(chat, (session, events) => {
      const recorded = new Map(events.flatMap(event => event.type === 'katcats/group-task-lifecycle'
        ? [[event.data.eventId, event.data] as const] : []))
      for (const delivery of changed) {
        if (delivery.chatId !== chat.id) throw new HarnessError('A group task belongs to another transcript.', 'KATCATS_CHAT_MESSAGE_MISMATCH')
        const queuedId = brandString<ChatTaskEventId>(`${delivery.id}:queued`)
        const first = recorded.get(queuedId)
        const identity = first ?? taskIdentity(chat, delivery, deliveries, bots)
        if (identity.chatId !== chat.id || identity.rootSessionId !== chat.rootSessionId
          || identity.deliveryId !== delivery.id || identity.target.botId !== delivery.botId || identity.message !== delivery.message
          || identity.runId !== delivery.runId || identity.generation !== delivery.generation) {
          throw new HarnessError('The saved group task identity differs from its committed delivery.', 'KATCATS_CHAT_MESSAGE_MISMATCH')
        }
        const observed = states(delivery)
        for (const status of observed) {
          const eventId = brandString<ChatTaskEventId>(`${delivery.id}:${status}`)
          if (recorded.has(eventId)) continue
          const data: ChatTaskLifecycle = { ...identity, eventId, status, recovered: recovering || status !== observed.at(-1),
            error: status === 'failed' || status === 'cancelled' || status === 'unknown' ? delivery.error : null }
          session.append('katcats/group-task-lifecycle', data)
          recorded.set(eventId, data)
        }
      }
    })
  }

  private publish(chat: GroupContainer, message: UserMessage): Promise<void> {
    return this.maintain(chat, (session, events) => {
      let exists = false
      for (const event of events) {
        if (event.type !== 'user/message' || event.data.id !== message.id) continue
        if (!isDeepStrictEqual(event.data, message)) {
          throw new HarnessError('This group message ID already contains different content. Reopen the group before retrying.',
            'KATCATS_CHAT_MESSAGE_MISMATCH')
        }
        exists = true
      }
      if (!exists) session.append('user/message', message, { surfaceOp: 'append' })
    })
  }

  private maintain(chat: GroupContainer, append: (session: Session, events: readonly SessionEvent[]) => void): Promise<void> {
    const operation = (this.tails.get(chat.rootSessionId) ?? Promise.resolve()).then(async () => {
      const inspected = await this.ctx.sessionController.inspect(chat.rootSessionId)
      requireClosedTurn(inspected.events)
      const found = await this.ctx.sessionController.resolveAgent(chat.rootSessionId)
      if ('error' in found) throw found.error
      const agent = found.agent
      if (agent.status !== 'idle') throw busy()
      requireEmptyInbox(agent)
      let write: Promise<void>
      try {
        write = agent.runMaintenance(async (signal) => {
          signal.throwIfAborted()
          requireEmptyInbox(agent)
          // oxlint-disable-next-line typescript/no-deprecated -- Owner-authorized retry checks unflushed accepted appends.
          const liveEvents = agent.session.snapshotEvents()
          requireClosedTurn(liveEvents)
          append(agent.session, [...inspected.events, ...liveEvents])
          try {
            if (!await this.ctx.sessions.flush(agent.session)) throw new Error('Group transcript has no Session durability owner')
          } catch (error) {
            throw new HarnessError('The group message was accepted, but its saved state is unconfirmed. Retry the same message before sending another.',
              'KATCATS_CHAT_DURABILITY_UNCONFIRMED', { cause: error })
          }
          signal.throwIfAborted()
          requireEmptyInbox(agent)
        })
      } catch (_error) {
        // Maintenance is synchronously refused only while another activity owns the Agent.
        throw busy()
      }
      await write
    })
    const settled = operation.then(() => {}, () => {})
    this.tails.set(chat.rootSessionId, settled)
    void settled.then(() => { if (this.tails.get(chat.rootSessionId) === settled) this.tails.delete(chat.rootSessionId) })
    return operation
  }
}
