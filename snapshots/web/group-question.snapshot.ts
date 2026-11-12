/** Replay real member questions, queued owner input and cancellation through the shipped Web profile. */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { materializeProfilePatch, sessionFixtureNames } from '@deepseek-ai/dsh-session-snapshot'
import type { BotMutationValue } from '@deepseek-ai/dsh-client-katcats-team/types'
import type { ChatMutationValue, ChatSnapshot } from '@deepseek-ai/dsh-client-katcats-team/chats-types'
import { prompts, ready, authenticatedWeb, remoteRpc, sessionLog, modelResponses, close } from './group-profile-fixture.ts'
import { verifyGroupSnapshots } from './group-context-efficiency-normalize.ts'

const directory = fileURLToPath(new URL('./group-question/', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const item = z.object({ type: z.literal('item'), value: z.record(z.string(), z.unknown()) })
const invocation = z.object({ type: z.literal('waterfall'), event: z.literal('user-questions/request'),
  eventId: z.string(), agentId: z.string(), request: z.object({ questions: z.array(z.object({ id: z.string(), options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional() })) }) })

it.skipIf(process.env.DSH_SNAPSHOT === 'record')('group-question: select a voucher period, preserve queued input and cancel the next wait', async () => {
  const mode = process.env.DSH_SNAPSHOT ?? 'replay'
  if (mode !== 'replay' && mode !== 'refresh') throw new Error('This authored fixture supports keyless replay or refresh only')
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'group-question-snapshot-')))
  let child: ChildProcess | undefined
  let socket: WebSocket | undefined
  let diagnostics = ''
  try {
    const [fixtureName] = sessionFixtureNames(await readdir(directory))
    if (fixtureName === undefined) throw new Error('Missing group question Session fixture')
    const fixtureFile = join(directory, fixtureName)
    const original = await readFile(fixtureFile, 'utf8')
    const tasks = prompts(original)
    expect(tasks).toHaveLength(3)
    const hydrated = join(cwd, 'replay-session.jsonl')
    await writeFile(hydrated, original.replaceAll('{{cwd}}', cwd.replaceAll('\\', '/')))
    const patchRoot = join(cwd, 'patches')
    await mkdir(patchRoot)
    const patch = materializeProfilePatch(join(directory, 'cordis.yml'), cwd, 'web', patchRoot, 0)
    const launch = resolveExampleLaunch({
      srcBin: join(repoRoot, 'apps/cli/src/bin.ts'), libBin: join(repoRoot, 'apps/cli/lib/bin.js'),
      sourceImport: 'tsx/esm', tsconfigPath: join(repoRoot, 'tsconfig.json'),
      configArgs: ['web', '--patch', patch, '--no-open', '--port', '0'],
      env: { DSH_HOME: join(cwd, '.dsh'), DSH_AGENTS_HOME: join(cwd, '.agents'),
        DSH_SNAPSHOT_FILE: hydrated, DSH_TELEMETRY_DISABLED: '1',
        XIAOJING_OFFICE_WORKSPACE_ROOT: join(cwd, 'workspaces'), DEEPSEEK_API_KEY: 'keyless-snapshot-no-network' },
    })
    child = spawn(launch.command, launch.args, { cwd, env: { ...process.env, ...launch.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stderr?.on('data', (chunk: Buffer) => { diagnostics += chunk.toString() })
    const connection = await authenticatedWeb(await ready(child))
    // Node's WebSocket accepts request headers; this is the same authenticated public stream used by the browser.
    socket = Reflect.construct(WebSocket, [`${connection.origin.replace('http:', 'ws:')}/api/remote.mux`,
      { headers: { cookie: connection.cookie } }]) as WebSocket
    const frames: Record<string, unknown>[] = []
    socket.addEventListener('message', event => {
      const parsed = item.safeParse(JSON.parse(String(event.data)))
      if (parsed.success) frames.push(parsed.data.value)
    })
    await new Promise<void>((resolve, reject) => {
      socket!.addEventListener('open', () => { resolve() }, { once: true })
      socket!.addEventListener('error', () => { reject(new Error('Group question stream did not connect')) }, { once: true })
    })
    socket.send(JSON.stringify({ type: 'open', streamId: 'questions', endpoint: '$events', payload: { args: {} } }))
    await expect.poll(() => frames.some(frame => frame.type === 'ready')).toBe(true)
    const clientId = z.string().parse(frames.find(frame => frame.type === 'ready')?.clientId)
    const coordinator = (await remoteRpc<BotMutationValue>(connection, 'katcatsTeam/createBot', { request: { name: 'Coordinator' } })).bot
    const observer = (await remoteRpc<BotMutationValue>(connection, 'katcatsTeam/createBot', { request: { name: 'Observer' } })).bot
    const chat = (await remoteRpc<ChatMutationValue>(connection, 'katcatsChats/createChat', { request: {
      name: 'Group question snapshot', memberIds: [coordinator.id, observer.id], managerId: coordinator.id,
    } })).chat
    const executor = chat.executors.find(worker => worker.botId === coordinator.id)
    if (executor === undefined) throw new Error('Missing coordinator executor')
    const send = (index: number) => remoteRpc(connection, 'katcatsChats/sendMessage', { request: {
      sessionId: chat.rootSessionId, mode: 'queue', requestId: `group-question-${String(index)}`,
      content: [{ type: 'text', text: tasks[index] }],
    } })
    const questions = () => frames.flatMap(frame => { const parsed = invocation.safeParse(frame); return parsed.success ? [parsed.data] : [] })
    await send(0)
    await expect.poll(async () => {
      const value = await remoteRpc<ChatSnapshot>(connection, 'katcatsChats/snapshot', {})
      if (value.deliveries.some(delivery => ['completed', 'failed', 'unknown'].includes(delivery.state))) {
        throw new Error(`Question did not wait: ${JSON.stringify(value.deliveries.map(delivery => delivery.error))}\n${diagnostics}`)
      }
      return questions().length
    }, { timeout: 30_000 }).toBe(1)
    const question = questions()[0]!
    expect(question.agentId).toBe(executor.sessionId)
    expect(question.agentId).not.toBe(chat.rootSessionId)
    expect(question.request.questions).toEqual([{ id: 'voucher_period', options: [
      { label: '本月至今', description: '2026-11-01 至 2026-11-10' },
      { label: '上月整月', description: '2026-10-01 至 2026-10-31' },
      { label: '本年至今', description: '2026-01-01 至 2026-11-10' },
    ] }])
    await send(1)
    const waiting = await remoteRpc<ChatSnapshot>(connection, 'katcatsChats/snapshot', {})
    expect(waiting.deliveries.filter(delivery => delivery.chatId === chat.id).map(delivery => delivery.state)).toEqual(['running'])
    expect(waiting.activities.find(activity => activity.chatId === chat.id)?.processing).toBe(true)
    await remoteRpc(connection, '$events/result', { clientId, eventId: question.eventId,
      outcome: { kind: 'result', value: { answers: [{ id: 'voucher_period', selected: ['上月整月'] }] } } })
    await expect.poll(async () => {
      const value = await remoteRpc<ChatSnapshot>(connection, 'katcatsChats/snapshot', {})
      return value.deliveries.filter(delivery => delivery.chatId === chat.id).map(delivery => delivery.receipt?.text)
    }, { timeout: 30_000 }).toEqual(['已选择上月整月，2026-10-01 至 2026-10-31。', '查询区间仍是 2026-10-01 至 2026-10-31。'])
    await send(2)
    await expect.poll(() => questions().length, { timeout: 30_000 }).toBe(2)
    const cancelled = questions()[1]!
    expect(cancelled.agentId).toBe(executor.sessionId)
    await remoteRpc(connection, 'katcatsChats/cancelSession', { request: { sessionId: chat.rootSessionId } })
    await expect.poll(() => frames.some(frame => frame.type === 'cancel' && frame.eventId === cancelled.eventId)).toBe(true)
    await expect.poll(async () => {
      const value = await remoteRpc<ChatSnapshot>(connection, 'katcatsChats/snapshot', {})
      return { status: value.chats.find(value => value.id === chat.id)?.status,
        running: value.activities.find(value => value.chatId === chat.id)?.runningBotIds,
        processing: value.activities.find(value => value.chatId === chat.id)?.processing,
        unfinished: value.deliveries.filter(value => value.chatId === chat.id && (value.state === 'accepted' || value.state === 'running')).length }
    }).toEqual({ status: 'stopped', running: [], processing: false, unfinished: 0 })
    const root = join(cwd, '.dsh', 'sessions')
    const workerLog = await sessionLog(root, executor.sessionId)
    const rootLog = await sessionLog(root, chat.rootSessionId)
    if (workerLog === undefined || rootLog === undefined) throw new Error('Group question logs were not persisted')
    expect(modelResponses(workerLog)).toBe(4)
    expect(workerLog).toContain('ASK_ABORTED')
    const idle = chat.executors.find(worker => worker.botId === observer.id)
    if (idle === undefined) throw new Error('Missing observer executor')
    const idleLog = await sessionLog(root, idle.sessionId)
    expect(idleLog === undefined ? 0 : modelResponses(idleLog)).toBe(0)
    await verifyGroupSnapshots({ directory, cwd, mode, workerLog, rootLog, memberIds: [coordinator.id, observer.id] })
    if (mode === 'replay') expect(await readFile(fixtureFile, 'utf8')).toBe(original)
  } finally {
    socket?.close()
    if (child !== undefined) await close(child)
    await rm(cwd, { recursive: true, force: true })
  }
}, 120_000)
