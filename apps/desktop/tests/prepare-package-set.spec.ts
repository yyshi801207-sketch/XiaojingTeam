import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  assertDesktopHostPackageFiles,
  prepareDesktopPackageSet,
  selectDesktopPackageClosure,
  type PackedDesktopPackage,
} from '../scripts/prepare-package-set.ts'

function packed(name: string, manifest: Record<string, unknown> = {}): PackedDesktopPackage {
  return { tarball: `${name}.tgz`, manifest: { name, version: '1.0.0', ...manifest } }
}

describe('desktop package-set selection', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('does not select a packaging target when imported as a library', async () => {
    vi.stubEnv('DSH_DESKTOP_TARGET_PLATFORM', 'linux')
    vi.stubEnv('DSH_DESKTOP_TARGET_ARCH', 'x64')
    vi.resetModules()
    await expect(import('../scripts/prepare-package-set.ts')).resolves.toHaveProperty('prepareDesktopPackageSet')
  })

  it('includes only the available internal production closure', () => {
    const available = new Map<string, PackedDesktopPackage>([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh', {
        dependencies: { '@deepseek-ai/dsh-base': '^1.0.0', external: '^2.0.0' },
        optionalDependencies: { '@deepseek-ai/platform-package': '1.0.0', '@deepseek-ai/missing-platform': '1.0.0' },
      })],
      ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host', {
        dependencies: { '@deepseek-ai/dsh': '^1.0.0' },
      })],
      ['@deepseek-ai/dsh-base', packed('@deepseek-ai/dsh-base', {
        peerDependencies: { '@deepseek-ai/cordis': '^1.0.0' },
      })],
      ['@deepseek-ai/cordis', packed('@deepseek-ai/cordis')],
      ['@deepseek-ai/platform-package', packed('@deepseek-ai/platform-package')],
      ['@deepseek-ai/unused', packed('@deepseek-ai/unused')],
    ])
    expect(selectDesktopPackageClosure(available).map(entry => entry.manifest.name)).toEqual([
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh',
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-desktop-host',
      '@deepseek-ai/platform-package',
    ])
  })

  it.each([
    '@deepseek-ai/dsh-base', '@deepseek-ai/cordis', '@deepseek-ai/node-addon-system',
  ])('rejects required prepared package %s absent from the packed release inputs', (dependency) => {
    const available = new Map<string, PackedDesktopPackage>([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh', {
        dependencies: { [dependency]: '^1.0.0' },
      })],
      ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host', {
        dependencies: { '@deepseek-ai/dsh': '^1.0.0' },
      })],
    ])
    expect(() => selectDesktopPackageClosure(available)).toThrow(/unpacked package/u)
    expect(() => selectDesktopPackageClosure(new Map([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh')],
    ]))).toThrow(/omit @deepseek-ai\/dsh-desktop-host/u)
  })

  it('leaves independently published Office packages to npm resolution', () => {
    const available = new Map<string, PackedDesktopPackage>([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh', {
        dependencies: {
          '@deepseek-ai/libreoffice-kit': '0.0.1',
          '@deepseek-ai/libreoffice-kit-wasm': '0.0.1',
        },
      })],
      ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host')],
    ])
    expect(selectDesktopPackageClosure(available).map(entry => entry.manifest.name)).toEqual([
      '@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host',
    ])
  })

  it('requires both Desktop Host and public CLI entries', () => {
    const files = [
      'package/lib/index.js',
      'package/lib/cli.js',
    ]
    expect(() => {
      assertDesktopHostPackageFiles(files)
    }).not.toThrow()
    expect(() => {
      assertDesktopHostPackageFiles(files.slice(1))
    }).toThrow(/lib\/index\.js/u)
    expect(() => { assertDesktopHostPackageFiles(files.slice(0, 1)) }).toThrow(/lib\/cli\.js/u)
  })
})

function tarballFixture(overrides: Record<string, string | null>) {
  const root = mkdtempSync(join(tmpdir(), 'katcats-package-chunks-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const input = join(root, 'packed')
  const output = join(root, 'package-set')
  mkdirSync(input)
  mkdirSync(output)
  writeFileSync(join(output, 'sentinel.txt'), 'existing package set')
  const team = '@deepseek-ai/dsh-client-katcats-team'
  const entries = Object.fromEntries(['index', 'chats', 'memory', 'client', 'typert.host', 'typert.remote-client']
    .map(name => [`lib/${name}.js`, 'export {}\n']))
  entries['lib/types/types.js'] = 'export {}\n'
  const packages: [string, Record<string, string | null>, Record<string, string>][] = [
    ['@deepseek-ai/dsh', {}, { [team]: '1.0.0' }],
    ['@deepseek-ai/dsh-desktop-host', { 'lib/index.js': 'export {}', 'lib/cli.js': 'export {}' }, {}],
    [team, { ...entries, ...overrides }, {}],
  ]
  for (const [index, [name, files, dependencies]] of packages.entries()) {
    const staging = join(root, `staging-${index}`)
    const packageRoot = join(staging, 'package')
    mkdirSync(packageRoot, { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name, version: '1.0.0', dependencies,
      ...name === team ? { exports: { '.': { default: './lib/index.js' }, './types': { default: './lib/types/types.js' } } } : {},
    }))
    for (const [file, body] of Object.entries(files)) {
      if (body === null) continue
      const path = join(packageRoot, file)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, body)
    }
    const tarball = join(input, `package-${index}.tgz`)
    execFileSync('tar', ['-czf', basename(tarball), '-C', staging, 'package'], { cwd: input })
  }
  return { input, output }
}

describe('private Katcats packed module imports', () => {
  it.each([
    { name: 'entry chunk', files: { 'lib/index.js': "import './memory-deadbeef.js'" } },
    { name: 'transitive re-export', files: { 'lib/index.js': "import './shared-123.js'", 'lib/shared-123.js': "export { value } from './leaf-456.js'" } },
    { name: 'literal dynamic import', files: { 'lib/memory.js': "export function load() { return import('./memory-lazy-789.js') }" } },
    { name: 'public runtime export', files: { 'lib/types/types.js': "export { value } from './public-missing-234.js'" } },
  ])('rejects a missing $name before replacing an existing package set', ({ files }) => {
    const { input, output } = tarballFixture(files)
    expect(() => { prepareDesktopPackageSet([input], output) }).toThrow(/katcats-team.*missing.*\.js/u)
    expect(readFileSync(join(output, 'sentinel.txt'), 'utf8')).toBe('existing package set')
    expect(existsSync(join(output, 'desktop-packages.json'))).toBe(false)
  })

  it('rejects an omitted public runtime entry before preparing the package set', () => {
    const { input, output } = tarballFixture({ 'lib/chats.js': null })
    expect(() => { prepareDesktopPackageSet([input], output) }).toThrow(/katcats-team.*lib\/chats\.js/u)
    expect(readFileSync(join(output, 'sentinel.txt'), 'utf8')).toBe('existing package set')
  })

  it('accepts a complete shared-chunk cycle and ignores import-looking comments or strings', () => {
    const { input, output } = tarballFixture({
      'lib/index.js': "export { value } from './shared-123.js'\n// import './comment-only.js'\nconst text = \"import './text-only.js'\"",
      'lib/shared-123.js': "import './index.js'\nexport const value = 1",
      'lib/types/client/unused.js': "import './Unused.module.css'\nexport const component = null",
    })
    prepareDesktopPackageSet([input], output)
    const descriptor = JSON.parse(readFileSync(join(output, 'desktop-packages.json'), 'utf8')) as {
      packages: { name: string; integrity: string }[]
    }
    expect(descriptor.packages.map(entry => entry.name)).toEqual([
      '@deepseek-ai/dsh', '@deepseek-ai/dsh-client-katcats-team', '@deepseek-ai/dsh-desktop-host',
    ])
    expect(descriptor.packages.every(entry => entry.integrity.startsWith('sha512-'))).toBe(true)
  })
})
