import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import Commands from '@deepseek-ai/dsh-commands'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import KatcatsChats from '../src/chats.ts'
import { AVATAR_COLORS } from '../src/avatar-palette.ts'
import { mainBotId, ordinaryGroupId, teamStateSchema } from '../src/storage.ts'
import { harness } from './member-fixture.ts'

type Fixture = Awaited<ReturnType<typeof harness>>

function main(h: Fixture): Agent {
  const bot = teamStateSchema.parse(h.ctx.storageDomain.get('katcats_team')!.global.get()).bots.find(bot => bot.id === mainBotId)!
  return h.ctx.agents.get(bot.sessionId)!
}

function run(h: Fixture, name: string, args: unknown, agent = main(h), signal = new AbortController().signal) {
  return h.ctx.tools.execute({ name, arguments: args, agent, signal, callId: ToolCallId('batch-fixture') })
}

async function groups(h: Fixture) {
  await h.ctx.plugin(AttachmentLocal, { dshHome: join(h.root, 'home') })
  await h.ctx.plugin(CredentialsLocal, { path: join(h.root, 'credentials.yaml'), watch: false })
  await h.ctx.plugin(Connection)
  await h.ctx.plugin(Commands)
  await h.ctx.plugin(FileUploads)
  const fiber = h.ctx.plugin(KatcatsChats, { workspaceRoot: join(h.root, 'workspaces'), relayLimit: 16,
    initialHistoryMessages: 20, historyPageSize: 20, historyPageMaxChars: 16000, reviewCandidateMaxBytes: 8388608 })
  await fiber
  await h.ctx.katcatsChats.snapshot()
  return fiber
}

describe('batch creation and immediate group creation', () => {
  it('prepends single and batch tool-created Bots and new group chats without moving reused groups', async () => {
    const h = await harness()
    await groups(h)
    const older = (await h.team.createBot({ name: 'Existing' })).bot
    const custom = (await h.team.createGroup({ name: 'Editorial' })).group
    expect((await run(h, 'create_bot', { name: 'Single', role: 'Draft reports.' })).isError).toBe(false)
    expect((await run(h, 'create_bots', { bots: [
      { name: 'Batch A', role: 'Draft articles.' }, { name: 'Batch B', role: 'Review articles.' },
      { name: 'Grouped', role: 'Edit articles.', group_id: custom.id },
    ] })).isError).toBe(false)
    const roster = await h.team.snapshot()
    expect(roster.bots.map(bot => bot.name)).toEqual(['小兢会计', 'Grouped', 'Batch B', 'Batch A', 'Single', 'Existing'])
    expect(roster.bots.filter(bot => bot.groupId === ordinaryGroupId).map(bot => bot.name))
      .toEqual(['Batch B', 'Batch A', 'Single', 'Existing'])
    expect(roster.bots.find(bot => bot.name === 'Grouped')?.groupId).toBe(custom.id)
    const old = (await h.ctx.katcatsChats.createChat({ name: 'Existing group', memberIds: [older.id] })).chat
    const args = { name: 'New group', member_ids: [older.id] }
    expect((await run(h, 'create_group_chat', args)).isError).toBe(false)
    const newest = (await h.ctx.katcatsChats.snapshot()).chats[0]!
    expect(newest.name).toBe('New group')
    expect((await h.ctx.katcatsChats.snapshot()).chats).toEqual([newest, old])
    expect((await run(h, 'create_group_chat', { name: old.name, member_ids: old.memberIds })).isError).toBe(false)
    expect((await h.ctx.katcatsChats.snapshot()).chats).toEqual([newest, old])
  })

  it('counts only this batch, uses eight distinct presets, and allows custom colors only for overflow', async () => {
    const h = await harness()
    for (const item of AVATAR_COLORS) await h.team.createBot({ name: `Existing ${item.key}`, avatar: { shape: 'round', color: item.color } })
    const before = await h.team.snapshot()
    expect(await run(h, 'create_bot', { name: 'One', role: 'Accountant', avatar: { shape: 'classic', color: '#123456' } }))
      .toMatchObject({ isError: true, error: { info: { code: 'KATCATS_TOOL_INVALID_INPUT' } } })
    expect(await h.team.snapshot()).toEqual(before)
    const bots = Array.from({ length: 9 }, (_, i) => ({ name: `New ${i + 1}`, role: `Responsibility ${i + 1}`,
      avatar: { shape: 'classic', color: i === 8 ? '#123456' : '#ff2849' } }))
    expect((await run(h, 'create_bots', { bots })).isError).toBe(false)
    const created = (await h.team.snapshot()).bots.filter(bot => bot.name.startsWith('New '))
    expect(created).toHaveLength(9)
    expect(created.slice(1).map(bot => bot.avatar.color).sort()).toEqual(AVATAR_COLORS.map(item => item.color).sort())
    expect(created[0]!.avatar.color).toBe('#123456')
    expect((await h.team.snapshot()).bots.filter(bot => !bot.name.startsWith('New '))).toEqual(before.bots)
    expect((await run(h, 'create_bots', { bots: [{ name: 'Next batch', role: 'Next' }] })).meta)
      .toMatchObject({ bots: [{ avatar: { color: '#FF2849' } }] })
  })

  it('validates the whole batch before creating any member', async () => {
    const h = await harness()
    const before = await h.team.snapshot()
    const creations = h.create.mock.calls.length
    for (const bots of [[], [{ name: 'A', role: 'A' }, { name: 'B', role: ' ' }],
      [{ name: 'A', role: 'A' }, { name: 'B', role: 'B', avatar: { shape: 'classic', color: '#123456' } }],
      [{ name: 'A', role: 'A' }, { name: 'B', role: 'B', group_id: 'missing' }]]) {
      expect((await run(h, 'create_bots', { bots })).isError).toBe(true)
      expect(await h.team.snapshot()).toEqual(before)
    }
    expect(h.create).toHaveBeenCalledTimes(creations)
  })

  it('stops after a partial failure and lets the roster recover the accepted member', async () => {
    const h = await harness()
    const create = h.create.getMockImplementation()!
    let count = 0
    h.create.mockImplementation(async (request) => {
      if (++count === 2) throw new Error('Synthetic second member interruption')
      return create(request)
    })
    const result = await run(h, 'create_bots', { bots: ['A', 'B', 'C'].map(name => ({ name, role: name })) })
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'KATCATS_TOOL_INCOMPLETE' } } })
    expect(JSON.stringify(result.content)).toContain('Some Bots may already be saved')
    expect(result.meta).toBeUndefined()
    expect((await run(h, 'list_bots', {})).meta).toMatchObject({ bots: [{ is_main: true }, { name: 'B' }, { name: 'A' }] })
    expect((await h.team.snapshot()).bots.some(bot => bot.name === 'C')).toBe(false)
  })

  it('creates a durable sidebar group with the selected manager and reuses concurrent duplicate requests', async () => {
    const h = await harness()
    await groups(h)
    expect((await run(h, 'create_bots', { bots: ['Accountant', 'CFO'].map(name => ({ name, role: name })) })).isError).toBe(false)
    const bots = (await h.team.snapshot()).bots.filter(bot => bot.kind === 'ordinary')
    const args = { name: 'Finance', member_ids: bots.map(bot => bot.id), manager_id: bots[1]!.id }
    const follow = h.ctx.katcatsChats.follow(new AbortController().signal)[Symbol.asyncIterator]()
    await follow.next()
    const results = await Promise.all([run(h, 'create_group_chat', args), run(h, 'create_group_chat', args)])
    expect(results.map(result => result.isError)).toEqual([false, false])
    expect(results[0].meta).toEqual(results[1].meta)
    expect((await follow.next()).value).toMatchObject({ type: 'replace', value: { chats: [{ name: 'Finance' }] } })
    await follow.return?.()
    const saved = await h.ctx.katcatsChats.snapshot()
    expect(saved.chats).toHaveLength(1)
    const chat = saved.chats[0]!
    expect(chat).toMatchObject({ memberIds: args.member_ids, managerId: args.manager_id, relayLimit: 16, run: null })
    expect(chat.memberIds).not.toContain(mainBotId)
    expect(chat.executors.every(executor => bots.every(bot => bot.sessionId !== executor.sessionId))).toBe(true)
    expect(h.adapter.requests).toEqual([])
    await h.close()
    const second = await harness(h.root)
    await groups(second)
    await second.resolveAgent((await second.team.snapshot()).bots.find(bot => bot.id === mainBotId)!.sessionId)
    expect((await second.ctx.katcatsChats.snapshot()).chats).toEqual(saved.chats)
    expect((await run(second, 'list_group_chats', {})).meta).toEqual({ chats: [results[0].meta] })
  })

  it('rejects invalid membership, a borrowed tool and cancelled requests before creating a group', async () => {
    const h = await harness()
    await groups(h)
    const bot = (await h.team.createBot({ name: 'Accountant' })).bot
    for (const args of [{ name: 'Empty', member_ids: [] }, { name: 'Main', member_ids: [mainBotId] },
      { name: 'Duplicate', member_ids: [bot.id, bot.id] }, { name: 'Missing', member_ids: ['missing'] },
      { name: 'Manager', member_ids: [bot.id], manager_id: mainBotId }]) {
      expect(await run(h, 'create_group_chat', args)).toMatchObject({ isError: true, error: { info: { code: 'KATCATS_TOOL_INVALID_INPUT' } } })
    }
    const ordinary = h.ctx.agents.get(bot.sessionId)!
    const dispose = ordinary.ctx.tools.register(h.ctx.tools.get('create_group_chat', main(h))!)
    const args = { name: 'Denied', member_ids: [bot.id] }
    try {
      expect(await run(h, 'create_group_chat', args, ordinary)).toMatchObject({ isError: true, error: { info: { code: 'KATCATS_TOOL_DENIED' } } })
    } finally { dispose() }
    const abort = new AbortController()
    abort.abort()
    expect((await run(h, 'create_group_chat', args, main(h), abort.signal)).isError).toBe(true)
    expect((await h.ctx.katcatsChats.snapshot()).chats).toEqual([])
  })

  it('reports an interrupted group save truthfully and recovers without duplicate creation', async () => {
    const h = await harness()
    await groups(h)
    const bot = (await h.team.createBot({ name: 'Accountant' })).bot
    h.create.mockRejectedValueOnce(new Error('Synthetic group session interruption'))
    const args = { name: 'Recovered', member_ids: [bot.id] }
    const result = await run(h, 'create_group_chat', args)
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'KATCATS_TOOL_INCOMPLETE' } } })
    expect(result.meta).toBeUndefined()
    expect(JSON.stringify(result.content)).toContain('list_group_chats')
    expect((await run(h, 'list_group_chats', {})).meta).toMatchObject({ chats: [{ name: 'Recovered' }] })
    expect((await run(h, 'create_group_chat', args)).isError).toBe(false)
    expect((await h.ctx.katcatsChats.snapshot()).chats).toHaveLength(1)
  })

  it('finishes an accepted group save after cancellation and reports the uncertain outcome', async () => {
    const h = await harness()
    await groups(h)
    const bot = (await h.team.createBot({ name: 'Accountant' })).bot
    const create = h.create.getMockImplementation()!
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    h.create.mockImplementationOnce(async (request) => {
      started.resolve(undefined)
      await release.promise
      return create(request)
    })
    const abort = new AbortController()
    const args = { name: 'Accepted', member_ids: [bot.id] }
    const creating = run(h, 'create_group_chat', args, main(h), abort.signal)
    await started.promise
    abort.abort()
    release.resolve(undefined)
    const result = await creating
    expect(result).toMatchObject({ isError: true, error: { info: { code: TOOL_ABORTED } } })
    expect(result.meta).toBeUndefined()
    expect(JSON.stringify(result.content)).toContain('may already have completed')
    expect((await run(h, 'list_group_chats', {})).meta).toMatchObject({ chats: [{ name: 'Accepted' }] })
    expect((await run(h, 'create_group_chat', args)).isError).toBe(false)
    expect((await h.ctx.katcatsChats.snapshot()).chats).toHaveLength(1)
  })
})
