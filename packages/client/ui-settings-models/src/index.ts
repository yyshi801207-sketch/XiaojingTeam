/** Host configuration and page bootstrap for Models credential onboarding. */

import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './onboarding-config.ts'
import { apply as bootstrapOnboarding } from './onboarding-bootstrap.ts'
import { ModelVerificationService } from './model-verification.ts'

export { ModelVerificationService } from './model-verification.ts'

export { Config } from './onboarding-config.ts'

/**
 * Publish the credential-onboarding choice before browser plugins activate.
 * @param ctx - Host context collecting the page's initialization data.
 * @param config - plugin options with schema defaults applied by the Loader.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(ModelVerificationService)
  bootstrapOnboarding(ctx, config)
}
