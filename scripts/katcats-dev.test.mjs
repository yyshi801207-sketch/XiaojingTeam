/** Keyless behavior checks for the independent development launcher. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { applicationCommand, dependencyState, developmentEnvironment, parseArguments, prepareRun, runChild } from './katcats-dev.mjs'

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'katcats-launcher-'))
  t.after(() => { rmSync(root, { recursive: true, force: true }) })
  return root
}

test('conflicting product variables are never read or passed to the child', t => {
  const paths = prepareRun(fixture(t))
  const secretNames = ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DSH_HOME', 'DSH_AGENTS_HOME', 'NODE_OPTIONS',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NPM_TOKEN', 'ELECTRON_RUN_AS_NODE', 'DSH_DESKTOP_USER_DATA_DIR',
    'KATCATS_DEV_ROOT', 'XIAOJING_OFFICE_WORKSPACE_ROOT', 'DSH_CLIENT_COMMIT_HASH', 'DSH_CLIENT_BUILD_PROFILE',
    'electron_config_cache', 'DSH_DESKTOP_RENDERER_DEBUG_PORT', 'DSH_DESKTOP_MAIN_INSPECT_PORT',
    'DSH_DESKTOP_HOST_INSPECT_PORT', 'DSH_DESKTOP_OPEN_DEVTOOLS', 'DSH_BUNDLED_SKILL_DIR',
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
    'PYTHONHOME', 'PYTHONPATH', 'NPM_CONFIG_USERCONFIG', 'GIT_CONFIG_GLOBAL']
  const inherited = { PATH: 'system-tools', SystemRoot: 'C:\\Windows' }
  for (const name of secretNames) Object.defineProperty(inherited, name, {
    enumerable: true,
    get() { throw new Error(`Forbidden parent variable read: ${name}`) },
  })
  const env = developmentEnvironment(paths, inherited)
  for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'NODE_OPTIONS', 'HTTP_PROXY', 'NPM_TOKEN', 'ELECTRON_RUN_AS_NODE']) {
    assert.equal(env[name], undefined)
  }
  for (const name of ['DSH_BUNDLED_SKILL_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PYTHONHOME', 'PYTHONPATH']) {
    assert.equal(env[name], undefined)
  }
  assert.equal(env.DSH_HOME, paths.home)
  assert.equal(env.DSH_AGENTS_HOME, paths.agents)
  assert.equal(env.DSH_CLIENT_BUILD_PROFILE, 'xiaojing')
  assert.equal(env.KATCATS_DEV_MODE, '1')
  assert.equal(env.KATCATS_PRODUCT_MODE, '1')
  assert.equal(env.KATCATS_DEV_ROOT, paths.run)
  assert.equal(env.DSH_DESKTOP_USER_DATA_DIR, join(paths.desktop, 'app-data', 'XiaojingAccountingTeam-Dev'))
  assert.equal(env.electron_config_cache, paths.electron)
  assert.equal(env.DSH_DESKTOP_RENDERER_DEBUG_PORT, '19422')
  assert.equal(env.DSH_DESKTOP_MAIN_INSPECT_PORT, '19429')
  assert.equal(env.DSH_DESKTOP_HOST_INSPECT_PORT, '19430')
  assert.equal(env.DSH_DESKTOP_OPEN_DEVTOOLS, '0')
  assert.equal(env.SYSTEMROOT, 'C:\\Windows')
  assert.ok(env.PATH.startsWith(join(paths.tooling, 'node_modules', '.bin')))
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR',
    'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
    'NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_GLOBALCONFIG', 'NPM_CONFIG_CACHE', 'PNPM_HOME', 'PNPM_STORE_DIR',
    'COREPACK_HOME', 'ELECTRON_CACHE', 'ELECTRON_BUILDER_CACHE', 'PLAYWRIGHT_BROWSERS_PATH',
    'PUPPETEER_CACHE_DIR', 'UV_CACHE_DIR', 'DSH_DESKTOP_PREVIEW_ROOT', 'DSH_DESKTOP_USER_DATA_DIR',
    'XIAOJING_OFFICE_WORKSPACE_ROOT']) assert.ok(env[name].startsWith(`${paths.run}${sep}`), name)
})

test('tool lookup excludes other products and external package bins while preserving owned and system tools', t => {
  const paths = prepareRun(fixture(t))
  const separator = process.platform === 'win32' ? ';' : ':'
  const sibling = dirname(paths.root)
  const retired = ['Katcat.AI', 'KATCATS.AI', '小兢会计0.3.3-个性版', '小兢会计0.2.3后续开发',
    '小兢办公V1.0-开发基线'].map(name => join(sibling, name, 'run', 'tooling', 'bin'))
  const externalPackageBin = join(sibling, 'another-project', 'node_modules', '.bin')
  const systemTools = join(dirname(sibling), 'system-tools')
  const ownedTools = join(paths.tooling, 'bin')
  const inherited = { PATH: [...retired, `"${retired[0]}"`, externalPackageBin, systemTools, ownedTools].join(separator) }
  const env = developmentEnvironment(paths, inherited)
  const entries = env.PATH.split(separator)
  for (const directory of [...retired, externalPackageBin]) assert.equal(entries.includes(directory), false, directory)
  assert.equal(entries.includes(`"${retired[0]}"`), false)
  for (const directory of [systemTools, ownedTools]) assert.equal(entries.includes(directory), true, directory)
  assert.equal(entries.includes(''), false)
})

test('prepareRun refuses a run junction before creating files in the target', t => {
  const root = fixture(t)
  const outside = fixture(t)
  symlinkSync(outside, join(root, 'run'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => prepareRun(root), /links outside/)
  assert.throws(() => readFileSync(join(outside, 'tooling', 'npm-user.config')), /ENOENT/)
})

test('prepareRun refuses an escaping nested cache junction', t => {
  const root = fixture(t)
  const outside = fixture(t)
  mkdirSync(join(root, 'run'))
  symlinkSync(outside, join(root, 'run', 'cache'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => prepareRun(root), /links outside/)
})

test('tool configurations stay empty and an unexpected existing configuration fails', t => {
  const root = fixture(t)
  const paths = prepareRun(root)
  assert.equal(readFileSync(paths.userConfig, 'utf8'), '')
  assert.equal(readFileSync(paths.globalConfig, 'utf8'), '')
  assert.deepEqual(prepareRun(root), paths)
  writeFileSync(paths.userConfig, 'registry=https://unexpected.invalid/')
  assert.throws(() => prepareRun(root), /empty project-owned tool configuration/)
})

test('check readiness does not read dotenv or credentials and missing dependencies fail before launch', t => {
  const paths = prepareRun(fixture(t))
  writeFileSync(join(paths.home, '.env'), 'not valid dotenv and never parsed')
  writeFileSync(join(paths.home, '.credentials.yaml'), 'not valid yaml and never parsed')
  const state = dependencyState(paths)
  assert.deepEqual(state.ready, { pnpm: false, tsx: false, typescript: false, web: false, desktop: false })
  for (const mode of ['build', 'web', 'desktop']) {
    assert.throws(() => applicationCommand({ mode, port: 3390 }, paths, state, {}), /Missing pnpm, tsx, typescript/)
  }
})

test('dependency readiness refuses a linked dependency from another project', t => {
  const root = fixture(t)
  const paths = prepareRun(root)
  const outside = fixture(t)
  mkdirSync(join(outside, 'tsx', 'dist', 'esm'), { recursive: true })
  writeFileSync(join(outside, 'tsx', 'dist', 'esm', 'index.mjs'), '')
  symlinkSync(outside, join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => dependencyState(paths), /Linked path leaves/)
})

test('arguments reject arbitrary commands, profile overrides and packaging', () => {
  assert.deepEqual(parseArguments([]), { mode: 'check', port: 3390 })
  assert.deepEqual(parseArguments(['web']), { mode: 'web', port: 3390 })
  assert.deepEqual(parseArguments(['web', '--port', '3399']), { mode: 'web', port: 3399 })
  for (const argv of [['package'], ['install'], ['web', '--home', 'outside'], ['web', '--patch', 'outside.yml'],
    ['desktop', '--user-data-dir', 'outside'], ['build', '--publish'], ['web', '--port', '0'],
    ['web', '--port', '65536'], ['web', '--port', '3390&echo'], ['check', 'anything']]) {
    assert.throws(() => parseArguments(argv), /Usage|Only web|Web port/)
  }
})

test('application commands use only the owned pnpm and supported source profile', t => {
  const paths = prepareRun(fixture(t))
  const state = dependencyState(paths)
  state.ready = { pnpm: true, tsx: true, typescript: true, web: true, desktop: true }
  const env = developmentEnvironment(paths, {})
  writeFileSync(join(paths.root, 'KATCATS-COPY-VERIFICATION.json'), JSON.stringify({ sourceHead: 'a'.repeat(40) }))
  const build = applicationCommand({ mode: 'build', port: 3390 }, paths, state, env)
  assert.deepEqual(build.args, [state.pnpm, 'run', 'build:xiaojing'])
  const desktop = applicationCommand({ mode: 'desktop', port: 3390 }, paths, state, env)
  assert.deepEqual(desktop.args, [state.pnpm, '--filter', '@deepseek-ai/dsh-desktop', 'run', 'start'])
  const web = applicationCommand({ mode: 'web', port: 3399 }, paths, state, env)
  assert.deepEqual(web.args, ['--import', pathToFileURL(state.tsx).href, join(paths.root, 'apps', 'cli', 'src', 'bin.ts'),
    'web', '--host', '127.0.0.1', '--port', '3399', '--no-open'])
  assert.equal(web.command, process.execPath)
  assert.equal(web.cwd, paths.root)
  assert.equal(web.env, env)
  state.ready.web = false
  assert.throws(() => applicationCommand({ mode: 'web', port: 3390 }, paths, state, env), /Missing web/)
})

test('a copy without Git supplies only its recorded baseline hash to the build child', async t => {
  const paths = prepareRun(fixture(t))
  const state = dependencyState(paths)
  state.ready = { pnpm: true, tsx: true, typescript: true, web: true, desktop: true }
  const env = developmentEnvironment(paths, { DSH_CLIENT_COMMIT_HASH: 'ambient-old-product-hash' })
  const sourceHead = '1234567890abcdef1234567890abcdef12345678'
  writeFileSync(join(paths.root, 'KATCATS-COPY-VERIFICATION.json'), JSON.stringify({ sourceHead }))
  const build = applicationCommand({ mode: 'build', port: 3390 }, paths, state, env)
  const probe = await runChild({ ...build, args: ['-e', 'console.log(process.env.DSH_CLIENT_COMMIT_HASH)'] }, true)
  assert.equal(probe.stdout.trim(), sourceHead)
  assert.equal(env.DSH_CLIENT_COMMIT_HASH, undefined)
  for (const mode of ['web', 'desktop']) {
    assert.equal(applicationCommand({ mode, port: 3390 }, paths, state, env).env.DSH_CLIENT_COMMIT_HASH, undefined)
  }
})

test('build prefers this checkout Git HEAD and does not require the historical copy report', t => {
  const paths = prepareRun(fixture(t))
  const env = developmentEnvironment(paths, process.env)
  const options = { cwd: paths.root, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  execFileSync('git', ['init', '--initial-branch=codex/team-launcher-test'], options)
  execFileSync('git', ['-c', 'user.name=Team fixture', '-c', 'user.email=team-fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Local Team fixture'], options)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], options).trim()
  const state = dependencyState(paths)
  state.ready = { pnpm: true, tsx: true, typescript: true, web: true, desktop: true }
  const report = join(paths.root, 'KATCATS-COPY-VERIFICATION.json')
  for (const content of [JSON.stringify({ sourceHead: 'a'.repeat(40) }), 'not valid copy metadata']) {
    writeFileSync(report, content)
    const build = applicationCommand({ mode: 'build', port: 3390 }, paths, state, env)
    assert.equal(build.env.DSH_CLIENT_COMMIT_HASH, head)
  }
  rmSync(report)
  assert.equal(applicationCommand({ mode: 'build', port: 3390 }, paths, state, env).env.DSH_CLIENT_COMMIT_HASH, head)
  assert.equal(env.DSH_CLIENT_COMMIT_HASH, undefined)
})

test('a local Git repository without a commit fails before build without falling back to copy metadata', t => {
  const paths = prepareRun(fixture(t))
  const env = developmentEnvironment(paths, process.env)
  execFileSync('git', ['init', '--initial-branch=codex/team-launcher-test'], {
    cwd: paths.root, env, windowsHide: true, stdio: 'ignore',
  })
  writeFileSync(join(paths.root, 'KATCATS-COPY-VERIFICATION.json'), JSON.stringify({ sourceHead: 'a'.repeat(40) }))
  const state = dependencyState(paths)
  state.ready = { pnpm: true, tsx: true, typescript: true, web: true, desktop: true }
  assert.throws(() => applicationCommand({ mode: 'build', port: 3390 }, paths, state, env), /committed Git HEAD in this checkout/)
})

test('build refuses Git metadata linked to another checkout', t => {
  const paths = prepareRun(fixture(t))
  const outside = fixture(t)
  symlinkSync(outside, join(paths.root, '.git'), process.platform === 'win32' ? 'junction' : 'dir')
  const state = dependencyState(paths)
  state.ready = { pnpm: true, tsx: true, typescript: true, web: true, desktop: true }
  assert.throws(() => applicationCommand({ mode: 'build', port: 3390 }, paths, state, developmentEnvironment(paths, {})), /Linked path leaves/)
})

test('build refuses missing, malformed or invalid copy baseline metadata', t => {
  const paths = prepareRun(fixture(t))
  const state = dependencyState(paths)
  state.ready = { pnpm: true, tsx: true, typescript: true, web: true, desktop: true }
  const build = () => applicationCommand({ mode: 'build', port: 3390 }, paths, state, {})
  assert.throws(build, /valid copy verification report/)
  const report = join(paths.root, 'KATCATS-COPY-VERIFICATION.json')
  for (const content of ['not json', 'null', '{}', '{"sourceHead":42}', '{"sourceHead":"deadbeef"}',
    JSON.stringify({ sourceHead: 'g'.repeat(40) })]) {
    writeFileSync(report, content)
    assert.throws(build, /valid copy verification report|40-character hexadecimal sourceHead/)
  }
})

test('an actual child receives only sanitized application variables and owned paths', async t => {
  const paths = prepareRun(fixture(t))
  const env = developmentEnvironment(paths, { DEEPSEEK_API_KEY: 'synthetic-old-key', DSH_HOME: 'synthetic-old-home',
    HTTP_PROXY: 'http://synthetic.invalid', NODE_OPTIONS: '--require synthetic-hook' })
  const childFile = join(paths.run, 'environment-probe.mjs')
  writeFileSync(childFile, `console.log(JSON.stringify({
    cwd: process.cwd(), home: process.env.DSH_HOME, agents: process.env.DSH_AGENTS_HOME,
    key: process.env.DEEPSEEK_API_KEY ?? null, proxy: process.env.HTTP_PROXY ?? null,
    hook: process.env.NODE_OPTIONS ?? null, mode: process.env.KATCATS_DEV_MODE,
    desktop: process.env.DSH_DESKTOP_USER_DATA_DIR, workspace: process.env.XIAOJING_OFFICE_WORKSPACE_ROOT,
    rendererPort: process.env.DSH_DESKTOP_RENDERER_DEBUG_PORT,
    mainPort: process.env.DSH_DESKTOP_MAIN_INSPECT_PORT, hostPort: process.env.DSH_DESKTOP_HOST_INSPECT_PORT
  }))\n`)
  const result = await runChild({ command: process.execPath, args: [childFile], cwd: paths.root, env }, true)
  assert.deepEqual(JSON.parse(result.stdout), { cwd: paths.root, home: paths.home, agents: paths.agents,
    key: null, proxy: null, hook: null, mode: '1', desktop: paths.desktopData, workspace: paths.workspaces,
    rendererPort: '19422', mainPort: '19429', hostPort: '19430' })
  assert.equal(result.stderr, '')
})

test('a child failure propagates and the installed CLI root cannot be redirected by cwd', async t => {
  const paths = prepareRun(fixture(t))
  const env = developmentEnvironment(paths, {})
  await assert.rejects(runChild({ command: process.execPath, args: ['-e', 'process.exit(7)'], cwd: paths.root, env }, true), /exited with 7/)
  const result = await runChild({ command: process.execPath,
    args: [join(REPOSITORY, 'scripts', 'katcats-dev.mjs'), 'check'], cwd: paths.root, env }, true)
  const state = JSON.parse(result.stdout)
  assert.equal(state.project, REPOSITORY)
  assert.equal(state.developmentIdentity, '小兢会计团队版 Dev')
  assert.deepEqual(state.ports, { web: 3390, renderer: 19422, main: 19429, host: 19430 })
})
