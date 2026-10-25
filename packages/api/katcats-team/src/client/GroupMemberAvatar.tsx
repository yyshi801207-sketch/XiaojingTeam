/** Group-only identity marker; private and composite avatars keep their original presentation. */
import type { CSSProperties } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BotId } from '../types.ts'
import { CatAvatar, type CatAppearance } from './avatars.tsx'
import css from './group-member-avatar.module.css'

/**
 * Show the saved member appearance with a tiny diamond only for the current group manager.
 * @param props - Actual member identity, current group manager, appearance and localized marker label.
 * @returns The approved cat avatar and, when applicable, its neutral manager marker.
 */
export function GroupMemberAvatar({ botId, managerId, appearance, size = 28, managerLabel }: {
  readonly botId: BotId
  readonly managerId: BotId | null | undefined
  readonly appearance: CatAppearance
  readonly size?: number
  readonly managerLabel: string
}) {
  if (botId !== managerId) return <CatAvatar appearance={appearance} size={size} />
  return <span className={css.avatar} data-katcats-manager-avatar={botId}
    style={{ '--katcats-manager-badge-size': `${Math.min(7, Math.max(5, Math.round(size * 0.22)))}px` } as CSSProperties}>
    <CatAvatar appearance={appearance} size={size} />
    <Tooltip label={managerLabel} side="top" portal>
      <span className={css.marker} role="img" aria-label={managerLabel} />
    </Tooltip>
  </span>
}
