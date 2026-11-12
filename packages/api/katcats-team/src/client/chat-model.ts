/** Host-authoritative group directory and revision-fenced mutations. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionCancelRequest, SessionCancelValue, SessionPromptRequest, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ChatControlRequest, ChatFrame, ChatId, ChatMutationValue, ChatPromptValue, ChatSnapshot, ContinueGroupTaskRequest, CreateChatRequest, DeleteChatRequest, GroupTicketId, UpdateChatRequest } from '../chats-types.ts'
import { TeamRequestSupersededError } from './model.ts'

/** Generated owner-only group operations consumed by the product interface. */
export interface ChatRemote {
  sendMessage: (request: SessionPromptRequest, signal?: AbortSignal) => Promise<RemoteResult<ChatPromptValue>>
  cancelSession: (request: SessionCancelRequest) => Promise<RemoteResult<SessionCancelValue>>
  snapshot: () => Promise<RemoteResult<ChatSnapshot>>
  follow: (signal?: AbortSignal) => AsyncIterable<ChatFrame>
  createChat: (request: CreateChatRequest) => Promise<RemoteResult<ChatMutationValue>>
  updateChat: (request: UpdateChatRequest) => Promise<RemoteResult<ChatMutationValue>>
  deleteChat: (request: DeleteChatRequest) => Promise<RemoteResult<ChatSnapshot>>
  pause: (request: ChatControlRequest) => Promise<RemoteResult<ChatMutationValue>>
  resume: (request: ChatControlRequest) => Promise<RemoteResult<ChatMutationValue>>
  stop: (request: ChatControlRequest) => Promise<RemoteResult<ChatMutationValue>>
  continueTask: (request: ContinueGroupTaskRequest) => Promise<RemoteResult<ChatMutationValue>>
  completeTask: (chatId: ChatId, taskId: GroupTicketId, expectedRevision: number, acceptanceRequestId?: SessionRequestId) => Promise<RemoteResult<ChatMutationValue>>
}

/** Retained group rows remain readable while their stream is unavailable. */
export interface ChatView {
  readonly phase: 'loading' | 'ready' | 'failed'
  readonly snapshot: ChatSnapshot | null
}

/** Group directory mirror scoped to one plugin lifetime and Host connection. */
export class ChatClientModel {
  /** Current group directory and visible connection state. */
  readonly state = createSnapshotStore<ChatView>({ phase: 'loading', snapshot: null })
  private active = true
  private generation = 0

  /** @param remote - Generated owner-only group operations. */
  constructor(private readonly remote: ChatRemote) {}

  /**
   * Accept the current Host's complete group directory.
   * @param snapshot - Authoritative group replacement for the current Host.
   */
  replace(snapshot: ChatSnapshot): void {
    if (this.active) this.state.set({ phase: 'ready', snapshot })
  }

  /** Keep the last directory available when its live stream fails. */
  failed(): void {
    if (this.active) this.state.set({ ...this.state.getSnapshot(), phase: 'failed' })
  }

  /** Fence stale replies and keep retained rows unavailable until the current Host snapshot arrives. */
  resetGeneration(): void {
    this.generation++
    if (this.active) this.state.set({ ...this.state.getSnapshot(), phase: 'loading' })
  }

  /**
   * Create a group through the current Host connection.
   * @param request - Explicit group name and selected members.
   * @returns The durable group.
   */
  async create(request: CreateChatRequest): Promise<ChatMutationValue['chat']> {
    return this.mutate(() => this.remote.createChat(request))
  }

  /**
   * Save the selected group's edited fields.
   * @param request - Explicitly edited group fields.
   * @returns The durable group.
   */
  async update(request: UpdateChatRequest): Promise<ChatMutationValue['chat']> {
    return this.mutate(() => this.remote.updateChat(request))
  }

  /**
   * Remove the captured group after the Host has stopped its work and saved the directory.
   * @param request - Captured group identity.
   * @returns Resolution after the acknowledged directory has been accepted.
   */
  async deleteChat(request: DeleteChatRequest): Promise<void> {
    const generation = this.generation
    const result = await this.remote.deleteChat(request)
    if (!this.active || generation !== this.generation) throw new TeamRequestSupersededError()
    if (!result.ok) throw new RemoteError(result.error.code, result.error.message, result.error.details)
    const current = this.state.getSnapshot().snapshot
    if (current === null || result.value.revision > current.revision) this.replace(result.value)
  }

  /**
   * Apply a coordination action to the captured group run.
   * @param action - Coordination action.
   * @param request - Captured group run.
   * @returns The acknowledged group state.
   */
  async control(action: 'pause' | 'resume' | 'stop', request: ChatControlRequest): Promise<ChatMutationValue['chat']> {
    return this.mutate(() => this.remote[action](request))
  }

  /**
   * Continue the selected business task through the current Host.
   * @param request - The selected task revision and captured group run.
   * @returns The acknowledged group state.
   */
  async continueTask(request: ContinueGroupTaskRequest): Promise<ChatMutationValue['chat']> {
    return this.mutate(() => this.remote.continueTask(request))
  }

  /**
   * Record the owner's acceptance of a verified delivery.
   * @param chatId - Owning group.
   * @param taskId - Task with a published delivery.
   * @param expectedRevision - Revision reviewed by the owner.
   * @param acceptanceRequestId - Saved chat instruction when resolving an ambiguous acceptance.
   * @returns The acknowledged group state.
   */
  async completeTask(chatId: ChatId, taskId: GroupTicketId, expectedRevision: number, acceptanceRequestId?: SessionRequestId): Promise<ChatMutationValue['chat']> {
    return this.mutate(() => this.remote.completeTask(chatId, taskId, expectedRevision, acceptanceRequestId))
  }

  /** End all publication when the owning product plugin unloads. */
  dispose(): void { this.active = false; this.resetGeneration() }

  private async mutate(invoke: () => Promise<RemoteResult<ChatMutationValue>>): Promise<ChatMutationValue['chat']> {
    const generation = this.generation
    const result = await invoke()
    if (!this.active || generation !== this.generation) throw new TeamRequestSupersededError()
    if (!result.ok) throw new Error(result.error.code)
    const current = this.state.getSnapshot().snapshot
    if (current === null || result.value.snapshot.revision > current.revision) this.replace(result.value.snapshot)
    return result.value.chat
  }
}
