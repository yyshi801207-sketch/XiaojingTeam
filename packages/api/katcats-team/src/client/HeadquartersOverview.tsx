/** Live headquarters totals and local clock, independent of scene animation. */
import { useEffect, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import css from './headquarters.module.css'

/**
 * Render distinct busy identities and processing groups beside the personnel entry.
 * @param props - Live counts, connection state, localized copy and personnel action.
 * @returns Compact overview and a clock using the device's local time.
 */
export function HeadquartersOverview({ busy, active, connected, onPeople, t }: {
  readonly busy: number
  readonly active: number
  readonly connected: boolean
  readonly onPeople: () => void
  readonly t: TranslateNS<'katcats.room'>
}) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => { setNow(new Date()) }, 1000)
    return () => { clearInterval(timer) }
  }, [])
  const day = now.getHours() >= 6 && now.getHours() < 18
  return <div className={css.overview}>
    <div className={css.overviewCounts} title={connected ? t('hq.countScope') : t('stale')}>
      <i data-connected={connected} />
      <span><b>{connected ? busy : '—'}</b> {t('hq.busy')}</span><em>·</em>
      <span><b>{connected ? active : '—'}</b> {t('hq.advancing')}</span>
      <button type="button" onClick={onPeople}>{t('people')}</button>
    </div>
    <div className={css.clock}><span aria-hidden="true">{day ? '☀' : '☾'}</span>
      <time dateTime={now.toISOString()}>{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</time>
      <small>{t(day ? 'hq.day' : 'hq.night')}</small></div>
  </div>
}
