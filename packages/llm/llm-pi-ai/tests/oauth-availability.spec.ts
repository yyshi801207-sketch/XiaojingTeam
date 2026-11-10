/** OAuth-only model choices depend on their own stored grant without resolving request auth. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Credential, OAuthCredential } from '@earendil-works/pi-ai'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

const LEGACY = 'openai-codex'
const GRANT: OAuthCredential = {
  type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: 0,
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** A configured legacy route with request-time auth forbidden during directory reads. */
function legacyFixture(seed: Record<string, Credential> = {}) {
  const auth = memoryAuth(seed)
  const profiles = resolveProfiles({ [LEGACY]: {} })
  const oauth = profiles.get(LEGACY)?.piProvider?.auth.oauth
  if (oauth === undefined) throw new Error('Expected the installed OAuth-only legacy provider')
  const refresh = vi.spyOn(oauth, 'refresh').mockRejectedValue(new Error('Directory must not refresh OAuth'))
  const toAuth = vi.spyOn(oauth, 'toAuth').mockRejectedValue(new Error('Directory must not resolve request auth'))
  const fetch = vi.fn(() => Promise.reject(new Error('Directory must not access the network')))
  vi.stubGlobal('fetch', fetch)
  const adapter = new PiAiAdapter({
    profiles: () => profiles, resolveApiKey: () => Promise.resolve(undefined), auth,
  })
  return { adapter, auth, refresh, toAuth, fetch }
}

describe('OAuth-only model availability', () => {
  const unavailable: { name: string; seed: Record<string, Credential> }[] = [
    { name: 'without a stored grant', seed: {} },
    { name: 'with only the separate ChatGPT grant', seed: { chatgpt: GRANT } },
    { name: 'with an API-key record the provider cannot use', seed: {
      [LEGACY]: { type: 'api_key', key: 'fixture-key' },
    } },
  ]

  it.each(unavailable)('hides the legacy models $name', async ({ seed }) => {
    const { adapter, refresh, toAuth, fetch } = legacyFixture(seed)

    await expect(adapter.listModels(LEGACY)).resolves.toEqual([])

    expect(refresh).not.toHaveBeenCalled()
    expect(toAuth).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'unexpired', expires: Number.MAX_SAFE_INTEGER },
    { name: 'expired', expires: 0 },
  ])('lists models with an $name legacy grant without refreshing it', async ({ expires }) => {
    const grant = { ...GRANT, expires }
    const { adapter, auth, refresh, toAuth, fetch } = legacyFixture({ [LEGACY]: grant })
    const modify = vi.spyOn(auth.credentials, 'modify')
    const env = vi.spyOn(auth.authContext, 'env')
    const fileExists = vi.spyOn(auth.authContext, 'fileExists')

    await expect(adapter.listModels(LEGACY)).resolves.not.toHaveLength(0)

    expect(auth.stored.get(LEGACY)).toBe(grant)
    expect(modify).not.toHaveBeenCalled()
    expect(env).not.toHaveBeenCalled()
    expect(fileExists).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    expect(toAuth).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps a legacy route with an explicitly resolved API key selectable', async () => {
    const auth = memoryAuth()
    const read = vi.spyOn(auth.credentials, 'read')
    const profiles = resolveProfiles({ [LEGACY]: { apiKeyEnv: 'FIXTURE_CODEX_TOKEN' } })
    const resolveApiKey = vi.fn(() => Promise.resolve('fixture-key'))
    const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey, auth })

    await expect(adapter.listModels(LEGACY)).resolves.not.toHaveLength(0)

    expect(resolveApiKey).toHaveBeenCalledWith(LEGACY, profiles.get(LEGACY))
    expect(read).not.toHaveBeenCalled()
  })

  it('reports a credential-store failure instead of an empty directory', async () => {
    const { adapter, auth, refresh, toAuth, fetch } = legacyFixture()
    const failure = new Error('fixture credential store unavailable')
    vi.spyOn(auth.credentials, 'read').mockRejectedValue(failure)

    await expect(adapter.listModels(LEGACY)).rejects.toMatchObject({ code: 'auth', cause: failure })

    expect(refresh).not.toHaveBeenCalled()
    expect(toAuth).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('updates the same adapter directory after its grant is saved and removed', async () => {
    const { adapter, auth, refresh, toAuth, fetch } = legacyFixture()

    await expect(adapter.listModels(LEGACY)).resolves.toEqual([])
    await auth.credentials.modify(LEGACY, () => Promise.resolve(GRANT))
    await expect(adapter.listModels(LEGACY)).resolves.not.toHaveLength(0)
    await auth.credentials.delete(LEGACY)
    await expect(adapter.listModels(LEGACY)).resolves.toEqual([])

    expect(refresh).not.toHaveBeenCalled()
    expect(toAuth).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps native API-key providers selectable without resolving their ambient auth', async () => {
    const auth = memoryAuth()
    const profiles = resolveProfiles({ deepseek: {} })
    const apiKey = profiles.get('deepseek')?.piProvider?.auth.apiKey
    if (apiKey === undefined) throw new Error('Expected the installed native API-key provider')
    const resolve = vi.spyOn(apiKey, 'resolve').mockRejectedValue(new Error('Directory must not resolve native auth'))
    const adapter = new PiAiAdapter({
      profiles: () => profiles, resolveApiKey: () => Promise.resolve(undefined), auth,
    })

    await expect(adapter.listModels('deepseek')).resolves.not.toHaveLength(0)

    expect(resolve).not.toHaveBeenCalled()
  })
})
