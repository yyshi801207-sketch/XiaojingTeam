/** Persisted connector configuration and company-scoped access to Odoo. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialKey, credentialKeyScope, parseCredentialKey, type CredentialKey, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { defineDomain, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { z } from 'zod'
import type { ChatId } from './chats-types.ts'
import type { BotId } from './types.ts'
import {
  discoverOdooCompanies, FinanceConnectionError, financeOdooAccountSchema, type FinanceRequestOptions, isFinanceOrmReadOnlyMethod,
  normalizeFinanceEndpoint, odooOrmBody, prepareOdooOrmCall, readOdooDatabaseUuid, runOdooExport, runOdooOrmCall, runOdooQuery,
  verifyOdooConnector,
} from './finance-odoo.ts'
import {
  financeFailureReasons, type FinanceCapability, type FinanceCompany, type FinanceConnectionDraft, type FinanceConnector,
  type FinanceConnectorAccessHealth, type FinanceConnectorId, type FinanceConnectorSnapshot, type FinanceEndpoint,
  type FinanceExportQuery, type FinanceFailureReason,
  type FinanceOrmCallRequest, type FinanceOrmCallResult, type FinanceOrmWriteAuthorization,
  type FinanceQuery, type FinanceQueryResult, type GroupFinanceQueryResult, type SaveFinanceConnectorRequest,
} from './finance-types.ts'

const CREDENTIAL_SCOPE = 'xiaojing-finance'
const CAPABILITIES: readonly FinanceCapability[] = ['accounts', 'journals', 'moves', 'move-lines', 'entries', 'turnover']
const connectorId = z.uuid().transform(id => brandString<FinanceConnectorId>(id))
const address = z.string().trim().min(1).max(2048)
const database = z.string().trim().min(1).max(128)
const keyValue = z.string().trim().min(1).max(4096).regex(/^[\x21-\x7e]+$/)
const companyId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const accessMode = z.enum(['read-only', 'full'])
const draftSchema = z.object({ id: connectorId.optional(), url: address, database, apiKey: keyValue.optional(), accessMode: accessMode.optional() }).strict()
const name = z.string().trim().min(1).max(100)
const saveSchema = draftSchema.extend({ name, companyId })
const companySchema = z.object({ id: companyId, name: z.string().min(1), currency: z.string().min(1) })
const storedSchema = z.object({
  id: connectorId, name, type: z.literal('odoo'), url: address, database, company: companySchema,
  lastTestAt: z.iso.datetime(), failure: z.enum(financeFailureReasons).nullable(),
  credential: z.string().regex(/^xiaojing-finance\/key-[0-9a-f-]{36}$/).transform(parseCredentialKey),
  accessMode: accessMode.default('read-only'),
  account: financeOdooAccountSchema.optional(),
  ledgerProof: z.object({ databaseUuid: z.uuid(), taskScopeKey: z.string().regex(/^[0-9a-f]{64}$/) }).optional(),
})
type StoredConnector = z.output<typeof storedSchema>

const stateSchema = z.object({
  connectors: z.array(storedSchema),
  bindings: z.array(z.object({
    chatId: z.string().min(1).transform(id => brandString<ChatId>(id)), connectorId,
  })),
  botBindings: z.array(z.object({
    botId: z.string().min(1).transform(id => brandString<BotId>(id)), connectorId,
  })).default([]),
}).refine(state => new Set(state.connectors.map(row => row.id)).size === state.connectors.length
  && new Set(state.bindings.map(row => row.chatId)).size === state.bindings.length
  && new Set(state.botBindings.map(row => row.botId)).size === state.botBindings.length
  && [...state.bindings, ...state.botBindings].every(binding => state.connectors.some(row => row.id === binding.connectorId)), 'invalid connector bindings')

const financeDomainSpec = defineDomain({
  name: 'xiaojing_finance_connectors', version: 1,
  global: { schema: stateSchema, initial: { connectors: [], bindings: [], botBindings: [] } },
  tables: {},
})

function view(row: StoredConnector, accessHealth?: FinanceConnectorAccessHealth): FinanceConnector {
  return {
    id: row.id, type: row.type, name: row.name, url: row.url, database: row.database, company: row.company,
    lastTestAt: row.lastTestAt, failure: row.failure, capabilities: CAPABILITIES, accessMode: row.accessMode,
    ...(row.account?.login === undefined ? {} : { account: { login: row.account.login } }),
    ...(accessHealth === undefined ? {} : { accessHealth }),
  }
}

/**
 * Build the secret-free Remote failure consumed by connector and group surfaces.
 * @param reason - stable handling classification.
 * @param message - safe operation summary.
 * @returns the typed failure.
 */
export function financeRemoteError(reason: FinanceFailureReason, message: string): RemoteError<'xiaojing/finance-connector'> {
  return new RemoteError('xiaojing/finance-connector', message, { reason })
}

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw financeRemoteError('invalid-input', 'Check the connector settings and try again.')
  return parsed.data
}

function sameEndpoint(left: FinanceEndpoint, right: FinanceEndpoint): boolean {
  return left.url === right.url && left.database === right.database
}

function taskScopeKey(row: StoredConnector): string {
  return row.ledgerProof?.taskScopeKey ?? createHash('sha256')
    .update(JSON.stringify([row.id, row.type, row.url, row.database, row.company.id])).digest('hex')
}

function isTransientFailure(reason: FinanceFailureReason | null): boolean {
  return reason === 'network' || reason === 'timeout'
}

/** Owns connector and binding commits, credential references, and authenticated Odoo operations. */
export class FinanceConnections {
  /** Resolves when the connector directory is available. */
  readonly ready: Promise<void>
  private domain: Domain<typeof financeDomainSpec> | undefined
  private tail = Promise.resolve()
  private readonly stopping = new AbortController()
  private readonly reads = new Set<Promise<unknown>>()
  private readonly access = new Map<FinanceConnectorId, { generation: number; health?: FinanceConnectorAccessHealth }>()
  private readonly followers = new Set<() => void>()
  private revision = 0

  constructor(ctx: Context, private readonly credentials: CredentialProvider, private readonly timeoutMs: number) {
    this.ready = ctx.storageDomain.open(financeDomainSpec).then(async domain => {
      this.domain = domain
      // Each key version has a unique address. Interrupted saves may leave an unreferenced key.
      const used = new Set(this.state.connectors.map(row => row.credential))
      try {
        for (const record of await credentials.listRecords()) {
          if (credentialKeyScope(record.key) === CREDENTIAL_SCOPE && !used.has(record.key)) await this.discard(record.key)
        }
      } catch {
        ctx.logger.warn('Finance connector credential cleanup could not be completed.')
      }
    })
    this.warnCleanup = () => ctx.logger.warn('Finance connector credential cleanup will be retried on restart.')
  }

  private readonly warnCleanup: () => void

  private get state(): z.output<typeof stateSchema> {
    if (!this.domain) throw new Error('Finance connectors are not initialized.')
    return this.domain.global.get()
  }

  private async commit(state: z.output<typeof stateSchema>): Promise<void> {
    if (!this.domain) throw new Error('Finance connectors are not initialized.')
    try {
      await this.domain.global.set(state)
    } catch {
      throw financeRemoteError('storage', 'Could not save finance settings. Reopen the page and check the current settings before retrying.')
    }
  }

  private async discard(key: CredentialKey): Promise<void> {
    try {
      await this.credentials.deleteRecord(key)
    } catch {
      this.warnCleanup()
    }
  }

  private async secret(row: StoredConnector): Promise<string> {
    try {
      const record = await this.credentials.readRecord(row.credential)
      if (record?.kind === 'api-key' && record.key) return record.key
    } catch {
      throw new FinanceConnectionError('credential', 'Could not open the stored API key. Check the credential store.')
    }
    throw new FinanceConnectionError('credential', 'Enter an API key for this connection.')
  }

  private row(id: FinanceConnectorId): StoredConnector {
    const row = this.state.connectors.find(candidate => candidate.id === id)
    if (!row) throw financeRemoteError('not-found', 'This finance connection is no longer available.')
    return row
  }

  private async reported<T>(operation: () => Promise<T>): Promise<T> {
    try {
      await this.ready
      if (this.stopping.signal.aborted) throw financeRemoteError('cancelled', 'The finance connector is closing.')
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

  private read<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.reported(operation)
    this.reads.add(result)
    void result.then(() => this.reads.delete(result), () => this.reads.delete(result))
    return result
  }

  private options(signal?: AbortSignal): { signal: AbortSignal; timeoutMs: number } {
    return {
      signal: signal ? AbortSignal.any([signal, this.stopping.signal]) : this.stopping.signal,
      timeoutMs: this.timeoutMs,
    }
  }

  private async observe<T>(id: FinanceConnectorId, options: FinanceRequestOptions,
    run: (options: FinanceRequestOptions) => Promise<T>): Promise<T> {
    const generation = this.access.get(id)?.generation ?? 0
    let outcome: FinanceConnectorAccessHealth['outcome'] | undefined
    try {
      return await run({ ...options, observeAccess: observed => { outcome = observed } })
    } finally {
      const previous = this.access.get(id)
      if (outcome !== undefined && !this.stopping.signal.aborted && generation === (previous?.generation ?? 0)
        && this.state.connectors.some(row => row.id === id)) {
        const checkedAt = new Date().toISOString()
        if (previous?.health?.checkedAt !== checkedAt || previous.health.outcome !== outcome) {
          this.access.set(id, { generation, health: { checkedAt, outcome } })
          this.notify()
        }
      }
    }
  }

  private notify(): void {
    this.revision++
    for (const wake of this.followers) wake()
  }

  private async candidate(draft: z.output<typeof draftSchema>): Promise<{
    endpoint: FinanceEndpoint; key: string; previous: StoredConnector | undefined
  }> {
    const endpoint = normalizeFinanceEndpoint(draft)
    const previous = draft.id === undefined ? undefined : this.row(draft.id)
    if (draft.apiKey !== undefined) return { endpoint, key: draft.apiKey, previous }
    if (!previous || previous.database !== endpoint.database) {
      throw financeRemoteError('credential', 'Enter an API key for this database.')
    }
    return { endpoint, key: await this.secret(previous), previous }
  }

  private async verifyAddressMigration(previous: StoredConnector, endpoint: FinanceEndpoint, key: string,
    options: FinanceRequestOptions): Promise<string> {
    const readIdentity = async (target: FinanceEndpoint, readKey: () => Promise<string>, message: string) => {
      try {
        return await readOdooDatabaseUuid(target, await readKey(), options)
      } catch (error) {
        if (!(error instanceof FinanceConnectionError) || error.reason === 'cancelled') throw error
        throw financeRemoteError('ledger-unverified', message)
      }
    }
    const original = previous.ledgerProof?.databaseUuid ?? await readIdentity(previous, () => this.secret(previous),
      'Could not verify the database identity at the saved address. Check access to the original Odoo server.')
    const destination = await readIdentity(endpoint, async () => key,
      'Could not verify the database identity at the new address. Check the address and Odoo access.')
    if (original !== destination) throw financeRemoteError('ledger-mismatch', 'The new address points to a different Odoo database.')
    return destination
  }

  /**
   * List persisted configurations and their last test results.
   * @returns all connections with credentials omitted.
   */
  snapshot(): Promise<FinanceConnectorSnapshot> {
    return this.reported(async () => this.snapshotValue())
  }

  private snapshotValue(): FinanceConnectorSnapshot {
    return { connectors: this.state.connectors.map(row => view(row, this.access.get(row.id)?.health)) }
  }

  /**
   * Follow connector changes and observed access from one baseline.
   * @param signal - Caller-owned cancellation.
   * @returns Complete current snapshots until cancellation or connector shutdown.
   */
  async *follow(signal: AbortSignal): AsyncIterable<FinanceConnectorSnapshot> {
    await this.ready
    const lifetime = AbortSignal.any([signal, this.stopping.signal])
    let seen = -1
    while (!lifetime.aborted) {
      if (seen !== this.revision) {
        seen = this.revision
        yield this.snapshotValue()
        continue
      }
      const next = Promise.withResolvers<void>()
      const wake = () => { next.resolve() }
      this.followers.add(wake)
      lifetime.addEventListener('abort', wake, { once: true })
      try { await next.promise } finally { this.followers.delete(wake); lifetime.removeEventListener('abort', wake) }
    }
  }

  /**
   * Read the companies the draft credential can access.
   * @param draft - proposed endpoint and credential.
   * @param signal - cancels the request when the caller leaves.
   * @returns the companies offered for selection.
   */
  discover(draft: FinanceConnectionDraft, signal?: AbortSignal): Promise<readonly FinanceCompany[]> {
    return this.read(async () => {
      const parsed = input(draftSchema, draft)
      const { endpoint, key, previous } = await this.candidate(parsed)
      const options = this.options(signal)
      if (previous && parsed.apiKey === undefined && !sameEndpoint(previous, endpoint)) {
        await this.verifyAddressMigration(previous, endpoint, key, options)
      }
      return discoverOdooCompanies(endpoint, key, options)
    })
  }

  /**
   * Verify the exact company before publishing a connector.
   * @param request - proposed configuration.
   * @param signal - cancels validation before the accepted save.
   * @param reservation - internal setup handoff identity and verified Odoo database UUID, when applicable.
   * @returns the saved public configuration.
   */
  save(request: SaveFinanceConnectorRequest, signal?: AbortSignal,
    reservation?: { readonly id: FinanceConnectorId; readonly databaseUuid: string }): Promise<FinanceConnector> {
    return this.serialize(async () => {
      const reserved = reservation && this.state.connectors.find(row => row.id === reservation.id)
      if (reserved && (reserved.company.id !== request.companyId || !sameEndpoint(reserved, request)
        || reserved.ledgerProof?.databaseUuid !== reservation.databaseUuid)) {
        throw financeRemoteError('ledger-mismatch', 'The prepared handoff connection changed. Check the ledger before retrying.')
      }
      const draft = input(saveSchema, reserved ? { ...request, id: reserved.id } : request)
      const { endpoint, key, previous } = await this.candidate(draft)
      const options = this.options(signal)
      let ledgerProof: StoredConnector['ledgerProof']
      if (previous) {
        const sameLedgerSelection = previous.database === endpoint.database && previous.company.id === draft.companyId
        const bound = this.isBound(previous.id)
        if (bound && !sameLedgerSelection) this.requireUnbound(previous.id)
        if (sameEndpoint(previous, endpoint)) {
          if (sameLedgerSelection) ledgerProof = previous.ledgerProof
        } else if (bound || draft.apiKey === undefined) {
          const databaseUuid = await this.verifyAddressMigration(previous, endpoint, key, options)
          if (sameLedgerSelection) ledgerProof = { databaseUuid, taskScopeKey: taskScopeKey(previous) }
        }
      }
      const { company, account } = await verifyOdooConnector(endpoint, key, draft.companyId, options)
      if (options.signal.aborted) throw financeRemoteError('cancelled', 'The connection test was cancelled.')
      const credential = draft.apiKey === undefined && previous
        ? previous.credential
        : credentialKey(CREDENTIAL_SCOPE, `key-${randomUUID()}`)
      if (credential !== previous?.credential) {
        try {
          await this.credentials.modifyRecord(credential, async () => ({ kind: 'api-key', key }))
        } catch {
          throw financeRemoteError('credential', 'Could not save the API key. Check the credential store.')
        }
      }
      const row: StoredConnector = {
        ...endpoint, id: previous?.id ?? reservation?.id ?? brandString<FinanceConnectorId>(randomUUID()), name: draft.name,
        type: 'odoo', company, account, lastTestAt: new Date().toISOString(), failure: null, credential,
        accessMode: draft.accessMode ?? previous?.accessMode ?? 'read-only',
        ...(ledgerProof === undefined ? {} : { ledgerProof }),
      }
      const verified = reservation && row.ledgerProof === undefined
        ? { ...row, ledgerProof: { databaseUuid: reservation.databaseUuid, taskScopeKey: taskScopeKey(row) } } : row
      await this.replace(verified)
      if (previous && previous.credential !== credential) await this.discard(previous.credential)
      return view(verified)
    })
  }

  private async replace(row: StoredConnector, health?: FinanceConnectorAccessHealth): Promise<void> {
    const state = this.state
    const rows = state.connectors.some(candidate => candidate.id === row.id)
      ? state.connectors.map(candidate => candidate.id === row.id ? row : candidate)
      : [...state.connectors, row]
    await this.commit({ ...state, connectors: rows })
    this.access.set(row.id, { generation: this.revision + 1, ...(health === undefined ? {} : { health }) })
    this.notify()
  }

  /**
   * Recheck a saved connector and record the result of this test.
   * @param id - saved connector identity.
   * @param signal - cancels the verification without changing the last result.
   * @returns the latest stored connection status.
   */
  test(id: FinanceConnectorId, signal?: AbortSignal): Promise<FinanceConnector> {
    return this.serialize(async () => {
      const { account: _priorAccount, ...current } = this.row(id)
      const options = this.options(signal)
      let company = current.company
      let account: StoredConnector['account']
      let failure: FinanceFailureReason | null = null
      try {
        const verified = await verifyOdooConnector(current, await this.secret(current), company.id, options)
        company = verified.company
        account = verified.account
      } catch (error) {
        if (error instanceof FinanceConnectionError) failure = error.reason
        if (failure === null || failure === 'cancelled') throw error
      }
      if (options.signal.aborted) throw financeRemoteError('cancelled', 'The connection test was cancelled.')
      const row = { ...current, company, account, failure, lastTestAt: new Date().toISOString() }
      const outcome = failure === null ? 'reachable' : isTransientFailure(failure) ? 'unreachable' : undefined
      const health: FinanceConnectorAccessHealth | undefined = outcome === undefined ? undefined : { checkedAt: row.lastTestAt, outcome }
      await this.replace(row, health)
      return view(row, health)
    })
  }

  private isBound(id: FinanceConnectorId): boolean {
    const { bindings, botBindings } = this.state
    return bindings.some(binding => binding.connectorId === id) || botBindings.some(binding => binding.connectorId === id)
  }

  private requireUnbound(id: FinanceConnectorId): void {
    if (this.isBound(id)) {
      throw financeRemoteError('in-use', 'Unbind this connection in the group and Bot settings before changing its database or company, or removing it.')
    }
  }

  /**
   * Remove a connector with no group or Bot bindings.
   * @param id - saved connector identity.
   */
  remove(id: FinanceConnectorId): Promise<void> {
    return this.serialize(async () => {
      const row = this.row(id)
      this.requireUnbound(id)
      await this.commit({ ...this.state, connectors: this.state.connectors.filter(candidate => candidate.id !== id) })
      this.access.delete(id)
      this.notify()
      await this.discard(row.credential)
    })
  }

  /**
   * Project group binding presence without exposing connector identities.
   * @returns Groups with a saved ledger binding after connector initialization.
   */
  boundChatIds(): readonly ChatId[] {
    return this.state.bindings.map(binding => binding.chatId)
  }

  /**
   * Read the connection selected for one group.
   * @param chatId - existing group identity.
   * @returns the bound connector identity, or null.
   */
  getBinding(chatId: ChatId): Promise<FinanceConnectorId | null> {
    return this.reported(async () => this.binding(chatId))
  }

  /**
   * Identify the accounting target without exposing its address or credentials.
   * @param chatId - Group whose saved target is being captured.
   * @returns The target fingerprint and display label, or null when unbound.
   */
  groupTaskScope(chatId: ChatId): { readonly key: string; readonly label: string } | null {
    const id = this.binding(chatId)
    if (id === null) return null
    const row = this.row(id)
    return { key: taskScopeKey(row), label: row.company.name }
  }

  private binding(chatId: ChatId): FinanceConnectorId | null {
    return this.state.bindings.find(entry => entry.chatId === chatId)?.connectorId ?? null
  }

  /**
   * Update one group binding without changing the connector's company.
   * @param chatId - existing group identity, validated by the group directory.
   * @param id - verified connector identity, or null to disconnect the group.
   */
  bind(chatId: ChatId, id: FinanceConnectorId | null): Promise<void> {
    return this.serialize(async () => {
      this.requireVerified(id)
      if (this.binding(chatId) === id) return
      const bindings = this.state.bindings.filter(entry => entry.chatId !== chatId)
      if (id !== null) bindings.push({ chatId, connectorId: id })
      await this.commit({ ...this.state, bindings })
    })
  }

  /**
   * Remove bindings whose groups no longer exist after directory recovery.
   * @param activeChatIds - the authoritative group IDs.
   */
  pruneBindings(activeChatIds: readonly ChatId[]): Promise<void> {
    return this.serialize(async () => {
      const active = new Set(activeChatIds)
      const bindings = this.state.bindings.filter(entry => active.has(entry.chatId))
      if (bindings.length !== this.state.bindings.length) await this.commit({ ...this.state, bindings })
    })
  }

  /**
   * Read the connection selected for one Bot's private conversations.
   * @param botId - existing eligible Bot identity.
   * @returns the bound connector identity, or null.
   */
  getBotBinding(botId: BotId): Promise<FinanceConnectorId | null> {
    return this.reported(async () => this.botBinding(botId))
  }

  private botBinding(botId: BotId): FinanceConnectorId | null {
    return this.state.botBindings.find(entry => entry.botId === botId)?.connectorId ?? null
  }

  /**
   * Describe the latest saved finance scope for an executing group member.
   * @param chatId - Active group identity.
   * @returns Model context containing only non-secret ledger metadata.
   */
  groupPrompt(chatId: ChatId): string {
    return this.bindingPrompt(this.binding(chatId))
  }

  /**
   * Describe the latest saved finance scope for a private finance Bot.
   * @param botId - Active private Bot identity.
   * @returns Model context containing only non-secret ledger metadata.
   */
  botPrompt(botId: BotId): string {
    return this.bindingPrompt(this.botBinding(botId))
  }

  private bindingPrompt(id: FinanceConnectorId | null): string {
    const history = 'Treat earlier finance replies, figures, files and record IDs as historical. '
      + 'For current data or a follow-up using earlier IDs, query the active ledger again. '
      + 'Verify current connectivity through a successful finance tool call before claiming it.'
    if (id === null) return 'Current finance ledger for this conversation is unbound. ' + history
    const { name, type, company, accessMode } = this.row(id)
    return 'Current finance ledger for this conversation (saved settings): '
      + JSON.stringify({ connector: { id, name, type }, company, accessMode }) + '. '
      + 'Use this company when identifying the active ledger, including on simple replies. ' + history
  }

  private requireVerified(id: FinanceConnectorId | null): void {
    if (id === null) return
    const { failure } = this.row(id)
    if (failure !== null && !(isTransientFailure(failure) && this.access.get(id)?.health?.outcome === 'reachable')) {
      throw financeRemoteError('credential', 'Test this connection successfully before binding it.')
    }
  }

  /**
   * Update a Bot's private binding without changing its group's connections.
   * @param botId - existing eligible Bot identity, validated by the Bot directory.
   * @param id - verified connector identity, or null to disconnect the Bot.
   */
  bindBot(botId: BotId, id: FinanceConnectorId | null): Promise<void> {
    return this.serialize(async () => {
      this.requireVerified(id)
      if (this.botBinding(botId) === id) return
      const botBindings = this.state.botBindings.filter(entry => entry.botId !== botId)
      if (id !== null) botBindings.push({ botId, connectorId: id })
      await this.commit({ ...this.state, botBindings })
    })
  }

  /**
   * Remove bindings for Bots absent from the recovered eligible directory.
   * @param activeBotIds - the authoritative eligible Bot IDs.
   */
  pruneBotBindings(activeBotIds: readonly BotId[]): Promise<void> {
    return this.serialize(async () => {
      const active = new Set(activeBotIds)
      const botBindings = this.state.botBindings.filter(entry => active.has(entry.botId))
      if (botBindings.length !== this.state.botBindings.length) await this.commit({ ...this.state, botBindings })
    })
  }

  /**
   * Read only from the connection selected for this group.
   * @param chatId - group derived from the active Agent binding.
   * @param query - bounded accounting operation.
   * @param signal - cancels the in-flight tool request.
   * @returns company-scoped ledger results.
   */
  query(chatId: ChatId, query: FinanceQuery, signal?: AbortSignal): Promise<GroupFinanceQueryResult> {
    return this.queryBinding(() => this.binding(chatId), 'group', signal,
      (row, key, options) => runOdooQuery(row, key, row.company, query, options))
  }

  /**
   * Read only from the connection selected for this Bot's private conversations.
   * @param botId - Bot derived from the active private Agent binding.
   * @param query - bounded accounting operation.
   * @param signal - cancels the in-flight tool request.
   * @returns company-scoped ledger results.
   */
  queryBot(botId: BotId, query: FinanceQuery, signal?: AbortSignal): Promise<GroupFinanceQueryResult> {
    return this.queryBinding(() => this.botBinding(botId), 'Bot', signal,
      (row, key, options) => runOdooQuery(row, key, row.company, query, options))
  }

  /**
   * Read the complete bounded dataset from this Bot's selected private connection.
   * @param botId - Bot derived from the active private Agent binding.
   * @param query - Accounting scope to export, including all matching pages.
   * @param signal - cancels the complete read operation.
   * @returns Company-scoped rows or a failure with no partial dataset.
   */
  exportBotRows(botId: BotId, query: FinanceExportQuery, signal?: AbortSignal): Promise<GroupFinanceQueryResult> {
    return this.queryBinding(() => this.botBinding(botId), 'Bot', signal,
      (row, key, options) => runOdooExport(row, key, row.company, query, options))
  }

  /**
   * Read the complete bounded dataset from this group's selected connection.
   * @param chatId - group derived from the active Agent binding.
   * @param query - Accounting scope to export, including all matching pages.
   * @param signal - cancels the complete read operation.
   * @returns Company-scoped rows or a failure with no partial dataset.
   */
  exportGroupRows(chatId: ChatId, query: FinanceExportQuery, signal?: AbortSignal): Promise<GroupFinanceQueryResult> {
    return this.queryBinding(() => this.binding(chatId), 'group', signal,
      (row, key, options) => runOdooExport(row, key, row.company, query, options))
  }

  /**
   * Call a public ORM method on the connection selected for this Bot.
   * @param botId - Bot derived from the active private Agent binding.
   * @param request - Method and JSON-2 arguments.
   * @param authorizeWrite - Human confirmation for methods outside the built-in read set.
   * @param signal - Cancels the pending operation.
   * @returns The bounded response and its actual connector and company.
   */
  callOrmBot(botId: BotId, request: FinanceOrmCallRequest, authorizeWrite: FinanceOrmWriteAuthorization | undefined,
    signal?: AbortSignal): Promise<FinanceOrmCallResult> {
    return this.callOrmBinding(() => this.botBinding(botId), 'Bot', request, authorizeWrite, signal)
  }

  /**
   * Call a public ORM method on the connection selected for this group.
   * @param chatId - Group derived from the active Agent binding.
   * @param request - Method and JSON-2 arguments.
   * @param authorizeWrite - Human confirmation for methods outside the built-in read set.
   * @param signal - Cancels the pending operation.
   * @returns The bounded response and its actual connector and company.
   */
  callOrmGroup(chatId: ChatId, request: FinanceOrmCallRequest, authorizeWrite: FinanceOrmWriteAuthorization | undefined,
    signal?: AbortSignal): Promise<FinanceOrmCallResult> {
    return this.callOrmBinding(() => this.binding(chatId), 'group', request, authorizeWrite, signal)
  }

  private callOrmBinding(lookup: () => FinanceConnectorId | null, scope: 'group' | 'Bot', request: FinanceOrmCallRequest,
    authorizeWrite: FinanceOrmWriteAuthorization | undefined, signal?: AbortSignal): Promise<FinanceOrmCallResult> {
    return this.read(async () => {
      const method = prepareOdooOrmCall(request)
      const id = lookup()
      if (id === null) throw financeRemoteError('unbound', `Bind a verified finance connection in this ${scope}’s settings.`)
      const row = this.row(id)
      if (row.failure !== null && !isTransientFailure(row.failure)) {
        throw financeRemoteError(row.failure, 'Test and repair the bound finance connection.')
      }
      const options = this.options(signal)
      const checkConnection = (): void => {
        if (options.signal.aborted) throw financeRemoteError('cancelled', 'The Odoo operation was cancelled.')
        const current = this.state.connectors.find(candidate => candidate.id === id)
        if (lookup() !== id || current?.credential !== row.credential || current.company.id !== row.company.id
          || current.accessMode !== row.accessMode || current.failure !== row.failure || !sameEndpoint(current, row)) {
          throw financeRemoteError('unbound', `The connection changed before this operation could be confirmed. Check the ${scope} binding.`)
        }
      }
      const readOnly = isFinanceOrmReadOnlyMethod(method.method)
      let recheckWrite: void | (() => Promise<void>)
      const send = async (): Promise<FinanceOrmCallResult> => {
        checkConnection()
        const key = await this.secret(row)
        checkConnection()
        if (recheckWrite !== undefined) {
          await recheckWrite()
          checkConnection()
        }
        const data = await this.observe(id, options, observed => runOdooOrmCall(row, key, row.company, method, observed))
        if (readOnly) checkConnection()
        return { connector: { id, name: row.name, type: row.type }, company: row.company, model: method.model, method: method.method, data }
      }
      if (readOnly) return send()
      if (row.accessMode !== 'full' || authorizeWrite === undefined) {
        throw financeRemoteError('permissions', 'This method requires a full-access connector and explicit approval.')
      }
      checkConnection()
      recheckWrite = await authorizeWrite(view(row), options.signal, odooOrmBody(method, row.company.id))
      return this.serialize(send)
    })
  }

  private queryBinding(
    lookup: () => FinanceConnectorId | null,
    scope: 'group' | 'Bot',
    signal: AbortSignal | undefined,
    operation: (row: StoredConnector, key: string, options: FinanceRequestOptions) => Promise<FinanceQueryResult>,
  ): Promise<GroupFinanceQueryResult> {
    return this.read(async () => {
      const id = lookup()
      if (!id) throw financeRemoteError('unbound', `Bind a verified finance connection in this ${scope}’s settings.`)
      const row = this.row(id)
      if (row.failure !== null && !isTransientFailure(row.failure)) {
        throw financeRemoteError(row.failure, 'Test and repair the bound finance connection.')
      }
      const options = this.options(signal)
      const result = await this.observe(id, options, async observed => operation(row, await this.secret(row), observed))
      if (options.signal.aborted) throw financeRemoteError('cancelled', 'The finance query was cancelled.')
      const current = this.state.connectors.find(candidate => candidate.id === id)
      if (lookup() !== id || current?.credential !== row.credential || current.company.id !== row.company.id
        || current.failure !== row.failure || !sameEndpoint(current, row)) {
        throw financeRemoteError('unbound', `The connection changed during this query. Check the ${scope} binding and retry.`)
      }
      return { ...result, connector: { id, name: current.name, type: current.type } }
    })
  }

  /** Cancel requests and close the domain after in-flight operations settle. */
  async close(): Promise<void> {
    this.stopping.abort()
    await Promise.allSettled([this.ready, this.tail, ...this.reads])
    await this.domain?.close()
  }
}
