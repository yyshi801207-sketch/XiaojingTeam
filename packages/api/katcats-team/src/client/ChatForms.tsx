/** Explicit group creation and settings, retaining only edited fields as drafts. */
import { useId, useRef, useState } from 'react'
import { Button, Checkbox, IconChevronRightOutlineRegular, IconClockOutlineRegular, Input, Modal, Switch, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { BotId, TeamBot } from '../types.ts'
import type { CreateChatRequest, TeamChat, UpdateChatRequest } from '../chats-types.ts'
import type { TeamView } from './model.ts'
import type { ChatView } from './chat-model.ts'
import { GroupMemberAvatar } from './GroupMemberAvatar.tsx'
import { BotIdentityAvatar } from './BotIdentityAvatar.tsx'
import { ChatAvatar } from './ChatAvatar.tsx'
import { TaskArchiveAction } from './TaskArchive.tsx'
import { Choice } from './Choice.tsx'
import { GroupPermissionSettings } from './PermissionSettings.tsx'
import type { PermissionSessionRetainer } from './PermissionSettings.tsx'
import type { GroupPermissionBatch, GroupPermissionBatchView } from './group-permission-batch.ts'
import css from './team.module.css'
import settingsCss from './settings.module.css'

function Members({ bots, selected, setSelected, disabled, managerId = null, t }: {
  readonly bots: readonly TeamBot[]
  readonly selected: readonly BotId[]
  readonly setSelected: (ids: readonly BotId[]) => void
  readonly disabled: boolean
  readonly managerId?: BotId | null
  readonly t: TranslateNS<'katcats.team'>
}) {
  return <fieldset className={css.chatMembers}><legend>{t('chat.members')}</legend>
    <p className={css.hint}>{t('chat.memberHint')}</p>
    {bots.filter(bot => bot.kind === 'ordinary' || selected.includes(bot.id)).map(bot => <div key={bot.id} className={css.chatMember}>
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
    {!bots.some(bot => bot.kind === 'ordinary') && <p className={css.hint}>{t('chat.noMembers')}</p>}
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
  const eligible = bots.filter(bot => bot.kind === 'ordinary' && members.includes(bot.id))
  const legacy = bots.find(bot => bot.kind === 'main' && bot.id === value)
  return <><label className={css.label} htmlFor={id}>{t('chat.manager')}</label>
    <Choice id={id} label={t('chat.manager')} value={value ?? 'none'} disabled={disabled}
      options={[{ value: 'none', label: t('chat.noManager') },
        ...legacy === undefined ? [] : [{ value: legacy.id, label: legacy.name, disabled: true }],
        ...eligible.map(bot => ({ value: bot.id, label: bot.name }))]}
      onChange={(next) => { if (next === 'none') onChange(null); else {
        const bot = eligible.find(item => item.id === next)
        if (bot !== undefined) onChange(bot.id)
      } }} />
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
    && bots.some(bot => bot.kind === 'ordinary' && members.includes(bot.id))
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
      <Members bots={bots.filter(bot => bot.kind === 'ordinary')} selected={members} setSelected={(next) => {
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
  save, openMemory, openSchedules, copyText, t }: ChatSettingsProps) {
  const directory = useDirectory(value => value)
  const groups = useChats(value => value)
  const connected = useConnection(value => value === 'connected')
  const visible = useTabInfo().tab.visible
  const batch = usePermissionBatch(value => value)
  const bots = directory.snapshot?.bots ?? []
  const chat = groups.snapshot?.chats.find(item => item.rootSessionId === sessionId)
  if (chat === undefined) return <p className={css.empty}>{t('chat.missing')}</p>
  return <SettingsForm key={chat.id} chat={chat} bots={bots} save={save} openMemory={openMemory} openSchedules={openSchedules}
    archiveConnected={connected && groups.phase === 'ready'} copyText={copyText}
    permissionsEnabled={directory.phase === 'ready' && groups.phase === 'ready' && connected && visible}
    batch={batch} activatePermissionBatch={activatePermissionBatch} applyPermissionBatch={applyPermissionBatch}
    cancelPermissionBatch={cancelPermissionBatch} retainPermissionSession={retainPermissionSession}
    renderFactorySlot={renderFactorySlot} renderSlot={renderSlot} SessionProvider={SessionProvider} t={t} />
}

function SettingsForm({ chat, bots, archiveConnected, permissionsEnabled,
  retainPermissionSession, renderFactorySlot, renderSlot, SessionProvider,
  batch, activatePermissionBatch, applyPermissionBatch, cancelPermissionBatch,
  save, openMemory, openSchedules, copyText, t }: PropsRenderSlots<'katcats.settings.permission'> & PropsRenderFactories & {
    readonly chat: TeamChat
    readonly bots: readonly TeamBot[]
    readonly archiveConnected: boolean
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
  const [roleEdits, setRoleEdits] = useState<ReadonlyMap<BotId, string>>(new Map())
  const [saving, setBusy] = useState(false)
  const savingGate = useRef(false)
  const busy = saving || batch.busy
  const id = useId()
  const value = { ...chat, ...draft }
  const valid = value.name.trim() !== '' && Number.isSafeInteger(value.relayLimit) && value.relayLimit > 0
    && bots.some(bot => bot.kind === 'ordinary' && value.memberIds.includes(bot.id))
  const patch = (next: NonNullable<typeof draft>) => { setDraft(current => ({ ...current, ...next })) }
  const dirty = draft !== null || roleEdits.size > 0
  return <form className={[css.settings, settingsCss.scroll].join(' ')} aria-busy={busy} onSubmit={(event) => {
    event.preventDefault()
    if (savingGate.current || busy || !dirty || !valid) return
    savingGate.current = true
    setBusy(true)
    const roles = value.memberIds.map(botId => ({ botId,
      role: (roleEdits.get(botId) ?? chat.memberRoles.find(member => member.botId === botId)?.role ?? '').trim(),
    })).filter(member => member.role !== '')
    void save({ id: chat.id, ...draft, ...draft?.name === undefined ? {} : { name: draft.name.trim() },
      ...roleEdits.size > 0 ? { memberRoles: roles } : {},
    }).then(
      () => { setDraft(null); setRoleEdits(new Map()) },
      () => { /* The frame reports the failure; explicit edits remain available. */ },
    ).finally(() => { savingGate.current = false; setBusy(false) })
  }}>
    <div className={[css.settingsIdentity, settingsCss.identity].join(' ')}>
      <ChatAvatar large appearances={bots.filter(bot => value.memberIds.includes(bot.id)).map(bot => bot.avatar)} />
      <h2>{chat.name}</h2>
      <Tooltip label={t('team.automations')}><button type="button" className={settingsCss.automation}
        aria-label={t('team.automations')} onClick={() => { openSchedules(chat.rootSessionId) }}>
        <IconClockOutlineRegular size={18} />
      </button></Tooltip>
    </div>
    <section className={settingsCss.section} aria-labelledby={`${id}-basics`}>
      <h3 id={`${id}-basics`} className={settingsCss.sectionTitle}>{t('chat.settingsBasics')}</h3>
      <label className={css.label} htmlFor={`${id}-name`}>{t('chat.name')}</label>
      <Input id={`${id}-name`} value={value.name} maxLength={40} disabled={busy}
        onChange={(event) => { patch({ name: event.target.value }) }} />
    </section>
    <section className={settingsCss.section} aria-labelledby={`${id}-archive`}>
      <h3 id={`${id}-archive`} className={settingsCss.sectionTitle}>{t('archive.open')} · {chat.tickets?.length ?? 0}</h3>
      <p className={css.hint}>{t('archive.subtitle')}</p>
      <TaskArchiveAction chat={chat} bots={bots} connected={archiveConnected} copyText={copyText} t={t} />
    </section>
    <section className={settingsCss.section} aria-labelledby={`${id}-people`}>
      <h3 id={`${id}-people`} className={settingsCss.sectionTitle}>{t('chat.settingsPeople')}</h3>
      <details className={settingsCss.members}>
        <summary>{t('chat.members')} · {value.memberIds.length}</summary>
        <Members bots={bots} selected={value.memberIds} setSelected={(memberIds) => {
          patch({ memberIds, ...value.managerId !== null && !memberIds.includes(value.managerId) ? { managerId: null } : {} })
        }} disabled={busy} managerId={permissionsEnabled ? chat.managerId : null} t={t} />
      </details>
      <Manager id={`${id}-manager`} bots={bots} members={value.memberIds} value={value.managerId}
        onChange={(managerId) => { patch({ managerId }) }} disabled={busy} t={t} />
      <fieldset className={css.chatMembers}><legend>{t('chat.groupRoles')}</legend>
        <p className={css.hint}>{t('chat.groupRolesHint')}</p>
        {bots.filter(bot => value.memberIds.includes(bot.id)).map((bot) => {
          const role = roleEdits.get(bot.id) ?? chat.memberRoles.find(member => member.botId === bot.id)?.role ?? ''
          const summary = role.trim() || bot.role.trim() || t('chat.inheritRole')
          return <details key={bot.id} className={settingsCss.role}>
            <summary aria-label={t('chat.editMemberRole', { name: bot.name })}>
              {bot.kind === 'main' ? <BotIdentityAvatar bot={bot} size={22} />
                : <GroupMemberAvatar appearance={bot.avatar} botId={bot.id} managerId={permissionsEnabled ? chat.managerId : null}
                  size={22} managerLabel={t('chat.managerBadge')} />}
              <span className={settingsCss.roleIdentity}><span>{bot.name}</span>
                <span className={settingsCss.roleSummary}>{summary}</span></span>
              <IconChevronRightOutlineRegular size={14} className={settingsCss.roleChevron} />
            </summary>
            <label className={css.label} htmlFor={`${id}-role-${bot.id}`}>{t('chat.memberRole', { name: bot.name })}</label>
            <textarea id={`${id}-role-${bot.id}`} className={[css.textarea, settingsCss.roleEditor].join(' ')}
              disabled={busy} placeholder={bot.role} value={role}
              onChange={(event) => { setRoleEdits(current => new Map(current).set(bot.id, event.target.value)) }} />
          </details>
        })}
      </fieldset>
    </section>
    <section className={settingsCss.section} aria-labelledby={`${id}-collaboration`}>
      <h3 id={`${id}-collaboration`} className={settingsCss.sectionTitle}>{t('chat.settingsCollaboration')}</h3>
      <label className={css.label} htmlFor={`${id}-limit`}>{t('chat.relayLimit')}</label>
      <Input id={`${id}-limit`} type="number" min={1} step={1} value={Number.isNaN(value.relayLimit) ? '' : value.relayLimit} disabled={busy}
        onChange={(event) => { patch({ relayLimit: event.target.valueAsNumber }) }} />
      <p className={css.hint}>{t('chat.relayHint')}</p>
      <div className={settingsCss.switchRow}>
        <span>{t('chat.showHandoffRecords')}</span>
        <Switch checked={chat.showHandoffRecords !== false} disabled={busy || !permissionsEnabled}
          label={t('chat.showHandoffRecords')} onChange={(showHandoffRecords) => {
            if (savingGate.current || busy || !permissionsEnabled) return
            savingGate.current = true
            setBusy(true)
            void save({ id: chat.id, showHandoffRecords }).catch((_error: unknown) => {
              // The frame reports the failure; the switch retains the confirmed directory value.
            }).finally(() => { savingGate.current = false; setBusy(false) })
          }} />
      </div>
      <p className={css.hint}>{t('chat.showHandoffRecordsHint')}</p>
    </section>
    <GroupPermissionSettings chat={chat} bots={bots} selectedMemberIds={value.memberIds}
      enabled={permissionsEnabled} locked={saving} dirty={dirty} batch={batch}
      activateBatch={activatePermissionBatch} applyBatch={applyPermissionBatch} cancelBatch={cancelPermissionBatch}
      retainPermissionSession={retainPermissionSession} renderFactorySlot={renderFactorySlot}
      renderSlot={renderSlot} SessionProvider={SessionProvider} t={t} />
    <section className={settingsCss.section} aria-labelledby={`${id}-resources`}>
      <h3 id={`${id}-resources`} className={settingsCss.sectionTitle}>{t('chat.settingsResources')}</h3>
      <label className={css.label} htmlFor={`${id}-folder`}>{t('chat.folder')}</label>
      <Input id={`${id}-folder`} value={chat.workDir} readOnly />
      <Button size="sm" variant="outline" onClick={openMemory}>{t('memory.open')}</Button>
    </section>
    <div className={css.saveBar}><Button type="submit" variant="outline" disabled={busy || !dirty || !valid}>{t('bot.save')}</Button></div>
  </form>
}
