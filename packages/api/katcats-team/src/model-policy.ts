/** Resolve the member's saved policy without reading or changing a Session. */
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { BotModel } from './types.ts'

/**
 * Resolve a fixed route or the current application base at task admission.
 * @param policy - persisted member model policy.
 * @param base - synchronous current-base getter, read only for following members.
 * @returns a detached selection for the Session Controller to validate and log.
 */
export function resolveBotModel(policy: BotModel, base: () => ModelSelection): ModelSelection {
  if (policy.kind === 'follow-global') return { ...base() }
  return {
    provider: policy.provider, model: policy.model,
    ...(policy.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(policy.reasoningEffort) }),
  }
}
