/** Run-aware group controls whose visible state follows Host acknowledgements. */
import { useMemo, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatControlRequest } from '../chats-types.ts'
import type { ChatView } from './chat-model.ts'
import type { TeamView } from './model.ts'
import type { TeamKey } from './locales.ts'
import { GroupWorkerStatus, type GroupWorkerStatusItem } from './GroupWorkerStatus.tsx'
import css from './team.module.css'

/** Commands bind to the group and run captured by the clicked control. */
export interface ChatControlsInjected {
  readonly hooks: { readonly chats: ObservableSnapshot<ChatView>; readonly directory: ObservableSnapshot<TeamView> }
  readonly control: (action: 'pause' | 'resume' | 'stop', request: ChatControlRequest) => Promise<void>
}

/** Public per-Session composer dock scope. */
export type ChatControlsProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'katcats.team'> & InjectFace<ChatControlsInjected>

const memberFailureKeys: ReadonlyMap<string, TeamKey> = new Map([
  ['KATCATS_CHAT_MEMBER_ERROR', 'chat.errorMemberError'],
  ['KATCATS_CHAT_MEMBER_MALFORMED_RESPONSE', 'chat.errorMemberMalformedResponse'],
  ['KATCATS_CHAT_MEMBER_MAX_TOKENS', 'chat.errorMemberMaxTokens'],
  ['KATCATS_CHAT_MEMBER_ABORTED', 'chat.errorMemberAborted'],
  ['KATCATS_CHAT_MEMBER_BLOCKED', 'chat.errorMemberBlocked'],
])

function failureKey(code: string): TeamKey {
  const memberKey = memberFailureKeys.get(code)
  if (memberKey !== undefined) return memberKey
  switch (code) {
    case 'interrupted': return 'chat.pauseRestart'
    case 'KATCATS_CHAT_OUTCOME_UNKNOWN': return 'chat.pauseUnknown'
    case 'KATCATS_CHAT_NO_REPLY': return 'chat.errorNoReply'
    case 'KATCATS_CHAT_DURABILITY_UNCONFIRMED': return 'chat.errorDurability'
    case 'member-removed': return 'chat.errorRemoved'
    case 'stopped': return 'chat.errorStopped'
    default: return 'chat.errorGeneric'
  }
}

function pauseKey(reason: string | null, errorCode: string | undefined): TeamKey {
  switch (reason) {
    case 'owner': return 'chat.pauseHint'
    case 'restart': return 'chat.pauseRestart'
    case 'relay-limit': return 'chat.pauseLimit'
    case 'unknown-result':
    case 'member-execution-unconfirmed':
    case 'member-dependency-unconfirmed':
    case 'interruption-unconfirmed': return 'chat.pauseUnknown'
    case 'member-failed': return 'chat.pauseMemberFailed'
    case 'continuation-failed':
    case 'dispatch-failed':
    case 'legacy-queue': return errorCode === undefined ? 'chat.pauseExecution' : failureKey(errorCode)
    default: return errorCode === undefined ? 'chat.pauseOther' : failureKey(errorCode)
  }
}

/**
 * Pause after the current member, continue, or stop this group's current run.
 * @param props - Scoped root Session, live group state and narrow commands.
 * @returns Group-root controls with each explanation once and original diagnostics; nothing for private conversations.
 */
export function ChatControls({ sessionId, useChats, useDirectory, useSessionStatus, control, t }: ChatControlsProps) {
  const view = useChats(value => value)
  const chat = view.snapshot?.chats.find(item => item.rootSessionId === sessionId)
  const bots = useDirectory(value => value.phase === 'ready' ? value.snapshot?.bots : undefined)
  const statuses = useSessionStatus(value => value)
  const [pending, setPending] = useState<{
    readonly action: 'pause' | 'resume' | 'stop'
    readonly sequence: number
    readonly target: ChatControlRequest
  } | null>(null)
  const sequence = useRef(0)
  const activity = view.snapshot?.activities.find(item => item.chatId === chat?.id)
  const working = useMemo<readonly GroupWorkerStatusItem[]>(() => {
    if (view.phase !== 'ready' || chat === undefined || bots === undefined) return []
    return (activity?.runningBotIds ?? []).flatMap((id) => {
      const bot = bots.find(member => member.id === id && member.kind === 'ordinary' && chat.memberIds.includes(id))
      const executor = chat.executors.find(member => member.botId === id)
      if (bot === undefined || executor === undefined) return []
      const pending = statuses.get(executor.sessionId)?.pendingInteraction
      const phase: GroupWorkerStatusItem['phase'] = pending?.kind === 'approval' && pending.answerable ? 'approval' : 'working'
      return [{ bot, phase }]
    })
  }, [view.phase, chat, bots, activity?.runningBotIds, statuses])
  if (chat === undefined) return null
  const pauseMessageKey = pauseKey(chat.pauseReason, chat.error?.code)
  const specificUnknown = pauseMessageKey === 'chat.pauseUnknown'
    && chat.error !== null && memberFailureKeys.has(chat.error.code)
  const currentPending = pending?.target.id === chat.id && pending.target.expectedGeneration === chat.generation
    && pending.target.expectedRunId === (chat.run?.id ?? null) ? pending : null
  const activeControl = currentPending?.action ?? activity?.pendingControl ?? null
  const disabled = activeControl !== null || view.phase !== 'ready'
  const stopDisabled = currentPending?.action === 'stop' || activity?.pendingControl === 'stop' || chat.status === 'stopped'
    || view.phase !== 'ready' || (activeControl !== null && chat.run === null)
  const invoke = (action: 'pause' | 'resume' | 'stop') => {
    if (action === 'stop' ? stopDisabled : disabled) return
    const attempt = ++sequence.current
    const target = { id: chat.id, expectedRunId: chat.run?.id ?? null, expectedGeneration: chat.generation }
    setPending({ action, sequence: attempt, target })
    void control(action, target).then(
      () => {},
      () => { /* The persistent frame reports the command failure without changing this status. */ },
    ).finally(() => { setPending(current => current?.sequence === attempt ? null : current) })
  }
  return <div className={css.chatControls} aria-busy={activeControl !== null} data-katcats-chat-controls="">
    <div className={css.chatStatus} aria-live="off">
      {activeControl !== null ? <span>{t('chat.controlPending')}</span>
        : <>
          {chat.status !== 'active' && <span>{t(`chat.${chat.status}`)}</span>}
          {working.length > 0 ? <GroupWorkerStatus members={working} managerId={chat.managerId} t={t} />
            : chat.status === 'active' && <span>{t(activity?.processing === true ? 'chat.preparing' : 'chat.idle')}</span>}
        </>}
    </div>
    <div className={css.chatControlActions}>
      {chat.status === 'active'
        ? <Button size="sm" variant="outline" disabled={disabled} onClick={() => { invoke('pause') }}>{t('chat.pause')}</Button>
        : <Button size="sm" variant="outline" disabled={disabled} onClick={() => { invoke('resume') }}>
          {t(chat.status === 'stopped' ? 'chat.newRun' : 'chat.resume')}</Button>}
      <Button size="sm" variant="outline" disabled={stopDisabled}
        onClick={() => { invoke('stop') }}>{t('chat.stop')}</Button>
    </div>
    {chat.status === 'paused' && !specificUnknown && (chat.error === null || pauseMessageKey !== failureKey(chat.error.code))
      && <p className={css.hint}>{t(pauseMessageKey)}</p>}
    {view.phase === 'failed' && <p className={css.hint} role="alert">{t('chat.loadFailed')}</p>}
    {chat.error !== null && <>
      <p className={css.chatError} role="alert">{t(failureKey(chat.error.code))}</p>
      <details className={css.chatErrorDetails}><summary>{t('chat.errorDetails')}</summary>
        <code>{chat.error.code}</code><p>{chat.error.message}</p></details>
    </>}
  </div>
}
