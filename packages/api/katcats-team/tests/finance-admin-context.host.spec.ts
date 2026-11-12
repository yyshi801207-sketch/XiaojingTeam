/** Fixed assistants isolate database history using persisted context and leave ordinary Bot memory intact. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { authorizeFinanceAdminContext } from '../src/finance-admin-context.ts'
import XiaojingLedgerSetup from '../src/finance-setup.ts'
import { ledgerSetupBotId, odooAccessBotId } from '../src/types.ts'
import { memoryFixture, memorySend } from './memory-fixture.ts'

const endpoint = { url: 'https://admin-context.example', database: 'first_database' }
const firstUuid = 'a0e86794-f5ca-4777-9e1b-6373300cae11'
const secondUuid = 'e4c8a6d2-5270-4e89-bf27-5f243f3109d7'
const signal = new AbortController().signal

function server() {
  let databaseUuid = firstUuid
  let userId = 17
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
    const route = new URL(String(url)).pathname.split('/json/2/')[1]
    expect(new Headers(init?.headers).has('authorization')).toBe(true)
    switch (route) {
      case 'res.users/context_get': return Response.json({ uid: userId })
      case 'res.users/read': return Response.json([{ id: userId, login: 'admin@example.test' }])
      case 'res.users/has_group':
      case 'res.company/has_access': return Response.json(true)
      case 'ir.module.module/search_count': return Response.json(1)
      case 'ir.config_parameter/get_param': return Response.json(databaseUuid)
      default: throw new Error('Unexpected Odoo request: ' + route)
    }
  }))
  return { changeDatabase: () => { databaseUuid = secondUuid }, changeUser: () => { userId = 42 } }
}

async function fixture(script: Parameters<typeof memoryFixture>[0] = [], root?: string) {
  const h = await memoryFixture(script, root, {}, { financeConnectors: true })
  await h.ctx.plugin(UserQuestions)
  await h.ctx.plugin(XiaojingLedgerSetup)
  const setup = h.ctx.xiaojingLedgerSetup
  await setup.snapshot()
  const bots = (await h.ctx.katcatsTeam.snapshot()).bots
  const jingResult = await h.ctx.sessionController.resolveAgent(bots.find(bot => bot.id === ledgerSetupBotId)!.sessionId)
  const yeResult = await h.ctx.sessionController.resolveAgent(bots.find(bot => bot.id === odooAccessBotId)!.sessionId)
  if ('error' in jingResult) throw jingResult.error
  if ('error' in yeResult) throw yeResult.error
  const jing = jingResult.agent
  const ye = yeResult.agent
  return { ...h, setup, jing, ye }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('fixed assistant administration context', () => {
  it('isolates legacy history and saved memories before the first scoped request of both assistants', async () => {
    server()
    const h = await fixture([textResponse('Ready in the current database.'), textResponse('Current permissions inspected.')])
    await h.setup.saveConnection({ ...endpoint, apiKey: 'synthetic-first-key' }, signal)
    await h.ctx.katcatsMemory.save({ scope: { kind: 'bot', botId: ledgerSetupBotId }, text: 'LEGACY_PRIVATE_COMPANY_ID_81' })
    await h.ctx.katcatsMemory.save({ scope: { kind: 'team' }, text: 'LEGACY_SHARED_COMPANY_ID_82' })
    for (const agent of [h.jing, h.ye]) {
      agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'LEGACY_DATABASE_COMPANY_ID_83' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      expect(() => authorizeFinanceAdminContext(h.setup, agent)).toThrow('Start a new turn')
      await memorySend(agent, 'Inspect the currently configured database.')
      const request = h.adapter.requests.at(-1)!
      expect(JSON.stringify(request.messages)).not.toContain('LEGACY_')
      expect(JSON.stringify(agent.session.snapshotEvents())).toContain('LEGACY_DATABASE_COMPANY_ID_83')
      expect(request.tools?.map(tool => tool.name)).not.toContain('recall')
      expect(() => authorizeFinanceAdminContext(h.setup, agent)).not.toThrow()
    }
    const request = h.adapter.requests[0]!
    expect(request.messages.filter(message => message.role === 'user').map(message => ({
      source: message.source?.kind, content: message.content,
    }))).toMatchSnapshot()
    expect(JSON.stringify(request.messages)).not.toContain('synthetic-first-key')
    const ordinary = await h.ctx.katcatsTeam.createBot({ name: 'Ordinary member' })
    const ordinaryAgent = h.ctx.agents.get(ordinary.bot.sessionId)!
    expect(h.ctx.tools.get('recall', ordinaryAgent)).toBeDefined()
  })

  it('keeps same-account key rotations and restarts, but removes old database history after a switch', async () => {
    const odoo = server()
    const h = await fixture([textResponse('FIRST_DATABASE_COMPANY_100'), textResponse('Same account remains active.')])
    await h.setup.saveConnection({ ...endpoint, apiKey: 'synthetic-first-key' }, signal)
    await memorySend(h.jing, 'Remember the first database context for this conversation.')
    await h.setup.saveConnection({ ...endpoint, apiKey: 'synthetic-rotated-key' }, signal)
    await memorySend(h.jing, 'Continue in the same database.')
    expect(JSON.stringify(h.adapter.requests.at(-1)!.messages)).toContain('FIRST_DATABASE_COMPANY_100')
    const sessionId = h.jing.id
    await h.close()
    const restored = await fixture([textResponse('Resume same database.'), textResponse('SECOND_DATABASE_VERIFIED')], h.root)
    expect(restored.jing.id).toBe(sessionId)
    await memorySend(restored.jing, 'Resume after restart.')
    expect(JSON.stringify(restored.adapter.requests[0]!.messages)).toContain('FIRST_DATABASE_COMPANY_100')
    odoo.changeDatabase()
    await restored.setup.saveConnection({ ...endpoint, apiKey: 'synthetic-second-key' }, signal)
    expect(() => authorizeFinanceAdminContext(restored.setup, restored.jing)).toThrow('Start a new turn')
    const priorNodes = [...restored.jing.session.surface.nodes]
    await memorySend(restored.jing, 'Inspect this new database.')
    const switched = JSON.stringify(restored.adapter.requests.at(-1)!.messages)
    expect(switched).not.toContain('FIRST_DATABASE_COMPANY_100')
    expect(switched).not.toContain(firstUuid)
    expect(switched).toContain(secondUuid)
    const replacement = restored.jing.session.snapshotEvents().findLast(event => event.type === 'user/message' && event.data.source.kind === 'system-prompt')!
    expect(replacement.sourceEventSeqs).toEqual(priorNodes.slice(1))
    expect(JSON.stringify(restored.jing.session.snapshotEvents())).toContain('FIRST_DATABASE_COMPANY_100')
    await restored.close()
    const reopened = await fixture([textResponse('The new database remains active.')], h.root)
    await memorySend(reopened.jing, 'Continue after another restart.')
    const afterRestart = JSON.stringify(reopened.adapter.requests[0]!.messages)
    expect(afterRestart).toContain('SECOND_DATABASE_VERIFIED')
    expect(afterRestart).not.toContain('FIRST_DATABASE_COMPANY_100')
  })

  it('retains a same-database compaction after restart and removes its summary when the account changes', async () => {
    const odoo = server()
    const h = await fixture([textResponse('ORIGINAL_DATABASE_COMPANY_500')])
    await h.setup.saveConnection({ ...endpoint, apiKey: 'synthetic-first-key' }, signal)
    await memorySend(h.jing, 'Inspect the current company.')
    const session = h.jing.session
    const nodes = session.surface.nodes.slice(1)
    const startSeq = nodes[0]!
    const endSeq = nodes.at(-1)!
    const compactionId = CompactionId('administration-context-compaction')
    const summary = [{ type: 'text' as const, text: 'SUMMARY_DATABASE_COMPANY_500' }]
    const started = session.append('compaction/start', { compactionId, turn: null })
    const summarized = session.append('compaction/summary', {
      compactionId, summary, shadowedRange: { start: startSeq, end: endSeq },
      shadowedSeqs: [...nodes], shadowedTokenCount: 100, provider: 'fixture', model: 'fixture-model',
    })
    session.append('user/message', createUserMessage({
      content: summary, source: { kind: 'compact-checkpoint', compactionId },
    }), { surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs: [started.seq, summarized.seq, ...nodes] })
    session.append('compaction/end', { compactionId, turn: null })
    await h.close()
    const restored = await fixture([textResponse('Same database resumed.'), textResponse('New account verified.')], h.root)
    await memorySend(restored.jing, 'Continue after compaction.')
    const sameAccount = JSON.stringify(restored.adapter.requests[0]!.messages)
    expect(sameAccount).toContain('SUMMARY_DATABASE_COMPANY_500')
    expect(sameAccount).not.toContain('ORIGINAL_DATABASE_COMPANY_500')
    expect(sameAccount).toContain(firstUuid)
    odoo.changeUser()
    await restored.setup.saveConnection({ ...endpoint, apiKey: 'synthetic-other-user-key' }, signal)
    await memorySend(restored.jing, 'Inspect permissions of the current account.')
    expect(JSON.stringify(restored.adapter.requests[1]!.messages)).not.toContain('SUMMARY_DATABASE_COMPANY_500')
    expect(JSON.stringify(restored.jing.session.snapshotEvents())).toContain('SUMMARY_DATABASE_COMPANY_500')
  })

  it.each(['url', 'database', 'user'] as const)('isolates an administration %s change even when the database UUID is unchanged', async change => {
    const odoo = server()
    const h = await fixture([textResponse('OLD_SCOPE_RECORD_404'), textResponse('Resolved new scope.')])
    await h.setup.saveConnection({ ...endpoint, apiKey: 'synthetic-first-key' }, signal)
    await memorySend(h.ye, 'Inspect users in this database.')
    if (change === 'user') odoo.changeUser()
    await h.setup.saveConnection({ ...endpoint, ...(change === 'url' ? { url: 'https://other-admin.example' } : {}),
      ...(change === 'database' ? { database: 'renamed_database' } : {}), apiKey: 'synthetic-new-key' }, signal)
    await memorySend(h.ye, 'Inspect users in the configured database.')
    expect(JSON.stringify(h.adapter.requests.at(-1)!.messages)).not.toContain('OLD_SCOPE_RECORD_404')
  })

  it.each(['jing', 'ye'] as const)('rejects a database switch while %s has an active model turn', async assistant => {
    const odoo = server()
    const h = await fixture(['hang'])
    await h.setup.saveConnection({ ...endpoint, apiKey: 'synthetic-first-key' }, signal)
    const agent = h[assistant]
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect current users.' }], source: { kind: 'user' } }))
    await vi.waitFor(() => expect(h.adapter.requests).toHaveLength(1))
    odoo.changeDatabase()
    await expect(h.setup.saveConnection({ ...endpoint, apiKey: 'synthetic-next-key' }, signal)).rejects.toMatchObject({ details: { reason: 'in-use' } })
    expect(h.setup.adminContextScope()?.databaseUuid).toBe(firstUuid)
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    await h.setup.saveConnection({ ...endpoint, apiKey: 'synthetic-next-key' }, signal)
    expect(h.setup.adminContextScope()?.databaseUuid).toBe(secondUuid)
  })
})
