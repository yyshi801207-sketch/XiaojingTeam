/** Compact, accessible status marks for group conversation names. */
import { IconCheckOutlineRegular, IconClockOutlineRegular, IconPauseOutlineRegular,
  IconStopFillRegular, IconWarningOutlineRegular, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatSidebarStatus as Status } from './chat-sidebar-status.ts'
import css from './chat-sidebar-status.module.css'

/**
 * Keep status detail in a tooltip while preserving the row's conversation name.
 * @param props - Truthful derived status and its localized description.
 * @returns A theme-aware icon beside the group name.
 */
export function ChatSidebarStatus({ status, label }: { readonly status: Status; readonly label: string }) {
  const ongoing = status === 'running' || status === 'preparing' || status === 'updating'
  return <Tooltip label={label} portal>
    <span className={css.status} data-chat-status={status} role="img" aria-label={label}>
      {ongoing ? <StateDot state="ongoing" size={13} />
        : status === 'completed' ? <IconCheckOutlineRegular size={14} aria-hidden="true" />
          : status === 'attention' ? <IconWarningOutlineRegular size={14} aria-hidden="true" />
            : status === 'paused' ? <IconPauseOutlineRegular size={13} aria-hidden="true" />
              : status === 'stopped' ? <IconStopFillRegular size={10} aria-hidden="true" />
                : <IconClockOutlineRegular size={13} aria-hidden="true" />}
    </span>
  </Tooltip>
}
