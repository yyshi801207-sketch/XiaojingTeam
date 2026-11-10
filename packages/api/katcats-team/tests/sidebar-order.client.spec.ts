// @vitest-environment jsdom
/** Browser-local ordering preserves current group membership and existing folds. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { GroupId } from '../src/types.ts'
import { createSidebarViewStore, orderSidebarEntries } from '../src/client/sidebar-view.ts'

const group = brandString<GroupId>('custom')
const otherGroup = brandString<GroupId>('other')
const bot = brandString<SessionId>('bot-session')
const chat = brandString<SessionId>('chat-session')
const later = brandString<SessionId>('later-session')
const removed = brandString<SessionId>('removed-session')

beforeEach(() => { localStorage.clear() })
afterEach(() => { localStorage.clear() })

describe('sidebar entry order', () => {
  it('keeps the registry pin order and directory order before any manual reorder', () => {
    expect(orderSidebarEntries([bot, chat, later], undefined, [later, chat])).toEqual([later, chat, bot])
    expect(orderSidebarEntries([bot, chat, later], [], [])).toEqual([bot, chat, later])
  })

  it('orders mixed Bot and chat identities without adding departed or duplicate entries', () => {
    expect(orderSidebarEntries([bot, chat, later], [removed, chat, chat, bot], [removed])).toEqual([chat, bot, later])
    expect(orderSidebarEntries([], [removed], [removed])).toEqual([])
  })

  it('keeps manual pin order and appends new entries within their own pin section', () => {
    expect(orderSidebarEntries([bot, chat, later], [chat, bot], [later, bot, chat])).toEqual([chat, bot, later])
    expect(orderSidebarEntries([bot, chat, later], [chat, bot], [later])).toEqual([later, chat, bot])
  })

  it('returns unpinned entries to saved relative order and keeps unsaved directory order', () => {
    expect(orderSidebarEntries([bot, chat, later], [chat, bot, later], [bot])).toEqual([bot, chat, later])
    expect(orderSidebarEntries([bot, chat, later], [chat, bot, later], [])).toEqual([chat, bot, later])
    expect(orderSidebarEntries([bot, chat, later], undefined, [chat])).toEqual([chat, bot, later])
    expect(orderSidebarEntries([bot, chat, later], undefined, [])).toEqual([bot, chat, later])
  })

  it('loads earlier fold preferences and saves ordering without clearing them', () => {
    localStorage.setItem('katcats.sidebar.view.v1', JSON.stringify({ collapsedGroups: { [group]: true } }))
    const first = createSidebarViewStore().create()
    expect(first.getSnapshot().entryOrder).toBeUndefined()
    expect(first.getSnapshot().collapsedGroups[group]).toBe(true)
    first.actions.setEntryOrder(group, [chat, bot])
    const reopened = createSidebarViewStore().create()
    expect(reopened.getSnapshot().entryOrder?.[group]).toEqual([chat, bot])
    expect(reopened.getSnapshot().collapsedGroups[group]).toBe(true)
    expect(orderSidebarEntries([bot, chat, later], reopened.getSnapshot().entryOrder?.[group], [])).toEqual([chat, bot, later])
  })

  it('ignores a saved value that is not an order array', () => {
    localStorage.setItem('katcats.sidebar.view.v1', JSON.stringify({ collapsedGroups: {}, entryOrder: { [group]: 'invalid' } }))
    const reopened = createSidebarViewStore().create().getSnapshot()
    expect(orderSidebarEntries([bot, chat], reopened.entryOrder?.[group], [])).toEqual([bot, chat])
  })

  it('persists each group independently and owns the saved array', () => {
    const store = createSidebarViewStore().create()
    const order = [chat, bot]
    store.actions.setEntryOrder(group, order)
    store.actions.setEntryOrder(otherGroup, [later])
    order.reverse()
    store.actions.setGroupCollapsed(otherGroup, true)
    const reopened = createSidebarViewStore().create().getSnapshot()
    expect(reopened.entryOrder?.[group]).toEqual([chat, bot])
    expect(reopened.entryOrder?.[otherGroup]).toEqual([later])
    expect(reopened.collapsedGroups[otherGroup]).toBe(true)
  })
})
