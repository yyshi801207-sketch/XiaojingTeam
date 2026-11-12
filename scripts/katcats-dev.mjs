/** Run the independent 小兢财务 development copy with project-owned state and tools. */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MODES = ['check', 'deps', 'build', 'web', 'desktop']
const SYSTEM_NAMES = ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT',
  'PATH', 'Path', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'TERM', 'COLORTERM', 'LANG', 'LC_ALL']

function inside(root, target) {
  const name = relative(root, target)
  return name === '' || (!isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`))
}

function localPath(root, target) {
  if (!inside(root, resolve(target))) throw new Error(`Path leaves the 小兢财务 project: ${target}`)
  if (existsSync(target) && !inside(realpathSync(root), realpathSync(target))) {
    throw new Error(`Linked path leaves the 小兢财务 project: ${target}`)
  }
  return target
}

function directory(root, target) {
  const run = join(root, 'run')
  if (!inside(run, target)) throw new Error(`Development directory leaves run: ${target}`)
  let current = root
  for (const part of relative(root, target).split(sep)) {
    current = join(current, part)
    let entry
    try { entry = lstatSync(current) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      mkdirSync(current)
      entry = lstatSync(current)
    }
    if (entry.isSymbolicLink()) {
      const actual = realpathSync(current)
      if (current === run || !inside(realpathSync(run), actual)) {
        throw new Error(`Development directory links outside its owned run tree: ${current}`)
      }
    }
    if (!statSync(current).isDirectory()) throw new Error(`Development directory is not a directory: ${current}`)
  }
  return target
}

function emptyFile(root, target) {
  localPath(root, target)
  try { writeFileSync(target, '', { flag: 'wx', mode: 0o600 }) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    if (lstatSync(target).isSymbolicLink() || !statSync(target).isFile() || statSync(target).size !== 0) {
      throw new Error(`Expected an empty project-owned tool configuration: ${target}`)
    }
  }
  return target
}

/**
 * Prepare private development directories, refusing links into another application's files.
 * @param {string} root Project root; the command-line entry always supplies its own repository.
 * @returns {Record<string, string>} Absolute project-owned paths.
 */
export function prepareRun(root) {
  root = resolve(root)
  const paths = { root, run: join(root, 'run') }
  for (const name of ['home', 'agents', 'desktop', 'workspaces', 'tmp', 'logs', 'tooling', 'cache', 'user']) {
    paths[name] = directory(root, join(paths.run, name))
  }
  for (const name of ['npm', 'pnpm-store', 'corepack', 'electron', 'electron-builder', 'playwright', 'puppeteer', 'uv']) {
    paths[name] = directory(root, join(paths.cache, name))
  }
  // Downloaded builder tools are CommonJS .js files beneath this ESM repository.
  const builderManifest = localPath(root, join(paths['electron-builder'], 'package.json'))
  if (existsSync(builderManifest) && lstatSync(builderManifest).isSymbolicLink()) {
    throw new Error(`Tool cache package metadata must not be a link: ${builderManifest}`)
  }
  writeFileSync(builderManifest, '{"private":true,"type":"commonjs"}\n')
  for (const name of ['config', 'data', 'state', 'runtime']) paths[`xdg-${name}`] = directory(root, join(paths.user, name))
  paths.appData = directory(root, join(paths.user, 'AppData', 'Roaming'))
  paths.localAppData = directory(root, join(paths.user, 'AppData', 'Local'))
  paths.pnpmHome = directory(root, join(paths.tooling, 'bin'))
  paths.npmPrefix = directory(root, join(paths.tooling, 'npm-prefix'))
  paths.desktopData = directory(root, join(paths.desktop, 'app-data', 'XiaojingAccountingTeam-Dev'))
  paths.userConfig = emptyFile(root, join(paths.tooling, 'npm-user.config'))
  paths.globalConfig = emptyFile(root, join(paths.tooling, 'npm-global.config'))
  paths.gitConfig = emptyFile(root, join(paths.tooling, 'git.config'))
  emptyFile(root, join(paths.tooling, '.npmrc'))
  return paths
}

/**
 * Copy only named operating-system variables, then replace all application state and cache locations.
 * @param {Record<string, string>} paths Prepared development paths.
 * @param {Record<string, string | undefined>} inherited Parent environment; unlisted values are never read.
 * @param {string} executable Node executable used for the launcher and child tools.
 * @returns {Record<string, string>} Environment passed explicitly to every child process.
 */
export function developmentEnvironment(paths, inherited, executable = process.execPath) {
  const env = {}
  for (const name of SYSTEM_NAMES) {
    const value = inherited[name]
    if (value !== undefined) env[name.toUpperCase()] = value
  }
  const pathSeparator = process.platform === 'win32' ? ';' : ':'
  const excludedDirectories = new Set(['node_modules', 'katcat.ai', 'katcats.ai', '小兢会计0.3.3-个性版',
    '小兢会计0.2.3后续开发', '小兢办公v1.0-开发基线'])
  const inheritedPaths = (env.PATH ?? '').split(pathSeparator).filter(entry => {
    if (entry === '') return false
    const target = resolve(paths.root, entry.replace(/^"(.*)"$/, '$1'))
    return inside(paths.root, target)
      || !target.split(/[\\/]/).some(segment => excludedDirectories.has(segment.toLowerCase()))
  })
  env.PATH = [join(paths.tooling, 'node_modules', '.bin'), join(paths.root, 'node_modules', '.bin'),
    dirname(executable), ...inheritedPaths].join(pathSeparator)
  return Object.assign(env, {
    HOME: paths.user, USERPROFILE: paths.user, APPDATA: paths.appData, LOCALAPPDATA: paths.localAppData,
    TEMP: paths.tmp, TMP: paths.tmp, TMPDIR: paths.tmp,
    XDG_CONFIG_HOME: paths['xdg-config'], XDG_DATA_HOME: paths['xdg-data'], XDG_STATE_HOME: paths['xdg-state'],
    XDG_CACHE_HOME: paths.cache, XDG_RUNTIME_DIR: paths['xdg-runtime'],
    DSH_HOME: paths.home, DSH_AGENTS_HOME: paths.agents, DSH_TELEMETRY_DISABLED: '1', DSH_CLIENT_BUILD_PROFILE: 'xiaojing',
    KATCATS_DEV_MODE: '1', KATCATS_PRODUCT_MODE: '1', KATCATS_DEV_ROOT: paths.run,
    DSH_DESKTOP_PREVIEW_ROOT: paths.desktop, DSH_DESKTOP_USER_DATA_DIR: paths.desktopData,
    DSH_DESKTOP_RENDERER_DEBUG_PORT: '19422', DSH_DESKTOP_MAIN_INSPECT_PORT: '19429',
    DSH_DESKTOP_HOST_INSPECT_PORT: '19430', DSH_DESKTOP_OPEN_DEVTOOLS: '0',
    XIAOJING_OFFICE_WORKSPACE_ROOT: paths.workspaces,
    NPM_CONFIG_USERCONFIG: paths.userConfig, NPM_CONFIG_GLOBALCONFIG: paths.globalConfig,
    NPM_CONFIG_CACHE: paths.npm, NPM_CONFIG_PREFIX: paths.npmPrefix,
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/', NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    PNPM_HOME: paths.pnpmHome, PNPM_STORE_DIR: paths['pnpm-store'],
    COREPACK_HOME: paths.corepack, COREPACK_ENABLE_AUTO_PIN: '0',
    ELECTRON_CACHE: paths.electron, electron_config_cache: paths.electron, ELECTRON_BUILDER_CACHE: paths['electron-builder'],
    PLAYWRIGHT_BROWSERS_PATH: paths.playwright, PUPPETEER_CACHE_DIR: paths.puppeteer, UV_CACHE_DIR: paths.uv,
    GIT_CONFIG_GLOBAL: paths.gitConfig, GIT_CONFIG_SYSTEM: paths.gitConfig, GIT_CONFIG_NOSYSTEM: '1',
  })
}

/**
 * Accept only development modes and an optional explicit local Web port.
 * @param {string[]} argv Arguments after the script path.
 * @returns {{ mode: string, port: number }} Validated development invocation.
 */
export function parseArguments(argv) {
  const mode = argv[0] ?? 'check'
  if (!MODES.includes(mode)) throw new Error(`小兢财务: Usage: npm run team:<${MODES.join('|')}> [web: -- --port 3390]`)
  let port = 3390
  if (argv.length > 1) {
    if (mode !== 'web' || argv.length !== 3 || argv[1] !== '--port' || !/^\d+$/.test(argv[2])) {
      throw new Error('Only web accepts additional arguments: --port <1..65535>')
    }
    port = Number(argv[2])
    if (port < 1 || port > 65535) throw new Error('Web port must be from 1 to 65535')
  }
  return { mode, port }
}

function fileReady(root, path) {
  localPath(root, path)
  return existsSync(path) && statSync(path).isFile()
}

/**
 * Inspect dependency and build artifact locations without reading credentials or dotenv files.
 * @param {Record<string, string>} paths Prepared project paths.
 * @returns {{ pnpm: string, tsx: string, npm: string, ready: Record<string, boolean> }} Tool paths and readiness.
 */
export function dependencyState(paths) {
  const pnpm = join(paths.tooling, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  const tsx = join(paths.root, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')
  const npm = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return { pnpm, tsx, npm, ready: {
    pnpm: fileReady(paths.root, pnpm), tsx: fileReady(paths.root, tsx),
    typescript: fileReady(paths.root, join(paths.root, 'node_modules', 'typescript', 'bin', 'tsc')),
    web: fileReady(paths.root, join(paths.root, 'apps', 'web', 'dist', 'index.html')),
    desktop: fileReady(paths.root, join(paths.root, 'apps', 'desktop', 'lib', 'main.js')),
  } }
}

function requireReady(state, names) {
  const missing = names.filter(name => !state.ready[name])
  if (missing.length > 0) {
    throw new Error(`Missing ${missing.join(', ')}. Run team:deps, then team:build before previewing.`)
  }
}

function buildRevision(root, env) {
  const gitDir = localPath(root, join(root, '.git'))
  let metadata
  try { metadata = lstatSync(gitDir) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (metadata !== undefined) {
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`Build requires this checkout's unlinked .git directory: ${gitDir}`)
    }
    let head
    try {
      head = execFileSync('git', ['--git-dir', gitDir, '--work-tree', root, 'rev-parse', '--verify', 'HEAD^{commit}'],
        { cwd: root, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    } catch (error) {
      throw new Error(`Build requires a committed Git HEAD in this checkout: ${gitDir}. Commit the local baseline before building.`, { cause: error })
    }
    if (!/^[a-f0-9]{40}$/i.test(head)) throw new Error(`Build requires a 40-character hexadecimal local Git HEAD: ${gitDir}`)
    return head
  }
  const report = localPath(root, join(root, 'KATCATS-COPY-VERIFICATION.json'))
  let sourceHead
  try { sourceHead = JSON.parse(readFileSync(report, 'utf8')).sourceHead } catch {
    throw new Error(`Build requires a valid copy verification report: ${report}`)
  }
  if (typeof sourceHead !== 'string' || !/^[a-f0-9]{40}$/i.test(sourceHead)) {
    throw new Error(`Build requires a 40-character hexadecimal sourceHead in ${report}`)
  }
  return sourceHead
}

/**
 * Resolve one supported application/build command; arbitrary commands and packaging are not exposed.
 * @param {{ mode: string, port: number }} invocation Validated invocation.
 * @param {Record<string, string>} paths Project-owned paths.
 * @param {ReturnType<typeof dependencyState>} state Dependency readiness.
 * @param {Record<string, string>} env Sanitized child environment.
 * @returns {{ command: string, args: string[], cwd: string, env: Record<string, string> }} Child invocation.
 */
export function applicationCommand(invocation, paths, state, env) {
  requireReady(state, ['pnpm', 'tsx', 'typescript'])
  let args
  let childEnv = env
  if (invocation.mode === 'build') {
    args = [state.pnpm, 'run', 'build:xiaojing']
    childEnv = { ...env, DSH_CLIENT_COMMIT_HASH: buildRevision(paths.root, env) }
  } else if (invocation.mode === 'web') {
    requireReady(state, ['web'])
    args = ['--import', pathToFileURL(state.tsx).href, join(paths.root, 'apps', 'cli', 'src', 'bin.ts'), 'web',
      '--host', '127.0.0.1', '--port', String(invocation.port), '--no-open']
  } else if (invocation.mode === 'desktop') {
    requireReady(state, ['desktop'])
    args = [state.pnpm, '--filter', '@deepseek-ai/dsh-desktop', 'run', 'start']
  } else throw new Error(`No application command for ${invocation.mode}`)
  return { command: process.execPath, args, cwd: paths.root, env: childEnv }
}

/**
 * Run one owned child process with an explicit environment and propagate failure.
 * @param {{ command: string, args: string[], cwd: string, env: Record<string, string> }} command Child invocation.
 * @param {boolean} capture Capture output for behavior tests instead of inheriting terminal streams.
 * @returns {Promise<{ stdout: string, stderr: string }>} Captured output, empty during interactive execution.
 */
export async function runChild(command, capture = false) {
  const child = spawn(command.command, command.args, {
    cwd: command.cwd, env: command.env, shell: false, windowsHide: true,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  let stdout = ''
  let stderr = ''
  if (capture) {
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  }
  const stop = () => { child.kill('SIGTERM') }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    await new Promise((accept, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => {
        if (code === 0) accept()
        else reject(new Error(`小兢财务 ${command.args[0]} exited with ${signal ?? code}`))
      })
    })
    return { stdout, stderr }
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

async function installDependencies(paths, state, env) {
  const { packageManager } = JSON.parse(readFileSync(join(paths.root, 'package.json'), 'utf8'))
  const version = /^pnpm@(\d+\.\d+\.\d+)(?:\+sha\d+\..+)?$/.exec(packageManager)?.[1]
  if (version === undefined) throw new Error('Expected an exact pnpm version in packageManager')
  if (!state.ready.pnpm) {
    if (!existsSync(state.npm)) throw new Error('A Node installation with its own npm CLI is required to bootstrap local pnpm')
    await runChild({ command: process.execPath, args: [state.npm, 'install', '--prefix', paths.tooling,
      '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--save-exact', `pnpm@${version}`],
    cwd: paths.tooling, env })
  }
  const installed = join(paths.tooling, 'node_modules', 'pnpm', 'package.json')
  localPath(paths.root, installed)
  if (JSON.parse(readFileSync(installed, 'utf8')).version !== version) {
    throw new Error(`Local pnpm does not match packageManager (${version}); remove only run/tooling's pnpm before retrying`)
  }
  await runChild({ command: process.execPath, args: [state.pnpm, 'install', '--frozen-lockfile',
    '--store-dir', paths['pnpm-store']], cwd: paths.root, env })
}

async function main() {
  const invocation = parseArguments(process.argv.slice(2))
  const paths = prepareRun(ROOT)
  const env = developmentEnvironment(paths, process.env)
  const state = dependencyState(paths)
  if (invocation.mode === 'check') {
    console.log(JSON.stringify({ developmentIdentity: '小兢财务 Dev',
      ports: { web: invocation.port, renderer: 19422, main: 19429, host: 19430 },
      project: ROOT, run: paths.run, home: paths.home, agents: paths.agents,
      desktop: paths.desktop, workspaces: paths.workspaces, dependencies: state.ready }, null, 2))
  } else if (invocation.mode === 'deps') await installDependencies(paths, state, env)
  else await runChild(applicationCommand(invocation, paths, state, env))
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`xiaojing-team-dev: ${error.message}`); process.exitCode = 1 })
}
