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
  BotId, BotModel, BotMutationValue, CreateBotRequest, CreateGroupRequest, DeleteBotRequest, FinanceBotPreset, GroupId,
  GroupMutationValue, MoveGroupRequest, RemoveGroupRequest, TeamBot, TeamFrame, TeamGroup,
  TeamSnapshot, UpdateBotRequest, UpdateGroupRequest,
} from './types.ts'
import { memberToolGuidance, registerMemberTools } from './tools.ts'
import { financeTeamPositions, type FinanceTeamTemplate } from './finance-team-templates.ts'
import { AVATAR_COLORS } from './avatar-palette.ts'
import { isOdooAdminBot, ledgerSetupBotId, odooAccessBotId } from './types.ts'
import { ledgerSetupRole, odooAccessRole } from './finance-setup-tools.ts'
import { resolveBotModel } from './model-policy.ts'
import { FinanceConnections, financeRemoteError } from './finance-connectors.ts'
import { createFinanceQueryTool } from './finance-query-tool.ts'
import { registerFinanceExportTool } from './finance-export-tool.ts'
import { createFinanceOrmTool } from './finance-orm-tool.ts'
import type {
  FinanceCompany, FinanceConnectionDraft, FinanceConnector, FinanceConnectorId, FinanceConnectorSnapshot,
  SaveFinanceConnectorRequest,
} from './finance-types.ts'
import { archiveOwnedSessions, GroupOrganization, requireInactiveSessions } from './group-organization.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Product member directory; logical groups do not own filesystem workspaces. */
    katcatsTeam: KatcatsTeam
  }
}

const FINANCE_ROLES: Readonly<Record<FinanceBotPreset, string>> = {
  cashier: '财务专用出纳：负责日记账、资金往来、凭证和收付款核对，说明记录范围与状态。',
  'general-ledger': '总账会计：负责会计科目、凭证、分录和往来核对，说明过账状态与借贷发生额。',
  reporting: '报表会计：负责核对报表、凭证、分录和科目发生额，说明取数期间与口径。',
  tax: '税务会计：负责核对涉税凭证、分录及相关科目发生额。',
  cost: '成本会计：负责成本相关科目、凭证和分录，核对归集期间与发生额。',
  audit: '审核专员：负责核验凭证、科目、分录和过账状态，说明核验发现。',
  analysis: '财务分析师：解释凭证和科目发生额，注明数据范围与分析依据。',
  documents: '票据专员：负责票据和凭证，核对引用、分录及相关记录。',
}

const odooAdminBots = [
  { id: ledgerSetupBotId, name: '建账助手', role: ledgerSetupRole, avatar: { shape: 'round', color: '#12A489' } },
  { id: odooAccessBotId, name: '系统助手', role: odooAccessRole, avatar: { shape: 'wave', color: '#F47A12' } },
] as const

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
  /** Enable finance connectors in this product deployment. */
  readonly financeConnectors?: boolean
  /** Time budget for one Odoo JSON-2 request. */
  readonly financeRequestTimeoutMs?: number
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
    financeConnectors: z.boolean().default(false),
    financeRequestTimeoutMs: z.natural().min(1).max(120000).default(10000),
  })

  /** Optional product finance connectors and group bindings. */
  readonly finance: FinanceConnections | undefined
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
    if (config.financeConnectors) {
      const credentials = ctx.get('credentials')
      if (!credentials) throw new Error('Finance connectors require a credential provider.')
      this.finance = new FinanceConnections(ctx, credentials, this.financeTimeoutMs)
    }
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
      await this.finance?.close()
      await this.domain?.close()
    })
  }

  /** Wait for the member directory before publishing the service to dependent plugins. */
  protected [Service.init](): Promise<void> {
    return this.ready
  }

  private async initialize(): Promise<void> {
    this.domain = await this.ctx.storageDomain.open(teamDomainSpec)
    await this.finance?.ready
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
    await this.finance?.pruneBotBindings(this.state.bots.filter(bot => bot.financePreset !== undefined).map(bot => bot.id))
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
      if (this.closing) throw new RemoteError('gateway/internal', 'The team member directory is closing', {})
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
      throw new RemoteError('remote-access/denied', 'Only the owner can manage the team', {
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

  /**
   * Read the finance connector directory for the product owner.
   * @returns the redacted directory, or null when the deployment disables finance connectors.
   */
  @Remote
  async financeSnapshot(): Promise<FinanceConnectorSnapshot | null> {
    this.requireOwner()
    return this.finance?.snapshot() ?? null
  }

  /**
   * Follow the owner’s finance connector catalog and observed access status.
   * @param signal - Cancels delivery when the client disconnects.
   * @returns The baseline catalog and later replacements, or null when finance connectors are disabled.
   */
  @Remote({ mode: 'stream' })
  async *followFinance(signal: AbortSignal): AsyncIterable<FinanceConnectorSnapshot | null> {
    this.requireOwner()
    if (this.finance === undefined) {
      yield null
      return
    }
    yield* this.finance.follow(signal)
  }

  /**
   * Discover companies accessible to an Odoo credential.
   * @param input - proposed destination and credential.
   * @param signal - cancels discovery if the owner leaves the page.
   * @returns the companies available for selection.
   */
  @Remote
  async discoverFinanceCompanies(input: FinanceConnectionDraft, signal: AbortSignal): Promise<readonly FinanceCompany[]> {
    this.requireOwner()
    return this.requireFinance().discover(input, signal)
  }

  /**
   * Verify and persist a finance connector with its selected access mode.
   * @param input - configuration and selected company.
   * @param signal - cancels verification before the accepted save.
   * @returns the saved configuration with its key omitted.
   */
  @Remote
  async saveFinanceConnector(input: SaveFinanceConnectorRequest, signal: AbortSignal): Promise<FinanceConnector> {
    this.requireOwner()
    return this.requireFinance().save(input, signal)
  }

  /**
   * Test an existing connector against its stored company.
   * @param id - the connector to test.
   * @param signal - cancels the test without replacing its last result.
   * @returns the updated public test status.
   */
  @Remote
  async testFinanceConnector(id: FinanceConnectorId, signal: AbortSignal): Promise<FinanceConnector> {
    this.requireOwner()
    return this.requireFinance().test(id, signal)
  }

  /**
   * Delete an unbound finance connector.
   * @param id - the connector to remove.
   */
  @Remote
  async deleteFinanceConnector(id: FinanceConnectorId): Promise<void> {
    this.requireOwner()
    await this.requireFinance().remove(id)
  }

  /**
   * Read the ledger bound to a dedicated finance Bot's private conversation.
   * @param botId - Existing dedicated finance Bot identity.
   * @returns Its verified connection identity, or null when unbound.
   */
  @Remote
  async financeBotBinding(botId: BotId): Promise<FinanceConnectorId | null> {
    this.requireOwner()
    await this.ready
    return this.serialize(async () => {
      this.requireOwner()
      this.requireDedicatedFinanceBot(botId)
      return this.requireFinance().getBotBinding(botId)
    })
  }

  /**
   * Bind one verified ledger for a dedicated finance Bot's private queries.
   * @param botId - Existing dedicated finance Bot identity.
   * @param connectorId - Verified connection, or null to unbind.
   */
  @Remote
  async bindFinanceBot(botId: BotId, connectorId: FinanceConnectorId | null): Promise<void> {
    this.requireOwner()
    await this.ready
    await this.serialize(async () => {
      this.requireOwner()
      this.requireDedicatedFinanceBot(botId)
      await this.requireFinance().bindBot(botId, connectorId)
    })
  }

  private requireDedicatedFinanceBot(botId: BotId): void {
    const bot = this.state.bots.find(item => item.id === botId)
    if (bot?.financePreset === undefined || this.deletingBots.has(botId)) {
      throw financeRemoteError('permissions', 'Private finance connections require a dedicated finance Bot.')
    }
  }

  /** Request deadline shared by Odoo finance and ledger setup operations. */
  get financeTimeoutMs(): number {
    return this.config.financeRequestTimeoutMs ?? 10000
  }

  private requireFinance(): FinanceConnections {
    if (!this.finance) throw financeRemoteError('unsupported', 'Finance connectors are unavailable in this deployment.')
    return this.finance
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
          if (bot.id === ledgerSetupBotId) return ledgerSetupRole
          if (bot.id === odooAccessBotId) return odooAccessRole
          if (bot.financePreset !== undefined) {
            return `You are ${bot.name}, a dedicated finance Bot of 瑞华云财务共享团队. ${bot.role}\nYour role describes your usual duties. For a direct owner request, use the connected tools and their actual permissions. Report any denial from the tool. Use query_bot_finance for verified ledger facts in private chat. Resolve the user's wording from context and ask for a missing date, voucher, or account when needed. Identify the company and scope of the result. For an unbound ledger, direct the owner to the finance connection in Bot settings. When the owner asks to export or download voucher data, call export_bot_finance using the confirmed scope. The tool creates an Excel workbook in the conversation. After success, tell the owner the file is ready and give the row count. Use the ordinary Bot tools and skills for document creation, conversion, charts, and other work under the current permissions. Use call_bot_odoo_orm to read Odoo models outside the finance shortcuts, including suppliers, customers, products and purchase orders. The saved connection mode and Odoo permissions govern allowed operations. In full mode use public methods for the owner’s requested changes and wait for confirmation.`
          }
          const scope = bot.kind === 'main'
            ? '\nYour product scope is creating and configuring Bots and, when create_group_chat is available, creating requested group chats from saved members. You remain outside the group. Group work is coordinated by its ordinary members, not by this private creation assistant. Claim creation only after the corresponding tool confirms it. These limits take precedence over a saved role that describes broader coordination.'
            : ''
          return `You are ${bot.name}, a member of 瑞华云财务共享团队.\n${bot.role || 'You are a general assistant. Work with the user to establish your role.'}${scope}\nWhen introducing yourself, use the exact team name 瑞华云财务共享团队, even if earlier conversation mentions an old product name.\n\n${memberToolGuidance(bot.kind, this.finance !== undefined)}`
        },
      })
      const authorize = (exec: ToolRunContext, mainOnly: boolean) => () => {
        this.requireToolAgent(agent, exec.agent, mainOnly)
      }
      if (member.financePreset !== undefined) {
        const finance = this.finance
        if (finance !== undefined) {
          yield agent.ctx.systemPrompt.context({
            name: 'xiaojing:finance-ledger',
            order: agent.ctx.systemPrompt.getContextOrder('TEAM_IDENTITY'),
            interpolate: false,
            required: true,
            text: () => finance.botPrompt(member.id),
          })
          const requireFinanceAgent = (exec: ToolRunContext) => {
            this.requireToolAgent(agent, exec.agent, false)
            this.requireDedicatedFinanceBot(member.id)
          }
          yield agent.ctx.tools.register(createFinanceQueryTool('bot', async (query, exec) => {
            requireFinanceAgent(exec)
            const result = await finance.queryBot(member.id, query, exec.signal)
            requireFinanceAgent(exec)
            return result
          }))
          yield agent.ctx.tools.register(createFinanceOrmTool('bot', async (request, approve, exec) => {
            requireFinanceAgent(exec)
            return await finance.callOrmBot(member.id, request, async (connector, signal, body) => {
              await approve(connector, signal, body)
              requireFinanceAgent(exec)
            }, exec.signal)
          }))
          yield registerFinanceExportTool(agent, 'bot', async (query, exec) => {
            requireFinanceAgent(exec)
            return await finance.exportBotRows(member.id, query, exec.signal)
          }, async (exec) => {
            requireFinanceAgent(exec)
            await this.ensureWorkDir(member)
            requireFinanceAgent(exec)
            return member.workDir
          })
        }
      } else if (!isOdooAdminBot(member.id)) {
        yield registerMemberTools(agent, member.kind, {
          create: async (request, role, exec) => (await this.createMember(request, role, exec.signal, authorize(exec, true))).bot,
          ...(this.finance !== undefined && member.kind === 'main' ? {
            createFinance: async (request, preset, exec) => (await this.createMember(
              request, FINANCE_ROLES[preset], exec.signal, authorize(exec, true), preset,
            )).bot,
          } : {}),
          createFolder: async (name, exec) => (await this.createGroupValue({ name }, exec.signal, authorize(exec, true))).group,
          list: exec => this.readSnapshot(exec.signal, authorize(exec, true)),
          setRole: async (role, exec) => (await this.updateMember({ id: member.id, role }, exec.signal, authorize(exec, false))).bot,
          setAppearance: async (id, avatar, exec) => (await this.updateMember({ id, avatar }, exec.signal, authorize(exec, true))).bot,
        })
      }
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

  /**
   * Provision the private Odoo administration Bots for the ledger setup plugin.
   * Existing private Sessions are retained while their fixed identities are synchronized.
   * @returns Once both private Bot records and their Sessions are saved.
   */
  async ensureOdooAdminBots(): Promise<void> {
    await this.ready
    this.requireFinance()
    await this.serialize(async () => {
      await this.finishPending()
      await this.finishPendingRename()
      for (const identity of odooAdminBots) {
        const previous = this.state.bots.find(bot => bot.id === identity.id)
        if (previous === undefined) {
          const bot = { ...this.newBot(identity.id, 'ordinary', identity.name, ordinaryGroupId, identity.role), avatar: identity.avatar }
          await this.commit({ ...this.state, pendingBot: bot })
          await this.finishPending()
        } else if (previous.name !== identity.name || previous.role !== identity.role
          || previous.avatar.shape !== identity.avatar.shape || previous.avatar.color !== identity.avatar.color) {
          await this.commit({ ...this.state, pendingRename: { ...previous, ...identity } })
          await this.finishPendingRename()
        }
      }
    })
  }

  /**
   * Resolve the original creator tool to the already provisioned ledger Bot.
   * @param agent Live main Bot authorized to locate the fixed ledger assistant.
   * @param signal Cancels the lookup.
   * @returns The saved ledger Bot and its private Session.
   */
  async ensureLedgerSetupBot(agent: Agent, signal: AbortSignal): Promise<TeamBot> {
    await this.ready
    signal.throwIfAborted()
    this.requireToolAgent(agent, agent, true)
    const bot = this.state.bots.find(item => item.id === ledgerSetupBotId)
    if (bot === undefined) throw new RemoteError('gateway/bad-request', 'The Odoo ledger Bot is unavailable.', {})
    return bot
  }

  /**
   * Save a versioned finance roster once, resuming its allocated identities after interruption.
   * Existing saved roles, model selections and names remain editable and are not reset by a retry.
   * @param agent Live main Bot requesting the team.
   * @param template Fixed compact or standard definition.
   * @param name Requested group name identifying this creation within its sidebar folder.
   * @param groupId Selected custom folder, or undefined for default member/chat placement.
   * @param signal Cancels before the next durable member is accepted.
   * @returns Saved ordered members, with the finance manager first.
   */
  async createFinanceTeamMembers(agent: Agent, template: FinanceTeamTemplate, name: string,
    groupId: GroupId | undefined, signal: AbortSignal): Promise<readonly TeamBot[]> {
    await this.ready
    this.requireFinance()
    return this.serialize(async () => {
      const authorize = () => { signal.throwIfAborted(); this.requireOwner(); this.requireToolAgent(agent, agent, true) }
      authorize()
      await this.finishPending()
      await this.finishPendingRename()
      const folder = groupId ?? ordinaryGroupId
      this.ordinaryGroup(folder)
      if (folder !== ordinaryGroupId && this.state.groups.find(group => group.id === folder)?.system) {
        throw new RemoteError('gateway/bad-request', 'Choose a custom folder for a finance team.', {})
      }
      const label = this.nameValue(name)
      let creation = this.state.financeTeams?.find(item => item.name === label && item.groupId === folder)
      if (creation !== undefined && creation.template !== template) {
        throw new RemoteError('gateway/bad-request', 'This team name already uses another template. Choose a different name for a new team.', {})
      }
      const positions = financeTeamPositions(template)
      if (creation === undefined) {
        creation = { template, name: label, groupId: folder, completed: false,
          memberIds: positions.map(() => brandString<BotId>(`bot-${randomUUID()}`)) }
        authorize()
        await this.commit({ ...this.state, financeTeams: [...(this.state.financeTeams ?? []), creation] })
      }
      const bots: TeamBot[] = []
      for (const [index, position] of positions.entries()) {
        authorize()
        const id = creation.memberIds[index]!
        let bot = this.state.bots.find(member => member.id === id)
        if (bot === undefined) {
          if (creation.completed) throw new RemoteError('gateway/bad-request', 'A saved template member was removed. Inspect the existing team instead of creating replacements automatically.', {})
          bot = { ...this.newBot(id, 'ordinary', position.name, folder, position.role),
            financePreset: position.preset, avatar: { shape: 'classic', color: AVATAR_COLORS[index]!.color } }
          await this.commit({ ...this.state, pendingBot: bot })
          await this.finishPending()
        }
        bots.push(bot)
      }
      if (!creation.completed) {
        const members = new Set(creation.memberIds)
        let index = 0
        const ordered = template === 'compact-v2' || template === 'standard-v2'
          ? this.state.bots.map(bot => members.has(bot.id) ? bots[index++]! : bot) : this.state.bots
        await this.commit({ ...this.state, bots: ordered, financeTeams: this.state.financeTeams!.map(item => item.groupId === folder && item.name === label
          ? { ...item, completed: true } : item) })
      }
      return bots
    })
  }

  private async createMember(
    request: CreateBotRequest, role: string, signal?: AbortSignal, authorize?: () => void,
    financePreset?: TeamBot['financePreset'],
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
      const retry = pending?.kind === 'ordinary' && !isOdooAdminBot(pending.id)
        && pending.name === name && pending.groupId === groupId && pending.role === role
        && pending.financePreset === financePreset && pending.avatar.shape === avatar.shape && pending.avatar.color.toLowerCase() === avatar.color.toLowerCase()
      const recovered = await this.finishPending()
      if (retry && recovered !== undefined) return { bot: recovered, snapshot: this.snapshotValue() }
      const bot = {
        ...this.newBot(brandString<BotId>(`bot-${randomUUID()}`), 'ordinary', name, groupId, role),
        avatar,
        ...(financePreset === undefined ? {} : { financePreset }),
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
        if (bot.kind === 'main' || isOdooAdminBot(bot.id)) {
          throw new RemoteError('katcats/organization', 'A fixed Bot cannot be deleted.', { reason: 'bot-main' })
        }
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
          if (bot.financePreset !== undefined) {
            try {
              await this.finance?.bindBot(bot.id, null)
            } catch {
              this.ctx.logger.warn('The deleted finance Bot’s binding could not be cleared and will be retried on restart.')
            }
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
      if (isOdooAdminBot(previous.id) && ((request.name !== undefined && request.name.trim() !== previous.name)
        || (request.role !== undefined && request.role !== previous.role)
        || (request.groupId !== undefined && request.groupId !== previous.groupId)
        || (request.avatar !== undefined && (request.avatar.shape !== previous.avatar.shape
          || request.avatar.color.toLowerCase() !== previous.avatar.color.toLowerCase())))) {
        throw new RemoteError('gateway/bad-request', 'The Odoo administration Bot has a fixed identity.', {})
      }
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
    return this.createGroupValue(request)
  }

  private async createGroupValue(request: CreateGroupRequest, signal?: AbortSignal, authorize?: () => void): Promise<GroupMutationValue> {
    await this.ready
    return this.serialize(async () => {
      signal?.throwIfAborted()
      authorize?.()
      await this.finishPendingRename()
      await this.finishPending()
      const name = this.nameValue(request.name)
      signal?.throwIfAborted()
      authorize?.()
      if (authorize !== undefined) {
        const matches = this.state.groups.filter(group => !group.system && group.kind === 'bots' && group.name === name)
        if (matches.length > 1) throw new RemoteError('gateway/bad-request', 'More than one folder has that name. Use list_bots and ask which folder to use.', {})
        const existing = matches[0]
        if (existing !== undefined) return { group: existing, snapshot: this.snapshotValue() }
      }
      const group: TeamGroup = { id: brandString<GroupId>(`group-${randomUUID()}`), name, kind: 'bots', system: false }
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
