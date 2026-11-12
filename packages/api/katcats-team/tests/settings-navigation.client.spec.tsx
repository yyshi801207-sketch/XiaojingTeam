// @vitest-environment jsdom
/** Settings shortcuts preserve the scoped conversation and unsaved form edits. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import type { SidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { BotId, GroupId, TeamBot } from '../src/types.ts'
import type { ChatId, TeamChat } from '../src/chats-types.ts'
import type { TeamView } from '../src/client/model.ts'
import type { ChatView } from '../src/client/chat-model.ts'
import { BotSettings, type BotSettingsProps } from '../src/client/BotSettings.tsx'
import { ChatSettings, type ChatSettingsProps } from '../src/client/ChatForms.tsx'
import type { FinanceSetupView } from '../src/client/FinanceLedgerSetup.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
const t = makeTranslate(zh)
const tabInfo: SidebarRightTabInfo = {
  sidebar: { expanded: true, fullscreen: false }, panel: { id: 'settings-pane' as SidebarRightTabInfo['panel']['id'] },
  tab: {
    id: 'settings-tab' as SidebarRightTabInfo['tab']['id'], kind: 'katcats-settings', contentId: 'settings', title: 'Settings',
    visible: true, navigation: { address: 'settings', params: undefined, revision: 1 }, signal: new AbortController().signal,
    actions: { bindCommands: () => () => {}, openResource: vi.fn(), openTab: vi.fn(), close: vi.fn() },
  },
}
const permissionDefaults = {
  useConnection: bindSnapshotSelector(createSnapshotStore<ConnectionState | undefined>(undefined)),
  useTabInfo: () => tabInfo,
}
const privatePermissionDefaults = {
  ...permissionDefaults,
  useFinanceSetup: bindSnapshotSelector(createSnapshotStore<FinanceSetupView>({ kind: 'disabled' })),
  setupDatabase: null,
}
const groupPermissionDefaults = {
  ...permissionDefaults,
  usePermissionBatch: bindSnapshotSelector(createSnapshotStore({ targetKey: '', targetLabel: '', targets: [],
    ready: false, currentValue: null, allowNoApproval: false, busy: false, results: [] })),
  activatePermissionBatch: () => {}, applyPermissionBatch: async () => {}, cancelPermissionBatch: () => {},
  renderFactorySlot: () => null,
}
const writer: TeamBot = {
  id: 'writer' as BotId, kind: 'ordinary', name: 'Writer', role: 'Draft',
  avatar: { shape: 'classic', color: '#FF2849' }, model: { kind: 'follow-global' },
  groupId: 'bots' as GroupId, sessionId: 'writer-private' as SessionId, workDir: '/synthetic/writer',
}
const chat: TeamChat = {
  id: 'editorial' as ChatId, name: 'Editorial', groupId: 'chats' as GroupId,
  rootSessionId: 'editorial-root' as SessionId, workDir: '/synthetic/editorial',
  memberIds: [writer.id], memberRoles: [], managerId: null,
  executors: [{ botId: writer.id, sessionId: 'editorial-writer-worker' as SessionId }],
  status: 'active', pauseReason: null, run: null, generation: 0, relayLimit: 6, error: null,
}
const directory = () => createSnapshotStore<TeamView>({ phase: 'ready', catalog: null, snapshot: {
  revision: 1, mainBotId: 'main' as BotId, bots: [writer], modelCapabilities: { override: false, followGlobal: false },
  groups: [{ id: 'bots' as GroupId, kind: 'bots', system: true, name: 'Bots' }],
} })
const chats = () => createSnapshotStore<ChatView>({ phase: 'ready', snapshot: {
  revision: 1, chats: [chat], activities: [], deliveries: [], relayLimit: 6,
} })

describe('settings task shortcuts', () => {
  it('opens the private Bot task list without submitting or clearing edited identity', () => {
    const openSchedules = vi.fn()
    const save = vi.fn(async () => {})
    const props = { ...privatePermissionDefaults, sessionId: writer.sessionId, useDirectory: bindSnapshotSelector(directory()),
      useProjection: () => undefined, renderFactorySlot: () => null, openMemory: vi.fn(), openSchedules, save, t } as BotSettingsProps
    render(<BotSettings {...props} />)
    fireEvent.change(screen.getByLabelText(zh['bot.name']), { target: { value: 'Unsaved Writer' } })
    fireEvent.click(screen.getByRole('button', { name: zh['team.automations'] }))
    expect(openSchedules).toHaveBeenCalledExactlyOnceWith(writer.sessionId)
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByLabelText<HTMLInputElement>(zh['bot.name']).value).toBe('Unsaved Writer')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['bot.save'] }).disabled).toBe(false)
  })

  it('opens the group list using its root instead of a member private or worker Session', () => {
    const openSchedules = vi.fn()
    const save = vi.fn(async () => {})
    const props = { ...groupPermissionDefaults, sessionId: chat.rootSessionId, useDirectory: bindSnapshotSelector(directory()),
      useChats: bindSnapshotSelector(chats()), openMemory: vi.fn(), openSchedules, save, t } as ChatSettingsProps
    render(<ChatSettings {...props} />)
    fireEvent.change(screen.getByLabelText(zh['chat.name']), { target: { value: 'Unsaved Editorial' } })
    fireEvent.click(screen.getByRole('button', { name: zh['team.automations'] }))
    expect(openSchedules).toHaveBeenCalledExactlyOnceWith(chat.rootSessionId)
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByLabelText<HTMLInputElement>(zh['chat.name']).value).toBe('Unsaved Editorial')
  })

  it('folds the group roster without changing member selection or discarding edited roles', () => {
    const save = vi.fn(async () => {})
    const props = { ...groupPermissionDefaults, sessionId: chat.rootSessionId, useDirectory: bindSnapshotSelector(directory()),
      useChats: bindSnapshotSelector(chats()), openMemory: vi.fn(), openSchedules: vi.fn(), save, t,
      useConnection: bindSnapshotSelector(createSnapshotStore<ConnectionState | undefined>('connected')),
    } as ChatSettingsProps
    render(<ChatSettings {...props} />)
    expect(within(screen.getByText(zh['chat.settingsBasics']).closest('section')!).getByLabelText(zh['chat.name'])).toBeTruthy()
    expect(within(screen.getByText(zh['chat.settingsCollaboration']).closest('details')!).getByLabelText(zh['chat.relayLimit'])).toBeTruthy()
    expect(within(screen.getByText(zh['chat.settingsResources']).closest('details')!).getByLabelText(zh['chat.folder'])).toBeTruthy()
    const summary = screen.getByText(zh['chat.settingsPeople']).closest('summary')!
    const details = summary.closest('details')!
    expect(details.open).toBe(false)
    fireEvent.click(screen.getByText(zh['chat.groupRoles']).closest('summary')!)
    const roleSummary = screen.getByLabelText(t('chat.viewMemberRole', { name: writer.name }))
    expect(roleSummary.closest('details')!.open).toBe(false)
    fireEvent.click(roleSummary)
    const duty = within(screen.getByRole('region', { name: t('chat.memberRole', { name: writer.name }) }))
    fireEvent.click(duty.getByRole('button', { name: zh['role.edit'] }))
    fireEvent.change(duty.getByRole('textbox', { name: t('chat.memberRole', { name: writer.name }) }), {
      target: { value: 'My unsaved group role' },
    })
    fireEvent.click(roleSummary)
    expect(roleSummary.closest('details')!.open).toBe(false)
    expect(roleSummary.textContent).toContain(writer.role)
    expect(roleSummary.textContent).not.toContain('My unsaved group role')
    fireEvent.click(summary)
    expect(details.open).toBe(true)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: writer.name }).checked).toBe(true)
    fireEvent.click(summary)
    expect(details.open).toBe(false)
    fireEvent.click(roleSummary)
    expect(duty.getByRole<HTMLTextAreaElement>('textbox', { name: t('chat.memberRole', { name: writer.name }) }).value)
      .toBe('My unsaved group role')
    expect(save).not.toHaveBeenCalled()
  })
})
