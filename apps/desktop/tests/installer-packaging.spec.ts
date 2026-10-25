import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { Arch, Platform } from 'electron-builder'
import { Packager } from 'app-builder-lib'
import { describe, expect, it, vi } from 'vitest'

const { execute, buildCommit } = vi.hoisted(() => ({ execute: vi.fn(async () => undefined), buildCommit: vi.fn() }))
vi.mock('../scripts/desktop-build-commit.mjs', () => ({ resolveDesktopBuildCommit: buildCommit }))
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  return { ...original, execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) }
})

describe('installer preparation preserves application dependencies', () => {
  it('uses the approved native icon for executable, shortcuts, installer, uninstaller and platform packages', async () => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig({ DSH_DESKTOP_UNSIGNED: '1' }, 'win32', 'x64')
    const ico = new URL('../build/installer-runtime-icon.ico', import.meta.url)
    expect(readFileSync(config.win.icon)).toEqual(readFileSync(ico))
    expect(config.nsis.installerIcon).toBe(config.win.icon)
    expect(config.nsis.uninstallerIcon).toBe(config.win.icon)
    expect(config.nsis.uninstallerSidebar).toBe(config.nsis.installerSidebar)
    expect(readFileSync(config.mac.icon).subarray(0, 4).toString()).toBe('icns')
    expect(readFileSync(config.linux.icon)).toEqual(readFileSync(new URL('../build/installer-icon-source.png', import.meta.url)))
    expect(readFileSync(config.extraResources.find(resource => resource.to === 'tray.ico')!.from)).toEqual(readFileSync(ico))
    expect(readFileSync(new URL('../build/installer-shortcuts.nsh', import.meta.url), 'utf8')).toContain('installer-runtime-icon.ico')
  })

  it.each([false, true])('keeps packaged source identity explicit for copy baseline=%s', async (copy) => {
    buildCommit.mockReturnValue({ commit: 'a'.repeat(40), dirty: copy, ...(copy ? { source: 'copy-baseline' } : {}) })
    try {
      const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
      const config = createElectronBuilderConfig({ DSH_DESKTOP_UNSIGNED: '1' }, 'win32', 'x64')
      expect(config.extraMetadata.name).toBe('xiaojing-accounting-team-desktop')
      expect(config.extraMetadata.dshDesktopAppId).toBe('ai.xiaojing.accounting.team.desktop')
      expect(config.nsis.guid).toBe('c8462347-245f-49dd-8195-e1174bb7e3ef')
      expect(config.extraMetadata.dshBuildDirty).toBe(copy)
      if (copy) {
        expect(config.extraMetadata.dshBuildSource).toBe('copy-baseline')
        expect(config.extraMetadata.dshBuildBaselineCommit).toBe('a'.repeat(40))
        expect(config.extraMetadata).not.toHaveProperty('dshBuildCommit')
      } else {
        expect(config.extraMetadata.dshBuildCommit).toBe('a'.repeat(40))
        expect(config.extraMetadata).not.toHaveProperty('dshBuildBaselineCommit')
        expect(config.extraMetadata).not.toHaveProperty('dshBuildSource')
      }
    } finally {
      buildCommit.mockReset()
    }
  })

  it.each(['win32', 'darwin'] as const)('keeps inherited release and policy services out of the Team package on %s', async (platform) => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'ai.xiaojing.accounting.team.desktop',
      DSH_DESKTOP_UNSIGNED: '1',
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
      DOWNLOAD_TEST_ORIGIN: 'https://previous-product.example.com',
      DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://previous-policy.example.com',
    }, platform, 'x64')
    expect(config.publish).toBeNull()
    expect(config.extraMetadata).not.toHaveProperty('dshMandatoryUpdatePolicy')
  })

  it.each(['ai.katcats.desktop', 'com.sudotech.xiaojing-office', 'com.sudotech.xiaojing-accounting'])(
    'rejects the previous product identity %s', async (appId) => {
      const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
      expect(() => createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: appId, DSH_DESKTOP_UNSIGNED: '1' }, 'win32', 'x64'))
        .toThrow('identity overrides are not supported')
    },
  )
  it.each(['win32', 'darwin'] as const)('keeps electron-builder responsible for node_modules on %s', async (platform) => {
    execute.mockClear()
    const env = {
      DSH_DESKTOP_APP_ID: 'ai.xiaojing.accounting.team.desktop',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
      DSH_DESKTOP_TARGET_PLATFORM: platform,
      DSH_DESKTOP_TARGET_ARCH: 'x64',
      DSH_DESKTOP_UNSIGNED: platform === 'win32' ? '1' : '0',
      DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
      DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
      APPLE_KEYCHAIN_PROFILE: 'installer-test',
      DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com', DOWNLOAD_TEST_RELEASE_ID: '0123456789abcdef0123456789abcdef',
    }
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    try {
      const { createElectronBuilderConfig } = await import('../electron-builder.config.mjs')
      const config = createElectronBuilderConfig(env, platform, 'x64')
      const aboutIcon = config.extraResources.find(resource => resource.to === 'icon.png')
      expect(aboutIcon).toBeDefined()
      expect(readFileSync(aboutIcon!.from)).toEqual(readFileSync(new URL('../build/app-icon.png', import.meta.url)))
      const packager = new Packager({ projectDir: tmpdir() })
      // A foreign source-build target avoids rebuilding modules; the real dependency ownership decision still runs.
      Object.defineProperties(packager, {
        config: { value: { beforeBuild: config.beforeBuild, buildDependenciesFromSource: true } },
        framework: { value: { isNpmRebuildRequired: true, version: '42.0.0' } },
        appInfo: { value: { type: 'module' } },
      })
      vi.spyOn(packager, 'getWorkspaceRoot').mockResolvedValue(tmpdir())
      await packager.installAppDependencies(process.platform === 'win32' ? Platform.LINUX : Platform.WINDOWS, Arch.x64)
      expect(packager.areNodeModulesHandledExternally).toBe(false)
      expect(execute).toHaveBeenCalledTimes(platform === 'win32' ? 1 : 0)
    } finally {
      vi.unstubAllEnvs()
      vi.restoreAllMocks()
    }
  })

  it('names unsigned Windows artifacts so they cannot pass for release builds', async () => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig({
      DSH_DESKTOP_APP_ID: 'ai.xiaojing.accounting.team.desktop',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
      DSH_DESKTOP_TARGET_PLATFORM: 'win32',
      DSH_DESKTOP_TARGET_ARCH: 'x64',
      DSH_DESKTOP_UNSIGNED: '1',
    }, 'win32', 'x64')
    expect(config.artifactName).toBe('XiaojingAccountingTeam-${version}-${os}-${arch}-unsigned.${ext}')
  })

  it('packages every preload entry point the shell loads', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const sourceDirectory = new URL('../src/', import.meta.url)
    const referenced = new Set<string>()
    for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      for (const match of readFileSync(new URL(entry.name, sourceDirectory), 'utf8').matchAll(/preload-[a-z-]+\.cjs/gu)) referenced.add(match[0])
    }
    expect(referenced.size).toBeGreaterThan(0)
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig({
      DSH_DESKTOP_APP_ID: 'ai.xiaojing.accounting.team.desktop',
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://harness-test.deepseek.com',
      DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
      DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
      APPLE_KEYCHAIN_PROFILE: 'installer-test',
    }, 'darwin', 'arm64')
    const packaged = new Set(config.files.filter((entry): entry is string => typeof entry === 'string'))
    for (const name of referenced) expect(packaged.has(`lib/${name}`)).toBe(true)
  })
})
