/** The global window owns only read subscriptions, never execution or cancellation. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ChatId } from '../chats-types.ts'
import type { RoomActivitySnapshot } from './room-activity.ts'
import type { WatchRoomActivity } from './RoomActivity.tsx'

/** Independent global-room visibility and group selection. */
export interface HeadquartersState {
  readonly open: boolean
  readonly selected: ChatId | null
  readonly activity: RoomActivitySnapshot
}

/**
 * Own one selected group's executor subscription, releasing it before switching groups.
 * @param watch - Existing read-only group journal observer.
 * @returns Window commands and a framework-injected snapshot source.
 */
export function createHeadquartersState(watch: WatchRoomActivity) {
  const empty: RoomActivitySnapshot = { connected: false, members: [] }
  const source = createSnapshotStore<HeadquartersState>({ open: false, selected: null, activity: empty })
  let controller: AbortController | null = null
  let unsubscribe = () => {}
  const release = () => { unsubscribe(); unsubscribe = () => {}; controller?.abort(); controller = null }
  const select = (selected: ChatId | null) => {
    release()
    source.set({ ...source.getSnapshot(), selected, activity: empty })
    if (!source.getSnapshot().open || selected === null) return
    const lifetime = new AbortController()
    controller = lifetime
    const activity = watch(selected, lifetime.signal)
    const read = () => {
      if (!lifetime.signal.aborted) source.set({ ...source.getSnapshot(), activity: activity.getSnapshot() })
    }
    unsubscribe = activity.subscribe(read)
    read()
  }
  return { source, select,
    open: () => { source.set({ ...source.getSnapshot(), open: true }); select(source.getSnapshot().selected) },
    close: () => { release(); source.set({ ...source.getSnapshot(), open: false, activity: empty }) },
    dispose: release,
  }
}
