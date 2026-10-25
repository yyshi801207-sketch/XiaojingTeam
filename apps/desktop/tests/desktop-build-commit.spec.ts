import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_BUILD_COMMIT_ENV,
  DESKTOP_BUILD_DIRTY_ENV,
  DESKTOP_BUILD_SOURCE_ENV,
  desktopBuildCommitEnvironment,
  readDesktopBuildCommit,
  resolveDesktopBuildCommit,
} from '../scripts/desktop-build-commit.mjs'
import { probeDesktopToolchain } from '../scripts/desktop-toolchain-preflight.ts'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const directories: string[] = []
const katcatsUnsigned = { appId: 'ai.xiaojing.accounting.team.desktop', productName: '小兢会计团队版', unsigned: true }

async function sourceCopy(report: object = { sourceHead: COMMIT }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'katcats-build-source-'))
  directories.push(directory)
  await writeFile(join(directory, 'KATCATS-COPY-VERIFICATION.json'), JSON.stringify({
    destination: directory, gitHistoryCopied: false, ...report,
  }))
  return directory
}

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('desktop build commit', () => {
  it('reads nothing outside a packaging run', () => {
    expect(resolveDesktopBuildCommit({})).toBeUndefined()
    expect(resolveDesktopBuildCommit({ [DESKTOP_BUILD_COMMIT_ENV]: '  ' })).toBeUndefined()
  })

  it('round-trips a commit and its tree state through a child environment', () => {
    for (const dirty of [true, false]) {
      expect(resolveDesktopBuildCommit(desktopBuildCommitEnvironment({ commit: COMMIT, dirty })))
        .toEqual({ commit: COMMIT, dirty })
    }
  })

  it.each(['abc', `${COMMIT}0`, 'Z'.repeat(40)])('rejects %j, which is not a commit hash', (commit) => {
    expect(() => resolveDesktopBuildCommit({ [DESKTOP_BUILD_COMMIT_ENV]: commit })).toThrow(/must be a commit hash/u)
  })

  it('rejects a tree state that is neither 0 nor 1', () => {
    expect(() => resolveDesktopBuildCommit({ [DESKTOP_BUILD_COMMIT_ENV]: COMMIT, [DESKTOP_BUILD_DIRTY_ENV]: 'yes' }))
      .toThrow(/must be 0 or 1/u)
  })

  it('reads a real Git checkout without using its copy report', async () => {
    const directory = await sourceCopy({ sourceHead: 'invalid' })
    for (const name of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME']) vi.stubEnv(name, directory)
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(directory, 'empty-git-config'))
    await writeFile(join(directory, 'empty-git-config'), '')
    const git = (args: string[]): string => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim()
    git(['init', '--quiet', '--template='])
    git(['add', '.'])
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture'])
    const commit = git(['rev-parse', 'HEAD'])
    expect(readDesktopBuildCommit(directory, { ...katcatsUnsigned, unsigned: false })).toEqual({ commit, dirty: false })
    await writeFile(join(directory, 'untracked.txt'), 'changed')
    expect(readDesktopBuildCommit(directory, katcatsUnsigned)).toEqual({ commit, dirty: true })
  })

  it('records a verified unsigned Katcats source copy as a modified baseline, never a current commit', async () => {
    const directory = await sourceCopy()
    const baseline = readDesktopBuildCommit(directory, katcatsUnsigned)
    expect(baseline).toEqual({ commit: COMMIT, dirty: true, source: 'copy-baseline' })
    expect(resolveDesktopBuildCommit(desktopBuildCommitEnvironment(baseline))).toEqual(baseline)
  })

  it.each([
    { ...katcatsUnsigned, unsigned: false },
    { ...katcatsUnsigned, appId: 'ai.katcat.desktop' },
    { ...katcatsUnsigned, productName: 'Katcat.AI' },
  ])('rejects the copy baseline for another product or signing mode: %j', async (options) => {
    const directory = await sourceCopy()
    expect(() => readDesktopBuildCommit(directory, options)).toThrow(/unsigned 小兢会计团队版/u)
  })

  it.each([
    { sourceHead: 'invalid' },
    { sourceHead: 'Z'.repeat(40) },
    { sourceHead: COMMIT, destination: 'different-copy' },
    { sourceHead: COMMIT, gitHistoryCopied: true },
  ])('rejects a copy report that cannot identify this baseline: %j', async (report) => {
    const directory = await sourceCopy(report)
    expect(() => readDesktopBuildCommit(directory, katcatsUnsigned)).toThrow(/copy verification report/u)
  })

  it('fails when the no-Git copy report is missing or invalid JSON', async () => {
    const directory = await sourceCopy()
    const report = join(directory, 'KATCATS-COPY-VERIFICATION.json')
    await rm(report)
    expect(() => readDesktopBuildCommit(directory, katcatsUnsigned)).toThrow(/copy verification report/u)
    await writeFile(report, 'not JSON')
    expect(() => readDesktopBuildCommit(directory, katcatsUnsigned)).toThrow(/copy verification report/u)
  })

  it('rejects unknown source labels and a baseline described as a clean checkout', () => {
    expect(() => resolveDesktopBuildCommit({
      [DESKTOP_BUILD_COMMIT_ENV]: COMMIT, [DESKTOP_BUILD_SOURCE_ENV]: 'current-copy',
    })).toThrow(/source/u)
    expect(() => resolveDesktopBuildCommit({
      [DESKTOP_BUILD_COMMIT_ENV]: COMMIT, [DESKTOP_BUILD_DIRTY_ENV]: '0', [DESKTOP_BUILD_SOURCE_ENV]: 'copy-baseline',
    })).toThrow(/modified/u)
  })
})

describe('desktop toolchain preflight', () => {
  it('passes on a host that can read archives', async () => {
    expect(await probeDesktopToolchain('darwin', {})).toEqual([])
  })

  it('reports the archive reader when it cannot run', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'dsh-no-tools-'))
    directories.push(empty)
    const saved = { PATH: process.env.PATH, Path: process.env.Path }
    try {
      Object.assign(process.env, { PATH: empty, Path: empty })
      const failures = await probeDesktopToolchain('darwin', {})
      expect(failures.map(failure => failure.tool)).toEqual(['tar'])
      expect(failures[0]?.detail).not.toBe('')
    }
    finally {
      Object.assign(process.env, saved)
    }
  })

  it('reports the Windows installer compiler when the host cannot locate Visual Studio', async () => {
    const failures = await probeDesktopToolchain('win32', {})
    expect(failures.map(failure => failure.tool)).toContain('vswhere')
    expect(failures.find(failure => failure.tool === 'vswhere')?.detail).toContain('ProgramFiles(x86)')
  })

  it('writes nothing into the working directory while probing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-probe-cwd-'))
    directories.push(directory)
    await writeFile(join(directory, 'sentinel'), '')
    await probeDesktopToolchain('darwin', {})
    expect(await import('node:fs/promises').then(async fs => fs.readdir(directory))).toEqual(['sentinel'])
  })
})
