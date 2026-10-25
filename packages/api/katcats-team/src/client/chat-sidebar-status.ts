/** Truthful group-list activity derived from the current run and its executor Sessions. */
import type {} from '@deepseek-ai/dsh-client-ui-approval/client'
import type {} from '@deepseek-ai/dsh-client-ui-user-questions/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { TeamChat } from '../chats-types.ts'
import type { ChatView } from './chat-model.ts'

/** Group status shown beside its name; idle never implies a finished task. */
export type ChatSidebarStatus = 'idle' | 'running' | 'approval' | 'confirmation' | 'completed'
  | 'paused' | 'stopped' | 'attention' | 'preparing' | 'syncing' | 'updating'

/**
 * Correlate only this group's current deliveries and exact executor identities.
 * @param chat - Saved group whose row is being rendered.
 * @param view - Current product directory, including live activity.
 * @param sessions - Public execution and human-interaction status.
 * @returns A completion mark only after all current work and public replies are settled.
 */
export function chatSidebarStatus(chat: TeamChat, view: ChatView, sessions: SessionStatusSnapshot): ChatSidebarStatus {
  if (view.phase !== 'ready' || view.snapshot === null) return 'syncing'
  const activity = view.snapshot.activities.find(value => value.chatId === chat.id)
  if (activity?.pendingControl != null) return 'updating'
  const deliveries = view.snapshot.deliveries.filter(value => value.chatId === chat.id && value.generation === chat.generation)
  if (chat.error !== null || deliveries.some(value => value.state === 'unknown' || value.state === 'failed')) return 'attention'
  if (chat.status === 'stopped') return 'stopped'
  const running = deliveries.filter(value => value.state === 'running' && chat.memberIds.includes(value.botId)
    && chat.executors.some(executor => executor.botId === value.botId && executor.sessionId === value.executorSessionId))
  for (const delivery of running) {
    const pending = sessions.get(delivery.executorSessionId)?.pendingInteraction
    if (pending?.sessionId !== delivery.executorSessionId) continue
    if (pending.kind === 'approval' && pending.answerable) return 'approval'
    if (pending.kind === 'question' || pending.kind === 'plan-review') {
      const state = pending.getSnapshot()
      if (pending.review === undefined && state.state === 'open' && state.channel === 'waterfall' && !state.closed) return 'confirmation'
    }
  }
  if (running.some(value => sessions.get(value.executorSessionId)?.running === true)
    || activity?.runningBotIds.some(id => running.some(value => value.botId === id))) return 'running'
  if (chat.status === 'paused') return 'paused'
  if (chat.run !== null || activity?.processing === true || deliveries.some(value => value.state === 'accepted' || value.state === 'running')) return 'preparing'
  if (deliveries.some(value => value.state === 'completed' && !value.relayed)) return 'preparing'
  if (deliveries.some(value => value.state === 'completed' && value.receipt === null || value.state === 'passed' && value.pass === null)) return 'attention'
  if (deliveries.some(value => value.state === 'completed' && value.receipt !== null)
    && deliveries.every(value => value.state === 'completed' ? value.receipt !== null && value.relayed
      : value.state === 'passed' && value.pass !== null)) return 'completed'
  return 'idle'
}
