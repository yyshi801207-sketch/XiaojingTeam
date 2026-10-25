import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDesktopCos } from '../scripts/desktop-cos.ts'
import { createDesktopUploadPlan } from '../scripts/desktop-upload-plan.ts'
import { loadDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { tagDesktopRelease } from '../scripts/desktop-release-tag.ts'
import { uploadDesktopRelease } from '../scripts/desktop-upload-run.ts'
import { uploadDesktopTarget } from '../scripts/upload-target.ts'
import { TEAM_PUBLICATION_UNAVAILABLE } from '../scripts/team-publication.ts'

vi.mock('../scripts/desktop-package-environment.mjs', () => ({ loadDesktopPackageEnvironment: vi.fn() }))
vi.mock('../scripts/desktop-upload-plan.ts', () => ({ createDesktopUploadPlan: vi.fn() }))
vi.mock('../scripts/desktop-cos.ts', () => ({ createDesktopCos: vi.fn() }))
vi.mock('../scripts/desktop-upload-run.ts', () => ({ uploadDesktopRelease: vi.fn() }))
vi.mock('../scripts/desktop-release-tag.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../scripts/desktop-release-tag.ts')>(), tagDesktopRelease: vi.fn(),
}))

afterEach(() => { vi.clearAllMocks() })

describe('Team upload commands without a dedicated publication target', () => {
  it.each([
    ['mac-arm64'], ['mac-x64'], ['win-x64'],
    ['mac-arm64', '--latest'], ['mac-x64', '--latest'], ['win-x64', '--latest'],
    ['win-x64', '--credential-launcher', '--environment', 'production', '--bucket', 'previous-product'],
  ])('blocks %j before credentials, package planning, network or Git tags', async (...args) => {
    await expect(uploadDesktopTarget(args)).rejects.toThrow(TEAM_PUBLICATION_UNAVAILABLE)
    for (const operation of [loadDesktopPackageEnvironment, createDesktopUploadPlan, createDesktopCos,
      uploadDesktopRelease, tagDesktopRelease]) expect(operation).not.toHaveBeenCalled()
  })
})
