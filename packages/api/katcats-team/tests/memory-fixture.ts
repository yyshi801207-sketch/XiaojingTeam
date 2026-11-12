/** Real Loader composition for keyless scoped-memory tests; only the external model is scripted. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Agents, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import Llm, { createUserMessage, type LlmModelInfo } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Sessions, { Session } from '@deepseek-ai/dsh-session'
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
import { Peer } from '@deepseek-ai/dsh-client-connection'
import Commands from '@deepseek-ai/dsh-commands'
import Uploads from '@deepseek-ai/dsh-client-file-upload'
import Typert from '@deepseek-ai/dsh-typert-registry'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import KatcatsTeam from '../src/index.ts'
import KatcatsChats from '../src/chats.ts'
import KatcatsMemory, { type MemoryConfig } from '../src/memory.ts'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'

const contexts = new Set<Context>()
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

class FixtureModels extends MockAdapter {
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: 'fixture-model', name: 'Fixture' }])
  }
}

/**
 * Load an independent test-only cordis.yml with filesystem persistence and no real credentials.
 * @param script - deterministic external model responses.
 * @param existingRoot - optional previously closed synthetic state to reopen.
 * @param config - explicit memory capacity overrides for parser and admission tests.
 * @param teamConfig - optional product capabilities to load with the team.
 * @returns real product services, the scripted external adapter, and exact owned teardown.
 */
export async function memoryFixture(
  script: ConstructorParameters<typeof MockAdapter>[0] = [], existingRoot?: string, config: Partial<MemoryConfig> = {},
  teamConfig: { financeConnectors?: boolean } = {},
) {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), 'katcats-memory-'))
  if (existingRoot === undefined) roots.push(root)
  const configPath = join(root, 'cordis.yml')
  const rows: [string, object?][] = [
    ['typert'], ['remote-access'], ['gateway'], ['sessions'], ['projections'],
    ['session-title', { fallbackMaxWords: 8, fallbackMaxBytes: 128, maxTitleBytes: 512 }],
    ['persistence', { root: join(root, 'sessions'), compression: 'none' }],
    ['session-query', { path: ':memory:', openAt: 'never' }], ['storage'],
    ['storage-json', { root: join(root, 'storage') }], ['storage-domain', { backend: 'json' }],
    ['workspaces'], ['llm'], ['fixture-model'], ['system-prompt', { includeRuntimeContext: false }], ['tools'],
    ['agents'], ['loop'], ['default-model', { provider: 'fixture', model: 'fixture-model' }], ['fs', { cwd: root }],
    ['attachments', { dshHome: join(root, 'home') }], ['credentials', { path: join(root, 'credentials.yml'), watch: false }],
    ['connection'], ['commands'], ['uploads'], ['session-controller', { nativeOpen: false }],
    ['team', { workspaceRoot: join(root, 'workspaces'), ...teamConfig }], ['chats', { workspaceRoot: join(root, 'workspaces'), relayLimit: 8 }],
    ['memory', config],
  ]
  await writeFile(configPath, JSON.stringify(rows.map(([name, config]) => ({ name: `cordis:${name}`, ...(config === undefined ? {} : { config }) }))))
  const ctx = new Context()
  contexts.add(ctx)
  const adapter = new FixtureModels(script)
  adapter.systemPromptUpdate = 'in-history'
  ctx.baseUrl = pathToFileURL(root).href + '/'
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([]))
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include, typert: Typert, 'remote-access': RemoteAccess, gateway: Gateway,
    sessions: Sessions, projections: Projections, 'session-title': SessionTitle, persistence: Persistence,
    'session-query': SessionQuery, storage: Storage, 'storage-json': JsonStorage, 'storage-domain': StorageDomain,
    workspaces: Workspaces, llm: Llm, 'system-prompt': SystemPrompt, tools: Tools, agents: Agents, loop: AgentLoop,
    'default-model': AgentDefaultModel, fs: Fs, attachments: Attachments, credentials: Credentials,
    connection: Connection, commands: Commands, uploads: Uploads, 'session-controller': SessionController,
    team: KatcatsTeam, chats: KatcatsChats, memory: KatcatsMemory,
    'fixture-model': { name: 'memory-fixture-model', inject: ['llm', 'agents'], apply(modelCtx: Context) {
      modelCtx.effect(() => modelCtx.llm.registerAdapter(['fixture'], adapter))
      modelCtx.on('llm/stream', (request, next) => {
        const agent = request.sessionId === undefined ? undefined : modelCtx.agents.get(request.sessionId)
        if (agent === undefined) throw new Error('Memory request has no live Agent')
        expect(request.messages).toEqual(Session.create(agent.id, agent.session.snapshotEvents()).deriveMessages())
        return next()
      })
    } },
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  await ctx.katcatsMemory.list({ scope: { kind: 'team' } })
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  return { ctx, root, adapter, peer, close: async () => { await ctx.fiber.dispose(); contexts.delete(ctx) } }
}

/**
 * Run a normal user turn and preserve actual Agent failures for the fixture assertion.
 * @param agent - real private member.
 * @param text - synthetic user request.
 * @returns completion after the real loop becomes idle.
 */
export async function memorySend(agent: Agent, text: string): Promise<void> {
  const failures: unknown[] = []
  const stop = agent.ctx.on('agent/error', ({ error }) => { failures.push(error) })
  try {
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await agent.whenIdle()
    if (failures.length) throw new AggregateError(failures, 'The memory fixture turn failed')
  } finally { stop() }
}
