/** Group conversations, isolated execution bindings, and durable delegation receipts. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { MessageId, ToolCallId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { BotAvatar, BotId, GroupId } from './types.ts'
export type { ChatTaskActor, ChatTaskEventId, ChatTaskLifecycle, ChatTaskMember, ChatTaskStatus } from './chats-task-events.ts'

/** Stable group identity, independent of every private member conversation. */
export type ChatId = Branded<'KatcatsChatId'>
/** Stable group dispatch run identity. */
export type ChatRunId = Branded<'KatcatsChatRunId'>
/** Stable accepted delegation identity. */
export type ChatDeliveryId = Branded<'KatcatsChatDeliveryId'>

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
  readonly activities: readonly ChatActivity[]
}

/** Live group processing and actual member activity, separate from its saved controls. */
export interface ChatActivity {
  readonly chatId: ChatId
  readonly processing: boolean
  readonly runningBotIds: readonly BotId[]
  readonly pendingControl: 'pause' | 'resume' | 'stop' | null
}

/** Directory stream frames replace complete values rather than merging member fields. */
export type ChatFrame =
  | { readonly type: 'snapshot'; readonly value: ChatSnapshot }
  | { readonly type: 'replace'; readonly value: ChatSnapshot }

/** Create a group from explicitly selected ordinary members; a responsible member is optional. */
export interface CreateChatRequest {
  readonly name: string
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
  readonly memberRoles?: readonly ChatMemberRole[]
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

/** Committed group mutation with an immediately renderable owner snapshot. */
export interface ChatMutationValue {
  readonly chat: TeamChat
  readonly snapshot: ChatSnapshot
}
