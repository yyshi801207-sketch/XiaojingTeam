/** Project only durable product task events; generated claims never become task records. */
import type { ConversationLocation, ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatTaskEventId, ChatTaskLifecycle, ChatTaskStatus } from '../chats-task-events.ts'
import type { ChatFailure } from '../chats-types.ts'

/** One observed stage with its original event identity and timestamp. */
export interface ChatTaskStage {
  readonly eventId: ChatTaskEventId
  readonly status: ChatTaskStatus
  readonly time: number
  readonly recovered: boolean
  readonly error: ChatFailure | null
}

/** Current task details and recorded stages; no missing stage is inferred. */
export interface ChatTaskLifecycleData {
  readonly task: ChatTaskLifecycle
  readonly stages: readonly ChatTaskStage[]
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** A real task delivery, aggregated from its root-Session lifecycle events. */
    'katcats-task': ChatTaskLifecycleData
  }
}

interface TaskState extends ChatTaskLifecycleData {
  readonly seq: number
  readonly location: ConversationLocation
}

/** One delivery keeps its first timeline position while its recorded outcome changes. */
export const chatTaskLifecycleDefinition: ConversationNodeDefinition<TaskState> = {
  kind: 'katcats-group-task-lifecycle',
  target: 'chat',
  match: (event) => {
    if (event.type !== 'katcats/group-task-lifecycle') return null
    const task = event.data
    return { id: JSON.stringify([task.rootSessionId, task.chatId, task.runId, task.generation, task.deliveryId]),
      role: 'start', exclusive: true }
  },
  start: (_context, match) => {
    if (match.event.type !== 'katcats/group-task-lifecycle') throw new Error('Task lifecycle start requires a task event')
    const task = match.event.data
    return { task, stages: [{ eventId: task.eventId, status: task.status, time: match.event.time,
      recovered: task.recovered, error: task.error }],
    seq: match.event.seq, location: match.location }
  },
  update: (context, match) => {
    if (match.event.type !== 'katcats/group-task-lifecycle') return context.state
    const task = match.event.data
    // A delivery has at most seven protocol states; replayed event IDs do not add another stage.
    if (context.state.stages.some(stage => stage.eventId === task.eventId)) return context.state
    return { ...context.state, task, stages: [...context.state.stages,
      { eventId: task.eventId, status: task.status, time: match.event.time, recovered: task.recovered, error: task.error }] }
  },
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined) return null
    return { key: context.key, kind: 'katcats-task', id: context.id, target: 'chat',
      anchorSeq: state.seq, location: state.location, visibility: 'visible', groupTree: 'turn',
      data: { task: state.task, stages: state.stages } }
  },
}
