/** Persistent sidebar folds and the product-owned scroll affordance. */
import { createSnapshotStore, defineStore, type EngineStoreHandle, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { GroupId } from '../types.ts'

/** Saved presentation preferences, independent from member and Session records. */
export interface SidebarViewState {
  collapsedGroups: Record<string, boolean>
  /** Older preferences leave the main Bot expanded. */
  mainCollapsed?: boolean
  /** Missing on previously saved preferences; entries retain their Session identities. */
  entryOrder?: Record<string, readonly SessionId[]>
}

/**
 * Apply saved member ordering within the pinned and ordinary sections of one group.
 * @param ids - Current Bot and chat Session identities in their default directory order.
 * @param order - Saved browser-local order; absent or departed identities are ignored.
 * @param pinnedIds - Registry pin order, used for pins without a saved position.
 * @returns Current identities once each, pinned first; newly seen entries follow saved entries in their section.
 */
export function orderSidebarEntries(
  ids: readonly SessionId[], order: readonly SessionId[] | undefined, pinnedIds: readonly SessionId[],
): readonly SessionId[] {
  const current = new Set(ids)
  const pinned = new Set(pinnedIds)
  const saved = (Array.isArray(order) ? order as readonly SessionId[] : []).filter(id => current.has(id))
  const entries = [...new Set([...saved, ...pinnedIds.filter(id => current.has(id)), ...ids])]
  return [...entries.filter(id => pinned.has(id)), ...entries.filter(id => !pinned.has(id))]
}

/**
 * Declare the root-scoped Katcats sidebar preferences.
 * @returns A framework-owned store; groups without a saved choice start expanded.
 */
export function createSidebarViewStore(): EngineStoreHandle<SidebarViewState, {
  setMainCollapsed: (draft: SidebarViewState, collapsed: boolean) => void
  setGroupCollapsed: (draft: SidebarViewState, id: string, collapsed: boolean) => void
  setEntryOrder: (draft: SidebarViewState, id: GroupId, ids: readonly SessionId[]) => void
}> {
  return defineStore({
    init: (): SidebarViewState => ({ collapsedGroups: {} }),
    persist: 'katcats.sidebar.view.v1',
    actions: {
      setMainCollapsed: (draft, collapsed: boolean) => { draft.mainCollapsed = collapsed },
      setGroupCollapsed: (draft, id: string, collapsed: boolean) => { draft.collapsedGroups[id] = collapsed },
      setEntryOrder: (draft, id: GroupId, ids: readonly SessionId[]) => {
        draft.entryOrder ??= {}
        draft.entryOrder[id] = [...ids]
      },
    },
  })
}

/**
 * Observe actual content below the list viewport without changing its scroll position.
 * @returns The injected snapshot, DOM attachment, scroll action, and lifecycle disposer.
 */
export function createSidebarOverflow(): {
  source: SnapshotStore<boolean>
  attach: (element: HTMLDivElement | null) => void
  scrollDown: () => void
  dispose: () => void
} {
  const source = createSnapshotStore(false)
  let list: HTMLDivElement | null = null
  let observer: ResizeObserver | undefined
  const update = (): void => {
    source.set(list !== null && list.scrollHeight - list.clientHeight - list.scrollTop > 1)
  }
  const attach = (element: HTMLDivElement | null): void => {
    observer?.disconnect()
    observer = undefined
    list?.removeEventListener('scroll', update)
    list = element
    if (element !== null) {
      element.addEventListener('scroll', update, { passive: true })
      observer = new ResizeObserver(update)
      observer.observe(element)
      // The inner wrapper grows when members arrive or a group expands.
      if (element.firstElementChild !== null) observer.observe(element.firstElementChild)
    }
    update()
  }
  return {
    source,
    attach,
    scrollDown: (): void => {
      list?.scrollBy({
        top: Math.max(1, list.clientHeight * .75),
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      })
    },
    dispose: (): void => { attach(null) },
  }
}
