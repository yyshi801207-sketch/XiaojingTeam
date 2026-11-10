/** A group-scoped, read-only room over the existing task journal and live directory. */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Button, ContextMenu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TeamChat } from '../chats-types.ts'
import type { BotId } from '../types.ts'
import type { ChatView } from './chat-model.ts'
import type { TeamView } from './model.ts'
import type { GroupQuestion } from './chat-questions.ts'
import { projectGroupRoom } from './group-room-model.ts'
import { CatAvatar } from './avatars.tsx'
import { RoomActivity, type WatchRoomActivity } from './RoomActivity.tsx'
import type { RoomActivitySnapshot } from './room-activity.ts'
import { RoomUsage, RoomElapsed } from './RoomUsage.tsx'
import { useHandoffScroll } from './use-handoff-scroll.ts'
import { TaskArchiveAction } from './TaskArchive.tsx'
import type {} from './room-locales.ts'
import css from './group-room.module.css'

const RoomScene = lazy(() => import('./RoomScene.tsx'))

/** Read-only inputs scoped to the header's root Session. */
export interface GroupRoomInjected {
  readonly hooks: {
    readonly chats: ObservableSnapshot<ChatView>
    readonly directory: ObservableSnapshot<TeamView>
    readonly roomEvents: ObservableSnapshot<SessionEventWindow>
    readonly roomConnection: ObservableSnapshot<ConnectionState | undefined>
    readonly roomStatuses: ObservableSnapshot<SessionStatusSnapshot>
    readonly groupQuestions: ObservableSnapshot<readonly GroupQuestion[]>
  }
  readonly loadRoomHistory: () => Promise<void>
  readonly watchRoomActivity: WatchRoomActivity
  readonly copyText: (text: string) => Promise<void>
}

/** The room uses the same Session scope as the group header. */
export type GroupRoomProps = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<'katcats.room'> & InjectFace<GroupRoomInjected>

/**
 * Open an on-demand room for a real group; no renderer runs in private chats or closed rooms.
 * @param props - Header scope and injected group stores.
 * @returns A room action and its scoped modal.
 */
export function GroupRoomAction(props: GroupRoomProps) {
  const chat = props.useChats(view => view.snapshot?.chats.find(item => item.rootSessionId === props.sessionId))
  const [open, setOpen] = useState(false)
  if (chat === undefined) return null
  return <>
    <Button size="sm" variant="outline" onClick={() => { setOpen(true) }}>{props.t('open')}</Button>
    {open && <GroupRoom key={chat.id} {...props} chat={chat} close={() => { setOpen(false) }} />}
  </>
}

function GroupRoom(props: GroupRoomProps & { readonly chat: TeamChat; readonly close: () => void }) {
  const { chat, t, close } = props
  const directory = props.useDirectory(view => view.snapshot)
  const groups = props.useChats(view => view)
  const events = props.useRoomEvents(value => value)
  const connection = props.useRoomConnection(value => value)
  const statuses = props.useRoomStatuses(value => value)
  const questions = props.useGroupQuestions(value => value)
  const [cursor, setCursor] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [selected, setSelected] = useState<BotId | null>(null)
  const [camera, setCamera] = useState<BotId | null>(null)
  const [cameraMode, setCameraMode] = useState<0 | 1 | 2>(0)
  const [peopleOpen, setPeopleOpen] = useState(false)
  const [peopleSearch, setPeopleSearch] = useState('')
  const [peopleFilter, setPeopleFilter] = useState<'all' | 'manager' | 'members'>('all')
  const [expandedPerson, setExpandedPerson] = useState<BotId | null>(null)
  const [activitySnapshot, setActivitySnapshot] = useState<RoomActivitySnapshot | null>(null)
  const replaying = cursor !== null
  useEffect(() => {
    if (!peopleOpen || !replaying) return
    const lifetime = new AbortController()
    const source = props.watchRoomActivity(chat.id, lifetime.signal)
    const read = () => { setActivitySnapshot(source.getSnapshot()) }
    const unsubscribe = source.subscribe(read)
    read()
    return () => { unsubscribe(); lifetime.abort() }
  }, [peopleOpen, replaying, chat.id, props.watchRoomActivity])
  const [historyState, setHistoryState] = useState<'idle' | 'loading' | 'failed'>('idle')
  const records = useHandoffScroll(JSON.stringify([chat.id, selected, cursor === null]))
  const drag = useRef<{
    id: number
    x: number
    y: number
    left: number
    top: number
    offsetX: number
    offsetY: number
    dialog: HTMLElement
  } | null>(null)
  const position = useRef({ x: 0, y: 0 })
  const connected = connection === 'connected' && groups.phase === 'ready'
  const waiting = useMemo(() => {
    const values = new Map<BotId, 'approval' | 'question'>()
    for (const executor of chat.executors) {
      const pending = statuses.get(executor.sessionId)?.pendingInteraction
      if (pending?.kind === 'approval' && pending.answerable) values.set(executor.botId, 'approval')
      else if (questions.some(item => item.pending.sessionId === executor.sessionId && item.waiting)) values.set(executor.botId, 'question')
    }
    return values
  }, [chat.executors, statuses, questions])
  const projection = useMemo(() => projectGroupRoom({ chat, bots: directory?.bots ?? [], snapshot: groups.snapshot,
    entries: events.entries, cursor, connected, waiting }), [chat, directory, groups.snapshot, events.entries, cursor, connected, waiting])
  // This timer advances a local display cursor only; it cannot dispatch work or alter a Session.
  useEffect(() => {
    if (!playing || cursor === null) return
    const next = projection.timeline.find(stage => stage.seq > cursor)
    if (next === undefined) { setPlaying(false); return }
    const timer = setTimeout(() => { setCursor(next.seq) }, 1500)
    return () => { clearTimeout(timer) }
  }, [playing, cursor, projection.timeline])
  const at = cursor === null ? projection.timeline.length - 1 : projection.timeline.findLastIndex(stage => stage.seq <= cursor)
  const stage = projection.timeline[at]
  const tasks = projection.tasks.filter(task => selected === null || task.botId === selected || task.from === selected)
  const title = t('title', { name: chat.name })
  const visitors = useMemo(() => cursor === null ? (directory?.bots ?? []).filter(bot => !chat.memberIds.includes(bot.id)
    && !projection.members.some(member => member.id === bot.id)) : [], [directory, chat.memberIds, projection.members, cursor])
  const visiblePeople = [...projection.members, ...visitors]
  const cameraTarget = visiblePeople.some(person => person.id === camera) ? camera : null
  const currentMembers = chat.memberIds.map(id => directory?.bots.find(bot => bot.id === id)).filter(bot => bot !== undefined)
    .map(bot => ({ ...bot, role: chat.memberRoles.find(member => member.botId === bot.id)?.role ?? bot.role }))
  const peopleProjection = useMemo(() => peopleOpen && cursor !== null
    ? projectGroupRoom({ chat, bots: directory?.bots ?? [], snapshot: groups.snapshot,
      entries: events.entries, cursor: null, connected, waiting })
    : projection, [peopleOpen, cursor, chat, directory, groups.snapshot, events.entries, connected, waiting, projection])
  const matchingMembers = currentMembers.filter(member =>
    (peopleFilter === 'all' || (member.id === chat.managerId) === (peopleFilter === 'manager'))
    && `${member.name} ${member.role}`.toLocaleLowerCase().includes(peopleSearch.trim().toLocaleLowerCase()))
  const peopleSections = [
    { key: 'manager' as const, members: matchingMembers.filter(member => member.id === chat.managerId) },
    { key: 'members' as const, members: matchingMembers.filter(member => member.id !== chat.managerId) },
  ]
  const openMember = (id: BotId) => {
    setPeopleSearch('')
    setPeopleFilter('all')
    setExpandedPerson(id)
    setPeopleOpen(true)
  }
  const memberItems = (id: BotId) => [{ id: 'details', label: t('member.viewDetails'),
    disabled: !currentMembers.some(member => member.id === id) }, { id: 'copy', label: t('member.copyName') }]
  const memberAction = (id: BotId, action: string) => {
    if (action === 'details') openMember(id)
    else if (action === 'copy') void props.copyText(directory?.bots.find(member => member.id === id)?.name
      ?? projection.members.find(member => member.id === id)?.name ?? id)
  }
  const activeRunId = chat.run?.id ?? projection.transitions.at(-1)?.task.runId ?? null
  const running = chat.status === 'active' && (groups.snapshot?.activities.some(item => item.chatId === chat.id && item.processing) ?? false)
  const progressRunId = cursor === null ? activeRunId : projection.transitions.findLast(item => item.seq <= cursor)?.task.runId
  const runTasks = projection.tasks.filter(task => task.stages.some(item => item.task.runId === progressRunId))
  const progressCounts = (['completed', 'started', 'queued', 'failed', 'unknown', 'cancelled', 'passed'] as const)
    .map(status => ({ status, count: runTasks.filter(task => task.status === status).length })).filter(item => item.count > 0)
  const runInstruction = runTasks.findLast(task => task.from === null)?.message
  const loadHistory = async () => {
    setHistoryState('loading')
    try { await props.loadRoomHistory(); setHistoryState('idle') }
    catch { setHistoryState('failed') }
  }
  return <Modal open headless title={title} onClose={close} className={css.dialog ?? ''}>
    <div className={css.room}>
      <header className={css.header}
        onPointerDown={(event) => {
          if (event.button !== 0 || !(event.target instanceof Element) || event.target.closest('button, select')) return
          const dialog = event.currentTarget.closest<HTMLElement>('[role="dialog"]')
          if (!dialog) return
          const rect = dialog.getBoundingClientRect()
          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top,
            offsetX: position.current.x, offsetY: position.current.y, dialog }
          event.currentTarget.setPointerCapture(event.pointerId)
          event.preventDefault()
        }}
        onPointerMove={(event) => {
          const current = drag.current
          if (!current || current.id !== event.pointerId) return
          const dx = Math.max(120 - current.dialog.offsetWidth - current.left,
            Math.min(window.innerWidth - 120 - current.left, event.clientX - current.x))
          const dy = Math.max(-current.top, Math.min(window.innerHeight - 64 - current.top, event.clientY - current.y))
          position.current = { x: current.offsetX + dx, y: current.offsetY + dy }
          current.dialog.style.translate = `${position.current.x}px ${position.current.y}px`
        }}
        onPointerUp={(event) => {
          if (drag.current?.id !== event.pointerId) return
          drag.current = null
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onLostPointerCapture={() => { drag.current = null }}>
        <div><h1 aria-label={title}>{chat.name}<span>{t('roomLabel')}</span></h1>
          <p>{cursor === null ? t(chat.status) : t('replay')}{cursor === null && !connected ? ` · ${t('stale')}` : ''}
            {' · '}<RoomElapsed projection={projection} runId={progressRunId ?? null} running={running && cursor === null} t={t} />
          </p></div>
        <div className={css.actions}>
          <button type="button" onClick={() => { setCamera(null); setCameraMode(cameraMode === 2 ? 0 : cameraMode === 0 ? 1 : 2) }}>
            {t('cameraLabel')} <b>{t(cameraMode === 0 ? 'overview' : cameraMode === 1 ? 'tour' : 'topView')}</b>
          </button>
          <button type="button" aria-pressed={cursor === null} onClick={() => { setCursor(null); setPlaying(false) }}>{t('live')}</button>
          <button type="button" disabled={!projection.timeline.length} aria-pressed={cursor !== null}
            onClick={() => { setCursor(projection.timeline[0]?.seq ?? null); setPlaying(false) }}>{t('replay')}</button>
          <button type="button" data-modal-autofocus onClick={close}>{t('close')}</button>
        </div>
      </header>
      <div className={css.body}>
        <div className={css.visual}>
          <div className={css.sceneStage}>
            <RoomUsage snapshot={activitySnapshot} projection={projection} replay={cursor !== null}
              runId={activeRunId}
              running={running} t={t} />
            <div className={css.sceneCanvas}>
              <Suspense fallback={<p>{t('sceneLoading')}</p>}>
                <RoomScene projection={projection} visitors={visitors} cameraTarget={cameraTarget}
                  cameraMode={cameraMode} managerId={chat.managerId}
                  onSelect={(id) => { setSelected(id); setCameraMode(0); if (cameraTarget !== null) setCamera(id) }} t={t}
                  onClose={close}
                  frameClassName={css.frame} errorClassName={css.sceneError} />
              </Suspense>
              <p className={css.sceneHint}>{t('sceneHint')}</p>
            </div>
          </div>
          <div className={css.viewControls} role="group" aria-label={t('views')}>
            <button type="button" aria-pressed={cameraTarget === null && cameraMode === 0} onClick={() => { setCamera(null); setCameraMode(0) }}>{t('overview')}</button>
            <button type="button" aria-pressed={cameraTarget !== null} disabled={!visiblePeople.length}
              onClick={() => { setCamera(selected ?? visiblePeople[0]?.id ?? null); setCameraMode(0) }}>{t('personView')}</button>
            {cameraTarget !== null && <select aria-label={t('choosePerson')} value={cameraTarget}
              onChange={(event) => { setCamera(visiblePeople.find(person => person.id === event.target.value)?.id ?? null) }}>
              {visiblePeople.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
            </select>}
            <button type="button" onClick={() => { setPeopleOpen(true) }}>{t('people')}</button>
          </div>
          {!!visitors.length && <details className={css.visitors} aria-label={t('visitors')}><summary>{t('visitors')} · {visitors.length}</summary>
            <div>
              <small>{t('visitorHint')}</small>
              {visitors.map(bot => <button type="button" key={bot.id} onClick={() => { setCamera(bot.id); setCameraMode(0) }}>
                <CatAvatar appearance={bot.avatar} size={20} />{bot.name}</button>)}
            </div>
          </details>}
          <section className={css.taskProgress} aria-label={t('progress.title')}>
            <div className={css.progressHeading}><h2>{t('progress.title')}</h2><small>{t('progress.recorded')}</small>
              <span>{t('progress.count', { count: runTasks.length })}</span></div>
            <div className={css.progressLine}>
              <strong title={runInstruction}>{runInstruction ?? t('empty')}</strong>
              <div>{progressCounts.map(item => <span key={item.status} data-state={item.status}>
                {t(`phase.${item.status}`)} <b>{item.count}</b>
              </span>)}</div>
            </div>
          </section>
        </div>
        <aside className={css.records} aria-label={t('tasks')}>
          {cursor === null ? <RoomActivity chatId={chat.id} members={projection.members} selected={selected}
            watch={props.watchRoomActivity} onSnapshot={setActivitySnapshot} t={t} />
            : <p className={css.hint}>{t('activity.replay')}</p>}
          <section className={css.handoffs} aria-label={t('handoffLog')}>
            <div data-room-handoffs className={`${css.recordHeader} ${css.handoffHeader}`}><h2>{t('tasks')}</h2>
              <TaskArchiveAction chat={chat} bots={directory?.bots ?? []} connected={connected} room copyText={props.copyText} t={t} />
              <button type="button" onClick={records.top}>{t('top')}</button>
              <button type="button" onClick={records.bottom}>{t('bottom')}</button>
              {selected !== null && <button type="button" onClick={() => { setSelected(null) }}>{t('all')}</button>}
            </div>
            <div ref={records.ref} onScroll={records.onScroll} className={css.handoffLog} role="log" aria-label={t('handoffLog')} tabIndex={0}>
              <details className={css.handoffHelp}><summary>{t('handoffHelp')}</summary><p>{t('backHint')}</p></details>
              {chat.error !== null && cursor === null && <details className={css.errorNotice}>
                <summary title={chat.error.message}>{chat.error.message}</summary><p>{chat.error.message}</p></details>}
              {!tasks.length && <p>{t('empty')}</p>}
              {tasks.map(task => <details key={task.id} className={css.task}>
                <summary><span>{task.from === null ? t('owner') : <ContextMenu items={memberItems(task.from)}
                  listClassName={css.contextMenu} onSelect={(action) => { if (task.from !== null) memberAction(task.from, action) }}>
                  {trigger => <span {...trigger} tabIndex={0} aria-haspopup="menu" className={css.memberName}>
                    {projection.members.find(member => member.id === task.from)?.name ?? task.from}</span>}</ContextMenu>}
                {' → '}<ContextMenu items={memberItems(task.botId)} listClassName={css.contextMenu}
                  onSelect={(action) => { memberAction(task.botId, action) }}>{trigger => <span {...trigger} tabIndex={0}
                    aria-haspopup="menu" className={css.memberName}>{projection.members.find(member => member.id === task.botId)?.name ?? task.botId}</span>}</ContextMenu></span>
                <small>{t(`phase.${task.status}`)}</small><span className={css.taskBrief} title={task.message}>{task.message}</span></summary>
                <p className={css.message}>{task.message}</p>
                {task.error !== null && <p className={css.error}>{task.error}</p>}
                {task.stages.map(item => <p className={css.stage} key={item.task.eventId}>
                  <time dateTime={new Date(item.time).toISOString()}>{new Date(item.time).toLocaleTimeString()}</time>
                  {' · '}{t(`phase.${item.task.status}`)}{item.task.recovered ? ` · ${t('recovered')}` : ''}</p>)}
                {projection.replies.filter(reply => reply.deliveryId === task.id).map(reply => <div key={reply.id} className={css.reply}>
                  <small>{t('output')} · {reply.sender.name}{reply.seq === 0 ? ` · ${t('unpublished')}` : ''}</small>
                  <p className={css.message}>{reply.text}</p>
                </div>)}
              </details>)}
            </div></section>
        </aside>
      </div>
      <footer className={css.footer}>
        {cursor !== null && <>
          <button type="button" onClick={() => { setPlaying(!playing) }} disabled={at >= projection.timeline.length - 1}>{t(playing ? 'pause' : 'play')}</button>
          <input type="range" aria-label={t('timeline')} min={0} max={Math.max(0, projection.timeline.length - 1)} value={Math.max(0, at)}
            onChange={(event) => { setPlaying(false); setCursor(projection.timeline[Number(event.target.value)]?.seq ?? null) }} />
          <time>{stage === undefined ? '' : new Date(stage.time).toLocaleString()}</time>
          <small>{t('roster')}</small>
        </>}
        {events.hasMore && <><small>{t('partial')}</small><button type="button" disabled={historyState === 'loading' || !connected}
          onClick={() => { void loadHistory() }}>{t(historyState === 'loading' ? 'loading' : 'earlier')}</button></>}
        {historyState === 'failed' && <span role="alert">{t('loadFailed')}</span>}
      </footer>
      {peopleOpen && <Modal open headless title={t('people')} onClose={() => { setPeopleOpen(false) }} className={css.peopleDialog ?? ''}>
        <div className={css.peoplePanel}>
          <header className={css.peopleHeader}>
            <div><p>{chat.name}</p><h2>{t('people')}</h2></div>
            <div className={css.peopleHeaderActions}><span>{t('memberCount', { count: chat.memberIds.length })}</span>
              <button type="button" aria-label={t('closePeople')} onClick={() => { setPeopleOpen(false) }}>{t('people.close')}</button>
            </div>
          </header>
          <div className={css.peopleToolbar}>
            <div className={css.peopleFilters} role="group" aria-label={t('people.filter')}>
              {(['all', 'manager', 'members'] as const).map(filter => <button type="button" key={filter}
                aria-pressed={peopleFilter === filter} onClick={() => { setPeopleFilter(filter) }}>
                {t(`people.${filter}`)} <span>{filter === 'all' ? currentMembers.length
                  : currentMembers.filter(member => (member.id === chat.managerId) === (filter === 'manager')).length}</span>
              </button>)}
            </div>
            <input data-modal-autofocus aria-label={t('searchPeople')} placeholder={t('searchPeople')} value={peopleSearch}
              onChange={(event) => { setPeopleSearch(event.target.value) }} />
          </div>
          <div className={css.peopleList}>
            {peopleSections.filter(section => section.members.length).map(section => <section key={section.key}
              aria-label={t(`people.${section.key}`)} className={css.peopleSection}>
              <h3>{t(`people.${section.key}`)}<span>{section.members.length}</span><small>{chat.name}</small></h3>
              {section.members.map((member) => {
                const phase = peopleProjection.members.find(item => item.id === member.id)?.phase ?? 'syncing'
                const expanded = expandedPerson === member.id
                const executor = chat.executors.find(item => item.botId === member.id)
                const activity = activitySnapshot?.members.find(item => item.botId === member.id
                  && item.sessionId === executor?.sessionId)
                const preset = connected && activitySnapshot?.connected && activity?.state === 'ready' ? activity.permission : undefined
                const permission = preset === 'read-only' ? t('people.readOnly') : preset === 'workspace-write' ? t('people.workspaceWrite')
                  : preset === 'danger-full-access' ? t('people.fullAccess') : preset === 'auto' ? t('people.autoReview')
                    : preset === 'xiaojing-no-approval' ? t('people.noApproval') : preset ?? t('people.unavailable')
                const model = member.model.kind === 'follow-global' ? t('people.followGlobal') : member.model.model
                return <ContextMenu key={member.id} items={memberItems(member.id)} listClassName={css.contextMenu}
                  onSelect={(action) => { memberAction(member.id, action) }}>{trigger => <article {...trigger} tabIndex={0}
                    aria-haspopup="menu" className={css.personInfo}>
                    <div className={css.personRow}>
                      <div className={css.personIdentity}>
                        <span className={css.personAvatar}><CatAvatar appearance={member.avatar} size={26} /></span>
                        <strong>{member.name}</strong>
                        {member.id === chat.managerId && <small className={css.personManager}>{t('manager')}</small>}
                      </div>
                      <div className={css.personDuty}><small>{t('people.role')}</small>
                        <p className={css.personSummary}>{member.role || t('noRole')}</p></div>
                      <div className={css.personConfig}><small>{t('people.model')}</small><span title={model}>{model}</span></div>
                      <div className={css.personConfig}><small>{t('people.permission')}</small><span title={permission}>{permission}</span></div>
                      <span className={css.personState} data-phase={phase}><i />{t(`phase.${phase}`)}</span>
                      <button type="button" aria-expanded={expanded} onClick={() => { setExpandedPerson(expanded ? null : member.id) }}>
                        {t(expanded ? 'people.collapse' : 'people.details')}</button>
                    </div>
                    {expanded && <div className={css.personDetail}>
                      <h4>{t('people.role')}</h4><p>{member.role || t('noRole')}</p>
                      <dl className={css.personSettings}>
                        <div><dt>{t('people.model')}</dt><dd>{model}</dd></div>
                        {member.model.kind === 'override' && <div><dt>{t('people.provider')}</dt><dd>{member.model.provider}</dd></div>}
                        {member.model.kind === 'override' && member.model.reasoningEffort && <div>
                          <dt>{t('people.reasoning')}</dt><dd>{member.model.reasoningEffort}</dd></div>}
                        <div><dt>{t('people.permission')}</dt><dd>{permission}</dd></div>
                        <div><dt>{t('people.workspace')}</dt><dd>{chat.workDir}</dd></div>
                      </dl>
                      <button type="button" onClick={() => { setCamera(member.id); setCameraMode(0); setPeopleOpen(false) }}>
                        {t('people.locate')}</button>
                    </div>}
                  </article>}</ContextMenu>
              })}
            </section>)}
            {matchingMembers.length === 0 && <p className={css.peopleEmpty}>{t(currentMembers.length ? 'people.emptySearch' : 'noMembers')}</p>}
          </div>
        </div>
      </Modal>}
    </div>
  </Modal>
}
