/** Xiaojing product identity, durable paths, and Host launch environment. */

import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { App } from 'electron'

interface XiaojingIdentity {
  readonly packageName: string
  readonly productVersion: string
  readonly appId: string
  readonly nsisGuid: string
  readonly installDirectoryName: string
  readonly executableName: string
  readonly productName: string
  readonly installScope: 'currentUser'
  readonly shortcutName: string
  readonly userDataSegments: readonly string[]
}

function readIdentity(): XiaojingIdentity {
  const value: unknown = JSON.parse(readFileSync(new URL('../identity.json', import.meta.url), 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Katcats desktop: invalid identity manifest')
  }
  const row = value as Record<string, unknown>
  const userDataSegments = row.userDataSegments
  if (typeof row.packageName !== 'string' || typeof row.productVersion !== 'string' || typeof row.appId !== 'string'
    || typeof row.nsisGuid !== 'string' || typeof row.installDirectoryName !== 'string'
    || typeof row.executableName !== 'string' || typeof row.productName !== 'string'
    || row.installScope !== 'currentUser' || typeof row.shortcutName !== 'string'
    || !Array.isArray(userDataSegments) || userDataSegments.length === 0
    || userDataSegments.some(segment => typeof segment !== 'string' || segment.length === 0)) {
    throw new Error('Katcats desktop: invalid identity manifest fields')
  }
  return {
    packageName: row.packageName,
    productVersion: row.productVersion,
    appId: row.appId,
    nsisGuid: row.nsisGuid,
    installDirectoryName: row.installDirectoryName,
    executableName: row.executableName,
    productName: row.productName,
    installScope: row.installScope,
    shortcutName: row.shortcutName,
    userDataSegments,
  }
}

/** Permanent Xiaojing installer and application identity. */
export const XIAOJING_IDENTITY = Object.freeze(readIdentity())

/** Installer-only request sent to an existing process before replacing application files. */
export const XIAOJING_UPDATE_SHUTDOWN_ARGUMENT = '--xiaojing-accounting-team-shutdown-for-update'

/** Xiaojing application-owned data and workspace paths. */
export interface XiaojingDesktopPaths {
  readonly userData: string
  readonly dshHome: string
  readonly workspaceRoot: string
  readonly officeWorkspace: string
}

function clearInheritedProductPaths(environment: NodeJS.ProcessEnv): void {
  const names = new Set([
    'DSH_HOME', 'DSH_AGENTS_HOME', 'DSH_BUNDLED_SKILL_DIR', 'DSH_DESKTOP_DSH_DIR', 'DSH_DESKTOP_PNPM_ENTRY',
    'DSH_DESKTOP_PRIMARY_RUNTIME_DIR', 'DSH_DESKTOP_NODE_EXECUTABLE', 'DSH_DESKTOP_USER_DATA_DIR',
    'DSH_DESKTOP_UPDATE_JOURNAL_DIR', 'DSH_DESKTOP_MANDATORY_UPDATE_CONFIG', 'DSH_DESKTOP_DIAGNOSTIC_FILE',
    'XIAOJING_OFFICE_WORKSPACE_ROOT', 'XIAOJING_FINANCE_WORKSPACE_ROOT', 'XIAOJING_EDGE_EXTENSION_DIR',
    'NODE_OPTIONS', 'NODE_PATH',
  ])
  for (const name of Object.keys(environment)) {
    const upper = name.toUpperCase()
    if (names.has(upper) || (upper.startsWith('XIAOJING_') && !upper.startsWith('XIAOJING_TEAM_'))) {
      Reflect.deleteProperty(environment, name)
    }
  }
}

function developmentDirectory(repositoryRoot: string, directory: string): void {
  let path = repositoryRoot
  for (const segment of relative(repositoryRoot, directory).split(sep)) {
    path = join(path, segment)
    try { lstatSync(path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      mkdirSync(path, { mode: 0o700 })
    }
    const entry = lstatSync(path)
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Katcats development: expected an unlinked directory at ${path}`)
    }
  }
}

function initializeKatcatsDevelopment(
  application: Pick<App, 'setPath' | 'setName' | 'setAppUserModelId'>,
  environment: NodeJS.ProcessEnv,
  repositoryRoot: string,
): XiaojingDesktopPaths {
  const repository = resolve(repositoryRoot)
  const root = join(repository, 'run')
  const preview = join(root, 'desktop')
  const home = join(root, 'home')
  const workspace = join(root, 'workspaces')
  const locations = {
    KATCATS_DEV_ROOT: root,
    DSH_HOME: home,
    DSH_AGENTS_HOME: join(root, 'agents'),
    DSH_DESKTOP_PREVIEW_ROOT: preview,
    XIAOJING_OFFICE_WORKSPACE_ROOT: workspace,
  }
  for (const [name, expected] of Object.entries(locations)) {
    const value = environment[name]
    if (value === undefined || !isAbsolute(value) || relative(expected, resolve(value)) !== '') {
      throw new Error(`Katcats development: ${name} must point to ${expected}`)
    }
  }
  if (lstatSync(repository).isSymbolicLink()) {
    throw new Error('Katcats development: the checkout directory must not be redirected by a link')
  }
  const appData = join(preview, 'app-data')
  const documents = join(preview, 'documents')
  const userData = join(appData, 'XiaojingAccountingTeam-Dev')
  const sessionData = join(preview, 'session-data')
  for (const directory of [...Object.values(locations), appData, documents, userData, sessionData, join(userData, 'logs')]) {
    developmentDirectory(repository, directory)
  }
  application.setPath('appData', appData)
  application.setPath('documents', documents)
  application.setPath('userData', userData)
  application.setPath('sessionData', sessionData)
  application.setName('小兢Bot Dev')
  application.setAppUserModelId('ai.xiaojing.accounting.team.development')
  return { userData, dshHome: home, workspaceRoot: workspace, officeWorkspace: workspace }
}

/**
 * Pin Xiaojing's permanent data paths before claiming the single-instance lock.
 * Unpackaged previews may redirect both application data and Documents into an isolated directory.
 * Katcats development requires this checkout's run-local paths and uses a temporary application identity.
 * @param application - Electron application singleton before `ready`.
 * @param environment - Process environment containing the optional preview root.
 * @param repositoryRoot - Checkout root for Katcats development; defaults to this source checkout.
 * @returns Resolved paths shared by the main process and Host child.
 */
export function initializeXiaojingApplication(
  application: Pick<App, 'isPackaged' | 'getPath' | 'setPath' | 'setName' | 'setAppUserModelId'>,
  environment: NodeJS.ProcessEnv = process.env,
  repositoryRoot: string = resolve(import.meta.dirname, '..', '..', '..'),
): XiaojingDesktopPaths {
  if (!application.isPackaged && environment.KATCATS_DEV_MODE === '1') {
    return initializeKatcatsDevelopment(application, environment, repositoryRoot)
  }
  clearInheritedProductPaths(environment)
  if (application.isPackaged) {
    for (const name of Object.keys(environment)) {
      if (['KATCATS_DEV_MODE', 'KATCATS_DEV_ROOT', 'DSH_DESKTOP_PREVIEW_ROOT'].includes(name.toUpperCase())) {
        Reflect.deleteProperty(environment, name)
      }
    }
  }
  const previewRoot = !application.isPackaged ? environment.DSH_DESKTOP_PREVIEW_ROOT?.trim() : undefined
  if (previewRoot !== undefined && previewRoot !== '') {
    const root = resolve(previewRoot)
    const appData = join(root, 'app-data')
    const documents = join(root, 'documents')
    mkdirSync(appData, { recursive: true })
    mkdirSync(documents, { recursive: true })
    application.setPath('appData', appData)
    application.setPath('documents', documents)
  }

  const userData = join(application.getPath('appData'), ...XIAOJING_IDENTITY.userDataSegments)
  application.setName(XIAOJING_IDENTITY.productName)
  application.setAppUserModelId(XIAOJING_IDENTITY.appId)
  const workspaceRoot = join(application.getPath('documents'), 'XiaojingAccountingTeam_Home')
  const paths = {
    userData,
    dshHome: join(userData, 'harness'),
    workspaceRoot,
    officeWorkspace: workspaceRoot,
  }
  for (const path of [paths.userData, join(userData, 'session-data'), paths.dshHome, paths.officeWorkspace]) {
    mkdirSync(path, { recursive: true })
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) {
      throw new Error(`小兢Bot: expected an unlinked directory at ${path}`)
    }
  }
  application.setPath('userData', userData)
  application.setPath('sessionData', join(userData, 'session-data'))
  environment.DSH_HOME = paths.dshHome
  environment.DSH_AGENTS_HOME = join(paths.dshHome, 'agents')
  environment.XIAOJING_OFFICE_WORKSPACE_ROOT = paths.officeWorkspace
  return paths
}

/**
 * Build the Team Host environment with product-owned data roots and without inherited runtime paths or API keys.
 * @param application - Electron packaging state used to locate the bundled Edge extension.
 * @param paths - Product data and workspace paths.
 * @param environment - Ambient environment copied for the child process.
 * @returns Host environment with Xiaojing composition and durable roots selected.
 */
export function xiaojingHostEnvironment(
  application: Pick<App, 'isPackaged'>,
  paths: XiaojingDesktopPaths,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const inherited = { ...environment }
  clearInheritedProductPaths(inherited)
  for (const name of Object.keys(inherited)) {
    if ((!name.toUpperCase().startsWith('XIAOJING_TEAM_') && /KEY|SECRET|TOKEN|PASSWORD/iu.test(name))
      || name.toUpperCase() === 'DSH_DESKTOP_PREVIEW_ROOT'
      || (application.isPackaged && ['KATCATS_DEV_MODE', 'KATCATS_DEV_ROOT'].includes(name.toUpperCase()))) {
      Reflect.deleteProperty(inherited, name)
    }
  }
  const result: NodeJS.ProcessEnv = {
    ...inherited,
    DSH_CLIENT_BUILD_PROFILE: 'xiaojing',
    KATCATS_PRODUCT_MODE: '1',
    DSH_HOME: paths.dshHome,
    DSH_AGENTS_HOME: !application.isPackaged && environment.KATCATS_DEV_MODE === '1'
      ? join(paths.dshHome, '..', 'agents') : join(paths.dshHome, 'agents'),
    XIAOJING_OFFICE_WORKSPACE_ROOT: paths.officeWorkspace,
    DSH_TELEMETRY_DISABLED: '1',
    XIAOJING_TEAM_EDGE_EXTENSION_DIR: application.isPackaged
      ? join(process.resourcesPath, 'xiaojing-team-edge-extension')
      : resolve(import.meta.dirname, '..', '..', '..', 'packages', 'xiaojing', 'xiaojing-browser-control', 'extension'),
    NODE_USE_ENV_PROXY: environment.NODE_USE_ENV_PROXY ?? '1',
    NO_COLOR: '1',
  }
  return result
}

/**
 * Refuse an unpackaged preview whose shared Client artifacts were built for another product.
 * Packaged runtimes were checked during preparation and do not carry the repository record.
 * @param repositoryRoot - Repository root containing `.dsh-build/client-build-environment.json`.
 * @param packaged - Whether Electron is running a packaged application.
 */
export function assertXiaojingDesktopClientBuild(repositoryRoot: string, packaged: boolean): void {
  if (packaged) return
  const recordPath = join(repositoryRoot, '.dsh-build', 'client-build-environment.json')
  if (!existsSync(recordPath)) {
    throw new Error('缺少Katcats前端构建记录，请先运行 pnpm run build:xiaojing。')
  }
  let record: unknown
  try { record = JSON.parse(readFileSync(recordPath, 'utf8')) }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Katcats前端构建记录无效，请重新运行 pnpm run build:xiaojing：${detail}`)
  }
  if (typeof record !== 'object' || record === null || !('environment' in record)
    || typeof record.environment !== 'object' || record.environment === null
    || !('DSH_CLIENT_BUILD_PROFILE' in record.environment)
    || record.environment.DSH_CLIENT_BUILD_PROFILE !== 'xiaojing') {
    throw new Error('当前前端产物不是Katcats版本，请运行 pnpm run build:xiaojing 后再启动桌面预览。')
  }
}

/** Return whether an application invocation asks the running Xiaojing process to exit for an in-place update. */
export function isXiaojingUpdateShutdown(argv: readonly string[]): boolean {
  return argv.includes(XIAOJING_UPDATE_SHUTDOWN_ARGUMENT)
}
