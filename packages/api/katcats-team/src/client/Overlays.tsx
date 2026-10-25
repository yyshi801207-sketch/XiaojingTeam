/** Frame-owned creation and outcome surfaces survive sidebar and Session changes. */
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { CreateBotRequest, RemoveGroupRequest, UpdateGroupRequest } from '../types.ts'
import type { TeamEntity, TeamUiState } from './ui-state.ts'
import { CreateBot, CreateGroup } from './CreateBot.tsx'
import { RemoveGroup } from './RemoveGroup.tsx'
import { DeleteEntity, RenameEntity } from './EntityDialogs.tsx'

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
  renameEntity, deleteEntity, dismissNotice, t }: TeamOverlaysProps) {
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
    {notice !== null && <Toast key={notice.id} text={t(notice.key, notice.name === undefined ? undefined : { name: notice.name })}
      {...notice.success ? { tone: 'success' } : {}} onDone={() => { dismissNotice(notice.id) }} />}
  </>
}
