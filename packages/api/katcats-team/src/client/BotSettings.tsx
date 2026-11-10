/** Member settings inside the existing per-Session right sidebar. */
import { useId, useState } from 'react'
import { Button, IconClockOutlineRegular, Input, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-permission-presets/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { TeamBot, TeamGroup, UpdateBotRequest } from '../types.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { TeamView } from './model.ts'
import { AppearancePicker } from './avatars.tsx'
import { BotIdentityAvatar } from './BotIdentityAvatar.tsx'
import { Choice } from './Choice.tsx'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import css from './team.module.css'
import settingsCss from './settings.module.css'
import permissionCss from './permission-settings.module.css'

/** Host-backed settings input and one captured mutation. */
export interface BotSettingsInjected {
  readonly hooks: {
    readonly directory: ObservableSnapshot<TeamView>
    readonly connection: ObservableSnapshot<ConnectionState | undefined>
  }
  readonly save: (request: UpdateBotRequest) => Promise<void>
  readonly openMemory: () => void
  readonly openSchedules: (sessionId: TeamBot['sessionId']) => void
}

/** Session identity comes from the surrounding right-sidebar scope. */
export type BotSettingsProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'katcats.team'>
  & PropsRenderFactories & InjectFace<BotSettingsInjected>

/**
 * Resolve this tab's member without a global current-Bot field.
 * @param props - Framework Session identity and directory hook.
 * @returns Settings for the scoped member or its unavailable state.
 */
export function BotSettings({ sessionId, useDirectory, useProjection, useConnection, useTabInfo, renderFactorySlot,
  save, openMemory, openSchedules, t }: BotSettingsProps) {
  const view = useDirectory(value => value)
  const selection = useProjection('modelSelection')
  const connected = useConnection(value => value === 'connected')
  const visible = useTabInfo().tab.visible
  const bot = view.snapshot?.bots.find(item => item.sessionId === sessionId)
  if (bot === undefined || view.snapshot === null) return <p className={css.empty}>{t('bot.missing')}</p>
  return <SettingsForm key={bot.id} bot={bot} groups={view.snapshot.groups} catalog={view.catalog}
    sessionChoice={selection?.next ?? selection?.lastUsed ?? undefined} lastUsedModel={selection?.lastUsed ?? undefined}
    overrideEnabled={view.snapshot.modelCapabilities.override} followEnabled={view.snapshot.modelCapabilities.followGlobal}
    permissionsEnabled={view.phase === 'ready' && connected && visible} renderFactorySlot={renderFactorySlot}
    save={save} openMemory={openMemory} openSchedules={openSchedules} t={t} />
}

function SettingsForm({ bot, groups, catalog, sessionChoice, lastUsedModel, overrideEnabled, followEnabled, permissionsEnabled,
  renderFactorySlot, save, openMemory, openSchedules, t }: PropsRenderFactories & {
    readonly bot: TeamBot
    readonly groups: readonly TeamGroup[]
    readonly catalog: ModelCatalog | null
    readonly sessionChoice: ModelCatalog['default'] | undefined
    readonly lastUsedModel: ModelCatalog['default'] | undefined
    readonly overrideEnabled: boolean
    readonly followEnabled: boolean
    readonly permissionsEnabled: boolean
    readonly save: (request: UpdateBotRequest) => Promise<void>
    readonly openMemory: () => void
    readonly openSchedules: BotSettingsInjected['openSchedules']
    readonly t: TranslateNS<'katcats.team'>
  }) {
  const [draft, setDraft] = useState<Partial<Pick<TeamBot, 'name' | 'role' | 'avatar' | 'model' | 'groupId'>> | null>(null)
  const value = { ...bot, ...draft }
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [modelChanged, setModelChanged] = useState(false)
  const id = useId()
  const set = (patch: NonNullable<typeof draft>) => { setSaved(false); setDraft(previous => ({ ...previous, ...patch })) }
  const options = (overrideEnabled ? catalog?.groups : undefined)?.flatMap(provider => provider.models.map(model => ({
    key: JSON.stringify([provider.id, model.id]), provider: provider.id, model: model.id,
    label: `${provider.name} / ${model.name}`,
  }))) ?? []
  const selectedModel = value.model.kind === 'override' ? value.model : sessionChoice
  const selected = followEnabled && value.model.kind === 'follow-global' ? 'follow-global'
    : selectedModel === undefined ? 'current' : JSON.stringify([selectedModel.provider, selectedModel.model])
  const modelKnown = options.some(option => option.key === selected)
  const modelEnabled = overrideEnabled || followEnabled
  const modelLabel = (model: TeamBot['model']) => model.kind === 'follow-global' ? t('bot.followGlobal') : `${model.provider} / ${model.model}`
  return <form className={[css.settings, settingsCss.scroll].join(' ')} aria-busy={busy} onSubmit={(event) => {
    event.preventDefault()
    if (busy || draft === null || value.name.trim() === '') return
    setBusy(true)
    const request: UpdateBotRequest = {
      id: bot.id,
      ...(draft.name === undefined ? {} : { name: draft.name.trim() }),
      ...(draft.role === undefined ? {} : { role: draft.role }),
      ...(draft.avatar === undefined ? {} : { avatar: draft.avatar }),
      ...(modelChanged && (value.model.kind === 'override' ? overrideEnabled : followEnabled) ? { model: value.model } : {}),
      ...(bot.kind === 'main' || draft.groupId === undefined || draft.groupId === null ? {} : { groupId: draft.groupId }),
    }
    void save(request).then(
      () => { setDraft(null); setModelChanged(false); setSaved(true) },
      () => { /* The frame-owned toast reports the failure; retain this draft. */ },
    ).finally(() => { setBusy(false) })
  }}>
    <div className={[css.settingsIdentity, settingsCss.identity].join(' ')}>
      <BotIdentityAvatar bot={value} size={60} /><h2>{bot.name}</h2>
      <Tooltip label={t('team.automations')}><button type="button" className={settingsCss.automation}
        aria-label={t('team.automations')} onClick={() => { openSchedules(bot.sessionId) }}>
        <IconClockOutlineRegular size={18} />
      </button></Tooltip>
    </div>
    <label className={css.label} htmlFor={`${id}-name`}>{t('bot.name')}</label>
    <Input id={`${id}-name`} value={value.name} maxLength={40} disabled={busy}
      onChange={(event) => { set({ name: event.target.value }) }} />
    <label className={css.label} htmlFor={`${id}-role`}>{t('bot.role')}</label>
    <textarea id={`${id}-role`} className={css.textarea} value={value.role} disabled={busy}
      placeholder={t('bot.rolePlaceholder')} onChange={(event) => { set({ role: event.target.value }) }} />
    {bot.kind !== 'main' && <AppearancePicker value={value.avatar} onChange={(avatar) => { set({ avatar }) }} t={t} disabled={busy} />}
    {bot.kind !== 'main' && <><label className={css.label} htmlFor={`${id}-group`}>{t('bot.group')}</label>
      <Choice id={`${id}-group`} label={t('bot.group')} value={value.groupId ?? ''} disabled={busy}
        options={groups.filter(group => group.kind === 'bots').map(group => ({ value: group.id, label: group.system ? t('team.bots') : group.name }))}
        onChange={(next) => {
          const group = groups.find(item => item.id === next)
          if (group !== undefined) set({ groupId: group.id })
        }} /></>}
    <label className={css.label} htmlFor={`${id}-model`}>{t('bot.model')}</label>
    <Choice id={`${id}-model`} label={t('bot.model')} value={selected} disabled={busy || !modelEnabled}
      {...!modelEnabled || !followEnabled ? { descriptionId: `${id}-modelHint` } : {}}
      options={[
        ...followEnabled ? [{ value: 'follow-global', label: t('bot.followGlobal') }] : [],
        ...overrideEnabled && catalog !== null ? [{ value: 'base', label: t('bot.useBaseModel') }] : [],
        ...selected === 'current' ? [{ value: 'current', label: t('bot.currentModel'), disabled: true }] : [],
        ...!modelKnown && selected !== 'follow-global' && selectedModel !== undefined ? [{ value: selected,
          label: `${selectedModel.provider} / ${selectedModel.model}`, disabled: true }] : [],
        ...options.map(option => ({ value: option.key, label: option.label }))]}
      onChange={(next) => {
        const option = options.find(item => item.key === next)
        if (next === 'follow-global' && followEnabled) set({ model: { kind: 'follow-global' } })
        else if (next === 'base' && overrideEnabled && catalog !== null) set({ model: { kind: 'override', ...catalog.default } })
        else if (option !== undefined && overrideEnabled) set({ model: { kind: 'override', provider: option.provider, model: option.model } })
        else return
        setModelChanged(true)
      }} />
    {!modelEnabled && <p id={`${id}-modelHint`} className={css.hint}>{t('bot.modelUnavailable')}</p>}
    {overrideEnabled && !followEnabled && <p id={`${id}-modelHint`} className={css.hint}>{t('bot.fixedModelHint')}</p>}
    {followEnabled && <p className={css.hint}>{t('bot.dynamicModelHint')}</p>}
    {modelEnabled && <p className={css.hint}>{t('bot.modelSourcesHint')}</p>}
    {modelEnabled && <div className={settingsCss.modelStatus} aria-live="polite">
      {modelChanged && <p className={settingsCss.modelPending}>{t('bot.pendingModel', { model: modelLabel(value.model) })}</p>}
      <p>{t('bot.savedModel', { model: modelLabel(bot.model) })}</p>
      <p className={css.hint}>{lastUsedModel === undefined ? t('bot.noRequestModel')
        : t('bot.lastRequestModel', { model: `${lastUsedModel.provider} / ${lastUsedModel.model}` })}</p>
    </div>}
    {catalog !== null && catalog.groups.length === 0 && sessionChoice === undefined && <p className={css.hint}>{t('bot.noModel')}</p>}
    <section className={permissionCss.section} aria-labelledby={`${id}-permissions`}>
      <h3 id={`${id}-permissions`} className={permissionCss.title}>{t('permissions.bot')}</h3>
      <p className={permissionCss.hint}>{t('permissions.botHint')}</p>
      {permissionsEnabled ? renderFactorySlot('permission.select', { locked: busy })
        : <p className={permissionCss.hint}>{t('permissions.unavailable')}</p>}
    </section>
    <label className={css.label} htmlFor={`${id}-folder`}>{t('bot.folder')}</label>
    <Input id={`${id}-folder`} value={bot.workDir} readOnly />
    <Button size="sm" variant="outline" onClick={openMemory}>{t('memory.open')}</Button>
    <div className={css.saveBar}><Button type="submit" variant="outline" disabled={busy || draft === null || value.name.trim() === ''}>
      {t('bot.save')}</Button>{saved && <span role="status" className={settingsCss.modelSaved}>{t('team.saved')}</span>}</div>
  </form>
}
