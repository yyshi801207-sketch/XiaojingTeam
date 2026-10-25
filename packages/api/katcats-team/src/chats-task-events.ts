/** Durable, log-only group task activity; member replies remain separate relay messages. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { BotId } from './types.ts'
import type { ChatDeliveryId, ChatFailure, ChatId, ChatRunId, ChatSender } from './chats-types.ts'

/** Stable identity of one delivery's recorded lifecycle state. */
export type ChatTaskEventId = Branded<'KatcatsChatTaskEventId'>

/** A member identity; older deliveries may outlive the member's directory entry. */
export interface ChatTaskMember {
  readonly kind: 'member'
  readonly botId: BotId
  readonly sender: ChatSender | null
}

/** The actual initiator, including historical coordinator-owned tool calls. */
export type ChatTaskActor = ChatTaskMember | { readonly kind: 'owner' } | { readonly kind: 'legacy-coordinator' }

/** Observed task state; cancellation means an admitted task was stopped before dispatch. */
export type ChatTaskStatus = 'queued' | 'started' | 'completed' | 'passed' | 'failed' | 'cancelled' | 'unknown'

/** One committed task state, carrying identities independent of later Bot renames. */
export interface ChatTaskLifecycle {
  readonly schemaVersion: 1
  readonly eventId: ChatTaskEventId
  readonly chatId: ChatId
  readonly rootSessionId: SessionId
  readonly runId: ChatRunId
  readonly generation: number
  readonly deliveryId: ChatDeliveryId
  readonly parentDeliveryId: ChatDeliveryId | null
  readonly actor: ChatTaskActor
  readonly target: ChatTaskMember
  readonly message: string
  readonly status: ChatTaskStatus
  /** True when recovered from the journal; the event time is not an original execution timestamp. */
  readonly recovered: boolean
  readonly error: ChatFailure | null
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A group-owned task transition after its directory write, with recorded participants and observed state.
     * Its public instruction can be included verbatim in a later member input, which is logged in that worker's Session.
     */
    'katcats/group-task-lifecycle': ChatTaskLifecycle
  }
}
