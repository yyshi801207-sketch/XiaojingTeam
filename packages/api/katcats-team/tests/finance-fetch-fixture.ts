/** Odoo connection metadata behavior for tests focused on subsequent finance operations. */
import { vi } from 'vitest'

/**
 * Stub the Odoo transport with optional account display metadata unavailable.
 * @param fetcher Scripted responses for verification and business requests.
 */
export function stubFinanceFetch(fetcher: typeof fetch): void {
  vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
    const path = new URL(String(args[0])).pathname
    if (path.endsWith('/json/2/res.users/read')) {
      return Response.json({}, { status: 404 })
    }
    return fetcher(...args)
  })
}
