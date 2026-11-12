/** Odoo 19 JSON-2 requests and bounded ledger projections. */
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import type {
  FinanceCompany, FinanceConnectorAccessHealth, FinanceEndpoint, FinanceExportQuery, FinanceFailureReason, FinanceOdooAccount,
  FinanceOrmCallRequest, FinanceOrmJsonValue, FinanceQuery, FinanceQueryResult,
} from './finance-types.ts'

/** An Odoo connector failure with a message safe to display outside the transport. */
export class FinanceConnectionError extends Error {
  override readonly name = 'FinanceConnectionError'

  constructor(readonly reason: FinanceFailureReason, message: string) {
    super(message)
  }
}

/** The deadline covers all requests in a connector operation. */
export interface FinanceRequestOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs: number
  /** Observe a confirmed reply or transport failure without changing operation results. */
  readonly observeAccess?: (outcome: FinanceConnectorAccessHealth['outcome']) => void
}

const MAX_COMPANIES = 100
const MAX_BODY_BYTES = 512 * 1024
const MAX_QUERY_OFFSET = 10_000
const MAX_PAGE_SIZE = 100
const MAX_ORM_PARAMS_BYTES = 64 * 1024
const MAX_ORM_DEPTH = 24
const ORM_PAGED_METHODS = new Set(['search', 'search_read', 'name_search', 'formatted_read_group'])
const ORM_READ_METHODS = new Set([...ORM_PAGED_METHODS, 'fields_get', 'read', 'search_count'])
const id = z.number().int().positive()
const ormModelName = z.string().max(128).regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/)
const ormRecordIds = z.array(id).max(MAX_PAGE_SIZE)
const ormWizardContext = z.strictObject({
  active_model: ormModelName.optional(), active_id: id.optional(), active_ids: ormRecordIds.optional(),
}).default({})
const count = z.number().int().nonnegative()
const relation = z.tuple([id, z.string()])
const optionalRelation = z.union([relation, z.literal(false)])
const optionalText = z.union([z.string(), z.literal(false)])
const moveState = z.enum(['draft', 'posted', 'cancel'])
const companyRow = z.object({ id, name: z.string(), currency_id: relation })
const companyFields = ['id', 'name', 'currency_id']
const moveIdentity = z.object({ id, company_id: relation })
const debitCredit = z.object({ 'debit:sum': z.number(), 'credit:sum': z.number() })
const odooLogin = z.string().trim().min(1).max(512)

/** Stored account metadata from a successful Odoo verification. */
export const financeOdooAccountSchema = z.object({ login: odooLogin.optional() })

type Filter = readonly [field: string, operator: '=' | '!=' | 'in' | '>=' | '<=' | 'ilike', value: string | number | false | readonly number[]]
type Domain = readonly (Filter | '|')[]
type LedgerModel = 'account.account' | 'account.journal' | 'account.move' | 'account.move.line'
/**
 * Normalize the configured JSON-2 base URL and database header.
 * @param input User-entered URL and Odoo database name.
 * @returns The base without a trailing slash and the database header value.
 */
export function normalizeFinanceEndpoint(input: FinanceEndpoint): FinanceEndpoint {
  const raw = input.url.trim()
  const url = URL.parse(raw)
  const loopback = url?.hostname === '127.0.0.1' || url?.hostname === '[::1]'
  if (!url || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || raw.includes('?') || raw.includes('#')) {
    throw new FinanceConnectionError('invalid-address', 'Use an HTTPS Odoo address or an HTTP loopback tunnel, without credentials, query or fragment.')
  }
  const database = input.database.trim()
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(database)) {
    throw new FinanceConnectionError('database', 'Enter an Odoo database name using letters, digits, dots, hyphens or underscores.')
  }
  return { url: url.href.replace(/\/+$/, ''), database }
}

function invalidResponse(): FinanceConnectionError {
  return new FinanceConnectionError('invalid-response', 'Odoo returned an unexpected response for this operation.')
}

function read<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw invalidResponse()
  return parsed.data
}

async function readBody(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let bytes = 0
  let body = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return body + decoder.decode()
      bytes += chunk.value.byteLength
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel()
        throw invalidResponse()
      }
      body += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch (error) {
    if (error instanceof SyntaxError) throw invalidResponse()
    throw error
  }
}

function responseError(status: number, name: string | undefined, isJson: boolean): FinanceConnectionError {
  if (status === 401 || name === 'odoo.exceptions.AccessDenied') {
    return new FinanceConnectionError('authentication', 'Odoo rejected the API key. Check that the key is active and belongs to this database.')
  }
  if (status === 403) {
    return new FinanceConnectionError('permissions', 'Odoo denied this operation (HTTP 403). Check the connected user’s access rights.')
  }
  if (name === 'odoo.exceptions.MissingError') {
    return new FinanceConnectionError('not-found', 'The requested record is unavailable.')
  }
  if (status === 404 && !isJson) {
    return new FinanceConnectionError('database', 'Odoo did not find the database or JSON-2 endpoint. Check the database name and server address.')
  }
  if (status === 404 || status === 405 || status === 501) {
    return new FinanceConnectionError('unsupported', 'The server does not expose this Odoo 19 JSON-2 operation.')
  }
  if (status === 408 || status === 504) {
    return new FinanceConnectionError('timeout', 'The Odoo request timed out. Try again.')
  }
  if (status === 429 || status >= 500) {
    return new FinanceConnectionError('network', 'Odoo is temporarily unavailable. Try again.')
  }
  if (status === 422 && name === 'werkzeug.exceptions.UnprocessableEntity') {
    return new FinanceConnectionError('invalid-input', 'Odoo rejected the JSON-2 arguments (HTTP 422). Check the method’s keyword names and values.')
  }
  if ((status === 400 || status === 422) && (name === 'odoo.exceptions.ValidationError' || name === 'odoo.exceptions.UserError')) {
    return new FinanceConnectionError('invalid-input', `Odoo rejected the values or record state (HTTP ${status}). Check the operation against Odoo’s validation rules.`)
  }
  return invalidResponse()
}

function unknownWrite(): FinanceConnectionError {
  return new FinanceConnectionError('unknown-outcome', 'Odoo may have applied the operation. Check the records in Odoo before attempting it again.')
}

/**
 * Create a bounded Odoo JSON-2 request function with a shared operation deadline.
 * @param endpoint Configured Odoo address and database.
 * @param apiKey Odoo API credential.
 * @param options Request cancellation, deadline and optional access observation.
 * @returns A request function that reports uncertain outcomes for dispatched writes.
 */
export function makeClient(endpoint: FinanceEndpoint, apiKey: string, options: FinanceRequestOptions):
  (route: string, params: Record<string, unknown>, mutating?: boolean) => Promise<unknown> {
  const { url, database } = normalizeFinanceEndpoint(endpoint)
  if (!/^[\x21-\x7E]+$/.test(apiKey)) {
    throw new FinanceConnectionError('credential', 'Enter a valid Odoo API key.')
  }
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout

  return async function request(route: string, params: Record<string, unknown>, mutating = false): Promise<unknown> {
    let dispatched = false
    try {
      signal.throwIfAborted()
      const body = JSON.stringify(params)
      dispatched = true
      const response = await fetch(url + '/json/2/' + route, {
        method: 'POST',
        redirect: 'manual',
        credentials: 'omit',
        headers: {
          Authorization: 'Bearer ' + apiKey,
          'X-Odoo-Database': database,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body,
        signal,
      })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        throw new FinanceConnectionError('invalid-address', 'Odoo redirected the request. Enter the final server address.')
      }
      const isJson = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/json'
      if (!response.ok) {
        let name: string | undefined
        if (isJson) {
          try {
            const error = z.object({ name: z.string().optional() }).safeParse(parseJson(await readBody(response)))
            if (error.success) name = error.data.name
          } catch (error) {
            // HTTP status still classifies a malformed error payload.
            if (!(error instanceof FinanceConnectionError)) throw error
          }
        } else {
          await response.body?.cancel()
        }
        throw responseError(response.status, name, isJson)
      }
      if (!isJson) {
        await response.body?.cancel()
        throw invalidResponse()
      }
      const payload = await readBody(response)
      // Odoo-generated keys are long ASCII tokens. Reject a response that echoes one.
      if (apiKey.length >= 32 && payload.includes(apiKey)) throw invalidResponse()
      const result = parseJson(payload)
      options.observeAccess?.('reachable')
      return result
    } catch (error) {
      if (dispatched && options.signal?.aborted !== true && (timeout.aborted
        || !(error instanceof FinanceConnectionError) || error.reason === 'network' || error.reason === 'timeout')) {
        options.observeAccess?.('unreachable')
      }
      const rejected = error instanceof FinanceConnectionError
        && ['authentication', 'permissions', 'invalid-input', 'database', 'unsupported', 'not-found'].includes(error.reason)
      if (mutating && dispatched && !rejected) throw unknownWrite()
      if (options.signal?.aborted) {
        throw new FinanceConnectionError('cancelled', 'The Odoo request was cancelled.')
      }
      if (timeout.aborted) {
        throw new FinanceConnectionError('timeout', 'The Odoo request timed out. Try again.')
      }
      if (error instanceof FinanceConnectionError) throw error
      throw new FinanceConnectionError('network', 'The Odoo server could not be reached. Check its address and network connection, then try again.')
    }
  }
}

type Request = ReturnType<typeof makeClient>

function companyContext(companyId: number) {
  return { allowed_company_ids: [companyId] }
}

/**
 * Identify the ORM methods permitted without write authorization.
 * @param method Odoo JSON-2 method name.
 * @returns Whether the method belongs to the built-in read set.
 */
export function isFinanceOrmReadOnlyMethod(method: string): boolean {
  return ORM_READ_METHODS.has(method)
}

function checkedOrmJson(value: unknown, maxNodes: number, error: () => FinanceConnectionError): FinanceOrmJsonValue {
  let remaining = maxNodes
  const visit = (item: unknown, depth: number): FinanceOrmJsonValue => {
    if (--remaining < 0 || depth > MAX_ORM_DEPTH) throw error()
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (Array.isArray(item)) return item.map((entry: unknown) => visit(entry, depth + 1))
    if (typeof item !== 'object' || (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)) throw error()
    return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, visit(entry, depth + 1)]))
  }
  return visit(value, 0)
}

function ormParamsError(): FinanceConnectionError {
  return new FinanceConnectionError('invalid-input', 'Supply a JSON object of method parameters within 64 KB.')
}

function moveCreateParams(params: Record<string, FinanceOrmJsonValue>): Record<string, FinanceOrmJsonValue> {
  const { vals_list: batch, vals, values, ids, ...other } = params
  const supplied = [batch, vals, values].filter(value => value !== undefined)
  const value = supplied[0]
  const rows = value === undefined ? [] : Array.isArray(value) ? value : [value]
  if (supplied.length !== 1 || Object.keys(other).length > 0 || (ids !== undefined && (!Array.isArray(ids) || ids.length > 0))
    || rows.length === 0 || rows.some(row => typeof row !== 'object' || row === null || Array.isArray(row))) {
    throw new FinanceConnectionError('invalid-input', 'Supply account.move.create with vals_list containing one or more voucher objects. Omit record IDs.')
  }
  return { vals_list: rows }
}

interface PreparedOdooOrmCall {
  readonly model: string
  readonly method: string
  readonly params: Readonly<Record<string, FinanceOrmJsonValue>>
  readonly wizard: z.infer<typeof ormWizardContext>
}

/**
 * Validate and copy a public Odoo method request before seeking authorization.
 * @param request Model, method and untrusted JSON-2 arguments.
 * @returns The route segments and copied arguments for this exact operation.
 */
export function prepareOdooOrmCall(request: FinanceOrmCallRequest): PreparedOdooOrmCall {
  const { model, method } = request
  if (!ormModelName.safeParse(model).success || method.length > 128 || !/^[A-Za-z][A-Za-z0-9_]*$/.test(method)) {
    throw new FinanceConnectionError('invalid-input', 'Supply a valid Odoo model and public method name.')
  }
  const { params } = request
  if (typeof params !== 'object' || params === null || Array.isArray(params)) throw ormParamsError()
  const checked = checkedOrmJson(params, 4096, ormParamsError)
  if (typeof checked !== 'object' || checked === null || Array.isArray(checked)
    || Buffer.byteLength(JSON.stringify(checked)) > MAX_ORM_PARAMS_BYTES) throw ormParamsError()
  const { context, ...bounded } = Object.fromEntries<FinanceOrmJsonValue>(Object.entries(checked))
  const wizard = ormWizardContext.safeParse(context)
  if (!wizard.success) {
    throw new FinanceConnectionError('invalid-input', 'Use only active_model, active_id or active_ids for wizard context. The connector chooses the company context.')
  }
  if (ORM_PAGED_METHODS.has(method)) {
    const limit = bounded.limit ?? MAX_PAGE_SIZE
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new FinanceConnectionError('invalid-input', 'Use a page limit between 1 and 100 for this Odoo read.')
    }
    bounded.limit = limit
  }
  if (method === 'read' && !ormRecordIds.safeParse(bounded.ids).success) {
    throw new FinanceConnectionError('invalid-input', 'Supply up to 100 record IDs for an Odoo read.')
  }
  const keywordArgs = model === 'account.move' && method === 'create' ? moveCreateParams(bounded) : bounded
  return { model, method, params: keywordArgs, wizard: wizard.data }
}

/**
 * Resolve the exact JSON-2 body shared by authorization and dispatch.
 * @param request Validated model method and normalized arguments.
 * @param companyId Company selected by the connection.
 * @returns Request fields with the bound company and optional wizard context.
 */
export function odooOrmBody(request: PreparedOdooOrmCall, companyId: number): Readonly<Record<string, unknown>> {
  return { ...request.params, context: { ...request.wizard, ...companyContext(companyId) } }
}

/**
 * Bound the parsed JSON-2 value before it enters tool output.
 * @param value Parsed Odoo JSON response.
 * @param mutating Whether the dispatched operation may have committed changes.
 * @returns JSON with finite numeric values and bounded nesting.
 */
export function checkedOdooOrmResult(value: unknown, mutating: boolean): FinanceOrmJsonValue {
  return checkedOrmJson(value, MAX_BODY_BYTES, mutating ? unknownWrite : invalidResponse)
}

/**
 * Dispatch one validated ORM call through the bound company's JSON-2 endpoint.
 * @param endpoint Bound address and database.
 * @param apiKey Connector credential resolved after authorization.
 * @param company Bound company whose context is sent to Odoo.
 * @param request Validated public route and arguments.
 * @param options Cancellation and request deadline.
 * @returns The bounded, JSON-serializable response.
 */
export async function runOdooOrmCall(endpoint: FinanceEndpoint, apiKey: string, company: FinanceCompany,
  request: PreparedOdooOrmCall, options: FinanceRequestOptions): Promise<FinanceOrmJsonValue> {
  const mutating = !isFinanceOrmReadOnlyMethod(request.method)
  const send = makeClient(endpoint, apiKey, options)
  const result = await send(`${request.model}/${request.method}`, odooOrmBody(request, company.id), mutating)
  return checkedOdooOrmResult(result, mutating)
}

async function currentUserId(request: Request): Promise<number> {
  return read(z.object({ uid: id }), await request('res.users/context_get', {})).uid
}

function userCompanyFilter(userId: number): Filter {
  return ['user_ids', 'in', [userId]]
}

/**
 * Read the authenticated user's own login for display if the server exposes it.
 * @param request Active Odoo connection and operation deadline.
 * @param userId User ID verified by the same API key.
 * @param apiKey Key excluded from the projected login.
 * @returns The matching self record's login when available.
 */
export async function readOdooLogin(request: Request, userId: number, apiKey: string): Promise<string | undefined> {
  try {
    const [user] = read(z.array(z.object({ id, login: odooLogin })).length(1), await request('res.users/read', {
      ids: [userId], fields: ['login'],
    }))
    return user?.id === userId && !user.login.includes(apiKey) ? user.login : undefined
  } catch (error) {
    if (!(error instanceof FinanceConnectionError) || error.reason === 'cancelled' || error.reason === 'authentication') throw error
    return undefined
  }
}

function projectCompany(row: z.infer<typeof companyRow>): FinanceCompany {
  return { id: row.id, name: row.name, currency: row.currency_id[1] }
}

/**
 * Discover companies explicitly assigned to the API-key user.
 * @param endpoint Configured Odoo address and database.
 * @param apiKey Key supplied by the owner.
 * @param options Cancellation and request deadline.
 * @returns Available company IDs, display names and currencies.
 */
export async function discoverOdooCompanies(
  endpoint: FinanceEndpoint, apiKey: string, options: FinanceRequestOptions,
): Promise<readonly FinanceCompany[]> {
  const request = makeClient(endpoint, apiKey, options)
  const membership = userCompanyFilter(await currentUserId(request))
  const rows = read(z.array(companyRow).max(MAX_COMPANIES + 1), await request('res.company/search_read', {
    domain: [membership], fields: companyFields, order: 'name, id', limit: MAX_COMPANIES + 1,
  }))
  if (rows.length === 0 || rows.length > MAX_COMPANIES) {
    throw new FinanceConnectionError('company', 'Assign the Odoo user between 1 and 100 companies before connecting.')
  }
  return rows.map(projectCompany)
}

/**
 * Read the Odoo database identity for connector address verification.
 * @param endpoint Configured Odoo address and database.
 * @param apiKey Credential with access to the database identity.
 * @param options Cancellation and request deadline.
 * @returns The database UUID.
 */
export async function readOdooDatabaseUuid(
  endpoint: FinanceEndpoint, apiKey: string, options: FinanceRequestOptions,
): Promise<string> {
  const request = makeClient(endpoint, apiKey, options)
  const uuid = z.uuid().safeParse(await request('ir.config_parameter/get_param', { key: 'database.uuid' }))
  if (!uuid.success) throw new FinanceConnectionError('ledger-unverified', 'Odoo did not return a database identity.')
  return uuid.data.toLowerCase()
}

/**
 * Verify the selected company and its accounting read access before saving a connector.
 * @param endpoint Configured Odoo address and database.
 * @param apiKey Key supplied by the owner or retrieved from the credential store.
 * @param companyId Company selected by the owner.
 * @param options Cancellation and request deadline.
 * @returns Verified company, including the ledger currency.
 */
export async function verifyOdooCompany(
  endpoint: FinanceEndpoint, apiKey: string, companyId: number, options: FinanceRequestOptions,
): Promise<FinanceCompany> {
  return (await verifyCompany(makeClient(endpoint, apiKey, options), companyId)).company
}

/**
 * Verify a bookkeeping connector and read the API-key user's login.
 * @param endpoint Configured Odoo address and database.
 * @param apiKey Key supplied by the owner or retrieved from the credential store.
 * @param companyId Company selected by the owner.
 * @param options Cancellation and shared deadline for required and optional reads.
 * @returns The verified company and the user's login when available.
 */
export async function verifyOdooConnector(
  endpoint: FinanceEndpoint, apiKey: string, companyId: number, options: FinanceRequestOptions,
): Promise<{ readonly company: FinanceCompany; readonly account?: FinanceOdooAccount }> {
  const { observeAccess: _observeAccess, ...verificationOptions } = options
  const request = makeClient(endpoint, apiKey, verificationOptions)
  const { company, userId } = await verifyCompany(request, companyId)
  const login = await readOdooLogin(request, userId, apiKey)
  return { company, ...(login === undefined ? {} : { account: { login } }) }
}

async function verifyCompany(request: Request, companyId: number): Promise<{ company: FinanceCompany; userId: number }> {
  if (!id.safeParse(companyId).success) {
    throw new FinanceConnectionError('invalid-input', 'Select a valid Odoo company.')
  }
  const userId = await currentUserId(request)
  const membership = userCompanyFilter(userId)
  const context = companyContext(companyId)
  const [company] = read(z.array(companyRow).max(1), await request('res.company/search_read', {
    domain: [membership, ['id', '=', companyId]], context, fields: companyFields, limit: 1,
  }))
  if (!company || company.id !== companyId) {
    throw new FinanceConnectionError('company', 'The selected company is unavailable to this Odoo user.')
  }
  const [move] = read(z.array(moveIdentity).max(1), await request('account.move/search_read', {
    domain: [['company_id', '=', companyId]], context, fields: ['id', 'company_id'], limit: 1,
  }))
  if (move && move.company_id[0] !== companyId) throw invalidResponse()
  return { company: projectCompany(company), userId }
}

function validateDateRange(from: string, to: string): void {
  if (!z.iso.date().safeParse(from).success || !z.iso.date().safeParse(to).success || from > to) {
    throw new FinanceConnectionError('invalid-input', 'Enter a valid date range using YYYY-MM-DD.')
  }
}

function searchDomain(search: string | undefined, first: string, second: string): Domain {
  const value = search?.trim()
  if (!value) return []
  if (value.length > 120) {
    throw new FinanceConnectionError('invalid-input', 'Use at most 120 characters in the search.')
  }
  return ['|', [first, 'ilike', value], [second, 'ilike', value]]
}

function optionalName(value: z.infer<typeof optionalRelation>): string | null {
  return value ? value[1] : null
}

function requireCompany(value: z.infer<typeof relation>, companyId: number): void {
  if (value[0] !== companyId) throw invalidResponse()
}

/**
 * Read only the selected company's ledger, using fixed Odoo ORM methods and fields.
 * @param endpoint Saved Odoo address and database.
 * @param apiKey Key retrieved from the credential store.
 * @param company Verified company saved with the connector.
 * @param query Operation, bounded page and operation-specific filters.
 * @param options Cancellation and request deadline.
 * @returns The matching page and an independent count, with full-scope totals for turnover.
 */
export async function runOdooQuery(
  endpoint: FinanceEndpoint, apiKey: string, company: FinanceCompany, query: FinanceQuery, options: FinanceRequestOptions,
): Promise<FinanceQueryResult> {
  return runOdooQueryPage(makeClient(endpoint, apiKey, options), company, query)
}

/**
 * Collect complete ordered pages from one company and credential within one deadline.
 * @param endpoint Saved Odoo address and database.
 * @param apiKey Key retrieved from the credential store.
 * @param company Verified company saved with the connector.
 * @param query Exact dataset and filters without a page restriction.
 * @param options Cancellation and operation deadline.
 * @returns All matching rows within the pagination limit. Changed counts, duplicate IDs and incomplete pages fail the export.
 */
export async function runOdooExport(
  endpoint: FinanceEndpoint, apiKey: string, company: FinanceCompany, query: FinanceExportQuery, options: FinanceRequestOptions,
): Promise<FinanceQueryResult> {
  const request = makeClient(endpoint, apiKey, options)
  const rows: FinanceQueryResult['rows'][number][] = []
  const ids = new Set<number>()
  let total: number | undefined
  do {
    const page = await runOdooQueryPage(request, company, { ...query, offset: rows.length, limit: MAX_PAGE_SIZE })
    total ??= page.total
    if (total > MAX_QUERY_OFFSET + MAX_PAGE_SIZE) {
      throw new FinanceConnectionError('invalid-input', 'The export exceeds 10,100 rows. Narrow the date range or search and try again.')
    }
    if (page.total !== total || page.rows.length !== Math.min(MAX_PAGE_SIZE, total - rows.length)) {
      throw new FinanceConnectionError('invalid-response', 'Odoo did not return a complete export. Retry with a narrower or stable date range.')
    }
    for (const row of page.rows) {
      if (typeof row.id !== 'number' || ids.has(row.id)) {
        throw new FinanceConnectionError('invalid-response', 'Odoo returned repeated records during export. Retry with a narrower or stable date range.')
      }
      ids.add(row.id)
      rows.push(row)
    }
  } while (rows.length < total)
  return { company, query, rows, total }
}

async function runOdooQueryPage(request: Request, company: FinanceCompany, query: FinanceQuery): Promise<FinanceQueryResult> {
  const offset = query.offset ?? 0
  const limit = query.limit ?? 20
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_QUERY_OFFSET || !Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new FinanceConnectionError('invalid-input', 'Use a page size from 1 to 100 and an offset from 0 to 10000.')
  }
  const context = companyContext(company.id)
  const companyFilter: Filter = ['company_id', '=', company.id]

  type Row = FinanceQueryResult['rows'][number]

  async function page<T>(
    model: LedgerModel, domain: Domain, fields: readonly string[], order: string,
    schema: z.ZodType<T>, project: (value: T) => Row,
  ): Promise<FinanceQueryResult> {
    const rows = read(z.array(schema).max(limit), await request(`${model}/search_read`, {
      domain, context, fields, order, offset, limit,
    })).map(project)
    const total = read(count, await request(`${model}/search_count`, { domain, context }))
    return { company, query, rows, total }
  }

  switch (query.kind) {
    case 'accounts':
      return page('account.account', [['company_ids', 'in', [company.id]], ...searchDomain(query.search, 'code', 'name')],
        ['id', 'code', 'name', 'account_type', 'company_ids'], 'code, id',
        z.object({ id, code: optionalText, name: z.string(), account_type: z.string(), company_ids: z.array(id) }),
        (row) => {
          if (!row.company_ids.includes(company.id)) throw invalidResponse()
          return { id: row.id, code: row.code || null, name: row.name, accountType: row.account_type }
        })
    case 'journals':
      return page('account.journal', [companyFilter, ...searchDomain(query.search, 'code', 'name')],
        ['id', 'code', 'name', 'type', 'company_id'], 'code, id',
        z.object({ id, code: z.string(), name: z.string(), type: z.string(), company_id: relation }),
        (row) => {
          requireCompany(row.company_id, company.id)
          return { id: row.id, code: row.code, name: row.name, type: row.type }
        })
    case 'moves': {
      validateDateRange(query.from, query.to)
      const domain: Filter[] = [companyFilter, ['date', '>=', query.from], ['date', '<=', query.to]]
      if (query.state !== 'all') domain.push(['state', '=', query.state])
      return page('account.move', [...domain, ...searchDomain(query.search, 'name', 'ref')],
        ['id', 'name', 'ref', 'date', 'state', 'journal_id', 'amount_total', 'currency_id', 'company_id'], 'date desc, id desc',
        moveIdentity.extend({
          name: optionalText, ref: optionalText, date: z.iso.date(), state: moveState, journal_id: relation,
          amount_total: z.number(), currency_id: relation,
        }), (row) => {
          requireCompany(row.company_id, company.id)
          if (row.date < query.from || row.date > query.to || (query.state !== 'all' && row.state !== query.state)) throw invalidResponse()
          return {
            id: row.id, number: row.name || null, reference: row.ref || null, date: row.date, state: row.state,
            journal: row.journal_id[1], amountTotal: row.amount_total, currency: row.currency_id[1],
          }
        })
    }
    case 'entries':
    case 'move-lines': {
      const domain: (Filter | '|')[] = [companyFilter]
      if (query.kind === 'entries') {
        validateDateRange(query.from, query.to)
        domain.push(['date', '>=', query.from], ['date', '<=', query.to])
        if (query.state !== 'all') domain.push(['parent_state', '=', query.state])
        domain.push(...searchDomain(query.search, 'name', 'move_id.name'))
      } else {
        if (!id.safeParse(query.moveId).success) {
          throw new FinanceConnectionError('invalid-input', 'Enter a valid Odoo journal entry ID.')
        }
        const [move] = read(z.array(moveIdentity).max(1), await request('account.move/search_read', {
          domain: [companyFilter, ['id', '=', query.moveId]], context, fields: ['id', 'company_id'], limit: 1,
        }))
        if (!move) throw new FinanceConnectionError('not-found', 'The journal entry is unavailable in the selected company.')
        requireCompany(move.company_id, company.id)
        if (move.id !== query.moveId) throw invalidResponse()
        domain.push(['move_id', '=', move.id])
      }
      return page('account.move.line', domain,
        ['id', 'move_id', 'date', 'parent_state', 'account_id', 'name', 'debit', 'credit', 'company_id'],
        query.kind === 'entries' ? 'date, id' : 'id',
        z.object({
          id, move_id: relation, date: z.iso.date(), parent_state: moveState, account_id: optionalRelation,
          name: optionalText, debit: z.number(), credit: z.number(), company_id: relation,
        }), (row) => {
          requireCompany(row.company_id, company.id)
          if (query.kind === 'entries') {
            if (row.date < query.from || row.date > query.to || (query.state !== 'all' && row.parent_state !== query.state)) throw invalidResponse()
          } else if (row.move_id[0] !== query.moveId) throw invalidResponse()
          return {
            id: row.id, moveId: row.move_id[0], number: row.move_id[1], date: row.date, state: row.parent_state,
            accountId: row.account_id ? row.account_id[0] : null, account: optionalName(row.account_id),
            description: row.name || null, debit: row.debit, credit: row.credit, currency: company.currency,
          }
        })
    }
    case 'turnover': {
      validateDateRange(query.from, query.to)
      const domain: Domain = [
        companyFilter, ['parent_state', '=', 'posted'], ['account_id', '!=', false],
        ['date', '>=', query.from], ['date', '<=', query.to],
      ]
      const aggregates = ['debit:sum', 'credit:sum']
      const rows = read(z.array(debitCredit.extend({ company_id: relation, account_id: relation })).max(limit),
        await request('account.move.line/formatted_read_group', {
          domain, context, groupby: ['company_id', 'account_id'], aggregates, order: 'account_id', offset, limit,
        })).map((row) => {
        requireCompany(row.company_id, company.id)
        return {
          accountId: row.account_id[0], account: row.account_id[1],
          debit: row['debit:sum'], credit: row['credit:sum'], currency: company.currency,
        }
      })
      const nullableSum = z.union([z.number(), z.literal(false)])
      const [summary] = read(z.array(z.object({
        'account_id:count_distinct': count, 'debit:sum': nullableSum, 'credit:sum': nullableSum,
      })).max(1), await request('account.move.line/formatted_read_group', {
        domain, context, groupby: [], aggregates: [...aggregates, 'account_id:count_distinct'],
      }))
      return {
        company, query, rows, total: summary?.['account_id:count_distinct'] ?? 0,
        totals: { debit: summary?.['debit:sum'] || 0, credit: summary?.['credit:sum'] || 0 },
      }
    }
    default: return assertNever(query)
  }
}
