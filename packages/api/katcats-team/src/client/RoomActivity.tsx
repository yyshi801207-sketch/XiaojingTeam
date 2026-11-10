/** Scrollable execution facts with room-scoped subscriptions and explicit scroll following. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { BotId } from '../types.ts'
import type { ChatId } from '../chats-types.ts'
import type { RoomMember } from './group-room-model.ts'
import type { RoomActivitySnapshot } from './room-activity.ts'
import { ROOM_ACTIVITY_ROWS } from './room-activity-model.ts'
import type {} from './room-locales.ts'
import css from './group-room.module.css'

/** One room's read subscription, bounded by its mounted panel or plugin lifetime. */
export type WatchRoomActivity = (chatId: ChatId, signal: AbortSignal) => ObservableSnapshot<RoomActivitySnapshot>

/**
 * Display a compact execution feed above the independently scrolling handoff list.
 * @param props - Current room members, optional member filter, locale and read-only subscription.
 * @returns A bounded live log; scrolling upward stops automatic following until the reader returns.
 */
export function RoomActivity({ chatId, members, selected, watch, t, onSnapshot }: {
  readonly chatId: ChatId
  readonly members: readonly RoomMember[]
  readonly selected: BotId | null
  readonly watch: WatchRoomActivity
  readonly t: TranslateNS<'katcats.room'>
  readonly onSnapshot?: (snapshot: RoomActivitySnapshot | null) => void
}) {
  const [snapshot, setSnapshot] = useState<RoomActivitySnapshot>({ connected: false, members: [] })
  const [retry, setRetry] = useState(0)
  const [following, setFollowing] = useState(true)
  const log = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const controller = new AbortController()
    const source = watch(chatId, controller.signal)
    const read = () => { const next = source.getSnapshot(); setSnapshot(next); onSnapshot?.(next) }
    const unsubscribe = source.subscribe(read)
    read()
    return () => { unsubscribe(); controller.abort(); onSnapshot?.(null) }
  }, [chatId, watch, retry, onSnapshot])
  const rows = useMemo(() => snapshot.members.flatMap(member => member.rows)
    .filter(row => selected === null || row.botId === selected)
    .sort((a, b) => a.time - b.time || a.sessionId.localeCompare(b.sessionId) || a.seq - b.seq)
    .slice(-ROOM_ACTIVITY_ROWS), [snapshot.members, selected])
  useEffect(() => { if (following && log.current) log.current.scrollTop = log.current.scrollHeight }, [following, rows])
  const failed = snapshot.members.some(member => member.state === 'failed')
  return <section className={css.activity} aria-label={t('activity.title')}>
    <div className={css.recordHeader}><h2>{t('activity.title')}</h2><small>{selected === null ? t('activity.all') : members.find(member => member.id === selected)?.name}</small>
      {!following && <button type="button" aria-pressed={following} onClick={() => { setFollowing(!following) }}>
        {t('activity.follow')}
      </button>}
    </div>
    {!snapshot.connected && <p className={css.hint} role="status">{t('stale')}</p>}
    {failed && <p className={css.error} role="alert">{t('activity.failed')} <button type="button" onClick={() => { setRetry(retry + 1) }}>{t('activity.retry')}</button></p>}
    <div ref={log} className={css.activityLog} role="log" aria-label={t('activity.log')} aria-live={following ? 'polite' : 'off'} tabIndex={0}
      onScroll={() => {
        const element = log.current
        if (element) setFollowing(element.scrollHeight - element.clientHeight - element.scrollTop <= 24)
      }}>
      {!rows.length && <p className={css.hint}>{t('activity.empty')}</p>}
      {rows.map((row) => {
        const member = members.find(person => person.id === row.botId)
        const label = t(`activity.${row.kind}`, { tool: row.tool || t('activity.unknownTool'), step: String(row.step ?? '') })
        return <div key={row.id} className={css.activityRow} data-failed={row.kind === 'toolFailed' || row.kind === 'turnFailed'}>
          <span className={css.activityText} title={label}><span>{label}</span></span>
          <strong style={{ color: member ? `color-mix(in srgb, ${member.avatar.color} 65%, var(--room-ink))` : undefined }}>
            {member?.name ?? row.botId}
          </strong>
          <time dateTime={new Date(row.time).toISOString()}>{new Date(row.time).toLocaleTimeString()}</time>
        </div>
      })}
    </div>
  </section>
}
