/** Group activity and private Bot avatars beside the collapsed conversation. */
import { useCallback, useLayoutEffect, useRef } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { ThinkingDots } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ledgerSetupBotId, odooAccessBotId } from '../types.ts'
import type { ChatView } from './chat-model.ts'
import type { GroupQuestion } from './chat-questions.ts'
import type { TeamView } from './model.ts'
import { BotIdentityAvatar } from './BotIdentityAvatar.tsx'
import { GroupMemberAvatar } from './GroupMemberAvatar.tsx'
import css from './conversation-member-rail.module.css'

interface ConversationMemberRailInjected {
  readonly hooks: {
    readonly chats: ObservableSnapshot<ChatView>
    readonly directory: ObservableSnapshot<TeamView>
    readonly groupQuestions: ObservableSnapshot<readonly GroupQuestion[]>
  }
}

type ConversationMemberRailProps = PropsRuntime<'conversation.session.leading'>
  & PropsLocale<'katcats.team'> & InjectFace<ConversationMemberRailInjected>

function useMemberMovement(hasRoster: boolean) {
  const list = useRef<HTMLUListElement>(null)
  const destination = useRef<HTMLDivElement>(null)
  const positionMembers = useCallback(() => {
    const roster = list.current
    const space = destination.current?.getBoundingClientRect()
    if (roster === null || space === undefined) return
    const listRect = roster.getBoundingClientRect()
    const rows = Array.from(roster.querySelectorAll<HTMLLIElement>(':scope > li'), row => ({ row, bounds: row.getBoundingClientRect() }))
    const fits = listRect.height > 0 && roster.scrollHeight <= roster.clientHeight + 1
      && space.width >= Math.max(1, ...rows.map(item => item.bounds.width))
    roster.toggleAttribute('data-member-movement', fits)
    const active = fits ? rows.filter(item => item.row.hasAttribute('data-phase')) : []
    const activeHeight = active.reduce((height, item) => height + item.bounds.height, 0)
    let top = listRect.top + (listRect.height - activeHeight) / 2
    for (const { row, bounds } of rows) {
      if (fits && row.hasAttribute('data-phase')) {
        const x = space.left - bounds.left
        row.style.setProperty('--member-position', `${x}px ${top - bounds.top}px`)
        top += bounds.height
      } else {
        row.style.removeProperty('--member-position')
      }
    }
  }, [])

  useLayoutEffect(positionMembers)
  useLayoutEffect(() => {
    if (!hasRoster || list.current === null || destination.current === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(positionMembers)
    observer.observe(list.current)
    observer.observe(destination.current)
    return () => observer.disconnect()
  }, [hasRoster, positionMembers])

  return { list, destination }
}

/**
 * Present the group roster or the current private Bot's centered identity and activity.
 * @param props - Session scope, current directories, and pending interactions.
 * @returns The identity display for the exact Session, or null when unavailable.
 */
export function ConversationMemberRail({
  sessionId, useChats, useDirectory, useSessionStatus, useGroupQuestions, t,
}: ConversationMemberRailProps) {
  const snapshot = useChats(view => view.phase === 'ready' ? view.snapshot : null)
  const bots = useDirectory(view => view.phase === 'ready' ? view.snapshot?.bots : undefined)
  const statuses = useSessionStatus(value => value)
  const questions = useGroupQuestions(value => value)
  const chat = snapshot?.chats.find(item => item.rootSessionId === sessionId)
  const members = chat?.memberIds.flatMap(id => bots?.find(bot => bot.id === id) ?? []) ?? []
  const { list, destination } = useMemberMovement(members.length > 0)
  if (bots === undefined) return null
  if (chat === undefined) {
    const bot = bots.find(item => item.sessionId === sessionId)
    if (bot === undefined) return null
    const largePortrait = bot.kind === 'main' || bot.id === ledgerSetupBotId || bot.id === odooAccessBotId
    const status = statuses.get(sessionId)
    const working = status?.running === true && status.pendingInteraction === undefined
    const activity = working && <span className={css.activity} role="img" aria-label={t('chat.phaseWorking')}><ThinkingDots /></span>
    return (
      <div className={css.portrait} data-large-portrait={largePortrait ? '' : undefined}>
        <BotIdentityAvatar bot={bot} size={largePortrait ? 120 : 64} rail />
        {largePortrait ? activity : (
          <span className={css.portraitCaption}>
            <span className={css.portraitName} title={bot.name}>{bot.name}</span>
            {activity}
          </span>
        )}
      </div>
    )
  }
  if (members.length === 0) return null
  const running = snapshot?.activities.find(activity => activity.chatId === chat.id)?.runningBotIds
  return (
    <aside className={css.roster} aria-label={t('chat.teamMembers')}>
      <span className={css.heading} aria-hidden="true">{t('chat.teamMembers')}</span>
      <div ref={destination} className={css.destination} data-member-destination="" aria-hidden="true" />
      <ul ref={list} className={css.list} role="list" tabIndex={0}>
        {members.map((bot) => {
          const executor = chat.executors.find(item => item.botId === bot.id)
          const pending = executor === undefined ? undefined : statuses.get(executor.sessionId)?.pendingInteraction
          const phase = executor === undefined || !running?.includes(bot.id) ? undefined
            : pending?.kind === 'approval' && pending.answerable ? 'approval'
              : questions.some(item => item.pending.sessionId === executor.sessionId && item.waiting) ? 'question'
                : 'working'
          return (
            <li key={bot.id} className={css.member} data-phase={phase}>
              <span className={css.memberVisual}>
                <span className={css.avatar}>
                  <GroupMemberAvatar botId={bot.id} managerId={chat.managerId} appearance={bot.avatar} size={30}
                    managerLabel={t('chat.managerBadge')} />
                </span>
                <span className={css.identity}>
                  <span className={css.name} title={bot.name}>{bot.name}</span>
                  {phase === 'working'
                    ? <span className={css.activity} role="img" aria-label={t('chat.phaseWorking')}>
                      <ThinkingDots />
                    </span>
                    : phase !== undefined && <span className={css.phase}>
                      {t(phase === 'approval' ? 'chat.phaseApproval' : 'chat.phaseQuestion')}
                    </span>}
                </span>
              </span>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
