/** Serial coordination of product membership and shared sidebar groups. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { BotId, GroupId } from './types.ts'
import type { ChatId } from './chats-types.ts'
import type {} from '@deepseek-ai/dsh-workspace'

/** Group-directory operations called outside the Team mutation queue. */
export interface GroupOrganizationParticipant {
  /** Read current group memberships after finishing accepted settings. */
  memberships(botId: BotId): Promise<readonly ChatId[]>
  /** Move all chats out of one custom group in one durable write. */
  moveGroup(groupId: GroupId): Promise<void>
}

/** One product instance's ordering of cross-directory mutations; snapshots never acquire it. */
export class GroupOrganization {
  private tail: Promise<void> = Promise.resolve()
  private participant: GroupOrganizationParticipant | undefined

  /**
   * Register the product group directory for cross-directory mutations.
   * @param participant - live group directory operations.
   * @returns disposer that removes this registration.
   */
  register(participant: GroupOrganizationParticipant): () => void {
    if (this.participant !== undefined) throw new Error('The group directory is already registered')
    this.participant = participant
    return () => { if (this.participant === participant) this.participant = undefined }
  }

  /**
   * Queue a membership or shared-group operation before either directory queue.
   * @param operation - mutation that must not recursively acquire this queue.
   * @returns the operation result, preserving failures without blocking later work.
   */
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => {}, () => {})
    return result
  }

  /** Read the required live group directory; absence cannot be treated as an empty directory. */
  get chats(): GroupOrganizationParticipant {
    if (this.participant === undefined) {
      throw new RemoteError('katcats/organization', 'Reopen the team before changing its organization.', { reason: 'organization-unavailable' })
    }
    return this.participant
  }
}

/**
 * Hide exact owned Sessions while retaining their history, files, and existing archive choices.
 * @param ctx - product context with the public Workspace registry.
 * @param sessionIds - owned private or group Sessions to archive.
 * @returns rollback of only the archive entries created by this operation.
 */
export async function archiveOwnedSessions(ctx: Context, sessionIds: readonly SessionId[]): Promise<() => Promise<void>> {
  const added: SessionId[] = []
  const pinned = ctx.workspaceRegistry.pinnedSessionIds.filter(id => sessionIds.includes(id))
  const rollback = async () => {
    for (const id of added.toReversed()) await ctx.workspaceRegistry.unarchiveSession(id)
    for (const id of pinned.toReversed()) await ctx.workspaceRegistry.pinSession(id)
  }
  try {
    for (const id of sessionIds) {
      if (ctx.workspaceRegistry.archivedSessionIds.includes(id)) continue
      await ctx.workspaceRegistry.archiveSession(id)
      added.push(id)
    }
  } catch (error) {
    try { await rollback() } catch (rollbackError) {
      throw new RemoteError('katcats/organization', 'Deletion is incomplete. The item and its history are retained; reopen the team before retrying.',
        { reason: 'delete-incomplete' }, { cause: rollbackError })
    }
    throw error
  }
  return rollback
}

/**
 * Reject deletion while persistent automation or other activity still targets an owned Session.
 * @param ctx - product context providing Workspace archive admission.
 * @param sessionIds - exact owned Session identities.
 * @param automationsOnly - before group stop, reject schedules while permitting its own running turns.
 * @returns resolution when no selected activity provider reports active work.
 */
export async function requireInactiveSessions(ctx: Context, sessionIds: readonly SessionId[], automationsOnly = false): Promise<void> {
  for (const sessionId of sessionIds) {
    const activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
    const scheduled = activity.some((item: { readonly kind: string }) => item.kind === 'schedule')
    if (automationsOnly ? scheduled : activity.length > 0) {
      throw new RemoteError('katcats/organization', 'Stop this item\'s active tasks before deleting it.', {
        reason: scheduled ? 'active-automations' : 'session-active',
      })
    }
  }
}
