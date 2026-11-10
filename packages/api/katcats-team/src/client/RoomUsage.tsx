/** Group-scoped reported usage from owned executor journals. */
import { useEffect, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { ChatRunId } from '../chats-types.ts'
import type { RoomProjection } from './group-room-model.ts'
import type { RoomActivitySnapshot } from './room-activity.ts'
import { totalRoomUsage } from './room-usage-model.ts'
import css from './group-room.module.css'

/**
 * Display returned usage for one group run, with explicit partial-data limits.
 * @param props - Group projection, owned executor snapshots and live/replay state.
 * @returns Read-only usage metrics and per-member breakdown; replay never displays live usage.
 */
export function RoomUsage({ snapshot, projection, runId, replay, running, t }: {
  readonly snapshot: RoomActivitySnapshot | null
  readonly projection: RoomProjection
  readonly runId: ChatRunId | null
  readonly replay: boolean
  readonly running: boolean
  readonly t: TranslateNS<'katcats.room'>
}) {
  if (replay) return <section className={css.usage} aria-label={t('usage.title')}><h2>{t('usage.title')}</h2><p>{t('usage.replay')}</p></section>
  const members = snapshot?.members ?? []
  const samples = members.flatMap(member => member.usage ?? []).filter(sample => runId !== null && sample.runId === runId)
  const totals = totalRoomUsage(samples)
  const partial = members.some(member => member.hasMore || member.state !== 'ready'
    || member.usage?.some(sample => sample.runId === null)) || totals.missing > 0
  const available = snapshot?.connected === true && runId !== null && members.every(member => member.state === 'ready')
  const number = (value: number | null) => value === null ? '—' : value.toLocaleString()
  return <section className={css.usage} aria-label={t('usage.title')}>
    <h2>{t('usage.title')}</h2><p>{t('usage.round')}</p>
    <strong className={css.usageTotal} title={available ? number(totals.total) : undefined}>
      {available && totals.total !== null ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(totals.total) : '—'}
    </strong>
    <small>Token</small>
    <dl className={css.usageGrid}>
      <div><dt>{t('usage.input')}</dt><dd>{available ? number(totals.input) : '—'}</dd></div>
      <div><dt>{t('usage.cache')}</dt><dd>{available ? number(totals.cacheRead) : '—'}</dd></div>
      <div><dt>{t('usage.output')}</dt><dd>{available ? number(totals.output) : '—'}</dd></div>
      <div><dt>{t('usage.cacheWrite')}</dt><dd>{available ? number(totals.cacheWrite) : '—'}</dd></div>
      <div><dt>{t('usage.calls')}</dt><dd>{available ? number(totals.calls) : '—'}</dd></div>
    </dl>
    {running && <p role="status">{t('usage.pending')}</p>}
    {partial && <p className={css.usageWarning}>{t('usage.partial')}</p>}
    {!snapshot?.connected && <p>{t('usage.syncing')}</p>}
    <details><summary>{t('usage.members')}</summary>
      {members.map((member) => {
        const value = totalRoomUsage((member.usage ?? []).filter(sample => runId !== null && sample.runId === runId))
        return <details key={member.sessionId}>
          <summary className={css.usageMember}>
            <span>{projection.members.find(person => person.id === member.botId)?.name ?? member.botId}</span>
            <strong>{member.state === 'ready' ? number(value.total) : '—'}</strong>
          </summary>
          {member.state === 'ready' && <dl className={css.usageGrid}>
            <div><dt>{t('usage.input')}</dt><dd>{number(value.input)}</dd></div>
            <div><dt>{t('usage.cache')}</dt><dd>{number(value.cacheRead)}</dd></div>
            <div><dt>{t('usage.output')}</dt><dd>{number(value.output)}</dd></div>
            <div><dt>{t('usage.cacheWrite')}</dt><dd>{number(value.cacheWrite)}</dd></div>
          </dl>}
        </details>
      })}
    </details>
    <details className={css.usageNote}><summary>{t('usage.about')}</summary><p>{t('usage.scope')}</p></details>
  </section>
}

/**
 * Show the selected run's recorded duration under its group heading.
 * @param props - Visible lifecycle records, run identity and execution state.
 * @returns A clock that ticks only during live execution; missing timestamps stay unknown.
 */
export function RoomElapsed({ projection, runId, running, t }: {
  readonly projection: RoomProjection
  readonly runId: ChatRunId | null
  readonly running: boolean
  readonly t: TranslateNS<'katcats.room'>
}) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [running])
  const stages = projection.transitions.filter(stage => stage.task.runId === runId && !stage.task.recovered)
  const first = stages[0]?.time, last = stages.at(-1)?.time
  const elapsed = first === undefined || last === undefined ? null : Math.max(0, (running ? now : last) - first)
  const seconds = Math.floor((elapsed ?? 0) / 1000)
  const duration = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, '0')).join(':')
  return <span className={css.elapsed} aria-label={t('usage.elapsed')} title={t('usage.elapsed')}>
    {elapsed === null ? '—' : duration}
  </span>
}
