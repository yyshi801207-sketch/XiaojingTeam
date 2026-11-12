/** Persistent, owner-approved Odoo ledger setup and connector registration. */
import { createHash } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialKey, credentialKeyScope, parseCredentialKey, type CredentialKey, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { defineDomain, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { principalOf, Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { z } from 'zod'
import type {} from './index.ts'
import type { ChatId } from './chats-types.ts'
import { financeRemoteError } from './finance-connectors.ts'
import type { FinanceAdminContextScope } from './finance-admin-context.ts'
import { isOdooAdminBot } from './types.ts'
import { FinanceConnectionError, financeOdooAccountSchema, normalizeFinanceEndpoint } from './finance-odoo.ts'
import { listOdooAdminCompanies, odooAdminBody, prepareOdooAdminCall, prepareOdooAdminWrite, runOdooAdminCall, verifyOdooAdminCompany, verifyOdooAdminWrite, type OdooAdminRole } from './finance-admin-odoo.ts'
import { odooAdminOperationDomain, publicOdooAdminOperation, type OdooAdminOperation, type OdooAdminOperationId, type StoredOdooAdminOperation } from './finance-admin-operations.ts'
import {
  createOdooSetupCompany, findOdooSetupCompanies, getOdooSetupChoices, importOdooSetupAccounts, initializeOdooExistingSetupCompany,
  initializeOdooSetupCompany, OdooSetupAccountConflict, verifyOdooSetupCandidate,
  verifyOdooSetupAccount, verifyOdooSetupAccounts, verifyOdooSetupCompany, verifyOdooSetupConnection, verifyOdooSetupHandoffUser, type OdooSetupChoices,
} from './finance-setup-odoo.ts'
import { FINANCE_SETUP_CHART_MAX_ACCOUNTS, FINANCE_SETUP_CHART_MAX_BYTES, FinanceSetupChartError, financeSetupAccountSchema, parseFinanceSetupChart } from './finance-setup-chart.ts'
import { registerLedgerSetupTools } from './finance-setup-tools.ts'
import type { LedgerSetupConnectionInput, LedgerSetupConnectorInput, LedgerSetupDraftInput, LedgerSetupPlan, LedgerSetupPlanId, LedgerSetupSnapshot } from './finance-setup-types.ts'
import { financeFailureReasons, type FinanceCompany, type FinanceConnectorId, type FinanceFailureReason, type FinanceOrmCallRequest, type FinanceOrmJsonValue } from './finance-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Database-level company setup and owner-approved registration in finance connectors. */
    xiaojingLedgerSetup: XiaojingLedgerSetup
  }
}

const setupCredentialScope = 'xiaojing-ledger-setup'
const planIdSchema = z.uuid().transform(value => brandString<LedgerSetupPlanId>(value))
const chatIdSchema = z.string().min(1).max(160).transform(value => brandString<ChatId>(value))
const keySchema = z.string().trim().min(1).max(4096).regex(/^[\x21-\x7e]+$/)
const addressSchema = z.object({ url: z.string().min(1).max(2048), database: z.string().min(1).max(128) })
const identitySchema = z.object({ databaseUuid: z.uuid(), userId: z.number().int().positive() })
const connectionSchema = addressSchema.extend({
  identity: identitySchema, verifiedAt: z.iso.datetime(),
  account: financeOdooAccountSchema.optional(),
  credential: z.string().regex(/^xiaojing-ledger-setup\/key-[0-9a-f-]{36}$/).transform(parseCredentialKey),
})
const lookupSchema = z.strictObject({
  countryCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/),
  currencyCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
})
const draftSchema = lookupSchema.extend({
  existingCompanyId: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(100),
  taxId: z.string().trim().min(1).max(64).optional(),
  templateCode: z.string().regex(/^[a-z][a-z0-9_-]{0,95}$/),
  openingDate: z.iso.date(),
  mode: z.enum(['odoo-template', 'custom-chart']),
})
const planSchema = draftSchema.extend({
  id: planIdSchema, revision: z.number().int().nonnegative(), createdAt: z.iso.datetime(),
  status: z.enum(['draft', 'running', 'blocked', 'uncertain', 'ready', 'handed-off']),
  identity: identitySchema, templateName: z.string().min(1),
  rows: z.array(financeSetupAccountSchema).max(FINANCE_SETUP_CHART_MAX_ACCOUNTS),
  customChartEditable: z.boolean().optional(),
  customImportStarted: z.boolean().optional(),
  customChart: z.object({ name: z.string().min(1).max(160), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).optional(),
  companyId: z.number().int().positive().optional(),
  companyReconciledAt: z.iso.datetime().optional(),
  company: z.object({ id: z.number().int().positive(), name: z.string(), currency: z.string() }).optional(),
  accountCount: z.number().int().nonnegative().optional(),
  journalCount: z.number().int().nonnegative().optional(),
  failure: z.enum(financeFailureReasons).optional(),
  chatId: chatIdSchema.optional(),
})
const stateSchema = z.object({ connection: connectionSchema.nullable(), plans: z.array(planSchema) })
const ledgerSetupDomain = defineDomain({
  name: 'xiaojing_ledger_setup',
  version: 1,
  global: { schema: stateSchema, initial: { connection: null, plans: [] } },
  tables: {},
})
type SetupState = z.output<typeof stateSchema>
type StoredPlan = z.output<typeof planSchema>
type SetupIdentity = z.output<typeof identitySchema>
type StoredConnection = z.output<typeof connectionSchema>

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw financeRemoteError('invalid-input', 'Check the ledger setup information.')
  return parsed.data
}

function publicPlan(plan: StoredPlan): LedgerSetupPlan {
  const { identity: _identity, customImportStarted: _customImportStarted, companyReconciledAt: _companyReconciledAt,
    existingCompanyId, rows, taxId, customChartEditable, customChart, companyId, company, accountCount, journalCount, failure, chatId, ...fields } = plan
  return {
    ...fields, customAccountCount: rows.length,
    ...(existingCompanyId === undefined ? {} : { existingCompanyId }),
    ...(taxId === undefined ? {} : { taxId }),
    ...(customChartEditable === undefined ? {} : { customChartEditable }),
    ...(customChart === undefined ? {} : { customChart }),
    ...(companyId === undefined ? {} : { companyId }),
    ...(company === undefined ? {} : { company }),
    ...(accountCount === undefined ? {} : { accountCount }),
    ...(journalCount === undefined ? {} : { journalCount }),
    ...(failure === undefined ? {} : { failure }),
    ...(chatId === undefined ? {} : { chatId }),
  }
}

function sameIdentity(left: SetupIdentity, right: SetupIdentity): boolean {
  return left.databaseUuid === right.databaseUuid && left.userId === right.userId
}

/** Stores setup plans before Odoo writes and checkpoints the confirmed company ID before initialization. */
export class XiaojingLedgerSetup extends TypertRemoteService {
  static inject = ['katcatsTeam', 'storageDomain', 'agents', 'tools', 'systemPrompt', 'sessionProjections', 'credentials', 'userQuestions']

  private domain: Domain<typeof ledgerSetupDomain> | undefined
  private adminDomain: Domain<typeof odooAdminOperationDomain> | undefined
  private readonly ready: Promise<void>
  private tail = Promise.resolve()
  private readonly closing = new AbortController()
  private readonly followers = new Set<() => void>()
  private revision = 0

  constructor(ctx: Context) {
    super(ctx, 'xiaojingLedgerSetup')
    this.ready = this.initialize()
    ctx.on('agent/created', ({ agent }) => { registerLedgerSetupTools(ctx, this, agent) })
    ctx.effect(() => async () => {
      this.closing.abort()
      this.notify()
      try { await this.ready; await this.tail } finally { await this.adminDomain?.close(); await this.domain?.close() }
    }, 'xiaojing-ledger-setup: close after accepted work')
  }

  /** Publish the service after its fixed Bots and saved state are ready. */
  protected [Service.init](): Promise<void> {
    return this.ready
  }

  private async initialize(): Promise<void> {
    this.domain = await this.ctx.storageDomain.open(ledgerSetupDomain)
    this.adminDomain = await this.ctx.storageDomain.open(odooAdminOperationDomain)
    if (this.adminDomain.global.get().operations.some(operation => operation.status === 'pending')) {
      await this.adminDomain.global.set({ operations: this.adminDomain.global.get().operations.map(operation => operation.status !== 'pending'
        ? operation : { ...operation, status: 'unknown', failure: 'unknown-outcome', updatedAt: new Date().toISOString() }) })
    }
    const state = this.state
    if (state.plans.some(plan => plan.status === 'running')) {
      await this.commit({ ...state, plans: state.plans.map(plan => plan.status !== 'running' ? plan : {
        ...plan, revision: plan.revision + 1, status: plan.companyId === undefined ? 'uncertain' : 'blocked',
        failure: 'unknown-outcome',
      }) })
    }
    try {
      const saved = this.state.connection?.credential
      for (const record of await this.credentials.listRecords()) {
        if (record.key !== saved && credentialKeyScope(record.key) === setupCredentialScope) await this.discard(record.key)
      }
    } catch (error) {
      this.ctx.logger.warn('Ledger setup credential cleanup could not be completed.')
    }
    await this.ctx.katcatsTeam.ensureOdooAdminBots()
    for (const agent of this.ctx.agents.list()) registerLedgerSetupTools(this.ctx, this, agent)
  }

  private get credentials(): CredentialProvider {
    return this.ctx.credentials
  }

  private get state(): SetupState {
    if (this.domain === undefined) throw new Error('The ledger setup domain is not ready.')
    return this.domain.global.get()
  }

  private owner(): void {
    const invocation = this.ctx.invocation
    if (invocation !== undefined && principalOf(invocation) !== undefined) {
      throw new RemoteError('remote-access/denied', 'Only the owner can manage Odoo ledger setup.', {
        action: `${invocation.request.namespace}/${invocation.request.method}`, reason: 'owner-required',
      })
    }
  }

  private notify(): void {
    this.revision += 1
    for (const wake of this.followers) wake()
  }

  private async commit(state: SetupState): Promise<void> {
    if (this.domain === undefined) throw new Error('The ledger setup domain is not ready.')
    try { await this.domain.global.set(state) } catch (error) {
      throw financeRemoteError('storage', 'The setup state could not be saved. Reopen it before retrying.')
    }
    this.notify()
  }

  private async replace(plan: StoredPlan): Promise<StoredPlan> {
    const next = { ...plan, revision: plan.revision + 1 }
    await this.commit({ ...this.state, plans: this.state.plans.map(item => item.id === next.id ? next : item) })
    return next
  }

  private async reported<T>(operation: () => Promise<T>): Promise<T> {
    await this.ready
    try {
      this.closing.signal.throwIfAborted()
      return await operation()
    } catch (error) {
      if (error instanceof FinanceConnectionError) throw financeRemoteError(error.reason, error.message)
      throw error
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => this.reported(operation))
    this.tail = result.then(() => {}, () => {})
    return result
  }

  private options(signal: AbortSignal) {
    return { signal: AbortSignal.any([signal, this.closing.signal]), timeoutMs: this.ctx.katcatsTeam.financeTimeoutMs }
  }

  private async discard(key: CredentialKey): Promise<void> {
    try { await this.credentials.deleteRecord(key) } catch (error) {
      this.ctx.logger.warn('Ledger setup credential cleanup will be retried on restart.')
    }
  }

  private async secret(connection: StoredConnection): Promise<string> {
    const record = await this.credentials.readRecord(connection.credential)
    if (record?.kind !== 'api-key' || !record.key) throw financeRemoteError('credential', 'Enter the Odoo setup API key again.')
    return record.key
  }

  private connection(): StoredConnection {
    const connection = this.state.connection
    if (connection === null) throw financeRemoteError('unbound', '先在建账助手或系统助手的 Bot 设置 → 财务系统连接中验证 Odoo 数据库。')
    return connection
  }

  /**
   * Read the verified scope used to isolate fixed assistant model context after initialization.
   * @returns The configured destination and account identity, without credential material.
   */
  adminContextScope(): FinanceAdminContextScope | null {
    const connection = this.state.connection
    return connection === null ? null : {
      url: connection.url, database: connection.database,
      databaseUuid: connection.identity.databaseUuid, userId: connection.identity.userId,
    }
  }

  private async verifiedConnection(signal: AbortSignal, identity?: SetupIdentity) {
    const connection = this.connection()
    if (identity && !sameIdentity(identity, connection.identity)) {
      throw financeRemoteError('ledger-mismatch', 'Reconnect the same Odoo database and setup account used by this plan.')
    }
    const key = await this.secret(connection)
    const options = this.options(signal)
    const actual = await verifyOdooSetupConnection(connection, key, options)
    if (!sameIdentity(actual, connection.identity)) {
      throw financeRemoteError('ledger-mismatch', 'This address no longer resolves to the verified Odoo database and account.')
    }
    return { connection, key, options }
  }

  private view(): LedgerSetupSnapshot {
    const { connection, plans } = this.state
    return {
      connection: connection && {
        url: connection.url, database: connection.database, verifiedAt: connection.verifiedAt,
        ...(connection.account?.login === undefined ? {} : { account: { login: connection.account.login } }),
      },
      plans: plans.map(publicPlan),
    }
  }

  private plan(id: LedgerSetupPlanId, expectedRevision?: number): StoredPlan {
    const plan = this.state.plans.find(item => item.id === id)
    if (!plan) throw financeRemoteError('not-found', 'This ledger setup plan is unavailable.')
    if (expectedRevision !== undefined && plan.revision !== expectedRevision) {
      throw financeRemoteError('in-use', 'The plan changed. Review the current version before confirming.')
    }
    return plan
  }

  /**
   * Read redacted setup configuration and plans.
   * @returns The database status and saved setup plans.
   */
  @Remote
  async snapshot(): Promise<LedgerSetupSnapshot> {
    this.owner()
    return this.reported(async () => this.view())
  }

  /**
   * Read model-facing setup status only for the currently verified database and account.
   * @param signal Tool execution lifetime.
   * @returns Current connection and matching plans; the owner snapshot retains all archived plans.
   */
  currentPlans(signal: AbortSignal): Promise<LedgerSetupSnapshot> {
    return this.reported(async () => {
      signal.throwIfAborted()
      const current = this.state.connection
      return { ...this.view(), plans: current === null ? [] : this.state.plans
        .filter(plan => sameIdentity(plan.identity, current.identity)).map(publicPlan) }
    })
  }

  /**
   * Follow saved setup changes after the initial snapshot.
   * @param signal Client connection lifetime.
   * @returns Redacted snapshots of the setup database and plans.
   */
  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<LedgerSetupSnapshot> {
    this.owner()
    await this.ready
    const lifetime = AbortSignal.any([signal, this.closing.signal])
    let seen = -1
    while (!lifetime.aborted) {
      if (seen !== this.revision) {
        seen = this.revision
        yield this.view()
        continue
      }
      const { promise, resolve } = Promise.withResolvers<void>()
      const wake = () => resolve()
      this.followers.add(wake)
      lifetime.addEventListener('abort', wake, { once: true })
      try { await promise } finally {
        lifetime.removeEventListener('abort', wake)
        this.followers.delete(wake)
      }
    }
  }

  /**
   * Verify and save a database-level setup credential without selecting a company.
   * @param request Address, database and an optional replacement key for the same destination.
   * @param signal Cancels verification before settings are committed.
   * @returns The redacted setup snapshot.
   */
  @Remote
  async saveConnection(request: LedgerSetupConnectionInput, signal: AbortSignal): Promise<LedgerSetupSnapshot> {
    this.owner()
    return this.serialize(async () => {
      const draft = input(addressSchema.extend({ apiKey: keySchema.optional() }).strict(), request)
      const endpoint = normalizeFinanceEndpoint(draft)
      const previous = this.state.connection
      const retained = draft.apiKey === undefined && previous?.url === endpoint.url && previous.database === endpoint.database
        ? previous : null
      const key = draft.apiKey ?? (retained && await this.secret(retained))
      if (!key) throw financeRemoteError('credential', 'Enter an API key for this Odoo database.')
      const options = this.options(signal)
      const { identity, account } = await verifyOdooSetupAccount(endpoint, key, options)
      options.signal.throwIfAborted()
      const commit = async () => {
        const credential = retained?.credential ?? credentialKey(setupCredentialScope, `key-${randomUUID()}`)
        if (!retained) {
          try { await this.credentials.modifyRecord(credential, async () => ({ kind: 'api-key', key })) } catch (error) {
            throw financeRemoteError('credential', 'Could not save the setup API key.')
          }
        }
        options.signal.throwIfAborted()
        await this.commit({ ...this.state, connection: { ...endpoint, identity, account, verifiedAt: new Date().toISOString(), credential } })
        if (previous && previous.credential !== credential) await this.discard(previous.credential)
        return this.view()
      }
      if (previous && previous.url === endpoint.url && previous.database === endpoint.database && sameIdentity(previous.identity, identity)) return commit()
      const assistants = this.ctx.agents.list().filter(agent => {
        const bot = this.ctx.katcatsTeam.memberForSession(agent.id)
        return bot !== undefined && isOdooAdminBot(bot.id)
      })
      if (assistants.some(agent => agent.status === 'running')) {
        throw financeRemoteError('in-use', 'Wait for both administration assistants to finish before changing their database or account.')
      }
      const reserve = (index: number): Promise<LedgerSetupSnapshot> => {
        const agent = assistants[index]
        return agent === undefined ? commit() : agent.runMaintenance(async () => reserve(index + 1))
      }
      return reserve(0)
    })
  }

  /**
   * Resolve the available Odoo template choices without changing server data.
   * @param request Country and currency codes confirmed for this proposed plan.
   * @param signal Tool execution lifetime.
   * @returns The matching Odoo country, currency and installed templates.
   */
  choices(request: { countryCode: string; currencyCode: string }, signal: AbortSignal): Promise<OdooSetupChoices> {
    return this.serialize(async () => {
      const lookup = input(lookupSchema, request)
      const { connection, key, options } = await this.verifiedConnection(signal)
      return getOdooSetupChoices(connection, key, lookup, options)
    })
  }

  /**
   * Discover the companies accessible to the saved administration account.
   * @param signal Tool execution lifetime.
   * @returns The verified database name and accessible company summaries.
   */
  adminCompanies(signal: AbortSignal): Promise<{ readonly database: string; readonly companies: readonly FinanceCompany[] }> {
    return this.serialize(async () => {
      const { connection, key, options } = await this.verifiedConnection(signal)
      return { database: connection.database, companies: await listOdooAdminCompanies(connection, key, options) }
    })
  }

  /**
   * Call a role-scoped Odoo administration method after confirming its exact write target and arguments.
   * @param role Fixed Bot responsibility derived from the private Session.
   * @param request Odoo model, method, arguments and optional selected company.
   * @param confirm Obtains explicit user approval before a mutation is sent.
   * @param signal Tool execution lifetime.
   * @returns The verified database and company scope with the Odoo response.
   */
  adminCall(role: 'ledger' | 'access', request: FinanceOrmCallRequest & { readonly companyId?: number },
    confirm: (details: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<void>, signal: AbortSignal): Promise<{
      readonly database: string; readonly company: FinanceCompany | null; readonly model: string; readonly method: string; readonly data: FinanceOrmJsonValue
      readonly operation?: OdooAdminOperation
    }> {
    return this.reported(async () => {
      const call = prepareOdooAdminCall(role, request)
      const body = odooAdminBody(call, request.companyId)
      const { connection, key, options } = await this.verifiedConnection(signal)
      if (call.mutating) this.requireSettledAdminWrites(role, connection.identity.databaseUuid)
      const company = request.companyId === undefined ? null
        : await verifyOdooAdminCompany(connection, key, request.companyId, options)
      const send = async () => {
        options.signal.throwIfAborted()
        const current = this.state.connection
        if (current?.credential !== connection.credential || !sameIdentity(current.identity, connection.identity)) {
          throw financeRemoteError('unbound', '确认期间 Odoo 连接发生变化，请核对数据库后重试。')
        }
        if (!call.mutating) {
          const data = await runOdooAdminCall(connection, key, call, options, request.companyId)
          return { database: connection.database, company, model: call.model, method: call.method, data }
        }
        this.requireSettledAdminWrites(role, connection.identity.databaseUuid)
        await this.verifiedConnection(options.signal, connection.identity)
        const witness = await prepareOdooAdminWrite(connection, key, call, options, request.companyId)
        options.signal.throwIfAborted()
        const now = new Date().toISOString()
        let operation: StoredOdooAdminOperation = {
          id: brandString<OdooAdminOperationId>(randomUUID()), role, database: connection.database,
          identity: connection.identity, model: call.model, method: call.method, params: { ...call.params },
          ...(request.companyId === undefined ? {} : { companyId: request.companyId }),
          witness: { fields: [...witness.fields], fieldTypes: { ...witness.fieldTypes }, targets: witness.targets.map(target => ({
            ...target, beforeIds: [...target.beforeIds], values: { ...target.values },
          })) }, status: 'pending', createdAt: now, updatedAt: now,
        }
        await this.saveAdminOperation(operation)
        let acknowledged = false
        try {
          const data = await runOdooAdminCall(connection, key, call, options, request.companyId)
          acknowledged = true
          if (call.method === 'create') {
            operation = { ...operation, recordIds: z.array(z.number().int().positive()).parse(data) }
            await this.saveAdminOperation(operation)
          }
          const verified = await verifyOdooAdminWrite(connection, key, call, witness, options, request.companyId, operation.recordIds)
          operation = { ...operation, status: verified.verified ? 'verified' : 'unknown',
            records: verified.records.map(row => ({ ...row })), candidates: verified.candidates.map(row => [...row]),
            failure: verified.verified ? undefined : 'readback-mismatch', updatedAt: new Date().toISOString() }
          await this.saveAdminOperation(operation)
          if (!verified.verified) throw financeRemoteError('unknown-outcome', `管理操作 ${operation.id} 的实际结果与预期不一致，请先核验，不能重复写入。`)
          return { database: connection.database, company, model: call.model, method: call.method, data, operation: publicOdooAdminOperation(operation) }
        } catch (error) {
          const rejected = !acknowledged && error instanceof FinanceConnectionError
            && ['authentication', 'permissions', 'invalid-input', 'database', 'unsupported', 'not-found'].includes(error.reason)
          if (operation.status === 'pending') {
            operation = { ...operation, status: rejected ? 'rejected' : 'unknown',
              failure: rejected && error instanceof FinanceConnectionError ? error.reason : 'unknown-outcome', updatedAt: new Date().toISOString() }
            await this.saveAdminOperation(operation)
          }
          if (rejected) throw error
          throw financeRemoteError('unknown-outcome', `管理操作 ${operation.id} 已记录但结果尚未核验。请读取操作记录并核验，不能重复写入。`)
        }
      }
      if (!call.mutating) return this.serialize(send)
      await confirm({ address: connection.url, database: connection.database, company, model: call.model, method: call.method, parameters: body }, options.signal)
      return this.serialize(send)
    })
  }

  private adminRecords(): readonly StoredOdooAdminOperation[] {
    if (!this.adminDomain) throw new Error('Odoo administration operation storage is not ready.')
    return this.adminDomain.global.get().operations
  }

  private async saveAdminOperation(operation: StoredOdooAdminOperation): Promise<void> {
    if (!this.adminDomain) throw new Error('Odoo administration operation storage is not ready.')
    const previous = this.adminRecords()
    const operations = previous.some(item => item.id === operation.id)
      ? previous.map(item => item.id === operation.id ? operation : item) : [...previous, operation]
    try { await this.adminDomain.global.set({ operations }) } catch (error) {
      throw financeRemoteError('storage', '管理操作记录保存失败，请重新打开并核验状态后再继续。')
    }
    this.notify()
  }

  private requireSettledAdminWrites(role: OdooAdminRole, databaseUuid: string): void {
    const pending = this.adminRecords().find(item => item.role === role && item.identity.databaseUuid === databaseUuid
      && (item.status === 'pending' || item.status === 'unknown'))
    if (pending) throw financeRemoteError('unknown-outcome', `管理操作 ${pending.id} 的结果尚未核验，请先核验该操作再发起新的写入；仍可查询数据。`)
  }

  /**
   * List durable write outcomes for one fixed assistant in the current database, without network access.
   * @param role Fixed administrative role.
   * @param signal Request lifetime.
   * @returns Redacted operation records, including writes requiring reconciliation.
   */
  async adminOperations(role: OdooAdminRole, signal: AbortSignal): Promise<readonly OdooAdminOperation[]> {
    this.owner()
    await this.ready
    signal.throwIfAborted()
    const connection = this.connection()
    return this.adminRecords().filter(item => item.role === role && item.identity.databaseUuid === connection.identity.databaseUuid)
      .map(publicOdooAdminOperation)
  }

  /**
   * Re-read an unresolved write without sending it again.
   * @param role Fixed assistant permitted to reconcile this operation.
   * @param id Recorded operation identity.
   * @param signal Request lifetime.
   * @param adoptRecordIds Creation IDs explicitly confirmed by the owner, in original creation order.
   * @returns Verified readback or unresolved state and candidates; candidates alone never unlock writes.
   */
  async reconcileAdminOperation(role: OdooAdminRole, id: OdooAdminOperationId, signal: AbortSignal,
    adoptRecordIds?: readonly number[]): Promise<OdooAdminOperation> {
    this.owner()
    return this.serialize(async () => {
      const { connection, key, options } = await this.verifiedConnection(signal)
      let operation = this.adminRecords().find(item => item.id === id && item.role === role
        && item.identity.databaseUuid === connection.identity.databaseUuid)
      if (!operation) throw financeRemoteError('not-found', '当前助手和数据库下没有这条管理操作记录。')
      if (operation.status === 'verified' || operation.status === 'rejected') return publicOdooAdminOperation(operation)
      if (adoptRecordIds !== undefined && (operation.method !== 'create' || operation.recordIds !== undefined)) {
        throw financeRemoteError('invalid-input', '只有尚未取得创建结果 ID 的操作可以认领创建记录。')
      }
      const call = prepareOdooAdminCall(role, { model: operation.model, method: operation.method, params: operation.params })
      const recordIds = adoptRecordIds ?? operation.recordIds
      const verified = await verifyOdooAdminWrite(connection, key, call, operation.witness, options, operation.companyId, recordIds)
      operation = { ...operation, status: verified.verified ? 'verified' : 'unknown',
        ...(verified.verified && recordIds !== undefined ? { recordIds: [...recordIds] } : {}),
        records: verified.records.map(row => ({ ...row })), candidates: verified.candidates.map(row => [...row]),
        failure: verified.verified ? undefined : 'readback-mismatch', updatedAt: new Date().toISOString() }
      await this.saveAdminOperation(operation)
      return publicOdooAdminOperation(operation)
    })
  }

  /**
   * Save a reviewable draft from the dedicated assistant without changing Odoo.
   * @param request Proposed company settings and template selection.
   * @param signal Tool execution lifetime.
   * @returns The persisted draft or identical existing plan.
   */
  propose(request: LedgerSetupDraftInput, signal: AbortSignal): Promise<LedgerSetupPlan> {
    return this.serialize(async () => {
      const draft = input(draftSchema, request)
      const { connection, key, options } = await this.verifiedConnection(signal)
      const { country, currency, templates } = await getOdooSetupChoices(connection, key, draft, options)
      const template = templates.find(item => item.code === draft.templateCode)
      if (!template) throw financeRemoteError('invalid-input', 'Select a template returned by the connected Odoo database.')
      const existing = this.state.plans.find(plan => sameIdentity(plan.identity, connection.identity)
        && (plan.name === draft.name || (draft.taxId !== undefined && plan.taxId === draft.taxId)
          || (draft.existingCompanyId !== undefined && plan.companyId === draft.existingCompanyId)))
      if (draft.existingCompanyId !== undefined) {
        if (existing?.companyId !== undefined && existing.companyId !== draft.existingCompanyId) {
          throw financeRemoteError('ledger-mismatch', 'This saved plan is already assigned to a different company.')
        }
        await verifyOdooSetupCandidate(connection, key, {
          name: draft.name, ...(draft.taxId === undefined ? {} : { taxId: draft.taxId }),
          companyId: draft.existingCompanyId, countryId: country.id, currencyId: currency.id, templateCode: draft.templateCode,
        }, options)
      }
      if (existing && ((existing.status !== 'draft' && existing.status !== 'blocked') || existing.companyId !== undefined)) {
        return publicPlan(existing)
      }
      const unchanged = existing && Object.entries(draft).every(([key, value]) => Reflect.get(existing, key) === value)
        && existing.taxId === draft.taxId
      if (unchanged) return publicPlan(existing)
      options.signal.throwIfAborted()
      if (existing) {
        return publicPlan(await this.replace({
          ...existing, ...draft, taxId: draft.taxId, templateName: template.name, status: 'draft',
          existingCompanyId: draft.existingCompanyId, companyId: draft.existingCompanyId,
          failure: undefined, rows: [], customChart: undefined,
        }))
      }
      const plan: StoredPlan = {
        ...draft, identity: connection.identity, templateName: template.name, id: brandString<LedgerSetupPlanId>(randomUUID()),
        companyId: draft.existingCompanyId,
        createdAt: new Date().toISOString(), revision: 0, status: 'draft', rows: [],
      }
      await this.commit({ ...this.state, plans: [plan, ...this.state.plans] })
      return publicPlan(plan)
    })
  }

  /**
   * List possible results of an uncertain company creation without changing its plan.
   * @param id Plan whose dispatched creation has an unknown result.
   * @param expectedRevision Revision currently shown to the owner.
   * @param signal Cancels company discovery.
   * @returns Matching accessible company choices; no choice is adopted automatically.
   */
  @Remote
  async recoveryCompanies(id: LedgerSetupPlanId, expectedRevision: number, signal: AbortSignal): Promise<readonly FinanceCompany[]> {
    this.owner()
    return this.serialize(async () => {
      const plan = this.plan(id, expectedRevision)
      if (plan.status !== 'uncertain' || plan.companyId !== undefined) {
        throw financeRemoteError('in-use', 'Only an uncertain company creation can be reconciled.')
      }
      const { connection, key, options } = await this.verifiedConnection(signal, plan.identity)
      return findOdooSetupCompanies(connection, key, {
        name: plan.name, ...(plan.taxId === undefined ? {} : { taxId: plan.taxId }),
      }, options)
    })
  }

  /**
   * Attach the owner-confirmed company result to an uncertain plan without performing Odoo writes.
   * @param id Plan whose company creation requires reconciliation.
   * @param expectedRevision Exact version reviewed by the owner.
   * @param companyId Company explicitly selected and confirmed by the owner.
   * @param signal Cancels read-only verification before saving the selection.
   * @returns The recoverable plan; initialization still requires its separate execution confirmation.
   */
  @Remote
  async reconcile(id: LedgerSetupPlanId, expectedRevision: number, companyId: number, signal: AbortSignal): Promise<LedgerSetupSnapshot> {
    this.owner()
    return this.serialize(async () => {
      const plan = this.plan(id, expectedRevision)
      if (plan.status !== 'uncertain' || plan.companyId !== undefined) {
        throw financeRemoteError('in-use', 'Only an uncertain company creation can be reconciled.')
      }
      input(z.number().int().positive(), companyId)
      const { connection, key, options } = await this.verifiedConnection(signal, plan.identity)
      const { country, currency } = await getOdooSetupChoices(connection, key, plan, options)
      await verifyOdooSetupCandidate(connection, key, {
        name: plan.name, ...(plan.taxId === undefined ? {} : { taxId: plan.taxId }),
        companyId, countryId: country.id, currencyId: currency.id, templateCode: plan.templateCode,
      }, options)
      options.signal.throwIfAborted()
      await this.replace({ ...plan, companyId, companyReconciledAt: new Date().toISOString(), status: 'blocked', failure: undefined })
      return this.view()
    })
  }

  /**
   * Validate an uploaded chart and save its normalized rows on the expected draft.
   * @param id Setup plan that receives the workbook.
   * @param expectedRevision Plan revision reviewed before the upload.
   * @param fileName Workbook label displayed on the approval.
   * @param workbookBase64 XLSX bytes encoded by the owner UI.
   * @returns The redacted snapshot after the workbook is accepted.
   */
  @Remote
  async uploadChart(id: LedgerSetupPlanId, expectedRevision: number, fileName: string, workbookBase64: string): Promise<LedgerSetupSnapshot> {
    this.owner()
    return this.serialize(async () => {
      const plan = this.plan(id, expectedRevision)
      if (plan.mode !== 'custom-chart' || (plan.status !== 'draft' && !(plan.status === 'blocked' && plan.customChartEditable))) {
        throw financeRemoteError('in-use', 'The chart cannot be changed after import may have started.')
      }
      if (typeof workbookBase64 !== 'string' || workbookBase64.length > Math.ceil(FINANCE_SETUP_CHART_MAX_BYTES / 3) * 4) {
        throw new RemoteError('xiaojing/ledger-setup-chart', 'The workbook is too large.', { reason: 'size' })
      }
      const name = input(z.string().trim().min(1).max(160), fileName)
      const bytes = Buffer.from(workbookBase64, 'base64')
      try {
        if (bytes.toString('base64') !== workbookBase64) throw new FinanceSetupChartError('workbook')
        const rows = await parseFinanceSetupChart(bytes)
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        await this.replace({ ...plan, rows: [...rows], customChart: { name, sha256 }, failure: undefined })
      } catch (error) {
        if (error instanceof FinanceSetupChartError) {
          throw new RemoteError('xiaojing/ledger-setup-chart', error.message, {
            reason: error.reason, ...(error.row === undefined ? {} : { row: error.row }),
          })
        }
        throw error
      }
      return this.view()
    })
  }

  /**
   * Execute the owner-approved plan and durably record the resulting company and readiness.
   * @param id Plan to execute.
   * @param expectedRevision Exact revision presented for confirmation.
   * @param signal Cancels work before writes or leaves the dispatched step for reconciliation.
   * @returns The current snapshot including the plan's settled status.
   */
  @Remote
  async execute(id: LedgerSetupPlanId, expectedRevision: number, signal: AbortSignal): Promise<LedgerSetupSnapshot> {
    this.owner()
    return this.serialize(async () => {
      let plan = this.plan(id, expectedRevision)
      if (plan.status !== 'draft' && plan.status !== 'blocked') {
        throw financeRemoteError('in-use', 'This setup plan cannot be executed again.')
      }
      if (plan.mode === 'custom-chart' && plan.rows.length === 0) {
        throw financeRemoteError('invalid-input', 'Upload and validate the custom chart before confirming the plan.')
      }
      const { connection, key, options } = await this.verifiedConnection(signal, plan.identity)
      const { country, currency, templates } = await getOdooSetupChoices(connection, key, plan, options)
      if (!templates.some(item => item.code === plan.templateCode && item.name === plan.templateName)) {
        throw financeRemoteError('ledger-mismatch', 'The approved Odoo accounting template is no longer available.')
      }
      options.signal.throwIfAborted()
      const importPreviouslyStarted = plan.customImportStarted === true
      plan = await this.replace({ ...plan, status: 'running', failure: undefined, customChartEditable: undefined })
      let createdId = plan.companyId
      try {
        if (createdId === undefined) {
          const { name, taxId, openingDate } = plan
          createdId = await createOdooSetupCompany(connection, key, {
            name, countryId: country.id, currencyId: currency.id, openingDate, ...(taxId === undefined ? {} : { taxId }),
          }, options)
          plan = await this.replace({ ...plan, companyId: createdId })
        }
        const target = { companyId: createdId, countryId: country.id, currencyId: currency.id,
          templateCode: plan.templateCode, openingDate: plan.openingDate }
        let result = plan.existingCompanyId !== undefined || plan.companyReconciledAt !== undefined
          ? await initializeOdooExistingSetupCompany(connection, key, {
            ...target, name: plan.name, ...(plan.taxId === undefined ? {} : { taxId: plan.taxId }),
          }, options)
          : await initializeOdooSetupCompany(connection, key, target, options)
        if (plan.mode === 'custom-chart') {
          if (!plan.customImportStarted) plan = await this.replace({ ...plan, customImportStarted: true })
          await importOdooSetupAccounts(connection, key, { companyId: createdId, rows: plan.rows }, options)
          result = await verifyOdooSetupCompany(connection, key, target, options)
        }
        await this.replace({ ...plan, status: 'ready', company: result.company, accountCount: result.accounts, journalCount: result.journals })
      } catch (error) {
        const failure: FinanceFailureReason = error instanceof FinanceConnectionError ? error.reason : 'storage'
        const status = createdId === undefined && (failure === 'unknown-outcome' || failure === 'storage') ? 'uncertain' : 'blocked'
        if (!(error instanceof FinanceConnectionError)) this.ctx.logger.warn('Ledger setup could not record a confirmed step.')
        const editable = error instanceof OdooSetupAccountConflict && !importPreviouslyStarted
        await this.replace({ ...plan, companyId: createdId, status, failure,
          ...(editable ? { customChartEditable: true, customImportStarted: false } : {}),
        })
      }
      return this.view()
    })
  }

  /**
   * Verify a separate bookkeeping account and publish its company in finance connectors.
   * @param id Ready plan to add.
   * @param request Access mode and bookkeeping account key.
   * @param signal Cancels account verification before the connector save is accepted.
   * @returns The redacted snapshot with registration confirmed after the connector is saved.
   */
  @Remote
  async addConnector(id: LedgerSetupPlanId, request: LedgerSetupConnectorInput, signal: AbortSignal): Promise<LedgerSetupSnapshot> {
    this.owner()
    return this.serialize(async () => {
      const registration = input(z.strictObject({ accessMode: z.enum(['read-only', 'full']), apiKey: keySchema }), request)
      const plan = this.plan(id)
      if (plan.status === 'handed-off') return this.view()
      const company = plan.company
      if (plan.status !== 'ready' || company === undefined) {
        throw financeRemoteError('in-use', 'Wait until the ledger is ready before adding its connector.')
      }
      const finance = this.ctx.katcatsTeam.finance
      if (!finance) throw financeRemoteError('unsupported', 'Finance connectors are unavailable.')
      const { connection, key, options } = await this.verifiedConnection(signal, plan.identity)
      const { country, currency } = await getOdooSetupChoices(connection, key, plan, options)
      await verifyOdooSetupCompany(connection, key, {
        companyId: company.id, countryId: country.id, currencyId: currency.id,
        templateCode: plan.templateCode, openingDate: plan.openingDate,
      }, options)
      if (plan.mode === 'custom-chart') {
        await verifyOdooSetupAccounts(connection, key, { companyId: company.id, rows: plan.rows }, options)
      }
      const bookkeepingUser = await verifyOdooSetupHandoffUser(connection, registration.apiKey, {
        companyId: company.id, requireCreate: registration.accessMode === 'full',
      }, options)
      if (bookkeepingUser === connection.identity.userId) {
        throw financeRemoteError('permissions', 'Use a different Odoo account with access to the new company for bookkeeping.')
      }
      options.signal.throwIfAborted()
      await finance.save({
        url: connection.url, database: connection.database, name: company.name, companyId: company.id,
        accessMode: registration.accessMode, apiKey: registration.apiKey,
      }, options.signal, { id: brandString<FinanceConnectorId>(plan.id), databaseUuid: connection.identity.databaseUuid })
      await this.replace({ ...plan, status: 'handed-off' })
      return this.view()
    })
  }
}

export default XiaojingLedgerSetup
