/** Actual member messages with their recorded identity and independent chat bubbles. */
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './GroupDeliveredFiles.tsx'
import type {} from './chat-relay.ts'
import { GroupMemberAvatar } from './GroupMemberAvatar.tsx'
import { groupManager, type GroupIdentityInjected } from './group-manager.ts'
import css from './team.module.css'

/** Public keyed Chat node scope with product-owned copy. */
export type ChatRelayMessageProps = PropsRuntime<'conversation.chat.node', 'katcats-relay'> & PropsLocale<'katcats.team'>
  & InjectFace<GroupIdentityInjected>
  & PropsRenderSlots<'katcats.group.delivered-files'>

/**
 * Render actual member output without interpreting a name from generated text.
 * @param props - Durable message content, sender snapshot and original timestamp.
 * @returns A left-aligned member result with safe Markdown rendering.
 */
export function ChatRelayMessage({ node, sessionId, useGroupDirectory, renderSlot, t }: ChatRelayMessageProps) {
  const data = node.data
  const sender = data.source.sender
  const managerId = useGroupDirectory(view => groupManager(view, data.source.chatId, sessionId))
  const date = new Date(data.time)
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  return <div className={css.relayMessage} role="group" aria-label={t('chat.memberMessage', { name: sender.name })}
    data-katcats-relay={data.messageId} data-consumed={data.consumed}>
    <GroupMemberAvatar appearance={sender.avatar} botId={sender.botId} managerId={managerId} size={28}
      managerLabel={t('chat.managerBadge')} />
    <div className={css.relayContent}>
      <div className={css.relayIdentity}><strong>{sender.name}</strong>
        <time dateTime={date.toISOString()} title={date.toLocaleString()} aria-label={t('chat.memberTime', { time })}>{time}</time></div>
      <div className={css.relayBubble} data-katcats-message-body="">
        <MarkdownText text={data.text} labels={{ code: { copyLabel: t('chat.copy'), copiedLabel: t('chat.copied') },
          link: { copyLabel: t('chat.copy'), copiedLabel: t('chat.copied') }, footnotes: t('chat.footnotes') }} />
      </div>
      {data.messageId !== data.source.outputMessageId
        && renderSlot('katcats.group.delivered-files', { messageId: data.messageId, source: data.source })}
    </div>
  </div>
}
