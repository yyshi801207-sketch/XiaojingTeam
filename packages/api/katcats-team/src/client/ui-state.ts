/** Shared viewing state for the team sidebar and its frame-owned dialogs. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { BotId, GroupId, MoveGroupRequest, TeamGroup } from '../types.ts'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ChatId, GroupTicketId } from '../chats-types.ts'
import type { TeamKey } from './locales.ts'

/** Captured list identity for one explicit rename or deletion action. */
export type TeamEntity =
  | { readonly kind: 'bot'; readonly id: BotId; readonly name: string }
  | { readonly kind: 'chat'; readonly id: ChatId; readonly name: string }

/** Exact delivered revision displayed for a human decision. */
export interface TaskAcceptanceCandidate {
  readonly taskId: GroupTicketId
  readonly goal: string
  readonly revision: number
  readonly financeLabel?: string
}

/** An explicit create action; closing it never invokes a member mutation. */
export type TeamDialog =
  | { readonly kind: 'bot'; readonly groupId: GroupId | undefined; readonly key: number }
  | { readonly kind: 'group'; readonly key: number; readonly group?: TeamGroup }
  | { readonly kind: 'remove-group'; readonly key: number; readonly group: TeamGroup }
  | { readonly kind: 'rename-entity' | 'delete-entity'; readonly key: number; readonly entity: TeamEntity }
  | { readonly kind: 'chat'; readonly key: number }
  | { readonly kind: 'accept-task'; readonly key: number; readonly requestId?: SessionRequestId;
    readonly chatId: ChatId; readonly candidates: readonly TaskAcceptanceCandidate[] }

/** Local UI state, independent from the durable directory. */
export interface TeamUiState {
  readonly dialog: TeamDialog | null
  readonly notice: { readonly id: number; readonly key: TeamKey; readonly name?: string; readonly success: boolean } | null
}

/**
 * Allocate one plugin-owned source for transient surface requests.
 * @returns Source and narrow actions; components read the source only through injected hooks.
 */
export function createTeamUi(): {
  source: SnapshotStore<TeamUiState>
  createBot: (groupId?: GroupId) => void
  createGroup: () => void
  createChat: () => void
  renameGroup: (group: TeamGroup) => void
  removeGroup: (group: TeamGroup) => void
  renameEntity: (entity: TeamEntity) => void
  deleteEntity: (entity: TeamEntity) => void
  chooseTaskAcceptance: (chatId: ChatId, candidates: readonly TaskAcceptanceCandidate[], requestId?: SessionRequestId) => void
  closeDialog: () => void
  notify: (key: TeamKey, success: boolean, name?: string) => void
  dismissNotice: (id: number) => void
} {
  const source = createSnapshotStore<TeamUiState>({ dialog: null, notice: null })
  let sequence = 0
  return {
    source,
    createBot: (groupId?: GroupId): void => {
      if (source.getSnapshot().dialog !== null) return
      source.set({ ...source.getSnapshot(), dialog: { kind: 'bot', groupId, key: ++sequence } })
    },
    createGroup: (): void => {
      if (source.getSnapshot().dialog !== null) return
      source.set({ ...source.getSnapshot(), dialog: { kind: 'group', key: ++sequence } })
    },
    createChat: (): void => {
      if (source.getSnapshot().dialog !== null) return
      source.set({ ...source.getSnapshot(), dialog: { kind: 'chat', key: ++sequence } })
    },
    renameGroup: (group: TeamGroup): void => {
      if (source.getSnapshot().dialog !== null) return
      source.set({ ...source.getSnapshot(), dialog: { kind: 'group', key: ++sequence, group } })
    },
    removeGroup: (group: TeamGroup): void => {
      if (source.getSnapshot().dialog !== null) return
      source.set({ ...source.getSnapshot(), dialog: { kind: 'remove-group', key: ++sequence, group } })
    },
    renameEntity: (entity: TeamEntity): void => {
      if (source.getSnapshot().dialog !== null) return
      source.set({ ...source.getSnapshot(), dialog: { kind: 'rename-entity', key: ++sequence, entity } })
    },
    deleteEntity: (entity: TeamEntity): void => {
      if (source.getSnapshot().dialog !== null) return
      source.set({ ...source.getSnapshot(), dialog: { kind: 'delete-entity', key: ++sequence, entity } })
    },
    chooseTaskAcceptance: (chatId, candidates, requestId): void => {
      if (source.getSnapshot().dialog !== null) return
      source.set({ ...source.getSnapshot(), dialog: { kind: 'accept-task', key: ++sequence, chatId, candidates,
        ...(requestId === undefined ? {} : { requestId }) } })
    },
    closeDialog: (): void => { source.set({ ...source.getSnapshot(), dialog: null }) },
    notify: (key: TeamKey, success: boolean, name?: string): void => {
      source.set({ ...source.getSnapshot(), notice: { id: ++sequence, key, success, ...(name === undefined ? {} : { name }) } })
    },
    dismissNotice: (id: number): void => {
      if (source.getSnapshot().notice?.id === id) source.set({ ...source.getSnapshot(), notice: null })
    },
  }
}

/** Narrow commands consumed by the sidebar. */
export interface TeamSidebarActions {
  readonly createBot: (groupId?: GroupId) => void
  readonly createGroup: () => void
  readonly renameGroup: (group: TeamGroup) => void
  readonly removeGroup: (group: TeamGroup) => void
  readonly moveGroup: (request: MoveGroupRequest) => Promise<void>
  readonly openBot: (id: BotId) => void
  readonly moveBot: (id: BotId, groupId: GroupId) => Promise<void>
  readonly createChat: () => void
  readonly openChat: (id: ChatId) => void
  readonly retry: () => void
}
