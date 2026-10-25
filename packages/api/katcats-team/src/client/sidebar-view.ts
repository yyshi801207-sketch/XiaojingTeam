/** Persistent sidebar folds and the product-owned scroll affordance. */
import { createSnapshotStore, defineStore } from '@deepseek-ai/dsh-client-store'

/** Saved presentation preferences, independent from member and Session records. */
export interface SidebarViewState {
  collapsedGroups: Record<string, boolean>
}

/**
 * Declare the root-scoped Katcats sidebar preferences.
 * @returns A framework-owned store; groups without a saved choice start expanded.
 */
export function createSidebarViewStore() {
  return defineStore({
    init: (): SidebarViewState => ({ collapsedGroups: {} }),
    persist: 'katcats.sidebar.view.v1',
    actions: {
      setGroupCollapsed: (draft, id: string, collapsed: boolean) => { draft.collapsedGroups[id] = collapsed },
    },
  })
}

/**
 * Observe actual content below the list viewport without changing its scroll position.
 * @returns The injected snapshot, DOM attachment, scroll action, and lifecycle disposer.
 */
export function createSidebarOverflow() {
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
