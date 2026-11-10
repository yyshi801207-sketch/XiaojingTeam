/** Per-group transcript display preferences preserve work, history, and old storage. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import Commands from '@deepseek-ai/dsh-commands'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import KatcatsChats from '../src/chats.ts'
import { chatSchema, chatsDomainSpec, chatsStateSchema } from '../src/chats-storage.ts'
import type { ChatId } from '../src/chats-types.ts'
import { harness } from './member-fixture.ts'

async function setup(providedRoot?: string) {
  const h = await harness(providedRoot)
  await h.ctx.plugin(AttachmentLocal, { dshHome: join(h.root, 'home') })
  await h.ctx.plugin(CredentialsLocal, { path: join(h.root, 'credentials.yaml'), watch: false })
  await h.ctx.plugin(Connection)
  await h.ctx.plugin(Commands)
  await h.ctx.plugin(FileUploads)
  await h.ctx.plugin(KatcatsChats, { workspaceRoot: join(h.root, 'workspaces'), relayLimit: 16,
    initialHistoryMessages: 20, historyPageSize: 20, historyPageMaxChars: 16000, reviewCandidateMaxBytes: 8388608 })
  await h.ctx.katcatsChats.snapshot()
  return { ...h, chats: h.ctx.katcatsChats }
}

describe('group transcript presentation preference', () => {
  it('enables new groups, saves each group independently, and restores false after reopening', async () => {
    const first = await setup()
    const writer = (await first.team.createBot({ name: 'Writer' })).bot
    const a = (await first.chats.createChat({ name: 'A', memberIds: [writer.id] })).chat
    const b = (await first.chats.createChat({ name: 'B', memberIds: [writer.id] })).chat
    expect(a.showHandoffRecords).toBe(true)
    expect(b.showHandoffRecords).toBe(true)
    const file = join(a.workDir, 'retained.md')
    await writeFile(file, 'Keep this deliverable.')
    const histories = [a.rootSessionId, b.rootSessionId,
      ...a.executors.map(value => value.sessionId), ...b.executors.map(value => value.sessionId)]
      .map(id => ({ id, events: first.ctx.agents.get(id)!.session.snapshotEvents() }))
    const creations = first.create.mock.calls.length
    const titles = first.rename.mock.calls.length
    const saved = (await first.chats.updateChat({ id: a.id, showHandoffRecords: false })).chat
    expect(saved).toEqual({ ...a, showHandoffRecords: false })
    expect((await first.chats.snapshot()).chats.find(chat => chat.id === b.id)).toEqual(b)
    expect(first.create).toHaveBeenCalledTimes(creations)
    expect(first.rename).toHaveBeenCalledTimes(titles)
    for (const history of histories) expect(first.ctx.agents.get(history.id)!.session.snapshotEvents()).toEqual(history.events)
    expect(first.adapter.requests).toEqual([])
    await first.close()
    const cold = await setup(first.root)
    expect((await cold.chats.snapshot()).chats).toEqual([b, saved])
    expect(await readFile(file, 'utf8')).toBe('Keep this deliverable.')
    expect((await cold.chats.updateChat({ id: a.id, showHandoffRecords: true })).chat).toEqual(a)
  })

  it('reads a pre-setting group without rewriting its bytes or changing its enabled interpretation', async () => {
    const first = await setup()
    const writer = (await first.team.createBot({ name: 'Writer' })).bot
    const created = (await first.chats.createChat({ name: 'Old group', memberIds: [writer.id] })).chat
    const { showHandoffRecords: _preference, ...old } = created
    const domain = first.ctx.storageDomain.get(chatsDomainSpec.name)!
    const state = chatsStateSchema.parse(domain.global.get())
    await domain.global.set({ ...state, chats: [old] })
    const path = join(first.root, 'storage', `${chatsDomainSpec.name}.json`)
    await first.close()
    const bytes = await readFile(path, 'utf8')
    const cold = await setup(first.root)
    const restored = (await cold.chats.snapshot()).chats[0]!
    expect(restored).toEqual(old)
    expect(restored.showHandoffRecords !== false).toBe(true)
    expect(await readFile(path, 'utf8')).toBe(bytes)
    expect(chatSchema.safeParse({ ...old, showHandoffRecords: 'false' }).success).toBe(false)
    expect(chatSchema.parse({ ...old, showHandoffRecords: false }).showHandoffRecords).toBe(false)
    expect(chatsDomainSpec.name).toBe('katcats_chats_v3')
    expect(chatsDomainSpec.version).toBe(3)
  })

  it('does not acknowledge a failed save, change another group, or bypass owner access', async () => {
    const h = await setup()
    const writer = (await h.team.createBot({ name: 'Writer' })).bot
    const chat = (await h.chats.createChat({ name: 'A', memberIds: [writer.id] })).chat
    const before = await h.chats.snapshot()
    const path = join(h.root, 'storage', `${chatsDomainSpec.name}.json`)
    const bytes = await readFile(path, 'utf8')
    const domain = h.ctx.storageDomain.get(chatsDomainSpec.name)!
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Fixture presentation save failure'))
    await expect(h.chats.updateChat({ id: chat.id, showHandoffRecords: false })).rejects.toThrow('Fixture presentation save failure')
    expect(await h.chats.snapshot()).toEqual(before)
    expect(await readFile(path, 'utf8')).toBe(bytes)
    const limited = h.ctx.extend({ invocation: { peer: { principal: { kind: 'limited-fixture' } },
      request: { namespace: 'katcatsChats', method: 'updateChat' } } }).katcatsChats
    await expect(limited.updateChat({ id: chat.id, showHandoffRecords: false })).rejects.toMatchObject({ code: 'remote-access/denied' })
    await expect(h.chats.updateChat({ id: brandString<ChatId>('missing'), showHandoffRecords: false }))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(await h.chats.snapshot()).toEqual(before)
    expect((await h.chats.updateChat({ id: chat.id, showHandoffRecords: false })).chat.showHandoffRecords).toBe(false)
  })

  it('saves display changes during actual work without cancelling, changing generation, or removing the eventual reply', async () => {
    const h = await setup()
    const writer = (await h.team.createBot({ name: 'Writer' })).bot
    const chat = (await h.chats.createChat({ name: 'Working', memberIds: [writer.id] })).chat
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const original = h.adapter.stream.bind(h.adapter)
    vi.spyOn(h.adapter, 'stream').mockImplementationOnce(async function* (request) {
      entered.resolve(undefined)
      await release.promise
      yield* original(request)
    })
    await h.chats.sendMessage({ sessionId: chat.rootSessionId, requestId: brandString<SessionRequestId>('presentation-while-working'),
      mode: 'queue', content: [{ type: 'text', text: '@Writer say hello.' }] }, new AbortController().signal)
    await entered.promise
    const abort = new AbortController()
    try {
      const before = await h.chats.snapshot()
      const active = before.chats.find(value => value.id === chat.id)!
      expect(before.activities.find(value => value.chatId === chat.id)?.processing).toBe(true)
      const updated = (await h.chats.updateChat({ id: chat.id, showHandoffRecords: false })).chat
      expect(updated).toEqual({ ...active, showHandoffRecords: false })
      const after = await h.chats.snapshot()
      expect(after.deliveries).toEqual(before.deliveries)
      expect(after.activities).toEqual(before.activities)
      release.resolve(undefined)
      for await (const frame of h.chats.follow(abort.signal)) {
        if (frame.value.activities.find(value => value.chatId === chat.id)?.processing === false) break
      }
      const finished = await h.chats.snapshot()
      expect(finished.chats[0]).toMatchObject({ showHandoffRecords: false, generation: active.generation })
      expect(finished.deliveries.some(value => value.chatId === chat.id && value.state === 'completed' && value.receipt?.text === 'Fixture response')).toBe(true)
      const events = h.ctx.agents.get(chat.rootSessionId)!.session.snapshotEvents()
      expect(events.filter(event => event.type === 'katcats/group-task-lifecycle').length).toBeGreaterThan(0)
      expect(events.some(event => event.type === 'user/message' && event.data.source.kind === 'katcats-group-relay')).toBe(true)
    } finally { release.resolve(undefined); abort.abort() }
  })

  it('keeps the preference through ordinary settings recovery and combined grouping updates', async () => {
    const h = await setup()
    const writer = (await h.team.createBot({ name: 'Writer' })).bot
    const chat = (await h.chats.createChat({ name: 'A', memberIds: [writer.id] })).chat
    const group = (await h.team.createGroup({ name: 'Shared' })).group
    const updated = (await h.chats.updateChat({ id: chat.id, name: 'Renamed', showHandoffRecords: false })).chat
    expect(updated).toEqual({ ...chat, name: 'Renamed', showHandoffRecords: false })
    expect((await h.chats.updateChat({ id: chat.id, groupId: group.id, showHandoffRecords: true })).chat)
      .toEqual({ ...updated, groupId: group.id, showHandoffRecords: true })
  })
})
