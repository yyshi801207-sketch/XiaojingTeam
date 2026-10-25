/** Group-local member identities; these references never address or expand Session history. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ChatId } from './chats-types.ts'
import type { BotId } from './types.ts'

/** Stable group and Bot identities with a display-only member label. */
export interface MemberMention {
  readonly chatId: ChatId
  readonly botId: BotId
  readonly label: string
}

/** A complete canonical member reference in original UTF-16 text coordinates. */
export interface MemberMentionMatch {
  readonly start: number
  readonly end: number
  readonly mention: MemberMention
}

/**
 * Encode a member without exposing its private or execution Session identity.
 * @param mention - Group, member and current display label.
 * @returns Canonical text retained in the owner message and replayed to the member.
 */
export function formatMemberMention(mention: MemberMention): string {
  const label = mention.label.replace(/[\r\n]/gu, ' ').replace(/[\\[\]]/gu, '\\$&')
  return `@[${label}](katcats-member:${encodeURIComponent(mention.chatId)}/${encodeURIComponent(mention.botId)})`
}

/**
 * Decode a complete canonical product reference without opening any Session.
 * @param reference - Untrusted text from a draft, clipboard or submitted prompt.
 * @returns The encoded identities, or undefined when the reference is not canonical.
 */
export function parseMemberMention(reference: string): MemberMention | undefined {
  const match = /^@\[((?:\\.|[^\\\]\r\n])*)\]\(katcats-member:([^/\s)]+)\/([^/\s)]+)\)$/u.exec(reference)
  if (match === null) return undefined
  const [, label, rawChat, rawBot] = match
  if (label === undefined || rawChat === undefined || rawBot === undefined) return undefined
  const chat = decodeIdentity(rawChat)
  const bot = decodeIdentity(rawBot)
  if (chat === undefined || bot === undefined) return undefined
  const mention: MemberMention = {
    chatId: brandString<ChatId>(chat), botId: brandString<BotId>(bot),
    label: label.replace(/\\([\\[\]])/gu, '$1'),
  }
  return formatMemberMention(mention) === reference ? mention : undefined
}

/**
 * Find the next complete canonical member reference, leaving unrelated references untouched.
 * @param text - Original prompt or rendered user text.
 * @param from - Inclusive UTF-16 offset.
 * @returns The next matching range and member identities.
 */
export function findMemberMention(text: string, from: number): MemberMentionMatch | undefined {
  const expression = /@\[(?:\\.|[^\\\]\r\n])*\]\(katcats-member:[^\s)]+\)/gu
  expression.lastIndex = from
  for (let match = expression.exec(text); match !== null; match = expression.exec(text)) {
    const mention = parseMemberMention(match[0])
    if (mention !== undefined) return { start: match.index, end: expression.lastIndex, mention }
  }
  return undefined
}

/**
 * Resolve each member token through its current group's admission policy.
 * @param text - Submitted text, including ordinary text and other reference kinds.
 * @param replace - Consumer validation and replacement for each canonical reference.
 * @returns Text with only the validated member references replaced.
 */
export function replaceMemberMentions(text: string, replace: (mention: MemberMention) => string): string {
  let result = ''
  let offset = 0
  for (let match = findMemberMention(text, offset); match !== undefined; match = findMemberMention(text, offset)) {
    result += text.slice(offset, match.start) + replace(match.mention)
    offset = match.end
  }
  return result + text.slice(offset)
}

/**
 * Exclude complete quoted file references and explicit paths from member-address detection.
 * The original prompt remains unchanged; quoted references use the shared `@"path"` file grammar.
 * @param text - Submitted prompt text before resolving any member or Session references.
 * @returns Address-detection text with file tokens replaced by whitespace.
 */
export function maskFileReferences(text: string): string {
  return text.replace(/(?<!\S)@(?:"[^"\r\n]+"|(?:[A-Za-z]:[\\/]|\.{0,2}\/|\\)[^\s"]*)/gu, ' ')
}

function decodeIdentity(encoded: string): string | undefined {
  let decoded: string
  try { decoded = decodeURIComponent(encoded) } catch (error) {
    if (error instanceof URIError) return undefined
    throw error
  }
  return decoded.length > 0 && encodeURIComponent(decoded) === encoded ? decoded : undefined
}
