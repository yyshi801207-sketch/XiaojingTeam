/** Explicit quick-create forms; cancellation never sends a model or member request. */
import { useId, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { CreateBotRequest, GroupId } from '../types.ts'
import { AppearancePicker, CatAvatar, DEFAULT_APPEARANCE } from './avatars.tsx'
import css from './team.module.css'

/** Plain form commands; registration owns the Host call and its outcome notice. */
export interface CreateBotProps {
  readonly groupId: GroupId | undefined
  readonly create: (request: CreateBotRequest) => Promise<void>
  readonly close: () => void
  readonly t: TranslateNS<'katcats.team'>
}

/**
 * Create a general member from only its name and appearance.
 * @param props - Captured destination group and explicit submit command.
 * @returns A focus-managed, body-portaled modal.
 */
export function CreateBot({ groupId, create, close, t }: CreateBotProps) {
  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState(DEFAULT_APPEARANCE)
  const [busy, setBusy] = useState(false)
  const id = useId()
  const dismiss = () => { if (!busy) close() }
  const submit = async () => {
    if (busy || name.trim() === '') return
    setBusy(true)
    try { await create({ name: name.trim(), ...(groupId === undefined ? {} : { groupId }), avatar }) }
    finally { setBusy(false) }
  }
  return <Modal open title={t('team.newBot')} closeLabel={t('team.close')} onClose={dismiss} className={css.modal ?? ''}>
    <form className={css.createForm} onSubmit={(event) => { event.preventDefault(); void submit() }} aria-busy={busy}>
      <div className={css.avatarPreview}><CatAvatar appearance={avatar} size={76} /></div>
      <label className={css.label} htmlFor={id}>{t('bot.name')}</label>
      <Input id={id} data-modal-autofocus value={name} maxLength={40} disabled={busy}
        placeholder={t('bot.namePlaceholder')} onChange={(event) => { setName(event.target.value) }} />
      <p className={css.hint}>{t('team.createHint')}</p>
      <AppearancePicker value={avatar} onChange={setAvatar} t={t} disabled={busy} />
      <div className={css.formActions}><Button onClick={dismiss} disabled={busy}>{t('team.cancel')}</Button>
        <Button type="submit" variant="primary" disabled={busy || name.trim() === ''}>{t('team.create')}</Button></div>
    </form>
  </Modal>
}

/**
 * Name one logical group without directory or model configuration.
 * @param props - Explicit save and cancel callbacks.
 * @returns A compact name dialog.
 */
export function CreateGroup({ create, close, t, name: initialName = '', editing = false }: {
  readonly create: (name: string) => Promise<void>
  readonly close: () => void
  readonly t: TranslateNS<'katcats.team'>
  readonly name?: string
  readonly editing?: boolean
}) {
  const [name, setName] = useState(initialName)
  const [busy, setBusy] = useState(false)
  const id = useId()
  const dismiss = () => { if (!busy) close() }
  return <Modal open title={t(editing ? 'team.renameGroup' : 'team.newGroup')} closeLabel={t('team.close')} onClose={dismiss} className={css.modal ?? ''}>
    <form className={css.createForm} aria-busy={busy} onSubmit={(event) => {
      event.preventDefault()
      if (busy || name.trim() === '') return
      setBusy(true)
      void create(name.trim()).finally(() => { setBusy(false) })
    }}>
      <label className={css.label} htmlFor={id}>{t('team.groupName')}</label>
      <Input id={id} data-modal-autofocus value={name} maxLength={40} disabled={busy}
        onChange={(event) => { setName(event.target.value) }} />
      <div className={css.formActions}><Button onClick={dismiss} disabled={busy}>{t('team.cancel')}</Button>
        <Button type="submit" variant="primary" disabled={busy || name.trim() === ''}>{t(editing ? 'bot.save' : 'team.create')}</Button></div>
    </form>
  </Modal>
}
