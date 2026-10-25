import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { createInstalledUpdateCos } from '../scripts/installed-update-cos.ts'
import { createDesktopCos } from '../scripts/desktop-cos.ts'
import { loadDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { TEAM_PUBLICATION_UNAVAILABLE } from '../scripts/team-publication.ts'

vi.mock('../scripts/desktop-package-environment.mjs', () => ({ loadDesktopPackageEnvironment: vi.fn() }))
vi.mock('../scripts/desktop-cos.ts', () => ({ createDesktopCos: vi.fn() }))

afterEach(() => { vi.clearAllMocks() })

it('refuses the inherited installed-update transport before loading credentials or constructing a client', () => {
  expect(() => createInstalledUpdateCos()).toThrow(TEAM_PUBLICATION_UNAVAILABLE)
  expect(loadDesktopPackageEnvironment).not.toHaveBeenCalled()
  expect(createDesktopCos).not.toHaveBeenCalled()
})

it.each([
  ['upload-target.ts', 'win-x64', '--latest'],
  ['publish-installed-update.ts', 'publish-feed', 'absent-manifest.json', '1.0.2', 'absent-receipt.json', '--execute'],
  ['publish-desktop-ci.ts', '--publish'],
])('reports the missing Team destination from %s without reading a release manifest', (script, ...args) => {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', `apps/desktop/scripts/${script}`, ...args], {
    cwd: root, timeout: 15_000, windowsHide: true, encoding: 'utf8',
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production', DOWNLOAD_PROD_COS_BUCKET: 'previous-product' },
  })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(TEAM_PUBLICATION_UNAVAILABLE)
  expect(result.stdout).toBe('')
})

it.skipIf(process.platform !== 'win32')('blocks the credential launcher before opening a nonexistent credential file', () => {
  const script = fileURLToPath(new URL('../scripts/upload-with-credentials.ps1', import.meta.url))
  const command = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); & '${script.replaceAll("'", "''")}' `
    + '-CredentialFile absent-team-credential.clixml -Environment production -Upload -Target win-x64 -Bucket previous-product'
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(command, 'utf16le').toString('base64')], {
    timeout: 15_000, windowsHide: true, encoding: 'utf8',
  })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status).toBe(1)
  expect(result.stdout).toContain(TEAM_PUBLICATION_UNAVAILABLE)
  expect(result.stdout).not.toContain('decrypt-file')
})
