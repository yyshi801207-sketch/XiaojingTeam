/** Read-only business records from the current group's persisted directory snapshot. */
import { useState, type ReactElement } from 'react'
import { ContextMenu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamChat } from '../chats-types.ts'
import type { TeamBot } from '../types.ts'
import type { TaskArchiveTranslate } from './task-archive-locales.ts'
import css from './task-archive.module.css'

interface TaskArchiveProps {
  readonly chat: TeamChat
  readonly bots: readonly TeamBot[]
  readonly connected: boolean
  readonly room?: boolean
  readonly copyText: (text: string) => Promise<void>
  readonly t: TaskArchiveTranslate
}

/**
 * Open group-local persisted work without mutating settings or dispatching a model request.
 * @param props - Live group snapshot, member identities, connection state and localized copy.
 * @returns An archive action whose open dialog continues to receive saved record updates.
 */
export function TaskArchiveAction(props: TaskArchiveProps): ReactElement {
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" className={props.room ? undefined : css.launch}
      onClick={() => { setOpen(true) }}>{props.t('archive.open')}</button>
    {open && <TaskArchive key={props.chat.id} {...props} close={() => { setOpen(false) }} />}
  </>
}

function TaskArchive({ chat, bots, connected, room, copyText, t, close }: TaskArchiveProps & { readonly close: () => void }) {
  const [query, setQuery] = useState('')
  const [blockedOnly, setBlockedOnly] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const tasks = chat.tickets ?? []
  const owner = (id: string) => bots.find(bot => bot.id === id)?.name ?? `${t('archive.formerOwner')} · ${id}`
  const needle = query.trim().toLocaleLowerCase()
  const visible = [...tasks].reverse().filter(task => (!blockedOnly || task.state === 'blocked')
    && `${task.goal}\n${task.id}\n${owner(task.ownerId)}`.toLocaleLowerCase().includes(needle))
  const selected = visible.find(task => task.id === selectedId) ?? visible[0]
  const blocked = tasks.filter(task => task.state === 'blocked').length
  return <Modal open headless title={t('archive.open')} onClose={close}
    className={[css.dialog, room && css.room].filter(Boolean).join(' ')}>
    <div className={css.content}>
      <header className={css.header}>
        <div><span className={css.eyebrow}>{t('archive.eyebrow')}</span>
          <h2>{chat.name}<span> / {t('archive.open')}</span></h2></div>
        <span className={css.sync} data-connected={connected}>{t(connected ? 'archive.synced' : 'archive.stale')}</span>
        <button type="button" className={css.close} onClick={close} aria-label={t('archive.close')}>×</button>
      </header>
      <div className={css.body}>
        <section className={css.sidebar} aria-label={t('archive.list')}>
          <div className={css.overview}>
            <div data-metric="total"><strong>{tasks.length}</strong><span>{t('archive.total')}</span></div>
            <div data-metric="unblocked"><strong>{tasks.length - blocked}</strong><span>{t('archive.unblocked')}</span></div>
            <div data-blocked={blocked > 0}><strong>{blocked}</strong><span>{t('archive.blocked')}</span></div>
          </div>
          <input data-modal-autofocus className={css.search} type="search" value={query} placeholder={t('archive.search')} aria-label={t('archive.search')}
            onChange={(event) => { setQuery(event.target.value) }} />
          <div className={css.filters}>
            <button type="button" aria-pressed={!blockedOnly} onClick={() => { setBlockedOnly(false) }}>{t('archive.all')}</button>
            <button type="button" aria-pressed={blockedOnly} onClick={() => { setBlockedOnly(true) }}>{t('archive.blocked')}</button>
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
                  <small data-state={task.state}>{t(task.state === 'blocked' ? 'archive.blockedState' : 'archive.openState')}</small></span>
                <span className={css.goal}>{task.goal}</span>
                <span className={css.itemStage}>{task.stage}<span>{t('archive.revision')} <b>{task.revision}</b></span></span>
              </button>}</ContextMenu>)}
            {tasks.length > 0 && visible.length === 0 && <p className={css.empty}>{t('archive.noMatch')}</p>}
          </div>
        </section>
        {selected ? <article className={css.detail} aria-label={selected.goal} key={selected.id}>
          <div className={css.detailMeta}><span data-state={selected.state}>{t(selected.state === 'blocked' ? 'archive.blockedState' : 'archive.openState')}</span>
            <span>{t('archive.revision')} <b>{selected.revision}</b></span></div>
          <div className={css.goalHeading}><h4>{t('archive.goal')}</h4><h3>{selected.goal}</h3></div>
          <dl className={css.facts}><div><dt>{t('archive.owner')}</dt><dd>{owner(selected.ownerId)}</dd></div>
            <div><dt>{t('archive.stage')}</dt><dd>{selected.stage}</dd></div></dl>
          <section className={css.next}><h4>{t('archive.next')}</h4><p>{selected.nextStep}</p></section>
          {selected.blocker !== null && <section className={css.blocker}><h4>{t('archive.blocker')}</h4><p>{selected.blocker}</p></section>}
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
