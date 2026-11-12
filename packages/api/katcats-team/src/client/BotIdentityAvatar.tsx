/** Fixed Bot portraits and ordinary member avatars. */
import { ledgerSetupBotId, odooAccessBotId, type TeamBot } from '../types.ts'
import { CatAvatar } from './avatars.tsx'
import portrait from './assets/main-bot-avatar.png'
import jingjing from './assets/odoo-jingjing.png'
import yeye from './assets/odoo-yeye.png'
import css from './bot-identity-avatar.module.css'
import teamCss from './team.module.css'

/**
 * Render supplied portraits for fixed Bots independently of editable ordinary appearances.
 * @param props - Bot identity, edge size and whether to use the private conversation rail artwork.
 * @returns A decorative portrait for a fixed Bot or the member's selected silhouette.
 */
export function BotIdentityAvatar({ bot, size = 32, rail = false }: {
  readonly bot: Pick<TeamBot, 'kind' | 'avatar'> & Partial<Pick<TeamBot, 'id'>>
  readonly size?: number
  readonly rail?: boolean
}) {
  const main = bot.kind === 'main'
  const assistant = bot.id === ledgerSetupBotId ? (rail ? './xiaojing-jingjing-rail.png' : jingjing)
    : bot.id === odooAccessBotId ? (rail ? './xiaojing-yeye-rail.png' : yeye) : undefined
  const artwork = main ? portrait : assistant
  if (artwork === undefined) return <CatAvatar appearance={bot.avatar} size={size} />
  return <img src={artwork} alt="" aria-hidden="true" width={size} height={size} draggable={false}
    loading={rail && !main ? 'lazy' : undefined}
    data-xiaojing-main-avatar={main ? '' : undefined} data-xiaojing-assistant-avatar={main ? undefined : bot.id}
    className={[teamCss.avatar, css.portrait].join(' ')} />
}
