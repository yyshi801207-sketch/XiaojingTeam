/** Checkout commit or explicitly modified source-copy baseline recorded by packaging. */
export interface DesktopBuildCommit {
  readonly commit: string
  readonly dirty: boolean
  /** A baseline identifies the copied starting revision, not the current source tree. */
  readonly source?: 'copy-baseline'
}

/** Environment variable that carries the packaged commit. */
export const DESKTOP_BUILD_COMMIT_ENV: 'DSH_DESKTOP_BUILD_COMMIT'

/** Environment variable that records whether the packaged checkout had uncommitted changes. */
export const DESKTOP_BUILD_DIRTY_ENV: 'DSH_DESKTOP_BUILD_DIRTY'

/** Environment variable that distinguishes a source-copy baseline from a checkout commit. */
export const DESKTOP_BUILD_SOURCE_ENV: 'DSH_DESKTOP_BUILD_SOURCE'

/**
 * Read the checkout commit, or an explicitly modified baseline for an unsigned Katcats source copy.
 * @param repositoryRoot - Directory to inspect.
 * @param options - Validated desktop identity and packaging mode.
 * @returns Checkout commit or labeled copy baseline and modified state.
 */
export function readDesktopBuildCommit(repositoryRoot: string, options?: {
  appId: string
  productName: string
  unsigned: boolean
}): DesktopBuildCommit

/**
 * Resolve the commit a parent packaging process recorded.
 * @param env - Packaging environment.
 * @returns The packaged commit, or undefined outside a packaging run.
 */
export function resolveDesktopBuildCommit(env: NodeJS.ProcessEnv): DesktopBuildCommit | undefined

/**
 * Describe the packaged commit as the environment variables child processes read.
 * @param packaged - Commit and tree state to pass down.
 * @returns Variables to merge into a child environment.
 */
export function desktopBuildCommitEnvironment(packaged: DesktopBuildCommit): Record<string, string>
