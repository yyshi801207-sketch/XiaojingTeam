/** Main-Bot portrait and ordinary member avatars selected by their saved kind. */
import type { TeamBot } from '../types.ts'
import { CatAvatar } from './avatars.tsx'
import portrait from './assets/main-bot-avatar.png'
import css from './bot-identity-avatar.module.css'
import teamCss from './team.module.css'

/**
 * Render the supplied main identity independently of editable ordinary appearances.
 * @param props - Actual member kind and appearance, with the requested square edge size.
 * @returns A decorative portrait only for the main Bot; ordinary members keep their selected robot.
 */
export function BotIdentityAvatar({ bot, size = 32 }: {
  readonly bot: Pick<TeamBot, 'kind' | 'avatar'>
  readonly size?: number
}) {
  if (bot.kind !== 'main') return <CatAvatar appearance={bot.avatar} size={size} />
  return <img src={portrait} alt="" aria-hidden="true" width={size} height={size} draggable={false}
    data-xiaojing-main-avatar="" className={[teamCss.avatar, css.portrait].join(' ')} />
}
