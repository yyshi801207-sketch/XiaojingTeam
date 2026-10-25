/** Product-owned input hints for each private Bot and group record Session. */
import { createSnapshotStore, type ObservableSnapshot, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ComposerPresentation, ComposerPresentations } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamView } from './model.ts'
import type { ChatView } from './chat-model.ts'

/** Exact product directories and the public display-only registration service. */
export interface TeamComposerOptions {
  readonly directory: ObservableSnapshot<TeamView>
  readonly chats: ObservableSnapshot<ChatView>
  readonly presentation: ComposerPresentations
  readonly t: TranslateNS<'katcats.team'>
  readonly subscribeLocale: (listener: () => void) => () => void
}

/**
 * Keep hints current without changing the editor, tools, permissions or selected model.
 * @param options - Product snapshots, localized copy and public registration service.
 * @returns Disposer releasing every Session registration and input subscription.
 */
export function installTeamComposerPresentations(options: TeamComposerOptions): () => void {
  const entries = new Map<SessionId, { source: SnapshotStore<ComposerPresentation>; dispose: () => void }>()
  let disposed = false
  const sync = (): void => {
    if (disposed) return
    const expected = new Map<SessionId, string>()
    for (const bot of options.directory.getSnapshot().snapshot?.bots ?? []) {
      expected.set(bot.sessionId, options.t(bot.kind === 'main' ? 'composer.mainPlaceholder' : 'composer.botPlaceholder'))
    }
    for (const chat of options.chats.getSnapshot().snapshot?.chats ?? []) {
      expected.set(chat.rootSessionId, options.t('composer.chatPlaceholder'))
    }
    for (const [id, entry] of entries) if (!expected.has(id)) { entry.dispose(); entries.delete(id) }
    for (const [id, defaultPlaceholder] of expected) {
      const existing = entries.get(id)
      if (existing !== undefined) {
        if (existing.source.getSnapshot().defaultPlaceholder !== defaultPlaceholder) {
          existing.source.set({ defaultPlaceholder, hideWorkspaceRow: true })
        }
      } else {
        const source = createSnapshotStore<ComposerPresentation>({ defaultPlaceholder, hideWorkspaceRow: true })
        entries.set(id, { source, dispose: options.presentation.register(id, source) })
      }
    }
  }
  const stops = [options.directory.subscribe(sync), options.chats.subscribe(sync), options.subscribeLocale(sync)]
  const dispose = (): void => {
    disposed = true
    for (const stop of stops) stop()
    for (const entry of entries.values()) entry.dispose()
    entries.clear()
  }
  try { sync() } catch (error) { dispose(); throw error }
  return dispose
}
