/** Independent global dispatch window; group room views keep their own state. */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { BotId, TeamBot } from '../types.ts'
import type { ChatId } from '../chats-types.ts'
import type { TeamView } from './model.ts'
import type { ChatView } from './chat-model.ts'
import type { HeadquartersState } from './headquarters-state.ts'
import type { HeadquartersPerson, HeadquartersSceneState } from './HeadquartersScene.tsx'
import { headquartersActivity, headquartersAddresses, projectHeadquarters, HEADQUARTERS_ROOMS_PER_FLOOR } from './headquarters-model.ts'
import { HeadquartersOverview } from './HeadquartersOverview.tsx'
import { HeadquartersPeople } from './HeadquartersPeople.tsx'
import { RoomUsage } from './RoomUsage.tsx'
import { useHandoffScroll } from './use-handoff-scroll.ts'
import { TaskArchiveAction } from './TaskArchive.tsx'
import { ROOM_ACTIVITY_ROWS } from './room-activity-model.ts'
import type {} from './room-locales.ts'
import roomCss from './group-room.module.css'
import css from './headquarters.module.css'

const Scene = lazy(() => import('./HeadquartersScene.tsx'))
const colors = ['#ffba54', '#ff77b6', '#ff795d', '#39d6a0', '#60c9ff', '#b398ff', '#ccdc68', '#e4b784']

/** Framework-bound data and read-only navigation commands for the global window. */
export interface HeadquartersInjected {
  readonly copyText: (text: string) => Promise<void>
  readonly hooks: {
    readonly headquarters: ObservableSnapshot<HeadquartersState>
    readonly directory: ObservableSnapshot<TeamView>
    readonly chats: ObservableSnapshot<ChatView>
    readonly connection: ObservableSnapshot<ConnectionState | undefined>
    readonly statuses: ObservableSnapshot<SessionStatusSnapshot>
  }
  readonly close: () => void
  readonly select: (id: ChatId | null) => void
  readonly openChat: (id: ChatId) => void
  readonly openBot: (id: BotId) => void
}

type HeadquartersProps = InjectFace<HeadquartersInjected> & PropsLocale<'katcats.room'>

/**
 * Mount the global room only while its independent sidebar entry is open.
 * @param props - Framework-provided catalog, selection and localization hooks.
 * @returns Global dispatch overlay or no mounted WebGL resources.
 */
export function Headquarters(props: HeadquartersProps) {
  const open = props.useHeadquarters(value => value.open)
  return open ? <HeadquartersWindow {...props} /> : null
}

function HeadquartersWindow(props: HeadquartersProps) {
  const { t } = props
  const state = props.useHeadquarters(value => value)
  const directory = props.useDirectory(value => value.snapshot)
  const chats = props.useChats(value => value)
  const connection = props.useConnection(value => value)
  const statuses = props.useStatuses(value => value)
  const connected = connection === 'connected' && chats.phase === 'ready'
  const data = useMemo(() => projectHeadquarters(directory, chats.snapshot, connected), [directory, chats.snapshot, connected])
  const addresses = useRef<ReadonlyMap<ChatId, number>>(new Map())
  addresses.current = headquartersAddresses(addresses.current, data.groups.map(group => group.chat.id))
  const [floor, setFloor] = useState(0)
  const [focus, setFocus] = useState<ChatId | null>(null)
  const [cameraMode, setCameraMode] = useState<0 | 1 | 2>(0)
  const [person, setPerson] = useState<BotId | null>(null)
  const [following, setFollowing] = useState(true)
  const [peopleOpen, setPeopleOpen] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [fullscreenFailed, setFullscreenFailed] = useState(false)
  const ownsFullscreen = useRef(false)
  useEffect(() => {
    const changed = () => {
      const active = document.fullscreenElement === document.documentElement && ownsFullscreen.current
      setFullscreen(active)
      if (!active) ownsFullscreen.current = false
    }
    document.addEventListener('fullscreenchange', changed)
    return () => {
      document.removeEventListener('fullscreenchange', changed)
      if (ownsFullscreen.current && document.fullscreenElement) {
        // Native Escape remains available if the window is already tearing down.
        void document.exitFullscreen().catch((error: unknown) => { console.warn('Headquarters fullscreen exit failed', error) })
      }
    }
  }, [])
  const toggleFullscreen = async () => {
    setFullscreenFailed(false)
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else {
        ownsFullscreen.current = true
        await document.documentElement.requestFullscreen()
      }
    } catch (error: unknown) {
      ownsFullscreen.current = document.fullscreenElement === document.documentElement
      setFullscreenFailed(true)
      console.warn('Headquarters fullscreen change failed', error)
    }
  }
  const dismiss = () => {
    if (fullscreen) void toggleFullscreen()
    else props.close()
  }
  const activity = useRef<HTMLDivElement>(null)
  const handoffs = useHandoffScroll(JSON.stringify([state.selected, person]))
  const drag = useRef<{ x: number; y: number; left: number; top: number; dialog: HTMLElement } | null>(null)
  const selected = data.groups.find(group => group.chat.id === state.selected)
  const counts = headquartersActivity(chats.snapshot,
    (directory?.bots ?? []).filter(bot => statuses.get(bot.sessionId)?.running).map(bot => bot.id))
  const visible = data.groups.filter(group =>
    Math.floor((addresses.current.get(group.chat.id) ?? 0) / HEADQUARTERS_ROOMS_PER_FLOOR) === floor)
  const floors = Math.max(1, ...[...addresses.current.values()].map(address => Math.floor(address / HEADQUARTERS_ROOMS_PER_FLOOR) + 1))
  const choose = (id: ChatId | null, botId?: BotId) => {
    props.select(id); setPerson(botId ?? null); setFollowing(true)
    if (id !== null) {
      setFloor(Math.floor((addresses.current.get(id) ?? 0) / HEADQUARTERS_ROOMS_PER_FLOOR))
      setFocus(id); setCameraMode(0)
    } else { setFocus(null); setCameraMode(0) }
  }
  useEffect(() => {
    if (state.selected !== null && !data.groups.some(group => group.chat.id === state.selected)) props.select(null)
  }, [state.selected, data.groups, props.select])
  const rows = useMemo(() => state.activity.members.flatMap(member => member.rows)
    .sort((a, b) => a.time - b.time || a.seq - b.seq).slice(-ROOM_ACTIVITY_ROWS), [state.activity])
  useEffect(() => {
    if (following && activity.current) activity.current.scrollTop = activity.current.scrollHeight
  }, [rows, following])
  const independentPerson = (bot: TeamBot): HeadquartersPerson => {
    const status = statuses.get(bot.sessionId)
    const phase = !connected || status?.running === undefined ? 'syncing' : status.running ? 'started' : 'idle'
    return { id: bot.id, name: bot.name, role: bot.role, color: bot.avatar.color,
      position: t(bot.id === data.main?.id ? 'hq.main' : 'hq.independent'), phase, label: t(`phase.${phase}`), manager: false }
  }
  const scene: HeadquartersSceneState = {
    groups: visible.map(({ chat, projection }) => ({ id: chat.id, name: chat.name,
      slot: (addresses.current.get(chat.id) ?? 0) % HEADQUARTERS_ROOMS_PER_FLOOR,
      color: colors[(addresses.current.get(chat.id) ?? 0) % colors.length] ?? '#ffc46b',
      caption: t('memberCount', { count: chat.memberIds.length }),
      members: projection.members.filter(member => member.current).map(member => ({ id: member.id, name: member.name,
        role: member.role, color: member.avatar.color, phase: member.phase, label: t(`phase.${member.phase}`),
        manager: member.id === chat.managerId, position: t(member.id === chat.managerId ? 'manager' : 'person.member') })),
      links: projection.tasks.map(task => ({ from: task.from, to: task.botId, active: task.status === 'started' || task.status === 'queued' })),
    })), main: data.main ? independentPerson(data.main) : null, independent: data.independent.map(independentPerson),
    selected: state.selected, focus, cameraMode,
  }
  const rosterKey = JSON.stringify([scene.groups.map(group => [group.id, group.slot, group.name,
    group.members.map(member => [member.id, member.name, member.role, member.color, member.manager])]),
  scene.main && [scene.main.id, scene.main.name, scene.main.role, scene.main.color],
  scene.independent.map(bot => [bot.id, bot.name, bot.role, bot.color])])
  const privateBot = directory?.bots.find(bot => bot.id === person)
  return <Modal open headless title={t('hq.title')} onClose={dismiss} className={`${roomCss.dialog} ${fullscreen ? css.fullscreen : ''}`}>
    <div className={`${roomCss.room} ${css.headquarters}`}>
      <header className={css.header} onPointerDown={(event) => {
        if (fullscreen || event.button !== 0 || (event.target as HTMLElement).closest('button,select')) return
        const dialog = event.currentTarget.closest<HTMLElement>('[role="dialog"]')
        if (!dialog) return
        const rect = dialog.getBoundingClientRect()
        drag.current = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, dialog }
        event.currentTarget.setPointerCapture(event.pointerId)
      }} onPointerMove={(event) => {
        const current = drag.current
        if (!current) return
        current.dialog.style.position = 'fixed'; current.dialog.style.margin = '0'; current.dialog.style.transform = 'none'
        current.dialog.style.left = `${Math.max(80 - current.dialog.offsetWidth,
          Math.min(window.innerWidth - 80, current.left + event.clientX - current.x))}px`
        current.dialog.style.top = `${Math.max(0, Math.min(window.innerHeight - 60, current.top + event.clientY - current.y))}px`
      }} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
        <div><small>{t('hq.eyebrow')}</small><h1>{t('hq.title')}</h1><p>{t('hq.summary', { groups: data.groups.length, bots: directory?.bots.length ?? 0 })}</p></div>
        <nav aria-label={t('views')}>
          <button type="button" onClick={() => { setCameraMode(value => value === 2 ? 0 : value === 0 ? 1 : 2); setFocus(null) }}>
            {t('cameraLabel')} · {t(cameraMode === 0 ? 'overview' : cameraMode === 1 ? 'tour' : 'topView')}</button>
          <button type="button" onClick={() => { setFocus(null); setCameraMode(0) }}>{t('overview')}</button>
          <button type="button" aria-pressed={fullscreen} onClick={() => { void toggleFullscreen() }}>{t(fullscreen ? 'hq.exitFullscreen' : 'hq.fullscreen')}</button>
          <button type="button" onClick={props.close}>{t('hq.close')}</button>
        </nav>
      </header>
      <HeadquartersOverview {...counts} connected={connected} t={t} onPeople={() => { setPeopleOpen(true) }} />
      <Suspense fallback={<p>{t('loading')}</p>}><Scene key={rosterKey} state={scene} title={t('hq.title')} failure={t('sceneFailed')}
        onSelect={choose} onClose={dismiss} className={css.scene} /></Suspense>
      {fullscreenFailed && <p className={css.fullscreenError} role="alert">{t('hq.fullscreenFailed')}</p>}
      <aside className={css.metrics}>
        {selected ? <RoomUsage projection={selected.projection} runId={selected.chat.run?.id ?? null} snapshot={state.activity} t={t}
          replay={false} running={selected.projection.members.some(member => member.phase === 'started')} />
          : <><small>{t('hq.main')}</small><h2>{data.main?.name ?? t('people.unavailable')}</h2>
            <p>{t('hq.choose')}</p></>}
        {!connected && <p role="status">{t('stale')}</p>}
        {privateBot && <section><h2>{privateBot.name}</h2><p>{privateBot.role}</p><button type="button" onClick={() => { props.openBot(privateBot.id) }}>{t('close')}</button></section>}
      </aside>
      <aside className={css.panel}>
        <select aria-label={t('hq.select')} value={state.selected ?? ''} onChange={(event) => { choose(data.groups.find(group => group.chat.id === event.target.value)?.chat.id ?? null) }}>
          <option value="">{t('hq.choose')}</option>{data.groups.map(group => <option key={group.chat.id} value={group.chat.id}>{group.chat.name}</option>)}
        </select>
        {selected ? <>
          <section className={css.activity}>
            <div className={css.heading}><h2>{t('activity.title')}</h2><small>{selected.chat.name}</small>
              {!following && <button type="button" onClick={() => { setFollowing(true) }}>{t('activity.follow')}</button>}</div>
            {!state.activity.connected && <small>{t('stale')}</small>}
            {state.activity.members.some(member => member.state === 'failed') && <p role="alert">{t('activity.failed')}</p>}
            <div ref={activity} className={css.activityLog} role="log" tabIndex={0} aria-label={t('activity.log')} onScroll={(event) => {
              const el = event.currentTarget; setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
            }}>
              {!rows.length && <p>{t('activity.empty')}</p>}
              {rows.map(row => <div className={css.event} key={row.id}>
                <span title={t(`activity.${row.kind}`, { tool: row.tool || t('activity.unknownTool'), step: String(row.step ?? '') })}>
                  {t(`activity.${row.kind}`, { tool: row.tool || t('activity.unknownTool'), step: String(row.step ?? '') })}</span>
                <b style={{ color: selected.projection.members.find(member => member.id === row.botId)?.avatar.color }}>
                  {selected.projection.members.find(member => member.id === row.botId)?.name}</b>
                <time>{new Date(row.time).toLocaleTimeString()}</time>
              </div>)}
            </div>
          </section>
          <section className={css.handoffs} key={selected.chat.id}>
            <div className={css.heading}><h2>{t('tasks')}</h2>
              <TaskArchiveAction chat={selected.chat} bots={directory?.bots ?? []} connected={connected}
                room copyText={props.copyText} t={t} />
              <button type="button" onClick={handoffs.top}>{t('top')}</button>
              <button type="button" onClick={handoffs.bottom}>{t('bottom')}</button></div>
            <div ref={handoffs.ref} onScroll={handoffs.onScroll} className={css.handoffLog} role="log" aria-label={t('handoffLog')} tabIndex={0}>
              {selected.chat.error && <p role="alert">{selected.chat.error.message}</p>}
              {!selected.projection.tasks.length && <p>{t('empty')}</p>}
              {selected.projection.tasks.map(task => <details key={task.id} className={roomCss.task}>
                <summary><span>{task.from === null ? t('owner') : selected.projection.members.find(member => member.id === task.from)?.name ?? task.from}
                  {' → '}{selected.projection.members.find(member => member.id === task.botId)?.name ?? task.botId}</span><small>{t(`phase.${task.status}`)}</small>
                <span className={roomCss.taskBrief}>{task.message}</span></summary>
                <p className={roomCss.message}>{task.message}</p>{task.error && <p role="alert">{task.error}</p>}
                {selected.projection.replies.filter(reply => reply.deliveryId === task.id)
                  .map(reply => <p key={reply.id} className={roomCss.message}>{reply.text}</p>)}
              </details>)}
            </div>
            <button type="button" onClick={() => { props.openChat(selected.chat.id) }}>{t('close')}</button>
          </section>
        </> : <p className={css.empty}>{t('hq.choose')}</p>}
      </aside>
      <footer className={css.footer}>
        <div className={css.heading}><h2>{t('hq.groups')}</h2><span>{t('hq.floor', { count: floor + 1 })}</span>
          <button type="button" disabled={floor === 0} onClick={() => { setFloor(floor - 1); setFocus(null) }}>←</button>
          <button type="button" disabled={floor >= floors - 1} onClick={() => { setFloor(floor + 1); setFocus(null) }}>→</button></div>
        <div className={css.groups}>{data.groups.map(group => <button type="button" key={group.chat.id} aria-pressed={state.selected === group.chat.id}
          style={{ borderColor: colors[(addresses.current.get(group.chat.id) ?? 0) % colors.length] }}
          onClick={() => { choose(group.chat.id) }}>
          <strong>{group.chat.name}</strong><b className={css.completion} aria-label={t('hq.progress')}>
            {connected && group.progress.percent !== null ? `${group.progress.percent}%` : '—'}</b>
          <span className={css.completionLine} title={t('hq.progressScope')}><i style={{ width: `${connected ? group.progress.percent ?? 0 : 0}%`, background: colors[(addresses.current.get(group.chat.id) ?? 0) % colors.length] }} /></span>
          <small title={t('hq.progressScope')}>{!connected ? t('phase.syncing') : group.progress.percent === null ? t('hq.noTasks')
            : t('hq.progressCount', { done: group.progress.completed, total: group.progress.total })}</small>
          <span>{group.progress.unresolved ? t('hq.unresolved', { count: group.progress.unresolved }) : t('memberCount', { count: group.chat.memberIds.length })}</span>
        </button>)}</div>
      </footer>
      {peopleOpen && <HeadquartersPeople directory={directory} data={data} selected={state.selected} activity={state.activity}
        statuses={statuses} connected={connected} close={() => { setPeopleOpen(false) }}
        openBot={props.openBot} copyText={props.copyText} t={t} />}
    </div>
  </Modal>
}
