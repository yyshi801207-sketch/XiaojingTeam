import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { TOOL_ABORTED, TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import KatcatsTeam from '../src/index.ts'
import { chatGroupId, mainBotId, ordinaryGroupId, teamStateSchema } from '../src/storage.ts'
import { harness, send, systemText } from './member-fixture.ts'

type Fixture = Awaited<ReturnType<typeof harness>>

function mainAgent(h: Fixture): Agent {
  const bot = teamStateSchema.parse(h.ctx.storageDomain.get('katcats_team')!.global.get()).bots.find(bot => bot.id === mainBotId)!
  return h.ctx.agents.get(bot.sessionId)!
}

async function run(
  h: Fixture, agent: Agent, name: string, args: unknown, signal = new AbortController().signal,
): Promise<ToolExecutionResult> {
  return h.ctx.tools.execute({ name, arguments: args, agent, signal, callId: ToolCallId('fixture-call') })
}

function text(result: ToolExecutionResult): string {
  return result.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
}

describe('Katcats Agent-scoped member tools', () => {
  it('exposes management only to the main Agent and refuses a borrowed definition in another scope', async () => {
    const h = await harness()
    const main = mainAgent(h)
    const writer = (await h.team.createBot({ name: 'Writer' })).bot
    const ordinary = h.ctx.agents.get(writer.sessionId)!
    expect(h.ctx.tools.schemas(main).map(tool => tool.name).sort()).toEqual(['create_bot', 'list_bots', 'set_bot_appearance', 'set_own_role'])
    expect(h.ctx.tools.schemas(ordinary).map(tool => tool.name)).toEqual(['set_own_role'])
    expect(h.ctx.tools.schemas()).toEqual([])
    for (const name of ['create_bot', 'list_bots', 'set_bot_appearance']) {
      expect(await run(h, ordinary, name, { name: 'Denied', role: 'Denied' }))
        .toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })
    }
    const borrowed = h.ctx.tools.get('create_bot', main)!
    const dispose = ordinary.ctx.tools.register(borrowed)
    try {
      expect(await run(h, ordinary, 'create_bot', { name: 'Denied', role: 'Denied' }))
        .toMatchObject({ isError: true, error: { info: { code: 'KATCATS_TOOL_DENIED' } } })
    } finally {
      dispose()
    }
    expect((await h.team.snapshot()).bots).toHaveLength(2)
  })

  it('persists the requested initial role with its private conversation and returns its saved receipt', async () => {
    const h = await harness()
    const group = (await h.team.createGroup({ name: 'Editorial' })).group
    const result = await run(h, mainAgent(h), 'create_bot', { name: ' Writer ', role: ' Write articles. ', group_id: group.id })
    expect(result.isError).toBe(false)
    const bot = (await h.team.snapshot()).bots.find(bot => bot.name === 'Writer')!
    expect(bot).toMatchObject({ role: 'Write articles.', groupId: group.id })
    expect(result.meta).toEqual({ bot_id: bot.id, name: 'Writer', role: 'Write articles.', avatar: bot.avatar })
    expect(text(result)).toBe(`Created Bot Writer (${bot.id}) with saved role:\nWrite articles.\nSaved avatar: classic #FF2849.`)
    await send(h.ctx.agents.get(bot.sessionId)!, 'start')
    expect(systemText(h.adapter.requests.at(-1)!).join('\n')).toContain('Write articles.')
    const list = await run(h, mainAgent(h), 'list_bots', {})
    expect(list.isError).toBe(false)
    expect(list.meta).toMatchObject({
      bots: [{ bot_id: mainBotId, is_main: true }, { bot_id: bot.id, role: bot.role, group_id: group.id }],
      groups: [{ group_id: ordinaryGroupId }, { group_id: group.id }],
    })
    expect(text(list)).not.toContain(chatGroupId)
    expect(h.saveDefault).not.toHaveBeenCalled()
  })

  it('keeps a failed accepted creation with its initial role and lets list recover it once', async () => {
    const h = await harness()
    h.create.mockRejectedValueOnce(new Error('Fixture private creation interrupted'))
    const avatar = { shape: 'round', color: '#2288FF' }
    const result = await run(h, mainAgent(h), 'create_bot', { name: 'Writer', role: 'Draft reports.', avatar })
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'KATCATS_TOOL_INCOMPLETE' } } })
    expect(result.meta).toBeUndefined()
    expect(text(result)).toContain('Call list_bots')
    const domain = h.ctx.storageDomain.get('katcats_team')!
    const pending = teamStateSchema.parse(domain.global.get()).pendingBot!
    expect(pending.role).toBe('Draft reports.')
    expect(pending.avatar).toEqual(avatar)
    expect(teamStateSchema.parse(domain.global.get()).bots).toHaveLength(1)
    const listed = await run(h, mainAgent(h), 'list_bots', {})
    expect(listed.isError).toBe(false)
    expect(listed.meta).toMatchObject({ bots: [expect.anything(), { bot_id: pending.id, avatar }] })
    expect((await h.team.snapshot()).bots.find(bot => bot.id === pending.id)).toEqual(pending)
    expect(teamStateSchema.parse(domain.global.get()).pendingBot).toBeNull()
    expect((await h.team.snapshot()).bots).toHaveLength(2)
  })

  it('matches a pending creation by role as well as name and group without conflating menu creation', async () => {
    const h = await harness()
    const main = mainAgent(h)
    h.create.mockRejectedValueOnce(new Error('Fixture creation interrupted'))
    await run(h, main, 'create_bot', { name: 'Writer', role: 'Write reports.' })
    const pending = teamStateSchema.parse(h.ctx.storageDomain.get('katcats_team')!.global.get()).pendingBot!
    const retry = await run(h, main, 'create_bot', { name: 'Writer', role: 'Write reports.' })
    expect(retry.meta).toMatchObject({ bot_id: pending.id, role: pending.role })
    h.create.mockRejectedValueOnce(new Error('Fixture second creation interrupted'))
    await run(h, main, 'create_bot', { name: 'Analyst', role: 'Analyze reports.' })
    const different = (await h.team.createBot({ name: 'Analyst' })).bot
    expect(different.role).toBe('')
    const bots = (await h.team.snapshot()).bots.filter(bot => bot.name === 'Analyst')
    expect(bots.map(bot => bot.role).sort()).toEqual(['', 'Analyze reports.'])
  })

  it.each([
    ['create_bot', { name: ' ', role: 'Write.' }],
    ['create_bot', { name: 'Writer', role: ' ' }],
    ['create_bot', { name: 'Writer', role: 'Write.', group_id: chatGroupId }],
    ['create_bot', { name: 'Writer', role: 'Write.', target: 'other' }],
    ['set_own_role', { role: ' ' }],
    ['set_own_role', { role: 'Write.', target: mainBotId }],
    ['list_bots', { target: 'other' }],
  ])('rejects invalid %s input without accepting a write', async (name, args) => {
    const h = await harness()
    const before = await h.team.snapshot()
    expect(await run(h, mainAgent(h), name, args))
      .toMatchObject({ isError: true, error: { info: { code: 'KATCATS_TOOL_INVALID_INPUT' } } })
    expect(await h.team.snapshot()).toEqual(before)
  })

  it('changes only the executing member role, logs its new identity, and restores it after cold resume', async () => {
    const first = await harness()
    const writer = (await first.team.createBot({ name: 'Writer' })).bot
    const coder = (await first.team.createBot({ name: 'Coder' })).bot
    const writerAgent = first.ctx.agents.get(writer.sessionId)!
    const result = await run(first, writerAgent, 'set_own_role', { role: 'Edit short reports.' })
    expect(result).toMatchObject({ isError: false, meta: { bot_id: writer.id, name: 'Writer', role: 'Edit short reports.' } })
    await send(writerAgent, 'work')
    expect(systemText(first.adapter.requests.at(-1)!).join('\n')).toContain('Edit short reports.')
    const snapshot = await first.team.snapshot()
    expect(snapshot.bots.find(bot => bot.id === coder.id)).toEqual(coder)
    await first.close()
    const second = await harness(first.root)
    const resolved = await second.resolveAgent(writer.sessionId)
    if ('error' in resolved) throw resolved.error
    await send(resolved.agent, 'after restart')
    expect(systemText(second.adapter.requests.at(-1)!).join('\n')).toContain('Edit short reports.')
    expect(second.ctx.tools.schemas(resolved.agent).map(tool => tool.name)).toEqual(['set_own_role'])
  })

  it('reports a role write failure without a success receipt and leaves both roles unchanged', async () => {
    const h = await harness()
    const before = await h.team.snapshot()
    const domain = h.ctx.storageDomain.get('katcats_team')!
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Fixture storage unavailable'))
    const result = await run(h, mainAgent(h), 'set_own_role', { role: 'Changed.' })
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'KATCATS_TOOL_INCOMPLETE' } } })
    expect(result.meta).toBeUndefined()
    expect(await h.team.snapshot()).toEqual(before)
    expect((await run(h, mainAgent(h), 'set_own_role', { role: 'Changed.' })).isError).toBe(false)
  })

  it('does not accept a pre-cancelled or queued-cancelled role change', async () => {
    const h = await harness()
    const main = mainAgent(h)
    const controller = new AbortController()
    controller.abort()
    const before = await h.team.snapshot()
    expect(await run(h, main, 'set_own_role', { role: 'Denied.' }, controller.signal))
      .toMatchObject({ isError: true, error: { info: { code: TOOL_ABORTED_BEFORE_DISPATCH } } })
    expect(await h.team.snapshot()).toEqual(before)
    const domain = h.ctx.storageDomain.get('katcats_team')!
    const set = domain.global.set.bind(domain.global)
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(domain.global, 'set').mockImplementationOnce(async (value) => {
      started.resolve(undefined)
      await release.promise
      await set(value)
    })
    const group = h.team.createGroup({ name: 'Holding the queue' })
    await started.promise
    const queued = new AbortController()
    const entered = Promise.withResolvers<undefined>()
    const off = h.ctx.on('tools/execute', (_exec, next) => { const result = next(); entered.resolve(undefined); return result })
    const changing = run(h, main, 'set_own_role', { role: 'Queued.' }, queued.signal)
    await entered.promise
    queued.abort()
    release.resolve(undefined)
    await group
    expect((await changing).isError).toBe(true)
    off()
    expect((await h.team.snapshot()).bots).toEqual(before.bots)
  })

  it('finishes accepted creation after cancellation and warns to inspect the durable roster before retrying', async () => {
    const first = await harness()
    const create = first.create.getMockImplementation()!
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    first.create.mockImplementationOnce(async (request) => {
      started.resolve(undefined)
      await release.promise
      return create(request)
    })
    const controller = new AbortController()
    const avatar = { shape: 'point', color: '#10BF7A' }
    const creating = run(first, mainAgent(first), 'create_bot', { name: 'Writer', role: 'Write reports.', avatar }, controller.signal)
    await started.promise
    controller.abort()
    release.resolve(undefined)
    const result = await creating
    expect(result).toMatchObject({ isError: true, error: { info: { code: TOOL_ABORTED } } })
    expect(text(result)).toContain('may already have completed; call list_bots')
    const before = await first.team.snapshot()
    expect(before.bots).toHaveLength(2)
    expect(before.bots[1]).toMatchObject({ name: 'Writer', role: 'Write reports.', avatar })
    await first.close()
    const second = await harness(first.root)
    expect(await second.team.snapshot()).toEqual(before)
  })

  it('retains a completed role change when cancellation supersedes its acknowledgement', async () => {
    const h = await harness()
    const controller = new AbortController()
    const domain = h.ctx.storageDomain.get('katcats_team')!
    const set = domain.global.set.bind(domain.global)
    vi.spyOn(domain.global, 'set').mockImplementationOnce(async (value) => { await set(value); controller.abort() })
    const result = await run(h, mainAgent(h), 'set_own_role', { role: 'Saved.' }, controller.signal)
    expect(result).toMatchObject({ isError: true, error: { info: { code: TOOL_ABORTED } } })
    expect(text(result)).toContain('may already have changed')
    expect((await h.team.snapshot()).bots[0]?.role).toBe('Saved.')
  })

  it('removes registrations when the Team owner unloads while Agents remain live and restores them on reload', async () => {
    const h = await harness()
    const main = mainAgent(h)
    const before = await h.team.snapshot()
    await h.teamFiber.dispose()
    expect(h.ctx.agents.get(main.id)).toBe(main)
    expect(h.ctx.tools.schemas(main)).toEqual([])
    await h.ctx.plugin(KatcatsTeam, { workspaceRoot: h.root + '/workspaces', mainName: 'Katcats', mainRole: '团队主管', ordinaryGroupName: '普通 Bot', chatGroupName: '群聊' })
    expect(await h.ctx.katcatsTeam.snapshot()).toEqual(before)
    expect(h.ctx.tools.schemas(main).map(tool => tool.name).sort()).toEqual(['create_bot', 'list_bots', 'set_bot_appearance', 'set_own_role'])
  })

  it('provides replayable generic presentation and recorded prompt guidance without speculative success', async () => {
    const h = await harness()
    const main = mainAgent(h)
    const definition = h.ctx.tools.get('set_own_role', main)!
    const args = { role: 'Coordinate the team.' }
    const result = await run(h, main, 'set_own_role', args)
    await send(main, 'Start coordinating.')
    expect({ call: definition.presentCall?.(args), result: definition.presentResult?.(args, result),
      persisted: result.meta, system: systemText(h.adapter.requests.at(-1)!) }).toMatchInlineSnapshot(`
        {
          "call": {
            "card": "generic",
            "kind": "edit",
            "title": "Save your role",
          },
          "persisted": {
            "avatar": {
              "color": "#FF2849",
              "shape": "classic",
            },
            "bot_id": "main",
            "name": "小兢会计",
            "role": "Coordinate the team.",
          },
          "result": {
            "card": "generic",
            "content": [
              {
                "text": "Saved your role for 小兢会计 (main):
        Coordinate the team.
        Saved avatar: classic #FF2849.",
                "type": "text",
              },
            ],
            "title": "Role saved",
          },
          "system": [
            "You are an AI agent powered by DeepSeek Harness.

        You are 小兢会计, a member of the Katcats.AI team.
        Coordinate the team.
        Your product scope is creating and configuring Bots. You do not automatically join or manage group chats. Do not claim to have created a group or delegated group work. These limits take precedence over a saved role that describes broader coordination.

        Use set_own_role only when the user explicitly asks to establish or change your ongoing identity or responsibilities. Do not change your saved role for a temporary task. Claim a role was saved only after the tool succeeds.
        When the user explicitly requests a new persistent team member, use create_bot with its name and lasting role. Pass any requested robot style and color through avatar; writing a color in role does not change the avatar. Omit avatar only to use the default red ledger robot. Use set_bot_appearance to change an existing member's requested avatar without recreating it. Use list_bots to inspect existing members, saved avatars, and group IDs; the default group is 未分组. Claim creation or an appearance change only after the tool returns the saved avatar. If a change fails or is cancelled, first use list_bots to check whether it completed; do not automatically retry it.",
          ],
        }
      `)
    expect(definition.presentCall?.({ obsolete: true })).toBeUndefined()
  })
})
