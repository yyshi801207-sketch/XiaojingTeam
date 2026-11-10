/** Compatible group settings and accepted delegation journal, separate from private members. */
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MessageId, ToolCallId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { AttachmentIdType } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { avatarSchema, chatGroupId, mainBotId } from './storage.ts'
import type { BotId, GroupId } from './types.ts'
import type { ChatDelivery, ChatDeliveryId, ChatId, ChatInbound, ChatRunId, TeamChat } from './chats-types.ts'
import { ticketOwnerInput, type GroupTicketId } from './group-tickets.ts'

const botId = z.string().regex(/^[a-z0-9-]+$/).transform(value => brandString<BotId>(value))
const chatId = z.string().regex(/^[a-z0-9-]+$/).transform(value => brandString<ChatId>(value))
const sessionId = z.string().min(1).transform(value => brandString<SessionId>(value))
const messageId = z.string().min(1).transform(value => brandString<MessageId>(value))
const callId = z.string().min(1).transform(value => brandString<ToolCallId>(value))
const deliveryId = z.string().min(1).transform(value => brandString<ChatDeliveryId>(value))
const requestId = z.string().min(1).transform(value => brandString<SessionRequestId>(value))
const runId = z.string().min(1).transform(value => brandString<ChatRunId>(value))
const failure = z.object({ code: z.string().min(1), message: z.string().min(1) })
const attachmentId = z.string().min(1).transform(value => brandString<AttachmentIdType>(value))
const dimensions = z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).loose()
const contentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).loose(),
  z.object({ type: z.literal('image'), attachment: z.object({
    attachmentId, mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    bytes: z.number().int().positive(), width: z.number().int().positive(), height: z.number().int().positive(),
    name: z.string().optional(), originalDimensions: dimensions.optional(),
  }).loose().transform(({ name, originalDimensions, ...attachment }) => ({
    ...attachment,
    ...(name === undefined ? {} : { name }),
    ...(originalDimensions === undefined ? {} : { originalDimensions }),
  })), offloaded: z.literal(true).optional() }).loose(),
  z.object({ type: z.literal('file'), attachment: z.object({
    attachmentId, name: z.string().min(1), bytes: z.number().int().nonnegative(),
  }).loose() }).loose(),
]).transform((part) => {
  if (part.type !== 'image') return part
  const { offloaded, ...image } = part
  return { ...image, ...(offloaded === undefined ? {} : { offloaded }) }
})

/** Durable group parsing preserves fixed Session identities and assigned group directories. */
export const chatSchema: z.ZodType<TeamChat> = z.object({
  tickets: z.array(z.object({
    version: z.literal(1), id: z.string().min(1).transform(value => brandString<GroupTicketId>(value)),
    ownerId: botId, goal: z.string().trim().min(1), acceptance: z.array(z.string().trim().min(1)),
    stage: z.string().trim().min(1), nextStep: z.string().trim().min(1),
    state: z.enum(['open', 'blocked']), blocker: z.string().nullable(),
    artifacts: z.array(z.string().trim().min(1)), messageIds: z.array(messageId).min(1), revision: z.number().int().positive(),
  })).optional(),
  id: chatId,
  name: z.string().trim().min(1),
  groupId: z.string().regex(/^[a-z0-9-]+$/).transform(value => brandString<GroupId>(value)),
  rootSessionId: sessionId,
  workDir: z.string().refine(isAbsolute, 'group working directory must be absolute'),
  memberIds: z.array(botId).min(1),
  managerId: botId.nullable().optional(),
  memberRoles: z.array(z.object({ botId, role: z.string().trim().min(1) })).default([]),
  executors: z.array(z.object({ botId, sessionId })).min(1),
  relayLimit: z.number().int().positive(),
  showHandoffRecords: z.boolean().optional(),
  generation: z.number().int().nonnegative(),
  status: z.enum(['active', 'paused', 'stopped']),
  pauseReason: z.string().nullable(),
  run: z.object({ id: runId, generation: z.number().int().positive(), relayCount: z.number().int().nonnegative() }).nullable(),
  error: failure.nullable(),
}).transform(({ showHandoffRecords, tickets, ...chat }) => ({ ...chat,
  ...(tickets === undefined ? {} : { tickets }),
  ...(showHandoffRecords === undefined ? {} : { showHandoffRecords }),
  managerId: chat.managerId === undefined ? (chat.memberIds.includes(mainBotId) ? mainBotId : null) : chat.managerId,
})).superRefine((chat, issue) => {
  const fail = (message: string) => { issue.addIssue({ code: 'custom', message }) }
  if (new Set(chat.memberIds).size !== chat.memberIds.length) fail('group requires distinct members')
  if (chat.managerId !== null && !chat.memberIds.includes(chat.managerId)) fail('group manager must be a current member')
  if (new Set(chat.memberRoles.map(member => member.botId)).size !== chat.memberRoles.length
    || chat.memberRoles.some(member => !chat.memberIds.includes(member.botId))) fail('group responsibilities require distinct current members')
  if (chat.executors.some(executor => executor.botId === mainBotId)
    || new Set(chat.executors.map(executor => executor.botId)).size !== chat.executors.length) fail('invalid ordinary execution binding')
  if (chat.memberIds.some(id => id !== mainBotId && !chat.executors.some(executor => executor.botId === id))) fail('missing ordinary execution binding')
  const sessions = [chat.rootSessionId, ...chat.executors.map(executor => executor.sessionId)]
  if (new Set(sessions).size !== sessions.length) fail('group Sessions must be distinct')
  if (chat.run !== null && chat.run.generation !== chat.generation) fail('run generation does not match its group')
  if (chat.status === 'stopped' && chat.run !== null) fail('stopped group retains an active run')
  if (chat.tickets !== undefined) {
    if (new Set(chat.tickets.map(task => task.id)).size !== chat.tickets.length) fail('duplicate business task identity')
    const messages = chat.tickets.flatMap(task => task.messageIds)
    if (new Set(messages).size !== messages.length) fail('one owner message cannot belong to multiple business tasks')
    if (chat.tickets.some(task => !chat.executors.some(executor => executor.botId === task.ownerId))) fail('business task owner has no group execution identity')
  }
})

const userMessageSchema: z.ZodType<UserMessage> = z.object({
  id: messageId,
  role: z.literal('user'),
  content: z.array(contentSchema).min(1)
    .refine(content => content.some(part => part.type !== 'text' || part.text.trim().length > 0), 'group message requires text or an attachment'),
  source: z.object({ kind: z.literal('user'), rpcId: requestId }).loose(),
}).loose()

const inboundSchema: z.ZodType<ChatInbound> = z.object({
  requestId, chatId, runId,
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  generation: z.number().int().positive(),
  userMessage: userMessageSchema,
  recipients: z.array(botId).min(1),
  addressing: z.enum(['explicit', 'broadcast']),
  collaborationVersion: z.literal(1).optional(),
  coordinationVersion: z.literal(1).optional(),
  state: z.enum(['accepted', 'published']),
}).loose().transform(({ collaborationVersion, coordinationVersion, ...input }) => ({ ...input,
  ...(coordinationVersion === undefined ? {} : { coordinationVersion }),
  ...(collaborationVersion === undefined ? {} : { collaborationVersion }) }))

const deliveryBase = z.object({
  recoveryOf: deliveryId.optional(),
  takeover: z.object({ version: z.literal(1), botId, state: z.enum(['pending', 'handled', 'stopped']) }).optional(),
  id: z.string().min(1).transform(value => brandString<ChatDeliveryId>(value)),
  chatId, runId,
  generation: z.number().int().positive(),
  sourceSessionId: sessionId,
  botId, executorSessionId: sessionId,
  message: z.string().min(1),
  inputMessageId: messageId,
  relayMessageId: messageId,
  state: z.enum(['accepted', 'running', 'completed', 'passed', 'failed', 'unknown']),
  receipt: z.object({
    sender: z.object({ botId, name: z.string().min(1), role: z.string(), avatar: avatarSchema }).loose(),
    text: z.string(), outputMessageId: messageId, turn: z.number().int().positive(),
  }).loose().nullable(),
  pass: z.object({ turn: z.number().int().positive(), callId }).nullable().default(null),
  relayed: z.boolean(),
  error: failure.nullable(),
}).loose()

const sourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('owner-message'), messageId }),
  z.object({ kind: z.literal('member-reply'), messageId }),
  z.object({ kind: z.literal('tool'), turn: z.number().int().positive(), step: z.number().int().positive(), callId,
    parentDeliveryId: z.string().min(1).transform(value => brandString<ChatDeliveryId>(value)).optional() }),
]).transform((source) => {
  if (source.kind !== 'tool') return source
  const { parentDeliveryId, ...tool } = source
  return { ...tool, ...(parentDeliveryId === undefined ? {} : { parentDeliveryId }) }
})

const currentDeliverySchema = deliveryBase.extend({
  source: sourceSchema,
  turn: z.never().optional(), step: z.never().optional(), callId: z.never().optional(),
})
const legacyDeliverySchema = deliveryBase.extend({
  source: z.never().optional(),
  turn: z.number().int().positive(), step: z.number().int().positive(), callId,
  state: z.enum(['accepted', 'running', 'completed', 'failed', 'unknown']),
  pass: z.null().default(null),
}).transform(({ turn, step, callId: legacyCallId, ...delivery }) => ({
  ...delivery, source: { kind: 'tool' as const, turn, step, callId: legacyCallId },
}))

const deliverySchema: z.ZodType<ChatDelivery> = z.union([currentDeliverySchema, legacyDeliverySchema])
  .transform(({ recoveryOf, takeover, ...delivery }) => ({ ...delivery,
    ...(recoveryOf === undefined ? {} : { recoveryOf }), ...(takeover === undefined ? {} : { takeover }) }))
  .superRefine((delivery, issue) => {
    if ((delivery.state === 'completed') !== (delivery.receipt !== null)) {
      issue.addIssue({ code: 'custom', message: 'completed delegation requires exactly one receipt' })
    }
    if ((delivery.state === 'passed') !== (delivery.pass !== null)) {
      issue.addIssue({ code: 'custom', message: 'passed delegation requires exactly one pass result' })
    }
    if (delivery.relayed && delivery.receipt === null) issue.addIssue({ code: 'custom', message: 'uncompleted delegation cannot be relayed' })
    if (delivery.receipt !== null && delivery.receipt.sender.botId !== delivery.botId) issue.addIssue({ code: 'custom', message: 'receipt sender does not match its delegation' })
  })

/** A complete create/settings target remains pending until Workspace and Session titles are durable. */
export interface PendingChat {
  readonly kind: 'create' | 'settings'
  readonly chat: TeamChat
}

/** Atomic owner record; P1 member data and Session generations remain unchanged. */
export interface ChatsState {
  readonly revision: number
  readonly chats: readonly TeamChat[]
  readonly inbounds: readonly ChatInbound[]
  readonly deliveries: readonly ChatDelivery[]
  readonly pendingChat: PendingChat | null
}

/** Reject ambiguous identities and broken execution bindings rather than replacing saved groups. */
export const chatsStateSchema: z.ZodType<ChatsState> = z.object({
  revision: z.number().int().nonnegative(),
  chats: z.array(chatSchema),
  inbounds: z.array(inboundSchema).default([]),
  deliveries: z.array(deliverySchema),
  pendingChat: z.object({ kind: z.enum(['create', 'settings']), chat: chatSchema }).nullable(),
}).loose().superRefine((state, issue) => {
  const fail = (message: string) => { issue.addIssue({ code: 'custom', message }) }
  const allChats = state.pendingChat?.kind === 'create' ? [...state.chats, state.pendingChat.chat] : state.chats
  if (new Set(allChats.map(chat => chat.id)).size !== allChats.length) fail('duplicate group identity')
  const sessions = allChats.flatMap(chat => [chat.rootSessionId, ...chat.executors.map(executor => executor.sessionId)])
  if (new Set(sessions).size !== sessions.length) fail('private group Sessions are shared')
  if (state.pendingChat?.kind === 'settings') {
    const target = state.pendingChat.chat
    const previous = state.chats.find(chat => chat.id === target.id)
    if (previous === undefined || previous.rootSessionId !== target.rootSessionId || previous.workDir !== target.workDir
      || previous.executors.some(executor => !target.executors.some(next => next.botId === executor.botId
        && next.sessionId === executor.sessionId))) {
      fail('group settings must preserve existing execution identities')
    }
  }
  if (new Set(state.deliveries.map(delivery => delivery.id)).size !== state.deliveries.length) fail('duplicate delegation identity')
  const messageIds = [...state.inbounds.map(inbound => inbound.userMessage.id),
    ...state.deliveries.flatMap(delivery => [delivery.inputMessageId, delivery.relayMessageId])]
  if (new Set(messageIds).size !== messageIds.length) fail('duplicate delegation message identity')
  const requests = state.inbounds.map(inbound => JSON.stringify([inbound.chatId, inbound.requestId]))
  if (new Set(requests).size !== requests.length) fail('duplicate group request identity')
  for (const chat of state.chats) {
    if (chat.tickets?.some(task => task.messageIds.some(id => !state.inbounds
      .some(input => input.chatId === chat.id && input.userMessage.id === id)))) {
      fail('business task requires its own group owner messages')
    }
  }
  for (const inbound of state.inbounds) {
    const chat = state.chats.find(chat => chat.id === inbound.chatId)
    if (chat === undefined || inbound.generation > chat.generation
      || new Set(inbound.recipients).size !== inbound.recipients.length
      || inbound.recipients.some(id => id === mainBotId || !chat.executors.some(executor => executor.botId === id))) {
      fail('group input requires distinct ordinary execution recipients')
    }
    const source = inbound.userMessage.source
    if (source.kind === 'user' && 'rpcId' in source && source.rpcId !== inbound.requestId) fail('group input request does not match its message')
  }
  const deliveries = state.deliveries.map(delivery => JSON.stringify([
    delivery.chatId, delivery.runId, delivery.generation, delivery.sourceSessionId,
    delivery.botId, delivery.source, delivery.recoveryOf ?? null,
  ]))
  if (new Set(deliveries).size !== deliveries.length) fail('duplicate member delivery source')
  for (const delivery of state.deliveries) {
    const recovery = delivery.recoveryOf === undefined ? undefined : state.deliveries.find(item => item.id === delivery.recoveryOf)
    if (delivery.recoveryOf !== undefined && (recovery === undefined || recovery.chatId !== delivery.chatId
      || recovery.runId !== delivery.runId || recovery.generation !== delivery.generation || recovery.state !== 'failed'
      || recovery.takeover?.botId !== delivery.botId || delivery.source.kind !== 'owner-message'
      || recovery.recoveryOf !== undefined)) fail('responsible-member follow-up requires a confirmed failed task in the same run')
    if (recovery !== undefined && delivery.source.kind === 'owner-message'
      && ticketOwnerInput(state.inbounds, state.deliveries, recovery)?.userMessage.id !== delivery.source.messageId) {
      fail('responsible-member follow-up must preserve its original owner message')
    }
    if (delivery.takeover !== undefined && (delivery.state !== 'failed' || delivery.recoveryOf !== undefined)) {
      fail('only confirmed ordinary failures can request takeover')
    }
    const chat = state.chats.find(chat => chat.id === delivery.chatId)
    if (chat === undefined || (chat.rootSessionId !== delivery.sourceSessionId
      && (delivery.source.kind !== 'tool' || !chat.executors.some(executor => executor.sessionId === delivery.sourceSessionId)))
      || !chat.executors.some(executor => executor.botId === delivery.botId && executor.sessionId === delivery.executorSessionId)) {
      fail('delegation requires its own group execution binding')
    }
    if (delivery.source.kind === 'owner-message') {
      const source = delivery.source
      if (!state.inbounds.some(inbound => inbound.chatId === delivery.chatId && inbound.runId === delivery.runId
        && inbound.generation === delivery.generation && inbound.userMessage.id === source.messageId
        && (inbound.recipients.includes(delivery.botId) || recovery !== undefined))) fail('member delivery requires its accepted group input')
    } else if (delivery.source.kind === 'member-reply') {
      const source = delivery.source
      if (!state.deliveries.some(parent => parent.id !== delivery.id && parent.chatId === delivery.chatId
        && parent.runId === delivery.runId && parent.generation === delivery.generation
        && parent.relayMessageId === source.messageId && parent.state === 'completed')) fail('member handoff requires its saved group reply')
    } else if (delivery.source.parentDeliveryId !== undefined) {
      const source = delivery.source
      if (!state.deliveries.some(parent => parent.id === source.parentDeliveryId && parent.id !== delivery.id
        && parent.chatId === delivery.chatId && parent.runId === delivery.runId && parent.generation === delivery.generation
        && parent.executorSessionId === delivery.sourceSessionId)) fail('member handoff requires its actual caller delivery')
      const visited = new Set<ChatDeliveryId>([delivery.id])
      let parentId: ChatDeliveryId | undefined = source.parentDeliveryId
      while (parentId !== undefined) {
        if (visited.has(parentId)) { fail('member handoff ancestry must not contain a cycle'); break }
        visited.add(parentId)
        const parent = state.deliveries.find(item => item.id === parentId)
        parentId = parent?.source.kind === 'tool' ? parent.source.parentDeliveryId : undefined
      }
    } else if (chat !== undefined && delivery.sourceSessionId !== chat.rootSessionId) {
      fail('member tool handoff requires a parent delivery')
    }
  }
})

/** Read-only predecessor with the original fixed group assignment; migration never writes this generation. */
export const legacyChatsDomainSpec = defineDomain({
  name: 'katcats_chats', version: 1,
  global: { schema: chatsStateSchema.refine(state => state.chats.every(chat => chat.groupId === chatGroupId)
    && (state.pendingChat === null || state.pendingChat.chat.groupId === chatGroupId), 'v1 groups require the system chat section'),
  initial: { revision: 0, chats: [], inbounds: [], deliveries: [], pendingChat: null } satisfies ChatsState },
  tables: {},
})

/** Read-only predecessor with custom group assignments; import never writes this generation. */
export const previousChatsDomainSpec = defineDomain({
  name: 'katcats_chats_v2', version: 2,
  global: { schema: chatsStateSchema,
    initial: { revision: 0, chats: [], inbounds: [], deliveries: [], pendingChat: null } satisfies ChatsState },
  tables: {},
})

/** Business tasks and durable failure follow-ups are written separately from earlier generations. */
export const chatsDomainSpec = defineDomain({
  name: 'katcats_chats_v3', version: 3,
  global: { schema: chatsStateSchema,
    initial: { revision: 0, chats: [], inbounds: [], deliveries: [], pendingChat: null } satisfies ChatsState },
  tables: {},
})
