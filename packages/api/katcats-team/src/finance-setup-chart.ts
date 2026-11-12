/** Decode a bounded, values-only Excel chart for review before Odoo provisioning. */
import ExcelJS, { type CellValue } from 'exceljs'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fromBuffer, type Entry, type ZipFile } from 'yauzl'
import { z } from 'zod'

/** Largest accepted compressed chart workbook in bytes. */
export const FINANCE_SETUP_CHART_MAX_BYTES = 1024 * 1024

/** Largest accepted number of custom chart rows. */
export const FINANCE_SETUP_CHART_MAX_ACCOUNTS = 500

const MAX_EXPANDED_BYTES = 8 * FINANCE_SETUP_CHART_MAX_BYTES
const MAX_ARCHIVE_ENTRIES = 64

const accountTypeLabels = {
  asset_receivable: ['Receivable', '应收', '应收账款'],
  asset_cash: ['Bank and Cash', '银行和现金', '银行与现金'],
  asset_current: ['Current Assets', '流动资产'],
  asset_non_current: ['Non-current Assets', '非流动资产'],
  asset_prepayments: ['Prepayments', '预付款项', '预付款'],
  asset_fixed: ['Fixed Assets', '固定资产'],
  liability_payable: ['Payable', '应付', '应付账款'],
  liability_credit_card: ['Credit Card', '信用卡'],
  liability_current: ['Current Liabilities', '流动负债'],
  liability_non_current: ['Non-current Liabilities', '非流动负债'],
  equity: ['Equity', '所有者权益', '权益'],
  equity_unaffected: ['Current Year Earnings', '本年利润'],
  income: ['Income', '收入'],
  income_other: ['Other Income', '其他收入'],
  expense: ['Expenses', '费用'],
  expense_other: ['Other Expenses', '其他费用'],
  expense_depreciation: ['Depreciation', '折旧'],
  expense_direct_cost: ['Cost of Revenue', '营业成本', '直接成本'],
  off_balance: ['Off-Balance Sheet', '表外科目', '表外'],
} as const satisfies Record<string, readonly string[]>

const accountType = z.enum(Object.keys(accountTypeLabels) as (keyof typeof accountTypeLabels)[])

const code = z.string().trim().regex(/^[A-Za-z0-9.]{1,64}$/)
const name = z.string().trim().min(1).max(200)

function requiresReconcile(type: z.infer<typeof accountType>): boolean {
  return type === 'asset_receivable' || type === 'liability_payable'
}

function supportsReconcile(type: z.infer<typeof accountType>): boolean {
  return type !== 'asset_cash' && type !== 'liability_credit_card' && type !== 'off_balance'
}

/** Normalized chart row persisted with the owner-approved setup plan. */
export const financeSetupAccountSchema = z.strictObject({
  code,
  name,
  accountType,
  reconcile: z.boolean(),
}).refine(row => (!requiresReconcile(row.accountType) || row.reconcile)
  && (supportsReconcile(row.accountType) || !row.reconcile))

/** One normalized Odoo account for the company being initialized. */
export type FinanceSetupAccount = Readonly<z.infer<typeof financeSetupAccountSchema>>

const reasonText = {
  size: 'Choose an XLSX file no larger than 1 MiB.',
  workbook: 'Choose a valid XLSX chart without macros or external workbook links.',
  worksheet: 'Put the chart in one visible worksheet.',
  headers: 'Use the headers code, name, account_type, and optional reconcile on the first row.',
  empty: 'Add at least one account below the column headers.',
  rows: 'Use at most 500 account rows.',
  formula: 'Replace formulas with their values before uploading.',
  code: 'Enter an account code using letters, digits or dots, with at most 64 characters. Use text for leading zeros.',
  name: 'Enter an account name of 1 to 200 characters.',
  'account-type': 'Choose an Odoo account type for this account.',
  reconcile: 'Use yes or no for reconciliation. Receivable and payable accounts require it.',
  'duplicate-code': 'Each account code must be unique.',
  'extra-column': 'Remove values in columns outside the chart headers.',
} as const

/** Stable import failure identifier for the settings editor. */
export type FinanceSetupChartFailureReason = keyof typeof reasonText

/** Workbook validation failure before any plan or Odoo record changes. */
export class FinanceSetupChartError extends Error {
  override readonly name = 'FinanceSetupChartError'

  constructor(readonly reason: FinanceSetupChartFailureReason, readonly row?: number) {
    super(row === undefined ? reasonText[reason] : 'Excel row ' + row + '. ' + reasonText[reason])
  }
}

function openArchive(bytes: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
      if (error) reject(error)
      else resolve(zip)
    })
  })
}

async function checkEntry(archive: ZipFile, entry: Entry): Promise<void> {
  const path = entry.fileName.toLowerCase()
  if (entry.isEncrypted() || /(?:^|\/)vbaproject\.bin$|^xl\/(?:externallinks|macrosheets)\//.test(path)) {
    throw new FinanceSetupChartError('workbook')
  }
  const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
    archive.openReadStream(entry, (error, input) => {
      if (error) reject(error)
      else resolve(input)
    })
  })
  const contentTypes: Buffer[] = []
  await pipeline(stream, new Writable({
    write(chunk: Buffer, _encoding, done) {
      if (path === '[content_types].xml') contentTypes.push(chunk)
      done()
    },
  }))
  if (contentTypes.length > 0 && /macroenabled|vbaproject|macrosheet/i.test(Buffer.concat(contentTypes).toString('utf8'))) {
    throw new FinanceSetupChartError('workbook')
  }
}

async function checkArchive(bytes: Buffer): Promise<void> {
  const archive = await openArchive(bytes)
  let expandedBytes = 0
  const paths = new Set<string>()
  try {
    if (archive.entryCount > MAX_ARCHIVE_ENTRIES) throw new FinanceSetupChartError('size')
    await new Promise<void>((resolve, reject) => {
      archive.on('error', reject)
      archive.once('end', resolve)
      archive.on('entry', (entry: Entry) => {
        expandedBytes += entry.uncompressedSize
        if (expandedBytes > MAX_EXPANDED_BYTES) {
          reject(new FinanceSetupChartError('size'))
          return
        }
        const path = entry.fileName.toLowerCase()
        if (paths.has(path)) {
          reject(new FinanceSetupChartError('workbook'))
          return
        }
        paths.add(path)
        void checkEntry(archive, entry).then(() => archive.readEntry(), reject)
      })
      archive.readEntry()
    })
  } finally {
    archive.close()
  }
}

const headerColumns = {
  code: ['code', '科目编码', '科目代码', '科目编号'],
  name: ['name', '科目名称'],
  accountType: ['account_type', '科目类型', '账户类型'],
  reconcile: ['reconcile', '允许核销', '可核销'],
} satisfies Record<keyof FinanceSetupAccount, string[]>

function lookup<Type extends string>(labels: Record<Type, readonly string[]>, value: string): Type | undefined {
  const text = value.trim().toLowerCase()
  for (const key in labels) {
    if (key.toLowerCase() === text || labels[key].some(label => label.toLowerCase() === text)) return key
  }
  return undefined
}

function blank(value: CellValue): boolean {
  return value == null || (typeof value === 'string' && value.trim() === '')
}

function columnMap(row: ExcelJS.Row) {
  const columns = new Map<keyof FinanceSetupAccount, number>()
  row.eachCell((cell, index) => {
    if (cell.type === ExcelJS.ValueType.Formula) throw new FinanceSetupChartError('formula', row.number)
    if (blank(cell.value)) return
    const key = typeof cell.value === 'string' ? lookup(headerColumns, cell.value) : undefined
    if (!key || columns.has(key)) throw new FinanceSetupChartError('headers', row.number)
    columns.set(key, index)
  })
  const code = columns.get('code')
  const name = columns.get('name')
  const accountType = columns.get('accountType')
  if (code === undefined || name === undefined || accountType === undefined) {
    throw new FinanceSetupChartError('headers', row.number)
  }
  return { code, name, accountType, reconcile: columns.get('reconcile'), allowed: new Set(columns.values()) }
}

function accountCode(value: CellValue, numberFormat: string, row: number): string {
  let text = value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < 1e15) {
    if (!numberFormat || numberFormat === 'General') text = String(value)
    else if (/^0{1,64}$/.test(numberFormat)) text = String(value).padStart(numberFormat.length, '0')
  }
  const result = code.safeParse(text)
  if (!result.success) throw new FinanceSetupChartError('code', row)
  return result.data
}

function accountReconcile(value: CellValue, type: FinanceSetupAccount['accountType'], row: number): boolean {
  if (blank(value)) return requiresReconcile(type)
  const option = typeof value === 'string' ? value.trim().toLowerCase() : value
  if (option === true || option === 1 || option === '1' || option === 'yes' || option === 'true' || option === '是') {
    if (!supportsReconcile(type)) throw new FinanceSetupChartError('reconcile', row)
    return true
  }
  if (option === false || option === 0 || option === '0' || option === 'no' || option === 'false' || option === '否') {
    if (requiresReconcile(type)) throw new FinanceSetupChartError('reconcile', row)
    return false
  }
  throw new FinanceSetupChartError('reconcile', row)
}

/**
 * Decode one worksheet with code, name, Odoo account type, and optional reconciliation columns.
 * @param bytes - raw uploaded XLSX bytes.
 * @returns Validated account rows in workbook order.
 * @throws FinanceSetupChartError before returning any rows if the file or a row cannot be imported.
 */
export async function parseFinanceSetupChart(bytes: Uint8Array): Promise<readonly FinanceSetupAccount[]> {
  if (bytes.byteLength > FINANCE_SETUP_CHART_MAX_BYTES) throw new FinanceSetupChartError('size')
  const workbook = new ExcelJS.Workbook()
  const input = Buffer.from(bytes)
  try {
    await checkArchive(input)
    await workbook.xlsx.load(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength), {
      ignoreNodes: ['drawing', 'mergeCells', 'dataValidations', 'conditionalFormatting'],
    })
  } catch (error) {
    if (error instanceof FinanceSetupChartError) throw error
    throw new FinanceSetupChartError('workbook')
  }

  const [sheet] = workbook.worksheets
  if (!sheet || sheet.state !== 'visible' || workbook.worksheets.length !== 1) throw new FinanceSetupChartError('worksheet')
  if (sheet.rowCount > FINANCE_SETUP_CHART_MAX_ACCOUNTS + 1) throw new FinanceSetupChartError('rows')
  const columns = columnMap(sheet.getRow(1))
  const accounts: FinanceSetupAccount[] = []
  const codes = new Set<string>()
  sheet.eachRow((row, index) => {
    if (index === 1) return
    let populated = false
    row.eachCell((cell, column) => {
      if (cell.type === ExcelJS.ValueType.Formula) throw new FinanceSetupChartError('formula', index)
      if (blank(cell.value)) return
      if (!columns.allowed.has(column)) throw new FinanceSetupChartError('extra-column', index)
      populated = true
    })
    if (!populated) return
    const codeCell = row.getCell(columns.code)
    const parsedCode = accountCode(codeCell.value, codeCell.numFmt, index)
    const parsedName = name.safeParse(row.getCell(columns.name).value)
    if (!parsedName.success) throw new FinanceSetupChartError('name', index)
    const typeValue = row.getCell(columns.accountType).value
    const type = typeof typeValue === 'string' ? lookup(accountTypeLabels, typeValue) : undefined
    if (!type) throw new FinanceSetupChartError('account-type', index)
    const reconcileColumn = columns.reconcile
    const reconcile = accountReconcile(reconcileColumn === undefined ? undefined : row.getCell(reconcileColumn).value, type, index)
    const codeKey = parsedCode.toLowerCase()
    if (codes.has(codeKey)) throw new FinanceSetupChartError('duplicate-code', index)
    codes.add(codeKey)
    accounts.push({ code: parsedCode, name: parsedName.data, accountType: type, reconcile })
  })
  if (accounts.length === 0) throw new FinanceSetupChartError('empty')
  return accounts
}
