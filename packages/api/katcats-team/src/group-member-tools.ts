/** Real group-member tools whose delegation results contain saved member replies. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool, TOOL_ABORTED, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ChatDeliveryId, UpdateChatRolesRequest } from './chats-types.ts'
import type { BotId } from './types.ts'
import type { GroupWorkPlan } from './group-work.ts'

/** Runtime-owned authorization and group mutations for the exact currently executing member. */
export interface GroupMemberToolActions {
  /** Reject a foreign Agent, stale generation, inactive member, or ended worker execution. */
  authorize(exec: ToolRunContext): void
  /** Read this group's current member identities and group-specific responsibilities. */
  list(exec: ToolRunContext): Promise<{ members: { bot_id: string; name: string; role: string; is_manager: boolean }[] }>
  /** Record the current member's work split; each actual request is a separate tool call with its own identity. */
  plan(request: GroupWorkPlan, exec: ToolRunContext): Promise<{
    chat_id: string
    own_task: string
    assignments: { bot_id: string; message: string }[]
  }>
  /** Save only the group settings explicitly requested by the owner in this group's conversation. */
  setRoles(request: UpdateChatRolesRequest, exec: ToolRunContext): Promise<{
    chat_id: string
    manager_id: string
    roles: { bot_id: string; role: string }[]
  }>
  /** Execute another available member and return only after its actual reply is saved in the group. */
  request(botId: string, message: string, exec: ToolRunContext): Promise<{
    chat_id: string
    delivery_id: string
    bot_id: string
    status: 'completed' | 'passed'
    reply: string | null
    message_id: string | null
  }>
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
    description: 'Record your work split for a task addressed to the group. Read the current roster and choose colleagues whose roles fit the task. For a complex deliverable, give each relevant colleague a useful independent part and keep integration as your own responsibility. This only records your plan: in a subsequent step call request_group_member separately for each assignment, await their actual results, then produce the final deliverable. Do not combine the plan or member requests with business tools in one step. Simple greetings and direct conversational answers need no plan.',
    parameters: {
      own_task: { type: 'string', required: true, description: 'The part you will perform after receiving your colleagues\' results.' },
      assignments: { type: 'array', required: true, items: {
        type: 'object', additionalProperties: false, properties: {
          bot_id: { type: 'string', required: true }, message: { type: 'string', required: true },
        },
      } },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        chat_id: { type: 'string', required: true }, own_task: { type: 'string', required: true },
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
      fields(args, ['own_task', 'assignments'])
      return actions.plan({ ownTask: text(args.own_task), assignments: args.assignments.map((task) => {
        fields(task, ['bot_id', 'message'])
        return { botId: brandString<BotId>(text(task.bot_id)), message: text(task.message) }
      }) }, exec)
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
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        chat_id: { type: 'string', required: true }, delivery_id: { type: 'string', required: true },
        bot_id: { type: 'string', required: true }, status: { type: 'string', enum: ['completed', 'passed'], required: true },
        reply: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        message_id: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => value,
    },
    execute: (args, exec) => {
      admit(exec)
      fields(args, ['bot_id', 'message'])
      return actions.request(text(args.bot_id), text(args.message), exec)
    },
    presentCall: () => ({ card: 'generic', title: 'Request group member', kind: 'edit' }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'Member result was not confirmed' : 'Member result received', content: result.content }),
    finalizeContent: (exec, result) => result.isError && (exec.signal.aborted || result.error.info?.code === TOOL_ABORTED)
      ? [{ type: 'text', text: 'The request was stopped. The member may have started or completed work; inspect the group before retrying.' }]
      : undefined,
  })]
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
