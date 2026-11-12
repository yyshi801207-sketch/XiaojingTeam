/** Group business records and owner actions from the persisted directory snapshot. */
import { useRef, useState, type ReactElement } from 'react'
import { ContextMenu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { ChatActivity, ContinueGroupTaskRequest, GroupTicket, GroupTicketId, TeamChat } from '../chats-types.ts'
import type { TeamBot } from '../types.ts'
import type { ChatClientModel } from './chat-model.ts'
import type { TaskArchiveTranslate } from './task-archive-locales.ts'
import css from './task-archive.module.css'

/** Revision-fenced operations exposed to all views of the same archive. */
export type TaskArchiveActions = Pick<ChatClientModel, 'continueTask' | 'completeTask'>

interface TaskArchiveProps {
  readonly chat: TeamChat
  readonly bots: readonly TeamBot[]
  readonly connected: boolean
  readonly activity?: ChatActivity | undefined
  readonly actions?: TaskArchiveActions
  readonly room?: boolean
  readonly copyText: (text: string) => Promise<void>
  readonly t: TaskArchiveTranslate
}

const stateLabels = {
  open: 'archive.openState', blocked: 'archive.blockedState',
  delivered: 'archive.deliveredState', completed: 'archive.completedState',
} as const satisfies Record<GroupTicket['state'], Parameters<TaskArchiveTranslate>[0]>

function stateLabel(task: GroupTicket): Parameters<TaskArchiveTranslate>[0] {
  if (task.state === 'completed' && task.completionKind !== undefined) {
    return task.completionKind === 'criteria' ? 'archive.criteriaCompleted' : 'archive.ownerCompleted'
  }
  return stateLabels[task.state]
}

const continuationHints = {
  resume: 'archive.resumeHint', start: 'archive.startHint', busy: 'archive.busyHint',
  unknown: 'archive.unknownHint', scope: 'archive.scopeHint', 'owner-missing': 'archive.ownerMissingHint',
} as const satisfies Record<NonNullable<ChatActivity['taskContinuation']>[string], Parameters<TaskArchiveTranslate>[0]>

const filters = { all: 'archive.all', blocked: 'archive.blocked', delivered: 'archive.deliveredState',
  completed: 'archive.completedState' } as const

/**
 * Open group-local persisted work and provide explicit continuation and acceptance.
 * @param props - Live group snapshot, member identities, connection state, owner actions and localized copy.
 * @returns An archive action whose open dialog continues to receive saved record updates.
 */
export function TaskArchiveAction(props: TaskArchiveProps): ReactElement {
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" className={props.room ? undefined : css.launch}
      onClick={() => { setOpen(true) }}>{props.t('archive.details')}</button>
    {open && <TaskArchive key={props.chat.id} {...props} close={() => { setOpen(false) }} />}
  </>
}

function TaskArchive({ chat, bots, connected, activity, actions, room, copyText, t, close }:
  TaskArchiveProps & { readonly close: () => void }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<keyof typeof filters>('all')
  const [selectedId, setSelectedId] = useState<GroupTicketId | null>(null)
  const [feedback, setFeedback] = useState<{ taskId: GroupTicketId; status: 'pending' | 'continued' | 'accepted' | 'failed' } | null>(null)
  const submitting = useRef(false)
  const tasks = chat.tickets ?? []
  const owner = (id: string) => bots.find(bot => bot.id === id)?.name ?? `${t('archive.formerOwner')} · ${id}`
  const current = tasks.find(task => task.id === activity?.currentTaskId)
  const needle = query.trim().toLocaleLowerCase()
  const visible = [...tasks].reverse().filter(task => (filter === 'all' || task.state === filter)
    && `${task.goal}\n${task.id}\n${owner(task.ownerId)}`.toLocaleLowerCase().includes(needle))
  const selected = visible.find(task => task.id === (selectedId ?? current?.id)) ?? visible[0]
  const delivered = tasks.filter(task => task.state === 'delivered').length
  const completed = tasks.filter(task => task.state === 'completed').length
  const continuation = connected && selected !== undefined ? activity?.taskContinuation?.[selected.id] : undefined
  const accept = selected?.state === 'delivered'
  const canContinue = continuation === 'start' || continuation === 'resume'
  const actionLabel = accept ? 'archive.accept' : continuation === 'resume' ? 'archive.resume' : 'archive.start'
  const actionHint = accept ? 'archive.acceptHint' : continuation === undefined ? undefined : continuationHints[continuation]
  const completedAt = selected?.completedAt === undefined ? undefined : new Date(selected.completedAt)
  const actOnTask = async () => {
    if (!connected || actions === undefined || selected === undefined || submitting.current || (!accept && !canContinue)) return
    submitting.current = true
    setFeedback({ taskId: selected.id, status: 'pending' })
    try {
      if (accept) await actions.completeTask(chat.id, selected.id, selected.revision)
      else await actions.continueTask({
        chatId: chat.id, taskId: selected.id, expectedRevision: selected.revision,
        expectedRunId: chat.run?.id ?? null, expectedGeneration: chat.generation,
        requestId: randomUUID() as ContinueGroupTaskRequest['requestId'],
      })
      setFeedback({ taskId: selected.id, status: accept ? 'accepted' : 'continued' })
    } catch (_error) {
      setFeedback({ taskId: selected.id, status: 'failed' })
    } finally {
      submitting.current = false
    }
  }
  return <Modal open headless title={t('archive.open')} onClose={close}
    className={[css.dialog, room && css.room].filter(Boolean).join(' ')}>
    <div className={css.content}>
      <header className={css.header}>
        <div><span className={css.eyebrow}>{t('archive.eyebrow')}</span>
          <h2>{chat.name}<span> / {t('archive.open')}</span></h2></div>
        <span className={css.sync} data-connected={connected}>{t(connected ? 'archive.synced' : 'archive.stale')}</span>
        <button type="button" className={css.close} onClick={close} aria-label={t('archive.close')}>×</button>
      </header>
      {tasks.length > 0 && <section className={css.current} aria-label={t(connected ? 'archive.current' : 'archive.lastCurrent')}>
        <span>{t(connected ? 'archive.current' : 'archive.lastCurrent')}</span>
        {current === undefined ? <small>{t('archive.noCurrent')}</small>
          : <button type="button" onClick={() => { setQuery(''); setFilter('all'); setSelectedId(current.id) }}>{current.goal}</button>}
      </section>}
      <div className={css.body}>
        <section className={css.sidebar} aria-label={t('archive.list')}>
          <div className={css.overview}>
            <div data-metric="total"><strong>{tasks.length}</strong><span>{t('archive.total')}</span></div>
            <div data-metric="delivered"><strong>{delivered}</strong><span>{t('archive.deliveredState')}</span></div>
            <div data-metric="completed"><strong>{completed}</strong><span>{t('archive.completedState')}</span></div>
          </div>
          <input data-modal-autofocus className={css.search} type="search" value={query} placeholder={t('archive.search')} aria-label={t('archive.search')}
            onChange={(event) => { setQuery(event.target.value) }} />
          <div className={css.filters}>
            <button type="button" aria-pressed={filter === 'all'} onClick={() => { setFilter('all') }}>{t(filters.all)}</button>
            <button type="button" aria-pressed={filter === 'blocked'} onClick={() => { setFilter('blocked') }}>{t(filters.blocked)}</button>
            <button type="button" aria-pressed={filter === 'delivered'} onClick={() => { setFilter('delivered') }}>{t(filters.delivered)}</button>
            <button type="button" aria-pressed={filter === 'completed'} onClick={() => { setFilter('completed') }}>{t(filters.completed)}</button>
          </div>
          <div className={css.list}>
            {visible.map(task => <ContextMenu key={task.id} listClassName={room ? css.roomMenu : css.menu}
              items={[{ id: 'details', label: t('archive.viewDetails') },
                { type: 'separator', id: 'copy' }, { id: 'goal', label: t('archive.copyGoal') },
                { id: 'id', label: t('archive.copyId') }]}
              onSelect={(action) => {
                if (action === 'details') setSelectedId(task.id)
                else if (action === 'goal') void copyText(task.goal)
                else if (action === 'id') void copyText(task.id)
              }}>{trigger => <button {...trigger} type="button" className={css.item} aria-pressed={selected?.id === task.id}
                onClick={() => { setSelectedId(task.id) }}>
                <span className={css.itemMeta}><span>{owner(task.ownerId)}</span>
                  <small data-state={task.state}>{t(stateLabel(task))}</small></span>
                <span className={css.goal}>{task.goal}</span>
                <span className={css.itemStage}>{task.stage}<span>{t('archive.revision')} <b>{task.revision}</b></span></span>
              </button>}</ContextMenu>)}
            {tasks.length > 0 && visible.length === 0 && <p className={css.empty}>{t('archive.noMatch')}</p>}
          </div>
        </section>
        {selected ? <article className={css.detail} aria-label={selected.goal} key={selected.id}>
          <div className={css.detailMeta}><span data-state={selected.state}>{t(stateLabel(selected))}</span>
            <span>{t('archive.revision')} <b>{selected.revision}</b></span></div>
          <div className={css.goalHeading}><h4>{t('archive.goal')}</h4><h3>{selected.goal}</h3></div>
          <dl className={css.facts}><div><dt>{t('archive.owner')}</dt><dd>{owner(selected.ownerId)}</dd></div>
            <div><dt>{t('archive.stage')}</dt><dd>{selected.stage}</dd></div>
            {selected.financeLabel !== undefined && <div><dt>{t('archive.ledger')}</dt><dd>{selected.financeLabel}</dd></div>}
            {completedAt !== undefined && <div><dt>{t(selected.completionKind === 'criteria' ? 'archive.criteriaCompletedAt' : 'archive.completedAt')}</dt>
              <dd><time dateTime={completedAt.toISOString()}>{completedAt.toLocaleString(t('archive.dateLocale'))}</time></dd></div>}
          </dl>
          {(selected.state === 'open' || selected.state === 'blocked') &&
            <section className={css.next}><h4>{t('archive.next')}</h4><p>{selected.nextStep}</p></section>}
          {selected.blocker !== null && <section className={css.blocker}><h4>{t('archive.blocker')}</h4><p>{selected.blocker}</p></section>}
          {(actionHint !== undefined || feedback?.taskId === selected.id) && <div className={css.action} aria-busy={feedback?.status === 'pending'}>
            <div>
              {actionHint !== undefined && <p>{t(actionHint)}</p>}
              {feedback?.taskId === selected.id && <p role="status" data-action-status={feedback.status}>{
                t(feedback.status === 'failed' ? 'archive.actionFailed' : `archive.${feedback.status}`)
              }</p>}
            </div>
            {actions !== undefined && (accept || canContinue) && <button type="button" disabled={!connected || feedback?.status === 'pending'}
              onClick={() => { void actOnTask() }}>{t(actionLabel)}</button>}
          </div>}
          <div className={css.supportGrid}>
            <section><h4>{t('archive.criteria')}<span className={css.sectionCount}>{selected.acceptance.length}</span></h4>{selected.acceptance.length > 0
              ? <ol className={css.criteria}>{selected.acceptance.map((item, index) => <li key={index}>{item}</li>)}</ol>
              : <p className={css.muted}>{t('archive.noCriteria')}</p>}</section>
            <section><h4>{t('archive.artifacts')}<span className={css.sectionCount}>{selected.artifacts.length}</span></h4>{selected.artifacts.length > 0
              ? <ul className={css.artifacts}>{selected.artifacts.map((item, index) => <li key={index}>{item}</li>)}</ul>
              : <p className={css.muted}>{t('archive.noArtifacts')}</p>}</section>
          </div>
          <details className={css.trace}><summary>{t('archive.messages')} · {selected.messageIds.length}</summary>
            <p>{t('archive.id')}<code>{selected.id}</code></p>
            {selected.delivery !== undefined && <p>{t('archive.deliveryMessage')}<code>{selected.delivery.relayMessageId}</code></p>}
            {selected.messageIds.map(id => <code key={id}>{id}</code>)}
          </details>
        </article> : <div className={css.emptyDetail}><span className={css.emptyMark}>○</span>
          <h3>{t(tasks.length ? 'archive.noMatch' : 'archive.empty')}</h3>
          {!tasks.length && <p>{t('archive.emptyHint')}</p>}</div>}
      </div>
      <footer className={css.footer}>{t('archive.scope')}</footer>
    </div>
  </Modal>
}
