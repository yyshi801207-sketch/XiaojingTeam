/** Read-only shared directory popup for a group root's existing workspace. */
import { useCallback } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatView } from './chat-model.ts'
import css from './team.module.css'

/** Public Hero popup lifecycle and owner-only group directory. */
export type ChatFolderInfoProps = PropsRuntime<'conversation.hero.workspace'> & PropsLocale<'katcats.team'>
  & InjectFace<{ readonly hooks: { readonly chats: ObservableSnapshot<ChatView> } }>

/**
 * Show the fixed group folder while preserving the current root conversation.
 * @param props - Public popup lifecycle, Session selection and group reader.
 * @returns Read-only shared-folder information.
 */
export function ChatFolderInfo({ open, anchorRef, onClose, useSessions, useChats, t }: ChatFolderInfoProps) {
  const selected = useSessions(state => state.ids.find(id => (state.byId[id]?.retainedBy.mainView ?? 0) > 0))
  const chat = useChats(value => value.snapshot?.chats.find(item => item.rootSessionId === selected))
  const getAnchorRect = useCallback(() => anchorRef?.current?.getBoundingClientRect() ?? null, [anchorRef])
  if (chat === undefined) return null
  return <Menu open={open} anchor={null} getAnchorRect={getAnchorRect} onClose={onClose} portal>
    <div className={css.folderInfo} role="group" aria-label={t('chat.folder')}>
      <span className={css.label}>{t('chat.folderReadOnly')}</span>
      <p className={css.folderPath}>{chat.workDir}</p>
    </div>
  </Menu>
}
