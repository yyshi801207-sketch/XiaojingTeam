/** The Host publishes validated model-control options for each browser bootstrap. */
import { Context } from '@deepseek-ai/cordis'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { expect, it } from 'vitest'
import * as plugin from '../src/index.ts'
import { MODEL_SELECTION_CONFIG_GLOBAL } from '../src/controls-config.ts'

it.each([true, false])('publishes controlsEnabled=%s until the plugin unloads', async (controlsEnabled) => {
  const ctx = new Context()
  try {
    const fiber = ctx.plugin(plugin, { controlsEnabled })
    await fiber.await()
    const rows: IndexInjection[] = []
    ctx.emit('webserver/index-inject', rows)
    expect(rows).toEqual([{
      kind: 'global', name: MODEL_SELECTION_CONFIG_GLOBAL, value: { controlsEnabled },
    }])
    await fiber.dispose()
    const after: IndexInjection[] = []
    ctx.emit('webserver/index-inject', after)
    expect(after).toEqual([])
  } finally { await ctx.fiber.dispose() }
})
