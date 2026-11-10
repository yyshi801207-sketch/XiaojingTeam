/** Main Bot tools for creating durable group conversations from saved members. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { ChatSnapshot, CreateChatRequest, TeamChat } from './chats-types.ts'
import type { BotId } from './types.ts'

/** Operations that recheck the live main Agent inside the directory queue. */
export interface GroupCreationActions {
  /** Create or recover an identical group, returning only after durable publication. */
  create(request: CreateChatRequest, exec: ToolRunContext): Promise<TeamChat>
  /** Read groups after recovering previously accepted work. */
  list(exec: ToolRunContext): Promise<ChatSnapshot>
}

const chatSchema = {
  type: 'object', additionalProperties: false, properties: {
    chat_id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    member_ids: { type: 'array', required: true, items: { type: 'string' } },
    manager_id: { type: 'string' },
    relay_limit: { type: 'number', required: true },
  },
} as const

function receipt(chat: TeamChat) {
  return { chat_id: chat.id, name: chat.name, member_ids: [...chat.memberIds],
    ...(chat.managerId === null ? {} : { manager_id: chat.managerId }), relay_limit: chat.relayLimit }
}

function requiredText(value: string): string {
  const text = value.trim()
  if (!text) throw new HarnessError('Group names and member IDs must not be empty.', 'KATCATS_TOOL_INVALID_INPUT')
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
  const definitions = [defineTool({
    name: 'create_group_chat',
    description: 'Create a group chat from saved ordinary Bots when the user requests a group or team. First finish create_bots and use the returned IDs; list_bots checks existing members. Optionally appoint one selected member as manager. The main Bot stays outside the group. Reuses an identical name, membership and manager; choose another name only if a separate group is intended. Success means the group and its isolated conversations are saved and visible in the sidebar. This does not start a business task.',
    parameters: {
      name: { type: 'string', required: true },
      member_ids: { type: 'array', required: true, items: { type: 'string' } },
      manager_id: { type: 'string', description: 'One of member_ids, only if a group manager is wanted.' },
    },
    output: { schema: chatSchema,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => value },
    execute: async (args, exec) => {
      requireFields(args, ['name', 'member_ids', 'manager_id'])
      const request: CreateChatRequest = {
        name: requiredText(args.name), memberIds: args.member_ids.map(id => brandString<BotId>(requiredText(id))),
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
    description: 'Read saved group names, member IDs and managers. Recovers pending creation first. Check this after interrupted creation before retrying; group transcripts are not included.',
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
  const disposers: (() => void)[] = []
  const dispose = () => { for (const unregister of disposers.splice(0).reverse()) unregister() }
  try {
    for (const definition of definitions) disposers.push(agent.ctx.tools.register(definition))
    disposers.push(agent.ctx.systemPrompt.section({
      name: 'katcats:group-creation', order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      interpolate: false,
      text: 'When asked to build a team or create Bots and put them in a group, first save every requested Bot, then call create_group_chat with their returned member IDs and requested manager. A logical Bot folder is not a group chat. Use list_group_chats to inspect uncertain creation. Only report the group ready after saved confirmation. Direct the user to its sidebar entry to begin collaboration; creating a group does not dispatch work. You remain the private Bot creation assistant, outside group execution.',
    }))
  } catch (error) { dispose(); throw error }
  return dispose
}
