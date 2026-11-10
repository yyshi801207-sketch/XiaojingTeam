/** Direct-group journal parsing and real JSON storage compatibility, without user data or models. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { chatsDomainSpec, chatsStateSchema, legacyChatsDomainSpec, previousChatsDomainSpec } from '../src/chats-storage.ts'
import { openChatsDomain } from '../src/chats-migration.ts'
import { chatGroupId, mainBotId } from '../src/storage.ts'
import type { ChatDelivery, ChatDeliveryId, ChatInbound } from '../src/chats-types.ts'

const roots: string[] = []
const contexts = new Set<Context>()
afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function legacyState() {
  return {
    revision: 7,
    chats: [{
      id: 'chat-alpha', name: 'Editorial', groupId: chatGroupId, rootSessionId: 'group-transcript',
      workDir: join(tmpdir(), 'katcats-synthetic-group'), memberIds: [mainBotId, 'writer', 'reviewer'],
      executors: [{ botId: 'writer', sessionId: 'writer-executor' }, { botId: 'reviewer', sessionId: 'reviewer-executor' }],
      relayLimit: 8, generation: 1, status: 'active', pauseReason: null,
      run: { id: 'run-first', generation: 1, relayCount: 1 }, error: null,
    }],
    deliveries: [{
      id: 'delivery-old', chatId: 'chat-alpha', runId: 'run-first', generation: 1,
      sourceSessionId: 'group-transcript', turn: 3, step: 2, callId: 'provider-call-old',
      botId: 'writer', executorSessionId: 'writer-executor', message: 'Review the existing draft.',
      inputMessageId: 'worker-input-old', relayMessageId: 'group-reply-old', state: 'completed',
      receipt: { sender: { botId: 'writer', name: 'Writer', role: 'Editor', avatar: { shape: 'classic', color: '#FF2849' } },
        text: 'The draft is ready.', outputMessageId: 'worker-output-old', turn: 4, displayHint: 'retained metadata' },
      relayed: true, error: null,
    }],
    pendingChat: null,
    ownerMetadata: { retained: true },
  }
}

function directState() {
  const state = chatsStateSchema.parse(legacyState())
  const chat = state.chats[0]!
  const requestId = brandString<SessionRequestId>('request-direct')
  const userMessage: UserMessage = {
    id: brandString<MessageId>('owner-input-direct'), role: 'user',
    content: [{ type: 'text', text: 'Please review the draft.' }],
    source: { kind: 'user', rpcId: requestId, clientTimeZone: 'Asia/Shanghai' },
  }
  const inbound: ChatInbound = { requestId, requestDigest: 'a'.repeat(64), chatId: chat.id, runId: chat.run!.id, generation: 1,
    userMessage, recipients: [chat.executors[0]!.botId, chat.executors[1]!.botId], addressing: 'broadcast', state: 'accepted' }
  const delivery: ChatDelivery = { ...state.deliveries[0]!, id: brandString<ChatDeliveryId>('delivery-direct'),
    source: { kind: 'owner-message', messageId: userMessage.id },
    inputMessageId: brandString<MessageId>('worker-input-direct'), relayMessageId: brandString<MessageId>('group-reply-direct'),
    state: 'accepted', receipt: null, pass: null, relayed: false }
  return { ...state, inbounds: [inbound], deliveries: [state.deliveries[0]!, delivery] }
}

async function storageFixture(root: string) {
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([
    { name: 'cordis:storage' },
    { name: 'cordis:json', config: { root: join(root, 'storage') } },
    { name: 'cordis:domain', config: { backend: 'json' } },
  ]))
  const ctx = new Context()
  contexts.add(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, storage: Storage, json: JsonStorage, domain: StorageDomain })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return { ctx, close: async () => { await ctx.fiber.dispose(); contexts.delete(ctx) } }
}

describe('direct group journal', () => {
  it('normalizes legacy tool positions without changing Sessions, receipts, or owner metadata', () => {
    const raw = legacyState()
    const previous = structuredClone(raw)
    const parsed = chatsStateSchema.parse(raw)
    expect(raw).toEqual(previous)
    expect(parsed.inbounds).toEqual([])
    expect(parsed.chats[0]).toMatchObject({ rootSessionId: raw.chats[0]!.rootSessionId,
      executors: raw.chats[0]!.executors, managerId: mainBotId, memberRoles: [] })
    expect(parsed.deliveries[0]).toMatchObject({ receipt: raw.deliveries[0]!.receipt,
      source: { kind: 'tool', turn: 3, step: 2, callId: 'provider-call-old' }, pass: null })
    expect(parsed.deliveries[0]).not.toHaveProperty('callId')
    expect(parsed).toHaveProperty('ownerMetadata', { retained: true })
    expect(parsed.deliveries.map(({ id, source, pass, receipt }) => ({ id, source, pass, receipt }))).toMatchInlineSnapshot(`
      [
        {
          "id": "delivery-old",
          "pass": null,
          "receipt": {
            "displayHint": "retained metadata",
            "outputMessageId": "worker-output-old",
            "sender": {
              "avatar": {
                "color": "#FF2849",
                "shape": "classic",
              },
              "botId": "writer",
              "name": "Writer",
              "role": "Editor",
            },
            "text": "The draft is ready.",
            "turn": 4,
          },
          "source": {
            "callId": "provider-call-old",
            "kind": "tool",
            "step": 2,
            "turn": 3,
          },
        },
      ]
    `)
  })

  it('keeps admitted image and file references and user source metadata', () => {
    const state = directState()
    const inbound = state.inbounds[0]!
    const content = [
      { type: 'image', attachment: { attachmentId: 'image-object', mediaType: 'image/png', bytes: 42,
        width: 32, height: 24, originalDimensions: { width: 64, height: 48 }, name: 'draft.png' } },
      { type: 'file', attachment: { attachmentId: 'file-object', name: 'draft.md', bytes: 0 } },
    ]
    const parsed = chatsStateSchema.parse({ ...state, inbounds: [{ ...inbound,
      userMessage: { ...inbound.userMessage, content, source: { ...inbound.userMessage.source, displayMetadata: { retained: true } } } }] })
    expect(parsed.inbounds[0]!.userMessage.content).toEqual(content)
    expect(parsed.inbounds[0]!.userMessage.source).toMatchObject({ rpcId: inbound.requestId,
      clientTimeZone: 'Asia/Shanghai', displayMetadata: { retained: true } })
    expect(chatsStateSchema.safeParse({ ...state, inbounds: [{ ...inbound,
      userMessage: { ...inbound.userMessage, content: [{ type: 'image', attachment: { attachmentId: 'bad' } }] } }] }).success).toBe(false)
  })

  it('requires distinct ordinary recipients and a matching request identity', () => {
    const state = directState()
    const inbound = state.inbounds[0]!
    for (const recipients of [[], [mainBotId], ['writer', 'writer'], ['missing']]) {
      expect(chatsStateSchema.safeParse({ ...state, inbounds: [{ ...inbound, recipients }] }).success).toBe(false)
    }
    expect(chatsStateSchema.safeParse({ ...state, inbounds: [inbound, { ...inbound,
      userMessage: { ...inbound.userMessage, id: 'another-owner-message' } }] }).success).toBe(false)
    expect(chatsStateSchema.safeParse({ ...state, inbounds: [{ ...inbound,
      userMessage: { ...inbound.userMessage, source: { kind: 'user', rpcId: 'different-request' } } }] }).success).toBe(false)
    for (const requestDigest of [undefined, '', 'a'.repeat(63), 'g'.repeat(64)]) {
      expect(chatsStateSchema.safeParse({ ...state, inbounds: [{ ...inbound, requestDigest }] }).success).toBe(false)
    }
  })

  it('retains historical ordinary recipients after membership changes but never recruits legacy main', () => {
    const state = directState()
    expect(chatsStateSchema.parse({ ...state, chats: state.chats.map(chat => ({ ...chat,
      memberIds: [mainBotId, 'reviewer'] })) }).inbounds).toEqual(state.inbounds)
  })

  it('preserves legacy execution when the collaboration version is absent and rejects unsupported versions', () => {
    const state = directState()
    const inbound = state.inbounds[0]!
    expect(chatsStateSchema.parse(state).inbounds[0]).not.toHaveProperty('collaborationVersion')
    const updated = { ...state, inbounds: [{ ...inbound, collaborationVersion: 1 }] }
    expect(chatsStateSchema.parse(updated).inbounds[0]).toEqual(updated.inbounds[0])
    for (const collaborationVersion of [0, 2, '1', null]) {
      expect(chatsStateSchema.safeParse({ ...state, inbounds: [{ ...inbound, collaborationVersion }] }).success).toBe(false)
    }
  })

  it('requires pass evidence and keeps silence distinct from text, failure, and publication', () => {
    const state = directState()
    const delivery = state.deliveries[1]!
    const passed = { ...delivery, state: 'passed', pass: { turn: 9, callId: 'real-pass-call' } }
    expect(chatsStateSchema.parse({ ...state, deliveries: [passed] }).deliveries[0]).toEqual(passed)
    for (const invalid of [
      { ...passed, pass: null }, { ...passed, relayed: true },
      { ...passed, state: 'failed' }, { ...delivery, state: 'completed' },
      { ...passed, pass: { turn: 0, callId: 'real-pass-call' } },
    ]) expect(chatsStateSchema.safeParse({ ...state, deliveries: [invalid] }).success).toBe(false)
  })

  it('deduplicates source and target while permitting one initial delivery per member', () => {
    const state = directState()
    const delivery = state.deliveries[1]!
    const another = { ...delivery, id: 'delivery-second', inputMessageId: 'input-second', relayMessageId: 'relay-second' }
    expect(chatsStateSchema.safeParse({ ...state, deliveries: [...state.deliveries, another] }).success).toBe(false)
    expect(chatsStateSchema.safeParse({ ...state, deliveries: [...state.deliveries,
      { ...another, botId: 'reviewer', executorSessionId: 'reviewer-executor' }] }).success).toBe(true)
    expect(chatsStateSchema.safeParse({ ...state, inbounds: [] }).success).toBe(false)
  })

  it('allows real member tool handoffs and requires saved parents for member-reply sources', () => {
    const state = directState()
    const target = { ...state.deliveries[1]!, id: 'handoff-target', inputMessageId: 'handoff-input', relayMessageId: 'handoff-relay',
      botId: 'reviewer', executorSessionId: 'reviewer-executor' }
    expect(chatsStateSchema.safeParse({ ...state, deliveries: [...state.deliveries, { ...target,
      sourceSessionId: 'writer-executor', source: { kind: 'tool', turn: 7, step: 1, callId: 'real-handoff-call',
        parentDeliveryId: state.deliveries[1]!.id } }] }).success).toBe(true)
    expect(chatsStateSchema.safeParse({ ...state, deliveries: [...state.deliveries, { ...target,
      source: { kind: 'member-reply', messageId: 'group-reply-old' } }] }).success).toBe(true)
    for (const invalid of [
      { ...target, source: { kind: 'member-reply', messageId: 'unconfirmed-reply' } },
      { ...target, sourceSessionId: 'writer-executor' },
      { ...target, sourceSessionId: 'another-private-session', source: { kind: 'tool', turn: 7, step: 1, callId: 'call' } },
      { ...target, sourceSessionId: 'writer-executor', source: { kind: 'tool', turn: 7, step: 1, callId: 'call' } },
      { ...target, sourceSessionId: 'reviewer-executor', source: { kind: 'tool', turn: 7, step: 1, callId: 'call',
        parentDeliveryId: state.deliveries[1]!.id } },
      { ...target, callId: 'invented-call' },
    ]) expect(chatsStateSchema.safeParse({ ...state, deliveries: [...state.deliveries, invalid] }).success).toBe(false)
  })

  it('keeps provider call correlation scoped to its actual source Session', () => {
    const state = directState()
    const parent = state.deliveries[1]!
    const otherParent = { ...parent, id: 'reviewer-parent', botId: 'reviewer', executorSessionId: 'reviewer-executor',
      inputMessageId: 'reviewer-parent-input', relayMessageId: 'reviewer-parent-relay' }
    const source = { kind: 'tool', turn: 2, step: 1, callId: 'provider-reused-id', parentDeliveryId: parent.id }
    const first = { ...parent, id: 'handoff-first', inputMessageId: 'handoff-first-input', relayMessageId: 'handoff-first-relay',
      sourceSessionId: 'writer-executor', source }
    const second = { ...first, id: 'delivery-another-caller', sourceSessionId: 'reviewer-executor',
      source: { ...source, parentDeliveryId: otherParent.id }, inputMessageId: 'input-another-caller', relayMessageId: 'relay-another-caller' }
    expect(chatsStateSchema.safeParse({ ...state, deliveries: [parent, otherParent, first, second] }).success).toBe(true)
  })

  it('rejects cyclic handoff ancestry instead of treating another tool call as an owner message', () => {
    const state = directState()
    const first = { ...state.deliveries[1]!, sourceSessionId: 'writer-executor',
      source: { kind: 'tool', turn: 1, step: 1, callId: 'first-call', parentDeliveryId: 'cycle-second' } }
    const second = { ...first, id: 'cycle-second', inputMessageId: 'cycle-second-input', relayMessageId: 'cycle-second-relay',
      source: { kind: 'tool', turn: 2, step: 1, callId: 'second-call', parentDeliveryId: first.id } }
    expect(chatsStateSchema.safeParse({ ...state, deliveries: [first, second] }).success).toBe(false)
  })

  it('imports committed v2 without rewriting it or reading an older invalid v1', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-group-storage-v2-'))
    roots.push(root)
    await mkdir(join(root, 'storage'))
    const path = join(root, 'storage', `${previousChatsDomainSpec.name}.json`)
    const text = JSON.stringify({ unit: { name: previousChatsDomainSpec.name, version: 2 }, global: directState(), tables: {} })
    await writeFile(path, text)
    await writeFile(join(root, 'storage', 'katcats_chats.json'), 'invalid older generation')
    const h = await storageFixture(root)
    const domain = await openChatsDomain(h.ctx)
    expect(domain.global.get()).toEqual(chatsStateSchema.parse(directState()))
    expect(await readFile(path, 'utf8')).toBe(text)
    await domain.close()
  })

  it('imports a complete v1 journal into v3 without rewriting its source and reopens only v3 afterwards', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-group-storage-'))
    roots.push(root)
    await mkdir(join(root, 'storage'))
    const path = join(root, 'storage', 'katcats_chats.json')
    const text = JSON.stringify({ unit: { name: 'katcats_chats', version: 1 }, global: legacyState(), tables: {} }, null, 2) + '\n'
    await writeFile(path, text)
    const first = await storageFixture(root)
    const domain = await openChatsDomain(first.ctx)
    expect(domain.global.get().inbounds).toEqual([])
    expect(domain.global.get()).toEqual(chatsStateSchema.parse(legacyState()))
    expect(await readFile(path, 'utf8')).toBe(text)
    await domain.close()
    await first.close()
    expect(await readFile(path, 'utf8')).toBe(text)
    const second = await storageFixture(root)
    const writable = await openChatsDomain(second.ctx)
    const value = directState()
    await writable.global.set(value)
    await writable.close()
    await second.close()
    const third = await storageFixture(root)
    await writeFile(path, 'this predecessor must never be opened again')
    const reopened = await openChatsDomain(third.ctx)
    expect(reopened.global.get()).toEqual(value)
    expect(await readFile(path, 'utf8')).toBe('this predecessor must never be opened again')
    expect(JSON.parse(await readFile(join(root, 'storage', `${chatsDomainSpec.name}.json`), 'utf8')))
      .toMatchObject({ unit: { name: chatsDomainSpec.name, version: 3 } })
    await reopened.close()
  })

  it('rejects a broken legacy journal without rewriting or resetting its records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-group-storage-invalid-'))
    roots.push(root)
    await mkdir(join(root, 'storage'))
    const path = join(root, 'storage', 'katcats_chats.json')
    const previous = legacyState()
    const text = JSON.stringify({ unit: { name: 'katcats_chats', version: 1 },
      global: { ...previous, deliveries: previous.deliveries.map(delivery => ({ ...delivery, executorSessionId: 'private-session' })) }, tables: {} })
    await writeFile(path, text)
    const h = await storageFixture(root)
    await expect(openChatsDomain(h.ctx)).rejects.toMatchObject({ code: 'invalid-record' })
    expect(await readFile(path, 'utf8')).toBe(text)
  })

  it('preserves pending settings, admitted message references and unknown metadata during v1 import', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-group-storage-pending-'))
    roots.push(root)
    await mkdir(join(root, 'storage'))
    const state = directState()
    const chat = state.chats[0]!
    const retained = { ...state, pendingChat: { kind: 'settings', chat: { ...chat, name: 'Publishing' } },
      ownerMetadata: { retained: true } }
    const path = join(root, 'storage', 'katcats_chats.json')
    const text = JSON.stringify({ unit: { name: 'katcats_chats', version: 1 }, global: retained, tables: {} })
    await writeFile(path, text)
    const h = await storageFixture(root)
    const domain = await openChatsDomain(h.ctx)
    expect(domain.global.get()).toEqual(chatsStateSchema.parse(retained))
    expect(domain.global.get().pendingChat?.chat).toMatchObject({ rootSessionId: chat.rootSessionId, executors: chat.executors })
    expect(await readFile(path, 'utf8')).toBe(text)
    await domain.close()
  })

  it('creates a durable v3 marker for an empty profile and does not import a later predecessor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-group-storage-empty-'))
    roots.push(root)
    const first = await storageFixture(root)
    const domain = await openChatsDomain(first.ctx)
    expect(domain.global.get()).toMatchObject({ revision: 1, chats: [], inbounds: [], deliveries: [], pendingChat: null })
    await domain.close()
    await first.close()
    const path = join(root, 'storage', 'katcats_chats.json')
    await writeFile(path, JSON.stringify({ unit: { name: 'katcats_chats', version: 1 }, global: legacyState(), tables: {} }))
    const second = await storageFixture(root)
    const reopened = await openChatsDomain(second.ctx)
    expect(reopened.global.get().chats).toEqual([])
    await reopened.close()
  })

  it('retains v1 and permits retry after the first v3 write fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-group-storage-retry-'))
    roots.push(root)
    await mkdir(join(root, 'storage'))
    const path = join(root, 'storage', 'katcats_chats.json')
    const text = JSON.stringify({ unit: { name: 'katcats_chats', version: 1 }, global: legacyState(), tables: {} })
    await writeFile(path, text)
    const first = await storageFixture(root)
    const kv = first.ctx.storage.backend.get('json').kv!
    const open = kv.open.bind(kv)
    vi.spyOn(kv, 'open').mockImplementationOnce(async (descriptor) => {
      const unit = await open(descriptor)
      vi.spyOn(unit, 'setGlobal').mockRejectedValueOnce(new Error('Fixture v3 write failed'))
      return unit
    })
    await expect(openChatsDomain(first.ctx)).rejects.toThrow('Fixture v3 write failed')
    expect(first.ctx.storageDomain.get(chatsDomainSpec.name)).toBeUndefined()
    expect(first.ctx.storageDomain.get(legacyChatsDomainSpec.name)).toBeUndefined()
    expect(await readFile(path, 'utf8')).toBe(text)
    const retried = await openChatsDomain(first.ctx)
    expect(retried.global.get()).toEqual(chatsStateSchema.parse(legacyState()))
    expect(await readFile(path, 'utf8')).toBe(text)
    await retried.close()
  })

  it('rejects a predecessor containing a custom group assignment and never falls back from malformed v3', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-group-storage-generations-'))
    roots.push(root)
    await mkdir(join(root, 'storage'))
    const previous = legacyState()
    const invalid = { ...previous, chats: previous.chats.map(chat => ({ ...chat, groupId: 'custom-group' })) }
    const path = join(root, 'storage', 'katcats_chats.json')
    const text = JSON.stringify({ unit: { name: 'katcats_chats', version: 1 }, global: invalid, tables: {} })
    await writeFile(path, text)
    const first = await storageFixture(root)
    await expect(openChatsDomain(first.ctx)).rejects.toMatchObject({ code: 'invalid-record' })
    expect(await readFile(path, 'utf8')).toBe(text)
    await first.close()
    await writeFile(path, JSON.stringify({ unit: { name: 'katcats_chats', version: 1 }, global: previous, tables: {} }))
    const currentPath = join(root, 'storage', `${chatsDomainSpec.name}.json`)
    const broken = JSON.stringify({ unit: { name: chatsDomainSpec.name, version: 3 }, global: { broken: true }, tables: {} })
    await writeFile(currentPath, broken)
    const second = await storageFixture(root)
    await expect(openChatsDomain(second.ctx)).rejects.toMatchObject({ code: 'invalid-record' })
    expect(await readFile(currentPath, 'utf8')).toBe(broken)
  })
})
