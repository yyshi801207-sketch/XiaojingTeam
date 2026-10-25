/** Avatar tool inputs, durable receipts, and main-Agent mutation ownership. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { TOOL_ABORTED, TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { mainBotId, ordinaryGroupId, teamStateSchema } from '../src/storage.ts'
import { harness } from './member-fixture.ts'

type Fixture = Awaited<ReturnType<typeof harness>>

function mainAgent(h: Fixture): Agent {
  const bot = teamStateSchema.parse(h.ctx.storageDomain.get('katcats_team')!.global.get()).bots.find(bot => bot.id === mainBotId)!
  return h.ctx.agents.get(bot.sessionId)!
}

function run(h: Fixture, agent: Agent, name: string, args: unknown, signal = new AbortController().signal): Promise<ToolExecutionResult> {
  return h.ctx.tools.execute({ name, arguments: args, agent, signal, callId: ToolCallId('appearance-call') })
}

function text(result: ToolExecutionResult): string {
  return result.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
}

describe('member appearance tools', () => {
  it('advertises optional creation avatars and required existing-member avatars to the model', async () => {
    const h = await harness()
    const schemas = h.ctx.tools.schemas(mainAgent(h))
    const avatar = { type: 'object', additionalProperties: false, required: ['shape', 'color'], properties: {
      shape: { type: 'string', enum: ['classic', 'round', 'point', 'fold', 'tilt', 'fluffy', 'slim'],
        description: 'Financial robot styles: classic ledger, round cashier, point tax, fold reporting, tilt audit, fluffy cost, slim supervisor. The style changes appearance only, not the member role.' },
      color: { type: 'string' },
    } }
    expect(schemas.find(tool => tool.name === 'create_bot')).toMatchObject({ parameters: {
      properties: { avatar }, required: ['name', 'role'],
    } })
    expect(schemas.find(tool => tool.name === 'set_bot_appearance')).toMatchObject({ parameters: {
      properties: { bot_id: { type: 'string' }, avatar }, required: ['bot_id', 'avatar'],
    } })
  })

  it('creates four distinct saved avatars and reports them through the real directory', async () => {
    const h = await harness()
    const avatars = [
      { shape: 'classic', color: '#FF2849' }, { shape: 'round', color: '#2288FF' },
      { shape: 'point', color: '#10BF7A' }, { shape: 'fold', color: '#9450FF' },
    ]
    for (const [index, avatar] of avatars.entries()) {
      const name = `Pipeline ${index + 1}`
      const result = await run(h, mainAgent(h), 'create_bot', { name, role: `Stage ${index + 1}`, avatar })
      expect(result.isError).toBe(false)
      const bot = (await h.team.snapshot()).bots.find(bot => bot.name === name)!
      expect(bot.avatar).toEqual(avatar)
      expect(result.meta).toMatchObject({ bot_id: bot.id, name, avatar })
      expect(text(result)).toContain(`Saved avatar: ${avatar.shape} ${avatar.color}.`)
    }
    const snapshot = await h.team.snapshot()
    expect(new Set(snapshot.bots.map(bot => bot.sessionId)).size).toBe(5)
    const listed = await run(h, mainAgent(h), 'list_bots', {})
    expect(listed.meta).toMatchObject({ bots: [expect.anything(), ...avatars.map(avatar => ({ avatar }))] })
    expect(h.saveDefault).not.toHaveBeenCalled()
  })

  it('keeps the old creation default and reports the saved avatar after a role change', async () => {
    const h = await harness()
    const created = await run(h, mainAgent(h), 'create_bot', { name: 'Writer', role: 'Draft articles.' })
    const avatar = { shape: 'classic', color: '#FF2849' }
    expect(created.meta).toMatchObject({ avatar })
    const bot = (await h.team.snapshot()).bots.find(bot => bot.name === 'Writer')!
    const changed = await run(h, h.ctx.agents.get(bot.sessionId)!, 'set_own_role', { role: 'Edit articles.' })
    expect(changed.meta).toMatchObject({ bot_id: bot.id, role: 'Edit articles.', avatar })
    expect(text(changed)).toContain('Saved avatar: classic #FF2849.')
  })

  it('projects only the system default group as 未分组 without renaming stored or custom groups', async () => {
    const h = await harness()
    const custom = (await h.team.createGroup({ name: '普通 Bot' })).group
    const before = await h.team.snapshot()
    expect(before.groups.find(group => group.id === ordinaryGroupId)?.name).toBe('普通 Bot')
    const listed = await run(h, mainAgent(h), 'list_bots', {})
    expect(listed.meta).toMatchObject({ groups: [
      { group_id: ordinaryGroupId, name: '未分组' }, { group_id: custom.id, name: '普通 Bot' },
    ] })
    expect(await h.team.snapshot()).toEqual(before)
  })

  it('updates only the target avatar while preserving its identity, work files and other members', async () => {
    const h = await harness()
    const group = (await h.team.createGroup({ name: 'Editorial' })).group
    const created = (await h.team.createBot({ name: 'Writer', groupId: group.id })).bot
    const bot = (await h.team.updateBot({ id: created.id, role: 'Draft reports.',
      model: { kind: 'override', provider: 'fixture', model: 'specialist-model' } })).bot
    const other = (await h.team.createBot({ name: 'Reviewer' })).bot
    const file = join(bot.workDir, 'retained.txt')
    await writeFile(file, 'Existing work')
    const before = await h.team.snapshot()
    const createCount = h.create.mock.calls.length
    const avatar = { shape: 'fluffy', color: '#0aA1b2' }
    const result = await run(h, mainAgent(h), 'set_bot_appearance', { bot_id: bot.id, avatar })
    expect(result).toMatchObject({ isError: false, meta: { bot_id: bot.id, name: bot.name, role: bot.role, avatar } })
    expect(text(result)).toBe(`Saved Bot Writer (${bot.id}) appearance: fluffy #0aA1b2.`)
    const after = await h.team.snapshot()
    expect(after.bots.find(item => item.id === bot.id)).toEqual({ ...bot, avatar })
    expect(after.bots.filter(item => item.id !== bot.id)).toEqual(before.bots.filter(item => item.id !== bot.id))
    expect(after.bots.find(item => item.id === other.id)).toEqual(other)
    expect(h.create).toHaveBeenCalledTimes(createCount)
    expect(h.selectModel).toHaveBeenCalledTimes(1)
    expect(h.saveDefault).not.toHaveBeenCalled()
    expect(await readFile(file, 'utf8')).toBe('Existing work')
    const definition = h.ctx.tools.get('set_bot_appearance', mainAgent(h))!
    expect({ call: definition.presentCall?.({ bot_id: bot.id, avatar }),
      result: definition.presentResult?.({ bot_id: bot.id, avatar }, result)?.title }).toMatchInlineSnapshot(`
        {
          "call": {
            "card": "generic",
            "kind": "edit",
            "title": "Change Bot avatar",
          },
          "result": "Avatar saved",
        }
      `)
  })

  it('denies ordinary Agents and a borrowed main appearance definition without changing either member', async () => {
    const h = await harness()
    const bot = (await h.team.createBot({ name: 'Writer' })).bot
    const ordinary = h.ctx.agents.get(bot.sessionId)!
    const args = { bot_id: mainBotId, avatar: { shape: 'slim', color: '#2288FF' } }
    const before = await h.team.snapshot()
    expect(await run(h, ordinary, 'set_bot_appearance', args))
      .toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })
    const dispose = ordinary.ctx.tools.register(h.ctx.tools.get('set_bot_appearance', mainAgent(h))!)
    try {
      expect(await run(h, ordinary, 'set_bot_appearance', args))
        .toMatchObject({ isError: true, error: { info: { code: 'KATCATS_TOOL_DENIED' } } })
    } finally { dispose() }
    expect(await h.team.snapshot()).toEqual(before)
  })

  it.each([
    { shape: 'side-profile', color: '#2288FF' }, { shape: 'classic', color: 'blue' },
    { shape: 'classic', color: '#123' }, { shape: 'classic', color: '#12345678' },
    { shape: 'classic', color: '#GGGGGG' }, { shape: 'classic', color: '#2288FF', target: 'other' },
    { shape: 'classic' }, { color: '#2288FF' }, null,
  ])('rejects invalid avatar %j before creating or updating a member', async (avatar) => {
    const h = await harness()
    const before = await h.team.snapshot()
    const count = h.create.mock.calls.length
    for (const [name, args] of [
      ['create_bot', { name: 'Writer', role: 'Draft.', avatar }],
      ['set_bot_appearance', { bot_id: mainBotId, avatar }],
    ] as const) {
      const result = await run(h, mainAgent(h), name, args)
      expect(result.isError).toBe(true)
      expect(result.meta).toBeUndefined()
      expect(await h.team.snapshot()).toEqual(before)
      expect(h.create).toHaveBeenCalledTimes(count)
    }
  })

  it.each([
    { bot_id: ' ', avatar: { shape: 'classic', color: '#2288FF' } },
    { bot_id: 'absent', avatar: { shape: 'classic', color: '#2288FF' } },
    { bot_id: mainBotId, avatar: { shape: 'classic', color: '#2288FF' }, role: 'Unrequested change' },
  ])('rejects invalid appearance target or extra fields %j without accepting a write', async (args) => {
    const h = await harness()
    const before = await h.team.snapshot()
    expect(await run(h, mainAgent(h), 'set_bot_appearance', args))
      .toMatchObject({ isError: true, error: { info: { code: 'KATCATS_TOOL_INVALID_INPUT' } } })
    expect(await h.team.snapshot()).toEqual(before)
  })

  it('reports a failed appearance save without a success receipt and allows an explicit later retry', async () => {
    const h = await harness()
    const before = await h.team.snapshot()
    const domain = h.ctx.storageDomain.get('katcats_team')!
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Fixture avatar storage failure'))
    const args = { bot_id: mainBotId, avatar: { shape: 'tilt', color: '#2288FF' } }
    const result = await run(h, mainAgent(h), 'set_bot_appearance', args)
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'KATCATS_TOOL_INCOMPLETE' } } })
    expect(result.meta).toBeUndefined()
    expect(text(result)).toContain('Call list_bots')
    expect(await h.team.snapshot()).toEqual(before)
    expect((await run(h, mainAgent(h), 'set_bot_appearance', args)).isError).toBe(false)
  })

  it('does not accept a pre-cancelled or queued-cancelled appearance change', async () => {
    const h = await harness()
    const main = mainAgent(h)
    const args = { bot_id: mainBotId, avatar: { shape: 'tilt', color: '#2288FF' } }
    const before = await h.team.snapshot()
    const cancelled = new AbortController()
    cancelled.abort()
    expect(await run(h, main, 'set_bot_appearance', args, cancelled.signal))
      .toMatchObject({ isError: true, error: { info: { code: TOOL_ABORTED_BEFORE_DISPATCH } } })
    const domain = h.ctx.storageDomain.get('katcats_team')!
    const set = domain.global.set.bind(domain.global)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(domain.global, 'set').mockImplementationOnce(async (value) => {
      entered.resolve(undefined)
      await release.promise
      await set(value)
    })
    const holding = h.team.createGroup({ name: 'Holding mutation' })
    await entered.promise
    const controller = new AbortController()
    const dispatched = Promise.withResolvers<undefined>()
    const off = h.ctx.on('tools/execute', (_exec, next) => { const result = next(); dispatched.resolve(undefined); return result })
    const changing = run(h, main, 'set_bot_appearance', args, controller.signal)
    await dispatched.promise
    controller.abort()
    release.resolve(undefined)
    await holding
    expect((await changing).isError).toBe(true)
    off()
    expect((await h.team.snapshot()).bots).toEqual(before.bots)
  })

  it('retains an accepted appearance change after cancellation and returns its actual avatar from list', async () => {
    const h = await harness()
    const controller = new AbortController()
    const domain = h.ctx.storageDomain.get('katcats_team')!
    const set = domain.global.set.bind(domain.global)
    vi.spyOn(domain.global, 'set').mockImplementationOnce(async (value) => { await set(value); controller.abort() })
    const avatar = { shape: 'tilt', color: '#2288FF' }
    const result = await run(h, mainAgent(h), 'set_bot_appearance', { bot_id: mainBotId, avatar }, controller.signal)
    expect(result).toMatchObject({ isError: true, error: { info: { code: TOOL_ABORTED } } })
    expect(text(result)).toContain('may already have changed; call list_bots')
    expect((await h.team.snapshot()).bots[0]?.avatar).toEqual(avatar)
    expect((await run(h, mainAgent(h), 'list_bots', {})).meta).toMatchObject({ bots: [{ bot_id: mainBotId, avatar }] })
  })
})
