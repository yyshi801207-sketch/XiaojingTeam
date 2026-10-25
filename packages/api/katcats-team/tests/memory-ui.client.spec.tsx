// @vitest-environment jsdom
/** Owner memory editing uses explicit scopes, source-preserving copies and selected revisions. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { BotId, GroupId, TeamBot } from '../src/types.ts'
import type { ChatId, TeamChat } from '../src/chats-types.ts'
import type { MemoryEntry, MemoryId, MemoryList, MemoryListRequest } from '../src/memory-types.ts'
import type { TeamView } from '../src/client/model.ts'
import type { ChatView } from '../src/client/chat-model.ts'
import { MemoryPanel, type MemoryPanelInjected, type MemoryPanelProps } from '../src/client/MemoryPanel.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
const t = makeTranslate(zh)
const writer: TeamBot = { id: 'writer' as BotId, kind: 'ordinary', name: 'Writer', role: 'Write',
  avatar: { shape: 'classic', color: '#2288FF' }, model: { kind: 'follow-global' }, groupId: 'bots' as GroupId,
  sessionId: 'writer-private' as SessionId, workDir: '/synthetic/writer' }
const chat: TeamChat = { id: 'editorial' as ChatId, name: 'Editorial', groupId: 'chats' as GroupId,
  rootSessionId: 'editorial-root' as SessionId, workDir: '/synthetic/editorial', memberIds: [writer.id],
  managerId: null, memberRoles: [], executors: [{ botId: writer.id, sessionId: 'editorial-writer' as SessionId }],
  status: 'active', pauseReason: null, run: null, generation: 0, relayLimit: 6, error: null }
const entry: MemoryEntry = { id: 'memory-one' as MemoryId, scope: { kind: 'bot', botId: writer.id },
  text: 'Saved private preference', version: 1, author: { kind: 'bot', botId: writer.id, sessionId: writer.sessionId },
  createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, source: null }

function bench(entries: readonly MemoryEntry[] = [entry], sessionId = writer.sessionId) {
  const watchers: { request: MemoryListRequest; replace: (value: MemoryList) => void; failed: () => void; dispose: ReturnType<typeof vi.fn> }[] = []
  const watch = vi.fn<MemoryPanelInjected['watch']>((request, replace, failed) => {
    const dispose = vi.fn(async () => {})
    watchers.push({ request, replace, failed, dispose })
    replace({ revision: 1, scope: request.scope, entries })
    return { dispose }
  })
  const directory = createSnapshotStore<TeamView>({ phase: 'ready', catalog: null, snapshot: { revision: 1,
    mainBotId: 'main' as BotId, bots: [writer], groups: [], modelCapabilities: { override: true, followGlobal: true } } })
  const groups = createSnapshotStore<ChatView>({ phase: 'ready', snapshot: { revision: 1, chats: [chat], deliveries: [], relayLimit: 6, activities: [] } })
  const operations = { saveMemory: vi.fn<MemoryPanelInjected['saveMemory']>(async () => {}),
    editMemory: vi.fn<MemoryPanelInjected['editMemory']>(async () => {}), deleteMemory: vi.fn<MemoryPanelInjected['deleteMemory']>(async () => {}),
    shareMemory: vi.fn<MemoryPanelInjected['shareMemory']>(async () => {}) }
  const props = { sessionId, useDirectory: bindSnapshotSelector(directory), useChats: bindSnapshotSelector(groups),
    watch, ...operations, t } as MemoryPanelProps
  const replace = (next: readonly MemoryEntry[]) => {
    const current = watchers.at(-1)!
    act(() => { current.replace({ revision: 2, scope: current.request.scope, entries: next }) })
  }
  return { props, watchers, watch, replace, ...operations }
}

describe('explicitly scoped memory panel', () => {
  it('opens only the current Bot scope, searches saved text and saves with that explicit scope', async () => {
    const fixture = bench([])
    render(<MemoryPanel {...fixture.props} />)
    expect(fixture.watchers[0]?.request).toEqual({ scope: { kind: 'bot', botId: writer.id } })
    fireEvent.change(screen.getByLabelText(zh['memory.new']), { target: { value: '  Keep this preference  ' } })
    fireEvent.click(screen.getByRole('button', { name: zh['memory.add'] }))
    await waitFor(() => { expect(fixture.saveMemory).toHaveBeenCalledExactlyOnceWith({ scope: entry.scope, text: 'Keep this preference' }) })
    expect(screen.getByText(zh['memory.saved'])).toBeTruthy()
    fireEvent.change(screen.getByLabelText(zh['memory.search']), { target: { value: '  preference  ' } })
    fireEvent.click(screen.getByRole('button', { name: zh['memory.search'] }))
    expect(fixture.watchers.at(-1)?.request).toEqual({ scope: entry.scope, query: 'preference' })
    expect(fixture.watchers[0]?.dispose).toHaveBeenCalledOnce()
  })

  it('uses group memory for group roots and ignores late data from a scope that was explicitly left', () => {
    const fixture = bench([], chat.rootSessionId)
    const view = render(<MemoryPanel {...fixture.props} />)
    expect(fixture.watchers[0]?.request).toEqual({ scope: { kind: 'group', chatId: chat.id } })
    fireEvent.click(screen.getByLabelText(zh['memory.scope']))
    fireEvent.click(screen.getByRole('menuitem', { name: zh['memory.team'] }))
    expect(fixture.watchers[0]?.dispose).toHaveBeenCalledOnce()
    expect(fixture.watchers[1]?.request).toEqual({ scope: { kind: 'team' } })
    act(() => { fixture.watchers[0]?.replace({ revision: 9, scope: entry.scope, entries: [entry] }) })
    expect(screen.queryByText(entry.text)).toBeNull()
    view.unmount()
    expect(fixture.watchers[1]?.dispose).toHaveBeenCalledOnce()
  })

  it('retains a failed edit and compares the version selected before a remote replacement', async () => {
    const fixture = bench()
    fixture.editMemory.mockRejectedValue(new Error('synthetic version conflict'))
    render(<MemoryPanel {...fixture.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['memory.edit'] }))
    fireEvent.change(screen.getByLabelText(zh['memory.editText']), { target: { value: 'My unsaved edit' } })
    fixture.replace([{ ...entry, version: 2, text: 'A newer remote entry' }])
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['memory.editText']).value).toBe('My unsaved edit')
    fireEvent.click(screen.getByRole('button', { name: zh['memory.saveEdit'] }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(zh['memory.mutationFailed']) })
    expect(fixture.editMemory).toHaveBeenCalledExactlyOnceWith({ id: entry.id, expectedVersion: 1, text: 'My unsaved edit' })
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['memory.editText']).value).toBe('My unsaved edit')
  })

  it('requires an explicit delete confirmation and does not authorize deleting an unseen later revision', async () => {
    const fixture = bench()
    render(<MemoryPanel {...fixture.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['memory.delete'] }))
    expect(fixture.deleteMemory).not.toHaveBeenCalled()
    fixture.replace([{ ...entry, version: 2, text: 'Changed after deletion was requested' }])
    fireEvent.click(screen.getByRole('button', { name: zh['memory.confirmDelete'] }))
    await waitFor(() => { expect(fixture.deleteMemory).toHaveBeenCalledExactlyOnceWith({ id: entry.id, expectedVersion: 1 }) })
  })

  it('shares only the selected entry revision after an explicit action, preserving visible source metadata', async () => {
    const fixture = bench([{ ...entry, source: { entryId: 'source' as MemoryId, scope: { kind: 'group', chatId: chat.id },
      version: 3, author: { kind: 'group', chatId: chat.id, sessionId: chat.rootSessionId }, createdAt: entry.createdAt, updatedAt: entry.updatedAt } }])
    render(<MemoryPanel {...fixture.props} />)
    expect(fixture.shareMemory).not.toHaveBeenCalled()
    expect(screen.getByText(t('memory.sharedSource', { scope: chat.name, name: chat.name, version: 3 }))).toBeTruthy()
    const card = screen.getByRole('article', { name: zh['memory.entry'] })
    fireEvent.click(within(card).getByText(zh['memory.share']))
    fireEvent.click(within(card).getByRole('button', { name: zh['memory.shareCopy'] }))
    await waitFor(() => { expect(fixture.shareMemory).toHaveBeenCalledExactlyOnceWith({ id: entry.id, expectedVersion: 1, target: { kind: 'team' } }) })
    expect(screen.getByText(zh['memory.shared'])).toBeTruthy()
    expect(fixture.shareMemory.mock.calls[0]?.[0]).not.toHaveProperty('text')
  })

  it('shows stream failure and preserves a failed new-entry draft for review before retrying', async () => {
    const fixture = bench([])
    fixture.saveMemory.mockRejectedValue(new Error('synthetic failed write'))
    render(<MemoryPanel {...fixture.props} />)
    act(() => { fixture.watchers[0]?.failed() })
    expect(screen.getByRole('alert').textContent).toBe(zh['memory.loadFailed'])
    fireEvent.change(screen.getByLabelText(zh['memory.new']), { target: { value: 'Unconfirmed draft' } })
    fireEvent.click(screen.getByRole('button', { name: zh['memory.add'] }))
    await waitFor(() => { expect(screen.getByText(zh['memory.mutationFailed'])).toBeTruthy() })
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['memory.new']).value).toBe('Unconfirmed draft')
    expect(screen.queryByText(zh['memory.saved'])).toBeNull()
  })
})
