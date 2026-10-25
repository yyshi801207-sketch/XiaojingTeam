/** Exact task association and shared catalog connection lifetimes. */
import { describe, expect, it, vi } from 'vitest'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule/client'
import { groupSchedules, scheduleOwner, ScheduleClientModel } from '../src/client/schedule-model.ts'
import { chatSnapshot, editorial, main, research, tasks, teamSnapshot, writer } from './schedule-fixture.client.ts'

describe('task ownership', () => {
  it('separates private and two group Sessions for the same Bot, retaining former group workers', () => {
    const groups = groupSchedules(tasks, teamSnapshot.bots, chatSnapshot.chats)
    expect(groups.map(group => [group.owner.key, group.records.map(task => task.title)])).toEqual([
      [`bot:${main.id}`, ['Creator task']], [`bot:${writer.id}`, ['Private draft']],
      [`chat:${editorial.id}`, ['Group root task', 'Editorial draft', 'Former member task']],
      [`chat:${research.id}`, ['Research draft']], ['unlinked', ['Legacy unlinked']],
    ])
    expect(groups.flatMap(group => group.records)).toHaveLength(tasks.length)
    expect(groups.flatMap(group => group.records).every(task => tasks.includes(task))).toBe(true)
    expect(scheduleOwner(editorial.executors[1]!.sessionId, teamSnapshot.bots, chatSnapshot.chats))
      .toEqual({ kind: 'chat', key: `chat:${editorial.id}`, name: editorial.name })
  })

  it('updates labels after rename or folder movement without rewriting original bindings', () => {
    const bots = [main, { ...writer, name: 'Renamed Writer', groupId: null }]
    const group = groupSchedules(tasks, bots, [{ ...editorial, name: 'Renamed Editorial' }, research])
      .find(value => value.owner.key === `chat:${editorial.id}`)!
    expect(group.owner).toMatchObject({ kind: 'chat', name: 'Renamed Editorial' })
    expect(group.records[1]).toBe(tasks[3])
    expect(group.records[1]?.sessionId).toBe(editorial.executors[0]!.sessionId)
    expect(groupSchedules(tasks, bots, []).find(value => value.owner.kind === 'unlinked')?.records).toHaveLength(5)
  })
})

function harness() {
  let changed: (() => void) | undefined
  let reset: (() => void) | undefined
  const offChanged = vi.fn()
  const offReset = vi.fn()
  const catalog = vi.fn<() => Promise<RemoteResult<ScheduleCatalogEntry[]>>>().mockResolvedValue({ ok: true, value: tasks })
  const model = new ScheduleClientModel({ catalog,
    subscribeChanged: (listener) => { changed = listener; return offChanged },
    subscribeReset: (listener) => { reset = listener; return offReset },
  })
  return { model, catalog, changed: () => { changed?.() }, reset: () => { reset?.() }, offChanged, offReset }
}

describe('shared task catalog', () => {
  it('queries once for simultaneous views and releases both invalidation subscriptions after the final view closes', async () => {
    const h = harness()
    expect(h.catalog).not.toHaveBeenCalled()
    const a = h.model.state.subscribe(vi.fn())
    const b = h.model.state.subscribe(vi.fn())
    await vi.waitFor(() => { expect(h.model.state.getSnapshot().phase).toBe('ready') })
    expect(h.catalog).toHaveBeenCalledOnce()
    a()
    expect(h.offChanged).not.toHaveBeenCalled()
    b()
    expect(h.offChanged).toHaveBeenCalledOnce()
    expect(h.offReset).toHaveBeenCalledOnce()
    const reopened = h.model.state.subscribe(vi.fn())
    await vi.waitFor(() => { expect(h.catalog).toHaveBeenCalledTimes(2) })
    reopened(); h.model.dispose()
  })

  it('discards an older task response after a connection-reset refresh', async () => {
    const h = harness()
    const stop = h.model.state.subscribe(vi.fn())
    await vi.waitFor(() => { expect(h.model.state.getSnapshot().phase).toBe('ready') })
    const stale = Promise.withResolvers<RemoteResult<ScheduleCatalogEntry[]>>()
    h.catalog.mockReturnValueOnce(stale.promise)
    h.changed()
    h.catalog.mockResolvedValueOnce({ ok: true, value: [tasks[0]!] })
    h.reset()
    await vi.waitFor(() => { expect(h.model.state.getSnapshot().records).toEqual([tasks[0]]) })
    stale.resolve({ ok: true, value: tasks })
    await stale.promise
    expect(h.model.state.getSnapshot().records).toEqual([tasks[0]])
    stop(); h.model.dispose()
  })

  it('retains rows for transport and Remote failures and recovers through a public read', async () => {
    const h = harness()
    const stop = h.model.state.subscribe(vi.fn())
    await vi.waitFor(() => { expect(h.model.state.getSnapshot().phase).toBe('ready') })
    h.catalog.mockRejectedValueOnce(new Error('synthetic transport closed'))
    await h.model.reload()
    expect(h.model.state.getSnapshot()).toEqual({ phase: 'failed', records: tasks })
    h.catalog.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'synthetic failure', {}) })
    await h.model.reload()
    expect(h.model.state.getSnapshot()).toEqual({ phase: 'failed', records: tasks })
    h.catalog.mockResolvedValueOnce({ ok: true, value: [] })
    await h.model.reload()
    expect(h.model.state.getSnapshot()).toEqual({ phase: 'ready', records: [] })
    stop(); h.model.dispose()
  })

  it('does not publish a pending read after the last view or product lifetime ends', async () => {
    const h = harness()
    const pending = Promise.withResolvers<RemoteResult<ScheduleCatalogEntry[]>>()
    h.catalog.mockReturnValueOnce(pending.promise)
    const listener = vi.fn()
    const stop = h.model.state.subscribe(listener)
    stop(); h.model.dispose()
    const calls = listener.mock.calls.length
    pending.resolve({ ok: true, value: tasks })
    await pending.promise
    expect(h.model.state.getSnapshot().records).toEqual([])
    expect(listener).toHaveBeenCalledTimes(calls)
  })
})
