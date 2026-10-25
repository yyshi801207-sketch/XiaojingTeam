// @vitest-environment jsdom
/** Transcript preferences save independently after confirmation without consuming other edits. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { BotId, GroupId, TeamBot } from '../src/types.ts'
import type { ChatId, ChatSnapshot, TeamChat, UpdateChatRequest } from '../src/chats-types.ts'
import type { ChatView } from '../src/client/chat-model.ts'
import type { TeamView } from '../src/client/model.ts'
import type { GroupPermissionBatchView } from '../src/client/group-permission-batch.ts'
import { ChatSettings, type ChatSettingsProps } from '../src/client/ChatForms.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const writer: TeamBot = { id: 'writer' as BotId, kind: 'ordinary', name: 'Writer', role: 'Write articles.',
  avatar: { shape: 'classic', color: '#2288FF' }, model: { kind: 'follow-global' }, groupId: 'bots' as GroupId,
  sessionId: 'writer-private' as SessionId, workDir: '/synthetic/writer' }
const chat: TeamChat = { id: 'editorial' as ChatId, name: 'Editorial', groupId: 'chats' as GroupId,
  rootSessionId: 'editorial-root' as SessionId, workDir: '/synthetic/editorial', memberIds: [writer.id],
  managerId: null, memberRoles: [], executors: [{ botId: writer.id, sessionId: 'editorial-worker' as SessionId }],
  relayLimit: 16, generation: 0, status: 'active', pauseReason: null, run: null, error: null }
const snapshot: ChatSnapshot = { revision: 1, chats: [chat], deliveries: [], relayLimit: 16, activities: [] }
const t = makeTranslate(zh)
const emptyBatch: GroupPermissionBatchView = { targetKey: '', targetLabel: '', targets: [], ready: false,
  currentValue: null, allowNoApproval: false, busy: false, results: [] }

function fixture() {
  const source = createSnapshotStore<ChatView>({ phase: 'ready', snapshot })
  const directory = createSnapshotStore<TeamView>({ phase: 'ready', catalog: null, snapshot: {
    revision: 1, mainBotId: 'main' as BotId, bots: [writer], groups: [],
    modelCapabilities: { override: true, followGlobal: true },
  } })
  const connection = createSnapshotStore<ConnectionState | undefined>('connected')
  const batch = createSnapshotStore<GroupPermissionBatchView>(emptyBatch)
  const tab = { visible: true }
  const injected = {
    sessionId: chat.rootSessionId, useDirectory: bindSnapshotSelector(directory), useChats: bindSnapshotSelector(source),
    usePermissionBatch: bindSnapshotSelector(batch),
    activatePermissionBatch: () => {}, applyPermissionBatch: async () => {}, cancelPermissionBatch: () => {},
    useConnection: bindSnapshotSelector(connection),
    useTabInfo: () => ({ tab }),
    retainPermissionSession: () => { throw new Error('This form fixture does not open member scopes') },
    SessionProvider: () => null, renderSlot: () => null, renderFactorySlot: () => null, t,
  }
  const commit = (request: UpdateChatRequest) => {
    const current = source.getSnapshot().snapshot
    if (current === null) throw new Error('Synthetic directory missing')
    source.set({ phase: 'ready', snapshot: { ...current, revision: current.revision + 1,
      chats: current.chats.map(item => item.id === request.id ? { ...item, ...request } : item) } })
  }
  return { source, directory, connection, batch, tab, injected, commit }
}

describe('group display settings', () => {
  it('automatically saves only the display flag and changes the switch after the directory confirms it', async () => {
    const { source, injected, commit } = fixture()
    const pending = Promise.withResolvers<undefined>()
    const save = vi.fn(async (request: UpdateChatRequest) => { await pending.promise; commit(request) })
    const props = { ...injected, save } as ChatSettingsProps
    const view = render(<ChatSettings {...props} />)
    const toggle = screen.getByRole<HTMLButtonElement>('switch', { name: zh['chat.showHandoffRecords'] })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    expect(save).toHaveBeenCalledExactlyOnceWith({ id: chat.id, showHandoffRecords: false })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(toggle.disabled).toBe(true)
    expect(source.getSnapshot().snapshot?.chats[0]?.showHandoffRecords).toBeUndefined()
    await act(async () => { pending.resolve(undefined) })
    expect(toggle.disabled).toBe(false)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['bot.save'] }).disabled).toBe(true)
    view.unmount()
    render(<ChatSettings {...props} />)
    expect(screen.getByRole('switch', { name: zh['chat.showHandoffRecords'] }).getAttribute('aria-checked')).toBe('false')
  })

  it('keeps the confirmed value on failure and retries without needing the form save button', async () => {
    const { injected, commit } = fixture()
    const pending = Promise.withResolvers<undefined>()
    const save = vi.fn<(request: UpdateChatRequest) => Promise<void>>()
      .mockImplementationOnce(() => pending.promise).mockImplementationOnce(async (request) => { commit(request) })
    render(<ChatSettings {...{ ...injected, save } as ChatSettingsProps} />)
    const toggle = screen.getByRole<HTMLButtonElement>('switch', { name: zh['chat.showHandoffRecords'] })
    fireEvent.click(toggle)
    await act(async () => { pending.reject(new Error('Synthetic display save failed')) })
    expect(toggle.disabled).toBe(false)
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['bot.save'] }).disabled).toBe(true)
    fireEvent.click(toggle)
    await waitFor(() => { expect(toggle.getAttribute('aria-checked')).toBe('false') })
    expect(save.mock.calls).toEqual([[{ id: chat.id, showHandoffRecords: false }], [{ id: chat.id, showHandoffRecords: false }]])
  })

  it('preserves edited name, relay limit and roles without including them in the display request', async () => {
    const { injected, commit } = fixture()
    const save = vi.fn(async (request: UpdateChatRequest) => { commit(request) })
    render(<ChatSettings {...{ ...injected, save } as ChatSettingsProps} />)
    const name = screen.getByLabelText<HTMLInputElement>(zh['chat.name'])
    const limit = screen.getByLabelText<HTMLInputElement>(zh['chat.relayLimit'])
    const role = screen.getByLabelText<HTMLTextAreaElement>(t('chat.memberRole', { name: writer.name }))
    fireEvent.change(name, { target: { value: 'Draft name' } })
    fireEvent.change(limit, { target: { value: '24' } })
    fireEvent.change(role, { target: { value: 'Draft group responsibility' } })
    fireEvent.click(screen.getByRole('switch', { name: zh['chat.showHandoffRecords'] }))
    await waitFor(() => { expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false') })
    expect(save).toHaveBeenCalledExactlyOnceWith({ id: chat.id, showHandoffRecords: false })
    expect({ name: name.value, limit: limit.value, role: role.value,
      display: screen.getByRole('switch').getAttribute('aria-checked'),
      canSaveDraft: !screen.getByRole<HTMLButtonElement>('button', { name: zh['bot.save'] }).disabled,
    }).toMatchInlineSnapshot(`
      {
        "canSaveDraft": true,
        "display": "false",
        "limit": "24",
        "name": "Draft name",
        "role": "Draft group responsibility",
      }
    `)
    fireEvent.click(screen.getByRole('button', { name: zh['bot.save'] }))
    await waitFor(() => { expect(save).toHaveBeenCalledTimes(2) })
    expect(save.mock.calls[1]?.[0]).toEqual({ id: chat.id, name: 'Draft name', relayLimit: 24,
      memberRoles: [{ botId: writer.id, role: 'Draft group responsibility' }] })
  })

  it('admits at most one display or manual save during a synchronous burst', async () => {
    const { injected, commit } = fixture()
    const pending = Promise.withResolvers<undefined>()
    const save = vi.fn(async (request: UpdateChatRequest) => { await pending.promise; commit(request) })
    const view = render(<ChatSettings {...{ ...injected, save } as ChatSettingsProps} />)
    fireEvent.change(screen.getByLabelText(zh['chat.name']), { target: { value: 'Unsaved name' } })
    const toggle = screen.getByRole<HTMLButtonElement>('switch', { name: zh['chat.showHandoffRecords'] })
    const form = view.container.querySelector('form')
    if (form === null) throw new Error('Synthetic settings form missing')
    act(() => { toggle.click(); toggle.click(); fireEvent.submit(form) })
    expect(save).toHaveBeenCalledExactlyOnceWith({ id: chat.id, showHandoffRecords: false })
    await act(async () => { pending.resolve(undefined) })
    expect(screen.getByLabelText<HTMLInputElement>(zh['chat.name']).value).toBe('Unsaved name')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['bot.save'] }).disabled).toBe(false)
  })

  it('blocks the display request while a manual save owns the form', async () => {
    const { injected, commit } = fixture()
    const pending = Promise.withResolvers<undefined>()
    const save = vi.fn(async (request: UpdateChatRequest) => { await pending.promise; commit(request) })
    render(<ChatSettings {...{ ...injected, save } as ChatSettingsProps} />)
    fireEvent.change(screen.getByLabelText(zh['chat.name']), { target: { value: 'Saved name' } })
    act(() => {
      screen.getByRole<HTMLButtonElement>('button', { name: zh['bot.save'] }).click()
      screen.getByRole<HTMLButtonElement>('switch', { name: zh['chat.showHandoffRecords'] }).click()
    })
    expect(save).toHaveBeenCalledExactlyOnceWith({ id: chat.id, name: 'Saved name' })
    await act(async () => { pending.resolve(undefined) })
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  })

  it.each(['disconnected', 'loading', 'hidden', 'permission-batch'] as const)('refuses a new request when %s', async (state) => {
    const { source, connection, batch, tab, injected, commit } = fixture()
    const save = vi.fn(async (request: UpdateChatRequest) => { commit(request) })
    const props = { ...injected, save } as ChatSettingsProps
    const view = render(<ChatSettings {...props} />)
    act(() => {
      if (state === 'disconnected') connection.set('disconnected')
      else if (state === 'loading') source.set({ phase: 'loading', snapshot })
      else if (state === 'hidden') { tab.visible = false; view.rerender(<ChatSettings {...props} />) }
      else batch.set({ ...emptyBatch, busy: true })
    })
    const toggle = screen.getByRole<HTMLButtonElement>('switch', { name: zh['chat.showHandoffRecords'] })
    expect(toggle.disabled).toBe(true)
    fireEvent.click(toggle)
    expect(save).not.toHaveBeenCalled()
    act(() => {
      connection.set('connected'); source.set({ phase: 'ready', snapshot }); batch.set(emptyBatch)
      tab.visible = true; view.rerender(<ChatSettings {...props} />)
    })
    fireEvent.click(toggle)
    await waitFor(() => { expect(toggle.getAttribute('aria-checked')).toBe('false') })
    expect(save).toHaveBeenCalledExactlyOnceWith({ id: chat.id, showHandoffRecords: false })
  })

  it('does not apply a late confirmation to another group or lose the confirmed value after hiding', async () => {
    const { source, tab, injected, commit } = fixture()
    const other: TeamChat = { ...chat, id: 'other' as ChatId, name: 'Other', rootSessionId: 'other-root' as SessionId }
    source.set({ phase: 'ready', snapshot: { ...snapshot, chats: [chat, other] } })
    const pending = Promise.withResolvers<undefined>()
    const save = vi.fn(async (request: UpdateChatRequest) => { await pending.promise; commit(request) })
    const props = { ...injected, save } as ChatSettingsProps
    const view = render(<ChatSettings {...props} />)
    fireEvent.click(screen.getByRole('switch', { name: zh['chat.showHandoffRecords'] }))
    tab.visible = false
    view.rerender(<ChatSettings {...props} />)
    view.rerender(<ChatSettings {...props} sessionId={other.rootSessionId} />)
    await act(async () => { pending.resolve(undefined) })
    tab.visible = true
    view.rerender(<ChatSettings {...props} sessionId={other.rootSessionId} />)
    expect(screen.getByLabelText<HTMLInputElement>(zh['chat.name']).value).toBe('Other')
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
    expect(source.getSnapshot().snapshot?.chats.find(item => item.id === other.id)?.showHandoffRecords).toBeUndefined()
    view.rerender(<ChatSettings {...props} />)
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
    expect(save).toHaveBeenCalledExactlyOnceWith({ id: chat.id, showHandoffRecords: false })
  })
})
