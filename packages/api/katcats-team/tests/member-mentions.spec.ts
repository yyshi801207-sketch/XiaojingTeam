import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { BotId } from '../src/types.ts'
import type { ChatId } from '../src/chats-types.ts'
import { findMemberMention, formatMemberMention, parseMemberMention, replaceMemberMentions } from '../src/member-mentions.ts'

const member = { chatId: brandString<ChatId>('chat-a'), botId: brandString<BotId>('bot-a'), label: '写作助手' }

describe('group member mention text', () => {
  it('encodes stable group and Bot identities without a Session reference', () => {
    const text = formatMemberMention(member)
    expect(text).toBe('@[写作助手](katcats-member:chat-a/bot-a)')
    expect(parseMemberMention(text)).toEqual(member)
    expect(text).not.toContain('dsh-session:')
  })

  it('round trips labels and opaque identities containing reserved characters', () => {
    const value = { chatId: brandString<ChatId>('群/组?'), botId: brandString<BotId>('成员 /+%'), label: 'Writer [A] \\ helper)' }
    expect(parseMemberMention(formatMemberMention(value))).toEqual(value)
    expect(formatMemberMention({ ...value, label: 'Writer\nA' })).not.toContain('\n')
  })

  it.each([
    '@[name](dsh-session:private-session)',
    '@[name](katcats-member:chat-a/)',
    '@[name](katcats-member:/bot-a)',
    '@[name](katcats-member:chat-a/bot-a/extra)',
    '@[name](katcats-member:%/bot-a)',
    '@[name](katcats-member:%61/bot-a)',
    '@[name](katcats-member:chat-a/%2f)',
    '@[na\\me](katcats-member:chat-a/bot-a)',
    '@[name\nnext](katcats-member:chat-a/bot-a)',
    'prefix @[name](katcats-member:chat-a/bot-a)',
    '@[name](katcats-member:chat-a/bot-a) suffix',
  ])('refuses noncanonical member text: %s', (text) => {
    expect(parseMemberMention(text)).toBeUndefined()
  })

  it('finds original UTF-16 ranges without taking over file or historical Session references', () => {
    const token = formatMemberMention(member)
    const prefix = '😀 @[old](dsh-session:old) @draft.md '
    const text = `${prefix}${token} hello ${token}`
    expect(findMemberMention(text, 0)).toEqual({ start: prefix.length, end: prefix.length + token.length, mention: member })
    expect(findMemberMention(text, prefix.length + token.length)?.start).toBe(prefix.length + token.length + 7)
    expect(findMemberMention('@[name](katcats-member:%/bot) @draft.md', 0)).toBeUndefined()
  })

  it('lets admission validate every identity while preserving all unrelated original text', () => {
    const second = { ...member, botId: brandString<BotId>('bot-b'), label: '资料助理' }
    const found: string[] = []
    const text = `${formatMemberMention(member)} and ${formatMemberMention(second)} @draft.md`
    expect(replaceMemberMentions(text, (value) => { found.push(value.botId); return ' ' })).toBe('  and   @draft.md')
    expect(found).toEqual(['bot-a', 'bot-b'])
    expect(() => replaceMemberMentions(text, () => { throw new Error('Membership changed') })).toThrow('Membership changed')
  })
})
