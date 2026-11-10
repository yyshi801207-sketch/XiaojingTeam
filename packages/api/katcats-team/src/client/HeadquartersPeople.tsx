/** Grouped directory over real Bot identities, with group-local execution details. */
import { useState } from 'react'
import { ContextMenu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { BotId, TeamSnapshot } from '../types.ts'
import type { ChatId } from '../chats-types.ts'
import type { projectHeadquarters } from './headquarters-model.ts'
import type { RoomActivitySnapshot } from './room-activity.ts'
import { CatAvatar } from './avatars.tsx'
import css from './group-room.module.css'

/**
 * Show every created Bot under its groups, plus the main and ungrouped identities.
 * @param props - Directory, group projections and currently observed group permissions.
 * @returns Searchable personnel dialog; membership copies do not inflate the unique total.
 */
export function HeadquartersPeople({ directory, data, selected, activity, statuses, connected, close, openBot, copyText, t }: {
  readonly directory: TeamSnapshot | null
  readonly data: ReturnType<typeof projectHeadquarters>
  readonly selected: ChatId | null
  readonly activity: RoomActivitySnapshot
  readonly statuses: SessionStatusSnapshot
  readonly connected: boolean
  readonly close: () => void
  readonly openBot: (id: BotId) => void
  readonly copyText: (text: string) => Promise<void>
  readonly t: TranslateNS<'katcats.room'>
}) {
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const sections = [
    { id: 'main', name: t('hq.main'), group: null, members: data.main ? [data.main] : [] },
    ...data.groups.map(group => ({ id: group.chat.id, name: group.chat.name, group,
      members: (directory?.bots ?? []).filter(bot => group.chat.memberIds.includes(bot.id)) })),
    { id: 'independent', name: t('hq.independent'), group: null, members: data.independent },
  ]
  const matching = sections.filter(section => filter === 'all' || section.id === filter).map(section => ({ ...section,
    members: section.members.filter(bot => `${bot.name} ${section.group?.chat.memberRoles.find(item => item.botId === bot.id)?.role ?? bot.role}`
      .toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) })).filter(section => section.members.length)
  return <Modal open headless title={t('people')} onClose={close} className={css.peopleDialog ?? ''}>
    <div className={css.peoplePanel}>
      <header className={css.peopleHeader}><div><p>{t('hq.title')}</p><h2>{t('people')}</h2></div>
        <div className={css.peopleHeaderActions}><span>{t('hq.peopleCount', { count: directory?.bots.length ?? 0 })}</span>
          <button type="button" aria-label={t('closePeople')} onClick={close}>{t('people.close')}</button></div></header>
      <div className={css.peopleToolbar}>
        <div className={css.peopleFilters} role="group" aria-label={t('hq.select')}>
          <button type="button" aria-pressed={filter === 'all'} onClick={() => { setFilter('all') }}>{t('people.all')}</button>
          {sections.filter(section => section.members.length).map(section => <button type="button" key={section.id}
            aria-pressed={filter === section.id} onClick={() => { setFilter(section.id) }}>
            {section.name}<span>{section.members.length}</span></button>)}
        </div>
        <input data-modal-autofocus aria-label={t('searchPeople')} placeholder={t('searchPeople')} value={search}
          onChange={(event) => { setSearch(event.target.value) }} />
      </div>
      <div className={css.peopleList}>
        {matching.map(section => <section key={section.id} className={css.peopleSection} aria-label={section.name}>
          <h3>{section.name}<span>{section.members.length}</span></h3>
          {section.members.map((bot) => {
            const key = JSON.stringify([section.id, bot.id]), detail = expanded === key
            const member = section.group?.projection.members.find(item => item.id === bot.id)
            const phase = !connected ? 'syncing' : member?.phase ?? (statuses.has(bot.sessionId)
              ? statuses.get(bot.sessionId)?.running ? 'started' : 'idle' : 'syncing')
            const role = member?.role ?? bot.role
            const executor = section.group?.chat.executors.find(item => item.botId === bot.id)
            const observed = connected && activity.connected && section.id === selected
              ? activity.members.find(item => item.botId === bot.id && item.sessionId === executor?.sessionId && item.state === 'ready') : undefined
            const preset = observed?.permission
            const permission = preset === 'read-only' ? t('people.readOnly') : preset === 'workspace-write' ? t('people.workspaceWrite')
              : preset === 'danger-full-access' ? t('people.fullAccess') : preset === 'auto' ? t('people.autoReview')
                : preset === 'xiaojing-no-approval' ? t('people.noApproval') : preset ?? t('people.unavailable')
            const model = bot.model.kind === 'follow-global' ? t('people.followGlobal') : bot.model.model
            return <ContextMenu key={bot.id} listClassName={css.contextMenu}
              items={[{ id: 'details', label: t('member.viewDetails') }, { id: 'copy', label: t('member.copyName') }]}
              onSelect={(action) => {
                if (action === 'details') setExpanded(key)
                else if (action === 'copy') void copyText(bot.name)
              }}>{trigger => <article {...trigger} tabIndex={0} aria-haspopup="menu" className={css.personInfo}>
                <div className={css.personRow}>
                  <div className={css.personIdentity}>
                    <span className={css.personAvatar}><CatAvatar appearance={bot.avatar} size={26} /></span>
                    <strong>{bot.name}</strong>{bot.id === section.group?.chat.managerId
                    && <small className={css.personManager}>{t('people.manager')}</small>}</div>
                  <div className={css.personDuty}><small>{t('people.role')}</small><p className={css.personSummary}>{role || t('noRole')}</p></div>
                  <div className={css.personConfig}><small>{t('people.model')}</small><span title={model}>{model}</span></div>
                  <div className={css.personConfig}><small>{t('hq.permission')}</small><span title={permission}>{permission}</span></div>
                  <span className={css.personState} data-phase={phase}><i />{t(`phase.${phase}`)}</span>
                  <button type="button" aria-expanded={detail} onClick={() => { setExpanded(detail ? null : key) }}>{t(detail ? 'people.collapse' : 'people.details')}</button>
                </div>
                {detail && <div className={css.personDetail}><h4>{t('people.role')}</h4><p>{role || t('noRole')}</p>
                  <dl className={css.personSettings}>
                    <div><dt>{t('people.model')}</dt><dd>{model}</dd></div>
                    {bot.model.kind === 'override' && <div><dt>{t('people.provider')}</dt><dd>{bot.model.provider}</dd></div>}
                    <div><dt>{t('hq.workspace')}</dt><dd>{section.group?.chat.workDir ?? bot.workDir}</dd></div>
                    <div><dt>{t('hq.permission')}</dt><dd>{permission}</dd></div>
                  </dl><button type="button" onClick={() => { openBot(bot.id) }}>{t('hq.openBot')}</button></div>}
              </article>}</ContextMenu>
          })}
        </section>)}
        {!matching.length && <p className={css.peopleEmpty}>{t('people.emptySearch')}</p>}
      </div>
    </div>
  </Modal>
}
