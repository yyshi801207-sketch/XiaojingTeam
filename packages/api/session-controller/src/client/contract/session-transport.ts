/** Product-owned prompt and cancellation delivery for one top-level Session. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  SessionCancelRequest, SessionCancelValue, SessionPromptRequest, SessionPromptValue,
} from '../../types.ts'

/** Admission and cancellation handlers registered together for one exact Session. */
export interface SessionTransport {
  /**
   * Admit the original request, including its request id and ordered attachments.
   * @param request - unchanged composer admission request.
   * @param signal - admission cancellation; omission supplies no caller cancellation.
   * @returns durable admission, or a structured failure; never request a default-route retry.
   */
  prompt(request: SessionPromptRequest, signal?: AbortSignal): Promise<RemoteResult<SessionPromptValue>>
  /**
   * Cancel this Session's owned execution; accepted does not imply a model reply.
   * @param request - exact registered Session identity.
   * @returns cancellation acknowledgement after the handler's required cleanup.
   */
  cancel(request: SessionCancelRequest): Promise<RemoteResult<SessionCancelValue>>
}

/**
 * Stop custom calls, abort pending admission and quarantine the id until re-registration.
 * @returns completion after all captured handlers settle.
 */
export type SessionTransportDisposer = () => Promise<void>

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'session/client-transport-unavailable': { readonly sessionId: SessionId }
    'session/client-transport-failed': {
      readonly sessionId: SessionId
      readonly operation: 'prompt' | 'cancel'
    }
  }
}
