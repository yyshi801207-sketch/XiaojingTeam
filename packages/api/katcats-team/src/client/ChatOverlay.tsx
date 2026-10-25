/** Group creation shares the existing frame-owned dialog lifecycle. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CreateChatRequest } from '../chats-types.ts'
import type { TeamView } from './model.ts'
import type { ChatView } from './chat-model.ts'
import type { TeamUiState } from './ui-state.ts'
import { CreateChat } from './ChatForms.tsx'

/** Narrow group creation commands and Host directory readers. */
export interface ChatOverlayInjected {
  readonly hooks: {
    readonly teamUi: ObservableSnapshot<TeamUiState>
    readonly directory: ObservableSnapshot<TeamView>
    readonly chats: ObservableSnapshot<ChatView>
  }
  readonly close: () => void
  readonly create: (request: CreateChatRequest) => Promise<void>
}

/** Public root overlay scope with typed product copy. */
export type ChatOverlayProps = PropsRuntime<'shell.overlay'> & PropsLocale<'katcats.team'> & InjectFace<ChatOverlayInjected>

/**
 * Present explicit group creation without moving business state into React.
 * @param props - Shared dialog request and current members and group defaults.
 * @returns A group dialog only for an explicit group-create request.
 */
export function ChatOverlay({ useTeamUi, useDirectory, useChats, close, create, t }: ChatOverlayProps) {
  const state = useTeamUi(value => value)
  const bots = useDirectory(value => value.snapshot?.bots ?? [])
  const defaults = useChats(value => value.snapshot)
  if (state.dialog?.kind !== 'chat' || defaults === null) return null
  return <CreateChat key={state.dialog.key} bots={bots} defaultRelayLimit={defaults.relayLimit} create={create} close={close} t={t} />
}
