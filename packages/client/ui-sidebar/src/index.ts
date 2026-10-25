/** Publish public sidebar presentation options before browser plugins activate. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { Config, SIDEBAR_PRESENTATION_GLOBAL } from './presentation-config.ts'

export { Config } from './presentation-config.ts'

/**
 * Contribute presentation options to each page and worker bootstrap.
 * @param ctx - Host context collecting structured index injections.
 * @param config - Public sidebar options validated by the Loader.
 */
export function apply(ctx: Context, config: Config = Config({})): void {
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: SIDEBAR_PRESENTATION_GLOBAL, value: {
      ...(config.primaryActionLabel === undefined ? {} : { primaryActionLabel: config.primaryActionLabel }),
      ...(config.panelNavigation === undefined ? {} : { panelNavigation: config.panelNavigation }),
      ...(config.footerNavigation === undefined ? {} : { footerNavigation: config.footerNavigation }),
      ...(config.footerActionsPlacement === undefined ? {} : { footerActionsPlacement: config.footerActionsPlacement }),
    } })
  })
}
