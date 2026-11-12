/** Odoo 19 database-level company creation and account initialization for approved setup plans. */
import { z } from 'zod'
import { FinanceConnectionError, makeClient, readOdooLogin, verifyOdooCompany, type FinanceRequestOptions } from './finance-odoo.ts'
import type { FinanceCompany, FinanceEndpoint, FinanceOdooAccount } from './finance-types.ts'

const id = z.number().int().positive()
const count = z.number().int().nonnegative()
const relation = z.tuple([id, z.string()])
const date = z.iso.date()
const templateKey = z.string().regex(/^[a-z][a-z0-9_-]{0,95}$/)
const customAccountLimit = 500
const companyRecord = z.object({
  id,
  name: z.string(),
  currency_id: relation,
  country_id: relation,
  country_code: z.string().length(2),
  account_fiscal_country_id: z.union([relation, z.literal(false)]),
  parent_id: z.literal(false),
  child_ids: z.array(id).length(0),
  chart_template: z.union([templateKey, z.literal(false)]),
  account_opening_date: z.union([date, z.literal(false)]),
})
const templateMetadata = z.object({
  name: z.unknown().optional(),
  country_id: z.union([id, z.literal(false), z.null()]),
  visible: z.union([z.boolean(), z.literal(0), z.literal(1)]),
  installed: z.boolean(),
})
const companyFields = Object.keys(companyRecord.shape)
const customAccount = z.object({
  code: z.string().regex(/^[A-Za-z0-9.]{1,64}$/),
  name: z.string().trim().min(1).max(256),
  accountType: z.string().regex(/^[a-z_]{1,48}$/),
  reconcile: z.boolean(),
})
const customAccounts = z.array(customAccount).min(1).max(customAccountLimit)
const importedAccount = z.object({
  id,
  code: customAccount.shape.code,
  name: z.string(),
  account_type: z.string(),
  reconcile: z.boolean(),
  active: z.boolean(),
  company_ids: z.array(id).min(1),
})

type Request = ReturnType<typeof makeClient>
type AccountRow = z.infer<typeof customAccount>

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data)
  if (!result.success) throw new FinanceConnectionError('invalid-response', 'Odoo returned an unexpected response during ledger setup.')
  return result.data
}

async function currentUser(request: Request): Promise<number> {
  return parse(z.object({ uid: id }), await request('res.users/context_get', {})).uid
}

async function requireSetupRights(request: Request, userId: number): Promise<void> {
  const [administrator, createCompany, accounting] = await Promise.all([
    request('res.users/has_group', { ids: [userId], group_ext_id: 'base.group_system' }),
    request('res.company/has_access', { operation: 'create' }),
    request('ir.module.module/search_count', { domain: [['name', '=', 'account'], ['state', '=', 'installed']] }),
  ])
  if (!parse(z.boolean(), administrator) || !parse(z.boolean(), createCompany)) {
    throw new FinanceConnectionError('permissions', 'Use an Odoo settings administrator with company creation access for ledger setup.')
  }
  if (parse(count, accounting) !== 1) {
    throw new FinanceConnectionError('unsupported', 'Install the Odoo Accounting module before setting up a ledger.')
  }
}

/** Verified Odoo database identity for a setup credential. */
export interface OdooSetupConnectionIdentity {
  readonly userId: number
  readonly databaseUuid: string
}

/**
 * Verify the database, settings role and company creation access before any setup writes.
 * @param endpoint Configured Odoo address and database.
 * @param apiKey Odoo settings administrator API key.
 * @param options Request cancellation and deadline.
 * @returns Odoo user and database identity, with no company required.
 */
export async function verifyOdooSetupConnection(
  endpoint: FinanceEndpoint, apiKey: string, options: FinanceRequestOptions,
): Promise<OdooSetupConnectionIdentity> {
  return verifySetupIdentity(makeClient(endpoint, apiKey, options))
}

/**
 * Verify an administration connection and read its owner-visible Odoo login.
 * @param endpoint Configured Odoo address and database.
 * @param apiKey Odoo settings administrator API key.
 * @param options Request cancellation and deadline.
 * @returns Verified database identity and the login when available, without a company binding.
 */
export async function verifyOdooSetupAccount(
  endpoint: FinanceEndpoint, apiKey: string, options: FinanceRequestOptions,
): Promise<{ readonly identity: OdooSetupConnectionIdentity; readonly account?: FinanceOdooAccount }> {
  const { observeAccess: _observeAccess, ...verificationOptions } = options
  const request = makeClient(endpoint, apiKey, verificationOptions)
  const identity = await verifySetupIdentity(request)
  const login = await readOdooLogin(request, identity.userId, apiKey)
  return { identity, ...(login === undefined ? {} : { account: { login } }) }
}

async function verifySetupIdentity(request: Request): Promise<OdooSetupConnectionIdentity> {
  const userId = await currentUser(request)
  await requireSetupRights(request, userId)
  const uuid = z.uuid().safeParse(await request('ir.config_parameter/get_param', { key: 'database.uuid' }))
  if (!uuid.success) throw new FinanceConnectionError('ledger-unverified', 'Odoo did not return its database identity.')
  return { userId, databaseUuid: uuid.data.toLowerCase() }
}

/** Installed accounting template offered by the connected Odoo database. */
export interface OdooSetupTemplate {
  readonly code: string
  readonly name: string
}

/** Resolved country, currency and installed accounting templates. */
export interface OdooSetupChoices {
  readonly country: { readonly id: number; readonly code: string; readonly name: string }
  readonly currency: { readonly id: number; readonly code: string }
  readonly templates: readonly OdooSetupTemplate[]
}

async function installedTemplates(request: Request, countryId: number, countryCode: string): Promise<readonly OdooSetupTemplate[]> {
  const modules = parse(
    z.array(z.object({ account_templates: z.union([z.record(z.string(), templateMetadata), z.literal(false), z.null()]) })),
    await request('ir.module.module/search_read', {
      domain: [['state', '=', 'installed']], fields: ['account_templates'], order: 'id',
    }),
  )
  const templates = new Map<string, OdooSetupTemplate>()
  for (const module of modules) {
    if (!module.account_templates) continue
    for (const [code, template] of Object.entries(module.account_templates)) {
      // Odoo's generic template hardcodes US as the fiscal country.
      const matchingCountry = template.country_id === countryId
        || (code === 'generic_coa' ? countryCode === 'US' : !template.country_id)
      if (template.visible && template.installed && matchingCountry) {
        templates.set(parse(templateKey, code), { code, name: parse(z.string().min(1), template.name) })
      }
    }
  }
  return Array.from(templates.values())
}

async function findCurrency(request: Request, code: string) {
  const [currency] = parse(z.array(z.object({ id, name: z.literal(code) })).max(1), await request('res.currency/search_read', {
    domain: [['name', '=', code]], fields: ['id', 'name'], context: { active_test: false }, limit: 2,
  }))
  return currency
}

/**
 * Resolve the selected country and currency and discover its installed chart templates.
 * @param endpoint Verified Odoo database endpoint.
 * @param apiKey Odoo settings administrator API key.
 * @param query ISO country and currency codes entered for the new company.
 * @param options Request cancellation and deadline.
 * @returns Resolved country, currency and visible templates, including installed custom localizations.
 */
export async function getOdooSetupChoices(
  endpoint: FinanceEndpoint, apiKey: string, query: { readonly countryCode: string; readonly currencyCode: string },
  options: FinanceRequestOptions,
): Promise<OdooSetupChoices> {
  const request = makeClient(endpoint, apiKey, options)
  const countryCode = query.countryCode.trim().toUpperCase()
  const requestedCurrency = query.currencyCode.trim().toUpperCase()
  const currencyCode = requestedCurrency === 'RMB' ? 'CNY' : requestedCurrency
  const [countries, currencyMatch] = await Promise.all([
    request('res.country/search_read', { domain: [['code', '=', countryCode]], fields: ['id', 'code', 'name'], limit: 2 }),
    findCurrency(request, currencyCode),
  ])
  const [country] = parse(z.array(z.object({ id, code: z.literal(countryCode), name: z.string() })).max(1), countries)
  const currency = currencyMatch ?? (country && currencyCode === 'CNY' ? await findCurrency(request, 'RMB') : undefined)
  if (!country || !currency) throw new FinanceConnectionError('invalid-input', 'Select a country and currency known to Odoo.')
  return { country, currency: { id: currency.id, code: currency.name }, templates: await installedTemplates(request, country.id, country.code) }
}

/** Owner-approved company information. */
export interface OdooSetupCompanyDraft {
  readonly name: string
  readonly countryId: number
  readonly currencyId: number
  readonly taxId?: string
  readonly openingDate?: string
}

/** Approved settings for a company created by the setup task. */
export interface OdooSetupTarget {
  readonly companyId: number
  readonly countryId: number
  readonly currencyId: number
  readonly templateCode: string
  readonly openingDate?: string
}

/** Readiness facts for the setup task's Odoo company. */
export interface OdooSetupCompanyStatus {
  readonly company: FinanceCompany
  readonly templateCode: string
  readonly accounts: number
  readonly journals: number
  readonly taxes: number
  readonly canCreateEntries: boolean
}

function contextFor(companyId: number) {
  return { allowed_company_ids: [companyId] }
}

/**
 * Create an independent company with the approved currency and without auto-selecting a chart.
 * A dispatched request with no confirmed ID must be reconciled in Odoo before creating again.
 * @param endpoint Verified Odoo database endpoint.
 * @param apiKey Odoo settings administrator API key.
 * @param draft Approved company information, including optional tax ID and opening date.
 * @param options Request cancellation and deadline.
 * @returns The new company's confirmed Odoo record ID.
 */
export async function createOdooSetupCompany(
  endpoint: FinanceEndpoint, apiKey: string, draft: OdooSetupCompanyDraft, options: FinanceRequestOptions,
): Promise<number> {
  const request = makeClient(endpoint, apiKey, options)
  const domain = draft.taxId
    ? ['|', ['name', '=', draft.name], ['vat', '=', draft.taxId]]
    : [['name', '=', draft.name]]
  const duplicates = parse(count, await request('res.company/search_count', {
    domain, context: { active_test: false },
  }))
  if (duplicates !== 0) throw new FinanceConnectionError('company', 'A company with this name or tax ID already exists. Check it in Odoo before setting up a ledger.')
  const values = {
    name: draft.name, country_id: draft.countryId, currency_id: draft.currencyId, parent_id: false,
    ...(draft.taxId ? { vat: draft.taxId } : {}),
    ...(draft.openingDate ? { account_opening_date: draft.openingDate } : {}),
  }
  const result = await request('res.company/create', {
    vals_list: [values], context: { chart_template_load: true },
  }, true)
  const created = z.tuple([id]).safeParse(result)
  if (!created.success) {
    throw new FinanceConnectionError('unknown-outcome', 'Odoo may have created the company. Check the company list before attempting another creation.')
  }
  return created.data[0]
}

async function readTarget(request: Request, companyId: number): Promise<z.infer<typeof companyRecord>> {
  const userId = await currentUser(request)
  const [company] = parse(z.array(companyRecord).max(1), await request('res.company/search_read', {
    domain: [['id', '=', companyId], ['user_ids', 'in', [userId]]],
    context: contextFor(companyId), fields: companyFields, limit: 1,
  }))
  if (company === undefined || company.id !== companyId) {
    throw new FinanceConnectionError('company', 'The created company is unavailable to this Odoo user.')
  }
  return company
}

function requireExpectedCompany(company: z.infer<typeof companyRecord>, target: OdooSetupTarget): void {
  if (company.country_id[0] !== target.countryId || company.currency_id[0] !== target.currencyId
    || (target.openingDate !== undefined && company.account_opening_date !== target.openingDate)) {
    throw new FinanceConnectionError('ledger-mismatch', 'The created company country, currency or opening date differs from the approved plan.')
  }
}

/** Exact company identity selected for existing-company setup or uncertain-create recovery. */
export interface OdooSetupExistingTarget extends OdooSetupTarget {
  readonly name: string
  readonly taxId?: string
}

/**
 * Find accessible companies matching a saved plan without adopting any result.
 * @param endpoint Verified setup database.
 * @param apiKey Setup administrator credential.
 * @param identity Saved company name and optional tax identifier.
 * @param options Request lifetime and deadline.
 * @returns Company choices requiring an explicit owner selection.
 */
export async function findOdooSetupCompanies(
  endpoint: FinanceEndpoint, apiKey: string, identity: { readonly name: string; readonly taxId?: string }, options: FinanceRequestOptions,
): Promise<readonly FinanceCompany[]> {
  const request = makeClient(endpoint, apiKey, options)
  const userId = await currentUser(request)
  const matches = identity.taxId
    ? ['|', ['name', '=', identity.name], ['vat', '=', identity.taxId]]
    : [['name', '=', identity.name]]
  const rows = parse(z.array(z.object({ id, name: z.string(), currency_id: relation })).max(100),
    await request('res.company/search_read', {
      domain: [['user_ids', 'in', [userId]], ...matches], fields: ['id', 'name', 'currency_id'],
      context: { active_test: false }, order: 'id', limit: 101,
    }))
  return rows.map(company => ({ id: company.id, name: company.name, currency: company.currency_id[1] }))
}

/**
 * Validate an explicitly selected company before adopting it into a setup plan.
 * @param endpoint Verified setup database.
 * @param apiKey Setup administrator credential.
 * @param target Approved identity and template; the opening date may be set during execution.
 * @param options Request lifetime and deadline.
 * @returns Current opening date after identity, activity and template checks pass.
 */
export async function verifyOdooSetupCandidate(
  endpoint: FinanceEndpoint, apiKey: string, target: OdooSetupExistingTarget, options: FinanceRequestOptions,
): Promise<{ readonly openingDate: string | false }> {
  const request = makeClient(endpoint, apiKey, options)
  const company = await readTarget(request, target.companyId)
  if (company.name !== target.name || company.country_id[0] !== target.countryId || company.currency_id[0] !== target.currencyId) {
    throw new FinanceConnectionError('ledger-mismatch', 'The selected company identity, country or currency differs from the saved plan.')
  }
  if (target.taxId !== undefined) {
    const [tax] = parse(z.array(z.object({ id, vat: z.union([z.string(), z.literal(false)]) })).length(1),
      await request('res.company/read', { ids: [company.id], fields: ['vat'], context: contextFor(company.id) }))
    if (tax?.id !== company.id || tax.vat !== target.taxId) {
      throw new FinanceConnectionError('ledger-mismatch', 'The selected company tax identifier differs from the saved plan.')
    }
  }
  if (company.chart_template !== false && company.chart_template !== target.templateCode) {
    throw new FinanceConnectionError('ledger-mismatch', 'The selected company already uses a different accounting template.')
  }
  await requireEmptyMoves(request, company.id)
  if (company.chart_template === false && parse(count, await request('account.account/search_count', {
    domain: [['company_ids', 'in', [company.id]]], context: { ...contextFor(company.id), active_test: false },
  })) !== 0) {
    throw new FinanceConnectionError('ledger-mismatch', 'The selected company has accounts without the approved template. Review its ledger first.')
  }
  return { openingDate: company.account_opening_date }
}

async function requireEmptyMoves(request: Request, companyId: number): Promise<void> {
  const moves = parse(count, await request('account.move/search_count', {
    domain: [['company_id', '=', companyId]], context: { ...contextFor(companyId), active_test: false },
  }))
  if (moves !== 0) throw new FinanceConnectionError('ledger-mismatch', 'The company already has accounting entries. Check its existing ledger before changing setup.')
}

/**
 * Initialize an owner-selected empty company after rechecking its exact identity and activity.
 * @param endpoint Verified setup database.
 * @param apiKey Setup administrator credential.
 * @param target Approved existing company, template and opening date.
 * @param options Request lifetime and deadline.
 * @returns Re-read ledger readiness after applying the approved opening date and template.
 */
export async function initializeOdooExistingSetupCompany(
  endpoint: FinanceEndpoint, apiKey: string, target: OdooSetupExistingTarget, options: FinanceRequestOptions,
): Promise<OdooSetupCompanyStatus> {
  const current = await verifyOdooSetupCandidate(endpoint, apiKey, target, options)
  if (target.openingDate !== undefined && current.openingDate !== target.openingDate) {
    const request = makeClient(endpoint, apiKey, options)
    const written = await request('res.company/write', {
      ids: [target.companyId], vals: { account_opening_date: target.openingDate }, context: contextFor(target.companyId),
    }, true)
    if (written !== true) throw new FinanceConnectionError('unknown-outcome', 'The company opening date change needs verification before continuing.')
  }
  return initializeOdooSetupCompany(endpoint, apiKey, target, options)
}

async function checkReadiness(request: Request, target: OdooSetupTarget): Promise<OdooSetupCompanyStatus> {
  const company = await readTarget(request, target.companyId)
  requireExpectedCompany(company, target)
  if (company.chart_template !== target.templateCode) {
    throw new FinanceConnectionError('ledger-mismatch', 'The selected chart template is not loaded for the created company.')
  }
  if (!company.account_fiscal_country_id || company.account_fiscal_country_id[0] !== target.countryId) {
    throw new FinanceConnectionError('ledger-mismatch', 'The ledger fiscal country differs from the approved company country.')
  }
  const context = contextFor(company.id)
  const [accounts, journals, general, taxes, mayRead, mayCreate] = await Promise.all([
    request('account.account/search_count', { domain: [['company_ids', 'in', [company.id]]], context }),
    request('account.journal/search_count', { domain: [['company_id', '=', company.id]], context }),
    request('account.journal/search_count', { domain: [['company_id', '=', company.id], ['type', '=', 'general']], context }),
    request('account.tax/search_count', { domain: [['company_id', '=', company.id]], context }),
    request('account.move/has_access', { operation: 'read', context }),
    request('account.move/has_access', { operation: 'create', context }),
  ])
  const accountCount = parse(count, accounts)
  const journalCount = parse(count, journals)
  if (accountCount < 2 || parse(count, general) < 1) {
    throw new FinanceConnectionError('ledger-unverified', 'Ledger setup needs at least two usable accounts and a miscellaneous journal.')
  }
  if (!parse(z.boolean(), mayRead) || !parse(z.boolean(), mayCreate)) {
    throw new FinanceConnectionError('permissions', 'The Odoo user cannot read and create journal entries in the new company.')
  }
  return {
    company: { id: company.id, name: company.name, currency: company.currency_id[1] },
    templateCode: company.chart_template, accounts: accountCount, journals: journalCount,
    taxes: parse(count, taxes), canCreateEntries: true,
  }
}

/**
 * Initialize the approved chart on a new independent company and check its resulting ledger.
 * Existing matching templates are checked in place. Any other template or prior activity requires review.
 * @param endpoint Verified Odoo database endpoint.
 * @param apiKey Odoo settings administrator API key.
 * @param target Confirmed company identity and approved chart.
 * @param options Request cancellation and deadline.
 * @returns Company and readiness facts after the selected chart is present.
 */
export async function initializeOdooSetupCompany(
  endpoint: FinanceEndpoint, apiKey: string, target: OdooSetupTarget, options: FinanceRequestOptions,
): Promise<OdooSetupCompanyStatus> {
  const request = makeClient(endpoint, apiKey, options)
  const company = await readTarget(request, target.companyId)
  requireExpectedCompany(company, target)
  if (company.chart_template === target.templateCode) return checkReadiness(request, target)
  if (company.chart_template !== false) {
    throw new FinanceConnectionError('ledger-mismatch', 'The new company has a different chart template. Check its accounting settings before proceeding.')
  }
  const templates = await installedTemplates(request, target.countryId, company.country_code)
  if (!templates.some(template => template.code === target.templateCode)) {
    throw new FinanceConnectionError('unsupported', 'Install and confirm the selected accounting template in Odoo before using it.')
  }
  await requireEmptyMoves(request, company.id)
  const context = contextFor(company.id)
  const accountCount = parse(count, await request('account.account/search_count', {
    domain: [['company_ids', 'in', [company.id]]], context: { ...context, active_test: false },
  }))
  if (accountCount !== 0) {
    throw new FinanceConnectionError('ledger-mismatch', 'The company already has accounts. Review them before loading a chart template.')
  }
  await request('account.chart.template/try_loading', {
    template_code: target.templateCode, company: company.id, install_demo: false, context,
  }, true)
  return checkReadiness(request, target)
}

/**
 * Re-read the approved company and verify its chart, accounts, journals and entry access.
 * @param endpoint Verified Odoo database endpoint.
 * @param apiKey Odoo key authorized for the created company.
 * @param target Confirmed company identity and approved chart.
 * @param options Request cancellation and deadline.
 * @returns Current company and readiness facts.
 */
export function verifyOdooSetupCompany(
  endpoint: FinanceEndpoint, apiKey: string, target: OdooSetupTarget, options: FinanceRequestOptions,
): Promise<OdooSetupCompanyStatus> {
  return checkReadiness(makeClient(endpoint, apiKey, options), target)
}

/**
 * Confirm the separate day-to-day credential can work in the company it will receive.
 * @param endpoint Verified Odoo database endpoint.
 * @param apiKey Day-to-day Odoo API key.
 * @param target Created company and whether the receiving connector needs entry creation.
 * @param options Request cancellation and deadline.
 * @returns Odoo user ID for comparison with the setup credential's owner.
 */
export async function verifyOdooSetupHandoffUser(
  endpoint: FinanceEndpoint, apiKey: string,
  target: { readonly companyId: number; readonly requireCreate: boolean }, options: FinanceRequestOptions,
): Promise<number> {
  await verifyOdooCompany(endpoint, apiKey, target.companyId, options)
  const request = makeClient(endpoint, apiKey, options)
  const userId = await currentUser(request)
  if (target.requireCreate && !parse(z.boolean(), await request('account.move/has_access', {
    operation: 'create', context: contextFor(target.companyId),
  }))) {
    throw new FinanceConnectionError('permissions', 'The receiving Odoo user cannot create journal entries in the new company.')
  }
  return userId
}

/** An approved workbook row conflicts with a pre-existing account before import dispatch. */
export class OdooSetupAccountConflict extends FinanceConnectionError {
  constructor(code: string) {
    super('ledger-mismatch', accountConflictMessage(code))
  }
}

function accountConflictMessage(code: string): string {
  return 'Existing account ' + code + ' differs from the approved workbook. Review it in Odoo.'
}

interface OdooSetupAccountDraft {
  readonly companyId: number
  readonly rows: readonly AccountRow[]
}

function parseAccountRows(draft: OdooSetupAccountDraft): readonly AccountRow[] {
  const rows = customAccounts.safeParse(draft.rows)
  if (!rows.success || new Set(rows.data.map(row => row.code)).size !== rows.data.length) {
    throw new FinanceConnectionError('invalid-input', 'Review the approved workbook account rows and ensure each code is unique.')
  }
  return rows.data
}

async function findCustomAccounts(
  request: Request, companyId: number, rows: readonly AccountRow[], phase: 'preflight' | 'verification',
) {
  const existing = parse(z.array(importedAccount).max(rows.length), await request('account.account/search_read', {
    domain: [['company_ids', 'in', [companyId]], ['code', 'in', rows.map(row => row.code)]],
    fields: Object.keys(importedAccount.shape), limit: rows.length + 1,
    context: { ...contextFor(companyId), active_test: false },
  }))
  const planned = new Map(rows.map(row => [row.code, row]))
  const matches = new Set<string>()
  for (const account of existing) {
    const row = planned.get(account.code)
    if (!row || matches.has(account.code) || !account.company_ids.includes(companyId)) {
      throw new FinanceConnectionError('ledger-mismatch', 'Odoo returned an unexpected company or duplicate account code during import.')
    }
    if (!account.active || account.name !== row.name || account.account_type !== row.accountType || account.reconcile !== row.reconcile) {
      if (phase === 'preflight') throw new OdooSetupAccountConflict(row.code)
      throw new FinanceConnectionError('ledger-mismatch', accountConflictMessage(row.code))
    }
    matches.add(account.code)
  }
  return rows.filter(row => !matches.has(row.code))
}

/**
 * Add missing approved custom accounts to a newly initialized company and confirm every row.
 * Matching accounts are reused and conflicting accounts stop the import before any write.
 * @param endpoint Verified Odoo database endpoint.
 * @param apiKey Odoo settings administrator API key.
 * @param draft Created company ID and validated workbook account rows.
 * @param options Request cancellation and deadline.
 * @returns Completion after all rows match the approved workbook.
 */
export async function importOdooSetupAccounts(
  endpoint: FinanceEndpoint, apiKey: string,
  draft: OdooSetupAccountDraft, options: FinanceRequestOptions,
): Promise<void> {
  const rows = parseAccountRows(draft)
  const request = makeClient(endpoint, apiKey, options)
  const company = await readTarget(request, draft.companyId)
  if (!company.chart_template) {
    throw new FinanceConnectionError('ledger-unverified', 'Load the approved base template before importing workbook accounts.')
  }
  await requireEmptyMoves(request, company.id)
  const missing = await findCustomAccounts(request, company.id, rows, 'preflight')
  if (missing.length === 0) return
  const result = await request('account.account/create', {
    vals_list: missing.map(row => ({
      code: row.code, name: row.name, account_type: row.accountType, reconcile: row.reconcile,
      company_ids: [[6, 0, [company.id]]],
    })),
    context: contextFor(company.id),
  }, true)
  if (!z.array(id).length(missing.length).safeParse(result).success) {
    throw new FinanceConnectionError('unknown-outcome', 'Odoo may have imported the workbook accounts. Check their codes before continuing.')
  }
  if ((await findCustomAccounts(request, company.id, rows, 'verification')).length !== 0) {
    throw new FinanceConnectionError('ledger-unverified', 'Some approved workbook accounts are missing after import. Check their codes in Odoo.')
  }
}

/**
 * Re-read the approved workbook accounts before handing the ledger to its bookkeeping group.
 * @param endpoint Verified Odoo database endpoint.
 * @param apiKey Odoo setup credential authorized for the company.
 * @param draft Created company ID and validated workbook account rows.
 * @param options Request cancellation and deadline.
 * @returns Completion after every approved account is active and matches the workbook.
 */
export async function verifyOdooSetupAccounts(
  endpoint: FinanceEndpoint, apiKey: string, draft: OdooSetupAccountDraft, options: FinanceRequestOptions,
): Promise<void> {
  const rows = parseAccountRows(draft)
  const request = makeClient(endpoint, apiKey, options)
  if ((await findCustomAccounts(request, draft.companyId, rows, 'verification')).length !== 0) {
    throw new FinanceConnectionError('ledger-unverified', 'Some approved workbook accounts are missing. Review the imported accounts in Odoo.')
  }
}
