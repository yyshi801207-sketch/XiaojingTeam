/** Room-owned read subscriptions; closing a room never cancels a Host task. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatId } from '../chats-types.ts'
import type { BotId } from '../types.ts'
import type { ChatView } from './chat-model.ts'
import { projectRoomExecution, type RoomExecutionRow } from './room-activity-model.ts'
import { projectRoomUsage, type RoomUsageSample } from './room-usage-model.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** Read-only execution journal observed while a group room is open. */
    katcatsRoomActivity: unknown
  }
}

/** One member's subscribed journal; failure never becomes an idle or completed state. */
export interface RoomActivityMember {
  readonly botId: BotId
  readonly sessionId: SessionId
  readonly state: 'loading' | 'ready' | 'failed'
  readonly rows: readonly RoomExecutionRow[]
  readonly usage?: readonly RoomUsageSample[]
  /** Current permission preset of this group's executor, never the private Bot Session. */
  readonly permission?: string
  readonly hasMore?: boolean
}

/** Recent executor records are separately marked when their connection becomes stale. */
export interface RoomActivitySnapshot {
  readonly connected: boolean
  readonly members: readonly RoomActivityMember[]
}

interface MemberWatch {
  value: RoomActivityMember
  readonly dispose: () => void
}

/**
 * Subscribe to this group's exact executor Sessions for one mounted live panel.
 * @param options - Existing catalogs and Session reference service; no prompt or cancellation operations.
 * @param chatId - Group selected by the room's header.
 * @param signal - Room or plugin disposal cancels subscriptions only.
 * @returns A store with recent execution records; reconnect reacquires current executor generations.
 */
export function observeRoomActivity(options: {
  readonly sessions: Pick<ISessions, 'retain'>
  readonly chats: ObservableSnapshot<ChatView>
  readonly connection: Pick<ConnectionHandle, 'state' | 'generation'>
}, chatId: ChatId, signal: AbortSignal): ObservableSnapshot<RoomActivitySnapshot> {
  const source = createSnapshotStore<RoomActivitySnapshot>({ connected: false, members: [] })
  const watches = new Map<SessionId, MemberWatch>()
  let generation = options.connection.generation.getSnapshot()
  let stopped = signal.aborted
  let reconciling = false
  const connected = () => !stopped && options.connection.state.getSnapshot() === 'connected'
    && options.connection.generation.getSnapshot() !== undefined && options.chats.getSnapshot().phase === 'ready'
  const publish = () => {
    if (!stopped && !reconciling) source.set({ connected: connected(), members: [...watches.values()].map(watch => watch.value) })
  }
  const releaseAll = () => { for (const watch of watches.values()) watch.dispose(); watches.clear() }
  const reconcile = () => {
    if (stopped || reconciling) return
    reconciling = true
    try {
      const nextGeneration = options.connection.generation.getSnapshot()
      if (generation !== nextGeneration) { releaseAll(); generation = nextGeneration }
      const chat = options.chats.getSnapshot().snapshot?.chats.find(item => item.id === chatId)
      const executors = chat?.executors ?? []
      for (const [id, watch] of watches) {
        if (!executors.some(item => item.sessionId === id && item.botId === watch.value.botId)) { watches.delete(id); watch.dispose() }
      }
      if (!connected()) return
      for (const executor of executors) {
        if (watches.has(executor.sessionId)) continue
        let reference: SessionReference
        try { reference = options.sessions.retain(executor.sessionId, { source: 'katcatsRoomActivity', signal }) }
        catch {
          watches.set(executor.sessionId, { value: { ...executor, state: 'failed', rows: [] }, dispose: () => {} })
          continue
        }
        let unsubscribeEvents = () => {}
        let unsubscribeState = () => {}
        let unsubscribePermission = () => {}
        let active = true
        const watch: MemberWatch = {
          value: { ...executor, state: 'loading', rows: [] },
          dispose: () => { active = false; unsubscribeEvents(); unsubscribeState(); unsubscribePermission(); reference.release() },
        }
        watches.set(executor.sessionId, watch)
        void reference.ready.then((binding) => {
          if (!active || stopped) return
          const read = () => {
            if (!active || stopped) return
            const state = binding.session.getSnapshot()
            const window = binding.eventSource.getSnapshot()
            const permission = binding.session.projections.faceOf('permissions').getSnapshot()
            const currentValue = typeof permission === 'object' && permission !== null && 'currentValue' in permission
              && typeof permission.currentValue === 'string' ? permission.currentValue : undefined
            watch.value = { ...executor, state: state.openState === 'error' || state.removed ? 'failed'
              : state.openState === 'open' ? 'ready' : 'loading',
            rows: projectRoomExecution(executor.botId, executor.sessionId, window.entries),
            usage: projectRoomUsage(window.entries, chatId), hasMore: window.hasMore,
            ...currentValue === undefined ? {} : { permission: currentValue } }
            publish()
          }
          unsubscribeEvents = binding.eventSource.subscribe(() => {
            const change = binding.eventSource.getSnapshot().change
            if (change.kind === 'append' && change.entries.every(entry => entry.type === 'transient')) return
            read()
          })
          unsubscribeState = binding.session.subscribe(read)
          unsubscribePermission = binding.session.projections.faceOf('permissions').subscribe(read)
          read()
        }).catch(() => {
          if (!active || stopped) return
          watch.value = { ...watch.value, state: 'failed' }; publish()
        })
      }
    } finally { reconciling = false; publish() }
  }
  if (stopped) return source
  const unsubscribers = [options.chats.subscribe(reconcile), options.connection.state.subscribe(reconcile),
    options.connection.generation.subscribe(reconcile)]
  const dispose = () => { stopped = true; unsubscribers.forEach((unsubscribe) => { unsubscribe() }); releaseAll() }
  signal.addEventListener('abort', dispose, { once: true })
  reconcile()
  return source
}
