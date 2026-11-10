/** Serializable group-review values shared by Host execution and Client Session readers. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ChatDeliveryId } from './chats-types.ts'
import type { BotId } from './types.ts'

/** Content identity computed by the host, never supplied by the reviewing model. */
export type GroupReviewVersion = Branded<'GroupReviewVersion'>

/** The owner's declared reason for independent review; none permits individual delivery. */
export interface GroupReviewPolicy {
  readonly reason: 'none' | 'financial-conclusion' | 'data-change' | 'explicit-review'
  /** Omission leaves important work pending until a reviewer is selected. */
  readonly reviewerBotId?: BotId
}

/** Original text and/or existing files to submit for independent review. */
export interface GroupReviewCandidateRequest {
  readonly text?: string
  readonly files?: readonly string[]
}

/** Host-captured content versions; files remain in the group's canonical working directory. */
export interface GroupReviewCandidate {
  readonly version: GroupReviewVersion
  readonly text: string | null
  readonly files: readonly { readonly path: string; readonly sha256: string }[]
}

/** A real child review result associated with the exact parent and candidate. */
export interface GroupReviewReceipt {
  readonly parentDeliveryId: ChatDeliveryId
  readonly deliveryId: ChatDeliveryId
  readonly reviewerId: BotId
  readonly candidateVersion: GroupReviewVersion
  readonly verdict: 'approved' | 'changes_requested'
  readonly findings: string
}
