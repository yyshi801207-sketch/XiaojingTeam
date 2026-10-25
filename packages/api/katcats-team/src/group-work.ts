/** Delegated work required before a member independently executes a group-wide task. */
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { BotId } from './types.ts'

/** An actual member's declared responsibilities for the current owner request. */
export interface GroupWorkPlan {
  readonly ownTask: string
  readonly assignments: readonly { readonly botId: BotId; readonly message: string }[]
}

const groupTools = new Set([
  'list_group_members', 'plan_group_work', 'request_group_member', 'set_group_roles', 'pass_group_turn',
  'remember', 'recall', 'forget',
])

/**
 * Require actual member results before business tools, without manufacturing member tasks or replies.
 * @param required - whether this is an owner request to a multi-member group rather than one explicit member.
 * @param eligible - other ordinary members available to the caller in this group.
 */
export class GroupWorkGate {
  private plan: GroupWorkPlan | undefined
  private readonly received = new Set<BotId>()

  constructor(private readonly required: boolean, private readonly eligible: readonly BotId[]) {}

  /**
   * Save the member's declared work split; the tool call and result retain the decision in its Session.
   * @param plan - concrete responsibilities for the caller and other current members.
   * @returns the admitted plan; this does not enqueue or complete any assignment.
   */
  decide(plan: GroupWorkPlan): GroupWorkPlan {
    if (plan.ownTask.trim().length === 0 || plan.assignments.length === 0
      || plan.assignments.some(task => !this.eligible.includes(task.botId) || task.message.trim().length === 0)
      || new Set(plan.assignments.map(task => task.botId)).size !== plan.assignments.length) {
      throw new HarnessError('Choose other current members and give each a concrete, distinct responsibility.', 'KATCATS_CHAT_INVALID_PLAN')
    }
    if (this.plan !== undefined && JSON.stringify(this.plan) !== JSON.stringify(plan)) {
      throw new HarnessError('This work split is already recorded. A new owner instruction can change the task.', 'KATCATS_CHAT_INVALID_PLAN')
    }
    this.plan = plan
    return plan
  }

  /**
   * Count only a completed reply already published in this group's transcript.
   * @param botId - exact member whose real result has been durably received.
   */
  receive(botId: BotId): void {
    this.received.add(botId)
  }

  /**
   * Refuse business tools until declared assignments, or a direct delegated contribution, have real results.
   * Registering existing final files does not require new delegation; a declared plan must still finish first.
   * @param tool - actual tool about to execute in this member's scope.
   * @returns a model-visible refusal, or undefined when execution may proceed.
   */
  denial(tool: string): string | undefined {
    if (groupTools.has(tool)) return undefined
    if (this.plan !== undefined) {
      if (this.plan.assignments.some(task => !this.received.has(task.botId))) {
        return 'Request every member in your recorded work split and wait for their actual replies before using business tools.'
      }
      return undefined
    }
    if (this.required && this.received.size === 0 && tool !== 'present') {
      return 'This is work for the group. First use plan_group_work to split responsibilities, then request_group_member to obtain actual contributions. Do not do the entire task alone. Simple conversational replies need no tools.'
    }
    return undefined
  }
}
