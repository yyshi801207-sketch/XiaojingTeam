/** Actual executing members rotate visually without repeatedly announcing status to screen readers. */
import { useEffect, useRef, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { BotId, TeamBot } from '../types.ts'
import { GroupMemberAvatar } from './GroupMemberAvatar.tsx'
import css from './group-worker-status.module.css'

/** The phase derives from this exact executor's original pending interaction. */
export interface GroupWorkerStatusItem {
  readonly bot: TeamBot
  readonly phase: 'working' | 'approval' | 'question'
}

/**
 * Present one active member at a time, or all members when reduced motion is preferred.
 * @param props - Only actual running group members, their phases and current manager identity.
 * @returns A concise, non-live status group whose rotation pauses on hover, focus or hidden pages.
 */
export function GroupWorkerStatus({ members, managerId, t }: {
  readonly members: readonly GroupWorkerStatusItem[]
  readonly managerId: BotId | null
  readonly t: TranslateNS<'katcats.team'>
}) {
  const [current, setCurrent] = useState<BotId | null>(null)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden')
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const memberOrder = JSON.stringify(members.map(member => member.bot.id))
  const currentMembers = useRef(members)
  useEffect(() => { currentMembers.current = members }, [members])
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const change = () => { setReduced(media.matches) }
    const visibility = () => { setHidden(document.visibilityState === 'hidden') }
    media.addEventListener('change', change)
    document.addEventListener('visibilitychange', visibility)
    return () => { media.removeEventListener('change', change); document.removeEventListener('visibilitychange', visibility) }
  }, [])
  useEffect(() => {
    if (members.length < 2 || reduced || hovered || focused || hidden) return
    const timer = setInterval(() => {
      setCurrent((previous) => {
        const latest = currentMembers.current
        const next = (Math.max(0, latest.findIndex(member => member.bot.id === previous)) + 1) % latest.length
        return latest[next]?.bot.id ?? null
      })
    }, 4_000)
    return () => { clearInterval(timer) }
  }, [memberOrder, reduced, hovered, focused, hidden])
  const selected = members.find(member => member.bot.id === current) ?? members[0]
  if (selected === undefined) return null
  const visible = reduced ? members : [selected]
  const phase = (member: GroupWorkerStatusItem) => t(member.phase === 'approval' ? 'chat.phaseApproval'
    : member.phase === 'question' ? 'chat.phaseQuestion' : 'chat.phaseWorking')
  const label = members.map(member => t('chat.memberStatus', { name: member.bot.name, phase: phase(member) })).join('; ')
  return <div className={css.status} role="group" aria-label={label} aria-live="off"
    tabIndex={members.length > 1 && !reduced ? 0 : undefined} data-katcats-worker-status=""
    data-rotating={members.length > 1 && !reduced && !hovered && !focused && !hidden || undefined}
    onMouseEnter={() => { setHovered(true) }} onMouseLeave={() => { setHovered(false) }}
    onFocusCapture={() => { setFocused(true) }} onBlurCapture={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
    }}>
    <span className={css.members} aria-hidden="true">
      {visible.map(member => <span key={member.bot.id} className={css.member} data-katcats-working-member={member.bot.id}>
        <GroupMemberAvatar botId={member.bot.id} managerId={managerId} appearance={member.bot.avatar} size={22}
          managerLabel={t('chat.managerBadge')} />
        <span className={css.name}>{member.bot.name}</span><span>{phase(member)}</span>
      </span>)}
      {members.length > 1 && !reduced && <span className={css.count}>{members.indexOf(selected) + 1}/{members.length}</span>}
    </span>
  </div>
}
