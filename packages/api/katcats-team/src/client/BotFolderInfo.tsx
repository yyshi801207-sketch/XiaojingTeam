/** Read-only folder information for a member's existing private Session. */
import { useCallback } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { BotSettingsInjected } from './BotSettings.tsx'
import css from './team.module.css'

/** The Hero supplies popup positioning while root selectors identify its member. */
export type BotFolderInfoProps = PropsRuntime<'conversation.hero.workspace'> & PropsLocale<'katcats.team'>
  & InjectFace<{ readonly hooks: Pick<BotSettingsInjected['hooks'], 'directory'> }>

/**
 * Show the current member folder without exposing a Session-changing picker.
 * @param props - Public Hero popup lifecycle and member-directory selector.
 * @returns Read-only folder information for the selected member.
 */
export function BotFolderInfo({ open, anchorRef, onClose, useSessions, useDirectory, t }: BotFolderInfoProps) {
  const selected = useSessions(state => state.ids.find(id => (state.byId[id]?.retainedBy.mainView ?? 0) > 0))
  const bot = useDirectory(value => value.snapshot?.bots.find(item => item.sessionId === selected))
  const getAnchorRect = useCallback(() => anchorRef?.current?.getBoundingClientRect() ?? null, [anchorRef])
  if (bot === undefined) return null
  return <Menu open={open} anchor={null} getAnchorRect={getAnchorRect} onClose={onClose} portal>
    <div className={css.folderInfo} role="group" aria-label={t('bot.folder')}>
      <span className={css.label}>{t('bot.folderReadOnly')}</span>
      <p className={css.folderPath}>{bot.workDir}</p>
    </div>
  </Menu>
}
