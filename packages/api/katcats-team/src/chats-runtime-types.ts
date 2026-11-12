/** Direct member execution over the durable directory and a model-free group transcript. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  ChatDelivery, ChatDeliveryId, ChatDeliverySource, ChatFailure, ChatId, ChatInbound, ChatPass,
  ChatReceipt, ChatRunId, TeamChat, UpdateChatRolesRequest,
} from './chats-types.ts'
import type { BotId, TeamBot } from './types.ts'
import type { GroupTicket, RecordGroupTicket } from './group-tickets.ts'
import type { GroupSemanticAcceptanceRequest } from './group-semantic-acceptance.ts'

/** Validated deployment limits for group context and candidate inspection. */
export interface GroupRuntimeConfig {
  readonly initialHistoryMessages: number
  readonly historyPageSize: number
  readonly historyPageMaxChars: number
  readonly reviewCandidateMaxBytes: number
}

/** One group and the current member settings and accepted work needed to execute it. */
export interface ChatRuntimeSnapshot {
  readonly chat: TeamChat
  readonly bots: readonly TeamBot[]
  readonly inbounds: readonly ChatInbound[]
  readonly deliveries: readonly ChatDelivery[]
}

/** A transcript container or isolated member Session, independent of private chat history. */
export interface ChatAgentBinding {
  readonly chatId: ChatId
  readonly botId: BotId | 'root'
}

/** A concrete group input or actual member tool position, retained before execution starts. */
export interface AcceptChatDelivery {
  /** Omit for ordinary dispatch; present only for a pending confirmed-failure explanation. */
  readonly recoveryOf?: ChatDeliveryId
  readonly chatId: ChatId
  readonly runId: ChatRunId
  readonly generation: number
  readonly sourceSessionId: SessionId
  readonly source: ChatDeliverySource
  readonly botId: BotId
  readonly message: string
}

/** Exact group generation captured by an owner control or live member delivery. */
export interface ChatRuntimeExpected {
  readonly runId: ChatRunId | null
  readonly generation: number
}

/** Serialized durable operations supplied by the directory; none waits for a model turn. */
export interface ChatRuntimeActions {
  /** Apply semantic acceptance after verifying the exact owner input and delivered revision. */
  acceptTask(deliveryId: ChatDeliveryId, request: GroupSemanticAcceptanceRequest, admit: () => void): Promise<GroupTicket>
  /** Persist classification from the current direct recipient, rechecking authority within the queue. */
  recordTicket(deliveryId: ChatDeliveryId, request: RecordGroupTicket, admit: () => void): Promise<GroupTicket>
  /** Read the group, current member settings, and its complete accepted delivery records. */
  read(chatId: ChatId): Promise<ChatRuntimeSnapshot>
  /** Save owner-requested group roles after rechecking current member authority inside the queue. */
  updateRoles(chatId: ChatId, request: UpdateChatRolesRequest, expected: ChatRuntimeExpected, admit: () => void): Promise<TeamChat>
  /** Start an active group's run when absent; retain the current run when present. */
  beginRun(chatId: ChatId): Promise<TeamChat>
  /** Advance queued owner input only in an active group after accepted work settles; paused or unknown outcomes block advancement. */
  advanceOwnerRun(chatId: ChatId, expected: ChatRuntimeExpected): Promise<boolean>
  /** Persist a pause and an optional visible failure without cancelling an already dispatched member. */
  pause(chatId: ChatId, reason: string, expected?: ChatRuntimeExpected, error?: ChatFailure): Promise<void>
  /** Invalidate the generation and clear the run before runtime cancellation begins. */
  stopped(chatId: ChatId, expected?: ChatRuntimeExpected): Promise<void>
  /** Finish only this run after every admitted recipient has had an opportunity to respond. */
  finishRun(chatId: ChatId, runId: ChatRunId, generation: number): Promise<void>
  /** Retain an initial target or actual handoff; invoke admission again inside the write queue. */
  acceptDelivery(input: AcceptChatDelivery, admit?: () => void): Promise<ChatDelivery>
  /** Validate active generation and budget, mark running, and count this actual dispatch. */
  markRunning(deliveryId: ChatDeliveryId): Promise<ChatDelivery>
  /** Retain a flushed member result, including a historical result whose run was stopped. */
  completeDelivery(deliveryId: ChatDeliveryId, receipt: ChatReceipt): Promise<ChatDelivery>
  /** Retain silence only after a real successful pass tool result and completed worker turn are flushed. */
  completePass(deliveryId: ChatDeliveryId, pass: ChatPass): Promise<ChatDelivery>
  /** Record a failure and contain dependent work according to the certainty of its outcome. */
  failDelivery(deliveryId: ChatDeliveryId, failure: ChatFailure, unknown: boolean): Promise<void>
  /** Mark a completed receipt flushed into group history, including a superseded run; this does not imply model consumption. */
  markRelayed(deliveryId: ChatDeliveryId): Promise<void>
  /** Confirm that an admitted owner message has been flushed into the transcript. */
  markInboundPublished(chatId: ChatId, messageId: MessageId): Promise<void>
  /** Publish volatile runtime activity changes without manufacturing durable model events. */
  notifyActivity(): void
}

/** Group runtime owned by the directory's plugin lifetime. */
export interface ChatRuntimeLifecycle {
  /** Install group identity and scoped controls before the Session accepts work. */
  install(agent: Agent, binding: ChatAgentBinding): void
  /** Publish accepted owner messages in order without starting a model. */
  publishInbound(chatId: ChatId): Promise<void>
  /** Admit one owned background driver; an existing driver observes newly admitted work. */
  kick(chatId: ChatId): void
  /** Report an admitted driver or stopping operation, independently of Agent.status. */
  isProcessing(chatId: ChatId): boolean
  /** Recover proven completed member outcomes and receipt display without executing or waking work. */
  reconcile(chatId: ChatId): Promise<void>
  /** Reconcile and admit continued work, returning before model execution completes. */
  resume(chatId: ChatId): Promise<void>
  /** Observe the directory's already committed pause; do not cancel an executing member. */
  pauseAfterCurrent(chatId: ChatId): Promise<void>
  /** Commit replacement input, then drain only the captured old run; the caller kicks after releasing its gate. */
  interrupt(chatId: ChatId, expected: ChatRuntimeExpected, commitNew: () => Promise<void>): Promise<void>
  /** Invalidate and cancel only this group's work, awaiting every owned driver. */
  stop(chatId: ChatId, expected?: ChatRuntimeExpected): Promise<void>
  /** Release one stopped group's plugin registrations after its owned transcript operations settle. */
  release(chatId: ChatId): Promise<void>
  /** Cancel and drain owned drivers before releasing registrations. */
  dispose(): Promise<void>
}
