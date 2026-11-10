/** Publish model-control options before browser plugins activate. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { Config, MODEL_SELECTION_CONFIG_GLOBAL } from './controls-config.ts'

export { Config } from './controls-config.ts'

/**
 * Publish public model-control configuration to each page bootstrap.
 * @param ctx - Host context collecting page initialization data.
 * @param config - Plugin options validated by the Loader.
 */
export function apply(ctx: Context, config: Config = Config({})): void {
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: MODEL_SELECTION_CONFIG_GLOBAL, value: {
      controlsEnabled: config.controlsEnabled,
    } })
  })
}
