// @vitest-environment jsdom
/** Group forms, acknowledged controls and directory mutation races with synthetic members. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import type { PermissionBatchSelectOwnerProps } from '@deepseek-ai/dsh-client-ui-permission-presets/client'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { BotId, GroupId, TeamBot } from '../src/types.ts'
import type { ChatId, ChatRunId, ChatSnapshot, TeamChat, UpdateChatRequest } from '../src/chats-types.ts'
import { ChatClientModel, type ChatRemote, type ChatView } from '../src/client/chat-model.ts'
import { TeamRequestSupersededError, type TeamView } from '../src/client/model.ts'
import { CreateChat, ChatSettings, type ChatSettingsProps } from '../src/client/ChatForms.tsx'
import { ChatControls, type ChatControlsProps } from '../src/client/ChatControls.tsx'
import { TeamSidebar, type TeamSidebarProps } from '../src/client/TeamSidebar.tsx'
import { createSidebarViewStore } from '../src/client/sidebar-view.ts'
import { en, zh } from '../src/client/locales.ts'
import type { GroupPermissionBatchView } from '../src/client/group-permission-batch.ts'

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: false }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const t = makeTranslate(zh)
const useSessionStatus = bindSnapshotSelector(createSnapshotStore<SessionStatusSnapshot>(new Map()))
const useGroupQuestions = bindSnapshotSelector(createSnapshotStore([]))
const main: TeamBot = { id: 'main' as BotId, kind: 'main', name: 'Katcats', role: 'Coordinate',
  avatar: { shape: 'classic', color: '#FF2849' }, model: { kind: 'follow-global' }, groupId: null,
  sessionId: 'main-private' as SessionId, workDir: '/synthetic/main' }
const writer: TeamBot = { ...main, id: 'writer' as BotId, kind: 'ordinary', name: 'Writer', groupId: 'bots' as GroupId,
  sessionId: 'writer-private' as SessionId, workDir: '/synthetic/writer' }
const reviewer: TeamBot = { ...writer, id: 'reviewer' as BotId, name: 'Reviewer', sessionId: 'reviewer-private' as SessionId }
const chat: TeamChat = { id: 'editorial' as ChatId, name: 'Editorial', groupId: 'chats' as GroupId,
  rootSessionId: 'editorial-root' as SessionId, workDir: '/synthetic/chat/editorial', managerId: null, memberRoles: [], memberIds: [main.id, writer.id],
  executors: [{ botId: writer.id, sessionId: 'editorial-writer-worker' as SessionId }],
  status: 'active', pauseReason: null, run: { id: 'run-1' as ChatRunId, generation: 1, relayCount: 0 },
  generation: 1, relayLimit: 6, error: null }
const snapshot: ChatSnapshot = { revision: 1, chats: [chat], deliveries: [], relayLimit: 6, activities: [{ chatId: chat.id, processing: false, runningBotIds: [], pendingControl: null }] }
const directory = () => createSnapshotStore<TeamView>({ phase: 'ready', catalog: null,
  snapshot: { revision: 1, mainBotId: main.id, modelCapabilities: { override: true, followGlobal: false }, bots: [main, writer, reviewer],
    groups: [{ id: 'bots' as GroupId, kind: 'bots', system: true, name: 'Bots' }, { id: 'chats' as GroupId, kind: 'chats', system: true, name: 'Chats' }] } })
const groups = () => createSnapshotStore<ChatView>({ phase: 'ready', snapshot })
const permissionDefaults = {
  usePermissionBatch: bindSnapshotSelector(createSnapshotStore({ targetKey: '', targetLabel: '', targets: [],
    ready: false, currentValue: null, allowNoApproval: false, busy: false, results: [] })),
  activatePermissionBatch: () => {}, applyPermissionBatch: async () => {}, cancelPermissionBatch: () => {},
  useConnection: bindSnapshotSelector(createSnapshotStore<ConnectionState | undefined>('connected')),
  useTabInfo: () => ({ tab: { visible: true } }),
  retainPermissionSession: () => { throw new Error('This form fixture does not open member scopes') },
  SessionProvider: () => null,
  renderSlot: () => null,
  renderFactorySlot: () => null,
}

describe('explicit group forms', () => {
  it('opens saved records without submitting unsaved settings and follows group updates', () => {
    const source = groups()
    const save = vi.fn()
    const props = { ...permissionDefaults, sessionId: chat.rootSessionId, useDirectory: bindSnapshotSelector(directory()),
      useChats: bindSnapshotSelector(source), save, t } as ChatSettingsProps
    render(<ChatSettings {...props} />)
    fireEvent.change(screen.getByLabelText(zh['chat.name']), { target: { value: 'Unsaved name' } })
    fireEvent.click(screen.getByRole('button', { name: '任务档案' }))
    expect(screen.getByRole('heading', { name: /^Editorial\s*\/ 任务档案$/ })).toBeTruthy()
    act(() => { source.set({ phase: 'ready', snapshot: { ...snapshot, revision: 2,
      chats: [{ ...chat, name: 'Saved name' }] } }) })
    expect(screen.getByRole('heading', { name: /^Saved name\s*\/ 任务档案$/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭任务档案' }))
    expect(screen.getByLabelText<HTMLInputElement>(zh['chat.name']).value).toBe('Unsaved name')
    expect(save).not.toHaveBeenCalled()
  })
  it('withdraws a batch confirmation scope for unsaved form edits and reopens it only after a successful save', async () => {
    const saved = { ...chat, memberIds: [writer.id] }
    const source = groups()
    source.set({ phase: 'ready', snapshot: { ...snapshot, chats: [saved] } })
    const batch = createSnapshotStore<GroupPermissionBatchView>({ targetKey: 'saved-workers', targetLabel: saved.name,
      targets: [{ chatId: saved.id, botId: writer.id, sessionId: saved.executors[0]!.sessionId, name: writer.name }],
      ready: true, currentValue: 'workspace-write', allowNoApproval: true, busy: false, results: [] })
    const activate = vi.fn<(signal: AbortSignal) => void>()
    const pending = Promise.withResolvers<undefined>()
    const save = vi.fn(() => pending.promise)
    const props = { ...permissionDefaults, sessionId: saved.rootSessionId, useDirectory: bindSnapshotSelector(directory()),
      useChats: bindSnapshotSelector(source), usePermissionBatch: bindSnapshotSelector(batch), activatePermissionBatch: activate,
      renderFactorySlot: (_name: string, owner: PermissionBatchSelectOwnerProps) => <button type="button" disabled={owner.locked}>
        Synthetic batch permission
      </button>, save, t } as ChatSettingsProps
    render(<ChatSettings {...props} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Synthetic batch permission' }).disabled).toBe(false)
    expect(activate).toHaveBeenCalledOnce()
    fireEvent.change(screen.getByLabelText(zh['chat.name']), { target: { value: 'Unsaved title' } })
    expect(activate.mock.calls[0]![0].aborted).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Synthetic batch permission' }).disabled).toBe(true)
    expect(screen.getByText(zh['permissions.batchSaveFirst'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['bot.save'] }))
    expect(activate).toHaveBeenCalledOnce()
    await act(async () => { pending.resolve(undefined) })
    expect(activate).toHaveBeenCalledTimes(2)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Synthetic batch permission' }).disabled).toBe(false)
  })

  it.each(['disconnected', 'hidden', 'loading-team', 'loading-groups'] as const)('does not acquire permission scopes while %s', async (reason) => {
    const source = directory()
    const chats = groups()
    const connection = createSnapshotStore<ConnectionState | undefined>('connected')
    const visibility = createSnapshotStore(true)
    const useVisible = bindSnapshotSelector(visibility)
    if (reason === 'disconnected') connection.set('disconnected')
    if (reason === 'hidden') visibility.set(false)
    if (reason === 'loading-team') source.set({ ...source.getSnapshot(), phase: 'loading' })
    if (reason === 'loading-groups') chats.set({ ...chats.getSnapshot(), phase: 'loading' })
    const retainPermissionSession = vi.fn(permissionDefaults.retainPermissionSession)
    const renderSlot = vi.fn(() => null)
    const props = { ...permissionDefaults, sessionId: chat.rootSessionId, useDirectory: bindSnapshotSelector(source),
      useChats: bindSnapshotSelector(chats), useConnection: bindSnapshotSelector(connection),
      useTabInfo: () => ({ tab: { visible: useVisible(value => value) } }), retainPermissionSession, renderSlot,
      save: vi.fn(), t } as ChatSettingsProps
    render(<ChatSettings {...permissionDefaults} {...props} />)
    expect(retainPermissionSession).not.toHaveBeenCalled()
    expect(renderSlot).not.toHaveBeenCalled()
    await act(async () => {
      connection.set('connected')
      visibility.set(true)
      source.set({ ...source.getSnapshot(), phase: 'ready' })
      chats.set({ ...chats.getSnapshot(), phase: 'ready' })
    })
    expect(retainPermissionSession).toHaveBeenCalledExactlyOnceWith({ chatId: chat.id, botId: writer.id,
      sessionId: chat.executors[0]!.sessionId }, expect.any(AbortSignal))
    expect(renderSlot).not.toHaveBeenCalled()
  })

  it('starts with no members or manager, omits the main Bot, and creates only on submit', async () => {
    const create = vi.fn(async () => {})
    const close = vi.fn()
    render(<CreateChat bots={[main, writer]} defaultRelayLimit={6} create={create} close={close} t={t} />)
    expect(screen.queryByRole('checkbox', { name: t('chat.mainMember', { name: main.name }) })).toBeNull()
    expect(screen.getByLabelText(zh['chat.manager']).textContent).toContain(zh['chat.noManager'])
    fireEvent.change(screen.getByLabelText(zh['chat.name']), { target: { value: '  Editorial  ' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['team.create'] }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: writer.name }))
    expect(create).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh['team.create'] }))
    await waitFor(() => { expect(create).toHaveBeenCalledExactlyOnceWith({ name: 'Editorial', memberIds: [writer.id], managerId: null, relayLimit: 6 }) })
    expect(close).not.toHaveBeenCalled()
  })

  it('offers only selected ordinary members as manager and clears a removed manager', async () => {
    const create = vi.fn(async () => {})
    render(<CreateChat bots={[main, writer, reviewer]} defaultRelayLimit={6} create={create} close={vi.fn()} t={t} />)
    fireEvent.change(screen.getByLabelText(zh['chat.name']), { target: { value: 'Editorial' } })
    fireEvent.click(screen.getByRole('checkbox', { name: writer.name }))
    fireEvent.click(screen.getByLabelText(zh['chat.manager']))
    expect(screen.queryByRole('menuitem', { name: reviewer.name })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: main.name })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: writer.name }))
    fireEvent.click(screen.getByRole('checkbox', { name: reviewer.name }))
    fireEvent.click(screen.getByRole('checkbox', { name: writer.name }))
    expect(screen.getByLabelText(zh['chat.manager']).textContent).toContain(zh['chat.noManager'])
    fireEvent.click(screen.getByRole('button', { name: zh['team.create'] }))
    await waitFor(() => { expect(create).toHaveBeenCalledExactlyOnceWith({ name: 'Editorial', memberIds: [reviewer.id], managerId: null, relayLimit: 6 }) })
  })

  it('allows removing a legacy main member without offering it for a new membership', async () => {
    const source = groups()
    source.set({ phase: 'ready', snapshot: { ...snapshot, chats: [{ ...chat, managerId: main.id }] } })
    const save = vi.fn(async () => {})
    const props = { sessionId: chat.rootSessionId, useDirectory: bindSnapshotSelector(directory()), useChats: bindSnapshotSelector(source), save, t } as ChatSettingsProps
    render(<ChatSettings {...permissionDefaults} {...props} />)
    fireEvent.click(screen.getByText(`${zh['chat.members']} · 2`))
    const members = screen.getByRole('group', { name: zh['chat.members'] })
    expect(members.querySelector('img[data-xiaojing-main-avatar]')?.getAttribute('width')).toBe('24')
    expect(members.querySelector('[data-katcats-manager-avatar="main"]')).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: t('chat.mainMember', { name: main.name }) }))
    expect(screen.queryByRole('checkbox', { name: t('chat.mainMember', { name: main.name }) })).toBeNull()
    expect(screen.getByLabelText(zh['chat.manager']).textContent).toContain(zh['chat.noManager'])
    fireEvent.click(screen.getByRole('button', { name: zh['bot.save'] }))
    await waitFor(() => { expect(save).toHaveBeenCalledExactlyOnceWith({ id: chat.id, memberIds: [writer.id], managerId: null }) })
  })

  it('merges explicit group-role edits with the latest untouched roles and leaves private instructions unchanged', async () => {
    const source = groups()
    const initial = { ...chat, memberIds: [writer.id, reviewer.id], memberRoles: [{ botId: writer.id, role: 'Draft' }] }
    source.set({ phase: 'ready', snapshot: { ...snapshot, chats: [initial] } })
    const save = vi.fn(async () => {})
    const props = { sessionId: chat.rootSessionId, useDirectory: bindSnapshotSelector(directory()), useChats: bindSnapshotSelector(source), save, t } as ChatSettingsProps
    render(<ChatSettings {...permissionDefaults} {...props} />)
    fireEvent.change(screen.getByLabelText(t('chat.memberRole', { name: writer.name })), { target: { value: 'My group draft' } })
    act(() => { source.set({ phase: 'ready', snapshot: { ...snapshot, revision: 2,
      chats: [{ ...initial, memberRoles: [{ botId: writer.id, role: 'Remote draft' }, { botId: reviewer.id, role: 'Latest review' }] }] } }) })
    expect(screen.getByLabelText<HTMLTextAreaElement>(t('chat.memberRole', { name: writer.name })).value).toBe('My group draft')
    expect(screen.getByLabelText<HTMLTextAreaElement>(t('chat.memberRole', { name: reviewer.name })).value).toBe('Latest review')
    fireEvent.click(screen.getByRole('button', { name: zh['bot.save'] }))
    await waitFor(() => { expect(save).toHaveBeenCalledExactlyOnceWith({ id: chat.id,
      memberRoles: [{ botId: writer.id, role: 'My group draft' }, { botId: reviewer.id, role: 'Latest review' }] }) })
    expect(writer.role).toBe('Coordinate')
  })

  it('cancels a filled form without creating a root or worker conversation', () => {
    const create = vi.fn(async () => {})
    const close = vi.fn()
    render(<CreateChat bots={[main, writer]} defaultRelayLimit={6} create={create} close={close} t={t} />)
    fireEvent.change(screen.getByLabelText(zh['chat.name']), { target: { value: 'Discard' } })
    fireEvent.click(screen.getByRole('checkbox', { name: writer.name }))
    fireEvent.click(screen.getByRole('button', { name: zh['team.cancel'] }))
    expect(close).toHaveBeenCalledOnce()
    expect(create).not.toHaveBeenCalled()
  })

  it('retains edited fields on failure while untouched member settings follow the directory', async () => {
    const source = groups()
    const save = vi.fn<(request: UpdateChatRequest) => Promise<void>>().mockRejectedValue(new Error('synthetic failure'))
    const props = { sessionId: chat.rootSessionId, useDirectory: bindSnapshotSelector(directory()), useChats: bindSnapshotSelector(source), save, t } as ChatSettingsProps
    render(<ChatSettings {...permissionDefaults} {...props} />)
    fireEvent.change(screen.getByLabelText(zh['chat.name']), { target: { value: 'My edited name' } })
    fireEvent.click(screen.getByText(`${zh['chat.members']} · 2`))
    act(() => { source.set({ phase: 'ready', snapshot: { ...snapshot, revision: 2,
      chats: [{ ...chat, memberIds: [...chat.memberIds, reviewer.id], relayLimit: 9 }] } }) })
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: reviewer.name }).checked).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>(zh['chat.relayLimit']).value).toBe('9')
    expect(screen.getByLabelText<HTMLInputElement>(zh['chat.folder']).readOnly).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: zh['bot.save'] }))
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['bot.save'] }).disabled).toBe(false) })
    expect(save).toHaveBeenCalledExactlyOnceWith({ id: chat.id, name: 'My edited name' })
    expect(screen.getByLabelText<HTMLInputElement>(zh['chat.name']).value).toBe('My edited name')
  })

  it('submits member and relay-limit edits without changing the root Session or folder', async () => {
    const save = vi.fn<(request: UpdateChatRequest) => Promise<void>>().mockResolvedValue(undefined)
    const props = { sessionId: chat.rootSessionId, useDirectory: bindSnapshotSelector(directory()), useChats: bindSnapshotSelector(groups()), save, t } as ChatSettingsProps
    render(<ChatSettings {...permissionDefaults} {...props} />)
    fireEvent.click(screen.getByText(`${zh['chat.members']} · 2`))
    fireEvent.click(screen.getByRole('checkbox', { name: reviewer.name }))
    fireEvent.change(screen.getByLabelText(zh['chat.relayLimit']), { target: { value: '8' } })
    fireEvent.click(screen.getByRole('button', { name: zh['bot.save'] }))
    await waitFor(() => { expect(save).toHaveBeenCalledExactlyOnceWith({ id: chat.id, memberIds: [main.id, writer.id, reviewer.id], relayLimit: 8 }) })
  })
})

describe('run-aware group controls', () => {
  it('marks the saved manager across group member, role and permission identities without treating unsaved selection as current', () => {
    const source = groups()
    source.set({ phase: 'ready', snapshot: { ...snapshot, chats: [{ ...chat, managerId: writer.id }] } })
    const props = { ...permissionDefaults, sessionId: chat.rootSessionId, useDirectory: bindSnapshotSelector(directory()),
      useChats: bindSnapshotSelector(source), save: vi.fn(), openMemory: vi.fn(), openSchedules: vi.fn(), t } as ChatSettingsProps
    const view = render(<ChatSettings {...props} />)
    expect(view.container.querySelectorAll('[data-katcats-manager-avatar="writer"]').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByText(`${zh['chat.members']} · 2`))
    expect(screen.getAllByRole('img', { name: zh['chat.managerBadge'] }).length).toBeGreaterThan(1)
    fireEvent.click(screen.getByRole('button', { name: zh['chat.manager'] }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh['chat.noManager'] }))
    expect(screen.getAllByRole('img', { name: zh['chat.managerBadge'] }).length).toBeGreaterThan(1)
    act(() => { source.set({ phase: 'ready', snapshot: { ...snapshot, revision: 2, chats: [{ ...chat, managerId: null }] } }) })
    expect(view.container.querySelector('[data-katcats-manager-avatar]')).toBeNull()
  })

  it('captures the current run and waits for the Host stream before changing displayed status', async () => {
    const source = groups()
    let finish!: () => void
    const control = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const props = { sessionId: chat.rootSessionId, useSessionStatus, useGroupQuestions, useChats: bindSnapshotSelector(source),
      useDirectory: bindSnapshotSelector(directory()), control, t } as ChatControlsProps
    render(<ChatControls {...props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['chat.pause'] }))
    expect(control).toHaveBeenCalledExactlyOnceWith('pause', { id: chat.id, expectedRunId: chat.run!.id, expectedGeneration: 1 })
    expect(screen.getByText(zh['chat.controlPending'])).toBeTruthy()
    expect(screen.queryByText(zh['chat.paused'])).toBeNull()
    await act(async () => { finish() })
    act(() => { source.set({ phase: 'ready', snapshot: { ...snapshot, chats: [{ ...chat, status: 'paused', pauseReason: 'owner' }] } }) })
    expect(screen.getByText(zh['chat.paused'])).toBeTruthy()
    expect(screen.getByText(zh['chat.pauseHint'])).toBeTruthy()
    expect(screen.getByRole('button', { name: zh['chat.resume'] })).toBeTruthy()
  })

  it('keeps rejected commands scoped to their group and presents only acknowledged errors', async () => {
    const source = groups()
    const control = vi.fn(async () => { throw new Error('stale synthetic run') })
    const props = { sessionId: chat.rootSessionId, useSessionStatus, useGroupQuestions, useChats: bindSnapshotSelector(source),
      useDirectory: bindSnapshotSelector(directory()), control, t } as ChatControlsProps
    render(<ChatControls {...props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['chat.stop'] }))
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['chat.stop'] }).disabled).toBe(false) })
    expect(screen.getByText(zh['chat.idle'])).toBeTruthy()
    act(() => { source.set({ phase: 'ready', snapshot: { ...snapshot, chats: [{ ...chat, error: { code: 'MEMBER_FAILED', message: 'Synthetic member failure' } }] } }) })
    expect(screen.getByRole('alert').textContent).toBe(zh['chat.errorGeneric'])
    expect(screen.getByText(zh['chat.errorDetails']).closest('details')?.open).toBe(false)
  })

  it.each([
    ['restart', 'interrupted', 'chat.pauseRestart', 'chat.pauseRestart'],
    ['relay-limit', null, 'chat.pauseLimit', null],
    ['unknown-result', 'KATCATS_CHAT_OUTCOME_UNKNOWN', 'chat.pauseUnknown', 'chat.pauseUnknown'],
    ['unknown-result', 'KATCATS_CHAT_DURABILITY_UNCONFIRMED', 'chat.pauseUnknown', 'chat.errorDurability'],
    ['member-failed', 'KATCATS_CHAT_NO_REPLY', 'chat.pauseMemberFailed', 'chat.errorNoReply'],
    ['blocker-followup-pending', 'KATCATS_CHAT_FOLLOWUP_INCOMPLETE', 'chat.errorFollowupIncomplete', 'chat.errorFollowupIncomplete'],
  ] as const)('localizes distinct pause and error guidance for %s / %s', (reason, code, key, errorKey) => {
    const source = groups()
    source.set({ phase: 'ready', snapshot: { ...snapshot, chats: [{ ...chat, status: 'paused', pauseReason: reason,
      error: code === null ? null : { code, message: 'Technical English explanation' } }] } })
    const props = { sessionId: chat.rootSessionId, useChats: bindSnapshotSelector(source), useDirectory: bindSnapshotSelector(directory()),
      useSessionStatus, useGroupQuestions, control: vi.fn(async () => {}), t } as ChatControlsProps
    const view = render(<ChatControls {...props} />)
    expect(screen.getAllByText(zh[key])).toHaveLength(1)
    expect(screen.queryByRole('alert')?.textContent).not.toBe('Technical English explanation')
    if (code !== null) {
      const details = screen.getByText(zh['chat.errorDetails']).closest('details')!
      expect(details.open).toBe(false)
      expect(details.textContent).toContain(code)
      expect(details.textContent).toContain('Technical English explanation')
      expect(screen.getByRole('alert').textContent).toBe(zh[errorKey])
      if (code === 'KATCATS_CHAT_OUTCOME_UNKNOWN') {
        expect({ status: screen.getByText(zh['chat.paused']).textContent,
          explanation: screen.getByRole('alert').textContent,
          explanations: screen.getAllByText(zh[key]).length,
          code: details.querySelector('code')?.textContent,
          diagnostic: details.querySelector('p')?.textContent,
          detailsOpen: details.open,
          actions: [...view.container.querySelectorAll('button')].map(button => button.textContent) }).toMatchInlineSnapshot(`
          {
            "actions": [
              "继续",
              "停止",
            ],
            "code": "KATCATS_CHAT_OUTCOME_UNKNOWN",
            "detailsOpen": false,
            "diagnostic": "Technical English explanation",
            "explanation": "成员可能已经执行了任务，但结果尚未确认。请先检查已保存的结果，避免重复派发",
            "explanations": 1,
            "status": "已暂停接话",
          }
        `)
      }
    }
  })

  it.each([['zh', zh], ['en', en]] as const)('explains incomplete review and retained drafts in %s', (_language, dictionary) => {
    const source = groups()
    source.set({ phase: 'ready', snapshot: { ...snapshot, chats: [{ ...chat, status: 'paused',
      pauseReason: 'member-failed', error: { code: 'KATCATS_CHAT_REVIEW_INCOMPLETE', message: 'Review evidence is missing.' } }] } })
    const props = { sessionId: chat.rootSessionId, useChats: bindSnapshotSelector(source), useDirectory: bindSnapshotSelector(directory()),
      useSessionStatus, useGroupQuestions, control: vi.fn(async () => {}), t: makeTranslate(dictionary) } as ChatControlsProps
    const view = render(<ChatControls {...props} />)
    expect(view.getByRole('alert').textContent).toBe(dictionary['chat.errorReviewIncomplete'])
  })

  it('shows each recorded member ending once with localized guidance while keeping its outcome unconfirmed', () => {
    const causes = [
      ['KATCATS_CHAT_MEMBER_ERROR', 'chat.errorMemberError',
        'The member execution failed before confirming completion. Inspect saved group results before retrying.'],
      ['KATCATS_CHAT_MEMBER_MALFORMED_RESPONSE', 'chat.errorMemberMalformedResponse',
        'The model response format was invalid. The member result is unconfirmed; inspect saved group results before retrying.'],
      ['KATCATS_CHAT_MEMBER_MAX_TOKENS', 'chat.errorMemberMaxTokens',
        'The member reached its output limit before confirming completion. Inspect saved group results before retrying.'],
      ['KATCATS_CHAT_MEMBER_ABORTED', 'chat.errorMemberAborted',
        'The member execution was cancelled before confirming completion. Inspect saved group results before retrying.'],
      ['KATCATS_CHAT_MEMBER_BLOCKED', 'chat.errorMemberBlocked',
        'The member could not enter its next step. Its work is unconfirmed; inspect saved group results before retrying.'],
    ] as const
    const source = groups()
    const control = vi.fn(async () => {})
    const props = { sessionId: chat.rootSessionId, useChats: bindSnapshotSelector(source), useDirectory: bindSnapshotSelector(directory()),
      useSessionStatus, useGroupQuestions, control, t } as ChatControlsProps
    const view = render(<ChatControls {...props} />)
    const notices: { language: string; code: string; explanation: string | null }[] = []
    for (const [language, dictionary] of [['zh', zh], ['en', en]] as const) {
      view.rerender(<ChatControls {...props} t={makeTranslate(dictionary)} />)
      for (const [code, key, diagnostic] of causes) {
        act(() => { source.set({ phase: 'ready', snapshot: { ...snapshot, chats: [{ ...chat, status: 'paused',
          pauseReason: 'unknown-result', error: { code, message: diagnostic } }] } }) })
        expect(screen.getByText(dictionary['chat.paused'])).toBeTruthy()
        expect(screen.getAllByRole('alert')).toHaveLength(1)
        expect(screen.getAllByText(dictionary[key])).toHaveLength(1)
        expect(screen.queryByText(dictionary['chat.pauseUnknown'])).toBeNull()
        const details = screen.getByText(dictionary['chat.errorDetails']).closest('details')!
        expect(details.open).toBe(false)
        expect(details.querySelector('code')?.textContent).toBe(code)
        expect(details.querySelector('p')?.textContent).toBe(diagnostic)
        expect(screen.getByRole('button', { name: dictionary[code === 'KATCATS_CHAT_MEMBER_MALFORMED_RESPONSE'
          ? 'chat.endFailedRun' : 'chat.resume'] })).toBeTruthy()
        notices.push({ language, code, explanation: screen.getByRole('alert').textContent })
      }
    }
    expect(control).not.toHaveBeenCalled()
    expect(notices).toMatchInlineSnapshot(`
      [
        {
          "code": "KATCATS_CHAT_MEMBER_ERROR",
          "explanation": "成员执行出错，结果尚未确认。已保存内容保留，请先检查再安排后续任务",
          "language": "zh",
        },
        {
          "code": "KATCATS_CHAT_MEMBER_MALFORMED_RESPONSE",
          "explanation": "模型响应格式异常，本轮已暂停。结束失败轮次后，发送新指令即可继续；聊天记录与已保存结果保留",
          "language": "zh",
        },
        {
          "code": "KATCATS_CHAT_MEMBER_MAX_TOKENS",
          "explanation": "成员输出达到长度上限，尚未确认完成。已保存内容保留，请先检查再安排补充或拆分任务",
          "language": "zh",
        },
        {
          "code": "KATCATS_CHAT_MEMBER_ABORTED",
          "explanation": "成员执行已被取消，结果尚未确认。已保存内容保留，请先检查再决定后续安排",
          "language": "zh",
        },
        {
          "code": "KATCATS_CHAT_MEMBER_BLOCKED",
          "explanation": "成员未能进入下一执行步骤，结果尚未确认。已保存内容保留，请先检查限制和现有结果再调整安排",
          "language": "zh",
        },
        {
          "code": "KATCATS_CHAT_MEMBER_ERROR",
          "explanation": "The member failed; its result is unconfirmed. Saved content is retained. Check it before assigning more work.",
          "language": "en",
        },
        {
          "code": "KATCATS_CHAT_MEMBER_MALFORMED_RESPONSE",
          "explanation": "The model response was invalid. End the failed run, then send a new instruction to continue; chat history and saved results are retained.",
          "language": "en",
        },
        {
          "code": "KATCATS_CHAT_MEMBER_MAX_TOKENS",
          "explanation": "The member reached its output limit without confirming completion. Saved content is retained. Check it before splitting or extending the task.",
          "language": "en",
        },
        {
          "code": "KATCATS_CHAT_MEMBER_ABORTED",
          "explanation": "The member was cancelled; its result is unconfirmed. Saved content is retained. Check it before deciding what to assign next.",
          "language": "en",
        },
        {
          "code": "KATCATS_CHAT_MEMBER_BLOCKED",
          "explanation": "The member could not enter its next step; its result is unconfirmed. Saved content is retained. Check the restriction and existing results before adjusting the task.",
          "language": "en",
        },
      ]
    `)
  })

  it('distinguishes a paused policy from a member still working and accepts same-revision activity frames', () => {
    const source = groups()
    const props = { sessionId: chat.rootSessionId, useChats: bindSnapshotSelector(source), useDirectory: bindSnapshotSelector(directory()),
      useSessionStatus, useGroupQuestions, control: vi.fn(async () => {}), t } as ChatControlsProps
    render(<ChatControls {...props} />)
    expect(screen.getByText(zh['chat.idle'])).toBeTruthy()
    act(() => { source.set({ phase: 'ready', snapshot: { ...snapshot, chats: [{ ...chat, status: 'paused' }],
      activities: [{ chatId: chat.id, processing: false, runningBotIds: [writer.id], pendingControl: null }] } }) })
    expect(screen.getByText(zh['chat.paused'])).toBeTruthy()
    expect(screen.getByText(writer.name)).toBeTruthy()
    expect(screen.getByText(zh['chat.phaseWorking'])).toBeTruthy()
    expect(screen.queryByText(zh['chat.idle'])).toBeNull()
    act(() => { source.set({ phase: 'ready', snapshot: { ...snapshot,
      activities: [{ chatId: chat.id, processing: false, runningBotIds: [], pendingControl: 'stop' }] } }) })
    expect(screen.getByText(zh['chat.controlPending'])).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['chat.stop'] }).disabled).toBe(true)
  })

  it('keeps Stop available during a resumed member and does not let the older reply unlock a pending Stop', async () => {
    const source = groups()
    source.set({ phase: 'ready', snapshot: { ...snapshot, chats: [{ ...chat, status: 'paused' }] } })
    let finishResume!: () => void
    let finishStop!: () => void
    const control = vi.fn((action: 'pause' | 'resume' | 'stop') => new Promise<void>((resolve) => {
      if (action === 'resume') finishResume = resolve
      else finishStop = resolve
    }))
    const props = { sessionId: chat.rootSessionId, useSessionStatus, useGroupQuestions, useChats: bindSnapshotSelector(source),
      useDirectory: bindSnapshotSelector(directory()), control, t } as ChatControlsProps
    render(<ChatControls {...props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['chat.resume'] }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['chat.stop'] }).disabled).toBe(false)
    const nextRun = { id: 'resumed-run' as ChatRunId, generation: 2, relayCount: 0 }
    act(() => { source.set({ phase: 'ready', snapshot: { ...snapshot, chats: [{ ...chat, generation: 2, run: nextRun }],
      activities: [{ chatId: chat.id, processing: true, runningBotIds: [writer.id], pendingControl: 'resume' }] } }) })
    expect(screen.getByText(zh['chat.controlPending'])).toBeTruthy()
    expect(screen.queryByText(zh['chat.idle'])).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh['chat.stop'] }))
    expect(control).toHaveBeenNthCalledWith(2, 'stop', { id: chat.id, expectedRunId: nextRun.id, expectedGeneration: 2 })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['chat.stop'] }).disabled).toBe(true)
    await act(async () => { finishResume() })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['chat.stop'] }).disabled).toBe(true)
    await act(async () => { finishStop() })
    act(() => { source.set({ phase: 'ready', snapshot: { ...snapshot, chats: [{ ...chat, status: 'stopped', run: null, generation: 3 }] } }) })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['chat.newRun'] }).disabled).toBe(false)
  })

  it('allows another window to stop a resumed run while a pending Stop disables all repeated controls', () => {
    const source = groups()
    source.set({ phase: 'ready', snapshot: { ...snapshot,
      activities: [{ chatId: chat.id, processing: true, runningBotIds: [writer.id], pendingControl: 'resume' }] } })
    const props = { sessionId: chat.rootSessionId, useChats: bindSnapshotSelector(source), useDirectory: bindSnapshotSelector(directory()),
      useSessionStatus, useGroupQuestions, control: vi.fn(async () => {}), t } as ChatControlsProps
    render(<ChatControls {...props} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['chat.pause'] }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['chat.stop'] }).disabled).toBe(false)
    act(() => { source.set({ phase: 'ready', snapshot: { ...snapshot,
      activities: [{ chatId: chat.id, processing: true, runningBotIds: [writer.id], pendingControl: 'stop' }] } }) })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['chat.pause'] }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['chat.stop'] }).disabled).toBe(true)
  })

  it('separates explicit group roots from private Bots and internal execution Sessions', () => {
    const actions = { openBot: vi.fn(), openChat: vi.fn(), createBot: vi.fn(), createChat: vi.fn(), createGroup: vi.fn(), renameGroup: vi.fn(),
      removeGroup: vi.fn(), moveGroup: vi.fn(), retry: vi.fn(), moveBot: vi.fn() }
    const view = createSidebarViewStore().create()
    const props = { wide: true, expandSidebar: vi.fn(), useDirectory: bindSnapshotSelector(directory()), useChats: bindSnapshotSelector(groups()),
      useSessions: (selector: (value: { ids: string[] }) => unknown) => selector({ ids: [] }),
      useSidebarSessionStatus: bindSnapshotSelector(createSnapshotStore(new Map())),
      useSessionStatus,
      usePanelInfo: (selector: (value: { activePanelId: null }) => unknown) => selector({ activePanelId: null }),
      useStore: bindSnapshotSelector(view), actions: view.actions, commands: actions,
      useWorkspaces: bindSnapshotSelector(createSnapshotStore<WorkspaceSnapshot>({
        items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null })),
      entityActions: { pin: vi.fn(), move: vi.fn(), rename: vi.fn(), copyId: vi.fn(), remove: vi.fn() },
      useSidebarOverflow: bindSnapshotSelector(createSnapshotStore(false)),
      useSidebarReveal: bindSnapshotSelector(createSnapshotStore(null)), observeScrollList: vi.fn(), scrollDown: vi.fn(), t } as TeamSidebarProps
    render(<TeamSidebar {...props} />)
    expect(screen.getByRole('region', { name: zh['team.chats'] }).textContent).toContain(chat.name)
    expect(screen.getByRole('region', { name: zh['team.bots'] }).textContent).toContain(writer.name)
    expect(screen.queryByRole('button', { name: chat.executors[0]!.sessionId })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: chat.name }))
    expect(actions.openChat).toHaveBeenCalledExactlyOnceWith(chat.id)
    expect(actions.openBot).not.toHaveBeenCalled()
  })
})

describe('group directory mutation races', () => {
  const remote = (): ChatRemote => ({ sendMessage: vi.fn(), cancelSession: vi.fn(), snapshot: vi.fn(), follow: async function* () {}, createChat: vi.fn(), updateChat: vi.fn(), deleteChat: vi.fn(), pause: vi.fn(), resume: vi.fn(), stop: vi.fn() })

  it('does not replace a later group stream state with an older control acknowledgement', async () => {
    const api = remote()
    const model = new ChatClientModel(api)
    model.replace(snapshot)
    vi.mocked(api.pause).mockResolvedValueOnce({ ok: true, value: { chat: { ...chat, status: 'paused' }, snapshot: { ...snapshot, revision: 2 } } })
    model.replace({ ...snapshot, revision: 3, chats: [{ ...chat, status: 'stopped', generation: 2, run: null }] })
    await model.control('pause', { id: chat.id, expectedRunId: chat.run!.id, expectedGeneration: 1 })
    expect(model.state.getSnapshot().snapshot?.chats[0]?.status).toBe('stopped')
  })

  it('rejects a late successful create after the Host connection changes', async () => {
    const api = remote()
    let finish!: (value: Awaited<ReturnType<ChatRemote['createChat']>>) => void
    vi.mocked(api.createChat).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const model = new ChatClientModel(api)
    const request = model.create({ name: chat.name, memberIds: chat.memberIds })
    model.resetGeneration()
    finish({ ok: true, value: { chat, snapshot } })
    await expect(request).rejects.toBeInstanceOf(TeamRequestSupersededError)
    expect(model.state.getSnapshot().snapshot).toBeNull()
  })

  it('does not overwrite newer activity with a mutation reply from the same durable revision', async () => {
    const api = remote()
    const model = new ChatClientModel(api)
    model.replace(snapshot)
    vi.mocked(api.updateChat).mockResolvedValueOnce({ ok: true, value: { chat, snapshot } })
    const live = { ...snapshot, activities: [{ chatId: chat.id, processing: true, runningBotIds: [writer.id], pendingControl: null }] }
    model.replace(live)
    await model.update({ id: chat.id, name: chat.name })
    expect(model.state.getSnapshot().snapshot).toBe(live)
  })

  it('retains the current directory when a control is rejected', async () => {
    const api = remote()
    vi.mocked(api.stop).mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'Synthetic stale run', {}) })
    const model = new ChatClientModel(api)
    model.replace(snapshot)
    await expect(model.control('stop', { id: chat.id, expectedRunId: chat.run!.id, expectedGeneration: 1 })).rejects.toThrow('gateway/internal')
    expect(model.state.getSnapshot().snapshot).toBe(snapshot)
  })
})
