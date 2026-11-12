/** Real Loader, Remote dispatch, and cold persistence for the Katcats directory. */
import { mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { mkdirSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import LlmService, { ToolCallId, createUserMessage, resolveRetryPolicy, type LlmModelInfo, type MessageId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import ApprovalService, { type ApprovalAnswer } from '@deepseek-ai/dsh-user-approval'
import * as RepeatToolReminder from '@deepseek-ai/dsh-repeat-tool-reminder'
import Sessions, { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SessionTitle, { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { logPath } from '../../../session/session-persistence-jsonl/src/format.ts'
import SessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry, { realpathNormalize } from '@deepseek-ai/dsh-workspace'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import Commands from '@deepseek-ai/dsh-commands'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import KatcatsTeam from '../src/index.ts'
import KatcatsChats from '../src/chats.ts'
import { chatsDomainSpec, chatsStateSchema } from '../src/chats-storage.ts'
import { GroupTranscript } from '../src/group-transcript.ts'
import { groupRequestDigest } from '../src/group-input.ts'
import { chatGroupId, mainBotId, ordinaryGroupId, teamStateSchema } from '../src/storage.ts'
import type { TeamBot } from '../src/types.ts'
import type { ChatDelivery, ChatDeliveryId, ChatInbound, ChatRunId, TeamChat } from '../src/chats-types.ts'
import type {} from '../src/chats-messages.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const contexts = new Set<Context>()
const roots: string[] = []

class FixtureModelCatalog extends MockAdapter {
  override providerRetryPolicy() {
    return resolveRetryPolicy({ mode: 'normal', maxRetries: 2,
      backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }, 'fixture provider retryPolicy')
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(['fixture-model', 'specialist-model'].map(id => ({ provider, id, name: id })))
  }
}

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function loadComposition(root: string, script: ConstructorParameters<typeof MockAdapter>[0] = [], chats = false, mainName?: string, retry = false) {
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([
    { name: 'cordis:typert' },
    { name: 'cordis:remote-access' },
    { name: 'cordis:gateway' },
    { name: 'cordis:sessions' },
    { name: 'cordis:session-projections' },
    { name: 'cordis:session-title', config: { fallbackMaxWords: 8, fallbackMaxBytes: 128, maxTitleBytes: 512 } },
    { name: 'cordis:session-persistence', config: { root: join(root, 'sessions'), compression: 'none' } },
    { name: 'cordis:session-query', config: { path: ':memory:', openAt: 'never' } },
    { name: 'cordis:storage' },
    { name: 'cordis:storage-json', config: { root: join(root, 'storage') } },
    { name: 'cordis:storage-domain', config: { backend: 'json' } },
    { name: 'cordis:workspace' },
    { name: 'cordis:llm' },
    { name: 'cordis:fixture-models' },
    { name: 'cordis:system-prompt', config: { includeRuntimeContext: false } },
    { name: 'cordis:tools' },
    { name: 'cordis:agents' },
    { name: 'cordis:agent-loop' },
    ...(retry ? [{ name: 'cordis:llm-retry' }] : []),
    { name: 'cordis:agent-default-model', config: { provider: 'fixture', model: 'fixture-model' } },
    { name: 'cordis:fs', config: { cwd: root } },
    { name: 'cordis:attachments', config: { dshHome: join(root, 'home') } },
    { name: 'cordis:credentials', config: { path: join(root, 'credentials.yaml'), watch: false } },
    { name: 'cordis:connection' },
    { name: 'cordis:commands' },
    { name: 'cordis:file-uploads' },
    { name: 'cordis:session-controller', config: { nativeOpen: false } },
    { name: 'cordis:katcats-team', config: { workspaceRoot: join(root, 'workspaces'), ...(mainName === undefined ? {} : { mainName }) } },
    ...(chats ? [{ name: 'cordis:katcats-chats', config: { workspaceRoot: join(root, 'workspaces'), relayLimit: 8 } }] : []),
  ]))

  const ctx = new Context()
  const adapter = new FixtureModelCatalog(script)
  adapter.systemPromptUpdate = 'in-history'
  contexts.add(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([]))
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include,
    typert: TypertRegistry,
    'remote-access': RemoteAccess,
    gateway: Gateway,
    sessions: Sessions,
    'session-projections': SessionProjections,
    'session-title': SessionTitle,
    'session-persistence': JsonlPersistence,
    'session-query': SessionQuery,
    storage: Storage,
    'storage-json': JsonStorage,
    'storage-domain': StorageDomain,
    workspace: WorkspaceRegistry,
    llm: LlmService,
    'fixture-models': {
      name: 'fixture-model-catalog', inject: ['llm', 'agents'],
      apply(modelCtx: Context) {
        modelCtx.effect(() => modelCtx.llm.registerAdapter(['fixture'], adapter))
        modelCtx.on('llm/stream', (request, next) => {
          const agent = request.sessionId === undefined ? undefined : modelCtx.agents.get(request.sessionId)
          if (agent === undefined) throw new Error('Fixture model request has no live Agent')
          expect(request.messages).toEqual(Session.create(agent.id, agent.session.snapshotEvents()).deriveMessages())
          return next()
        })
      },
    },
    'system-prompt': SystemPrompt,
    tools: Tools,
    agents: AgentRegistry,
    'agent-loop': AgentLoop,
    'llm-retry': LlmRetry,
    'agent-default-model': AgentDefaultModel,
    fs: FsLocal,
    attachments: AttachmentLocal,
    credentials: CredentialsLocal,
    connection: Connection,
    commands: Commands,
    'file-uploads': FileUploads,
    'session-controller': SessionController,
    'katcats-team': KatcatsTeam,
    'katcats-chats': KatcatsChats,
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  const invoke = (method: string, args: Readonly<Record<string, unknown>> = {}) =>
    ctx.typertGateway.invoke({ peer, namespace: 'katcatsTeam', method, args })
  const invokeChat = (method: string, args: Readonly<Record<string, unknown>> = {}) =>
    ctx.typertGateway.invoke({ peer, namespace: 'katcatsChats', method, args })
  return { ctx, invoke, invokeChat, adapter }
}

async function expectWorkspaceForBot(ctx: Context, bot: TeamBot) {
  const workspace = await ctx.workspaceRegistry.resolveByPath(bot.workDir)
  expect(workspace).toBeDefined()
  if (workspace === undefined) throw new Error('Member working directory has no Workspace registration')
  expect(workspace.path).toBe(await realpathNormalize(bot.workDir))
  expect(workspace.sessionIds).toEqual([bot.sessionId])
  expect(ctx.workspaceRegistry.get(workspace.id)).toBe(workspace)
  expect(ctx.workspaceRegistry.list()).toContain(workspace)
  return workspace
}

async function send(agent: Agent, text: string) {
  const failures: unknown[] = []
  const stop = agent.ctx.on('agent/error', ({ error }) => { failures.push(error) })
  try {
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await agent.whenIdle()
    if (failures.length > 0) throw new AggregateError(failures, 'The fixture Agent turn failed')
  } finally {
    stop()
  }
}

function execute(ctx: Context, agent: Agent, name: string, args: unknown) {
  return ctx.tools.execute({
    callId: ToolCallId(`fixture-${name}`), name, arguments: args, agent, signal: new AbortController().signal,
  })
}

function requireAgent(ctx: Context, bot: TeamBot): Agent {
  const agent = ctx.agents.get(bot.sessionId)
  if (agent === undefined) throw new Error('Fixture member has no live Agent')
  return agent
}

function groupAgent(ctx: Context, sessionId: TeamChat['rootSessionId']): Agent {
  const agent = ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error('Group fixture has no live Agent')
  return agent
}

function control(chat: TeamChat) {
  return { id: chat.id, expectedRunId: chat.run?.id ?? null, expectedGeneration: chat.generation }
}

function toolTranscript(events: readonly SessionEvent[], bot: TeamBot) {
  const transcript: unknown[] = []
  for (const event of events) {
    if (event.type === 'tool/call') {
      transcript.push({ type: event.type, name: event.data.name, arguments: event.data.arguments })
    } else if (event.type === 'tool/result') {
      const meta = event.data.meta
      transcript.push({
        type: event.type, callId: event.data.message.toolCallId,
        isError: event.data.message.isError ?? false,
        content: event.data.message.content.map(block => block.type === 'text'
          ? { ...block, text: block.text.replaceAll(bot.id, '<writer>') } : block),
        meta: typeof meta === 'object' && meta !== null && 'bot_id' in meta && meta.bot_id === bot.id
          ? { ...meta, bot_id: '<writer>' } : meta,
        error: event.data.error === undefined ? undefined : { code: event.data.error.code },
      })
    }
  }
  return transcript
}


let groupRequestSequence = 0

async function sendGroup(ctx: Context, chat: TeamChat, text: string, mode: 'queue' | 'steer' = 'queue'): Promise<void> {
  await ctx.katcatsChats.sendMessage({
    sessionId: chat.rootSessionId, requestId: brandString<SessionRequestId>('loader-group-' + String(++groupRequestSequence)),
    mode, content: [{ type: 'text', text }],
  }, new AbortController().signal)
}

async function settledGroup(ctx: Context, id: TeamChat['id']): Promise<void> {
  const abort = new AbortController()
  try {
    for await (const frame of ctx.katcatsChats.follow(abort.signal)) {
      if (frame.value.activities.find(value => value.chatId === id)?.processing === false) return
    }
    throw new Error('The group directory closed before its driver settled')
  } finally { abort.abort() }
}

async function resumeLegacyBroadcast(ctx: Context, chat: TeamChat, text: string): Promise<void> {
  const before = (await ctx.katcatsChats.snapshot()).chats.find(value => value.id === chat.id)!
  await ctx.katcatsChats.pause(control(before))
  await sendGroup(ctx, chat, text)
  await settledGroup(ctx, chat.id)
  const domain = ctx.storageDomain.get(chatsDomainSpec.name)!
  const state = chatsStateSchema.parse(domain.global.get())
  const admitted = state.inbounds.findLast(input => input.chatId === chat.id)!
  const { collaborationVersion: _version, ...historical } = admitted
  await domain.global.set({ ...state, inbounds: state.inbounds.map(input => input.requestId === admitted.requestId
    ? { ...historical, recipients: chat.memberIds } : input) })
  expect(state.deliveries.some(delivery => delivery.source.kind === 'owner-message'
    && delivery.source.messageId === admitted.userMessage.id)).toBe(false)
  const paused = (await ctx.katcatsChats.snapshot()).chats.find(value => value.id === chat.id)!
  await ctx.katcatsChats.resume(control(paused))
}

function malformedHandoff(): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Unconfirmed handoff.' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Unconfirmed handoff.' } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: ToolCallId('malformed-handoff'), name: 'request_group_member', argumentsDelta: '{"bot_id":' },
    { type: 'finish', reason: { kind: 'error', failure: { code: 'MALFORMED_RESPONSE', message: 'Tool arguments were incomplete.' } } },
  ]
}

describe('Katcats directory through the real Loader and owner Remote', () => {
  it('asks where to place a team, then saves new members and their chat in the selected folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-create-team-'))
    roots.push(root)
    let ctx: Context
    const h = await loadComposition(root, [
      toolCallResponse('inspect-team-folders', 'list_bots', {}),
      textResponse('Should I use an existing folder, create a new folder, or leave this team ungrouped?'),
      toolCallResponse('create-team-folder', 'create_bot_folder', { name: 'Finance operations' }),
      () => {
        const folder = teamStateSchema.parse(ctx.storageDomain.get('katcats_team')!.global.get()).groups.find(group => group.name === 'Finance operations')!
        return toolCallResponse('create-team-members', 'create_bots', { bots: [
          { name: 'Accountant', role: 'Prepare accounts.', group_id: folder.id },
          { name: 'CFO', role: 'Review and coordinate finance.', group_id: folder.id },
        ] })
      },
      () => {
        const team = teamStateSchema.parse(ctx.storageDomain.get('katcats_team')!.global.get())
        const folder = team.groups.find(group => group.name === 'Finance operations')!
        const bots = team.bots.filter(bot => bot.groupId === folder.id)
        return toolCallResponse('create-team-chat', 'create_group_chat', {
          name: 'Finance', group_id: folder.id, member_ids: bots.map(bot => bot.id), manager_id: bots.find(bot => bot.name === 'CFO')!.id,
        })
      },
      toolCallResponse('inspect-team-chat', 'list_group_chats', {}),
      textResponse('Accountant and CFO are saved. Finance is ready in the sidebar, with CFO as manager.'),
    ], true)
    ctx = h.ctx
    const priorFolder = (await ctx.katcatsTeam.createGroup({ name: 'Editorial' })).group
    const priorBot = (await ctx.katcatsTeam.createBot({ name: 'Writer', groupId: priorFolder.id })).bot
    const main = (await ctx.katcatsTeam.snapshot()).bots.find(bot => bot.id === mainBotId)!
    await send(requireAgent(ctx, main), 'Create an Accountant and CFO with their roles, then put them in Finance with CFO managing.')
    expect((await ctx.katcatsTeam.snapshot()).bots).toHaveLength(2)
    expect((await ctx.katcatsChats.snapshot()).chats).toEqual([])
    await send(requireAgent(ctx, main), 'Create a new sidebar folder called Finance operations for the new members and chat.')
    const team = await ctx.katcatsTeam.snapshot()
    const folder = team.groups.find(group => group.name === 'Finance operations')!
    const bots = team.bots.filter(bot => bot.groupId === folder.id)
    const saved = await ctx.katcatsChats.snapshot()
    expect(team.bots.find(bot => bot.id === priorBot.id)).toEqual(priorBot)
    expect(bots).toHaveLength(2)
    expect(saved.chats).toHaveLength(1)
    expect(saved.chats[0]).toMatchObject({ name: 'Finance', groupId: folder.id, memberIds: bots.map(bot => bot.id),
      managerId: bots.find(bot => bot.name === 'CFO')!.id, run: null })
    expect(h.adapter.requests).toHaveLength(7)
    expect(h.adapter.requests.every(request => request.sessionId === main.sessionId)).toBe(true)
    const log = await ctx.sessionController.inspect(main.sessionId)
    const results = log.events.flatMap(event => event.type === 'tool/result' ? [event.data] : [])
    expect(results).toHaveLength(5)
    expect(results.every(result => !result.message.isError)).toBe(true)
    const transcript = results.map(result => ({ callId: result.message.toolCallId, content: result.message.content, meta: result.meta }))
    const stable = [...bots, priorBot].reduce((text, bot) => text.replaceAll(bot.id, `<${bot.name}>`), JSON.stringify(transcript, null, 2))
      .replaceAll(saved.chats[0]!.id, '<finance-chat>').replaceAll(folder.id, '<finance-folder>').replaceAll(priorFolder.id, '<editorial-folder>')
    expect(stable).toMatchSnapshot()
    await ctx.fiber.dispose()
    contexts.delete(ctx)
    const reopened = await loadComposition(root, [], true)
    expect((await reopened.ctx.katcatsChats.snapshot()).chats).toEqual(saved.chats)
    expect((await reopened.ctx.katcatsTeam.snapshot()).bots).toEqual(team.bots)
    expect(reopened.adapter.requests).toEqual([])
  })

  it('finishes an older accepted settings intent before confirming later conversational responsibilities', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-role-order-'))
    roots.push(root)
    let aId = ''
    const h = await loadComposition(root, [
      () => toolCallResponse('later-roles', 'set_group_roles', { manager_id: aId, roles: [{ bot_id: aId, role: 'Final group responsibility.' }] }),
      textResponse('The later group responsibility is saved.'),
    ], true)
    const a = (await h.ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const b = (await h.ctx.katcatsTeam.createBot({ name: 'B' })).bot
    aId = a.id
    const chat = (await h.ctx.katcatsChats.createChat({ name: 'Roles', memberIds: [a.id, b.id] })).chat
    const flush = vi.spyOn(h.ctx.sessions, 'flush').mockRejectedValueOnce(new Error('Synthetic settings interruption'))
    await expect(h.ctx.katcatsChats.updateChat({ id: chat.id, managerId: b.id })).rejects.toThrow('Synthetic settings interruption')
    flush.mockRestore()
    await sendGroup(h.ctx, chat, '@A Make A responsible and save its final group responsibility.')
    await settledGroup(h.ctx, chat.id)
    expect((await h.ctx.katcatsChats.snapshot()).chats[0]).toMatchObject({
      managerId: a.id, memberRoles: [{ botId: a.id, role: 'Final group responsibility.' }],
    })
    expect(h.ctx.storageDomain.get(chatsDomainSpec.name)!.global.get()).toMatchObject({ pendingChat: null })
    expect(h.adapter.requests.every(request => request.sessionId === chat.executors[0]!.sessionId)).toBe(true)
  })

  it.each(['write-failure', 'cancel-after-commit'] as const)('reports a group-role %s without claiming an unconfirmed outcome', async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-group-role-outcome-'))
    roots.push(root)
    let writerId = ''
    const h = await loadComposition(root, [
      () => toolCallResponse('role-outcome', 'set_group_roles', { manager_id: writerId }),
      textResponse('Inspect group settings to confirm the outcome.'),
    ], true)
    const writer = (await h.ctx.katcatsTeam.createBot({ name: 'Writer' })).bot
    writerId = writer.id
    const { chat } = await h.ctx.katcatsChats.createChat({ name: 'Role outcome', memberIds: [writer.id] })
    const worker = groupAgent(h.ctx, chat.executors[0]!.sessionId)
    const domain = h.ctx.storageDomain.get(chatsDomainSpec.name)!
    const set = domain.global.set.bind(domain.global)
    vi.spyOn(domain.global, 'set').mockImplementation(async (value) => {
      if (chatsStateSchema.parse(value).chats.find(value => value.id === chat.id)?.managerId === writer.id) {
        if (mode === 'write-failure') throw new Error('Synthetic group role write failure')
        await set(value)
        worker.cancel({ kind: 'user' })
        return
      }
      await set(value)
    })
    await sendGroup(h.ctx, chat, '@Writer Make Writer responsible for this group.')
    await settledGroup(h.ctx, chat.id)
    const log = await h.ctx.sessionController.inspect(worker.id)
    const result = log.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'role-outcome')
    if (result?.type !== 'tool/result') throw new Error('Expected the actual group-role tool outcome')
    expect(result.data.message.isError).toBe(true)
    expect(result.data.meta).toBeUndefined()
    const saved = (await h.ctx.katcatsChats.snapshot()).chats.find(value => value.id === chat.id)!
    expect(saved.managerId).toBe(mode === 'write-failure' ? null : writer.id)
    if (mode === 'cancel-after-commit') {
      expect(result.data.message.content).toEqual([{ type: 'text', text: 'The request was stopped. Responsibilities may already have been saved; inspect group settings before retrying.' }])
    }
    expect((await h.ctx.katcatsTeam.snapshot()).bots.find(bot => bot.id === writer.id)).toEqual(writer)
  })

  it('uses actual member model policies while the transcript never requests a model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-group-member-models-'))
    roots.push(root)
    const { ctx, adapter } = await loadComposition(root, Array.from({ length: 5 }, () => textResponse('The member answered.')), true)
    const a = (await ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const b = (await ctx.katcatsTeam.createBot({ name: 'B' })).bot
    await ctx.katcatsTeam.updateBot({ id: mainBotId, model: { kind: 'override', provider: 'fixture', model: 'specialist-model' } })
    await ctx.katcatsTeam.updateBot({ id: b.id, model: { kind: 'override', provider: 'fixture', model: 'fixture-model' } })
    const chat = (await ctx.katcatsChats.createChat({ name: 'Models', memberIds: [a.id, b.id] })).chat
    await sendGroup(ctx, chat, '@A Use the current base.')
    await settledGroup(ctx, chat.id)
    const entry = [...ctx.loader.entries()].find(value => value.options.name === 'cordis:agent-default-model')!
    await entry.update({ config: { provider: 'fixture', model: 'specialist-model' } })
    await sendGroup(ctx, chat, '@A Follow the changed base.')
    await settledGroup(ctx, chat.id)
    await ctx.katcatsChats.updateChat({ id: chat.id, managerId: b.id })
    await sendGroup(ctx, chat, '@B Use your own fixed model.')
    await settledGroup(ctx, chat.id)
    await ctx.katcatsTeam.updateBot({ id: a.id, model: { kind: 'override', provider: 'fixture', model: 'fixture-model' } })
    await sendGroup(ctx, chat, '@A Use the explicit override.')
    await settledGroup(ctx, chat.id)
    const flush = vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new Error('Synthetic group setting interruption'))
    await expect(ctx.katcatsChats.updateChat({ id: chat.id, managerId: a.id })).rejects.toThrow('Synthetic group setting interruption')
    flush.mockRestore()
    await sendGroup(ctx, chat, '@B Recovered settings must preserve your member policy.')
    await settledGroup(ctx, chat.id)
    expect(adapter.requests.map(request => request.model)).toEqual([
      'fixture-model', 'specialist-model', 'fixture-model', 'fixture-model', 'fixture-model',
    ])
    expect(adapter.requests.some(request => request.sessionId === chat.rootSessionId)).toBe(false)
    expect((await ctx.sessionController.inspect(chat.rootSessionId)).events
      .some(event => ['assistant/message', 'request/header', 'turn/start', 'step/start'].includes(event.type))).toBe(false)
  })

  it('lets actual members set group roles and hand work to another member without changing private identities', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-member-roles-'))
    roots.push(root)
    let writerId = ''
    let reviewerId = ''
    const first = await loadComposition(root, [
      () => toolCallResponse('group-roles', 'set_group_roles', { manager_id: reviewerId,
        roles: [{ bot_id: writerId, role: 'Draft group articles.' }, { bot_id: reviewerId, role: 'Review group articles.' }] }),
      toolCallResponse('group-roster', 'list_group_members', {}),
      () => toolCallResponse('ask-reviewer', 'request_group_member',
        { bot_id: reviewerId, message: 'Review my draft title: A title drafted by Writer.' }),
      (request) => {
        expect(JSON.stringify(request.messages)).toContain('A title drafted by Writer.')
        expect(JSON.stringify(request.messages)).toContain('Review group articles.')
        return textResponse('Reviewer approves the title.')
      },
      (request) => {
        expect(JSON.stringify(request.messages)).toContain('Reviewer approves the title.')
        return textResponse('A title drafted by Writer, approved by Reviewer.')
      },
    ], true)
    const writer = (await first.ctx.katcatsTeam.createBot({ name: 'Writer' })).bot
    const reviewer = (await first.ctx.katcatsTeam.createBot({ name: 'Reviewer' })).bot
    writerId = writer.id; reviewerId = reviewer.id
    await first.ctx.katcatsTeam.updateBot({ id: writer.id, role: 'Private writer identity.' })
    const privateBefore = await first.ctx.katcatsTeam.snapshot()
    const chat = (await first.ctx.katcatsChats.createChat({ name: 'Editorial', memberIds: [writer.id, reviewer.id] })).chat
    const other = (await first.ctx.katcatsChats.createChat({ name: 'Other', memberIds: [writer.id, reviewer.id] })).chat
    await sendGroup(first.ctx, chat, 'Reviewer is responsible. Writer drafts group articles; Reviewer reviews. Prepare and review a title.')
    await settledGroup(first.ctx, chat.id)
    const snapshot = await first.ctx.katcatsChats.snapshot()
    const saved = snapshot.chats.find(value => value.id === chat.id)!
    expect(saved).toMatchObject({ managerId: reviewer.id, memberRoles: [
      { botId: writer.id, role: 'Draft group articles.' }, { botId: reviewer.id, role: 'Review group articles.' },
    ] })
    expect(snapshot.deliveries.map(value => value.botId)).toEqual([writer.id, reviewer.id])
    expect(snapshot.deliveries[1]!.source.kind).toBe('tool')
    expect(snapshot.chats.find(value => value.id === other.id)).toEqual(other)
    expect(await first.ctx.katcatsTeam.snapshot()).toEqual(privateBefore)
    const worker = groupAgent(first.ctx, chat.executors[0]!.sessionId)
    const log = await first.ctx.sessionController.inspect(worker.id)
    expect(log.events.flatMap<unknown>((event) => {
      if (event.type !== 'tool/result') return []
      const value: unknown = JSON.parse(JSON.stringify(event.data.meta).replaceAll(writer.id, '<writer>')
        .replaceAll(reviewer.id, '<reviewer>').replaceAll(chat.id, '<group>')
        .replaceAll(snapshot.deliveries[1]!.id, '<member-delivery>')
        .replaceAll(snapshot.deliveries[1]!.relayMessageId, '<member-reply>'))
      return [value]
    })).toMatchInlineSnapshot(`
      [
        {
          "chat_id": "<group>",
          "manager_id": "<reviewer>",
          "roles": [
            {
              "bot_id": "<writer>",
              "role": "Draft group articles.",
            },
            {
              "bot_id": "<reviewer>",
              "role": "Review group articles.",
            },
          ],
        },
        {
          "members": [
            {
              "bot_id": "<writer>",
              "is_manager": false,
              "name": "Writer",
              "role": "Draft group articles.",
            },
            {
              "bot_id": "<reviewer>",
              "is_manager": true,
              "name": "Reviewer",
              "role": "Review group articles.",
            },
          ],
        },
        {
          "bot_id": "<reviewer>",
          "chat_id": "<group>",
          "delivery_id": "<member-delivery>",
          "message_id": "<member-reply>",
          "reply": "Reviewer approves the title.",
          "status": "completed",
        },
      ]
    `)
    expect((await execute(first.ctx, worker, 'set_group_roles', { manager_id: writer.id })).isError).toBe(true)
    const definition = first.ctx.tools.get('set_group_roles', worker)!
    const privateWriter = requireAgent(first.ctx, writer)
    const borrowed = privateWriter.ctx.tools.register(definition)
    try {
      expect((await execute(first.ctx, privateWriter, 'set_group_roles', { manager_id: writer.id })).isError).toBe(true)
    } finally { borrowed() }
    expect(first.adapter.requests.some(request => request.sessionId === chat.rootSessionId)).toBe(false)
    await first.ctx.fiber.dispose()
    contexts.delete(first.ctx)
    const second = await loadComposition(root, [], true)
    expect((await second.ctx.katcatsChats.snapshot()).chats.find(value => value.id === chat.id)?.memberRoles).toEqual(saved.memberRoles)
    expect(await second.ctx.katcatsTeam.snapshot()).toEqual(privateBefore)
    expect(second.adapter.requests).toEqual([])
  })

  it('follows live base changes through real prompt admission while preserving explicit overrides and old v1 records across cold reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-following-loader-'))
    roots.push(root)
    const first = await loadComposition(root, Array.from({ length: 5 }, () => textResponse('The chosen model answered.')))
    const follower = (await first.ctx.katcatsTeam.createBot({ name: 'Following' })).bot
    const fixed = (await first.ctx.katcatsTeam.createBot({ name: 'Fixed' })).bot
    await first.ctx.katcatsTeam.updateBot({ id: fixed.id, model: { kind: 'override', provider: 'fixture', model: 'fixture-model' } })
    const before = await first.ctx.katcatsTeam.snapshot()
    const stored = await readFile(join(root, 'storage', 'katcats_team.json'), 'utf8')
    const submit = async (ctx: Context, bot: TeamBot, id: string) => {
      await ctx.sessionController.prompt({ sessionId: bot.sessionId, mode: 'queue',
        requestId: brandString<SessionRequestId>(id), content: [{ type: 'text', text: id }] }, new AbortController().signal)
      await requireAgent(ctx, bot).whenIdle()
    }
    await submit(first.ctx, follower, 'before base change')
    const baseEntry = [...first.ctx.loader.entries()].find(entry => entry.options.name === 'cordis:agent-default-model')
    if (baseEntry === undefined) throw new Error('Fixture base-model entry is absent')
    const originalFiberId = baseEntry.fiber?.uid
    await baseEntry.update({ config: { provider: 'fixture', model: 'specialist-model' } })
    expect(baseEntry.fiber?.uid).toBe(originalFiberId)
    expect(first.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'fixture', model: 'specialist-model' })
    await submit(first.ctx, follower, 'after base change')
    await submit(first.ctx, fixed, 'fixed model remains')
    expect(first.adapter.requests.map(request => ({ model: request.model, user: request.messages.filter(message => message.role === 'user')
      .flatMap(message => message.content.flatMap(part => part.type === 'text' ? [part.text] : [])) })))
      .toMatchInlineSnapshot(`
        [
          {
            "model": "fixture-model",
            "user": [
              "before base change",
            ],
          },
          {
            "model": "specialist-model",
            "user": [
              "before base change",
              "after base change",
              "[model changed: assistant turns above this point were generated by fixture-model; the session continues with specialist-model]",
            ],
          },
          {
            "model": "fixture-model",
            "user": [
              "fixed model remains",
            ],
          },
        ]
      `)
    expect(await first.ctx.katcatsTeam.snapshot()).toEqual(before)
    expect(await readFile(join(root, 'storage', 'katcats_team.json'), 'utf8')).toBe(stored)
    expect(first.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'fixture', model: 'specialist-model' })
    await first.ctx.fiber.dispose()
    contexts.delete(first.ctx)
    const second = await loadComposition(root, [textResponse('Following after reopen.')])
    expect(await second.ctx.katcatsTeam.snapshot()).toEqual(before)
    expect(second.ctx.agents.get(follower.sessionId)).toBeUndefined()
    await submit(second.ctx, follower, 'after cold reopen')
    expect(second.adapter.requests[0]).toMatchObject({ model: 'fixture-model' })
    expect(await readFile(join(root, 'storage', 'katcats_team.json'), 'utf8')).toBe(stored)
    const log = await second.ctx.sessionController.inspect(follower.sessionId)
    expect(log.events.filter(event => event.type === 'model/selection').map(event => event.data.model))
      .toEqual(['fixture-model', 'specialist-model', 'fixture-model'])
  })

  it('records main-created roles and a member’s own role through real tool turns and a cold resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-tools-loader-'))
    roots.push(root)
    const initialRole = 'Draft and edit technical articles.'
    const ownRole = 'Review technical articles for clarity and factual support.'
    const first = await loadComposition(root, [
      toolCallResponse('create-writer', 'create_bot', { name: 'Writer', role: initialRole }),
      textResponse('Writer was created with the requested role.'),
      toolCallResponse('set-writer-role', 'set_own_role', { role: ownRole }),
      textResponse('My long-term role was saved.'),
      textResponse('I will review the next article.'),
    ])
    const baseline = await first.ctx.katcatsTeam.snapshot()
    const main = baseline.bots[0]!
    await send(requireAgent(first.ctx, main), 'Create a Writer Bot that drafts and edits technical articles.')
    const created = (await first.ctx.katcatsTeam.snapshot()).bots.find(bot => bot.name === 'Writer')
    if (created === undefined) throw new Error('The main Bot tool did not create Writer')
    expect(created.role).toBe(initialRole)
    await expectWorkspaceForBot(first.ctx, created)
    const writer = requireAgent(first.ctx, created)
    expect(first.ctx.tools.get('create_bot', writer)).toBeUndefined()
    expect(first.ctx.tools.get('set_own_role', writer)).toBeDefined()
    await send(writer, 'From now on, review technical articles for clarity and factual support.')
    await send(writer, 'Review the next article using your saved role.')
    const saved = await first.ctx.katcatsTeam.snapshot()
    expect(saved.bots.find(bot => bot.id === created.id)).toEqual({ ...created, role: ownRole })
    expect(saved.bots.find(bot => bot.id === main.id)).toEqual(main)
    const nextRequest = first.adapter.requests.at(-1)!
    expect(nextRequest.messages.filter(message => message.role === 'system')
      .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n'))
      .toContain(`You are Writer, a member of 瑞华云财务共享团队.\n${ownRole}`)
    const mainLog = await first.ctx.sessionController.inspect(main.sessionId)
    const writerLog = await first.ctx.sessionController.inspect(created.sessionId)
    expect(mainLog.events.find(event => event.type === 'tool/call' && event.data.callId === 'create-writer'))
      .toMatchObject({ type: 'tool/call', data: { callId: 'create-writer', name: 'create_bot' } })
    const createdResult = mainLog.events.find(event => event.type === 'tool/result'
      && event.data.message.toolCallId === 'create-writer')
    if (createdResult?.type !== 'tool/result') throw new Error('The create tool has no durable result')
    expect(createdResult.data.message.isError).not.toBe(true)
    expect(createdResult.data.meta).toMatchObject({ bot_id: created.id, name: 'Writer', role: initialRole,
      avatar: { shape: 'classic', color: '#FF2849' } })
    const roleResult = writerLog.events.find(event => event.type === 'tool/result'
      && event.data.message.toolCallId === 'set-writer-role')
    if (roleResult?.type !== 'tool/result') throw new Error('The role tool has no durable result')
    expect(roleResult.data.message.isError).not.toBe(true)
    expect(roleResult.data.meta).toMatchObject({ bot_id: created.id, name: 'Writer', role: ownRole,
      avatar: { shape: 'classic', color: '#FF2849' } })
    expect({
      main: toolTranscript(mainLog.events, created),
      writer: toolTranscript(writerLog.events, created),
      nextPromptIdentity: nextRequest.messages.filter(message => message.role === 'system')
        .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])),
    }).toMatchInlineSnapshot(`
      {
        "main": [
          {
            "arguments": "{"name":"Writer","role":"Draft and edit technical articles."}",
            "name": "create_bot",
            "type": "tool/call",
          },
          {
            "callId": "create-writer",
            "content": [
              {
                "text": "Created Bot Writer (<writer>) with saved role:
      Draft and edit technical articles.
      Saved avatar: classic #FF2849.",
                "type": "text",
              },
            ],
            "error": undefined,
            "isError": false,
            "meta": {
              "avatar": {
                "color": "#FF2849",
                "shape": "classic",
              },
              "bot_id": "<writer>",
              "name": "Writer",
              "role": "Draft and edit technical articles.",
            },
            "type": "tool/result",
          },
        ],
        "nextPromptIdentity": [
          "You are an AI agent powered by DeepSeek Harness.

      You are Writer, a member of 瑞华云财务共享团队.
      Draft and edit technical articles.
      When introducing yourself, use the exact team name 瑞华云财务共享团队, even if earlier conversation mentions an old product name.

      Use set_own_role only when the user explicitly asks to establish or change your ongoing identity or responsibilities. Do not change your saved role for a temporary task. Claim a role was saved only after the tool succeeds.",
          "You are an AI agent powered by DeepSeek Harness.

      You are Writer, a member of 瑞华云财务共享团队.
      Review technical articles for clarity and factual support.
      When introducing yourself, use the exact team name 瑞华云财务共享团队, even if earlier conversation mentions an old product name.

      Use set_own_role only when the user explicitly asks to establish or change your ongoing identity or responsibilities. Do not change your saved role for a temporary task. Claim a role was saved only after the tool succeeds.",
        ],
        "writer": [
          {
            "arguments": "{"role":"Review technical articles for clarity and factual support."}",
            "name": "set_own_role",
            "type": "tool/call",
          },
          {
            "callId": "set-writer-role",
            "content": [
              {
                "text": "Saved your role for Writer (<writer>):
      Review technical articles for clarity and factual support.
      Saved avatar: classic #FF2849.",
                "type": "text",
              },
            ],
            "error": undefined,
            "isError": false,
            "meta": {
              "avatar": {
                "color": "#FF2849",
                "shape": "classic",
              },
              "bot_id": "<writer>",
              "name": "Writer",
              "role": "Review technical articles for clarity and factual support.",
            },
            "type": "tool/result",
          },
        ],
      }
    `)
    await first.ctx.fiber.dispose()
    contexts.delete(first.ctx)

    const second = await loadComposition(root, [textResponse('The saved role is active after resume.')])
    await expect(second.invoke('snapshot')).resolves.toEqual(saved)
    expect(second.ctx.agents.get(created.sessionId)).toBeUndefined()
    const resolved = await second.ctx.sessionController.resolveAgent(created.sessionId)
    if ('error' in resolved) throw resolved.error
    await send(resolved.agent, 'Continue with your saved role after restarting.')
    expect(second.adapter.requests[0]!.messages.filter(message => message.role === 'system')
      .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n'))
      .toContain(`You are Writer, a member of 瑞华云财务共享团队.\n${ownRole}`)
    const cold = await second.ctx.sessionController.inspect(created.sessionId)
    expect(cold.events.slice(0, writerLog.events.length)).toEqual(writerLog.events)
    expect(second.ctx.tools.get('create_bot', resolved.agent)).toBeUndefined()
    expect(second.ctx.tools.get('set_own_role', resolved.agent)).toBeDefined()
  })

  it('saves requested avatar colors through main Session tools and preserves member state across a cold reload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-avatar-tools-loader-'))
    roots.push(root)
    const members = [
      { name: 'Ruby', role: 'Draft clear articles.', avatar: { shape: 'classic', color: '#FF2849' } },
      { name: 'Jade', role: 'Check source material.', avatar: { shape: 'round', color: '#10C477' } },
      { name: 'Azure', role: 'Review interface designs.', avatar: { shape: 'point', color: '#2288FF' } },
      { name: 'Violet', role: 'Review accessibility.', avatar: { shape: 'fluffy', color: '#9253FF' } },
    ]
    let groupId = ''
    let targetId = ''
    const replacement = { shape: 'tilt', color: '#FF9933' }
    const first = await loadComposition(root, [
      ...members.map((member, index) => () => toolCallResponse(`create-avatar-${String(index + 1)}`, 'create_bot', {
        ...member, ...(member.name === 'Azure' ? { group_id: groupId } : {}),
      })),
      toolCallResponse('list-created-avatars', 'list_bots', {}),
      textResponse('The four requested avatars were saved.'),
      () => toolCallResponse('change-avatar', 'set_bot_appearance', { bot_id: targetId, avatar: replacement }),
      toolCallResponse('list-changed-avatars', 'list_bots', {}),
      textResponse('Azure has the requested saved avatar.'),
    ])
    const group = (await first.ctx.katcatsTeam.createGroup({ name: 'Design team' })).group
    groupId = group.id
    const main = (await first.ctx.katcatsTeam.snapshot()).bots.find(bot => bot.id === mainBotId)!
    await send(requireAgent(first.ctx, main), 'Create Ruby, Jade, Azure and Violet with red, green, blue and purple cat avatars, then list their saved settings.')
    const created = await first.ctx.katcatsTeam.snapshot()
    expect(created.bots.filter(bot => bot.kind === 'ordinary')).toHaveLength(4)
    for (const member of members) {
      const saved = created.bots.find(bot => bot.name === member.name)!
      expect(saved).toMatchObject({ ...member, groupId: member.name === 'Azure' ? group.id : ordinaryGroupId })
      await expectWorkspaceForBot(first.ctx, saved)
    }
    const target = created.bots.find(bot => bot.name === 'Azure')!
    targetId = target.id
    await first.ctx.katcatsTeam.updateBot({ id: target.id,
      model: { kind: 'override', provider: 'fixture', model: 'specialist-model' } })
    const canaryPath = join(target.workDir, 'avatar-canary.txt')
    await writeFile(canaryPath, 'Keep this member file.')
    const beforeChange = await first.ctx.katcatsTeam.snapshot()
    const memberLogs = await Promise.all(beforeChange.bots.filter(bot => bot.kind === 'ordinary')
      .map(bot => first.ctx.sessionController.inspect(bot.sessionId)))
    await send(requireAgent(first.ctx, main), 'Change only Azure’s avatar to the tilted orange cat and list the saved settings.')
    const saved = await first.ctx.katcatsTeam.snapshot()
    expect(saved.bots).toEqual(beforeChange.bots.map(bot => bot.id === target.id ? { ...bot, avatar: replacement } : bot))
    expect(saved.groups).toEqual(beforeChange.groups)
    expect(saved.modelCapabilities).toEqual(beforeChange.modelCapabilities)
    expect(saved.mainBotId).toBe(beforeChange.mainBotId)
    expect(saved.revision).toBeGreaterThan(beforeChange.revision)
    expect(await readFile(canaryPath, 'utf8')).toBe('Keep this member file.')
    expect(await Promise.all(saved.bots.filter(bot => bot.kind === 'ordinary')
      .map(bot => first.ctx.sessionController.inspect(bot.sessionId)))).toEqual(memberLogs)

    const mainLog = await first.ctx.sessionController.inspect(main.sessionId)
    const results = mainLog.events.flatMap(event => event.type === 'tool/result' ? [event] : [])
    expect(results).toHaveLength(7)
    expect(results.every(event => !event.data.message.isError && event.data.error === undefined)).toBe(true)
    for (const [index, member] of members.entries()) {
      const bot = created.bots.find(bot => bot.name === member.name)!
      expect(results[index]!.data.meta).toEqual({ bot_id: bot.id, ...member })
    }
    const listed = (bots: typeof saved.bots) => ({
      bots: bots.map(bot => ({ bot_id: bot.id, name: bot.name, role: bot.role, avatar: bot.avatar,
        is_main: bot.kind === 'main', ...(bot.groupId === null ? {} : { group_id: bot.groupId }) })),
      groups: [{ group_id: ordinaryGroupId, name: '未分组' }, { group_id: group.id, name: group.name }],
    })
    expect(results[4]!.data.meta).toEqual(listed(created.bots))
    expect(results[5]!.data.meta).toEqual({ bot_id: target.id, name: target.name, role: target.role, avatar: replacement })
    expect(results[6]!.data.meta).toEqual(listed(saved.bots))
    expect(first.adapter.requests).toHaveLength(9)
    expect(first.adapter.requests.every(request => request.sessionId === main.sessionId)).toBe(true)
    const transcript: unknown[] = []
    for (const event of mainLog.events) {
      if (event.type === 'tool/call') {
        transcript.push({ type: event.type, name: event.data.name, arguments: event.data.arguments })
      } else if (event.type === 'tool/result') {
        transcript.push({ type: event.type, callId: event.data.message.toolCallId, content: event.data.message.content,
          meta: event.data.meta, isError: event.data.message.isError ?? false })
      }
    }
    const stableTranscript = created.bots.filter(bot => bot.kind === 'ordinary')
      .reduce((text, bot) => text.replaceAll(bot.id, `<${bot.name}>`),
        JSON.stringify(transcript, null, 2)).replaceAll(group.id, '<design-group>')
    expect(stableTranscript).toMatchInlineSnapshot(`
      "[
        {
          "type": "tool/call",
          "name": "create_bot",
          "arguments": "{\\"name\\":\\"Ruby\\",\\"role\\":\\"Draft clear articles.\\",\\"avatar\\":{\\"shape\\":\\"classic\\",\\"color\\":\\"#FF2849\\"}}"
        },
        {
          "type": "tool/result",
          "callId": "create-avatar-1",
          "content": [
            {
              "type": "text",
              "text": "Created Bot Ruby (<Ruby>) with saved role:\\nDraft clear articles.\\nSaved avatar: classic #FF2849."
            }
          ],
          "meta": {
            "bot_id": "<Ruby>",
            "name": "Ruby",
            "role": "Draft clear articles.",
            "avatar": {
              "shape": "classic",
              "color": "#FF2849"
            }
          },
          "isError": false
        },
        {
          "type": "tool/call",
          "name": "create_bot",
          "arguments": "{\\"name\\":\\"Jade\\",\\"role\\":\\"Check source material.\\",\\"avatar\\":{\\"shape\\":\\"round\\",\\"color\\":\\"#10C477\\"}}"
        },
        {
          "type": "tool/result",
          "callId": "create-avatar-2",
          "content": [
            {
              "type": "text",
              "text": "Created Bot Jade (<Jade>) with saved role:\\nCheck source material.\\nSaved avatar: round #10C477."
            }
          ],
          "meta": {
            "bot_id": "<Jade>",
            "name": "Jade",
            "role": "Check source material.",
            "avatar": {
              "shape": "round",
              "color": "#10C477"
            }
          },
          "isError": false
        },
        {
          "type": "tool/call",
          "name": "create_bot",
          "arguments": "{\\"name\\":\\"Azure\\",\\"role\\":\\"Review interface designs.\\",\\"avatar\\":{\\"shape\\":\\"point\\",\\"color\\":\\"#2288FF\\"},\\"group_id\\":\\"<design-group>\\"}"
        },
        {
          "type": "tool/result",
          "callId": "create-avatar-3",
          "content": [
            {
              "type": "text",
              "text": "Created Bot Azure (<Azure>) with saved role:\\nReview interface designs.\\nSaved avatar: point #2288FF."
            }
          ],
          "meta": {
            "bot_id": "<Azure>",
            "name": "Azure",
            "role": "Review interface designs.",
            "avatar": {
              "shape": "point",
              "color": "#2288FF"
            }
          },
          "isError": false
        },
        {
          "type": "tool/call",
          "name": "create_bot",
          "arguments": "{\\"name\\":\\"Violet\\",\\"role\\":\\"Review accessibility.\\",\\"avatar\\":{\\"shape\\":\\"fluffy\\",\\"color\\":\\"#9253FF\\"}}"
        },
        {
          "type": "tool/result",
          "callId": "create-avatar-4",
          "content": [
            {
              "type": "text",
              "text": "Created Bot Violet (<Violet>) with saved role:\\nReview accessibility.\\nSaved avatar: fluffy #9253FF."
            }
          ],
          "meta": {
            "bot_id": "<Violet>",
            "name": "Violet",
            "role": "Review accessibility.",
            "avatar": {
              "shape": "fluffy",
              "color": "#9253FF"
            }
          },
          "isError": false
        },
        {
          "type": "tool/call",
          "name": "list_bots",
          "arguments": "{}"
        },
        {
          "type": "tool/result",
          "callId": "list-created-avatars",
          "content": [
            {
              "type": "text",
              "text": "{\\"bots\\":[{\\"bot_id\\":\\"main\\",\\"name\\":\\"小兢会计\\",\\"role\\":\\"Bot 创建助手：根据用户需求创建和配置 Bot。\\",\\"avatar\\":{\\"shape\\":\\"classic\\",\\"color\\":\\"#FF2849\\"},\\"is_main\\":true},{\\"bot_id\\":\\"<Violet>\\",\\"name\\":\\"Violet\\",\\"role\\":\\"Review accessibility.\\",\\"avatar\\":{\\"shape\\":\\"fluffy\\",\\"color\\":\\"#9253FF\\"},\\"is_main\\":false,\\"group_id\\":\\"bots\\"},{\\"bot_id\\":\\"<Azure>\\",\\"name\\":\\"Azure\\",\\"role\\":\\"Review interface designs.\\",\\"avatar\\":{\\"shape\\":\\"point\\",\\"color\\":\\"#2288FF\\"},\\"is_main\\":false,\\"group_id\\":\\"<design-group>\\"},{\\"bot_id\\":\\"<Jade>\\",\\"name\\":\\"Jade\\",\\"role\\":\\"Check source material.\\",\\"avatar\\":{\\"shape\\":\\"round\\",\\"color\\":\\"#10C477\\"},\\"is_main\\":false,\\"group_id\\":\\"bots\\"},{\\"bot_id\\":\\"<Ruby>\\",\\"name\\":\\"Ruby\\",\\"role\\":\\"Draft clear articles.\\",\\"avatar\\":{\\"shape\\":\\"classic\\",\\"color\\":\\"#FF2849\\"},\\"is_main\\":false,\\"group_id\\":\\"bots\\"}],\\"groups\\":[{\\"group_id\\":\\"bots\\",\\"name\\":\\"未分组\\"},{\\"group_id\\":\\"<design-group>\\",\\"name\\":\\"Design team\\"}]}"
            }
          ],
          "meta": {
            "bots": [
              {
                "bot_id": "main",
                "name": "小兢会计",
                "role": "Bot 创建助手：根据用户需求创建和配置 Bot。",
                "avatar": {
                  "shape": "classic",
                  "color": "#FF2849"
                },
                "is_main": true
              },
              {
                "bot_id": "<Violet>",
                "name": "Violet",
                "role": "Review accessibility.",
                "avatar": {
                  "shape": "fluffy",
                  "color": "#9253FF"
                },
                "is_main": false,
                "group_id": "bots"
              },
              {
                "bot_id": "<Azure>",
                "name": "Azure",
                "role": "Review interface designs.",
                "avatar": {
                  "shape": "point",
                  "color": "#2288FF"
                },
                "is_main": false,
                "group_id": "<design-group>"
              },
              {
                "bot_id": "<Jade>",
                "name": "Jade",
                "role": "Check source material.",
                "avatar": {
                  "shape": "round",
                  "color": "#10C477"
                },
                "is_main": false,
                "group_id": "bots"
              },
              {
                "bot_id": "<Ruby>",
                "name": "Ruby",
                "role": "Draft clear articles.",
                "avatar": {
                  "shape": "classic",
                  "color": "#FF2849"
                },
                "is_main": false,
                "group_id": "bots"
              }
            ],
            "groups": [
              {
                "group_id": "bots",
                "name": "未分组"
              },
              {
                "group_id": "<design-group>",
                "name": "Design team"
              }
            ]
          },
          "isError": false
        },
        {
          "type": "tool/call",
          "name": "set_bot_appearance",
          "arguments": "{\\"bot_id\\":\\"<Azure>\\",\\"avatar\\":{\\"shape\\":\\"tilt\\",\\"color\\":\\"#FF9933\\"}}"
        },
        {
          "type": "tool/result",
          "callId": "change-avatar",
          "content": [
            {
              "type": "text",
              "text": "Saved Bot Azure (<Azure>) appearance: tilt #FF9933."
            }
          ],
          "meta": {
            "bot_id": "<Azure>",
            "name": "Azure",
            "role": "Review interface designs.",
            "avatar": {
              "shape": "tilt",
              "color": "#FF9933"
            }
          },
          "isError": false
        },
        {
          "type": "tool/call",
          "name": "list_bots",
          "arguments": "{}"
        },
        {
          "type": "tool/result",
          "callId": "list-changed-avatars",
          "content": [
            {
              "type": "text",
              "text": "{\\"bots\\":[{\\"bot_id\\":\\"main\\",\\"name\\":\\"小兢会计\\",\\"role\\":\\"Bot 创建助手：根据用户需求创建和配置 Bot。\\",\\"avatar\\":{\\"shape\\":\\"classic\\",\\"color\\":\\"#FF2849\\"},\\"is_main\\":true},{\\"bot_id\\":\\"<Violet>\\",\\"name\\":\\"Violet\\",\\"role\\":\\"Review accessibility.\\",\\"avatar\\":{\\"shape\\":\\"fluffy\\",\\"color\\":\\"#9253FF\\"},\\"is_main\\":false,\\"group_id\\":\\"bots\\"},{\\"bot_id\\":\\"<Azure>\\",\\"name\\":\\"Azure\\",\\"role\\":\\"Review interface designs.\\",\\"avatar\\":{\\"shape\\":\\"tilt\\",\\"color\\":\\"#FF9933\\"},\\"is_main\\":false,\\"group_id\\":\\"<design-group>\\"},{\\"bot_id\\":\\"<Jade>\\",\\"name\\":\\"Jade\\",\\"role\\":\\"Check source material.\\",\\"avatar\\":{\\"shape\\":\\"round\\",\\"color\\":\\"#10C477\\"},\\"is_main\\":false,\\"group_id\\":\\"bots\\"},{\\"bot_id\\":\\"<Ruby>\\",\\"name\\":\\"Ruby\\",\\"role\\":\\"Draft clear articles.\\",\\"avatar\\":{\\"shape\\":\\"classic\\",\\"color\\":\\"#FF2849\\"},\\"is_main\\":false,\\"group_id\\":\\"bots\\"}],\\"groups\\":[{\\"group_id\\":\\"bots\\",\\"name\\":\\"未分组\\"},{\\"group_id\\":\\"<design-group>\\",\\"name\\":\\"Design team\\"}]}"
            }
          ],
          "meta": {
            "bots": [
              {
                "bot_id": "main",
                "name": "小兢会计",
                "role": "Bot 创建助手：根据用户需求创建和配置 Bot。",
                "avatar": {
                  "shape": "classic",
                  "color": "#FF2849"
                },
                "is_main": true
              },
              {
                "bot_id": "<Violet>",
                "name": "Violet",
                "role": "Review accessibility.",
                "avatar": {
                  "shape": "fluffy",
                  "color": "#9253FF"
                },
                "is_main": false,
                "group_id": "bots"
              },
              {
                "bot_id": "<Azure>",
                "name": "Azure",
                "role": "Review interface designs.",
                "avatar": {
                  "shape": "tilt",
                  "color": "#FF9933"
                },
                "is_main": false,
                "group_id": "<design-group>"
              },
              {
                "bot_id": "<Jade>",
                "name": "Jade",
                "role": "Check source material.",
                "avatar": {
                  "shape": "round",
                  "color": "#10C477"
                },
                "is_main": false,
                "group_id": "bots"
              },
              {
                "bot_id": "<Ruby>",
                "name": "Ruby",
                "role": "Draft clear articles.",
                "avatar": {
                  "shape": "classic",
                  "color": "#FF2849"
                },
                "is_main": false,
                "group_id": "bots"
              }
            ],
            "groups": [
              {
                "group_id": "bots",
                "name": "未分组"
              },
              {
                "group_id": "<design-group>",
                "name": "Design team"
              }
            ]
          },
          "isError": false
        }
      ]"
    `)
    await first.ctx.fiber.dispose()
    contexts.delete(first.ctx)

    const cold = await loadComposition(root)
    await expect(cold.invoke('snapshot')).resolves.toEqual(saved)
    expect((await cold.ctx.sessionController.inspect(main.sessionId)).events).toEqual(mainLog.events)
    const coldLogs = await Promise.all(saved.bots.filter(bot => bot.kind === 'ordinary')
      .map(bot => cold.ctx.sessionController.inspect(bot.sessionId)))
    expect(coldLogs.map(log => ({ events: log.events, id: log.meta.id, cwd: log.meta.cwd })))
      .toEqual(memberLogs.map(log => ({ events: log.events, id: log.meta.id, cwd: log.meta.cwd })))
    for (const bot of saved.bots) await expectWorkspaceForBot(cold.ctx, bot)
    expect(await readFile(canaryPath, 'utf8')).toBe('Keep this member file.')
    expect(cold.adapter.requests).toEqual([])
  })

  it('denies borrowed identities and ordinary-member creation and leaves roles unchanged after invalid input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-tool-permissions-'))
    roots.push(root)
    const { ctx, invoke } = await loadComposition(root)
    await invoke('createBot', { request: { name: 'Writer' } })
    const before = await ctx.katcatsTeam.snapshot()
    const main = requireAgent(ctx, before.bots[0]!)
    const writer = requireAgent(ctx, before.bots.find(bot => bot.name === 'Writer')!)
    expect(ctx.tools.get('create_bot', main)).toBeDefined()
    expect(ctx.tools.get('list_bots', main)).toBeDefined()
    expect(ctx.tools.get('create_bot', writer)).toBeUndefined()
    const denied = await execute(ctx, writer, 'create_bot', { name: 'Intruder', role: 'Unexpected member.' })
    expect(denied).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })
    const borrowed = { ...main, id: main.id, ctx: main.ctx }
    expect(borrowed.id).toBe(main.id)
    expect(borrowed).not.toBe(main)
    const borrowedResult = await execute(ctx, borrowed, 'create_bot', { name: 'Impostor', role: 'Unexpected member.' })
    expect(borrowedResult.isError).toBe(true)
    if (!borrowedResult.isError) throw new Error('Borrowed Agent identity unexpectedly created a member')
    expect(['UNKNOWN_TOOL', 'KATCATS_TOOL_DENIED']).toContain(borrowedResult.error.info?.code)
    expect(await execute(ctx, writer, 'list_bots', {})).toMatchObject({ isError: true,
      error: { info: { code: 'UNKNOWN_TOOL' } } })
    expect(await execute(ctx, main, 'list_bots', {})).toMatchObject({ isError: false,
      value: { bots: [{ name: '小兢会计' }, { name: 'Writer' }],
        groups: [{ group_id: ordinaryGroupId, name: '未分组' }] } })
    const empty = await execute(ctx, writer, 'set_own_role', { role: ' ' })
    expect(empty).toMatchObject({ isError: true, error: { info: { code: 'KATCATS_TOOL_INVALID_INPUT' } } })
    const targeted = await execute(ctx, writer, 'set_own_role', { role: 'Changed role.', target: main.id })
    expect(targeted).toMatchObject({ isError: true, error: { info: { code: 'KATCATS_TOOL_INVALID_INPUT' } } })
    await expect(ctx.katcatsTeam.snapshot()).resolves.toEqual(before)
  })

  it('records a failed own-role tool result when the real JSON medium refuses the write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-tool-write-failure-'))
    roots.push(root)
    const { ctx, invoke } = await loadComposition(root, [
      toolCallResponse('failed-role', 'set_own_role', { role: 'A role that must not be reported as saved.' }),
      textResponse('The role was not saved.'),
    ])
    await invoke('createBot', { request: { name: 'Writer' } })
    const before = await ctx.katcatsTeam.snapshot()
    const writer = before.bots.find(bot => bot.name === 'Writer')!
    const statePath = join(root, 'storage', 'katcats_team.json')
    const backup = join(root, 'storage', 'katcats_team.backup.json')
    await rename(statePath, backup)
    await mkdir(statePath)
    try {
      await send(requireAgent(ctx, writer), 'Save this new long-term role.')
      const log = await ctx.sessionController.inspect(writer.sessionId)
      const result = log.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'failed-role')
      if (result?.type !== 'tool/result') throw new Error('Failed role update has no durable tool result')
      expect(result.data.message.isError).toBe(true)
      expect(result.data.error?.code).toBe('KATCATS_TOOL_INCOMPLETE')
      expect(result.data.meta).toBeUndefined()
      expect(toolTranscript(log.events, writer)).toMatchInlineSnapshot(`
        [
          {
            "arguments": "{"role":"A role that must not be reported as saved."}",
            "name": "set_own_role",
            "type": "tool/call",
          },
          {
            "callId": "failed-role",
            "content": [
              {
                "text": "Error: The role change did not report success. Check the member settings before retrying.",
                "type": "text",
              },
            ],
            "error": {
              "code": "KATCATS_TOOL_INCOMPLETE",
            },
            "isError": true,
            "meta": undefined,
            "type": "tool/result",
          },
        ]
      `)
      await expect(ctx.katcatsTeam.snapshot()).resolves.toEqual(before)
    } finally {
      await rmdir(statePath)
      await rename(backup, statePath)
    }
  })

  it('renames the previous default main member and title on cold startup while retaining its conversation and files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xiaojing-main-name-upgrade-'))
    roots.push(root)
    const first = await loadComposition(root, [textResponse('Earlier conversation.')], false, 'Katcats')
    const main = (await first.ctx.katcatsTeam.snapshot()).bots[0]!
    const ordinary = (await first.ctx.katcatsTeam.createBot({ name: 'Katcats' })).bot
    await send(requireAgent(first.ctx, main), 'Keep this conversation.')
    const canary = join(main.workDir, 'keep.txt')
    await writeFile(canary, 'Keep the existing main Bot files.')
    const before = await first.ctx.katcatsTeam.snapshot()
    const history = await first.ctx.sessionController.inspect(main.sessionId)
    const ordinaryHistory = await first.ctx.sessionController.inspect(ordinary.sessionId)
    await first.ctx.fiber.dispose()
    contexts.delete(first.ctx)

    const second = await loadComposition(root, [textResponse('New identity.')])
    const after = await second.invoke('snapshot')
    expect(after).toEqual({ ...before, revision: before.revision + 2,
      bots: before.bots.map(bot => bot.id === mainBotId ? { ...bot, name: '小兢会计' } : bot) })
    const migrated = await second.ctx.sessionController.inspect(main.sessionId)
    expect(foldSessionTitle(migrated.events)?.title).toBe('小兢会计')
    expect(migrated.events.slice(0, history.events.length)).toEqual(history.events)
    expect(migrated.events.slice(history.events.length).map(event => event.type)).toEqual(['session/end-seed', 'session/title'])
    expect(await readFile(canary, 'utf8')).toBe('Keep the existing main Bot files.')
    expect((await second.ctx.sessionController.inspect(ordinary.sessionId)).events).toEqual(ordinaryHistory.events)
    await send(requireAgent(second.ctx, main), 'What is your name now?')
    const identity = second.adapter.requests[0]!.messages.filter(message => message.role === 'system')
      .flatMap(message => message.content.filter(part => part.type === 'text').map(part => part.text))
    expect(identity.at(-1)).toContain('You are 小兢会计, a member of 瑞华云财务共享团队.')
    const migratedHistory = await second.ctx.sessionController.inspect(main.sessionId)
    await second.ctx.fiber.dispose()
    contexts.delete(second.ctx)

    const third = await loadComposition(root)
    expect(await third.invoke('snapshot')).toEqual(after)
    expect(third.ctx.agents.list()).toEqual([])
    expect((await third.ctx.sessionController.inspect(main.sessionId)).events).toEqual(migratedHistory.events)
  })

  it('retains a custom main name and its unchanged Session when the product default changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xiaojing-custom-main-name-'))
    roots.push(root)
    const first = await loadComposition(root, [], false, '我的财务主管')
    const before = await first.ctx.katcatsTeam.snapshot()
    const main = before.bots[0]!
    const history = await first.ctx.sessionController.inspect(main.sessionId)
    await first.ctx.fiber.dispose()
    contexts.delete(first.ctx)

    const second = await loadComposition(root)
    expect(await second.invoke('snapshot')).toEqual(before)
    expect(second.ctx.agents.list()).toEqual([])
    expect((await second.ctx.sessionController.inspect(main.sessionId)).events).toEqual(history.events)
  })

  it('creates and edits private members whose directory and Session titles survive a cold reload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-team-loader-'))
    roots.push(root)
    const first = await loadComposition(root)
    const baseline = await first.ctx.katcatsTeam.snapshot()
    await expect(first.invoke('snapshot')).resolves.toEqual(baseline)
    expect(baseline.groups).toEqual([
      { id: ordinaryGroupId, name: '普通 Bot', kind: 'bots', system: true },
      { id: chatGroupId, name: '群聊', kind: 'chats', system: true },
    ])
    expect(baseline.bots).toEqual([expect.objectContaining({
      id: mainBotId, kind: 'main', name: '小兢会计', groupId: null,
      avatar: { shape: 'classic', color: '#FF2849' }, model: { kind: 'follow-global' },
    })])
    await expectWorkspaceForBot(first.ctx, baseline.bots[0]!)

    await expect(first.invoke('createBot', { request: { name: '  Writer  ', avatar: { shape: 'round', color: '#12BB77' } } }))
      .resolves.toMatchObject({ bot: { name: 'Writer', kind: 'ordinary', groupId: ordinaryGroupId } })
    const created = (await first.ctx.katcatsTeam.snapshot()).bots.find(bot => bot.kind === 'ordinary')
    if (created === undefined) throw new Error('Owner Remote did not create an ordinary member')
    expect(created.sessionId).not.toBe(baseline.bots[0]!.sessionId)
    expect(created.workDir).toBe(join(root, 'workspaces', 'bots', created.id))
    await expectWorkspaceForBot(first.ctx, created)
    const editedFields = {
      name: 'Editorial', role: 'Draft and edit technical articles.', avatar: { shape: 'fluffy', color: '#AA44FF' },
    }
    await expect(first.invoke('updateBot', { request: { id: created.id, ...editedFields } }))
      .resolves.toMatchObject({ bot: { ...created, ...editedFields } })
    const saved = await first.ctx.katcatsTeam.snapshot()
    const live = await first.ctx.sessionController.inspect(created.sessionId)
    expect(live.meta.cwd).toBe(created.workDir)
    expect(foldSessionTitle(live.events)?.title).toBe('Editorial')
    expect(live.events.some(event => event.type === 'request/header')).toBe(false)
    expect(saved.bots.find(bot => bot.id === mainBotId)).toEqual(baseline.bots[0])

    await expect(first.invoke('createBot', { request: { name: ' ' } }))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(first.invoke('snapshot')).resolves.toEqual(saved)
    await first.ctx.fiber.dispose()
    contexts.delete(first.ctx)

    const second = await loadComposition(root)
    await expect(second.invoke('snapshot')).resolves.toEqual(saved)
    for (const bot of saved.bots) await expectWorkspaceForBot(second.ctx, bot)
    expect(second.ctx.agents.get(created.sessionId)).toBeUndefined()
    const cold = await second.ctx.sessionController.inspect(created.sessionId)
    expect(cold.meta.cwd).toBe(created.workDir)
    expect(foldSessionTitle(cold.events)?.title).toBe('Editorial')
    expect(cold.events).toEqual(live.events)
    expect(second.ctx.agents.get(created.sessionId)).toBeUndefined()
  })

  it('repairs missing Workspace registrations and memberships without changing member Sessions or history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-workspace-recovery-'))
    roots.push(root)
    const first = await loadComposition(root)
    await first.invoke('createBot', { request: { name: 'Writer' } })
    const saved = await first.ctx.katcatsTeam.snapshot()
    const main = saved.bots.find(bot => bot.id === mainBotId)
    const writer = saved.bots.find(bot => bot.name === 'Writer')
    if (main === undefined || writer === undefined) throw new Error('Fixture members were not created')
    const mainWorkspace = await expectWorkspaceForBot(first.ctx, main)
    const writerWorkspace = await expectWorkspaceForBot(first.ctx, writer)
    const histories = await Promise.all(saved.bots.map(bot => first.ctx.sessionController.inspect(bot.sessionId)))
    await mainWorkspace.detachSession(main.sessionId)
    await first.ctx.workspaceRegistry.delete(writerWorkspace.id)
    expect(mainWorkspace.sessionIds).toEqual([])
    expect(await first.ctx.workspaceRegistry.resolveByPath(writer.workDir)).toBeUndefined()
    await first.ctx.fiber.dispose()
    contexts.delete(first.ctx)

    const second = await loadComposition(root)
    await expect(second.invoke('snapshot')).resolves.toEqual(saved)
    for (const [index, bot] of saved.bots.entries()) {
      await expectWorkspaceForBot(second.ctx, bot)
      expect(second.ctx.agents.get(bot.sessionId)).toBeUndefined()
      const cold = await second.ctx.sessionController.inspect(bot.sessionId)
      expect(cold.meta.cwd).toBe(bot.workDir)
      expect(cold.events).toEqual(histories[index]!.events)
      expect(second.ctx.agents.get(bot.sessionId)).toBeUndefined()
    }
    expect((await second.ctx.workspaceRegistry.resolveByPath(main.workDir))?.id).toBe(mainWorkspace.id)
    expect(second.ctx.workspaceRegistry.list()).toHaveLength(saved.bots.length)
  })

  it('retains a fixed member model across reload and rejects unavailable selections without changing other defaults', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-model-loader-'))
    roots.push(root)
    const first = await loadComposition(root)
    const defaultModel = { provider: 'fixture', model: 'fixture-model' }
    expect((await first.ctx.sessionController.modelCatalog()).default).toEqual(defaultModel)
    await first.invoke('createBot', { request: { name: 'Writer' } })
    await first.invoke('createBot', { request: { name: 'Coder' } })
    const before = await first.ctx.katcatsTeam.snapshot()
    const writer = before.bots.find(bot => bot.name === 'Writer')
    const coder = before.bots.find(bot => bot.name === 'Coder')
    if (writer === undefined || coder === undefined) throw new Error('Fixture members were not created')
    const model = { kind: 'override', provider: 'fixture', model: 'specialist-model' }
    await expect(first.invoke('updateBot', { request: { id: writer.id, model } }))
      .resolves.toMatchObject({ bot: { id: writer.id, model } })
    const saved = await first.ctx.katcatsTeam.snapshot()
    expect(saved.bots.find(bot => bot.id === coder.id)).toEqual(coder)
    expect(first.ctx.agentDefaultModel.currentSelection()).toEqual(defaultModel)
    const signal = new AbortController().signal
    const selected = await first.ctx.sessionController.projections({ sessionId: writer.sessionId }, signal)
    expect(selected).toMatchObject({
      kind: 'sequenced', values: { modelSelection: { lastUsed: null, next: { provider: 'fixture', model: 'specialist-model' } } },
    })
    await expect(first.invoke('updateBot', {
      request: { id: writer.id, model: { ...model, model: 'unavailable-model' } },
    })).rejects.toMatchObject({ code: 'session/model-unavailable' })
    const afterRejected = await first.ctx.katcatsTeam.snapshot()
    expect(afterRejected.bots).toEqual(saved.bots)
    expect(afterRejected.groups).toEqual(saved.groups)
    await expect(first.invoke('snapshot')).resolves.toEqual(afterRejected)
    expect(await first.ctx.sessionController.projections({ sessionId: writer.sessionId }, signal)).toEqual(selected)
    expect((await first.ctx.sessionController.modelCatalog()).default).toEqual(defaultModel)
    await first.ctx.fiber.dispose()
    contexts.delete(first.ctx)

    const second = await loadComposition(root)
    await expect(second.invoke('snapshot')).resolves.toEqual(afterRejected)
    expect(second.ctx.agentDefaultModel.currentSelection()).toEqual(defaultModel)
    expect(second.ctx.agents.get(writer.sessionId)).toBeUndefined()
    const cold = await second.ctx.sessionController.projections({ sessionId: writer.sessionId }, signal)
    expect(cold).toEqual(selected)
    expect(second.ctx.agents.get(writer.sessionId)).toBeUndefined()
  })
})

describe('Katcats groups through the real Loader and direct member turns', () => {
  it('retries only a malformed model request and completes its group handoff without replaying saved work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-malformed-recovery-'))
    roots.push(root)
    let aId = ''
    let bId = ''
    const { ctx, adapter } = await loadComposition(root, [
      () => toolCallResponse('save-roles-once', 'set_group_roles', {
        manager_id: aId, roles: [{ bot_id: aId, role: 'Coordinate the review.' }, { bot_id: bId, role: 'Review the saved draft.' }],
      }),
      malformedHandoff(),
      () => toolCallResponse('confirmed-handoff', 'request_group_member', { bot_id: bId, message: 'Review the saved draft.' }, 'B, please review the saved draft.'),
      textResponse('B reviewed the saved draft.'),
      textResponse('A delivered the reviewed draft.'),
    ], true, undefined, true)
    const a = (await ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const b = (await ctx.katcatsTeam.createBot({ name: 'B' })).bot
    aId = a.id
    bId = b.id
    const chat = (await ctx.katcatsChats.createChat({ name: 'Recoverable handoff', memberIds: [a.id, b.id] })).chat
    await sendGroup(ctx, chat, '@A Save responsibilities and ask B to review the draft.')
    await settledGroup(ctx, chat.id)
    const saved = await ctx.katcatsChats.snapshot()
    expect(saved.chats[0]).toMatchObject({ status: 'active', pauseReason: null, error: null, managerId: a.id,
      memberRoles: [{ botId: a.id, role: 'Coordinate the review.' }, { botId: b.id, role: 'Review the saved draft.' }] })
    expect(saved.deliveries.map(delivery => ({ bot: delivery.botId, state: delivery.state }))).toEqual([
      { bot: a.id, state: 'completed' }, { bot: b.id, state: 'completed' },
    ])
    expect(adapter.requests.map(request => request.sessionId)).toEqual([
      chat.executors[0]!.sessionId, chat.executors[0]!.sessionId, chat.executors[0]!.sessionId,
      chat.executors[1]!.sessionId, chat.executors[0]!.sessionId,
    ])
    const firstGroupPrompt = JSON.stringify(adapter.requests[0]!.messages.filter(message => message.role === 'system'))
    expect(firstGroupPrompt).toContain('member of 瑞华云财务共享团队, working in group Recoverable handoff')
    expect(firstGroupPrompt).toContain('use the exact team name 瑞华云财务共享团队')
    expect(firstGroupPrompt).not.toContain('瑞华云财务共享团队团队')
    expect(firstGroupPrompt).not.toContain('Katcats.AI')
    expect(adapter.requests[2]!.messages).toEqual(adapter.requests[1]!.messages)
    const member = (await ctx.sessionController.inspect(chat.executors[0]!.sessionId)).events
    expect(member.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual(['set_group_roles', 'request_group_member'])
    expect(member.filter(event => event.type === 'llm/retry').map(event => ({ step: event.data.step, retry: event.data.retry,
      code: event.data.failure.code }))).toEqual([{ step: 2, retry: 1, code: 'MALFORMED_RESPONSE' }])
    expect(member.filter(event => event.type === 'assistant/attempt')).toHaveLength(1)
    const transcript = (await ctx.sessionController.inspect(chat.rootSessionId)).events.flatMap(event => event.type === 'user/message'
      ? [{ speaker: event.data.source.kind === 'katcats-group-relay' ? event.data.source.sender.name : 'owner', content: event.data.content }] : [])
    expect(transcript).toMatchSnapshot()
    expect(JSON.stringify(transcript)).not.toContain('Unconfirmed handoff.')
  })

  it('pauses with a visible malformed-response error after the bounded request retry budget is exhausted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-malformed-exhausted-'))
    roots.push(root)
    const { ctx, adapter } = await loadComposition(root, [malformedHandoff(), malformedHandoff(), malformedHandoff(),
      textResponse('A completed the new request after Stop.')], true, undefined, true)
    const a = (await ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const chat = (await ctx.katcatsChats.createChat({ name: 'Bounded recovery', memberIds: [a.id] })).chat
    await sendGroup(ctx, chat, '@A Arrange a review.')
    await settledGroup(ctx, chat.id)
    const saved = await ctx.katcatsChats.snapshot()
    expect(adapter.requests).toHaveLength(3)
    expect(saved.chats[0]).toMatchObject({ status: 'paused', pauseReason: 'unknown-result',
      error: { code: 'KATCATS_CHAT_MEMBER_MALFORMED_RESPONSE' } })
    expect(saved.deliveries).toHaveLength(1)
    expect(saved.deliveries[0]).toMatchObject({ state: 'unknown', receipt: null })
    const member = (await ctx.sessionController.inspect(chat.executors[0]!.sessionId)).events
    expect(member.filter(event => event.type === 'llm/retry').map(event => event.data.retry)).toEqual([1, 2])
    expect(member.filter(event => event.type === 'assistant/attempt')).toHaveLength(3)
    expect(member.some(event => event.type === 'tool/call')).toBe(false)
    await expect(ctx.katcatsChats.resume(control(saved.chats[0]!))).rejects.toThrow()
    expect(adapter.requests).toHaveLength(3)
    await ctx.katcatsChats.stop(control(saved.chats[0]!))
    await sendGroup(ctx, chat, '@A Start a new request after Stop.')
    await settledGroup(ctx, chat.id)
    const recovered = await ctx.katcatsChats.snapshot()
    expect(recovered.chats[0]).toMatchObject({ status: 'active', pauseReason: null, error: null })
    expect(recovered.deliveries).toHaveLength(2)
    expect(recovered.deliveries[0]).toMatchObject({ id: saved.deliveries[0]!.id, state: 'unknown', receipt: null })
    expect(recovered.deliveries[1]).toMatchObject({ state: 'completed', receipt: { text: 'A completed the new request after Stop.' } })
    expect(adapter.requests).toHaveLength(4)
  })

  it('shows no member handoff when a model only says that it assigned work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-spoken-assignment-'))
    roots.push(root)
    const { ctx, adapter } = await loadComposition(root, [textResponse('I assigned the review to B.')], true)
    const a = (await ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const b = (await ctx.katcatsTeam.createBot({ name: 'B' })).bot
    const chat = (await ctx.katcatsChats.createChat({ name: 'Actual assignments', memberIds: [a.id, b.id] })).chat
    const other = (await ctx.katcatsChats.createChat({ name: 'Other group', memberIds: [a.id, b.id] })).chat
    await sendGroup(ctx, chat, '@A Please arrange a review.')
    await settledGroup(ctx, chat.id)
    const snapshot = await ctx.katcatsChats.snapshot()
    expect(snapshot.deliveries).toHaveLength(1)
    const log = await ctx.sessionController.inspect(chat.rootSessionId)
    const activity = log.events.filter(event => event.type === 'katcats/group-task-lifecycle')
    expect(activity.map(event => event.data.status)).toEqual(['queued', 'started', 'completed'])
    expect(activity.every(event => event.data.actor.kind === 'owner' && event.data.target.botId === a.id)).toBe(true)
    for (const id of [other.rootSessionId, a.sessionId, b.sessionId]) {
      expect((await ctx.sessionController.inspect(id)).events.some(event => event.type === 'katcats/group-task-lifecycle')).toBe(false)
    }
    expect(adapter.requests.map(request => request.sessionId)).toEqual([chat.executors[0]!.sessionId])
  })

  it('keeps real public handoff speech and task history exactly once after cold group recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-public-handoff-history-'))
    roots.push(root)
    let bId = ''
    const first = await loadComposition(root, [
      () => toolCallResponse('handoff-with-public-text', 'request_group_member',
        { bot_id: bId, message: 'Review the saved draft.' }, 'B, please review the saved draft.'),
      textResponse('B reviewed the draft.'), textResponse('A finished the reviewed draft.'),
    ], true)
    const a = (await first.ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const b = (await first.ctx.katcatsTeam.createBot({ name: 'B' })).bot
    bId = b.id
    const chat = (await first.ctx.katcatsChats.createChat({ name: 'Public handoff', memberIds: [a.id, b.id] })).chat
    await sendGroup(first.ctx, chat, '@A Draft and ask B to review.')
    await settledGroup(first.ctx, chat.id)
    const log = await first.ctx.sessionController.inspect(chat.rootSessionId)
    const publicMessages = log.events.filter(event => event.type === 'user/message')
      .filter(event => event.data.source.kind === 'katcats-group-relay')
    expect(publicMessages.map(event => event.data.content)).toEqual([
      [{ type: 'text', text: 'B, please review the saved draft.' }],
      [{ type: 'text', text: 'B reviewed the draft.' }],
      [{ type: 'text', text: 'A finished the reviewed draft.' }],
    ])
    expect(JSON.stringify(first.adapter.requests.at(-1)?.messages)).toContain('B, please review the saved draft.')
    const activity = log.events.filter(event => event.type === 'katcats/group-task-lifecycle')
    await first.ctx.fiber.dispose()
    contexts.delete(first.ctx)
    const cold = await loadComposition(root, [], true)
    const restored = await cold.ctx.sessionController.inspect(chat.rootSessionId)
    expect(restored.events.filter(event => event.type === 'user/message')
      .filter(event => event.data.source.kind === 'katcats-group-relay')).toEqual(publicMessages)
    expect(restored.events.filter(event => event.type === 'katcats/group-task-lifecycle')).toEqual(activity)
    expect(cold.adapter.requests).toEqual([])
  })

  it('does not publish or execute a handoff whose real admission write failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-assignment-write-failed-'))
    roots.push(root)
    let bId = ''
    const { ctx, adapter } = await loadComposition(root, [
      () => toolCallResponse('failed-handoff', 'request_group_member', { bot_id: bId, message: 'Review the draft.' }),
      textResponse('The review request was not confirmed.'),
    ], true)
    const a = (await ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const b = (await ctx.katcatsTeam.createBot({ name: 'B' })).bot
    bId = b.id
    const chat = (await ctx.katcatsChats.createChat({ name: 'Admission failure', memberIds: [a.id, b.id] })).chat
    const domain = ctx.storageDomain.get(chatsDomainSpec.name)!
    const write = domain.global.set.bind(domain.global)
    const spy = vi.spyOn(domain.global, 'set').mockImplementation(async (value) => {
      if (chatsStateSchema.parse(value).deliveries.some(delivery => delivery.source.kind === 'tool')) {
        throw new Error('Synthetic handoff write failure')
      }
      await write(value)
    })
    try {
      await sendGroup(ctx, chat, '@A Ask B to review.')
      await settledGroup(ctx, chat.id)
    } finally { spy.mockRestore() }
    const log = await ctx.sessionController.inspect(chat.rootSessionId)
    expect(log.events.filter(event => event.type === 'katcats/group-task-lifecycle')
      .every(event => event.data.target.botId === a.id && event.data.actor.kind === 'owner')).toBe(true)
    expect((await ctx.katcatsChats.snapshot()).deliveries).toHaveLength(1)
    expect(adapter.requests.map(request => request.sessionId)).toEqual([chat.executors[0]!.sessionId, chat.executors[0]!.sessionId])
  })

  it('contains an unconfirmed handoff transcript and requires inspection before cold dispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-assignment-flush-failed-'))
    roots.push(root)
    let bId = ''
    const first = await loadComposition(root, [
      () => toolCallResponse('queued-before-flush-failure', 'request_group_member', { bot_id: bId, message: 'Review exactly once.' }),
      textResponse('The review request requires inspection.'),
    ], true)
    const a = (await first.ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const b = (await first.ctx.katcatsTeam.createBot({ name: 'B' })).bot
    bId = b.id
    const chat = (await first.ctx.katcatsChats.createChat({ name: 'Unconfirmed activity', memberIds: [a.id, b.id] })).chat
    let failed = false
    const remove = first.ctx.on('session/flush', (session) => {
      if (failed || session.id !== chat.rootSessionId) return
      if (!session.snapshotEvents().some(event => event.type === 'katcats/group-task-lifecycle'
        && event.data.target.botId === b.id && event.data.status === 'queued')) return
      failed = true
      throw new Error('Synthetic handoff transcript flush failure')
    })
    try {
      await sendGroup(first.ctx, chat, '@A Ask B to review once.')
      await settledGroup(first.ctx, chat.id)
    } finally { remove() }
    expect(failed).toBe(true)
    const pending = (await first.ctx.katcatsChats.snapshot()).deliveries.find(delivery => delivery.botId === b.id)!
    expect(pending.state).toBe('accepted')
    expect((await first.ctx.katcatsChats.snapshot()).chats[0]).toMatchObject({ status: 'paused',
      error: { code: 'KATCATS_CHAT_DURABILITY_UNCONFIRMED' } })
    expect(first.adapter.requests.every(request => request.sessionId === chat.executors[0]!.sessionId)).toBe(true)
    await first.ctx.fiber.dispose()
    contexts.delete(first.ctx)
    const second = await loadComposition(root, [], true)
    const snapshot = await second.ctx.katcatsChats.snapshot()
    await expect(second.ctx.katcatsChats.resume(control(snapshot.chats[0]!))).rejects.toThrow()
    const after = await second.ctx.katcatsChats.snapshot()
    expect(after.deliveries.find(delivery => delivery.id === pending.id)).toMatchObject({ state: 'accepted', receipt: null })
    const activity = (await second.ctx.sessionController.inspect(chat.rootSessionId)).events
      .filter(event => event.type === 'katcats/group-task-lifecycle').filter(event => event.data.deliveryId === pending.id)
    expect(activity.map(event => event.data.status)).toEqual(['queued'])
    expect(new Set(activity.map(event => event.data.eventId)).size).toBe(1)
    expect(second.adapter.requests).toEqual([])
  })

  it.each(['accepted', 'completed', 'partial'] as const)('preserves a bound later owner input from an older shared run with %s work while a budget-paused message queues', async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-old-shared-owner-run-'))
    roots.push(root)
    const { ctx, adapter } = await loadComposition(root, mode === 'accepted'
      ? [textResponse('The earlier first answer.')]
      : [textResponse('The earlier first answer.'), textResponse('The earlier second answer.')], true)
    const a = (await ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const b = (await ctx.katcatsTeam.createBot({ name: 'B' })).bot
    const chat = (await ctx.katcatsChats.createChat({ name: 'Older owner records', memberIds: [a.id, b.id], relayLimit: 2 })).chat
    await sendGroup(ctx, chat, '@A First older question.')
    await settledGroup(ctx, chat.id)
    if (mode !== 'accepted') {
      await sendGroup(ctx, chat, '@A Second older question.')
      await settledGroup(ctx, chat.id)
    }
    const domain = ctx.storageDomain.get(chatsDomainSpec.name)!
    let legacy = chatsStateSchema.parse(domain.global.get())
    const first = legacy.deliveries[0]!
    if (mode === 'accepted') {
      const request = { sessionId: chat.rootSessionId, requestId: brandString<SessionRequestId>('old-later-request'),
        mode: 'queue' as const, content: [{ type: 'text' as const, text: '@A Second older question.' }] }
      const userMessage = createUserMessage({ content: request.content, source: { kind: 'user', rpcId: request.requestId } })
      await new GroupTranscript(ctx).publishUser(chat, userMessage)
      const input: ChatInbound = { chatId: chat.id, runId: first.runId, generation: first.generation,
        requestId: request.requestId, requestDigest: groupRequestDigest(request), userMessage,
        recipients: [a.id, b.id], addressing: 'broadcast', state: 'published' }
      const pending: ChatDelivery = { ...first, id: brandString<ChatDeliveryId>('old-later-delivery'),
        source: { kind: 'owner-message', messageId: userMessage.id }, message: request.content[0]!.text,
        inputMessageId: brandString<MessageId>('old-later-worker-input'), relayMessageId: brandString<MessageId>('old-later-relay'),
        state: 'accepted', receipt: null, pass: null, relayed: false, error: null }
      legacy = { ...legacy, inbounds: [...legacy.inbounds, input], deliveries: [...legacy.deliveries, pending] }
    }
    // Older v1 directories admitted successive owner inputs into one retained run.
    legacy = chatsStateSchema.parse({ ...legacy,
      chats: legacy.chats.map(value => ({ ...value, status: 'paused', pauseReason: 'relay-limit', generation: first.generation,
        run: { id: first.runId, generation: first.generation, relayCount: 2 } })),
      inbounds: legacy.inbounds.map((input, index) => ({ ...input, runId: first.runId, generation: first.generation,
        ...(mode === 'partial' && index === 1 ? { recipients: [a.id, b.id], addressing: 'broadcast' } : {}) })),
      deliveries: legacy.deliveries.map(delivery => ({ ...delivery, runId: first.runId, generation: first.generation })),
    })
    await domain.global.set(legacy)
    const bound = legacy.inbounds[1]!
    await sendGroup(ctx, chat, '@A Where is the final deliverable?')
    await settledGroup(ctx, chat.id)
    const saved = chatsStateSchema.parse(domain.global.get())
    expect(saved.inbounds.find(input => input.userMessage.id === bound.userMessage.id)).toEqual(bound)
    for (const prior of legacy.deliveries) {
      const retained = saved.deliveries.find(delivery => delivery.id === prior.id)!
      expect(retained).toMatchObject({ id: prior.id, runId: prior.runId, generation: prior.generation, source: prior.source,
        executorSessionId: prior.executorSessionId, inputMessageId: prior.inputMessageId, relayMessageId: prior.relayMessageId,
        receipt: prior.receipt })
      expect(retained.state).toBe(prior.state)
    }
    expect(saved.deliveries).toEqual(legacy.deliveries)
    expect(saved.chats[0]).toMatchObject({ status: 'paused', pauseReason: 'relay-limit', generation: first.generation })
    expect(adapter.requests).toHaveLength(mode === 'accepted' ? 1 : 2)
    expect(adapter.requests.some(request => request.sessionId === chat.executors[1]!.sessionId)).toBe(false)
  })

  it('keeps earlier queued owner questions behind the budget-paused dependent task until Continue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-queued-owner-budget-'))
    roots.push(root)
    let bId = ''
    const { ctx, adapter } = await loadComposition(root, [
      () => toolCallResponse('queued-old-handoff', 'request_group_member', { bot_id: bId, message: 'Keep reviewing the old draft.' }),
      textResponse('B completed the original draft review.'), textResponse('The original draft review is complete.'),
      textResponse('The finalized deliverable is here.'), textResponse('The final delivery is here.'),
    ], true)
    const a = (await ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const b = (await ctx.katcatsTeam.createBot({ name: 'B' })).bot
    bId = b.id
    const chat = (await ctx.katcatsChats.createChat({ name: 'Queued owner questions', memberIds: [a.id, b.id], relayLimit: 1 })).chat
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let held = false
    const remove = ctx.on('llm/stream', (request, next) => {
      const stream = next()
      if (request.sessionId !== chat.executors[0]!.sessionId || held) return stream
      held = true
      return (async function* () { entered.resolve(undefined); await release.promise; yield* stream })()
    })
    const stableInputs = () => chatsStateSchema.parse(ctx.storageDomain.get(chatsDomainSpec.name)!.global.get()).inbounds
      .map(input => ({ requestId: input.requestId, requestDigest: input.requestDigest, userMessage: input.userMessage }))
    try {
      await sendGroup(ctx, chat, 'Prepare the first draft.')
      await entered.promise
      await sendGroup(ctx, chat, 'Where is the finalized deliverable?')
      await sendGroup(ctx, chat, 'Where is the final delivery?')
      const accepted = stableInputs()
      release.resolve(undefined)
      await vi.waitFor(async () => {
        expect((await ctx.katcatsChats.snapshot()).chats[0]).toMatchObject({ status: 'paused', pauseReason: 'relay-limit' })
      })
      const paused = await ctx.katcatsChats.snapshot()
      expect(paused.deliveries.map(delivery => delivery.state)).toEqual(['running', 'accepted'])
      expect(adapter.requests).toHaveLength(1)
      await ctx.katcatsChats.resume(control(paused.chats[0]!))
      await settledGroup(ctx, chat.id)
      const finished = await ctx.katcatsChats.snapshot()
      expect(finished.deliveries.flatMap(delivery => delivery.receipt === null ? [] : [delivery.receipt.text])).toEqual([
        'The original draft review is complete.', 'B completed the original draft review.',
        'The finalized deliverable is here.', 'The final delivery is here.',
      ])
      expect(finished.deliveries[1]).toMatchObject({ state: 'completed', relayed: true })
      expect(finished.chats[0]).toMatchObject({ status: 'active', pauseReason: null, run: null })
      expect(finished.deliveries[0]).toMatchObject({ state: 'completed', relayed: true })
      expect(adapter.requests.map(request => request.sessionId)).toEqual([chat.executors[0]!.sessionId, chat.executors[1]!.sessionId,
        chat.executors[0]!.sessionId, chat.executors[0]!.sessionId, chat.executors[0]!.sessionId])
      expect(JSON.stringify(adapter.requests[0]?.messages)).not.toContain('Where is the finalized deliverable?')
      expect(JSON.stringify(adapter.requests[3]?.messages)).not.toContain('Where is the final delivery?')
      expect(JSON.stringify(adapter.requests[4]?.messages)).toContain('The finalized deliverable is here.')
      expect(stableInputs()).toEqual(accepted)
      expect((await ctx.sessionController.inspect(chat.rootSessionId)).events.filter(event => event.type === 'user/message'))
        .toHaveLength(7)
    } finally { release.resolve(undefined); remove() }
  })

  it('keeps accepted legacy broadcast passes silent while a newly addressed member must answer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-all-pass-explicit-'))
    roots.push(root)
    const { ctx, adapter } = await loadComposition(root, [
      toolCallResponse('a-broadcast-pass', 'pass_group_turn', {}),
      toolCallResponse('b-broadcast-pass', 'pass_group_turn', {}),
      toolCallResponse('a-explicit-pass-denied', 'pass_group_turn', {}),
      textResponse('A answers the direct owner question.'),
    ], true)
    const a = (await ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const b = (await ctx.katcatsTeam.createBot({ name: 'B' })).bot
    const chat = (await ctx.katcatsChats.createChat({ name: 'Pass policy', memberIds: [a.id, b.id] })).chat
    await resumeLegacyBroadcast(ctx, chat, 'Contribute only if this update needs your role.')
    await settledGroup(ctx, chat.id)
    const passed = await ctx.katcatsChats.snapshot()
    expect(passed.chats[0]).toMatchObject({ status: 'active', run: null })
    expect(passed.deliveries.map(delivery => delivery.state)).toEqual(['passed', 'passed'])
    expect((await ctx.sessionController.inspect(chat.rootSessionId)).events.filter(event => event.type === 'user/message'))
      .toHaveLength(1)
    await sendGroup(ctx, chat, '@A Please answer my direct question.')
    await settledGroup(ctx, chat.id)
    const finished = await ctx.katcatsChats.snapshot()
    expect(finished.deliveries.at(-1)).toMatchObject({ state: 'completed', receipt: { text: 'A answers the direct owner question.' } })
    const log = await ctx.sessionController.inspect(chat.executors[0]!.sessionId)
    expect(log.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'a-explicit-pass-denied'))
      .toMatchObject({ data: { message: { isError: true } } })
    expect(adapter.requests).toHaveLength(4)
    expect(adapter.requests.some(request => request.sessionId === chat.rootSessionId)).toBe(false)
  })

  it('does not let an older budget driver pause the fresh owner run while its failure is settling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-owner-budget-race-'))
    roots.push(root)
    const { ctx, adapter } = await loadComposition(root, [textResponse('The saved draft.'), textResponse('The final deliverable.')], true)
    const a = (await ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const b = (await ctx.katcatsTeam.createBot({ name: 'B' })).bot
    const chat = (await ctx.katcatsChats.createChat({ name: 'Owner race', memberIds: [a.id, b.id], relayLimit: 1 })).chat
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const readTeam = ctx.katcatsTeam.snapshot.bind(ctx.katcatsTeam)
    let held = false
    const barrier = vi.spyOn(ctx.katcatsTeam, 'snapshot').mockImplementation(async () => {
      const value = await readTeam()
      const current = chatsStateSchema.parse(ctx.storageDomain.get(chatsDomainSpec.name)!.global.get()).chats[0]!
      if (!held && current.pauseReason === 'relay-limit') {
        held = true
        entered.resolve(undefined)
        await release.promise
      }
      return value
    })
    try {
      await sendGroup(ctx, chat, '@A @B Prepare the initial draft.')
      await entered.promise
      const previous = (await ctx.katcatsChats.snapshot()).chats[0]!
      expect((await ctx.katcatsChats.snapshot()).activities[0]?.processing).toBe(true)
      const replacement = sendGroup(ctx, chat, '@A Where is the final deliverable?', 'steer')
      await vi.waitFor(async () => {
        expect((await ctx.katcatsChats.snapshot()).chats[0]!.generation).toBe(previous.generation + 1)
      })
      const admitted = (await ctx.katcatsChats.snapshot()).chats[0]!
      expect(admitted).toMatchObject({ status: 'active', generation: previous.generation + 1, run: { relayCount: 0 } })
      release.resolve(undefined)
      await replacement
      await settledGroup(ctx, chat.id)
      const finished = await ctx.katcatsChats.snapshot()
      expect(finished.chats[0]).toMatchObject({ status: 'active', run: null, error: null })
      expect(finished.deliveries.map(delivery => delivery.state)).toEqual(['completed', 'failed', 'completed'])
      expect(finished.deliveries.at(-1)?.receipt?.text).toBe('The final deliverable.')
      expect(adapter.requests.map(request => request.sessionId)).toEqual([chat.executors[0]!.sessionId, chat.executors[0]!.sessionId])
    } finally { release.resolve(undefined); barrier.mockRestore() }
  })

  it('keeps ordinary owner turns on separate budgets and respects manual pauses and stopped generations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-owner-control-budget-'))
    roots.push(root)
    const { ctx, adapter } = await loadComposition(root, [
      textResponse('First ordinary answer.'), textResponse('Second ordinary answer.'),
      textResponse('The manually queued question is answered after Continue.'), textResponse('The new request after Stop is answered.'),
    ], true)
    const a = (await ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const chat = (await ctx.katcatsChats.createChat({ name: 'Manual controls', memberIds: [a.id], relayLimit: 1 })).chat
    await sendGroup(ctx, chat, 'First ordinary question.')
    await settledGroup(ctx, chat.id)
    const first = (await ctx.katcatsChats.snapshot()).chats[0]!
    expect(first).toMatchObject({ status: 'active', run: null })
    await sendGroup(ctx, chat, 'Second ordinary question.')
    await settledGroup(ctx, chat.id)
    const second = (await ctx.katcatsChats.snapshot()).chats[0]!
    expect(second).toMatchObject({ status: 'active', run: null, generation: first.generation + 1 })
    await ctx.katcatsChats.pause(control(second))
    await sendGroup(ctx, chat, 'Wait until I explicitly continue.')
    await settledGroup(ctx, chat.id)
    const paused = (await ctx.katcatsChats.snapshot()).chats[0]!
    expect(paused).toMatchObject({ status: 'paused', pauseReason: 'owner', run: { relayCount: 0 } })
    expect(adapter.requests).toHaveLength(2)
    await ctx.katcatsChats.resume(control(paused))
    await settledGroup(ctx, chat.id)
    expect((await ctx.katcatsChats.snapshot()).deliveries.at(-1)?.receipt?.text)
      .toBe('The manually queued question is answered after Continue.')
    await ctx.katcatsChats.stop(control((await ctx.katcatsChats.snapshot()).chats[0]!))
    const stopped = (await ctx.katcatsChats.snapshot()).chats[0]!
    expect(stopped).toMatchObject({ status: 'stopped', run: null })
    expect(adapter.requests).toHaveLength(3)
    await sendGroup(ctx, chat, 'This is a new request after Stop.')
    await settledGroup(ctx, chat.id)
    const finished = (await ctx.katcatsChats.snapshot()).chats[0]!
    expect(finished).toMatchObject({ status: 'active', run: null, generation: stopped.generation + 1 })
    expect(adapter.requests).toHaveLength(4)
  })

  it('preserves a safe budget pause when another group was interrupted and answers a new owner question after cold reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-cold-owner-budget-'))
    roots.push(root)
    const first = await loadComposition(root, [textResponse('The saved draft.'), 'hang-slow'], true)
    const a = (await first.ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const b = (await first.ctx.katcatsTeam.createBot({ name: 'B' })).bot
    const budget = (await first.ctx.katcatsChats.createChat({ name: 'Budget pause', memberIds: [a.id, b.id], relayLimit: 1 })).chat
    const interrupted = (await first.ctx.katcatsChats.createChat({ name: 'Interrupted', memberIds: [b.id] })).chat
    await sendGroup(first.ctx, budget, '@A @B Prepare a draft.')
    await settledGroup(first.ctx, budget.id)
    const ready = Promise.withResolvers<undefined>()
    const remove = first.ctx.on('llm/stream', (request, next) => {
      if (request.sessionId === interrupted.executors[0]!.sessionId) ready.resolve(undefined)
      return next()
    })
    await sendGroup(first.ctx, interrupted, 'Continue a slow task.')
    await ready.promise
    const path = join(root, 'storage', 'katcats_chats_v3.json')
    const crashImage = await readFile(path, 'utf8')
    remove()
    await first.ctx.fiber.dispose()
    contexts.delete(first.ctx)
    await writeFile(path, crashImage)
    const cold = await loadComposition(root, [textResponse('B completed the original draft after Continue.'),
      textResponse('The finalized deliverable is saved.')], true)
    const restored = await cold.ctx.katcatsChats.snapshot()
    expect(restored.chats.find(chat => chat.id === budget.id)).toMatchObject({ status: 'paused', pauseReason: 'relay-limit' })
    expect(restored.chats.find(chat => chat.id === interrupted.id)).toMatchObject({ status: 'paused', pauseReason: 'restart' })
    expect(cold.adapter.requests).toHaveLength(0)
    await sendGroup(cold.ctx, interrupted, 'An uncertain earlier result must not resume automatically.')
    await settledGroup(cold.ctx, interrupted.id)
    expect(cold.adapter.requests).toHaveLength(0)
    await sendGroup(cold.ctx, budget, '@A Where is the final deliverable?')
    await settledGroup(cold.ctx, budget.id)
    expect(cold.adapter.requests).toHaveLength(0)
    const waiting = (await cold.ctx.katcatsChats.snapshot()).chats.find(chat => chat.id === budget.id)!
    expect(waiting).toMatchObject({ status: 'paused', pauseReason: 'relay-limit', generation: budget.generation + 1 })
    await cold.ctx.katcatsChats.resume(control(waiting))
    await settledGroup(cold.ctx, budget.id)
    const finished = await cold.ctx.katcatsChats.snapshot()
    expect(finished.deliveries.filter(delivery => delivery.chatId === budget.id).map(delivery => delivery.state))
      .toEqual(['completed', 'completed', 'completed'])
    expect(finished.deliveries.at(-1)?.receipt?.text).toBe('The finalized deliverable is saved.')
    expect(finished.deliveries.find(delivery => delivery.chatId === interrupted.id)?.state).toBe('unknown')
    expect(cold.adapter.requests.map(request => request.sessionId))
      .toEqual([budget.executors[1]!.sessionId, budget.executors[0]!.sessionId])
    expect(JSON.stringify(cold.adapter.requests[1]?.messages)).toContain('The saved draft.')
  })

  it('uses explicit steering for fresh budget windows without reviving superseded handoffs or duplicate submissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-owner-budget-window-'))
    roots.push(root)
    let bId = ''
    const { ctx, adapter } = await loadComposition(root, [
      () => toolCallResponse('old-review-handoff', 'request_group_member', { bot_id: bId, message: 'Keep reviewing the earlier draft.' }),
      textResponse('Here is the finalized deliverable.'),
      textResponse('Here is the final delivery location.'),
    ], true)
    const a = (await ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const b = (await ctx.katcatsTeam.createBot({ name: 'B' })).bot
    bId = b.id
    const chat = (await ctx.katcatsChats.createChat({ name: 'Owner questions', memberIds: [a.id, b.id], relayLimit: 1 })).chat
    const submit = (text: string, id: string, mode: 'queue' | 'steer' = 'queue') => ctx.katcatsChats.sendMessage({ sessionId: chat.rootSessionId,
      requestId: brandString<SessionRequestId>(id), mode, content: [{ type: 'text', text }] }, new AbortController().signal)
    await submit('Prepare the draft together.', 'budget-original')
    await vi.waitFor(async () => {
      expect((await ctx.katcatsChats.snapshot()).chats[0]).toMatchObject({ status: 'paused', pauseReason: 'relay-limit' })
    })
    const initial = await ctx.katcatsChats.snapshot()
    expect(initial.chats[0]).toMatchObject({ status: 'paused', pauseReason: 'relay-limit', run: { relayCount: 1 } })
    const oldPending = initial.deliveries[1]!
    expect(oldPending.state).toBe('accepted')
    await submit('Prepare the draft together.', 'budget-original')
    expect((await ctx.katcatsChats.snapshot()).chats).toEqual(initial.chats)
    expect(adapter.requests).toHaveLength(1)
    await submit('@A @B Where is the finalized deliverable?', 'budget-question-one', 'steer')
    await settledGroup(ctx, chat.id)
    const answered = await ctx.katcatsChats.snapshot()
    expect(answered.deliveries.some(delivery => delivery.receipt?.text === 'Here is the finalized deliverable.')).toBe(true)
    expect(answered.chats[0]?.generation).toBe(initial.chats[0]!.generation + 1)
    expect(answered.chats[0]?.run?.id).not.toBe(initial.chats[0]?.run?.id)
    expect(answered.deliveries.find(delivery => delivery.id === oldPending.id)).toMatchObject({
      state: 'failed', error: { code: 'superseded' }, inputMessageId: oldPending.inputMessageId,
    })
    await submit('@A @B Where is the finalized deliverable?', 'budget-question-one', 'steer')
    await settledGroup(ctx, chat.id)
    expect((await ctx.katcatsChats.snapshot()).chats).toEqual(answered.chats)
    expect(adapter.requests).toHaveLength(2)
    await submit('@A @B Where is the final delivery?', 'budget-question-two', 'steer')
    await settledGroup(ctx, chat.id)
    const finished = await ctx.katcatsChats.snapshot()
    expect(finished.chats[0]).toMatchObject({ status: 'paused', pauseReason: 'relay-limit', run: { relayCount: 1 } })
    expect(finished.chats[0]?.generation).toBe(initial.chats[0]!.generation + 2)
    expect(finished.deliveries.flatMap(delivery => delivery.receipt === null ? [] : [delivery.receipt.text])).toEqual([
      'Here is the finalized deliverable.', 'Here is the final delivery location.',
    ])
    expect(adapter.requests.map(request => request.sessionId)).toEqual(Array.from({ length: 3 }, () => chat.executors[0]!.sessionId))
    expect(JSON.stringify(adapter.requests[2]?.messages)).toContain('Here is the finalized deliverable.')
    expect(chatsStateSchema.parse(ctx.storageDomain.get(chatsDomainSpec.name)!.global.get()).inbounds).toHaveLength(3)
    expect((await ctx.sessionController.inspect(chat.rootSessionId)).events.flatMap(event => event.type === 'user/message'
      ? [{ speaker: event.data.source.kind === 'katcats-group-relay' ? event.data.source.sender.name : 'owner',
        content: event.data.content }] : [])).toMatchInlineSnapshot(`
          [
            {
              "content": [
                {
                  "text": "Prepare the draft together.",
                  "type": "text",
                },
              ],
              "speaker": "owner",
            },
            {
              "content": [
                {
                  "text": "@A @B Where is the finalized deliverable?",
                  "type": "text",
                },
              ],
              "speaker": "owner",
            },
            {
              "content": [
                {
                  "text": "Here is the finalized deliverable.",
                  "type": "text",
                },
              ],
              "speaker": "A",
            },
            {
              "content": [
                {
                  "text": "@A @B Where is the final delivery?",
                  "type": "text",
                },
              ],
              "speaker": "owner",
            },
            {
              "content": [
                {
                  "text": "Here is the final delivery location.",
                  "type": "text",
                },
              ],
              "speaker": "A",
            },
          ]
        `)
  })

  it('returns actual reviews to the waiting author and resumes its next review at the dispatch budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-member-revision-chain-'))
    roots.push(root)
    let aId = ''
    let bId = ''
    const { ctx, adapter } = await loadComposition(root, [
      () => toolCallResponse('ask-b-review', 'request_group_member',
        { bot_id: bId, message: 'Review this draft: A drafted the article.' }, 'A drafted the article.'),
      (request) => {
        expect(JSON.stringify(request.messages)).toContain('A drafted the article.')
        return toolCallResponse('ask-a-revise', 'request_group_member', { bot_id: aId, message: 'Revise the article with a concrete example.' })
      },
      (request) => {
        expect(JSON.stringify(request.messages)).toContain('This member is already working.')
        return textResponse('B requested a concrete example.')
      },
      (request) => {
        expect(JSON.stringify(request.messages)).toContain('B requested a concrete example.')
        return toolCallResponse('ask-b-revised', 'request_group_member',
          { bot_id: bId, message: 'Check my revised article with a concrete example.' }, 'A added a concrete example.')
      },
      textResponse('B approves the revised example.'),
      (request) => {
        expect(JSON.stringify(request.messages)).toContain('B approves the revised example.')
        return toolCallResponse('ask-b-final', 'request_group_member', { bot_id: bId, message: 'Check the final exported article.' })
      },
      textResponse('B checked the final export.'),
      (request) => {
        expect(JSON.stringify(request.messages)).toContain('B checked the final export.')
        return textResponse('A delivers the reviewed final article.')
      },
    ], true)
    const a = (await ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const b = (await ctx.katcatsTeam.createBot({ name: 'B' })).bot
    aId = a.id; bId = b.id
    const chat = (await ctx.katcatsChats.createChat({ name: 'Revision chain', memberIds: [a.id, b.id], relayLimit: 3 })).chat
    await sendGroup(ctx, chat, 'A writes an article and B reviews it; revise together as needed.')
    await vi.waitFor(async () => {
      expect((await ctx.katcatsChats.snapshot()).chats[0]).toMatchObject({ status: 'paused', pauseReason: 'relay-limit' })
    })
    const snapshot = await ctx.katcatsChats.snapshot()
    expect(snapshot.chats[0]).toMatchObject({ status: 'paused', pauseReason: 'relay-limit', run: { relayCount: 3 } })
    expect(snapshot.deliveries.map(delivery => delivery.botId)).toEqual([a.id, b.id, b.id, b.id])
    expect(snapshot.deliveries.map(delivery => ({ state: delivery.state, text: delivery.receipt?.text })))
      .toMatchInlineSnapshot(`
        [
          {
            "state": "running",
            "text": undefined,
          },
          {
            "state": "completed",
            "text": "B requested a concrete example.",
          },
          {
            "state": "completed",
            "text": "B approves the revised example.",
          },
          {
            "state": "accepted",
            "text": undefined,
          },
        ]
      `)
    expect(adapter.requests.map(request => request.sessionId)).toEqual([
      chat.executors[0]!.sessionId, chat.executors[1]!.sessionId,
      chat.executors[1]!.sessionId, chat.executors[0]!.sessionId,
      chat.executors[1]!.sessionId, chat.executors[0]!.sessionId,
    ])
    expect(snapshot.deliveries.slice(1).every(delivery => delivery.source.kind === 'tool'
      && delivery.source.parentDeliveryId === snapshot.deliveries[0]!.id)).toBe(true)
    const rootLog = await ctx.sessionController.inspect(chat.rootSessionId)
    const activity = rootLog.events.filter(event => event.type === 'katcats/group-task-lifecycle')
    expect(activity.map(event => ({
      delivery: snapshot.deliveries.findIndex(delivery => delivery.id === event.data.deliveryId),
      actor: event.data.actor.kind === 'member' ? event.data.actor.sender?.name : event.data.actor.kind,
      target: event.data.target.sender?.name, status: event.data.status,
    }))).toEqual([
      { delivery: 0, actor: 'owner', target: 'A', status: 'queued' },
      { delivery: 0, actor: 'owner', target: 'A', status: 'started' },
      { delivery: 1, actor: 'A', target: 'B', status: 'queued' },
      { delivery: 1, actor: 'A', target: 'B', status: 'started' },
      { delivery: 1, actor: 'A', target: 'B', status: 'completed' },
      { delivery: 2, actor: 'A', target: 'B', status: 'queued' },
      { delivery: 2, actor: 'A', target: 'B', status: 'started' },
      { delivery: 2, actor: 'A', target: 'B', status: 'completed' },
      { delivery: 3, actor: 'A', target: 'B', status: 'queued' },
    ])
    expect(rootLog.events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'katcats-group-relay'
      ? [event.data.source.sender.name] : [])).toEqual(['A', 'B', 'A', 'B'])
    expect(new Set(activity.map(event => event.data.eventId)).size).toBe(activity.length)
    expect(activity.every(event => event.data.rootSessionId === chat.rootSessionId && event.surfaceOp === undefined)).toBe(true)
    await ctx.katcatsChats.resume(control(snapshot.chats[0]!))
    await settledGroup(ctx, chat.id)
    const completed = await ctx.katcatsChats.snapshot()
    expect(completed.deliveries.every(delivery => delivery.state === 'completed')).toBe(true)
    expect(completed.deliveries[0]?.receipt?.text).toBe('A delivers the reviewed final article.')
    expect(completed.deliveries.at(-1)?.id).toBe(snapshot.deliveries.at(-1)?.id)
    expect(adapter.requests).toHaveLength(8)
  })

  it('retains approval-policy context through group dispatch and Stop without treating it as pending work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-policy-context-'))
    roots.push(root)
    const { ctx, adapter } = await loadComposition(root, [
      textResponse('Writer is ready.'), textResponse('The policy-aware group task completed.'),
      textResponse('The new task completed after Stop.'),
    ], true)
    await ctx.plugin(ApprovalService)
    const writer = (await ctx.katcatsTeam.createBot({ name: 'Writer' })).bot
    const chat = (await ctx.katcatsChats.createChat({ name: 'Policy context', memberIds: [writer.id] })).chat
    const worker = groupAgent(ctx, chat.executors[0]!.sessionId)
    await sendGroup(ctx, chat, 'Hello.')
    await settledGroup(ctx, chat.id)
    ctx.approval.setPolicy(worker, 'never')
    const firstNotice = worker.inbox.nextStep[0]!
    expect(firstNotice.source.kind).toBe('user-approval')
    expect(worker.status).toBe('idle')
    await sendGroup(ctx, chat, 'Complete the policy-aware task.')
    await settledGroup(ctx, chat.id)
    const first = await ctx.katcatsChats.snapshot()
    expect(first.chats[0]).toMatchObject({ status: 'active', pauseReason: null, error: null, run: null })
    expect(first.deliveries.at(-1)).toMatchObject({ state: 'completed', receipt: { text: 'The policy-aware group task completed.' } })
    expect(adapter.requests[1]!.messages.some(message => message.id === firstNotice.id)).toBe(true)
    ctx.approval.setPolicy(worker, 'ask')
    const retainedNotice = worker.inbox.nextStep[0]!
    await ctx.katcatsChats.stop(control(first.chats[0]!))
    expect(worker.inbox.nextStep.map(message => message.id)).toEqual([retainedNotice.id])
    await sendGroup(ctx, chat, 'Complete a new task after Stop.')
    await settledGroup(ctx, chat.id)
    const final = await ctx.katcatsChats.snapshot()
    expect(final.chats[0]).toMatchObject({ status: 'active', pauseReason: null, error: null, run: null })
    expect(final.deliveries.at(-1)).toMatchObject({ state: 'completed', receipt: { text: 'The new task completed after Stop.' } })
    expect(adapter.requests[2]!.messages.some(message => message.id === retainedNotice.id)).toBe(true)
    const log = await ctx.sessionController.inspect(worker.id)
    const notices = log.events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user-approval'
      ? [event.data.id] : [])
    expect(notices).toEqual([firstNotice.id, retainedNotice.id])
    expect({
      notices: log.events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user-approval'
        ? [{ source: event.data.source.kind, content: event.data.content }] : []),
      group: (await ctx.sessionController.inspect(chat.rootSessionId)).events.flatMap(event => event.type === 'user/message'
        ? [{ speaker: event.data.source.kind === 'katcats-group-relay' ? event.data.source.sender.name : 'owner',
          content: event.data.content }] : []),
    }).toMatchSnapshot()
    expect(worker.inbox.nextStep).toEqual([])
    expect(adapter.requests).toHaveLength(3)
  })

  it('dispatches both members after sequential permission changes and retained notices after Stop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-two-member-policy-context-'))
    roots.push(root)
    const { ctx, adapter } = await loadComposition(root, [
      textResponse('Ready.'), textResponse('Ready.'),
      textResponse('Policy-aware reply.'), textResponse('Policy-aware reply.'),
      textResponse('Reply after Stop.'), textResponse('Reply after Stop.'),
    ], true)
    await ctx.plugin(ApprovalService)
    const a = (await ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const b = (await ctx.katcatsTeam.createBot({ name: 'B' })).bot
    const chat = (await ctx.katcatsChats.createChat({ name: 'Two-member policies', memberIds: [a.id, b.id] })).chat
    const workers = chat.executors.map(executor => groupAgent(ctx, executor.sessionId))
    await sendGroup(ctx, chat, '@A @B Hello, team.')
    await settledGroup(ctx, chat.id)

    for (const worker of workers) ctx.approval.setPolicy(worker, 'never')
    const firstNotices = workers.map(worker => worker.inbox.nextStep[0]!)
    for (const worker of workers) {
      expect(worker.status).toBe('idle')
      expect(worker.inbox.nextStep.map(message => message.source.kind)).toEqual(['user-approval'])
    }
    await sendGroup(ctx, chat, '@A @B Both members complete this task.')
    await settledGroup(ctx, chat.id)
    const first = await ctx.katcatsChats.snapshot()
    expect(first.chats[0]).toMatchObject({ status: 'active', pauseReason: null, error: null, run: null })
    const firstReplies = first.deliveries.slice(-2)
    expect(firstReplies.map(delivery => delivery.botId).sort()).toEqual([a.id, b.id].sort())
    expect(firstReplies.every(delivery => delivery.state === 'completed'
      && delivery.receipt?.text === 'Policy-aware reply.')).toBe(true)
    for (const [index, worker] of workers.entries()) {
      expect(adapter.requests.findLast(request => request.sessionId === worker.id)?.messages
        .some(message => message.id === firstNotices[index]!.id)).toBe(true)
    }

    for (const worker of workers) ctx.approval.setPolicy(worker, 'ask')
    const retainedNotices = workers.map(worker => worker.inbox.nextStep[0]!)
    await ctx.katcatsChats.stop(control(first.chats[0]!))
    for (const [index, worker] of workers.entries()) {
      expect(worker.inbox.nextStep.map(message => message.id)).toEqual([retainedNotices[index]!.id])
    }
    await sendGroup(ctx, chat, '@A @B Both members answer after Stop.')
    await settledGroup(ctx, chat.id)
    const final = await ctx.katcatsChats.snapshot()
    expect(final.chats[0]).toMatchObject({ status: 'active', pauseReason: null, error: null, run: null })
    const finalReplies = final.deliveries.slice(-2)
    expect(finalReplies.map(delivery => delivery.botId).sort()).toEqual([a.id, b.id].sort())
    expect(finalReplies.every(delivery => delivery.state === 'completed'
      && delivery.receipt?.text === 'Reply after Stop.')).toBe(true)
    for (const [index, worker] of workers.entries()) {
      expect(adapter.requests.findLast(request => request.sessionId === worker.id)?.messages
        .some(message => message.id === retainedNotices[index]!.id)).toBe(true)
      const log = await ctx.sessionController.inspect(worker.id)
      expect(log.events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user-approval'
        ? [event.data.id] : [])).toEqual([firstNotices[index]!.id, retainedNotices[index]!.id])
      expect(worker.inbox.nextStep).toEqual([])
    }
    expect(adapter.requests).toHaveLength(6)
  })

  it('continues a stored policy-notice pause once after cold reopen without replacing its accepted task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-cold-policy-context-'))
    roots.push(root)
    const first = await loadComposition(root, [textResponse('Writer is ready.')], true)
    await first.ctx.plugin(ApprovalService)
    const writer = (await first.ctx.katcatsTeam.createBot({ name: 'Writer' })).bot
    const chat = (await first.ctx.katcatsChats.createChat({ name: 'Stored policy pause', memberIds: [writer.id] })).chat
    await sendGroup(first.ctx, chat, 'Hello.')
    await settledGroup(first.ctx, chat.id)
    const worker = groupAgent(first.ctx, chat.executors[0]!.sessionId)
    first.ctx.approval.setPolicy(worker, 'never')
    const notice = worker.inbox.nextStep[0]!
    expect(await first.ctx.sessions.flush(worker.session)).toBe(true)
    const domain = first.ctx.storageDomain.get(chatsDomainSpec.name)!
    const previous = chatsStateSchema.parse(domain.global.get())
    const greeting = previous.deliveries[0]!
    const generation = previous.chats[0]!.generation + 1
    const runId = brandString<ChatRunId>('stored-policy-paused-run')
    const request = { sessionId: chat.rootSessionId, requestId: brandString<SessionRequestId>('stored-policy-paused-request'),
      mode: 'queue' as const, content: [{ type: 'text' as const, text: 'Write the already accepted article.' }] }
    const userMessage = createUserMessage({ content: request.content, source: { kind: 'user', rpcId: request.requestId } })
    await new GroupTranscript(first.ctx).publishUser(chat, userMessage)
    const inbound: ChatInbound = { chatId: chat.id, runId, generation, requestId: request.requestId,
      requestDigest: groupRequestDigest(request), userMessage, recipients: [writer.id], addressing: 'broadcast', state: 'published' }
    const pending: ChatDelivery = { ...greeting, id: brandString<ChatDeliveryId>('stored-policy-paused-delivery'),
      runId, generation, source: { kind: 'owner-message', messageId: userMessage.id }, message: request.content[0]!.text,
      inputMessageId: brandString<MessageId>('stored-policy-paused-worker-input'),
      relayMessageId: brandString<MessageId>('stored-policy-paused-relay'),
      state: 'accepted', receipt: null, pass: null, relayed: false, error: null }
    await domain.global.set(chatsStateSchema.parse({ ...previous,
      chats: previous.chats.map(value => ({ ...value, status: 'paused', pauseReason: 'member-execution-unconfirmed',
        generation, run: { id: runId, generation, relayCount: 0 }, error: null })),
      inbounds: [...previous.inbounds, inbound], deliveries: [...previous.deliveries, pending],
    }))
    // Preserve the flushed crash image before graceful teardown cancels pending input.
    const path = logPath(join(root, 'sessions'), chat.workDir, worker.id, 'none')
    const crashImage = await readFile(path, 'utf8')
    await first.ctx.fiber.dispose()
    contexts.delete(first.ctx)
    await writeFile(path, crashImage)
    const cold = await loadComposition(root, [textResponse('The already accepted article is ready.')], true)
    const restored = await cold.ctx.katcatsChats.snapshot()
    expect(restored.chats[0]).toMatchObject({ status: 'paused', pauseReason: 'member-execution-unconfirmed', error: null,
      generation, run: { id: runId, relayCount: 0 } })
    expect(restored.deliveries).toEqual([greeting, pending])
    expect(cold.adapter.requests).toEqual([])
    await cold.ctx.katcatsChats.resume(control(restored.chats[0]!))
    await settledGroup(cold.ctx, chat.id)
    const completed = await cold.ctx.katcatsChats.snapshot()
    expect(completed.chats[0]).toMatchObject({ status: 'active', pauseReason: null, error: null, generation, run: null })
    expect(completed.deliveries).toHaveLength(2)
    expect(completed.deliveries[0]).toEqual(greeting)
    expect(completed.deliveries[1]).toMatchObject({ id: pending.id, inputMessageId: pending.inputMessageId,
      relayMessageId: pending.relayMessageId, runId, generation, state: 'completed',
      receipt: { text: 'The already accepted article is ready.' } })
    expect(cold.adapter.requests).toHaveLength(1)
    expect(cold.adapter.requests[0]!.messages.some(message => message.id === notice.id)).toBe(true)
    const log = await cold.ctx.sessionController.inspect(worker.id)
    expect(log.events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user-approval'
      ? [event.data.id] : [])).toEqual([notice.id])
    expect(log.events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'katcats-group-task'
      ? [event.data.id] : [])).toEqual([greeting.inputMessageId, pending.inputMessageId])
    expect((await cold.ctx.sessionController.inspect(chat.rootSessionId)).events.flatMap(event => event.type === 'user/message'
      ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])).toEqual([
      'Hello.', 'Writer is ready.', 'Write the already accepted article.', 'The already accepted article is ready.',
    ])
  })

  it('reports an actual queued executor task without dispatching or discarding it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-pending-executor-task-'))
    roots.push(root)
    const { ctx, adapter } = await loadComposition(root, [], true)
    const writer = (await ctx.katcatsTeam.createBot({ name: 'Writer' })).bot
    const chat = (await ctx.katcatsChats.createChat({ name: 'Pending executor task', memberIds: [writer.id] })).chat
    const worker = groupAgent(ctx, chat.executors[0]!.sessionId)
    const pending = createUserMessage({ content: [{ type: 'text', text: 'Retain this earlier task for inspection.' }],
      source: { kind: 'user' } })
    worker.inject(pending)
    await sendGroup(ctx, chat, 'Do not overlap the earlier queued task.')
    await settledGroup(ctx, chat.id)
    const paused = await ctx.katcatsChats.snapshot()
    expect(paused.chats[0]).toMatchObject({ status: 'paused', pauseReason: 'member-failed',
      error: { code: 'KATCATS_CHAT_EXECUTOR_BUSY' } })
    expect(paused.deliveries).toMatchObject([{ state: 'failed', receipt: null, error: { code: 'KATCATS_CHAT_EXECUTOR_BUSY' } }])
    expect(worker.inbox.nextStep.map(message => message.id)).toEqual([pending.id])
    expect(adapter.requests).toEqual([])
    await ctx.katcatsChats.stop(control(paused.chats[0]!))
    expect(worker.inbox.nextStep.map(message => message.id)).toEqual([pending.id])
  })

  it('can dispatch again after Stop cancels approval and a repeat guard queues a final notice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-stop-approval-notice-'))
    roots.push(root)
    const approvalCall = (id: string) => toolCallResponse(id, 'fixture_approval',
      { command: 'synthetic reviewable operation' }, `Writer requests approval ${id}.`)
    const permissionPlan = (id: string) => toolCallResponse(id, 'plan_group_work', {
      own_task: 'Run the synthetic permission check.', assignments: [], review: { reason: 'none' },
    })
    const { ctx, adapter } = await loadComposition(root, [
      textResponse('The image and file were received.'),
      permissionPlan('plan-one'), approvalCall('approve-one'), textResponse('The allowed operation completed.'),
      permissionPlan('plan-two'), approvalCall('approve-two'), textResponse('The denied operation was not performed.'),
      permissionPlan('plan-stop'), approvalCall('approve-stop'), textResponse('The new owner request can run after Stop.'),
    ], true)
    await ctx.plugin(ApprovalService)
    await ctx.plugin(RepeatToolReminder, { include: ['fixture_approval'] })
    const writer = (await ctx.katcatsTeam.createBot({ name: 'Writer' })).bot
    const chat = (await ctx.katcatsChats.createChat({ name: 'Approval reuse', memberIds: [writer.id] })).chat
    const worker = groupAgent(ctx, chat.executors[0]!.sessionId)
    const container = groupAgent(ctx, chat.rootSessionId)
    const staged = await ctx.fileUploads.upload(container, {
      data: Buffer.from('A real staged file remains in group history.').toString('base64'), name: 'group-draft.txt',
    }, new AbortController().signal)
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
    await ctx.katcatsChats.sendMessage({ sessionId: chat.rootSessionId,
      requestId: brandString<SessionRequestId>('approval-history-attachments'), mode: 'queue', content: [
        { type: 'text', text: '@Writer Read the attachments.' }, { type: 'image', mediaType: 'image/png', data: png },
        { type: 'file', receiptId: staged.receiptId },
      ] }, new AbortController().signal)
    await settledGroup(ctx, chat.id)
    const shown = Promise.withResolvers<undefined>()
    let questions = 0
    const removeAnswerer = ctx.on('approval/request', () => {
      questions += 1
      if (questions < 3) return Promise.resolve<ApprovalAnswer>(questions === 1 ? 'allowed-once' : 'rejected')
      shown.resolve(undefined)
      return new Promise<ApprovalAnswer>(() => {})
    })
    const removeTool = ctx.tools.register(defineTool({
      name: 'fixture_approval', description: 'Synthetic reviewable operation.',
      parameters: { command: { type: 'string', required: true } },
      output: { schema: { type: 'object', additionalProperties: false, properties: {
        outcome: { type: 'string', required: true },
      } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (_args, exec) => {
        if (exec.agent === undefined) throw new Error('The approval fixture requires a real Agent turn')
        return { outcome: await ctx.approval.request({
          agent: exec.agent, toolName: 'fixture_approval', callId: exec.callId, signal: exec.signal,
        }) }
      },
    }))
    try {
      await sendGroup(ctx, chat, '@Writer Allow the operation.')
      await settledGroup(ctx, chat.id)
      await sendGroup(ctx, chat, '@Writer Deny the operation.')
      await settledGroup(ctx, chat.id)
      await sendGroup(ctx, chat, '@Writer Wait for approval, then Stop.')
      await shown.promise
      const awaiting = await ctx.katcatsChats.snapshot()
      expect(awaiting.deliveries.at(-1)).toMatchObject({ state: 'running', receipt: null })
      const publicBeforeApproval = (await ctx.sessionController.inspect(chat.rootSessionId)).events
        .filter(event => event.type === 'user/message')
        .filter(event => event.data.source.kind === 'katcats-group-relay' && event.data.id === event.data.source.outputMessageId)
      expect(publicBeforeApproval.map(event => event.data.content)).toEqual([
        [{ type: 'text', text: 'Writer requests approval approve-one.' }],
        [{ type: 'text', text: 'Writer requests approval approve-two.' }],
        [{ type: 'text', text: 'Writer requests approval approve-stop.' }],
      ])
      await ctx.katcatsChats.stop(control((await ctx.katcatsChats.snapshot()).chats[0]!))
      expect(worker.inbox.nextStep).toEqual([])
      expect(worker.inbox.nextTurn).toEqual([])
      const stoppedLog = await ctx.sessionController.inspect(worker.id)
      const reminder = stoppedLog.events.flatMap(event => event.type === 'agent/inbox/spliced'
        ? event.data.inserted.filter(message => message.source.kind === 'repeat-tool-reminder') : [])
      expect(reminder).toHaveLength(1)
      expect(stoppedLog.events.flatMap(event => event.type === 'approval/decided' ? [event.data.outcome] : []))
        .toEqual(['allowed-once', 'rejected', 'cancelled'])
      await sendGroup(ctx, chat, '@Writer Start a new owner request after Stop.')
      await settledGroup(ctx, chat.id)
      const latest = await ctx.katcatsChats.snapshot()
      expect(latest.deliveries.at(-1)).toMatchObject({ state: 'completed',
        receipt: { text: 'The new owner request can run after Stop.' } })
      expect(adapter.requests).toHaveLength(10)
      expect(adapter.requests.at(-1)?.messages.some(message => message.source?.kind === 'repeat-tool-reminder')).toBe(false)
      expect(JSON.stringify(adapter.requests.at(-1)?.messages)).toContain('group-draft.txt')
      expect(adapter.requests.at(-1)?.messages.some(message => message.content.some(block => block.type === 'image'))).toBe(true)
      expect(adapter.requests.some(request => request.sessionId === chat.rootSessionId)).toBe(false)
      expect((await ctx.sessionController.inspect(worker.id)).events.some(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.id === reminder[0]!.id))).toBe(true)
    } finally { removeTool(); removeAnswerer() }
  })

  it('continues a retained budget target and allows Stop during its slow member request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-direct-budget-stop-'))
    roots.push(root)
    const { ctx, adapter } = await loadComposition(root, [textResponse('A completed reply.'), 'hang-slow'], true)
    const a = (await ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const b = (await ctx.katcatsTeam.createBot({ name: 'B' })).bot
    const chat = (await ctx.katcatsChats.createChat({ name: 'Budget stop', memberIds: [a.id, b.id], relayLimit: 1 })).chat
    await sendGroup(ctx, chat, '@A @B Both members should contribute.')
    await settledGroup(ctx, chat.id)
    const held = await ctx.katcatsChats.snapshot()
    expect(held.chats[0]).toMatchObject({ status: 'paused', pauseReason: 'relay-limit' })
    expect(held.deliveries.map(delivery => delivery.state)).toEqual(['completed', 'accepted'])
    const ready = Promise.withResolvers<undefined>()
    const remove = ctx.on('llm/stream', (request, next) => {
      if (request.sessionId === chat.executors[1]!.sessionId) ready.resolve(undefined)
      return next()
    })
    try {
      await ctx.katcatsChats.resume(control(held.chats[0]!))
      await ready.promise
      const live = await ctx.katcatsChats.snapshot()
      expect(live.activities[0]?.pendingControl).toBeNull()
      await ctx.katcatsChats.stop(control(live.chats[0]!))
    } finally { remove() }
    const stopped = await ctx.katcatsChats.snapshot()
    expect(stopped.chats[0]?.status).toBe('stopped')
    expect(stopped.activities[0]?.processing).toBe(false)
    expect(stopped.deliveries.map(delivery => delivery.state)).toEqual(['completed', 'unknown'])
    expect(adapter.requests.map(request => request.sessionId)).toEqual(chat.executors.map(executor => executor.sessionId))
  })

  it('records legacy member silence and rejects direct model entry to the container and its internal executors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-direct-pass-'))
    roots.push(root)
    const { ctx, adapter } = await loadComposition(root, [toolCallResponse('actual-pass', 'pass_group_turn', {}), textResponse('B has the relevant reply.')], true)
    const a = (await ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const b = (await ctx.katcatsTeam.createBot({ name: 'B' })).bot
    const chat = (await ctx.katcatsChats.createChat({ name: 'Optional contribution', memberIds: [a.id, b.id] })).chat
    await resumeLegacyBroadcast(ctx, chat, 'Contribute if your role is relevant.')
    await settledGroup(ctx, chat.id)
    const snapshot = await ctx.katcatsChats.snapshot()
    expect(snapshot.deliveries.map(delivery => delivery.state)).toEqual(['passed', 'completed'])
    expect(snapshot.deliveries[0]?.pass).toMatchObject({ callId: 'actual-pass', turn: 1 })
    const log = await ctx.sessionController.inspect(chat.rootSessionId)
    expect(log.events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'katcats-group-relay'
      ? [event.data.source.sender.botId] : [])).toEqual([b.id])
    const request = { sessionId: chat.rootSessionId, requestId: brandString<SessionRequestId>('wrong-root'),
      mode: 'queue' as const, content: [{ type: 'text' as const, text: 'Do not run a container model.' }] }
    await expect(ctx.sessionController.prompt(request, new AbortController().signal)).rejects.toHaveProperty('details.reason',
      'HarnessError: Send this message through the group conversation. Its transcript does not run a model.')
    await expect(ctx.sessionController.prompt({ ...request, sessionId: chat.executors[0]!.sessionId }, new AbortController().signal))
      .rejects.toHaveProperty('details.reason',
        'HarnessError: Send this message to the group; member execution Sessions accept only group-owned work.')
    expect(ctx.tools.schemas(groupAgent(ctx, chat.rootSessionId)).map(tool => tool.name)).not.toContain('list_group_members')
    const worker = groupAgent(ctx, chat.executors[0]!.sessionId)
    expect((await execute(ctx, worker, 'pass_group_turn', {})).isError).toBe(true)
    const tools = worker.ctx.tools
    const entry = [...ctx.loader.entries()].find(value => value.options.name === 'cordis:katcats-chats')!
    await entry.fiber!.dispose()
    expect(tools.get('pass_group_turn', worker)).toBeUndefined()
    expect(tools.get('request_group_member', worker)).toBeUndefined()
    expect(adapter.requests).toHaveLength(2)
  })

  it('keeps the same Bot private conversation and another group running when one group stops', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-direct-isolation-'))
    roots.push(root)
    const { ctx } = await loadComposition(root, ['hang-slow', 'hang-slow', 'hang-slow'], true)
    const writer = (await ctx.katcatsTeam.createBot({ name: 'Writer' })).bot
    const x = (await ctx.katcatsChats.createChat({ name: 'X', memberIds: [writer.id] })).chat
    const y = (await ctx.katcatsChats.createChat({ name: 'Y', memberIds: [writer.id] })).chat
    const privateReady = Promise.withResolvers<undefined>()
    const xReady = Promise.withResolvers<undefined>()
    const yReady = Promise.withResolvers<undefined>()
    const remove = ctx.on('llm/stream', (request, next) => {
      if (request.sessionId === writer.sessionId) privateReady.resolve(undefined)
      if (request.sessionId === x.executors[0]!.sessionId) xReady.resolve(undefined)
      if (request.sessionId === y.executors[0]!.sessionId) yReady.resolve(undefined)
      return next()
    })
    const privateBot = requireAgent(ctx, writer)
    const privateTurn = send(privateBot, 'Keep working privately.')
    try {
      await privateReady.promise
      await sendGroup(ctx, x, 'Work in X.')
      await xReady.promise
      await sendGroup(ctx, y, 'Work in Y.')
      await yReady.promise
      await ctx.katcatsChats.stop(control((await ctx.katcatsChats.snapshot()).chats.find(chat => chat.id === x.id)!))
      expect(groupAgent(ctx, x.executors[0]!.sessionId).status).toBe('idle')
      expect(groupAgent(ctx, y.executors[0]!.sessionId).status).toBe('running')
      expect(groupAgent(ctx, y.rootSessionId).status).toBe('idle')
      expect(privateBot.status).toBe('running')
      const identities = [writer.sessionId, x.rootSessionId, x.executors[0]!.sessionId, y.rootSessionId, y.executors[0]!.sessionId]
      expect(new Set(identities).size).toBe(5)
      expect(groupAgent(ctx, x.executors[0]!.sessionId).session.header.cwd).toBe(x.workDir)
      expect(groupAgent(ctx, y.executors[0]!.sessionId).session.header.cwd).toBe(y.workDir)
    } finally {
      privateBot.cancel({ kind: 'user' })
      await ctx.katcatsChats.stop(control((await ctx.katcatsChats.snapshot()).chats.find(chat => chat.id === y.id)!))
      await privateTurn
      remove()
    }
  })

  it('recovers a flushed reply after a real receipt write failure without rerunning the member', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-direct-receipt-failure-'))
    roots.push(root)
    const first = await loadComposition(root, [textResponse('A confirmed result that must not run twice.')], true)
    const writer = (await first.ctx.katcatsTeam.createBot({ name: 'Writer' })).bot
    const chat = (await first.ctx.katcatsChats.createChat({ name: 'Receipt recovery', memberIds: [writer.id] })).chat
    const path = join(root, 'storage', 'katcats_chats_v3.json')
    const backup = join(root, 'storage', 'katcats_chats_v3.backup.json')
    let blocked = false
    const remove = first.ctx.on('agent/status', ({ agent, status }) => {
      if (agent.id !== chat.executors[0]!.sessionId || status !== 'idle' || blocked) return
      renameSync(path, backup)
      mkdirSync(path)
      blocked = true
    })
    try {
      await sendGroup(first.ctx, chat, 'Produce one final result.')
      await settledGroup(first.ctx, chat.id)
      expect(blocked).toBe(true)
      expect((await first.ctx.katcatsChats.snapshot()).deliveries[0]?.state).toBe('running')
      expect(first.adapter.requests).toHaveLength(1)
    } finally {
      remove()
      if (blocked) { await rmdir(path); await rename(backup, path) }
    }
    await first.ctx.katcatsTeam.updateBot({ id: writer.id, name: 'Renamed later' })
    await first.ctx.fiber.dispose()
    contexts.delete(first.ctx)
    const second = await loadComposition(root, [], true)
    const restored = await second.ctx.katcatsChats.snapshot()
    expect(restored.deliveries[0]).toMatchObject({ state: 'completed', receipt: {
      text: 'A confirmed result that must not run twice.', sender: { name: 'Writer' },
    } })
    expect(second.adapter.requests).toEqual([])
    await second.ctx.katcatsChats.resume(control(restored.chats[0]!))
    await settledGroup(second.ctx, chat.id)
    expect(second.adapter.requests).toEqual([])
    const workerLog = await second.ctx.sessionController.inspect(chat.executors[0]!.sessionId)
    expect(workerLog.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'katcats-group-task')).toHaveLength(1)
    const groupLog = await second.ctx.sessionController.inspect(chat.rootSessionId)
    expect(groupLog.events.filter(event => event.type === 'user/message' && event.data.id === restored.deliveries[0]!.relayMessageId)).toHaveLength(1)
  })

  it('retains a genuinely completed reply when Stop wins before the final flush and publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-direct-late-result-'))
    roots.push(root)
    const { ctx, adapter } = await loadComposition(root, [textResponse('A real result completed before Stop.')], true)
    const writer = (await ctx.katcatsTeam.createBot({ name: 'Writer' })).bot
    const chat = (await ctx.katcatsChats.createChat({ name: 'Late result', memberIds: [writer.id] })).chat
    const stopped = Promise.withResolvers<undefined>()
    let requested = false
    let observedStopped = false
    const checkpoint = ctx.on('session/flush', async (session) => {
      if (session.id !== chat.executors[0]!.sessionId || !requested || observedStopped) return
      const abort = new AbortController()
      try {
        for await (const frame of ctx.katcatsChats.follow(abort.signal)) {
          if (frame.value.chats[0]?.status !== 'stopped') continue
          observedStopped = true
          break
        }
      } finally { abort.abort() }
    })
    const remove = ctx.on('agent/status', ({ agent, status }) => {
      if (agent.id !== chat.executors[0]!.sessionId || status !== 'idle' || requested) return
      requested = true
      void ctx.katcatsChats.snapshot().then(snapshot => ctx.katcatsChats.stop(control(snapshot.chats[0]!)))
        .then(() => { stopped.resolve(undefined) }, stopped.reject)
    })
    try { await sendGroup(ctx, chat, 'Produce a result.'); await stopped.promise } finally { remove(); checkpoint() }
    expect(observedStopped).toBe(true)
    const snapshot = await ctx.katcatsChats.snapshot()
    expect(snapshot.chats[0]?.status).toBe('stopped')
    expect(snapshot.deliveries[0]).toMatchObject({ state: 'completed', receipt: { text: 'A real result completed before Stop.' } })
    const log = await ctx.sessionController.inspect(chat.rootSessionId)
    expect(log.events.filter(event => event.type === 'user/message' && event.data.id === snapshot.deliveries[0]!.relayMessageId)).toHaveLength(1)
    expect(adapter.requests).toHaveLength(1)
  })

  it('clears owned member queues before cold reuse without repeating their former task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-direct-old-queue-'))
    roots.push(root)
    const first = await loadComposition(root, [textResponse('Old result.')], true)
    const writer = (await first.ctx.katcatsTeam.createBot({ name: 'Writer' })).bot
    const chat = (await first.ctx.katcatsChats.createChat({ name: 'Queue recovery', memberIds: [writer.id] })).chat
    await sendGroup(first.ctx, chat, 'Old task.')
    await settledGroup(first.ctx, chat.id)
    const worker = groupAgent(first.ctx, chat.executors[0]!.sessionId)
    const oldTask = (await first.ctx.sessionController.inspect(worker.id)).events
      .find(event => event.type === 'user/message' && event.data.source.kind === 'katcats-group-task')
    if (oldTask?.type !== 'user/message') throw new Error('The old task has no durable input')
    worker.send(oldTask.data, 'next-turn', false)
    await first.ctx.sessions.flush(worker.session)
    await first.ctx.katcatsChats.stop(control((await first.ctx.katcatsChats.snapshot()).chats[0]!))
    expect(worker.inbox.nextTurn).toEqual([])
    await first.ctx.fiber.dispose()
    contexts.delete(first.ctx)
    const second = await loadComposition(root, [textResponse('New result.')], true)
    expect(second.ctx.agents.get(worker.id)).toBeUndefined()
    await sendGroup(second.ctx, chat, 'New task.')
    await settledGroup(second.ctx, chat.id)
    expect((await second.ctx.katcatsChats.snapshot()).deliveries.map(delivery => delivery.receipt?.text)).toEqual(['Old result.', 'New result.'])
    expect((await second.ctx.sessionController.inspect(worker.id)).events
      .filter(event => event.type === 'user/message' && event.data.id === oldTask.data.id)).toHaveLength(1)
    expect(second.adapter.requests).toHaveLength(1)
  })

  it('publishes paused results immediately and cold continuation starts only the remaining recipient', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-direct-pause-'))
    roots.push(root)
    const first = await loadComposition(root, [textResponse('A saved reply before the pause.')], true)
    const a = (await first.ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const b = (await first.ctx.katcatsTeam.createBot({ name: 'B' })).bot
    const chat = (await first.ctx.katcatsChats.createChat({ name: 'Pause', memberIds: [a.id, b.id] })).chat
    const remove = first.ctx.on('llm/stream', (request, next) => {
      const stream = next()
      if (request.sessionId !== chat.executors[0]!.sessionId) return stream
      return (async function* () {
        await first.ctx.katcatsChats.pause(control((await first.ctx.katcatsChats.snapshot()).chats[0]!))
        yield* stream
      })()
    })
    await sendGroup(first.ctx, chat, '@A @B Both members should contribute.')
    await settledGroup(first.ctx, chat.id)
    remove()
    const paused = await first.ctx.katcatsChats.snapshot()
    expect(paused.chats[0]?.status).toBe('paused')
    expect(paused.deliveries.map(delivery => delivery.state)).toEqual(['completed'])
    expect((await first.ctx.sessionController.inspect(chat.rootSessionId)).events
      .filter(event => event.type === 'user/message' && event.data.id === paused.deliveries[0]!.relayMessageId)).toHaveLength(1)
    await first.ctx.fiber.dispose()
    contexts.delete(first.ctx)
    const second = await loadComposition(root, [textResponse('B supplied its own response.')], true)
    expect(second.adapter.requests).toEqual([])
    await second.ctx.katcatsChats.resume(control((await second.ctx.katcatsChats.snapshot()).chats[0]!))
    await settledGroup(second.ctx, chat.id)
    expect((await second.ctx.katcatsChats.snapshot()).deliveries.map(delivery => delivery.botId)).toEqual([a.id, b.id])
    expect(second.adapter.requests.map(request => request.sessionId)).toEqual([chat.executors[1]!.sessionId])
    expect(JSON.stringify(second.adapter.requests[0]?.messages)).toContain('A saved reply before the pause.')
  })

  it('retains an undispatched budget target across Continue without repeating the first member', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-direct-budget-'))
    roots.push(root)
    const { ctx, adapter } = await loadComposition(root, [textResponse('A reply.'), textResponse('B reply.')], true)
    const a = (await ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const b = (await ctx.katcatsTeam.createBot({ name: 'B' })).bot
    const chat = (await ctx.katcatsChats.createChat({ name: 'Budget', memberIds: [a.id, b.id], relayLimit: 1 })).chat
    await sendGroup(ctx, chat, '@A @B Both members reply.')
    await settledGroup(ctx, chat.id)
    const held = await ctx.katcatsChats.snapshot()
    const pending = held.deliveries[1]!
    expect(pending.state).toBe('accepted')
    await ctx.katcatsChats.resume(control(held.chats[0]!))
    await settledGroup(ctx, chat.id)
    const finished = await ctx.katcatsChats.snapshot()
    expect(finished.deliveries.map(delivery => delivery.state)).toEqual(['completed', 'completed'])
    expect(finished.deliveries[1]).toMatchObject({
      id: pending.id, inputMessageId: pending.inputMessageId, relayMessageId: pending.relayMessageId,
    })
    expect(adapter.requests).toHaveLength(2)
  })

  it('stops the slow second member, retains the first public reply, and never replays an unknown outcome', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-direct-stop-'))
    roots.push(root)
    const { ctx, adapter } = await loadComposition(root, [textResponse('The first reply is complete.'), 'hang-slow'], true)
    const a = (await ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const b = (await ctx.katcatsTeam.createBot({ name: 'B' })).bot
    const chat = (await ctx.katcatsChats.createChat({ name: 'Stop', memberIds: [a.id, b.id] })).chat
    const ready = Promise.withResolvers<undefined>()
    const remove = ctx.on('llm/stream', (request, next) => {
      if (request.sessionId === chat.executors[1]!.sessionId) ready.resolve(undefined)
      return next()
    })
    await sendGroup(ctx, chat, '@A @B Both members contribute.')
    await ready.promise
    await ctx.katcatsChats.stop(control((await ctx.katcatsChats.snapshot()).chats[0]!))
    remove()
    expect((await ctx.katcatsChats.snapshot()).deliveries.map(delivery => delivery.state)).toEqual(['completed', 'unknown'])
    expect((await ctx.sessionController.inspect(chat.rootSessionId)).events
      .filter(event => event.type === 'user/message' && event.data.source.kind === 'katcats-group-relay')).toHaveLength(1)
    expect(groupAgent(ctx, chat.executors[1]!.sessionId).status).toBe('idle')
    expect(adapter.requests).toHaveLength(2)
    await ctx.fiber.dispose()
    contexts.delete(ctx)
    const cold = await loadComposition(root, [], true)
    expect((await cold.ctx.katcatsChats.snapshot()).deliveries[1]?.state).toBe('unknown')
    expect(cold.adapter.requests).toEqual([])
  })

  it('shows actual A and B speakers and shares A public response with B without private conversation history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-direct-speakers-'))
    roots.push(root)
    const { ctx, adapter } = await loadComposition(root, [
      textResponse('This private note must stay private.'),
      textResponse('A headline about reliable teamwork.'),
      (request) => {
        expect(JSON.stringify(request.messages)).toContain('A headline about reliable teamwork.')
        expect(JSON.stringify(request.messages)).not.toContain('This private note must stay private.')
        expect(request.messages.some(message => message.source?.kind === 'katcats-group-task')).toBe(true)
        return textResponse('Add a concrete example to that headline.')
      },
    ], true)
    const writer = (await ctx.katcatsTeam.createBot({ name: 'Writer' })).bot
    const reviewer = (await ctx.katcatsTeam.createBot({ name: 'Reviewer' })).bot
    await send(requireAgent(ctx, writer), 'Remember this private note.')
    const chat = (await ctx.katcatsChats.createChat({ name: 'Editorial', memberIds: [writer.id, reviewer.id] })).chat
    await sendGroup(ctx, chat, '@Writer drafts a headline; @Reviewer comments on it.')
    await settledGroup(ctx, chat.id)
    expect((await ctx.katcatsChats.snapshot()).deliveries.map(delivery => delivery.receipt?.sender.name)).toEqual(['Writer', 'Reviewer'])
    const log = await ctx.sessionController.inspect(chat.rootSessionId)
    expect(log.events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'katcats-group-relay'
      ? [{ sender: event.data.source.sender.name, content: event.data.content }] : [])).toMatchInlineSnapshot(`
        [
          {
            "content": [
              {
                "text": "A headline about reliable teamwork.",
                "type": "text",
              },
            ],
            "sender": "Writer",
          },
          {
            "content": [
              {
                "text": "Add a concrete example to that headline.",
                "type": "text",
              },
            ],
            "sender": "Reviewer",
          },
        ]
      `)
    expect(log.events.some(event => ['assistant/message', 'request/header', 'step/start'].includes(event.type))).toBe(false)
    expect(adapter.requests.some(request => request.sessionId === chat.rootSessionId)).toBe(false)
    expect((await ctx.workspaceRegistry.resolveByPath(chat.workDir))?.sessionIds)
      .toEqual(expect.arrayContaining([chat.rootSessionId, ...chat.executors.map(executor => executor.sessionId)]))
  })

  it('admits a second owner message during a member request without counting the first reply twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'katcats-direct-input-race-'))
    roots.push(root)
    const { ctx, adapter } = await loadComposition(root, [textResponse('First reply.'), textResponse('Second reply.')], true)
    const a = (await ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const chat = (await ctx.katcatsChats.createChat({ name: 'Consecutive input', memberIds: [a.id] })).chat
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let held = false
    const remove = ctx.on('llm/stream', (request, next) => {
      const stream = next()
      if (request.sessionId !== chat.executors[0]!.sessionId || held) return stream
      held = true
      return (async function* () { entered.resolve(undefined); await release.promise; yield* stream })()
    })
    try {
      await sendGroup(ctx, chat, 'First owner message.')
      await entered.promise
      await sendGroup(ctx, chat, 'Second owner message.')
      release.resolve(undefined)
      await settledGroup(ctx, chat.id)
    } finally { release.resolve(undefined); remove() }
    const snapshot = await ctx.katcatsChats.snapshot()
    expect(chatsStateSchema.parse(ctx.storageDomain.get(chatsDomainSpec.name)!.global.get()).inbounds).toHaveLength(2)
    expect(snapshot.deliveries.map(delivery => delivery.receipt?.text)).toEqual(['First reply.', 'Second reply.'])
    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[0]?.messages)).not.toContain('Second owner message.')
    expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('First reply.')
  })
})
