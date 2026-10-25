/** Version-one scoped memories, with explicit copied-source attribution and no Session history. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { BotId } from './types.ts'
import type { ChatId } from './chats-types.ts'
import type { MemoryEntry, MemoryId, MemoryScope } from './memory-types.ts'

/**
 * Recognize credential-shaped text without including the submitted value in a report.
 * @param text - text presented at the durable or model-tool input parser.
 * @returns whether a recognizable credential marker is present.
 */
export function containsMemorySecret(text: string): boolean {
  return /(?:\b|_)(?:api[_ -]?key|(?:access|refresh)[_ -]?token|token)\s*[:=]\s*\S+/i.test(text)
    || /(?:\b|_)(?:password|passwd|secret|authorization|cookie)\s*[:=]\s*\S+/i.test(text)
    || /\bBearer\s+[a-z0-9._~+\/-]+/i.test(text)
    || /\b(?:sk|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{8,}\b/.test(text)
    || /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(text)
}

const botId = z.string().min(1).transform(value => brandString<BotId>(value))
const chatId = z.string().min(1).transform(value => brandString<ChatId>(value))
const memoryId = z.string().min(1).transform(value => brandString<MemoryId>(value))
const author = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('owner') }).strict(),
  z.object({ kind: z.literal('bot'), botId,
    sessionId: z.string().min(1).transform(value => brandString<SessionId>(value)) }).strict(),
  z.object({ kind: z.literal('group'), chatId,
    sessionId: z.string().min(1).transform(value => brandString<SessionId>(value)) }).strict(),
])

/** Runtime validation for explicit owner-selected scopes. */
export const memoryScopeSchema: z.ZodType<MemoryScope> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bot'), botId }).strict(),
  z.object({ kind: z.literal('group'), chatId }).strict(),
  z.object({ kind: z.literal('team') }).strict(),
])

const timestamp = z.number().int().nonnegative()
const entry: z.ZodType<MemoryEntry> = z.object({
  id: memoryId, scope: memoryScopeSchema,
  text: z.string().trim().min(1).refine(text => !containsMemorySecret(text), 'Credential-shaped text is not permitted in memory'),
  version: z.number().int().positive(), author, createdAt: timestamp, updatedAt: timestamp,
  source: z.object({ entryId: memoryId, scope: memoryScopeSchema, version: z.number().int().positive(),
    author, createdAt: timestamp, updatedAt: timestamp }).strict().nullable(),
}).strict()

/** One atomic memory replacement; failed writes leave the previous revision authoritative. */
export interface MemoryState {
  readonly revision: number
  readonly entries: readonly MemoryEntry[]
}

/** A new product domain; it neither imports nor migrates another product's memory files. */
export const memoryDomainSpec = defineDomain({
  name: 'katcats_memory', version: 1,
  global: {
    schema: z.object({ revision: z.number().int().nonnegative(), entries: z.array(entry) }).strict()
      .refine(state => new Set(state.entries.map(item => item.id)).size === state.entries.length, 'Duplicate memory identity'),
    initial: { revision: 0, entries: [] } satisfies MemoryState,
  },
  tables: {},
})
