/** Agent-scoped team tools, model guidance, and replayable generic presentation. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { avatarSchema, ordinaryGroupId } from './storage.ts'
import type { BotAvatar, BotId, CreateBotRequest, GroupId, TeamBot, TeamSnapshot } from './types.ts'

/** Serialized member operations whose implementations enforce the execution Agent's authority. */
export interface MemberToolActions {
  /** Create with the initial durable role, honoring cancellation before accepting its intent. */
  create(request: CreateBotRequest, role: string, exec: ToolRunContext): Promise<TeamBot>
  /** Read the roster after recovering accepted pending work. */
  list(exec: ToolRunContext): Promise<TeamSnapshot>
  /** Replace only the executing member's lasting role. */
  setRole(role: string, exec: ToolRunContext): Promise<TeamBot>
  /** Replace only one member's avatar, honoring the main Agent's authority and cancellation. */
  setAppearance(botId: BotId, avatar: BotAvatar, exec: ToolRunContext): Promise<TeamBot>
}

const toolAvatarSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    shape: { type: 'string', required: true, enum: avatarSchema.shape.shape.options },
    color: { type: 'string', required: true, description: 'A six-digit hexadecimal color including #, for example #2288FF.' },
  },
} as const

const botResultSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    bot_id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    role: { type: 'string', required: true },
    avatar: { ...toolAvatarSchema, required: true, properties: {
      ...toolAvatarSchema.properties, shape: { type: 'string', required: true },
    } },
  },
} as const

/**
 * Instructions for persistent identity changes and truthful tool acknowledgements.
 * @param kind - fixed main-member authority or ordinary membership.
 * @returns model-facing guidance included in the member's system prompt.
 */
export function memberToolGuidance(kind: TeamBot['kind']): string {
  const ownRole = 'Use set_own_role only when the user explicitly asks to establish or change your ongoing identity or responsibilities. Do not change your saved role for a temporary task. Claim a role was saved only after the tool succeeds.'
  return kind === 'main'
    ? `${ownRole}\nWhen the user explicitly requests a new persistent team member, use create_bot with its name and lasting role. Pass any requested cat shape and color through avatar; writing a color in role does not change the avatar. Omit avatar only to use the default classic red cat. Use set_bot_appearance to change an existing member's requested avatar without recreating it. Use list_bots to inspect existing members, saved avatars, and group IDs; the default group is 未分组. Claim creation or an appearance change only after the tool returns the saved avatar. If a change fails or is cancelled, first use list_bots to check whether it completed; do not automatically retry it.`
    : ownRole
}

function requireFields(args: object, allowed: readonly string[]): void {
  if (Object.keys(args).some(key => !allowed.includes(key))) {
    throw new HarnessError('Supply only the declared fields; member tools do not accept a caller or target identity.', 'KATCATS_TOOL_INVALID_INPUT')
  }
}

function requiredText(value: string, label: string): string {
  const text = value.trim()
  if (text.length === 0) throw new HarnessError(`Provide a non-empty ${label}.`, 'KATCATS_TOOL_INVALID_INPUT')
  return text
}

function botResult(bot: TeamBot) {
  return { bot_id: bot.id, name: bot.name, role: bot.role, avatar: bot.avatar }
}

function avatarValue(value: BotAvatar): BotAvatar {
  const parsed = avatarSchema.strict().safeParse(value)
  if (!parsed.success) {
    throw new HarnessError('Choose a declared cat shape and a six-digit hexadecimal color including #.', 'KATCATS_TOOL_INVALID_INPUT')
  }
  return parsed.data
}

async function mutation<T>(operation: () => Promise<T>, failure: string): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof HarnessError) throw error
    const remote = remoteErrorOf(error)
    if (remote?.code === 'gateway/bad-request') {
      throw new HarnessError(remote.message, 'KATCATS_TOOL_INVALID_INPUT', { cause: error })
    }
    throw new HarnessError(failure, 'KATCATS_TOOL_INCOMPLETE', { cause: error })
  }
}

function cancelledAfterDispatch(result: Readonly<ToolExecutionResult>): boolean {
  return result.isError && result.error.info?.code === TOOL_ABORTED
}

/**
 * Register member tools through an Agent scope; unloading either owner removes them.
 * @param agent - Agent whose tool schemas and execution scope receive the definitions.
 * @param kind - server-owned member kind, controlling the visible management tools.
 * @param actions - serialized operations that recheck the live executing Agent.
 * @returns an idempotent disposer for this registration group.
 */
export function registerMemberTools(agent: Agent, kind: TeamBot['kind'], actions: MemberToolActions): () => void {
  const definitions: ToolDefinition[] = [defineTool({
    name: 'set_own_role',
    description: 'Save your own lasting identity or responsibilities only when the user explicitly asks. Temporary tasks do not change your role. This tool cannot change another member.',
    parameters: { role: { type: 'string', required: true, description: 'The complete ongoing role explicitly requested by the user; not a temporary task.' } },
    output: {
      schema: botResultSchema,
      render: (_args, value) => [{ type: 'text', text: `Saved your role for ${value.name} (${value.bot_id}):\n${value.role}\nSaved avatar: ${value.avatar.shape} ${value.avatar.color}.` }],
      presentationMeta: (_args, value) => value,
    },
    execute: async (args, exec) => {
      requireFields(args, ['role'])
      const role = requiredText(args.role, 'lasting role')
      return botResult(await mutation(() => actions.setRole(role, exec),
        'The role change did not report success. Check the member settings before retrying.'))
    },
    presentCall: () => ({ card: 'generic', title: 'Save your role', kind: 'edit' }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'Role change failed' : 'Role saved', content: result.content }),
    finalizeContent: (_exec, result) => cancelledAfterDispatch(result)
      ? [{ type: 'text', text: 'The request was cancelled. Your saved role may already have changed; check the member settings before retrying.' }]
      : undefined,
  })]
  if (kind === 'main') {
    definitions.push(defineTool({
      name: 'create_bot',
      description: 'Create a persistent team member with the requested name, lasting role, and optional cat avatar. Omitted avatar uses the default classic red cat. Pass requested appearance in avatar, not only in role. Success means the member and its private conversation are durable. On failure or cancellation, call list_bots before trying again.',
      parameters: {
        name: { type: 'string', required: true, description: 'The requested member name.' },
        role: { type: 'string', required: true, description: 'The complete lasting role and responsibilities requested by the user.' },
        group_id: { type: 'string', description: 'A member group ID from list_bots. Omit for the default 未分组 group.' },
        avatar: { ...toolAvatarSchema, description: 'The requested cat shape and color. Omit to retain the default classic red cat.' },
      },
      output: {
        schema: botResultSchema,
        render: (_args, value) => [{ type: 'text', text: `Created Bot ${value.name} (${value.bot_id}) with saved role:\n${value.role}\nSaved avatar: ${value.avatar.shape} ${value.avatar.color}.` }],
        presentationMeta: (_args, value) => value,
      },
      execute: async (args, exec) => {
        requireFields(args, ['name', 'role', 'group_id', 'avatar'])
        const request: CreateBotRequest = {
          name: requiredText(args.name, 'member name'),
          ...(args.group_id === undefined ? {} : { groupId: brandString<GroupId>(requiredText(args.group_id, 'group ID')) }),
          ...(args.avatar === undefined ? {} : { avatar: avatarValue(args.avatar) }),
        }
        const role = requiredText(args.role, 'lasting role')
        return botResult(await mutation(() => actions.create(request, role, exec),
          'Bot creation did not report success and may already have completed. Call list_bots before trying to create it again.'))
      },
      presentCall: args => ({ card: 'generic', title: `Create Bot ${args.name}`, kind: 'edit' }),
      presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'Bot creation failed' : 'Bot created', content: result.content }),
      finalizeContent: (_exec, result) => cancelledAfterDispatch(result)
        ? [{ type: 'text', text: 'The request was cancelled. Bot creation may already have completed; call list_bots before trying to create it again.' }]
        : undefined,
    }), defineTool({
      name: 'set_bot_appearance',
      description: 'Save a requested cat shape and color for an existing team member from list_bots. Changes only its avatar, preserving its role, model, groups, private conversation and files. On failure or cancellation, call list_bots before trying again.',
      parameters: {
        bot_id: { type: 'string', required: true, description: 'The existing member ID from list_bots.' },
        avatar: { ...toolAvatarSchema, required: true },
      },
      output: {
        schema: botResultSchema,
        render: (_args, value) => [{ type: 'text', text: `Saved Bot ${value.name} (${value.bot_id}) appearance: ${value.avatar.shape} ${value.avatar.color}.` }],
        presentationMeta: (_args, value) => value,
      },
      execute: async (args, exec) => {
        requireFields(args, ['bot_id', 'avatar'])
        const botId = brandString<BotId>(requiredText(args.bot_id, 'member ID'))
        const avatar = avatarValue(args.avatar)
        return botResult(await mutation(() => actions.setAppearance(botId, avatar, exec),
          'The appearance change did not report success and may already have completed. Call list_bots before trying to change it again.'))
      },
      presentCall: () => ({ card: 'generic', title: 'Change Bot avatar', kind: 'edit' }),
      presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'Avatar change failed' : 'Avatar saved', content: result.content }),
      finalizeContent: (_exec, result) => cancelledAfterDispatch(result)
        ? [{ type: 'text', text: 'The request was cancelled. The Bot appearance may already have changed; call list_bots before trying to change it again.' }]
        : undefined,
    }), defineTool({
      name: 'list_bots',
      description: 'Read current team members, their saved avatars, and member groups. The default group is 未分组. Finishes previously accepted pending changes before returning. Use this to check an uncertain or cancelled change before trying again.',
      parameters: {},
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            bots: { type: 'array', required: true, items: {
              type: 'object', additionalProperties: false,
              properties: {
                ...botResultSchema.properties,
                is_main: { type: 'boolean', required: true },
                group_id: { type: 'string' },
              },
            } },
            groups: { type: 'array', required: true, items: {
              type: 'object', additionalProperties: false,
              properties: { group_id: { type: 'string', required: true }, name: { type: 'string', required: true } },
            } },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        presentationMeta: (_args, value) => value,
      },
      execute: async (args, exec) => {
        requireFields(args, [])
        const snapshot = await mutation(() => actions.list(exec), 'The team could not be read or recovered. Check team settings before retrying creation.')
        return {
          bots: snapshot.bots.map(bot => ({ ...botResult(bot), is_main: bot.kind === 'main',
            ...(bot.groupId === null ? {} : { group_id: bot.groupId }) })),
          groups: snapshot.groups.filter(group => group.kind === 'bots').map(group => ({ group_id: group.id,
            name: group.system && group.id === ordinaryGroupId ? '未分组' : group.name })),
        }
      },
      presentCall: () => ({ card: 'generic', title: 'Read team members', kind: 'read' }),
      presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'Team read failed' : 'Team members', content: result.content }),
    }))
  }
  const disposers: (() => void)[] = []
  const dispose = () => { for (const unregister of disposers.splice(0).reverse()) unregister() }
  try {
    for (const definition of definitions) disposers.push(agent.ctx.tools.register(definition))
  } catch (error) {
    dispose()
    throw error
  }
  return dispose
}
