/** Session display defaults update independently and release their source subscriptions. */
import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ComposerPresentation } from '../src/client/contract/presentation.ts'
import { ComposerPresentationRegistry } from '../src/client/input/presentation.ts'

const A = 'presentation-a' as SessionId
const B = 'presentation-b' as SessionId

describe('Session composer presentation', () => {
  it('starts absent and updates only the addressed Session', () => {
    const registry = new ComposerPresentationRegistry()
    const first = registry.storeFor(A)
    const second = registry.storeFor(B)
    expect(first.getSnapshot()).toBeUndefined()
    expect(registry.storeFor(A)).toBe(first)
    const source = createSnapshotStore<ComposerPresentation>({ defaultPlaceholder: 'Create a helper' })
    const remove = registry.register(A, source)
    expect(first.getSnapshot()).toEqual({ defaultPlaceholder: 'Create a helper' })
    expect(second.getSnapshot()).toBeUndefined()
    source.set({ defaultPlaceholder: '创建助手', hideWorkspaceRow: true })
    expect(first.getSnapshot()).toEqual({ defaultPlaceholder: '创建助手', hideWorkspaceRow: true })
    remove()
    expect(first.getSnapshot()).toBeUndefined()
    source.set({ defaultPlaceholder: 'Obsolete' })
    expect(first.getSnapshot()).toBeUndefined()
  })

  it('rejects a duplicate owner without changing the current contribution', () => {
    const registry = new ComposerPresentationRegistry()
    const source = createSnapshotStore<ComposerPresentation>({ hideWorkspaceRow: true })
    registry.register(A, source)
    expect(() => registry.register(A, createSnapshotStore({}))).toThrow('already registered')
    source.set({ defaultPlaceholder: 'Still current' })
    expect(registry.storeFor(A).getSnapshot()).toEqual({ defaultPlaceholder: 'Still current' })
    registry.dispose()
  })

  it('ignores queued old notifications and an old disposer after replacement', () => {
    const registry = new ComposerPresentationRegistry()
    let queued = (): void => {}
    const stop = vi.fn()
    const source: ObservableSnapshot<ComposerPresentation> = {
      getSnapshot: () => ({ defaultPlaceholder: 'Old' }),
      subscribe: (listener) => { queued = listener; return stop },
    }
    const remove = registry.register(A, source)
    remove()
    remove()
    expect(stop).toHaveBeenCalledOnce()
    const replacement = createSnapshotStore<ComposerPresentation>({ defaultPlaceholder: 'New' })
    registry.register(A, replacement)
    queued()
    remove()
    expect(registry.storeFor(A).getSnapshot()).toEqual({ defaultPlaceholder: 'New' })
    registry.dispose()
  })

  it('releases every source and restores retained outlets on plugin disposal', () => {
    const registry = new ComposerPresentationRegistry()
    const stops = [vi.fn(), vi.fn()]
    for (const [index, sessionId] of [A, B].entries()) {
      registry.register(sessionId, { getSnapshot: () => ({ hideWorkspaceRow: true }), subscribe: () => stops[index]! })
    }
    const outlets = [registry.storeFor(A), registry.storeFor(B)]
    registry.dispose()
    registry.dispose()
    expect(stops.map(stop => stop.mock.calls.length)).toEqual([1, 1])
    expect(outlets.map(outlet => outlet.getSnapshot())).toEqual([undefined, undefined])
  })
})
