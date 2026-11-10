/** Sign in with ChatGPT installation identity and Responses request restrictions. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { PiAiAuthInjection } from './adapter.ts'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { catalogProvider } from './catalog.ts'
import { createModels } from './models.ts'

/** Official origin authorized by Sign in with ChatGPT access grants. */
export const CHATGPT_API_BASE_URL = 'https://api.openai.com/v1'

/**
 * Keep the subscription record separate from OpenAI API-key credentials.
 * @param auth - Host credential injection used by every configured provider.
 * @returns A pi-ai injection mapping its OpenAI provider to the dedicated ChatGPT record.
 */
export function chatGPTAuthInjection(auth: PiAiAuthInjection): PiAiAuthInjection {
  const route = (provider: string): string => provider === 'openai' ? 'chatgpt' : provider
  return {
    authContext: auth.authContext,
    credentials: {
      read: (provider, options) => auth.credentials.read(route(provider), options),
      modify: (provider, mutate, options) => auth.credentials.modify(route(provider), mutate, options),
      delete: (provider, options) => auth.credentials.delete(route(provider), options),
      list: async () => (await auth.credentials.list()).flatMap(entry =>
        entry.providerId === 'openai' ? [] : [{ ...entry, providerId: entry.providerId === 'chatgpt' ? 'openai' : entry.providerId }]),
    },
  }
}

/**
 * Resolve a subscription grant only for its authorized origin and Responses protocol.
 * @param auth - Durable provider credentials and ambient lookup implementation.
 * @param profile - Current OpenAI route, absent before the route is configured.
 * @param signal - Cancels waiting for authorization or token refresh.
 * @param subscriptionOnly - Refuse a missing grant instead of allowing native API-key authentication.
 * @returns The access token, or undefined when this route uses API-key authentication.
 */
export async function chatGPTAccessToken(
  auth: PiAiAuthInjection,
  profile: ResolvedPiAiProviderProfile | undefined,
  signal?: AbortSignal,
  subscriptionOnly = false,
): Promise<string | undefined> {
  if (profile?.apiKeyEnv !== undefined) return undefined
  const source = subscriptionOnly ? chatGPTAuthInjection(auth) : auth
  if ((await source.credentials.read('openai'))?.type !== 'oauth') {
    if (subscriptionOnly) throw new LlmError('Connect your ChatGPT subscription in model settings before using this model.', 'MISSING_CREDENTIAL')
    return undefined
  }
  if ((profile?.baseURL !== undefined && profile.baseURL.replace(/\/+$/, '') !== CHATGPT_API_BASE_URL)
    || (profile?.api !== undefined && profile.api !== 'openai-responses')) {
    throw new LlmError('ChatGPT sign-in can only use https://api.openai.com/v1 with the Responses protocol.', 'INVALID_CHATGPT_ROUTE')
  }
  const provider = catalogProvider('openai')
  if (provider === undefined) throw new LlmError('The OpenAI subscription provider is unavailable.', 'NO_ADAPTER')
  const models = createModels(source)
  models.setProvider(provider)
  const resolved = await models.getAuth('openai', { ...signal === undefined ? {} : { signal } })
  return resolved?.source === 'OAuth' ? resolved.auth.apiKey : undefined
}

const INSTALLATION_KEY = credentialKey('llm-pi-ai-installation', 'host')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Read a persisted installation identity without accepting another record format. */
function installationId(record: CredentialRecord | undefined): string | undefined {
  if (record === undefined) return undefined
  if (record.kind === 'grant' && typeof record.payload === 'object' && record.payload !== null) {
    const payload = record.payload as { version?: unknown; id?: unknown }
    if (payload.version === 1 && typeof payload.id === 'string' && UUID.test(payload.id)) return payload.id
  }
  throw new LlmError('The ChatGPT installation identity is invalid; restore its saved credential record.', 'INVALID_INSTALLATION_ID')
}

/**
 * Obtain the home-scoped UUID registered with ChatGPT, persisting before login starts.
 * @param ctx - Host context owning the credential store.
 * @returns The stable installation UUID, shared across processes using this store.
 */
export async function chatGPTInstallationId(ctx: Context): Promise<string> {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) throw new LlmError('ChatGPT sign-in requires a credential store.', 'NO_CREDENTIAL_STORE')
  const existing = installationId(await credentials.readRecord(INSTALLATION_KEY))
  if (existing !== undefined) return existing
  const stored = await credentials.modifyRecord(INSTALLATION_KEY, (current) => {
    const next: CredentialRecord | undefined = installationId(current) === undefined
      ? { kind: 'grant', payload: { version: 1, id: randomUUID() } } : undefined
    return Promise.resolve(next)
  })
  const id = installationId(stored)
  if (id === undefined) throw new LlmError('ChatGPT installation identity was not saved.', 'INSTALLATION_ID_NOT_SAVED')
  return id
}

/** One protocol object received from pi-ai's payload callback. */
function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/**
 * Apply the subscription endpoint's requirements after pi-ai serializes the request.
 * @param payload - Responses request assembled by pi-ai.
 * @returns A request with developer instructions, namespaced tools and supported fields.
 */
export function chatGPTPayload(payload: unknown): unknown {
  const request = object(payload)
  if (request === undefined) throw new LlmError('ChatGPT Responses payload must be an object.', 'INVALID_REQUEST')
  const unsupported = new Set([
    'background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent',
    'prompt', 'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation',
    'user', 'previous_response_id',
  ])
  const result: Record<string, unknown> = {
    ...Object.fromEntries(Object.entries(request).filter(([field]) => !unsupported.has(field))),
    store: false, stream: true,
  }
  if (Array.isArray(request['input'])) {
    result['input'] = request['input'].map((entry: unknown) => {
      const item = object(entry)
      if (item?.['role'] === 'system') return { ...item, role: 'developer' }
      if ((item?.['type'] === 'function_call' || item?.['type'] === 'custom_tool_call') && item['namespace'] === undefined) {
        return { ...item, namespace: 'functions' }
      }
      return entry
    })
  }
  if (Array.isArray(request['tools'])) {
    const tools: unknown[] = []
    const functions: unknown[] = []
    for (const entry of request['tools']) {
      const tool = object(entry)
      if (tool?.['type'] === 'function' || tool?.['type'] === 'custom') functions.push(entry)
      else tools.push(entry)
    }
    if (functions.length > 0) tools.push({
      type: 'namespace', name: 'functions', description: 'Tools provided by the agent to complete the user task.', tools: functions,
    })
    result['tools'] = tools
  }
  return result
}
