/** Isolated ChatGPT adapters for logged model connection checks. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from './adapter.ts'
import { authContextFrom, credentialStoreFrom } from './auth.ts'
import { resolveProfiles } from './config.ts'

/**
 * Construct a candidate-only adapter without registering routes or changing settings.
 * @param ctx - Host context supplying the shared ChatGPT credential store.
 * @param models - Candidates advertised by the signed-in account.
 * @returns An adapter for the `chatgpt` route, suitable for an isolated logged Agent runtime.
 */
export function createChatGPTAdapter(ctx: Context, models: readonly LlmDiscoveredModel[]): PiAiAdapter {
  if (models.length === 0) throw new LlmError('Choose at least one ChatGPT model to check.', 'INVALID_CONFIG')
  const profiles = resolveProfiles({ chatgpt: { models: models.map(model => ({
    id: model.id,
    ...model.name === undefined ? {} : { name: model.name },
    ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
    ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
    ...model.inputModalities === undefined ? {} : { input: [...model.inputModalities] },
  })) } })
  return new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: () => Promise.resolve(undefined),
    auth: { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) },
  })
}
