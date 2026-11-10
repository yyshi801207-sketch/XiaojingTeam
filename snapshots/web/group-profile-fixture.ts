/** Shared public Web profile transport and Session-log helpers for group snapshots. */
import type { ChildProcess } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { latestPersistedSessionPaths } from '@deepseek-ai/dsh-session-snapshot'

/**
 * Extract current owner tasks from the selected executor recording.
 * @param fixture - selected Session JSONL.
 * @returns ordered owner task texts.
 */
export function prompts(fixture: string): string[] {
  const userRecord = z.object({ type: z.literal('user/message'), data: z.object({
    content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
    source: z.object({ kind: z.string() }),
  }) })
  return fixture.trimEnd().split('\n').flatMap(line => {
    const parsed = userRecord.safeParse(JSON.parse(line))
    if (!parsed.success) return []
    const { content, source } = parsed.data.data
    if (source.kind === 'user') return [content.map(block => block.text).join('\n')]
    if (source.kind !== 'katcats-group-task') return []
    const taskId = /^Current task source: (.+)$/m.exec(content[0]?.text ?? '')?.[1]
    if (taskId === undefined) throw new Error('The group snapshot input has no current task source')
    const start = content.findIndex(block => block.text.startsWith(`\n[${taskId}] `))
    if (start < 0) throw new Error('The group snapshot task source was not included')
    const blocks = content.slice(start + 1)
    const end = blocks.findIndex(block => block.text.startsWith('\n['))
    return [blocks.slice(0, end < 0 ? undefined : end).map(block => block.text).join('\n')]
  })
}

/**
 * Wait for the shipped Web profile readiness URL.
 * @param child - running dsh Web process.
 * @returns authenticated startup URL.
 */
export function ready(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''
    const failure = (reason: string) => new Error(reason + '\n' + output.replace(/([?&]token=)[A-Za-z0-9_-]+/gu, '$1[REDACTED]'))
    const timer = setTimeout(() => { reject(failure('The snapshot Web profile did not become ready')) }, 90_000)
    const capture = (chunk: Buffer) => {
      output += chunk.toString()
      const url = /dsh web: (http:\/\/[^\s]+)/.exec(output)?.[1]
      if (url !== undefined) { clearTimeout(timer); resolve(url) }
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); reject(failure(`The snapshot Web profile exited (${String(code)})`)) })
  })
}

/**
 * Exchange the startup token for an answering browser connection.
 * @param url - authenticated startup URL.
 * @returns origin and cookie for public RPCs.
 */
export async function authenticatedWeb(url: string): Promise<{ origin: string; cookie: string }> {
  const response = await fetch(url, { headers: { accept: 'text/html' }, redirect: 'manual', signal: AbortSignal.timeout(15_000) })
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  if (response.status !== 303 || cookie === undefined) throw new Error(`Web authentication returned ${String(response.status)}`)
  return { origin: new URL(url).origin, cookie }
}

/**
 * Invoke one public Gateway endpoint.
 * @param connection - authenticated browser connection.
 * @param endpoint - public method name.
 * @param args - named wire arguments.
 * @returns successful method value.
 */
export async function remoteRpc<T>(connection: { origin: string; cookie: string }, endpoint: string, args: object): Promise<T> {
  const response = await fetch(`${connection.origin}/api/${endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: connection.cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: `group-snapshot-${endpoint}`, method: endpoint, payload: { args } }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`${endpoint}: HTTP ${String(response.status)}: ${await response.text()}`)
  const body = await response.json() as { result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } } }
  if (!body.result.ok) throw new Error(`${endpoint}: ${body.result.error.code}: ${body.result.error.message}`)
  return body.result.value
}

/**
 * Read the latest persisted generation for one Session.
 * @param root - isolated Session store.
 * @param sessionId - target executor or transcript identity.
 * @returns matching log, if persisted.
 */
export async function sessionLog(root: string, sessionId: string): Promise<string | undefined> {
  const paths = latestPersistedSessionPaths((await readdir(root, { recursive: true })).map(path => join(root, path)))
  for (const path of paths) {
    const text = await readFile(path, 'utf8')
    const header = z.object({ type: z.literal('session'), id: z.string() }).parse(JSON.parse(text.split('\n', 1)[0] ?? ''))
    if (header.id === sessionId) return text
  }
  return undefined
}

/**
 * Count recorded model responses.
 * @param log - persisted Session JSONL.
 * @returns number of assistant messages.
 */
export function modelResponses(log: string): number {
  const message = z.object({ type: z.literal('assistant/message') })
  return log.trimEnd().split('\n').filter(line => message.safeParse(JSON.parse(line)).success).length
}

/**
 * Stop the scenario-owned Web process.
 * @param child - process started by this snapshot.
 */
export async function close(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>(resolve => child.once('exit', () => { resolve() }))
  child.kill('SIGTERM')
  await Promise.race([exited, delay(3000)])
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await exited
  }
}
