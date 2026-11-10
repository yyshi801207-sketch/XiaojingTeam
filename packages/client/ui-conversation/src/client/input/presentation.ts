/** Live display defaults for retained Session composers, owned by one plugin instance. */
import { createSnapshotStore, type ObservableSnapshot, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ComposerPresentation, ComposerPresentations } from '../contract/presentation.ts'

/** One provider per Session; registration and disposal update every existing outlet. */
export class ComposerPresentationRegistry implements ComposerPresentations {
  private readonly stores = new Map<SessionId, SnapshotStore<ComposerPresentation | undefined>>()
  private readonly providers = new Map<SessionId, { stop: () => void }>()

  /** @inheritdoc */
  register(sessionId: SessionId, source: ObservableSnapshot<ComposerPresentation>): () => void {
    if (this.providers.has(sessionId)) throw new Error('A composer presentation is already registered for this Session')
    const store = this.storeFor(sessionId)
    let active = true
    const publish = (): void => { if (active) store.set(source.getSnapshot()) }
    const stop = source.subscribe(publish)
    const provider = { stop: (): void => { active = false; stop() } }
    this.providers.set(sessionId, provider)
    publish()
    return () => {
      if (this.providers.get(sessionId) !== provider) return
      provider.stop()
      this.providers.delete(sessionId)
      store.set(undefined)
    }
  }

  /**
   * Resolve one stable source across provider registration and disposal.
   * @param sessionId - Session whose composer presentation is observed.
   * @returns A store whose snapshot is undefined while no presentation is registered.
   */
  storeFor(sessionId: SessionId): SnapshotStore<ComposerPresentation | undefined> {
    const existing = this.stores.get(sessionId)
    if (existing !== undefined) return existing
    const created = createSnapshotStore<ComposerPresentation | undefined>(undefined)
    this.stores.set(sessionId, created)
    return created
  }

  /** Release every contributor and restore standard hints when the Conversation plugin unloads. */
  dispose(): void {
    for (const provider of this.providers.values()) provider.stop()
    this.providers.clear()
    for (const store of this.stores.values()) store.set(undefined)
    this.stores.clear()
  }
}
