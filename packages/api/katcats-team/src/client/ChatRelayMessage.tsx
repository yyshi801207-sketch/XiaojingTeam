/** Actual member messages with their recorded identity and independent chat bubbles. */
import { ContextMenu, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './GroupDeliveredFiles.tsx'
import type {} from './chat-relay.ts'
import type { BotId } from '../types.ts'
import { GroupMemberAvatar } from './GroupMemberAvatar.tsx'
import { groupManager, type GroupIdentityInjected } from './group-manager.ts'
import css from './team.module.css'

/** Frame-owned actions keep clipboard feedback visible when the conversation changes. */
export interface ChatRelayActionsInjected {
  readonly copyRelayText: (text: string) => void
  readonly openRelayMember: (id: BotId) => void
}

/** Public keyed Chat node scope with product-owned copy. */
export type ChatRelayMessageProps = PropsRuntime<'conversation.chat.node', 'katcats-relay'> & PropsLocale<'katcats.team'>
  & InjectFace<GroupIdentityInjected>
  & InjectFace<ChatRelayActionsInjected>
  & PropsRenderSlots<'katcats.group.delivered-files'>

/**
 * Render actual member output without interpreting a name from generated text.
 * @param props - Durable message content, sender snapshot and original timestamp.
 * @returns A left-aligned member result with safe Markdown rendering.
 */
export function ChatRelayMessage({
  node, sessionId, useGroupDirectory, renderSlot, copyRelayText, openRelayMember, t,
}: ChatRelayMessageProps) {
  const data = node.data
  const sender = data.source.sender
  const managerId = useGroupDirectory(view => groupManager(view, data.source.chatId, sessionId))
  const memberAvailable = useGroupDirectory(view => view.phase === 'ready'
    && view.snapshot?.chats.some(chat => chat.id === data.source.chatId && chat.rootSessionId === sessionId
      && chat.memberIds.includes(sender.botId)) === true)
  const memberItems = [{ id: 'open-member', label: t('chat.openMember'), disabled: !memberAvailable },
    { id: 'copy-name', label: t('chat.copyMemberName') }]
  const selectMember = (id: string): void => {
    if (id === 'copy-name') copyRelayText(sender.name)
    else if (id === 'open-member' && memberAvailable) openRelayMember(sender.botId)
  }
  const date = new Date(data.time)
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  return <div className={css.relayMessage} role="group" aria-label={t('chat.memberMessage', { name: sender.name })}
    data-katcats-relay={data.messageId} data-consumed={data.consumed}>
    <ContextMenu items={memberItems} onSelect={selectMember}>{trigger => <span {...trigger}
      tabIndex={0} className={css.relayMember} aria-label={sender.name}>
      <GroupMemberAvatar appearance={sender.avatar} botId={sender.botId} managerId={managerId} size={28}
        managerLabel={t('chat.managerBadge')} />
    </span>}</ContextMenu>
    <div className={css.relayContent}>
      <div className={css.relayIdentity}>
        <ContextMenu items={memberItems} onSelect={selectMember}>{trigger => <strong {...trigger}
          tabIndex={0} className={css.relayMember}>{sender.name}</strong>}</ContextMenu>
        <time dateTime={date.toISOString()} title={date.toLocaleString()} aria-label={t('chat.memberTime', { time })}>{time}</time></div>
      <ContextMenu items={[{ id: 'copy-message', label: t('chat.copyMessage'), disabled: data.text.length === 0 },
        { id: 'copy-id', label: t('chat.copyMessageId') }]} onSelect={(id) => {
        if (id === 'copy-message' && data.text.length > 0) copyRelayText(data.text)
        else if (id === 'copy-id') copyRelayText(data.messageId)
      }}>{trigger => <div {...trigger} tabIndex={0} className={css.relayBubble} data-katcats-message-body="">
          <MarkdownText text={data.text} labels={{ code: { copyLabel: t('chat.copy'), copiedLabel: t('chat.copied') },
            link: { copyLabel: t('chat.copy'), copiedLabel: t('chat.copied') }, footnotes: t('chat.footnotes') }} />
        </div>}</ContextMenu>
      {data.messageId !== data.source.outputMessageId
        && renderSlot('katcats.group.delivered-files', { messageId: data.messageId, source: data.source })}
    </div>
  </div>
}
