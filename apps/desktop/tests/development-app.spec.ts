/** Cold-start launcher preserves workspace paths without evaluating shell syntax. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { developmentLauncher, prepareDevelopmentApp } from '../scripts/development-app.ts'

vi.mock('node:child_process', { spy: true })

it('prepares a Team-only macOS bundle without registering a system URL handler', () => {
  const root = mkdtempSync(join(tmpdir(), 'xiaojing-team-development-app-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const source = join(root, 'Electron.app')
  const bundle = join(root, 'XiaojingAccountingTeam Dev.app')
  mkdirSync(join(source, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(source, 'Contents', 'Info.plist'), '<plist/>')
  const execute = vi.mocked(execFileSync).mockImplementation((file) => {
    if (file === '/usr/bin/ditto') {
      mkdirSync(join(bundle, 'Contents', 'Resources'), { recursive: true })
      mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
    }
    return Buffer.alloc(0)
  })
  onTestFinished(() => { execute.mockRestore() })
  expect(prepareDevelopmentApp({ electron: join(source, 'Contents', 'MacOS', 'Electron'), appRoot: root,
    directory: root, home: join(root, 'home'), userData: join(root, 'user-data'),
    mainPort: 20229, rendererPort: 20222, hostPort: 20230, openDevtools: '0' }))
    .toBe(join(bundle, 'Contents', 'MacOS', 'XiaojingAccountingTeamDev'))
  expect(execute).toHaveBeenCalledWith('/usr/bin/plutil', [
    '-replace', 'CFBundleIdentifier', '-json', '"ai.xiaojing.accounting.team.development"', join(bundle, 'Contents', 'Info.plist'),
  ])
  expect(execute).toHaveBeenCalledWith('/usr/bin/plutil', [
    '-replace', 'CFBundleURLTypes', '-json', '[]', join(bundle, 'Contents', 'Info.plist'),
  ])
  expect(execute.mock.calls.some(([file]) => file.includes('lsregister'))).toBe(false)
})

it.skipIf(process.platform === 'win32')('passes literal workspace paths and cold-start settings to Electron', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-development-app-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const bundle = join(root, "Harness ' $(false).app")
  const binary = join(bundle, 'Contents', 'MacOS', 'Electron')
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$DSH_HOME" "$DSH_DESKTOP_DEV_APP" "$DSH_DESKTOP_OPEN_DEVTOOLS" "$@"\n', { mode: 0o755 })
  const launcher = join(root, 'launcher')
  const home = join(root, "home ' $(false)")
  writeFileSync(launcher, developmentLauncher({ electron: binary, appRoot: root, directory: root,
    home, userData: join(root, 'browser data'), mainPort: 9229, rendererPort: 9222, hostPort: 9230, openDevtools: '0' }, bundle))
  const result = execFileSync('/bin/sh', [launcher, '--test-launch-argument'], { encoding: 'utf8' })
  expect(result.trimEnd().split('\n')).toEqual([home, '1', '0', '--inspect=127.0.0.1:9229',
    '--remote-debugging-port=9222', `--user-data-dir=${join(root, 'browser data')}`, root, '--test-launch-argument'])
})
