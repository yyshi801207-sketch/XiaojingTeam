import { rm, readFile, writeFile, symlink, unlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { chatGroupId, mainBotId, ordinaryGroupId, teamStateSchema } from '../src/storage.ts'
import { freshRoot, harness, send, systemText } from './member-fixture.ts'

describe('Katcats persistent members', () => {
  it('creates one fixed main member and retains both empty system groups across reopen', async () => {
    const first = await harness()
    const before = await first.team.snapshot()
    expect(before.bots).toHaveLength(1)
    expect(before.bots[0]).toMatchObject({ id: mainBotId, kind: 'main', groupId: null, name: '小兢会计' })
    expect(before.groups).toEqual([
      { id: ordinaryGroupId, name: '普通 Bot', kind: 'bots', system: true },
      { id: chatGroupId, name: '群聊', kind: 'chats', system: true },
    ])
    await first.close()
    const second = await harness(first.root)
    expect(await second.team.snapshot()).toEqual(before)
    expect(second.create).not.toHaveBeenCalled()
  })

  it('creates a general Bot with an independent id, private Session, and assigned directory', async () => {
    const h = await harness()
    const created = await h.team.createBot({ name: '  Writer  ', avatar: { shape: 'round', color: '#12BB77' } })
    expect(created.bot).toMatchObject({ name: 'Writer', kind: 'ordinary', role: '', groupId: ordinaryGroupId, model: { kind: 'follow-global' } })
    expect(created.bot.id).not.toBe(created.bot.sessionId)
    expect(created.bot.workDir).toBe(join(h.root, 'workspaces', 'bots', created.bot.id))
    const privateAgent = h.ctx.agents.get(created.bot.sessionId)!
    expect(privateAgent.session.header.cwd).toBe(created.bot.workDir)
    const main = created.snapshot.bots.find(bot => bot.id === mainBotId)!
    expect(privateAgent.id).not.toBe(main.sessionId)
    const workspace = await h.ctx.workspaceRegistry.resolveByPath(created.bot.workDir)
    expect(workspace?.sessionIds).toEqual([created.bot.sessionId])
    expect(h.create).toHaveBeenLastCalledWith({ sessionId: created.bot.sessionId, workspaceId: workspace?.id })
  })

  it('places new Bots before older members, retains explicit groups, and preserves the order after reopening', async () => {
    const first = await harness()
    const group = (await first.team.createGroup({ name: 'Editorial' })).group
    const older = (await first.team.createBot({ name: 'Older' })).bot
    const grouped = (await first.team.createBot({ name: 'Grouped', groupId: group.id })).bot
    const created = await first.team.createBot({ name: 'Newest' })
    expect(created.bot.groupId).toBe(ordinaryGroupId)
    expect(created.snapshot.bots.map(bot => bot.id)).toEqual([mainBotId, created.bot.id, grouped.id, older.id])
    expect(created.snapshot.bots.filter(bot => bot.groupId === ordinaryGroupId).map(bot => bot.id)).toEqual([created.bot.id, older.id])
    expect(created.snapshot.bots.find(bot => bot.id === grouped.id)).toEqual(grouped)
    await first.close()
    const reopened = await harness(first.root)
    expect(await reopened.team.snapshot()).toEqual(created.snapshot)
  })

  it('logs member role changes in normal private requests without changing another member', async () => {
    const h = await harness()
    const writer = (await h.team.createBot({ name: 'Writer' })).bot
    const coder = (await h.team.createBot({ name: 'Coder' })).bot
    const writerAgent = h.ctx.agents.get(writer.sessionId)!
    await send(writerAgent, 'first')
    expect(systemText(h.adapter.requests.at(-1)!)).toMatchInlineSnapshot(`
      [
        "You are an AI agent powered by DeepSeek Harness.

      You are Writer, a member of 瑞华云财务共享团队.
      You are a general assistant. Work with the user to establish your role.
      When introducing yourself, use the exact team name 瑞华云财务共享团队, even if earlier conversation mentions an old product name.

      Use set_own_role only when the user explicitly asks to establish or change your ongoing identity or responsibilities. Do not change your saved role for a temporary task. Claim a role was saved only after the tool succeeds.",
      ]
    `)
    await h.team.updateBot({ id: writer.id, role: 'Write technical articles. Preserve literal {{variables}}.' })
    await send(writerAgent, 'second')
    const request = h.adapter.requests.at(-1)!
    expect(systemText(request).at(-1)).toContain('You are Writer, a member of 瑞华云财务共享团队.\nWrite technical articles. Preserve literal {{variables}}.')
    expect(systemText(request).join('\n')).toContain('use the exact team name 瑞华云财务共享团队')
    expect(systemText(request).join('\n')).not.toContain('瑞华云财务共享团队团队')
    expect(systemText(request).join('\n')).not.toContain('Katcat.AI, the personal assistant')
    await send(h.ctx.agents.get(coder.sessionId)!, 'third')
    expect(systemText(h.adapter.requests.at(-1)!).at(-1)).toContain('You are Coder, a member of 瑞华云财务共享团队.\nYou are a general assistant. Work with the user to establish your role.')
    expect(systemText(h.adapter.requests.at(-1)!).join('\n')).not.toContain('Write technical articles')
  })

  it('retains the deployment persona for conversations outside the member directory', async () => {
    const h = await harness()
    const handle = await h.ctx.agents.create({ sessionId: SessionId('outside-team'), agentOptions: { provider: 'fixture', model: 'fixture-model' } })
    try {
      await send(handle.agent, 'ordinary conversation')
      expect(systemText(h.adapter.requests.at(-1)!).join('\n')).toContain('Katcat.AI, the personal assistant')
      expect(systemText(h.adapter.requests.at(-1)!).join('\n')).not.toContain('瑞华云财务共享团队')
    } finally {
      await handle.dispose()
    }
  })

  it('restores the edited role when the private Session is resumed after restart', async () => {
    const first = await harness()
    const bot = (await first.team.createBot({ name: 'Writer' })).bot
    await first.team.updateBot({ id: bot.id, role: 'Write short reports.' })
    await send(first.ctx.agents.get(bot.sessionId)!, 'before restart')
    await first.close()
    const second = await harness(first.root)
    const resumed = await second.resolveAgent(bot.sessionId)
    if ('error' in resumed) throw resumed.error
    await send(resumed.agent, 'after restart')
    expect(systemText(second.adapter.requests.at(-1)!).at(-1)).toContain('Write short reports.')
    const userTexts = second.adapter.requests.at(-1)!.messages.filter(message => message.role === 'user')
      .flatMap(message => message.content.filter(part => part.type === 'text').map(part => part.text))
    expect(userTexts).toEqual(expect.arrayContaining(['before restart', 'after restart']))
  })

  it('renames the member and its durable private Session title together', async () => {
    const h = await harness()
    const before = (await h.team.createBot({ name: 'Writer' })).bot
    const changed = (await h.team.updateBot({ id: before.id, name: 'Editor', role: 'Review drafts.' })).bot
    const agent = h.ctx.agents.get(changed.sessionId)!
    expect(changed).toMatchObject({ name: 'Editor', role: 'Review drafts.', sessionId: before.sessionId })
    expect(h.ctx.sessionTitle.get(agent.session)?.title).toBe('Editor')
    expect(h.ctx.sessionProjections.stateOf(agent.session, 'title')).toBe('Editor')
    expect(teamStateSchema.parse(h.ctx.storageDomain.get('katcats_team')!.global.get()).pendingRename).toBeNull()
    await send(agent, 'after rename')
    expect(systemText(h.adapter.requests.at(-1)!).at(-1)).toContain('You are Editor, a member of 瑞华云财务共享团队.')
  })

  it('retains a recoverable rename intent when updating the private title fails', async () => {
    const h = await harness()
    const bot = (await h.team.createBot({ name: 'Writer' })).bot
    h.rename.mockRejectedValueOnce(new Error('Fixture title write failed'))
    await expect(h.team.updateBot({ id: bot.id, name: 'Editor' })).rejects.toThrow('Fixture title write failed')
    const stored = teamStateSchema.parse(h.ctx.storageDomain.get('katcats_team')!.global.get())
    expect(stored.bots.find(item => item.id === bot.id)?.name).toBe('Writer')
    expect(stored.pendingRename?.name).toBe('Editor')
    expect(h.ctx.sessionTitle.get(h.ctx.agents.get(bot.sessionId)!.session)?.title).toBe('Writer')
    const retried = await h.team.updateBot({ id: bot.id, name: 'Editor' })
    expect(retried.bot.name).toBe('Editor')
    expect(retried.bot.sessionId).toBe(bot.sessionId)
    expect(h.ctx.sessionTitle.get(h.ctx.agents.get(bot.sessionId)!.session)?.title).toBe('Editor')
  })

  it('restores the old title after a final directory write fails and recovers on the next read', async () => {
    const h = await harness()
    const bot = (await h.team.createBot({ name: 'Writer' })).bot
    const domain = h.ctx.storageDomain.get('katcats_team')!
    const set = domain.global.set.bind(domain.global)
    let writes = 0
    vi.spyOn(domain.global, 'set').mockImplementation(async (value) => {
      writes += 1
      if (writes === 2) throw new Error('Fixture rename publication failed')
      await set(value)
    })
    await expect(h.team.updateBot({ id: bot.id, name: 'Editor' })).rejects.toThrow('Fixture rename publication failed')
    expect(teamStateSchema.parse(domain.global.get()).bots.find(item => item.id === bot.id)?.name).toBe('Writer')
    expect(h.ctx.sessionTitle.get(h.ctx.agents.get(bot.sessionId)!.session)?.title).toBe('Writer')
    const recovered = await h.team.snapshot()
    expect(recovered.bots.find(item => item.id === bot.id)?.name).toBe('Editor')
    expect(h.ctx.sessionTitle.get(h.ctx.agents.get(bot.sessionId)!.session)?.title).toBe('Editor')
    expect(teamStateSchema.parse(domain.global.get()).pendingRename).toBeNull()
  })

  it('recovers an interrupted rename after reopening the persistent directory', async () => {
    const first = await harness()
    const bot = (await first.team.createBot({ name: 'Writer' })).bot
    first.rename.mockRejectedValueOnce(new Error('Fixture title update interrupted'))
    await expect(first.team.updateBot({ id: bot.id, name: 'Editor' })).rejects.toThrow('Fixture title update interrupted')
    await first.close()
    const second = await harness(first.root)
    expect((await second.team.snapshot()).bots.find(item => item.id === bot.id)?.name).toBe('Editor')
    expect(second.ctx.sessionTitle.get(second.ctx.agents.get(bot.sessionId)!.session)?.title).toBe('Editor')
    expect(second.create).not.toHaveBeenCalled()
  })

  it('reports an uncertain title restoration and keeps its intent for restart recovery', async () => {
    const first = await harness()
    const bot = (await first.team.createBot({ name: 'Writer' })).bot
    first.rename.mockImplementationOnce(async (request) => {
      first.ctx.sessionTitle.rename(first.ctx.agents.get(request.sessionId)!.session, request.title)
      throw new Error('Fixture title acknowledgement interrupted')
    }).mockRejectedValueOnce(new Error('Fixture title restoration failed'))
    await expect(first.team.updateBot({ id: bot.id, name: 'Editor' })).rejects.toMatchObject({ code: 'gateway/internal' })
    expect(teamStateSchema.parse(first.ctx.storageDomain.get('katcats_team')!.global.get()).pendingRename?.name).toBe('Editor')
    await first.close()
    const second = await harness(first.root)
    expect((await second.team.snapshot()).bots.find(item => item.id === bot.id)?.name).toBe('Editor')
    expect(second.ctx.sessionTitle.get(second.ctx.agents.get(bot.sessionId)!.session)?.title).toBe('Editor')
  })

  it('organizes members with logical groups and protects system groups and the main member', async () => {
    const h = await harness()
    const group = (await h.team.createGroup({ name: 'Editorial' })).group
    const bot = (await h.team.createBot({ name: 'Writer', groupId: group.id })).bot
    await h.team.updateGroup({ id: group.id, name: 'Content' })
    const moved = (await h.team.updateBot({ id: bot.id, groupId: ordinaryGroupId })).bot
    expect(moved.sessionId).toBe(bot.sessionId)
    expect(moved.workDir).toBe(bot.workDir)
    h.ctx.effect(() => h.team.organization.register({ memberships: async () => [], moveGroup: async () => {} }))
    await h.team.removeGroup({ id: group.id })
    await expect(h.team.updateGroup({ id: ordinaryGroupId, name: 'Changed' })).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(h.team.removeGroup({ id: ordinaryGroupId })).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(h.team.updateBot({ id: mainBotId, groupId: ordinaryGroupId })).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(h.team.createBot({ name: 'Wrong', groupId: chatGroupId })).rejects.toMatchObject({ code: 'gateway/bad-request' })
  })

  it('serializes simultaneous member and group writes without dropping another result', async () => {
    const h = await harness()
    const [first, second] = await Promise.all([h.team.createBot({ name: 'Writer' }), h.team.createBot({ name: 'Coder' })])
    const snapshot = await h.team.snapshot()
    expect(snapshot.bots.map(bot => bot.id)).toEqual(expect.arrayContaining([first.bot.id, second.bot.id]))
    expect(snapshot.bots).toHaveLength(3)
  })

  it('leaves the committed directory unchanged when an atomic group write fails', async () => {
    const h = await harness()
    const before = await h.team.snapshot()
    const domain = h.ctx.storageDomain.get('katcats_team')!
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Fixture disk write failed'))
    await expect(h.team.createGroup({ name: 'Lost' })).rejects.toThrow('Fixture disk write failed')
    expect(await h.team.snapshot()).toEqual(before)
    await h.team.createGroup({ name: 'Retried' })
    expect((await h.team.snapshot()).groups.at(-1)?.name).toBe('Retried')
  })

  it('recovers an interrupted member creation with the same Session identity', async () => {
    const first = await harness()
    first.create.mockRejectedValueOnce(new Error('Fixture provisioning failed'))
    await expect(first.team.createBot({ name: 'Recoverable' })).rejects.toThrow('Fixture provisioning failed')
    const stored = teamStateSchema.parse(first.ctx.storageDomain.get('katcats_team')!.global.get())
    const pending = stored.pendingBot!
    expect(stored.bots).toHaveLength(1)
    await first.close()
    const second = await harness(first.root)
    const recovered = (await second.team.snapshot()).bots.find(bot => bot.id === pending.id)
    expect(recovered).toEqual(pending)
    const workspace = await second.ctx.workspaceRegistry.resolveByPath(pending.workDir)
    expect(workspace?.sessionIds).toEqual([pending.sessionId])
    expect(second.create).toHaveBeenCalledExactlyOnceWith({ sessionId: pending.sessionId, workspaceId: workspace?.id })
  })

  it('reuses a durable private Session after the final member write is interrupted', async () => {
    const first = await harness()
    const domain = first.ctx.storageDomain.get('katcats_team')!
    const set = domain.global.set.bind(domain.global)
    let writes = 0
    vi.spyOn(domain.global, 'set').mockImplementation(async (value) => {
      writes += 1
      if (writes === 2) throw new Error('Fixture publication failed')
      await set(value)
    })
    await expect(first.team.createBot({ name: 'Already stored' })).rejects.toThrow('Fixture publication failed')
    const pending = teamStateSchema.parse(domain.global.get()).pendingBot!
    expect(first.ctx.agents.get(pending.sessionId)).toBeDefined()
    await first.close()
    const second = await harness(first.root)
    expect((await second.team.snapshot()).bots.find(bot => bot.id === pending.id)?.sessionId).toBe(pending.sessionId)
    expect(second.create).not.toHaveBeenCalled()
  })

  it('returns the same pending member when the original creation is retried after publication fails', async () => {
    const h = await harness()
    const domain = h.ctx.storageDomain.get('katcats_team')!
    const set = domain.global.set.bind(domain.global)
    let writes = 0
    vi.spyOn(domain.global, 'set').mockImplementation(async (value) => {
      writes += 1
      if (writes === 2) throw new Error('Fixture creation publication failed')
      await set(value)
    })
    const request = { name: 'Writer', avatar: { shape: 'round', color: '#12BB77' } }
    await expect(h.team.createBot(request)).rejects.toThrow('Fixture creation publication failed')
    const pending = teamStateSchema.parse(domain.global.get()).pendingBot!
    const retried = await h.team.createBot(request)
    expect(retried.bot).toEqual(pending)
    expect(retried.snapshot.bots).toHaveLength(2)
    expect(h.create).toHaveBeenCalledTimes(2)
    expect(teamStateSchema.parse(domain.global.get()).pendingBot).toBeNull()
  })

  it('retries Workspace registration without duplicating a pending member or its directory', async () => {
    const h = await harness()
    const createWorkspace = vi.spyOn(h.ctx.workspaceRegistry, 'create')
      .mockRejectedValueOnce(new Error('Fixture Workspace registration failed'))
    await expect(h.team.createBot({ name: 'Writer' })).rejects.toThrow('Fixture Workspace registration failed')
    const pending = teamStateSchema.parse(h.ctx.storageDomain.get('katcats_team')!.global.get()).pendingBot!
    expect(teamStateSchema.parse(h.ctx.storageDomain.get('katcats_team')!.global.get()).bots).toHaveLength(1)
    expect(h.create).toHaveBeenCalledTimes(1)
    const recovered = await h.team.createBot({ name: 'Writer' })
    expect(recovered.bot).toEqual(pending)
    expect(recovered.snapshot.bots).toHaveLength(2)
    expect(createWorkspace).toHaveBeenCalledTimes(2)
    const workspace = await h.ctx.workspaceRegistry.resolveByPath(pending.workDir)
    expect(workspace?.sessionIds).toEqual([pending.sessionId])
    expect(h.ctx.workspaceRegistry.list()).toHaveLength(2)
  })

  it('reattaches the same private Session when the initial Workspace attachment fails', async () => {
    const h = await harness()
    const createWorkspace = h.ctx.workspaceRegistry.create.bind(h.ctx.workspaceRegistry)
    let failFirstAttachment = true
    vi.spyOn(h.ctx.workspaceRegistry, 'create').mockImplementation(async (path, title) => {
      const workspace = await createWorkspace(path, title)
      if (failFirstAttachment) {
        failFirstAttachment = false
        vi.spyOn(workspace, 'attachSession').mockRejectedValueOnce(new Error('Fixture Workspace attachment failed'))
      }
      return workspace
    })
    await expect(h.team.createBot({ name: 'Writer' })).rejects.toThrow('Fixture Workspace attachment failed')
    const pending = teamStateSchema.parse(h.ctx.storageDomain.get('katcats_team')!.global.get()).pendingBot!
    const agent = h.ctx.agents.get(pending.sessionId)!
    expect(agent.session.header.cwd).toBe(pending.workDir)
    expect(teamStateSchema.parse(h.ctx.storageDomain.get('katcats_team')!.global.get()).bots).toHaveLength(1)
    const recovered = await h.team.createBot({ name: 'Writer' })
    expect(recovered.bot).toEqual(pending)
    expect(h.ctx.agents.get(pending.sessionId)).toBe(agent)
    expect(h.create).toHaveBeenCalledTimes(2)
    expect((await h.ctx.workspaceRegistry.resolveByPath(pending.workDir))?.sessionIds).toEqual([pending.sessionId])
    expect(h.ctx.workspaceRegistry.list()).toHaveLength(2)
  })

  it('registers an existing unassigned member without changing its identity, directory, or history', async () => {
    const first = await harness()
    const bot = (await first.team.createBot({ name: 'Existing' })).bot
    await send(first.ctx.agents.get(bot.sessionId)!, 'preserve this conversation')
    const before = await first.team.snapshot()
    const workspace = await first.ctx.workspaceRegistry.resolveByPath(bot.workDir)
    if (workspace === undefined) throw new Error('Expected the fixture member Workspace')
    await first.ctx.workspaceRegistry.delete(workspace.id)
    expect(await first.ctx.workspaceRegistry.resolveByPath(bot.workDir)).toBeUndefined()
    await first.close()

    const second = await harness(first.root)
    expect(await second.team.snapshot()).toEqual(before)
    expect(second.create).not.toHaveBeenCalled()
    expect(second.ctx.agents.list()).toEqual([])
    const restoredWorkspace = await second.ctx.workspaceRegistry.resolveByPath(bot.workDir)
    expect(restoredWorkspace?.sessionIds).toEqual([bot.sessionId])
    const stored = await second.ctx.sessionPersistence.stat(bot.sessionId)
    expect(stored?.header.cwd).toBe(bot.workDir)
    const resolved = await second.resolveAgent(bot.sessionId)
    if ('error' in resolved) throw resolved.error
    await send(resolved.agent, 'after workspace repair')
    const text = second.adapter.requests.at(-1)!.messages.filter(message => message.role === 'user')
      .flatMap(message => message.content.filter(part => part.type === 'text').map(part => part.text))
    expect(text).toEqual(['preserve this conversation', 'after workspace repair'])
  })

  it('recovers an unfinished creation before removing its logical group', async () => {
    const h = await harness()
    h.ctx.effect(() => h.team.organization.register({ memberships: async () => [], moveGroup: async () => {} }))
    const group = (await h.team.createGroup({ name: 'Editorial' })).group
    h.create.mockRejectedValueOnce(new Error('Fixture creation paused'))
    await expect(h.team.createBot({ name: 'Writer', groupId: group.id })).rejects.toThrow('Fixture creation paused')
    const removed = await h.team.removeGroup({ id: group.id })
    expect(removed.groups.some(item => item.id === group.id)).toBe(false)
    expect(removed.bots.find(bot => bot.name === 'Writer')?.groupId).toBe(ordinaryGroupId)
  })

  it('rejects a redirected member directory without touching its target', async () => {
    const first = await harness()
    first.create.mockRejectedValueOnce(new Error('Fixture provisioning paused'))
    await expect(first.team.createBot({ name: 'Redirected' })).rejects.toThrow('Fixture provisioning paused')
    const pending = teamStateSchema.parse(first.ctx.storageDomain.get('katcats_team')!.global.get()).pendingBot!
    expect(pending.workDir).toBe(join(first.root, 'workspaces', 'bots', pending.id))
    await first.close()
    await rm(pending.workDir, { recursive: true })
    const target = await freshRoot()
    await symlink(target, pending.workDir, 'junction')
    try {
      await expect(harness(first.root)).rejects.toMatchObject({ code: 'gateway/bad-request' })
      expect(await readdir(target)).toEqual([])
    } finally {
      await unlink(pending.workDir)
    }
  })

  it('publishes one opening snapshot and later replacements, then releases a cancelled follower', async () => {
    const h = await harness()
    const abort = new AbortController()
    const stream = h.team.follow(abort.signal)[Symbol.asyncIterator]()
    const opening = await stream.next()
    if (opening.done) throw new Error('Expected the opening team snapshot')
    expect(opening.value.type).toBe('snapshot')
    const changed = stream.next()
    await h.team.createGroup({ name: 'Live' })
    const next = await changed
    if (next.done) throw new Error('Expected a replacement team snapshot')
    expect(next.value.type).toBe('replace')
    expect(next.value.value.groups.at(-1)?.name).toBe('Live')
    const ended = stream.next()
    abort.abort()
    expect(await ended).toEqual({ done: true, value: undefined })
  })

  it('creates general members without model credentials, catalog reads, or model selection', async () => {
    const h = await harness()
    const catalog = vi.spyOn(h.ctx.llm, 'listModels').mockRejectedValue(new Error('No configured model'))
    const bot = (await h.team.createBot({ name: 'Unconfigured' })).bot
    expect(bot.model).toEqual({ kind: 'follow-global' })
    expect((await h.team.snapshot()).modelCapabilities).toEqual({ override: true, followGlobal: true })
    expect(catalog).not.toHaveBeenCalled()
    expect(h.selectModel).not.toHaveBeenCalled()
    expect(h.saveDefault).not.toHaveBeenCalled()
    expect(h.adapter.requests).toHaveLength(0)
  })

  it('records a normalized fixed model and applies it to only the next private request', async () => {
    const h = await harness()
    const writer = (await h.team.createBot({ name: 'Writer' })).bot
    const coder = (await h.team.createBot({ name: 'Coder' })).bot
    const writerAgent = h.ctx.agents.get(writer.sessionId)!
    await send(writerAgent, 'before')
    const result = await h.team.updateBot({ id: writer.id, model: { kind: 'override', provider: 'fixture', model: 'specialist-model' } })
    expect(result.bot.model).toEqual({ kind: 'override', provider: 'fixture', model: 'specialist-model', reasoningEffort: 'high' })
    expect(h.selectModel).toHaveBeenCalledExactlyOnceWith({ sessionId: writer.sessionId, provider: 'fixture', model: 'specialist-model', scope: 'session' })
    expect(h.ctx.sessionProjections.snapshot(writerAgent.session).values.modelSelection?.next)
      .toEqual({ provider: 'fixture', model: 'specialist-model', reasoningEffort: 'high' })
    await send(writerAgent, 'after')
    const request = h.adapter.requests.at(-1)!
    expect({ provider: request.provider, model: request.model, reasoningEffort: request.reasoningEffort,
      system: systemText(request), user: request.messages.filter(message => message.role === 'user')
        .flatMap(message => message.content.filter(part => part.type === 'text').map(part => part.text)) })
      .toMatchInlineSnapshot(`
        {
          "model": "specialist-model",
          "provider": "fixture",
          "reasoningEffort": "high",
          "system": [
            "You are an AI agent powered by DeepSeek Harness.

        You are Writer, a member of 瑞华云财务共享团队.
        You are a general assistant. Work with the user to establish your role.
        When introducing yourself, use the exact team name 瑞华云财务共享团队, even if earlier conversation mentions an old product name.

        Use set_own_role only when the user explicitly asks to establish or change your ongoing identity or responsibilities. Do not change your saved role for a temporary task. Claim a role was saved only after the tool succeeds.",
          ],
          "user": [
            "before",
            "after",
            "[model changed: assistant turns above this point were generated by fixture-model; the session continues with specialist-model]",
          ],
        }
      `)
    await send(h.ctx.agents.get(coder.sessionId)!, 'separate')
    expect(h.adapter.requests.at(-1)).toMatchObject({ provider: 'fixture', model: 'fixture-model' })
    expect((await h.team.snapshot()).bots.find(bot => bot.id === coder.id)?.model).toEqual({ kind: 'follow-global' })
    expect(h.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'fixture', model: 'fixture-model' })
    expect(h.saveDefault).not.toHaveBeenCalled()
  })

  it('rejects unavailable models and unsupported efforts without changing the private Session', async () => {
    const h = await harness()
    const before = await h.team.snapshot()
    const main = before.bots[0]!
    const agent = h.ctx.agents.get(main.sessionId)!
    const events = [...agent.session.snapshotEvents()]
    for (const model of [
      { kind: 'override' as const, provider: 'other', model: 'other' },
      { kind: 'override' as const, provider: 'fixture', model: 'specialist-model', reasoningEffort: 'unsupported' },
    ]) {
      await expect(h.team.updateBot({ id: mainBotId, name: 'Rejected', model }))
        .rejects.toMatchObject({ code: 'session/model-unavailable' })
    }
    const after = await h.team.snapshot()
    expect(after.bots).toEqual(before.bots)
    expect(agent.session.snapshotEvents()).toEqual(events)
    expect(teamStateSchema.parse(h.ctx.storageDomain.get('katcats_team')!.global.get()).pendingRename).toBeNull()
    expect(h.saveDefault).not.toHaveBeenCalled()
  })

  it('switches a fixed member back to the current base without persisting that base as an override', async () => {
    const h = await harness()
    const bot = (await h.team.createBot({ name: 'Writer' })).bot
    await h.team.updateBot({ id: bot.id, model: { kind: 'override', provider: 'fixture', model: 'specialist-model' } })
    const result = await h.team.updateBot({ id: bot.id, model: { kind: 'follow-global' } })
    expect(result.bot.model).toEqual({ kind: 'follow-global' })
    expect(h.selectModel).toHaveBeenLastCalledWith({ sessionId: bot.sessionId, provider: 'fixture', model: 'fixture-model', scope: 'session' })
    expect(h.team.modelSelection(bot.id)).toEqual({ provider: 'fixture', model: 'fixture-model' })
    expect(h.saveDefault).not.toHaveBeenCalled()
    vi.spyOn(h.ctx.agentDefaultModel, 'currentSelection').mockReturnValue({ provider: 'fixture', model: 'specialist-model' })
    expect(h.team.modelSelection(bot.id)).toEqual({ provider: 'fixture', model: 'specialist-model' })
    expect((await h.team.snapshot()).bots.find(member => member.id === bot.id)?.model).toEqual({ kind: 'follow-global' })
  })

  it('preserves a following-policy intent after model acceptance and a failed final publication', async () => {
    const h = await harness()
    await h.team.updateBot({ id: mainBotId, model: { kind: 'override', provider: 'fixture', model: 'specialist-model' } })
    const domain = h.ctx.storageDomain.get('katcats_team')!
    const set = domain.global.set.bind(domain.global)
    let writes = 0
    const publication = vi.spyOn(domain.global, 'set').mockImplementation(async (value) => {
      if (++writes === 2) throw new Error('Fixture following publication failed')
      await set(value)
    })
    await expect(h.team.updateBot({ id: mainBotId, name: 'Recovered', model: { kind: 'follow-global' } }))
      .rejects.toMatchObject({ code: 'gateway/internal' })
    expect(teamStateSchema.parse(domain.global.get()).pendingRename).toMatchObject({ name: 'Recovered', model: { kind: 'follow-global' } })
    expect(h.team.modelSelection(mainBotId)).toMatchObject({ model: 'specialist-model' })
    publication.mockRestore()
    expect((await h.team.snapshot()).bots[0]).toMatchObject({ name: 'Recovered', model: { kind: 'follow-global' } })
    expect(teamStateSchema.parse(domain.global.get()).pendingRename).toBeNull()
    expect(h.team.modelSelection(mainBotId)).toMatchObject({ model: 'fixture-model' })
    expect(h.saveDefault).not.toHaveBeenCalled()
  })

  it('refuses an unavailable base without discarding the fixed model or retaining a rejected intent', async () => {
    const h = await harness()
    const fixed = await h.team.updateBot({ id: mainBotId, model: { kind: 'override', provider: 'fixture', model: 'specialist-model' } })
    vi.spyOn(h.ctx.agentDefaultModel, 'currentSelection').mockReturnValue({ provider: 'missing', model: 'missing' })
    await expect(h.team.updateBot({ id: mainBotId, model: { kind: 'follow-global' } }))
      .rejects.toMatchObject({ code: 'session/model-unavailable' })
    expect((await h.team.snapshot()).bots).toEqual(fixed.snapshot.bots)
    expect(teamStateSchema.parse(h.ctx.storageDomain.get('katcats_team')!.global.get()).pendingRename).toBeNull()
    expect(h.team.modelSelection(mainBotId)).toMatchObject({ model: 'specialist-model' })
  })

  it('does not switch a model when saving its setting intent fails', async () => {
    const h = await harness()
    const before = await h.team.snapshot()
    const domain = h.ctx.storageDomain.get('katcats_team')!
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Fixture setting intent write failed'))
    await expect(h.team.updateBot({ id: mainBotId, model: { kind: 'override', provider: 'fixture', model: 'specialist-model' } }))
      .rejects.toThrow('Fixture setting intent write failed')
    expect(h.selectModel).not.toHaveBeenCalled()
    expect(await h.team.snapshot()).toEqual(before)
  })

  it('recovers a compound title/model target after an accepted switch cannot be published', async () => {
    const first = await harness()
    const bot = (await first.team.createBot({ name: 'Writer' })).bot
    const domain = first.ctx.storageDomain.get('katcats_team')!
    const set = domain.global.set.bind(domain.global)
    let writes = 0
    vi.spyOn(domain.global, 'set').mockImplementation(async (value) => {
      writes += 1
      if (writes === 2) throw new Error('Fixture model publication failed')
      await set(value)
    })
    await expect(first.team.updateBot({ id: bot.id, name: 'Specialist', role: 'Review drafts.',
      model: { kind: 'override', provider: 'fixture', model: 'specialist-model' } }))
      .rejects.toMatchObject({ code: 'gateway/internal' })
    const pending = teamStateSchema.parse(domain.global.get())
    expect(pending.bots.find(item => item.id === bot.id)).toEqual(bot)
    expect(pending.pendingRename).toMatchObject({ name: 'Specialist', role: 'Review drafts.', model: { kind: 'override', model: 'specialist-model' } })
    expect(first.ctx.sessionTitle.get(first.ctx.agents.get(bot.sessionId)!.session)?.title).toBe('Specialist')
    await first.close()
    const second = await harness(first.root)
    const recovered = (await second.team.snapshot()).bots.find(item => item.id === bot.id)!
    expect(recovered).toMatchObject({ name: 'Specialist', role: 'Review drafts.', model: { kind: 'override', model: 'specialist-model', reasoningEffort: 'high' } })
    const resolved = await second.resolveAgent(bot.sessionId)
    if ('error' in resolved) throw resolved.error
    await send(resolved.agent, 'after recovery')
    expect(second.adapter.requests.at(-1)).toMatchObject({ model: 'specialist-model', reasoningEffort: 'high' })
    expect(systemText(second.adapter.requests.at(-1)!).at(-1)).toContain('Review drafts.')
    expect(second.saveDefault).not.toHaveBeenCalled()
  })

  it('retains an uncertain model result until a later recovery succeeds', async () => {
    const h = await harness()
    const bot = (await h.team.createBot({ name: 'Writer' })).bot
    const select = h.selectModel.getMockImplementation()!
    h.selectModel.mockImplementationOnce(async (request) => {
      await select(request)
      throw new Error('Fixture model acknowledgement lost')
    })
    await expect(h.team.updateBot({ id: bot.id, model: { kind: 'override', provider: 'fixture', model: 'specialist-model' } }))
      .rejects.toMatchObject({ code: 'gateway/internal' })
    expect(teamStateSchema.parse(h.ctx.storageDomain.get('katcats_team')!.global.get()).pendingRename?.id).toBe(bot.id)
    expect((await h.team.snapshot()).bots.find(item => item.id === bot.id)?.model)
      .toEqual({ kind: 'override', provider: 'fixture', model: 'specialist-model', reasoningEffort: 'high' })
  })

  it('reports Session flush failures and retains the model target until recovery commits', async () => {
    const h = await harness()
    const bot = (await h.team.createBot({ name: 'Writer' })).bot
    const flush = vi.spyOn(h.ctx.sessions, 'flush').mockResolvedValueOnce(false)
    await expect(h.team.updateBot({ id: bot.id, model: { kind: 'override', provider: 'fixture', model: 'specialist-model' } }))
      .rejects.toMatchObject({ code: 'gateway/internal' })
    const domain = h.ctx.storageDomain.get('katcats_team')!
    expect(teamStateSchema.parse(domain.global.get()).bots.find(item => item.id === bot.id)?.model)
      .toEqual({ kind: 'follow-global' })
    flush.mockRejectedValueOnce(new Error('Fixture Session flush still offline'))
    await expect(h.team.snapshot()).rejects.toMatchObject({ code: 'gateway/internal' })
    expect(teamStateSchema.parse(domain.global.get()).pendingRename?.id).toBe(bot.id)
    expect((await h.team.snapshot()).bots.find(item => item.id === bot.id)?.model)
      .toEqual({ kind: 'override', provider: 'fixture', model: 'specialist-model', reasoningEffort: 'high' })
    expect(teamStateSchema.parse(domain.global.get()).pendingRename).toBeNull()
  })

  it('restores the fixed model from a completed private request after restart', async () => {
    const first = await harness()
    const bot = (await first.team.createBot({ name: 'Writer' })).bot
    const selected = await first.team.updateBot({ id: bot.id, model: { kind: 'override', provider: 'fixture', model: 'specialist-model' } })
    await send(first.ctx.agents.get(bot.sessionId)!, 'before restart')
    await first.close()
    const second = await harness(first.root)
    expect((await second.team.snapshot()).bots.find(item => item.id === bot.id)?.model).toEqual(selected.bot.model)
    const resolved = await second.resolveAgent(bot.sessionId)
    if ('error' in resolved) throw resolved.error
    await send(resolved.agent, 'after restart')
    expect(second.adapter.requests.at(-1)).toMatchObject({ provider: 'fixture', model: 'specialist-model', reasoningEffort: 'high' })
    expect(second.selectModel).not.toHaveBeenCalled()
    expect(second.saveDefault).not.toHaveBeenCalled()
  })

  it('rejects invalid names and unapproved avatar shapes before creating a private Session', async () => {
    const h = await harness()
    const calls = h.create.mock.calls.length
    await expect(h.team.createBot({ name: '   ' })).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(h.team.createBot({ name: 'Bad shape', avatar: { shape: 'side-profile', color: '#FF2849' } })).rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(h.create).toHaveBeenCalledTimes(calls)
  })

  it('rejects malformed stored metadata without resetting it', async () => {
    const first = await harness()
    const path = join(first.root, 'storage', 'katcats_team.json')
    await first.close()
    const contents = await readFile(path, 'utf8')
    const document: unknown = JSON.parse(contents)
    if (typeof document !== 'object' || document === null || !('global' in document)) throw new Error('Expected the fixture storage document')
    const global = teamStateSchema.parse(document.global)
    const malformed = JSON.stringify({ ...document, global: { ...global, bots: [] } })
    await writeFile(path, malformed)
    await expect(harness(first.root)).rejects.toMatchObject({ code: 'invalid-record' })
    expect(await readFile(path, 'utf8')).toBe(malformed)
  })

  it('denies every team method to a non-owner caller before revealing or mutating members', async () => {
    const h = await harness()
    const before = await h.team.snapshot()
    const limited = h.ctx.extend({
      invocation: { peer: { principal: { kind: 'limited-fixture' } }, request: { namespace: 'katcatsTeam', method: 'snapshot' } },
    }).katcatsTeam
    const denied = { code: 'remote-access/denied', details: { reason: 'owner-required' } }
    await expect(limited.snapshot()).rejects.toMatchObject(denied)
    await expect(limited.createBot({ name: 'Denied' })).rejects.toMatchObject(denied)
    await expect(limited.updateBot({ id: mainBotId, role: 'Denied' })).rejects.toMatchObject(denied)
    await expect(limited.createGroup({ name: 'Denied' })).rejects.toMatchObject(denied)
    await expect(limited.updateGroup({ id: ordinaryGroupId, name: 'Denied' })).rejects.toMatchObject(denied)
    await expect(limited.removeGroup({ id: ordinaryGroupId })).rejects.toMatchObject(denied)
    await expect(limited.follow(new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toMatchObject(denied)
    expect(await h.team.snapshot()).toEqual(before)
  })
})
