/** Compact execution facts; tool arguments, results and assistant text stay in the original conversation. */
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-tools/types'
import type { BotId } from '../types.ts'

/** Recorded activity labels, independent of a task's delivery or review outcome. */
export type RoomExecutionKind = 'turnStarted' | 'stepStarted' | 'toolRequested' | 'toolStarted'
  | 'toolCompleted' | 'toolFailed' | 'turnEnded' | 'turnCancelled' | 'turnFailed' | 'turnPaused' | 'turnUnknown'

/** One durable execution event belonging to an exact group executor. */
export interface RoomExecutionRow {
  readonly id: string
  readonly botId: BotId
  readonly sessionId: SessionId
  readonly seq: number
  readonly time: number
  readonly kind: RoomExecutionKind
  readonly tool: string
  readonly step: number | null
}

/** A fixed display window, not a limit on execution or retained Session history. */
export const ROOM_ACTIVITY_ROWS = 100

/**
 * Read only execution events, pairing tools by call identity rather than name or text.
 * @param botId - Group member whose executor supplied the window.
 * @param sessionId - Exact executor identity, never the member's private Session.
 * @param entries - Loaded executor journal window, including transient chunks to ignore.
 * @returns The latest display rows in Session order, with repeated event sequences deduplicated.
 */
export function projectRoomExecution(
  botId: BotId, sessionId: SessionId, entries: readonly SessionEventLikeEntry[],
): readonly RoomExecutionRow[] {
  const rows: RoomExecutionRow[] = []
  const tools = new Map<string, string>()
  const seen = new Set<number>()
  for (const entry of entries) {
    if (entry.type !== 'event' || seen.has(entry.event.seq)) continue
    const event = entry.event
    seen.add(event.seq)
    let kind: RoomExecutionKind
    let tool = ''
    let step: number | null = null
    switch (event.type) {
      case 'turn/start': kind = 'turnStarted'; break
      case 'step/start': kind = 'stepStarted'; step = event.data.step; break
      case 'tool/call':
        kind = 'toolRequested'; tool = event.data.name; step = event.data.step
        tools.set(event.data.callId, tool)
        break
      case 'tool/result':
        kind = event.data.message.isError ? 'toolFailed' : 'toolCompleted'
        tool = tools.get(event.data.message.toolCallId) ?? ''; step = event.data.step
        break
      case 'tool/ptc-dispatch-start': kind = 'toolStarted'; tool = event.data.name; break
      case 'tool/ptc-dispatch': kind = event.data.isError ? 'toolFailed' : 'toolCompleted'; tool = event.data.name; break
      case 'turn/end':
        switch (event.data.reason.kind) {
          case 'completed': kind = 'turnEnded'; break
          case 'aborted': kind = 'turnCancelled'; break
          case 'error': kind = 'turnFailed'; break
          case 'blocked': kind = 'turnPaused'; break
          // Extensions and interrupted/imported turns do not imply successful completion.
          default: kind = 'turnUnknown'
        }
        break
      // Reply text, reasoning, arguments, raw results and usage are not activity feed content.
      default: continue
    }
    rows.push({ id: `${sessionId}:${event.seq}`, botId, sessionId, seq: event.seq, time: event.time, kind, tool, step })
  }
  return rows.slice(-ROOM_ACTIVITY_ROWS)
}
