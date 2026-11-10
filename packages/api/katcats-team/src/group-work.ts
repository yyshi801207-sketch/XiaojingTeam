/** Recorded group assignments and independent review required before formal delivery. */
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { BotId } from './types.ts'
import type { ChatDeliveryId } from './chats-types.ts'
import type { GroupReviewCandidate, GroupReviewPolicy, GroupReviewReceipt } from './group-review-types.ts'

/** An actual member's declared responsibilities for the current owner request. */
export interface GroupWorkPlan {
  readonly ownTask: string
  readonly assignments: readonly { readonly botId: BotId; readonly message: string }[]
  /** Absent only for work accepted under the legacy collaboration policy. */
  readonly review?: GroupReviewPolicy
}

const groupTools = new Set([
  'list_group_members', 'plan_group_work', 'request_group_member', 'set_group_roles', 'pass_group_turn',
  'remember', 'recall', 'forget', 'read_group_history', 'submit_group_review', 'report_group_blocker',
  'record_group_task', 'find_group_tasks',
])

/**
 * Admit draft preparation under the current policy and require saved evidence before delivery.
 * @param required - whether this delivery directly owns the user's substantive work decision.
 * @param eligible - other ordinary members available to the caller in this group.
 * @param options - current completion policy and delivery identity; omission preserves accepted legacy work.
 */
export class GroupWorkGate {
  private plan: GroupWorkPlan | undefined
  private readonly received = new Set<BotId>()
  private businessAttempted = false
  private candidate: GroupReviewCandidate | undefined
  private receipt: GroupReviewReceipt | undefined

  constructor(private readonly required: boolean, private readonly eligible: readonly BotId[],
    private readonly options?: { readonly policy: 'review-v1'; readonly deliveryId: ChatDeliveryId }) {}

  /** Candidate for the latest admitted review; absent before any review request. */
  get reviewCandidate(): GroupReviewCandidate | undefined { return this.candidate }

  /** Actual receipt for the latest candidate; absent until that child has durably answered. */
  get reviewReceipt(): GroupReviewReceipt | undefined { return this.receipt }

  /** Clear approval when a new review attempt is recorded, including one that later fails. */
  invalidateReview(): void { this.receipt = undefined }

  /**
   * Save the member's declared work split; the tool call and result retain the decision in its Session.
   * @param plan - concrete responsibilities for the caller and other current members.
   * @returns the admitted plan; this does not enqueue or complete any assignment.
   */
  decide(plan: GroupWorkPlan): GroupWorkPlan {
    if (plan.ownTask.trim().length === 0 || (this.options === undefined && plan.assignments.length === 0)
      || plan.assignments.some(task => !this.eligible.includes(task.botId) || task.message.trim().length === 0)
      || new Set(plan.assignments.map(task => task.botId)).size !== plan.assignments.length) {
      throw new HarnessError('Choose other current members and give each a concrete, distinct responsibility.', 'KATCATS_CHAT_INVALID_PLAN')
    }
    if (this.options !== undefined && (plan.review === undefined
      || (plan.review.reviewerBotId !== undefined && (!this.eligible.includes(plan.review.reviewerBotId) || plan.review.reason === 'none')))) {
      throw new HarnessError('Declare whether independent review is needed and choose another current member when available.', 'KATCATS_CHAT_INVALID_PLAN')
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
   * Bind a reviewer request to its exact host-captured draft, replacing earlier approval.
   * @param botId - current ordinary member selected in the plan.
   * @param candidate - content captured before accepting the child task.
   */
  beginReview(botId: BotId, candidate: GroupReviewCandidate): void {
    if (this.options === undefined || this.plan?.review === undefined || this.plan.review.reason === 'none'
      || this.plan.review.reviewerBotId !== botId || !this.eligible.includes(botId)) {
      throw new HarnessError('Choose the independent reviewer recorded in this task plan.', 'KATCATS_CHAT_INVALID_REVIEW')
    }
    this.candidate = candidate
    this.receipt = undefined
  }

  /**
   * Accept only a real saved result for this parent's latest candidate and declared reviewer.
   * @param receipt - completed child receipt whose ownership has been checked by the runtime.
   */
  receiveReview(receipt: GroupReviewReceipt): void {
    if (this.options === undefined || receipt.parentDeliveryId !== this.options.deliveryId
      || receipt.reviewerId !== this.plan?.review?.reviewerBotId || this.candidate?.version !== receipt.candidateVersion
      || receipt.deliveryId === receipt.parentDeliveryId) {
      throw new HarnessError('The review result does not belong to this task, reviewer, and candidate.', 'KATCATS_CHAT_INVALID_REVIEW')
    }
    this.receipt = receipt
  }

  /**
   * Refuse formal completion until required contributions and review are confirmed.
   * @param finalText - when supplied, the proposed final response; reviewed candidate text must remain unchanged.
   * @returns a corrective instruction, or undefined when structural completion evidence is sufficient.
   */
  completionDenial(finalText?: string): string | undefined {
    if (this.options === undefined) return undefined
    if (this.plan === undefined) {
      return this.required && this.businessAttempted
        ? 'Record a plan_group_work decision before delivering substantive group work.' : undefined
    }
    if (this.plan.assignments.some(task => !this.received.has(task.botId))) {
      return 'Obtain every assigned member result before delivering the final work.'
    }
    const review = this.plan.review
    if (review === undefined) return 'Record whether this task needs independent review.'
    if (review.reason === 'none') return undefined
    if (review.reviewerBotId === undefined) return 'Independent review is required but no reviewer is selected. The deliverable remains pending review.'
    if (this.receipt?.verdict !== 'approved') {
      return this.receipt?.verdict === 'changes_requested'
        ? 'Address the reviewer findings and request a new review of the revised candidate before final delivery.'
        : 'Request the recorded reviewer with review_candidate and obtain an actual approved review before final delivery.'
    }
    if (finalText !== undefined && this.candidate !== undefined && this.candidate.text !== null
      && finalText.trim() !== this.candidate.text.trim()) {
      return 'Deliver the exact reviewed text or submit the revised text for another independent review.'
    }
    return undefined
  }

  /**
   * Require a work decision before draft tools and completion evidence before presentation.
   * Modern tasks may clarify the owner's requirements before recording that decision.
   * Accepted legacy work retains its earlier requirement for member replies before business tools.
   * @param tool - actual tool about to execute in this member's scope.
   * @returns a model-visible refusal, or undefined when execution may proceed.
   */
  denial(tool: string): string | undefined {
    if (groupTools.has(tool)) return undefined
    if (this.options !== undefined) {
      if (tool === 'ask_user_question') return undefined
      this.businessAttempted = true
      if (this.required && this.plan === undefined) return 'First record plan_group_work with the task scope and review reason. Draft preparation is allowed after that decision.'
      return tool === 'present' ? this.completionDenial() : undefined
    }
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
