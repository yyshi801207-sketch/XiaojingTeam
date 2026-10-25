/** Member mutation ordering, visible failures and plugin-generation lifetimes. */
import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { TeamSnapshot, BotId, GroupId } from '../src/types.ts'
import { TeamClientModel, TeamRequestSupersededError, type TeamRemote } from '../src/client/model.ts'
import { createTeamUi } from '../src/client/ui-state.ts'

const bid = (value: string) => value as BotId
const gid = (value: string) => value as GroupId
const snapshot = (revision = 0): TeamSnapshot => ({
  revision, mainBotId: bid('main'), bots: [], modelCapabilities: { override: false, followGlobal: false },
  groups: [{ id: gid('ordinary'), name: 'ordinary', kind: 'bots', system: true }, { id: gid('chats'), name: 'chats', kind: 'chats', system: true }],
})

function harness() {
  const remote: TeamRemote = {
    snapshot: vi.fn<TeamRemote['snapshot']>().mockResolvedValue({ ok: true, value: snapshot() }),
    follow: async function* () { yield { type: 'snapshot', value: snapshot() } },
    createBot: vi.fn(), updateBot: vi.fn(), deleteBot: vi.fn(), createGroup: vi.fn(), updateGroup: vi.fn(), moveGroup: vi.fn(), removeGroup: vi.fn(),
  }
  return { remote, model: new TeamClientModel(remote) }
}

describe('Katcats directory mirror', () => {
  it('retains Bot rows but marks them loading until a replacement arrives after reconnection', () => {
    const { model } = harness()
    model.replace(snapshot(3))
    model.resetGeneration()
    expect(model.state.getSnapshot()).toEqual({ phase: 'loading', snapshot: snapshot(3), catalog: null })
    model.replace(snapshot(0))
    expect(model.state.getSnapshot()).toEqual({ phase: 'ready', snapshot: snapshot(0), catalog: null })
  })

  it('keeps a newer stream result when an older request completes afterwards', async () => {
    const { remote, model } = harness()
    let resolve!: (value: Awaited<ReturnType<TeamRemote['snapshot']>>) => void
    vi.mocked(remote.snapshot).mockReturnValueOnce(new Promise(accept => { resolve = accept }))
    const reloading = model.reload()
    model.replace(snapshot(8))
    resolve({ ok: true, value: snapshot(2) })
    await reloading
    expect(model.state.getSnapshot().snapshot?.revision).toBe(8)
  })

  it('retains the saved directory when a query fails', async () => {
    const { remote, model } = harness()
    model.replace(snapshot(3))
    vi.mocked(remote.snapshot).mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'unavailable', {}) })
    await model.reload()
    expect(model.state.getSnapshot()).toMatchObject({ phase: 'failed', snapshot: { revision: 3 } })
  })

  it('does not publish a late result after the owning Host generation changed', async () => {
    const { remote, model } = harness()
    let resolve!: (value: Awaited<ReturnType<TeamRemote['createGroup']>>) => void
    vi.mocked(remote.createGroup).mockReturnValueOnce(new Promise(accept => { resolve = accept }))
    const creating = model.createGroup({ name: 'Writers' })
    model.resetGeneration()
    model.replace(snapshot(0))
    resolve({ ok: true, value: { group: { id: gid('writers'), name: 'Writers', kind: 'bots', system: false }, snapshot: snapshot(12) } })
    await expect(creating).rejects.toBeInstanceOf(TeamRequestSupersededError)
    expect(model.state.getSnapshot().snapshot?.revision).toBe(0)
  })

  it('keeps failed writes out of the published team', async () => {
    const { remote, model } = harness()
    model.replace(snapshot(3))
    vi.mocked(remote.createGroup).mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'disk unavailable', {}) })
    await expect(model.createGroup({ name: 'Writers' })).rejects.toThrow()
    expect(model.state.getSnapshot().snapshot?.revision).toBe(3)
    model.dispose()
    model.replace(snapshot(9))
    expect(model.state.getSnapshot().snapshot?.revision).toBe(3)
  })

  it('waits for an acknowledged Bot deletion and keeps newer streamed data', async () => {
    const { remote, model } = harness()
    const pending = Promise.withResolvers<Awaited<ReturnType<TeamRemote['deleteBot']>>>()
    vi.mocked(remote.deleteBot).mockReturnValueOnce(pending.promise)
    model.replace(snapshot(3))
    const deleting = model.deleteBot({ id: bid('writer') })
    expect(model.state.getSnapshot().snapshot).toEqual(snapshot(3))
    expect(remote.deleteBot).toHaveBeenCalledExactlyOnceWith({ id: 'writer' })
    model.replace(snapshot(6))
    pending.resolve({ ok: true, value: snapshot(4) })
    await deleting
    expect(model.state.getSnapshot().snapshot).toEqual(snapshot(6))
  })

  it('retains the saved team when Bot deletion is refused', async () => {
    const { remote, model } = harness()
    model.replace(snapshot(3))
    vi.mocked(remote.deleteBot).mockResolvedValueOnce({ ok: false, error: new RemoteError('katcats/organization', 'Bot is still in a group', { reason: 'bot-in-group' }) })
    const rejected = model.deleteBot({ id: bid('writer') })
    await expect(rejected).rejects.toBeInstanceOf(RemoteError)
    await expect(rejected).rejects.toMatchObject({ code: 'katcats/organization', details: { reason: 'bot-in-group' } })
    expect(model.state.getSnapshot().snapshot).toEqual(snapshot(3))
  })

  it.each(['reset', 'dispose'] as const)('rejects Bot deletion after %s', async (ending) => {
    const { remote, model } = harness()
    const pending = Promise.withResolvers<Awaited<ReturnType<TeamRemote['deleteBot']>>>()
    vi.mocked(remote.deleteBot).mockReturnValueOnce(pending.promise)
    model.replace(snapshot(3))
    const deleting = model.deleteBot({ id: bid('writer') })
    if (ending === 'reset') model.resetGeneration()
    else model.dispose()
    pending.resolve({ ok: true, value: snapshot(4) })
    await expect(deleting).rejects.toBeInstanceOf(TeamRequestSupersededError)
    expect(model.state.getSnapshot().snapshot).toEqual(snapshot(3))
  })

  it.each(['moveGroup', 'removeGroup'] as const)('accepts only the committed replacement from %s', async (operation) => {
    const { remote, model } = harness()
    model.replace(snapshot(3))
    const next = snapshot(4)
    vi.mocked(remote[operation]).mockResolvedValueOnce({ ok: true, value: next })
    await (operation === 'moveGroup' ? model.moveGroup({ id: gid('writers'), direction: 'up' }) : model.removeGroup({ id: gid('writers') }))
    expect(model.state.getSnapshot().snapshot).toEqual(next)
    expect(remote[operation]).toHaveBeenCalledExactlyOnceWith(operation === 'moveGroup'
      ? { id: 'writers', direction: 'up' } : { id: 'writers' })
  })

  it.each(['moveGroup', 'removeGroup'] as const)('retains the directory when %s is rejected', async (operation) => {
    const { remote, model } = harness()
    model.replace(snapshot(3))
    vi.mocked(remote[operation]).mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'disk unavailable', {}) })
    await expect(operation === 'moveGroup' ? model.moveGroup({ id: gid('writers'), direction: 'up' })
      : model.removeGroup({ id: gid('writers') })).rejects.toThrow('gateway/internal')
    expect(model.state.getSnapshot().snapshot).toEqual(snapshot(3))
  })

  it.each(['moveGroup', 'removeGroup'] as const)('does not accept a %s result from a replaced Host connection', async (operation) => {
    const { remote, model } = harness()
    let finish!: (value: Awaited<ReturnType<TeamRemote['removeGroup']>>) => void
    vi.mocked(remote[operation]).mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    const pending = operation === 'moveGroup' ? model.moveGroup({ id: gid('writers'), direction: 'up' }) : model.removeGroup({ id: gid('writers') })
    model.resetGeneration()
    model.replace(snapshot(0))
    finish({ ok: true, value: snapshot(10) })
    await expect(pending).rejects.toBeInstanceOf(TeamRequestSupersededError)
    expect(model.state.getSnapshot().snapshot).toEqual(snapshot(0))
  })
})

it('dismisses or cancels a create request without calling member mutations', () => {
  const { remote } = harness()
  const ui = createTeamUi()
  ui.createBot(gid('ordinary'))
  ui.closeDialog()
  expect(ui.source.getSnapshot().dialog).toBeNull()
  expect(remote.createBot).not.toHaveBeenCalled()
  expect(remote.createGroup).not.toHaveBeenCalled()
})
