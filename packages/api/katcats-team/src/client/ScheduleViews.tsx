/** Scoped and aggregate automation lists over one read-only product catalog. */
import { useId, useState } from 'react'
import { Button, IconClockOutlineRegular, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule/client'
import type { TeamView } from './model.ts'
import type { ChatView } from './chat-model.ts'
import { groupSchedules, scheduleOwner, type ScheduleOwner, type ScheduleOwnerGroup, type ScheduleView } from './schedule-model.ts'
import type {} from './schedule-locales.ts'
import css from './schedule.module.css'

/** Narrow task viewing actions and framework-bound data sources. */
export interface ScheduleViewsInjected {
  readonly hooks: {
    readonly schedules: ObservableSnapshot<ScheduleView>
    readonly directory: ObservableSnapshot<TeamView>
    readonly chats: ObservableSnapshot<ChatView>
  }
  readonly reload: () => Promise<void>
  readonly openTask: (task: ScheduleCatalogEntry) => void
}

/** Per-Session settings-list props; scope never follows a global selected Bot. */
export type ScheduleListProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'katcats.schedules'> & InjectFace<ScheduleViewsInjected>
/** Central task-view props with all product owners. */
export type ScheduleManagerProps = PropsRuntime<'main'> & PropsLocale<'katcats.schedules'> & InjectFace<ScheduleViewsInjected>

type SharedProps = PropsLocale<'katcats.schedules'> & InjectFace<ScheduleViewsInjected>
type StatusFilter = 'all' | ScheduleCatalogEntry['status']

function ownerName(owner: ScheduleOwner, t: SharedProps['t']): string {
  return owner.kind === 'unlinked' ? t('unlinked') : t(owner.kind, { name: owner.name })
}

/**
 * Show only tasks belonging to the settings tab's Bot or group, including historical workers.
 * @param props - Current tab Session and shared catalog hooks.
 * @returns Scoped task list without mounting or reading an executing Session.
 */
export function ScheduleList(props: ScheduleListProps) {
  const directory = props.useDirectory(view => view)
  const chats = props.useChats(view => view)
  const bots = directory.snapshot?.bots
  const groups = chats.snapshot?.chats
  if (bots === undefined || groups === undefined) return <DirectoryFeedback failed={directory.phase === 'failed' || chats.phase === 'failed'} t={props.t} />
  const owner = scheduleOwner(props.sessionId, bots, groups)
  if (owner.kind === 'unlinked') return <p className={css.feedback}>{props.t('missing')}</p>
  return <TaskList key={owner.key} {...props} scope={owner} />
}

/**
 * Show all retained tasks grouped by exact Bot or group bindings, with unmatched tasks preserved.
 * @param props - Shared task and directory hooks plus existing-detail navigation.
 * @returns Searchable aggregate catalog.
 */
export function ScheduleManager(props: ScheduleManagerProps) {
  return <TaskList {...props} />
}

function DirectoryFeedback({ failed, t }: { readonly failed: boolean; readonly t: SharedProps['t'] }) {
  return <p role={failed ? 'alert' : 'status'} className={css.feedback}>{t(failed ? 'directoryFailed' : 'loading')}</p>
}

function TaskList({ scope, useSchedules, useDirectory, useChats, reload, openTask, t }: SharedProps & { readonly scope?: ScheduleOwner }) {
  const catalog = useSchedules(view => view)
  const directory = useDirectory(view => view)
  const chats = useChats(view => view)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const id = useId()
  const owners = directory.snapshot === null || chats.snapshot === null ? undefined
    : groupSchedules(catalog.records, directory.snapshot.bots, chats.snapshot.chats)
  const scoped = owners?.filter(group => scope === undefined || group.owner.key === scope.key)
  const normalized = query.trim().toLocaleLowerCase()
  const visible: ScheduleOwnerGroup[] = scoped?.map(group => ({ ...group, records: group.records.filter(record =>
    (status === 'all' || record.status === status) && (normalized === ''
      || `${ownerName(group.owner, t)} ${record.title} ${record.prompt}`.toLocaleLowerCase().includes(normalized))),
  })).filter(group => group.records.length > 0) ?? []
  const title = scope === undefined ? t('title') : t('scopedTitle', { name: scope.kind === 'unlinked' ? t('unlinked') : scope.name })
  return <section className={css.page} aria-label={title}>
    <div className={css.heading}><h2>{title}</h2><Button size="sm" variant="outline" onClick={() => { void reload() }}>{t('refresh')}</Button></div>
    {scope === undefined && <>
      <label className={css.searchLabel} htmlFor={id}>{t('search')}</label>
      <Input id={id} value={query} placeholder={t('search')} onChange={(event) => { setQuery(event.target.value) }} />
    </>}
    <div className={css.filters} role="group" aria-label={t('statusFilter')}>
      {(['all', 'active', 'inactive'] as const).map(value => <button key={value} type="button" className={css.filter}
        aria-pressed={status === value} onClick={() => { setStatus(value) }}>{t(value)}</button>)}
    </div>
    {scope?.kind === 'chat' && <p className={css.feedback}>{t('chatNotice')}</p>}
    {catalog.phase !== 'ready' && <p className={css.feedback} role={catalog.phase === 'failed' ? 'alert' : 'status'}>{t(catalog.phase === 'failed' ? 'failed' : 'loading')}</p>}
    {owners === undefined ? <DirectoryFeedback failed={directory.phase === 'failed' || chats.phase === 'failed'} t={t} />
      : <>
        {catalog.phase === 'ready' && visible.length === 0 && <p className={css.feedback}>{t(query.trim() !== '' || status !== 'all' ? 'noMatches' : 'empty')}</p>}
        {visible.map(group => <section key={group.owner.key} className={css.group} aria-label={ownerName(group.owner, t)}>
          {scope === undefined && <div className={css.owner}><h3>{ownerName(group.owner, t)}</h3><span>{t('count', { count: group.records.length })}</span></div>}
          <ul className={css.tasks}>{group.records.map(task => <li key={task.id}>
            <button type="button" className={css.task} aria-label={t('detail', { name: task.title })} onClick={() => { openTask(task) }}>
              <span className={css.taskHeading}><strong>{task.title}</strong><span>{t(task.status)}</span></span>
              <span className={css.prompt}>{task.prompt}</span>
              <time dateTime={task.scheduledAt}>{t(task.status === 'active' ? 'next' : 'last', { time: new Date(task.scheduledAt).toLocaleString() })}</time>
            </button>
          </li>)}</ul>
        </section>)}
      </>}
  </section>
}

/**
 * Render the automation navigation glyph using the sidebar's requested size.
 * @param props - Framework panel icon dimensions.
 * @returns Existing clock icon, with no separate branded glyph.
 */
export function ScheduleManagerIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconClockOutlineRegular size={size} />
}
