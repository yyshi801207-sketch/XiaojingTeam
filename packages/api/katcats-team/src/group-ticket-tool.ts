/** Group-local task classification with a logged, durable result. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { GroupTicket, GroupTicketId, RecordGroupTicket } from './group-tickets.ts'

/**
 * Describe business work without changing the execution loop or approving delivery.
 * @param admit - validate the current member and cancellation before a mutation.
 * @param record - save a classification under the directory's serialized authority.
 * @returns scoped tool definition; its result is retained by the ordinary tool log.
 */
export function createGroupTicketTool(admit: (exec: ToolRunContext) => void,
  record: (request: RecordGroupTicket, exec: ToolRunContext) => Promise<GroupTicket>): ToolDefinition {
  return defineTool({
    name: 'record_group_task',
    description: 'Before substantive work, record the business goal, concrete acceptance criteria, current stage and next step. For a correction or continuation of an existing task, supply its task_id from the task index; otherwise omit task_id to create work. Never infer association from identical wording or simply choose the latest task. Ask the owner if ambiguous. Only a direct recipient can classify the current owner message; delegated members inherit that task. The result provides original message IDs: query read_group_history before relying on earlier numbers or decisions. An ordinary record only describes work. If an older task has empty criteria, first record criteria with its task_id and without submit_delivery. When the saved criteria have actually been met and all review and file presentation have finished, call again with the same task_id, unchanged goal and criteria, and submit_delivery: true, then give the final answer. The task completes after the successful result is published, unless human_review_required explicitly requires owner acceptance. Do not create a new task for an acceptance-only message; use accept_group_task when the owner clearly accepts an existing delivery.',
    parameters: {
      task_id: { type: 'string', description: 'Existing business task in this group. Omit to create work or update the current message\'s saved task.' },
      take_over_owner: { type: 'boolean', description: 'Only the current group manager may set true after the human explicitly authorizes taking over this exact unfinished task from an owner who left the group. Keep its goal and existing non-empty criteria unchanged. Do not submit in this call. Ask for confirmation if the human has not authorized the transfer.' },
      owner_transfer_quote: { type: 'string', description: 'Required with take_over_owner: full original text of the current human message authorizing the manager to take over. Do not quote only a fragment.' },
      submit_delivery: { type: 'boolean', description: 'Set true when the finished result meets the recorded acceptance criteria. Keep the saved goal and criteria unchanged.' },
      human_review_required: { type: 'boolean', description: 'Set true only when the owner explicitly requires personal acceptance of the finished result. Ordinary tasks, financial conclusions and completed data changes do not automatically require a second owner acceptance. Required approvals before an operation (including posting) use the normal action approval flow; they do not require this flag. Independent member review still applies.' },
      goal: { type: 'string', required: true },
      acceptance: { type: 'array', items: { type: 'string' }, required: true },
      stage: { type: 'string', required: true },
      next_step: { type: 'string', required: true },
      artifacts: { type: 'array', items: { type: 'string' }, required: true,
        description: 'For drafts, record existing references. For submit_delivery, first use present for final files and list only paths registered in this turn. Use [] for a text result.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      task_id: { type: 'string', required: true }, record: { type: 'string', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: value.record }], presentationMeta: (_args, value) => value },
    execute: async (args, exec) => {
      admit(exec)
      if (Object.keys(args).some(key => !['task_id', 'take_over_owner', 'owner_transfer_quote', 'submit_delivery', 'human_review_required', 'goal', 'acceptance', 'stage', 'next_step', 'artifacts'].includes(key))
        || args.acceptance.length === 0 || [args.goal, args.stage, args.next_step, ...args.acceptance, ...args.artifacts,
        ...(args.task_id === undefined ? [] : [args.task_id])].some(value => value.trim().length === 0)) {
        throw new HarnessError('Provide a goal, at least one acceptance criterion, stage and next step.', 'KATCATS_CHAT_INVALID_INPUT')
      }
      if (args.take_over_owner === true ? args.task_id === undefined || !args.owner_transfer_quote?.trim()
        : args.owner_transfer_quote !== undefined) {
        throw new HarnessError('A confirmed owner transfer requires task_id, take_over_owner and the complete current owner_transfer_quote.', 'KATCATS_CHAT_INVALID_INPUT')
      }
      const ticket = await record({ ...(args.task_id === undefined ? {} : { id: brandString<GroupTicketId>(args.task_id.trim()) }),
        ...(args.take_over_owner === true ? { takeOverOwner: true, ownerTransferQuote: args.owner_transfer_quote!.trim() } : {}),
        ...(args.submit_delivery === true ? { submitDelivery: true } : {}),
        ...(args.human_review_required === true ? { humanReviewRequired: true } : {}),
        goal: args.goal.trim(), acceptance: args.acceptance.map(value => value.trim()), stage: args.stage.trim(),
        nextStep: args.next_step.trim(), artifacts: args.artifacts.map(value => value.trim()) }, exec)
      const { financeScope: _scope, ...savedTask } = ticket
      return { task_id: ticket.id, record: JSON.stringify(savedTask) }
    },
    presentCall: () => ({ card: 'generic', title: 'Record group task', kind: 'edit' }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'Task was not recorded' : 'Business task recorded', content: result.content }),
  })
}
