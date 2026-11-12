/** Group conversations, isolated execution bindings, and durable delegation receipts. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { MessageId, ToolCallId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionPromptValue, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { BotAvatar, BotId, GroupId } from './types.ts'
export type { ChatTaskActor, ChatTaskEventId, ChatTaskLifecycle, ChatTaskMember, ChatTaskStatus } from './chats-task-events.ts'

/** Stable group identity, independent of every private member conversation. */
export type ChatId = Branded<'KatcatsChatId'>
/** Stable group dispatch run identity. */
export type ChatRunId = Branded<'KatcatsChatRunId'>
/** Stable accepted delegation identity. */
export type ChatDeliveryId = Branded<'KatcatsChatDeliveryId'>

/** Stable business task identity retained when later owner messages continue the same work. */
export type GroupTicketId = Branded<'KatcatsGroupTicketId'>

/** Saved response to a group owner’s acceptance message. */
export type GroupTaskAcceptance =
  | { readonly kind: 'completed'; readonly taskId: GroupTicketId; readonly goal: string }
  | { readonly kind: 'choose'; readonly chatId: ChatId; readonly candidates: readonly {
    readonly taskId: GroupTicketId; readonly goal: string; readonly revision: number
  }[] }
  | { readonly kind: 'none' }

/** A group prompt can be recorded as an acceptance instruction without starting an Agent. */
export interface ChatPromptValue extends SessionPromptValue {
  readonly taskAcceptance?: GroupTaskAcceptance
}

/** Confirmed, published result offered for owner acceptance on a business task. */
export interface GroupTicketDelivery {
  readonly deliveryId: ChatDeliveryId
  readonly outputMessageId: MessageId
  readonly relayMessageId: MessageId
}

/** Versioned business task with verified delivery and optional human acceptance. */
export interface GroupTicket {
  readonly version: 1
  readonly id: GroupTicketId
  readonly ownerId: BotId
  readonly goal: string
  /** Empty until the responsible member explicitly records acceptance criteria. */
  readonly acceptance: readonly string[]
  readonly stage: string
  readonly nextStep: string
  readonly state: 'open' | 'blocked' | 'delivered' | 'completed'
  readonly blocker: string | null
  /** Opaque saved finance target, null for a known unbound group, absent on legacy tasks. */
  readonly financeScope?: string | null
  /** Ledger and company label retained with the saved task, when bound. */
  readonly financeLabel?: string
  /** Exact owner delivery allowed to publish the submitted work after normal review. */
  readonly pendingDeliveryId?: ChatDeliveryId
  /** Public receipt for a delivered or accepted task. */
  readonly delivery?: GroupTicketDelivery
  /** UTC timestamp in epoch milliseconds when the task completed. */
  readonly completedAt?: number
  /** Automatic criteria-based completion or owner acceptance; absent on older completed records. */
  readonly completionKind?: 'criteria' | 'owner'
  /** Prompt the owner to confirm a published result when the work calls for human review. */
  readonly humanReviewRequired?: true
  readonly artifacts: readonly string[]
  readonly messageIds: readonly MessageId[]
  readonly revision: number
}

/** Complete business description; omitted id creates work or updates this message's saved task. */
export interface RecordGroupTicket {
  readonly id?: GroupTicketId
  /** Explicit owner-authorized transfer to the current manager after the previous owner leaves. */
  readonly takeOverOwner?: true
  /** Complete current owner message authorizing the transfer, never a selected excerpt. */
  readonly ownerTransferQuote?: string
  /** Submit this already-recorded task for delivery with the current turn's confirmed result. */
  readonly submitDelivery?: true
  /** The task calls for the owner to review its finished result. */
  readonly humanReviewRequired?: true
  readonly goal: string
  readonly acceptance: readonly string[]
  readonly stage: string
  readonly nextStep: string
  readonly artifacts: readonly string[]
}

/** One ordinary member's conversation within one group directory. */
export interface ChatExecutor {
  readonly botId: BotId
  readonly sessionId: SessionId
}

/** Dispatch identity and count since the last explicit continuation. */
export interface ChatRun {
  readonly id: ChatRunId
  readonly generation: number
  readonly relayCount: number
}

/** User-visible structured failure without stack traces or configuration values. */
export interface ChatFailure {
  readonly code: string
  readonly message: string
}

/** One member's group-specific responsibility, independent of its private identity. */
export interface ChatMemberRole {
  readonly botId: BotId
  readonly role: string
}

/** Durable group settings with an optional responsible member and a separate transcript Session. */
export interface TeamChat {
  /** Saved business work; absent on groups that have not recorded a task yet. */
  readonly tickets?: readonly GroupTicket[]
  readonly id: ChatId
  readonly name: string
  readonly groupId: GroupId
  readonly rootSessionId: SessionId
  readonly workDir: string
  readonly memberIds: readonly BotId[]
  readonly managerId: BotId | null
  readonly memberRoles: readonly ChatMemberRole[]
  readonly executors: readonly ChatExecutor[]
  readonly relayLimit: number
  /** Show task handoff records and stages in this group's transcript; omission preserves the enabled default. */
  readonly showHandoffRecords?: boolean
  readonly generation: number
  readonly status: 'active' | 'paused' | 'stopped'
  readonly pauseReason: string | null
  readonly run: ChatRun | null
  readonly error: ChatFailure | null
}

/** Sender appearance and identity captured when a delegation is accepted. */
export interface ChatSender {
  readonly botId: BotId
  readonly name: string
  readonly role: string
  readonly avatar: BotAvatar
}

/** Completed member text retained before it is published to the group. */
export interface ChatReceipt {
  readonly sender: ChatSender
  readonly text: string
  readonly outputMessageId: MessageId
  readonly turn: number
}

/** Accepted owner message and its fixed initial recipients; publication does not imply model completion. */
export interface ChatInbound {
  readonly requestId: SessionRequestId
  /** SHA-256 of canonical submitted content and time zone; the original encoded upload is not retained. */
  readonly requestDigest: string
  readonly chatId: ChatId
  readonly runId: ChatRunId
  readonly generation: number
  readonly userMessage: UserMessage
  readonly recipients: readonly BotId[]
  readonly addressing: 'explicit' | 'broadcast'
  /** Version 1 enables responsible-member routing and delivery review; absent inputs retain legacy execution. */
  readonly collaborationVersion?: 1
  /** Version 1 enables durable task classification and one-shot confirmed-blocker follow-up. */
  readonly coordinationVersion?: 1
  /** Finance target captured at admission, null if known unbound, absent on legacy inputs. */
  readonly financeScope?: string | null
  /** Transcript-only owner instruction with its persisted acceptance outcome. */
  readonly taskAcceptance?: GroupTaskAcceptance
  readonly state: 'accepted' | 'published'
}

/** Actual initiating message, or a preserved historical coordinator tool position. */
export type ChatDeliverySource =
  | { readonly kind: 'owner-message'; readonly messageId: MessageId }
  | { readonly kind: 'member-reply'; readonly messageId: MessageId }
  | {
    readonly kind: 'tool'
    readonly turn: number
    readonly step: number
    readonly callId: ToolCallId
    /** Active member delivery that authorized the handoff; historical root tools omit it. */
    readonly parentDeliveryId?: ChatDeliveryId
  }

/** Successful member silence, proven by its persisted pass tool result and completed worker turn. */
export interface ChatPass {
  readonly turn: number
  readonly callId: ToolCallId
}

/** Accepted delegation and its durable outcome, retained across pause and restart. */
export interface ChatDelivery {
  /** Confirmed failed delivery being explained by this one-shot responsible-member follow-up. */
  readonly recoveryOf?: ChatDeliveryId
  /** Durable obligation to explain a confirmed failure; never authorizes repeating the failed operation. */
  readonly takeover?: {
    readonly version: 1
    readonly botId: BotId
    readonly state: 'pending' | 'handled' | 'stopped'
  }
  readonly id: ChatDeliveryId
  readonly chatId: ChatId
  readonly runId: ChatRunId
  readonly generation: number
  /** Transcript Session for message delivery, or the actual group executor that called a handoff tool. */
  readonly sourceSessionId: SessionId
  readonly source: ChatDeliverySource
  readonly botId: BotId
  readonly executorSessionId: SessionId
  readonly message: string
  readonly inputMessageId: MessageId
  readonly relayMessageId: MessageId
  readonly state: 'accepted' | 'running' | 'completed' | 'passed' | 'failed' | 'unknown'
  readonly receipt: ChatReceipt | null
  readonly pass: ChatPass | null
  readonly relayed: boolean
  readonly error: ChatFailure | null
}

/** Complete owner-only group directory and delegation outcomes. */
export interface ChatSnapshot {
  readonly revision: number
  readonly chats: readonly TeamChat[]
  readonly deliveries: readonly ChatDelivery[]
  readonly relayLimit: number
  /** Groups with a saved ledger binding, independent of the last connection test. */
  readonly financeChatIds?: readonly ChatId[]
  readonly activities: readonly ChatActivity[]
}

/** Live group processing and actual member activity, separate from its saved controls. */
export interface ChatActivity {
  readonly chatId: ChatId
  readonly processing: boolean
  readonly runningBotIds: readonly BotId[]
  readonly pendingControl: 'pause' | 'resume' | 'stop' | null
  /** Business task attached to the current admitted group run, when classified. */
  readonly currentTaskId?: GroupTicketId
  /** Current disposition for each open or blocked task in this group's archive. */
  readonly taskContinuation?: Readonly<Record<string, 'resume' | 'start' | 'busy' | 'unknown' | 'scope' | 'owner-missing'>>
}

/** Directory stream frames replace complete values rather than merging member fields. */
export type ChatFrame =
  | { readonly type: 'snapshot'; readonly value: ChatSnapshot }
  | { readonly type: 'replace'; readonly value: ChatSnapshot }

/** Create a group from explicitly selected ordinary members with optional sidebar placement and a responsible member. */
export interface CreateChatRequest {
  readonly name: string
  readonly groupId?: GroupId
  readonly memberIds: readonly BotId[]
  readonly managerId?: BotId | null
  readonly relayLimit?: number
}

/** Replace explicit group settings without changing its root conversation or directory. */
export interface UpdateChatRequest {
  readonly id: ChatId
  readonly groupId?: GroupId
  readonly name?: string
  readonly memberIds?: readonly BotId[]
  readonly managerId?: BotId | null
  /** Replace the complete responsibility list when supplied. */
  readonly memberRoles?: readonly ChatMemberRole[]
  /** Update only this member's override. Blank text clears it. Omission preserves the existing list unless memberRoles is supplied. */
  readonly memberRole?: ChatMemberRole
  readonly relayLimit?: number
  /** Change transcript presentation only; omission preserves this group's saved preference. */
  readonly showHandoffRecords?: boolean
}

/** Stop and remove one group directory entry while retaining its Sessions and files. */
export interface DeleteChatRequest {
  readonly id: ChatId
}

/** Explicit group-local changes inferred from the owner's conversation, without changing private identities. */
export interface UpdateChatRolesRequest {
  readonly managerId?: BotId | null
  readonly memberRoles?: readonly ChatMemberRole[]
}

/** Identify the group whose coordination state should change. */
export interface ChatControlRequest {
  readonly id: ChatId
  readonly expectedRunId: ChatRunId | null
  readonly expectedGeneration: number
}

/** Owner-selected archive task and the exact observed revision and run. */
export interface ContinueGroupTaskRequest {
  readonly chatId: ChatId
  readonly taskId: GroupTicketId
  readonly expectedRevision: number
  readonly expectedRunId: ChatRunId | null
  readonly expectedGeneration: number
  readonly requestId: ChatInbound['requestId']
}

/** Committed group mutation with an immediately renderable owner snapshot. */
export interface ChatMutationValue {
  readonly chat: TeamChat
  readonly snapshot: ChatSnapshot
}
