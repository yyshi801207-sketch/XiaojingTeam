import ExcelJS, { type CellValue } from 'exceljs'
import { describe, expect, it } from 'vitest'
import {
  FINANCE_SETUP_CHART_MAX_ACCOUNTS, FINANCE_SETUP_CHART_MAX_BYTES,
  financeSetupAccountSchema, parseFinanceSetupChart,
} from '../src/finance-setup-chart.ts'

const columns = ['code', 'name', 'account_type', 'reconcile']

async function sheetBytes(rows: readonly (readonly CellValue[])[], prepare?: (sheet: ExcelJS.Worksheet) => void): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('科目表')
  for (const row of rows) sheet.addRow([...row])
  prepare?.(sheet)
  return new Uint8Array(await workbook.xlsx.writeBuffer())
}

describe('custom accounting chart import', () => {
  it('preserves text codes, reads ordinary numeric codes, and normalizes reconciliation defaults', async () => {
    const bytes = await sheetBytes([
      ['科目名称', '科目编码', '科目类型', '允许核销'],
      ['现金', '001001', '银行和现金'],
      ['应收账款', 1122, '应收账款'],
      ['内部往来', 'A.002', 'asset_current', '是'],
    ])
    await expect(parseFinanceSetupChart(bytes)).resolves.toEqual([
      { code: '001001', name: '现金', accountType: 'asset_cash', reconcile: false },
      { code: '1122', name: '应收账款', accountType: 'asset_receivable', reconcile: true },
      { code: 'A.002', name: '内部往来', accountType: 'asset_current', reconcile: true },
    ])
  })

  it('preserves fixed-width zero padding in a numeric account code', async () => {
    const bytes = await sheetBytes([columns, [101, '现金', 'asset_cash']], sheet => {
      sheet.getCell('A2').numFmt = '000000'
    })
    await expect(parseFinanceSetupChart(bytes)).resolves.toMatchObject([{ code: '000101' }])
  })

  it('rejects an ambiguously formatted numeric code at its workbook row', async () => {
    const bytes = await sheetBytes([columns, [101, '现金', 'asset_cash']], sheet => {
      sheet.getCell('A2').numFmt = '000-000'
    })
    await expect(parseFinanceSetupChart(bytes)).rejects.toMatchObject({ reason: 'code', row: 2 })
  })

  it('rejects computed cells instead of importing cached values', async () => {
    const bytes = await sheetBytes([columns, [{ formula: '10+20', result: 30 }, '现金', 'asset_cash']])
    await expect(parseFinanceSetupChart(bytes)).rejects.toMatchObject({ reason: 'formula', row: 2 })
  })

  it.each([
    { rows: [columns, ['A.1', '现金', 'asset_cash'], ['a.1', '银行', 'asset_cash']], reason: 'duplicate-code', row: 3 },
    { rows: [columns, ['1001', '现金', '资产']], reason: 'account-type', row: 2 },
    { rows: [columns, ['1001', '现金', 'asset_cash', true]], reason: 'reconcile', row: 2 },
    { rows: [columns, ['1122', '应收账款', 'asset_receivable', '否']], reason: 'reconcile', row: 2 },
    { rows: [columns, ['1001', '现金', 'asset_cash', false, '意外数据']], reason: 'extra-column', row: 2 },
    { rows: [['code', '科目编码', 'name', 'account_type']], reason: 'headers', row: 1 },
  ])('rejects $reason at row $row', async ({ rows, reason, row }) => {
    await expect(parseFinanceSetupChart(await sheetBytes(rows))).rejects.toMatchObject({ reason, row })
  })

  it('rejects empty or overlong charts', async () => {
    await expect(parseFinanceSetupChart(await sheetBytes([columns]))).rejects.toMatchObject({ reason: 'empty' })
    const rows = Array.from({ length: FINANCE_SETUP_CHART_MAX_ACCOUNTS + 1 }, (_, index) => [index + 1, '现金', 'asset_cash'])
    await expect(parseFinanceSetupChart(await sheetBytes([columns, ...rows]))).rejects.toMatchObject({ reason: 'rows' })
  })

  it('rejects corrupt or oversized archives and multi-sheet files', async () => {
    await expect(parseFinanceSetupChart(new Uint8Array([1, 2, 3, 4]))).rejects.toMatchObject({ reason: 'workbook' })
    await expect(parseFinanceSetupChart(new Uint8Array(FINANCE_SETUP_CHART_MAX_BYTES + 1))).rejects.toMatchObject({ reason: 'size' })
    const bytes = await sheetBytes([columns, ['1001', '现金', 'asset_cash']], sheet => {
      sheet.workbook.addWorksheet('第二张表')
    })
    await expect(parseFinanceSetupChart(bytes)).rejects.toMatchObject({ reason: 'worksheet' })
  })

  it('keeps invalid payable configuration out of a persisted plan', () => {
    expect(financeSetupAccountSchema.safeParse({
      code: '2202', name: '应付账款', accountType: 'liability_payable', reconcile: false,
    }).success).toBe(false)
  })
})
