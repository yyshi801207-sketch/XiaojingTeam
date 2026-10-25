/** Exact transport ownership, quarantine and asynchronous consumer teardown. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload/types'
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionCancelValue, SessionPromptRequest } from '../src/types.ts'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionTransport } from '../src/client/contract/session-transport.ts'
import { SessionTransportRegistry } from '../src/client/sessions/transports.ts'

const id = 'transport-fixture' as SessionId
const accepted = { ok: true, value: { accepted: true } } as const
const request: SessionPromptRequest = {
  sessionId: id, requestId: 'fixture-request' as SessionPromptRequest['requestId'],
  mode: 'queue', content: [{ type: 'image', mediaType: 'image/png', data: 'AA==' },
    { type: 'file', receiptId: brandString<FileUploadReceiptId>('staged-file') }, { type: 'text', text: 'Hello' }], clientTimeZone: 'Asia/Shanghai',
}
const handlers = (): SessionTransport => ({
  prompt: vi.fn(async () => accepted), cancel: vi.fn(async () => accepted),
})

describe('exact Session transport registrations', () => {
  it('routes the original request and signal without mutating ordered content', async () => {
    const registry = new SessionTransportRegistry()
    const implementation = handlers()
    const release = registry.register(id, implementation)
    const transport = registry.get(id)
    if (transport === undefined) throw new Error('missing registered transport')
    const caller = new AbortController()
    await expect(transport.prompt(request, caller.signal)).resolves.toEqual(accepted)
    expect(implementation.prompt).toHaveBeenCalledWith(request, expect.any(AbortSignal))
    expect(vi.mocked(implementation.prompt).mock.calls[0]?.[0]).toBe(request)
    await expect(transport.cancel({ sessionId: id })).resolves.toEqual(accepted)
    expect(implementation.cancel).toHaveBeenCalledWith({ sessionId: id })
    await release()
    expect(await registry.get(id)?.prompt(request)).toMatchObject({
      ok: false, error: { code: 'session/client-transport-unavailable' },
    })
  })

  it('refuses overlap and waits for an already-started cancellation before releasing', async () => {
    const registry = new SessionTransportRegistry()
    const gate = Promise.withResolvers<RemoteResult<SessionCancelValue>>()
    const release = registry.register(id, { ...handlers(), cancel: () => gate.promise })
    const transport = registry.get(id)
    if (transport === undefined) throw new Error('missing registered transport')
    const cancelling = transport.cancel({ sessionId: id })
    const closing = release()
    expect(registry.get(id)).toBe(transport)
    expect(() => registry.register(id, handlers())).toThrow('already registered')
    expect(await transport.prompt(request)).toMatchObject({
      ok: false, error: { code: 'session/client-transport-unavailable' },
    })
    gate.resolve(accepted)
    await cancelling
    await closing
    const newer = registry.register(id, handlers())
    await release()
    expect(registry.get(id)).not.toBeUndefined()
    await newer()
  })

  it('aborts admission on provider release and awaits its settlement', async () => {
    const registry = new SessionTransportRegistry()
    let observed: AbortSignal | undefined
    const release = registry.register(id, {
      ...handlers(),
      prompt: async (_request, signal) => {
        if (signal === undefined) throw new Error('missing admission signal')
        observed = signal
        await new Promise<void>(resolve => signal.addEventListener('abort', () => { resolve() }, { once: true }))
        throw new RemoteError('session/client-transport-unavailable', 'Unloading', { sessionId: id })
      },
    })
    const transport = registry.get(id)
    if (transport === undefined) throw new Error('missing registered transport')
    const sending = transport.prompt(request)
    await release()
    expect(observed?.aborted).toBe(true)
    expect(await sending).toMatchObject({
      ok: false, error: { code: 'session/client-transport-unavailable' },
    })
    await registry.dispose()
    expect(() => registry.register(id, handlers())).toThrow('disposed')
  })

  it('preserves typed failures and reports unexpected handler failures without retry', async () => {
    const registry = new SessionTransportRegistry()
    const denied = new RemoteError('session/client-transport-unavailable', 'Unavailable', { sessionId: id })
    const implementation: SessionTransport = {
      prompt: vi.fn(async () => { throw denied }),
      cancel: vi.fn(async () => { throw new Error('Unexpected failure') }),
    }
    const release = registry.register(id, implementation)
    const transport = registry.get(id)
    if (transport === undefined) throw new Error('missing registered transport')
    const result = await transport.prompt(request)
    expect(result.ok ? undefined : result.error).toBe(denied)
    expect(await transport.cancel({ sessionId: id })).toMatchObject({
      ok: false, error: { code: 'session/client-transport-failed', details: { sessionId: id, operation: 'cancel' } },
    })
    expect(implementation.prompt).toHaveBeenCalledTimes(1)
    expect(implementation.cancel).toHaveBeenCalledTimes(1)
    await release()
  })

  it('tracks a provider before it can synchronously release its registration', async () => {
    const registry = new SessionTransportRegistry()
    const gate = Promise.withResolvers<RemoteResult<SessionCancelValue>>()
    let closing: Promise<void> | undefined
    const release = registry.register(id, {
      ...handlers(), cancel: () => { closing = release(); return gate.promise },
    })
    const transport = registry.get(id)
    if (transport === undefined) throw new Error('missing registered transport')
    const cancelling = transport.cancel({ sessionId: id })
    expect(closing).toBeDefined()
    expect(() => registry.register(id, handlers())).toThrow('already registered')
    gate.resolve(accepted)
    await cancelling
    await closing
    expect(await registry.get(id)?.cancel({ sessionId: id })).toMatchObject({
      ok: false, error: { code: 'session/client-transport-unavailable' },
    })
  })

  it('returns the same release while abort callbacks reenter teardown', async () => {
    const registry = new SessionTransportRegistry()
    let repeated: Promise<void> | undefined
    const release = registry.register(id, {
      ...handlers(), prompt: async (_request, signal) => {
        if (signal === undefined) throw new Error('missing admission signal')
        await new Promise<void>(resolve => signal.addEventListener('abort', () => {
          repeated = release()
          resolve()
        }, { once: true }))
        return accepted
      },
    })
    const sending = registry.get(id)?.prompt(request)
    const closing = release()
    expect(repeated).toBe(closing)
    await closing
    await sending
    expect(registry.get('never-claimed' as SessionId)).toBeUndefined()
  })
})
