/** Current group identity reaches historical message renderers through the existing directory injection. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatId } from '../chats-types.ts'
import type { BotId } from '../types.ts'
import type { ChatView } from './chat-model.ts'

/** Only the current product group directory is observed; no private Session is inspected. */
export interface GroupIdentityInjected {
  readonly hooks: { readonly groupDirectory: ObservableSnapshot<ChatView> }
}

/**
 * Resolve a current manager only in the matching, ready group transcript.
 * @param view - Current connection's group directory phase and retained snapshot.
 * @param chatId - Original message's group identity.
 * @param sessionId - Session actually rendering the message.
 * @returns The current manager, or null outside the exact ready group.
 */
export function groupManager(view: ChatView, chatId: ChatId, sessionId: SessionId | undefined): BotId | null {
  if (view.phase !== 'ready') return null
  const chat = view.snapshot?.chats.find(value => value.id === chatId && value.rootSessionId === sessionId)
  return chat !== undefined && chat.managerId !== null && chat.memberIds.includes(chat.managerId) ? chat.managerId : null
}

/**
 * Read the transcript preference only from its exact group's current or retained directory row.
 * @param view - Group directory, including the last readable snapshot while reconnecting.
 * @param chatId - Original task's group identity.
 * @param sessionId - Session actually rendering the task.
 * @returns Whether task handoff records are visible; absent preferences preserve the enabled default.
 */
export function groupHandoffRecordsVisible(view: ChatView, chatId: ChatId, sessionId: SessionId | undefined): boolean {
  const chat = view.snapshot?.chats.find(value => value.id === chatId && value.rootSessionId === sessionId)
  return chat?.showHandoffRecords !== false
}
