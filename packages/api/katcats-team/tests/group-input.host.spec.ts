/** Real Loader admission, attachment storage, staged receipts, and synthetic durable acceptance. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import Llm, {
  LlmAdapter, type GenerateOptions, type LlmModelInfo, type MessageId, type StreamChunk, type UserMessage,
} from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SessionTitle from '@deepseek-ai/dsh-session-title'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import Workspaces from '@deepseek-ai/dsh-workspace'
import Fs from '@deepseek-ai/dsh-fs-local'
import Attachments from '@deepseek-ai/dsh-attachment-local'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import Commands from '@deepseek-ai/dsh-commands'
import Uploads from '@deepseek-ai/dsh-client-file-upload'
import Typert from '@deepseek-ai/dsh-typert-registry'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import type { SessionPromptRequest, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { brandString } from '@deepseek-ai/dsh-brand'
import KatcatsTeam from '../src/index.ts'
import { GroupTranscript } from '../src/group-transcript.ts'
import { admitGroupPrompt, groupRequestDigest } from '../src/group-input.ts'
import type { ChatId } from '../src/chats-types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    'katcats-group-input-fixture': { readonly kind: 'katcats-group-input-fixture' }
  }
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
const contexts = new Set<Context>()
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

class AdmissionModels extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  lookup: ((signal?: AbortSignal) => Promise<void>) | undefined
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(['vision', 'text-only'].map(id => ({ provider, id, name: id })))
  }
  override async resolveModel(provider: string, id: string, signal?: AbortSignal) {
    await this.lookup?.(signal)
    return { provider, id, name: id, inputModalities: id === 'text-only' ? ['text'] as const : ['text', 'image'] as const }
  }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    throw new Error('Admission must not execute a container or member model')
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'katcats-group-input-'))
  roots.push(root)
  const configPath = join(root, 'cordis.yml')
  const rows: [string, object?][] = [
    ['typert'], ['remote-access'], ['gateway'], ['sessions'], ['projections'],
    ['session-title', { fallbackMaxWords: 8, fallbackMaxBytes: 128, maxTitleBytes: 512 }],
    ['persistence', { root: join(root, 'sessions'), compression: 'none' }],
    ['session-query', { path: ':memory:', openAt: 'never' }], ['storage'],
    ['storage-json', { root: join(root, 'storage') }], ['storage-domain', { backend: 'json' }],
    ['workspaces'], ['llm'], ['models'], ['system-prompt', { includeRuntimeContext: false }], ['tools'],
    ['agents'], ['loop'], ['default-model', { provider: 'fixture', model: 'vision' }], ['fs', { cwd: root }],
    ['attachments', { dshHome: join(root, 'home') }], ['credentials', { path: join(root, 'credentials.yml'), watch: false }],
    ['connection'], ['commands'], ['uploads'], ['session-controller', { nativeOpen: false }],
    ['team', { workspaceRoot: join(root, 'workspaces') }],
  ]
  await writeFile(configPath, JSON.stringify(rows.map(([name, config]) => ({ name: `cordis:${name}`,
    ...(config === undefined ? {} : { config }) }))))
  const ctx = new Context()
  contexts.add(ctx)
  const adapter = new AdmissionModels()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([]))
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include, typert: Typert, 'remote-access': RemoteAccess, gateway: Gateway,
    sessions: Sessions, projections: Projections, 'session-title': SessionTitle, persistence: Persistence,
    'session-query': SessionQuery, storage: Storage, 'storage-json': JsonStorage, 'storage-domain': StorageDomain,
    workspaces: Workspaces, llm: Llm, 'system-prompt': SystemPrompt, tools: Tools, agents: Agents, loop: AgentLoop,
    'default-model': AgentDefaultModel, fs: Fs, attachments: Attachments, credentials: Credentials,
    connection: Connection, commands: Commands, uploads: Uploads, 'session-controller': SessionController, team: KatcatsTeam,
    models: { name: 'group-input-fixture-models', inject: ['llm'], apply(modelCtx: Context) {
      modelCtx.effect(() => modelCtx.llm.registerAdapter(['fixture'], adapter))
    } },
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const bot = (await ctx.katcatsTeam.createBot({ name: 'Reviewer' })).bot
  const groupDir = join(root, 'group-workspace')
  await mkdir(groupDir)
  const workspace = await ctx.workspaceRegistry.create(groupDir, 'Group')
  const created = await ctx.sessionController.create({ sessionId: brandString<SessionId>('group-input-container'), workspaceId: workspace.id })
  const found = await ctx.sessionController.resolveAgent(created.sessionId)
  if ('error' in found) throw found.error
  const container = found.agent
  const chat = { id: brandString<ChatId>('group-input-fixture'), rootSessionId: container.id }
  const transcript = new GroupTranscript(ctx)
  const intent = await ctx.storageDomain.open(StorageDomain.defineDomain({
    name: 'group_input_fixture', version: 1,
    global: { schema: z.object({ message: z.unknown() }), initial: { message: null } }, tables: {},
  }))
  const accept = async (message: UserMessage, commit: () => void) => {
    await intent.global.set({ message })
    commit()
    await transcript.publishUser(chat, message)
    return message
  }
  const request = (content: SessionPromptRequest['content'], id = 'admission-request'): SessionPromptRequest => ({
    requestId: brandString<SessionRequestId>(id), sessionId: container.id, mode: 'queue', content,
    clientTimeZone: 'Asia/Shanghai',
  })
  return { ctx, root, adapter, bot, container, chat, transcript, intent, accept, request }
}

describe('direct group input admission', () => {
  it('hashes ordered request meaning consistently without retaining upload bytes', () => {
    const request: SessionPromptRequest = { requestId: brandString<SessionRequestId>('digest-request'),
      sessionId: brandString<SessionId>('digest-session'),
      mode: 'queue', content: [{ type: 'text', text: 'hello' }, { type: 'image', mediaType: 'image/png', data: PNG }],
      clientTimeZone: 'US/Eastern' }
    const digest = groupRequestDigest(request)
    expect(digest).toMatch(/^[a-f0-9]{64}$/)
    expect(groupRequestDigest({ ...request, requestId: brandString<SessionRequestId>('another-id'), mode: 'steer',
      clientTimeZone: 'America/New_York' })).toBe(digest)
    expect(groupRequestDigest({ ...request, content: [...request.content].reverse() })).not.toBe(digest)
    expect(groupRequestDigest({ ...request, content: [{ type: 'text', text: 'changed' }] })).not.toBe(digest)
    expect(groupRequestDigest({ ...request, clientTimeZone: 'UTC' })).not.toBe(digest)
    expect(() => groupRequestDigest({ ...request, clientTimeZone: 'not/a/zone' })).toThrow('timezone')
  })

  it('admits real image and staged files in order, then retires receipts after awaited persistence and publication', async () => {
    const h = await fixture()
    const upload = await h.ctx.fileUploads.upload(h.container, {
      data: Buffer.from('draft contents').toString('base64'), name: 'draft.md',
    }, new AbortController().signal)
    const request = h.request([{ type: 'text', text: 'Review these.' },
      { type: 'image', mediaType: 'image/png', data: PNG, name: 'pixel.png' },
      { type: 'file', receiptId: upload.receiptId }, { type: 'file', receiptId: upload.receiptId }])
    const digest = groupRequestDigest(request)
    const message = await admitGroupPrompt(h.ctx, request, [h.bot], new AbortController().signal, h.accept)
    expect(message.content.map(part => part.type)).toEqual(['text', 'image', 'file', 'file'])
    expect(message.source).toEqual({ kind: 'user', rpcId: request.requestId, clientTimeZone: 'Asia/Shanghai' })
    expect(h.ctx.fileUploads.resolve(h.container, upload.receiptId)).toBeUndefined()
    expect(groupRequestDigest(request)).toBe(digest)
    expect(groupRequestDigest({ ...request, content: [{ type: 'text', text: 'Changed request with the same ID.' }] })).not.toBe(digest)
    const image = message.content.find(part => part.type === 'image')
    if (image?.type !== 'image') throw new Error('missing admitted image')
    expect((await h.ctx.attachments.readImage(image.attachment)).data.length).toBeGreaterThan(0)
    const stored = JSON.stringify(h.intent.global.get())
    expect(stored).not.toContain(PNG)
    expect(stored).toContain(upload.file.attachmentId)
    const history = await h.ctx.sessionController.inspect(h.container.id)
    expect(history.events.filter(event => event.type === 'user/message' && event.data.id === message.id)).toHaveLength(1)
    expect(history.events.some(event => event.type === 'turn/start')).toBe(false)
    expect(h.adapter.requests).toHaveLength(0)
    expect(message.content.map(part => part.type === 'image' ? { type: part.type, width: part.attachment.width,
      height: part.attachment.height } : part.type === 'file' ? { type: part.type, name: part.attachment.name,
      bytes: part.attachment.bytes } : part)).toMatchInlineSnapshot(`
      [
        {
          "text": "Review these.",
          "type": "text",
        },
        {
          "height": 1,
          "type": "image",
          "width": 1,
        },
        {
          "bytes": 14,
          "name": "draft.md",
          "type": "file",
        },
        {
          "bytes": 14,
          "name": "draft.md",
          "type": "file",
        },
      ]
    `)
  })

  it('restores staged receipt ownership when the real durable acceptance write fails', async () => {
    const h = await fixture()
    const upload = await h.ctx.fileUploads.upload(h.container, { data: 'ZG9jdW1lbnQ=', name: 'draft.txt' }, new AbortController().signal)
    const request = h.request([{ type: 'file', receiptId: upload.receiptId }])
    const blocker = join(h.root, 'storage', 'group_input_fixture.json')
    await mkdir(blocker)
    try {
      await expect(admitGroupPrompt(h.ctx, request, [h.bot], new AbortController().signal, h.accept)).rejects.toThrow()
      expect(h.intent.global.get()).toEqual({ message: null })
      const probe: UserMessage = { id: brandString<MessageId>('rollback-observation'), role: 'user',
        content: [{ type: 'text', text: 'A separate observation of the rejected request.' }],
        source: { kind: 'user', rpcId: request.requestId } }
      await h.transcript.publishUser(h.chat, probe)
      expect(h.ctx.fileUploads.resolve(h.container, upload.receiptId)).toEqual(upload.file)
    } finally { await rm(blocker, { recursive: true }) }
  })

  it('rejects another Session’s file receipt without binding or publishing it', async () => {
    const h = await fixture()
    const foreign = await h.ctx.sessionController.resolveAgent(h.bot.sessionId)
    if ('error' in foreign) throw foreign.error
    const upload = await h.ctx.fileUploads.upload(foreign.agent, { data: 'ZG9jdW1lbnQ=' }, new AbortController().signal)
    await expect(admitGroupPrompt(h.ctx, h.request([{ type: 'file', receiptId: upload.receiptId }]),
      [h.bot], new AbortController().signal, h.accept)).rejects.toMatchObject({
      code: 'session/attachment-invalid', details: { reason: 'FILE_NOT_STAGED' },
    })
    expect(h.ctx.fileUploads.resolve(foreign.agent, upload.receiptId)).toEqual(upload.file)
    expect(h.intent.global.get()).toEqual({ message: null })
  })

  it('rejects selected text-only models and maps actual invalid image admission to a typed failure', async () => {
    const h = await fixture()
    const textBot = (await h.ctx.katcatsTeam.createBot({ name: 'Text member' })).bot
    await h.ctx.katcatsTeam.updateBot({ id: textBot.id, model: { kind: 'override', provider: 'fixture', model: 'text-only' } })
    const request = h.request([{ type: 'image', mediaType: 'image/png', data: PNG }])
    await expect(admitGroupPrompt(h.ctx, request, [h.bot, textBot], new AbortController().signal, h.accept))
      .rejects.toMatchObject({ code: 'session/attachment-invalid', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } })
    await expect(admitGroupPrompt(h.ctx, h.request([{ type: 'image', mediaType: 'image/png', data: 'invalid-image-data' }]),
      [h.bot], new AbortController().signal, h.accept)).rejects.toMatchObject({ code: 'session/attachment-invalid' })
    expect(h.intent.global.get()).toEqual({ message: null })
    expect(h.adapter.requests).toHaveLength(0)
  })

  it('does not accept canceled metadata lookups and passes the admission signal to the external adapter', async () => {
    const h = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    const controller = new AbortController()
    h.adapter.lookup = async (signal) => {
      expect(signal).toBe(controller.signal)
      entered.resolve(undefined)
      await gate.promise
    }
    const pending = admitGroupPrompt(h.ctx, h.request([{ type: 'image', mediaType: 'image/png', data: PNG }]),
      [h.bot], controller.signal, h.accept)
    await entered.promise
    const canceled = new Error('Synthetic admission canceled')
    controller.abort(canceled)
    gate.resolve(undefined)
    await expect(pending).rejects.toBe(canceled)
    expect(h.intent.global.get()).toEqual({ message: null })
  })

  it('reports unavailable recipient model metadata without accepting or echoing the provider failure', async () => {
    const h = await fixture()
    h.adapter.lookup = () => Promise.reject(new Error('Synthetic external model directory unavailable'))
    await expect(admitGroupPrompt(h.ctx, h.request([{ type: 'image', mediaType: 'image/png', data: PNG }]),
      [h.bot], new AbortController().signal, h.accept)).rejects.toMatchObject({
      code: 'session/model-unavailable', message: 'A selected member model is unavailable',
      details: { provider: 'fixture', model: 'vision' },
    })
    expect(h.intent.global.get()).toEqual({ message: null })
    expect(h.adapter.requests).toHaveLength(0)
  })

  it('keeps an already persisted and published input when cancellation arrives after acceptance', async () => {
    const h = await fixture()
    const controller = new AbortController()
    const upload = await h.ctx.fileUploads.upload(h.container, { data: 'ZG9jdW1lbnQ=' }, controller.signal)
    const message = await admitGroupPrompt(h.ctx, h.request([{ type: 'file', receiptId: upload.receiptId }]), [h.bot],
      controller.signal, async (accepted, commit) => {
        await h.intent.global.set({ message: accepted })
        controller.abort(new Error('Synthetic cancellation after durable acceptance'))
        commit()
        await h.transcript.publishUser(h.chat, accepted)
        return accepted
      })
    expect(h.intent.global.get()).toEqual({ message })
    expect(h.ctx.fileUploads.resolve(h.container, upload.receiptId)).toBeUndefined()
    expect(JSON.parse(await readFile(join(h.root, 'storage', 'group_input_fixture.json'), 'utf8')))
      .toMatchObject({ global: { message: { id: message.id } } })
  })

  it('records the invocation principal and never takes caller identity from the request', async () => {
    const h = await fixture()
    const limited = new Connection.Peer(h.ctx, { principal: { kind: 'katcats-group-input-fixture' } })
    const scoped = h.ctx.extend({ invocation: { peer: limited, request: { namespace: 'fixture', method: 'admit' } } })
    const request = { ...h.request([{ type: 'text', text: 'Scoped caller.' }], 'scoped-request'),
      principal: { kind: 'owner' } }
    const message = await admitGroupPrompt(scoped, request, [h.bot], new AbortController().signal, h.accept)
    expect(message.source).toMatchObject({ kind: 'user', principal: { kind: 'katcats-group-input-fixture' } })
    const owner = new Connection.Peer(h.ctx, { principal: { kind: 'owner' } })
    const ownerScope = h.ctx.extend({ invocation: { peer: owner, request: { namespace: 'fixture', method: 'admit' } } })
    const ownerMessage = await admitGroupPrompt(ownerScope, h.request([{ type: 'text', text: 'Owner caller.' }], 'owner-request'),
      [h.bot], new AbortController().signal, h.accept)
    expect(ownerMessage.source).not.toHaveProperty('principal')
  })

  it('rejects canceled, empty, invalid-zone, and empty-recipient input before acceptance', async () => {
    const h = await fixture()
    const controller = new AbortController()
    controller.abort(new Error('Already canceled'))
    await expect(admitGroupPrompt(h.ctx, h.request([{ type: 'text', text: 'hello' }]), [h.bot], controller.signal, h.accept))
      .rejects.toThrow('Already canceled')
    await expect(admitGroupPrompt(h.ctx, h.request([{ type: 'text', text: '  ' }]), [h.bot], new AbortController().signal, h.accept))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(admitGroupPrompt(h.ctx, { ...h.request([{ type: 'text', text: 'hello' }]), clientTimeZone: 'not/a/zone' },
      [h.bot], new AbortController().signal, h.accept)).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(admitGroupPrompt(h.ctx, h.request([{ type: 'text', text: 'hello' }]), [], new AbortController().signal, h.accept))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(h.intent.global.get()).toEqual({ message: null })
  })
})
