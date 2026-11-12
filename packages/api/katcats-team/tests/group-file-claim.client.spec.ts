// @vitest-environment jsdom
/** Group file claims and borrowed worker references retain exact recorded ownership. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { MutableSessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionFixture } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConnectionGeneration, ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import type { MessageId, MessageSourceMap, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId, SessionSeq, TurnEndReason } from '@deepseek-ai/dsh-session/types'
import { groupFileClaimMatches } from '../src/group-file-claim.ts'
import { groupFilesClaimMatches, groupFilesTargetAvailable, retainGroupFiles } from '../src/client/group-delivered-files.ts'
import type { GroupFilesOptions, GroupFilesTarget } from '../src/client/group-delivered-files.ts'
import type { ChatView } from '../src/client/chat-model.ts'
import type { TeamView } from '../src/client/model.ts'
import type { ChatDelivery, ChatDeliveryId, ChatId, ChatRunId, TeamChat } from '../src/chats-types.ts'
import type { BotId, GroupId, TeamBot } from '../src/types.ts'

const worker = 'report-writer-worker' as SessionId
const sender = { botId: 'writer' as BotId, name: 'Writer', role: 'Writing', avatar: { shape: 'classic', color: '#FF2849' } }
const source: MessageSourceMap['katcats-group-relay'] = {
  kind: 'katcats-group-relay', form: 'relay', schemaVersion: 1, chatId: 'report-group' as ChatId,
  deliveryId: 'original-delivery' as ChatDeliveryId, runId: 'original-run' as ChatRunId, generation: 3,
  sender, executionSessionId: worker, inputMessageId: 'claimed-input' as MessageId, outputMessageId: 'final-answer' as MessageId,
}
const target: GroupFilesTarget = { rootSessionId: 'report-root' as SessionId, messageId: 'published-relay' as MessageId, source }
const task: MessageSourceMap['katcats-group-task'] = {
  kind: 'katcats-group-task', form: 'relay', chatId: source.chatId, deliveryId: source.deliveryId,
  runId: source.runId, generation: source.generation, target: sender,
}

function start(turn: number, seq: number): SessionLiveEventEntry {
  return { type: 'event', event: { type: 'turn/start', seq: seq as SessionSeq, time: seq, data: { turn } } }
}

function claim(claimed: Partial<typeof task> = {}): SessionLiveEventEntry {
  return { type: 'event', event: { type: 'user/message', seq: 2 as SessionSeq, time: 2, surfaceOp: 'append', data: {
    id: source.inputMessageId, role: 'user', content: [{ type: 'text', text: 'Prepare the report' }], source: { ...task, ...claimed },
  } } }
}

function closing(options: { id?: MessageId; tool?: boolean; interrupted?: true } = {}): SessionLiveEventEntry {
  return { type: 'event', event: { type: 'assistant/message', seq: 3 as SessionSeq, time: 3, surfaceOp: 'append', data: {
    turn: 1, step: 1, stream: [], ...options.interrupted ? { interrupted: options.interrupted } : {}, message: {
      id: options.id ?? source.outputMessageId, role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      content: options.tool ? [{ type: 'tool-call', id: 'unfinished-call' as ToolCallId, name: 'present', arguments: '{}' }]
        : [{ type: 'text', text: 'The registered report is ready.' }],
    },
  } } }
}

function end(reason: TurnEndReason = { kind: 'completed' }, turn = 1, seq = 4): SessionLiveEventEntry {
  return { type: 'event', event: { type: 'turn/end', seq: seq as SessionSeq, time: seq, data: { turn, reason } } }
}

function history(): SessionLiveEventEntry[] { return [start(1, 1), claim(), closing(), end()] }

function windowOf(entries: readonly SessionLiveEventEntry[], hasMore = false) {
  const events = new MutableSessionEventSource()
  events.replace(entries, hasMore)
  return events.getSnapshot()
}

function catalogs() {
  const chat: TeamChat = { id: source.chatId, name: 'Reports', groupId: 'chats' as GroupId,
    rootSessionId: target.rootSessionId, workDir: '/synthetic/reports', memberIds: [], managerId: null, memberRoles: [],
    executors: [{ botId: sender.botId, sessionId: worker }], relayLimit: 16, generation: 3,
    status: 'active', pauseReason: null, run: null, error: null }
  const chats = createSnapshotStore<ChatView>({ phase: 'ready', snapshot: {
    revision: 1, chats: [chat], deliveries: [], relayLimit: 16, activities: [],
  } })
  const directory = createSnapshotStore<TeamView>({ phase: 'ready', catalog: null, snapshot: {
    revision: 1, mainBotId: 'main' as BotId, bots: [], groups: [], modelCapabilities: { override: false, followGlobal: false },
  } })
  const state = createSnapshotStore<ConnectionState | undefined>('connected')
  const generation = createSnapshotStore<ConnectionGeneration | undefined>({ id: 1, host: { home: '/synthetic' } })
  return { chat, chats, directory, state, generation }
}

function delivery(patch: Partial<ChatDelivery> = {}): ChatDelivery {
  return { id: source.deliveryId, chatId: source.chatId, runId: source.runId, generation: source.generation,
    sourceSessionId: target.rootSessionId, source: { kind: 'owner-message', messageId: 'owner-message' as MessageId },
    botId: sender.botId, executorSessionId: worker, message: 'Prepare the report', inputMessageId: source.inputMessageId,
    relayMessageId: target.messageId, state: 'completed', receipt: { sender, text: 'The registered report is ready.',
      outputMessageId: source.outputMessageId, turn: 1 }, pass: null, relayed: true, error: null, ...patch }
}

async function setup(fixture: Partial<Omit<SessionFixture, 'id'>> = {}) {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  await runtime.sessions.add({ id: worker, events: history(), ...fixture })
  const catalog = catalogs()
  const options: GroupFilesOptions = { sessions: runtime.sessions, chats: catalog.chats, directory: catalog.directory,
    connection: { state: catalog.state, generation: catalog.generation } }
  const retained = () => runtime.sessions.retainInfo(worker).getSnapshot().retainedBy.katcatsDeliveredFiles ?? 0
  return { runtime, options, retained, ...catalog }
}

describe('recorded final group file claim', () => {
  it('accepts the exact completed worker claim through both shared and client readers', () => {
    const entries = history()
    expect(groupFileClaimMatches(source, entries.map(entry => entry.event))).toBe(true)
    expect(groupFilesClaimMatches(target, windowOf(entries))).toBe(true)
    expect(entries.map(entry => ({ type: entry.event.type, data: entry.event.data }))).toMatchInlineSnapshot(`
      [
        {
          "data": {
            "turn": 1,
          },
          "type": "turn/start",
        },
        {
          "data": {
            "content": [
              {
                "text": "Prepare the report",
                "type": "text",
              },
            ],
            "id": "claimed-input",
            "role": "user",
            "source": {
              "chatId": "report-group",
              "deliveryId": "original-delivery",
              "form": "relay",
              "generation": 3,
              "kind": "katcats-group-task",
              "runId": "original-run",
              "target": {
                "avatar": {
                  "color": "#FF2849",
                  "shape": "classic",
                },
                "botId": "writer",
                "name": "Writer",
                "role": "Writing",
              },
            },
          },
          "type": "user/message",
        },
        {
          "data": {
            "message": {
              "content": [
                {
                  "text": "The registered report is ready.",
                  "type": "text",
                },
              ],
              "id": "final-answer",
              "role": "assistant",
              "source": {
                "kind": "model",
                "model": "fixture",
                "provider": "fixture",
              },
            },
            "step": 1,
            "stream": [],
            "turn": 1,
          },
          "type": "assistant/message",
        },
        {
          "data": {
            "reason": {
              "kind": "completed",
            },
            "turn": 1,
          },
          "type": "turn/end",
        },
      ]
    `)
  })

  it.each([
    { chatId: 'other-group' as ChatId },
    { deliveryId: 'other-delivery' as ChatDeliveryId },
    { runId: 'new-run' as ChatRunId, generation: 4 },
    { target: { ...sender, botId: 'reviewer' as BotId } },
  ])('rejects an output claimed by another dispatch: %j', (mismatch) => {
    expect(groupFilesClaimMatches(target, windowOf([start(1, 1), claim(mismatch), closing(), end()]))).toBe(false)
  })

  it.each<TurnEndReason>([
    { kind: 'error', error: { code: 'UNKNOWN', message: 'Synthetic failure' } },
    { kind: 'blocked' }, { kind: 'interrupted' },
  ])('rejects a final-looking output when its turn ends with $kind', (reason) => {
    expect(groupFilesClaimMatches(target, windowOf([start(1, 1), claim(), closing(), end(reason)]))).toBe(false)
  })

  it('does not promote an intermediate tool step, interrupted output or another turn into the final reply', () => {
    for (const output of [closing({ tool: true }), closing({ interrupted: true }), closing({ id: 'other-output' as MessageId })]) {
      expect(groupFilesClaimMatches(target, windowOf([start(1, 1), claim(), output, end()]))).toBe(false)
    }
    expect(groupFilesClaimMatches(target, windowOf([start(1, 1), claim(), closing(), start(2, 4), end(undefined, 2, 5)]))).toBe(false)
    expect(groupFilesClaimMatches(target, windowOf([start(1, 1), claim(), closing(), closing({ id: 'later-output' as MessageId }), end()]))).toBe(false)
  })
})

describe('group delivery acquisition', () => {
  it('preserves verified historical access after member removal and journal trimming, and releases on unmount cancellation', async () => {
    const b = await setup()
    expect(b.chat.memberIds).toEqual([])
    expect(b.chats.getSnapshot().snapshot?.deliveries).toEqual([])
    const lifetime = new AbortController()
    const { reference } = await retainGroupFiles(b.options, target, lifetime.signal)
    expect(reference.binding).toBe(b.runtime.sessions.binding(worker))
    expect(b.retained()).toBe(1)
    lifetime.abort()
    reference.release()
    expect(b.retained()).toBe(0)
  })

  it.each([
    delivery({ inputMessageId: 'unrelated-input' as MessageId }),
    delivery({ state: 'failed', receipt: null }),
    delivery({ relayMessageId: 'other-root-relay' as MessageId }),
  ])('rejects a conflicting retained journal row before retaining the worker: $state', async (row) => {
    const b = await setup()
    b.chats.set({ phase: 'ready', snapshot: { ...b.chats.getSnapshot().snapshot!, deliveries: [row] } })
    const retain = vi.spyOn(b.runtime.sessions, 'retain')
    await expect(retainGroupFiles(b.options, target, new AbortController().signal)).rejects.toThrow('unavailable')
    expect(retain).not.toHaveBeenCalled()
  })

  it('refuses other roots, private aliases and an executor reused by a different group', () => {
    const b = catalogs()
    const groups = b.chats.getSnapshot()
    const team = b.directory.getSnapshot()
    expect(groupFilesTargetAvailable({ ...target, rootSessionId: 'other-root' as SessionId }, groups, team)).toBe(false)
    const privateBot: TeamBot = { id: sender.botId, kind: 'ordinary', name: 'Writer', role: 'Writing', avatar: sender.avatar,
      model: { kind: 'follow-global' }, workDir: '/synthetic/private', groupId: null, sessionId: worker }
    expect(groupFilesTargetAvailable(target, groups, { ...team, snapshot: { ...team.snapshot!, bots: [privateBot] } })).toBe(false)
    expect(groupFilesTargetAvailable(target, { ...groups, snapshot: { ...groups.snapshot!, chats: [b.chat,
      { ...b.chat, id: 'other-group' as ChatId, rootSessionId: 'other-root' as SessionId }] } }, team)).toBe(false)
  })

  it('loads a cold claim through the public history face before returning its reference', async () => {
    const loadThrough = vi.fn(async () => { await b.runtime.sessions.replaceEvents(worker, history(), false) })
    const b = await setup({ events: history().slice(-2), hasMore: true, session: { loadThrough } })
    const lifetime = new AbortController()
    const { reference } = await retainGroupFiles(b.options, target, lifetime.signal)
    expect(loadThrough).toHaveBeenCalledExactlyOnceWith(1)
    expect(b.retained()).toBe(1)
    lifetime.abort()
    reference.release()
    expect(b.retained()).toBe(0)
  })

  it('releases a failed open and a failed historical lookup without returning a reference', async () => {
    const failedOpen = await setup({ initialOpen: async () => { throw new Error('Synthetic open failure') } })
    await expect(retainGroupFiles(failedOpen.options, target, new AbortController().signal)).rejects.toThrow('Synthetic open failure')
    expect(failedOpen.retained()).toBe(0)
    const failedHistory = await setup({ events: [], hasMore: true, session: {
      loadThrough: async () => { throw new Error('Synthetic history failure') },
    } })
    await expect(retainGroupFiles(failedHistory.options, target, new AbortController().signal)).rejects.toThrow('Synthetic history failure')
    expect(failedHistory.retained()).toBe(0)
  })

  it('releases immediately when a pending mount is cancelled and does not reacquire on late readiness', async () => {
    const opening = Promise.withResolvers<undefined>()
    const b = await setup({ initialOpen: () => opening.promise })
    const lifetime = new AbortController()
    const pending = retainGroupFiles(b.options, target, lifetime.signal)
    const rejection = expect(pending).rejects.toThrow()
    expect(b.retained()).toBe(1)
    lifetime.abort()
    expect(b.retained()).toBe(0)
    opening.resolve(undefined)
    await rejection
    expect(b.retained()).toBe(0)
  })

  it.each(['binding', 'connection', 'directory', 'cancel'] as const)('rechecks %s after asynchronous history loading and releases the obsolete result', async (change) => {
    const loaded = Promise.withResolvers<undefined>()
    const loadThrough = vi.fn(async () => { await loaded.promise })
    const b = await setup({ events: [], hasMore: true, session: { loadThrough } })
    const lifetime = new AbortController()
    const replacementOwner = change === 'binding' ? await setup() : undefined
    const replacementReference = replacementOwner?.runtime.sessions.retainFor(replacementOwner.runtime.ctx, worker)
    await replacementReference?.ready
    let replacement = false
    const options: GroupFilesOptions = { ...b.options, sessions: {
      retain: (id, retainOptions) => b.runtime.sessions.retain(id, retainOptions),
      binding: id => replacement ? replacementReference?.binding : b.runtime.sessions.binding(id),
    } }
    const pending = retainGroupFiles(options, target, lifetime.signal)
    const rejection = expect(pending).rejects.toThrow('does not belong')
    await vi.waitFor(() => { expect(loadThrough).toHaveBeenCalledOnce() })
    if (change === 'binding') replacement = true
    if (change === 'connection') b.generation.set({ id: 2, host: { home: '/synthetic' } })
    if (change === 'directory') b.chats.set({ phase: 'loading', snapshot: b.chats.getSnapshot().snapshot })
    if (change === 'cancel') { lifetime.abort(); expect(b.retained()).toBe(0) }
    await b.runtime.sessions.replaceEvents(worker, history(), false)
    loaded.resolve(undefined)
    await rejection
    expect(b.retained()).toBe(0)
    if (replacementReference !== undefined) {
      expect(replacementOwner?.runtime.sessions.retainInfo(worker).getSnapshot().referenceCount).toBe(1)
      replacementReference.release()
    }
  })
})
