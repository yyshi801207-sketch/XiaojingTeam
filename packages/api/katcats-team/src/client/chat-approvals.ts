/** Original executor approval requests grouped only for visible product navigation. */
import type { PendingApproval } from '@deepseek-ai/dsh-client-ui-approval/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatNode, ChatSnapshot, ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { TeamChat } from '../chats-types.ts'
import type { BotId } from '../types.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** Temporary read of the original execution's approval operation. */
    katcatsApproval: unknown
  }
}

/** One unchanged approval object and the group member whose execution owns it. */
export interface ChatApproval {
  readonly botId: BotId
  readonly pending: PendingApproval
}

/**
 * Find answerable requests without moving them into the coordinator's authority.
 * @param chat - Explicit group and its private execution Session identities.
 * @param status - Public Session interaction snapshot.
 * @returns Original requests belonging to this group's executors only.
 */
export function chatApprovals(chat: TeamChat, status: SessionStatusSnapshot): readonly ChatApproval[] {
  const requests: ChatApproval[] = []
  for (const executor of chat.executors) {
    const pending = status.get(executor.sessionId)?.pendingInteraction
    if (pending?.kind === 'approval' && pending.answerable) requests.push({ botId: executor.botId, pending })
  }
  return requests
}

function operationArgs(call: ToolCallBlock, callId: string): string | undefined {
  if (call.callId === callId) return 'kind' in call ? call.call?.argsRaw : call.phase === 'start' ? call.argsRaw : undefined
  for (const child of call.subCalls) {
    const args = operationArgs(child, callId)
    if (args !== undefined) return args
  }
  return undefined
}

/**
 * Read exact recorded arguments for an original root or nested tool call.
 * @param snapshot - Public Chat projection of the execution Session.
 * @param callId - Original approval correlation identity.
 * @returns Raw recorded arguments, or absence outside the loaded call history.
 */
export function approvalOperation(snapshot: ChatSnapshot | undefined, callId: string): string | undefined {
  for (const node of snapshot?.nodes.values() ?? []) {
    if (node.kind !== 'tool-call') continue
    const root = (node as ChatNode<'tool-call'>).data.root
    const args = operationArgs(root, callId)
    if (args !== undefined) return args
  }
  return undefined
}

/**
 * Inspect the approval's original execution without selecting it or changing its authority.
 * @param sessions - Public Controller retaining only this read's lifetime.
 * @param conversation - Public per-Session projection service.
 * @param sessionId - Original execution Session.
 * @param callId - Correlated original tool call.
 * @param signal - Cancellation when the request or visible card changes.
 * @returns Recorded arguments, or absence when the call is outside available history.
 */
export function readApprovalOperation(sessions: Pick<ISessions, 'using'>, conversation: Pick<UiConversation, 'binding'>,
  sessionId: SessionId, callId: string, signal: AbortSignal): Promise<string | undefined> {
  return sessions.using(sessionId, { source: 'katcatsApproval', signal }, async (reference) => {
    const owner = await reference.ready
    const binding = conversation.binding(owner)
    binding.activate('chat')
    return approvalOperation(binding.target('chat').getSnapshot(), callId)
  })
}
