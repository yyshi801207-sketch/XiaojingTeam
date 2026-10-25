/** Exact-Session transport registrations and awaited consumer teardown. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, remoteErrorOf, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionTransport, SessionTransportDisposer } from '../contract/session-transport.ts'

interface Registration {
  readonly transport: SessionTransport
  readonly abort: AbortController
  readonly pending: Set<Promise<unknown>>
  closing: boolean
  disposal: Promise<void> | undefined
}

function unavailable(id: SessionId): RemoteResult<never> {
  return { ok: false,
    error: new RemoteError('session/client-transport-unavailable', 'Session transport is unavailable', { sessionId: id }) }
}

function quarantine(id: SessionId): SessionTransport {
  return { prompt: () => Promise.resolve(unavailable(id)), cancel: () => Promise.resolve(unavailable(id)) }
}

/** ClientSessions owns registrations independently from retained Session generations. */
export class SessionTransportRegistry {
  private readonly entries = new Map<SessionId, Registration>()
  private readonly quarantined = new Map<SessionId, SessionTransport>()
  private closed = false

  /**
   * Resolve custom or quarantined delivery for a previously claimed identity.
   * @param id - top-level Session identity.
   * @returns custom or quarantined handlers, or undefined when never claimed.
   */
  get(id: SessionId): SessionTransport | undefined {
    return this.entries.get(id)?.transport ?? this.quarantined.get(id)
  }

  /**
   * Claim both delivery operations for one Session.
   * @param id - exact Session identity; the public service verifies catalog eligibility.
   * @param implementation - provider-owned admission and cancellation.
   * @returns idempotent asynchronous release; overlapping registrations throw.
   */
  register(id: SessionId, implementation: SessionTransport): SessionTransportDisposer {
    if (this.closed) throw new Error('Session transports are disposed')
    if (this.entries.has(id)) throw new Error('Session transport is already registered: ' + id)
    const abort = new AbortController()
    const pending = new Set<Promise<unknown>>()
    if (!this.quarantined.has(id)) {
      this.quarantined.set(id, quarantine(id))
    }
    const invoke = <Value>(
      operation: 'prompt' | 'cancel',
      run: () => Promise<RemoteResult<Value>>,
    ): Promise<RemoteResult<Value>> => {
      if (entry.closing) return Promise.resolve(unavailable(id))
      const task = Promise.withResolvers<RemoteResult<Value>>()
      pending.add(task.promise)
      void task.promise.then(() => { pending.delete(task.promise) })
      const failed = (error: unknown): void => {
        task.resolve({
          ok: false,
          error: remoteErrorOf(error) ?? new RemoteError(
            'session/client-transport-failed', 'Session transport failed',
            { sessionId: id, operation }, { cause: error },
          ),
        })
      }
      try { void run().then(task.resolve, failed) } catch (error: unknown) { failed(error) }
      return task.promise
    }
    const entry: Registration = {
      abort, pending, closing: false, disposal: undefined,
      transport: {
        prompt: (request, signal) => invoke('prompt', async () => {
          const combined = signal === undefined ? abort.signal : AbortSignal.any([signal, abort.signal])
          combined.throwIfAborted()
          return implementation.prompt(request, combined)
        }),
        cancel: request => invoke('cancel', () => implementation.cancel(request)),
      },
    }
    this.entries.set(id, entry)
    return () => this.release(id, entry)
  }

  /**
   * Stop registration and await every captured provider call before root teardown completes.
   * @returns provider teardown completion.
   */
  async dispose(): Promise<void> {
    this.closed = true
    await Promise.all([...this.entries].map(([id, entry]) => this.release(id, entry)))
  }

  private release(id: SessionId, entry: Registration): Promise<void> {
    if (entry.disposal !== undefined) return entry.disposal
    const completion = Promise.withResolvers<void>()
    entry.disposal = completion.promise
    entry.closing = true
    entry.abort.abort(new Error('Session transport is unloading'))
    void Promise.all([...entry.pending]).then(() => {
      if (this.entries.get(id) === entry) this.entries.delete(id)
      completion.resolve()
    })
    return completion.promise
  }
}
