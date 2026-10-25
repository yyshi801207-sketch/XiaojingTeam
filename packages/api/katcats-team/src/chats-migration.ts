/** One-way import into the adjacent product group generation; predecessors remain untouched. */
import type { Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { chatsDomainSpec, legacyChatsDomainSpec } from './chats-storage.ts'

/**
 * Open v2, importing the complete validated v1 record only before v2 has committed.
 * A failed import closes v2 and propagates; later v2 failures never fall back to v1.
 * @param ctx - product context with the public storage-domain facility.
 * @returns the owned v2 handle; the caller closes it after its accepted writes settle.
 */
export async function openChatsDomain(ctx: Context): Promise<Domain<typeof chatsDomainSpec>> {
  const current = await ctx.storageDomain.open(chatsDomainSpec)
  try {
    if (current.global.get().revision > 0) return current
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
