/** Subscription authorization, request serialization and model discovery through the installed pi-ai provider. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import LlmRuntime, { createMessage, createToolResultMessage, createUserMessage, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { recordKeyFor } from '../src/auth.ts'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { chatGPTAccessToken, chatGPTAuthInjection, chatGPTInstallationId, chatGPTPayload } from '../src/chatgpt.ts'
import { discoverModels } from '../src/discovery.ts'
import { memoryAuth } from './auth-double.ts'
import { assemble } from './assemble.ts'

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

/** A real credential store with an isolated temporary file. */
async function stored(path: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { path, watch: false })
  return ctx
}

/** A subscription grant used only by the mocked official origin. */
function subscription(route = 'openai') {
  return memoryAuth({ [route]: {
    type: 'oauth', access: 'subscription-access', refresh: 'subscription-refresh',
    expires: Date.now() + 3_600_000, clientId: 'issued-client', scopes: ['chatgpt.tokens.use.direct'],
  } })
}

/** Encode mock Responses events as SSE accepted by the installed serializer. */
function events(frames: readonly Record<string, unknown>[]): Response {
  return new Response(frames.map(frame => `event: ${String(frame['type'])}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

/** Parse the JSON body supplied by the real Responses serializer. */
function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('Expected a serialized JSON request')
  return JSON.parse(init.body) as Record<string, unknown>
}

/** Reject the missing namespace description reported by the official Responses endpoint. */
function namespaceDescriptionError(request: Record<string, unknown>): Response | undefined {
  if (!Array.isArray(request['tools'])) throw new Error('Expected Responses tools')
  for (const [index, entry] of request['tools'].entries()) {
    const tool = entry as Record<string, unknown>
    if (tool['type'] !== 'namespace') throw new Error('Expected namespaced subscription tools')
    if (typeof tool['description'] === 'string' && tool['description'].trim().length > 0) continue
    const param = `tools[${index}].description`
    return Response.json({ error: {
      message: `Missing required parameter '${param}'.`, type: 'invalid_request_error', param, code: 'missing_required_parameter',
    } }, { status: 400 })
  }
  return undefined
}

describe('ChatGPT installation identity', () => {
  it('persists one identity across independent contexts without exposing it as a provider credential', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-chatgpt-installation-'))
    directories.push(directory)
    const path = join(directory, '.credentials.yaml')
    const first = await stored(path)
    const second = await stored(path)
    const [left, right] = await Promise.all([chatGPTInstallationId(first), chatGPTInstallationId(second)])
    expect(left).toBe(right)
    expect(left).toMatch(/^[0-9a-f-]{36}$/)
    const reopened = await stored(path)
    expect(await chatGPTInstallationId(reopened)).toBe(left)
    expect((await reopened.credentials.listRecords()).map(entry => entry.key)).toEqual(['llm-pi-ai-installation/host'])
  })

  it('refuses an invalid saved identity and a missing credential store', async () => {
    await expect(chatGPTInstallationId(new Context())).rejects.toMatchObject({ code: 'NO_CREDENTIAL_STORE' })
    const directory = await mkdtemp(join(tmpdir(), 'dsh-chatgpt-invalid-'))
    directories.push(directory)
    const ctx = await stored(join(directory, '.credentials.yaml'))
    await ctx.credentials.modifyRecord(credentialKey('llm-pi-ai-installation', 'host'), async () => ({
      kind: 'grant', payload: { version: 1, id: 'changed' },
    }))
    await expect(chatGPTInstallationId(ctx)).rejects.toMatchObject({ code: 'INVALID_INSTALLATION_ID' })
  })
})

describe('ChatGPT subscription transport', () => {
  it('constructs candidate-only adapters without registering or changing the host model routes', async () => {
    const source = new Context()
    await source.plugin(LlmRuntime)
    const isolated = new Context()
    await isolated.plugin(LlmRuntime)
    const adapter = LlmPiAi.createChatGPTAdapter(source, [{ id: 'gpt-5.4', name: 'Selected candidate' }])
    const dispose = isolated.llm.registerAdapter(['chatgpt'], adapter)
    try {
      expect(source.llm.listProviders()).toEqual([])
      expect((await isolated.llm.listModels('chatgpt')).map(model => model.id)).toEqual(['gpt-5.4'])
      expect(() => LlmPiAi.createChatGPTAdapter(source, [])).toThrow(/Choose at least one/)
      expect(() => LlmPiAi.createChatGPTAdapter(source, [{ id: '' }])).toThrow(/empty id/)
    } finally { dispose() }
  })

  it('discovers account models through the dormant plugin before a route is configured', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-chatgpt-discovery-'))
    directories.push(directory)
    const ctx = await stored(join(directory, '.credentials.yaml'))
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi)
    await ctx.credentials.modifyRecord(recordKeyFor('chatgpt'), async () => ({
      kind: 'grant', payload: subscription().stored.get('openai'),
    }))
    const fetch = vi.fn(async () => Response.json({ models: [{ slug: 'account-only', display_name: 'Account only' }] }))
    vi.stubGlobal('fetch', fetch)
    expect(await ctx.llm.discoverModels('llm-pi-ai', { provider: 'chatgpt' })).toEqual([{ id: 'account-only', name: 'Account only' }])
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('discovers the authorized account catalog at the official endpoint with its stored OAuth grant', async () => {
    const auth = subscription()
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ models: [
      { slug: 'gpt-account-model', display_name: 'Account model', context_window: 196608 },
      { slug: 'gpt-other', display_name: 'Other model' },
    ] }))
    vi.stubGlobal('fetch', fetch)
    const models = await discoverModels({ provider: 'openai' }, () => ({
      headers: undefined, resolveApiKey: () => Promise.resolve(undefined),
      resolveChatGPTAccessToken: signal => chatGPTAccessToken(auth, undefined, signal),
    }))
    expect(models).toEqual([
      { id: 'gpt-account-model', name: 'Account model', contextWindow: 196608 },
      { id: 'gpt-other', name: 'Other model' },
    ])
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/models')
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer subscription-access')
  })

  it('never sends a subscription grant to a custom endpoint or the legacy Codex endpoint', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    for (const baseURL of ['https://gateway.example/v1', 'https://chatgpt.com/backend-api']) {
      const profile = resolveProfiles({ openai: { baseURL } }).get('openai')
      await expect(chatGPTAccessToken(subscription(), profile)).rejects.toMatchObject({ code: 'INVALID_CHATGPT_ROUTE' })
    }
    const profile = resolveProfiles({ openai: { api: 'openai-completions' } }).get('openai')
    await expect(chatGPTAccessToken(subscription(), profile)).rejects.toMatchObject({ code: 'INVALID_CHATGPT_ROUTE' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps an explicitly selected API-key route independent of a saved subscription grant', async () => {
    const profile = resolveProfiles({ openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://gateway.example/v1' } }).get('openai')
    await expect(chatGPTAccessToken(subscription(), profile)).resolves.toBeUndefined()
    const resolveGrant = vi.fn()
    await discoverModels({ provider: 'openai', apiKey: 'sk-test' }, () => ({
      headers: undefined, resolveApiKey: () => Promise.resolve(undefined), resolveChatGPTAccessToken: resolveGrant,
    }))
    expect(resolveGrant).not.toHaveBeenCalled()
  })

  it('isolates the subscription credential from the original OpenAI native API-key record', async () => {
    const auth = memoryAuth({ openai: { type: 'api_key', key: 'sk-original-native-key' } })
    const isolated = chatGPTAuthInjection(auth)
    const grant = subscription().stored.get('openai')
    if (grant === undefined) throw new Error('missing test grant')
    await isolated.credentials.modify('openai', async () => grant)
    expect(auth.stored.get('openai')).toEqual({ type: 'api_key', key: 'sk-original-native-key' })
    expect(auth.stored.get('chatgpt')).toEqual(grant)
    await isolated.credentials.delete('openai')
    expect(auth.stored.get('chatgpt')).toBeUndefined()
    expect(auth.stored.get('openai')).toEqual({ type: 'api_key', key: 'sk-original-native-key' })
  })

  it('refuses a disconnected subscription without using another OpenAI record or environment credential', async () => {
    const auth = memoryAuth({ openai: { type: 'api_key', key: 'sk-original' } })
    const ambient = vi.fn(() => Promise.resolve('sk-environment'))
    auth.authContext.env = ambient
    await expect(chatGPTAccessToken(auth, undefined, undefined, true)).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    expect(ambient).not.toHaveBeenCalled()
    await expect(discoverModels({ provider: 'chatgpt' })).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    await expect(discoverModels({ provider: 'chatgpt', apiKey: 'sk-original' })).rejects.toMatchObject({ code: 'INVALID_CHATGPT_ROUTE' })
    for (const options of [{ apiKeyEnv: 'OPENAI_API_KEY' }, { baseURL: 'https://example.com/v1' }, { api: 'openai-completions' }]) {
      expect(() => resolveProfiles({ chatgpt: options })).toThrow(/ChatGPT subscription/)
    }
  })

  it('refreshes an expired issued-client grant and persists its rotated refresh token', async () => {
    const auth = subscription()
    const grant = auth.stored.get('openai')
    if (grant?.type !== 'oauth') throw new Error('missing test grant')
    grant.expires = Date.now() - 1
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      access_token: 'new-subscription-access', refresh_token: 'rotated-refresh', expires_in: 3600,
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    }))
    vi.stubGlobal('fetch', fetch)
    expect(await chatGPTAccessToken(auth, undefined)).toBe('new-subscription-access')
    expect(fetch.mock.calls[0]?.[0]).toBe('https://auth.openai.com/api/accounts/oauth/token')
    const body = fetch.mock.calls[0]?.[1]?.body
    if (!(body instanceof URLSearchParams)) throw new Error('Expected a form-encoded token request')
    expect(body.get('client_id')).toBe('issued-client')
    expect(auth.stored.get('openai')).toMatchObject({ type: 'oauth', access: 'new-subscription-access', refresh: 'rotated-refresh', clientId: 'issued-client' })
  })

  it('preserves the grant when refresh fails, and makes cancellation stop before a request', async () => {
    const auth = subscription()
    const grant = auth.stored.get('openai')
    if (grant?.type !== 'oauth') throw new Error('missing test grant')
    grant.expires = Date.now() - 1
    const fetch = vi.fn(async () => Response.json({ error: 'invalid_grant' }, { status: 401 }))
    vi.stubGlobal('fetch', fetch)
    await expect(chatGPTAccessToken(auth, undefined)).rejects.toThrow(/refresh/)
    expect(auth.stored.get('openai')).toEqual(grant)
    const controller = new AbortController()
    controller.abort(new Error('cancelled by user'))
    await expect(chatGPTAccessToken(auth, undefined, controller.signal)).rejects.toThrow('cancelled by user')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('removes unsupported fields and namespaces tools while leaving the original payload untouched', () => {
    const original = {
      model: 'gpt-account-model', stream: false, store: true, max_output_tokens: 300,
      temperature: 0.4, top_p: 0.8, background: true, conversation: 'old', metadata: { a: 1 },
      previous_response_id: 'previous', input: [{ role: 'system', content: 'Follow the instructions.' }],
      tools: [{ type: 'function', name: 'read', parameters: { type: 'object', properties: {} } }],
    }
    expect(chatGPTPayload(original)).toEqual({
      model: 'gpt-account-model', stream: true, store: false,
      input: [{ role: 'developer', content: 'Follow the instructions.' }],
      tools: [{
        type: 'namespace', name: 'functions', description: 'Tools provided by the agent to complete the user task.', tools: original.tools,
      }],
    })
    expect(original).toMatchObject({ store: true, max_output_tokens: 300, input: [{ role: 'system' }] })
  })

  it.each([undefined, '', ' '])('rejects namespace description %j in the Responses endpoint fixture', async (description) => {
    const rejected = namespaceDescriptionError({ tools: [{ type: 'namespace', name: 'functions', tools: [], description }] })
    expect(rejected?.status).toBe(400)
    expect(await rejected?.json()).toEqual({ error: {
      message: "Missing required parameter 'tools[0].description'.", type: 'invalid_request_error',
      param: 'tools[0].description', code: 'missing_required_parameter',
    } })
  })

  it('reports an HTTP error when a request loses its required namespace description', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = requestBody(init)
      const tools = request['tools'] as Record<string, unknown>[]
      delete tools[0]?.['description']
      const rejected = namespaceDescriptionError(request)
      if (rejected === undefined) throw new Error('Expected the invalid request to be rejected')
      return rejected
    })
    vi.stubGlobal('fetch', fetch)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const dispose = ctx.llm.registerAdapter(['chatgpt'], new PiAiAdapter({
      profiles: () => resolveProfiles({ chatgpt: { models: [{ id: 'gpt-5.4' }] } }),
      resolveApiKey: () => Promise.resolve(undefined), auth: subscription('chatgpt'),
    }))
    try {
      const result = await assemble(ctx, {
        provider: 'chatgpt', model: 'gpt-5.4', messages: [],
        tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } }],
      })
      expect(result.finish).toMatchObject({ kind: 'error' })
      expect(JSON.stringify(result.finish)).toContain('tools[0].description')
      expect(result.message.content).toEqual([])
      expect(fetch).toHaveBeenCalledOnce()
    } finally { dispose() }
  })

  it.each(['openai', 'chatgpt'])('completes a schema-checked function-call roundtrip through %s', async (provider) => {
    const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', namespace: 'functions', arguments: '{"path":"notes.txt"}' }
    const captured: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = requestBody(init)
      captured.push(request)
      const invalid = namespaceDescriptionError(request)
      if (invalid !== undefined) return invalid
      if (captured.length === 2) {
        const content = { type: 'output_text', text: 'File contents received.', annotations: [] }
        const message = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [content] }
        return events([
          { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } },
          { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { ...content, text: '' } },
          { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: content.text },
          { type: 'response.output_item.done', output_index: 0, item: message },
          { type: 'response.completed', response: { status: 'completed', output: [message], usage: { input_tokens: 21, output_tokens: 4, total_tokens: 25 } } },
        ])
      }
      return events([
        { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: call.arguments },
        { type: 'response.output_item.done', output_index: 0, item: call },
        { type: 'response.completed', response: { status: 'completed', output: [call], usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 } } },
      ])
    }))
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ [provider]: { models: [{ id: 'gpt-5.4' }] } }),
      resolveApiKey: () => Promise.resolve(undefined), auth: subscription(provider),
    })
    const dispose = ctx.llm.registerAdapter([provider], adapter)
    try {
      const result = await assemble(ctx, {
        provider, model: 'gpt-5.4', temperature: 0.5, maxTokens: 300,
        messages: [
          createMessage({ role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'Read the file.' }] }),
          createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read notes.txt.' }] }),
        ],
        tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
      })
      expect(captured[0]).toMatchObject({ stream: true, store: false, input: [
        { role: 'developer', content: 'Read the file.' }, { role: 'user' },
      ], tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'read' }] }] })
      expect(captured[0]).not.toHaveProperty('max_output_tokens')
      expect(captured[0]).not.toHaveProperty('temperature')
      expect(captured[0]).toMatchInlineSnapshot(`
        {
          "input": [
            {
              "content": "Read the file.",
              "role": "developer",
            },
            {
              "content": [
                {
                  "text": "Read notes.txt.",
                  "type": "input_text",
                },
              ],
              "role": "user",
            },
          ],
          "model": "gpt-5.4",
          "reasoning": {
            "effort": "none",
          },
          "store": false,
          "stream": true,
          "tools": [
            {
              "description": "Tools provided by the agent to complete the user task.",
              "name": "functions",
              "tools": [
                {
                  "description": "Read a file",
                  "name": "read",
                  "parameters": {
                    "properties": {
                      "path": {
                        "type": "string",
                      },
                    },
                    "type": "object",
                  },
                  "strict": false,
                  "type": "function",
                },
              ],
              "type": "namespace",
            },
          ],
        }
      `)
      expect(result.message.content).toMatchObject([{ type: 'tool-call', name: 'read', arguments: '{"path":"notes.txt"}' }])
      expect(JSON.stringify(result)).toContain('functions')
      expect(result.finish).toMatchObject({ kind: 'tool-calls' })
      expect(result.message.source).toMatchObject({ provider })
      const tool = result.message.content.find(block => block.type === 'tool-call')
      if (tool === undefined) throw new Error('missing function call')
      const completed = await assemble(ctx, {
        provider, model: 'gpt-5.4', messages: [result.message, createToolResultMessage({
          callId: tool.id, content: [{ type: 'text', text: 'File contents' }], isError: false,
        })],
        tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } }],
      })
      const replay = captured[1]?.['input'] as Record<string, unknown>[]
      const replayedCall = replay.find(item => item['type'] === 'function_call')
      const replayedOutput = replay.find(item => item['type'] === 'function_call_output')
      expect(replayedCall).toMatchObject({ name: 'read', namespace: 'functions', arguments: '{"path":"notes.txt"}' })
      expect(replayedOutput?.['call_id']).toBe(replayedCall?.['call_id'])
      expect(completed.message.content).toEqual([{ type: 'text', text: 'File contents received.' }])
      expect(completed.finish).toEqual({ kind: 'stop' })
      expect(captured).toHaveLength(2)
    } finally { dispose() }
  })

  it('retains API-key request options and flat tools when that authentication is explicitly selected', async () => {
    const captured: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.push(requestBody(init))
      return events([{ type: 'response.failed', response: { status: 'failed', error: { code: 'fixture', message: 'fixture failure' } } }])
    }))
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const dispose = ctx.llm.registerAdapter(['openai'], new PiAiAdapter({
      profiles: () => resolveProfiles({ openai: { models: [{ id: 'gpt-5.4' }], apiKeyEnv: 'OPENAI_API_KEY' } }),
      resolveApiKey: () => Promise.resolve('sk-explicit-key'), auth: subscription(),
    }))
    try {
      await assemble(ctx, {
        provider: 'openai', model: 'gpt-5.4', messages: [], temperature: 0.5, maxTokens: 300,
        tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } }],
      })
      expect(captured[0]).toMatchObject({ max_output_tokens: 300, temperature: 0.5, tools: [{ type: 'function', name: 'read' }] })
    } finally { dispose() }
  })

  it('reports a failed Responses stream rather than treating it as completed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => events([
      { type: 'response.failed', response: { status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Check your account' } } },
    ])))
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const dispose = ctx.llm.registerAdapter(['openai'], new PiAiAdapter({
      profiles: () => resolveProfiles({ openai: { models: [{ id: 'gpt-5.4' }] } }),
      resolveApiKey: () => Promise.resolve(undefined), auth: subscription(),
    }))
    try {
      const result = await assemble(ctx, { provider: 'openai', model: 'gpt-5.4', messages: [] })
      expect(result.finish).toMatchObject({ kind: 'error', failure: { code: QUOTA_EXCEEDED_CODE } })
      expect(JSON.stringify(result.finish)).toContain('subscription_sharing_usage_limit_exceeded')
    } finally { dispose() }
  })
})
