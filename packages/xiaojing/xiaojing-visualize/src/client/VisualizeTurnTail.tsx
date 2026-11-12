/** Completed visualizations remain visible when Chat folds the Turn's process. */
import type { ChatNode, UseChat } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { FactoryComponentPropsOf, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { visualizeMetaFrom } from '../fragment.ts'
import { VisualizeFrame } from './VisualizeCard.tsx'

function SavedVisualization({ nodeKey, useChat, callIds }: { nodeKey: string; useChat: UseChat; callIds?: readonly string[] }) {
  const node = useChat(snapshot => snapshot.nodes.get(nodeKey)) as ChatNode | undefined
  if (node?.kind !== 'tool-call') return null
  const block = node.data.root
  if (!('kind' in block) || block.isError || callIds !== undefined && !callIds.includes(block.callId)) return null
  const meta = visualizeMetaFrom(block.meta)
  if (meta === undefined) return null
  return <VisualizeFrame meta={meta} callId={block.callId} />
}

/**
 * Render this completed Turn's saved cards outside its collapsible process.
 * @param props - completed Turn and current Conversation's Chat reader.
 * @returns successful visualization cards, including those restored from history.
 */
export function VisualizeTurnTail({ turn, useChat }: PropsRuntime<'conversation.chat.turnTail'>) {
  const keys = useChat(snapshot => snapshot.locations.getTurn(turn.turn))
  return <>{keys.map(key => <SavedVisualization key={key} nodeKey={key} useChat={useChat} />)}</>
}

/**
 * Render eligible cards from the member reply using the original sandboxed frame.
 * @param props - Closing message and eligible call IDs from the group relay.
 * @returns Saved cards from that exact closed Turn.
 */
export function VisualizeDeliveredCards({ messageId, callIds, useChat }: FactoryComponentPropsOf<'xiaojing.visualize.cards'>) {
  const keys = useChat(snapshot => {
    const turn = [...snapshot.timeline.turns.values()].find(item => item.status === 'closed'
      && item.data.get('turn-tail')?.closing?.finalNode.messageId === messageId)
    return turn === undefined ? undefined : snapshot.locations.getTurn(turn.turn)
  })
  if (keys === undefined) return null
  return <>{keys.map(key => <SavedVisualization key={key} nodeKey={key} useChat={useChat} callIds={callIds} />)}</>
}
