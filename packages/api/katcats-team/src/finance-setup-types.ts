/** Owner-facing values for the Odoo ledger setup workflow. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ChatId } from './chats-types.ts'
import type { FinanceCompany, FinanceEndpoint, FinanceFailureReason, FinanceOdooAccount, FinanceOrmAccessMode } from './finance-types.ts'

/** A saved ledger setup task, independent of any group binding. */
export type LedgerSetupPlanId = Branded<'XiaojingLedgerSetupPlanId'>

/** Set up a database credential without selecting a company. */
export interface LedgerSetupConnectionInput extends FinanceEndpoint {
  readonly apiKey?: string
}

/** Access mode and separate day-to-day accounting credential for the new connector. */
export interface LedgerSetupConnectorInput {
  readonly accessMode: FinanceOrmAccessMode
  readonly apiKey: string
}

/** Setup modes supported for a new independent company. */
export type LedgerSetupMode = 'odoo-template' | 'custom-chart'

/** A confirmed company creation is checkpointed before its configuration is changed. */
export type LedgerSetupStatus = 'draft' | 'running' | 'blocked' | 'uncertain' | 'ready' | 'handed-off'

/** Company details and chart source proposed by the private assistant. */
export interface LedgerSetupDraftInput {
  /** Exact existing empty company selected by the user; omitted when creating a new company. */
  readonly existingCompanyId?: number
  readonly name: string
  readonly taxId?: string
  readonly countryCode: string
  readonly currencyCode: string
  readonly templateCode: string
  readonly openingDate: string
  readonly mode: LedgerSetupMode
}

/** Redacted, revisioned plan shown to the owner before execution. */
export interface LedgerSetupPlan extends LedgerSetupDraftInput {
  readonly id: LedgerSetupPlanId
  readonly revision: number
  readonly templateName: string
  readonly createdAt: string
  readonly status: LedgerSetupStatus
  readonly customAccountCount: number
  readonly customChartEditable?: boolean
  readonly customChart?: { readonly name: string; readonly sha256: string }
  readonly companyId?: number
  readonly company?: FinanceCompany
  readonly accountCount?: number
  readonly journalCount?: number
  readonly failure?: FinanceFailureReason
  /** Historical group selection from the original handoff flow. */
  readonly chatId?: ChatId
}

/** Only public connection metadata and plan summaries cross the remote interface. */
export interface LedgerSetupSnapshot {
  readonly connection: (FinanceEndpoint & { readonly verifiedAt: string; readonly account?: FinanceOdooAccount }) | null
  readonly plans: readonly LedgerSetupPlan[]
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Expected validation failures in an owner's workbook. */
    'xiaojing/ledger-setup-chart': { readonly reason: string; readonly row?: number }
  }
}
