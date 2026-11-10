/** Group presentation retains original question identities, including temporarily hidden panels. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PendingQuestion } from '@deepseek-ai/dsh-client-ui-user-questions/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { BotId } from '../types.ts'
import type { ChatView } from './chat-model.ts'
import type { TeamView } from './model.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** A group question rendered through its original executor's composer. */
    katcatsQuestion: unknown
  }
}

/** The original provider owns every answer channel and panel lifetime. */
export interface GroupQuestion {
  readonly pending: PendingQuestion
  readonly visible: boolean
  readonly waiting: boolean
}

/**
 * Keep hidden answerable cards reachable without copying their question or answer state.
 * @param status - Original public Session interaction source.
 * @param chats - Current group ownership; removed groups release their cached references.
 * @param connection - Connection state; disconnection releases cached references.
 * @param reveal - Return hidden cards to their provider before dropping disconnected presentation references.
 * @returns An observable presentation list and its subscription disposer.
 */
export function createGroupQuestions(status: ObservableSnapshot<SessionStatusSnapshot>, chats: ObservableSnapshot<ChatView>,
  connection: ConnectionHandle['state'], reveal: (pending: PendingQuestion) => void) {
  const source = createSnapshotStore<readonly GroupQuestion[]>([])
  const cards = new Map<PendingQuestion, () => void>()
  const reconcile = (): void => {
    const current = status.getSnapshot()
    if (connection.getSnapshot() !== 'connected') {
      const hidden = [...cards.keys()].filter(pending => current.get(pending.sessionId)?.pendingInteraction !== pending
        && !pending.getSnapshot().closed && pending.getSnapshot().channel !== 'none')
      for (const stop of cards.values()) stop()
      cards.clear()
      if (source.getSnapshot().length !== 0) source.set([])
      for (const pending of hidden) reveal(pending)
      return
    }
    const groups = chats.getSnapshot()
    const executors = new Set(groups.snapshot?.chats.flatMap(chat => chat.executors.map(executor => executor.sessionId)))
    for (const value of current.values()) {
      const pending = value.pendingInteraction
      if (pending?.kind !== 'question' && pending?.kind !== 'plan-review') continue
      if (!executors.has(pending.sessionId)) continue
      if (!cards.has(pending) && !pending.getSnapshot().closed) cards.set(pending, pending.subscribe(reconcile))
    }
    const next: GroupQuestion[] = []
    for (const [pending, stop] of cards) {
      const state = pending.getSnapshot()
      if (state.closed || !executors.has(pending.sessionId)) { stop(); cards.delete(pending); continue }
      const visible = current.get(pending.sessionId)?.pendingInteraction === pending
      if (!visible && state.channel === 'none') { stop(); cards.delete(pending); continue }
      if (pending.review === undefined && state.channel !== 'none') next.push({ pending, visible, waiting: pending.hasWaterfall() })
    }
    const previous = source.getSnapshot()
    if (next.length !== previous.length || next.some((item, index) => {
      const prior = previous.at(index)
      return prior === undefined || item.pending !== prior.pending || item.visible !== prior.visible || item.waiting !== prior.waiting
    })) source.set(next)
  }
  const stopStatus = status.subscribe(reconcile)
  const stopGroups = chats.subscribe(reconcile)
  const stopConnection = connection.subscribe(reconcile)
  reconcile()
  return { source, dispose: () => {
    stopStatus(); stopGroups(); stopConnection()
    for (const stop of cards.values()) stop()
    cards.clear(); source.set([])
  } }
}

/** One group-root panel borrowing its exact executor. */
export interface GroupQuestionTarget {
  readonly rootSessionId: SessionId
  readonly botId: BotId
  readonly pending: PendingQuestion
}

/**
 * Reject private-session aliases and executor identities shared with another group.
 * @param target - Original pending card and selected group root.
 * @param groups - Current public group directory.
 * @param team - Private Bot identities, used only to reject aliasing.
 * @returns Whether this question belongs to the selected group's current member.
 */
export function groupQuestionAvailable(target: GroupQuestionTarget, groups: ChatView, team: TeamView): boolean {
  if (groups.phase !== 'ready' || team.phase !== 'ready') return false
  const chat = groups.snapshot?.chats.find(item => item.rootSessionId === target.rootSessionId)
  const sessionId = target.pending.sessionId
  return chat !== undefined && chat.memberIds.includes(target.botId) && sessionId !== target.rootSessionId
    && chat.executors.some(item => item.botId === target.botId && item.sessionId === sessionId)
    && !team.snapshot?.bots.some(bot => bot.sessionId === sessionId)
    && !groups.snapshot?.chats.some(item => item.id !== chat.id
      && (item.rootSessionId === sessionId || item.executors.some(worker => worker.sessionId === sessionId)))
}

/**
 * Retain a verified worker scope without selecting it or replacing its pending question.
 * @param options - Public catalogs, original question list and Session acquisition.
 * @param target - Original question and its visible group.
 * @param signal - Mounted panel lifetime.
 * @returns A ready reference owned by the caller until release; failures never answer the question.
 */
export async function retainGroupQuestion(options: {
  readonly sessions: Pick<ISessions, 'retain' | 'binding'>
  readonly chats: ObservableSnapshot<ChatView>
  readonly directory: ObservableSnapshot<TeamView>
  readonly questions: ObservableSnapshot<readonly GroupQuestion[]>
  readonly connection: Pick<ConnectionHandle, 'state' | 'generation'>
}, target: GroupQuestionTarget, signal: AbortSignal): Promise<SessionReference> {
  const generation = options.connection.generation.getSnapshot()
  const available = (): boolean => !signal.aborted && generation !== undefined
    && options.connection.state.getSnapshot() === 'connected' && options.connection.generation.getSnapshot() === generation
    && groupQuestionAvailable(target, options.chats.getSnapshot(), options.directory.getSnapshot())
    && options.questions.getSnapshot().some(item => item.pending === target.pending)
  if (!available()) throw new Error('The group question Session is unavailable')
  const reference = options.sessions.retain(target.pending.sessionId, { source: 'katcatsQuestion', signal })
  try {
    const binding = await reference.ready
    if (!available() || options.sessions.binding(target.pending.sessionId) !== binding) throw new Error('The group question Session changed')
    return reference
  } catch (error) { reference.release(); throw error }
}
