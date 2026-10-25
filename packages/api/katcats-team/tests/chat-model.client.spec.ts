/** Group deletion and grouping metadata accept only acknowledged current-generation results. */
import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { GroupId } from '../src/types.ts'
import type { ChatId, ChatSnapshot } from '../src/chats-types.ts'
import { ChatClientModel, type ChatRemote } from '../src/client/chat-model.ts'
import { TeamRequestSupersededError } from '../src/client/model.ts'

const id = 'editorial' as ChatId
const snapshot = (revision: number): ChatSnapshot => ({ revision, chats: [], deliveries: [], relayLimit: 6, activities: [] })

function setup() {
  const remote: ChatRemote = { sendMessage: vi.fn(), cancelSession: vi.fn(), snapshot: vi.fn(),
    follow: async function* () {}, createChat: vi.fn(), updateChat: vi.fn(), deleteChat: vi.fn(),
    pause: vi.fn(), resume: vi.fn(), stop: vi.fn() }
  return { remote, model: new ChatClientModel(remote) }
}

describe('group directory mutations', () => {
  it('retains group rows but marks them loading until a replacement arrives after reconnection', () => {
    const { model } = setup()
    model.replace(snapshot(3))
    model.resetGeneration()
    expect(model.state.getSnapshot()).toEqual({ phase: 'loading', snapshot: snapshot(3) })
    model.replace(snapshot(0))
    expect(model.state.getSnapshot()).toEqual({ phase: 'ready', snapshot: snapshot(0) })
  })

  it('retains the visible directory until deletion is acknowledged', async () => {
    const { remote, model } = setup()
    const pending = Promise.withResolvers<Awaited<ReturnType<ChatRemote['deleteChat']>>>()
    vi.mocked(remote.deleteChat).mockReturnValueOnce(pending.promise)
    model.replace(snapshot(3))
    const deleting = model.deleteChat({ id })
    expect(remote.deleteChat).toHaveBeenCalledExactlyOnceWith({ id })
    expect(model.state.getSnapshot().snapshot).toEqual(snapshot(3))
    pending.resolve({ ok: true, value: snapshot(4) })
    await deleting
    expect(model.state.getSnapshot().snapshot).toEqual(snapshot(4))
  })

  it('keeps a newer stream replacement when an older deletion result arrives', async () => {
    const { remote, model } = setup()
    const pending = Promise.withResolvers<Awaited<ReturnType<ChatRemote['deleteChat']>>>()
    vi.mocked(remote.deleteChat).mockReturnValueOnce(pending.promise)
    const deleting = model.deleteChat({ id })
    model.replace(snapshot(7))
    pending.resolve({ ok: true, value: snapshot(4) })
    await deleting
    expect(model.state.getSnapshot().snapshot).toEqual(snapshot(7))
  })

  it('does not remove a group when deletion is rejected', async () => {
    const { remote, model } = setup()
    model.replace(snapshot(3))
    vi.mocked(remote.deleteChat).mockResolvedValueOnce({ ok: false, error: new RemoteError('katcats/organization', 'automations are active', { reason: 'active-automations' }) })
    const rejected = model.deleteChat({ id })
    await expect(rejected).rejects.toBeInstanceOf(RemoteError)
    await expect(rejected).rejects.toMatchObject({ code: 'katcats/organization', details: { reason: 'active-automations' } })
    expect(model.state.getSnapshot().snapshot).toEqual(snapshot(3))
  })

  it.each(['reset', 'dispose'] as const)('rejects a late deletion result after %s', async (ending) => {
    const { remote, model } = setup()
    const pending = Promise.withResolvers<Awaited<ReturnType<ChatRemote['deleteChat']>>>()
    vi.mocked(remote.deleteChat).mockReturnValueOnce(pending.promise)
    model.replace(snapshot(3))
    const deleting = model.deleteChat({ id })
    if (ending === 'reset') model.resetGeneration()
    else model.dispose()
    pending.resolve({ ok: true, value: snapshot(4) })
    await expect(deleting).rejects.toBeInstanceOf(TeamRequestSupersededError)
    expect(model.state.getSnapshot().snapshot).toEqual(snapshot(3))
  })

  it('forwards only the selected custom-group patch and waits for the Host', async () => {
    const { remote, model } = setup()
    model.replace(snapshot(3))
    vi.mocked(remote.updateChat).mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/bad-request', 'group removed', {}) })
    await expect(model.update({ id, groupId: 'content' as GroupId })).rejects.toThrow('gateway/bad-request')
    expect(remote.updateChat).toHaveBeenCalledExactlyOnceWith({ id, groupId: 'content' })
    expect(model.state.getSnapshot().snapshot).toEqual(snapshot(3))
  })
})
