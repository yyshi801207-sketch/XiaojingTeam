/** Main-Bot tagline occupying only its blank-conversation headline. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { TeamView } from './model.ts'
import css from './main-bot-welcome.module.css'

/** Current directory supplied by the product's conditional Hero registration. */
export interface MainBotWelcomeInjected {
  readonly hooks: { readonly directory: ObservableSnapshot<TeamView> }
}

/** The public blank-session slot supplies optional Session identity and localized copy. */
export type MainBotWelcomeProps = PropsRuntime<'conversation.hero.brand.content'> & PropsLocale<'katcats.team'>
  & InjectFace<MainBotWelcomeInjected>

/**
 * Show the team tagline without changing the separate team-artwork slot.
 * @param props - Current optional Session identity, member directory and product locale.
 * @returns The main Bot's tagline; no content for another or unavailable Session.
 */
export function MainBotWelcome({ sessionId, useDirectory, t }: MainBotWelcomeProps) {
  const main = useDirectory(view => view.snapshot?.bots.find(bot => bot.id === view.snapshot?.mainBotId && bot.kind === 'main'))
  if (main === undefined || sessionId === undefined || main.sessionId !== sessionId) return null
  return <div className={css.welcome}>
    <h2 className={css.tagline}>{t('main.welcomeTagline')}</h2>
  </div>
}
