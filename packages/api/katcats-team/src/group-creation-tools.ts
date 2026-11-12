/** Main Bot tools for creating durable group conversations from saved members. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { ChatSnapshot, CreateChatRequest, TeamChat } from './chats-types.ts'
import { chatGroupId } from './storage.ts'
import type { BotId, GroupId } from './types.ts'
import { financeTeamTemplates, type FinanceTeamTemplate } from './finance-team-templates.ts'

/** Operations that recheck the live main Agent inside the directory queue. */
export interface GroupCreationActions {
  /** Create or recover an identical group, returning only after durable publication. */
  create(request: CreateChatRequest, exec: ToolRunContext): Promise<TeamChat>
  /** Read groups after recovering previously accepted work. */
  list(exec: ToolRunContext): Promise<ChatSnapshot>
  /** Save all fixed positions and their group with its finance manager; absent when finance is disabled. */
  createFinance?(template: FinanceTeamTemplate, name: string, groupId: GroupId | undefined, exec: ToolRunContext): Promise<TeamChat>
}

const chatSchema = {
  type: 'object', additionalProperties: false, properties: {
    chat_id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    group_id: { type: 'string', required: true },
    member_ids: { type: 'array', required: true, items: { type: 'string' } },
    manager_id: { type: 'string' },
    relay_limit: { type: 'number', required: true },
  },
} as const

function receipt(chat: TeamChat) {
  return { chat_id: chat.id, name: chat.name, group_id: chat.groupId, member_ids: [...chat.memberIds],
    ...(chat.managerId === null ? {} : { manager_id: chat.managerId }), relay_limit: chat.relayLimit }
}

function requiredText(value: string): string {
  const text = value.trim()
  if (!text) throw new HarnessError('Group names, folder IDs and member IDs must not be empty.', 'KATCATS_TOOL_INVALID_INPUT')
  return text
}

function requireFields(args: object, allowed: readonly string[]): void {
  if (Object.keys(args).some(key => !allowed.includes(key))) {
    throw new HarnessError('Supply only the declared group fields.', 'KATCATS_TOOL_INVALID_INPUT')
  }
}

async function operation<T>(run: () => Promise<T>): Promise<T> {
  try { return await run() } catch (error) {
    if (error instanceof HarnessError) throw error
    const remote = remoteErrorOf(error)
    if (remote?.code === 'gateway/bad-request') {
      throw new HarnessError(remote.message, 'KATCATS_TOOL_INVALID_INPUT', { cause: error })
    }
    throw new HarnessError('The group operation did not report success. Creation may already have completed; inspect list_group_chats before retrying. Do not claim the group is ready yet.', 'KATCATS_TOOL_INCOMPLETE', { cause: error })
  }
}

/**
 * Register group creation in the main Bot scope without giving it group execution tools.
 * @param agent - main Agent receiving the tools and logged system guidance.
 * @param actions - serialized, authorized group operations.
 * @returns disposer for the tools and guidance.
 */
export function registerGroupCreationTools(agent: Agent, actions: GroupCreationActions): () => void {
  const definitions: ToolDefinition[] = [defineTool({
    name: 'create_group_chat',
    description: 'Create a group chat from saved team members when the user requests a group or team. Finish creating the members first and use their saved IDs; list_bots checks existing members. Optionally appoint one selected member as manager. The main Bot stays outside the group. Reuses a group with the same name, membership, manager and any specified sidebar folder. Success means the group and its isolated conversations are saved and visible in the sidebar. This does not start a business task.',
    parameters: {
      name: { type: 'string', required: true },
      group_id: { type: 'string', description: `The custom sidebar folder ID from list_bots or create_bot_folder. Use ${chatGroupId} for the default 群聊 section.` },
      member_ids: { type: 'array', required: true, items: { type: 'string' } },
      manager_id: { type: 'string', description: 'One of member_ids, only if a group manager is wanted.' },
    },
    output: { schema: chatSchema,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => value },
    execute: async (args, exec) => {
      requireFields(args, ['name', 'group_id', 'member_ids', 'manager_id'])
      const request: CreateChatRequest = {
        name: requiredText(args.name), memberIds: args.member_ids.map(id => brandString<BotId>(requiredText(id))),
        ...(args.group_id === undefined ? {} : { groupId: brandString<GroupId>(requiredText(args.group_id)) }),
        ...(args.manager_id === undefined ? {} : { managerId: brandString<BotId>(requiredText(args.manager_id)) }),
      }
      return receipt(await operation(() => actions.create(request, exec)))
    },
    presentCall: args => ({ card: 'generic', title: `Create group ${args.name}`, kind: 'edit' }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'Group creation incomplete' : 'Group ready', content: result.content }),
    finalizeContent: (_exec, result) => result.isError && result.error.info?.code === TOOL_ABORTED
      ? [{ type: 'text', text: 'Group creation was cancelled and may already have completed. Call list_group_chats before retrying.' }]
      : undefined,
  }), defineTool({
    name: 'list_group_chats',
    description: 'Read saved group names, sidebar folders, member IDs and managers. Recovers pending creation first. Check this after interrupted creation before retrying; group transcripts are not included.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      chats: { type: 'array', required: true, items: chatSchema },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    presentationMeta: (_args, value) => value },
    execute: async (args, exec) => {
      requireFields(args, [])
      return { chats: (await operation(() => actions.list(exec))).chats.map(receipt) }
    },
    presentCall: () => ({ card: 'generic', title: 'Read groups', kind: 'read' }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'Group read failed' : 'Saved groups', content: result.content }),
  })]
  const createFinance = actions.createFinance
  if (createFinance !== undefined) definitions.push(defineTool({
    name: 'create_finance_team',
    description: 'Create a complete fixed finance team after the user selects its size and sidebar folder. For new teams, compact-v2 creates 财务主管、01 收单审核、02 记账结账、03 报表税务归档 (4 members); standard-v2 creates 财务主管、01 出纳、02 应收会计、03 应付会计、04 成本会计、05 总账会计、06 税务会计、07 报表会计 (8 members). Both save the unnumbered 财务主管 as the initial group manager; other members are numbered in accounting workflow display order. Numbering does not require every task to use every member or follow a fixed execution sequence. Each position receives its full versioned responsibilities and retains ordinary document, chart and tool capabilities. The group shares one ledger binding; do not ask every member to bind it. This saves members and the chat but does not bind a ledger or execute accounting. Repeating the same template, team name and folder resumes saved creation without replacing edited responsibilities. Use compact-v1 or standard-v1 only when retrying a creation that already used that version. Inspect list_group_chats and list_bots after failure before retrying with the same arguments.',
    parameters: {
      template: { type: 'string', enum: financeTeamTemplates, required: true,
        description: 'Use compact-v2 or standard-v2 for new teams. Preserve the original template version when retrying saved creation.' },
      name: { type: 'string', required: true, description: 'The requested team/group name. Use a different name to create another team.' },
      group_id: { type: 'string', description: 'The user-selected custom sidebar folder ID. Omit for default placement. Ask about placement before creating.' },
    },
    output: { schema: chatSchema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => value },
    execute: async (args, exec) => {
      requireFields(args, ['template', 'name', 'group_id'])
      return receipt(await operation(() => createFinance(args.template, requiredText(args.name),
        args.group_id === undefined ? undefined : brandString<GroupId>(requiredText(args.group_id)), exec)))
    },
    presentCall: args => ({ card: 'generic', title: `Create finance team ${args.name}`, kind: 'edit' }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'Finance team creation incomplete' : 'Finance team ready', content: result.content }),
    finalizeContent: (_exec, result) => result.isError && result.error.info?.code === TOOL_ABORTED
      ? [{ type: 'text', text: 'Finance team creation was cancelled. Saved members and allocation are retained. Inspect list_bots and list_group_chats, then resume with the same template, name and folder; do not recreate the roster individually.' }]
      : undefined,
  }))
  const disposers: (() => void)[] = []
  const dispose = () => { for (const unregister of disposers.splice(0).reverse()) unregister() }
  try {
    for (const definition of definitions) disposers.push(agent.ctx.tools.register(definition))
    disposers.push(agent.ctx.systemPrompt.section({
      name: 'katcats:group-creation', order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      interpolate: false,
      text: (createFinance === undefined ? '' : 'For a new fixed compact or standard finance team, use create_finance_team with compact-v2 or standard-v2 to save its complete positions and managed group together. Keep the finance manager unnumbered and retain the numbered display names supplied by the template. When resuming saved creation, use its original template version, name and folder. ')
        + 'For a custom team, first save every requested Bot, then call create_group_chat with their returned member IDs, requested manager, and selected sidebar folder. Use the same custom folder ID for the new members and chat. Use list_group_chats to inspect uncertain creation. Only report the group ready after saved confirmation. Direct the user to its sidebar entry to begin collaboration; creating a group does not dispatch work. You remain the private Bot creation assistant, outside group execution.',
    }))
  } catch (error) { dispose(); throw error }
  return dispose
}
