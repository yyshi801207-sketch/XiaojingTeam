/** Completed member messages retain their identity across live and durable history. */
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { MessageSourceMap, UserMessage } from '@deepseek-ai/dsh-llm/types'
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationLocation, ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
export type {} from '../chats-messages.ts'

/** Immutable member identity and content from the durable relay message. */
export interface ChatRelayData {
  readonly messageId: MessageId
  readonly source: MessageSourceMap['katcats-group-relay']
  readonly text: string
  readonly time: number
  readonly consumed: boolean
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** A real member result carried as a UserMessage, never an assistant impersonation. */
    'katcats-relay': ChatRelayData
  }
}

interface RelayState extends ChatRelayData {
  readonly seq: number
  readonly location: ConversationLocation
}

function relayMessage(event: SessionEventLike): { message: UserMessage; consumed: boolean } | null {
  if (event.type === 'user/message' && event.surfaceOp === 'append' && event.data.source.kind === 'katcats-group-relay') {
    return { message: event.data, consumed: true }
  }
  if (event.type !== 'agent/inbox/spliced' || event.data.target !== 'next-step') return null
  const messages = event.data.inserted.filter(message => message.source.kind === 'katcats-group-relay')
  // Product writers enqueue each relay separately, including recovery and pause reordering.
  if (messages.length > 1) throw new Error('Katcats relay messages must use separate inbox splices')
  const message = messages[0]
  return message === undefined ? null : { message, consumed: false }
}

/** Member projection keyed by durable MessageId, including older pending relay history. */
export const chatRelayDefinition: ConversationNodeDefinition<RelayState> = {
  kind: 'katcats-group-relay',
  target: 'chat',
  match: (event) => {
    const relay = relayMessage(event)
    return relay === null ? null : { id: relay.message.id, role: 'start', exclusive: true }
  },
  start: (_context, match) => {
    const relay = relayMessage(match.event)
    if (relay === null || relay.message.source.kind !== 'katcats-group-relay') throw new Error('Katcats relay start requires a relay message')
    return {
      messageId: relay.message.id,
      source: relay.message.source,
      text: relay.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
      time: match.event.time,
      seq: match.event.seq,
      consumed: relay.consumed,
      location: match.location,
    }
  },
  update: (context, match) => {
    const relay = relayMessage(match.event)
    if (relay === null || !relay.consumed || context.state.consumed) return context.state
    return { ...context.state, consumed: true, location: match.location }
  },
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined) return null
    return {
      key: context.key, kind: 'katcats-relay', id: context.id, target: 'chat',
      anchorSeq: state.seq, location: state.location, visibility: 'visible', groupTree: 'turn',
      data: { messageId: state.messageId, source: state.source, text: state.text, time: state.time, consumed: state.consumed },
    }
  },
}
