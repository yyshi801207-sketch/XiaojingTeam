import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import Commands from '@deepseek-ai/dsh-commands'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { SessionPromptRequest, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import KatcatsChats from '../src/chats.ts'
import type { ChatsConfig } from '../src/chats.ts'
import { chatsDomainSpec, chatsStateSchema } from '../src/chats-storage.ts'
import { GroupTranscript } from '../src/group-transcript.ts'
import { formatMemberMention } from '../src/member-mentions.ts'
import { chatGroupId, mainBotId, ordinaryGroupId, teamStateSchema } from '../src/storage.ts'
import type { BotId, GroupId } from '../src/types.ts'
import type { ChatControlRequest, TeamChat, UpdateChatRequest } from '../src/chats-types.ts'
import { harness } from './member-fixture.ts'

async function setup(providedRoot?: string, configuredLimit: number | null = 2) {
  const h = await harness(providedRoot)
  await h.ctx.plugin(AttachmentLocal, { dshHome: join(h.root, 'home') })
  await h.ctx.plugin(CredentialsLocal, { path: join(h.root, 'credentials.yaml'), watch: false })
  await h.ctx.plugin(Connection)
  await h.ctx.plugin(Commands)
  await h.ctx.plugin(FileUploads)
  // Exercise omitted schema defaults despite the schema's resolved-config input annotation.
  const config = KatcatsChats.Config({ workspaceRoot: join(h.root, 'workspaces'),
    ...(configuredLimit === null ? {} : { relayLimit: configuredLimit }) } as ChatsConfig)
  await h.ctx.plugin(KatcatsChats, config)
  const chats = h.ctx.katcatsChats
  await chats.snapshot()
  return { ...h, chats }
}

function control(chat: TeamChat): ChatControlRequest {
  return { id: chat.id, expectedRunId: chat.run?.id ?? null, expectedGeneration: chat.generation }
}

function prompt(chat: TeamChat, text: string, id = 'group-fixture-request'): SessionPromptRequest {
  return { sessionId: chat.rootSessionId, requestId: brandString<SessionRequestId>(id), mode: 'queue', content: [{ type: 'text', text }] }
}

async function settled(chats: KatcatsChats, id: TeamChat['id']): Promise<void> {
  const abort = new AbortController()
  try {
    for await (const frame of chats.follow(abort.signal)) {
      if (frame.value.activities.find(value => value.chatId === id)?.processing === false) return
    }
    throw new Error('The group directory closed before its work settled')
  } finally { abort.abort() }
}

function stateOf(h: Awaited<ReturnType<typeof setup>>) {
  return chatsStateSchema.parse(h.ctx.storageDomain.get(chatsDomainSpec.name)?.global.get())
}

describe('Katcats durable groups', () => {
  it('resolves deployment history and review limits and refuses nonpositive or fractional limits', () => {
    const input = { workspaceRoot: '/synthetic-workspaces', relayLimit: 8 } as ChatsConfig
    expect(KatcatsChats.Config(input)).toMatchObject({ initialHistoryMessages: 20, historyPageSize: 20,
      historyPageMaxChars: 16000, reviewCandidateMaxBytes: 8388608 })
    for (const field of ['initialHistoryMessages', 'historyPageSize', 'historyPageMaxChars', 'reviewCandidateMaxBytes']) {
      for (const value of [0, -1, 0.5]) expect(() => KatcatsChats.Config({ ...input, [field]: value })).toThrow()
    }
  })

  it('uses the first saved group member when the sidebar member order changes without saving a manager', async () => {
    const h = await setup()
    const first = (await h.team.createBot({ name: 'First' })).bot
    const second = (await h.team.createBot({ name: 'Second' })).bot
    const chat = (await h.chats.createChat({ name: 'Stable dispatch', memberIds: [first.id, second.id] })).chat
    await h.chats.sendMessage(prompt(chat, 'First broadcast', 'first-order'), new AbortController().signal)
    await settled(h.chats, chat.id)
    const domain = h.ctx.storageDomain.get('katcats_team')!
    const saved = teamStateSchema.parse(domain.global.get())
    await domain.global.set({ ...saved, revision: saved.revision + 1,
      bots: [...saved.bots.filter(bot => bot.kind === 'main'), ...saved.bots.filter(bot => bot.kind === 'ordinary').toReversed()] })
    await h.chats.sendMessage(prompt(chat, 'Second broadcast', 'second-order'), new AbortController().signal)
    await settled(h.chats, chat.id)
    expect(stateOf(h).inbounds.map(input => input.recipients)).toEqual([[first.id], [first.id]])
    expect(stateOf(h).chats[0]?.managerId).toBeNull()
    expect(h.adapter.requests.map(request => request.sessionId)).toEqual([chat.executors[0]!.sessionId, chat.executors[0]!.sessionId])
  })

  it('captures the responsible member once and preserves explicit mentions independently of the manager', async () => {
    const h = await setup()
    const first = (await h.team.createBot({ name: 'First' })).bot
    const manager = (await h.team.createBot({ name: 'Manager' })).bot
    const last = (await h.team.createBot({ name: 'Last' })).bot
    const chat = (await h.chats.createChat({ name: 'Responsible routing', memberIds: [first.id, manager.id, last.id], managerId: manager.id })).chat
    await h.chats.pause(control(chat))
    const initial = prompt(chat, 'Ordinary request', 'routing-ordinary')
    await h.chats.sendMessage(initial, new AbortController().signal)
    await h.chats.sendMessage(prompt(chat, '@Last Direct request', 'routing-explicit'), new AbortController().signal)
    await h.chats.sendMessage(prompt(chat, '@Manager @First Both requested', 'routing-multiple'), new AbortController().signal)
    await settled(h.chats, chat.id)
    await h.chats.updateChat({ id: chat.id, managerId: last.id, memberIds: [last.id, first.id, manager.id] })
    await h.chats.sendMessage(initial, new AbortController().signal)
    await h.chats.sendMessage(prompt(chat, 'New ordinary request', 'routing-new'), new AbortController().signal)
    await settled(h.chats, chat.id)
    expect(stateOf(h).inbounds.map(({ recipients, addressing, collaborationVersion }) => ({ recipients, addressing, collaborationVersion }))).toEqual([
      { recipients: [manager.id], addressing: 'broadcast', collaborationVersion: 1 },
      { recipients: [last.id], addressing: 'explicit', collaborationVersion: 1 },
      { recipients: [first.id, manager.id], addressing: 'explicit', collaborationVersion: 1 },
      { recipients: [last.id], addressing: 'broadcast', collaborationVersion: 1 },
    ])
    expect(h.adapter.requests).toHaveLength(0)
    const saved = stateOf(h).inbounds
    await h.close()
    const reopened = await setup(h.root)
    expect(stateOf(reopened).inbounds).toEqual(saved)
    expect(reopened.adapter.requests).toHaveLength(0)
  })

  it('retains legacy broadcast recipients when a paused accepted message is reopened', async () => {
    const h = await setup()
    const first = (await h.team.createBot({ name: 'First' })).bot
    const second = (await h.team.createBot({ name: 'Second' })).bot
    const chat = (await h.chats.createChat({ name: 'Legacy accepted routing', memberIds: [first.id, second.id], managerId: second.id })).chat
    await h.chats.pause(control(chat))
    await h.chats.sendMessage(prompt(chat, 'Previously accepted broadcast', 'legacy-broadcast'), new AbortController().signal)
    await settled(h.chats, chat.id)
    const state = stateOf(h)
    const inbounds = state.inbounds.map(({ collaborationVersion: _version, ...input }) => ({ ...input, recipients: [first.id, second.id] }))
    await h.ctx.storageDomain.get(chatsDomainSpec.name)!.global.set({ ...state, inbounds })
    await h.close()
    const reopened = await setup(h.root)
    expect(stateOf(reopened).inbounds).toEqual(inbounds)
    const paused = (await reopened.chats.snapshot()).chats[0]!
    await reopened.chats.resume(control(paused))
    await settled(reopened.chats, chat.id)
    expect(reopened.adapter.requests.map(request => request.sessionId)).toEqual(chat.executors.map(executor => executor.sessionId))
  })

  it('prepends new groups, retains existing settings and order, and restores that order after reopening', async () => {
    const first = await setup()
    const writer = (await first.team.createBot({ name: 'Writer' })).bot
    const older = (await first.chats.createChat({ name: 'Older', memberIds: [writer.id] })).chat
    const newer = (await first.chats.createChat({ name: 'Newer', memberIds: [writer.id] })).chat
    const newest = await first.chats.createChat({ name: 'Newest', memberIds: [writer.id] })
    expect(newest.snapshot.chats).toEqual([newest.chat, newer, older])
    const renamed = (await first.chats.updateChat({ id: older.id, name: 'Renamed' })).chat
    expect((await first.chats.snapshot()).chats).toEqual([newest.chat, newer, renamed])
    await first.close()
    const reopened = await setup(first.root)
    expect((await reopened.chats.snapshot()).chats).toEqual([newest.chat, newer, renamed])
  })

  it('uses sixteen dispatches for new groups while preserving an existing eight-dispatch group after reopening', async () => {
    const first = await setup(undefined, 8)
    const writer = (await first.team.createBot({ name: 'Writer' })).bot
    const existing = (await first.chats.createChat({ name: 'Existing', memberIds: [writer.id] })).chat
    expect(existing.relayLimit).toBe(8)
    await first.close()
    const second = await setup(first.root, null)
    const restored = await second.chats.snapshot()
    expect(restored.relayLimit).toBe(16)
    expect(restored.chats).toEqual([existing])
    const created = (await second.chats.createChat({ name: 'New', memberIds: [writer.id] })).chat
    expect(created.relayLimit).toBe(16)
    expect((await second.chats.snapshot()).chats.find(chat => chat.id === existing.id)).toEqual(existing)
    expect(second.adapter.requests).toEqual([])
  })

  it('moves a group into a shared custom section without changing Sessions, work files or private Bots', async () => {
    const first = await setup()
    const writer = (await first.team.createBot({ name: 'Writer' })).bot
    const group = (await first.team.createGroup({ name: 'Editorial section' })).group
    const chat = (await first.chats.createChat({ name: 'Editorial', memberIds: [writer.id] })).chat
    const path = join(chat.workDir, 'retained-draft.md')
    await writeFile(path, 'A retained group deliverable.')
    const previousTeam = await first.team.snapshot()
    const domain = first.ctx.storageDomain.get(chatsDomainSpec.name)!
    const save = vi.spyOn(domain.global, 'set')
    const creations = first.create.mock.calls.length
    const titles = first.rename.mock.calls.length
    const histories = [chat.rootSessionId, ...chat.executors.map(executor => executor.sessionId)]
      .map(id => ({ id, events: first.ctx.agents.get(id)!.session.snapshotEvents() }))
    const moved = (await first.chats.updateChat({ id: chat.id, groupId: group.id })).chat
    expect(moved).toEqual({ ...chat, groupId: group.id })
    expect(save).toHaveBeenCalledOnce()
    expect(first.create.mock.calls).toHaveLength(creations)
    expect(first.rename.mock.calls).toHaveLength(titles)
    expect(await first.team.snapshot()).toEqual(previousTeam)
    for (const history of histories) expect(first.ctx.agents.get(history.id)!.session.snapshotEvents()).toEqual(history.events)
    expect(first.adapter.requests).toEqual([])
    await first.close()
    const second = await setup(first.root)
    expect((await second.chats.snapshot()).chats).toEqual([moved])
    expect(await readFile(path, 'utf8')).toBe('A retained group deliverable.')
    expect(second.create).not.toHaveBeenCalled()
    const returned = (await second.chats.updateChat({ id: chat.id, groupId: chatGroupId })).chat
    expect(returned).toEqual(chat)
  })

  it('rejects missing, Bot-only and non-owner group moves before writing', async () => {
    const h = await setup()
    const writer = (await h.team.createBot({ name: 'Writer' })).bot
    const chat = (await h.chats.createChat({ name: 'Editorial', memberIds: [writer.id] })).chat
    const group = (await h.team.createGroup({ name: 'Shared' })).group
    const before = await h.chats.snapshot()
    const domain = h.ctx.storageDomain.get(chatsDomainSpec.name)!
    const save = vi.spyOn(domain.global, 'set')
    for (const groupId of [ordinaryGroupId, 'missing' as GroupId]) {
      await expect(h.chats.updateChat({ id: chat.id, groupId })).rejects.toMatchObject({ code: 'gateway/bad-request' })
    }
    const limited = h.ctx.extend({ invocation: { peer: { principal: { kind: 'limited-fixture' } },
      request: { namespace: 'katcatsChats', method: 'updateChat' } } }).katcatsChats
    await expect(limited.updateChat({ id: chat.id, groupId: group.id })).rejects.toMatchObject({ code: 'remote-access/denied' })
    expect(await h.chats.snapshot()).toEqual(before)
    expect(save).not.toHaveBeenCalled()
  })

  it('preserves the saved assignment after a failed grouping-only write and allows retry', async () => {
    const h = await setup()
    const writer = (await h.team.createBot({ name: 'Writer' })).bot
    const group = (await h.team.createGroup({ name: 'Shared' })).group
    const chat = (await h.chats.createChat({ name: 'Editorial', memberIds: [writer.id] })).chat
    const path = join(h.root, 'storage', `${chatsDomainSpec.name}.json`)
    const previous = await readFile(path, 'utf8')
    const before = await h.chats.snapshot()
    const domain = h.ctx.storageDomain.get(chatsDomainSpec.name)!
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Fixture grouping write failed'))
    await expect(h.chats.updateChat({ id: chat.id, groupId: group.id })).rejects.toThrow('Fixture grouping write failed')
    expect(await h.chats.snapshot()).toEqual(before)
    expect(await readFile(path, 'utf8')).toBe(previous)
    expect((await h.chats.updateChat({ id: chat.id, groupId: group.id })).chat).toEqual({ ...chat, groupId: group.id })
  })

  it('allows a grouping-only move while members are working without changing the active run', async () => {
    const h = await setup()
    const writer = (await h.team.createBot({ name: 'Writer' })).bot
    const group = (await h.team.createGroup({ name: 'Shared' })).group
    const chat = (await h.chats.createChat({ name: 'Editorial', memberIds: [writer.id] })).chat
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const stream = h.adapter.stream.bind(h.adapter)
    vi.spyOn(h.adapter, 'stream').mockImplementationOnce(async function* (request) {
      entered.resolve(undefined)
      await release.promise
      yield* stream(request)
    })
    await h.chats.sendMessage(prompt(chat, '@Writer draft the deliverable.'), new AbortController().signal)
    await entered.promise
    try {
      const running = (await h.chats.snapshot()).chats[0]!
      const moved = (await h.chats.updateChat({ id: chat.id, groupId: group.id })).chat
      expect(moved).toEqual({ ...running, groupId: group.id })
      await expect(h.chats.updateChat({ id: chat.id, groupId: chatGroupId, name: 'Busy rename' }))
        .rejects.toMatchObject({ code: 'gateway/bad-request' })
    } finally { release.resolve(undefined) }
    await settled(h.chats, chat.id)
    expect((await h.chats.snapshot()).chats[0]?.groupId).toBe(group.id)
    expect(h.adapter.requests).toHaveLength(1)
  })

  it('recovers a combined rename and group move from its accepted settings target', async () => {
    const first = await setup()
    const writer = (await first.team.createBot({ name: 'Writer' })).bot
    const group = (await first.team.createGroup({ name: 'Shared' })).group
    const chat = (await first.chats.createChat({ name: 'Editorial', memberIds: [writer.id] })).chat
    const domain = first.ctx.storageDomain.get(chatsDomainSpec.name)!
    const set = domain.global.set.bind(domain.global)
    let writes = 0
    vi.spyOn(domain.global, 'set').mockImplementation(async (value) => {
      writes += 1
      if (writes === 2) throw new Error('Fixture moved rename publication failed')
      await set(value)
    })
    await expect(first.chats.updateChat({ id: chat.id, name: 'Publishing', groupId: group.id }))
      .rejects.toThrow('Fixture moved rename publication failed')
    expect(stateOf(first).pendingChat?.chat).toMatchObject({ id: chat.id, name: 'Publishing', groupId: group.id })
    await first.close()
    const second = await setup(first.root)
    expect((await second.chats.snapshot()).chats[0]).toEqual({ ...chat, name: 'Publishing', groupId: group.id })
    expect(stateOf(second).pendingChat).toBeNull()
    expect(second.create).not.toHaveBeenCalled()
    expect(second.adapter.requests).toEqual([])
  })

  it('creates a separate transcript and per-member execution Session in one group Workspace', async () => {
    const h = await setup()
    const writer = (await h.team.createBot({ name: 'Writer' })).bot
    const created = await h.chats.createChat({ name: 'Editorial', memberIds: [writer.id] })
    const chat = created.chat
    expect(chat).toMatchObject({ groupId: chatGroupId, memberIds: [writer.id], managerId: null, memberRoles: [], relayLimit: 2, status: 'active', generation: 0, run: null })
    expect(chat.rootSessionId).not.toBe((await h.team.snapshot()).bots[0]?.sessionId)
    expect(chat.executors[0]?.sessionId).not.toBe(writer.sessionId)
    expect(chat.workDir).toBe(join(h.root, 'workspaces', 'chats', chat.id))
    const groupSessions = [chat.rootSessionId, ...chat.executors.map(executor => executor.sessionId)]
    for (const sessionId of groupSessions) expect(h.ctx.agents.get(sessionId)?.session.header.cwd).toBe(chat.workDir)
    const workspace = await h.ctx.workspaceRegistry.resolveByPath(chat.workDir)
    expect(workspace?.sessionIds.toSorted()).toEqual(groupSessions.sort())
    const another = (await h.chats.createChat({ name: 'Another', memberIds: [writer.id] })).chat
    expect(another.executors[0]?.sessionId).not.toBe(chat.executors[0]?.sessionId)
    expect((await h.team.snapshot()).bots).toHaveLength(2)
  })

  it('retains an accepted creation target and reuses all identities after provisioning fails', async () => {
    const h = await setup()
    const writer = (await h.team.createBot({ name: 'Writer' })).bot
    h.create.mockRejectedValueOnce(new Error('Fixture group provisioning failed'))
    const request = { name: 'Editorial', memberIds: [writer.id] }
    await expect(h.chats.createChat(request)).rejects.toThrow('Fixture group provisioning failed')
    const domain = h.ctx.storageDomain.get(chatsDomainSpec.name)!
    const pending = chatsStateSchema.parse(domain.global.get()).pendingChat!.chat
    expect(chatsStateSchema.parse(domain.global.get()).chats).toEqual([])
    const result = await h.chats.createChat(request)
    expect(result.chat).toEqual(pending)
    expect(result.snapshot.chats).toHaveLength(1)
    expect(chatsStateSchema.parse(domain.global.get()).pendingChat).toBeNull()
  })

  it('recovers a failed final publication after cold reopen without duplicate Sessions or greetings', async () => {
    const first = await setup()
    const writer = (await first.team.createBot({ name: 'Writer' })).bot
    const domain = first.ctx.storageDomain.get(chatsDomainSpec.name)!
    const set = domain.global.set.bind(domain.global)
    let writes = 0
    vi.spyOn(domain.global, 'set').mockImplementation(async (value) => {
      writes += 1
      if (writes === 2) throw new Error('Fixture group publication failed')
      await set(value)
    })
    await expect(first.chats.createChat({ name: 'Editorial', memberIds: [writer.id] })).rejects.toThrow('Fixture group publication failed')
    const pending = chatsStateSchema.parse(domain.global.get()).pendingChat!.chat
    const sessions = [pending.rootSessionId, ...pending.executors.map(executor => executor.sessionId)]
    await first.close()
    const second = await setup(first.root)
    expect((await second.chats.snapshot()).chats).toEqual([pending])
    expect(second.create).not.toHaveBeenCalled()
    for (const id of sessions) {
      const stored = await second.ctx.sessionPersistence.stat(id)
      expect(stored?.header.cwd).toBe(pending.workDir)
    }
    expect(second.adapter.requests).toEqual([])
  })

  it('recovers renamed Session titles while preserving current run progress and member history', async () => {
    const h = await setup()
    const writer = (await h.team.createBot({ name: 'Writer' })).bot
    const chat = (await h.chats.createChat({ name: 'Editorial', memberIds: [writer.id] })).chat
    const domain = h.ctx.storageDomain.get(chatsDomainSpec.name)!
    const set = domain.global.set.bind(domain.global)
    let writes = 0
    vi.spyOn(domain.global, 'set').mockImplementation(async (value) => {
      writes += 1
      if (writes === 2) throw new Error('Fixture group rename publication failed')
      await set(value)
    })
    await expect(h.chats.updateChat({ id: chat.id, name: 'Publishing', relayLimit: 4 })).rejects.toThrow('Fixture group rename publication failed')
    const pending = chatsStateSchema.parse(domain.global.get())
    expect(pending.chats[0]?.name).toBe('Editorial')
    expect(pending.pendingChat?.chat.name).toBe('Publishing')
    const paused = { ...pending.chats[0]!, status: 'paused' as const, pauseReason: 'owner' }
    await set({ ...pending, chats: [paused] })
    const recovered = (await h.chats.snapshot()).chats[0]!
    expect(recovered).toMatchObject({ name: 'Publishing', relayLimit: 4, status: 'paused', pauseReason: 'owner', rootSessionId: chat.rootSessionId })
    expect(h.ctx.sessionTitle.get(h.ctx.agents.get(chat.rootSessionId)!.session)?.title).toBe('Publishing')
    expect(recovered.executors).toEqual(chat.executors)
  })

  it('validates member membership and limit settings without accepting invalid group writes', async () => {
    const h = await setup()
    const writer = (await h.team.createBot({ name: 'Writer' })).bot
    const before = await h.chats.snapshot()
    for (const request of [
      { name: 'Empty', memberIds: [] },
      { name: 'Main only', memberIds: [mainBotId] },
      { name: 'Creator added', memberIds: [writer.id, mainBotId] },
      { name: 'Duplicate', memberIds: [writer.id, writer.id] },
      { name: 'Outside manager', memberIds: [writer.id], managerId: mainBotId },
      { name: 'Unknown', memberIds: [brandString<BotId>('missing')] },
      { name: ' ', memberIds: [writer.id] },
      { name: 'Zero', memberIds: [writer.id], relayLimit: 0 },
      { name: 'Fraction', memberIds: [writer.id], relayLimit: 1.5 },
    ]) await expect(h.chats.createChat(request)).rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(await h.chats.snapshot()).toEqual(before)
    const chat = (await h.chats.createChat({ name: 'Editorial', memberIds: [writer.id] })).chat
    await expect(h.chats.updateChat({ id: chat.id, memberIds: [mainBotId, writer.id] })).rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect((await h.chats.snapshot()).chats[0]).toEqual(chat)
  })

  it('retains removed execution history and reuses its binding when the member is added again', async () => {
    const h = await setup()
    const writer = (await h.team.createBot({ name: 'Writer' })).bot
    const coder = (await h.team.createBot({ name: 'Coder' })).bot
    const chat = (await h.chats.createChat({ name: 'Editorial', memberIds: [writer.id, coder.id] })).chat
    const removed = (await h.chats.updateChat({ id: chat.id, memberIds: [writer.id] })).chat
    expect(removed.executors).toEqual(chat.executors)
    expect(removed.memberIds).toEqual([writer.id])
    const restored = (await h.chats.updateChat({ id: chat.id, memberIds: [writer.id, coder.id] })).chat
    expect(restored.executors).toEqual(chat.executors)
  })

  it('keeps dispatching after each group settings change', async () => {
    const h = await setup()
    const writer = (await h.team.createBot({ name: 'Writer' })).bot
    const reviewer = (await h.team.createBot({ name: 'Reviewer' })).bot
    const group = (await h.team.createGroup({ name: 'Shared' })).group
    const chat = (await h.chats.createChat({ name: 'Editorial', memberIds: [writer.id] })).chat
    const changes: readonly { label: string; request: UpdateChatRequest; recipient: string }[] = [
      { label: 'name', request: { id: chat.id, name: 'Renamed' }, recipient: 'Writer' },
      { label: 'add member', request: { id: chat.id, memberIds: [writer.id, reviewer.id] }, recipient: 'Reviewer' },
      { label: 'manager', request: { id: chat.id, managerId: reviewer.id }, recipient: 'Writer' },
      { label: 'member role', request: { id: chat.id, memberRoles: [{ botId: writer.id, role: 'Draft reports.' }] }, recipient: 'Writer' },
      { label: 'relay limit', request: { id: chat.id, relayLimit: 4 }, recipient: 'Writer' },
      { label: 'handoff display', request: { id: chat.id, showHandoffRecords: false }, recipient: 'Writer' },
      { label: 'group section', request: { id: chat.id, groupId: group.id }, recipient: 'Writer' },
      { label: 'remove member', request: { id: chat.id, memberIds: [writer.id] }, recipient: 'Writer' },
    ]
    for (const [index, change] of changes.entries()) {
      const saved = (await h.chats.updateChat(change.request)).chat
      await h.chats.sendMessage(prompt(saved, `@${change.recipient} Continue after ${change.label}.`,
        `settings-followup-${index}`), new AbortController().signal)
      await settled(h.chats, chat.id)
      const snapshot = await h.chats.snapshot()
      expect(snapshot.chats[0], change.label).toMatchObject({ status: 'active', pauseReason: null, run: null, error: null })
      expect(snapshot.deliveries.at(-1), change.label).toMatchObject({
        botId: change.recipient === 'Reviewer' ? reviewer.id : writer.id,
        state: 'completed', receipt: { text: 'Fixture response' },
      })
      expect(h.adapter.requests, change.label).toHaveLength(index + 1)
    }
  })

  it('carries queued workspace context into the next group task without treating it as work', async () => {
    const h = await setup()
    const writer = (await h.team.createBot({ name: 'Writer' })).bot
    const chat = (await h.chats.createChat({ name: 'Editorial', memberIds: [writer.id] })).chat
    const worker = h.ctx.agents.get(chat.executors[0]!.sessionId)!
    const instructions = createUserMessage({ content: [{ type: 'text', text: 'Workspace instructions were updated.' }],
      source: { kind: 'agent-instructions', form: 'instructions', changes: [] } })
    const directory = createUserMessage({ content: [{ type: 'text', text: 'The working directory changed.' }],
      source: { kind: 'working-directory' } })
    for (const [index, context] of [instructions, directory].entries()) {
      worker.inject(context)
      expect(worker.status).toBe('idle')
      expect(worker.inbox.nextStep.map(message => message.id)).toEqual([context.id])
      await h.chats.sendMessage(prompt(chat, '@Writer Continue after the workspace update.',
        `workspace-context-followup-${index}`), new AbortController().signal)
      await settled(h.chats, chat.id)
      const snapshot = await h.chats.snapshot()
      expect(snapshot.chats[0], context.source.kind)
        .toMatchObject({ status: 'active', pauseReason: null, run: null, error: null })
      expect(snapshot.deliveries.at(-1), context.source.kind)
        .toMatchObject({ state: 'completed', receipt: { text: 'Fixture response' } })
      expect(h.adapter.requests).toHaveLength(index + 1)
      expect(h.adapter.requests[index]!.messages.some(message => message.id === context.id)).toBe(true)
    }
    const speech = (events: ReturnType<typeof worker.session.snapshotEvents>) => events.flatMap(event =>
      event.type === 'user/message' ? [{ source: event.data.source.kind,
        text: event.data.source.kind === 'katcats-group-task' ? '[saved group task]'
          : event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') }] : [])
    expect({ member: speech(worker.session.snapshotEvents()),
      group: speech(h.ctx.agents.get(chat.rootSessionId)!.session.snapshotEvents()) }).toMatchSnapshot()
  })

  it('still blocks a real queued task beside workspace context', async () => {
    const h = await setup()
    const writer = (await h.team.createBot({ name: 'Writer' })).bot
    const chat = (await h.chats.createChat({ name: 'Editorial', memberIds: [writer.id] })).chat
    const worker = h.ctx.agents.get(chat.executors[0]!.sessionId)!
    const context = createUserMessage({ content: [{ type: 'text', text: 'Workspace instructions were updated.' }],
      source: { kind: 'agent-instructions', form: 'instructions', changes: [] } })
    const pending = createUserMessage({ content: [{ type: 'text', text: 'An earlier task is still pending.' }],
      source: { kind: 'user' } })
    worker.inject(context)
    worker.inject(pending)
    await h.chats.sendMessage(prompt(chat, '@Writer Do not overlap the queued task.', 'real-work-followup'),
      new AbortController().signal)
    await settled(h.chats, chat.id)
    const snapshot = await h.chats.snapshot()
    expect(snapshot.chats[0]).toMatchObject({ status: 'paused', pauseReason: 'member-failed',
      error: { code: 'KATCATS_CHAT_EXECUTOR_BUSY' } })
    expect(snapshot.deliveries[0]).toMatchObject({ state: 'failed', error: { code: 'KATCATS_CHAT_EXECUTOR_BUSY' } })
    expect(worker.inbox.nextStep.map(message => message.id)).toEqual([context.id, pending.id])
    expect(h.adapter.requests).toEqual([])
  })

  it('rejects stale controls and stops only the displayed group generation', async () => {
    const h = await setup()
    const writer = (await h.team.createBot({ name: 'Writer' })).bot
    const chat = (await h.chats.createChat({ name: 'Editorial', memberIds: [writer.id] })).chat
    const paused = (await h.chats.pause(control(chat))).chat
    expect(paused.status).toBe('paused')
    const before = await h.chats.snapshot()
    await expect(h.chats.stop({ ...control(paused), expectedGeneration: 99 })).rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(await h.chats.snapshot()).toEqual(before)
    const stopped = (await h.chats.stop(control(paused))).chat
    expect(stopped).toMatchObject({ status: 'stopped', generation: 1, run: null })
    expect((await h.chats.snapshot()).activities[0]).toMatchObject({ processing: false, runningBotIds: [], pendingControl: null })
  })

  it('reports actual member activity while the transcript makes no model request', async () => {
    const h = await setup()
    const writer = (await h.team.createBot({ name: 'Writer' })).bot
    const chat = (await h.chats.createChat({ name: 'Editorial', memberIds: [writer.id] })).chat
    const abort = new AbortController()
    const stream = h.chats.follow(abort.signal)[Symbol.asyncIterator]()
    const opening = await stream.next()
    if (opening.done) throw new Error('Expected the group baseline')
    const changed = stream.next()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const streamResponse = h.adapter.stream.bind(h.adapter)
    vi.spyOn(h.adapter, 'stream').mockImplementationOnce(async function* (request) {
      entered.resolve(undefined)
      await release.promise
      yield* streamResponse(request)
    })
    await h.chats.sendMessage(prompt(chat, '@Writer draft a plan.'), new AbortController().signal)
    const frame = await changed
    if (frame.done) throw new Error('Expected an activity replacement')
    expect(frame.value.type).toBe('replace')
    expect(frame.value.value.revision).toBeGreaterThanOrEqual(opening.value.value.revision)
    await entered.promise
    release.resolve(undefined)
    await settled(h.chats, chat.id)
    abort.abort()
    await stream.return?.()
    expect(h.adapter.requests.at(-1)?.messages.filter(message => message.role === 'system')
      .flatMap(message => message.content.filter(part => part.type === 'text').map(part => part.text)).join('\n'))
      .toContain('Editorial')
    expect(h.adapter.requests).toHaveLength(1)
    expect(h.adapter.requests[0]?.sessionId).toBe(chat.executors[0]?.sessionId)
    expect((await h.ctx.sessionController.inspect(chat.rootSessionId)).events.some(event => event.type === 'request/header')).toBe(false)
    expect(h.ctx.agents.get(writer.sessionId)!.session.snapshotEvents().some(event => event.type === 'user/message')).toBe(false)
  })

  it('reuses a saved request retry and rejects changed content without making another member request', async () => {
    const h = await setup()
    const writer = (await h.team.createBot({ name: 'Writer' })).bot
    const chat = (await h.chats.createChat({ name: 'Editorial', memberIds: [writer.id] })).chat
    const request = prompt(chat, '@Writer hello.')
    await h.chats.sendMessage(request, new AbortController().signal)
    await settled(h.chats, chat.id)
    const before = await h.chats.snapshot()
    const inputs = stateOf(h).inbounds
    await h.chats.sendMessage(request, new AbortController().signal)
    await settled(h.chats, chat.id)
    await expect(h.chats.sendMessage({ ...request, content: [{ type: 'text', text: 'Changed content' }] }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    const after = await h.chats.snapshot()
    expect(stateOf(h).inbounds).toEqual(inputs)
    expect(after.deliveries).toEqual(before.deliveries)
    expect(h.adapter.requests).toHaveLength(1)
  })

  it('publishes an accepted owner message after a cold interruption without starting any member', async () => {
    const first = await setup()
    const writer = (await first.team.createBot({ name: 'Writer' })).bot
    const chat = (await first.chats.createChat({ name: 'Editorial', memberIds: [writer.id] })).chat
    const interrupted = vi.spyOn(GroupTranscript.prototype, 'publishUser').mockRejectedValueOnce(new Error('Fixture publication interrupted'))
    await expect(first.chats.sendMessage(prompt(chat, '@Writer retained owner message.'), new AbortController().signal))
      .rejects.toThrow('Fixture publication interrupted')
    interrupted.mockRestore()
    expect(stateOf(first).inbounds[0]?.state).toBe('accepted')
    await first.close()
    const second = await setup(first.root)
    const state = await second.chats.snapshot()
    expect(state.chats[0]).toMatchObject({ id: chat.id, status: 'paused', pauseReason: 'restart' })
    expect(stateOf(second).inbounds[0]?.state).toBe('published')
    expect(state.deliveries).toEqual([])
    const root = await second.ctx.sessionController.inspect(chat.rootSessionId)
    expect(root.events.filter(event => event.type === 'user/message')).toHaveLength(1)
    expect(root.events.some(event => event.type === 'turn/start' || event.type === 'request/header')).toBe(false)
    expect(second.adapter.requests).toEqual([])
  })

  it('keeps slow image admission outside the directory queue and refuses its stale commit after Stop', async () => {
    const h = await setup()
    const writer = (await h.team.createBot({ name: 'Writer' })).bot
    const first = (await h.chats.createChat({ name: 'First', memberIds: [writer.id] })).chat
    const other = (await h.chats.createChat({ name: 'Other', memberIds: [writer.id] })).chat
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const resolve = h.ctx.llm.resolveModelInfo.bind(h.ctx.llm)
    vi.spyOn(h.ctx.llm, 'resolveModelInfo').mockImplementationOnce(async (...args) => {
      entered.resolve(undefined); await release.promise
      return resolve(...args)
    })
    const pending = h.chats.sendMessage({ ...prompt(first, '@Writer inspect the image.'), content: [
      { type: 'text', text: '@Writer inspect the image.' }, { type: 'image', mediaType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC' },
    ] }, new AbortController().signal)
    const refused = expect(pending).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await entered.promise
    try {
      await h.chats.sendMessage(prompt(other, '@Writer hello in another group.', 'other-group'), new AbortController().signal)
      await settled(h.chats, other.id)
      expect((await h.chats.stop(control(first))).chat.status).toBe('stopped')
    } finally { release.resolve(undefined) }
    await refused
    expect(stateOf(h).inbounds.map(input => input.chatId)).toEqual([other.id])
    expect(h.adapter.requests).toHaveLength(1)
    expect(h.adapter.requests[0]?.sessionId).toBe(other.executors[0]?.sessionId)
  })

  it.each([
    '@"Reviewer"',
    '@"AI时代共享服务 蓝皮书 @Missing.pdf"',
    '@E:/synthetic/蓝皮书.pdf',
    '@"@[Not a member](katcats-member:foreign/outside)"',
    '@"@[Old session](dsh-session:foreign-session)"',
    '@"relative/draft.md" Please review this file.',
  ])('routes a file reference to the responsible member without interpreting its filename as member addressing: %s', async (text) => {
    const h = await setup()
    const first = (await h.team.createBot({ name: 'Reviewer' })).bot
    const second = (await h.team.createBot({ name: 'Reviewer' })).bot
    const chat = (await h.chats.createChat({ name: 'Attachments', memberIds: [first.id, second.id] })).chat
    await h.chats.sendMessage(prompt(chat, text), new AbortController().signal)
    await settled(h.chats, chat.id)
    expect(stateOf(h).inbounds).toMatchObject([{ recipients: [first.id], addressing: 'broadcast',
      userMessage: { content: [{ type: 'text', text }] } }])
    expect(h.adapter.requests.map(request => request.sessionId)).toEqual([chat.executors[0]!.sessionId])
    const history = (await h.ctx.sessionController.inspect(chat.rootSessionId)).events
    expect(history.some(event => event.type === 'turn/start')).toBe(false)
    if (text === '@"Reviewer"') {
      const event = history.find(value => value.type === 'user/message')
      if (event?.type !== 'user/message') throw new Error('Synthetic owner message is missing')
      expect({ type: event.type, content: event.data.content, source: event.data.source,
        addressedNames: stateOf(h).inbounds[0]!.recipients.map(id => [first, second].find(bot => bot.id === id)?.name),
      }).toMatchInlineSnapshot(`
        {
          "addressedNames": [
            "Reviewer",
          ],
          "content": [
            {
              "text": "@\"Reviewer\"",
              "type": "text",
            },
          ],
          "source": {
            "kind": "user",
            "rpcId": "group-fixture-request",
          },
          "type": "user/message",
        }
      `)
    }
  })

  it.each([false, true])('admits staged attachment input with optional text without using a duplicate member name: %s', async (withText) => {
    const h = await setup()
    const first = (await h.team.createBot({ name: 'Reviewer' })).bot
    const second = (await h.team.createBot({ name: 'Reviewer' })).bot
    const chat = (await h.chats.createChat({ name: 'Uploads', memberIds: [first.id, second.id] })).chat
    const container = await h.ctx.sessionController.resolveAgent(chat.rootSessionId)
    if ('error' in container) throw container.error
    const upload = await h.ctx.fileUploads.upload(container.agent, {
      name: 'Reviewer', data: Buffer.from('Synthetic attachment contents.').toString('base64'),
    }, new AbortController().signal)
    const request: SessionPromptRequest = { ...prompt(chat, ''), content: [
      { type: 'file', receiptId: upload.receiptId },
      ...withText ? [{ type: 'text' as const, text: 'Please review the attachment.' }] : [],
    ] }
    await h.chats.sendMessage(request, new AbortController().signal)
    await settled(h.chats, chat.id)
    const input = stateOf(h).inbounds[0]!
    expect(input).toMatchObject({ recipients: [first.id], addressing: 'broadcast' })
    expect(input.userMessage.content.map(part => part.type)).toEqual(withText ? ['file', 'text'] : ['file'])
    expect(input.userMessage.content[0]).toMatchObject({ type: 'file', attachment: { name: 'Reviewer' } })
    expect(h.ctx.fileUploads.resolve(container.agent, upload.receiptId)).toBeUndefined()
    expect(h.adapter.requests.map(value => value.sessionId)).toEqual([chat.executors[0]!.sessionId])
  })

  it('keeps real spaced member addressing and refuses unknown, ambiguous and foreign mentions beside file references', async () => {
    const h = await setup()
    const writer = (await h.team.createBot({ name: 'Content writer' })).bot
    const first = (await h.team.createBot({ name: 'Reviewer' })).bot
    const second = (await h.team.createBot({ name: 'Reviewer' })).bot
    const chat = (await h.chats.createChat({ name: 'Review', memberIds: [writer.id, first.id, second.id] })).chat
    await h.chats.sendMessage(prompt(chat, '@"Content writer" @Content writer Review this file.'), new AbortController().signal)
    await settled(h.chats, chat.id)
    expect(stateOf(h).inbounds[0]).toMatchObject({ recipients: [writer.id], addressing: 'explicit' })
    const requests = h.adapter.requests.length
    for (const [index, mention] of ['@Missing', '@Reviewer', formatMemberMention({
      chatId: brandString<ChatControlRequest['id']>('foreign'), botId: first.id, label: first.name,
    })].entries()) {
      await expect(h.chats.sendMessage(prompt(chat, `@"Reviewer" ${mention} Review this file.`, `file-mention-${String(index)}`),
        new AbortController().signal)).rejects.toMatchObject({ code: 'gateway/bad-request' })
    }
    expect(stateOf(h).inbounds).toHaveLength(1)
    expect(h.adapter.requests).toHaveLength(requests)
  })

  it('uses canonical Bot mentions only as identity and rejects private conversations outside the group', async () => {
    const h = await setup()
    const writer = (await h.team.createBot({ name: 'Writer' })).bot
    const other = (await h.team.createBot({ name: 'Outside' })).bot
    const chat = (await h.chats.createChat({ name: 'Editorial', memberIds: [writer.id] })).chat
    const reference = formatSessionReferenceMention({ sessionId: writer.sessionId, label: writer.name })
    await h.chats.sendMessage(prompt(chat, `${reference} hello.`), new AbortController().signal)
    await settled(h.chats, chat.id)
    expect(stateOf(h).inbounds[0]).toMatchObject({ recipients: [writer.id], addressing: 'explicit' })
    const requests = h.adapter.requests.length
    await expect(h.chats.sendMessage(prompt(chat, formatSessionReferenceMention({ sessionId: other.sessionId }), 'outside'), new AbortController().signal))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(h.chats.sendMessage(prompt(chat, '@Missing hello.', 'missing'), new AbortController().signal))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(h.chats.sendMessage(prompt(chat, '@WriterOutside hello.', 'prefix'), new AbortController().signal))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(h.adapter.requests).toHaveLength(requests)
    expect(stateOf(h).inbounds).toHaveLength(1)
    expect((await h.ctx.sessionController.inspect(writer.sessionId)).events.some(event => event.type === 'user/message')).toBe(false)
  })

  it('routes product member links by group and Bot identity even when names are equal, without reading private Sessions', async () => {
    const h = await setup()
    const first = (await h.team.createBot({ name: 'Editor' })).bot
    const second = (await h.team.createBot({ name: 'Editor' })).bot
    const chat = (await h.chats.createChat({ name: 'Editorial', memberIds: [first.id, second.id] })).chat
    const inspect = vi.spyOn(h.ctx.sessionController, 'inspect')
    const reference = formatMemberMention({ chatId: chat.id, botId: second.id, label: second.name })
    await h.chats.sendMessage(prompt(chat, `${reference} review this draft.`), new AbortController().signal)
    await settled(h.chats, chat.id)
    expect(stateOf(h).inbounds[0]).toMatchObject({ recipients: [second.id], addressing: 'explicit' })
    expect(h.adapter.requests).toHaveLength(1)
    expect(h.adapter.requests[0]?.sessionId).toBe(chat.executors.find(value => value.botId === second.id)?.sessionId)
    expect(inspect.mock.calls.some(([id]) => id === first.sessionId || id === second.sessionId)).toBe(false)
    expect(h.ctx.agents.get(first.sessionId)!.session.snapshotEvents().some(event => event.type === 'user/message')).toBe(false)
    expect(h.ctx.agents.get(second.sessionId)!.session.snapshotEvents().some(event => event.type === 'user/message')).toBe(false)
    const stored = stateOf(h).inbounds[0]!.userMessage.content
    expect(stored).toEqual([{ type: 'text', text: `${reference} review this draft.` }])
    expect(JSON.stringify(stored)).not.toContain('dsh-session:')
  })

  it('rejects foreign, creator, removed and malformed member links before accepting or running work', async () => {
    const h = await setup()
    const writer = (await h.team.createBot({ name: 'Writer' })).bot
    const reviewer = (await h.team.createBot({ name: 'Reviewer' })).bot
    const outsider = (await h.team.createBot({ name: 'Outside' })).bot
    const chat = (await h.chats.createChat({ name: 'Editorial', memberIds: [writer.id, reviewer.id] })).chat
    const other = (await h.chats.createChat({ name: 'Another', memberIds: [writer.id] })).chat
    await h.chats.updateChat({ id: chat.id, memberIds: [reviewer.id] })
    const denied = [
      formatMemberMention({ chatId: other.id, botId: writer.id, label: writer.name }),
      formatMemberMention({ chatId: chat.id, botId: mainBotId, label: 'Katcats' }),
      formatMemberMention({ chatId: chat.id, botId: outsider.id, label: outsider.name }),
      formatMemberMention({ chatId: chat.id, botId: writer.id, label: writer.name }),
      '@[Reviewer](katcats-member:%/invalid)',
      '@[Reviewer](katcats-member:missing/invalid/extra)',
    ]
    for (const [index, text] of denied.entries()) {
      await expect(h.chats.sendMessage(prompt(chat, `${text} hello.`, `denied-${String(index)}`), new AbortController().signal))
        .rejects.toMatchObject({ code: 'gateway/bad-request' })
    }
    expect(stateOf(h).inbounds).toEqual([])
    expect(h.adapter.requests).toEqual([])
    expect((await h.ctx.sessionController.inspect(chat.rootSessionId)).events.some(event => event.type === 'user/message')).toBe(false)
  })

  it('rechecks a selected member after slow attachment admission and refuses a member removed before durable acceptance', async () => {
    const h = await setup()
    const writer = (await h.team.createBot({ name: 'Writer' })).bot
    const reviewer = (await h.team.createBot({ name: 'Reviewer' })).bot
    const chat = (await h.chats.createChat({ name: 'Editorial', memberIds: [writer.id, reviewer.id] })).chat
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const resolve = h.ctx.llm.resolveModelInfo.bind(h.ctx.llm)
    vi.spyOn(h.ctx.llm, 'resolveModelInfo').mockImplementationOnce(async (...args) => {
      entered.resolve(undefined)
      await release.promise
      return resolve(...args)
    })
    const mention = formatMemberMention({ chatId: chat.id, botId: writer.id, label: writer.name })
    const request: SessionPromptRequest = { ...prompt(chat, mention), content: [
      { type: 'text', text: `${mention} inspect the image.` },
      { type: 'image', mediaType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC' },
    ] }
    const pending = h.chats.sendMessage(request, new AbortController().signal)
    const refused = expect(pending).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await entered.promise
    try { await h.chats.updateChat({ id: chat.id, memberIds: [reviewer.id] }) }
    finally { release.resolve(undefined) }
    await refused
    expect(stateOf(h).inbounds).toEqual([])
    expect(h.adapter.requests).toEqual([])
    expect((await h.ctx.sessionController.inspect(chat.rootSessionId)).events.some(event => event.type === 'user/message')).toBe(false)
  })

  it('rejects group transport calls for private or internal member Sessions', async () => {
    const h = await setup()
    const writer = (await h.team.createBot({ name: 'Writer' })).bot
    const chat = (await h.chats.createChat({ name: 'Editorial', memberIds: [writer.id] })).chat
    for (const sessionId of [writer.sessionId, chat.executors[0]!.sessionId]) {
      await expect(h.chats.sendMessage({ ...prompt(chat, 'hello'), sessionId }, new AbortController().signal))
        .rejects.toMatchObject({ code: 'gateway/bad-request' })
      await expect(h.chats.cancelSession({ sessionId })).rejects.toMatchObject({ code: 'gateway/bad-request' })
    }
    expect(stateOf(h).inbounds).toEqual([])
    expect(h.adapter.requests).toEqual([])
  })

  it('keeps the creator outside groups while allowing it to create them', async () => {
    const h = await setup()
    const writer = (await h.team.createBot({ name: 'Writer' })).bot
    const main = h.ctx.agents.get((await h.team.snapshot()).bots[0]!.sessionId)!
    const ordinary = h.ctx.agents.get(writer.sessionId)!
    expect(h.ctx.tools.get('create_group_chat', ordinary)).toBeUndefined()
    expect(h.ctx.tools.get('create_group_chat', main)).toBeDefined()
    expect(h.ctx.tools.get('list_group_chats', main)).toBeDefined()
    expect(h.ctx.tools.get('set_group_roles', main)).toBeUndefined()
    expect(h.ctx.tools.get('set_group_roles', ordinary)).toBeUndefined()
    const { chat } = await h.chats.createChat({ name: 'Editorial', memberIds: [writer.id] })
    expect(main.id).not.toBe(chat.rootSessionId)
    expect(chat.memberIds).not.toContain(mainBotId)
    expect((await h.chats.snapshot()).chats).toHaveLength(1)
  })

  it('keeps manager and responsibilities group-local and clears a removed manager', async () => {
    const h = await setup()
    const writer = (await h.team.createBot({ name: 'Writer' })).bot
    const reviewer = (await h.team.createBot({ name: 'Reviewer' })).bot
    const before = await h.team.snapshot()
    const { chat } = await h.chats.createChat({ name: 'Editorial', memberIds: [writer.id, reviewer.id], managerId: writer.id })
    expect(chat.managerId).toBe(writer.id)
    const next = (await h.chats.updateChat({ id: chat.id, managerId: reviewer.id,
      memberRoles: [{ botId: writer.id, role: 'Draft articles.' }, { botId: reviewer.id, role: 'Coordinate reviews.' }] })).chat
    expect(next.managerId).toBe(reviewer.id)
    expect(next.memberRoles).toHaveLength(2)
    expect(await h.team.snapshot()).toEqual(before)
    const other = (await h.chats.createChat({ name: 'Other', memberIds: [writer.id, reviewer.id] })).chat
    expect(other).toMatchObject({ managerId: null, memberRoles: [] })
    const removed = (await h.chats.updateChat({ id: chat.id, memberIds: [writer.id] })).chat
    expect(removed).toMatchObject({ managerId: null, memberRoles: [{ botId: writer.id, role: 'Draft articles.' }] })
    await expect(h.chats.updateChat({ id: chat.id, managerId: reviewer.id })).rejects.toMatchObject({ code: 'gateway/bad-request' })
  })

  it('denies every owner operation before revealing group metadata to another principal', async () => {
    const h = await setup()
    const limited = h.ctx.extend({ invocation: { peer: { principal: { kind: 'limited-fixture' } }, request: { namespace: 'katcatsChats', method: 'snapshot' } } }).katcatsChats
    const denied = { code: 'remote-access/denied' }
    await expect(limited.snapshot()).rejects.toMatchObject(denied)
    await expect(limited.createChat({ name: 'Denied', memberIds: [] })).rejects.toMatchObject(denied)
    const id = brandString<TeamChat['id']>('denied')
    await expect(limited.updateChat({ id, name: 'Denied' })).rejects.toMatchObject(denied)
    const request = { id, expectedRunId: null, expectedGeneration: 0 }
    await expect(limited.pause(request)).rejects.toMatchObject(denied)
    await expect(limited.resume(request)).rejects.toMatchObject(denied)
    await expect(limited.stop(request)).rejects.toMatchObject(denied)
    await expect(limited.sendMessage({ sessionId: brandString<TeamChat['rootSessionId']>('denied-session'), requestId: brandString<SessionRequestId>('denied-message'),
      mode: 'queue', content: [{ type: 'text', text: 'Denied' }] }, new AbortController().signal)).rejects.toMatchObject(denied)
    await expect(limited.cancelSession({ sessionId: brandString<TeamChat['rootSessionId']>('denied-session') })).rejects.toMatchObject(denied)
    await expect(limited.follow(new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toMatchObject(denied)
  })

  it('reads old v1 groups without rewriting them and preserves historical bindings when removing the old creator', async () => {
    const first = await setup()
    const writer = (await first.team.createBot({ name: 'Writer' })).bot
    const { chat } = await first.chats.createChat({ name: 'Legacy group', memberIds: [writer.id] })
    const currentPath = join(first.root, 'storage', `${chatsDomainSpec.name}.json`)
    const groupPath = join(first.root, 'storage', 'katcats_chats.json')
    await first.close()
    const document: unknown = JSON.parse(await readFile(currentPath, 'utf8'))
    if (typeof document !== 'object' || document === null || !('global' in document)) throw new Error('Expected group storage fixture')
    const state = chatsStateSchema.parse(document.global)
    const legacy = JSON.stringify({ ...document, unit: { name: 'katcats_chats', version: 1 }, global: { ...state, chats: state.chats.map((value) => {
      const { managerId: _manager, memberRoles: _roles, ...oldFields } = value
      return { ...oldFields, memberIds: [mainBotId, ...oldFields.memberIds] }
    }) } })
    await writeFile(groupPath, legacy)
    await rm(currentPath)
    const second = await setup(first.root)
    const restored = (await second.chats.snapshot()).chats[0]!
    expect(restored).toMatchObject({ memberIds: [mainBotId, writer.id], managerId: mainBotId,
      memberRoles: [], rootSessionId: chat.rootSessionId })
    expect(await readFile(groupPath, 'utf8')).toBe(legacy)
    const updated = (await second.chats.updateChat({ id: chat.id, memberIds: [writer.id] })).chat
    expect(updated).toMatchObject({ memberIds: [writer.id], managerId: null, rootSessionId: chat.rootSessionId, executors: chat.executors })
    await second.close()
    const third = await setup(first.root)
    expect((await third.chats.snapshot()).chats).toEqual([updated])
    expect(third.adapter.requests).toHaveLength(0)
    await expect(third.chats.updateChat({ id: chat.id, memberIds: [mainBotId, writer.id] }))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
  })

  it('rejects invalid group-local roles without changing the manager, private identity, or other settings', async () => {
    const h = await setup()
    const writer = (await h.team.createBot({ name: 'Writer' })).bot
    const { chat } = await h.chats.createChat({ name: 'Roles', memberIds: [writer.id] })
    const before = await h.chats.snapshot()
    for (const memberRoles of [
      [{ botId: mainBotId, role: 'Outside this group.' }],
      [{ botId: writer.id, role: ' ' }],
      [{ botId: writer.id, role: 'First' }, { botId: writer.id, role: 'Second' }],
    ]) await expect(h.chats.updateChat({ id: chat.id, managerId: writer.id, memberRoles }))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(await h.chats.snapshot()).toEqual(before)
    expect((await h.team.snapshot()).bots.find(bot => bot.id === writer.id)).toEqual(writer)
  })

  it('rejects corrupt group metadata at cold open without resetting it', async () => {
    const first = await setup()
    const writer = (await first.team.createBot({ name: 'Writer' })).bot
    await first.chats.createChat({ name: 'Editorial', memberIds: [writer.id] })
    const path = join(first.root, 'storage', 'katcats_chats_v3.json')
    await first.close()
    const original: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof original !== 'object' || original === null || !('global' in original)) throw new Error('Expected group storage fixture')
    const state = chatsStateSchema.parse(original.global)
    const malformed = JSON.stringify({ ...original,
      global: { ...state, chats: state.chats.map(chat => ({ ...chat, memberIds: [] })) } })
    await writeFile(path, malformed)
    await expect(setup(first.root)).rejects.toMatchObject({ code: 'invalid-record' })
    expect(await readFile(path, 'utf8')).toBe(malformed)
  })

  it('rejects a stored group binding that reuses a private conversation without changing either product record', async () => {
    const first = await setup()
    const writer = (await first.team.createBot({ name: 'Writer' })).bot
    await first.chats.createChat({ name: 'Editorial', memberIds: [writer.id] })
    const groupPath = join(first.root, 'storage', 'katcats_chats_v3.json')
    const teamPath = join(first.root, 'storage', 'katcats_team.json')
    await first.close()
    const teamBefore = await readFile(teamPath, 'utf8')
    const document: unknown = JSON.parse(await readFile(groupPath, 'utf8'))
    if (typeof document !== 'object' || document === null || !('global' in document)) throw new Error('Expected group storage fixture')
    const state = chatsStateSchema.parse(document.global)
    const mixed = JSON.stringify({ ...document,
      global: { ...state, chats: state.chats.map(chat => ({ ...chat, rootSessionId: writer.sessionId })) } })
    await writeFile(groupPath, mixed)
    await expect(setup(first.root)).rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(await readFile(groupPath, 'utf8')).toBe(mixed)
    expect(await readFile(teamPath, 'utf8')).toBe(teamBefore)
  })
})
