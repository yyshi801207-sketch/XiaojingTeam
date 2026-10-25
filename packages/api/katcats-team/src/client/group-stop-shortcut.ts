/** Group-container Escape cancellation follows real member activity rather than model turns. */
import type { ISessions, SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { Shortcuts } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { UiSession } from '@deepseek-ai/dsh-client-ui-session/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatRunId } from '../chats-types.ts'
import type { ChatView } from './chat-model.ts'

interface StopTarget {
  readonly sessionId: SessionId
  readonly runId: ChatRunId | null
  readonly generation: number
  readonly binding: SessionBinding
  readonly region: Element
  readonly deadline: number
}

/**
 * Reuse the fixed double-Escape gesture only inside a running group's composer.
 * @param shortcuts - public input arbitration and configured sequence interval.
 * @param sessions - retained Session bindings; private conversations are never claimed.
 * @param chats - actual product group runs and member activity.
 * @param uiSession - original pending-interaction ownership.
 * @param cancel - original group-container Session cancellation.
 * @param failed - localized visible cancellation failure reporter.
 * @returns awaited cleanup of observations, timer and captured cancellations.
 */
export function installGroupStopShortcut(
  shortcuts: Pick<Shortcuts, 'observeFixedInput' | 'stopSequenceMs'>,
  sessions: Pick<ISessions, 'binding' | 'list'>,
  chats: ObservableSnapshot<ChatView>,
  uiSession: Pick<UiSession, 'sessionStatus'>,
  cancel: (id: SessionId) => Promise<void>,
  failed: () => void,
): () => Promise<void> {
  let first: StopTarget | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const pending = new Set<Promise<void>>()
  const stopping = new Set<SessionId>()
  const reset = (): void => { first = undefined; clearTimeout(timer); timer = undefined }
  const target = (id: SessionId, region: Element): StopTarget | undefined => {
    const view = chats.getSnapshot()
    const chat = view.snapshot?.chats.find(item => item.rootSessionId === id)
    const activity = view.snapshot?.activities.find(item => item.chatId === chat?.id)
    const binding = sessions.binding(id)
    if (stopping.has(id) || view.phase !== 'ready' || chat === undefined || binding === undefined || binding.session.getSnapshot().removed
      || activity?.pendingControl === 'stop' || chat.status === 'stopped'
      || uiSession.sessionStatus.getSnapshot().get(id)?.pendingInteraction !== undefined
      || (activity?.processing !== true && (activity?.runningBotIds.length ?? 0) === 0)) return undefined
    return { sessionId: id, runId: chat.run?.id ?? null, generation: chat.generation,
      binding, region, deadline: performance.now() + shortcuts.stopSequenceMs }
  }
  const same = (a: StopTarget, b: StopTarget): boolean => a.sessionId === b.sessionId && a.runId === b.runId
    && a.generation === b.generation && a.binding === b.binding && a.region === b.region
  const changed = (): void => {
    if (first === undefined) return
    const current = target(first.sessionId, first.region)
    if (current === undefined || !same(first, current)) reset()
  }
  const off = shortcuts.observeFixedInput((input) => {
    if (input.type === 'reset') { reset(); return }
    const { gesture, context } = input
    if (gesture.code !== 'Escape' || gesture.repeat || gesture.composing || gesture.defaultPrevented
      || gesture.control || gesture.alt || gesture.shift || gesture.meta || context.modal !== null
      || context.region === 'terminal' || context.target === null) { reset(); return }
    const occurrence = context.target.closest<HTMLElement>('[data-conversation-session]')
    const region = context.target.closest('[data-conversation-region]')
    if (occurrence === null || region?.getAttribute('data-conversation-region') !== 'composer'
      || !occurrence.contains(region)
      || context.target.closest('[data-approval-key], [data-katcats-approval], iframe, .xterm, [inert]') !== null) { reset(); return }
    const id = occurrence.dataset.conversationSession as SessionId
    const current = target(id, region)
    if (current === undefined) { reset(); return }
    input.consume()
    const previous = first
    reset()
    if (previous === undefined || !same(previous, current) || performance.now() > previous.deadline) {
      first = current
      timer = setTimeout(reset, shortcuts.stopSequenceMs + 1)
      return
    }
    const operation = Promise.withResolvers<void>()
    pending.add(operation.promise)
    stopping.add(id)
    void operation.promise.then(() => { pending.delete(operation.promise); stopping.delete(id) })
    void (async () => {
      try { await cancel(id) } catch (_error) { failed() }
    })().then(operation.resolve, operation.reject)
  })
  const subscriptions = [chats.subscribe(changed), sessions.list.subscribe(changed), uiSession.sessionStatus.subscribe(changed)]
  return async () => { off(); reset(); for (const release of subscriptions) release(); await Promise.all(pending) }
}
