/** Owner-managed group directory and isolated Sessions over the public DSH services. */
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError, type MessageId } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SessionCancelRequest, SessionCancelValue, SessionPromptRequest, SessionPromptValue } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { decodeSessionReferenceUri, SessionReferenceError } from '@deepseek-ai/dsh-session-reference'
import { principalOf, Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from './index.ts'
import { chatGroupId, mainBotId } from './storage.ts'
import { chatsDomainSpec, type ChatsState } from './chats-storage.ts'
import { openChatsDomain } from './chats-migration.ts'
import { ChatsRuntime } from './chats-runtime.ts'
import { registerGroupCreationTools } from './group-creation-tools.ts'
import { archiveOwnedSessions, requireInactiveSessions } from './group-organization.ts'
import { admitGroupPrompt, groupRequestDigest } from './group-input.ts'
import { maskFileReferences, replaceMemberMentions } from './member-mentions.ts'
import { recordGroupTicket, ticketForInput, ticketOwnerInput } from './group-tickets.ts'
import type { AcceptChatDelivery, ChatRuntimeActions, ChatRuntimeExpected, ChatRuntimeSnapshot } from './chats-runtime-types.ts'
import type { BotId, GroupId, TeamBot, TeamGroup } from './types.ts'
import type {
  ChatControlRequest, ChatDelivery, ChatDeliveryId, ChatFailure, ChatFrame, ChatId, ChatInbound,
  ChatMemberRole, ChatMutationValue, ChatPass, ChatReceipt, ChatRunId, ChatSnapshot,
  CreateChatRequest, DeleteChatRequest, TeamChat, UpdateChatRequest, UpdateChatRolesRequest,
} from './chats-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Group directory and direct member chat controls; private Sessions remain separate. */
    katcatsChats: KatcatsChats
  }
}

/** Group directory location and dispatch budget for newly created groups. */
export interface ChatsConfig {
  readonly workspaceRoot: string
  readonly relayLimit: number
  /** Recent public messages supplied when an executor has no recorded group context. */
  readonly initialHistoryMessages: number
  /** Maximum public messages returned by one history query. */
  readonly historyPageSize: number
  /** Maximum text characters returned by one history query. */
  readonly historyPageMaxChars: number
  /** Maximum cumulative bytes in candidate text and files during independent review. */
  readonly reviewCandidateMaxBytes: number
}

/** Persistent groups and owner controls; model execution belongs to the composed group runtime. */
export class KatcatsChats extends TypertRemoteService {
  static inject = ['katcatsTeam', 'storageDomain', 'sessionController', 'sessionTitle', 'sessionPersistence', 'agents', 'sessions', 'systemPrompt', 'workspaceRegistry', 'tools', 'llm', 'attachments', 'fileUploads', 'fs']
  static Config: z<ChatsConfig> = z.object({
    workspaceRoot: z.string().required(),
    relayLimit: z.number().min(1).step(1).default(16),
    initialHistoryMessages: z.number().min(1).step(1).default(20),
    historyPageSize: z.number().min(1).step(1).default(20),
    historyPageMaxChars: z.number().min(1).step(1).default(16000),
    reviewCandidateMaxBytes: z.number().min(1).step(1).default(8388608),
  })

  private readonly ready: Promise<void>
  private readonly workspaceRoot: string
  private readonly runtime: ChatsRuntime
  private domain: Domain<typeof chatsDomainSpec> | undefined
  private tail: Promise<void> = Promise.resolve()
  private readonly followers = new Set<() => void>()
  private readonly creationAgents = new Set<Agent>()
  private readonly controls = new Map<ChatId, { readonly kind: 'pause' | 'resume' | 'stop'; settled: boolean }>()
  private readonly controlSettlements = new Set<Promise<undefined>>()
  private readonly promptAdmissions = new Map<ChatId, Promise<void>>()
  private sequence = 0
  private closing = false

  constructor(ctx: Context, private readonly config: ChatsConfig) {
    super(ctx, 'katcatsChats')
    if (!isAbsolute(config.workspaceRoot)) throw new Error('katcats-chats workspaceRoot must be absolute')
    this.workspaceRoot = resolve(config.workspaceRoot)
    this.runtime = new ChatsRuntime(ctx, this.runtimeActions(), this.config)
    ctx.on('agent/created', ({ agent }) => { this.installAgent(agent) })
    ctx.on('agent/status', ({ agent }) => {
      if (this.binding(agent.id) !== undefined) this.notify()
    })
    this.ready = this.initialize()
    ctx.effect(() => ctx.katcatsTeam.organization.register({
      memberships: async (botId) => {
        await this.ready
        return this.serialize(async () => {
          this.requireOwner()
          await this.finishPending()
          return this.state.chats.filter(chat => chat.memberIds.includes(botId)).map(chat => chat.id)
        })
      },
      moveGroup: async (groupId) => {
        await this.ready
        await this.serialize(async () => {
          this.requireOwner()
          await this.finishPending()
          if (!this.state.chats.some(chat => chat.groupId === groupId)) return
          await this.commit({ ...this.state, chats: this.state.chats.map(chat => chat.groupId === groupId
            ? { ...chat, groupId: chatGroupId } : chat) })
        })
      },
    }))
    ctx.effect(() => async () => {
      this.closing = true
      this.notify()
      await this.ready.catch(() => {})
      await this.runtime.dispose()
      await Promise.all(this.promptAdmissions.values())
      await Promise.all(this.controlSettlements)
      await this.tail
      await this.domain?.close()
    })
  }

  /** Publish the service only after accepted settings and cold recovery are durable. */
  protected [Service.init](): Promise<void> { return this.ready }

  private get state(): ChatsState {
    if (this.domain === undefined) throw new Error('Katcats group directory is not open')
    return this.domain.global.get()
  }

  private serialize<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => {}, () => {})
    return result
  }

  private async commit(next: ChatsState, afterSaved?: () => void): Promise<void> {
    if (this.domain === undefined) throw new Error('Katcats group directory is not open')
    const before = new Map(this.state.deliveries.map(delivery => [delivery.id, delivery.state]))
    await this.domain.global.set({ ...next, revision: this.state.revision + 1 })
    afterSaved?.()
    this.notify()
    await this.publishTaskStates(next.deliveries.filter(delivery => before.get(delivery.id) !== delivery.state))
  }

  private async publishTaskStates(changed: readonly ChatDelivery[]): Promise<void> {
    if (changed.length === 0) return
    const team = await this.ctx.katcatsTeam.snapshot()
    for (const id of new Set(changed.map(delivery => delivery.chatId))) {
      const chat = this.chat(id)
      await this.runtime.publishTaskStates(chat, changed.filter(delivery => delivery.chatId === id),
        this.state.deliveries.filter(delivery => delivery.chatId === id), team.bots)
    }
  }

  private notify(): void {
    this.sequence += 1
    for (const wake of this.followers) wake()
  }

  private requireOwner(): void {
    const invocation = this.ctx.invocation
    if (invocation !== undefined && principalOf(invocation) !== undefined) {
      throw new RemoteError('remote-access/denied', 'Only the owner can manage group conversations', {
        action: `${invocation.request.namespace}/${invocation.request.method}`, reason: 'owner-required',
      })
    }
    if (this.closing) throw new RemoteError('gateway/internal', 'The group directory is closing', {})
  }

  private chat(id: ChatId): TeamChat {
    const chat = this.state.chats.find(chat => chat.id === id)
    if (chat === undefined) throw new RemoteError('gateway/bad-request', 'Group does not exist', {})
    return chat
  }

  private delivery(id: ChatDeliveryId): ChatDelivery {
    const delivery = this.state.deliveries.find(delivery => delivery.id === id)
    if (delivery === undefined) throw new RemoteError('gateway/bad-request', 'Group task does not exist', {})
    return delivery
  }

  private async replaceChat(chat: TeamChat): Promise<void> {
    await this.commit({ ...this.state, chats: this.state.chats.map(previous => previous.id === chat.id ? chat : previous) })
  }

  private snapshotValue(): ChatSnapshot {
    return {
      revision: this.state.revision, chats: this.state.chats, deliveries: this.state.deliveries,
      relayLimit: this.config.relayLimit,
      activities: this.state.chats.map(chat => ({
        chatId: chat.id,
        processing: this.runtime.isProcessing(chat.id),
        runningBotIds: chat.executors.filter(executor => this.ctx.agents.get(executor.sessionId)?.status === 'running').map(executor => executor.botId),
        pendingControl: this.controls.get(chat.id)?.kind ?? null,
      })),
    }
  }

  private async initialize(): Promise<void> {
    const team = await this.ctx.katcatsTeam.snapshot()
    this.domain = await openChatsDomain(this.ctx)
    const privateSessions = new Set(team.bots.map(bot => bot.sessionId))
    const pending = this.state.pendingChat?.chat
    for (const chat of pending === undefined ? this.state.chats : [...this.state.chats, pending]) {
      if ([chat.rootSessionId, ...chat.executors.map(executor => executor.sessionId)].some(id => privateSessions.has(id))) {
        throw new RemoteError('gateway/bad-request', 'Group execution cannot reuse a member private conversation', {})
      }
    }
    for (const chat of this.state.chats) {
      this.groupValue(chat.groupId, team.groups)
      await this.validateMembers(chat.memberIds, chat.memberIds.includes(mainBotId))
      await this.ensureWorkDir(chat)
      const workspace = await this.ctx.workspaceRegistry.create(chat.workDir, chat.name)
      for (const sessionId of [chat.rootSessionId, ...chat.executors.map(executor => executor.sessionId)]) {
        const stored = await this.ctx.sessionPersistence.stat(sessionId)
        if (stored === undefined || stored.header.cwd === undefined || await realpath(stored.header.cwd) !== workspace.path) {
          throw new RemoteError('gateway/bad-request', 'A saved group conversation is missing or uses a different working directory', {})
        }
        await workspace.attachSession(sessionId)
      }
    }
    for (const agent of this.ctx.agents.list()) this.installAgent(agent)
    await this.serialize(async () => {
      await this.finishPending()
      const interrupted = new Set(this.state.deliveries.filter(delivery => delivery.state === 'running').map(delivery => delivery.chatId))
      for (const chat of this.state.chats) if (chat.run !== null && chat.status === 'active') interrupted.add(chat.id)
      if (interrupted.size === 0) return
      const uncertain: ChatFailure = { code: 'interrupted', message: 'Previous group work was interrupted. Check its saved results before continuing.' }
      await this.commit({
        ...this.state,
        deliveries: this.state.deliveries.map(delivery => delivery.state === 'running'
          ? { ...delivery, state: 'unknown', error: uncertain } : delivery),
        chats: this.state.chats.map(chat => interrupted.has(chat.id) && chat.run !== null && chat.status !== 'stopped'
          ? { ...chat, status: 'paused', pauseReason: 'restart', error: uncertain } : chat),
      })
    })
    for (const chat of this.state.chats) {
      if (this.state.inbounds.some(input => input.chatId === chat.id && input.state === 'accepted')
        || this.state.deliveries.some(delivery => delivery.chatId === chat.id)) {
        try { await this.runtime.reconcile(chat.id) } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'KATCATS_CHAT_CONTAINER_BUSY')) throw error
          await this.serialize(async () => {
            const current = this.chat(chat.id)
            await this.replaceChat({ ...current, status: current.status === 'stopped' ? 'stopped' : 'paused',
              pauseReason: 'legacy-queue', error: { code: 'legacy-queue',
                message: 'This group has pending work from its earlier chat mode. Stop that run before continuing; saved history is retained.' } })
          })
        }
      }
    }
  }

  /**
   * Read a group's Session binding without executing work or entering the mutation queue.
   * Historical executor bindings remain after member removal; callers must check current membership.
   * @param sessionId - transcript or executor Session identity, including accepted pending creation.
   * @returns the group and executor identity, or undefined for a Session outside the group directory.
   */
  binding(sessionId: SessionId): { chatId: ChatId; botId: BotId | 'root' } | undefined {
    if (this.domain === undefined) return undefined
    const pending = this.state.pendingChat?.chat
    const chats = pending === undefined ? this.state.chats : [pending, ...this.state.chats.filter(chat => chat.id !== pending.id)]
    for (const chat of chats) {
      if (chat.rootSessionId === sessionId) return { chatId: chat.id, botId: 'root' }
      const executor = chat.executors.find(executor => executor.sessionId === sessionId)
      if (executor !== undefined) return { chatId: chat.id, botId: executor.botId }
    }
    return undefined
  }

  private installAgent(agent: Agent): void {
    const binding = this.binding(agent.id)
    if (binding !== undefined) this.runtime.install(agent, binding)
    if (this.ctx.katcatsTeam.memberForSession(agent.id)?.kind !== 'main' || this.creationAgents.has(agent)) return
    this.ctx.effect(function* (this: KatcatsChats) {
      yield agent.ctx.on('agent/disposed', () => { this.creationAgents.delete(agent) })
      const authorize = (exec: ToolRunContext) => () => {
        this.requireOwner()
        if (exec.agent !== agent || this.ctx.agents.get(agent.id) !== agent
          || this.ctx.katcatsTeam.memberForSession(agent.id)?.kind !== 'main') {
          throw new HarnessError('Only the main Bot can create group conversations.', 'KATCATS_TOOL_DENIED')
        }
      }
      yield registerGroupCreationTools(agent, {
        create: async (request, exec) => (await this.createValue(request, exec.signal, authorize(exec), true)).chat,
        list: exec => this.readValue(exec.signal, authorize(exec)),
      })
      yield () => { this.creationAgents.delete(agent) }
    }.bind(this), 'katcats-chats.groupCreation()')
    this.creationAgents.add(agent)
  }

  private async validateMembers(ids: readonly BotId[], retainLegacyMain = false): Promise<readonly BotId[]> {
    const team = await this.ctx.katcatsTeam.snapshot()
    const selected = [...ids]
    if (selected.length === 0 || new Set(selected).size !== selected.length
      || selected.some(id => !team.bots.some(bot => bot.id === id) || (id === mainBotId && !retainLegacyMain))) {
      throw new RemoteError('gateway/bad-request', 'Select at least one distinct existing ordinary Bot; the creator Bot is not a group member', {})
    }
    return selected
  }

  private groupValue(id: GroupId, groups: readonly TeamGroup[]): GroupId {
    const group = groups.find(item => item.id === id)
    if (group === undefined || (group.id !== chatGroupId && (group.system || group.kind !== 'bots'))) {
      throw new RemoteError('gateway/bad-request', 'Select the group chat section or an existing custom group', {})
    }
    return group.id
  }

  private managerValue(managerId: BotId | null, memberIds: readonly BotId[]): BotId | null {
    if (managerId !== null && !memberIds.includes(managerId)) {
      throw new RemoteError('gateway/bad-request', 'The responsible Bot must belong to this group', {})
    }
    return managerId
  }

  private rolesValue(roles: readonly ChatMemberRole[], memberIds: readonly BotId[]): readonly ChatMemberRole[] {
    if (new Set(roles.map(member => member.botId)).size !== roles.length || roles.some(member => !memberIds.includes(member.botId))) {
      throw new RemoteError('gateway/bad-request', 'Group responsibilities must identify distinct current members', {})
    }
    return roles.map(member => ({ botId: member.botId, role: this.nameValue(member.role) }))
  }

  private nameValue(value: string): string {
    const name = value.trim()
    if (name.length === 0) throw new RemoteError('gateway/bad-request', 'Provide a non-empty group name', {})
    return name
  }

  private limit(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1) throw new RemoteError('gateway/bad-request', 'Relay limit must be a positive integer', {})
    return value
  }

  private async ensureWorkDir(chat: TeamChat): Promise<void> {
    if (resolve(chat.workDir) !== join(this.workspaceRoot, 'chats', chat.id)) throw new Error('Group directory is outside its assigned location')
    for (const path of [this.workspaceRoot, join(this.workspaceRoot, 'chats'), chat.workDir]) {
      try { await mkdir(path) } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      }
      const entry = await lstat(path)
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new RemoteError('gateway/bad-request', 'Group directories cannot use redirected links', {})
    }
  }

  private async provisionSession(sessionId: SessionId, workspaceId: Parameters<Context['workspaceRegistry']['get']>[0], title: string, path: string): Promise<void> {
    const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) {
      if (resolved.error.code !== 'session/not-found') throw resolved.error
      const created = await this.ctx.sessionController.create({ sessionId, workspaceId })
      if (created.sessionId !== sessionId) throw new Error('Group Session identity was not retained')
    }
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('Group Agent was not published')
    this.installAgent(agent)
    const cwd = agent.session.header.cwd
    if (cwd === undefined || await realpath(cwd) !== path) throw new Error('Group Session working directory does not match its group')
    await this.ctx.sessionController.rename({ sessionId, title })
    if (!await this.ctx.sessions.flush(agent.session)) throw new Error('Group Session has no durability owner')
  }

  private async finishPending(): Promise<TeamChat | undefined> {
    const pending = this.state.pendingChat
    if (pending === null) return undefined
    const target = pending.chat
    await this.ensureWorkDir(target)
    const workspace = await this.ctx.workspaceRegistry.create(target.workDir, target.name)
    await this.provisionSession(target.rootSessionId, workspace.id, target.name, workspace.path)
    for (const executor of target.executors) {
      await this.provisionSession(executor.sessionId, workspace.id, `${target.name} · ${executor.botId}`, workspace.path)
      await workspace.attachSession(executor.sessionId)
    }
    await workspace.attachSession(target.rootSessionId)
    const previous = this.state.chats.find(chat => chat.id === target.id)
    const completed = pending.kind === 'create' ? target : {
      ...this.chat(target.id), name: target.name, groupId: target.groupId, memberIds: target.memberIds,
      managerId: target.managerId, memberRoles: target.memberRoles,
      executors: target.executors, relayLimit: target.relayLimit,
      ...(target.showHandoffRecords === undefined ? {} : { showHandoffRecords: target.showHandoffRecords }),
    }
    await this.commit({
      ...this.state,
      chats: previous === undefined ? [completed, ...this.state.chats]
        : this.state.chats.map(chat => chat.id === completed.id ? completed : chat),
      pendingChat: null,
    })
    return completed
  }

  /**
   * Read committed groups after recovering any accepted create/settings target.
   * @returns the owner directory and current public Agent activity.
   */
  @Remote
  async snapshot(): Promise<ChatSnapshot> { this.requireOwner(); return this.readValue() }

  private async readValue(signal?: AbortSignal, authorize?: () => void): Promise<ChatSnapshot> {
    await this.ready
    return this.serialize(async () => {
      signal?.throwIfAborted(); authorize?.()
      await this.finishPending()
      return this.snapshotValue()
    })
  }

  private transcriptChat(sessionId: SessionId): TeamChat {
    const chat = this.state.chats.find(value => value.rootSessionId === sessionId)
    if (chat === undefined) throw new RemoteError('gateway/bad-request', 'Select a group conversation before sending or stopping a group message', {})
    return chat
  }

  private recipients(request: SessionPromptRequest, chat: TeamChat, bots: readonly TeamBot[]): Pick<ChatInbound, 'recipients' | 'addressing'> {
    const ordinary = bots.filter(bot => bot.id !== mainBotId && chat.memberIds.includes(bot.id))
    const text = maskFileReferences(request.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'))
    const selected = new Set<BotId>()
    const withoutMembers = replaceMemberMentions(text, (mention) => {
      if (mention.chatId !== chat.id || !ordinary.some(bot => bot.id === mention.botId)) {
        throw new RemoteError('gateway/bad-request', 'A group mention must identify one of its current ordinary members', {})
      }
      selected.add(mention.botId)
      return ' '
    })
    const wire = /@\[((?:\\.|[^\\\]])*)\]\((dsh-session:[^\s)]*)\)/gu
    const withoutReferences = withoutMembers.replace(wire, (_match: string, _label: string, uri: string) => {
      let sessionId: SessionId
      try { sessionId = decodeSessionReferenceUri(uri) } catch (error) {
        if (!(error instanceof SessionReferenceError)) throw error
        throw new RemoteError('gateway/bad-request', 'Select a valid group member mention', {})
      }
      const bot = ordinary.find(member => member.sessionId === sessionId
        || chat.executors.some(executor => executor.botId === member.id && executor.sessionId === sessionId))
      if (bot === undefined) throw new RemoteError('gateway/bad-request', 'A group mention must identify one of its current ordinary members', {})
      selected.add(bot.id)
      return ' '
    })
    const byName = [...ordinary].sort((left, right) => right.name.length - left.name.length)
    let hasBareMention = false
    for (let index = withoutReferences.indexOf('@'); index >= 0; index = withoutReferences.indexOf('@', index + 1)) {
      const previous = withoutReferences.slice(Math.max(index - 1, 0), index)
      if (/[\p{L}\p{N}_.+-]/u.test(previous)) continue
      hasBareMention = true
      const matching = byName.filter(bot => withoutReferences.startsWith(bot.name, index + 1)
        && !/[\p{L}\p{N}_-]/u.test(withoutReferences[index + 1 + bot.name.length] ?? ''))
      const longest = matching[0]?.name
      const exact = matching.filter(bot => bot.name === longest)
      const target = exact[0]
      if (exact.length !== 1 || target === undefined) {
        throw new RemoteError('gateway/bad-request', 'Use a distinct current member name when mentioning a Bot', {})
      }
      selected.add(target.id)
    }
    const addressing = selected.size > 0 || hasBareMention ? 'explicit' : 'broadcast'
    const recipients = chat.memberIds.filter(id => ordinary.some(bot => bot.id === id)
      && (addressing === 'broadcast' || selected.has(id)))
    const first = recipients[0]
    if (first === undefined) throw new RemoteError('gateway/bad-request', 'This group has no ordinary member available to reply', {})
    const responsible = chat.managerId !== null && recipients.includes(chat.managerId) ? chat.managerId : first
    return { recipients: addressing === 'broadcast' ? [responsible] : recipients, addressing }
  }

  private startRun(chat: TeamChat): TeamChat {
    if (chat.run !== null) return chat
    const generation = chat.generation + 1
    return { ...chat, generation, run: { id: brandString<ChatRunId>(`run-${randomUUID()}`), generation, relayCount: 0 } }
  }

  private runInputs(chat: TeamChat): readonly ChatInbound[] {
    return this.state.inbounds.filter(input => input.chatId === chat.id && input.runId === chat.run?.id
      && input.generation === chat.generation)
  }

  private ownerRun(chat: TeamChat, queued: readonly ChatInbound[]): {
    chat: TeamChat
    inbounds: ChatsState['inbounds']
    deliveries: ChatsState['deliveries']
  } {
    const next = this.startRun({ ...chat, status: 'active', pauseReason: null, error: null, run: null })
    if (next.run === null) throw new Error('The next owner input has no group run')
    const runId = next.run.id
    const existing = this.state.deliveries.filter(delivery => delivery.chatId === chat.id)
    const queuedIds = new Set(queued.filter(input => !existing.some(delivery => this.ownerMessage(delivery) === input.userMessage.id))
      .map(input => input.userMessage.id))
    const superseded: ChatFailure = { code: 'superseded',
      message: 'A new owner message started another run before this task was dispatched.' }
    const deliveries = this.state.deliveries.map<ChatDelivery>(delivery => delivery.chatId === chat.id
      && delivery.runId === chat.run?.id && delivery.generation === chat.generation
      ? { ...delivery, ...(delivery.state === 'accepted' ? { state: 'failed' as const, error: superseded } : {}),
        ...(delivery.takeover?.state === 'pending' ? { takeover: { ...delivery.takeover, state: 'stopped' as const } } : {}) } : delivery)
    for (const input of this.runInputs(chat)) {
      if (queuedIds.has(input.userMessage.id)) continue
      for (const botId of input.recipients) {
        if (existing.some(delivery => delivery.botId === botId && this.ownerMessage(delivery) === input.userMessage.id)) continue
        const executor = chat.executors.find(executor => executor.botId === botId)
        if (executor === undefined) throw new Error('The saved owner input has no member execution binding')
        const text = input.userMessage.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
        deliveries.push({ id: brandString<ChatDeliveryId>(`delivery-${randomUUID()}`), chatId: chat.id,
          runId: input.runId, generation: input.generation, sourceSessionId: chat.rootSessionId,
          source: { kind: 'owner-message', messageId: input.userMessage.id }, botId, executorSessionId: executor.sessionId,
          message: text.trim().length > 0 ? text : 'Respond to the owner message and its attached group content.',
          inputMessageId: brandString<MessageId>(`message-${randomUUID()}`), relayMessageId: brandString<MessageId>(`message-${randomUUID()}`),
          state: 'failed', receipt: null, pass: null, relayed: false, error: superseded })
      }
    }
    return { chat: next,
      inbounds: this.state.inbounds.map(input => queuedIds.has(input.userMessage.id)
        ? { ...input, runId, generation: next.generation } : input),
      deliveries,
    }
  }

  /**
   * Admit the original composer's message into a pure group transcript and schedule actual members.
   * Identical request retries reuse the durable input; a changed retry is rejected before resolving uploads.
   * Queue requests preserve active work and pauses; stopped groups start a new run. Steering replaces the run and drains its old work.
   * @param request - owner message targeting the group's exact transcript Session.
   * @param signal - cancellation before durable input acceptance.
   * @returns confirmation after the owner message is flushed and any interrupted work settles; member replies arrive separately.
   */
  @Remote
  async sendMessage(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue> {
    this.requireOwner()
    await this.ready
    const id = await this.serialize(() => {
      this.requireOwner()
      return this.transcriptChat(request.sessionId).id
    })
    const previous = this.promptAdmissions.get(id) ?? Promise.resolve()
    const pending = previous.then(() => this.submitPrompt(request, signal))
    const settled = pending.then(() => {}, () => {})
    this.promptAdmissions.set(id, settled)
    try { return await pending } finally {
      if (this.promptAdmissions.get(id) === settled) this.promptAdmissions.delete(id)
    }
  }

  private async submitPrompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue> {
    this.requireOwner()
    const digest = groupRequestDigest(request)
    const prepared = await this.serialize(async () => {
      signal.throwIfAborted(); this.requireOwner()
      await this.finishPending()
      const chat = this.transcriptChat(request.sessionId)
      const duplicate = this.state.inbounds.find(input => input.chatId === chat.id && input.requestId === request.requestId)
      if (duplicate !== undefined) {
        if (duplicate.requestDigest !== digest) throw new RemoteError('gateway/bad-request', 'A saved group message cannot change during retry', {})
        return { kind: 'existing' as const, chatId: chat.id }
      }
      if (this.controls.has(chat.id)) throw new RemoteError('gateway/bad-request', 'Wait for the current group control before sending another message', {})
      const team = await this.ctx.katcatsTeam.snapshot()
      const targets = this.recipients(request, chat, team.bots)
      return { kind: 'new' as const, chat, targets, bots: team.bots.filter(bot => targets.recipients.includes(bot.id)) }
    })
    const chatId = prepared.kind === 'existing' ? prepared.chatId : await admitGroupPrompt(
      this.ctx, request, prepared.bots, signal, async (userMessage, commitFiles) => {
        if (request.mode === 'steer') {
          const captured = await this.serialize(async () => {
            signal.throwIfAborted(); this.requireOwner()
            const previous = this.chat(prepared.chat.id)
            const duplicate = this.state.inbounds.find(input => input.chatId === previous.id && input.requestId === request.requestId)
            if (duplicate !== undefined) {
              if (duplicate.requestDigest !== digest) throw new RemoteError('gateway/bad-request', 'A saved group message cannot change during retry', {})
              return { kind: 'existing' as const, id: previous.id }
            }
            if (this.controls.has(previous.id)) throw new RemoteError('gateway/bad-request', 'Wait for the current group control before sending another message', {})
            const team = await this.ctx.katcatsTeam.snapshot()
            const targets = this.recipients(request, previous, team.bots)
            if (previous.generation !== prepared.chat.generation || JSON.stringify(targets) !== JSON.stringify(prepared.targets)) {
              throw new RemoteError('gateway/bad-request', 'The group changed while this message was being admitted. Review it and send again.', {})
            }
            const token = { kind: 'stop' as const, settled: false }
            this.controls.set(previous.id, token)
            this.notify()
            return { kind: 'new' as const, id: previous.id, token,
              expected: { runId: previous.run?.id ?? null, generation: previous.generation } }
          })
          if (captured.kind === 'existing') return captured.id
          try {
            await this.runtime.interrupt(captured.id, captured.expected, () => this.serialize(async () => {
              signal.throwIfAborted(); this.requireOwner()
              const previous = this.chat(captured.id)
              this.expected(previous, captured.expected)
              if (this.controls.get(captured.id) !== captured.token) throw new RemoteError('gateway/bad-request', 'The group input was superseded by another control', {})
              const team = await this.ctx.katcatsTeam.snapshot()
              const targets = this.recipients(request, previous, team.bots)
              if (JSON.stringify(targets) !== JSON.stringify(prepared.targets)) {
                throw new RemoteError('gateway/bad-request', 'The group members changed during message admission. Review it and send again.', {})
              }
              const reset = this.ownerRun(previous, [])
              if (reset.chat.run === null) throw new Error('Accepted group steering has no run')
              const inbound: ChatInbound = { requestId: request.requestId, requestDigest: digest, chatId: captured.id,
                runId: reset.chat.run.id, generation: reset.chat.generation, userMessage, ...targets, collaborationVersion: 1, coordinationVersion: 1, state: 'accepted' }
              await this.commit({ ...this.state, chats: this.state.chats.map(chat => chat.id === captured.id ? reset.chat : chat),
                inbounds: [...reset.inbounds, inbound], deliveries: reset.deliveries }, commitFiles)
            }))
          } finally {
            captured.token.settled = true
            if (this.controls.get(captured.id) === captured.token) this.controls.delete(captured.id)
            this.notify()
          }
          return captured.id
        }
        return this.serialize(async () => {
          signal.throwIfAborted(); this.requireOwner()
          const previous = this.chat(prepared.chat.id)
          const duplicate = this.state.inbounds.find(input => input.chatId === previous.id && input.requestId === request.requestId)
          if (duplicate !== undefined) {
            if (duplicate.requestDigest !== digest) throw new RemoteError('gateway/bad-request', 'A saved group message cannot change during retry', {})
            return previous.id
          }
          if (this.controls.has(previous.id)) throw new RemoteError('gateway/bad-request', 'Wait for the current group control before sending another message', {})
          const team = await this.ctx.katcatsTeam.snapshot()
          const targets = this.recipients(request, previous, team.bots)
          const prior = prepared.chat
          if (previous.generation !== prior.generation || previous.run?.id !== prior.run?.id || previous.status !== prior.status
            || JSON.stringify(targets) !== JSON.stringify(prepared.targets)) {
            throw new RemoteError('gateway/bad-request', 'The group changed while this message was being admitted. Review it and send again.', {})
          }
          const next = this.startRun(previous.status === 'stopped'
            ? { ...previous, status: 'active', pauseReason: null, error: null } : previous)
          if (next.run === null) throw new Error('Accepted group message has no run')
          const inbound: ChatInbound = { requestId: request.requestId, requestDigest: digest, chatId: next.id,
            runId: next.run.id, generation: next.generation, userMessage, ...targets, collaborationVersion: 1, coordinationVersion: 1, state: 'accepted' }
          await this.commit({ ...this.state, chats: this.state.chats.map(chat => chat.id === next.id ? next : chat),
            inbounds: [...this.state.inbounds, inbound] }, commitFiles)
          return next.id
        })
      },
    )
    await this.runtime.publishInbound(chatId)
    this.runtime.kick(chatId)
    return { accepted: true }
  }

  /**
   * Stop the current group work from the original composer, using a fresh captured run generation.
   * @param request - the exact transcript Session selected when Stop was pressed.
   * @returns confirmation after owned member work and approvals have settled.
   */
  @Remote
  async cancelSession(request: SessionCancelRequest): Promise<SessionCancelValue> {
    this.requireOwner()
    await this.ready
    const control = await this.serialize(() => {
      this.requireOwner()
      const chat = this.transcriptChat(request.sessionId)
      return { id: chat.id, expectedRunId: chat.run?.id ?? null, expectedGeneration: chat.generation }
    })
    await this.stop(control)
    return { accepted: true }
  }

  /**
   * Follow directory and live activity replacements, including activity-only changes.
   * @param signal - caller-owned cancellation.
   * @returns a baseline and later complete replacements until disconnect or plugin disposal.
   */
  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<ChatFrame> {
    this.requireOwner()
    await this.readValue()
    let seen = -1
    while (!signal.aborted && !this.closing) {
      if (seen !== this.sequence) {
        const type = seen === -1 ? 'snapshot' : 'replace'
        seen = this.sequence
        yield { type, value: this.snapshotValue() }
        continue
      }
      const next = Promise.withResolvers<undefined>()
      const wake = () => { next.resolve(undefined) }
      this.followers.add(wake)
      signal.addEventListener('abort', wake, { once: true })
      try { await next.promise } finally { this.followers.delete(wake); signal.removeEventListener('abort', wake) }
    }
  }

  /**
   * Create an isolated group and one persistent execution Session per selected ordinary member.
   * Newly created groups precede existing groups in the durable directory.
   * @param request - name, ordinary members, and optional positive dispatch limit.
   * @returns the fully committed group and replacement directory.
   */
  @Remote
  async createChat(request: CreateChatRequest): Promise<ChatMutationValue> {
    this.requireOwner()
    return this.createValue(request)
  }

  private async createValue(
    request: CreateChatRequest, signal?: AbortSignal, authorize?: () => void, reuseExisting = false,
  ): Promise<ChatMutationValue> {
    await this.ready
    return this.ctx.katcatsTeam.organization.run(() => this.serialize(async () => {
      this.requireOwner()
      signal?.throwIfAborted(); authorize?.()
      const name = this.nameValue(request.name)
      const memberIds = await this.validateMembers(request.memberIds)
      const managerId = this.managerValue(request.managerId ?? null, memberIds)
      const relayLimit = this.limit(request.relayLimit ?? this.config.relayLimit)
      const pending = this.state.pendingChat
      const retry = pending?.kind === 'create' && pending.chat.name === name && pending.chat.relayLimit === relayLimit
        && pending.chat.managerId === managerId
        && pending.chat.memberIds.length === memberIds.length && memberIds.every(id => pending.chat.memberIds.includes(id))
      const recovered = await this.finishPending()
      if (retry && recovered !== undefined) return { chat: recovered, snapshot: this.snapshotValue() }
      if (reuseExisting) {
        const existing = this.state.chats.find(chat => chat.name === name && chat.managerId === managerId
          && chat.memberIds.length === memberIds.length && memberIds.every(id => chat.memberIds.includes(id)))
        if (existing !== undefined) return { chat: existing, snapshot: this.snapshotValue() }
      }
      const id = brandString<ChatId>(`chat-${randomUUID()}`)
      const chat: TeamChat = {
        id, name, groupId: chatGroupId, rootSessionId: brandString<SessionId>(`session-${randomUUID()}`),
        workDir: join(this.workspaceRoot, 'chats', id), memberIds, managerId, memberRoles: [],
        executors: memberIds.map(botId => ({ botId, sessionId: brandString<SessionId>(`session-${randomUUID()}`) })),
        relayLimit, showHandoffRecords: true, generation: 0, status: 'active', pauseReason: null, run: null, error: null,
      }
      signal?.throwIfAborted(); authorize?.()
      await this.commit({ ...this.state, pendingChat: { kind: 'create', chat } })
      await this.finishPending()
      return { chat, snapshot: this.snapshotValue() }
    }))
  }

  /**
   * Update group settings while idle or paused without replacing any existing Session identity.
   * Grouping and transcript-presentation updates use one directory write and may run while members are working.
   * @param request - group identity and explicit settings to replace.
   * @returns the committed group and replacement directory.
   */
  @Remote
  async updateChat(request: UpdateChatRequest): Promise<ChatMutationValue> {
    this.requireOwner()
    await this.ready
    return this.ctx.katcatsTeam.organization.run(() => this.serialize(async () => {
      this.requireOwner()
      await this.finishPending()
      const previous = this.chat(request.id)
      const groupId = request.groupId === undefined ? previous.groupId
        : this.groupValue(request.groupId, (await this.ctx.katcatsTeam.snapshot()).groups)
      const presentation = request.showHandoffRecords === undefined ? {} : { showHandoffRecords: request.showHandoffRecords }
      if ((request.groupId !== undefined || request.showHandoffRecords !== undefined)
        && request.name === undefined && request.memberIds === undefined
        && request.managerId === undefined && request.memberRoles === undefined && request.relayLimit === undefined) {
        const chat = { ...previous, groupId, ...presentation }
        await this.replaceChat(chat)
        return { chat, snapshot: this.snapshotValue() }
      }
      if (this.controls.has(previous.id) || this.runtime.isProcessing(previous.id)
        || previous.executors.some(executor => this.ctx.agents.get(executor.sessionId)?.status === 'running')
        || this.state.deliveries.some(delivery => delivery.chatId === previous.id && delivery.state === 'running')
        || (previous.status === 'active' && this.ctx.agents.get(previous.rootSessionId)?.status === 'running')) {
        throw new RemoteError('gateway/bad-request', 'Pause or stop the group and wait for the current member before editing its settings', {})
      }
      const memberIds = request.memberIds === undefined ? previous.memberIds
        : await this.validateMembers(request.memberIds, previous.memberIds.includes(mainBotId))
      const managerId = this.managerValue(request.managerId === undefined
        ? (previous.managerId !== null && memberIds.includes(previous.managerId) ? previous.managerId : null)
        : request.managerId, memberIds)
      const memberRoles = this.rolesValue(
        request.memberRoles ?? previous.memberRoles.filter(member => memberIds.includes(member.botId)), memberIds)
      const target: TeamChat = {
        ...previous, name: request.name === undefined ? previous.name : this.nameValue(request.name),
        groupId, memberIds, managerId, memberRoles, ...presentation,
        relayLimit: request.relayLimit === undefined ? previous.relayLimit : this.limit(request.relayLimit),
        executors: [...previous.executors, ...memberIds
          .filter(id => id !== mainBotId && !previous.executors.some(executor => executor.botId === id))
          .map(botId => ({ botId, sessionId: brandString<SessionId>(`session-${randomUUID()}`) }))],
      }
      const removed: ChatFailure = { code: 'member-removed', message: 'The selected member was removed before this task was dispatched.' }
      await this.commit({ ...this.state, pendingChat: { kind: 'settings', chat: target },
        deliveries: this.state.deliveries.map(delivery => delivery.chatId === previous.id && delivery.state === 'accepted' && !memberIds.includes(delivery.botId)
          ? { ...delivery, state: 'failed', error: removed } : delivery) })
      const chat = await this.finishPending()
      if (chat === undefined) throw new Error('Accepted group settings were not recovered')
      return { chat, snapshot: this.snapshotValue() }
    }))
  }

  /**
   * Stop one group's owned work and remove its directory and dispatch journal, retaining Sessions and files.
   * @param request - group identity; active scheduled tasks must be stopped first.
   * @returns the replacement group snapshot after durable removal.
   */
  @Remote
  async deleteChat(request: DeleteChatRequest): Promise<ChatSnapshot> {
    this.requireOwner()
    await this.ready
    const settled = Promise.withResolvers<undefined>()
    this.controlSettlements.add(settled.promise)
    return this.ctx.katcatsTeam.organization.run(async () => {
      const current = await this.serialize(async () => {
        this.requireOwner()
        await this.finishPending()
        const chat = this.chat(request.id)
        if (this.controls.has(chat.id)) throw new RemoteError('katcats/organization', 'Wait for the current group control before deleting it.', { reason: 'chat-busy' })
        this.controls.set(chat.id, { kind: 'stop', settled: false })
        this.notify()
        return chat
      })
      try {
        const ids = [current.rootSessionId, ...current.executors.map(executor => executor.sessionId)]
        await requireInactiveSessions(this.ctx, ids, true)
        await this.runtime.stop(current.id, { runId: current.run?.id ?? null, generation: current.generation })
        this.requireOwner()
        await requireInactiveSessions(this.ctx, ids)
        const rollback = await archiveOwnedSessions(this.ctx, ids)
        try {
          await this.serialize(async () => {
            this.requireOwner()
            const stopped = this.chat(current.id)
            if (stopped.status !== 'stopped' || this.runtime.isProcessing(stopped.id)) {
              throw new RemoteError('katcats/organization', 'Wait for this group to stop before deleting it.', { reason: 'chat-busy' })
            }
            await this.commit({ ...this.state,
              chats: this.state.chats.filter(chat => chat.id !== current.id),
              inbounds: this.state.inbounds.filter(input => input.chatId !== current.id),
              deliveries: this.state.deliveries.filter(delivery => delivery.chatId !== current.id),
            })
          })
        } catch (error) {
          try { await rollback() } catch (rollbackError) {
            throw new RemoteError('katcats/organization', 'Group deletion is incomplete. Its record and history are retained; reopen the team before retrying.', { reason: 'delete-incomplete' }, { cause: rollbackError })
          }
          throw error
        }
        await this.runtime.release(current.id)
        return this.snapshotValue()
      } finally {
        this.controls.delete(current.id)
        this.notify()
      }
    }).finally(() => {
      this.controlSettlements.delete(settled.promise)
      settled.resolve(undefined)
    })
  }

  private expected(chat: TeamChat, expected: ChatRuntimeExpected): void {
    if (chat.generation !== expected.generation || (chat.run?.id ?? null) !== expected.runId) {
      throw new RemoteError('gateway/bad-request', 'This control belongs to an older group run. Refresh the group before trying again.', {})
    }
  }

  private async control(
    request: ChatControlRequest, kind: 'pause' | 'resume' | 'stop', operation: (current: () => boolean) => Promise<void>,
  ): Promise<ChatMutationValue> {
    this.requireOwner()
    await this.ready
    this.requireOwner()
    const settled = Promise.withResolvers<undefined>()
    this.controlSettlements.add(settled.promise)
    try {
      return await this.controlValue(request, kind, operation)
    } finally {
      this.controlSettlements.delete(settled.promise)
      settled.resolve(undefined)
    }
  }

  private async controlValue(
    request: ChatControlRequest, kind: 'pause' | 'resume' | 'stop', operation: (current: () => boolean) => Promise<void>,
  ): Promise<ChatMutationValue> {
    const previous = this.controls.get(request.id)
    if (previous !== undefined && !(kind === 'stop' && previous.kind === 'resume')) {
      throw new RemoteError('gateway/bad-request', 'A group control is already settling', {})
    }
    const token = { kind, settled: false }
    this.controls.set(request.id, token)
    const current = () => this.controls.get(request.id) === token
    this.notify()
    try {
      await operation(current)
      if (!current()) throw new RemoteError('gateway/bad-request', 'This group control was superseded by a later stop', {})
    } catch (error) {
      if (kind === 'stop' && current() && previous?.kind === 'resume' && !previous.settled
        && this.state.chats.find(chat => chat.id === request.id)?.status !== 'stopped') {
        this.controls.set(request.id, previous)
      }
      throw error
    } finally {
      token.settled = true
      if (current()) this.controls.delete(request.id)
      this.notify()
    }
    return { chat: this.chat(request.id), snapshot: this.snapshotValue() }
  }

  /**
   * Request a pause after currently dispatched work without cancelling its result.
   * @param request - group and the exact run generation displayed by the owner.
   * @returns the accepted policy and actual current Agent activity.
   */
  @Remote
  async pause(request: ChatControlRequest): Promise<ChatMutationValue> {
    return this.control(request, 'pause', async () => {
      await this.pauseValue(request.id, 'owner', { runId: request.expectedRunId, generation: request.expectedGeneration })
      await this.runtime.pauseAfterCurrent(request.id)
    })
  }

  /**
   * Grant another dispatch window and explicitly continue a paused or stopped group.
   * @param request - group and the exact run generation displayed by the owner.
   * @returns the committed policy and immediately renderable directory.
   */
  @Remote
  async resume(request: ChatControlRequest): Promise<ChatMutationValue> {
    return this.control(request, 'resume', async (current) => {
      await this.serialize(() => { this.expected(this.chat(request.id),
        { runId: request.expectedRunId, generation: request.expectedGeneration }) })
      await this.runtime.reconcile(request.id)
      await this.serialize(async () => {
        const chat = this.chat(request.id)
        this.expected(chat, { runId: request.expectedRunId, generation: request.expectedGeneration })
        if (this.state.deliveries.some(delivery => delivery.chatId === chat.id && delivery.generation === chat.generation && delivery.state === 'unknown')) {
          throw new RemoteError('gateway/bad-request', 'An earlier member outcome is unknown. Check its saved results and stop that run before starting another.', {})
        }
        await this.replaceChat({ ...chat, status: 'active', pauseReason: null, error: null,
          run: chat.run === null ? null : { ...chat.run, relayCount: 0 } })
      })
      try {
        await this.runtime.resume(request.id)
      } catch (error) {
        await this.serialize(async () => {
          if (!current()) return
          const chat = this.chat(request.id)
          if (chat.status !== 'active') return
          await this.replaceChat({ ...chat, status: 'paused', pauseReason: 'continuation-failed',
            error: { code: 'continuation-failed', message: 'Group continuation did not complete. Check saved member results before trying again.' } })
        })
        throw error
      }
    })
  }

  /**
   * Invalidate this run, cancel only its captured work, and await its owned drivers.
   * @param request - group and the exact run generation displayed by the owner.
   * @returns the stopped policy after cancellation settles.
   */
  @Remote
  async stop(request: ChatControlRequest): Promise<ChatMutationValue> {
    return this.control(request, 'stop', () => this.runtime.stop(request.id,
      { runId: request.expectedRunId, generation: request.expectedGeneration }))
  }

  private async runtimeRead(id: ChatId): Promise<ChatRuntimeSnapshot> {
    const pending = this.state.pendingChat
    const committed = this.state.chats.find(chat => chat.id === id)
    const chat = committed ?? (pending?.kind === 'create' && pending.chat.id === id ? pending.chat : this.chat(id))
    const team = await this.ctx.katcatsTeam.snapshot()
    return { chat, bots: chat.memberIds.flatMap(id => team.bots.filter(bot => bot.id === id)).map(bot => ({ ...bot,
      role: chat.memberRoles.find(member => member.botId === bot.id)?.role ?? bot.role,
    })),
    inbounds: this.state.inbounds.filter(input => input.chatId === id),
    deliveries: this.state.deliveries.filter(delivery => delivery.chatId === id) }
  }

  private async pauseValue(id: ChatId, reason: string, expected?: ChatRuntimeExpected, error?: ChatFailure): Promise<void> {
    await this.serialize(async () => {
      const chat = this.chat(id)
      if (expected !== undefined) this.expected(chat, expected)
      if (chat.status === 'stopped') return
      await this.replaceChat({ ...chat, status: 'paused', pauseReason: reason, ...error === undefined ? {} : { error } })
    })
  }

  private async updateRoles(
    id: ChatId, request: UpdateChatRolesRequest, expected: ChatRuntimeExpected, admit: () => void,
  ): Promise<TeamChat> {
    return this.serialize(async () => {
      admit()
      await this.finishPending()
      admit()
      const chat = this.chat(id)
      this.expected(chat, expected)
      if (this.closing || this.controls.has(id) || chat.status !== 'active') {
        throw new RemoteError('gateway/bad-request', 'Group responsibilities cannot change in this run state', {})
      }
      const changed = this.rolesValue(request.memberRoles ?? [], chat.memberIds)
      const next: TeamChat = { ...chat,
        managerId: request.managerId === undefined ? chat.managerId : this.managerValue(request.managerId, chat.memberIds),
        memberRoles: [...chat.memberRoles.filter(member => !changed.some(value => value.botId === member.botId)), ...changed],
      }
      await this.replaceChat(next)
      return next
    })
  }

  private runtimeActions(): ChatRuntimeActions {
    return {
      recordTicket: (id, request, admit) => this.serialize(async () => {
        admit()
        const delivery = this.delivery(id)
        const chat = this.chat(delivery.chatId)
        this.expected(chat, { runId: delivery.runId, generation: delivery.generation })
        if (this.closing || this.controls.has(chat.id) || chat.status !== 'active' || delivery.state !== 'running') {
          throw new HarnessError('This task is no longer executing.', 'KATCATS_CHAT_TASK_DENIED')
        }
        const input = ticketOwnerInput(this.state.inbounds, this.state.deliveries, delivery)
        if (input === undefined) throw new HarnessError('This execution has no owner request to classify.', 'KATCATS_CHAT_TASK_DENIED')
        const next = recordGroupTicket(chat, input, delivery, request)
        await this.replaceChat(next.chat)
        return next.ticket
      }),
      read: id => this.runtimeRead(id),
      updateRoles: (id, request, expected, admit) => this.updateRoles(id, request, expected, admit),
      beginRun: id => this.serialize(async () => {
        const chat = this.chat(id)
        if (this.closing || chat.status !== 'active') throw new RemoteError('gateway/bad-request', 'This group is not allowed to process messages', {})
        if (chat.run !== null) return chat
        const next = this.startRun(chat)
        await this.replaceChat(next)
        return next
      }),
      advanceOwnerRun: (id, expected) => this.serialize(async () => {
        const chat = this.chat(id)
        if (this.closing || this.controls.has(id) || chat.run === null || chat.run.id !== expected.runId
          || chat.generation !== expected.generation || chat.status !== 'active') return false
        const inputs = this.runInputs(chat)
        const first = inputs[0]
        if (first === undefined || inputs.length < 2) return false
        const deliveries = this.state.deliveries.filter(delivery => delivery.chatId === id
          && delivery.runId === chat.run?.id && delivery.generation === chat.generation)
        if (deliveries.some(delivery => delivery.state === 'unknown' || delivery.takeover?.state === 'pending')
          || deliveries.some(delivery => delivery.state === 'running' || delivery.state === 'accepted')
          || !deliveries.some(delivery => (delivery.state === 'completed' || delivery.state === 'passed')
            && this.ownerMessage(delivery) === first.userMessage.id)) return false
        const queued = inputs.slice(1).filter(input => !deliveries.some(delivery => this.ownerMessage(delivery) === input.userMessage.id))
        if (queued.length === 0) return false
        const next = this.ownerRun(chat, queued)
        await this.commit({ ...this.state, chats: this.state.chats.map(chat => chat.id === id ? next.chat : chat),
          deliveries: next.deliveries, inbounds: next.inbounds })
        return true
      }),
      pause: (id, reason, expected, error) => this.pauseValue(id, reason, expected, error),
      stopped: (id, expected) => this.serialize(async () => {
        const chat = this.chat(id)
        if (expected !== undefined) this.expected(chat, expected)
        const stopped: ChatFailure = { code: 'stopped', message: 'The owner stopped this run before the task was dispatched.' }
        await this.commit({ ...this.state,
          chats: this.state.chats.map(item => item.id === id ? { ...chat, status: 'stopped', pauseReason: 'owner', generation: chat.generation + 1, run: null } : item),
          deliveries: this.state.deliveries.map(delivery => delivery.chatId === id && delivery.generation === chat.generation
            ? { ...delivery, ...(delivery.state === 'accepted' ? { state: 'failed' as const, error: stopped } : {}),
              ...(delivery.takeover?.state === 'pending' ? { takeover: { ...delivery.takeover, state: 'stopped' as const } } : {}) } : delivery),
        })
      }),
      finishRun: (id, runId, generation) => this.serialize(async () => {
        const chat = this.chat(id)
        if (chat.status === 'active' && chat.run?.id === runId && chat.generation === generation
          && !this.state.deliveries.some(delivery => delivery.chatId === id && delivery.runId === runId
            && (delivery.state === 'accepted' || delivery.state === 'running' || delivery.state === 'unknown'
              || delivery.takeover?.state === 'pending'))
          && this.state.inbounds.filter(input => input.chatId === id && input.runId === runId && input.generation === generation)
            .every(input => input.state === 'published' && input.recipients.every(botId => !chat.memberIds.includes(botId)
              || this.state.deliveries.some(delivery => delivery.chatId === id && delivery.botId === botId
                && this.ownerMessage(delivery) === input.userMessage.id)))) {
          await this.replaceChat({ ...chat, run: null })
        }
      }),
      acceptDelivery: (input, admit) => this.acceptDelivery(input, admit),
      markRunning: id => this.markRunning(id),
      completeDelivery: (id, receipt) => this.completeDelivery(id, receipt),
      completePass: (id, pass) => this.completePass(id, pass),
      failDelivery: (id, error, unknown) => this.failDelivery(id, error, unknown),
      notifyActivity: () => { this.notify() },
      markInboundPublished: (chatId, messageId) => this.serialize(async () => {
        const input = this.state.inbounds.find(value => value.chatId === chatId && value.userMessage.id === messageId)
        if (input === undefined) throw new Error('Group transcript publication has no accepted message')
        if (input.state === 'published') return
        await this.commit({ ...this.state, inbounds: this.state.inbounds.map(value => value === input ? { ...input, state: 'published' } : value) })
      }),
      markRelayed: id => this.serialize(async () => {
        const delivery = this.delivery(id)
        if (delivery.state !== 'completed') throw new RemoteError('gateway/bad-request', 'An incomplete group result cannot be logged', {})
        if (delivery.relayed) return
        await this.commit({ ...this.state,
          deliveries: this.state.deliveries.map(item => item.id === id ? { ...delivery, relayed: true } : item) })
      }),
    }
  }

  private ownerMessage(delivery: ChatDelivery): MessageId | undefined {
    if (delivery.source.kind === 'owner-message') return delivery.source.messageId
    if (delivery.source.kind === 'member-reply') {
      const source = delivery.source
      const parent = this.state.deliveries.find(value => value.chatId === delivery.chatId && value.relayMessageId === source.messageId)
      return parent === undefined ? undefined : this.ownerMessage(parent)
    }
    const parentId = delivery.source.parentDeliveryId
    if (parentId === undefined) return undefined
    const parent = this.state.deliveries.find(value => value.id === parentId)
    return parent === undefined ? undefined : this.ownerMessage(parent)
  }

  private async acceptDelivery(input: AcceptChatDelivery, admit?: () => void): Promise<ChatDelivery> {
    return this.serialize(async () => {
      admit?.()
      const chat = this.chat(input.chatId)
      this.expected(chat, { runId: input.runId, generation: input.generation })
      if (this.closing || this.controls.has(chat.id) || chat.status !== 'active' || input.botId === mainBotId
        || !chat.memberIds.includes(input.botId) || input.message.trim().length === 0) {
        throw new RemoteError('gateway/bad-request', 'This group cannot accept the selected member task', {})
      }
      const source = input.source
      const recovery = input.recoveryOf === undefined ? undefined : this.state.deliveries.find(item => item.id === input.recoveryOf)
      if (input.recoveryOf !== undefined && (recovery === undefined || recovery.chatId !== chat.id
        || recovery.runId !== input.runId || recovery.generation !== input.generation || recovery.state !== 'failed'
        || recovery.takeover?.state !== 'pending' || recovery.takeover.botId !== input.botId
        || recovery.recoveryOf !== undefined || source.kind !== 'owner-message'
        || this.ownerMessage(recovery) !== source.messageId)) {
        throw new HarnessError('The confirmed blocker no longer permits this follow-up.', 'KATCATS_CHAT_TASK_DENIED')
      }
      if (source.kind === 'tool') {
        const parent = this.state.deliveries.find(value => value.id === source.parentDeliveryId)
        if (parent === undefined || parent.chatId !== chat.id || parent.runId !== input.runId || parent.generation !== input.generation
          || parent.state !== 'running' || parent.executorSessionId !== input.sourceSessionId) {
          throw new RemoteError('gateway/bad-request', 'Only a currently executing group member can request another member', {})
        }
      } else if (input.sourceSessionId !== chat.rootSessionId
        || (source.kind === 'owner-message' && !this.state.inbounds.some(value => value.chatId === chat.id
          && value.runId === input.runId && value.generation === input.generation && value.state === 'published'
          && value.userMessage.id === source.messageId && (value.recipients.includes(input.botId) || recovery !== undefined)))
        || (source.kind === 'member-reply' && !this.state.deliveries.some(value => value.chatId === chat.id
          && value.runId === input.runId && value.generation === input.generation && value.state === 'completed'
          && value.relayMessageId === source.messageId))) {
        throw new RemoteError('gateway/bad-request', 'The member request has no published group message', {})
      }
      const duplicate = this.state.deliveries.find(delivery => delivery.chatId === input.chatId && delivery.runId === input.runId
        && delivery.generation === input.generation && delivery.sourceSessionId === input.sourceSessionId
        && JSON.stringify(delivery.source) === JSON.stringify(source) && delivery.recoveryOf === input.recoveryOf
        && (source.kind === 'tool' || delivery.botId === input.botId))
      if (duplicate !== undefined) {
        if (duplicate.botId !== input.botId || duplicate.message !== input.message) throw new RemoteError('gateway/bad-request', 'A recorded task cannot be changed during retry', {})
        await this.publishTaskStates([duplicate])
        return duplicate
      }
      const executor = chat.executors.find(executor => executor.botId === input.botId)
      if (executor === undefined) throw new Error('Group member has no execution binding')
      const delivery: ChatDelivery = {
        ...input, id: brandString<ChatDeliveryId>(`delivery-${randomUUID()}`), executorSessionId: executor.sessionId,
        inputMessageId: brandString<MessageId>(`message-${randomUUID()}`), relayMessageId: brandString<MessageId>(`message-${randomUUID()}`),
        state: 'accepted', receipt: null, pass: null, relayed: false, error: null,
      }
      await this.commit({ ...this.state, deliveries: [...this.state.deliveries, delivery] })
      return delivery
    })
  }

  private async markRunning(id: ChatDeliveryId): Promise<ChatDelivery> {
    return this.serialize(async () => {
      const delivery = this.delivery(id)
      const chat = this.chat(delivery.chatId)
      this.expected(chat, { runId: delivery.runId, generation: delivery.generation })
      if (this.closing || chat.status !== 'active' || delivery.state !== 'accepted' || !chat.memberIds.includes(delivery.botId) || chat.run === null) {
        throw new RemoteError('gateway/bad-request', 'This member task cannot start in the current group state', {})
      }
      if (this.state.deliveries.some(item => item.executorSessionId === delivery.executorSessionId && item.state === 'running')) {
        throw new RemoteError('gateway/bad-request', 'This group member must finish its current task before another task starts', {})
      }
      if (chat.run.relayCount >= chat.relayLimit) {
        await this.replaceChat({ ...chat, status: 'paused', pauseReason: 'relay-limit' })
        throw new RemoteError('gateway/bad-request', 'Group relay limit reached. Continue explicitly to grant another dispatch window.', {})
      }
      const running: ChatDelivery = { ...delivery, state: 'running' }
      const run = { ...chat.run, relayCount: chat.run.relayCount + 1 }
      await this.commit({ ...this.state,
        chats: this.state.chats.map(item => item.id === chat.id ? { ...chat, run } : item),
        deliveries: this.state.deliveries.map(item => item.id === id ? running : item),
      })
      return running
    })
  }

  private async completeDelivery(id: ChatDeliveryId, receipt: ChatReceipt): Promise<ChatDelivery> {
    return this.serialize(async () => {
      const delivery = this.delivery(id)
      if (receipt.sender.botId !== delivery.botId) throw new Error('Group result sender differs from its dispatched member')
      if (delivery.state === 'completed') {
        if (delivery.receipt?.outputMessageId !== receipt.outputMessageId) throw new Error('Group task has conflicting completed results')
        return delivery
      }
      if (delivery.state !== 'running' && delivery.state !== 'unknown') throw new Error('Group task has no dispatched result to complete')
      const completed: ChatDelivery = { ...delivery, state: 'completed', receipt, error: null }
      await this.commit({ ...this.state, deliveries: this.handledTakeovers(delivery)
        .map(item => item.id === id ? completed : item) })
      return completed
    })
  }

  private async completePass(id: ChatDeliveryId, pass: ChatPass): Promise<ChatDelivery> {
    return this.serialize(async () => {
      const delivery = this.delivery(id)
      if (delivery.state === 'passed') {
        if (JSON.stringify(delivery.pass) !== JSON.stringify(pass)) throw new Error('Group member has conflicting pass results')
        return delivery
      }
      if (delivery.state !== 'running' && delivery.state !== 'unknown') throw new Error('Only a dispatched member can pass its turn')
      const passed: ChatDelivery = { ...delivery, state: 'passed', pass, error: null }
      await this.commit({ ...this.state, deliveries: this.state.deliveries.map(value => value.id === id ? passed : value) })
      return passed
    })
  }

  private async failDelivery(id: ChatDeliveryId, error: ChatFailure, unknown: boolean): Promise<void> {
    await this.serialize(async () => {
      const delivery = this.delivery(id)
      if (delivery.state === 'completed' || delivery.state === 'passed') return
      const chat = this.chat(delivery.chatId)
      const current = chat.run?.id === delivery.runId && chat.generation === delivery.generation && chat.status !== 'stopped'
      const ownerId = this.ownerMessage(delivery)
      const modern = this.state.inbounds.some(input => input.chatId === chat.id
        && input.userMessage.id === ownerId && input.collaborationVersion === 1)
      const reportable = modern && !unknown && error.code !== 'KATCATS_CHAT_DURABILITY_UNCONFIRMED'
        && (delivery.source.kind === 'tool' || error.code === 'KATCATS_CHAT_TASK_BLOCKED')
      const input = ticketOwnerInput(this.state.inbounds, this.state.deliveries, delivery)
      const ticket = ticketForInput(chat, input)
      const responsible = [ticket?.ownerId === delivery.botId ? undefined : ticket?.ownerId, chat.managerId, ...chat.memberIds]
        .find(member => member !== undefined && member !== null && member !== mainBotId && chat.memberIds.includes(member))
      const takeover = current && input?.coordinationVersion === 1 && reportable && delivery.recoveryOf === undefined
        && responsible !== undefined && responsible !== null && responsible !== delivery.botId
        ? { version: 1 as const, botId: responsible, state: 'pending' as const } : delivery.takeover
      const nextChat = ticket === undefined ? chat : { ...chat, tickets: (chat.tickets ?? []).map(task => task.id === ticket.id
        ? { ...task, state: 'blocked' as const, blocker: error.message, revision: task.revision + 1 } : task) }
      const records = !unknown && error.code === 'KATCATS_CHAT_TASK_BLOCKED' ? this.handledTakeovers(delivery) : this.state.deliveries
      await this.commit({ ...this.state,
        deliveries: records.map(item => item.id === id ? { ...delivery, state: unknown ? 'unknown' : 'failed', error,
          ...(takeover === undefined ? {} : { takeover }) } : item),
        chats: this.state.chats.map(item => item.id !== chat.id ? item : current && (!reportable
          || delivery.recoveryOf !== undefined && error.code !== 'KATCATS_CHAT_TASK_BLOCKED')
          ? { ...nextChat, status: 'paused', pauseReason: unknown ? 'unknown-result' : 'member-failed', error } : nextChat),
      })
    })
  }

  private handledTakeovers(delivery: ChatDelivery): readonly ChatDelivery[] {
    const owner = this.ownerMessage(delivery)
    return this.state.deliveries.map(item => item.chatId === delivery.chatId && item.runId === delivery.runId
      && item.takeover?.state === 'pending' && item.takeover.botId === delivery.botId
      && (item.id === delivery.recoveryOf || owner !== undefined && this.ownerMessage(item) === owner)
      ? { ...item, takeover: { ...item.takeover, state: 'handled' } } : item)
  }
}

export default KatcatsChats
