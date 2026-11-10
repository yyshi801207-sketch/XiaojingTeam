/** Katcats member directory and private conversations over public DSH services. */
import { isAbsolute, join, resolve } from 'node:path'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { principalOf, Remote, RemoteError, remoteErrorOf, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type {} from '@deepseek-ai/dsh-workspace'
import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import {
  avatarSchema, chatGroupId, mainBotId, ordinaryGroupId, teamDomainSpec,
  type TeamState,
} from './storage.ts'
import type {
  BotId, BotModel, BotMutationValue, CreateBotRequest, CreateGroupRequest, DeleteBotRequest, GroupId,
  GroupMutationValue, MoveGroupRequest, RemoveGroupRequest, TeamBot, TeamFrame, TeamGroup,
  TeamSnapshot, UpdateBotRequest, UpdateGroupRequest,
} from './types.ts'
import { memberToolGuidance, registerMemberTools } from './tools.ts'
import { resolveBotModel } from './model-policy.ts'
import { archiveOwnedSessions, GroupOrganization, requireInactiveSessions } from './group-organization.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Product member directory; logical groups do not own filesystem workspaces. */
    katcatsTeam: KatcatsTeam
  }
}

/** Deployment-owned locations and first-use member labels. */
export interface Config {
  /** Absolute root containing the team's default Bot working directories. */
  readonly workspaceRoot: string
  /** Initial main Bot name; the current product default also replaces the previous default at startup. */
  readonly mainName: string
  /** Initial saved responsibility of the main Bot. */
  readonly mainRole: string
  /** Initial label of the built-in ordinary Bot group. */
  readonly ordinaryGroupName: string
  /** Initial label of the built-in group chat section. */
  readonly chatGroupName: string
}

/** Team metadata and private Sessions, with durable interrupted-creation recovery. */
export class KatcatsTeam extends TypertRemoteService {
  static inject = ['storageDomain', 'sessionController', 'sessionTitle', 'sessionPersistence', 'agents', 'sessions', 'systemPrompt', 'workspaceRegistry', 'tools', 'agentDefaultModel']
  static Config: z<Config> = z.object({
    workspaceRoot: z.string().required(),
    mainName: z.string().default('小兢会计'),
    mainRole: z.string().default('Bot 创建助手：根据用户需求创建和配置 Bot。'),
    ordinaryGroupName: z.string().default('普通 Bot'),
    chatGroupName: z.string().default('群聊'),
  })

  private readonly ready: Promise<void>
  private readonly workspaceRoot: string
  private domain: Domain<typeof teamDomainSpec> | undefined
  private tail: Promise<void> = Promise.resolve()
  /** Product mutation ordering shared with the group directory; never acquired by snapshots. */
  readonly organization: GroupOrganization = new GroupOrganization()
  private readonly initializedAgents = new Map<Agent, () => void | Promise<void>>()
  private readonly deletingBots = new Set<BotId>()
  private readonly followers = new Set<() => void>()
  private closing = false

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'katcatsTeam')
    if (!isAbsolute(config.workspaceRoot)) throw new Error('katcats-team workspaceRoot must be absolute')
    this.workspaceRoot = resolve(config.workspaceRoot)
    ctx.on('agent/created', ({ agent }) => {
      this.installIdentity(agent)
    })
    this.ready = this.initialize()
    ctx.effect(() => async () => {
      this.closing = true
      this.notify()
      // Activation already reports a rejected ready promise; teardown still releases its domain.
      await this.ready.catch(() => {})
      await this.organization.run(async () => {})
      await this.tail
      await this.domain?.close()
    })
  }

  /** Wait for the member directory before publishing the service to dependent plugins. */
  protected [Service.init](): Promise<void> {
    return this.ready
  }

  private async initialize(): Promise<void> {
    this.domain = await this.ctx.storageDomain.open(teamDomainSpec)
    const members = this.state.pendingBot === null ? this.state.bots : [...this.state.bots, this.state.pendingBot]
    for (const bot of members) {
      if (resolve(bot.workDir) !== join(this.workspaceRoot, 'bots', bot.id)) {
        throw new Error('Katcats member working directory is outside its assigned location')
      }
      await this.ensureWorkDir(bot)
      if (this.state.bots.some(member => member.id === bot.id)) {
        const workspace = await this.ctx.workspaceRegistry.create(bot.workDir, bot.name)
        await workspace.attachSession(bot.sessionId)
      }
    }
    for (const agent of this.ctx.agents.list()) this.installIdentity(agent)
    await this.serialize(async () => {
      await this.finishPending()
      await this.finishPendingRename()
      const main = this.state.bots.find(bot => bot.id === mainBotId)
      if (main !== undefined) {
        if (main.name === 'Katcats' && this.config.mainName === '小兢会计') {
          await this.commit({ ...this.state, pendingRename: { ...main, name: this.config.mainName } })
          await this.finishPendingRename()
        }
        return
      }
      const groups: readonly TeamGroup[] = [
        { id: ordinaryGroupId, name: this.config.ordinaryGroupName, kind: 'bots', system: true },
        { id: chatGroupId, name: this.config.chatGroupName, kind: 'chats', system: true },
      ]
      const bot = this.newBot(mainBotId, 'main', this.config.mainName, null, this.config.mainRole)
      await this.commit({ ...this.state, groups, pendingBot: bot })
      await this.finishPending()
    })
  }

  private get state(): TeamState {
    if (this.domain === undefined) throw new Error('katcats-team has not opened its member directory')
    return this.domain.global.get()
  }

  private async commit(next: TeamState): Promise<void> {
    if (this.domain === undefined) throw new Error('katcats-team has not opened its member directory')
    await this.domain.global.set({ ...next, revision: this.state.revision + 1 })
    this.notify()
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => {
      if (this.closing) throw new RemoteError('gateway/internal', 'Katcats member directory is closing', {})
      return operation()
    })
    this.tail = result.then(() => {}, () => {})
    return result
  }

  private notify(): void {
    for (const wake of this.followers) wake()
  }

  private requireOwner(): void {
    const invocation = this.ctx.invocation
    if (invocation !== undefined && principalOf(invocation) !== undefined) {
      throw new RemoteError('remote-access/denied', 'Only the owner can manage the Katcats team', {
        action: `${invocation.request.namespace}/${invocation.request.method}`,
        reason: 'owner-required',
      })
    }
  }

  private snapshotValue(): TeamSnapshot {
    return {
      revision: this.state.revision,
      mainBotId,
      groups: this.state.groups,
      bots: this.state.bots,
      modelCapabilities: { override: true, followGlobal: true },
    }
  }

  /**
   * Read the complete product directory, finishing accepted creation and Session-setting intents first.
   * @returns the persisted member and group snapshot.
   */
  @Remote
  async snapshot(): Promise<TeamSnapshot> {
    this.requireOwner()
    return this.readSnapshot()
  }

  private async readSnapshot(signal?: AbortSignal, authorize?: () => void): Promise<TeamSnapshot> {
    await this.ready
    return this.serialize(async () => {
      signal?.throwIfAborted()
      authorize?.()
      await this.finishPendingRename()
      await this.finishPending()
      return this.snapshotValue()
    })
  }

  /**
   * Follow complete durable directory replacements, starting with a baseline.
   * @param signal - caller-owned stream cancellation.
   * @returns one baseline and later committed snapshots until cancellation.
   */
  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<TeamFrame> {
    this.requireOwner()
    await this.ready
    await this.serialize(async () => {
      await this.finishPendingRename()
      await this.finishPending()
    })
    let revision = -1
    while (!signal.aborted && !this.closing) {
      if (revision !== this.state.revision) {
        const value = this.snapshotValue()
        const type = revision === -1 ? 'snapshot' : 'replace'
        revision = value.revision
        yield { type, value }
        continue
      }
      const pending = Promise.withResolvers<void>()
      const wake = () => { pending.resolve() }
      this.followers.add(wake)
      signal.addEventListener('abort', wake, { once: true })
      try {
        await pending.promise
      } finally {
        this.followers.delete(wake)
        signal.removeEventListener('abort', wake)
      }
    }
  }

  private newBot(id: BotId, kind: TeamBot['kind'], name: string, groupId: GroupId | null, role = ''): TeamBot {
    return {
      id, kind, name: this.nameValue(name), role,
      avatar: { shape: 'classic', color: '#FF2849' },
      model: { kind: 'follow-global' },
      workDir: join(this.workspaceRoot, 'bots', id), groupId,
      sessionId: brandString<SessionId>(`session-${randomUUID()}`),
    }
  }

  private nameValue(value: string): string {
    const name = value.trim()
    if (name.length === 0) throw new RemoteError('gateway/bad-request', 'A non-empty name is required', {})
    return name
  }

  private ordinaryGroup(id: GroupId): TeamGroup {
    const group = this.state.groups.find(item => item.id === id)
    if (group?.kind !== 'bots') throw new RemoteError('gateway/bad-request', 'Choose an ordinary Bot group', {})
    return group
  }

  private async finishPending(): Promise<TeamBot | undefined> {
    const bot = this.state.pendingBot
    if (bot === null) return undefined
    await this.ensureWorkDir(bot)
    const workspace = await this.ctx.workspaceRegistry.create(bot.workDir, bot.name)
    const resumed = await this.ctx.sessionController.resolveAgent(bot.sessionId)
    if ('error' in resumed) {
      if (resumed.error.code !== 'session/not-found') throw resumed.error
      const created = await this.ctx.sessionController.create({ sessionId: bot.sessionId, workspaceId: workspace.id })
      if (created.sessionId !== bot.sessionId) throw new Error('Katcats private Session identity was not retained')
    }
    const agent = this.ctx.agents.get(bot.sessionId)
    if (agent === undefined) throw new Error('Katcats private Agent was not published')
    this.installIdentity(agent)
    const cwd = agent.session.header.cwd
    if (cwd === undefined || await realpath(cwd) !== workspace.path) throw new Error('Katcats private Session working directory does not match its member')
    await workspace.attachSession(bot.sessionId)
    await this.ctx.sessionController.rename({ sessionId: bot.sessionId, title: bot.name })
    if (!await this.ctx.sessions.flush(agent.session)) throw new Error('Katcats private Session has no durability owner')
    const index = bot.kind === 'main' ? 0 : this.state.bots.findIndex(member => member.kind === 'main') + 1
    await this.commit({ ...this.state, bots: [...this.state.bots.slice(0, index), bot, ...this.state.bots.slice(index)], pendingBot: null })
    return bot
  }

  private async renameSession(bot: TeamBot): Promise<void> {
    await this.ctx.sessionController.rename({ sessionId: bot.sessionId, title: bot.name })
    const agent = this.ctx.agents.get(bot.sessionId)
    if (agent === undefined || !await this.ctx.sessions.flush(agent.session)) {
      throw new Error('Katcats renamed private Session has no durability owner')
    }
  }

  private async finishPendingRename(): Promise<void> {
    const next = this.state.pendingRename
    if (next === null) return
    const previous = this.state.bots.find(bot => bot.id === next.id)
    if (previous === undefined) throw new Error('Katcats pending rename has no member')
    const modelChanged = !this.sameModel(previous.model, next.model)
    if (modelChanged) {
      const selection = resolveBotModel(next.model, () => this.ctx.agentDefaultModel.currentSelection())
      const resolved = await this.ctx.sessionController.resolveAgent(next.sessionId)
      if ('error' in resolved) throw resolved.error
      const beforeSeq = resolved.agent.session.seq
      let accepted = false
      try {
        const { selected } = await this.ctx.sessionController.selectModel({
          sessionId: next.sessionId, ...selection,
          scope: 'session',
        })
        accepted = true
        const completed: TeamBot = { ...next, model: next.model.kind === 'override'
          ? { kind: 'override', ...selected } : { kind: 'follow-global' } }
        await this.renameSession(completed)
        await this.commit({
          ...this.state,
          bots: this.state.bots.map(bot => bot.id === completed.id ? completed : bot),
          pendingRename: null,
        })
      } catch (error) {
        if (!accepted && resolved.agent.session.seq === beforeSeq
          && remoteErrorOf(error)?.code === 'session/model-unavailable') {
          await this.commit({ ...this.state, pendingRename: null })
          throw error
        }
        throw new RemoteError('gateway/internal', 'Bot settings are incomplete; reopen the team to recover the saved change', {}, { cause: error })
      }
      return
    }
    try {
      await this.renameSession(next)
      await this.commit({
        ...this.state,
        bots: this.state.bots.map(bot => bot.id === next.id ? next : bot),
        pendingRename: null,
      })
    } catch (error) {
      try {
        await this.renameSession(previous)
      } catch (rollbackError) {
        throw new RemoteError('gateway/internal', 'Bot rename is incomplete; reopen the team to recover its saved change', {}, { cause: rollbackError })
      }
      throw error
    }
  }

  private sameModel(left: BotModel, right: BotModel): boolean {
    return left.kind === 'follow-global'
      ? right.kind === 'follow-global'
      : right.kind === 'override' && left.provider === right.provider && left.model === right.model
        && left.reasoningEffort === right.reasoningEffort
  }

  private async ensureWorkDir(bot: TeamBot): Promise<void> {
    for (const path of [this.workspaceRoot, join(this.workspaceRoot, 'bots'), bot.workDir]) {
      try {
        await mkdir(path)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      }
      const entry = await lstat(path)
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new RemoteError('gateway/bad-request', 'A member directory must be a real directory without redirected links', {})
      }
    }
  }

  /**
   * Read the current owner of a private Session without entering the mutation queue.
   * @param sessionId - private Session identity to match, including pending creation.
   * @returns the persisted member, or undefined for a Session outside the private directory.
   */
  memberForSession(sessionId: SessionId): TeamBot | undefined {
    if (this.domain === undefined) return undefined
    return this.state.bots.find(bot => bot.sessionId === sessionId)
      ?? (this.state.pendingBot?.sessionId === sessionId ? this.state.pendingBot : undefined)
  }

  /**
   * Resolve one member's committed model policy without entering the mutation queue.
   * Pending creation is visible; an incomplete setting target retains its previous policy.
   * @param botId - member whose private or group task is being admitted.
   * @returns the current base for followers, or the member's explicit fixed route.
   */
  modelSelection(botId: BotId): ModelSelection {
    const bot = this.state.bots.find(member => member.id === botId)
      ?? (this.state.pendingBot?.id === botId ? this.state.pendingBot : undefined)
    if (bot === undefined || this.closing) throw new RemoteError('gateway/bad-request', 'Member model policy is unavailable', {})
    return resolveBotModel(bot.model, () => this.ctx.agentDefaultModel.currentSelection())
  }

  private installIdentity(agent: Agent): void {
    const member = this.memberForSession(agent.id)
    if (member === undefined || this.initializedAgents.has(agent)) return
    const dispose = this.ctx.effect(function* (this: KatcatsTeam) {
      yield agent.ctx.on('agent/disposed', () => { this.initializedAgents.delete(agent) })
      yield agent.ctx.on('api-session/prompt-model', (_subject, next) => {
        next()
        if (this.deletingBots.has(member.id)) throw new HarnessError('This Bot is being deleted.', 'KATCATS_BOT_DELETING')
        return this.modelSelection(member.id)
      })
      yield agent.ctx.on('agent/pre-step', (payload, next) => {
        if (!this.deletingBots.has(member.id)) return next()
        for (const message of [...payload.messages].reverse()) agent.inbox.prepend('next-step', message)
        return Promise.resolve({ kind: 'reject' })
      })
      yield agent.ctx.systemPrompt.section({
        name: PERSONA_PREFIX_SECTION,
        order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
        interpolate: false,
        text: () => {
          const bot = this.memberForSession(agent.id)
          if (bot === undefined) throw new Error('Katcats member identity is unavailable')
          const scope = bot.kind === 'main'
            ? '\nYour product scope is creating and configuring Bots and, when create_group_chat is available, creating requested group chats from saved members. You remain outside the group. Group work is coordinated by its ordinary members, not by this private creation assistant. Claim creation only after the corresponding tool confirms it. These limits take precedence over a saved role that describes broader coordination.'
            : ''
          return `You are ${bot.name}, a member of 瑞华云财务共享团队.\n${bot.role || 'You are a general assistant. Work with the user to establish your role.'}${scope}\nWhen introducing yourself, use the exact team name 瑞华云财务共享团队, even if earlier conversation mentions an old product name.\n\n${memberToolGuidance(bot.kind)}`
        },
      })
      const authorize = (exec: ToolRunContext, mainOnly: boolean) => () => {
        this.requireToolAgent(agent, exec.agent, mainOnly)
      }
      yield registerMemberTools(agent, member.kind, {
        create: async (request, role, exec) => (await this.createMember(request, role, exec.signal, authorize(exec, true))).bot,
        list: exec => this.readSnapshot(exec.signal, authorize(exec, true)),
        setRole: async (role, exec) => (await this.updateMember({ id: member.id, role }, exec.signal, authorize(exec, false))).bot,
        setAppearance: async (id, avatar, exec) => (await this.updateMember({ id, avatar }, exec.signal, authorize(exec, true))).bot,
      })
      yield () => { this.initializedAgents.delete(agent) }
    }.bind(this), 'katcats-team.memberIdentity()')
    this.initializedAgents.set(agent, dispose)
  }

  private requireToolAgent(owner: Agent, caller: Agent | undefined, mainOnly: boolean): void {
    const member = this.state.bots.find(bot => bot.sessionId === owner.id)
    if (caller !== owner || this.ctx.agents.get(owner.id) !== owner || member === undefined
      || (mainOnly && member.kind !== 'main')) {
      throw new HarnessError('This tool is not authorized for the executing member.', 'KATCATS_TOOL_DENIED')
    }
  }

  /**
   * Create a general member and a durable ordinary private Session.
   * New members precede existing ordinary members; an omitted group uses 未分组.
   * A retry matching a still-pending name, group, avatar, and empty role returns that recovered member.
   * @param request - member name, optional explicit group, and optional approved avatar.
   * @returns the committed member and replacement snapshot.
   */
  @Remote
  async createBot(request: CreateBotRequest): Promise<BotMutationValue> {
    this.requireOwner()
    return this.createMember(request, '')
  }

  private async createMember(
    request: CreateBotRequest, role: string, signal?: AbortSignal, authorize?: () => void,
  ): Promise<BotMutationValue> {
    await this.ready
    return this.serialize(async () => {
      signal?.throwIfAborted()
      authorize?.()
      await this.finishPendingRename()
      const groupId = request.groupId ?? ordinaryGroupId
      this.ordinaryGroup(groupId)
      const name = this.nameValue(request.name)
      const avatar = this.avatarValue(request.avatar ?? { shape: 'classic', color: '#FF2849' })
      const pending = this.state.pendingBot
      const retry = pending?.kind === 'ordinary' && pending.name === name && pending.groupId === groupId && pending.role === role
        && pending.avatar.shape === avatar.shape && pending.avatar.color.toLowerCase() === avatar.color.toLowerCase()
      const recovered = await this.finishPending()
      if (retry && recovered !== undefined) return { bot: recovered, snapshot: this.snapshotValue() }
      const bot = {
        ...this.newBot(brandString<BotId>(`bot-${randomUUID()}`), 'ordinary', name, groupId, role),
        avatar,
      }
      signal?.throwIfAborted()
      authorize?.()
      await this.commit({ ...this.state, pendingBot: bot })
      await this.finishPending()
      return { bot, snapshot: this.snapshotValue() }
    })
  }

  private avatarValue(avatar: TeamBot['avatar']): TeamBot['avatar'] {
    const parsed = avatarSchema.safeParse(avatar)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', 'Choose a silhouette avatar and a six-digit color', {})
    return parsed.data
  }

  /**
   * Update member settings and synchronize title or model policy changes with the private Session.
   * Refused model input is discarded; an accepted or uncertain switch retains its target until both stores commit.
   * Pure title failures restore the old title when possible and retain their target for recovery.
   * @param request - member identity and explicit fields to replace.
   * @returns the committed member and replacement snapshot.
   */
  @Remote
  async updateBot(request: UpdateBotRequest): Promise<BotMutationValue> {
    this.requireOwner()
    return this.updateMember(request)
  }

  /**
   * Remove an idle, unreferenced ordinary Bot while retaining its Session and files.
   * @param request - ordinary Bot identity; main Bots, group members and active tasks reject.
   * @returns the replacement member directory after archival and durable removal.
   */
  @Remote
  async deleteBot(request: DeleteBotRequest): Promise<TeamSnapshot> {
    this.requireOwner()
    await this.ready
    return this.organization.run(async () => {
      const memberships = await this.organization.chats.memberships(request.id)
      return this.serialize(async () => {
        await this.finishPendingRename()
        await this.finishPending()
        const bot = this.state.bots.find(item => item.id === request.id)
        if (bot === undefined) throw new RemoteError('katcats/organization', 'Bot no longer exists.', { reason: 'bot-not-found' })
        if (bot.kind === 'main') throw new RemoteError('katcats/organization', 'The main Bot cannot be deleted.', { reason: 'bot-main' })
        if (memberships.length > 0) throw new RemoteError('katcats/organization', 'Remove this Bot from its groups before deleting it. A group must retain at least one member.', { reason: 'bot-in-group' })
        const idle = () => {
          const agent = this.ctx.agents.get(bot.sessionId)
          if (agent !== undefined && (agent.status === 'running' || agent.inbox.nextStep.length > 0 || agent.inbox.nextTurn.length > 0)) {
            throw new RemoteError('katcats/organization', 'Wait for this Bot to finish and clear its pending messages before deleting it.', { reason: 'bot-running' })
          }
        }
        idle()
        this.deletingBots.add(bot.id)
        try {
          await requireInactiveSessions(this.ctx, [bot.sessionId])
          const rollback = await archiveOwnedSessions(this.ctx, [bot.sessionId])
          try {
            idle()
            await this.commit({ ...this.state, bots: this.state.bots.filter(item => item.id !== bot.id) })
          } catch (error) {
            try { await rollback() } catch (rollbackError) {
              throw new RemoteError('katcats/organization', 'Bot deletion is incomplete. Its record and history are retained; reopen the team before retrying.', { reason: 'delete-incomplete' }, { cause: rollbackError })
            }
            throw error
          }
          for (const [agent, dispose] of this.initializedAgents) if (agent.id === bot.sessionId) await dispose()
          return this.snapshotValue()
        } finally { this.deletingBots.delete(bot.id) }
      })
    })
  }

  private async updateMember(
    request: UpdateBotRequest, signal?: AbortSignal, authorize?: () => void,
  ): Promise<BotMutationValue> {
    await this.ready
    return this.serialize(async () => {
      signal?.throwIfAborted()
      authorize?.()
      await this.finishPendingRename()
      await this.finishPending()
      const previous = this.state.bots.find(bot => bot.id === request.id)
      if (previous === undefined) throw new RemoteError('gateway/bad-request', 'Member does not exist', {})
      if (request.groupId !== undefined) {
        if (previous.kind === 'main') throw new RemoteError('gateway/bad-request', 'The main Bot stays above the groups', {})
        this.ordinaryGroup(request.groupId)
      }
      const bot: TeamBot = {
        ...previous,
        ...(request.name === undefined ? {} : { name: this.nameValue(request.name) }),
        ...(request.role === undefined ? {} : { role: request.role }),
        ...(request.avatar === undefined ? {} : { avatar: this.avatarValue(request.avatar) }),
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.groupId === undefined ? {} : { groupId: request.groupId }),
      }
      signal?.throwIfAborted()
      authorize?.()
      if (bot.name === previous.name && this.sameModel(bot.model, previous.model)) {
        await this.commit({ ...this.state, bots: this.state.bots.map(item => item.id === bot.id ? bot : item) })
      } else {
        await this.commit({ ...this.state, pendingRename: bot })
        await this.finishPendingRename()
      }
      const committed = this.state.bots.find(item => item.id === bot.id)
      if (committed === undefined) throw new Error('Katcats committed member is unavailable')
      return { bot: committed, snapshot: this.snapshotValue() }
    })
  }

  /**
   * Create a logical group before existing custom groups, retaining system-group order.
   * @param request - non-empty group name.
   * @returns the committed group and replacement snapshot.
   */
  @Remote
  async createGroup(request: CreateGroupRequest): Promise<GroupMutationValue> {
    this.requireOwner()
    await this.ready
    return this.serialize(async () => {
      await this.finishPendingRename()
      await this.finishPending()
      const group: TeamGroup = { id: brandString<GroupId>(`group-${randomUUID()}`), name: this.nameValue(request.name), kind: 'bots', system: false }
      const firstCustom = this.state.groups.findIndex(item => !item.system)
      const index = firstCustom === -1 ? this.state.groups.length : firstCustom
      await this.commit({ ...this.state, groups: [...this.state.groups.slice(0, index), group, ...this.state.groups.slice(index)] })
      return { group, snapshot: this.snapshotValue() }
    })
  }

  /**
   * Rename an ordinary user-created group.
   * @param request - group identity and replacement name.
   * @returns the committed group and replacement snapshot.
   */
  @Remote
  async updateGroup(request: UpdateGroupRequest): Promise<GroupMutationValue> {
    this.requireOwner()
    await this.ready
    return this.serialize(async () => {
      await this.finishPendingRename()
      await this.finishPending()
      const previous = this.ordinaryGroup(request.id)
      if (previous.system) throw new RemoteError('gateway/bad-request', 'System groups cannot be renamed', {})
      const group = { ...previous, name: this.nameValue(request.name) }
      await this.commit({ ...this.state, groups: this.state.groups.map(item => item.id === group.id ? group : item) })
      return { group, snapshot: this.snapshotValue() }
    })
  }

  /**
   * Move one custom group within the saved custom-group order; system group positions remain unchanged.
   * @param request - group identity and one adjacent position to move.
   * @returns the committed directory; rejects system groups and moves beyond either end.
   */
  @Remote
  async moveGroup(request: MoveGroupRequest): Promise<TeamSnapshot> {
    this.requireOwner()
    await this.ready
    return this.serialize(async () => {
      await this.finishPendingRename()
      await this.finishPending()
      const group = this.ordinaryGroup(request.id)
      if (group.system) throw new RemoteError('gateway/bad-request', 'System groups cannot be moved', {})
      const custom = this.state.groups.filter(item => item.kind === 'bots' && !item.system)
      const index = custom.findIndex(item => item.id === group.id)
      const target = custom[index + (request.direction === 'up' ? -1 : 1)]
      if (target === undefined) throw new RemoteError('gateway/bad-request', 'The group is already at the end of the custom-group order', {})
      await this.commit({ ...this.state,
        groups: this.state.groups.map(item => item.id === group.id ? target : item.id === target.id ? group : item),
      })
      return this.snapshotValue()
    })
  }

  /**
   * Move chats to their system group before removing a custom group and moving its Bots.
   * The two durable writes preserve valid references if interrupted and can be retried.
   * Member identities, private Sessions and files remain unchanged.
   * @param request - group identity to remove.
   * @returns the replacement directory snapshot.
   */
  @Remote
  async removeGroup(request: RemoveGroupRequest): Promise<TeamSnapshot> {
    this.requireOwner()
    await this.ready
    return this.organization.run(async () => {
      await this.serialize(async () => {
        await this.finishPendingRename()
        await this.finishPending()
        const group = this.ordinaryGroup(request.id)
        if (group.system) throw new RemoteError('gateway/bad-request', 'System groups cannot be removed', {})
      })
      await this.organization.chats.moveGroup(request.id)
      return this.serialize(async () => {
        await this.finishPendingRename()
        await this.finishPending()
        const group = this.ordinaryGroup(request.id)
        if (group.system) throw new RemoteError('gateway/bad-request', 'System groups cannot be removed', {})
        await this.commit({ ...this.state,
          groups: this.state.groups.filter(item => item.id !== group.id),
          bots: this.state.bots.map(bot => bot.groupId === group.id ? { ...bot, groupId: ordinaryGroupId } : bot),
        })
        return this.snapshotValue()
      })
    })
  }
}

export default KatcatsTeam

export { KatcatsChats } from './chats.ts'
export { KatcatsMemory } from './memory.ts'
