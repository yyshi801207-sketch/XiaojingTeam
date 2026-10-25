/** Borrow only the executor that produced this group's confirmed closing reply. */
import type { ISessions, SessionReference, SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { MessageId, MessageSourceMap } from '@deepseek-ai/dsh-llm'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ChatView } from './chat-model.ts'
import type { TeamView } from './model.ts'
import { groupFileClaimMatches } from '../group-file-claim.ts'
import type {} from '../chats-messages.ts'

/** A persisted final relay supplies identities, never file paths. */
export interface GroupFilesTarget {
  readonly rootSessionId: SessionId
  readonly messageId: MessageId
  readonly source: MessageSourceMap['katcats-group-relay']
}

/** Public group catalogs and Session acquisitions for a mounted result. */
export interface GroupFilesOptions {
  readonly sessions: Pick<ISessions, 'retain' | 'binding'>
  readonly chats: ObservableSnapshot<ChatView>
  readonly directory: ObservableSnapshot<TeamView>
  readonly connection: Pick<ConnectionHandle, 'state' | 'generation'>
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** A mounted group closing reply showing its original executor's final files. */
    katcatsDeliveredFiles: unknown
  }
}

/**
 * Validate a final relay against the Host directory before acquiring any Session.
 * @param target - Root transcript and immutable recorded member result.
 * @param groups - Current group directory.
 * @param team - Current private-session identities, used to reject aliasing.
 * @returns Whether the original executor remains group-owned; retained journal rows must match the final relay.
 */
export function groupFilesTargetAvailable(target: GroupFilesTarget, groups: ChatView, team: TeamView): boolean {
  if (groups.phase !== 'ready' || team.phase !== 'ready') return false
  const { source } = target
  const chat = groups.snapshot?.chats.find(item => item.id === source.chatId && item.rootSessionId === target.rootSessionId)
  const delivery = groups.snapshot?.deliveries.find(item => item.id === source.deliveryId)
  const outcomeMatches = delivery === undefined || delivery.state === 'completed' && delivery.receipt !== null
    && delivery.chatId === source.chatId && delivery.relayMessageId === target.messageId
    && delivery.executorSessionId === source.executionSessionId && delivery.botId === source.sender.botId
    && delivery.inputMessageId === source.inputMessageId && delivery.receipt.outputMessageId === source.outputMessageId
    && delivery.runId === source.runId && delivery.generation === source.generation
  return chat !== undefined && outcomeMatches && target.messageId !== source.outputMessageId
    && source.executionSessionId !== chat.rootSessionId
    && chat.executors.some(item => item.botId === source.sender.botId && item.sessionId === source.executionSessionId)
    && !team.snapshot?.bots.some(bot => bot.sessionId === source.executionSessionId)
    && !groups.snapshot?.chats.some(item => item.id !== chat.id
      && (item.rootSessionId === source.executionSessionId
        || item.executors.some(worker => worker.sessionId === source.executionSessionId)))
}

/**
 * Check the actual worker claim and closed output without accepting model-authored path text.
 * @param target - Confirmed group relay.
 * @param window - Original executor's durable event window.
 * @returns Whether the claimed group turn contains and closes this exact assistant output.
 */
export function groupFilesClaimMatches(target: GroupFilesTarget, window: SessionEventWindow): boolean {
  return groupFileClaimMatches(target.source, window.entries.flatMap(entry => entry.type === 'event' ? [entry.event] : []))
}

/**
 * Acquire and verify an exact original executor; hiding the result aborts and releases it.
 * @param options - Existing Session controller and authoritative product catalogs.
 * @param target - Actual completed relay, with no file paths supplied by the caller.
 * @param signal - Mounted result lifetime.
 * @returns A ready verified reference, owned by the caller until release or cancellation.
 */
export async function retainGroupFiles(options: GroupFilesOptions, target: GroupFilesTarget,
  signal: AbortSignal): Promise<SessionReference> {
  const generation = options.connection.generation.getSnapshot()
  const available = (): boolean => !signal.aborted && generation !== undefined
    && options.connection.state.getSnapshot() === 'connected' && options.connection.generation.getSnapshot() === generation
    && groupFilesTargetAvailable(target, options.chats.getSnapshot(), options.directory.getSnapshot())
  if (!available()) throw new Error('The group delivery Session is unavailable')
  const reference = options.sessions.retain(target.source.executionSessionId, { source: 'katcatsDeliveredFiles', signal })
  const release = (): void => { reference.release() }
  signal.addEventListener('abort', release, { once: true })
  try {
    const binding = await reference.ready
    const current = (): boolean => available() && options.sessions.binding(target.source.executionSessionId) === binding
      && binding.session.getSnapshot().openState === 'open'
    if (!current()) throw new Error('The group delivery Session changed')
    if (!groupFilesClaimMatches(target, binding.eventSource.getSnapshot()) && binding.eventSource.getSnapshot().hasMore) {
      // The relay retains a message identity rather than a sequence. The shared history loader coalesces this cold lookup.
      await binding.session.loadThrough(1 as SessionSeq)
    }
    if (!current() || !groupFilesClaimMatches(target, binding.eventSource.getSnapshot())) {
      throw new Error('The recorded reply does not belong to this group delivery')
    }
    return reference
  } catch (error) {
    signal.removeEventListener('abort', release)
    release()
    throw error
  }
}
