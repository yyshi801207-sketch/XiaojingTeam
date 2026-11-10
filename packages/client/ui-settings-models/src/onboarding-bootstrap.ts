/** Publish Models onboarding choices without loading Host verification dependencies. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { type Config, ONBOARDING_CONFIG_GLOBAL } from './onboarding-config.ts'

export { Config } from './onboarding-config.ts'

/**
 * Publish public onboarding configuration before browser plugins activate.
 * @param ctx - Host context collecting page initialization data.
 * @param config - plugin options with schema defaults applied.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'global',
      name: ONBOARDING_CONFIG_GLOBAL,
      value: {
        credentialOnboarding: config.credentialOnboarding,
        ...config.installationId === undefined ? {} : { installationId: config.installationId },
      },
    })
  })
}
