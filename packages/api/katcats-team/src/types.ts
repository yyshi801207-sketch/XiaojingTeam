/** Persistent Katcats members, logical groups, and Remote request values. */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Product-owned removal and organization refusal, suitable for localized recovery instructions. */
    'katcats/organization': { readonly reason: 'organization-unavailable' | 'delete-incomplete' | 'active-automations'
      | 'session-active' | 'bot-not-found' | 'bot-main' | 'bot-in-group' | 'bot-running' | 'chat-busy' }
  }
}

/** Member identity, independent of its current private conversation. */
export type BotId = Branded<'KatcatsBotId'>

/** Fixed Odoo company and ledger Bot, retaining the original setup assistant's identity. */
export const ledgerSetupBotId = brandString<BotId>('ledger-setup')
/** Fixed Odoo user and permissions Bot. */
export const odooAccessBotId = brandString<BotId>('odoo-access')

/**
 * Identify the two private Odoo administration Bots by their saved identities.
 * @param id Bot identity from the member directory.
 * @returns Whether the Bot has a fixed Odoo administration role.
 */
export function isOdooAdminBot(id: BotId): boolean {
  return id === ledgerSetupBotId || id === odooAccessBotId
}

/** Logical sidebar group identity; it does not name a filesystem workspace. */
export type GroupId = Branded<'KatcatsGroupId'>

/** Head-and-shoulders silhouette and independently chosen color, retaining existing saved shape identifiers. */
export interface BotAvatar {
  readonly shape: string
  readonly color: string
}

/** Follow the current DSH base at owned task admission, or retain an explicit per-member route. */
export type BotModel =
  | { readonly kind: 'follow-global' }
  | { readonly kind: 'override'; readonly provider: string; readonly model: string; readonly reasoningEffort?: string }

/** Finance templates that fix a Bot’s private query scope at creation. */
export const financeBotPresets = ['cashier', 'general-ledger', 'reporting', 'tax', 'cost', 'audit', 'analysis', 'documents'] as const

/** Stable identity of a dedicated finance template. */
export type FinanceBotPreset = typeof financeBotPresets[number]

/** Durable member record. Role changes apply at the next prompt assembly. */
export interface TeamBot {
  readonly id: BotId
  readonly kind: 'main' | 'ordinary'
  /** A creation-owned finance template for this Bot's private conversation. */
  readonly financePreset?: FinanceBotPreset
  readonly name: string
  readonly role: string
  readonly avatar: BotAvatar
  readonly model: BotModel
  readonly workDir: string
  readonly groupId: GroupId | null
  readonly sessionId: SessionId
}

/** Sidebar organization; system groups remain present even when empty. */
export interface TeamGroup {
  readonly id: GroupId
  readonly name: string
  readonly kind: 'bots' | 'chats'
  readonly system: boolean
}

/** Complete durable member directory exposed to the product UI. */
export interface TeamSnapshot {
  readonly revision: number
  readonly mainBotId: BotId
  readonly groups: readonly TeamGroup[]
  readonly bots: readonly TeamBot[]
  readonly modelCapabilities: { readonly override: boolean; readonly followGlobal: boolean }
}

/** Full replacement frame; consumers do not merge persisted member fields. */
export type TeamFrame =
  | { readonly type: 'snapshot'; readonly value: TeamSnapshot }
  | { readonly type: 'replace'; readonly value: TeamSnapshot }

/** Quick creation starts a general member without role or model setup. */
export interface CreateBotRequest {
  readonly name: string
  readonly groupId?: GroupId
  readonly avatar?: BotAvatar
}

/** Editable member settings; the P1 working directory remains creation-owned. */
export interface UpdateBotRequest {
  readonly id: BotId
  readonly name?: string
  readonly role?: string
  readonly avatar?: BotAvatar
  readonly model?: BotModel
  readonly groupId?: GroupId
}

/** Remove an idle ordinary Bot directory entry while retaining its private history and files. */
export interface DeleteBotRequest {
  readonly id: BotId
}

/** Creation of an ordinary member group. */
export interface CreateGroupRequest {
  readonly name: string
}

/** Rename one ordinary group. */
export interface UpdateGroupRequest {
  readonly id: GroupId
  readonly name: string
}

/** Move a custom group within the saved custom-group order, without crossing system groups. */
export interface MoveGroupRequest {
  readonly id: GroupId
  readonly direction: 'up' | 'down'
}

/** Remove a custom group after moving its chats and Bots to their respective system groups. */
export interface RemoveGroupRequest {
  readonly id: GroupId
}

/** Member mutation result with an immediately renderable directory snapshot. */
export interface BotMutationValue {
  readonly bot: TeamBot
  readonly snapshot: TeamSnapshot
}

/** Group mutation result with an immediately renderable directory snapshot. */
export interface GroupMutationValue {
  readonly group: TeamGroup
  readonly snapshot: TeamSnapshot
}
