/** Real group-member tools whose delegation results contain saved member replies. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool, TOOL_ABORTED, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ChatDeliveryId, ChatFailure, UpdateChatRolesRequest } from './chats-types.ts'
import type { BotId } from './types.ts'
import type { GroupWorkPlan } from './group-work.ts'
import type { GroupReviewCandidate, GroupReviewCandidateRequest, GroupReviewReceipt } from './group-review-types.ts'
import type { GroupHistoryQuery, GroupHistoryResult } from './group-context.ts'
import { createGroupHistoryTool } from './group-history-tool.ts'
import { createGroupTicketTool } from './group-ticket-tool.ts'
import type { GroupTicket, RecordGroupTicket } from './group-tickets.ts'

const reviewPolicy = { type: 'object', additionalProperties: false, properties: {
  reason: { type: 'string', enum: ['none', 'financial-conclusion', 'data-change', 'explicit-review'], required: true },
  reviewer_bot_id: { type: 'string' },
} } as const
const reviewCandidate = { type: 'object', additionalProperties: false, properties: {
  version: { type: 'string', required: true }, text: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
  files: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    path: { type: 'string', required: true }, sha256: { type: 'string', required: true },
  } } },
} } as const
const reviewReceipt = { type: 'object', additionalProperties: false, properties: {
  parentDeliveryId: { type: 'string', required: true }, deliveryId: { type: 'string', required: true },
  reviewerId: { type: 'string', required: true }, candidateVersion: { type: 'string', required: true },
  verdict: { type: 'string', enum: ['approved', 'changes_requested'], required: true },
  findings: { type: 'string', required: true },
} } as const

/** Runtime-owned authorization and group mutations for the exact currently executing member. */
export interface GroupMemberToolActions {
  /** Search saved task descriptions inside this group; omitted only for legacy registrations. */
  findTickets?(query: string, exec: ToolRunContext): Promise<string>
  /** Classify direct owner messages; omitted only for legacy tool registrations. */
  recordTicket?(request: RecordGroupTicket, exec: ToolRunContext): Promise<GroupTicket>
  /** Reject a foreign Agent, stale generation, inactive member, or ended worker execution. */
  authorize(exec: ToolRunContext): void
  /** Read this group's current member identities and group-specific responsibilities. */
  list(exec: ToolRunContext): Promise<{ members: { bot_id: string; name: string; role: string; is_manager: boolean }[] }>
  /** Record the current member's work split; each actual request is a separate tool call with its own identity. */
  plan(request: GroupWorkPlan, exec: ToolRunContext): Promise<{
    chat_id: string
    own_task: string
    assignments: { bot_id: string; message: string }[]
    review?: { reason: 'none' | 'financial-conclusion' | 'data-change' | 'explicit-review'; reviewer_bot_id?: string }
  }>
  /** Save only the group settings explicitly requested by the owner in this group's conversation. */
  setRoles(request: UpdateChatRolesRequest, exec: ToolRunContext): Promise<{
    chat_id: string
    manager_id: string
    roles: { bot_id: string; role: string }[]
  }>
  /** Execute another available member and return only after its actual reply is saved in the group. */
  request(botId: string, message: string, exec: ToolRunContext, reviewCandidate?: GroupReviewCandidateRequest): Promise<{
    chat_id: string
    delivery_id: string
    bot_id: string
    status: 'completed' | 'passed' | 'failed'
    reply: string | null
    message_id: string | null
    review_candidate?: GroupReviewCandidate
    review?: GroupReviewReceipt
    error?: ChatFailure
  }>
  /** End this task with a recorded blocker, never a successful or approved deliverable. */
  reportBlocker?(exec: ToolRunContext): ChatDeliveryId
  /** Record a verdict only for the actual current review child; omitted for legacy registrations. */
  submitReview?(request: { verdict: 'approved' | 'changes_requested'; findings: string }, exec: ToolRunContext): Promise<GroupReviewReceipt>
  /** Retrieve bounded public history; omitted when this legacy worker has no history capability. */
  history?(query: GroupHistoryQuery, exec: ToolRunContext): Promise<GroupHistoryResult>
  /** Confirm a pass for this delivery, rejecting when the owner directly addressed this member. */
  pass(exec: ToolRunContext): Promise<ChatDeliveryId>
}

function fields(args: object, allowed: readonly string[]): void {
  if (Object.keys(args).some(key => !allowed.includes(key))) {
    throw new HarnessError('Supply only the declared group-tool fields.', 'KATCATS_CHAT_INVALID_INPUT')
  }
}

function text(value: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new HarnessError('Provide a non-empty member identity or instruction.', 'KATCATS_CHAT_INVALID_INPUT')
  return normalized
}

/**
 * Register tools in one actual group worker's scope; execution callbacks recheck its current delivery.
 * @param agent - the live member Agent whose scope owns these registrations.
 * @param actions - current-delivery authority and durable group operations, including member-result waits.
 * @returns disposer releasing every registration, including after partial registration failure.
 */
export function registerGroupMemberTools(agent: Agent, actions: GroupMemberToolActions): () => void {
  const admit = (exec: ToolRunContext) => {
    actions.authorize(exec)
    exec.signal.throwIfAborted()
  }
  const definitions = [defineTool({
    name: 'pass_group_turn',
    description: 'Choose not to speak when this group message does not need your contribution. Do not pass when the user directly addresses you. A successful pass ends only your current member turn and creates no spoken group reply.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        kind: { type: 'string', required: true }, deliveryId: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => value,
    },
    execute: async (args, exec) => {
      admit(exec)
      fields(args, [])
      const deliveryId = await actions.pass(exec)
      exec.concludeTurn()
      return { kind: 'katcats-group-pass', deliveryId }
    },
    presentCall: () => ({ card: 'generic', title: 'Pass this group turn', kind: 'read' }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'Pass was not confirmed' : 'Group turn passed', content: result.content }),
  }), defineTool({
    name: 'list_group_members',
    description: 'Read only this group\'s current member identities, group responsibilities, and optional responsible member before addressing another member.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        members: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          bot_id: { type: 'string', required: true }, name: { type: 'string', required: true }, role: { type: 'string', required: true },
          is_manager: { type: 'boolean', required: true },
        } } },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => value,
    },
    execute: (args, exec) => {
      admit(exec)
      fields(args, [])
      return actions.list(exec)
    },
    presentCall: () => ({ card: 'generic', title: 'Read group members', kind: 'read' }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'Group could not be read' : 'Group members', content: result.content }),
  }), defineTool({
    name: 'plan_group_work',
    description: 'Record the task scope, useful assignments, and independent-review decision before substantive group work. For a continuation, first use record_group_task with the existing task_id; otherwise this plan creates a business task for an unclassified direct owner message, with acceptance criteria still unspecified. Empty assignments are valid when colleagues are unnecessary. Financial conclusions, data modifications, and explicitly requested reviews need an independent reviewer. Prepare draft files after recording the plan, then request review of the exact candidate before final delivery. A recorded plan alone does not assign anyone. Use a separate step for planning or member requests. Simple conversational answers need no plan.',
    parameters: {
      own_task: { type: 'string', required: true, description: 'Your own preparation, execution, and integration responsibilities.' },
      review: { ...reviewPolicy, description: 'Required for new substantive group work; none for ordinary tasks. Omit the reviewer only when none is available, leaving important delivery pending review.' },
      assignments: { type: 'array', required: true, items: {
        type: 'object', additionalProperties: false, properties: {
          bot_id: { type: 'string', required: true }, message: { type: 'string', required: true },
        },
      } },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        chat_id: { type: 'string', required: true }, own_task: { type: 'string', required: true },
        review: reviewPolicy,
        assignments: { type: 'array', required: true, items: {
          type: 'object', additionalProperties: false, properties: {
            bot_id: { type: 'string', required: true }, message: { type: 'string', required: true },
          },
        } },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => value,
    },
    execute: (args, exec) => {
      admit(exec)
      fields(args, ['own_task', 'assignments', 'review'])
      return actions.plan({ ownTask: text(args.own_task), assignments: args.assignments.map((task) => {
        fields(task, ['bot_id', 'message'])
        return { botId: brandString<BotId>(text(task.bot_id)), message: text(task.message) }
      }), ...(args.review === undefined ? {} : { review: { reason: args.review.reason,
        ...(args.review.reviewer_bot_id === undefined ? {}
          : { reviewerBotId: brandString<BotId>(text(args.review.reviewer_bot_id)) }) } }) }, exec)
    },
    presentCall: () => ({ card: 'generic', title: 'Plan group responsibilities', kind: 'edit' }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'Group work split was not confirmed' : 'Group work split recorded', content: result.content }),
  }), defineTool({
    name: 'set_group_roles',
    description: 'Save group responsibilities or the optional responsible member only when the user explicitly requests that change in this group. Read member IDs first. This never changes private identities, permissions, or other groups. Claim saved changes only after this tool succeeds.',
    parameters: {
      manager_id: { type: 'string', description: 'Current group member ID to appoint, or empty text to clear the manager. Omit to preserve it.' },
      roles: { type: 'array', description: 'Responsibilities to add or replace for these members; preserve other members.', items: {
        type: 'object', additionalProperties: false, properties: {
          bot_id: { type: 'string', required: true }, role: { type: 'string', required: true },
        },
      } },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        chat_id: { type: 'string', required: true }, manager_id: { type: 'string', required: true },
        roles: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          bot_id: { type: 'string', required: true }, role: { type: 'string', required: true },
        } } },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => value,
    },
    execute: (args, exec) => {
      admit(exec)
      fields(args, ['manager_id', 'roles'])
      if (args.manager_id === undefined && (args.roles === undefined || args.roles.length === 0)) {
        throw new HarnessError('Provide a group manager or at least one responsibility.', 'KATCATS_CHAT_INVALID_INPUT')
      }
      return actions.setRoles({
        ...(args.manager_id === undefined ? {} : { managerId: args.manager_id.trim() === '' ? null : brandString<BotId>(text(args.manager_id)) }),
        ...(args.roles === undefined ? {} : { memberRoles: args.roles.map((member) => {
          fields(member, ['bot_id', 'role'])
          return { botId: brandString<BotId>(text(member.bot_id)), role: text(member.role) }
        }) }),
      }, exec)
    },
    presentCall: () => ({ card: 'generic', title: 'Set group responsibilities', kind: 'edit' }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'Group responsibilities were not confirmed' : 'Group responsibilities saved', content: result.content }),
    finalizeContent: (exec, result) => result.isError && (exec.signal.aborted || result.error.info?.code === TOOL_ABORTED)
      ? [{ type: 'text', text: 'The request was stopped. Responsibilities may already have been saved; inspect group settings before retrying.' }]
      : undefined,
  }), defineTool({
    name: 'request_group_member',
    description: 'Assign a concrete question or task to another available group member and wait for their actual result. The assignment and real reply appear in this group. Use a separate step for delegation; prepare any input files in an earlier step and do not call other tools in the delegation step. A completed result includes the saved reply; passed means no answer was supplied. Read the result in your next step before creating dependent files or claiming completion. Do not request a busy member that is waiting for your result: finish your reply to return it to them. Inspect the group before retrying an uncertain request.',
    parameters: {
      bot_id: { type: 'string', required: true, description: 'Member identity from list_group_members.' },
      message: { type: 'string', required: true, description: 'Concrete question or task for that member.' },
      review_candidate: { type: 'object', additionalProperties: false, description: 'For independent review only: exact draft text and/or existing files inside this group working directory.', properties: {
        text: { type: 'string' }, files: { type: 'array', items: { type: 'string' } },
      } },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        chat_id: { type: 'string', required: true }, delivery_id: { type: 'string', required: true },
        bot_id: { type: 'string', required: true }, status: { type: 'string', enum: ['completed', 'passed', 'failed'], required: true },
        reply: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        message_id: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        review_candidate: reviewCandidate, review: reviewReceipt,
        error: { type: 'object', additionalProperties: false, properties: {
          code: { type: 'string', required: true }, message: { type: 'string', required: true },
        } },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => value,
    },
    execute: async (args, exec) => {
      admit(exec)
      fields(args, ['bot_id', 'message', 'review_candidate'])
      const candidate = args.review_candidate
      if (candidate?.text !== undefined) text(candidate.text)
      const result = await actions.request(text(args.bot_id), text(args.message), exec, candidate === undefined ? undefined : {
        ...(candidate.text === undefined ? {} : { text: candidate.text }),
        ...(candidate.files === undefined ? {} : { files: candidate.files.map(text) }),
      })
      const { review_candidate: savedCandidate, ...rest } = result
      return { ...rest, ...(savedCandidate === undefined ? {} : { review_candidate: {
        ...savedCandidate, files: savedCandidate.files.map(file => ({ ...file })),
      } }) }
    },
    presentCall: () => ({ card: 'generic', title: 'Request group member', kind: 'edit' }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'Member result was not confirmed' : 'Member result received', content: result.content }),
    finalizeContent: (exec, result) => result.isError && (exec.signal.aborted || result.error.info?.code === TOOL_ABORTED)
      ? [{ type: 'text', text: 'The request was stopped. The member may have started or completed work; inspect the group before retrying.' }]
      : undefined,
  })]
  const reportBlocker = actions.reportBlocker?.bind(actions)
  if (reportBlocker !== undefined) definitions.push(defineTool({
    name: 'report_group_blocker',
    description: 'End your current task as NOT completed when permissions, authentication, missing inputs, unavailable members, failed dependencies or incomplete review prevent delivery. Briefly explain the blocker to the user first. State evidence, known effects and a safe next step; do not claim an unreviewed conclusion or file as approved. This never approves review or retries an operation. Unknown external effects require inspection before retrying.',
    parameters: {
      reason: { type: 'string', required: true },
      next_step: { type: 'string', required: true },
      effects: { type: 'string', enum: ['none', 'partial', 'unknown'], required: true },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', required: true }, deliveryId: { type: 'string', required: true },
      reason: { type: 'string', required: true }, next_step: { type: 'string', required: true },
      effects: { type: 'string', enum: ['none', 'partial', 'unknown'], required: true },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    presentationMeta: (_args, value) => value },
    execute: (args, exec) => {
      admit(exec)
      fields(args, ['reason', 'next_step', 'effects'])
      const result = { kind: 'katcats-group-blocker', deliveryId: reportBlocker(exec),
        reason: text(args.reason), next_step: text(args.next_step), effects: args.effects }
      exec.concludeTurn()
      return Promise.resolve(result)
    },
    presentCall: () => ({ card: 'generic', title: 'Report group task blocker', kind: 'read' }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'Blocker report failed' : 'Task remains incomplete', content: result.content }),
  }))
  const submitReview = actions.submitReview?.bind(actions)
  if (submitReview !== undefined) definitions.push(defineTool({
    name: 'submit_group_review',
    description: 'Record your independent review of the exact candidate assigned to this review task. Inspect the original evidence and files. Use approved only when no blocking issues remain; otherwise use changes_requested with concrete findings. This does not approve another task or another draft version. Finish with your actual review reply after this succeeds.',
    parameters: { verdict: { type: 'string', enum: ['approved', 'changes_requested'], required: true },
      findings: { type: 'string', required: true } },
    output: { schema: reviewReceipt, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => value },
    execute: (args, exec) => {
      admit(exec)
      fields(args, ['verdict', 'findings'])
      return submitReview({ verdict: args.verdict, findings: text(args.findings) }, exec)
    },
    presentCall: () => ({ card: 'generic', title: 'Submit independent review', kind: 'edit' }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'Review was not confirmed' : 'Independent review recorded', content: result.content }),
  }))
  const history = actions.history?.bind(actions)
  if (history !== undefined) definitions.push(createGroupHistoryTool(admit, history))
  const recordTicket = actions.recordTicket?.bind(actions)
  if (recordTicket !== undefined) definitions.push(createGroupTicketTool(admit, recordTicket))
  const findTickets = actions.findTickets?.bind(actions)
  if (findTickets !== undefined) definitions.push(defineTool({
    name: 'find_group_tasks',
    description: 'Find saved business tasks in this group by task ID or goal keyword. Empty query returns the most recently updated tasks. Results are bounded by the configured history page size; narrow the query when more matches remain. Use original message IDs with read_group_history to verify facts, not task descriptions alone.',
    parameters: { query: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.result }], presentationMeta: (_args, value) => value },
    execute: async (args, exec) => { admit(exec); fields(args, ['query']); return { result: await findTickets(args.query, exec) } },
    presentCall: () => ({ card: 'generic', title: 'Find group tasks', kind: 'read' }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'Tasks could not be read' : 'Saved group tasks', content: result.content }),
  }))
  const removals: (() => void)[] = []
  const dispose = () => { for (const remove of removals.splice(0).reverse()) remove() }
  try {
    for (const definition of definitions) removals.push(agent.ctx.tools.register(definition))
  } catch (error) {
    dispose()
    throw error
  }
  return dispose
}
