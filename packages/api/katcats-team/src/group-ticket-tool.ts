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
    description: 'Before substantive work, record the business goal, acceptance criteria, current stage and next step. For a correction or continuation of an existing task, supply its task_id from the task index; otherwise omit task_id to create work. Never infer association from identical wording or simply choose the latest task. Ask the owner if ambiguous. Only a direct recipient can classify the current owner message; delegated members inherit that task. The result provides original message IDs: query read_group_history before relying on earlier numbers or decisions. This records work, not successful delivery, review approval, user acceptance, or permission to resume a stopped operation.',
    parameters: {
      task_id: { type: 'string', description: 'Existing business task in this group. Omit to create work or update the current message\'s saved task.' },
      goal: { type: 'string', required: true },
      acceptance: { type: 'array', items: { type: 'string' }, required: true },
      stage: { type: 'string', required: true },
      next_step: { type: 'string', required: true },
      artifacts: { type: 'array', items: { type: 'string' }, required: true, description: 'References to actual draft files or saved results; no invented deliverables.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      task_id: { type: 'string', required: true }, record: { type: 'string', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: value.record }], presentationMeta: (_args, value) => value },
    execute: async (args, exec) => {
      admit(exec)
      if (Object.keys(args).some(key => !['task_id', 'goal', 'acceptance', 'stage', 'next_step', 'artifacts'].includes(key))
        || args.acceptance.length === 0 || [args.goal, args.stage, args.next_step, ...args.acceptance, ...args.artifacts,
        ...(args.task_id === undefined ? [] : [args.task_id])].some(value => value.trim().length === 0)) {
        throw new HarnessError('Provide a goal, at least one acceptance criterion, stage and next step.', 'KATCATS_CHAT_INVALID_INPUT')
      }
      const ticket = await record({ ...(args.task_id === undefined ? {} : { id: brandString<GroupTicketId>(args.task_id.trim()) }),
        goal: args.goal.trim(), acceptance: args.acceptance.map(value => value.trim()), stage: args.stage.trim(),
        nextStep: args.next_step.trim(), artifacts: args.artifacts.map(value => value.trim()) }, exec)
      return { task_id: ticket.id, record: JSON.stringify(ticket) }
    },
    presentCall: () => ({ card: 'generic', title: 'Record group task', kind: 'edit' }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'Task was not recorded' : 'Business task recorded', content: result.content }),
  })
}
