/** Group-run usage from settled executor attempts; no inferred prices or reasoning double count. */
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { Message, TokenUsage } from '@deepseek-ai/dsh-llm/types'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatId, ChatRunId } from '../chats-types.ts'
import type {} from '../chats-messages.ts'
import type {} from '@deepseek-ai/dsh-llm-retry/types'

/** One settled model request, including failed attempts and explicit retries. */
export interface RoomUsageSample {
  readonly runId: ChatRunId | null
  readonly usage: TokenUsage | null
}

/** Display-only totals retain unknown buckets and missing request usage. */
export interface RoomUsageTotals {
  readonly calls: number
  readonly missing: number
  readonly input: number
  readonly output: number
  readonly cacheRead: number | null
  readonly cacheWrite: number | null
  readonly total: number | null
}

/**
 * Attribute settled requests to their delivered group input and deduplicate usage samples.
 * @param entries - Loaded journal for one exact group executor, in sequence order.
 * @param chatId - Only this group's input identities establish attribution.
 * @returns One sample per turn, step and retry attempt; missing scope remains unassigned.
 */
export function projectRoomUsage(entries: readonly SessionEventLikeEntry[], chatId: ChatId): readonly RoomUsageSample[] {
  let runId: ChatRunId | null = null
  const attempts = new Map<string, RoomUsageSample>()
  const retries = new Map<string, number>()
  const seen = new Set<number>()
  const accept = (message: Message) => {
    const source = message.source
    if (source.kind === 'katcats-group-task' || source.kind === 'katcats-group-control') {
      runId = source.chatId === chatId ? source.runId : null
    }
  }
  for (const entry of entries) {
    if (entry.type !== 'event' || seen.has(entry.event.seq)) continue
    const event = entry.event
    seen.add(event.seq)
    if (event.type === 'user/message' && event.surfaceOp === 'append') accept(event.data)
    else if (event.type === 'agent/inbox/spliced' && event.data.target === 'next-step') event.data.inserted.forEach(accept)
    else if (event.type === 'llm/retry-started') {
      const key = `${event.data.turn}:${event.data.step}`
      retries.set(key, (retries.get(key) ?? 0) + 1)
    } else if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      const key = `${event.data.turn}:${event.data.step}`
      const usage = (event.type === 'assistant/message' ? event.data.usage : undefined)
        ?? lastAssistantStreamChunk(event.data.stream, 'usage')?.usage ?? null
      attempts.set(`${key}:${retries.get(key) ?? 0}`, { runId, usage })
    }
  }
  return [...attempts.values()]
}

/**
 * Sum reported buckets; reasoning is already included in output.
 * @param samples - Deduplicated settled model requests selected for one group run.
 * @returns Known usage with null for unavailable totals or optional cache buckets.
 */
export function totalRoomUsage(samples: readonly RoomUsageSample[]): RoomUsageTotals {
  let input = 0, output = 0, cacheRead: number | null = 0, cacheWrite: number | null = 0, total: number | null = 0, missing = 0
  for (const { usage } of samples) {
    if (usage === null) { missing++; total = null; continue }
    input += usage.inputTokens
    output += usage.outputTokens
    cacheRead = cacheRead !== null && usage.cacheReadTokens !== undefined ? cacheRead + usage.cacheReadTokens : null
    cacheWrite = cacheWrite !== null && usage.cacheWriteTokens !== undefined ? cacheWrite + usage.cacheWriteTokens : null
    const count = usage.totalTokens ?? (usage.cacheReadTokens !== undefined && usage.cacheWriteTokens !== undefined
      ? usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens : null)
    total = total !== null && count !== null ? total + count : null
  }
  return { calls: samples.length, missing, input, output, cacheRead, cacheWrite, total }
}
