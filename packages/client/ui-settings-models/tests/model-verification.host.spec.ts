/** Candidate tests use the shipped Host plugin, Gateway, AgentLoop, and JSONL persistence. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import LlmRuntime, { LlmAdapter, ToolCallId, type GenerateOptions, type LlmDiscoveredModel, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import SessionStore from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { MemoryCredentials } from '../../../credentials/authorization/tests/memory.ts'
import * as ModelsPlugin from '../src/index.ts'
import type { ModelVerificationResult } from '../src/types.ts'

const factories = vi.hoisted(() => ({ create: vi.fn<(ctx: Context, models: readonly LlmDiscoveredModel[]) => LlmAdapter>() }))
vi.mock('@deepseek-ai/dsh-llm-pi-ai', () => ({ createChatGPTAdapter: factories.create }))

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

class CandidateAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly started = Promise.withResolvers<undefined>()

  constructor(private readonly response: readonly StreamChunk[] | 'hang' | 'probe') { super() }

  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    if (this.response === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'interrupted prefix' }
      this.started.resolve(undefined)
      const aborted = Promise.withResolvers<never>()
      const fail = (): void => { aborted.reject(new Error('fixture cancelled')) }
      request.signal?.addEventListener('abort', fail, { once: true })
      try {
        if (request.signal?.aborted) fail()
        await aborted.promise
      } finally {
        request.signal?.removeEventListener('abort', fail)
      }
      return
    }
    this.started.resolve(undefined)
    if (this.response === 'probe') {
      if (this.requests.length === 1) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('probe'), name: 'model_verification_probe', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield* response('OK')
      }
      return
    }
    yield* this.response
  }
}

function response(text: string, finish: 'stop' | 'max-tokens' = 'stop'): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 7, outputTokens: 1 } },
    { type: 'finish', reason: { kind: finish } },
  ]
}

async function load(adapter: CandidateAdapter): Promise<{
  ctx: Context
  verify: (signal?: AbortSignal) => Promise<ModelVerificationResult>
}> {
  factories.create.mockReturnValue(adapter)
  const root = await mkdtemp(join(tmpdir(), 'dsh-model-verification-'))
  roots.push(root)
  const path = join(root, 'cordis.yml')
  await writeFile(path, JSON.stringify([
    { name: 'cordis:typert' },
    { name: 'cordis:remote-access' },
    { name: 'cordis:gateway' },
    { name: 'cordis:sessions' },
    { name: 'cordis:llm' },
    { name: 'cordis:credentials' },
    { name: 'cordis:persistence', config: { root: join(root, 'sessions'), compression: 'none' } },
    { name: 'cordis:models' },
  ]))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include, typert: TypertRegistry, 'remote-access': RemoteAccess, gateway: Gateway,
    sessions: SessionStore, llm: LlmRuntime, credentials: MemoryCredentials, persistence: JsonlPersistence, models: ModelsPlugin,
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  return {
    ctx,
    verify: async signal => await ctx.typertGateway.invoke({
      peer, namespace: 'modelVerification', method: 'verify',
      args: { request: { provider: 'chatgpt', model: { id: 'candidate', name: 'Candidate' } } },
      ...signal === undefined ? {} : { signal },
    }) as ModelVerificationResult,
  }
}

describe('candidate model verification Host composition', () => {
  it('persists a full successful exchange without publishing a normal Session or changing global routes', async () => {
    const adapter = new CandidateAdapter(response('OK'))
    const { ctx, verify } = await load(adapter)
    const ordinary = vi.fn()
    ctx.on('session/created', ordinary)
    const result = await verify()
    expect(result.status).toBe('passed')
    expect(ordinary).not.toHaveBeenCalled()
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.sessions.get(result.testSessionId)).toBeUndefined()
    const handle = await ctx.sessionPersistence.open(result.testSessionId, 'read')
    try {
      const { events } = await handle.read()
      expect(events.map(event => event.type)).toContain('request/header')
      expect(events.find(event => event.type === 'user/message')?.data).toMatchObject({ content: [{ type: 'text', text: 'Reply with exactly OK.' }] })
      const completed = events.find(event => event.type === 'assistant/message')
      expect(completed?.data).toMatchObject({ message: { content: [{ type: 'text', text: 'OK' }] }, usage: { inputTokens: 7, outputTokens: 1 } })
      const request = adapter.requests[0]!
      expect(request.tools).toEqual([{
        name: 'model_verification_probe',
        description: 'Verify tool schema support. Accepts no arguments and returns OK without reading or changing any state.',
        parameters: { type: 'object', properties: {} },
      }])
      expect(events.find(event => event.type === 'request/header')?.data.header.tools).toEqual(request.tools)
      expect(adapter.requests).toHaveLength(1)
      expect({
        request: {
          provider: request.provider, model: request.model,
          messages: request.messages.map(message => ({ role: message.role, content: message.content })), tools: request.tools,
        },
        events: events.map(event => event.type),
        completion: completed?.type === 'assistant/message' ? { content: completed.data.message.content, usage: completed.data.usage } : undefined,
      }).toMatchSnapshot()
    } finally {
      await handle.close()
    }
  })

  it('executes the local probe with a fixed output and persists its call and result', async () => {
    const adapter = new CandidateAdapter('probe')
    const { ctx, verify } = await load(adapter)
    const result = await verify()
    expect(result.status).toBe('passed')
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]?.messages.find(message => message.role === 'tool')?.content).toEqual([{ type: 'text', text: 'OK' }])
    expect(ctx.llm.listProviders()).toEqual([])
    const handle = await ctx.sessionPersistence.open(result.testSessionId, 'read')
    try {
      const { events } = await handle.read()
      expect(events.find(event => event.type === 'tool/call')?.data).toMatchObject({ name: 'model_verification_probe', arguments: '{}' })
      expect(events.find(event => event.type === 'tool/result')?.data).toMatchObject({ message: { content: [{ type: 'text', text: 'OK' }], isError: false } })
      expect(events.filter(event => event.type === 'step/start')).toHaveLength(2)
    } finally {
      await handle.close()
    }
  })

  it.each([
    ['empty', response('   ')],
    ['truncated', response('OK', 'max-tokens')],
    ['failed', [{ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'fixture refused' } } }]],
  ] as const)('rejects a %s completion as unverified', async (_label, chunks) => {
    const { verify } = await load(new CandidateAdapter(chunks))
    expect((await verify()).status).toBe('failed')
  })

  it('records cancellation and preserves the interrupted prefix without passing it', async () => {
    const adapter = new CandidateAdapter('hang')
    const { ctx, verify } = await load(adapter)
    const controller = new AbortController()
    const running = verify(controller.signal)
    await adapter.started.promise
    controller.abort()
    const result = await running
    expect(result.status).toBe('cancelled')
    const handle = await ctx.sessionPersistence.open(result.testSessionId, 'read')
    try {
      const { events } = await handle.read()
      expect(events.findLast(event => event.type === 'turn/end')?.data).toMatchObject({ reason: { kind: 'aborted' } })
      expect(events.find(event => event.type === 'assistant/message')?.data).toMatchObject({ interrupted: true })
    } finally {
      await handle.close()
    }
  })

  it('does not report a pass when the persistent writer fails', async () => {
    const { ctx, verify } = await load(new CandidateAdapter(response('OK')))
    vi.spyOn(ctx.sessionPersistence, 'create').mockRejectedValueOnce(new Error('fixture persistence unavailable'))
    await expect(verify()).rejects.toMatchObject({ code: 'model-verification/failed' })
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('refuses a pass when the durability checkpoint fails', async () => {
    const { ctx, verify } = await load(new CandidateAdapter(response('OK')))
    const create = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
    vi.spyOn(ctx.sessionPersistence, 'create').mockImplementationOnce(async (...args) => {
      const handle = await create(...args)
      vi.spyOn(handle, 'flush').mockRejectedValueOnce(new Error('fixture flush unavailable'))
      return handle
    })
    await expect(verify()).rejects.toMatchObject({ code: 'model-verification/failed' })
  })

  it('does not adopt a completed response after the caller cancels its pending checkpoint', async () => {
    const { ctx, verify } = await load(new CandidateAdapter(response('OK')))
    const flushing = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const create = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
    vi.spyOn(ctx.sessionPersistence, 'create').mockImplementationOnce(async (...args) => {
      const handle = await create(...args)
      const flush = handle.flush.bind(handle)
      vi.spyOn(handle, 'flush').mockImplementationOnce(async () => {
        flushing.resolve(undefined)
        await release.promise
        await flush()
      })
      return handle
    })
    const controller = new AbortController()
    const running = verify(controller.signal)
    await flushing.promise
    controller.abort()
    release.resolve(undefined)
    expect((await running).status).toBe('cancelled')
  })

  it('drains and reports an untrusted log when Host-wide shutdown closes the shared writer early', async () => {
    const adapter = new CandidateAdapter('hang')
    const { ctx, verify } = await load(adapter)
    const running = verify()
    await adapter.started.promise
    const warning = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const failed = expect(running).rejects.toMatchObject({ code: 'model-verification/failed' })
    await ctx.fiber.dispose()
    await failed
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('audit log'))
  })
})
