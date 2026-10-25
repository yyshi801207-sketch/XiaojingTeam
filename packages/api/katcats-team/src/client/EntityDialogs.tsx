/** Small explicit list actions whose registration owns routing, failures and committed outcomes. */
import { useId, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { TeamEntity } from './ui-state.ts'
import css from './team.module.css'

/**
 * Rename the captured Bot or group chat without opening its full settings form.
 * @param props - Captured identity and registration-owned mutation and dismissal callbacks.
 * @returns A name-only dialog that stays mounted until the registration acknowledges success.
 */
export function RenameEntity({ entity, rename, close, t }: {
  readonly entity: TeamEntity
  readonly rename: (entity: TeamEntity, name: string) => Promise<void>
  readonly close: () => void
  readonly t: TranslateNS<'katcats.team'>
}) {
  const [name, setName] = useState(entity.name)
  const [busy, setBusy] = useState(false)
  const id = useId()
  const dismiss = (): void => { if (!busy) close() }
  return <Modal open title={t('team.renameEntityTitle', { name: entity.name })} closeLabel={t('team.close')}
    onClose={dismiss} className={css.modal ?? ''}>
    <form className={css.createForm} aria-busy={busy} onSubmit={(event) => {
      event.preventDefault()
      if (busy || name.trim() === '') return
      setBusy(true)
      void rename(entity, name.trim()).finally(() => { setBusy(false) })
    }}>
      <label className={css.label} htmlFor={id}>{t('bot.name')}</label>
      <Input id={id} data-modal-autofocus value={name} maxLength={40} disabled={busy}
        onChange={(event) => { setName(event.target.value) }} />
      <div className={css.formActions}>
        <Button onClick={dismiss} disabled={busy}>{t('team.cancel')}</Button>
        <Button type="submit" variant="primary" disabled={busy || name.trim() === ''}>{t('bot.save')}</Button>
      </div>
    </form>
  </Modal>
}

/**
 * Confirm a list-entity deletion; no optimistic removal is performed by the dialog.
 * @param props - Captured identity and registration-owned mutation and dismissal callbacks.
 * @returns A confirmation kept available until the mutation owner explicitly closes it.
 */
export function DeleteEntity({ entity, remove, close, t }: {
  readonly entity: TeamEntity
  readonly remove: (entity: TeamEntity) => Promise<void>
  readonly close: () => void
  readonly t: TranslateNS<'katcats.team'>
}) {
  const [busy, setBusy] = useState(false)
  const dismiss = (): void => { if (!busy) close() }
  const title = entity.kind === 'bot' ? 'team.deleteBot' : 'team.deleteChat'
  return <Modal open title={t(title)} closeLabel={t('team.close')} onClose={dismiss} className={css.modal ?? ''}>
    <form className={css.createForm} aria-busy={busy} onSubmit={(event) => {
      event.preventDefault()
      if (busy) return
      setBusy(true)
      void remove(entity).finally(() => { setBusy(false) })
    }}>
      <p className={css.label}>{entity.name}</p>
      <p className={css.hint}>{t(entity.kind === 'bot' ? 'team.deleteBotDescription' : 'team.deleteChatDescription')}</p>
      <div className={css.formActions}>
        <Button data-modal-autofocus onClick={dismiss} disabled={busy}>{t('team.cancel')}</Button>
        <Button type="submit" variant="primary" disabled={busy}>{t(busy ? 'team.deletingEntity' : title)}</Button>
      </div>
    </form>
  </Modal>
}
