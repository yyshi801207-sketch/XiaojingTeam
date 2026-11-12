/** Durable Odoo administrative write intents and their verified readback. */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { FinanceOrmJsonValue } from './finance-types.ts'

/** One owner-confirmed administrative mutation. */
export type OdooAdminOperationId = Branded<'OdooAdminOperationId'>

/** Fields and existing records captured before an administrative write is dispatched. */
export interface OdooAdminWriteWitness {
  readonly fields: readonly string[]
  readonly fieldTypes: Readonly<Record<string, string>>
  readonly targets: readonly {
    readonly id?: number | undefined
    readonly beforeIds: readonly number[]
    readonly values: Readonly<Record<string, FinanceOrmJsonValue>>
  }[]
}

/** Redacted state displayed to the owner and the responsible fixed assistant. */
export interface OdooAdminOperation {
  readonly id: OdooAdminOperationId
  readonly role: 'ledger' | 'access'
  readonly database: string
  readonly model: string
  readonly method: string
  readonly companyId?: number
  readonly status: 'pending' | 'unknown' | 'verified' | 'rejected'
  readonly createdAt: string
  readonly updatedAt: string
  readonly recordIds?: readonly number[]
  readonly records?: readonly Readonly<Record<string, FinanceOrmJsonValue>>[]
  readonly candidates?: readonly (readonly number[])[]
  readonly failure?: string
}

const record = z.record(z.string(), z.json())
const ids = z.array(z.number().int().positive()).max(100)
const witness = z.object({
  fields: z.array(z.string()), fieldTypes: z.record(z.string(), z.string()),
  targets: z.array(z.object({ id: z.number().int().positive().optional(), beforeIds: ids, values: record })),
})
const operation = z.object({
  id: z.uuid().transform(value => brandString<OdooAdminOperationId>(value)),
  role: z.enum(['ledger', 'access']), database: z.string(),
  identity: z.object({ databaseUuid: z.uuid(), userId: z.number().int().positive() }),
  model: z.string(), method: z.string(), companyId: z.number().int().positive().optional(),
  params: record, witness,
  status: z.enum(['pending', 'unknown', 'verified', 'rejected']),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  recordIds: ids.optional(), records: z.array(record).max(100).optional(),
  candidates: z.array(ids).max(100).optional(), failure: z.string().optional(),
})

/** Separate from setup plans; a saved pending intent blocks re-dispatch after a crash. */
export const odooAdminOperationDomain = defineDomain({
  name: 'xiaojing_odoo_admin_operations', version: 1,
  global: { schema: z.object({ operations: z.array(operation) }), initial: { operations: [] } }, tables: {},
})

/** Validated private operation including its exact approved parameters and database identity. */
export type StoredOdooAdminOperation = z.output<typeof operation>

/**
 * Omit private recovery parameters from the UI and model-facing operation summary.
 * @param operation Saved write intent.
 * @returns Its redacted outcome and readback evidence.
 */
export function publicOdooAdminOperation(operation: StoredOdooAdminOperation): OdooAdminOperation {
  const { params: _params, witness: _witness, identity: _identity,
    companyId, recordIds, records, candidates, failure, ...value } = operation
  return { ...value,
    ...(companyId === undefined ? {} : { companyId }),
    ...(recordIds === undefined ? {} : { recordIds }),
    ...(records === undefined ? {} : { records }),
    ...(candidates === undefined ? {} : { candidates }),
    ...(failure === undefined ? {} : { failure }),
  }
}
