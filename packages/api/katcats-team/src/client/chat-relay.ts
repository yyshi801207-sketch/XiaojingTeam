/** Group replies and finance connection notices retain their recorded author in chat. */
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { MessageSourceMap, UserMessage } from '@deepseek-ai/dsh-llm/types'
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationLocation, ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
export type {} from '../chats-messages.ts'

type RelaySource = MessageSourceMap['katcats-group-relay' | 'katcats-group-finance-connected']

/** Immutable author identity and content from the durable group message. */
export interface ChatRelayData {
  readonly messageId: MessageId
  readonly source: RelaySource
  readonly text: string
  readonly time: number
  readonly consumed: boolean
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** A member reply or a finance connection notice with its recorded author. */
    'katcats-relay': ChatRelayData
  }
}

interface RelayState extends ChatRelayData {
  readonly seq: number
  readonly location: ConversationLocation
}

function isRelay(message: UserMessage): message is UserMessage & { readonly source: RelaySource } {
  return message.source.kind === 'katcats-group-relay' || message.source.kind === 'katcats-group-finance-connected'
}

function relayMessage(event: SessionEventLike): { message: UserMessage & { readonly source: RelaySource }; consumed: boolean } | null {
  if (event.type === 'user/message' && event.surfaceOp === 'append' && isRelay(event.data)) {
    return { message: event.data, consumed: true }
  }
  if (event.type !== 'agent/inbox/spliced' || event.data.target !== 'next-step') return null
  const messages = event.data.inserted.filter(isRelay)
  // Product writers enqueue each relay separately, including recovery and pause reordering.
  if (messages.length > 1) throw new Error('Katcats relay messages must use separate inbox splices')
  const message = messages[0]
  return message?.source.kind !== 'katcats-group-relay' ? null : { message, consumed: false }
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
    if (relay === null) throw new Error('Katcats relay start requires a group message')
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
