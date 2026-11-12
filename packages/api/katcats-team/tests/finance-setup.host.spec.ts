/** Fixed Odoo assistants preserve their private setup records and require confirmation for administration. */
import ExcelJS from 'exceljs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import UserQuestions, { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { chatsDomainSpec, chatsStateSchema } from '../src/chats-storage.ts'
import XiaojingLedgerSetup from '../src/finance-setup.ts'
import type { LedgerSetupPlan } from '../src/finance-setup-types.ts'
import { teamStateSchema } from '../src/storage.ts'
import { ledgerSetupBotId, odooAccessBotId } from '../src/types.ts'
import { memoryFixture, memorySend } from './memory-fixture.ts'

const endpoint = { url: 'https://test-ledger.example', database: 'synthetic_ledger' }
const setupKey = 'test-setup-administrator-key'
const sameUserKey = 'test-other-key-of-same-administrator'
const dailyKey = 'test-separate-bookkeeper-key'
const databaseUuid = 'a0e86794-f5ca-4777-9e1b-6373300cae11'
const signal = new AbortController().signal
const draft = {
  name: 'Synthetic Company', taxId: 'SYNTHETIC-CN', countryCode: 'CN', currencyCode: 'CNY',
  templateCode: 'cn', openingDate: '2026-02-01', mode: 'odoo-template',
} as const
const template = { name: 'China - Small Business', country_id: 5, visible: true, installed: true }
const companyId = 31
const priorCompany = { id: 12, name: 'Existing Ledger', currency: 'CNY' }
const readCompany = {
  id: companyId, name: draft.name, country_id: [5, 'China'], country_code: 'CN',
  account_fiscal_country_id: [5, 'China'], currency_id: [7, 'CNY'], parent_id: false, child_ids: [],
  account_opening_date: draft.openingDate,
}

interface MockBody {
  readonly fields?: readonly string[]
  readonly allfields?: readonly string[]
  readonly operation?: string
  readonly ids?: readonly number[]
  readonly context?: { readonly allowed_company_ids?: number[] }
  readonly domain?: readonly (string | readonly unknown[])[]
  readonly vals?: Readonly<Record<string, unknown>>
  readonly vals_list?: readonly Record<string, unknown>[]
}

function mockOdoo(accountTemplates: unknown = { cn: template }) {
  const calls: { route: string; credential: string; body: MockBody }[] = []
  const customAccounts: Record<string, unknown>[] = []
  const adminCompany = { id: priorCompany.id, name: priorCompany.name }
  const setupCompany: Record<string, unknown> = { ...readCompany, vat: draft.taxId }
  const adminUser = { id: 42, name: 'Bookkeeper', company_id: [12, 'Existing Ledger'],
    company_ids: [12], group_ids: [] as number[], all_group_ids: [] as number[], active: true }
  let created = false
  let loaded = false
  let moves = 0
  let loseCompanyReply = false
  let loseCustomReply = false
  let rejectTemplate = false
  let activeDatabaseUuid = databaseUuid
  const mock = vi.fn<typeof fetch>(async (url, init) => {
    const route = String(url).slice((endpoint.url + '/json/2/').length)
    expect(String(url).startsWith(endpoint.url + '/json/2/')).toBe(true)
    expect(new Headers(init?.headers).get('x-odoo-database')).toBe(endpoint.database)
    const credential = new Headers(init?.headers).get('authorization') ?? ''
    expect(['Bearer ' + setupKey, 'Bearer ' + sameUserKey, 'Bearer ' + dailyKey]).toContain(credential)
    const uid = credential === 'Bearer ' + dailyKey ? 42 : 17
    if (typeof init?.body !== 'string') throw new Error('Expected Odoo JSON body')
    const body: MockBody = JSON.parse(init.body)
    calls.push({ route, credential, body })
    switch (route) {
      case 'res.users/context_get': return Response.json({ uid })
      case 'res.users/read':
        if (body.fields?.includes('name')) return Response.json([adminUser])
        expect(body).toEqual({ ids: [uid], fields: ['login'] })
        return Response.json([{ id: uid, login: uid === 17 ? 'setup@example.test' : 'bookkeeper@example.test' }])
      case 'res.users/has_group': return Response.json(uid === 17)
      case 'res.company/has_access': return Response.json(uid === 17)
      case 'ir.module.module/search_count': return Response.json(1)
      case 'ir.config_parameter/get_param': return Response.json(activeDatabaseUuid)
      case 'res.country/search_read': return Response.json([{ id: 5, code: 'CN', name: 'China' }])
      case 'res.currency/search_read': return Response.json([{ id: 7, name: 'CNY' }])
      case 'ir.module.module/search_read': return Response.json([{ account_templates: accountTemplates }])
      case 'res.company/search_count': return Response.json(created ? 1 : 0)
      case 'res.company/create':
        expect(uid).toBe(17)
        expect(created).toBe(false)
        expect(body.vals_list?.[0]).toMatchObject({ name: draft.name, currency_id: 7, country_id: 5, parent_id: false })
        created = true
        if (loseCompanyReply) throw new TypeError('Synthetic network interruption after create')
        return Response.json([companyId])
      case 'res.company/search_read':
        expect(body.domain).toContainEqual(['user_ids', 'in', [uid]])
        if (body.context?.allowed_company_ids === undefined) {
          if (body.domain?.some(term => Array.isArray(term) && term[0] === 'name')) {
            return Response.json(created ? [{ ...setupCompany, chart_template: loaded ? 'cn' : false }] : [])
          }
          return Response.json([{ id: priorCompany.id, name: priorCompany.name, currency_id: [7, priorCompany.currency] }])
        }
        if (body.context?.allowed_company_ids?.[0] === priorCompany.id) {
          expect(body.context.allowed_company_ids).toEqual([priorCompany.id])
          return Response.json([{ id: priorCompany.id, name: priorCompany.name, currency_id: [7, priorCompany.currency] }])
        }
        expect(body.context?.allowed_company_ids).toEqual([companyId])
        return Response.json(created ? [{ ...setupCompany, chart_template: loaded ? 'cn' : false }] : [])
      case 'res.company/fields_get':
      case 'res.users/fields_get':
        return Response.json(Object.fromEntries((body.allfields ?? []).map(field => [field, {
          type: field === 'group_ids' ? 'many2many' : field === 'active' ? 'boolean' : 'char',
        }])))
      case 'res.company/read': return Response.json(body.ids?.includes(companyId) ? [setupCompany] : [adminCompany])
      case 'res.company/write':
        expect(uid).toBe(17)
        if (body.ids?.includes(priorCompany.id)) Object.assign(adminCompany, body.vals)
        if (body.ids?.includes(companyId)) Object.assign(setupCompany, body.vals)
        return Response.json(true)
      case 'res.users/write':
        expect(uid).toBe(17)
        if (body.vals?.name !== undefined) adminUser.name = String(body.vals.name)
        if (body.vals?.group_ids !== undefined) {
          expect(body.vals.group_ids).toEqual([[4, 7, 0]])
          adminUser.group_ids = [7]
          adminUser.all_group_ids = [7]
        }
        return Response.json(true)
      case 'account.chart.template/try_loading':
        expect(uid).toBe(17)
        expect(body.context?.allowed_company_ids).toEqual([companyId])
        if (rejectTemplate) return Response.json({ name: 'odoo.exceptions.AccessError' }, { status: 403 })
        loaded = true
        return Response.json(null)
      case 'account.move/search_count': return Response.json(moves)
      case 'account.move/search_read':
        expect([[priorCompany.id], [companyId]]).toContainEqual(body.context?.allowed_company_ids)
        return Response.json([])
      case 'account.move/has_access': return Response.json(true)
      case 'account.account/search_count': return Response.json(loaded ? 12 + customAccounts.length : 0)
      case 'account.journal/search_count': return Response.json(body.domain?.length === 2 ? 1 : 5)
      case 'account.tax/search_count': return Response.json(4)
      case 'account.account/search_read': {
        const codes = body.domain?.find(term => typeof term !== 'string' && term[0] === 'code')
        const selected = typeof codes === 'string' ? undefined : codes?.[2]
        if (!Array.isArray(selected)) throw new Error('Expected a scoped account code filter')
        return Response.json(customAccounts.filter(account => selected.includes(account.code)))
      }
      case 'account.account/create': {
        expect(uid).toBe(17)
        expect(body.context?.allowed_company_ids).toEqual([companyId])
        const rows = body.vals_list ?? []
        const ids = rows.map((row, index) => {
          const id = 101 + index
          customAccounts.push({ ...row, id, active: true, company_ids: [companyId] })
          return id
        })
        if (loseCustomReply) throw new TypeError('Synthetic network interruption after account import')
        return Response.json(ids)
      }
      default: throw new Error('Unexpected mock Odoo route ' + route)
    }
  })
  vi.stubGlobal('fetch', mock)
  const writes = () => calls.filter(call => /\/(?:create|write|try_loading)$/.test(call.route))
  return {
    calls, writes,
    existingCompany: () => { created = true; setupCompany.account_opening_date = false },
    alterCompany: (fields: Readonly<Record<string, unknown>>) => { Object.assign(setupCompany, fields) },
    addMove: () => { moves++ },
    loseCreateReply: () => { loseCompanyReply = true },
    loseImportReply: () => { loseCustomReply = true },
    addAccount: (code: string, name: string) => {
      customAccounts.push({ id: 99, code, name, account_type: 'asset_cash', reconcile: false, company_ids: [companyId], active: true })
    },
    renameAccount: (code: string, name: string) => {
      const account = customAccounts.find(row => row.code === code)
      if (account === undefined) throw new Error('Expected the mock account to exist')
      account.name = name
    },
    blockTemplate: () => { rejectTemplate = true },
    allowTemplate: () => { rejectTemplate = false },
    changeDatabase: () => { activeDatabaseUuid = 'e4c8a6d2-5270-4e89-bf27-5f243f3109d7' },
  }
}

async function fixture(existingRoot?: string, script: Parameters<typeof memoryFixture>[0] = []) {
  const h = await memoryFixture(script, existingRoot, {}, { financeConnectors: true })
  await h.ctx.plugin(UserQuestions)
  await h.ctx.plugin(XiaojingLedgerSetup)
  await h.ctx.xiaojingLedgerSetup.snapshot()
  return { ...h, setup: h.ctx.xiaojingLedgerSetup }
}

async function createPlan(setup: XiaojingLedgerSetup, mode: LedgerSetupPlan['mode'] = 'odoo-template') {
  await setup.saveConnection({ ...endpoint, apiKey: setupKey }, signal)
  return setup.propose({ ...draft, mode }, signal)
}

async function setupAgent(ctx: Context) {
  const main = (await ctx.katcatsTeam.snapshot()).bots.find(bot => bot.kind === 'main')!
  expect(await tool(ctx, 'create_ledger_setup_bot', ctx.agents.get(main.sessionId)!)).toMatchObject({ isError: false })
  const assistant = (await ctx.katcatsTeam.snapshot()).bots.find(bot => bot.id === ledgerSetupBotId)!
  return ctx.agents.get(assistant.sessionId)!
}

function wizardAnswer(question: AskUserQuestionItem, { text, label }: { text?: string; label?: RegExp } = {}) {
  if (text !== undefined) return { answers: [{ id: question.id, selected: [], custom: text }] }
  const option = question.options?.find(candidate => label === undefined || label.test(candidate.label))
  if (option === undefined) throw new Error('Expected an offered answer for ' + question.id)
  return { answers: [{ id: question.id, selected: [option.label] }] }
}

async function chartWorkbook(code: string, name: string): Promise<string> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Chart')
  sheet.addRow(['code', 'name', 'account_type'])
  sheet.addRow([code, name, 'asset_cash'])
  return Buffer.from(new Uint8Array(await workbook.xlsx.writeBuffer())).toString('base64')
}

function tool(
  ctx: Context, name: string, agent: NonNullable<ReturnType<Context['agents']['get']>>, args: object = {},
) {
  return ctx.tools.execute({ name, arguments: args, agent, signal, callId: ToolCallId('ledger-setup-tool-fixture') })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('XiaojingLedgerSetup workflow', () => {
  it('configures a database without selecting a company and persists a plan without Odoo writes', async () => {
    const odoo = mockOdoo()
    const h = await fixture()
    const connected = await h.setup.saveConnection({ ...endpoint, apiKey: setupKey }, signal)
    expect(connected).toMatchObject({ connection: { ...endpoint, account: { login: 'setup@example.test' } }, plans: [] })
    expect(odoo.calls.map(call => call.route)).toEqual([
      'res.users/context_get', 'res.users/has_group', 'res.company/has_access',
      'ir.module.module/search_count', 'ir.config_parameter/get_param', 'res.users/read',
    ])
    expect(JSON.stringify(connected)).not.toContain(setupKey)
    const status = await tool(h.ctx, 'ledger_setup_status', await setupAgent(h.ctx))
    expect(status.value).toEqual({ connection: { ...endpoint, verifiedAt: expect.any(String) }, plans: [] })
    const plan = await h.setup.propose(draft, signal)
    expect(plan).toMatchObject({ status: 'draft', revision: 0, templateName: template.name, customAccountCount: 0 })
    expect(await h.setup.propose(draft, signal)).toEqual(plan)
    const updated = await h.setup.propose({ ...draft, openingDate: '2026-02-02' }, signal)
    expect(updated).toMatchObject({ id: plan.id, revision: 1 })
    const before = odoo.calls.length
    await expect(h.setup.execute(plan.id, plan.revision, signal)).rejects.toMatchObject({ details: { reason: 'in-use' } })
    expect(odoo.calls).toHaveLength(before)
    expect(odoo.writes()).toEqual([])
    await h.close()
    const restarted = await fixture(h.root)
    expect((await restarted.setup.snapshot()).plans).toEqual([updated])
  })

  it('provisions two fixed private assistants with their own tool sets', async () => {
    const h = await fixture()
    const team = h.ctx.katcatsTeam
    const { bots } = await team.snapshot()
    const main = bots.find(bot => bot.kind === 'main')!
    const ledger = bots.find(bot => bot.id === ledgerSetupBotId)!
    const access = bots.find(bot => bot.id === odooAccessBotId)!
    expect(ledger).toMatchObject({ name: '建账助手', kind: 'ordinary' })
    expect(access).toMatchObject({ name: '系统助手', kind: 'ordinary' })
    expect(ledger.sessionId).not.toBe(access.sessionId)
    const mainAgent = h.ctx.agents.get(main.sessionId)!
    expect(await tool(h.ctx, 'create_ledger_setup_bot', mainAgent)).toMatchObject({
      isError: false, value: { bot_id: ledger.id, name: '建账助手', session_id: ledger.sessionId },
    })
    expect((await team.snapshot()).bots).toEqual(bots)

    const ledgerAgent = h.ctx.agents.get(ledger.sessionId)!
    const accessAgent = h.ctx.agents.get(access.sessionId)!
    for (const name of ['list_odoo_admin_companies', 'call_odoo_admin_orm']) {
      expect(h.ctx.tools.get(name, ledgerAgent)).toBeDefined()
      expect(h.ctx.tools.get(name, accessAgent)).toBeDefined()
      expect(h.ctx.tools.get(name, mainAgent)).toBeUndefined()
    }
    for (const name of ['list_ledger_setup_templates', 'prepare_ledger_setup', 'ledger_setup_status']) {
      expect(h.ctx.tools.get(name, ledgerAgent)).toBeDefined()
      expect(h.ctx.tools.get(name, accessAgent)).toBeUndefined()
      expect(h.ctx.tools.get(name, mainAgent)).toBeUndefined()
    }
    expect(h.ctx.tools.get('create_ledger_setup_bot', ledgerAgent)).toBeUndefined()
    expect(h.ctx.tools.get('create_ledger_setup_bot', accessAgent)).toBeUndefined()

    const { group } = await team.createGroup({ name: 'Other Bots' })
    for (const bot of [ledger, access]) {
      await expect(team.deleteBot({ id: bot.id })).rejects.toThrow()
      for (const patch of [{ name: 'Renamed' }, { role: 'Edited' }, { groupId: group.id },
        { avatar: { shape: 'classic', color: '#FF2849' } }] as const) {
        await expect(team.updateBot({ id: bot.id, ...patch })).rejects.toThrow()
      }
      await expect(h.ctx.katcatsChats.createChat({ name: 'Restricted', memberIds: [bot.id] })).rejects.toThrow()
    }
    expect((await team.snapshot()).bots).toEqual(bots)
  })

  it('sends each fixed assistant its own Chinese greeting', async () => {
    const h = await fixture(undefined, [textResponse('Fixture reply'), textResponse('Fixture reply')])
    const { bots } = await h.ctx.katcatsTeam.snapshot()
    const ledger = bots.find(bot => bot.id === ledgerSetupBotId)!
    const access = bots.find(bot => bot.id === odooAccessBotId)!
    const ledgerGreeting = '你好！我是小兢会计的建账助手 兢兢，负责 Odoo 的公司与组织管理、账套维护。'
    const accessGreeting = '你好！我是小兢会计的系统助手 业业，负责 Odoo 的用户与权限管理。'
    await memorySend(h.ctx.agents.get(ledger.sessionId)!, '你好')
    await memorySend(h.ctx.agents.get(access.sessionId)!, '你好')
    expect(h.adapter.requests.map(request => request.sessionId)).toEqual([ledger.sessionId, access.sessionId])
    const [ledgerPrompt, accessPrompt] = h.adapter.requests.map(request => request.messages
      .filter(message => message.role === 'system')
      .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n'))
    expect(ledgerPrompt).toContain(ledgerGreeting)
    expect(ledgerPrompt).not.toContain(accessGreeting)
    expect(accessPrompt).toContain(accessGreeting)
    expect(accessPrompt).not.toContain(ledgerGreeting)
  })

  it('keeps ordinary Team deployments free of the Odoo setup assistants', async () => {
    const h = await memoryFixture([], undefined, {}, { financeConnectors: true })
    const { bots } = await h.ctx.katcatsTeam.snapshot()
    expect(bots.map(bot => bot.id)).not.toContain(ledgerSetupBotId)
    expect(bots.map(bot => bot.id)).not.toContain(odooAccessBotId)
    const mainAgent = h.ctx.agents.get(bots.find(bot => bot.kind === 'main')!.sessionId)!
    expect(h.ctx.tools.get('call_odoo_admin_orm', mainAgent)).toBeUndefined()
  })

  it.each([
    { ledgerName: '建账助手', accessName: null },
    { ledgerName: '兢兢', accessName: '业业' },
  ])('retains private sessions and plans when the saved ledger assistant is $ledgerName', async ({ ledgerName, accessName }) => {
    const odoo = mockOdoo()
    const legacyReply = '原建账助手的会话记录。'
    const h = await fixture(undefined, [textResponse(legacyReply)])
    const plan = await createPlan(h.setup)
    const domain = h.ctx.storageDomain.get('katcats_team')!
    const saved = teamStateSchema.parse(domain.global.get())
    const legacy = { ...saved.bots.find(bot => bot.id === ledgerSetupBotId)!, name: ledgerName, role: '建账助手，负责初始化账套。' }
    const access = saved.bots.find(bot => bot.id === odooAccessBotId)!
    await memorySend(h.ctx.agents.get(legacy.sessionId)!, '之前的建账任务是什么？')
    await h.ctx.sessionController.rename({ sessionId: legacy.sessionId, title: legacy.name })
    if (accessName !== null) await h.ctx.sessionController.rename({ sessionId: access.sessionId, title: accessName })
    const { bot: coworker } = await h.ctx.katcatsTeam.createBot({ name: 'Bookkeeper' })
    const { chat } = await h.ctx.katcatsChats.createChat({ name: 'Existing group', memberIds: [coworker.id] })
    const chats = h.ctx.storageDomain.get(chatsDomainSpec.name)!
    const savedChats = chatsStateSchema.parse(chats.global.get())
    await chats.global.set({ ...savedChats, chats: savedChats.chats.map(group => group.id !== chat.id ? group : {
      ...group, memberIds: [legacy.id], executors: group.executors.map(executor => ({ ...executor, botId: legacy.id })),
    }) })
    const current = teamStateSchema.parse(domain.global.get())
    const previousBots = current.bots.filter(bot => bot.id !== odooAccessBotId)
      .map(bot => bot.id === ledgerSetupBotId ? legacy : bot)
    if (accessName !== null) previousBots.push({ ...access, name: accessName })
    await domain.global.set({ ...current, bots: previousBots })
    const connection = (await h.setup.snapshot()).connection
    await h.close()

    const reopened = await fixture(h.root)
    const { bots } = await reopened.ctx.katcatsTeam.snapshot()
    expect(bots.filter(bot => bot.id === ledgerSetupBotId)).toMatchObject([{
      name: '建账助手', sessionId: legacy.sessionId, workDir: legacy.workDir,
    }])
    expect(bots.filter(bot => bot.id === odooAccessBotId)).toMatchObject([{
      name: '系统助手', ...(accessName === null ? {} : { sessionId: access.sessionId, workDir: access.workDir }),
    }])
    const { events } = await reopened.ctx.sessionController.inspect(legacy.sessionId)
    expect(JSON.stringify(events)).toContain(legacyReply)
    expect(await reopened.setup.snapshot()).toEqual({ connection, plans: [plan] })
    const { chat: retained } = await reopened.ctx.katcatsChats.updateChat({ id: chat.id, name: 'Renamed group', memberIds: [legacy.id] })
    expect(retained).toMatchObject({ name: 'Renamed group', memberIds: [legacy.id] })
    await expect(reopened.ctx.katcatsChats.updateChat({ id: chat.id, memberIds: [legacy.id, odooAccessBotId] })).rejects.toThrow()
    expect(odoo.writes()).toEqual([])
  })

  it('lists companies and reads scoped accounting configuration using the verified database', async () => {
    const odoo = mockOdoo()
    const h = await fixture()
    const { bots } = await h.ctx.katcatsTeam.snapshot()
    const jing = h.ctx.agents.get(bots.find(bot => bot.id === ledgerSetupBotId)!.sessionId)!
    const ye = h.ctx.agents.get(bots.find(bot => bot.id === odooAccessBotId)!.sessionId)!
    expect(await tool(h.ctx, 'list_odoo_admin_companies', jing)).toMatchObject({ isError: true })
    expect(odoo.calls).toEqual([])
    await h.setup.saveConnection({ ...endpoint, apiKey: setupKey }, signal)

    for (const assistant of [jing, ye]) {
      const result = await tool(h.ctx, 'list_odoo_admin_companies', assistant)
      expect(result).toMatchObject({ isError: false, value: { database: endpoint.database, companies: [priorCompany] } })
      expect(JSON.stringify(result)).not.toContain(setupKey)
    }
    const scopedRead = { model: 'account.account', method: 'search_count', parameters_json: '{}' }
    const denied = await tool(h.ctx, 'call_odoo_admin_orm', jing, scopedRead)
    expect(denied).toMatchObject({ isError: true })
    expect(odoo.calls.map(call => call.route)).not.toContain('account.account/search_count')

    expect(await tool(h.ctx, 'call_odoo_admin_orm', jing, { ...scopedRead, company_id: priorCompany.id }))
      .toMatchObject({ isError: false })
    expect(odoo.calls.find(call => call.route === 'account.account/search_count')).toMatchObject({
      body: { context: { allowed_company_ids: [priorCompany.id] } },
    })
    expect(odoo.writes()).toEqual([])
  })

  it('requires an explicit answer for each role-scoped Odoo administration write', async () => {
    const odoo = mockOdoo()
    const h = await fixture()
    await h.setup.saveConnection({ ...endpoint, apiKey: setupKey }, signal)
    const { bots } = await h.ctx.katcatsTeam.snapshot()
    const jing = h.ctx.agents.get(bots.find(bot => bot.id === ledgerSetupBotId)!.sessionId)!
    const ye = h.ctx.agents.get(bots.find(bot => bot.id === odooAccessBotId)!.sessionId)!
    const company = { ids: [priorCompany.id], vals: { name: 'Updated company' } }
    const user = { ids: [42], vals: { name: 'Updated bookkeeper', group_ids: [[4, 7, 0]] } }
    const companyWrite = { model: 'res.company', method: 'write', parameters_json: JSON.stringify(company), summary: '更改公司名称' }
    const userWrite = { model: 'res.users', method: 'write', parameters_json: JSON.stringify(user), summary: '更新记账账号权限' }
    let answer: { selected: string[]; custom?: string } = { selected: ['取消'] }
    const questions: AskUserQuestionItem[] = []
    const stop = h.ctx.on('user-questions/request', async request => {
      expect(odoo.writes()).toHaveLength(request.agent === jing ? 0 : 1)
      expect(request.questions).toHaveLength(1)
      const question = request.questions[0]!
      expect(question).toMatchObject({ id: 'odoo-admin-write', header: '确认 Odoo 管理操作' })
      expect(question.options?.map(option => option.label)).toEqual(expect.arrayContaining(['确认执行', '取消']))
      expect(question.detail).toContain(request.agent === jing ? company.vals.name : user.vals.name)
      expect(question.detail).not.toContain(setupKey)
      questions.push(question)
      return { answers: [{ id: question.id, ...answer }] }
    })
    try {
      expect(await tool(h.ctx, 'call_odoo_admin_orm', jing, userWrite)).toMatchObject({ isError: true })
      expect(await tool(h.ctx, 'call_odoo_admin_orm', ye, companyWrite)).toMatchObject({ isError: true })
      expect(questions).toEqual([])
      expect(odoo.writes()).toEqual([])

      expect(await tool(h.ctx, 'call_odoo_admin_orm', jing, companyWrite)).toMatchObject({ isError: true })
      expect(questions).toHaveLength(1)
      expect(odoo.writes()).toEqual([])

      answer = { selected: [], custom: '确认执行' }
      expect(await tool(h.ctx, 'call_odoo_admin_orm', jing, companyWrite)).toMatchObject({ isError: true })
      expect(questions).toHaveLength(2)
      expect(odoo.writes()).toEqual([])

      answer = { selected: ['确认执行'] }
      const result = await tool(h.ctx, 'call_odoo_admin_orm', jing, companyWrite)
      expect(result).toMatchObject({ isError: false, value: {
        database: endpoint.database, company: null, model: 'res.company', method: 'write', data: true,
      } })
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.value) }])
      expect(await tool(h.ctx, 'call_odoo_admin_orm', ye, userWrite)).toMatchObject({ isError: false })
      expect(questions).toHaveLength(4)
      expect(questions.map(question => question.intent)).toEqual([undefined, undefined, undefined, undefined])
      expect(odoo.writes()).toMatchObject([
        { route: 'res.company/write', body: company }, { route: 'res.users/write', body: user },
      ])
      expect({ question: questions[2], result: result.value }).toMatchSnapshot({ result: { operation: {
        id: expect.any(String), createdAt: expect.any(String), updatedAt: expect.any(String),
      } } })
      expect(questions[3]).toMatchSnapshot()
    } finally { stop() }
  })

  it('rejects an approved administration write if the database identity changes during confirmation', async () => {
    const odoo = mockOdoo()
    const h = await fixture()
    const assistant = await setupAgent(h.ctx)
    await h.setup.saveConnection({ ...endpoint, apiKey: setupKey }, signal)
    const answer = vi.fn(async () => {
      expect(odoo.writes()).toEqual([])
      odoo.changeDatabase()
      return { answers: [{ id: 'odoo-admin-write', selected: ['确认执行'] }] }
    })
    const stop = h.ctx.on('user-questions/request', answer)
    try {
      const result = await tool(h.ctx, 'call_odoo_admin_orm', assistant, {
        model: 'res.company', method: 'write',
        parameters_json: JSON.stringify({ ids: [priorCompany.id], vals: { name: 'Updated company' } }),
      })
      expect(result).toMatchObject({ isError: true })
      expect(answer).toHaveBeenCalledOnce()
      expect(odoo.calls.filter(call => call.route === 'ir.config_parameter/get_param')).toHaveLength(3)
      expect(odoo.writes()).toEqual([])
    } finally { stop() }
  })

  it.each([
    { label: '使用 Odoo 会计科目模板', mode: 'odoo-template' },
    { label: '导入自定义科目表', mode: 'custom-chart' },
  ])('asks the owner to select the chart source before saving a $mode draft', async ({ label, mode }) => {
    const odoo = mockOdoo()
    const h = await fixture()
    const team = h.ctx.katcatsTeam
    const main = (await team.snapshot()).bots.find(bot => bot.kind === 'main')!
    expect(await tool(h.ctx, 'create_ledger_setup_bot', h.ctx.agents.get(main.sessionId)!)).toMatchObject({ isError: false })
    const assistant = (await team.snapshot()).bots.find(bot => bot.id === ledgerSetupBotId)!
    const assistantAgent = h.ctx.agents.get(assistant.sessionId)!
    await h.setup.saveConnection({ ...endpoint, apiKey: setupKey }, signal)
    let asked = 0
    let questions: AskUserQuestionItem[] | undefined
    const stop = h.ctx.on('user-questions/request', async request => {
      asked += 1
      questions = request.questions
      expect(request.agent).toBe(assistantAgent)
      expect(request.questions).toEqual([expect.objectContaining({
        id: 'ledger-chart-source',
        options: [expect.objectContaining({ label: '使用 Odoo 会计科目模板' }), expect.objectContaining({ label: '导入自定义科目表' })],
      })])
      expect((await h.setup.snapshot()).plans).toEqual([])
      expect(odoo.writes()).toEqual([])
      return { answers: [{ id: 'ledger-chart-source', selected: [label] }] }
    })
    try {
      const result = await tool(h.ctx, 'prepare_ledger_setup', assistantAgent, {
        name: draft.name, tax_id: draft.taxId, country_code: draft.countryCode, currency_code: draft.currencyCode,
        template_code: draft.templateCode, opening_date: draft.openingDate, setup_kind: 'fresh',
      })
      expect(result).toMatchObject({ isError: false })
      expect(asked).toBe(1)
      const outcome = z.looseObject({ id: z.uuid() }).parse(result.value)
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(outcome) }])
      expect({ questions, selected: label, outcome: { ...outcome, id: '<plan-id>' } }).toMatchSnapshot()
      expect((await h.setup.snapshot()).plans).toEqual([expect.objectContaining({ name: draft.name, mode, status: 'draft' })])
      expect(odoo.writes()).toEqual([])
    } finally { stop() }
  })

  it('opens each missing field in order and waits for an answer before advancing', async () => {
    const odoo = mockOdoo()
    const h = await fixture()
    const assistant = await setupAgent(h.ctx)
    await h.setup.saveConnection({ ...endpoint, apiKey: setupKey }, signal)
    const steps = [
      ['ledger-company-name', { text: draft.name }],
      ['ledger-country', { label: /中国|CN/ }],
      ['ledger-currency', { label: /人民币|CNY/ }],
      ['ledger-opening-date', { text: draft.openingDate }],
      ['ledger-setup-kind', { label: /全新|新设|新建/ }],
      ['ledger-chart-source', { label: /使用 Odoo 会计科目模板/ }],
      ['ledger-odoo-template', { label: /China - Small Business/ }],
    ] as const
    const opened = Promise.withResolvers<void>()
    const firstAnswer = Promise.withResolvers<void>()
    const questions: AskUserQuestionItem[] = []
    const stop = h.ctx.on('user-questions/request', async request => {
      expect(request.agent).toBe(assistant)
      expect(request.questions).toHaveLength(1)
      const question = request.questions[0]!
      const step = steps[questions.length]
      expect(question.id).toBe(step?.[0])
      expect((await h.setup.snapshot()).plans).toEqual([])
      expect(odoo.writes()).toEqual([])
      questions.push(question)
      if (questions.length === 1) {
        expect(question.options).toBeUndefined()
        opened.resolve()
        await firstAnswer.promise
      }
      return wizardAnswer(question, step?.[1])
    })
    try {
      const pending = tool(h.ctx, 'prepare_ledger_setup', assistant)
      await Promise.race([
        opened.promise,
        pending.then(result => { throw new Error('Wizard ended before opening the first field: ' + JSON.stringify(result.content)) }),
      ])
      expect(questions.map(question => question.id)).toEqual(['ledger-company-name'])
      firstAnswer.resolve()
      const result = await pending
      expect(result).toMatchObject({ isError: false })
      expect(questions.map(question => question.id)).toEqual(steps.map(([id]) => id))
      expect((await h.setup.snapshot()).plans).toEqual([expect.objectContaining({
        name: draft.name, countryCode: draft.countryCode, currencyCode: draft.currencyCode,
        openingDate: draft.openingDate, templateCode: draft.templateCode, mode: 'odoo-template', status: 'draft',
      })])
      expect(odoo.writes()).toEqual([])
    } finally {
      firstAnswer.resolve()
      stop()
    }
  })

  it('collects the remaining basics before database verification and reports confirmed values', async () => {
    const odoo = mockOdoo()
    const h = await fixture()
    const assistant = await setupAgent(h.ctx)
    const asked: string[] = []
    const stop = h.ctx.on('user-questions/request', async request => {
      expect(request.questions).toHaveLength(1)
      const question = request.questions[0]!
      asked.push(question.id)
      expect(question.id).toBe('ledger-opening-date')
      return wizardAnswer(question, { text: draft.openingDate })
    })
    try {
      const result = await tool(h.ctx, 'prepare_ledger_setup', assistant, {
        name: draft.name, country_code: draft.countryCode, currency_code: draft.currencyCode, setup_kind: 'fresh',
      })
      expect(result).toMatchObject({ isError: false })
      expect(asked).toEqual(['ledger-opening-date'])
      expect(result.value).toMatchObject({
        status: 'needs-connection',
        confirmed: { name: draft.name, country_code: draft.countryCode, currency_code: draft.currencyCode,
          opening_date: draft.openingDate, setup_kind: 'fresh' },
      })
      expect((await h.setup.snapshot()).plans).toEqual([])
      expect(odoo.calls).toEqual([])
    } finally { stop() }
  })

  it('reports an invalid template response and retains confirmed details after database verification', async () => {
    const odoo = mockOdoo({ cn: { ...template, name: null } })
    const h = await fixture()
    const assistant = await setupAgent(h.ctx)
    const { connection } = await h.setup.saveConnection({ ...endpoint, apiKey: setupKey }, signal)
    expect(connection).toMatchObject(endpoint)
    const confirmed = {
      name: draft.name, country_code: draft.countryCode, currency_code: draft.currencyCode,
      opening_date: draft.openingDate, setup_kind: 'fresh', tax_id: draft.taxId,
    }
    const result = await tool(h.ctx, 'prepare_ledger_setup', assistant, confirmed)
    expect(result).toMatchObject({ isError: false })
    expect(result.value).toEqual({
      status: 'blocked', failure: 'invalid-response', confirmed,
      message: '读取 Odoo 会计科目模板时收到了无法识别的数据。连接设置和已确认的建账信息可以沿用。',
    })
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.value) }])
    expect(odoo.calls.map(call => call.route)).toContain('ir.module.module/search_read')
    expect(await h.setup.snapshot()).toMatchObject({ connection, plans: [] })
    expect(odoo.writes()).toEqual([])
  })

  it.each(['skip', 'cancel'] as const)('preserves the completed fields when the user chooses %s on a required question', async (action) => {
    const odoo = mockOdoo()
    const h = await fixture()
    const assistant = await setupAgent(h.ctx)
    const asked: string[] = []
    const stop = h.ctx.on('user-questions/request', async request => {
      expect(request.questions).toHaveLength(1)
      const question = request.questions[0]!
      asked.push(question.id)
      expect(question.id).toBe('ledger-country')
      if (action === 'cancel') throw new UserQuestionError('The user cancelled', 'ASK_CANCELLED')
      return { answers: [{ id: question.id, selected: [] }] }
    })
    try {
      const result = await tool(h.ctx, 'prepare_ledger_setup', assistant, { name: draft.name })
      expect(result).toMatchObject({ isError: false })
      expect(result.value).toEqual({ status: 'paused', confirmed: { name: draft.name } })
      expect(asked).toEqual(['ledger-country'])
      expect((await h.setup.snapshot()).plans).toEqual([])
      expect(odoo.calls).toEqual([])
    } finally { stop() }
  })

  it('does not create a fresh-ledger draft for a confirmed migration', async () => {
    const odoo = mockOdoo()
    const h = await fixture()
    const assistant = await setupAgent(h.ctx)
    const question = vi.fn(async () => { throw new Error('Unexpected question for a confirmed migration') })
    const stop = h.ctx.on('user-questions/request', question)
    try {
      const result = await tool(h.ctx, 'prepare_ledger_setup', assistant, {
        name: draft.name, country_code: draft.countryCode, currency_code: draft.currencyCode,
        opening_date: draft.openingDate, setup_kind: 'migration',
      })
      expect(result).toMatchObject({ isError: false })
      expect(result.value).toMatchObject({ status: 'migration-needs-review', confirmed: { setup_kind: 'migration' } })
      expect(question).not.toHaveBeenCalled()
      expect((await h.setup.snapshot()).plans).toEqual([])
      expect(odoo.calls).toEqual([])
    } finally { stop() }
  })

  it('keeps the selected chart source if the user pauses at the template question', async () => {
    const odoo = mockOdoo()
    const h = await fixture()
    const assistant = await setupAgent(h.ctx)
    await h.setup.saveConnection({ ...endpoint, apiKey: setupKey }, signal)
    const asked: string[] = []
    const stop = h.ctx.on('user-questions/request', async request => {
      expect(request.questions).toHaveLength(1)
      const question = request.questions[0]!
      asked.push(question.id)
      if (question.id === 'ledger-chart-source') return wizardAnswer(question, { label: /导入自定义科目表/ })
      expect(question.id).toBe('ledger-odoo-template')
      return { answers: [{ id: question.id, selected: [] }] }
    })
    try {
      const result = await tool(h.ctx, 'prepare_ledger_setup', assistant, {
        name: draft.name, country_code: draft.countryCode, currency_code: draft.currencyCode,
        opening_date: draft.openingDate, setup_kind: 'fresh',
      })
      expect(result).toMatchObject({ isError: false })
      expect(result.value).toMatchObject({ status: 'paused', confirmed: { chart_source: 'custom-chart' } })
      expect(asked).toEqual(['ledger-chart-source', 'ledger-odoo-template'])
      expect((await h.setup.snapshot()).plans).toEqual([])
      expect(odoo.writes()).toEqual([])
    } finally { stop() }
  })

  it('adds the ready ledger to Connectors with a separate account while keeping group bindings', async () => {
    const odoo = mockOdoo()
    const h = await fixture()
    const plan = await createPlan(h.setup)
    const team = h.ctx.katcatsTeam
    const groups = h.ctx.katcatsChats
    const { bot } = await team.createBot({ name: 'Bookkeeper' })
    const { chat: bound } = await groups.createChat({ name: 'Existing bookkeeping', memberIds: [bot.id] })
    const { chat: unbound } = await groups.createChat({ name: 'Other group', memberIds: [bot.id] })
    const previous = await team.saveFinanceConnector({
      ...endpoint, name: priorCompany.name, companyId: priorCompany.id, apiKey: dailyKey,
    }, signal)
    await groups.bindFinance(bound.id, previous.id)
    const { plans: [ready] } = await h.setup.execute(plan.id, plan.revision, signal)
    expect(ready).toMatchObject({ status: 'ready', companyId, accountCount: 12, journalCount: 5 })
    expect(odoo.writes().map(call => call.route)).toEqual(['res.company/create', 'account.chart.template/try_loading'])

    await expect(h.setup.addConnector(plan.id, { accessMode: 'full', apiKey: sameUserKey }, signal))
      .rejects.toMatchObject({ details: { reason: 'permissions' } })
    expect((await team.financeSnapshot())?.connectors).toEqual([previous])

    const request = { accessMode: 'full', apiKey: dailyKey } as const
    const added = await h.setup.addConnector(plan.id, request, signal)
    expect(added.plans[0]).toMatchObject({ status: 'handed-off' })
    expect(added.plans[0]).not.toHaveProperty('chatId')
    expect(JSON.stringify(added)).not.toContain(dailyKey)
    const finance = await team.financeSnapshot()
    expect(finance?.connectors).toHaveLength(2)
    expect(finance?.connectors.find(connector => connector.company.id === companyId)).toMatchObject({
      ...endpoint, id: plan.id, type: 'odoo', name: draft.name,
      company: { id: companyId, name: draft.name, currency: 'CNY' },
      accessMode: 'full', failure: null,
    })
    expect(await groups.financeBinding(bound.id)).toBe(previous.id)
    expect(await groups.financeBinding(unbound.id)).toBeNull()

    const after = odoo.calls.length
    await h.close()
    const reopened = await fixture(h.root)
    await expect(reopened.setup.addConnector(plan.id, request, signal)).resolves.toEqual(added)
    expect((await reopened.ctx.katcatsTeam.financeSnapshot())?.connectors).toHaveLength(2)
    expect(await reopened.ctx.katcatsChats.financeBinding(bound.id)).toBe(previous.id)
    expect(await reopened.ctx.katcatsChats.financeBinding(unbound.id)).toBeNull()
    expect(odoo.calls).toHaveLength(after)
  })

  it('reuses the saved connector after the setup status could not be committed', async () => {
    const odoo = mockOdoo()
    const h = await fixture()
    const plan = await createPlan(h.setup)
    await h.setup.execute(plan.id, plan.revision, signal)
    const global = h.ctx.storageDomain.get('xiaojing_ledger_setup')!.global
    const set = global.set.bind(global)
    const planStatuses = z.object({ plans: z.array(z.object({ status: z.string() })) })
    const failStatusWrite = vi.spyOn(global, 'set').mockImplementation(value => {
      if (planStatuses.parse(value).plans.some(item => item.status === 'handed-off')) {
        failStatusWrite.mockRestore()
        return Promise.reject(new Error('Synthetic setup status write failure'))
      }
      return set(value)
    })
    const request = { accessMode: 'read-only', apiKey: dailyKey } as const
    try {
      await expect(h.setup.addConnector(plan.id, request, signal)).rejects.toMatchObject({ details: { reason: 'storage' } })
    } finally { failStatusWrite.mockRestore() }
    expect((await h.setup.snapshot()).plans[0]).toMatchObject({ id: plan.id, status: 'ready' })
    expect((await h.ctx.katcatsTeam.financeSnapshot())?.connectors.map(connector => connector.id)).toEqual([plan.id])
    await h.close()

    const reopened = await fixture(h.root)
    const result = await reopened.setup.addConnector(plan.id, request, signal)
    expect(result.plans[0]).toMatchObject({ id: plan.id, status: 'handed-off' })
    expect((await reopened.ctx.katcatsTeam.financeSnapshot())?.connectors).toEqual([expect.objectContaining({
      id: plan.id, company: { id: companyId, name: draft.name, currency: 'CNY' }, accessMode: 'read-only',
    })])
    expect(odoo.writes().map(call => call.route)).toEqual(['res.company/create', 'account.chart.template/try_loading'])
  })

  it('blocks a duplicate company write when a dispatched create loses its response across restart', async () => {
    const odoo = mockOdoo()
    const h = await fixture()
    const plan = await createPlan(h.setup)
    odoo.loseCreateReply()
    const outcome = await h.setup.execute(plan.id, plan.revision, signal)
    expect(outcome.plans[0]).toMatchObject({ status: 'uncertain', failure: 'unknown-outcome' })
    expect(outcome.plans[0]?.companyId).toBeUndefined()
    await h.close()
    const restarted = await fixture(h.root)
    expect(await restarted.setup.snapshot()).toEqual(outcome)
    await expect(restarted.setup.execute(plan.id, outcome.plans[0]!.revision, signal))
      .rejects.toMatchObject({ details: { reason: 'in-use' } })
    expect(odoo.writes().map(call => call.route)).toEqual(['res.company/create'])
  })

  it('continues a verified company ID after reopening a blocked template step', async () => {
    const odoo = mockOdoo()
    const h = await fixture()
    const plan = await createPlan(h.setup)
    odoo.blockTemplate()
    const result = await h.setup.execute(plan.id, plan.revision, signal)
    expect(result.plans[0]).toMatchObject({ status: 'blocked', companyId, failure: 'permissions' })
    await h.close()
    const restarted = await fixture(h.root)
    odoo.allowTemplate()
    const ready = await restarted.setup.execute(plan.id, result.plans[0]!.revision, signal)
    expect(ready.plans[0]).toMatchObject({ status: 'ready', companyId })
    expect(odoo.writes().map(call => call.route)).toEqual([
      'res.company/create', 'account.chart.template/try_loading', 'account.chart.template/try_loading',
    ])
  })

  it('reconciles a lost create receipt only after selecting its exact company and separately approving initialization', async () => {
    const odoo = mockOdoo()
    const h = await fixture()
    const plan = await createPlan(h.setup)
    odoo.loseCreateReply()
    const failed = (await h.setup.execute(plan.id, plan.revision, signal)).plans[0]!
    expect(failed.status).toBe('uncertain')
    await expect(h.setup.recoveryCompanies(plan.id, plan.revision, signal))
      .rejects.toMatchObject({ details: { reason: 'in-use' } })
    expect(await h.setup.recoveryCompanies(plan.id, failed.revision, signal))
      .toEqual([{ id: companyId, name: draft.name, currency: 'CNY' }])
    expect((await h.setup.snapshot()).plans[0]).toEqual(failed)
    expect(await h.setup.propose({ ...draft, existingCompanyId: companyId }, signal)).toEqual(failed)
    await expect(h.setup.execute(plan.id, failed.revision, signal)).rejects.toMatchObject({ details: { reason: 'in-use' } })
    odoo.alterCompany({ vat: 'WRONG-TAX-ID' })
    await expect(h.setup.reconcile(plan.id, failed.revision, companyId, signal))
      .rejects.toMatchObject({ details: { reason: 'ledger-mismatch' } })
    expect((await h.setup.snapshot()).plans[0]).toEqual(failed)
    odoo.alterCompany({ vat: draft.taxId })
    const associated = (await h.setup.reconcile(plan.id, failed.revision, companyId, signal)).plans[0]!
    expect(associated).toMatchObject({ id: plan.id, companyId, status: 'blocked' })
    expect(odoo.writes().map(call => call.route)).toEqual(['res.company/create'])
    await h.close()
    const restarted = await fixture(h.root)
    expect((await restarted.setup.snapshot()).plans[0]).toEqual(associated)
    await expect(restarted.setup.execute(plan.id, failed.revision, signal)).rejects.toMatchObject({ details: { reason: 'in-use' } })
    const ready = await restarted.setup.execute(plan.id, associated.revision, signal)
    expect(ready.plans[0]).toMatchObject({ status: 'ready', companyId, accountCount: 12 })
    expect(odoo.writes().map(call => call.route)).toEqual(['res.company/create', 'account.chart.template/try_loading'])
  })

  it('adopts an explicitly selected empty company in a draft and initializes it after approval without another create', async () => {
    const odoo = mockOdoo()
    odoo.existingCompany()
    const h = await fixture()
    await h.setup.saveConnection({ ...endpoint, apiKey: setupKey }, signal)
    const plan = await h.setup.propose({ ...draft, existingCompanyId: companyId }, signal)
    expect(plan).toMatchObject({ existingCompanyId: companyId, companyId, status: 'draft' })
    expect(odoo.writes()).toEqual([])
    await h.close()
    const reopened = await fixture(h.root)
    expect((await reopened.setup.snapshot()).plans[0]).toEqual(plan)
    const ready = await reopened.setup.execute(plan.id, plan.revision, signal)
    expect(ready.plans[0]).toMatchObject({ status: 'ready', companyId })
    expect(odoo.writes().map(call => call.route)).toEqual(['res.company/write', 'account.chart.template/try_loading'])
    expect(odoo.writes()[0]?.body.vals).toEqual({ account_opening_date: draft.openingDate })
  })

  it('passes an explicitly chosen existing company through the setup tool without asking to recreate it', async () => {
    const odoo = mockOdoo()
    odoo.existingCompany()
    const h = await fixture()
    await h.setup.saveConnection({ ...endpoint, apiKey: setupKey }, signal)
    const result = await tool(h.ctx, 'prepare_ledger_setup', await setupAgent(h.ctx), {
      name: draft.name, tax_id: draft.taxId, country_code: draft.countryCode, currency_code: draft.currencyCode,
      opening_date: draft.openingDate, setup_kind: 'fresh', chart_source: draft.mode,
      template_code: draft.templateCode, existing_company_id: companyId,
    })
    expect(result).toMatchObject({ isError: false, value: { companyId, existingCompanyId: companyId, status: 'draft' } })
    expect((await h.setup.snapshot()).plans[0]).toMatchObject({ companyId, existingCompanyId: companyId })
    expect(odoo.writes()).toEqual([])
  })

  it('retains an existing company selection when setup pauses for a database connection', async () => {
    const odoo = mockOdoo()
    const h = await fixture()
    const result = await tool(h.ctx, 'prepare_ledger_setup', await setupAgent(h.ctx), {
      name: draft.name, tax_id: draft.taxId, country_code: draft.countryCode, currency_code: draft.currencyCode,
      opening_date: draft.openingDate, setup_kind: 'fresh', existing_company_id: companyId,
    })
    expect(result).toMatchObject({ isError: false, value: {
      status: 'needs-connection', confirmed: { existing_company_id: companyId, name: draft.name },
    } })
    expect((await h.setup.snapshot()).plans).toEqual([])
    expect(odoo.calls).toEqual([])
  })

  it('rechecks identity and new accounting activity before writing to a selected existing company', async () => {
    const odoo = mockOdoo()
    odoo.existingCompany()
    const h = await fixture()
    await h.setup.saveConnection({ ...endpoint, apiKey: setupKey }, signal)
    odoo.alterCompany({ name: 'Different Company' })
    await expect(h.setup.propose({ ...draft, existingCompanyId: companyId }, signal))
      .rejects.toMatchObject({ details: { reason: 'ledger-mismatch' } })
    expect((await h.setup.snapshot()).plans).toEqual([])
    odoo.alterCompany({ name: draft.name })
    const plan = await h.setup.propose({ ...draft, existingCompanyId: companyId }, signal)
    odoo.addMove()
    const blocked = await h.setup.execute(plan.id, plan.revision, signal)
    expect(blocked.plans[0]).toMatchObject({ status: 'blocked', failure: 'ledger-mismatch', companyId })
    expect(odoo.writes()).toEqual([])
  })

  it('refuses recovery under a changed database identity and keeps the uncertain plan unassigned', async () => {
    const odoo = mockOdoo()
    const h = await fixture()
    const plan = await createPlan(h.setup)
    odoo.loseCreateReply()
    const failed = (await h.setup.execute(plan.id, plan.revision, signal)).plans[0]!
    odoo.changeDatabase()
    await expect(h.setup.recoveryCompanies(plan.id, failed.revision, signal))
      .rejects.toMatchObject({ details: { reason: 'ledger-mismatch' } })
    await expect(h.setup.reconcile(plan.id, failed.revision, companyId, signal))
      .rejects.toMatchObject({ details: { reason: 'ledger-mismatch' } })
    expect((await h.setup.snapshot()).plans[0]).toEqual(failed)
    expect(odoo.writes().map(call => call.route)).toEqual(['res.company/create'])
    await h.setup.saveConnection({ ...endpoint, apiKey: setupKey }, signal)
    expect((await h.setup.currentPlans(signal)).plans).toEqual([])
    expect((await h.setup.snapshot()).plans).toEqual([failed])
  })

  it('rejects a database identity change before confirming writes', async () => {
    const odoo = mockOdoo()
    const h = await fixture()
    const plan = await createPlan(h.setup)
    odoo.changeDatabase()
    await expect(h.setup.execute(plan.id, plan.revision, signal)).rejects.toMatchObject({ details: { reason: 'ledger-mismatch' } })
    expect(odoo.writes()).toEqual([])
  })

  it('requires the validated workbook revision and verifies scoped custom accounts before readiness', async () => {
    const odoo = mockOdoo()
    const h = await fixture()
    const plan = await createPlan(h.setup, 'custom-chart')
    await expect(h.setup.execute(plan.id, plan.revision, signal)).rejects.toMatchObject({ details: { reason: 'invalid-input' } })
    expect(odoo.writes()).toEqual([])
    const upload = await chartWorkbook('001001', 'Custom Cash')
    const uploaded = await h.setup.uploadChart(plan.id, plan.revision, 'Chart.xlsx', upload)
    expect(uploaded.plans[0]).toMatchObject({ revision: 1, customAccountCount: 1, customChart: { name: 'Chart.xlsx' } })
    expect(JSON.stringify(uploaded)).not.toContain('Custom Cash')
    await expect(h.setup.execute(plan.id, plan.revision, signal)).rejects.toMatchObject({ details: { reason: 'in-use' } })
    const ready = await h.setup.execute(plan.id, uploaded.plans[0]!.revision, signal)
    expect(ready.plans[0]).toMatchObject({ status: 'ready', accountCount: 13, companyId })
    expect(odoo.writes()[2]).toMatchObject({ route: 'account.account/create', body: {
      context: { allowed_company_ids: [companyId] },
      vals_list: [{ code: '001001', name: 'Custom Cash', account_type: 'asset_cash', reconcile: false, company_ids: [[6, 0, [companyId]]] }],
    } })
  })

  it('allows a replacement workbook after a preflight conflict and rechecks the approved chart before adding its connector', async () => {
    const odoo = mockOdoo()
    const h = await fixture()
    const plan = await createPlan(h.setup, 'custom-chart')
    odoo.addAccount('001001', 'Existing Cash')
    const original = await h.setup.uploadChart(plan.id, plan.revision, 'Original.xlsx', await chartWorkbook('001001', 'Custom Cash'))
    const blocked = await h.setup.execute(plan.id, original.plans[0]!.revision, signal)
    expect(blocked.plans[0]).toMatchObject({ status: 'blocked', companyId, failure: 'ledger-mismatch', customChartEditable: true })
    expect(odoo.writes().map(call => call.route)).toEqual(['res.company/create', 'account.chart.template/try_loading'])
    const revised = await h.setup.uploadChart(plan.id, blocked.plans[0]!.revision, 'Revised.xlsx', await chartWorkbook('001002', 'Custom Cash'))
    await expect(h.setup.execute(plan.id, blocked.plans[0]!.revision, signal)).rejects.toMatchObject({ details: { reason: 'in-use' } })
    const ready = await h.setup.execute(plan.id, revised.plans[0]!.revision, signal)
    expect(ready.plans[0]).toMatchObject({ status: 'ready', companyId })
    expect(odoo.writes().map(call => call.route)).toEqual(['res.company/create', 'account.chart.template/try_loading', 'account.account/create'])
    odoo.renameAccount('001002', 'Changed Cash')
    await expect(h.setup.addConnector(plan.id, { accessMode: 'full', apiKey: dailyKey }, signal))
      .rejects.toMatchObject({ details: { reason: 'ledger-mismatch' } })
    expect((await h.ctx.katcatsTeam.financeSnapshot())?.connectors).toEqual([])
    expect(odoo.calls.some(call => call.credential === 'Bearer ' + dailyKey)).toBe(false)
  })

  it('resumes an unconfirmed custom import using the same workbook without duplicating accounts', async () => {
    const odoo = mockOdoo()
    const h = await fixture()
    const plan = await createPlan(h.setup, 'custom-chart')
    const upload = await chartWorkbook('001001', 'Custom Cash')
    const approved = await h.setup.uploadChart(plan.id, plan.revision, 'Chart.xlsx', upload)
    odoo.loseImportReply()
    const blocked = await h.setup.execute(plan.id, approved.plans[0]!.revision, signal)
    expect(blocked.plans[0]).toMatchObject({ status: 'blocked', companyId, failure: 'unknown-outcome' })
    await expect(h.setup.uploadChart(plan.id, blocked.plans[0]!.revision, 'New.xlsx', upload))
      .rejects.toMatchObject({ details: { reason: 'in-use' } })
    const ready = await h.setup.execute(plan.id, blocked.plans[0]!.revision, signal)
    expect(ready.plans[0]).toMatchObject({ status: 'ready', companyId, accountCount: 13 })
    expect(odoo.writes().map(call => call.route)).toEqual(['res.company/create', 'account.chart.template/try_loading', 'account.account/create'])
  })
})
