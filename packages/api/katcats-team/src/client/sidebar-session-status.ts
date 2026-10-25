/** Public question-card changes refresh the sidebar's existing Session status read. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-ui-user-questions/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'

/**
 * Observe internal question settlement without retaining or navigating an executor.
 * @param source - Public Session status source owned by ui-session.
 * @returns A sidebar source and a disposer owned by the product plugin effect.
 */
export function createSidebarSessionStatus(source: ObservableSnapshot<SessionStatusSnapshot>): {
  readonly source: ObservableSnapshot<SessionStatusSnapshot>
  readonly dispose: () => void
} {
  let snapshot = source.getSnapshot()
  const listeners = new Set<() => void>()
  let questions: (() => void)[] = []
  const publish = (): void => {
    snapshot = new Map(source.getSnapshot())
    for (const listener of listeners) listener()
  }
  const bind = (): void => {
    for (const stop of questions) stop()
    questions = []
    for (const status of source.getSnapshot().values()) {
      const pending = status.pendingInteraction
      if (pending?.kind !== 'question' && pending?.kind !== 'plan-review') continue
      let previous = pending.getSnapshot()
      questions.push(pending.subscribe(() => {
        const next = pending.getSnapshot()
        if (previous.state === next.state && previous.channel === next.channel && previous.closed === next.closed) return
        previous = next
        publish()
      }))
    }
    publish()
  }
  const stop = source.subscribe(bind)
  bind()
  return {
    source: { getSnapshot: () => snapshot,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
    dispose: () => { stop(); for (const release of questions) release(); questions = []; listeners.clear() },
  }
}
