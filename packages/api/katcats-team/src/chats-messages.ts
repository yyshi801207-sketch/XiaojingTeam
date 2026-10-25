/** Durable sources for group tasks, member receipts, and explicit continuation. */
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatDeliveryId, ChatId, ChatRunId, ChatSender } from './chats-types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** One actual member's persisted public assistant text; a segment does not imply task completion. */
    'katcats-group-relay': {
      readonly kind: 'katcats-group-relay'
      readonly form: 'relay'
      readonly schemaVersion: 1
      readonly chatId: ChatId
      readonly runId: ChatRunId
      readonly generation: number
      readonly deliveryId: ChatDeliveryId
      readonly sender: ChatSender
      readonly executionSessionId: SessionId
      readonly inputMessageId: MessageId
      readonly outputMessageId: MessageId
    }
    /** One group-owned member input; it never carries a private conversation. */
    'katcats-group-task': {
      readonly kind: 'katcats-group-task'
      readonly form: 'relay'
      readonly chatId: ChatId
      readonly runId: ChatRunId
      readonly generation: number
      readonly deliveryId: ChatDeliveryId
      readonly target: ChatSender
    }
    /** Explicit owner continuation; queuing a receipt alone never wakes the driver. */
    'katcats-group-control': {
      readonly kind: 'katcats-group-control'
      readonly form: 'notice'
      readonly summary: string
      readonly chatId: ChatId
      readonly runId: ChatRunId
      readonly generation: number
      readonly action: 'continue'
    }
  }
}
