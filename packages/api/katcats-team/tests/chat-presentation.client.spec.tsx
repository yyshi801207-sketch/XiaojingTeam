// @vitest-environment jsdom
/** Transcript preferences save independently after confirmation without consuming other edits. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    const { memberRole, ...settings } = request
    source.set({ phase: 'ready', snapshot: { ...current, revision: current.revision + 1,
      chats: current.chats.map(item => item.id !== request.id ? item : { ...item, ...settings,
        ...(memberRole === undefined ? {} : {
          memberRoles: [...item.memberRoles.filter(role => role.botId !== memberRole.botId), memberRole],
        }),
      }) } })
  }
  return { source, directory, connection, batch, tab, injected, commit }
}

function settingsSection(title: string) {
  const summary = screen.getByText(title, { selector: 'summary > span' }).closest('summary')
  const details = summary?.parentElement
  if (summary === null || !(details instanceof HTMLDetailsElement)) throw new Error(`Missing settings section: ${title}`)
  return { details, summary }
}

function displaySwitch() {
  const { details, summary } = settingsSection(zh['chat.settingsCollaboration'])
  if (!details.open) fireEvent.click(summary)
  return screen.getByRole<HTMLButtonElement>('switch', { name: zh['chat.showHandoffRecords'] })
}

function editWriterDuty() {
  const summary = screen.getByLabelText(t('chat.viewMemberRole', { name: writer.name }))
  fireEvent.click(summary)
  const field = screen.getByRole('region', { name: t('chat.memberRole', { name: writer.name }) })
  fireEvent.click(within(field).getByRole('button', { name: zh['role.edit'] }))
  return within(field)
}

describe('group display settings', () => {
  it('opens only basic information initially and keeps role and collaboration drafts through folding', () => {
    const { injected } = fixture()
    const save = vi.fn(async (_request: UpdateChatRequest) => {})
    const { container } = render(<ChatSettings {...{ ...injected, save } as ChatSettingsProps} />)
    const basics = settingsSection(zh['chat.settingsBasics'])
    const roles = settingsSection(zh['chat.groupRoles'])
    const collaboration = settingsSection(zh['chat.settingsCollaboration'])
    expect([...container.querySelectorAll('form > details[open]')]).toEqual([basics.details])
    expect(roles.details.open).toBe(false)
    expect(collaboration.details.open).toBe(false)

    fireEvent.click(roles.summary)
    const duty = editWriterDuty()
    fireEvent.click(collaboration.summary)
    const role = duty.getByRole<HTMLTextAreaElement>('textbox', { name: t('chat.memberRole', { name: writer.name }) })
    const limit = screen.getByRole<HTMLInputElement>('spinbutton', { name: zh['chat.relayLimit'] })
    fireEvent.change(role, { target: { value: 'Review drafts before publication' } })
    fireEvent.change(limit, { target: { value: '24' } })
    fireEvent.click(roles.summary)
    fireEvent.click(collaboration.summary)
    expect(roles.details.open).toBe(false)
    expect(collaboration.details.open).toBe(false)
    expect(roles.details.contains(role)).toBe(true)
    expect(collaboration.details.contains(limit)).toBe(true)

    fireEvent.click(roles.summary)
    fireEvent.click(collaboration.summary)
    expect(screen.getByRole('textbox', { name: t('chat.memberRole', { name: writer.name }) })).toBe(role)
    expect(role.value).toBe('Review drafts before publication')
    expect(screen.getByRole('spinbutton', { name: zh['chat.relayLimit'] })).toBe(limit)
    expect(limit.value).toBe('24')
    expect(save).not.toHaveBeenCalled()
  })

  it('automatically saves only the display flag and changes the switch after the directory confirms it', async () => {
    const { source, injected, commit } = fixture()
    const pending = Promise.withResolvers<undefined>()
    const save = vi.fn(async (request: UpdateChatRequest) => { await pending.promise; commit(request) })
    const props = { ...injected, save } as ChatSettingsProps
    const view = render(<ChatSettings {...props} />)
    const toggle = displaySwitch()
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
    expect(displaySwitch().getAttribute('aria-checked')).toBe('false')
  })

  it('keeps the confirmed value on failure and retries without needing the form save button', async () => {
    const { injected, commit } = fixture()
    const pending = Promise.withResolvers<undefined>()
    const save = vi.fn<(request: UpdateChatRequest) => Promise<void>>()
      .mockImplementationOnce(() => pending.promise).mockImplementationOnce(async (request) => { commit(request) })
    render(<ChatSettings {...{ ...injected, save } as ChatSettingsProps} />)
    const toggle = displaySwitch()
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
    const toggle = displaySwitch()
    fireEvent.click(settingsSection(zh['chat.groupRoles']).summary)
    const duty = editWriterDuty()
    const limit = screen.getByLabelText<HTMLInputElement>(zh['chat.relayLimit'])
    const role = duty.getByRole<HTMLTextAreaElement>('textbox', { name: t('chat.memberRole', { name: writer.name }) })
    fireEvent.change(name, { target: { value: 'Draft name' } })
    fireEvent.change(limit, { target: { value: '24' } })
    fireEvent.change(role, { target: { value: 'Draft group responsibility' } })
    fireEvent.click(toggle)
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
    expect(save.mock.calls[1]?.[0]).toEqual({ id: chat.id, name: 'Draft name', relayLimit: 24 })
    expect(role.value).toBe('Draft group responsibility')
    await act(async () => { fireEvent.click(duty.getByRole('button', { name: zh['role.save'] })) })
    expect(save.mock.calls[2]?.[0]).toEqual({ id: chat.id,
      memberRole: { botId: writer.id, role: 'Draft group responsibility' } })
    expect(duty.getByText('Draft group responsibility')).toBeTruthy()
    expect(duty.queryByRole('textbox')).toBeNull()
  })

  it('admits at most one display or manual save during a synchronous burst', async () => {
    const { injected, commit } = fixture()
    const pending = Promise.withResolvers<undefined>()
    const save = vi.fn(async (request: UpdateChatRequest) => { await pending.promise; commit(request) })
    const view = render(<ChatSettings {...{ ...injected, save } as ChatSettingsProps} />)
    fireEvent.change(screen.getByLabelText(zh['chat.name']), { target: { value: 'Unsaved name' } })
    const toggle = displaySwitch()
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
    const toggle = displaySwitch()
    act(() => {
      screen.getByRole<HTMLButtonElement>('button', { name: zh['bot.save'] }).click()
      toggle.click()
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
    const toggle = displaySwitch()
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
    fireEvent.click(displaySwitch())
    tab.visible = false
    view.rerender(<ChatSettings {...props} />)
    view.rerender(<ChatSettings {...props} sessionId={other.rootSessionId} />)
    await act(async () => { pending.resolve(undefined) })
    tab.visible = true
    view.rerender(<ChatSettings {...props} sessionId={other.rootSessionId} />)
    expect(screen.getByLabelText<HTMLInputElement>(zh['chat.name']).value).toBe('Other')
    expect(displaySwitch().getAttribute('aria-checked')).toBe('true')
    expect(source.getSnapshot().snapshot?.chats.find(item => item.id === other.id)?.showHandoffRecords).toBeUndefined()
    view.rerender(<ChatSettings {...props} />)
    expect(displaySwitch().getAttribute('aria-checked')).toBe('false')
    expect(save).toHaveBeenCalledExactlyOnceWith({ id: chat.id, showHandoffRecords: false })
  })
})
