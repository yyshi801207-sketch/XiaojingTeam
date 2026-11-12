/** Frame-owned creation and outcome surfaces survive sidebar and Session changes. */
import { useId, useRef, useState } from 'react'
import { Button, Modal, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { CreateBotRequest, RemoveGroupRequest, UpdateGroupRequest } from '../types.ts'
import type { TaskAcceptanceCandidate, TeamDialog, TeamEntity, TeamUiState } from './ui-state.ts'
import { CreateBot, CreateGroup } from './CreateBot.tsx'
import { RemoveGroup } from './RemoveGroup.tsx'
import { DeleteEntity, RenameEntity } from './EntityDialogs.tsx'
import css from './team.module.css'

type AcceptanceDialog = Extract<TeamDialog, { kind: 'accept-task' }>

/** Data and commands projected into the persistent overlay registration. */
export interface TeamOverlaysInjected {
  readonly hooks: { readonly teamUi: ObservableSnapshot<TeamUiState> }
  readonly close: () => void
  readonly createBot: (request: CreateBotRequest) => Promise<void>
  readonly createGroup: (name: string) => Promise<void>
  readonly renameGroup: (request: UpdateGroupRequest) => Promise<void>
  readonly removeGroup: (request: RemoveGroupRequest) => Promise<void>
  readonly renameEntity: (entity: TeamEntity, name: string) => Promise<void>
  readonly deleteEntity: (entity: TeamEntity) => Promise<void>
  readonly acceptTask: (dialog: AcceptanceDialog, task: TaskAcceptanceCandidate) => Promise<void>
  readonly dismissNotice: (id: number) => void
}

/** The frame supplies standard locale and root scope. */
export type TeamOverlaysProps = PropsRuntime<'shell.overlay'> & PropsLocale<'katcats.team'> & InjectFace<TeamOverlaysInjected>

/**
 * Present explicit create requests and the latest localized result.
 * @param props - Shared transient state and narrow commands.
 * @returns Frame-owned modals and toast, without owning business persistence.
 */
export function TeamOverlays({ useTeamUi, close, createBot, createGroup, renameGroup, removeGroup,
  renameEntity, deleteEntity, acceptTask, dismissNotice, t }: TeamOverlaysProps) {
  const state = useTeamUi(value => value)
  const notice = state.notice
  return <>
    {state.dialog?.kind === 'bot' && <CreateBot key={state.dialog.key} groupId={state.dialog.groupId} create={createBot} close={close} t={t} />}
    {state.dialog?.kind === 'group' && (() => {
      const group = state.dialog.group
      return <CreateGroup key={state.dialog.key} create={group === undefined ? createGroup : name => renameGroup({ id: group.id, name })}
        {...group === undefined ? {} : { name: group.name }} editing={group !== undefined} close={close} t={t} />
    })()}
    {state.dialog?.kind === 'remove-group' && <RemoveGroup key={state.dialog.key} group={state.dialog.group}
      remove={removeGroup} close={close} t={t} />}
    {state.dialog?.kind === 'rename-entity' && <RenameEntity key={state.dialog.key} entity={state.dialog.entity}
      rename={renameEntity} close={close} t={t} />}
    {state.dialog?.kind === 'delete-entity' && <DeleteEntity key={state.dialog.key} entity={state.dialog.entity}
      remove={deleteEntity} close={close} t={t} />}
    {state.dialog?.kind === 'accept-task' && <AcceptTask key={state.dialog.key} dialog={state.dialog}
      accept={acceptTask} close={close} t={t} />}
    {notice !== null && <Toast key={notice.id} text={t(notice.key, notice.name === undefined ? undefined : { name: notice.name })}
      {...notice.success ? { tone: 'success' } : {}} onDone={() => { dismissNotice(notice.id) }} />}
  </>
}

function AcceptTask({ dialog, accept, close, t }: {
  readonly dialog: AcceptanceDialog
  readonly accept: TeamOverlaysInjected['acceptTask']
  readonly close: () => void
  readonly t: TeamOverlaysProps['t']
}) {
  const inputGroup = useId()
  const single = dialog.candidates.length === 1 ? dialog.candidates[0] : undefined
  const [selectedId, select] = useState(single?.taskId)
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const selected = dialog.candidates.find(candidate => candidate.taskId === selectedId)
  const dismiss = (): void => { if (!saving.current) close() }
  const proactive = dialog.requestId === undefined
  return <Modal open title={t(proactive ? 'archive.chatReview' : 'archive.chatChoose')}
    description={t('archive.chatReviewHint')} closeLabel={t('team.close')} onClose={dismiss}
    className={[css.modal, css.createChatModal].filter(Boolean).join(' ')} contentClassName={css.createChatContent ?? ''}>
    <form className={css.createForm} aria-busy={busy} onSubmit={event => {
      event.preventDefault()
      if (saving.current || selected === undefined) return
      saving.current = true
      setBusy(true)
      void accept(dialog, selected).finally(() => { saving.current = false; setBusy(false) })
    }}>
      <fieldset className={css.appearanceField}>
        <legend>{t('archive.deliveredState')}</legend>
        {dialog.candidates.map((task, index) => <label className={css.acceptanceChoice} key={task.taskId}>
          {single === undefined && <input type="radio" name={inputGroup} checked={task.taskId === selectedId}
            data-modal-autofocus={index === 0 ? '' : undefined} disabled={busy} onChange={() => { select(task.taskId) }} />}
          <span>{task.goal}
            {task.financeLabel !== undefined && <small>{task.financeLabel}</small>}
            {dialog.candidates.some(other => other !== task && other.goal === task.goal && other.financeLabel === task.financeLabel)
              && <small>{task.taskId}</small>}
          </span>
        </label>)}
      </fieldset>
      <div className={css.formActions}>
        <Button onClick={dismiss} disabled={busy} data-modal-autofocus={single === undefined ? undefined : ''}>
          {t(proactive ? 'archive.chatReviewLater' : 'team.cancel')}
        </Button>
        <Button type="submit" variant="primary" disabled={busy || selected === undefined}>
          {t(busy ? 'archive.pending' : 'archive.accept')}
        </Button>
      </div>
    </form>
  </Modal>
}
