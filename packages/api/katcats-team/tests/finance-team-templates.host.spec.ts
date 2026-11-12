/** Fixed finance teams persist complete editable rosters and the default responsible manager. */
import { expect, it, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { financeTeamPositions, financeTeamTemplates } from '../src/finance-team-templates.ts'
import { teamStateSchema } from '../src/storage.ts'
import { chatsStateSchema } from '../src/chats-storage.ts'
import { memoryFixture, memorySend } from './memory-fixture.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

type Fixture = Awaited<ReturnType<typeof memoryFixture>>

async function mainAgent(h: Fixture): Promise<Agent> {
  const snapshot = await h.ctx.katcatsTeam.snapshot()
  const main = snapshot.bots.find(bot => bot.id === snapshot.mainBotId)!
  const resolved = await h.ctx.sessionController.resolveAgent(main.sessionId)
  if (!('agent' in resolved)) throw new Error('Missing finance team creation Agent')
  return resolved.agent
}

async function create(h: Fixture, args: object, agent?: Agent, signal = new AbortController().signal) {
  return h.ctx.tools.execute({ name: 'create_finance_team', arguments: args,
    agent: agent ?? await mainAgent(h), signal, callId: ToolCallId('finance-template-fixture') })
}

it.each(financeTeamTemplates)('saves every %s position with a finance manager and preserves it after restart', async template => {
  const h = await memoryFixture([], undefined, {}, { financeConnectors: true })
  const folder = (await h.ctx.katcatsTeam.createGroup({ name: 'Finance' })).group
  const args = { template, name: 'Accounting', group_id: folder.id }
  const result = await create(h, args)
  expect(result.isError).toBe(false)
  const snapshot = await h.ctx.katcatsTeam.snapshot()
  const chat = (await h.ctx.katcatsChats.snapshot()).chats[0]!
  const members = chat.memberIds.map(id => snapshot.bots.find(bot => bot.id === id)!)
  expect(members.map(bot => bot.name)).toEqual(financeTeamPositions(template).map(position => position.name))
  expect(members.map(bot => bot.role)).toEqual(financeTeamPositions(template).map(position => position.role))
  expect(chat.managerId).toBe(members[0]!.id)
  expect(members[0]!.name).toBe('财务主管')
  expect(chat.groupId).toBe(folder.id)
  expect(members.every(bot => bot.groupId === folder.id && bot.financePreset !== undefined && bot.model.kind === 'follow-global')).toBe(true)
  expect(new Set(members.map(bot => bot.avatar.color)).size).toBe(members.length)
  if (template === 'compact-v2' || template === 'standard-v2') {
    expect(snapshot.bots.filter(bot => bot.groupId === folder.id).map(bot => bot.id)).toEqual(chat.memberIds)
    expect(h.ctx.workspaceRegistry.pinnedSessionIds).toContain(chat.rootSessionId)
    expect(members.slice(1).map(bot => bot.name.slice(0, 3)))
      .toEqual(members.slice(1).map((_, index) => `${String(index + 1).padStart(2, '0')} `))
  }
  expect(await h.ctx.katcatsChats.financeBinding(chat.id)).toBeNull()
  expect(result.meta).toMatchObject({ chat_id: chat.id, manager_id: members[0]!.id, member_ids: chat.memberIds })
  expect(teamStateSchema.parse(h.ctx.storageDomain.get('katcats_team')!.global.get()).financeTeams?.[0]?.completed).toBe(true)
  const customRole = '财务主管：增加本公司的预算跟踪职责。'
  await h.ctx.katcatsTeam.updateBot({ id: members[0]!.id, role: customRole })
  await h.close()

  const resumed = await memoryFixture([], h.root, {}, { financeConnectors: true })
  expect(await create(resumed, args)).toMatchObject({ isError: false, meta: { chat_id: chat.id, manager_id: chat.managerId } })
  const saved = await resumed.ctx.katcatsTeam.snapshot()
  if (template === 'compact-v2' || template === 'standard-v2') {
    expect(saved.bots.filter(bot => bot.groupId === folder.id).map(bot => bot.id)).toEqual(chat.memberIds)
    expect(resumed.ctx.workspaceRegistry.pinnedSessionIds).toContain(chat.rootSessionId)
    await resumed.ctx.workspaceRegistry.unpinSession(chat.rootSessionId)
    expect(await create(resumed, args)).toMatchObject({ isError: false })
    expect(resumed.ctx.workspaceRegistry.pinnedSessionIds).not.toContain(chat.rootSessionId)
  }
  expect(saved.bots).toHaveLength(members.length + 1)
  expect(saved.bots.find(bot => bot.id === members[0]!.id)?.role).toBe(customRole)
  expect((await resumed.ctx.katcatsChats.snapshot()).chats).toHaveLength(1)
})

it.each(financeTeamTemplates)('resumes allocated %s member IDs after a private Session failure and restart without duplicating the saved positions', async template => {
  const h = await memoryFixture([], undefined, {}, { financeConnectors: true })
  const agent = await mainAgent(h)
  const original = h.ctx.sessionController.create.bind(h.ctx.sessionController)
  let calls = 0
  const creation = vi.spyOn(h.ctx.sessionController, 'create').mockImplementation(async (...args) => {
    if (++calls === 3) throw new Error('Fixture interrupted third member')
    return original(...args)
  })
  const args = { template, name: 'Recoverable finance' }
  expect(await create(h, args, agent)).toMatchObject({ isError: true })
  creation.mockRestore()
  const state = teamStateSchema.parse(h.ctx.storageDomain.get('katcats_team')!.global.get())
  const allocated = state.financeTeams![0]!.memberIds
  expect(state.bots.filter(bot => bot.kind === 'ordinary')).toHaveLength(2)
  expect(state.pendingBot?.id).toBe(allocated[2])
  expect(state.financeTeams![0]!.completed).toBe(false)
  await h.close()
  const resumed = await memoryFixture([], h.root, {}, { financeConnectors: true })
  expect(await create(resumed, args)).toMatchObject({ isError: false })
  expect((await resumed.ctx.katcatsChats.snapshot()).chats[0]!.memberIds).toEqual(allocated)
  const savedBots = (await resumed.ctx.katcatsTeam.snapshot()).bots
  expect(savedBots).toHaveLength(allocated.length + 1)
  expect(allocated.map(id => savedBots.find(bot => bot.id === id)?.name))
    .toEqual(financeTeamPositions(template).map(position => position.name))
  if (template === 'compact-v2' || template === 'standard-v2') {
    expect(savedBots.filter(bot => bot.kind === 'ordinary').map(bot => bot.id)).toEqual(allocated)
  }
  expect(teamStateSchema.parse(resumed.ctx.storageDomain.get('katcats_team')!.global.get()).financeTeams?.[0]?.completed).toBe(true)
})

it('recovers the new finance group pin after a persistence failure without pinning ordinary groups', async () => {
  const h = await memoryFixture([], undefined, {}, { financeConnectors: true })
  const agent = await mainAgent(h)
  const pin = vi.spyOn(h.ctx.workspaceRegistry, 'pinSession').mockRejectedValue(new Error('Fixture pin persistence failed'))
  const args = { template: 'compact-v2', name: 'Pin recovery' }
  expect(await create(h, args, agent)).toMatchObject({ isError: true })
  const pending = chatsStateSchema.parse(h.ctx.storageDomain.get('katcats_chats_v3')!.global.get()).pendingChat!
  expect(pending.kind).toBe('create')
  expect(pending.pinOnCreate).toBe(true)
  pin.mockRestore()
  await h.close()

  const resumed = await memoryFixture([], h.root, {}, { financeConnectors: true })
  expect(await create(resumed, args)).toMatchObject({ isError: false, meta: { chat_id: pending.chat.id } })
  expect(resumed.ctx.workspaceRegistry.pinnedSessionIds).toContain(pending.chat.rootSessionId)
  expect((await resumed.ctx.katcatsChats.snapshot()).chats).toHaveLength(1)
  const ordinary = await resumed.ctx.katcatsChats.createChat({ name: 'Ordinary', memberIds: [pending.chat.memberIds[0]!] })
  expect(resumed.ctx.workspaceRegistry.pinnedSessionIds).not.toContain(ordinary.chat.rootSessionId)
})

it('reuses concurrent template requests and refuses a different size under the same creation name', async () => {
  const h = await memoryFixture([], undefined, {}, { financeConnectors: true })
  const agent = await mainAgent(h)
  const args = { template: 'compact-v1', name: 'Accounting' }
  const results = await Promise.all([create(h, args, agent), create(h, args, agent)])
  expect(results.every(result => !result.isError)).toBe(true)
  expect((await h.ctx.katcatsTeam.snapshot()).bots).toHaveLength(5)
  expect((await h.ctx.katcatsChats.snapshot()).chats).toHaveLength(1)
  expect(await create(h, { ...args, template: 'standard-v1' }, agent)).toMatchObject({ isError: true })
  expect((await h.ctx.katcatsTeam.snapshot()).bots).toHaveLength(5)
})

it('rejects unsupported input, cancellation and non-main callers before creating a finance roster', async () => {
  const h = await memoryFixture([], undefined, {}, { financeConnectors: true })
  const main = await mainAgent(h)
  const before = await h.ctx.katcatsTeam.snapshot()
  for (const args of [
    { template: 'shared', name: 'No' }, { template: 'compact-v1', name: ' ' },
    { template: 'compact-v1', name: 'No', group_id: 'missing' },
    { template: 'compact-v1', name: 'No', manager_id: 'main' },
  ]) expect(await create(h, args, main)).toMatchObject({ isError: true })
  const controller = new AbortController()
  controller.abort()
  expect(await create(h, { template: 'compact-v1', name: 'Cancelled' }, main, controller.signal)).toMatchObject({ isError: true })
  expect(await h.ctx.katcatsTeam.snapshot()).toEqual(before)
  const member = (await h.ctx.katcatsTeam.createBot({ name: 'Ordinary' })).bot
  const memberAgent = h.ctx.agents.get(member.sessionId)!
  expect(h.ctx.tools.get('create_finance_team', memberAgent)).toBeUndefined()
  const dispose = memberAgent.ctx.tools.register(h.ctx.tools.get('create_finance_team', main)!)
  try { expect(await create(h, { template: 'compact-v1', name: 'Denied' }, memberAgent)).toMatchObject({ isError: true }) }
  finally { dispose() }
  expect((await h.ctx.katcatsTeam.snapshot()).bots).toHaveLength(2)
})

it('does not expose fixed finance creation in a deployment without connectors', async () => {
  const h = await memoryFixture()
  expect(h.ctx.tools.get('create_finance_team', await mainAgent(h))).toBeUndefined()
})

it('logs the fixed roster guidance and actual creation receipt through a normal main Bot turn', async () => {
  const h = await memoryFixture([
    toolCallResponse('fixed-team', 'create_finance_team', { template: 'compact-v2', name: 'Compact finance' }),
    textResponse('The four-member finance team is saved with its finance manager.'),
  ], undefined, {}, { financeConnectors: true })
  const main = await mainAgent(h)
  await memorySend(main, 'Create the compact finance team under the default folders.')
  const events = main.session.snapshotEvents()
  const call = events.find(event => event.type === 'tool/call')
  const result = events.find(event => event.type === 'tool/result')
  expect(call?.type === 'tool/call' && call.data.name).toBe('create_finance_team')
  expect(result?.type === 'tool/result' && result.data.message.isError).not.toBe(true)
  const request = h.adapter.requests[0]!
  const tool = request.tools?.find(item => item.name === 'create_finance_team')
  const positions = financeTeamTemplates.map(template => ({ template, positions: financeTeamPositions(template) }))
  expect({ tool, positions }).toMatchSnapshot()
  expect(events.filter(event => event.type === 'system/message').map(event => JSON.stringify(event.data)).join('\n'))
    .toContain('Bind a group ledger only once')
})
