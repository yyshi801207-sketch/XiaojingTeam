/** Explicitly scoped product memories; these records never contain private conversation history. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { BotId } from './types.ts'
import type { ChatId } from './chats-types.ts'

/** Durable identity of one saved entry or explicitly shared copy. */
export type MemoryId = Branded<'KatcatsMemoryId'>

/** A private member, one group, or the explicitly shared team store. */
export type MemoryScope =
  | { readonly kind: 'bot'; readonly botId: BotId }
  | { readonly kind: 'group'; readonly chatId: ChatId }
  | { readonly kind: 'team' }

/** Server-derived author; models cannot select another member's identity. */
export type MemoryAuthor =
  | { readonly kind: 'owner' }
  | { readonly kind: 'bot'; readonly botId: BotId; readonly sessionId: SessionId }
  | { readonly kind: 'group'; readonly chatId: ChatId; readonly sessionId: SessionId }

/** The selected source revision captured by an owner-approved cross-scope copy. */
export interface MemorySource {
  readonly entryId: MemoryId
  readonly scope: MemoryScope
  readonly version: number
  readonly author: MemoryAuthor
  readonly createdAt: number
  readonly updatedAt: number
}

/** Saved text is untrusted data; sharing preserves the selected source's author and times. */
export interface MemoryEntry {
  readonly id: MemoryId
  readonly scope: MemoryScope
  readonly text: string
  readonly version: number
  readonly author: MemoryAuthor
  readonly createdAt: number
  readonly updatedAt: number
  readonly source: MemorySource | null
}

/** One complete scope result; queries filter saved entries without reading Session history. */
export interface MemoryList {
  readonly revision: number
  readonly scope: MemoryScope
  readonly entries: readonly MemoryEntry[]
}

/** Owner-selected scope and optional case-insensitive saved-text query. */
export interface MemoryListRequest {
  readonly scope: MemoryScope
  readonly query?: string
}

/** A new entry; author and timestamps are supplied by the Host. */
export interface MemorySaveRequest {
  readonly scope: MemoryScope
  readonly text: string
}

/** Compare the selected revision before replacing its text. */
export interface MemoryEditRequest {
  readonly id: MemoryId
  readonly expectedVersion: number
  readonly text: string
}

/** Compare the selected revision before deleting or sharing it. */
export interface MemorySelectRequest {
  readonly id: MemoryId
  readonly expectedVersion: number
}

/** Copy exactly the selected entry to another scope; no automatic conversation sharing occurs. */
export interface MemoryShareRequest extends MemorySelectRequest {
  readonly target: MemoryScope
}

/** Mutation acknowledgement emitted only after the durable write succeeds. */
export interface MemoryMutationValue {
  readonly revision: number
  readonly entry: MemoryEntry
}

/** Durable deletion acknowledgement. */
export interface MemoryDeleteValue {
  readonly revision: number
  readonly id: MemoryId
  readonly deleted: true
}

/** Scope streams replace their complete result after a committed change. */
export type MemoryFrame =
  | { readonly type: 'snapshot'; readonly value: MemoryList }
  | { readonly type: 'replace'; readonly value: MemoryList }
