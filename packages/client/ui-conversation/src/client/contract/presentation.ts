/** Display-only defaults contributed by the owner of one Session. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Overrides ordinary empty input hints without replacing the editor or execution policy. */
export interface ComposerPresentation {
  /** Already localized default hint; blocking, unavailable, queue and plan hints retain precedence. */
  readonly defaultPlaceholder?: string
  /** Hide the Hero location/preset row only after its existing input prerequisites are satisfied. */
  readonly hideWorkspaceRow?: boolean
}

/** One lifetime-scoped product owner per Session; consumers retain the original composer. */
export interface ComposerPresentations {
  /**
   * Publish one Session's live presentation defaults.
   * @param sessionId - exact Session being presented, never the global selection.
   * @param source - localized product snapshot; no model input or permissions are modified.
   * @returns idempotent disposer restoring the standard presentation.
   * @throws when another owner already contributes to this Session.
   */
  register(sessionId: SessionId, source: ObservableSnapshot<ComposerPresentation>): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Display-only Session composer defaults; provided by the Conversation plugin. */
    composerPresentation: ComposerPresentations
  }
}
