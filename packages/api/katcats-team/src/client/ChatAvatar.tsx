/** Approved member cats combined into a compact group identity. */
import type { BotAvatar } from '../types.ts'
import { CatAvatar, DEFAULT_APPEARANCE } from './avatars.tsx'
import css from './chat-avatar.module.css'

/**
 * Arrange current member appearances without overlap; a fourth cell counts additional members.
 * @param props - Member appearances and optional large settings presentation.
 * @returns A decorative group avatar.
 */
export function ChatAvatar({ appearances, large = false }: {
  readonly appearances: readonly BotAvatar[]
  readonly large?: boolean
}) {
  const members = appearances.length === 0 ? [DEFAULT_APPEARANCE] : appearances
  const overflow = members.length > 4 ? members.length - 3 : 0
  const visible = members.slice(0, overflow > 0 ? 3 : 4)
  const count = visible.length + (overflow > 0 ? 1 : 0)
  const memberSize = count === 1 ? large ? 56 : 28 : large ? 30 : 15
  return <span className={css.avatar} data-large={large || undefined} data-count={count} aria-hidden="true">
    {visible.map((appearance, index) => <span key={index} className={css.member}>
      <CatAvatar appearance={appearance} size={memberSize} />
    </span>)}
    {overflow > 0 && <span className={css.count}>+{overflow}</span>}
  </span>
}
