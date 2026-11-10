/** Assert the actual archived Katcats composition and its browser UI before delivery. */
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { DesktopHostProcess } from '../src/host-process.ts'
import { createPluginProfile } from '../src/project-manager.ts'
import type { DesktopRuntimeDescriptor } from '../src/runtime-tree.ts'
import { xiaojingHostEnvironment } from '../src/xiaojing-product.ts'
import { redactPackagedSmokeOutput, verifyPackagedKatcatsBrowser } from '../../web/tests/fixtures/katcats-packaged-ui.mjs'

/**
 * Boot the shipped product with fresh data and verify its actual team UI without model calls.
 * @param root - packaged dsh directory, including an ASAR path when archived.
 * @param node - target Electron executable used only in Node mode for the Host.
 * @param runtime - verified runtime descriptor supplied by the packaging stage.
 * @param environment - caller environment; only OS process-launch fields are inherited.
 * @param resourcesRuntime - bundled interpreters outside the ASAR.
 * @param artifactDirectory - optional case-owned directory retaining browser and failure evidence.
 * @returns resolves only when the real packaged services, sidebar, and composer pass.
 */
export async function smokeKatcatsProduct(
  root: string, node: string, runtime: DesktopRuntimeDescriptor, environment: NodeJS.ProcessEnv,
  resourcesRuntime: string, artifactDirectory?: string,
): Promise<void> {
  const evidence = artifactDirectory ?? join(import.meta.dirname, '../../../run/tmp/katcats-packaged-ui')
  await mkdir(evidence, { recursive: true })
  const directory = await mkdtemp(join(evidence, 'case-'))
  const home = join(directory, 'home'), profile = join(home, 'profiles/desktop'), workspace = join(directory, 'workspace')
  const base: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(environment)
    .filter(([name]) => /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/iu.test(name)))
  Object.assign(base, {
    NODE_OPTIONS: '',
    HOME: directory, USERPROFILE: directory, APPDATA: join(directory, 'app-data'), LOCALAPPDATA: join(directory, 'local-app-data'),
    XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, XDG_STATE_HOME: directory,
    TEMP: join(directory, 'tmp'), TMP: join(directory, 'tmp'),
    NARB_NATIVE_CACHE_DIR: join(directory, 'native-cache'), NARB_DISABLE_NATIVE_CACHE: '0',
  })
  const resourceDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: join(resourcesRuntime, '..') })
  let isolated: NodeJS.ProcessEnv
  try {
    isolated = xiaojingHostEnvironment({ isPackaged: true }, {
      userData: join(directory, 'app-data/XiaojingAccountingTeam-desktop'), dshHome: home,
      workspaceRoot: workspace, officeWorkspace: workspace,
    }, base)
  } finally {
    if (resourceDescriptor === undefined) Reflect.deleteProperty(process, 'resourcesPath')
    else Object.defineProperty(process, 'resourcesPath', resourceDescriptor)
  }
  for (const path of [directory, workspace, home, isolated.APPDATA!, isolated.LOCALAPPDATA!, isolated.TEMP!,
    isolated.NARB_NATIVE_CACHE_DIR!]) await mkdir(path, { recursive: true })
  createPluginProfile(profile)
  const name = 'katcats-packaged-ui-probe', plugin = join(profile, 'node_modules', name)
  await mkdir(plugin, { recursive: true })
  const cordis = runtime.sharedPackages.find(entry => entry.name === '@deepseek-ai/cordis')
  if (cordis === undefined) throw new Error('Katcats product smoke requires the packaged Cordis version')
  await writeFile(join(plugin, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', exports: './index.js',
    peerDependencies: { '@deepseek-ai/cordis': cordis.version, '@deepseek-ai/dsh-llm': '*' },
    dsh: { bundle: { patch: './bundle.yml' } } }))
  await writeFile(join(plugin, 'index.js'), `
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
let modelCalls = 0
const sentinel = '合成验收聊天应始终可见'
class NoCalls extends LlmAdapter {
  async listModels(provider) { return [{ provider, id: 'no-messages', name: 'Packaged smoke model' }] }
  async resolveModel(provider, model) { return { provider, id: model, name: 'Packaged smoke model', inputModalities: ['text'] } }
  async *stream() { modelCalls++; throw new Error('Packaged UI smoke must never request model output') }
}
export function apply(ctx) {
  ctx.effect(() => ctx.llm.registerAdapter(['packaged-ui-smoke'], new NoCalls()))
  let questionState = null
  const questionAbort = new AbortController()
  ctx.effect(() => () => questionAbort.abort(), 'packaged smoke: pending question')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/katcats-packaged-ui-question',
    async handler(request, response) {
      response.setHeader('content-type', 'application/json')
      if (!['GET', 'POST'].includes(request.method)) {
        response.statusCode = 405; response.end(JSON.stringify({ error: 'GET or POST required' })); return
      }
      for await (const chunk of request) if (chunk.length !== 0) {
        response.statusCode = 400; response.end(JSON.stringify({ error: 'Empty body required' })); return
      }
      try {
        if (request.method === 'POST') {
          if (questionState !== null && questionState.status !== 'answered') throw new Error('Unexpected question sequence')
          const team = await ctx.get('katcatsTeam').snapshot(), groups = await ctx.get('katcatsChats').snapshot()
          const matches = groups.chats.filter(chat => chat.name === '打包验收协作群')
          if (matches.length !== 1) throw new Error('The synthetic question group must exist exactly once')
          const chat = matches[0], executor = chat.executors[0]
          const bot = team.bots.find(item => item.id === executor?.botId)
          if (executor === undefined || bot?.kind !== 'ordinary' || executor.sessionId === chat.rootSessionId
            || team.bots.some(item => item.sessionId === executor.sessionId)) throw new Error('Missing isolated question executor')
          const resolved = await ctx.sessionController.resolveAgent(executor.sessionId)
          if ('error' in resolved) throw new Error('The question executor is unavailable')
          const phase = questionState === null ? 'answer' : 'cancel'
          const state = { phase, status: 'pending', sessionId: executor.sessionId, rootSessionId: chat.rootSessionId,
            privateSessionId: bot.sessionId, member: bot.name, answer: null, error: null }
          questionState = state
          void ctx.userQuestions.ask({ agent: resolved.agent, signal: questionAbort.signal,
            questions: [{ id: 'packaged-group-question', question: phase === 'answer'
              ? '合成验收：请选择群成员交付方式。' : '合成验收：请取消这次群成员提问。',
              options: [{ label: '提交原成员' }, { label: '稍后处理' }] }],
          }).then(answer => { state.answer = answer; state.status = 'answered' }, error => {
            state.error = { code: error?.code ?? null, message: error instanceof Error ? error.message : String(error) }
            state.status = 'failed'
          })
        }
        response.end(JSON.stringify({ question: questionState, modelCalls }))
      } catch (error) {
        response.statusCode = 409
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Synthetic question failed' }))
      }
    } }))
  let handoffTail = Promise.resolve()
  const seedHandoff = async phase => {
    const team = ctx.get('katcatsTeam'), chats = ctx.get('katcatsChats')
    if (team === undefined || chats === undefined) throw new Error('The synthetic team services are unavailable')
    const directory = await team.snapshot()
    const groups = await chats.snapshot()
    const matches = groups.chats.filter(chat => chat.name === '打包验收协作群')
    if (matches.length !== 1) throw new Error('The synthetic handoff group must exist exactly once')
    const chat = matches[0]
    const members = chat.memberIds.map(id => directory.bots.find(bot => bot.id === id))
    if (members.length !== 2 || members.some(bot => bot?.kind !== 'ordinary')) {
      throw new Error('The synthetic handoff group requires its two saved ordinary members')
    }
    for (const bot of members) {
      const executor = chat.executors.find(item => item.botId === bot.id)
      if (executor === undefined || executor.sessionId === chat.rootSessionId
        || directory.bots.some(item => item.sessionId === executor.sessionId)) {
        throw new Error('The synthetic handoff group has no isolated executor binding')
      }
    }
    const resolved = await ctx.sessionController.resolveAgent(chat.rootSessionId)
    if ('error' in resolved) throw new Error('The synthetic group transcript is unavailable')
    const agent = resolved.agent
    if (agent.status !== 'idle' || agent.inbox.nextStep.length !== 0 || agent.inbox.nextTurn.length !== 0) {
      throw new Error('The synthetic group transcript must be idle with an empty inbox')
    }
    return agent.runMaintenance(async signal => {
      signal.throwIfAborted()
      const inspected = await ctx.sessionController.inspect(chat.rootSessionId)
      const prefix = 'katcats-packaged-ui-handoff:' + chat.id + ':'
      const lifecycle = inspected.events.filter(event => event.type === 'katcats/group-task-lifecycle')
      const recorded = new Set(lifecycle.map(event => event.data.eventId))
      if (phase === 2 && !['owner', 'member'].every(kind => recorded.has(prefix + '1:' + kind + ':completed'))) {
        throw new Error('The first synthetic handoff batch must be saved before the second')
      }
      if (phase === 1 && lifecycle.some(event => event.data.eventId.startsWith(prefix + '2:'))) {
        throw new Error('The first synthetic handoff batch cannot run after the second')
      }
      const sender = bot => ({ botId: bot.id, name: bot.name, role: bot.role, avatar: bot.avatar })
      const member = bot => ({ kind: 'member', botId: bot.id, sender: sender(bot) })
      const parentId = prefix + phase + ':owner'
      const tasks = [
        { deliveryId: parentId, parentDeliveryId: null, actor: { kind: 'owner' }, target: member(members[0]),
          message: '合成验收任务 ' + phase + '：准备交接材料。' },
        { deliveryId: prefix + phase + ':member', parentDeliveryId: parentId,
          actor: member(members[0]), target: member(members[1]),
          message: '**合成验收交接 ' + phase + '**：请复核这份公开材料。' },
      ]
      const sentinelId = prefix + 'chat-sentinel'
      if (phase === 1 && !inspected.events.some(event => event.type === 'user/message' && event.data.id === sentinelId)) {
        agent.session.append('user/message', { id: sentinelId, role: 'user', source: { kind: 'user' },
          content: [{ type: 'text', text: sentinel }] }, { surfaceOp: 'append' })
      }
      for (const task of tasks) for (const status of ['queued', 'started', 'completed']) {
        const eventId = task.deliveryId + ':' + status
        if (recorded.has(eventId)) continue
        agent.session.append('katcats/group-task-lifecycle', { schemaVersion: 1, eventId,
          chatId: chat.id, rootSessionId: chat.rootSessionId, runId: prefix + 'run', generation: chat.generation,
          ...task, status, recovered: false, error: null })
        recorded.add(eventId)
      }
      if (!await ctx.sessions.flush(agent.session)) throw new Error('The synthetic transcript has no durability owner')
      signal.throwIfAborted()
      const saved = await ctx.sessionController.inspect(chat.rootSessionId)
      const completed = saved.events.filter(event => event.type === 'katcats/group-task-lifecycle'
        && event.data.eventId.startsWith(prefix) && event.data.status === 'completed')
      if (completed.length !== phase * 2 || !saved.events.some(event => event.type === 'user/message'
        && event.data.id === sentinelId && event.data.content.some(block => block.type === 'text' && block.text === sentinel))) {
        throw new Error('The synthetic transcript did not retain the expected records and chat')
      }
      return { phase, taskCount: completed.length, handoffCount: completed.filter(event => event.data.actor.kind === 'member').length,
        sentinel }
    })
  }
  for (const [phase, path] of [[1, '/katcats-packaged-ui-handoff-first'], [2, '/katcats-packaged-ui-handoff-second']]) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, async handler(request, response) {
      response.setHeader('content-type', 'application/json')
      if (request.method !== 'POST') { response.statusCode = 405; response.end(JSON.stringify({ error: 'POST required' })); return }
      for await (const chunk of request) if (chunk.length !== 0) {
        response.statusCode = 400; response.end(JSON.stringify({ error: 'Empty body required' })); return
      }
      const operation = handoffTail.then(() => seedHandoff(phase))
      handoffTail = operation.then(() => {}, () => {})
      try { response.end(JSON.stringify(await operation)) }
      catch (error) {
        response.statusCode = 409
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Synthetic handoff append failed' }))
      }
    } }))
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/katcats-packaged-ui-queue',
    async handler(request, response) {
      response.setHeader('content-type', 'application/json')
      if (!['GET', 'POST'].includes(request.method)) {
        response.statusCode = 405; response.end(JSON.stringify({ error: 'GET or POST required' })); return
      }
      for await (const chunk of request) if (chunk.length !== 0) {
        response.statusCode = 400; response.end(JSON.stringify({ error: 'Empty body required' })); return
      }
      try {
        const chats = ctx.get('katcatsChats')
        if (chats === undefined) throw new Error('The synthetic chat service is unavailable')
        const groups = await chats.snapshot()
        const matches = groups.chats.filter(chat => chat.name === '打包验收协作群')
        if (matches.length !== 1) throw new Error('The synthetic queue group must exist exactly once')
        let chat = matches[0]
        if (request.method === 'POST') {
          if (chat.run !== null) throw new Error('Only the synthetic group without an active run may be paused')
          chat = (await chats.pause({ id: chat.id, expectedRunId: null, expectedGeneration: chat.generation })).chat
        }
        const session = await ctx.sessionController.inspect(chat.rootSessionId)
        response.end(JSON.stringify({ status: chat.status, pauseReason: chat.pauseReason,
          generation: chat.generation, runId: chat.run?.id ?? null, modelCalls,
          queuedMessages: session.events.filter(event => event.type === 'user/message'
            && event.data.source.kind === 'user' && event.data.content.some(block => block.type === 'text'
              && block.text === '合成验收普通追问保留后台任务')).length,
          rootTurns: session.events.filter(event => event.type === 'turn/start').length }))
      } catch (error) {
        response.statusCode = 409
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Synthetic queue inspection failed' }))
      }
    } }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/katcats-packaged-ui-probe',
    async handler(_request, response) {
      const team = ctx.get('katcatsTeam'), chats = ctx.get('katcatsChats'), memory = ctx.get('katcatsMemory')
      const directory = team === undefined ? undefined : await team.snapshot()
      const groups = chats === undefined ? undefined : await chats.snapshot()
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ productMode: process.env.KATCATS_PRODUCT_MODE,
        developmentModePresent: process.env.KATCATS_DEV_MODE !== undefined,
        services: { team: team !== undefined, chats: chats !== undefined, memory: memory !== undefined }, modelCalls,
        bots: directory?.bots.length ?? 0, chats: groups?.chats.length ?? 0,
        entries: [...ctx.loader.entries()].filter(entry => ['katcats-team','katcats-chats','katcats-memory'].includes(entry.options.id))
          .map(entry => ({ id: entry.options.id, disabled: entry.disabled, state: entry.fiber?.state ?? null })) }))
    } }))
}
`)
  await writeFile(join(plugin, 'bundle.yml'), `- insert:\n    - id: ${name}\n      name: ${name}\n      inject: [webServer, loader, llm, sessionController, sessions, userQuestions]\n`)
  const manifestPath = join(profile, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>
    dsh: { profile: { bundles: string[] } }
  }
  manifest.dependencies = { ...manifest.dependencies, [name]: `file:${plugin}` }
  manifest.dsh.profile.bundles.push(name)
  await writeFile(manifestPath, JSON.stringify(manifest))
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([
    { id: 'webserver', config: { host: '127.0.0.1', port: 0 } },
    { id: 'session-title-llm', disabled: true },
    { id: 'llm-deepseek', disabled: true }, { id: 'llm-deepseek-account', disabled: true }, { id: 'llm-pi-ai', disabled: true },
    { id: 'agent-default-model', config: { provider: 'packaged-ui-smoke', model: 'no-messages' } },
    { id: 'directory-picker', disabled: true },
    { insert: [{ id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
      { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' }] },
  ]))
  const primary = join(resourcesRuntime, 'primary-runtime')
  const host = new DesktopHostProcess(node, root, profile, undefined, isolated, undefined, primary,
    { pnpm: join(primary, 'dependencies/pnpm/bin/pnpm.mjs'), nodeBin: join(resourcesRuntime, 'bin') }, undefined, workspace)
  const electron: unknown = createRequire(import.meta.url)('electron')
  if (typeof electron !== 'string') throw new Error('Katcats smoke browser executable is unavailable')
  const restoreOutput = redactPackagedSmokeOutput()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const ready = await Promise.race([host.start(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error('Katcats packaged Host readiness exceeded 120 seconds')) }, 120_000)
    })])
    clearTimeout(timer)
    await verifyPackagedKatcatsBrowser({ loginUrl: ready.url, directory, environment: isolated, electron })
    console.log(`Katcats packaged product UI passed; evidence: ${directory}`)
  } finally {
    clearTimeout(timer)
    try { await host.stop(true) } finally { restoreOutput() }
  }
}
