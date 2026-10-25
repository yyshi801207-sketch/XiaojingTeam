/** Member appearance beside the existing Session title and header actions. */
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { BotSettingsInjected } from './BotSettings.tsx'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ChatView } from './chat-model.ts'
import { CatAvatar } from './avatars.tsx'
import { ChatAvatar } from './ChatAvatar.tsx'
import css from './team.module.css'

/** Member lookup stays scoped to this header's Session. */
export type BotHeaderActionProps = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<'katcats.team'>
  & InjectFace<{
    readonly hooks: Pick<BotSettingsInjected['hooks'], 'directory'> & { readonly chats: ObservableSnapshot<ChatView> }
    openSettings: () => void
  }>

/**
 * Open the scoped member's settings without replacing Session navigation.
 * @param props - Current Session, directory hook and settings action.
 * @returns The saved cat appearance, or no action for unrelated Sessions.
 */
export function BotHeaderAction({ sessionId, useDirectory, useChats, openSettings, t }: BotHeaderActionProps) {
  const bots = useDirectory(value => value.snapshot?.bots ?? [])
  const bot = bots.find(item => item.sessionId === sessionId)
  const chat = useChats(value => value.snapshot?.chats.find(item => item.rootSessionId === sessionId))
  if (bot === undefined && chat === undefined) return null
  const label = t(chat === undefined ? 'bot.settings' : 'chat.settings')
  return <Tooltip label={label}>
    <button type="button" className={css.headerIdentity} aria-label={label} onClick={openSettings}>
      {bot === undefined && chat !== undefined
        ? <ChatAvatar appearances={bots.filter(item => chat.memberIds.includes(item.id)).map(item => item.avatar)} />
        : bot !== undefined && <CatAvatar appearance={bot.avatar} size={24} />}
    </button>
  </Tooltip>
}
