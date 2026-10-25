/** Reuse the public permission selector within exact member Session scopes. */
import { useEffect, useId, useState } from 'react'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-permission-presets/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { BotId, TeamBot } from '../types.ts'
import type { ChatId, TeamChat } from '../chats-types.ts'
import { GroupMemberAvatar } from './GroupMemberAvatar.tsx'
import { BotIdentityAvatar } from './BotIdentityAvatar.tsx'
import type { GroupPermissionBatch, GroupPermissionBatchView } from './group-permission-batch.ts'
import css from './permission-settings.module.css'

/** Captured group membership and its exact group-local execution Session. */
export interface PermissionMemberTarget {
  readonly chatId: ChatId
  readonly botId: BotId
  readonly sessionId: SessionId
}

/** Revalidate current membership before retaining a group-local Session. */
export type PermissionSessionRetainer = (target: PermissionMemberTarget, signal: AbortSignal) => SessionReference

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** A visible group-settings permission row, released on hide or invalidation. */
    katcatsPermissions: unknown
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Permission factory rendered under a retained member Session, never the group root. */
    'katcats.settings.permission': { kind: 'single'; scope: 'session'; owner: { readonly locked: boolean } }
  }
}

/** The member Session supplies its original projection and Factory scope. */
export type SettingsPermissionPickerProps = PropsRuntime<'katcats.settings.permission'> & PropsRenderFactories
  & PropsLocale<'katcats.team'>

/**
 * Keep the native picker and its risk confirmation inside the exact current Session.
 * @param props - Scoped Session readiness, published permissions and native Factory rendering.
 * @returns The original picker, or a localized unavailable state before its Session is usable.
 */
export function SettingsPermissionPicker({ locked, useSession, useProjection, renderFactorySlot, t }: SettingsPermissionPickerProps) {
  const open = useSession(session => session.openState === 'open')
  const available = useProjection('permissions') !== undefined
  if (!open || !available) return <p className={css.hint}>{t('permissions.unavailable')}</p>
  return renderFactorySlot('permission.select', { locked })
}

/** Group settings authorize a session child and inject only an acquisition callback. */
export type GroupPermissionSettingsProps = PropsRenderSlots<'katcats.settings.permission'> & PropsRenderFactories & {
  readonly chat: TeamChat
  readonly bots: readonly TeamBot[]
  readonly selectedMemberIds: readonly BotId[]
  readonly enabled: boolean
  readonly locked: boolean
  readonly dirty: boolean
  readonly batch: GroupPermissionBatchView
  readonly activateBatch: GroupPermissionBatch['activate']
  readonly applyBatch: GroupPermissionBatch['apply']
  readonly cancelBatch: GroupPermissionBatch['cancel']
  readonly retainPermissionSession: PermissionSessionRetainer
  readonly t: TranslateNS<'katcats.team'>
}

/**
 * Give each saved, selected group member its own permission selector.
 * @param props - Current group membership, visibility/readiness, retained scope provider and child dispatcher.
 * @returns Member-labelled permission rows that never fall back to private or root Sessions.
 */
export function GroupPermissionSettings({
  chat, bots, selectedMemberIds, enabled, locked, dirty, batch, activateBatch, applyBatch, cancelBatch,
  retainPermissionSession, renderFactorySlot, renderSlot, SessionProvider, t,
}: GroupPermissionSettingsProps) {
  const id = useId()
  const batchEnabled = enabled && !locked && !dirty
  useEffect(() => {
    if (!batchEnabled) return
    const controller = new AbortController()
    activateBatch(controller.signal)
    return () => { controller.abort() }
  }, [batchEnabled, activateBatch])
  const members = bots.filter(bot => chat.memberIds.includes(bot.id) && selectedMemberIds.includes(bot.id))
  return <section className={css.section} aria-labelledby={id}>
    <h3 id={id} className={css.title}>{t('permissions.members')}</h3>
    <p className={css.hint}>{t('permissions.groupHint')}</p>
    <div className={css.batch} role="group" aria-label={t('permissions.batch')}>
      <h4 className={css.batchTitle}>{t('permissions.batch')}</h4>
      <p className={css.hint}>{t('permissions.batchHint')}</p>
      {renderFactorySlot('permission.select-batch', {
        locked: !batchEnabled || !batch.ready || batch.busy,
        currentValue: batch.currentValue,
        targetKey: `${batch.targetKey}:${batchEnabled ? 'enabled' : 'locked'}`,
        targetCount: batch.targets.length, targetLabel: batch.targetLabel,
        allowNoApproval: batchEnabled && batch.ready && batch.allowNoApproval,
        onSelect: preset => applyBatch(preset, batch.targetKey),
      })}
      {dirty && <p className={css.hint}>{t('permissions.batchSaveFirst')}</p>}
      {!dirty && !batch.ready && <p className={css.hint}>{t('permissions.unavailable')}</p>}
      {batch.busy && <button type="button" className={css.cancel} onClick={cancelBatch}>{t('permissions.batchCancel')}</button>}
      {batch.results.length > 0 && <div role="status" aria-live="polite" className={css.results}>
        <p className={css.hint}>{t('permissions.batchReport')}</p>
        <ul>{batch.results.map(result => <li key={result.target.botId}>
          <span>{result.target.name}</span><span>{t(`permissions.batchResult.${result.status}`)}</span>
        </li>)}</ul>
      </div>}
    </div>
    {members.map((bot) => {
      const executor = chat.executors.find(item => item.botId === bot.id)
      const usable = executor !== undefined && executor.sessionId !== chat.rootSessionId
        && !bots.some(member => member.sessionId === executor.sessionId)
      return <div key={bot.id} className={css.member} role="group" aria-label={t('permissions.member', { name: bot.name })}>
        <div className={css.identity}>
          {bot.kind === 'main' ? <BotIdentityAvatar bot={bot} size={22} />
            : <GroupMemberAvatar appearance={bot.avatar} botId={bot.id} managerId={enabled ? chat.managerId : null}
              size={22} managerLabel={t('chat.managerBadge')} />}
          <span>{bot.name}</span>
        </div>
        {enabled && usable
          ? <RetainedPermissionPicker key={`${chat.id}:${bot.id}:${executor.sessionId}`}
            chatId={chat.id} botId={bot.id} sessionId={executor.sessionId} locked={locked || batch.busy}
            retainPermissionSession={retainPermissionSession} renderSlot={renderSlot} SessionProvider={SessionProvider} t={t} />
          : <p className={css.hint}>{t('permissions.unavailable')}</p>}
      </div>
    })}
    {members.length === 0 && <p className={css.hint}>{t('permissions.noMembers')}</p>}
  </section>
}

function RetainedPermissionPicker({
  chatId, botId, sessionId, locked, retainPermissionSession, renderSlot, SessionProvider, t,
}: PropsRenderSlots<'katcats.settings.permission'> & PermissionMemberTarget & {
  readonly locked: boolean
  readonly retainPermissionSession: PermissionSessionRetainer
  readonly t: TranslateNS<'katcats.team'>
}) {
  const [state, setState] = useState<{
    readonly reference?: SessionReference
    readonly failed: boolean
    readonly owner: PermissionSessionRetainer
  }>({ failed: false, owner: retainPermissionSession })
  useEffect(() => {
    const controller = new AbortController()
    let reference: SessionReference
    try { reference = retainPermissionSession({ chatId, botId, sessionId }, controller.signal) }
    catch (_error) {
      // Acquisition failures are visible here; no scope or permission command is created.
      setState({ failed: true, owner: retainPermissionSession })
      return () => { controller.abort() }
    }
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      reference.release()
    }
    void reference.ready.then(() => {
      if (controller.signal.aborted) { release(); return }
      if (reference.sessionId === sessionId) setState({ reference, failed: false, owner: retainPermissionSession })
      else { release(); setState({ failed: true, owner: retainPermissionSession }) }
    }, (_error: unknown) => {
      release()
      if (!controller.signal.aborted) setState({ failed: true, owner: retainPermissionSession })
    })
    return () => { controller.abort(); release() }
  }, [chatId, botId, sessionId, retainPermissionSession])
  if (state.owner !== retainPermissionSession || state.reference === undefined) {
    return <p className={css.hint}>{t(state.failed && state.owner === retainPermissionSession ? 'permissions.unavailable' : 'permissions.loading')}</p>
  }
  return <SessionProvider session={state.reference}>{renderSlot('katcats.settings.permission', { locked })}</SessionProvider>
}
