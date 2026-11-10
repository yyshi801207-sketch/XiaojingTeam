/** Durable-admission notices scoped to the original retained group Session. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'

/** Acceptance is system feedback, never an assistant message or a completion claim. */
export interface GroupMessageReceipt {
  readonly requestId: SessionPromptRequest['requestId']
  readonly mode: SessionPromptRequest['mode']
  readonly generation: number
}

/** Borrowed Session bindings do not retain Sessions or install background subscriptions. */
export interface GroupMessageFeedbackOptions {
  readonly binding: (id: SessionId) => SessionBinding | undefined
  readonly connection: Pick<ConnectionHandle, 'state' | 'generation'>
}

/**
 * Track only the latest submission on each live binding, discarding stale acknowledgements.
 * @param options - Exact Session lookup and active Host connection.
 * @returns Binding-owned observable notices, acceptance capture and plugin teardown.
 */
export function createGroupMessageFeedback(options: GroupMessageFeedbackOptions): {
  source: (binding: SessionBinding | undefined) => ObservableSnapshot<GroupMessageReceipt | null>
  submitting: (request: SessionPromptRequest) => () => void
  dispose: () => void
} {
  const sources = new WeakMap<SessionBinding, ReturnType<typeof entry>>()
  const absent = createSnapshotStore<GroupMessageReceipt | null>(null)
  let disposed = false
  function entry() {
    return { source: createSnapshotStore<GroupMessageReceipt | null>(null), sequence: 0, request: '' }
  }
  const valueFor = (binding: SessionBinding): ReturnType<typeof entry> => {
    let value = sources.get(binding)
    if (value === undefined) { value = entry(); sources.set(binding, value) }
    return value
  }
  const source = (binding: SessionBinding | undefined): ObservableSnapshot<GroupMessageReceipt | null> =>
    binding === undefined ? absent : valueFor(binding).source
  const submitting = (request: SessionPromptRequest): (() => void) => {
    const binding = options.binding(request.sessionId)
    const generation = options.connection.generation.getSnapshot()
    if (disposed || binding === undefined || generation === undefined
      || options.connection.state.getSnapshot() !== 'connected') return () => {}
    const value = valueFor(binding)
    const key = JSON.stringify([generation.id, request.requestId, request.mode])
    if (value.request !== key) {
      value.request = key
      value.sequence++
      value.source.set(null)
    }
    const sequence = value.sequence
    return () => {
      if (disposed || options.binding(request.sessionId) !== binding || value.sequence !== sequence
        || options.connection.state.getSnapshot() !== 'connected'
        || options.connection.generation.getSnapshot() !== generation) return
      const current = value.source.getSnapshot()
      if (current?.requestId === request.requestId && current.mode === request.mode && current.generation === generation.id) return
      value.source.set({ requestId: request.requestId, mode: request.mode, generation: generation.id })
    }
  }
  return { source, submitting, dispose: (): void => { disposed = true } }
}
