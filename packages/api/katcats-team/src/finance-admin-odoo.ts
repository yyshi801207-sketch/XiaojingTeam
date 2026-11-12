/** Role-scoped Odoo 19 administrative requests and their model-facing projections. */
import { z } from 'zod'
import {
  checkedOdooOrmResult, FinanceConnectionError, makeClient, prepareOdooOrmCall, type FinanceRequestOptions,
} from './finance-odoo.ts'
import type { FinanceCompany, FinanceEndpoint, FinanceOrmCallRequest, FinanceOrmJsonValue } from './finance-types.ts'
import type { OdooAdminWriteWitness } from './finance-admin-operations.ts'

/** Administrative roles assigned to the built-in finance assistants. */
export type OdooAdminRole = 'ledger' | 'access'

interface ModelPolicy {
  readonly read: readonly string[]
  readonly write: readonly string[]
  readonly links: readonly string[]
}

function allow(write: readonly string[], read: readonly string[] = [], links: readonly string[] = []): ModelPolicy {
  return { read: ['id', 'name', ...write.filter(field => field !== 'name'), ...read], write, links }
}

const ledgerPolicy: Readonly<Record<string, ModelPolicy>> = {
  'res.company': allow(
    ['name', 'parent_id', 'country_id', 'state_id', 'currency_id', 'street', 'street2', 'city', 'zip', 'vat',
      'phone', 'email', 'website', 'company_registry', 'account_opening_date'],
    ['active', 'child_ids', 'account_fiscal_country_id', 'chart_template', 'country_code'],
  ),
  'hr.department': allow(['name', 'company_id', 'parent_id', 'manager_id', 'active', 'note'], ['complete_name', 'child_ids']),
  'res.country': allow([], ['code', 'currency_id']),
  'res.country.state': allow([], ['code', 'country_id']),
  'res.currency': allow([], ['symbol', 'active', 'rounding']),
  'account.account': allow(
    ['name', 'code', 'account_type', 'reconcile', 'active', 'company_ids', 'currency_id', 'note'],
    ['group_id'], ['company_ids'],
  ),
  'account.group': allow(['name', 'code_prefix_start', 'code_prefix_end', 'company_id'], ['parent_id']),
  'account.journal': allow([
    'name', 'code', 'type', 'company_id', 'currency_id', 'active', 'sequence',
    'default_account_id', 'suspense_account_id',
  ]),
  'account.tax': allow([
    'name', 'company_id', 'active', 'tax_group_id', 'amount_type', 'amount', 'type_tax_use',
    'description', 'price_include_override', 'include_base_amount', 'is_base_affected', 'sequence', 'tax_scope',
  ], ['country_id']),
  'account.tax.group': allow(['name', 'company_id', 'country_id', 'sequence']),
  'account.fiscal.position': allow(['name', 'company_id', 'active', 'sequence', 'auto_apply', 'vat_required', 'country_id']),
}

const permissionFields = ['perm_read', 'perm_write', 'perm_create', 'perm_unlink']
const accessPolicy: Readonly<Record<string, ModelPolicy>> = {
  'res.users': allow(
    ['name', 'login', 'email', 'active', 'company_id', 'company_ids', 'group_ids', 'lang', 'tz'],
    ['all_group_ids', 'role', 'share', 'partner_id'], ['company_ids', 'group_ids'],
  ),
  'res.groups': allow(
    ['name', 'privilege_id', 'comment', 'sequence', 'user_ids', 'implied_ids'],
    ['full_name', 'all_user_ids', 'all_implied_ids', 'implied_by_ids', 'model_access', 'rule_groups'],
    ['user_ids', 'implied_ids'],
  ),
  'res.company': allow([], ['active', 'parent_id', 'child_ids', 'country_id', 'currency_id']),
  'res.groups.privilege': allow([], ['category_id', 'sequence', 'group_ids']),
  'ir.module.category': allow([], ['parent_id', 'sequence']),
  'ir.model': allow([], ['model', 'state']),
  'ir.model.access': allow([], ['model_id', 'group_id', 'active', ...permissionFields]),
  'ir.rule': allow([], ['model_id', 'groups', 'active', 'domain_force', ...permissionFields]),
}

const maxRows = 100
const id = z.number().int().positive()
const count = z.number().int().nonnegative()
const ids = z.array(id).min(1).max(maxRows)
const relation = z.tuple([id, z.string()])
const companyRow = z.object({ id, name: z.string(), currency_id: relation })
const scalar = z.union([z.string().max(4096), z.number(), z.boolean(), z.null()])
const link = z.union([
  z.tuple([z.union([z.literal(3), z.literal(4)]), id, z.literal(0)]),
  z.tuple([z.literal(5), z.literal(0), z.literal(0)]),
  z.tuple([z.literal(6), z.literal(0), z.array(id).max(maxRows)]),
])
const filterOperator = z.enum([
  '=', '!=', '=?', '>', '>=', '<', '<=', 'in', 'not in', 'like', 'ilike', '=like', '=ilike',
  'not like', 'not ilike', 'child_of', 'parent_of',
])
const filterTerm = z.union([z.enum(['&', '|', '!']), z.tuple([
  z.string(), filterOperator, z.union([scalar, z.array(scalar).max(maxRows)]),
])])
const filterDomain = z.array(filterTerm).max(maxRows)
const readMethods = z.enum(['search', 'search_read', 'search_count', 'read', 'name_search', 'fields_get'])
const writeMethods = z.enum(['create', 'write', 'action_archive', 'action_unarchive'])
const methodSchema = z.union([readMethods, writeMethods])
const fieldAttributes = ['string', 'type', 'relation', 'required', 'readonly', 'selection']
const records = z.array(z.record(z.string(), z.json())).max(maxRows)
const recordCell = z.union([z.string(), z.number(), z.boolean(), z.null(), relation, z.array(id)])

type Method = z.infer<typeof methodSchema>
type Arguments = Readonly<Record<string, FinanceOrmJsonValue>>

/** Public route and normalized arguments validated for one administrative role. */
export interface PreparedOdooAdminCall {
  readonly role: OdooAdminRole
  readonly model: string
  readonly method: Method
  readonly params: Arguments
  readonly mutating: boolean
}

function invalidInput(message: string): never {
  throw new FinanceConnectionError('invalid-input', message)
}

function denied(): never {
  throw new FinanceConnectionError('permissions', 'This Odoo model, method or field is outside this administrative role.')
}

function result<T>(schema: z.ZodType<T>, value: unknown, mutating = false): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw mutating
      ? new FinanceConnectionError('unknown-outcome', 'Odoo may have applied the change. Verify the record before trying again.')
      : new FinanceConnectionError('invalid-response', 'Odoo returned an unexpected administration response.')
  }
  return parsed.data
}

function validateKeys(params: Arguments, keys: readonly string[]): void {
  if (Object.keys(params).some(key => !keys.includes(key))) {
    invalidInput('Use only the Odoo keyword arguments accepted by this administrative method.')
  }
}

function selectFields(value: FinanceOrmJsonValue | undefined, permitted: readonly string[], defaults: readonly string[]): string[] {
  if (value === undefined) return [...defaults]
  const fields = z.array(z.string()).min(1).max(maxRows).safeParse(value)
  if (!fields.success) invalidInput('Provide a nonempty list of supported Odoo fields.')
  if (fields.data.some(field => !permitted.includes(field))) denied()
  return [...new Set(fields.data)]
}

function checkSearch(params: Arguments, policy: ModelPolicy): void {
  if (params.domain !== undefined) {
    const domain = filterDomain.safeParse(params.domain)
    if (!domain.success) invalidInput('Provide a valid Odoo domain using supported fields and operators.')
    if (domain.data.some(term => typeof term !== 'string' && !policy.read.includes(term[0]))) denied()
  }
  if (params.order !== undefined) {
    const fields = typeof params.order === 'string' ? params.order.split(',').map(part => part.trim()) : []
    if (fields.length === 0 || fields.length > maxRows || fields.some(part => {
      const match = /^([a-z][a-z0-9_]*)(?: +(asc|desc))?$/i.exec(part)
      return !match?.[1] || !policy.read.includes(match[1])
    })) invalidInput('Sort only by supported Odoo fields, optionally followed by ASC or DESC.')
  }
  if (params.offset !== undefined && !z.number().int().nonnegative().max(10_000).safeParse(params.offset).success) {
    invalidInput('Use a nonnegative Odoo search offset up to 10000.')
  }
}

function checkValues(value: FinanceOrmJsonValue | undefined, policy: ModelPolicy): void {
  const vals = z.record(z.string(), z.json()).safeParse(value)
  if (!vals.success || Object.keys(vals.data).length === 0) invalidInput('Provide a nonempty Odoo values object.')
  for (const [field, item] of Object.entries(vals.data)) {
    if (!policy.write.includes(field)) denied()
    const schema = policy.links.includes(field) ? z.array(link).max(maxRows) : scalar
    if (!schema.safeParse(item).success) {
      invalidInput('Provide scalar values or explicit relation links. Related record creation and edits require a separate operation.')
    }
  }
}

function prepareRead(method: z.infer<typeof readMethods>, params: Arguments, policy: ModelPolicy): Arguments {
  switch (method) {
    case 'search_read':
      validateKeys(params, ['fields', 'domain', 'limit', 'offset', 'order'])
      checkSearch(params, policy)
      return { ...params, fields: selectFields(params.fields, policy.read, ['id', 'name']) }
    case 'read':
      validateKeys(params, ['ids', 'fields'])
      return { ...params, fields: selectFields(params.fields, policy.read, ['id', 'name']) }
    case 'search':
      validateKeys(params, ['domain', 'limit', 'offset', 'order'])
      checkSearch(params, policy)
      return params
    case 'search_count':
      validateKeys(params, ['domain'])
      checkSearch(params, policy)
      return params
    case 'name_search':
      validateKeys(params, ['name', 'domain', 'operator', 'limit'])
      checkSearch(params, policy)
      if ((params.name !== undefined && !z.string().max(256).safeParse(params.name).success)
        || (params.operator !== undefined && !z.enum(['=', 'like', 'ilike', '=like', '=ilike']).safeParse(params.operator).success)) {
        invalidInput('Use a short name and a supported text comparison for Odoo name search.')
      }
      return params
    case 'fields_get':
      validateKeys(params, ['allfields', 'attributes'])
      return {
        allfields: selectFields(params.allfields, policy.read, policy.read),
        attributes: selectFields(params.attributes, fieldAttributes, fieldAttributes),
      }
  }
}

function prepareWrite(method: z.infer<typeof writeMethods>, params: Arguments, policy: ModelPolicy): Arguments {
  if (policy.write.length === 0) denied()
  if (method === 'create') {
    validateKeys(params, ['vals_list'])
    const values = z.array(z.json()).min(1).max(maxRows).safeParse(params.vals_list)
    if (!values.success) invalidInput('Supply vals_list with one or more Odoo creation objects.')
    for (const item of values.data) checkValues(item, policy)
    return params
  }
  if (!ids.safeParse(params.ids).success) invalidInput('Supply one to 100 existing Odoo record IDs.')
  if (method === 'write') {
    validateKeys(params, ['ids', 'vals'])
    checkValues(params.vals, policy)
  } else {
    validateKeys(params, ['ids'])
    if (!policy.write.includes('active')) denied()
  }
  return params
}

/**
 * Validate a role-scoped administrative route before exposing it for owner approval.
 * @param role Role assigned to the current built-in assistant.
 * @param request Untrusted model arguments from the assistant.
 * @returns The exact public method, bounded arguments and whether it requires approval.
 */
export function prepareOdooAdminCall(role: OdooAdminRole, request: FinanceOrmCallRequest): PreparedOdooAdminCall {
  const prepared = prepareOdooOrmCall(request)
  const policy = (role === 'ledger' ? ledgerPolicy : accessPolicy)[prepared.model]
  const parsed = methodSchema.safeParse(prepared.method)
  if (!Object.hasOwn(role === 'ledger' ? ledgerPolicy : accessPolicy, prepared.model) || !policy || !parsed.success) denied()
  if (Object.keys(prepared.wizard).length !== 0) invalidInput('Select the company separately. Administration does not accept caller context.')
  const read = readMethods.safeParse(parsed.data)
  if (read.success) {
    return { role, model: prepared.model, method: read.data, params: prepareRead(read.data, prepared.params, policy), mutating: false }
  }
  const method = writeMethods.parse(parsed.data)
  return { role, model: prepared.model, method, params: prepareWrite(method, prepared.params, policy), mutating: true }
}

/**
 * Resolve the JSON-2 body shared by the approval card and dispatch.
 * @param call Prepared administrative operation.
 * @param companyId Explicit company. Required for accounting records and departments.
 * @returns Approved arguments with runtime-selected company context and company-only creation settings.
 */
export function odooAdminBody(call: PreparedOdooAdminCall, companyId?: number): Arguments {
  if (companyId === undefined && (call.model.startsWith('account.') || call.model === 'hr.department')) {
    invalidInput('Select an authorized Odoo company before working with accounting records or departments.')
  }
  if (companyId !== undefined && !id.safeParse(companyId).success) invalidInput('Select a valid Odoo company ID.')
  const companyOnlyCreate = call.model === 'res.company' && call.method === 'create'
  if (companyId === undefined && !companyOnlyCreate) return call.params
  return { ...call.params, context: {
    ...(companyId === undefined ? {} : { allowed_company_ids: [companyId] }),
    ...(companyOnlyCreate ? { chart_template_load: true } : {}),
  } }
}

function projectCompany(row: z.infer<typeof companyRow>): FinanceCompany {
  return { id: row.id, name: row.name, currency: row.currency_id[1] }
}

async function companyMembership(request: ReturnType<typeof makeClient>) {
  const { uid } = result(z.object({ uid: id }), await request('res.users/context_get', {}))
  return ['user_ids', 'in', [uid]]
}

const companyFields = ['id', 'name', 'currency_id']

/**
 * List active companies assigned to the verified Odoo administrator.
 * @param endpoint Verified administration address and database.
 * @param apiKey Administrator key from the credential store.
 * @param options Request cancellation and deadline.
 * @returns Bounded company choices containing only ID, name and currency.
 */
export async function listOdooAdminCompanies(
  endpoint: FinanceEndpoint, apiKey: string, options: FinanceRequestOptions,
): Promise<readonly FinanceCompany[]> {
  const send = makeClient(endpoint, apiKey, options)
  const domain = [await companyMembership(send)]
  const companies = result(z.array(companyRow).max(maxRows + 1), await send('res.company/search_read', {
    domain, fields: companyFields, order: 'name, id', limit: maxRows + 1,
  }))
  if (companies.length > maxRows) invalidInput('The company list exceeds 100 results. Select the company by its exact ID.')
  return companies.map(projectCompany)
}

async function readCompany(send: ReturnType<typeof makeClient>, companyId: number): Promise<FinanceCompany> {
  if (!id.safeParse(companyId).success) invalidInput('Select a valid Odoo company ID.')
  const domain = [await companyMembership(send), ['id', '=', companyId]]
  const [company] = result(z.array(companyRow).max(1), await send('res.company/search_read', {
    domain, context: { allowed_company_ids: [companyId] }, fields: companyFields, limit: 1,
  }))
  if (company?.id !== companyId) {
    throw new FinanceConnectionError('company', 'The selected company is unavailable to this Odoo administrator.')
  }
  return projectCompany(company)
}

/**
 * Confirm the exact assigned company for an approval card or scoped read.
 * @param endpoint Verified administration address and database.
 * @param apiKey Administrator key from the credential store.
 * @param companyId Explicit company ID.
 * @param options Request cancellation and deadline.
 * @returns Company ID, name and currency from Odoo.
 */
export function verifyOdooAdminCompany(
  endpoint: FinanceEndpoint, apiKey: string, companyId: number, options: FinanceRequestOptions,
): Promise<FinanceCompany> {
  return readCompany(makeClient(endpoint, apiKey, options), companyId)
}

function projectRead(call: PreparedOdooAdminCall, data: FinanceOrmJsonValue): FinanceOrmJsonValue {
  if (call.method === 'search_count') return result(count, data)
  if (call.method === 'search') return result(z.array(id).max(maxRows), data)
  if (call.method === 'name_search') return result(z.array(relation).max(maxRows), data)
  if (call.method === 'fields_get') {
    const fields = z.array(z.string()).parse(call.params.allfields)
    const attributes = z.array(z.string()).parse(call.params.attributes)
    const values = result(z.record(z.string(), z.record(z.string(), z.json())), data)
    return Object.fromEntries(Object.entries(values).filter(([field]) => fields.includes(field)).map(([field, metadata]) => [
      field, Object.fromEntries(Object.entries(metadata).filter(([key]) => attributes.includes(key))),
    ]))
  }
  const fields = z.array(z.string()).parse(call.params.fields)
  return result(records, data).map(row => Object.fromEntries(
    Object.entries(row).filter(([field]) => field === 'id' || fields.includes(field)).map(([field, value]) => [
      field, field === 'id' ? result(id, value) : result(recordCell, value),
    ]),
  ))
}

/**
 * Dispatch an administrative request after the caller has obtained required owner approval.
 * @param endpoint Verified administration address and database.
 * @param apiKey Administrator key from the credential store.
 * @param call Prepared route and arguments. The caller authorizes this exact value.
 * @param options Request cancellation and deadline.
 * @param companyId Company to recheck before dispatch. Database-level models may omit it.
 * @returns Bounded response with administrative record fields projected to the approved selection.
 */
export async function runOdooAdminCall(
  endpoint: FinanceEndpoint, apiKey: string, call: PreparedOdooAdminCall, options: FinanceRequestOptions, companyId?: number,
): Promise<FinanceOrmJsonValue> {
  const send = makeClient(endpoint, apiKey, options)
  const body = odooAdminBody(call, companyId)
  if (companyId !== undefined) await readCompany(send, companyId)
  const response = await send(call.model + '/' + call.method, body, call.mutating)
  const data = checkedOdooOrmResult(response, call.mutating)
  if (!call.mutating) return projectRead(call, data)
  if (call.method === 'create') {
    const expected = z.array(z.json()).parse(call.params.vals_list).length
    return result(z.array(id).length(expected), data, true)
  }
  if (call.method === 'write') return result(z.boolean(), data, true)
  return result(z.boolean().nullable(), data, true)
}

function readbackContext(companyId?: number) {
  return { active_test: false, ...(companyId === undefined ? {} : { allowed_company_ids: [companyId] }) }
}

function normalizedCell(value: FinanceOrmJsonValue, type: string | undefined): FinanceOrmJsonValue {
  if (type === 'many2one') return Array.isArray(value) ? value[0]! : value === null ? false : value
  if (type === 'many2many' || type === 'one2many') return result(z.array(id), value).sort((a, b) => a - b)
  if (value === null || ((type === 'char' || type === 'text' || type === 'html' || type === 'selection') && value === '')) return false
  return value
}

function expectedValues(values: Arguments, before: Arguments, fieldTypes: Readonly<Record<string, string>>): Record<string, FinanceOrmJsonValue> {
  return Object.fromEntries(Object.entries(values).map(([field, value]) => {
    if (fieldTypes[field] !== 'many2many' && fieldTypes[field] !== 'one2many') return [field, normalizedCell(value, fieldTypes[field])]
    const current = new Set(result(z.array(id), before[field] ?? []))
    for (const command of result(z.array(link), value)) {
      if (command[0] === 3) current.delete(command[1])
      else if (command[0] === 4) current.add(command[1])
      else {
        current.clear()
        if (command[0] === 6) for (const linked of command[2]) current.add(linked)
      }
    }
    return [field, [...current].sort((a, b) => a - b)]
  }))
}

function matchesValues(row: Arguments, values: Arguments, fieldTypes: Readonly<Record<string, string>>): boolean {
  return Object.entries(values).every(([field, expected]) => row[field] !== undefined
    && JSON.stringify(normalizedCell(row[field], fieldTypes[field])) === JSON.stringify(expected))
}

function readbackRecords(value: unknown, fields: readonly string[]) {
  return result(records, value).map(row => Object.fromEntries(fields.filter(field => row[field] !== undefined)
    .map(field => [field, row[field]!])) )
}

async function matchingRecords(send: ReturnType<typeof makeClient>, call: PreparedOdooAdminCall,
  values: Arguments, witness: Pick<OdooAdminWriteWitness, 'fields' | 'fieldTypes'>, companyId?: number) {
  const domain = Object.entries(values).filter(([field]) => !['many2many', 'one2many'].includes(witness.fieldTypes[field] ?? ''))
    .map(([field, value]) => [field, '=', value])
  const rows = readbackRecords(await send(call.model + '/search_read', {
    domain, fields: witness.fields, limit: maxRows + 1, context: readbackContext(companyId),
  }), witness.fields)
  return rows.filter(row => matchesValues(row, values, witness.fieldTypes))
}

/**
 * Capture existing values and creation matches before saving a write intent.
 * @param endpoint Verified database endpoint.
 * @param apiKey Saved administrator credential.
 * @param call Exact role-validated write.
 * @param options Request lifetime.
 * @param companyId Selected accounting company, when required.
 * @returns Bounded readback expectations and IDs that predate a creation.
 */
export async function prepareOdooAdminWrite(endpoint: FinanceEndpoint, apiKey: string, call: PreparedOdooAdminCall,
  options: FinanceRequestOptions, companyId?: number): Promise<OdooAdminWriteWitness> {
  if (!call.mutating) invalidInput('Only mutations have administrative write intents.')
  const send = makeClient(endpoint, apiKey, options)
  const values = call.method === 'create' ? result(z.array(z.record(z.string(), z.json())), call.params.vals_list)
    : [call.method === 'write' ? result(z.record(z.string(), z.json()), call.params.vals)
      : { active: call.method === 'action_unarchive' }]
  const changed = [...new Set(values.flatMap(value => Object.keys(value)))]
  const metadata = result(z.record(z.string(), z.object({ type: z.string() })), await send(call.model + '/fields_get', {
    allfields: changed, attributes: ['type'], context: readbackContext(companyId),
  }))
  if (changed.some(field => metadata[field] === undefined)) invalidInput('Odoo did not expose every requested field for verification.')
  const fieldTypes = Object.fromEntries(changed.map(field => [field, metadata[field]!.type]))
  const fields = [...new Set(['id', 'name', ...changed,
    ...(call.model === 'res.users' ? ['company_id', 'company_ids', 'group_ids', 'all_group_ids', 'active'] : [])])]
  if (call.method === 'create') {
    const targets = []
    for (const value of values) {
      const expected = expectedValues(value, {}, fieldTypes)
      const before = await matchingRecords(send, call, expected, { fields, fieldTypes }, companyId)
      targets.push({ beforeIds: before.map(row => result(id, row.id)), values: expected })
    }
    return { fields, fieldTypes, targets }
  }
  const targetIds = result(ids, call.params.ids)
  const rows = readbackRecords(await send(call.model + '/read', { ids: targetIds, fields, context: readbackContext(companyId) }), fields)
  if (rows.length !== targetIds.length || new Set(rows.map(row => row.id)).size !== targetIds.length) {
    invalidInput('Read every target record before changing it.')
  }
  const targets = targetIds.map(targetId => {
    const before = rows.find(row => row.id === targetId)
    if (!before) invalidInput('An administrative target is no longer available.')
    return { id: targetId, beforeIds: [], values: expectedValues(values[0]!, before, fieldTypes) }
  })
  return { fields, fieldTypes, targets }
}

/** Exact readback, or non-authoritative candidates requiring explicit owner adoption. */
export interface OdooAdminWriteVerification {
  readonly verified: boolean
  readonly records: readonly Readonly<Record<string, FinanceOrmJsonValue>>[]
  readonly candidates: readonly (readonly number[])[]
}

/**
 * Read the post-write state without repeating a mutation.
 * @param endpoint Verified database endpoint.
 * @param apiKey Saved administrator credential.
 * @param call Exact recorded write.
 * @param witness Persisted expected values and preexisting IDs.
 * @param options Request lifetime.
 * @param companyId Recorded company scope.
 * @param recordIds Confirmed creation IDs, or IDs explicitly adopted by the owner.
 * @returns Verified target records, or exact creation candidates without claiming attribution.
 */
export async function verifyOdooAdminWrite(endpoint: FinanceEndpoint, apiKey: string, call: PreparedOdooAdminCall,
  witness: OdooAdminWriteWitness, options: FinanceRequestOptions, companyId?: number,
  recordIds?: readonly number[]): Promise<OdooAdminWriteVerification> {
  const send = makeClient(endpoint, apiKey, options)
  if (companyId !== undefined) await readCompany(send, companyId)
  const selected = call.method === 'create' ? recordIds : witness.targets.map(target => target.id!)
  if (selected === undefined) {
    const candidates: number[][] = []
    const found: Record<string, FinanceOrmJsonValue>[] = []
    for (const target of witness.targets) {
      const rows = (await matchingRecords(send, call, target.values, witness, companyId))
        .filter(row => !target.beforeIds.includes(result(id, row.id)))
      candidates.push(rows.map(row => result(id, row.id)))
      for (const row of rows) if (!found.some(value => value.id === row.id)) found.push(row)
      if (found.length > maxRows) throw new FinanceConnectionError('invalid-response', 'Too many matching creation candidates. Inspect the target records before reconciling.')
    }
    return { verified: false, records: found, candidates }
  }
  if (selected.length !== witness.targets.length || new Set(selected).size !== selected.length
    || selected.some((targetId, index) => !id.safeParse(targetId).success || witness.targets[index]!.beforeIds.includes(targetId))) {
    invalidInput('Select one distinct new record for each creation, in its original order.')
  }
  const rows = readbackRecords(await send(call.model + '/read', { ids: selected, fields: witness.fields, context: readbackContext(companyId) }), witness.fields)
  const verified = rows.length === selected.length && selected.every((targetId, index) => {
    const row = rows.find(value => value.id === targetId)
    return row !== undefined && matchesValues(row, witness.targets[index]!.values, witness.fieldTypes)
  })
  return { verified, records: rows, candidates: [] }
}
