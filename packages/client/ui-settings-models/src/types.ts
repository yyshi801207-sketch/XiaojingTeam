/** Client-safe requests and outcomes for explicit model connection tests. */

import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-llm/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One discovered candidate; testing does not adopt it into the configured catalog. */
export interface ModelVerificationRequest {
  provider: 'chatgpt'
  model: LlmDiscoveredModel
}

/** Result of one fully persisted, isolated verification conversation. */
export interface ModelVerificationResult {
  status: 'passed' | 'failed' | 'cancelled'
  testSessionId: SessionId
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Verification could not establish a trusted, durable outcome. */
    'model-verification/failed': {}
  }
}
