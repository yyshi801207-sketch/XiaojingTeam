/** Explicit custom-group removal without deleting its members or their conversations. */
import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { RemoveGroupRequest, TeamGroup } from '../types.ts'
import css from './team.module.css'

/**
 * Confirm removal of the captured logical group; the registration owns notices and closing on success.
 * @param props - Captured group, explicit mutation and cancellation callbacks.
 * @returns A focus-managed confirmation that keeps the group available after a refused mutation.
 */
export function RemoveGroup({ group, remove, close, t }: {
  readonly group: TeamGroup
  readonly remove: (request: RemoveGroupRequest) => Promise<void>
  readonly close: () => void
  readonly t: TranslateNS<'katcats.team'>
}) {
  const [busy, setBusy] = useState(false)
  const dismiss = (): void => { if (!busy) close() }
  return <Modal open title={t('team.removeGroup')} closeLabel={t('team.close')} onClose={dismiss} className={css.modal ?? ''}>
    <form className={css.createForm} aria-busy={busy} onSubmit={(event) => {
      event.preventDefault()
      if (busy) return
      setBusy(true)
      void remove({ id: group.id }).finally(() => { setBusy(false) })
    }}>
      <p className={css.label}>{group.name}</p>
      <p className={css.hint}>{t('team.removeGroupDescription')}</p>
      <div className={css.formActions}>
        <Button data-modal-autofocus onClick={dismiss} disabled={busy}>{t('team.cancel')}</Button>
        <Button type="submit" variant="primary" disabled={busy}>{t(busy ? 'team.removingGroup' : 'team.removeGroup')}</Button>
      </div>
    </form>
  </Modal>
}
