/** Compare the group executor recording and public transcript with shared typed identities. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'
import {
  formatSystemPromptSnapshot, formatToolSchemasSnapshot, normalizeSessionLog,
  redactSessionSnapshotIds, scrubSessionSnapshot, sessionFixtureName, sessionHeaderVersion,
} from '@deepseek-ai/dsh-session-snapshot'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { normalizeWebSessionVolatiles } from '../../apps/web/tests/scaffold.ts'

/** Persisted logs from the public Web group protocol scenario. */
export interface GroupSnapshotInput {
  readonly directory: string
  readonly workerLog: string
  readonly rootLog: string
  readonly cwd: string
  readonly memberIds: readonly string[]
  readonly mode: 'replay' | 'refresh'
}

/**
 * Record or compare all model input, model output and public delivery events.
 * Identity claims come from both real logs so original owner IDs in member text retain their relationships.
 * @param input - actual persisted logs and the scenario's isolated workspace.
 */
export async function verifyGroupSnapshots(input: GroupSnapshotInput): Promise<void> {
  const ctx = { sessionIds: [], cwd: input.cwd }
  const identityClaims = JSON.stringify({ members: input.memberIds.map(botId => ({ botId })) }) + '\n'
  const [worker, root] = redactSessionSnapshotIds([
    ...[input.workerLog, input.rootLog].map(log => normalizeWebSessionVolatiles(log, input.cwd)), identityClaims,
  ]).slice(0, 2)
    .map(log => normalizeSessionLog(log, ctx, { identityMode: 'preserve' }))
  if (worker === undefined || root === undefined) throw new Error('The group snapshot requires executor and root logs.')
  const events = parseSessionLog(worker)
  const prompts = events.flatMap(event => event.type === 'system/message'
    ? [event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')] : [])
  const schemas = events.flatMap(event => event.type === 'request/header' && event.data.header.tools !== undefined
    ? [[...event.data.header.tools]] : [])
  const firstPrompt = prompts[0]
  const firstSchemas = schemas[0]
  if (firstPrompt === undefined || firstSchemas === undefined) throw new Error('The group executor issued no recorded model request.')
  const files = new Map([
    [sessionFixtureName(0, sessionHeaderVersion(worker, 'group executor')), scrubSessionSnapshot(worker)],
    ['root-transcript.expected.json', JSON.stringify(scrubSessionSnapshot(root).trimEnd().split('\n')
      .map((line): unknown => JSON.parse(line)), null, 2) + '\n'],
    ['system-prompt.expected.md', formatSystemPromptSnapshot(firstPrompt, prompts.slice(1))],
    ['tool-schemas.expected.json', formatToolSchemasSnapshot(firstSchemas, schemas.slice(1))],
  ])
  for (const [name, actual] of files) {
    const path = join(input.directory, name)
    if (input.mode === 'refresh') await writeFile(path, actual)
    else expect(actual, name).toBe(await readFile(path, 'utf8'))
  }
}
