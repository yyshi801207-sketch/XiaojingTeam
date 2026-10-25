/** Atomic custom-group deletion and ordering over isolated durable member directories. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { GroupId } from '../src/types.ts'
import { chatGroupId, mainBotId, ordinaryGroupId } from '../src/storage.ts'
import { harness, send } from './member-fixture.ts'

async function setup(providedRoot?: string) {
  const fixture = await harness(providedRoot)
  fixture.ctx.effect(() => fixture.team.organization.register({ memberships: async () => [], moveGroup: async () => {} }))
  return fixture
}

describe('custom-group management', () => {
  it('returns every member to Ordinary Bots in one write while retaining private chats and working files across restart', async () => {
    const first = await setup()
    const group = (await first.team.createGroup({ name: 'Editorial' })).group
    const writer = (await first.team.createBot({ name: 'Writer', groupId: group.id })).bot
    const reviewer = (await first.team.createBot({ name: 'Reviewer', groupId: group.id })).bot
    const outside = (await first.team.createBot({ name: 'Outside' })).bot
    const privateAgent = first.ctx.agents.get(writer.sessionId)!
    await send(privateAgent, 'Keep this private conversation')
    await writeFile(join(writer.workDir, 'draft.md'), 'Retain the working draft.\n')
    const before = await first.team.snapshot()
    const events = privateAgent.session.snapshotEvents()
    const creates = first.create.mock.calls.length
    const renames = first.rename.mock.calls.length
    const write = vi.spyOn(first.ctx.storageDomain.get('katcats_team')!.global, 'set')

    const removed = await first.team.removeGroup({ id: group.id })

    expect(write).toHaveBeenCalledOnce()
    expect(removed.revision).toBe(before.revision + 1)
    expect(removed.groups).toEqual(before.groups.filter(item => item.id !== group.id))
    expect(removed.bots).toEqual(before.bots.map(bot => bot.groupId === group.id ? { ...bot, groupId: ordinaryGroupId } : bot))
    expect(removed.bots.find(bot => bot.id === outside.id)).toEqual(outside)
    expect(removed.bots.find(bot => bot.id === mainBotId)).toEqual(before.bots.find(bot => bot.id === mainBotId))
    expect(removed.bots.find(bot => bot.id === reviewer.id)?.sessionId).toBe(reviewer.sessionId)
    expect(privateAgent.session.snapshotEvents()).toEqual(events)
    expect(first.create).toHaveBeenCalledTimes(creates)
    expect(first.rename).toHaveBeenCalledTimes(renames)
    expect(await readFile(join(writer.workDir, 'draft.md'), 'utf8')).toBe('Retain the working draft.\n')
    await first.close()

    const second = await setup(first.root)
    expect(await second.team.snapshot()).toEqual(removed)
    const resumed = await second.resolveAgent(writer.sessionId)
    if ('error' in resumed) throw resumed.error
    await send(resumed.agent, 'Continue after removing the group')
    const messages = second.adapter.requests.at(-1)!.messages.filter(message => message.role === 'user')
      .flatMap(message => message.content.filter(part => part.type === 'text').map(part => part.text))
    expect(messages).toEqual(['Keep this private conversation', 'Continue after removing the group'])
    expect(await readFile(join(writer.workDir, 'draft.md'), 'utf8')).toBe('Retain the working draft.\n')
  })

  it('keeps a nonempty group and all member bindings unchanged when its single storage write fails', async () => {
    const h = await setup()
    const group = (await h.team.createGroup({ name: 'Editorial' })).group
    const bot = (await h.team.createBot({ name: 'Writer', groupId: group.id })).bot
    const before = await h.team.snapshot()
    const path = join(h.root, 'storage', 'katcats_team.json')
    const document = await readFile(path, 'utf8')
    const write = vi.spyOn(h.ctx.storageDomain.get('katcats_team')!.global, 'set')
      .mockRejectedValueOnce(new Error('Fixture group deletion write failed'))

    await expect(h.team.removeGroup({ id: group.id })).rejects.toThrow('Fixture group deletion write failed')

    expect(write).toHaveBeenCalledOnce()
    expect(await h.team.snapshot()).toEqual(before)
    expect(await readFile(path, 'utf8')).toBe(document)
    const retried = await h.team.removeGroup({ id: group.id })
    expect(retried.bots.find(item => item.id === bot.id)).toEqual({ ...bot, groupId: ordinaryGroupId })
    expect(retried.groups.some(item => item.id === group.id)).toBe(false)
  })

  it('refuses missing and system groups and a non-owner deletion without changing the directory', async () => {
    const h = await setup()
    const group = (await h.team.createGroup({ name: 'Editorial' })).group
    await h.team.createBot({ name: 'Writer', groupId: group.id })
    const before = await h.team.snapshot()
    for (const id of [ordinaryGroupId, chatGroupId, brandString<GroupId>('missing-group'), brandString<GroupId>(mainBotId)]) {
      await expect(h.team.removeGroup({ id })).rejects.toMatchObject({ code: 'gateway/bad-request' })
    }
    const limited = h.ctx.extend({
      invocation: { peer: { principal: { kind: 'limited-fixture' } }, request: { namespace: 'katcatsTeam', method: 'removeGroup' } },
    }).katcatsTeam
    await expect(limited.removeGroup({ id: group.id })).rejects.toMatchObject({ code: 'remote-access/denied' })
    expect(await h.team.snapshot()).toEqual(before)
  })

  it('persists adjacent custom-group ordering while keeping both system groups and all Bots fixed', async () => {
    const first = await harness()
    const editorial = (await first.team.createGroup({ name: 'Editorial' })).group
    const research = (await first.team.createGroup({ name: 'Research' })).group
    const finance = (await first.team.createGroup({ name: 'Finance' })).group
    await first.team.createBot({ name: 'Writer', groupId: editorial.id })
    const before = await first.team.snapshot()
    const moved = await first.team.moveGroup({ id: research.id, direction: 'up' })
    expect(moved.groups).toEqual([before.groups[0], before.groups[1], research, editorial, finance])
    const down = await first.team.moveGroup({ id: editorial.id, direction: 'down' })
    expect(down.groups).toEqual([before.groups[0], before.groups[1], research, finance, editorial])
    expect(down.bots).toEqual(before.bots)
    await first.close()
    const second = await harness(first.root)
    expect(await second.team.snapshot()).toEqual(down)
  })

  it('refuses custom-order boundaries, missing groups, system moves and non-owner moves', async () => {
    const h = await harness()
    const first = (await h.team.createGroup({ name: 'First' })).group
    const last = (await h.team.createGroup({ name: 'Last' })).group
    const before = await h.team.snapshot()
    await expect(h.team.moveGroup({ id: first.id, direction: 'up' })).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(h.team.moveGroup({ id: last.id, direction: 'down' })).rejects.toMatchObject({ code: 'gateway/bad-request' })
    for (const id of [ordinaryGroupId, chatGroupId, brandString<GroupId>('missing-group')]) {
      await expect(h.team.moveGroup({ id, direction: 'up' })).rejects.toMatchObject({ code: 'gateway/bad-request' })
    }
    const limited = h.ctx.extend({
      invocation: { peer: { principal: { kind: 'limited-fixture' } }, request: { namespace: 'katcatsTeam', method: 'moveGroup' } },
    }).katcatsTeam
    await expect(limited.moveGroup({ id: last.id, direction: 'up' })).rejects.toMatchObject({ code: 'remote-access/denied' })
    expect(await h.team.snapshot()).toEqual(before)
  })

  it('retains the saved order and revision after a failed move, then accepts a retry', async () => {
    const h = await harness()
    const first = (await h.team.createGroup({ name: 'First' })).group
    const last = (await h.team.createGroup({ name: 'Last' })).group
    const before = await h.team.snapshot()
    const path = join(h.root, 'storage', 'katcats_team.json')
    const document = await readFile(path, 'utf8')
    vi.spyOn(h.ctx.storageDomain.get('katcats_team')!.global, 'set').mockRejectedValueOnce(new Error('Fixture group order write failed'))
    await expect(h.team.moveGroup({ id: last.id, direction: 'up' })).rejects.toThrow('Fixture group order write failed')
    expect(await h.team.snapshot()).toEqual(before)
    expect(await readFile(path, 'utf8')).toBe(document)
    const moved = await h.team.moveGroup({ id: last.id, direction: 'up' })
    expect(moved.groups.filter(group => !group.system).map(group => group.id)).toEqual([last.id, first.id])
  })
})
