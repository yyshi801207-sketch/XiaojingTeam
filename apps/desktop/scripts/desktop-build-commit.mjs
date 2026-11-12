/**
 * Carry a checkout revision or explicitly labeled source-copy baseline into artifacts.
 *
 * A build that reaches a colleague or a test feed is not reachable from a tag,
 * so the only way back to its sources is what the build recorded about itself.
 * A copy baseline identifies the starting revision, not the modified copy.
 * The packaging entry reads the source once and passes the result to every
 * child process, which run against a build tree rather than a checkout.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Environment variable that carries the packaged commit. */
export const DESKTOP_BUILD_COMMIT_ENV = 'DSH_DESKTOP_BUILD_COMMIT'

/** Environment variable that records whether the packaged checkout had uncommitted changes. */
export const DESKTOP_BUILD_DIRTY_ENV = 'DSH_DESKTOP_BUILD_DIRTY'

/** Environment variable that distinguishes a source-copy baseline from a checkout commit. */
export const DESKTOP_BUILD_SOURCE_ENV = 'DSH_DESKTOP_BUILD_SOURCE'

/**
 * Read the checkout commit, or an explicitly modified baseline for an unsigned Katcats source copy.
 * @param {string} repositoryRoot - Directory to inspect.
 * @param {{ appId: string, productName: string, unsigned: boolean }} [options] - Validated desktop identity and packaging mode.
 * @returns {{ commit: string, dirty: boolean, source?: 'copy-baseline' }} Checkout commit or labeled copy baseline and modified state.
 */
export function readDesktopBuildCommit(repositoryRoot, options) {
  if (!existsSync(join(repositoryRoot, '.git')) && options !== undefined) {
    if (!options.unsigned || options.appId !== 'ai.xiaojing.accounting.team.desktop' || options.productName !== '小兢财务') {
      throw new Error('desktop build commit: copy baselines require unsigned 小兢财务 packaging')
    }
    let report
    try {
      report = JSON.parse(readFileSync(join(repositoryRoot, 'KATCATS-COPY-VERIFICATION.json'), 'utf8'))
    } catch (error) {
      throw new Error('desktop build commit: a valid copy verification report is required', { cause: error })
    }
    if (report === null || typeof report !== 'object' || Array.isArray(report)
      || typeof report.sourceHead !== 'string' || !/^[0-9a-f]{40}$/u.test(report.sourceHead)
      || typeof report.destination !== 'string' || resolve(report.destination) !== resolve(repositoryRoot)
      || report.gitHistoryCopied !== false) {
      throw new Error('desktop build commit: the copy verification report must identify this directory and its baseline commit')
    }
    return { commit: report.sourceHead, dirty: true, source: 'copy-baseline' }
  }
  const git = (args) => execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim()
  return {
    commit: git(['rev-parse', 'HEAD']),
    dirty: git(['status', '--porcelain', '--untracked-files=normal']) !== '',
  }
}

/**
 * Resolve the commit a parent packaging process recorded.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {{ commit: string, dirty: boolean, source?: 'copy-baseline' } | undefined} The checkout commit or labeled baseline, or undefined outside packaging.
 */
export function resolveDesktopBuildCommit(env) {
  const commit = env[DESKTOP_BUILD_COMMIT_ENV]?.trim()
  if (commit === undefined || commit === '') return undefined
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`desktop build commit: ${DESKTOP_BUILD_COMMIT_ENV} must be a commit hash`)
  const dirty = env[DESKTOP_BUILD_DIRTY_ENV]?.trim()
  if (dirty !== undefined && dirty !== '' && dirty !== '0' && dirty !== '1') {
    throw new Error(`desktop build commit: ${DESKTOP_BUILD_DIRTY_ENV} must be 0 or 1`)
  }
  const source = env[DESKTOP_BUILD_SOURCE_ENV]?.trim()
  if (source !== undefined && source !== '' && source !== 'copy-baseline') {
    throw new Error('desktop build commit: unknown build source')
  }
  if (source === 'copy-baseline') {
    if (dirty !== '1') throw new Error('desktop build commit: a copy baseline must be marked modified')
    return { commit, dirty: true, source }
  }
  return { commit, dirty: dirty === '1' }
}

/**
 * Describe the packaged commit as the environment variables child processes read.
 * @param {{ commit: string, dirty: boolean, source?: 'copy-baseline' }} packaged - Checkout commit or labeled baseline and modified state to pass down.
 * @returns {Record<string, string>} Variables to merge into a child environment.
 */
export function desktopBuildCommitEnvironment(packaged) {
  return {
    [DESKTOP_BUILD_COMMIT_ENV]: packaged.commit,
    [DESKTOP_BUILD_DIRTY_ENV]: packaged.dirty ? '1' : '0',
    [DESKTOP_BUILD_SOURCE_ENV]: packaged.source ?? '',
  }
}
