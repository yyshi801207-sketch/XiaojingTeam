/** Replay group inputs through the shipped Web profile and compare actual persisted member and group records. */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { materializeProfilePatch, sessionFixtureNames } from '@deepseek-ai/dsh-session-snapshot'
import type { BotMutationValue } from '@deepseek-ai/dsh-client-katcats-team/types'
import type { ChatMutationValue, ChatSnapshot } from '@deepseek-ai/dsh-client-katcats-team/chats-types'
import { prompts, ready, authenticatedWeb, remoteRpc, sessionLog, modelResponses, close } from './group-profile-fixture.ts'
import { verifyGroupSnapshots } from './group-context-efficiency-normalize.ts'

const directory = fileURLToPath(new URL('./group-context-efficiency/', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const snapshotTest = it.skipIf(process.env.DSH_SNAPSHOT === 'record')

snapshotTest('group-context-efficiency: selective dispatch and incremental history through dsh web', async () => {
  const mode = process.env.DSH_SNAPSHOT ?? 'replay'
  if (mode !== 'replay' && mode !== 'refresh') throw new Error('This authored keyless fixture supports replay or refresh; it is not real-API evidence')
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'group-context-snapshot-')))
  let child: ChildProcess | undefined
  try {
    const [fixtureName] = sessionFixtureNames(await readdir(directory))
    if (fixtureName === undefined) throw new Error('The group snapshot has no primary Session fixture')
    const fixtureFile = join(directory, fixtureName)
    const original = await readFile(fixtureFile, 'utf8')
    const tasks = prompts(original)
    expect(tasks).toHaveLength(2)
    const hydrated = join(cwd, 'replay-session.jsonl')
    await writeFile(hydrated, original.replaceAll('{{cwd}}', cwd.replaceAll('\\', '/')))
    const patchRoot = join(cwd, 'patches')
    await mkdir(patchRoot)
    const patch = materializeProfilePatch(join(directory, 'cordis.yml'), cwd, 'web', patchRoot, 0)
    const launch = resolveExampleLaunch({
      srcBin: join(repoRoot, 'apps/cli/src/bin.ts'), libBin: join(repoRoot, 'apps/cli/lib/bin.js'),
      sourceImport: 'tsx/esm', tsconfigPath: join(repoRoot, 'tsconfig.json'),
      configArgs: ['web', '--patch', patch, '--no-open', '--port', '0'],
      env: {
        DSH_HOME: join(cwd, '.dsh'), DSH_AGENTS_HOME: join(cwd, '.agents'),
        DSH_SNAPSHOT_FILE: hydrated, DSH_TELEMETRY_DISABLED: '1',
        XIAOJING_OFFICE_WORKSPACE_ROOT: join(cwd, 'workspaces'), DEEPSEEK_API_KEY: 'keyless-snapshot-no-network',
      },
    })
    child = spawn(launch.command, launch.args, { cwd, env: { ...process.env, ...launch.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    const connection = await authenticatedWeb(await ready(child))
    const coordinator = (await remoteRpc<BotMutationValue>(connection, 'katcatsTeam/createBot', { request: { name: 'Coordinator' } })).bot
    const observer = (await remoteRpc<BotMutationValue>(connection, 'katcatsTeam/createBot', { request: { name: 'Observer' } })).bot
    const chat = (await remoteRpc<ChatMutationValue>(connection, 'katcatsChats/createChat', { request: {
      name: 'Context efficiency snapshot', memberIds: [coordinator.id, observer.id], managerId: coordinator.id,
    } })).chat
    let snapshot: ChatSnapshot | undefined
    for (const [index, text] of tasks.entries()) {
      await remoteRpc(connection, 'katcatsChats/sendMessage', { request: { sessionId: chat.rootSessionId, mode: 'queue',
        requestId: `group-context-owner-${String(index + 1)}`, content: [{ type: 'text', text }],
      } })
      await expect.poll(async () => {
        snapshot = await remoteRpc<ChatSnapshot>(connection, 'katcatsChats/snapshot', {})
        const deliveries = snapshot.deliveries.filter(delivery => delivery.chatId === chat.id)
        if (deliveries.some(delivery => delivery.state === 'failed' || delivery.state === 'unknown')) {
          throw new Error(`The snapshot group failed: ${JSON.stringify(deliveries.map(delivery => delivery.error))}`)
        }
        return deliveries.length === index + 1 && deliveries.every(delivery => delivery.state === 'completed')
          && snapshot.activities.find(activity => activity.chatId === chat.id)?.processing === false
      }, { timeout: 30_000, interval: 50 }).toBe(true)
    }
    expect(snapshot?.deliveries.map(delivery => delivery.botId)).toEqual([coordinator.id, coordinator.id])
    expect(snapshot?.deliveries.at(-1)?.receipt?.text).toBe('The original code was blue; the latest correction is green.')
    const executor = chat.executors.find(worker => worker.botId === coordinator.id)
    if (executor === undefined) throw new Error('The coordinator has no group executor')
    const root = join(cwd, '.dsh', 'sessions')
    const workerLog = await sessionLog(root, executor.sessionId)
    const rootLog = await sessionLog(root, chat.rootSessionId)
    if (workerLog === undefined || rootLog === undefined) throw new Error('The group and coordinator Sessions were not persisted')
    expect(modelResponses(workerLog)).toBe(3)
    const idle = chat.executors.find(worker => worker.botId === observer.id)
    if (idle === undefined) throw new Error('The observer has no group executor')
    const idleLog = await sessionLog(root, idle.sessionId)
    expect(idleLog === undefined ? 0 : modelResponses(idleLog)).toBe(0)
    await verifyGroupSnapshots({ directory, cwd, mode, workerLog, rootLog, memberIds: [coordinator.id, observer.id] })
    if (mode === 'replay') expect(await readFile(fixtureFile, 'utf8')).toBe(original)
  } finally {
    if (child !== undefined) await close(child)
    await rm(cwd, { recursive: true, force: true })
  }
}, 120_000)
