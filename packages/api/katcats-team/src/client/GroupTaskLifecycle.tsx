/** Actual task allocation and complete member handoffs, separate from each member's reply. */
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { ChatTaskActor, ChatTaskMember, ChatTaskStatus } from '../chats-task-events.ts'
import type {} from './chat-task-lifecycle.ts'
import type { BotId } from '../types.ts'
import { GroupMemberAvatar } from './GroupMemberAvatar.tsx'
import { groupHandoffRecordsVisible, groupManager, type GroupIdentityInjected } from './group-manager.ts'
import type { TaskKey } from './task-locales.ts'
import css from './group-task-lifecycle.module.css'

/** The renderer receives its current Session from the enclosing conversation. */
export type GroupTaskLifecycleProps = PropsRuntime<'conversation.chat.node', 'katcats-task'> & PropsLocale<'katcats.tasks'>
  & InjectFace<GroupIdentityInjected>

const STATE_KEYS: Record<ChatTaskStatus, TaskKey> = {
  queued: 'state.queued', started: 'state.started', completed: 'state.completed', passed: 'state.passed',
  failed: 'state.failed', cancelled: 'state.cancelled', unknown: 'state.unknown',
}

function participantName(participant: ChatTaskActor, t: TranslateNS<'katcats.tasks'>): string {
  if (participant.kind === 'owner') return t('task.owner')
  if (participant.kind === 'legacy-coordinator') return t('task.legacyCoordinator')
  return participant.sender?.name ?? t('task.unavailableMember')
}

function MemberIdentity({ member, name, managerId, managerLabel }: {
  readonly member: ChatTaskMember
  readonly name: string
  readonly managerId: BotId | null
  readonly managerLabel: string
}) {
  return <span className={css.participant}>
    {member.sender !== null && <GroupMemberAvatar appearance={member.sender.avatar} botId={member.botId} size={20}
      managerId={managerId} managerLabel={managerLabel} />}
    <strong>{name}</strong>
  </span>
}

/**
 * Show committed handoffs and observed stages only in their original group transcript.
 * @param props - Typed lifecycle node, exact current Session and localized task copy.
 * @returns A task record and, for member handoffs, its full Markdown; nothing outside the original root Session.
 */
export function GroupTaskLifecycle({ node, sessionId, useGroupDirectory, t }: GroupTaskLifecycleProps) {
  const { task, stages } = node.data
  const managerId = useGroupDirectory(view => groupManager(view, task.chatId, sessionId))
  const visible = useGroupDirectory(view => groupHandoffRecordsVisible(view, task.chatId, sessionId))
  if (sessionId !== task.rootSessionId || !visible) return null
  const from = participantName(task.actor, t)
  const to = participantName(task.target, t)
  const memberHandoff = task.actor.kind === 'member'
  return <>
    {memberHandoff && <section className={css.handoff} aria-label={t('task.handoff', { from, to })}
      data-katcats-handoff={task.deliveryId}>
      <details className={css.handoffDetails} open>
        <summary>
          {task.actor.sender !== null
            && <GroupMemberAvatar appearance={task.actor.sender.avatar} botId={task.actor.botId} size={28}
              managerId={managerId} managerLabel={t('task.managerBadge')} />}
          <strong>{t('task.handoff', { from, to })}</strong>
          <span className={css.handoffSource}>{t('task.toolHandoff')}</span>
        </summary>
        <div className={css.handoffBody} data-katcats-handoff-body="">
          <MarkdownText text={task.message} labels={{ code: { copyLabel: t('task.copy'), copiedLabel: t('task.copied') },
            link: { copyLabel: t('task.copy'), copiedLabel: t('task.copied') }, footnotes: t('task.footnotes') }} />
        </div>
      </details>
    </section>}
    <article className={css.record} aria-label={t('task.record', { from, to })}
      data-katcats-task={task.deliveryId} data-state={task.status}>
      <div className={css.heading}>
        {task.actor.kind === 'member' ? <MemberIdentity member={task.actor} name={from} managerId={managerId}
          managerLabel={t('task.managerBadge')} /> : <strong>{from}</strong>}
        <span className={css.arrow} aria-hidden="true">→</span>
        <MemberIdentity member={task.target} name={to} managerId={managerId} managerLabel={t('task.managerBadge')} />
        <span className={css.status}>{t(STATE_KEYS[task.status])}</span>
      </div>
      {!memberHandoff && <details className={css.instructions}>
        <summary><span className={css.label}>{t('task.instructions')}</span><span className={css.preview}>{task.message}</span></summary>
        <p className={css.fullInstructions}>{task.message}</p>
      </details>}
      <ol className={css.progress} aria-label={t('task.progress')}>
        {stages.map((stage) => {
          const date = new Date(stage.time)
          const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
          return <li key={stage.eventId}>
            <span>{t(STATE_KEYS[stage.status])}</span>
            {stage.recovered ? <span>{t('task.recovered')}</span>
              : <time dateTime={date.toISOString()} title={date.toLocaleString()} aria-label={t('task.time', { time })}>{time}</time>}
          </li>
        })}
      </ol>
      {task.error !== null && <p className={css.notice}>{t('task.failure', { message: task.error.message })}</p>}
      {task.status === 'unknown' && <p className={css.notice}>{t('task.unknownHint')}</p>}
      {task.status === 'passed' && <p className={css.notice}>{t('task.passedHint')}</p>}
    </article>
  </>
}
