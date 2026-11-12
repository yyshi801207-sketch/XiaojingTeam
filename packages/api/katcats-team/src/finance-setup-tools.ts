/** Private Odoo administration tools for the two fixed Bots. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import { collectLedgerIntake, ledgerAnswer } from './finance-setup-questions.ts'
import type { XiaojingLedgerSetup } from './finance-setup.ts'
import type { LedgerSetupMode, LedgerSetupPlan } from './finance-setup-types.ts'
import type { OdooAdminOperation, OdooAdminOperationId } from './finance-admin-operations.ts'
import { authorizeFinanceAdminContext, registerFinanceAdminContext } from './finance-admin-context.ts'
import { isOdooAdminBot, ledgerSetupBotId } from './types.ts'

/** Fixed directory role for 建账助手. */
export const ledgerSetupRole = '公司与组织、建账与账套维护'
/** Fixed directory role for 系统助手. */
export const odooAccessRole = '用户与权限'

const sharedGuidance = [
  'Work against the verified Odoo database saved in your Bot settings. If it is missing, send the user to Bot 设置 → 财务系统连接. Never request passwords or API keys in chat.',
  'Use list_odoo_admin_companies to resolve the intended company and distinguish similarly named companies. Use call_odoo_admin_orm to inspect current records and fields before proposing a change. Ask one focused question if company, record, or intended access is ambiguous.',
  'Changes require explicit confirmation in the tool panel. A successful write includes a saved operation and verified readback. Report completion only when operation.status is verified. If an operation is unknown, cancelled or interrupted, call list_odoo_admin_operations and reconcile_odoo_admin_operation before proposing another write. Unknown writes block further writes in this database for this assistant. Never claim a missing reply means no change.',
  'A create operation with a lost reply may return candidate IDs. Matching fields do not prove which operation created a record. Present the candidates to the owner for explicit adoption using reconcile_odoo_admin_operation; never automatically adopt or recreate them. If the outcome remains unknown, explain the unresolved operation ID and retain the task for investigation.',
].join('\n')

const guidance = [
  'You are 建账助手, responsible for Odoo companies, organization and ledger setup and maintenance. Use the administration tools for company and department records and for maintenance of existing charts, journals, taxes and fiscal positions. Send user and permissions requests to 系统助手.',
  sharedGuidance,
  'For a request to start or resume ledger setup, use prepare_ledger_setup. Pass only fields the user explicitly supplied or the tool returned as confirmed for this company. The tool asks one missing question at a time.',
  'When greeted in Chinese without a task, begin with exactly: 你好！我是小兢会计的建账助手 兢兢，负责 Odoo 的公司与组织管理、账套维护。 Briefly offer help with company management, new ledger setup, or existing ledger maintenance.',
  'This workflow sets up a fresh ledger. If the user needs historical balances or open items imported, explain the separate migration step and do not promise a completed migration.',
  'The guided tool reads available Odoo templates for the confirmed country and currency. Chinese standard and customized templates can represent different accounting standards. Do not infer a tax treatment or template choice.',
  'Preserve confirmed values when setup pauses or a lookup fails. Use the reported failure and message to explain the next step. Ask the user to visit 建账助手 → Bot 设置 → 财务系统连接 for needs-connection. For blocked or no-templates, report the specific lookup issue and resume with the saved connection and confirmed fields once resolved. For a custom chart, the owner uploads the workbook under 连接器 → 建账任务.',
  'For an existing empty company, resolve its ID in the current database and pass existing_company_id to prepare_ledger_setup. The workflow validates that the selected company can be initialized; do not create a duplicate. Fiscal-position maintenance supports basic fields, not tax/account mapping lines. Inspect installed fields before promising a configuration.',
  'A saved draft performs no Odoo writes. Tell the user to review and confirm execution under 连接器 → 建账任务. Check ledger_setup_status to report actual progress, a blocked step, or a ready result. For uncertain company creation, the owner can inspect candidate companies and confirm recovery on that task, then separately continue setup. Once the ledger is ready, direct the owner to 添加到连接器 on its setup task. It appears in 可连接帐套 after a separate Odoo bookkeeping credential is verified. Group binding is a separate action in group settings.',
].join('\n')

const accessGuidance = [
  'You are 系统助手. Manage Odoo users, their default and allowed companies, and their access groups. Company creation and ledger maintenance belong to 建账助手.',
  sharedGuidance,
  'When greeted in Chinese without a task, begin with exactly: 你好！我是小兢会计的系统助手 业业，负责 Odoo 的用户与权限管理。',
  'For a new user, resolve the login and check for an existing account. Confirm internal or portal access as appropriate, the default company, allowed companies, and requested roles. Resolve existing Odoo roles and groups by name and inspect inherited memberships before assigning or removing access. Avoid replacing unrelated memberships or creating duplicate accounts.',
  'When changing a user or group, explain who will be affected and show the company and role changes before confirmation. If the user needs a new API key, direct them to Odoo’s account security settings and the appropriate credential form in the app.',
  'You can inspect model ACLs and record rules, but this tool does not modify ir.model.access or ir.rule. You can create and maintain supported permission-group fields. Check inherited memberships and preserve unrelated permissions; do not promise arbitrary security-rule editing.',
].join('\n')

const output = { schema: { type: 'json' }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] } as const

function toolResult<T>(exec: ToolRunContext, run: () => Promise<T>): Promise<T> {
  return run().catch(error => {
    exec.signal.throwIfAborted()
    if (error instanceof RemoteError && error.code === 'xiaojing/finance-connector') {
      throw new HarnessError(`${error.message} [${error.details.reason}]`, 'XIAOJING_LEDGER_SETUP')
    }
    throw error
  })
}

function modelPlan(plan: LedgerSetupPlan) {
  return {
    id: plan.id, name: plan.name, countryCode: plan.countryCode, currencyCode: plan.currencyCode,
    openingDate: plan.openingDate, templateName: plan.templateName, mode: plan.mode,
    status: plan.status, customAccountCount: plan.customAccountCount,
    ...(plan.companyId === undefined ? {} : { companyId: plan.companyId }),
    ...(plan.existingCompanyId === undefined ? {} : { existingCompanyId: plan.existingCompanyId }),
    ...(plan.company === undefined ? {} : { company: { ...plan.company } }),
    ...(plan.failure === undefined ? {} : { failure: plan.failure }),
    ...(plan.chatId === undefined ? {} : { chatId: plan.chatId }),
  }
}

function modelOperation(operation: OdooAdminOperation) {
  const { recordIds, records, candidates, ...fields } = operation
  return {
    ...fields,
    ...(recordIds === undefined ? {} : { recordIds: [...recordIds] }),
    ...(records === undefined ? {} : { records: records.map(record => ({ ...record })) }),
    ...(candidates === undefined ? {} : { candidates: candidates.map(ids => [...ids]) }),
  }
}

const registered = new WeakMap<XiaojingLedgerSetup, WeakSet<Agent>>()

/**
 * Register the original ledger lookup for the main Bot and role-scoped tools for the two private administration Bots.
 * @param ctx Plugin context owning the registrations.
 * @param setup Service owning the saved setup workflow.
 * @param agent Agent receiving tools for its private Session.
 */
export function registerLedgerSetupTools(ctx: Context, setup: XiaojingLedgerSetup, agent: Agent): void {
  const team = ctx.katcatsTeam
  const bot = team.memberForSession(agent.id)
  if (!bot || (bot.kind !== 'main' && !isOdooAdminBot(bot.id))) return
  const installed = registered.get(setup) ?? new WeakSet<Agent>()
  if (installed.has(agent)) return
  registered.set(setup, installed)
  installed.add(agent)
  const authorize = (exec: ToolRunContext) => {
    if (exec.agent !== agent || ctx.agents.get(agent.id) !== agent || team.memberForSession(agent.id)?.id !== bot.id) {
      throw new HarnessError('Ledger setup tools are limited to the authorized private Bot.', 'XIAOJING_LEDGER_SETUP_DENIED')
    }
    exec.signal.throwIfAborted()
    if (isOdooAdminBot(bot.id)) authorizeFinanceAdminContext(setup, agent)
  }
  ctx.effect(function* () {
    if (bot.kind === 'main') {
      yield agent.ctx.systemPrompt.section({
        name: 'xiaojing:ledger-setup-creator', order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
        interpolate: false, text: 'Direct company, organization and ledger setup or maintenance requests to 建账助手. Direct Odoo user and permissions requests to 系统助手. Both are available in the fixed Bot switcher in the sidebar. The create_ledger_setup_bot tool returns the saved 建账助手 conversation.',
      })
      yield agent.ctx.tools.register(defineTool({
        name: 'create_ledger_setup_bot',
        description: 'Find the fixed 建账助手 Bot for Odoo company, organization or ledger setup and maintenance. Open its private conversation from the sidebar Bot switcher.',
        parameters: {},
        output,
        execute: (_args, exec) => toolResult(exec, async () => {
          authorize(exec)
          const assistant = await team.ensureLedgerSetupBot(agent, exec.signal)
          return { bot_id: assistant.id, name: assistant.name, session_id: assistant.sessionId }
        }),
        presentCall: () => ({ card: 'generic', title: '打开建账助手', kind: 'read' }),
      }))
      return
    }
    const role = bot.id === ledgerSetupBotId ? 'ledger' : 'access'
    registerFinanceAdminContext(ctx, setup, agent)
    yield agent.ctx.systemPrompt.section({
      name: 'xiaojing:ledger-setup', order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      interpolate: false, text: role === 'ledger' ? guidance : accessGuidance,
    })
    yield agent.ctx.tools.register(defineTool({
      name: 'list_odoo_admin_companies',
      description: 'List accessible companies in the saved Odoo administration database, to resolve the target before reviewing or changing it.',
      parameters: {},
      output,
      execute: (_args, exec) => toolResult(exec, async () => {
        authorize(exec)
        const result = await setup.adminCompanies(exec.signal)
        return { ...result, companies: result.companies.map(company => ({ ...company })) }
      }),
      presentCall: () => ({ card: 'generic', title: '读取 Odoo 公司', kind: 'read' }),
    }))
    yield agent.ctx.tools.register(defineTool({
      name: 'call_odoo_admin_orm',
      description: role === 'ledger'
        ? 'Inspect or maintain Odoo companies, departments, accounts, journals, taxes and fiscal positions. Select a company for accounting configuration. To set up a complete new ledger use prepare_ledger_setup.'
        : 'Inspect or maintain Odoo users and permission groups. Resolve user, company and group IDs before writing. Provide explicit fields for reads and retain unrelated permissions.',
      parameters: {
        model: { type: 'string', required: true, description: 'Odoo model in this Bot’s administration scope.' },
        method: { type: 'string', required: true, description: 'A supported public method such as fields_get, search_read, read, create or write.' },
        company_id: { type: 'number', description: 'Verified target company ID. Required for company accounting settings.' },
        parameters_json: { type: 'string', description: 'JSON object of method arguments. Use vals_list for create, and ids and vals for write. Leave company context to company_id. Keep credentials out of this tool.' },
        summary: { type: 'string', description: 'For writes, explain the requested changes in the user’s language.' },
      },
      output,
      execute: (args, exec) => toolResult(exec, async () => {
        authorize(exec)
        let params: unknown
        try { params = JSON.parse(args.parameters_json ?? '{}') } catch (error) {
          throw new HarnessError('请提供有效的 Odoo 参数 JSON。', 'XIAOJING_ODOO_ADMIN_INPUT', { cause: error })
        }
        const result = await setup.adminCall(role, { model: args.model, method: args.method, params,
          ...(args.company_id === undefined ? {} : { companyId: args.company_id }) }, async (details, signal) => {
          authorize(exec)
          const approve = '确认执行'
          const id = 'odoo-admin-write'
          const content = JSON.stringify(details, null, 2).replaceAll('`', '\\u0060')
          const result = await ctx.userQuestions.ask({ agent, signal, questions: [{
            id, header: '确认 Odoo 管理操作',
            question: args.summary?.trim() || `确认执行 ${args.model}.${args.method}？`,
            detail: '```json\n' + content + '\n```',
            options: [{ label: approve }, { label: '取消' }],
          }] })
          authorize(exec)
          const answer = result.answers.find(item => item.id === id)
          if (answer?.selected.length !== 1 || answer.selected[0] !== approve || answer.custom !== undefined) {
            throw new HarnessError('本次 Odoo 管理操作未经确认。', 'XIAOJING_ODOO_ADMIN_DECLINED')
          }
        }, exec.signal)
        const { operation, ...fields } = result
        return { ...fields, company: result.company === null ? null : { ...result.company },
          ...(operation === undefined ? {} : { operation: modelOperation(operation) }) }
      }),
      presentCall: args => ({ card: 'generic', title: `Odoo · ${args.model}.${args.method}`, kind: 'other' }),
    }))
    yield agent.ctx.tools.register(defineTool({
      name: 'list_odoo_admin_operations',
      description: 'Read this assistant’s saved administration writes in the current database, including unresolved writes after a timeout or restart. Does not re-execute them.',
      parameters: {}, output,
      execute: (_args, exec) => toolResult(exec, async () => {
        authorize(exec)
        return { operations: (await setup.adminOperations(role, exec.signal)).map(modelOperation) }
      }),
      presentCall: () => ({ card: 'generic', title: '查看管理操作记录', kind: 'read' }),
    }))
    yield agent.ctx.tools.register(defineTool({
      name: 'reconcile_odoo_admin_operation',
      description: 'Read back a saved operation without replaying the write. For an uncertain create, first call without adopt_record_ids to inspect candidates. Adoption requires the owner’s explicit confirmation; matching fields alone are insufficient.',
      parameters: {
        operation_id: { type: 'string', required: true, description: 'Exact saved operation ID returned by list_odoo_admin_operations.' },
        adopt_record_ids: { type: 'array', items: { type: 'number' }, description: 'Previously inspected candidate IDs, one per original create item in its original order. Omit for ordinary readback. The owner must confirm adoption.' },
      },
      output,
      execute: (args, exec) => toolResult(exec, async () => {
        authorize(exec)
        const operationId = brandString<OdooAdminOperationId>(args.operation_id)
        if (args.adopt_record_ids !== undefined) {
          const operation = await setup.reconcileAdminOperation(role, operationId, exec.signal)
          const approve = '确认认领记录'
          const id = 'odoo-admin-reconcile'
          const detail = JSON.stringify({ operation: modelOperation(operation), adoptRecordIds: args.adopt_record_ids }, null, 2).replaceAll('`', '\\u0060')
          const result = await ctx.userQuestions.ask({ agent, signal: exec.signal, questions: [{
            id, header: '核对未确认的管理操作',
            question: '这些记录是否确实属于本次操作？确认后将其作为本次操作结果，不会重新创建。',
            detail: '```json\n' + detail + '\n```', options: [{ label: approve }, { label: '取消' }],
          }] })
          authorize(exec)
          const answer = result.answers.find(item => item.id === id)
          if (answer?.selected.length !== 1 || answer.selected[0] !== approve || answer.custom !== undefined) {
            throw new HarnessError('本次记录认领未经确认。', 'XIAOJING_ODOO_ADMIN_DECLINED')
          }
        }
        return modelOperation(await setup.reconcileAdminOperation(role, operationId, exec.signal, args.adopt_record_ids))
      }),
      presentCall: () => ({ card: 'generic', title: '核对管理操作结果', kind: 'read' }),
    }))
    if (role !== 'ledger') return
    yield agent.ctx.tools.register(defineTool({
      name: 'list_ledger_setup_templates',
      description: 'Read accounting templates available for the confirmed country and currency in the connected Odoo database.',
      parameters: {
        country_code: { type: 'string', required: true, description: 'ISO country code, for example CN.' },
        currency_code: { type: 'string', required: true, description: 'ISO currency code, for example CNY.' },
      },
      output,
      execute: (args, exec) => toolResult(exec, async () => {
        authorize(exec)
        const result = await setup.choices({ countryCode: args.country_code, currencyCode: args.currency_code }, exec.signal)
        return { country: { ...result.country }, currency: { ...result.currency }, templates: result.templates.map(item => ({ ...item })) }
      }),
      presentCall: () => ({ card: 'generic', title: '读取会计科目模板', kind: 'read' }),
    }))
    yield agent.ctx.tools.register(defineTool({
      name: 'prepare_ledger_setup',
      description: 'Start or resume guided setup in the private setup assistant. Opens one native question for each missing company field, then offers chart and template selection. Accept only explicitly confirmed fields. Call with no fields to start from a greeting. Saves a reviewable draft without writing to Odoo.',
      parameters: {
        name: { type: 'string', description: 'Legal company name explicitly supplied by the user.' },
        existing_company_id: { type: 'number', description: 'Current-database ID of an existing empty company explicitly chosen for initialization. Omit only when creating a new company.' },
        tax_id: { type: 'string', description: 'Confirmed tax identifier, when provided.' },
        country_code: { type: 'string', description: 'Country explicitly supplied by the user, as a two-letter ISO code.' },
        currency_code: { type: 'string', description: 'Accounting currency explicitly supplied by the user, as a three-letter ISO code.' },
        opening_date: { type: 'string', description: 'Accounting start date explicitly supplied by the user, YYYY-MM-DD.' },
        setup_kind: { type: 'string', enum: ['fresh', 'migration'], description: 'New ledger or migration explicitly selected by the user.' },
        chart_source: { type: 'string', enum: ['odoo-template', 'custom-chart'], description: 'Chart source from a prior confirmed guided result for this same company.' },
        template_code: { type: 'string', description: 'An installed Odoo template code explicitly confirmed by the user.' },
      },
      output,
      execute: (args, exec) => toolResult(exec, async () => {
        authorize(exec)
        const ask = async (question: AskUserQuestionItem) => {
          authorize(exec)
          try {
            const answer = await ctx.userQuestions.ask({ agent, signal: exec.signal, questions: [question] })
            authorize(exec)
            return answer
          } catch (error) {
            exec.signal.throwIfAborted()
            if (error instanceof UserQuestionError && error.code === 'ASK_CANCELLED') return { answers: [] }
            throw error
          }
        }
        const intake = await collectLedgerIntake(args, ask, new Date())
        const tax = args.tax_id === undefined ? {} : { tax_id: args.tax_id }
        const confirmed = { ...intake.values, ...tax,
          ...(args.existing_company_id === undefined ? {} : { existing_company_id: args.existing_company_id }) }
        if (intake.status === 'paused') return { status: 'paused', confirmed }
        const values = intake.values
        if (values.setup_kind === 'migration') return { status: 'migration-needs-review', confirmed }

        const lookup = { countryCode: values.country_code, currencyCode: values.currency_code }
        const available = await setup.choices(lookup, exec.signal).catch(error => {
          if (error instanceof RemoteError && error.code === 'xiaojing/finance-connector') return error
          throw error
        })
        authorize(exec)
        if (available instanceof RemoteError) {
          const failure = available.details.reason
          const needsConnection = failure === 'unbound' || failure === 'credential' || failure === 'authentication'
          const message = failure === 'invalid-response'
            ? '读取 Odoo 会计科目模板时收到了无法识别的数据。连接设置和已确认的建账信息可以沿用。'
            : available.message
          return { status: needsConnection ? 'needs-connection' : 'blocked', confirmed, failure, message }
        }
        if (available.templates.length === 0) return {
          status: 'no-templates', confirmed,
          message: '当前国家或地区没有可选的 Odoo 会计科目模板。请在 Odoo 核对已安装的会计本地化模块。',
        }

        const standard = '使用 Odoo 会计科目模板'
        const custom = '导入自定义科目表'
        const mode = args.chart_source ?? await ledgerAnswer<LedgerSetupMode>(ask, {
          id: 'ledger-chart-source', header: '科目表来源', question: '请选择这套账的会计科目表来源。',
          options: [
            { label: standard, description: '使用已安装的 Odoo 科目模板和默认科目。' },
            { label: custom, description: '上传 Excel 并校验科目，在所选基础模板上导入。' },
          ],
        }, label => label === standard ? 'odoo-template' : label === custom ? 'custom-chart' : undefined,
        '请从面板中选择 Odoo 模板或导入自定义科目表。')
        if (mode === undefined) return { status: 'paused', confirmed }

        const templates = available.templates.map(({ code, name }) => ({ code, label: name + ' (' + code + ')' }))
        const findTemplate = (input: string) => templates.find(item => item.code === input || item.label === input)?.code
        const template = (args.template_code === undefined ? undefined : findTemplate(args.template_code)) ?? await ledgerAnswer(ask, {
          id: 'ledger-odoo-template', header: '会计科目模板',
          question: mode === 'custom-chart' ? '请选择导入自定义科目表时使用的基础模板。' : '请选择这套账使用的 Odoo 会计科目模板。',
          options: templates.map(({ label }) => ({ label })),
        }, findTemplate, '请选择 Odoo 提供的模板，或输入选项括号里的模板代码。')
        if (template === undefined) return { status: 'paused', confirmed: { ...confirmed, chart_source: mode } }

        const plan = await setup.propose({
          name: values.name, ...lookup, ...(args.tax_id === undefined ? {} : { taxId: args.tax_id }),
          ...(args.existing_company_id === undefined ? {} : { existingCompanyId: args.existing_company_id }),
          templateCode: template, openingDate: values.opening_date, mode,
        }, exec.signal)
        return modelPlan(plan)
      }),
      presentCall: () => ({ card: 'generic', title: '逐项确认建账资料', kind: 'edit' }),
    }))
    yield agent.ctx.tools.register(defineTool({
      name: 'ledger_setup_status',
      description: 'Read confirmed database and setup task statuses. Does not expose keys, workbook contents or financial records.',
      parameters: {},
      output,
      execute: (_args, exec) => toolResult(exec, async () => {
        authorize(exec)
        const { connection, plans } = await setup.currentPlans(exec.signal)
        return { connection: connection === null ? null : {
          url: connection.url, database: connection.database, verifiedAt: connection.verifiedAt,
        }, plans: plans.map(modelPlan) }
      }),
      presentCall: () => ({ card: 'generic', title: '查看建账状态', kind: 'read' }),
    }))
  }, 'xiaojing-ledger-setup: private Agent tools')
}
