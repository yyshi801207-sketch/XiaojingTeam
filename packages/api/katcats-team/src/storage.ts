/** Version-one member directory; every replacement is one atomic global write. */
import { z } from 'zod'
import { isAbsolute } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { BotId, BotModel, GroupId, TeamBot, TeamGroup } from './types.ts'

/** Stable product identities, independent of names and conversation ids. */
export const mainBotId = brandString<BotId>('main')
/** The empty ordinary-member group is retained at first launch. */
export const ordinaryGroupId = brandString<GroupId>('bots')
/** The empty group-conversation group is retained at first launch. */
export const chatGroupId = brandString<GroupId>('chats')

const botId = z.string().regex(/^[a-z0-9-]+$/).transform(value => brandString<BotId>(value))
const groupId = z.string().regex(/^[a-z0-9-]+$/).transform(value => brandString<GroupId>(value))
const sessionId = z.string().min(1).transform(value => brandString<SessionId>(value))

/** Avatar validation at durable and Remote input parsing. */
export const avatarSchema = z.object({
  shape: z.enum(['classic', 'round', 'point', 'fold', 'tilt', 'fluffy', 'slim', 'wave', 'layered', 'ponytail']),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
})

const modelSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('follow-global') }),
  z.object({
    kind: z.literal('override'),
    provider: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: z.string().min(1).optional(),
  }),
]).transform((model): BotModel => {
  if (model.kind === 'follow-global') return model
  const { reasoningEffort, ...route } = model
  return reasoningEffort === undefined ? route : { ...route, reasoningEffort }
})

const memberSchema = z.object({
  id: botId,
  kind: z.enum(['main', 'ordinary']),
  name: z.string().trim().min(1),
  role: z.string(),
  avatar: avatarSchema,
  model: modelSchema,
  workDir: z.string().refine(isAbsolute, 'working directory must be absolute'),
  groupId: groupId.nullable(),
  sessionId,
})

const groupSchema = z.object({
  id: groupId,
  name: z.string().trim().min(1),
  kind: z.enum(['bots', 'chats']),
  system: z.boolean(),
})

/** Creation and Session-setting intents survive interruption until both durable stores agree. */
export interface TeamState {
  readonly revision: number
  readonly bots: readonly TeamBot[]
  readonly groups: readonly TeamGroup[]
  readonly pendingBot: TeamBot | null
  /** Historical field name retained for complete title/model setting targets. */
  readonly pendingRename: TeamBot | null
}

/** Reject unexplained missing identities instead of resetting authoritative data. */
export const teamStateSchema: z.ZodType<TeamState> = z.object({
  revision: z.number().int().nonnegative(),
  bots: z.array(memberSchema),
  groups: z.array(groupSchema),
  pendingBot: memberSchema.nullable(),
  pendingRename: memberSchema.nullable(),
}).superRefine((state, issue) => {
  const fail = (message: string) => { issue.addIssue({ code: 'custom', message }) }
  if (new Set(state.bots.map(bot => bot.id)).size !== state.bots.length) fail('duplicate member identity')
  if (new Set(state.bots.map(bot => bot.sessionId)).size !== state.bots.length) fail('duplicate private Session')
  if (new Set(state.groups.map(group => group.id)).size !== state.groups.length) fail('duplicate group identity')
  if (state.groups.length > 0 && (!state.groups.some(group => group.id === ordinaryGroupId && group.system && group.kind === 'bots')
    || !state.groups.some(group => group.id === chatGroupId && group.system && group.kind === 'chats'))) fail('missing system group')
  const members = state.pendingBot === null ? state.bots : [...state.bots, state.pendingBot]
  if (new Set(members.map(bot => bot.id)).size !== members.length) fail('pending member identity already exists')
  if (new Set(members.map(bot => bot.sessionId)).size !== members.length) fail('pending private Session already exists')
  for (const bot of members) {
    if (bot.kind === 'main') {
      if (bot.id !== mainBotId || bot.groupId !== null) fail('invalid main member')
    } else if (bot.id === mainBotId || !state.groups.some(group => group.id === bot.groupId && group.kind === 'bots')) {
      fail('ordinary member requires an ordinary group')
    }
  }
  if (members.length > 0 && members.filter(bot => bot.kind === 'main').length !== 1) fail('missing main member')
  if (members.length === 0 && (state.revision !== 0 || state.groups.length > 0)) fail('missing main member')
  if (state.pendingRename !== null) {
    const next = state.pendingRename
    const previous = state.bots.find(bot => bot.id === next.id)
    if (state.pendingBot !== null || previous === undefined
      || previous.sessionId !== next.sessionId
      || previous.workDir !== next.workDir
      || previous.kind !== next.kind) fail('invalid pending rename')
    if (next.kind === 'main' ? next.groupId !== null
      : !state.groups.some(group => group.id === next.groupId && group.kind === 'bots')) fail('invalid pending rename group')
  }
})

/** This new domain has no predecessor or migration from other products. */
export const teamDomainSpec = defineDomain({
  name: 'katcats_team',
  version: 1,
  global: {
    schema: teamStateSchema,
    initial: { revision: 0, bots: [], groups: [], pendingBot: null, pendingRename: null } satisfies TeamState,
  },
  tables: {},
})
