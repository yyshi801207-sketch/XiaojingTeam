/** Explicit group creation and settings, retaining only edited fields as drafts. */
import { useId, useRef, useState, type ReactNode } from 'react'
import {
  Button, Checkbox, IconArchiveOutlineRegular, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular,
  IconChevronUpOutlineRegular, IconClockOutlineRegular,
  IconFolderOpenOutlineRegular, IconInfoOutlineRegular, IconListPenOutlineRegular, IconPlusOutlineRegular,
  IconShieldOutlineRegular, IconSlidersTwoOutlineRegular, IconUsersOutlineRegular, Input, Menu, Modal, Switch, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { isOdooAdminBot, type BotId, type TeamBot } from '../types.ts'
import type { ChatActivity, ChatId, CreateChatRequest, TeamChat, UpdateChatRequest } from '../chats-types.ts'
import type { TeamView } from './model.ts'
import type { ChatView } from './chat-model.ts'
import { GroupMemberAvatar } from './GroupMemberAvatar.tsx'
import { BotIdentityAvatar } from './BotIdentityAvatar.tsx'
import { ChatAvatar } from './ChatAvatar.tsx'
import { TaskArchiveAction, type TaskArchiveActions } from './TaskArchive.tsx'
import { Choice } from './Choice.tsx'
import { FinanceBinding, type FinanceBindingActions } from './FinanceBinding.tsx'
import { GroupPermissionSettings } from './PermissionSettings.tsx'
import { ResponsibilityField } from './ResponsibilityField.tsx'
import type { PermissionSessionRetainer } from './PermissionSettings.tsx'
import type { GroupPermissionBatch, GroupPermissionBatchView } from './group-permission-batch.ts'
import css from './team.module.css'
import settingsCss from './settings.module.css'

function eligibleGroupBot(bot: TeamBot): boolean {
  return bot.kind === 'ordinary' && !isOdooAdminBot(bot.id)
}

function Members({ bots, selected, setSelected, disabled, managerId = null, settings = false, t }: {
  readonly bots: readonly TeamBot[]
  readonly selected: readonly BotId[]
  readonly setSelected: (ids: readonly BotId[]) => void
  readonly disabled: boolean
  readonly managerId?: BotId | null
  readonly settings?: boolean
  readonly t: TranslateNS<'katcats.team'>
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const available = settings ? bots.filter(bot => eligibleGroupBot(bot) && !selected.includes(bot.id)) : []
  const addLabel = t('chat.addMember')
  const rows = bots.filter(bot => selected.includes(bot.id) || (!settings && eligibleGroupBot(bot)))
  return <fieldset className={css.chatMembers}>
    <legend>{settings ? <span className={settingsCss.memberLegend}>
      {t('chat.members')} · {selected.length}
      <Menu open={menuOpen && !disabled && available.length > 0} autoFocus portal compact align="start"
        items={available.map(bot => ({ id: bot.id, label: bot.name,
          icon: <GroupMemberAvatar appearance={bot.avatar} botId={bot.id} managerId={null}
            managerLabel={t('chat.managerBadge')} size={16} /> }))}
        onSelect={(id) => {
          const bot = available.find(item => item.id === id)
          if (!disabled && bot !== undefined) setSelected([...selected, bot.id])
          setMenuOpen(false)
        }} onClose={() => { setMenuOpen(false) }}
        anchor={<Tooltip label={addLabel} side="top" portal>
          <Button size="sm" variant="ghost" className={settingsCss.memberAdd} aria-label={addLabel}
            aria-haspopup="menu" aria-expanded={menuOpen && !disabled && available.length > 0}
            disabled={disabled || available.length === 0} icon={<IconPlusOutlineRegular size={14} aria-hidden="true" />}
            onClick={() => { setMenuOpen(open => !open) }} />
        </Tooltip>} />
    </span> : t('chat.members')}</legend>
    {(!settings || selected.length === 0) && <p className={css.hint}>{t('chat.memberHint')}</p>}
    {rows.map(bot => <div key={bot.id} className={css.chatMember}>
      {bot.kind === 'main' ? <BotIdentityAvatar bot={bot} size={24} />
        : <GroupMemberAvatar appearance={bot.avatar} botId={bot.id} managerId={managerId} size={24}
          managerLabel={t('chat.managerBadge')} />}
      <Checkbox label={bot.kind === 'main' ? t('chat.mainMember', { name: bot.name }) : bot.name}
        checked={selected.includes(bot.id)} disabled={disabled}
        onChange={(checked) => {
          const next = checked ? [...selected, bot.id] : selected.filter(id => id !== bot.id)
          setSelected(next)
        }} />
    </div>)}
    {!bots.some(eligibleGroupBot) && <p className={css.hint}>{t('chat.noMembers')}</p>}
  </fieldset>
}

function Manager({ id, bots, members, value, onChange, disabled, t }: {
  readonly id: string
  readonly bots: readonly TeamBot[]
  readonly members: readonly BotId[]
  readonly value: BotId | null
  readonly onChange: (id: BotId | null) => void
  readonly disabled: boolean
  readonly t: TranslateNS<'katcats.team'>
}) {
  const eligible = bots.filter(bot => eligibleGroupBot(bot) && members.includes(bot.id))
  const legacy = bots.find(bot => bot.kind === 'main' && bot.id === value)
  return <><label className={css.label} htmlFor={id}>{t('chat.manager')}</label>
    <div className={`${settingsCss.selectedControl} ${settingsCss.managerControl}`} data-selected={value !== null}>
      <Choice id={id} label={t('chat.manager')} value={value ?? 'none'} disabled={disabled}
        options={[{ value: 'none', label: t('chat.noManager') },
          ...legacy === undefined ? [] : [{ value: legacy.id, label: legacy.name, disabled: true }],
          ...eligible.map(bot => ({ value: bot.id, label: bot.name }))]}
        onChange={(next) => { if (next === 'none') onChange(null); else {
          const bot = eligible.find(item => item.id === next)
          if (bot !== undefined) onChange(bot.id)
        } }} />
    </div>
    <p className={css.hint}>{t('chat.managerHint')}</p></>
}

/** Explicit group form commands; closing never creates a conversation. */
export interface CreateChatProps {
  readonly bots: readonly TeamBot[]
  readonly defaultRelayLimit: number
  readonly create: (request: CreateChatRequest) => Promise<void>
  readonly close: () => void
  readonly t: TranslateNS<'katcats.team'>
}

/**
 * Create an independent group with explicitly selected members and an optional manager.
 * @param props - Available members, configured limit and explicit commands.
 * @returns A focus-managed group creation dialog with scrollable fields and persistent actions.
 */
export function CreateChat({ bots, defaultRelayLimit, create, close, t }: CreateChatProps) {
  const [name, setName] = useState('')
  const [members, setMembers] = useState<readonly BotId[]>([])
  const [managerId, setManagerId] = useState<BotId | null>(null)
  const [relayLimit, setRelayLimit] = useState(defaultRelayLimit)
  const [busy, setBusy] = useState(false)
  const id = useId()
  const valid = name.trim() !== '' && Number.isSafeInteger(relayLimit) && relayLimit > 0
    && bots.some(bot => eligibleGroupBot(bot) && members.includes(bot.id))
  const dismiss = () => { if (!busy) close() }
  return <Modal open title={t('chat.new')} closeLabel={t('team.close')} onClose={dismiss}
    className={[css.modal, css.createChatModal].join(' ')} contentClassName={css.createChatContent ?? ''}
    footer={<><Button onClick={dismiss} disabled={busy}>{t('team.cancel')}</Button>
      <Button type="submit" form={`${id}-form`} variant="primary" disabled={busy || !valid}>{t('team.create')}</Button></>}>
    <form id={`${id}-form`} className={css.createForm} aria-busy={busy} onSubmit={(event) => {
      event.preventDefault()
      if (busy || !valid) return
      setBusy(true)
      void create({ name: name.trim(), memberIds: members, managerId, relayLimit }).finally(() => { setBusy(false) })
    }}>
      <label className={css.label} htmlFor={`${id}-name`}>{t('chat.name')}</label>
      <Input id={`${id}-name`} data-modal-autofocus value={name} maxLength={40} disabled={busy}
        placeholder={t('chat.namePlaceholder')} onChange={(event) => { setName(event.target.value) }} />
      <Members bots={bots.filter(eligibleGroupBot)} selected={members} setSelected={(next) => {
        setMembers(next)
        if (managerId !== null && !next.includes(managerId)) setManagerId(null)
      }} disabled={busy} t={t} />
      <Manager id={`${id}-manager`} bots={bots} members={members} value={managerId} onChange={setManagerId} disabled={busy} t={t} />
      <label className={css.label} htmlFor={`${id}-limit`}>{t('chat.relayLimit')}</label>
      <Input id={`${id}-limit`} type="number" min={1} step={1} value={Number.isNaN(relayLimit) ? '' : relayLimit} disabled={busy}
        onChange={(event) => { setRelayLimit(event.target.valueAsNumber) }} />
      <p className={css.hint}>{t('chat.relayHint')}</p>
    </form>
  </Modal>
}

/** Group settings read only their scoped root Session and current directory. */
export interface ChatSettingsInjected {
  readonly copyText: (text: string) => Promise<void>
  readonly archiveActions: TaskArchiveActions
  readonly finance?: FinanceBindingActions<ChatId>
  readonly hooks: {
    readonly directory: ObservableSnapshot<TeamView>
    readonly chats: ObservableSnapshot<ChatView>
    readonly connection: ObservableSnapshot<ConnectionState | undefined>
    readonly permissionBatch: ObservableSnapshot<GroupPermissionBatchView>
  }
  readonly activatePermissionBatch: GroupPermissionBatch['activate']
  readonly applyPermissionBatch: GroupPermissionBatch['apply']
  readonly cancelPermissionBatch: GroupPermissionBatch['cancel']
  readonly retainPermissionSession: PermissionSessionRetainer
  readonly save: (request: UpdateChatRequest) => Promise<void>
  readonly openMemory: () => void
  readonly openSchedules: (sessionId: TeamChat['rootSessionId']) => void
}

/** Public per-Session right-sidebar scope and product-only data. */
export type ChatSettingsProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'katcats.team'>
  & PropsRenderSlots<'katcats.settings.permission'> & PropsRenderFactories & InjectFace<ChatSettingsInjected>

/**
 * Resolve group settings from this tab's Session, never a global selected-chat field.
 * @param props - Scoped root Session and Host-backed directory hooks.
 * @returns The current group form or its unavailable state.
 */
export function ChatSettings({ sessionId, useDirectory, useChats, useConnection, usePermissionBatch, useTabInfo,
  activatePermissionBatch, applyPermissionBatch, cancelPermissionBatch,
  retainPermissionSession, renderFactorySlot, renderSlot, SessionProvider,
  save, openMemory, openSchedules, copyText, archiveActions, finance, t }: ChatSettingsProps) {
  const directory = useDirectory(value => value)
  const groups = useChats(value => value)
  const connected = useConnection(value => value === 'connected')
  const visible = useTabInfo().tab.visible
  const batch = usePermissionBatch(value => value)
  const bots = directory.snapshot?.bots ?? []
  const chat = groups.snapshot?.chats.find(item => item.rootSessionId === sessionId)
  if (chat === undefined) return <p className={css.empty}>{t('chat.missing')}</p>
  return <SettingsForm key={chat.id} chat={chat} bots={bots} save={save} openMemory={openMemory} openSchedules={openSchedules}
    archiveConnected={connected && groups.phase === 'ready'} copyText={copyText} archiveActions={archiveActions}
    archiveActivity={groups.snapshot?.activities.find(item => item.chatId === chat.id)}
    finance={finance} financeActive={visible && connected && groups.phase === 'ready'}
    permissionsEnabled={directory.phase === 'ready' && groups.phase === 'ready' && connected && visible}
    batch={batch} activatePermissionBatch={activatePermissionBatch} applyPermissionBatch={applyPermissionBatch}
    cancelPermissionBatch={cancelPermissionBatch} retainPermissionSession={retainPermissionSession}
    renderFactorySlot={renderFactorySlot} renderSlot={renderSlot} SessionProvider={SessionProvider} t={t} />
}

function SettingsSection({ title, icon, count, counts, open, onOpenChange, className, children }: {
  readonly title: string
  readonly icon: ReactNode
  readonly count?: number
  readonly counts?: readonly { readonly label: string; readonly count: number; readonly tone: 'total' | 'completed' | 'delivered' | 'blocked' }[]
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly className?: string | undefined
  readonly children: ReactNode
}) {
  return <details className={[settingsCss.fold, className].filter(Boolean).join(' ')} open={open}>
    <summary className={settingsCss.foldSummary} onClick={event => { event.preventDefault(); onOpenChange(!open) }}>
      <span className={settingsCss.foldIcon} aria-hidden="true">{icon}</span>
      <span className={settingsCss.foldTitle}>{title}</span>
      {count !== undefined && <span className={settingsCss.foldCount}>{count}</span>}
      {counts !== undefined && <span className={settingsCss.archiveCounts}>
        {counts.map(item => <Tooltip key={item.tone} label={`${item.label} · ${item.count}`} portal>
          <span className={settingsCss.foldCount} data-task-count={item.tone}
            aria-label={`${item.label} · ${item.count}`}>{item.count}</span>
        </Tooltip>)}
      </span>}
      <IconChevronRightOutlineRegular size={14} className={settingsCss.foldChevron} />
    </summary>
    <div className={settingsCss.foldBody}>{children}</div>
  </details>
}

function SettingsForm({ chat, bots, archiveConnected, archiveActivity, archiveActions, permissionsEnabled,
  retainPermissionSession, renderFactorySlot, renderSlot, SessionProvider,
  batch, activatePermissionBatch, applyPermissionBatch, cancelPermissionBatch,
  save, openMemory, openSchedules, copyText, finance, financeActive, t }: PropsRenderSlots<'katcats.settings.permission'> & PropsRenderFactories & {
    readonly chat: TeamChat
    readonly bots: readonly TeamBot[]
    readonly archiveConnected: boolean
    readonly archiveActivity: ChatActivity | undefined
    readonly archiveActions: TaskArchiveActions
    readonly finance: FinanceBindingActions<ChatId> | undefined
    readonly financeActive: boolean
    readonly permissionsEnabled: boolean
    readonly retainPermissionSession: PermissionSessionRetainer
    readonly batch: GroupPermissionBatchView
    readonly activatePermissionBatch: GroupPermissionBatch['activate']
    readonly applyPermissionBatch: GroupPermissionBatch['apply']
    readonly cancelPermissionBatch: GroupPermissionBatch['cancel']
    readonly save: (request: UpdateChatRequest) => Promise<void>
    readonly openMemory: () => void
    readonly openSchedules: ChatSettingsInjected['openSchedules']
    readonly copyText: ChatSettingsInjected['copyText']
    readonly t: TranslateNS<'katcats.team'>
  }) {
  const [draft, setDraft] = useState<Omit<UpdateChatRequest, 'id'> | null>(null)
  const [saving, setBusy] = useState(false)
  const [expanded, setExpanded] = useState({ finance: false, archive: false, people: false,
    roles: false, collaboration: false, permissions: false, resources: false })
  const disclosure = (section: keyof typeof expanded) => ({ open: expanded[section],
    onOpenChange: (open: boolean) => { setExpanded(current => ({ ...current, [section]: open })) } })
  const expandAll = (open: boolean) => { setExpanded({ finance: open, archive: open, people: open,
    roles: open, collaboration: open, permissions: open, resources: open }) }
  const hasOpenSections = Object.entries(expanded).some(([section, open]) => open && (section !== 'finance' || finance !== undefined))
  const savingGate = useRef(false)
  const busy = saving || batch.busy
  const id = useId()
  const value = { ...chat, ...draft }
  const tickets = chat.tickets ?? []
  const valid = value.name.trim() !== '' && Number.isSafeInteger(value.relayLimit) && value.relayLimit > 0
    && bots.some(bot => eligibleGroupBot(bot) && value.memberIds.includes(bot.id))
  const patch = (next: NonNullable<typeof draft>) => { setDraft(current => ({ ...current, ...next })) }
  const dirty = draft !== null
  const saveSettings = async (request: UpdateChatRequest): Promise<void> => {
    if (savingGate.current || busy) throw new Error('Group settings are already being saved.')
    savingGate.current = true
    setBusy(true)
    try { await save(request) }
    finally { savingGate.current = false; setBusy(false) }
  }
  return <form className={[css.settings, settingsCss.scroll, settingsCss.groupScroll].join(' ')} aria-busy={busy} onSubmit={(event) => {
    event.preventDefault()
    if (savingGate.current || busy || !dirty || !valid) return
    void saveSettings({ id: chat.id, ...draft, ...draft?.name === undefined ? {} : { name: draft.name.trim() },
    }).then(
      () => { setDraft(null) },
      () => { /* The frame reports the failure; explicit edits remain available. */ },
    )
  }}>
    <div className={[css.settingsIdentity, settingsCss.identity, settingsCss.groupHeader].join(' ')}>
      <ChatAvatar large appearances={bots.filter(bot => value.memberIds.includes(bot.id)).map(bot => bot.avatar)} />
      <h2>{chat.name}</h2>
      <div className={settingsCss.groupActions}>
        <Tooltip label={t('team.automations')}><button type="button" className={settingsCss.groupAction}
          aria-label={t('team.automations')} onClick={() => { openSchedules(chat.rootSessionId) }}>
          <IconClockOutlineRegular size={14} />
        </button></Tooltip>
      </div>
    </div>
    <section className={settingsCss.fold} aria-labelledby={`${id}-basics`}>
      <div className={[settingsCss.foldSummary, settingsCss.basicsHeading].join(' ')}>
        <span className={settingsCss.foldIcon} aria-hidden="true"><IconInfoOutlineRegular size={16} /></span>
        <h3 id={`${id}-basics`} className={settingsCss.foldTitle}>{t('chat.settingsBasics')}</h3>
      </div>
      <div className={settingsCss.foldBody}>
        <label className={css.label} htmlFor={`${id}-name`}>{t('chat.name')}</label>
        <Input id={`${id}-name`} value={value.name} maxLength={40} disabled={busy}
          onChange={(event) => { patch({ name: event.target.value }) }} />
      </div>
    </section>
    <button type="button" className={[settingsCss.groupAction, settingsCss.groupFoldToggle].join(' ')}
      aria-label={t(hasOpenSections ? 'chat.collapseSettings' : 'chat.expandSettings')} aria-expanded={hasOpenSections}
      onClick={() => { expandAll(!hasOpenSections) }}>
      {hasOpenSections ? <IconChevronUpOutlineRegular size={14} aria-hidden="true" />
        : <IconChevronDownOutlineRegular size={14} aria-hidden="true" />}
    </button>
    {finance !== undefined && <FinanceBinding ownerId={chat.id} scope="group" active={financeActive} busy={busy}
      actions={finance} disclosure={disclosure('finance')} t={t} />}
    <SettingsSection className={settingsCss.archiveFold} title={t('archive.open')}
      icon={<IconArchiveOutlineRegular size={16} />} counts={[
        { label: t('archive.total'), count: tickets.length, tone: 'total' },
        { label: t('archive.completedState'), count: tickets.filter(task => task.state === 'completed').length, tone: 'completed' },
        { label: t('archive.deliveredState'), count: tickets.filter(task => task.state === 'delivered').length, tone: 'delivered' },
        { label: t('archive.blocked'), count: tickets.filter(task => task.state === 'blocked').length, tone: 'blocked' },
      ]} {...disclosure('archive')}>
      <p className={css.hint}>{t('archive.subtitle')}</p>
      <TaskArchiveAction chat={chat} bots={bots} connected={archiveConnected} activity={archiveActivity}
        actions={archiveActions} copyText={copyText} t={t} />
    </SettingsSection>
    <SettingsSection title={t('chat.settingsPeople')} icon={<IconUsersOutlineRegular size={16} />} count={value.memberIds.length}
      {...disclosure('people')}>
      <Members settings bots={bots} selected={value.memberIds} setSelected={(memberIds) => {
        patch({ memberIds, ...value.managerId !== null && !memberIds.includes(value.managerId) ? { managerId: null } : {} })
      }} disabled={busy} managerId={permissionsEnabled ? chat.managerId : null} t={t} />
      <Manager id={`${id}-manager`} bots={bots} members={value.memberIds} value={value.managerId}
        onChange={(managerId) => { patch({ managerId }) }} disabled={busy} t={t} />
    </SettingsSection>
    <SettingsSection title={t('chat.groupRoles')} icon={<IconListPenOutlineRegular size={16} />} {...disclosure('roles')}>
      <div className={settingsCss.roles}>
        <p className={css.hint}>{t('chat.groupRolesHint')}</p>
        {bots.filter(bot => chat.memberIds.includes(bot.id)).map((bot) => {
          const savedRole = chat.memberRoles.find(member => member.botId === bot.id)?.role ?? bot.role
          const summary = savedRole.trim() || t('chat.inheritRole')
          return <details key={bot.id} className={settingsCss.role}>
            <summary aria-label={t('chat.viewMemberRole', { name: bot.name })}>
              {bot.kind === 'main' ? <BotIdentityAvatar bot={bot} size={22} />
                : <GroupMemberAvatar appearance={bot.avatar} botId={bot.id} managerId={permissionsEnabled ? chat.managerId : null}
                  size={22} managerLabel={t('chat.managerBadge')} />}
              <span className={settingsCss.roleIdentity}><span>{bot.name}</span>
                <span className={settingsCss.roleSummary}>{summary}</span></span>
              <IconChevronRightOutlineRegular size={14} className={settingsCss.roleChevron} />
            </summary>
            <ResponsibilityField id={`${id}-role-${bot.id}`} label={t('chat.memberRole', { name: bot.name })}
              value={savedRole} placeholder={bot.role || t('chat.inheritRole')} disabled={busy || !permissionsEnabled} t={t}
              save={role => saveSettings({ id: chat.id, memberRole: { botId: bot.id, role } })} />
          </details>
        })}
      </div>
    </SettingsSection>
    <SettingsSection title={t('chat.settingsCollaboration')} icon={<IconSlidersTwoOutlineRegular size={16} />} {...disclosure('collaboration')}>
      <label className={css.label} htmlFor={`${id}-limit`}>{t('chat.relayLimit')}</label>
      <Input id={`${id}-limit`} type="number" min={1} step={1} value={Number.isNaN(value.relayLimit) ? '' : value.relayLimit} disabled={busy}
        onChange={(event) => { patch({ relayLimit: event.target.valueAsNumber }) }} />
      <p className={css.hint}>{t('chat.relayHint')}</p>
      <div className={settingsCss.switchRow}>
        <span>{t('chat.showHandoffRecords')}</span>
        <Switch checked={chat.showHandoffRecords !== false} disabled={busy || !permissionsEnabled}
          label={t('chat.showHandoffRecords')} onChange={(showHandoffRecords) => {
            if (savingGate.current || busy || !permissionsEnabled) return
            void saveSettings({ id: chat.id, showHandoffRecords }).catch((_error: unknown) => {
              // The frame reports the failure; the switch retains the confirmed directory value.
            })
          }} />
      </div>
      <p className={css.hint}>{t('chat.showHandoffRecordsHint')}</p>
    </SettingsSection>
    <SettingsSection title={t('permissions.members')} icon={<IconShieldOutlineRegular size={16} />} {...disclosure('permissions')}>
      <GroupPermissionSettings chat={chat} bots={bots} selectedMemberIds={value.memberIds}
        enabled={permissionsEnabled} locked={saving} dirty={dirty} batch={batch}
        activateBatch={activatePermissionBatch} applyBatch={applyPermissionBatch} cancelBatch={cancelPermissionBatch}
        retainPermissionSession={retainPermissionSession} renderFactorySlot={renderFactorySlot}
        renderSlot={renderSlot} SessionProvider={SessionProvider} t={t} />
    </SettingsSection>
    <SettingsSection title={t('chat.settingsResources')} icon={<IconFolderOpenOutlineRegular size={16} />} {...disclosure('resources')}>
      <label className={css.label} htmlFor={`${id}-folder`}>{t('chat.folder')}</label>
      <Input id={`${id}-folder`} value={chat.workDir} readOnly />
      <Button size="sm" variant="outline" onClick={openMemory}>{t('memory.open')}</Button>
    </SettingsSection>
    <div className={[css.saveBar, settingsCss.groupSave].join(' ')}><Button type="submit" variant="outline"
      disabled={busy || !dirty || !valid}>{t('bot.save')}</Button></div>
  </form>
}
