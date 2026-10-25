/** Explicit interruption and system-owned admission feedback beside the original composer. */
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ConnectionGeneration, ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import type { ComposerBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatView } from './chat-model.ts'
import type { TeamView } from './model.ts'
import type { GroupMessageReceipt } from './group-message-feedback.ts'
import css from './group-message-actions.module.css'

/** The original input facade owns submission, attachment checks and failed-draft restoration. */
export interface GroupMessageActionsInjected {
  readonly hooks: {
    readonly chats: ObservableSnapshot<ChatView>
    readonly directory: ObservableSnapshot<TeamView>
    readonly connection: ObservableSnapshot<ConnectionState | undefined>
    readonly connectionGeneration: ObservableSnapshot<ConnectionGeneration | undefined>
    readonly groupMessageReceipt: ObservableSnapshot<GroupMessageReceipt | null>
    readonly composerBlock: ObservableSnapshot<ComposerBlock | undefined>
  }
  readonly interrupt: () => void
}

/** Current group-root editor; private and internal Sessions have no product send action. */
export type GroupMessageActionsProps = PropsRuntime<'conversation.input.right'> & PropsLocale<'katcats.team'>
  & InjectFace<GroupMessageActionsInjected>
/** System receipt beneath the current group-root composer. */
export type GroupMessageFeedbackProps = PropsRuntime<'conversation.composer.dock'> & PropsLocale<'katcats.team'>
  & InjectFace<GroupMessageActionsInjected>

/**
 * Submit this editor's content as an explicitly interrupting instruction.
 * @param props - Live group, editor and original submission callback.
 * @returns A compact action only for saved group roots.
 */
export function GroupMessageActions({ sessionId, useChats, useInput, useSession, useAccess, useConnection,
  useComposerBlock, interrupt, t }: GroupMessageActionsProps) {
  const groups = useChats(value => value)
  const chat = groups.snapshot?.chats.find(item => item.rootSessionId === sessionId)
  const input = useInput(value => value)
  const session = useSession(value => value)
  const connected = useConnection(value => value === 'connected')
  const canPrompt = useAccess('session/prompt')
  const blocked = useComposerBlock(value => value !== undefined)
  if (chat === undefined) return null
  const disabled = groups.phase !== 'ready' || !connected || !canPrompt || blocked
    || session.openState !== 'open' || session.removed || input.phase !== 'plain'
    || input.draft.trimStart().startsWith('/') || input.draft.trim().length === 0 && input.attachmentIds.length === 0
  return <Tooltip label={t('chat.interruptHint')}>
    <Button size="sm" variant="ghost" className={css.interrupt} disabled={disabled}
      onMouseDown={(event) => { event.preventDefault() }} onClick={() => { interrupt() }}>{t('chat.interruptAndAdjust')}</Button>
  </Tooltip>
}

/**
 * Show acknowledged receipt and actual current handlers without inventing a Bot response.
 * @param props - The exact composer receipt and live group/directory snapshots.
 * @returns Localized system feedback; stale generations and unrelated Sessions render nothing.
 */
export function GroupMessageFeedback({ sessionId, useChats, useDirectory, useConnection, useConnectionGeneration,
  useGroupMessageReceipt, t }: GroupMessageFeedbackProps) {
  const groups = useChats(value => value)
  const team = useDirectory(value => value)
  const connection = useConnection(value => value)
  const generation = useConnectionGeneration(value => value?.id)
  const receipt = useGroupMessageReceipt(value => value)
  const chat = groups.snapshot?.chats.find(item => item.rootSessionId === sessionId)
  if (connection !== 'connected' || groups.phase !== 'ready' || chat === undefined
    || receipt === null || receipt.generation !== generation) return null
  const running = groups.snapshot?.activities.find(item => item.chatId === chat.id)?.runningBotIds ?? []
  const names = team.phase === 'ready' ? running.flatMap((id) => {
    const bot = team.snapshot?.bots.find(item => item.id === id && item.kind === 'ordinary')
    return bot !== undefined && chat.memberIds.includes(id) && chat.executors.some(item => item.botId === id) ? [bot.name] : []
  }) : []
  return <div className={css.receipt} data-katcats-message-receipt="">
    <span role="status">{t(receipt.mode === 'steer' ? 'chat.messageAdjusted' : 'chat.messageQueued')}</span>
    {chat.status === 'paused' ? <span>{t(chat.error !== null || chat.pauseReason === 'restart'
      ? 'chat.messagePausedUnconfirmed' : 'chat.messagePaused')}</span>
      : names.length > 0 && <span aria-live="off">{t('chat.messageHandling', { names: names.join('、') })}</span>}
  </div>
}
