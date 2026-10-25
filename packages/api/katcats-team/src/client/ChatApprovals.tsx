/** Visible group decisions retain the original worker approval lifetime and authority. */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ApprovalDecision, PendingApproval } from '@deepseek-ai/dsh-client-ui-approval/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatView } from './chat-model.ts'
import type { TeamView } from './model.ts'
import type { BotId } from '../types.ts'
import { chatApprovals } from './chat-approvals.ts'
import { GroupMemberAvatar } from './GroupMemberAvatar.tsx'
import css from './team.module.css'

/** Original approval data comes from the existing public Session interaction source. */
export interface ChatApprovalsInjected {
  readonly hooks: {
    readonly chats: ObservableSnapshot<ChatView>
    readonly directory: ObservableSnapshot<TeamView>
  }
  readonly resolveReason: (reason: NonNullable<PendingApproval['displayReason']>) => string
  readonly readOperation: (pending: PendingApproval, signal: AbortSignal) => Promise<string | undefined>
}

/** Group-root composer contribution; ordinary approvals keep their existing presentation. */
export type ChatApprovalsProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'katcats.team'> & InjectFace<ChatApprovalsInjected>

/**
 * Display pending worker decisions beside their visible group conversation.
 * @param props - Selected root Session, original requests and localized presentation.
 * @returns Explicit approval controls for this group's workers.
 */
export function ChatApprovals({
  sessionId, useChats, useDirectory, useSessionStatus, resolveReason, readOperation, t,
}: ChatApprovalsProps) {
  const chat = useChats(view => view.snapshot?.chats.find(item => item.rootSessionId === sessionId))
  const managerId = useChats(view => view.phase === 'ready'
    ? view.snapshot?.chats.find(item => item.rootSessionId === sessionId)?.managerId ?? null : null)
  const bots = useDirectory(view => view.snapshot?.bots ?? [])
  const statuses = useSessionStatus(value => value)
  if (chat === undefined) return null
  const requests = chatApprovals(chat, statuses)
  if (requests.length === 0) return null
  return <section className={css.approvals} aria-label={t('approval.groupRequests')}>
    {requests.map(({ botId, pending }) => {
      const bot = bots.find(item => item.id === botId)
      return <ApprovalRequest key={pending.key} pending={pending} botId={botId} managerId={managerId} name={bot?.name ?? t('team.general')}
        avatar={bot?.avatar} resolveReason={resolveReason} readOperation={readOperation} t={t} />
    })}
  </section>
}

function ApprovalRequest({ pending, botId, managerId, name, avatar, resolveReason, readOperation, t }: {
  readonly pending: PendingApproval
  readonly botId: BotId
  readonly managerId: BotId | null
  readonly name: string
  readonly avatar: Parameters<typeof GroupMemberAvatar>[0]['appearance'] | undefined
  readonly resolveReason: ChatApprovalsInjected['resolveReason']
  readonly readOperation: ChatApprovalsInjected['readOperation']
  readonly t: ChatApprovalsProps['t']
}) {
  const [answered, setAnswered] = useState(false)
  const [failed, setFailed] = useState(false)
  const [operation, setOperation] = useState<{ readonly text: string | undefined; readonly failed: boolean } | null>(null)
  const waiting = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    if (pending.callId === undefined) return
    const controller = new AbortController()
    void readOperation(pending, controller.signal).then((text) => {
      if (!controller.signal.aborted) setOperation({ text, failed: text === undefined })
    }, () => {
      if (!controller.signal.aborted) setOperation({ text: undefined, failed: true })
    })
    return () => { controller.abort() }
  }, [pending, readOperation])
  const answer = (decision: ApprovalDecision): void => {
    if (waiting.current || !pending.answerable) return
    waiting.current = true
    setAnswered(true)
    setFailed(false)
    void pending.answer(decision).catch(() => {
      if (!mounted.current || !pending.answerable) return
      waiting.current = false
      setAnswered(false)
      setFailed(true)
    })
  }
  const reason = pending.displayReason === undefined ? pending.reason : resolveReason(pending.displayReason)
  const scope = pending.reusable?.displayLabel === undefined ? pending.reusable?.label : resolveReason(pending.reusable.displayLabel)
  const disabled = answered || !pending.answerable
  return <div className={css.approvalCard} role="group" aria-label={t('approval.memberRequest', { name })}
    aria-busy={answered} data-katcats-approval={pending.key}>
    <div className={css.approvalHeading}>
      {avatar !== undefined && <GroupMemberAvatar appearance={avatar} botId={botId} managerId={managerId} size={22}
        managerLabel={t('chat.managerBadge')} />}
      <strong>{t('approval.waitingForMember', { name })}</strong><code>{pending.toolName}</code>
    </div>
    <p>{reason ?? t('approval.operation', { toolName: pending.toolName })}</p>
    {operation?.text !== undefined && <details className={css.approvalOperation}><summary>{t('approval.viewOperation')}</summary>
      <pre>{operation.text}</pre></details>}
    {operation?.failed === true && <p className={css.hint}>{t('approval.operationUnavailable')}</p>}
    {scope !== undefined && <p className={css.hint}>{t('approval.executionScope', { scope })}</p>}
    <div className={css.approvalActions}>
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => { answer('rejected') }}>{t('approval.reject')}</Button>
      {pending.reusable !== undefined && <Button size="sm" variant="outline" disabled={disabled}
        onClick={() => { answer('allowed-session') }}>{t('approval.allowExecution')}</Button>}
      <Button size="sm" variant="primary" disabled={disabled} onClick={() => { answer('allowed-once') }}>{t('approval.allowOnce')}</Button>
    </div>
    {failed && <p role="alert">{t('approval.answerFailed')}</p>}
  </div>
}
