/** Host-owned interaction queue for one non-resumable Remote authorization attempt. */

import { randomUUID } from 'node:crypto'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { AuthorizationInteraction } from './index.ts'
import type {
  AuthorizationPrompt, AuthorizationPromptId, AuthorizationRemoteEvent,
} from './types.ts'

interface PendingPrompt {
  accepts(answer: string): boolean
  resolve(answer: string): void
  reject(error: Error): void
  dispose(): void
}

/** Owns prompt answers and queued notices until its initiating stream closes. */
export class AuthorizationRemoteAttempt implements AuthorizationInteraction {
  /** Cancellation owned by the initiating carrier and Peer. */
  readonly controller = new AbortController()
  /** Undelivered events; consumed only by the initiating stream. */
  readonly events: AuthorizationRemoteEvent[] = []
  private readonly prompts = new Map<AuthorizationPromptId, PendingPrompt>()
  private wake: (() => void) | undefined

  constructor(readonly peer: PeerScope) {}

  /**
   * Queue one notice or terminal event for the initiating stream.
   * @param event - secret-free event from the flow or authorization service.
   */
  push(event: AuthorizationRemoteEvent): void {
    this.events.push(event)
    this.wake?.()
    this.wake = undefined
  }

  notify(notice: Parameters<AuthorizationInteraction['notify']>[0]): void {
    if (!this.controller.signal.aborted) this.push({ type: 'notice', notice })
  }

  prompt(prompt: AuthorizationPrompt): Promise<string> {
    const { signal, ...content } = prompt
    if (this.controller.signal.aborted) return Promise.reject(new Error('authorization cancelled'))
    if (signal?.aborted === true) return Promise.reject(new Error('authorization prompt withdrawn'))
    const id = randomUUID() as AuthorizationPromptId
    const answer = Promise.withResolvers<string>()
    const withdraw = (): void => {
      this.prompts.delete(id)
      this.push({ type: 'prompt-withdrawn', id })
      answer.reject(new Error('authorization prompt withdrawn'))
    }
    signal?.addEventListener('abort', withdraw, { once: true })
    this.prompts.set(id, {
      ...answer,
      accepts: value => prompt.kind !== 'select' || prompt.options.some(option => option.id === value),
      dispose: () => { signal?.removeEventListener('abort', withdraw) },
    })
    this.push({ type: 'prompt', id, prompt: content })
    return answer.promise
  }

  /**
   * Complete a question once; stale answers never reach a successor question.
   * @param id - opaque pending question identity.
   * @param answer - supplied text or selected option identity.
   */
  answer(id: AuthorizationPromptId, answer: string): void {
    const prompt = this.prompts.get(id)
    if (prompt === undefined) {
      throw new RemoteError('authorization/not-owned', 'Authorization question is no longer pending', {})
    }
    if (!prompt.accepts(answer)) {
      throw new RemoteError('gateway/bad-request', 'Authorization answer is not an offered option', {})
    }
    this.prompts.delete(id)
    prompt.dispose()
    prompt.resolve(answer)
  }

  /**
   * Wait until a queued event or attempt completion becomes observable.
   * @returns when the producer has queued an event or finished.
   */
  wait(): Promise<void> {
    return new Promise((resolve) => { this.wake = resolve })
  }

  /** Reject unanswered questions and wake the stream when its producer finishes. */
  close(): void {
    for (const prompt of this.prompts.values()) {
      prompt.dispose()
      prompt.reject(new Error('authorization attempt ended'))
    }
    this.prompts.clear()
    this.wake?.()
    this.wake = undefined
  }
}
