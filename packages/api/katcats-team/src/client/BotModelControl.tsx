/** Team composer lifecycle suppresses the global-saving model picker. */
import { useEffect } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { BotSettingsInjected } from './BotSettings.tsx'
import type { ChatView } from './chat-model.ts'

/** One navigation's sidebar intent, consumed by its committed member composer. */
export interface BotSettingsRequest {
  readonly sessionId: SessionId
  readonly sequence: number
  readonly intent: 'reveal' | 'collapse'
}

/** Sidebar presentation scoped to the committed member composer. */
export interface BotModelControlInjected {
  readonly hooks: Pick<BotSettingsInjected['hooks'], 'directory'> & {
    readonly settingsRequest: ObservableSnapshot<BotSettingsRequest | null>
    readonly chats: ObservableSnapshot<ChatView>
  }
  readonly openSettings: () => void
  readonly completeSettings: (request: BotSettingsRequest) => void
}

/** Explicit navigation, without changing model or deployment defaults. */
export type BotModelControlProps = PropsRuntime<'conversation.input.model'> & PropsLocale<'katcats.team'>
  & InjectFace<BotModelControlInjected>

/**
 * Apply a sidebar presentation request without displaying a model control in the composer.
 * @param props - Scoped Session, Host directory and pending settings request.
 * @returns No visible content; model selection remains in member settings.
 */
export function BotModelControl({
  sessionId, useDirectory, useChats, useSettingsRequest, completeSettings,
}: BotModelControlProps) {
  const view = useDirectory(value => value)
  const bot = view.snapshot?.bots.find(item => item.sessionId === sessionId)
  const chat = useChats(value => value.snapshot?.chats.find(item => item.rootSessionId === sessionId))
  const request = useSettingsRequest(value => value)
  const member = bot !== undefined || chat !== undefined
  useEffect(() => {
    if (member && request?.sessionId === sessionId) completeSettings(request)
  }, [completeSettings, member, request, sessionId])
  return null
}
