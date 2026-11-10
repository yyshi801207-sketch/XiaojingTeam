/** One-way import into the adjacent product group generation; predecessors remain untouched. */
import type { Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { chatsDomainSpec, legacyChatsDomainSpec, previousChatsDomainSpec } from './chats-storage.ts'

/**
 * Open v3, importing committed v2 or otherwise v1 only before v3 has committed.
 * A failed import closes v3 and propagates; invalid or committed generations never fall back.
 * @param ctx - product context with the public storage-domain facility.
 * @returns the owned v3 handle; the caller closes it after its accepted writes settle.
 */
export async function openChatsDomain(ctx: Context): Promise<Domain<typeof chatsDomainSpec>> {
  const current = await ctx.storageDomain.open(chatsDomainSpec)
  try {
    if (current.global.get().revision > 0) return current
    const previous = await ctx.storageDomain.open(previousChatsDomainSpec)
    try {
      const state = previous.global.get()
      if (state.revision > 0) {
        await current.global.set(state)
        return current
      }
    } finally { await previous.close() }
    const legacy = await ctx.storageDomain.open(legacyChatsDomainSpec)
    try {
      const state = legacy.global.get()
      await current.global.set({ ...state, revision: Math.max(1, state.revision) })
    } finally { await legacy.close() }
    return current
  } catch (error) {
    await current.close()
    throw error
  }
}
