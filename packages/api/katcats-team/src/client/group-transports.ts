/** Exact group-container delivery over the public Session transport registration. */
import type { ISessions, SessionTransportDisposer } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ChatPromptValue } from '../chats-types.ts'
import type { ChatRemote, ChatView } from './chat-model.ts'

/** Product-owned group delivery, composer availability and visible registration failures. */
export interface GroupTransportOptions {
  readonly sessions: Pick<ISessions, 'list' | 'registerTransport'>
  readonly chats: ObservableSnapshot<ChatView>
  readonly remote: Pick<ChatRemote, 'sendMessage' | 'cancelSession'>
  /** @param id - group container. @param blocked - whether ordinary submission must wait. */
  readonly block: (id: SessionId, blocked: boolean) => void
  /** @param id - unavailable group container. @param error - registration or teardown failure. */
  readonly failed: (id: SessionId, error: unknown) => void
  /** Capture this submission's scope; the returned callback runs only after durable acceptance. */
  readonly submitting?: (request: SessionPromptRequest) => (value: ChatPromptValue) => void
}

/**
 * Register known group containers before enabling their existing composers.
 * @param options - catalog, explicit group rows and product delivery handlers.
 * @returns awaited teardown; previously claimed ids remain quarantined by the Session service.
 */
export function installGroupTransports(options: GroupTransportOptions): () => Promise<void> {
  const registrations = new Map<SessionId, { readonly release: SessionTransportDisposer; closing: boolean }>()
  const pending = new Set<Promise<void>>()
  const failures = new Set<SessionId>()
  let disposed = false
  const synchronize = (): void => {
    if (disposed) return
    const wanted = new Set(options.chats.getSnapshot().snapshot?.chats.map(chat => chat.rootSessionId) ?? [])
    const known = options.sessions.list.getSnapshot()
    for (const id of wanted) {
      const existing = registrations.get(id)
      if (existing !== undefined && !existing.closing) continue
      options.block(id, true)
      if (existing !== undefined || failures.has(id) || !known.ids.includes(id)) continue
      try {
        const release = options.sessions.registerTransport(id, {
          prompt: async (request, signal) => {
            const accepted = options.submitting?.(request)
            const result = await options.remote.sendMessage(request, signal)
            if (result.ok && !signal?.aborted) accepted?.(result.value)
            return result
          },
          cancel: request => options.remote.cancelSession(request),
        })
        registrations.set(id, { release, closing: false })
        options.block(id, false)
      } catch (error: unknown) {
        failures.add(id)
        options.failed(id, error)
      }
    }
    for (const [id, entry] of registrations) {
      if (wanted.has(id) || entry.closing) continue
      entry.closing = true
      options.block(id, true)
      const closing = entry.release().then(() => {
        if (registrations.get(id) === entry) registrations.delete(id)
      }, (error: unknown) => {
        failures.add(id)
        options.failed(id, error)
      }).finally(() => { pending.delete(closing); synchronize() })
      pending.add(closing)
    }
  }
  const stopChats = options.chats.subscribe(synchronize)
  const stopSessions = options.sessions.list.subscribe(synchronize)
  synchronize()
  return async () => {
    disposed = true
    stopChats()
    stopSessions()
    for (const id of registrations.keys()) options.block(id, true)
    await Promise.all([...registrations.values()].map(entry => entry.release()))
    await Promise.all(pending)
    registrations.clear()
  }
}
