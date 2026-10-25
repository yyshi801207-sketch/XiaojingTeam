/** Read-only task catalog shared by the product's owner and aggregate views. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamBot } from '../types.ts'
import type { TeamChat } from '../chats-types.ts'

/** Original Schedule records remain available after a failed refresh. */
export interface ScheduleView {
  readonly phase: 'loading' | 'ready' | 'failed'
  readonly records: readonly ScheduleCatalogEntry[]
}

/** Public task reads and invalidations; none starts or restores an Agent. */
export interface ScheduleCatalogDependencies {
  readonly catalog: () => Promise<RemoteResult<ScheduleCatalogEntry[]>>
  readonly subscribeChanged: (listener: () => void) => () => void
  readonly subscribeReset: (listener: () => void) => () => void
}

/** Product ownership derived from existing private and group Session bindings. */
export type ScheduleOwner =
  | { readonly kind: 'bot'; readonly key: string; readonly name: string }
  | { readonly kind: 'chat'; readonly key: string; readonly name: string }
  | { readonly kind: 'unlinked'; readonly key: 'unlinked' }

/** One owner and its unmodified authoritative task records. */
export interface ScheduleOwnerGroup {
  readonly owner: ScheduleOwner
  readonly records: readonly ScheduleCatalogEntry[]
}

/**
 * Resolve ownership without inspecting Session histories or guessing from titles.
 * Historical group executors remain group-owned after a member leaves.
 * @param sessionId - Original task binding or visible settings Session.
 * @param bots - Current private member bindings.
 * @param chats - Current groups, including historical executor bindings.
 * @returns The exact product owner, or an explicit unlinked owner.
 */
export function scheduleOwner(sessionId: SessionId, bots: readonly TeamBot[], chats: readonly TeamChat[]): ScheduleOwner {
  const bot = bots.find(member => member.sessionId === sessionId)
  if (bot !== undefined) return { kind: 'bot', key: `bot:${bot.id}`, name: bot.name }
  const chat = chats.find(group => group.rootSessionId === sessionId
    || group.executors.some(executor => executor.sessionId === sessionId))
  return chat === undefined ? { kind: 'unlinked', key: 'unlinked' }
    : { kind: 'chat', key: `chat:${chat.id}`, name: chat.name }
}

/**
 * Group tasks once by their original Session; no task data or bindings are rewritten.
 * @param records - Retained tasks from the public Schedule catalog.
 * @param bots - Current private members.
 * @param chats - Current groups and their retained execution bindings.
 * @returns Nonempty groups in directory order, followed by unlinked tasks; rows use next-target order.
 */
export function groupSchedules(
  records: readonly ScheduleCatalogEntry[], bots: readonly TeamBot[], chats: readonly TeamChat[],
): ScheduleOwnerGroup[] {
  const groups = new Map<string, { owner: ScheduleOwner; records: ScheduleCatalogEntry[] }>()
  const owners: ScheduleOwner[] = [
    ...bots.map(bot => ({ kind: 'bot' as const, key: `bot:${bot.id}`, name: bot.name })),
    ...chats.map(chat => ({ kind: 'chat' as const, key: `chat:${chat.id}`, name: chat.name })),
    { kind: 'unlinked', key: 'unlinked' },
  ]
  for (const owner of owners) groups.set(owner.key, { owner, records: [] })
  for (const record of records) groups.get(scheduleOwner(record.sessionId, bots, chats).key)?.records.push(record)
  return [...groups.values()].filter(group => group.records.length > 0).map(group => ({
    ...group, records: group.records.toSorted((left, right) => Date.parse(left.scheduledAt) - Date.parse(right.scheduledAt)),
  }))
}

/** One lifecycle-owned catalog whose visible consumers share reads and invalidations. */
export class ScheduleClientModel {
  /** Mounted views retain records and subscribe through framework-bound hooks. */
  readonly state: ObservableSnapshot<ScheduleView>
  private readonly source = createSnapshotStore<ScheduleView>({ phase: 'loading', records: [] })
  private consumers = 0
  private generation = 0
  private active = true
  private subscriptions: readonly (() => void)[] = []

  /** @param dependencies - Public catalog read and connection/task invalidations. */
  constructor(private readonly dependencies: ScheduleCatalogDependencies) {
    this.state = {
      getSnapshot: () => this.source.getSnapshot(),
      subscribe: (listener) => {
        const stop = this.source.subscribe(listener)
        if (this.active && ++this.consumers === 1) {
          const changed = () => { void this.reload() }
          this.subscriptions = [dependencies.subscribeChanged(changed), dependencies.subscribeReset(changed)]
          void this.reload()
        }
        return () => {
          stop()
          if (this.consumers > 0 && --this.consumers === 0) this.stop()
        }
      },
    }
  }

  /** Refresh once, fencing replies from older requests, connections and closed views. */
  async reload(): Promise<void> {
    if (!this.active) return
    const generation = ++this.generation
    this.source.set({ ...this.source.getSnapshot(), phase: 'loading' })
    let result: RemoteResult<ScheduleCatalogEntry[]>
    try { result = await this.dependencies.catalog() } catch (_error: unknown) {
      // Transport failures retain the last authoritative rows for an explicit retry.
      if (generation === this.generation) this.source.set({ ...this.source.getSnapshot(), phase: 'failed' })
      return
    }
    if (generation !== this.generation) return
    this.source.set(result.ok ? { phase: 'ready', records: result.value }
      : { ...this.source.getSnapshot(), phase: 'failed' })
  }

  /** Stop subscriptions and discard pending reads when the product plugin unloads. */
  dispose(): void { this.active = false; this.stop() }

  private stop(): void {
    this.generation++
    for (const unsubscribe of this.subscriptions) unsubscribe()
    this.subscriptions = []
  }
}
