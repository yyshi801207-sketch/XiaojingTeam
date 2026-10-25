/** Group container routing waits for its real Session and never claims private members. */
import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { GroupId } from '../src/types.ts'
import type { ChatId, TeamChat } from '../src/chats-types.ts'
import type { ChatRemote, ChatView } from '../src/client/chat-model.ts'
import { installGroupTransports } from '../src/client/group-transports.ts'

const root = 'group-container' as SessionId
const accepted = { ok: true, value: { accepted: true } } as const
const chat: TeamChat = {
  id: 'group' as ChatId, groupId: 'chats' as GroupId, name: 'Group', rootSessionId: root,
  managerId: null, memberRoles: [], workDir: '/synthetic/group', memberIds: [], executors: [],
  status: 'active', pauseReason: null, run: null, error: null, generation: 0, relayLimit: 6,
}
const directory = (items: readonly TeamChat[]): ChatView => ({ phase: 'ready', snapshot: {
  revision: 1, chats: items, deliveries: [], activities: [], relayLimit: 6,
} })
const list = (...ids: SessionId[]): SessionListState => ({ ids, byId: Object.fromEntries(ids.map(id => [id, {
  id, displayTitle: id, blank: true, running: false, retainedBy: {}, updatedAt: 0,
}])), phase: 'ready', projectionsBySession: {} })

function setup(known = list()) {
  const sessions = createSnapshotStore(known)
  const chats = createSnapshotStore(directory([chat]))
  const release = vi.fn(async () => {})
  const registerTransport = vi.fn<ISessions['registerTransport']>(() => release)
  const remote: Pick<ChatRemote, 'sendMessage' | 'cancelSession'> = {
    sendMessage: vi.fn(async () => accepted),
    cancelSession: vi.fn(async () => accepted),
  }
  const block = vi.fn()
  const failed = vi.fn()
  const options = { sessions: { list: sessions, registerTransport }, chats, remote, block, failed }
  return { sessions, chats, release, registerTransport, remote, block, failed, options }
}

describe('group Session transport registration', () => {
  it('waits for the real catalog and routes both operations only for explicit group roots', async () => {
    const b = setup()
    const dispose = installGroupTransports(b.options)
    expect(b.block).toHaveBeenLastCalledWith(root, true)
    expect(b.registerTransport).not.toHaveBeenCalled()
    b.sessions.set(list(root, 'private-bot' as SessionId, 'hidden-worker' as SessionId))
    expect(b.registerTransport).toHaveBeenCalledTimes(1)
    expect(b.registerTransport.mock.calls[0]?.[0]).toBe(root)
    expect(b.block).toHaveBeenLastCalledWith(root, false)
    const transport = b.registerTransport.mock.calls[0]?.[1]
    if (transport === undefined) throw new Error('missing transport')
    const request = { sessionId: root, requestId: 'request' as Parameters<ChatRemote['sendMessage']>[0]['requestId'],
      content: [{ type: 'text' as const, text: 'Hello members' }], mode: 'queue' as const }
    const caller = new AbortController()
    await transport.prompt(request, caller.signal)
    expect(b.remote.sendMessage).toHaveBeenCalledExactlyOnceWith(request, caller.signal)
    expect(request.mode).toBe('queue')
    await transport.cancel({ sessionId: root })
    expect(b.remote.cancelSession).toHaveBeenCalledExactlyOnceWith({ sessionId: root })
    await dispose()
    expect(b.block).toHaveBeenLastCalledWith(root, true)
  })

  it('preserves rapid ordinary queue sends and an explicit interrupt without activity heuristics', async () => {
    const b = setup(list(root, 'private-bot' as SessionId))
    const dispose = installGroupTransports(b.options)
    const transport = b.registerTransport.mock.calls[0]?.[1]
    if (transport === undefined) throw new Error('missing transport')
    const caller = new AbortController()
    const request = { sessionId: root, requestId: 'first' as Parameters<ChatRemote['sendMessage']>[0]['requestId'],
      content: [{ type: 'text' as const, text: 'Start this task' }], mode: 'queue' as const }
    await Promise.all([transport.prompt(request, caller.signal), transport.prompt({ ...request,
      requestId: 'second' as Parameters<ChatRemote['sendMessage']>[0]['requestId'] }, caller.signal)])
    expect(b.remote.sendMessage).toHaveBeenCalledTimes(2)
    await transport.prompt({ ...request, mode: 'steer',
      requestId: 'explicit' as Parameters<ChatRemote['sendMessage']>[0]['requestId'] }, caller.signal)
    expect(vi.mocked(b.remote.sendMessage).mock.calls.map(([value]) => value.mode)).toEqual(['queue', 'queue', 'steer'])
    expect(b.registerTransport.mock.calls.map(([id]) => id)).toEqual([root])
    await dispose()
  })

  it('waits for removal cleanup before re-registering a reintroduced container', async () => {
    const b = setup(list(root))
    const gate = Promise.withResolvers<undefined>()
    b.release.mockImplementationOnce(() => gate.promise)
    const dispose = installGroupTransports(b.options)
    b.chats.set(directory([]))
    b.chats.set(directory([chat]))
    expect(b.registerTransport).toHaveBeenCalledTimes(1)
    expect(b.block).toHaveBeenLastCalledWith(root, true)
    gate.resolve(undefined)
    await expect.poll(() => b.registerTransport.mock.calls.length).toBe(2)
    expect(b.block).toHaveBeenLastCalledWith(root, false)
    await dispose()
  })

  it('reports acceptance only after success, never for rejection, transport failure or an aborted request', async () => {
    const b = setup(list(root))
    const acknowledged = vi.fn()
    const submitting = vi.fn(() => acknowledged)
    const dispose = installGroupTransports({ ...b.options, submitting })
    const transport = b.registerTransport.mock.calls[0]?.[1]
    if (transport === undefined) throw new Error('missing transport')
    const request = { sessionId: root, requestId: 'admission' as Parameters<ChatRemote['sendMessage']>[0]['requestId'],
      content: [{ type: 'text' as const, text: 'A question' }], mode: 'queue' as const }
    const gate = Promise.withResolvers<typeof accepted>()
    vi.mocked(b.remote.sendMessage).mockReturnValueOnce(gate.promise)
    const pending = transport.prompt(request, new AbortController().signal)
    expect(acknowledged).not.toHaveBeenCalled()
    gate.resolve(accepted)
    await pending
    expect(acknowledged).toHaveBeenCalledOnce()
    acknowledged.mockClear()
    vi.mocked(b.remote.sendMessage).mockResolvedValueOnce({ ok: false,
      error: new RemoteError('gateway/internal', 'Not admitted', {}) })
    await transport.prompt(request, new AbortController().signal)
    vi.mocked(b.remote.sendMessage).mockRejectedValueOnce(new Error('Synthetic disconnected'))
    await expect(transport.prompt(request, new AbortController().signal)).rejects.toThrow('Synthetic disconnected')
    const caller = new AbortController()
    caller.abort()
    await transport.prompt(request, caller.signal)
    expect(submitting).toHaveBeenCalledTimes(4)
    expect(acknowledged).not.toHaveBeenCalled()
    await dispose()
  })

  it('keeps a failed registration blocked and reports it without default fallback', async () => {
    const b = setup(list(root))
    const error = new Error('Overlapping registration')
    b.registerTransport.mockImplementation(() => { throw error })
    const dispose = installGroupTransports(b.options)
    b.chats.set(directory([chat]))
    expect(b.registerTransport).toHaveBeenCalledTimes(1)
    expect(b.failed).toHaveBeenCalledExactlyOnceWith(root, error)
    expect(b.block).toHaveBeenLastCalledWith(root, true)
    expect(b.remote.sendMessage).not.toHaveBeenCalled()
    await dispose()
  })

  it('acknowledges an accepted public transport call without an optional cancellation signal', async () => {
    const b = setup(list(root))
    const acknowledged = vi.fn()
    const dispose = installGroupTransports({ ...b.options, submitting: () => acknowledged })
    const transport = b.registerTransport.mock.calls[0]?.[1]
    if (transport === undefined) throw new Error('missing transport')
    const request = { sessionId: root, requestId: 'without-signal' as Parameters<ChatRemote['sendMessage']>[0]['requestId'],
      content: [{ type: 'text' as const, text: 'A question without a signal' }], mode: 'queue' as const }
    await expect(transport.prompt(request)).resolves.toEqual(accepted)
    expect(b.remote.sendMessage).toHaveBeenCalledExactlyOnceWith(request, undefined)
    expect(acknowledged).toHaveBeenCalledOnce()
    await dispose()
  })

  it('awaits registered providers and removes observations before disposal completes', async () => {
    const b = setup(list(root))
    const gate = Promise.withResolvers<undefined>()
    b.release.mockImplementation(() => gate.promise)
    const dispose = installGroupTransports(b.options)
    const closing = dispose()
    b.chats.set(directory([{ ...chat, rootSessionId: 'other-group' as SessionId }]))
    b.sessions.set(list('other-group' as SessionId))
    expect(b.registerTransport).toHaveBeenCalledTimes(1)
    expect(b.release).toHaveBeenCalledTimes(1)
    gate.resolve(undefined)
    await closing
  })
})
