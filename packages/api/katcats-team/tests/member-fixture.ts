import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, vi, type Mock } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ReasoningEffortId, createUserMessage, type GenerateOptions, type LlmModelInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionTitle from '@deepseek-ai/dsh-session-title'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { SessionCreateRequest, SessionRenameValue, SessionSelectModelRequest, SessionSelectModelValue } from '@deepseek-ai/dsh-api-session-controller'
import { ApiSessionAgentController } from '@deepseek-ai/dsh-api-session-controller/src/agent.ts'
import { SessionCommandController } from '@deepseek-ai/dsh-api-session-controller/src/commands.ts'
import { installModelSelectionProjection } from '@deepseek-ai/dsh-api-session-controller/src/model-selection-projection.ts'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import KatcatsTeam from '../src/index.ts'

class FixtureAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(['fixture-model', 'specialist-model'].map(id => ({ id, name: id, provider: 'fixture' })))
  }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, systemPromptUpdate: 'in-history',
      ...(model !== 'specialist-model' ? {} : { reasoning: {
        efforts: [{ id: ReasoningEffortId('high'), name: 'High' }], defaultEffort: ReasoningEffortId('high'),
      } }),
    })
  }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Fixture response' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Fixture response' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const cleanups: (() => Promise<void>)[] = []
const roots: string[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

export async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'katcats-member-test-'))
  roots.push(root)
  return root
}

interface MemberFixture {
  root: string
  ctx: Context
  team: KatcatsTeam
  create: Mock<(request: SessionCreateRequest) => Promise<{ sessionId: SessionId }>>
  rename: Mock<(request: { sessionId: SessionId; title: string }) => Promise<SessionRenameValue>>
  adapter: FixtureAdapter
  resolveAgent(sessionId: SessionId): Promise<{ agent: Agent } | { error: RemoteError }>
  selectModel: Mock<(request: SessionSelectModelRequest) => Promise<SessionSelectModelValue>>
  saveDefault: Mock<() => void>
  close(): Promise<void>
  teamFiber: { dispose(): Promise<void> }
}

export async function harness(providedRoot?: string): Promise<MemberFixture> {
  const root = providedRoot ?? await freshRoot()
  const ctx = new Context()
  const handles: AgentHandle[] = []
  const backend = new JsonStorageBackend(join(root, 'storage'))
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    for (const handle of handles.reverse()) await handle.dispose()
    await ctx.fiber.dispose()
    await backend.close()
  }
  cleanups.push(close)
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'You are Katcat.AI, the personal assistant.', personaSuffix: '' } })
  await ctx.plugin(TypertRegistry)
  installModelSelectionProjection(ctx)
  await ctx.plugin(SessionTitle, { fallbackMaxWords: 8, fallbackMaxBytes: 128, maxTitleBytes: 512 })
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await mountAgentLoopTestHarness(ctx)
  const adapter = new FixtureAdapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  ctx.on('llm/stream', (request, next) => {
    const subject = hSubject(request.sessionId)
    // Compare at request entry, before the new assistant response is appended.
    const replay = Session.create(subject.id, subject.session.snapshotEvents())
    expect(request.messages).toEqual(replay.deriveMessages())
    return next()
  })
  function hSubject(sessionId: SessionId | undefined): Agent {
    const subject = sessionId === undefined ? undefined : ctx.agents.get(sessionId)
    if (subject === undefined) throw new Error('Fixture request has no live Agent')
    return subject
  }
  await ctx.plugin(Storage)
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  ctx.provide('storageDomain', facility)
  await ctx.plugin(WorkspaceRegistry)
  const options = { provider: 'fixture', model: 'fixture-model' }
  const saveDefault = vi.fn<() => void>()
  ctx.provide('agentDefaultModel', { currentSelection: () => options, saveSelection: async () => { saveDefault() } } as never)
  const models = new ApiSessionAgentController(ctx)
  const commands = new SessionCommandController(ctx, models, root)
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'request/header') return
    const agent = ctx.agents.get(session.id)
    if (agent === undefined) return
    const config = event.data.header.config
    models.consumeSelection(agent, config.provider, config.model, config.reasoningEffort)
  })
  const create = vi.fn(async (request: SessionCreateRequest) => {
    const workspace = request.workspaceId === undefined ? undefined : ctx.workspaceRegistry.get(request.workspaceId)
    const cwd = workspace?.path ?? request.cwd
    if (request.sessionId === undefined || cwd === undefined) throw new Error('Expected an explicit private Session and directory')
    await mkdir(cwd, { recursive: true })
    const handle = await ctx.agents.create({ sessionId: request.sessionId, meta: { cwd }, agentOptions: options })
    handles.push(handle)
    models.selectionFor(handle.agent)
    await workspace?.attachSession(handle.agent.id)
    return { sessionId: handle.agent.id }
  })
  const resolveAgent = async (sessionId: SessionId) => {
    const live = ctx.agents.get(sessionId)
    if (live !== undefined) return { agent: live }
    const stored = await ctx.sessionPersistence.stat(sessionId)
    if (stored === undefined) return { error: new RemoteError('session/not-found', 'Fixture Session is absent', { sessionId }) }
    const handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: options })
    handles.push(handle)
    models.selectionFor(handle.agent)
    return { agent: handle.agent }
  }
  const rename = vi.fn(async (request: { sessionId: SessionId; title: string }) => {
    const resolved = await resolveAgent(request.sessionId)
    if ('error' in resolved) throw resolved.error
    const accepted = ctx.sessionTitle.rename(resolved.agent.session, request.title)
    return { title: accepted.title, seq: accepted.eventSeq }
  })
  const selectModel = vi.fn((request: SessionSelectModelRequest) => commands.selectModel(request))
  const inspect = async (sessionId: SessionId) => {
    const resolved = await resolveAgent(sessionId)
    if ('error' in resolved) throw resolved.error
    return { events: [...resolved.agent.session.snapshotEvents()] }
  }
  // Creation/title orchestration is replaced; model commands, Agents, events, and persistence are real.
  ctx.provide('sessionController', {
    create, resolveAgent, rename, selectModel, inspect,
  } as never)
  const teamFiber = ctx.plugin(KatcatsTeam, {
    workspaceRoot: join(root, 'workspaces'), mainRole: '团队主管',
    ordinaryGroupName: '普通 Bot', chatGroupName: '群聊',
  })
  await teamFiber
  const team = ctx.katcatsTeam
  await team.snapshot()
  return { root, ctx, team, create, rename, adapter, resolveAgent, selectModel, saveDefault, close, teamFiber }
}

export async function send(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

export function systemText(request: GenerateOptions): string[] {
  return request.messages.filter(message => message.role === 'system')
    .flatMap(message => message.content.filter(part => part.type === 'text').map(part => part.text))
}
