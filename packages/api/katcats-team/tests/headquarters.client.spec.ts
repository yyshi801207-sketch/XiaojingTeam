/** Group room placement and selected subscriptions remain independent of each other. */
import { describe, expect, it } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { BotId, GroupId, TeamBot, TeamSnapshot } from '../src/types.ts'
import type { ChatDelivery, ChatDeliveryId, ChatId, ChatRunId, ChatSnapshot, TeamChat } from '../src/chats-types.ts'
import type { RoomActivitySnapshot } from '../src/client/room-activity.ts'
import { headquartersActivity, headquartersAddresses, headquartersProgress, projectHeadquarters } from '../src/client/headquarters-model.ts'
import { createHeadquartersState } from '../src/client/headquarters-state.ts'

const mainId = 'main' as BotId, sharedId = 'shared' as BotId
const firstId = 'first' as ChatId, secondId = 'second' as ChatId
const bot = (id: BotId, name: string): TeamBot => ({ id, name, kind: id === mainId ? 'main' : 'ordinary',
  role: 'Synthetic role', avatar: { shape: 'classic', color: '#10B8A6' }, model: { kind: 'follow-global' },
  workDir: '/synthetic', groupId: null, sessionId: `private-${id}` as SessionId })
const chat = (id: ChatId): TeamChat => ({ id, name: id, rootSessionId: `root-${id}` as SessionId, groupId: 'groups' as GroupId,
  memberIds: [sharedId], managerId: sharedId, memberRoles: [], executors: [{ botId: sharedId, sessionId: `executor-${id}` as SessionId }],
  workDir: '/synthetic/group', relayLimit: 6, status: 'active', pauseReason: null, error: null, run: null, generation: 1 })

describe('global headquarters', () => {
  it('counts current-run outcomes without mixing old runs, other groups, silence or failures into completion', () => {
    const delivery = (id: string, state: ChatDelivery['state'], generation = 2, chatId = firstId): ChatDelivery => ({
      id: id as ChatDeliveryId, chatId, runId: `run-${generation}` as ChatRunId, generation,
      sourceSessionId: 'root' as SessionId, source: { kind: 'owner-message', messageId: id as MessageId },
      botId: sharedId, executorSessionId: 'worker' as SessionId, message: 'Synthetic task', inputMessageId: id as MessageId,
      relayMessageId: id as MessageId, state, receipt: null, pass: null, relayed: true, error: null,
    })
    const snapshot: ChatSnapshot = { revision: 1, chats: [chat(firstId)], relayLimit: 6, activities: [], deliveries: [
      delivery('old', 'completed', 1), delivery('done', 'completed'), delivery('busy', 'running'),
      delivery('error', 'failed'), delivery('unknown', 'unknown'), delivery('skip', 'passed'), delivery('other', 'completed', 2, secondId),
    ] }
    const group = { ...chat(firstId), run: { id: 'run-2' as ChatRunId, generation: 2, relayCount: 0 } }
    expect(headquartersProgress(group, snapshot)).toEqual({ completed: 1, total: 4, percent: 25, running: 1, queued: 0, unresolved: 2 })
    expect(headquartersProgress(chat(firstId), snapshot)).toEqual(headquartersProgress(group, snapshot))
    expect(headquartersProgress({ ...group, run: { ...group.run, id: 'new' as ChatRunId } }, snapshot).percent).toBeNull()
    expect(headquartersProgress(group, { ...snapshot, deliveries: [] }).percent).toBeNull()
    expect(headquartersProgress(group, { ...snapshot, deliveries: [delivery('done', 'completed'), delivery('skip', 'passed')] }).percent).toBe(100)
  })
  it('deduplicates busy Bots across groups and private sessions, excluding removed groups', () => {
    const snapshot: ChatSnapshot = { revision: 1, chats: [chat(firstId), chat(secondId)], deliveries: [], relayLimit: 6, activities: [
      { chatId: firstId, processing: true, runningBotIds: [sharedId], pendingControl: null },
      { chatId: secondId, processing: true, runningBotIds: [sharedId], pendingControl: null },
      { chatId: 'removed' as ChatId, processing: true, runningBotIds: ['removed' as BotId], pendingControl: null },
    ] }
    expect(headquartersActivity(snapshot, [sharedId, mainId])).toEqual({ busy: 2, active: 2 })
    expect(headquartersActivity({ ...snapshot, activities: [] }, [])).toEqual({ busy: 0, active: 0 })
  })
  it('binds the central office by main identity, preserving independent shared-member states', () => {
    const directory: TeamSnapshot = { revision: 1, mainBotId: mainId, groups: [],
      bots: [bot(sharedId, '小兢会计'), bot(mainId, 'Renamed main')], modelCapabilities: { override: true, followGlobal: true } }
    const snapshot: ChatSnapshot = { revision: 1, chats: [chat(firstId), { ...chat(secondId), managerId: null }],
      deliveries: [], relayLimit: 6,
      activities: [{ chatId: firstId, processing: true, runningBotIds: [sharedId], pendingControl: null }] }
    const result = projectHeadquarters(directory, snapshot, true)
    expect(result.main?.name).toBe('Renamed main')
    expect(result.groups.map(group => [group.chat.id, group.chat.managerId, group.projection.members[0]?.phase]))
      .toEqual([[firstId, sharedId, 'started'], [secondId, null, 'idle']])
    expect(result.independent).toEqual([])
    expect(projectHeadquarters({ ...directory, bots: [directory.bots[0]!] }, snapshot, true).main).toBeNull()
    expect(result).toMatchSnapshot()
  })
  it('keeps addresses stable across reordering and deletion, then allocates another floor', () => {
    const ids = Array.from({ length: 9 }, (_, index) => `group-${index}` as ChatId)
    const initial = headquartersAddresses(new Map(), ids)
    const reordered = headquartersAddresses(initial, ids.toReversed().slice(1))
    expect([...reordered]).toEqual([...initial])
    expect(initial.get(ids[8]!)).toBe(8)
    expect(headquartersAddresses(reordered, ['new' as ChatId]).get('new' as ChatId)).toBe(9)
  })
  it('releases the old observer before switching, rejects late events and releases on close', () => {
    const watched: { id: ChatId; signal: AbortSignal; source: ReturnType<typeof createSnapshotStore<RoomActivitySnapshot>> }[] = []
    const state = createHeadquartersState((id, signal) => {
      expect(watched.every(item => item.signal.aborted)).toBe(true)
      const source = createSnapshotStore<RoomActivitySnapshot>({ connected: true, members: [] })
      watched.push({ id, signal, source }); return source
    })
    state.select(firstId)
    expect(watched).toHaveLength(0)
    state.open()
    expect(watched[0]?.id).toBe(firstId)
    state.select(secondId)
    expect(watched[0]?.signal.aborted).toBe(true)
    const current = state.source.getSnapshot()
    watched[0]!.source.set({ connected: false, members: [] })
    expect(state.source.getSnapshot()).toBe(current)
    state.close()
    expect(watched[1]?.signal.aborted).toBe(true)
    expect(state.source.getSnapshot().selected).toBe(secondId)
    state.dispose()
  })
})
