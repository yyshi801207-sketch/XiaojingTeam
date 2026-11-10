/** Global room placement is independent of each group's conversation view. */
import type { ChatId, ChatSnapshot, TeamChat } from '../chats-types.ts'
import type { BotId, TeamBot, TeamSnapshot } from '../types.ts'
import { projectGroupRoom, type RoomProjection } from './group-room-model.ts'

/**
 * Count confirmed dispatch outcomes in the current run, or the latest retained run when idle.
 * @param chat - Group whose work is displayed.
 * @param snapshot - Persisted delivery outcomes; other groups and older runs are excluded.
 * @returns Dispatch completion counts, excluding explicit non-participation from the denominator.
 */
export function headquartersProgress(chat: TeamChat, snapshot: ChatSnapshot | null): {
  completed: number
  total: number
  percent: number | null
  running: number
  queued: number
  unresolved: number
} {
  const deliveries = (snapshot?.deliveries ?? []).filter(item => item.chatId === chat.id)
  const latest = deliveries.reduce<(typeof deliveries)[number] | undefined>((last, item) =>
    !last || item.generation > last.generation ? item : last, undefined)
  const runId = chat.run?.id ?? latest?.runId
  const tasks = deliveries.filter(item => item.runId === runId && item.state !== 'passed')
  const completed = tasks.filter(item => item.state === 'completed').length
  return { completed, total: tasks.length, percent: tasks.length ? Math.floor(completed / tasks.length * 100) : null,
    running: tasks.filter(item => item.state === 'running').length,
    queued: tasks.filter(item => item.state === 'accepted').length,
    unresolved: tasks.filter(item => item.state === 'failed' || item.state === 'unknown').length }
}

/**
 * Count executing identities once across group and private sessions.
 * @param snapshot - Live group activity, independent of saved delivery states.
 * @param privateRunning - Known running private Bot identities.
 * @returns Distinct busy Bots and groups currently processing work.
 */
export function headquartersActivity(snapshot: ChatSnapshot | null, privateRunning: readonly BotId[]): { busy: number, active: number } {
  const groups = new Set(snapshot?.chats.map(chat => chat.id))
  const busy = new Set(privateRunning)
  const active = new Set<ChatId>()
  for (const activity of snapshot?.activities ?? []) {
    if (!groups.has(activity.chatId)) continue
    for (const id of activity.runningBotIds) busy.add(id)
    if (activity.processing || activity.runningBotIds.length) active.add(activity.chatId)
  }
  return { busy: busy.size, active: active.size }
}

/** Native HQ has eight furnished group rooms on each floor. */
export const HEADQUARTERS_ROOMS_PER_FLOOR = 8

/**
 * Preserve occupied room addresses while assigning newly observed groups to unused addresses.
 * @param previous - Addresses retained by this dispatch window, including removed groups.
 * @param ids - Current group identities in catalog order.
 * @returns Updated addresses; catalog sorting and deletion cannot move another group.
 */
export function headquartersAddresses(previous: ReadonlyMap<ChatId, number>, ids: readonly ChatId[]): ReadonlyMap<ChatId, number> {
  const next = new Map(previous)
  let address = Math.max(-1, ...next.values()) + 1
  for (const id of ids) if (!next.has(id)) next.set(id, address++)
  return next
}

/**
 * Keep the main Bot at headquarters and group execution states inside their own rooms.
 * @param directory - Real Bot identities; the main Bot is selected by ID, never name or roster order.
 * @param snapshot - Group catalog and current delivery receipts.
 * @param connected - Whether the catalog is current.
 * @returns Independent group projections and ungrouped Bots for the common area.
 */
export function projectHeadquarters(directory: TeamSnapshot | null, snapshot: ChatSnapshot | null, connected: boolean): {
  main: TeamBot | null
  groups: Array<{ chat: TeamChat, progress: ReturnType<typeof headquartersProgress>, projection: RoomProjection }>
  independent: TeamBot[]
} {
  const bots = directory?.bots ?? []
  const groups = (snapshot?.chats ?? []).map(chat => ({ chat, progress: headquartersProgress(chat, snapshot), projection: projectGroupRoom({
    chat, bots, snapshot, connected, entries: [], cursor: null, waiting: new Map<BotId, 'approval' | 'question'>(),
  }) }))
  const grouped = new Set(groups.flatMap(group => group.chat.memberIds))
  return {
    main: bots.find(bot => bot.id === directory?.mainBotId) ?? null,
    groups,
    independent: bots.filter(bot => bot.id !== directory?.mainBotId && !grouped.has(bot.id)),
  }
}
