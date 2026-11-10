// @vitest-environment jsdom
/** Rooms observe worker journals without retaining private Sessions or owning task execution. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConnectionGeneration, ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatId, TeamChat } from '../src/chats-types.ts'
import type { BotId, GroupId } from '../src/types.ts'
import type { ChatView } from '../src/client/chat-model.ts'
import { observeRoomActivity } from '../src/client/room-activity.ts'

const workerId = 'worker' as SessionId, botId = 'member' as BotId
const chat: TeamChat = { id: 'group' as ChatId, name: 'Group', groupId: 'folder' as GroupId,
  rootSessionId: 'root' as SessionId, workDir: '/synthetic', memberIds: [botId], managerId: botId, memberRoles: [],
  executors: [{ botId, sessionId: workerId }], status: 'active', pauseReason: null, run: null, generation: 1, relayLimit: 6, error: null }

async function fixture() {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  await runtime.sessions.add({ id: workerId })
  await runtime.sessions.add({ id: 'private' })
  await runtime.sessions.add({ id: 'other-group-worker' })
  const chats = createSnapshotStore<ChatView>({ phase: 'ready', snapshot: { revision: 1, chats: [chat], deliveries: [], activities: [], relayLimit: 6 } })
  const state = createSnapshotStore<ConnectionState | undefined>('connected')
  const generation = createSnapshotStore<ConnectionGeneration | undefined>({ id: 1, host: { home: '/synthetic' } })
  const abort = new AbortController()
  onTestFinished(() => { abort.abort() })
  const retain = vi.spyOn(runtime.sessions, 'retain')
  const source = observeRoomActivity({ sessions: runtime.sessions, chats, connection: { state, generation } }, chat.id, abort.signal)
  await vi.waitFor(() => { expect(source.getSnapshot().members[0]?.state).toBe('ready') })
  return { runtime, chats, state, generation, abort, source, retain }
}

describe('room activity subscriptions', () => {
  it('observes group-local permission changes and releases their subscription with the room', async () => {
    const f = await fixture()
    await f.runtime.sessions.setProjection('private', 'permissions', { currentValue: 'danger-full-access' })
    expect(f.source.getSnapshot().members[0]?.permission).toBeUndefined()
    await f.runtime.sessions.setProjection(workerId, 'permissions', { currentValue: 'read-only' })
    expect(f.source.getSnapshot().members[0]?.permission).toBe('read-only')
    await f.runtime.sessions.setProjection(workerId, 'permissions', { currentValue: 'workspace-write' })
    expect(f.source.getSnapshot().members[0]?.permission).toBe('workspace-write')
    f.abort.abort()
    const stopped = f.source.getSnapshot()
    await f.runtime.sessions.setProjection(workerId, 'permissions', { currentValue: 'auto' })
    expect(f.source.getSnapshot()).toBe(stopped)
  })
  it('retains only the selected group executors and releases them on close', async () => {
    const f = await fixture()
    expect(f.retain.mock.calls.map(call => call[0])).toEqual([workerId])
    expect(f.runtime.sessions.retainInfo(workerId).getSnapshot().retainedBy.katcatsRoomActivity).toBe(1)
    f.abort.abort()
    expect(f.runtime.sessions.retainInfo(workerId).getSnapshot().referenceCount).toBe(0)
    expect(f.runtime.sessions.retainInfo('private' as SessionId).getSnapshot().referenceCount).toBe(0)
  })
  it('releases removed members and reacquires after a connection generation changes', async () => {
    const f = await fixture()
    f.state.set('disconnected')
    expect(f.source.getSnapshot().connected).toBe(false)
    f.generation.set(undefined)
    expect(f.runtime.sessions.retainInfo(workerId).getSnapshot().referenceCount).toBe(0)
    f.generation.set({ id: 2, host: { home: '/synthetic' } })
    f.state.set('connected')
    await vi.waitFor(() => { expect(f.source.getSnapshot().members[0]?.state).toBe('ready') })
    expect(f.retain).toHaveBeenCalledTimes(2)
    f.chats.set({ ...f.chats.getSnapshot(), snapshot: { ...f.chats.getSnapshot().snapshot!,
      chats: [{ ...chat, memberIds: [], executors: [] }] } })
    expect(f.source.getSnapshot().members).toEqual([])
    expect(f.runtime.sessions.retainInfo(workerId).getSnapshot().referenceCount).toBe(0)
  })
  it('reports a synchronous acquisition failure without failing the room or starting work', async () => {
    const f = await fixture()
    f.abort.abort()
    const retry = new AbortController()
    onTestFinished(() => { retry.abort() })
    const failure = observeRoomActivity({ sessions: { retain: () => { throw new Error('unavailable') } },
      chats: f.chats, connection: { state: f.state, generation: f.generation } }, chat.id, retry.signal)
    expect(failure.getSnapshot().members[0]?.state).toBe('failed')
  })
})
