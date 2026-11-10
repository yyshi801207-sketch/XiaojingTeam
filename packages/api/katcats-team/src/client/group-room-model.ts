/** Read-only group projection. Replay never consults present-day delivery results. */
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatDelivery, ChatDeliveryId, ChatSnapshot, TeamChat } from '../chats-types.ts'
import type { ChatTaskLifecycle, ChatTaskStatus } from '../chats-task-events.ts'
import type { ChatSender } from '../chats-types.ts'
import type { BotId, TeamBot } from '../types.ts'
import type {} from '../chats-messages.ts'

/** Observed task transition, ordered by the root Session sequence. */
export interface RoomTransition {
  readonly seq: number
  readonly time: number
  readonly task: ChatTaskLifecycle
}

/** Public output at the replay cursor, including intermediate replies. */
export interface RoomReply {
  readonly id: string
  readonly outputMessageId: string
  readonly seq: number
  readonly time: number
  readonly deliveryId: ChatDeliveryId
  readonly sender: ChatSender
  readonly text: string
}

/** One task's current observed state and complete instruction. */
export interface RoomTask {
  readonly id: ChatDeliveryId
  readonly botId: BotId
  readonly from: BotId | null
  readonly parentId: ChatDeliveryId | null
  readonly message: string
  readonly status: ChatTaskStatus
  readonly error: string | null
  readonly stages: readonly RoomTransition[]
}

/** Visual state does not imply model completion or review approval. */
export type RoomPhase = ChatTaskStatus | 'idle' | 'dependency' | 'approval' | 'question' | 'syncing'

/** Current members plus recorded participants that have since left the group. */
export interface RoomMember {
  readonly id: BotId
  readonly name: string
  readonly role: string
  readonly avatar: TeamBot['avatar']
  readonly phase: RoomPhase
  readonly current: boolean
}

/** Group-scoped data consumed by the scene and accessible task list. */
export interface RoomProjection {
  readonly transitions: readonly RoomTransition[]
  readonly timeline: readonly { readonly seq: number; readonly time: number }[]
  readonly tasks: readonly RoomTask[]
  readonly replies: readonly RoomReply[]
  readonly members: readonly RoomMember[]
}

const deliveryStatus: Record<ChatDelivery['state'], ChatTaskStatus> = {
  accepted: 'queued', running: 'started', completed: 'completed', passed: 'passed', failed: 'failed', unknown: 'unknown',
}

/**
 * Project only this group's records. A finite cursor excludes all live receipts and activity.
 * @param input - Scoped group, root log window, directory and optional replay cursor.
 * @returns Recorded transitions, tasks, public replies and member activity without inferred progress.
 */
export function projectGroupRoom(input: {
  readonly chat: TeamChat
  readonly bots: readonly TeamBot[]
  readonly snapshot: ChatSnapshot | null
  readonly entries: readonly SessionEventLikeEntry[]
  readonly cursor: number | null
  readonly connected: boolean
  readonly waiting: ReadonlyMap<BotId, 'approval' | 'question'>
}): RoomProjection {
  const { chat, bots, snapshot, cursor } = input
  const seen = new Set<string>()
  const transitions: RoomTransition[] = []
  const timeline = new Map<number, { readonly seq: number; readonly time: number }>()
  const replies = new Map<string, RoomReply>()
  const tasks = new Map<ChatDeliveryId, RoomTask>()
  const people = new Map<BotId, RoomMember>()
  for (const id of chat.memberIds) {
    const bot = bots.find(item => item.id === id)
    if (bot !== undefined) people.set(id, { id, name: bot.name,
      role: chat.memberRoles.find(item => item.botId === id)?.role ?? bot.role,
      avatar: bot.avatar, phase: 'idle', current: true })
  }
  const remember = (sender: ChatSender | null) => {
    if (sender === null) return
    if (cursor !== null || !people.has(sender.botId)) people.set(sender.botId, {
      id: sender.botId, name: sender.name, role: sender.role, avatar: sender.avatar,
      phase: 'idle', current: chat.memberIds.includes(sender.botId),
    })
  }
  for (const entry of input.entries) {
    if (entry.type !== 'event') continue
    const event = entry.event
    if (event.type === 'katcats/group-task-lifecycle') {
      const task = event.data
      if (task.chatId !== chat.id || task.rootSessionId !== chat.rootSessionId || seen.has(task.eventId)) continue
      seen.add(task.eventId)
      transitions.push({ seq: event.seq, time: event.time, task })
      timeline.set(event.seq, { seq: event.seq, time: event.time })
    }
    const messages = event.type === 'user/message' && event.surfaceOp === 'append' ? [event.data]
      : event.type === 'agent/inbox/spliced' && event.data.target === 'next-step' ? event.data.inserted : []
    for (const message of messages) {
      const source = message.source
      if (source.kind !== 'katcats-group-relay' || source.chatId !== chat.id || replies.has(message.id)) continue
      timeline.set(event.seq, { seq: event.seq, time: event.time })
      if (cursor !== null && event.seq > cursor) continue
      remember(source.sender)
      replies.set(message.id, { id: message.id, outputMessageId: source.outputMessageId,
        seq: event.seq, time: event.time, deliveryId: source.deliveryId,
        sender: source.sender, text: message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') })
    }
  }
  transitions.sort((a, b) => a.seq - b.seq)
  for (const stage of transitions) {
    if (cursor !== null && stage.seq > cursor) continue
    const task = stage.task
    remember(task.target.sender)
    if (task.actor.kind === 'member') remember(task.actor.sender)
    tasks.set(task.deliveryId, { id: task.deliveryId, botId: task.target.botId,
      from: task.actor.kind === 'member' ? task.actor.botId : null,
      parentId: task.parentDeliveryId, message: task.message, status: task.status,
      error: task.error?.message ?? null, stages: [...(tasks.get(task.deliveryId)?.stages ?? []), stage] })
  }
  if (cursor === null) {
    for (const delivery of snapshot?.deliveries ?? []) {
      if (delivery.chatId !== chat.id) continue
      const previous = tasks.get(delivery.id)
      tasks.set(delivery.id, { id: delivery.id, botId: delivery.botId,
        from: previous?.from ?? (delivery.source.kind === 'tool'
          ? chat.executors.find(item => item.sessionId === delivery.sourceSessionId)?.botId ?? null : null),
        parentId: delivery.source.kind === 'tool' ? delivery.source.parentDeliveryId ?? null : null,
        message: delivery.message, status: deliveryStatus[delivery.state], error: delivery.error?.message ?? null,
        stages: previous?.stages ?? [] })
      const receipt = delivery.receipt
      if (receipt !== null && ![...replies.values()].some(reply => reply.id === delivery.relayMessageId)) {
        remember(receipt.sender)
        // A saved but unpublished receipt has no root-log timestamp yet.
        if (![...replies.values()].some(reply => reply.deliveryId === delivery.id && reply.outputMessageId === receipt.outputMessageId)) {
          replies.set(delivery.relayMessageId, { id: delivery.relayMessageId, outputMessageId: receipt.outputMessageId, seq: 0, time: 0,
            deliveryId: delivery.id, sender: receipt.sender, text: receipt.text })
        }
      }
    }
  }
  const taskList = [...tasks.values()]
  const running = new Set(cursor === null ? snapshot?.activities.find(item => item.chatId === chat.id)?.runningBotIds : [])
  for (const [id, person] of people) {
    const own = taskList.filter(task => task.botId === id)
    const active = own.findLast(task => task.status === 'started' || task.status === 'queued')
    const last = own.at(-1)
    let phase: RoomPhase = active?.status ?? last?.status ?? 'idle'
    if (active !== undefined && taskList.some(task => task.parentId === active.id && (task.status === 'queued' || task.status === 'started'))) phase = 'dependency'
    if (cursor === null) {
      if (running.has(id) && (phase === 'idle' || phase === 'queued')) phase = 'started'
      else if (!running.has(id) && phase === 'started') phase = 'unknown'
      phase = input.waiting.get(id) ?? phase
      if (!input.connected) phase = 'syncing'
    }
    people.set(id, { ...person, phase })
  }
  return { transitions, timeline: [...timeline.values()].sort((a, b) => a.seq - b.seq),
    tasks: taskList, replies: [...replies.values()], members: [...people.values()] }
}
