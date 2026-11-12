/** Export authorized ledger results to a new workbook in the conversation workspace. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { lstat, realpath } from 'node:fs/promises'
import ExcelJS from 'exceljs'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolExecutionToken, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { FinanceExportQuery, GroupFinanceQueryResult } from './finance-types.ts'

/** Narrow file-producing tool exposed only in a dedicated finance Bot's private Session. */
export const BOT_FINANCE_EXPORT_TOOL = 'export_bot_finance'

const moveColumns = [
  ['number', '凭证号'], ['date', '记账日期'], ['state', '状态'], ['journal', '日记账'],
  ['reference', '凭证摘要'], ['amountTotal', '金额'], ['currency', '币别'],
] as const
const lineColumns = [
  ['number', '凭证号'], ['date', '记账日期'], ['state', '状态'], ['account', '会计科目'],
  ['description', '分录摘要'], ['debit', '借方金额'], ['credit', '贷方金额'], ['currency', '币别'],
] as const

async function exportWorkbook(result: GroupFinanceQueryResult, sheetName: string): Promise<Uint8Array> {
  const columns = result.query.kind === 'moves' ? moveColumns : lineColumns
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] })
  const labels = ['公司', '账套', ...columns.map(([, label]) => label)]
  sheet.addRow(labels).font = { bold: true }
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: labels.length } }
  for (let index = 0; index < labels.length; index += 1) sheet.getColumn(index + 1).width = 22
  for (const row of result.rows) {
    sheet.addRow([result.company.name, result.connector.name, ...columns.map(([key]) => row[key] ?? null)])
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer())
}

/**
 * Register a finance export. Private results use file cards and group drafts follow normal presentation checks.
 * @param agent - exact Bot or group executor.
 * @param scope - private delivery or group draft under group review rules.
 * @param query - authorized complete read of the selected company and voucher scope.
 * @param workspace - recheck ownership and return the Bot's validated workspace before saving.
 * @returns disposer for the scoped tool and its file registration hook.
 */
export function registerFinanceExportTool(
  agent: Agent,
  scope: 'bot' | 'group',
  query: (request: FinanceExportQuery, exec: ToolRunContext) => Promise<GroupFinanceQueryResult>,
  workspace: (exec: ToolRunContext) => Promise<string>,
): () => void | Promise<void> {
  const pending = new WeakMap<ToolExecutionToken, { turn: number; path: string }>()
  return agent.ctx.effect(function* () {
    yield agent.ctx.tools.register(defineTool({
      name: scope === 'bot' ? BOT_FINANCE_EXPORT_TOOL : 'export_group_finance',
      description: 'Generate an Excel workbook (.xlsx) from all matching vouchers or voucher lines in the bound read-only ledger. Use this for export requests, including a follow-up that says only “导出”. Reuse the confirmed scope. Use moves for a voucher list, entries for period voucher lines, and move-lines for one voucher ID. '
        + (scope === 'bot' ? 'A successful export attaches the file to this conversation. Give the file name and row count.'
          : 'Saves a draft in the group workspace. Follow group review requirements and use present to deliver the workbook.'),
      parameters: {
        kind: { type: 'string', enum: ['moves', 'entries', 'move-lines'], required: true },
        from: { type: 'string', description: 'First inclusive accounting date, YYYY-MM-DD, for moves or entries.' },
        to: { type: 'string', description: 'Last inclusive accounting date, YYYY-MM-DD, for moves or entries.' },
        state: { type: 'string', enum: ['posted', 'draft', 'all'], description: 'Voucher status for moves or entries. Defaults to posted.' },
        search: { type: 'string', description: 'Optional voucher number or reference for moves, or voucher number or line description for entries.' },
        move_id: { type: 'integer', description: 'Positive voucher ID for move-lines.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {
          filename: { type: 'string', required: true },
          row_count: { type: 'integer', required: true },
          company: { type: 'string', required: true },
          ledger: { type: 'string', required: true },
        } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        presentationMeta: (_args, value) => value,
      },
      execute: async (args, exec) => {
        if (exec.agent !== agent) throw new HarnessError('This export belongs to the current finance conversation.', 'KATCATS_FINANCE_EXPORT')
        if (Object.keys(args).some(key => !['kind', 'from', 'to', 'state', 'search', 'move_id'].includes(key))) {
          throw new HarnessError('Use only the listed voucher filters.', 'KATCATS_FINANCE_INPUT')
        }
        const { kind, from, to, state, search, move_id: moveId } = args
        let request: FinanceExportQuery
        if (kind === 'move-lines') {
          if (moveId === undefined || !Number.isSafeInteger(moveId) || moveId < 1
            || from !== undefined || to !== undefined || state !== undefined || search !== undefined) {
            throw new HarnessError('Supply only the positive voucher ID for this line export.', 'KATCATS_FINANCE_INPUT')
          }
          request = { kind, moveId }
        } else {
          if (from === undefined || to === undefined || moveId !== undefined) {
            throw new HarnessError('Supply both accounting dates for a period export.', 'KATCATS_FINANCE_INPUT')
          }
          request = { kind, from, to, state: state ?? 'posted', ...(search === undefined ? {} : { search }) }
        }
        const boundary = agent.ctx.get('sessionProjections')?.stateOf(agent.session, 'turnBoundary')
        const fs = agent.ctx.get('fs')
        if (boundary === undefined || boundary.openTurnStartSeq === null || fs === undefined) {
          throw new HarnessError('This finance export needs an active conversation and its file workspace.', 'KATCATS_FINANCE_EXPORT')
        }
        let result: GroupFinanceQueryResult
        try {
          result = await query(request, exec)
        } catch (error) {
          exec.signal.throwIfAborted()
          if (error instanceof RemoteError && error.code === 'xiaojing/finance-connector') {
            throw new HarnessError(error.message, 'KATCATS_FINANCE_QUERY')
          }
          throw error
        }
        const sheetName = kind === 'moves' ? '凭证清单' : '凭证分录'
        const filename = sheetName + '-' + randomUUID() + '.xlsx'
        const bytes = await exportWorkbook(result, sheetName)
        const directory = await workspace(exec)
        const policy = agent.ctx.get('sandboxPolicy')?.resolve({ session: agent.session })
        if (policy?.mode === 'read-only' || (fs.sandboxMode !== undefined && policy === undefined)) {
          throw new HarnessError('Allow workspace edits in this conversation before exporting a workbook.', 'KATCATS_FINANCE_EXPORT')
        }
        let path: string
        try {
          const entry = await lstat(directory)
          const cwd = agent.session.header.cwd
          if (!entry.isDirectory() || entry.isSymbolicLink() || cwd === undefined
            || await realpath(cwd) !== await realpath(directory)) {
            throw new Error('The Session workspace does not match the authorized export directory.')
          }
          const target = await fs.resolve(filename, { cwd: directory, signal: exec.signal })
          if (policy?.mode === 'workspace-write'
            && !fs.contains(await fs.resolve(policy.workspaceRoot, { signal: exec.signal }), target)) {
            throw new Error('The export directory is outside the approved workspace.')
          }
          path = fs.processPath(target)
          exec.signal.throwIfAborted()
          await writeFileAtomic(path, bytes, { mode: 0o600 })
          exec.signal.throwIfAborted()
        } catch (error) {
          exec.signal.throwIfAborted()
          throw new HarnessError('The voucher workbook could not be saved. Check the conversation workspace and retry.',
            'KATCATS_FINANCE_EXPORT', { cause: error })
        }
        if (scope === 'bot') pending.set(exec.token, { turn: boundary.lastTurn, path })
        return { filename, row_count: result.rows.length, company: result.company.name, ledger: result.connector.name }
      },
      presentCall: () => ({ card: 'generic', title: 'Export vouchers', kind: 'read' }),
      presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'Voucher export failed' : 'Voucher file created', content: result.content }),
    }))
    if (scope === 'bot') yield agent.ctx.on('tools/result', (exec, result) => {
      const file = pending.get(exec.token)
      if (file === undefined) return
      pending.delete(exec.token)
      if (!result.isError) agent.session.append('deliverables/presented', {
        turn: file.turn, callId: exec.callId, files: [{ path: file.path }],
      })
    })
  })
}
