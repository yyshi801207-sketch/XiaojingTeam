/** Synthetic current-group directory for message badges; no Session or user data is opened. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatId, TeamChat } from '../src/chats-types.ts'
import type { BotId, GroupId } from '../src/types.ts'
import type { ChatView } from '../src/client/chat-model.ts'

/**
 * Create an isolated directory with stable group and member identities for presentation tests.
 * @param patch - Explicit current group fields for the scenario.
 * @returns A real observable snapshot and the selector hook used by the message Slot.
 */
export function presentationDirectory(patch: Partial<TeamChat> = {}) {
  const chat: TeamChat = { id: 'editorial' as ChatId, name: 'Editorial', groupId: 'chats' as GroupId,
    rootSessionId: 'editorial-root' as SessionId, workDir: '/synthetic/editorial', managerId: null, memberRoles: [],
    memberIds: ['writer' as BotId, 'reviewer' as BotId], executors: [], status: 'active', pauseReason: null,
    run: null, generation: 0, relayLimit: 8, error: null, ...patch }
  const source = createSnapshotStore<ChatView>({ phase: 'ready', snapshot: {
    revision: 1, chats: [chat], deliveries: [], relayLimit: 8, activities: [],
  } })
  return { source, useGroupDirectory: bindSnapshotSelector(source), chat }
}
