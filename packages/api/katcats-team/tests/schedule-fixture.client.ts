/** Synthetic task, private Bot and historical group-worker identities. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ScheduleCatalogEntry, ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import type { BotId, GroupId, TeamBot, TeamSnapshot } from '../src/types.ts'
import type { ChatId, ChatSnapshot, TeamChat } from '../src/chats-types.ts'

export const writer: TeamBot = {
  id: 'writer' as BotId, kind: 'ordinary', name: 'Writer', role: 'Write', groupId: 'bots' as GroupId,
  avatar: { shape: 'classic', color: '#FF2849' }, model: { kind: 'follow-global' },
  sessionId: 'private-writer' as SessionId, workDir: '/synthetic/writer',
}
export const main: TeamBot = { ...writer, id: 'main' as BotId, kind: 'main', name: 'Katcats',
  sessionId: 'private-main' as SessionId, groupId: null }
export const editorial: TeamChat = {
  id: 'editorial' as ChatId, name: 'Editorial', groupId: 'chats' as GroupId,
  rootSessionId: 'editorial-root' as SessionId, workDir: '/synthetic/editorial',
  memberIds: [writer.id], managerId: null, memberRoles: [],
  executors: [{ botId: writer.id, sessionId: 'editorial-writer' as SessionId },
    { botId: 'former-reviewer' as BotId, sessionId: 'editorial-former-reviewer' as SessionId }],
  relayLimit: 6, generation: 0, status: 'active', pauseReason: null, run: null, error: null,
}
export const research: TeamChat = { ...editorial, id: 'research' as ChatId, name: 'Research',
  rootSessionId: 'research-root' as SessionId,
  executors: [{ botId: writer.id, sessionId: 'research-writer' as SessionId }],
}
export const teamSnapshot: TeamSnapshot = {
  revision: 1, mainBotId: main.id, bots: [main, writer], modelCapabilities: { override: true, followGlobal: true },
  groups: [{ id: 'bots' as GroupId, name: 'Bots', kind: 'bots', system: true },
    { id: 'chats' as GroupId, name: 'Chats', kind: 'chats', system: true }],
}
export const chatSnapshot: ChatSnapshot = { revision: 1, chats: [editorial, research], deliveries: [], relayLimit: 6, activities: [] }

/** Make an authoritative retained task without writing or opening a Session. */
export function task(id: string, sessionId: SessionId, status: ScheduleCatalogEntry['status'] = 'active'): ScheduleCatalogEntry {
  return { id: id as ScheduleId, sessionId, kind: 'at', title: id, prompt: `Instructions for ${id}`,
    scheduledAt: '2099-01-01T00:00:00.000Z', status }
}

export const tasks: ScheduleCatalogEntry[] = [
  task('Creator task', main.sessionId), task('Private draft', writer.sessionId),
  task('Group root task', editorial.rootSessionId), task('Editorial draft', editorial.executors[0]!.sessionId),
  task('Former member task', editorial.executors[1]!.sessionId),
  task('Research draft', research.executors[0]!.sessionId),
  task('Legacy unlinked', 'old-unknown-session' as SessionId, 'inactive'),
]
