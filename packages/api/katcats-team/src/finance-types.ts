/** Finance connector configuration and bounded group-query values. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Stable identity of a configured connector. */
export type FinanceConnectorId = Branded<'XiaojingFinanceConnectorId'>

/** Expected connector failures, translated by the receiving surface. */
export const financeFailureReasons = [
  'invalid-input', 'invalid-address', 'authentication', 'database', 'company', 'permissions',
  'network', 'timeout', 'cancelled', 'unsupported', 'invalid-response', 'not-found',
  'in-use', 'storage', 'unbound', 'credential', 'ledger-unverified', 'ledger-mismatch',
  'unknown-outcome',
] as const

/** Machine-readable failure classification. */
export type FinanceFailureReason = typeof financeFailureReasons[number]

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** User-visible connector failures with a bounded reason and secret-free message. */
    'xiaojing/finance-connector': { readonly reason: FinanceFailureReason }
  }
}

/** Odoo origin or reverse-proxy base and its selected database. */
export interface FinanceEndpoint {
  readonly url: string
  readonly database: string
}

/** Maximum ORM authority the connector owner enabled. */
export type FinanceOrmAccessMode = 'read-only' | 'full'

/** Owner-visible information about the API-key user from the last successful verification. */
export interface FinanceOdooAccount {
  /** The user's Odoo login when Odoo exposes it. */
  readonly login?: string
}

/** Credentials supplied for discovery or to replace an existing key. */
export interface FinanceConnectionDraft extends FinanceEndpoint {
  readonly id?: FinanceConnectorId
  readonly apiKey?: string
  readonly accessMode?: FinanceOrmAccessMode
}

/** An Odoo company available to the configured credential. */
export interface FinanceCompany {
  readonly id: number
  readonly name: string
  readonly currency: string
}

/** Verified connector destination and display name to save. */
export interface SaveFinanceConnectorRequest extends FinanceConnectionDraft {
  readonly name: string
  readonly companyId: number
}

/** Operations made available by a read-only connector. */
export type FinanceCapability = 'accounts' | 'journals' | 'moves' | 'move-lines' | 'entries' | 'turnover'

/** Latest observed access in this process, independent of the saved explicit test. */
export interface FinanceConnectorAccessHealth {
  readonly checkedAt: string
  readonly outcome: 'reachable' | 'unreachable'
}

/** Connector status and company identity, with credential material excluded. */
export interface FinanceConnector extends FinanceEndpoint {
  readonly id: FinanceConnectorId
  readonly name: string
  readonly type: 'odoo'
  readonly company: FinanceCompany
  readonly lastTestAt: string
  readonly failure: FinanceFailureReason | null
  readonly capabilities: readonly FinanceCapability[]
  /** Absent in older connector projections, where ORM access defaults to read-only. */
  readonly accessMode?: FinanceOrmAccessMode
  readonly accessHealth?: FinanceConnectorAccessHealth
  /** Absent until an explicit connection verification supplies account information. */
  readonly account?: FinanceOdooAccount
}

/** Current configured connections, with values safe for the owner UI. */
export interface FinanceConnectorSnapshot {
  readonly connectors: readonly FinanceConnector[]
}

type DatedFinanceLookup = {
  readonly from: string
  readonly to: string
  readonly state: 'posted' | 'draft' | 'all'
  readonly search?: string
}

type FinanceLookup =
  | { readonly kind: 'accounts' | 'journals'; readonly search?: string }
  | ({ readonly kind: 'moves' } & DatedFinanceLookup)
  | ({ readonly kind: 'entries' } & DatedFinanceLookup)
  | { readonly kind: 'move-lines'; readonly moveId: number }
  | { readonly kind: 'turnover'; readonly from: string; readonly to: string }

/** Ledger query limited to the conversation's configured company. */
export type FinanceQuery = FinanceLookup & { readonly offset?: number; readonly limit?: number }

/** A complete export of one company-scoped voucher or voucher-line dataset. */
export type FinanceExportQuery = Extract<FinanceLookup, { kind: 'moves' | 'entries' | 'move-lines' }>

/** Bounded projection of Odoo fields with totals calculated for the full matching scope. */
export interface FinanceQueryResult {
  readonly company: FinanceCompany
  readonly query: FinanceQuery
  readonly rows: readonly Readonly<Record<string, string | number | boolean | null>>[]
  readonly total: number
  readonly totals?: { readonly debit: number; readonly credit: number }
}

/** Ledger data accompanied by the group’s configured connector identity. */
export interface GroupFinanceQueryResult extends FinanceQueryResult {
  readonly connector: Pick<FinanceConnector, 'id' | 'name' | 'type'>
}

/** A public model method and its JSON-2 keyword parameters, including optional wizard selection. */
export interface FinanceOrmCallRequest {
  readonly model: string
  readonly method: string
  readonly params: unknown
}

/** A JSON-serializable value sent to or returned by Odoo. */
export type FinanceOrmJsonValue = JsonValue

/** Bounded JSON-2 response from the bound connector. */
export interface FinanceOrmCallResult {
  readonly connector: Pick<FinanceConnector, 'id' | 'name' | 'type'>
  readonly company: FinanceCompany
  readonly model: string
  readonly method: string
  readonly data: FinanceOrmJsonValue
}

/**
 * Confirm the exact connector and JSON-2 body; reject to prevent the request.
 * An optional returned check runs after queueing and credential lookup, immediately before dispatch.
 * Return void when no additional dispatch-time check is needed.
 */
export type FinanceOrmWriteAuthorization = (connector: FinanceConnector, signal: AbortSignal,
  body: Readonly<Record<string, unknown>>) => Promise<void | (() => Promise<void>)>
