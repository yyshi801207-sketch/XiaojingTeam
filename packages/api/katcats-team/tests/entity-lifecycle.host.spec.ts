import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import Commands from '@deepseek-ai/dsh-commands'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import KatcatsChats from '../src/chats.ts'
import { chatsDomainSpec, chatsStateSchema } from '../src/chats-storage.ts'
import { chatGroupId, mainBotId, ordinaryGroupId } from '../src/storage.ts'
import { harness, send } from './member-fixture.ts'

async function setup(root?: string) {
  const h = await harness(root)
  await h.ctx.plugin(AttachmentLocal, { dshHome: join(h.root, 'home') })
  await h.ctx.plugin(CredentialsLocal, { path: join(h.root, 'credentials.yaml'), watch: false })
  await h.ctx.plugin(Connection)
  await h.ctx.plugin(Commands)
  await h.ctx.plugin(FileUploads)
  const chatFiber = h.ctx.plugin(KatcatsChats, { workspaceRoot: join(h.root, 'workspaces'), relayLimit: 2,
    initialHistoryMessages: 20, historyPageSize: 20, historyPageMaxChars: 16000, reviewCandidateMaxBytes: 8388608 })
  await chatFiber
  await h.ctx.katcatsChats.snapshot()
  return { ...h, chats: h.ctx.katcatsChats, chatFiber }
}

function scheduled(h: Awaited<ReturnType<typeof setup>>, target: SessionId) {
  return h.ctx.on('workspace/session-activity', async ({ sessionId }, next) => sessionId === target
    ? [{ kind: 'schedule', items: [{ id: 'fixture-reminder', label: 'Fixture reminder' }] }, ...await next()]
    : next())
}

describe('Katcats product entity removal', () => {
  it('removes only an idle Bot directory entry and preserves its history, files and other members after reopen', async () => {
    const h = await setup()
    const bot = (await h.team.createBot({ name: 'Writer' })).bot
    const other = (await h.team.createBot({ name: 'Other' })).bot
    await send(h.ctx.agents.get(bot.sessionId)!, 'remember the original history')
    await writeFile(join(bot.workDir, 'kept.txt'), 'kept')
    const saved = await h.ctx.sessionController.inspect(bot.sessionId)
    expect(h.ctx.tools.get('set_own_role', h.ctx.agents.get(bot.sessionId))).toBeDefined()
    const otherCancel = vi.spyOn(h.ctx.agents.get(other.sessionId)!, 'cancel')
    const result = await h.team.deleteBot({ id: bot.id })
    expect(result.bots.map(value => value.id)).toEqual([mainBotId, other.id])
    expect(h.ctx.workspaceRegistry.archivedSessionIds).toContain(bot.sessionId)
    expect(h.ctx.workspaceRegistry.archivedSessionIds).not.toContain(other.sessionId)
    expect(await h.ctx.sessionController.inspect(bot.sessionId)).toEqual(saved)
    expect(await readFile(join(bot.workDir, 'kept.txt'), 'utf8')).toBe('kept')
    expect(h.ctx.tools.get('set_own_role', h.ctx.agents.get(bot.sessionId))).toBeUndefined()
    expect(otherCancel).not.toHaveBeenCalled()
    await h.close()
    const reopened = await setup(h.root)
    expect((await reopened.team.snapshot()).bots.map(value => value.id)).toEqual([mainBotId, other.id])
    expect(await reopened.ctx.sessionPersistence.stat(bot.sessionId)).toBeDefined()
  })

  it('protects the main Bot and any current group member, including a group last member', async () => {
    const h = await setup()
    const bot = (await h.team.createBot({ name: 'Writer' })).bot
    await h.chats.createChat({ name: 'Single member', memberIds: [bot.id] })
    await expect(h.team.deleteBot({ id: mainBotId })).rejects.toMatchObject({ details: { reason: 'bot-main' } })
    await expect(h.team.deleteBot({ id: bot.id })).rejects.toMatchObject({ details: { reason: 'bot-in-group' } })
    expect(h.ctx.workspaceRegistry.archivedSessionIds).not.toContain(bot.sessionId)
    expect((await h.team.snapshot()).bots).toHaveLength(2)
  })

  it('refuses a private pending message and active persisted automations before archiving', async () => {
    const h = await setup()
    const bot = (await h.team.createBot({ name: 'Writer' })).bot
    const release = scheduled(h, bot.sessionId)
    await expect(h.team.deleteBot({ id: bot.id })).rejects.toMatchObject({ details: { reason: 'active-automations' } })
    release()
    const agent = h.ctx.agents.get(bot.sessionId)!
    const status = vi.spyOn(agent, 'status', 'get').mockReturnValue('running')
    await expect(h.team.deleteBot({ id: bot.id })).rejects.toMatchObject({ details: { reason: 'bot-running' } })
    status.mockRestore()
    expect(h.ctx.workspaceRegistry.archivedSessionIds).not.toContain(bot.sessionId)
  })

  it('keeps Bot registrations and archive choices when removal cannot commit', async () => {
    const h = await setup()
    const bot = (await h.team.createBot({ name: 'Writer' })).bot
    const domain = h.ctx.storageDomain.get('katcats_team')!
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Fixture removal write failed'))
    await expect(h.team.deleteBot({ id: bot.id })).rejects.toThrow('Fixture removal write failed')
    expect((await h.team.snapshot()).bots).toContainEqual(bot)
    expect(h.ctx.workspaceRegistry.archivedSessionIds).not.toContain(bot.sessionId)
    await send(h.ctx.agents.get(bot.sessionId)!, 'identity still works')
    expect(h.adapter.requests).toHaveLength(1)
  })

  it('rejects group removal with active schedules without stopping any owned Session', async () => {
    const h = await setup()
    const bot = (await h.team.createBot({ name: 'Writer' })).bot
    const chat = (await h.chats.createChat({ name: 'Scheduled', memberIds: [bot.id] })).chat
    scheduled(h, chat.rootSessionId)
    const cancel = vi.spyOn(h.ctx.agents.get(chat.executors[0]!.sessionId)!, 'cancel')
    await expect(h.chats.deleteChat({ id: chat.id })).rejects.toMatchObject({ details: { reason: 'active-automations' } })
    expect(cancel).not.toHaveBeenCalled()
    expect((await h.chats.snapshot()).chats).toContainEqual(chat)
  })

  it('removes a group and its journal while preserving exact owned Session history, files and other groups', async () => {
    const h = await setup()
    const bot = (await h.team.createBot({ name: 'Writer' })).bot
    const chat = (await h.chats.createChat({ name: 'Remove', memberIds: [bot.id] })).chat
    const other = (await h.chats.createChat({ name: 'Keep', memberIds: [bot.id] })).chat
    await writeFile(join(chat.workDir, 'kept.txt'), 'group file')
    const privateCancel = vi.spyOn(h.ctx.agents.get(bot.sessionId)!, 'cancel')
    const otherCancel = vi.spyOn(h.ctx.agents.get(other.executors[0]!.sessionId)!, 'cancel')
    const result = await h.chats.deleteChat({ id: chat.id })
    expect(result.chats).toEqual([other])
    const stored = chatsStateSchema.parse(h.ctx.storageDomain.get(chatsDomainSpec.name)!.global.get())
    expect(stored.inbounds.every(input => input.chatId !== chat.id)).toBe(true)
    expect(stored.deliveries.every(delivery => delivery.chatId !== chat.id)).toBe(true)
    for (const id of [chat.rootSessionId, ...chat.executors.map(executor => executor.sessionId)]) {
      expect(h.ctx.workspaceRegistry.archivedSessionIds).toContain(id)
      expect(await h.ctx.sessionPersistence.stat(id)).toBeDefined()
    }
    expect(await readFile(join(chat.workDir, 'kept.txt'), 'utf8')).toBe('group file')
    expect(privateCancel).not.toHaveBeenCalled()
    expect(otherCancel).not.toHaveBeenCalled()
    await h.team.deleteBot({ id: bot.id }).then(() => { throw new Error('The other group must protect its member') }, (error: unknown) => {
      expect(error).toMatchObject({ details: { reason: 'bot-in-group' } })
    })
    await h.close()
    const reopened = await setup(h.root)
    expect((await reopened.chats.snapshot()).chats).toEqual([other])
  })

  it('keeps a stopped group and rolls back its own archives when final removal fails', async () => {
    const h = await setup()
    const bot = (await h.team.createBot({ name: 'Writer' })).bot
    const chat = (await h.chats.createChat({ name: 'Retained', memberIds: [bot.id] })).chat
    const domain = h.ctx.storageDomain.get(chatsDomainSpec.name)!
    const write = domain.global.set.bind(domain.global)
    vi.spyOn(domain.global, 'set').mockImplementation(async (value) => {
      const state = chatsStateSchema.parse(value)
      if (state.chats.every(item => item.id !== chat.id)) throw new Error('Fixture group removal failed')
      await write(value)
    })
    await expect(h.chats.deleteChat({ id: chat.id })).rejects.toThrow('Fixture group removal failed')
    expect((await h.chats.snapshot()).chats[0]).toMatchObject({ id: chat.id, status: 'stopped' })
    expect(h.ctx.workspaceRegistry.archivedSessionIds).not.toContain(chat.rootSessionId)
    expect(h.ctx.workspaceRegistry.archivedSessionIds).not.toContain(chat.executors[0]!.sessionId)
  })

  it('waits for an executing group worker and retains its public history before removing its journal', async () => {
    const h = await setup()
    const bot = (await h.team.createBot({ name: 'Writer' })).bot
    const chat = (await h.chats.createChat({ name: 'Running', memberIds: [bot.id] })).chat
    const other = (await h.chats.createChat({ name: 'Unrelated', memberIds: [bot.id] })).chat
    const executor = h.ctx.agents.get(chat.executors[0]!.sessionId)!
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const stream = h.adapter.stream.bind(h.adapter)
    vi.spyOn(h.adapter, 'stream').mockImplementationOnce(async function* (request) {
      entered.resolve(undefined)
      await release.promise
      yield* stream(request)
    })
    await h.chats.sendMessage({ sessionId: chat.rootSessionId, requestId: brandString<SessionRequestId>('remove-running'),
      mode: 'queue', content: [{ type: 'text', text: '@Writer save this group history.' }] }, new AbortController().signal)
    await entered.promise
    const privateCancel = vi.spyOn(h.ctx.agents.get(bot.sessionId)!, 'cancel')
    const otherCancel = vi.spyOn(h.ctx.agents.get(other.executors[0]!.sessionId)!, 'cancel')
    const cancel = vi.spyOn(executor, 'cancel')
    let removed = false
    const deleting = h.chats.deleteChat({ id: chat.id }).then((value) => { removed = true; return value })
    try {
      await vi.waitFor(() => { expect(cancel).toHaveBeenCalled() })
      expect(removed).toBe(false)
    } finally { release.resolve(undefined) }
    expect((await deleting).chats).toEqual([other])
    expect(privateCancel).not.toHaveBeenCalled()
    expect(otherCancel).not.toHaveBeenCalled()
    const saved = await h.ctx.sessionController.inspect(chat.rootSessionId)
    expect(saved.events.some(event => event.type === 'user/message' && event.data.content.some(part =>
      part.type === 'text' && part.text.includes('save this group history')))).toBe(true)
    const state = chatsStateSchema.parse(h.ctx.storageDomain.get(chatsDomainSpec.name)!.global.get())
    expect(state.inbounds).toEqual([])
    expect(state.deliveries).toEqual([])
  })

  it('retains the stopped group and prior archive choices if a later owned archive fails', async () => {
    const h = await setup()
    const bot = (await h.team.createBot({ name: 'Writer' })).bot
    const chat = (await h.chats.createChat({ name: 'Retained', memberIds: [bot.id] })).chat
    const archive = h.ctx.workspaceRegistry.archiveSession.bind(h.ctx.workspaceRegistry)
    vi.spyOn(h.ctx.workspaceRegistry, 'archiveSession').mockImplementation(async (id) => {
      if (id === chat.executors[0]!.sessionId) throw new Error('Fixture archive failed')
      await archive(id)
    })
    await expect(h.chats.deleteChat({ id: chat.id })).rejects.toThrow('Fixture archive failed')
    expect((await h.chats.snapshot()).chats[0]).toMatchObject({ id: chat.id, status: 'stopped' })
    expect(h.ctx.workspaceRegistry.archivedSessionIds).not.toContain(chat.rootSessionId)
    expect(h.ctx.workspaceRegistry.archivedSessionIds).not.toContain(chat.executors[0]!.sessionId)
  })

  it('retains group metadata and history if stopping its owned work cannot be confirmed', async () => {
    const h = await setup()
    const bot = (await h.team.createBot({ name: 'Writer' })).bot
    const chat = (await h.chats.createChat({ name: 'Stop failure', memberIds: [bot.id] })).chat
    vi.spyOn(h.ctx.sessions, 'flush').mockRejectedValueOnce(new Error('Fixture stop flush failed'))
    await expect(h.chats.deleteChat({ id: chat.id })).rejects.toThrow('Fixture stop flush failed')
    expect((await h.chats.snapshot()).chats[0]?.id).toBe(chat.id)
    expect(h.ctx.workspaceRegistry.archivedSessionIds).not.toContain(chat.rootSessionId)
    expect(await h.ctx.sessionPersistence.stat(chat.rootSessionId)).toBeDefined()
  })

  it('rejects both removal APIs for another principal before exposing directory entries', async () => {
    const h = await setup()
    const bot = (await h.team.createBot({ name: 'Writer' })).bot
    const chat = (await h.chats.createChat({ name: 'Owner only', memberIds: [bot.id] })).chat
    const limited = h.ctx.extend({ invocation: { peer: { principal: { kind: 'limited-fixture' } },
      request: { namespace: 'katcatsTeam', method: 'deleteBot' } } })
    await expect(limited.katcatsTeam.deleteBot({ id: bot.id })).rejects.toMatchObject({ code: 'remote-access/denied' })
    await expect(limited.katcatsChats.deleteChat({ id: chat.id })).rejects.toMatchObject({ code: 'remote-access/denied' })
    expect((await h.team.snapshot()).bots).toContainEqual(bot)
    expect((await h.chats.snapshot()).chats).toContainEqual(chat)
  })

  it('waits for an accepted removal to roll back its archives before closing the group directory', async () => {
    const h = await setup()
    const bot = (await h.team.createBot({ name: 'Writer' })).bot
    const chat = (await h.chats.createChat({ name: 'Closing', memberIds: [bot.id] })).chat
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const archive = h.ctx.workspaceRegistry.archiveSession.bind(h.ctx.workspaceRegistry)
    vi.spyOn(h.ctx.workspaceRegistry, 'archiveSession').mockImplementationOnce(async (id) => {
      entered.resolve(undefined)
      await release.promise
      await archive(id)
    })
    const deleting = h.chats.deleteChat({ id: chat.id })
    const refused = expect(deleting).rejects.toMatchObject({ code: 'gateway/internal' })
    await entered.promise
    let closed = false
    const closing = h.chatFiber.dispose().then(() => { closed = true })
    try {
      await vi.waitFor(async () => {
        await expect(h.chats.snapshot()).rejects.toMatchObject({ code: 'gateway/internal' })
      })
      expect(closed).toBe(false)
    } finally { release.resolve(undefined) }
    await refused
    await closing
    expect(h.ctx.workspaceRegistry.archivedSessionIds).not.toContain(chat.rootSessionId)
    expect(h.ctx.workspaceRegistry.archivedSessionIds).not.toContain(chat.executors[0]!.sessionId)
    const raw: unknown = JSON.parse(await readFile(join(h.root, 'storage', chatsDomainSpec.name + '.json'), 'utf8'))
    if (typeof raw !== 'object' || raw === null || !('global' in raw)) throw new Error('Expected saved group fixture')
    expect(chatsStateSchema.parse(raw.global).chats[0]?.id).toBe(chat.id)
  })

  it('serializes Bot removal before a concurrent group creation using that Bot', async () => {
    const h = await setup()
    const bot = (await h.team.createBot({ name: 'Writer' })).bot
    const [removed, created] = await Promise.allSettled([
      h.team.deleteBot({ id: bot.id }), h.chats.createChat({ name: 'Concurrent', memberIds: [bot.id] }),
    ])
    expect(removed.status).toBe('fulfilled')
    expect(created.status).toBe('rejected')
    expect((await h.chats.snapshot()).chats).toEqual([])
  })

  it('moves chats before deleting a shared group and returns Bots to their separate default section', async () => {
    const h = await setup()
    const group = (await h.team.createGroup({ name: 'Shared' })).group
    const bot = (await h.team.createBot({ name: 'Writer', groupId: group.id })).bot
    const chat = (await h.chats.createChat({ name: 'Editorial', memberIds: [bot.id] })).chat
    await h.chats.updateChat({ id: chat.id, groupId: group.id })
    const result = await h.team.removeGroup({ id: group.id })
    expect(result.groups.some(value => value.id === group.id)).toBe(false)
    expect(result.bots.find(value => value.id === bot.id)?.groupId).toBe(ordinaryGroupId)
    expect((await h.chats.snapshot()).chats[0]).toEqual({ ...chat, groupId: chatGroupId })
  })

  it('leaves valid references after the second group-removal write fails, then finishes on retry', async () => {
    const h = await setup()
    const group = (await h.team.createGroup({ name: 'Shared' })).group
    const bot = (await h.team.createBot({ name: 'Writer', groupId: group.id })).bot
    const chat = (await h.chats.createChat({ name: 'Editorial', memberIds: [bot.id] })).chat
    await h.chats.updateChat({ id: chat.id, groupId: group.id })
    const domain = h.ctx.storageDomain.get('katcats_team')!
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Fixture final group write failed'))
    await expect(h.team.removeGroup({ id: group.id })).rejects.toThrow('Fixture final group write failed')
    expect((await h.team.snapshot()).groups).toContainEqual(group)
    expect((await h.chats.snapshot()).chats[0]?.groupId).toBe(chatGroupId)
    await h.close()
    const reopened = await setup(h.root)
    await reopened.team.removeGroup({ id: group.id })
    expect((await reopened.team.snapshot()).groups.some(value => value.id === group.id)).toBe(false)
  })

  it('does not delete a shared group if moving its chats fails', async () => {
    const h = await setup()
    const group = (await h.team.createGroup({ name: 'Shared' })).group
    const bot = (await h.team.createBot({ name: 'Writer', groupId: group.id })).bot
    const chat = (await h.chats.createChat({ name: 'Editorial', memberIds: [bot.id] })).chat
    await h.chats.updateChat({ id: chat.id, groupId: group.id })
    const domain = h.ctx.storageDomain.get(chatsDomainSpec.name)!
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Fixture first group write failed'))
    await expect(h.team.removeGroup({ id: group.id })).rejects.toThrow('Fixture first group write failed')
    expect((await h.team.snapshot()).groups).toContainEqual(group)
    expect((await h.team.snapshot()).bots).toContainEqual(bot)
    expect((await h.chats.snapshot()).chats[0]?.groupId).toBe(group.id)
  })

  it('orders a simultaneous chat move after shared-group deletion and rejects the removed target', async () => {
    const h = await setup()
    const group = (await h.team.createGroup({ name: 'Shared' })).group
    const bot = (await h.team.createBot({ name: 'Writer' })).bot
    const chat = (await h.chats.createChat({ name: 'Editorial', memberIds: [bot.id] })).chat
    const deleting = h.team.removeGroup({ id: group.id })
    const moving = h.chats.updateChat({ id: chat.id, groupId: group.id })
    const [deleted, moved] = await Promise.allSettled([deleting, moving])
    expect(deleted.status).toBe('fulfilled')
    expect(moved.status).toBe('rejected')
    expect((await h.chats.snapshot()).chats[0]?.groupId).toBe(chatGroupId)
  })
})
