/** Current-group member discovery and display, independent of private Session references. */
import type { UserTextNodeProps, UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ClientSessionContext, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatId, TeamChat } from '../chats-types.ts'
import type { TeamBot } from '../types.ts'
import { findMemberMention, formatMemberMention, parseMemberMention } from '../member-mentions.ts'
import type { ChatView } from './chat-model.ts'
import type { TeamView } from './model.ts'
import { CatAvatar } from './avatars.tsx'
import css from './member-mentions.module.css'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    'katcats-member': { readonly chatId: string; readonly botId: string; readonly label: string }
  }
}

/** Member discovery reads only product-owned snapshots. */
export interface MemberMentionOptions {
  readonly directory: ObservableSnapshot<TeamView>
  readonly chats: ObservableSnapshot<ChatView>
  /** @returns Current localized reason shown when a selected member is no longer available. */
  readonly unavailableReason: () => string
}

/** Product discovery claim; registration awaits the separately reviewed trigger API. */
export interface MemberMentionSource extends InputTriggerSource {
  /** @param session - Current composer. @returns Whether ordinary @ discovery must be suppressed. */
  exclusive(session: ClientSessionContext): boolean
  /** Wait for fresh team and group snapshots after the Host connection changes. */
  invalidate(): void
  /** Remove source-owned directory subscriptions after unregistering the source. */
  dispose(): void
}

/**
 * Create a group-only source with live membership checks at pick and serialization time.
 * @param options - Current team and group stores, never a Session history reader.
 * @returns Source with explicit reconnect invalidation and owned teardown.
 */
export function createMemberMentionSource(options: MemberMentionOptions): MemberMentionSource {
  const knownGroups = new Set<import('@deepseek-ai/dsh-session/types').SessionId>()
  const listeners = new Set<() => void>()
  let freshTeam = options.directory.getSnapshot().phase === 'ready'
  let freshChats = options.chats.getSnapshot().phase === 'ready'
  let disposed = false
  const notify = (): void => { for (const listener of listeners) listener() }
  const rememberGroups = (): void => {
    for (const chat of options.chats.getSnapshot().snapshot?.chats ?? []) knownGroups.add(chat.rootSessionId)
  }
  rememberGroups()
  const stopTeam = options.directory.subscribe(() => {
    freshTeam = options.directory.getSnapshot().phase === 'ready'
    notify()
  })
  const stopChats = options.chats.subscribe(() => {
    rememberGroups()
    freshChats = options.chats.getSnapshot().phase === 'ready'
    notify()
  })
  const ready = (): boolean => !disposed && freshTeam && freshChats
    && options.directory.getSnapshot().snapshot !== null && options.chats.getSnapshot().snapshot !== null
  const group = (session: ClientSessionContext): TeamChat | undefined => ready()
    ? options.chats.getSnapshot().snapshot?.chats.find(chat => chat.rootSessionId === session.sessionId) : undefined
  const members = (chat: TeamChat): readonly TeamBot[] => {
    const bots = options.directory.getSnapshot().snapshot?.bots ?? []
    return chat.memberIds.flatMap(id => bots.filter(bot => bot.id === id && bot.kind === 'ordinary'))
  }
  const resolveReference = (reference: string, chatId?: ChatId) => {
    const mention = parseMemberMention(reference)
    if (!ready() || mention === undefined || (chatId !== undefined && mention.chatId !== chatId)) return undefined
    const chat = options.chats.getSnapshot().snapshot?.chats.find(chat => chat.id === mention.chatId)
    if (chat === undefined) return undefined
    const bot = members(chat).find(bot => bot.id === mention.botId)
    return bot === undefined ? undefined : { chat, bot }
  }
  return {
    name: 'katcats-member', trigger: '@', order: -100, showGroupTitle: false,
    exclusive: session => !ready() || knownGroups.has(session.sessionId),
    candidates(session, { query, signal }) {
      if (signal.aborted) return Promise.resolve([])
      const chat = group(session)
      if (chat === undefined) return Promise.resolve([])
      const list = members(chat)
      const nameCounts = new Map<string, number>()
      const nameIndexes = new Map<string, number>()
      for (const bot of list) nameCounts.set(bot.name, (nameCounts.get(bot.name) ?? 0) + 1)
      return Promise.resolve(list.flatMap((bot) => {
        const role = chat.memberRoles.find(value => value.botId === bot.id)?.role ?? bot.role
        const index = (nameIndexes.get(bot.name) ?? 0) + 1
        nameIndexes.set(bot.name, index)
        if (!`${bot.name}\n${role}`.toLowerCase().includes(query.toLowerCase())) return []
        return [{
          name: (nameCounts.get(bot.name) ?? 0) > 1 ? `${bot.name} · ${String(index)}` : bot.name,
          ...(role.length > 0 ? { description: role } : {}),
          value: formatMemberMention({ chatId: chat.id, botId: bot.id, label: bot.name }),
          icon: ({ size = 20 }: IconProps) => <CatAvatar appearance={bot.avatar} size={size} />,
        }]
      }))
    },
    onPick({ session, candidate }) {
      const chat = group(session)
      if (chat === undefined || candidate.value === undefined) return undefined
      const resolved = resolveReference(candidate.value, chat.id)
      if (resolved === undefined) return undefined
      const reference = formatMemberMention({ chatId: chat.id, botId: resolved.bot.id, label: resolved.bot.name })
      return { insert: { source: 'katcats-member', ref: reference, label: resolved.bot.name, clipboardText: reference } }
    },
    lexicon: (session) => {
      const chat = group(session)
      return chat === undefined ? [] : members(chat).map(bot => bot.name)
    },
    subscribeLexicon(_session, listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    codec: {
      clipboardText: reference => reference,
      serialize(reference, signal) {
        return Promise.resolve().then(() => {
          signal.throwIfAborted()
          const resolved = resolveReference(reference)
          if (resolved === undefined) throw new Error(options.unavailableReason())
          return formatMemberMention({ chatId: resolved.chat.id, botId: resolved.bot.id, label: resolved.bot.name })
        })
      },
    },
    invalidate() { freshTeam = false; freshChats = false; notify() },
    dispose() { disposed = true; stopTeam(); stopChats(); listeners.clear() },
  }
}

/** Product references take precedence over generic file parsing at the same position. */
export const memberMentionRule: UserTextRule<'katcats-member'> = {
  id: 'katcats-member', order: 0,
  match(text, from) {
    const match = findMemberMention(text, from)
    return match === undefined ? undefined : {
      id: 'katcats-member', start: match.start, end: match.end, data: match.mention,
    }
  },
}

/**
 * Display a persisted point of address without opening another Session or showing raw identities.
 * @param props - Persisted product reference and original owner message context.
 * @returns The original display name, including after a later rename or removal.
 */
export function MemberMentionLabel({ node }: Pick<UserTextNodeProps<'katcats-member'>, 'node'>) {
  return <span className={css.mention}>@{node.data.label}</span>
}
