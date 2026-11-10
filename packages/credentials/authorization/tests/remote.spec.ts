import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { PeerId, PeerScope, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import AuthorizationService, { type AuthorizationRemoteEvent } from '@deepseek-ai/dsh-authorization'
import { MemoryCredentials } from './memory.ts'

const KEY = credentialKey('fixture', 'subscription')
const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
})

async function fixture(): Promise<{ ctx: Context; peer: PeerScope; caller: AuthorizationService }> {
  const ctx = new Context()
  const credentials = ctx.plugin(MemoryCredentials)
  await credentials
  const authorization = ctx.plugin(AuthorizationService)
  await authorization
  disposers.push(async () => { await authorization.dispose(); await credentials.dispose() })
  const peer = peerOf(ctx, 'one')
  return { ctx, peer, caller: callerOf(ctx, peer) }
}

function peerOf(ctx: Context, id: string): PeerScope {
  const controller = new AbortController()
  return {
    id: id as PeerId, ctx, principal: { kind: 'owner' }, signal: controller.signal, interactions: 'none',
    dispose: () => { controller.abort(); return Promise.resolve() },
  }
}

function callerOf(ctx: Context, peer: PeerScope): AuthorizationService {
  const invocation: RemoteInvocation = {
    service: 'authorization', request: { namespace: 'authorization', method: 'begin', args: {} },
    peer, signal: peer.signal, uplink: () => ({ async *[Symbol.asyncIterator]() {} }),
  }
  return ctx.extend({ invocation }).authorization
}

async function eventOf(iterator: AsyncIterator<AuthorizationRemoteEvent>): Promise<AuthorizationRemoteEvent> {
  const next = await iterator.next()
  if (next.done) throw new Error('authorization stream ended before the expected event')
  return next.value
}

describe('authorization Remote conversation', () => {
  it('streams notices and signal-free questions, then stores answers only on the Host', async () => {
    const { ctx, caller } = await fixture()
    const promptSignal = new AbortController()
    ctx.authorization.registerFlow({
      key: KEY, label: 'Subscription', methods: [{ id: 'oauth', label: 'Sign in' }],
      async run(session) {
        session.notify({ message: 'Open sign in', url: 'https://example.test/auth' })
        const answer = await session.prompt({ kind: 'secret', message: 'Code', signal: promptSignal.signal })
        await session.commit({ kind: 'grant', payload: { token: answer } })
      },
    })
    const iterator = caller.beginRemote({ key: KEY }, new AbortController().signal)[Symbol.asyncIterator]()
    const notice = await eventOf(iterator)
    const question = await eventOf(iterator)
    expect(notice).toEqual({ type: 'notice', notice: { message: 'Open sign in', url: 'https://example.test/auth' } })
    expect(question).toMatchObject({ type: 'prompt', prompt: { kind: 'secret', message: 'Code' } })
    if (question.type !== 'prompt') throw new Error('expected prompt')
    expect(question.prompt).not.toHaveProperty('signal')
    caller.answer({ key: KEY, id: question.id, answer: 'test-only-secret' })
    const settled = await eventOf(iterator)
    expect(settled).toEqual({ type: 'settled', outcome: { status: 'authorized' } })
    expect(await iterator.next()).toEqual({ done: true, value: undefined })
    expect(await caller.status(KEY)).toEqual({ configured: true, writable: true, kind: 'grant', inFlight: false })
    expect(JSON.stringify([notice, question, settled, await caller.status(KEY)])).not.toContain('test-only-secret')
  })

  it('refuses another Peer answering or cancelling the initiating Peers question', async () => {
    const { ctx, caller } = await fixture()
    ctx.authorization.registerFlow({
      key: KEY, label: 'Subscription', methods: [{ id: 'oauth', label: 'Sign in' }],
      async run(session) { await session.prompt({ kind: 'text', message: 'Code' }) },
    })
    const iterator = caller.beginRemote({ key: KEY }, new AbortController().signal)[Symbol.asyncIterator]()
    const question = await eventOf(iterator)
    if (question.type !== 'prompt') throw new Error('expected prompt')
    const other = callerOf(ctx, peerOf(ctx, 'two'))
    expect(() => { other.answer({ key: KEY, id: question.id, answer: 'foreign' }) }).toThrow('another Peer')
    await expect(other.cancelAttempt(KEY)).rejects.toMatchObject({ code: 'authorization/not-owned' })
    await caller.cancelAttempt(KEY)
    expect(await eventOf(iterator)).toEqual({ type: 'settled', outcome: { status: 'cancelled' } })
    await iterator.next()
    await expect(caller.cancelAttempt(KEY)).resolves.toBeUndefined()
  })

  it('withdraws a losing prompt and refuses its stale answer without cancelling the flow', async () => {
    const { ctx, caller } = await fixture()
    const promptSignal = new AbortController()
    ctx.authorization.registerFlow({
      key: KEY, label: 'Subscription', methods: [{ id: 'oauth', label: 'Sign in' }],
      async run(session) {
        await session.prompt({ kind: 'text', message: 'Code', signal: promptSignal.signal }).catch(() => {})
        await session.commit({ kind: 'grant', payload: {} })
      },
    })
    const iterator = caller.beginRemote({ key: KEY }, new AbortController().signal)[Symbol.asyncIterator]()
    const question = await eventOf(iterator)
    if (question.type !== 'prompt') throw new Error('expected prompt')
    promptSignal.abort()
    expect(await eventOf(iterator)).toEqual({ type: 'prompt-withdrawn', id: question.id })
    expect(() => { caller.answer({ key: KEY, id: question.id, answer: 'stale' }) }).toThrow('no longer pending')
    expect(await eventOf(iterator)).toEqual({ type: 'settled', outcome: { status: 'authorized' } })
    await iterator.next()
  })

  it.each(['carrier', 'peer', 'iterator'] as const)('cancels when the %s closes', async (closed) => {
    const { ctx, peer, caller } = await fixture()
    let flowSignal: AbortSignal | undefined
    ctx.authorization.registerFlow({
      key: KEY, label: 'Subscription', methods: [{ id: 'oauth', label: 'Sign in' }],
      async run(session) { flowSignal = session.signal; await session.prompt({ kind: 'text', message: 'Code' }) },
    })
    const carrier = new AbortController()
    const iterator = caller.beginRemote({ key: KEY }, carrier.signal)[Symbol.asyncIterator]()
    await eventOf(iterator)
    if (closed === 'carrier') carrier.abort()
    else if (closed === 'peer') await peer.dispose()
    else await iterator.return?.()
    if (closed !== 'iterator') {
      expect(await eventOf(iterator)).toEqual({ type: 'settled', outcome: { status: 'cancelled' } })
      await iterator.next()
    }
    expect(flowSignal?.aborted).toBe(true)
    expect(await caller.status(KEY)).toEqual({ configured: false, writable: true, inFlight: false })
  })

  it('waits for an admitted commit before deleting and refuses attempts during deletion', async () => {
    const { ctx, caller } = await fixture()
    const committing = Promise.withResolvers<undefined>()
    const finish = Promise.withResolvers<undefined>()
    const modify = ctx.credentials.modifyRecord.bind(ctx.credentials)
    vi.spyOn(ctx.credentials, 'modifyRecord').mockImplementation(async (key, mutate) => {
      committing.resolve(undefined)
      await finish.promise
      return modify(key, mutate)
    })
    ctx.authorization.registerFlow({
      key: KEY, label: 'Subscription', methods: [{ id: 'oauth', label: 'Sign in' }],
      async run(session) {
        session.notify({ message: 'Starting' })
        await session.commit({ kind: 'grant', payload: { token: 'host-only' } })
      },
    })
    const iterator = caller.beginRemote({ key: KEY }, new AbortController().signal)[Symbol.asyncIterator]()
    await eventOf(iterator)
    await committing.promise
    const remove = vi.spyOn(ctx.credentials, 'deleteRecord')
    const disconnect = caller.disconnect(KEY)
    expect(remove).not.toHaveBeenCalled()
    await expect(ctx.authorization.begin({ key: KEY, interaction: { notify() {}, prompt: () => Promise.resolve('') } }))
      .rejects.toMatchObject({ code: 'ALREADY_IN_FLIGHT' })
    finish.resolve(undefined)
    await disconnect
    expect(remove).toHaveBeenCalledOnce()
    await eventOf(iterator)
    await iterator.next()
    expect(await caller.status(KEY)).toEqual({ configured: false, writable: true, inFlight: false })
  })

  it('redacts flow failures before returning them to the Client', async () => {
    const { ctx, caller } = await fixture()
    ctx.authorization.registerFlow({
      key: KEY, label: 'Subscription', methods: [{ id: 'oauth', label: 'Sign in' }],
      run: () => Promise.reject(new Error('token=test-only-secret')),
    })
    const iterator = caller.beginRemote({ key: KEY }, new AbortController().signal)[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toMatchObject({
      code: 'authorization/failed', message: 'Authorization failed; try signing in again', details: {},
    })
    expect(ctx.authorization.describe(KEY)?.inFlight).toBe(false)
  })

  it('rejects an unoffered selection while retaining the pending question', async () => {
    const { ctx, caller } = await fixture()
    ctx.authorization.registerFlow({
      key: KEY, label: 'Subscription', methods: [{ id: 'oauth', label: 'Sign in' }],
      async run(session) {
        const answer = await session.prompt({ kind: 'select', message: 'Account', options: [{ id: 'one', label: 'One' }] })
        await session.commit({ kind: 'grant', payload: { account: answer } })
      },
    })
    const iterator = caller.beginRemote({ key: KEY }, new AbortController().signal)[Symbol.asyncIterator]()
    const question = await eventOf(iterator)
    if (question.type !== 'prompt') throw new Error('expected prompt')
    expect(() => { caller.answer({ key: KEY, id: question.id, answer: 'unoffered' }) })
      .toThrow('not an offered option')
    caller.answer({ key: KEY, id: question.id, answer: 'one' })
    expect(await eventOf(iterator)).toEqual({ type: 'settled', outcome: { status: 'authorized' } })
    await iterator.next()
  })

  it('reports failed credential reads and deletions without exposing provider diagnostics', async () => {
    const { ctx, caller } = await fixture()
    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: { token: 'host-only' } }))
    const failure = new Error('sensitive-provider-diagnostic')
    vi.spyOn(ctx.credentials, 'describeRecord').mockRejectedValueOnce(failure)
    await expect(caller.status(KEY)).rejects.toMatchObject({ code: 'authorization/failed', message: 'Credential status could not be read' })
    vi.spyOn(ctx.credentials, 'deleteRecord').mockRejectedValueOnce(failure)
    await expect(caller.disconnect(KEY)).rejects.toMatchObject({
      code: 'authorization/failed', message: 'Credential removal failed; check its status before retrying',
    })
    expect(await caller.status(KEY)).toEqual({ configured: true, writable: true, kind: 'grant', inFlight: false })
  })
})
