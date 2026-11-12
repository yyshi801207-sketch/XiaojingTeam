/** Durable sources for group tasks, member receipts, and explicit continuation. */
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatDeliveryId, ChatId, ChatRunId, ChatSender } from './chats-types.ts'
import type { FinanceConnectorId } from './finance-types.ts'

/** Public history included in one member input; archived entries remain available through history lookup. */
export interface GroupContextManifest {
  readonly schemaVersion: 1
  readonly rootSessionId: SessionId
  readonly deliveredIds: readonly string[]
  readonly archivedIds: readonly string[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A product-authored welcome after successful manual verification of the group’s bound ledger. */
    'katcats-group-finance-connected': {
      readonly kind: 'katcats-group-finance-connected'
      readonly form: 'notice'
      readonly summary: string
      readonly chatId: ChatId
      readonly sender: ChatSender
      readonly connectorId: FinanceConnectorId
      readonly connectorName: string
      readonly companyName: string
      readonly currency: string
    }
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
      /** Absent on historical full-context inputs; present entries describe only this input's history selection. */
      readonly context?: GroupContextManifest
      /** Present when this delivery uses the current selective collaboration policy. */
      readonly collaborationVersion?: 1
      /** Review target and the exact candidate supplied by the responsible member, when this is an independent review. */
      readonly reviewRequest?: {
        readonly parentDeliveryId: ChatDeliveryId
        readonly candidate: import('./group-review-types.ts').GroupReviewCandidate
      }
    }
    /** One correction requested before the responsible member can claim a reviewed delivery. */
    'katcats-group-review-notice': {
      readonly kind: 'katcats-group-review-notice'
      readonly form: 'notice'
      readonly summary: string
      readonly chatId: ChatId
      readonly deliveryId: ChatDeliveryId
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
