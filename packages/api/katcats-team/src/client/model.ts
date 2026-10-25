/** React-free member directory; full Host snapshots are the business authority. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type {
  BotMutationValue, CreateBotRequest, CreateGroupRequest, DeleteBotRequest, GroupMutationValue,
  MoveGroupRequest, RemoveGroupRequest, TeamFrame, TeamSnapshot, UpdateBotRequest, UpdateGroupRequest,
} from '../types.ts'

/** Generated Remote face projected into the team model. */
export interface TeamRemote {
  snapshot: () => Promise<RemoteResult<TeamSnapshot>>
  follow: (signal?: AbortSignal) => AsyncIterable<TeamFrame>
  createBot: (request: CreateBotRequest) => Promise<RemoteResult<BotMutationValue>>
  updateBot: (request: UpdateBotRequest) => Promise<RemoteResult<BotMutationValue>>
  deleteBot: (request: DeleteBotRequest) => Promise<RemoteResult<TeamSnapshot>>
  createGroup: (request: CreateGroupRequest) => Promise<RemoteResult<GroupMutationValue>>
  updateGroup: (request: UpdateGroupRequest) => Promise<RemoteResult<GroupMutationValue>>
  moveGroup: (request: MoveGroupRequest) => Promise<RemoteResult<TeamSnapshot>>
  removeGroup: (request: RemoveGroupRequest) => Promise<RemoteResult<TeamSnapshot>>
}

/** Retained data stays visible while a disconnected or failed query can be retried. */
export interface TeamView {
  readonly phase: 'loading' | 'ready' | 'failed'
  readonly snapshot: TeamSnapshot | null
  readonly catalog: ModelCatalog | null
}

/** A completed request belongs to a Host connection the interface has replaced. */
export class TeamRequestSupersededError extends Error {
  /** Create an outcome that must be checked against the current directory. */
  constructor() { super('The team connection changed before the request completed') }
}

/** One directory mirror, scoped to the lifetime of its owning plugin. */
export class TeamClientModel {
  /** Latest usable directory, loading state and credential-free model catalog. */
  readonly state = createSnapshotStore<TeamView>({ phase: 'loading', snapshot: null, catalog: null })
  private active = true
  private generation = 0

  /** @param remote - Generated member operations, with no persistence in the browser. */
  constructor(private readonly remote: TeamRemote) {}

  /**
   * Accept one authoritative replacement from the reconnecting stream.
   * @param snapshot - Complete directory for the current Host generation.
   */
  replace(snapshot: TeamSnapshot): void {
    if (!this.active) return
    this.state.set({ ...this.state.getSnapshot(), phase: 'ready', snapshot })
  }

  /** Fence stale mutations and keep retained rows unavailable until the current Host snapshot arrives. */
  resetGeneration(): void {
    this.generation += 1
    if (this.active) this.state.set({ ...this.state.getSnapshot(), phase: 'loading' })
  }

  /** Preserve retained rows on a visible loading failure. */
  failed(): void {
    if (this.active) this.state.set({ ...this.state.getSnapshot(), phase: 'failed' })
  }

  /**
   * Replace the credential-free model choices from the current Host.
   * @param catalog - Available configured models without provider credentials.
   */
  setCatalog(catalog: ModelCatalog): void {
    if (this.active) this.state.set({ ...this.state.getSnapshot(), catalog })
  }

  /**
   * Refresh the directory without replacing retained rows on a failed read.
   * @returns Resolution after the explicit directory read settles.
   */
  async reload(): Promise<void> {
    const epoch = this.generation
    const result = await this.remote.snapshot()
    if (epoch !== this.generation || !this.active) return
    if (!result.ok) { this.failed(); return }
    this.acceptMutation(result.value)
  }

  /**
   * Create a member through the current Host connection.
   * @param request - Validated form data.
   * @returns The durably created member.
   */
  async createBot(request: CreateBotRequest): Promise<BotMutationValue['bot']> {
    const epoch = this.generation
    const result = await this.remote.createBot(request)
    this.requireGeneration(epoch)
    if (!result.ok) throw new Error(result.error.code)
    this.acceptMutation(result.value.snapshot)
    return result.value.bot
  }

  /**
   * Save the selected member's edited fields.
   * @param request - Captured member identity and patch.
   * @returns The durably updated member.
   */
  async updateBot(request: UpdateBotRequest): Promise<BotMutationValue['bot']> {
    const epoch = this.generation
    const result = await this.remote.updateBot(request)
    this.requireGeneration(epoch)
    if (!result.ok) throw new Error(result.error.code)
    this.acceptMutation(result.value.snapshot)
    return result.value.bot
  }

  /**
   * Remove the captured Bot after the Host confirms its membership checks and durable change.
   * @param request - Captured Bot identity.
   * @returns Resolution after the saved directory has been accepted.
   */
  async deleteBot(request: DeleteBotRequest): Promise<void> {
    const epoch = this.generation
    const result = await this.remote.deleteBot(request)
    this.requireGeneration(epoch)
    if (!result.ok) throw new RemoteError(result.error.code, result.error.message, result.error.details)
    this.acceptMutation(result.value)
  }

  /**
   * Create an ordinary logical group through the current Host connection.
   * @param request - Name for an ordinary logical group.
   * @returns The saved group.
   */
  async createGroup(request: CreateGroupRequest): Promise<GroupMutationValue['group']> {
    const epoch = this.generation
    const result = await this.remote.createGroup(request)
    this.requireGeneration(epoch)
    if (!result.ok) throw new Error(result.error.code)
    this.acceptMutation(result.value.snapshot)
    return result.value.group
  }

  /**
   * Save the selected logical group's replacement name.
   * @param request - Group identity and replacement name.
   * @returns The saved group.
   */
  async updateGroup(request: UpdateGroupRequest): Promise<GroupMutationValue['group']> {
    const epoch = this.generation
    const result = await this.remote.updateGroup(request)
    this.requireGeneration(epoch)
    if (!result.ok) throw new Error(result.error.code)
    this.acceptMutation(result.value.snapshot)
    return result.value.group
  }

  /**
   * Save one adjacent custom-group move without changing member records.
   * @param request - Group identity and direction captured from its menu.
   * @returns Resolution after the committed directory has been accepted.
   */
  async moveGroup(request: MoveGroupRequest): Promise<void> {
    const epoch = this.generation
    const result = await this.remote.moveGroup(request)
    this.requireGeneration(epoch)
    if (!result.ok) throw new Error(result.error.code)
    this.acceptMutation(result.value)
  }

  /**
   * Remove a custom group and return its members to the system Bot group in the same Host mutation.
   * @param request - Captured custom-group identity.
   * @returns Resolution after the committed directory has been accepted.
   */
  async removeGroup(request: RemoveGroupRequest): Promise<void> {
    const epoch = this.generation
    const result = await this.remote.removeGroup(request)
    this.requireGeneration(epoch)
    if (!result.ok) throw new Error(result.error.code)
    this.acceptMutation(result.value)
  }

  /** End publication when the plugin unloads. */
  dispose(): void { this.active = false; this.resetGeneration() }

  private requireGeneration(epoch: number): void {
    if (!this.active || epoch !== this.generation) throw new TeamRequestSupersededError()
  }

  private acceptMutation(snapshot: TeamSnapshot): void {
    const current = this.state.getSnapshot().snapshot
    if (current === null || snapshot.revision >= current.revision) this.replace(snapshot)
  }
}
