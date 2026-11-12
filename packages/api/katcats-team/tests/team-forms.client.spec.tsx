// @vitest-environment jsdom
/** Observable quick-create and member-settings behavior with synthetic members. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import { createSidebarViewStore } from '../src/client/sidebar-view.ts'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ledgerSetupBotId, odooAccessBotId, type BotId, type GroupId, type TeamBot, type TeamSnapshot, type UpdateBotRequest } from '../src/types.ts'
import type { FinanceConnector, FinanceConnectorId } from '../src/finance-types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { CreateBot } from '../src/client/CreateBot.tsx'
import { BotSettings, type BotSettingsProps } from '../src/client/BotSettings.tsx'
import { BotHeaderAction, type BotHeaderActionProps } from '../src/client/BotHeaderAction.tsx'
import { BotModelControl, type BotModelControlProps, type BotSettingsRequest } from '../src/client/BotModelControl.tsx'
import { TeamSidebar, type TeamSidebarProps } from '../src/client/TeamSidebar.tsx'
import type { TeamView } from '../src/client/model.ts'
import type { ChatView } from '../src/client/chat-model.ts'
import { en, zh } from '../src/client/locales.ts'
import { financeZh } from '../src/client/finance-locales.ts'
import type { FinanceSetupView } from '../src/client/FinanceLedgerSetup.tsx'
import type { LedgerSetupDatabaseControls } from '../src/client/LedgerSetupDatabaseSettings.tsx'

afterEach(cleanup)
const t = makeTranslate(zh)
const gid = (value: string) => value as GroupId
const bot: TeamBot = {
  id: 'member' as BotId, kind: 'ordinary', name: 'Writer', role: '', avatar: { shape: 'classic', color: '#FF2849' },
  model: { kind: 'follow-global' }, groupId: gid('ordinary'), sessionId: 'writer-session' as SessionId, workDir: '/synthetic/writer',
}
const main: TeamBot = { ...bot, id: 'main' as BotId, kind: 'main', name: 'Katcats', groupId: null, sessionId: 'main-session' as SessionId }
const snapshot: TeamSnapshot = {
  revision: 1, mainBotId: main.id, bots: [main, bot], modelCapabilities: { override: false, followGlobal: false },
  groups: [{ id: gid('ordinary'), name: 'ordinary', kind: 'bots', system: true }, { id: gid('chats'), name: 'chats', kind: 'chats', system: true }],
}
const directory = () => createSnapshotStore<TeamView>({ phase: 'ready', snapshot, catalog: null })
const chatDirectory = () => createSnapshotStore<ChatView>({ phase: 'ready', snapshot: { revision: 0, chats: [], deliveries: [], relayLimit: 6, activities: [] } })
const permissionDefaults = {
  useConnection: bindSnapshotSelector(createSnapshotStore<ConnectionState | undefined>('connected')),
  useFinanceSetup: bindSnapshotSelector(createSnapshotStore<FinanceSetupView>({ kind: 'disabled' })),
  setupDatabase: null,
  useTabInfo: () => ({ tab: { visible: true } }),
  renderFactorySlot: () => null,
}

describe('quick member creation', () => {
  it('offers ten silhouettes, keeps shape and color independent, and submits a general member', async () => {
    const create = vi.fn(async () => {})
    render(<CreateBot groupId={gid('ordinary')} create={create} close={vi.fn()} t={t} />)
    expect(within(screen.getByRole('group', { name: zh['avatar.shape'] })).getAllByRole('button')).toHaveLength(10)
    fireEvent.change(screen.getByLabelText(zh['bot.name']), { target: { value: '  Editor  ' } })
    fireEvent.click(screen.getByRole('button', { name: zh['avatar.ponytail'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['color.blue'] }))
    expect(screen.getByRole('button', { name: zh['avatar.ponytail'] }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: zh['team.create'] }))
    await waitFor(() => { expect(create).toHaveBeenCalledExactlyOnceWith({ name: 'Editor', groupId: 'ordinary', avatar: { shape: 'ponytail', color: '#2288FF' } }) })
  })

  it('cancels a populated draft without a create request', () => {
    const create = vi.fn(async () => {})
    const close = vi.fn()
    render(<CreateBot groupId={gid('ordinary')} create={create} close={close} t={t} />)
    fireEvent.change(screen.getByLabelText(zh['bot.name']), { target: { value: 'Discard me' } })
    fireEvent.click(screen.getByRole('button', { name: zh['team.cancel'] }))
    expect(close).toHaveBeenCalledOnce()
    expect(create).not.toHaveBeenCalled()
  })

  it('uses the default red classic silhouette and prevents a blank name', async () => {
    const create = vi.fn(async () => {})
    render(<CreateBot groupId={undefined} create={create} close={vi.fn()} t={makeTranslate(en)} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en['team.create'] }).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(en['bot.name']), { target: { value: 'Helper' } })
    fireEvent.click(screen.getByRole('button', { name: en['team.create'] }))
    await waitFor(() => { expect(create).toHaveBeenCalledExactlyOnceWith({ name: 'Helper', avatar: { shape: 'classic', color: '#FF2849' } }) })
  })
})

describe('member settings', () => {
  it.each([{ locale: 'zh', copy: zh }, { locale: 'en', copy: en }])('shows detailed fixed-assistant duties as expandable read-only text in $locale', ({ copy }) => {
    const setupBot: TeamBot = { ...bot, id: ledgerSetupBotId, name: copy['team.ledgerAssistantNickname'], sessionId: 'setup-session' as SessionId }
    const accessBot: TeamBot = { ...bot, id: odooAccessBotId, name: copy['team.accessAssistantNickname'], sessionId: 'access-session' as SessionId }
    const source = directory()
    source.set({ ...source.getSnapshot(), snapshot: { ...snapshot, bots: [main, bot, setupBot, accessBot] } })
    const save = vi.fn(async () => {})
    const props = { ...permissionDefaults, sessionId: setupBot.sessionId, useDirectory: bindSnapshotSelector(source),
      useProjection: () => undefined, save, t: makeTranslate(copy),
    } as BotSettingsProps
    const computedStyle = window.getComputedStyle.bind(window)
    const style = vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
      const result = computedStyle(element)
      if (element.tagName === 'P') result.lineHeight = '20px'
      return result
    })
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.tagName === 'P' ? 400 : 0
    })
    try {
      const view = render(<BotSettings {...props} />)
      const duties: Record<string, string | null> = {}
      for (const member of [setupBot, accessBot]) {
        view.rerender(<BotSettings {...props} sessionId={member.sessionId} />)
        const field = screen.getByRole('region', { name: copy['bot.role'] })
        duties[member.name] = field.querySelector('p')!.textContent
        expect(within(field).queryByRole('button', { name: copy['role.edit'] })).toBeNull()
        expect(within(field).queryByRole('button', { name: copy['role.save'] })).toBeNull()
        expect(within(field).queryByRole('textbox')).toBeNull()
        const disclosure = within(field).getByRole('button', { name: copy['role.expand'] })
        const preview = field.querySelector<HTMLElement>('[data-expanded]')!
        expect(disclosure.getAttribute('aria-expanded')).toBe('false')
        expect(preview.style.maxBlockSize).toBe('8lh')
        fireEvent.click(disclosure)
        expect(disclosure.getAttribute('aria-expanded')).toBe('true')
        expect(preview.style.maxBlockSize).toBe('')
        fireEvent.click(within(field).getByRole('button', { name: copy['role.collapse'] }))
        expect(disclosure.getAttribute('aria-expanded')).toBe('false')
        expect(preview.style.maxBlockSize).toBe('8lh')
      }
      expect(duties).toMatchSnapshot()
      expect(save).not.toHaveBeenCalled()
      view.rerender(<BotSettings {...props} sessionId={bot.sessionId} />)
      fireEvent.click(screen.getByRole('button', { name: copy['role.edit'] }))
      expect(screen.getByRole('textbox', { name: copy['bot.role'] })).toBeTruthy()
    } finally {
      style.mockRestore()
      height.mockRestore()
    }
  })

  it('shares the verified Odoo connection between fixed assistants and reopens a blank credential field', async () => {
    const setupBot: TeamBot = { ...bot, id: ledgerSetupBotId, name: '建账助手', sessionId: 'setup-session' as SessionId }
    const accessBot: TeamBot = { ...bot, id: odooAccessBotId, name: '系统助手', sessionId: 'access-session' as SessionId }
    const source = directory()
    source.set({ ...source.getSnapshot(), snapshot: { ...snapshot, bots: [main, bot, setupBot, accessBot] } })
    const account = { login: 'odoo-admin@example.com' }
    const connection = { url: 'https://odoo.example.com', database: 'ledger', verifiedAt: '2026-11-11T01:00:00Z', account }
    const setup = createSnapshotStore<FinanceSetupView>({ kind: 'ready', revision: 1, snapshot: { connection: null, plans: [] } })
    const connect = vi.fn<LedgerSetupDatabaseControls['connect']>().mockResolvedValue({ ok: true, value: { connection, plans: [] } })
    const save = vi.fn(async () => {})
    const props = { ...permissionDefaults, sessionId: bot.sessionId, useDirectory: bindSnapshotSelector(source),
      useFinanceSetup: bindSnapshotSelector(setup), useProjection: () => undefined, save, t,
      setupDatabase: { t: makeTranslate(financeZh), connect, reload: vi.fn() },
    } as BotSettingsProps
    const view = render(<BotSettings {...props} />)
    expect(screen.queryByRole('region', { name: financeZh['setup.connection'] })).toBeNull()

    view.rerender(<BotSettings {...props} sessionId={setupBot.sessionId} />)
    const card = () => screen.getByRole('region', { name: financeZh['setup.connection'] })
    const fields = () => within(card())
    const button = () => fields().getByRole('button', { name: financeZh['setup.connect'] })
    const openEditor = () => fireEvent.click(fields().getByRole('button', { name: financeZh.edit }))
    const expandCard = () => {
      const summary = card().querySelector('summary')!
      expect(summary.parentElement).toHaveProperty('open', false)
      expect(within(summary).getByText('财务系统连接')).toBeTruthy()
      fireEvent.click(summary)
      expect(summary.parentElement).toHaveProperty('open', true)
    }
    expandCard()
    expect(button()).toHaveProperty('disabled', true)
    expect(fields().queryByText(financeZh['editor.companyStep'])).toBeNull()
    expect(screen.queryByLabelText(zh['bot.name'])).toBeNull()
    expect(screen.queryByRole('textbox', { name: zh['bot.role'] })).toBeNull()
    expect(screen.queryByLabelText(zh['bot.group'])).toBeNull()
    expect(screen.getByLabelText(zh['bot.model'])).toBeTruthy()
    fireEvent.change(fields().getByLabelText(financeZh['connection.address']), { target: { value: connection.url } })
    fireEvent.change(fields().getByLabelText(financeZh.database), { target: { value: connection.database } })
    fireEvent.change(fields().getByLabelText(financeZh['setup.adminKey']), { target: { value: 'setup-key' } })
    await act(async () => { fireEvent.click(button()) })
    expect(connect).toHaveBeenCalledExactlyOnceWith({ url: connection.url, database: connection.database, apiKey: 'setup-key' })
    expect(save).not.toHaveBeenCalled()
    expect(card().dataset.financeState).toBe('reachable')
    expect(fields().getByText(financeZh['setup.connected'])).toBeTruthy()
    expect(fields().getByText(connection.url)).toBeTruthy()
    expect(fields().getByText(connection.database)).toBeTruthy()
    const login = fields().getByText(financeZh['connection.login']).nextElementSibling
    expect(login?.querySelector('bdi')?.textContent).toBe(account.login)
    expect(login?.querySelector('small')?.textContent).toBe(financeZh['odoo.readWrite'])
    expect(fields().queryByText('已验证权限')).toBeNull()
    const verification = fields().getByText(financeZh.lastTest)
    expect(verification.parentElement).toBe(verification.parentElement?.parentElement?.lastElementChild)
    expect(verification.nextElementSibling?.querySelector('time')?.dateTime).toBe(connection.verifiedAt)
    expect(fields().queryByLabelText(financeZh['setup.adminKey'])).toBeNull()

    act(() => setup.set({ kind: 'ready', revision: 1, snapshot: { connection, plans: [] } }))
    view.rerender(<BotSettings {...props} sessionId={accessBot.sessionId} />)
    expect(screen.getByRole('heading', { name: accessBot.name })).toBeTruthy()
    expect(screen.getByText(zh['team.accessAssistantRole'])).toBeTruthy()
    expect(view.container.querySelector('img[data-xiaojing-assistant-avatar]')?.getAttribute('src')).toContain('odoo-yeye.png')
    expandCard()
    expect(fields().getByText(connection.database)).toBeTruthy()
    expect(fields().getByText(account.login)).toBeTruthy()
    expect(screen.queryByLabelText(zh['bot.group'])).toBeNull()
    openEditor()
    expect(fields().getByLabelText(financeZh['setup.adminKey'])).toHaveProperty('value', '')
    expect(fields().getByLabelText(financeZh['setup.adminKey'])).toHaveProperty('placeholder', financeZh['editor.keySaved'])
    expect(fields().getByText(financeZh['editor.keyExisting'])).toBeTruthy()
    await act(async () => { fireEvent.click(button()) })
    expect(connect).toHaveBeenLastCalledWith({ url: connection.url, database: connection.database })
    expect(fields().queryByLabelText(financeZh['setup.adminKey'])).toBeNull()

    openEditor()
    const changed = 'https://second.example.com'
    fireEvent.change(fields().getByLabelText(financeZh['connection.address']), { target: { value: changed } })
    fireEvent.change(fields().getByLabelText(financeZh.database), { target: { value: 'other' } })
    expect(fields().getByText(financeZh['setup.connectionChangedKey'])).toBeTruthy()
    expect(fields().getByLabelText(financeZh['setup.adminKey'])).not.toHaveProperty('placeholder', financeZh['editor.keySaved'])
    expect(button()).toHaveProperty('disabled', true)
    fireEvent.change(fields().getByLabelText(financeZh['setup.adminKey']), { target: { value: 'new-key' } })
    connect.mockResolvedValueOnce({ ok: false, key: 'error.authentication' })
    await act(async () => { fireEvent.click(button()) })
    expect(connect).toHaveBeenLastCalledWith({ url: changed, database: 'other', apiKey: 'new-key' })
    expect(fields().getByRole('alert').textContent).toBe(financeZh['error.authentication'])
    expect(fields().queryByText(financeZh['setup.connected'])).toBeNull()
    expect(fields().getByLabelText(financeZh['connection.address'])).toHaveProperty('value', changed)
    expect(fields().getByLabelText(financeZh.database)).toHaveProperty('value', 'other')
    fireEvent.click(fields().getByRole('button', { name: financeZh['editor.cancel'] }))
    expect(fields().getByText(connection.url)).toBeTruthy()
    expect(fields().queryByLabelText(financeZh['setup.adminKey'])).toBeNull()

    openEditor()
    fireEvent.change(fields().getByLabelText(financeZh['setup.adminKey']), { target: { value: 'draft-key' } })
    act(() => setup.set({ kind: 'ready', revision: 2, snapshot: { connection, plans: [] } }))
    expect(fields().queryByLabelText(financeZh['setup.adminKey'])).toBeNull()
    expandCard()
    openEditor()
    expect(fields().getByLabelText(financeZh['setup.adminKey'])).toHaveProperty('value', '')
  })

  it.each(['cashier', 'general-ledger'] as const)('edits a %s Bot’s role and keeps its private ledger controls separate from ordinary Bot settings', async (financePreset) => {
    const financeBot: TeamBot = { ...bot, id: 'finance' as BotId, name: 'Finance member', role: 'Verify ledger entries.',
      sessionId: 'finance-session' as SessionId, financePreset }
    const source = directory()
    source.set({ ...source.getSnapshot(), snapshot: { ...snapshot, bots: [main, { ...bot, role: 'Draft finance newsletters' }, financeBot] } })
    const connector: FinanceConnector = {
      id: 'verified-connector' as FinanceConnectorId, type: 'odoo', name: 'Odoo',
      url: 'https://odoo.example', database: 'fixture', company: { id: 1, name: '测试账套', currency: 'CNY' },
      lastTestAt: '2026-11-10T00:00:00Z', failure: null, capabilities: ['journals'],
    }
    const finance = {
      load: vi.fn(async () => ({ connectors: [connector], connectorId: null })),
      bind: vi.fn(async () => {}),
      connect: vi.fn(async () => connector),
    }
    const save = vi.fn(async () => {})
    const props = {
      sessionId: bot.sessionId, useDirectory: bindSnapshotSelector(source), useProjection: () => undefined, save, finance, t,
    } as BotSettingsProps
    const view = render(<BotSettings {...permissionDefaults} {...props} />)
    expect(screen.getByText('Draft finance newsletters')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: zh['bot.role'] })).toBeNull()
    expect(screen.queryByRole('region', { name: zh['chat.financeTitle'] })).toBeNull()
    expect(finance.load).not.toHaveBeenCalled()

    view.rerender(<BotSettings {...permissionDefaults} {...props} sessionId={financeBot.sessionId} />)
    expect(screen.getByText(zh['bot.financeBadge'])).toBeTruthy()
    expect(screen.getByText(financeBot.role)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['role.edit'] }))
    const role = screen.getByRole<HTMLTextAreaElement>('textbox', { name: zh['bot.role'] })
    expect(role.value).toBe(financeBot.role)
    const extended = role.value + '\nPrepare the monthly report.'
    fireEvent.change(role, { target: { value: extended } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['role.save'] })) })
    expect(save).toHaveBeenCalledExactlyOnceWith({ id: financeBot.id, role: extended })
    expect(finance.load).toHaveBeenCalledExactlyOnceWith(financeBot.id)
    const panel = within(await screen.findByRole('region', { name: zh['chat.financeTitle'] }))
    fireEvent.click(panel.getByText(zh['chat.financeTitle']))
    fireEvent.click(await panel.findByRole('button', { name: zh['chat.financeSelect'] }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Odoo · 测试账套' }))
    fireEvent.click(panel.getByRole('button', { name: zh['chat.financeSave'] }))
    expect(await panel.findByText(zh['chat.financeSaved'])).toBeTruthy()
    expect(finance.bind).toHaveBeenCalledExactlyOnceWith(financeBot.id, connector.id)
  })

  it('shows the fixed main portrait without ordinary appearance controls and saves only the edited identity', async () => {
    const source = directory()
    const save = vi.fn(async () => {})
    const props = { sessionId: main.sessionId, useDirectory: bindSnapshotSelector(source), useProjection: () => undefined,
      save, openMemory: vi.fn(), openSchedules: vi.fn(), t } as BotSettingsProps
    const view = render(<BotSettings {...permissionDefaults} {...props} />)
    const portrait = view.container.querySelector('img[data-xiaojing-main-avatar]')
    expect(portrait?.getAttribute('width')).toBe('60')
    expect(screen.queryByRole('group', { name: zh['avatar.shape'] })).toBeNull()
    expect(screen.queryByRole('group', { name: zh['avatar.color'] })).toBeNull()
    fireEvent.change(screen.getByLabelText(zh['bot.name']), { target: { value: 'Team Assistant' } })
    fireEvent.click(screen.getByRole('button', { name: zh['bot.save'] }))
    await waitFor(() => { expect(save).toHaveBeenCalledExactlyOnceWith({ id: main.id, name: 'Team Assistant' }) })
    expect(source.getSnapshot().snapshot?.bots[0]?.avatar).toBe(main.avatar)
  })

  it.each(['disconnected', 'hidden', 'loading'] as const)('withholds permission factories while %s and restores them only when ready', (reason) => {
    const source = directory()
    const connection = createSnapshotStore<ConnectionState | undefined>('connected')
    const visibility = createSnapshotStore(true)
    const useVisible = bindSnapshotSelector(visibility)
    if (reason === 'disconnected') connection.set('disconnected')
    if (reason === 'hidden') visibility.set(false)
    if (reason === 'loading') source.set({ ...source.getSnapshot(), phase: 'loading' })
    const renderFactorySlot = vi.fn(() => null)
    const props = { sessionId: bot.sessionId, useDirectory: bindSnapshotSelector(source), useProjection: () => undefined,
      useConnection: bindSnapshotSelector(connection), useTabInfo: () => ({ tab: { visible: useVisible(value => value) } }),
      renderFactorySlot, save: vi.fn(), t } as BotSettingsProps
    render(<BotSettings {...permissionDefaults} {...props} />)
    expect(renderFactorySlot).not.toHaveBeenCalled()
    expect(screen.getByText(zh['permissions.unavailable'])).toBeTruthy()
    act(() => {
      connection.set('connected')
      visibility.set(true)
      source.set({ ...source.getSnapshot(), phase: 'ready' })
    })
    expect(renderFactorySlot).toHaveBeenCalledWith('permission.select', { locked: false })
  })

  it('moves a member to a logical group without changing its private Session or files', async () => {
    const source = directory()
    source.set({ ...source.getSnapshot(), snapshot: { ...snapshot, groups: [...snapshot.groups,
      { id: gid('writers'), name: 'Content', kind: 'bots', system: false }] } })
    const save = vi.fn<(request: UpdateBotRequest) => Promise<void>>().mockResolvedValue(undefined)
    const props = { sessionId: bot.sessionId, useDirectory: bindSnapshotSelector(source), useProjection: () => undefined, save, t } as BotSettingsProps
    render(<BotSettings {...permissionDefaults} {...props} />)
    fireEvent.click(screen.getByLabelText(zh['bot.group']))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Content' }))
    fireEvent.click(screen.getByRole('button', { name: zh['bot.save'] }))
    await waitFor(() => { expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: bot.id, groupId: 'writers' })) })
    expect(save.mock.calls[0]?.[0]).not.toHaveProperty('workDir')
    expect(save.mock.calls[0]?.[0]).not.toHaveProperty('sessionId')
  })

  it('keeps unsupported model changes disabled and the working folder read-only', async () => {
    const save = vi.fn<(request: UpdateBotRequest) => Promise<void>>().mockResolvedValue(undefined)
    const props = { sessionId: bot.sessionId, useDirectory: bindSnapshotSelector(directory()), useProjection: () => undefined, save, t } as BotSettingsProps
    render(<BotSettings {...permissionDefaults} {...props} />)
    const modelControl = screen.getByLabelText<HTMLButtonElement>(zh['bot.model'])
    expect(modelControl.disabled).toBe(true)
    expect(document.getElementById(modelControl.getAttribute('aria-describedby') ?? '')?.textContent).toBe(zh['bot.modelUnavailable'])
    expect(screen.getByLabelText<HTMLInputElement>(zh['bot.folder']).readOnly).toBe(true)
    fireEvent.change(screen.getByLabelText(zh['bot.name']), { target: { value: 'Editor' } })
    fireEvent.click(screen.getByRole('button', { name: zh['bot.save'] }))
    await waitFor(() => { expect(save).toHaveBeenCalledExactlyOnceWith({ id: bot.id, name: 'Editor' }) })
  })

  it('saves only the edited avatar while unedited identity fields follow a concurrent tool update', async () => {
    const source = directory()
    const save = vi.fn<(request: UpdateBotRequest) => Promise<void>>().mockResolvedValue(undefined)
    const props = { sessionId: bot.sessionId, useDirectory: bindSnapshotSelector(source), useProjection: () => undefined, save, t } as BotSettingsProps
    render(<BotSettings {...permissionDefaults} {...props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['color.blue'] }))
    const updated = { ...bot, name: 'Updated Writer', role: 'The lasting role saved through chat' }
    act(() => { source.set({ ...source.getSnapshot(), snapshot: { ...snapshot, bots: [main, updated] } }) })
    expect(screen.getByLabelText<HTMLInputElement>(zh['bot.name']).value).toBe(updated.name)
    expect(screen.getByText(updated.role)).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: zh['bot.role'] })).toBeNull()
    expect(screen.getByRole('button', { name: zh['color.blue'] }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: zh['bot.save'] }))
    await waitFor(() => { expect(save).toHaveBeenCalledExactlyOnceWith({ id: bot.id, avatar: { shape: 'classic', color: '#2288FF' } }) })
    expect(source.getSnapshot().snapshot?.bots.find(member => member.id === bot.id)?.role).toBe(updated.role)
  })

  it('preserves a multiline duty draft after a concurrent update and a failed inline save', async () => {
    const source = directory()
    const initialRole = 'Prepare complete workpapers.\nPreserve source dates and exact numbers on every line.'
    source.set({ ...source.getSnapshot(), snapshot: { ...snapshot, bots: [main, { ...bot, role: initialRole }] } })
    const save = vi.fn<(request: UpdateBotRequest) => Promise<void>>()
      .mockRejectedValueOnce(new Error('Synthetic duty save failed'))
      .mockImplementationOnce(async request => {
        const state = source.getSnapshot()
        if (state.snapshot === null) throw new Error('Synthetic directory missing')
        source.set({ ...state, snapshot: { ...state.snapshot,
          bots: state.snapshot.bots.map(member => member.id === request.id ? { ...member, ...request } : member),
        } })
      })
    const props = { sessionId: bot.sessionId, useDirectory: bindSnapshotSelector(source), useProjection: () => undefined, save, t } as BotSettingsProps
    render(<BotSettings {...permissionDefaults} {...props} />)
    expect(screen.getByText(initialRole, { normalizer: text => text }).textContent).toBe(initialRole)
    expect(screen.queryByRole('textbox', { name: zh['bot.role'] })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh['role.edit'] }))
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: zh['bot.role'] }).value).toBe(initialRole)
    const draftRole = initialRole + '\nRecord any unresolved exceptions.'
    fireEvent.change(screen.getByRole('textbox', { name: zh['bot.role'] }), { target: { value: draftRole } })
    act(() => { source.set({ ...source.getSnapshot(), snapshot: { ...snapshot,
      bots: [main, { ...bot, name: 'Updated Writer', role: 'A concurrent role from chat' }] } }) })
    fireEvent.change(screen.getByLabelText(zh['bot.name']), { target: { value: 'Unsaved title' } })
    const saveRole = () => screen.getByRole('button', { name: zh['role.save'] })
    await act(async () => { fireEvent.click(saveRole()) })
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: zh['bot.role'] }).value).toBe(draftRole)
    expect(saveRole()).toHaveProperty('disabled', false)
    await act(async () => { fireEvent.click(saveRole()) })
    expect(save.mock.calls).toEqual([[{ id: bot.id, role: draftRole }], [{ id: bot.id, role: draftRole }]])
    expect(screen.queryByRole('textbox', { name: zh['bot.role'] })).toBeNull()
    expect(screen.getByText(draftRole, { normalizer: text => text })).toBeTruthy()
    expect(screen.getByLabelText<HTMLInputElement>(zh['bot.name']).value).toBe('Unsaved title')
  })

  it('retains the edited draft after a failed save', async () => {
    const source = directory()
    const save = vi.fn<(request: UpdateBotRequest) => Promise<void>>().mockRejectedValue(new Error('synthetic write failure'))
    const props = { sessionId: bot.sessionId, useDirectory: bindSnapshotSelector(source), useProjection: () => undefined, save, t } as BotSettingsProps
    render(<BotSettings {...permissionDefaults} {...props} />)
    fireEvent.change(screen.getByLabelText(zh['bot.name']), { target: { value: 'Keep this draft' } })
    fireEvent.click(screen.getByRole('button', { name: zh['bot.save'] }))
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['bot.save'] }).disabled).toBe(false) })
    act(() => { source.set({ ...source.getSnapshot(), snapshot: { ...snapshot,
      bots: [main, { ...bot, role: 'A role saved while this draft remained unsaved' }] } }) })
    expect(screen.getByLabelText<HTMLInputElement>(zh['bot.name']).value).toBe('Keep this draft')
    expect(screen.getByText('A role saved while this draft remained unsaved')).toBeTruthy()
    expect(save).toHaveBeenCalledExactlyOnceWith({ id: bot.id, name: 'Keep this draft' })
  })
})

it('keeps the main member fixed above the two default sections, including an empty chat section', () => {
  const commands = { openBot: vi.fn(), moveBot: vi.fn(), openChat: vi.fn(), createChat: vi.fn(),
    createBot: vi.fn(), createGroup: vi.fn(), renameGroup: vi.fn(), removeGroup: vi.fn(), moveGroup: vi.fn(), retry: vi.fn() }
  const view = createSidebarViewStore().create()
  const props = {
    wide: true, expandSidebar: vi.fn(), commands, t,
    useDirectory: bindSnapshotSelector(directory()), useChats: bindSnapshotSelector(chatDirectory()),
    useWorkspaces: bindSnapshotSelector(createSnapshotStore<WorkspaceSnapshot>({
      items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null })),
    entityActions: { pin: vi.fn(), move: vi.fn(), rename: vi.fn(), copyId: vi.fn(), remove: vi.fn() },
    useStore: bindSnapshotSelector(view), actions: view.actions,
    useSidebarOverflow: bindSnapshotSelector(createSnapshotStore(false)),
    useSidebarReveal: bindSnapshotSelector(createSnapshotStore(null)), observeScrollList: vi.fn(), scrollDown: vi.fn(),
    useSessions: (select: (value: { ids: string[] }) => unknown) => select({ ids: [] }),
    useSidebarSessionStatus: bindSnapshotSelector(createSnapshotStore(new Map())),
    useSessionStatus: bindSnapshotSelector(createSnapshotStore(new Map())),
    usePanelInfo: (select: (value: { activePanelId: null }) => unknown) => select({ activePanelId: null }),
  } as TeamSidebarProps
  render(<TeamSidebar {...props} />)
  expect(screen.getByRole('button', { name: 'Katcats' })).toBeTruthy()
  expect(screen.getByRole('region', { name: zh['team.bots'] })).toBeTruthy()
  expect(screen.getByRole('region', { name: zh['team.chats'] }).textContent).toContain(zh['team.emptyChats'])
  fireEvent.click(screen.getByRole('button', { name: 'Writer' }))
  expect(commands.openBot).toHaveBeenCalledExactlyOnceWith(bot.id)
  fireEvent.click(screen.getByRole('button', { name: t('team.newInGroup', { name: zh['team.bots'] }) }))
  expect(commands.createBot).toHaveBeenCalledExactlyOnceWith(gid('ordinary'))
})

it('updates the scoped header robot from saved member data and opens its settings', () => {
  const source = directory()
  const openSettings = vi.fn()
  const props = { sessionId: bot.sessionId, useDirectory: bindSnapshotSelector(source), useChats: bindSnapshotSelector(chatDirectory()), openSettings, t } as BotHeaderActionProps
  const view = render(<BotHeaderAction {...props} />)
  const button = screen.getByRole('button', { name: zh['bot.settings'] })
  expect(button.querySelector('svg')?.style.getPropertyValue('--katcats-avatar-color')).toBe('#FF2849')
  act(() => {
    source.set({ ...source.getSnapshot(), snapshot: { ...snapshot, bots: [main, { ...bot, avatar: { shape: 'fluffy', color: '#2288FF' } }] } })
  })
  expect(button.querySelector('svg')?.style.getPropertyValue('--katcats-avatar-color')).toBe('#2288FF')
  fireEvent.click(button)
  expect(openSettings).toHaveBeenCalledOnce()
  view.rerender(<BotHeaderAction {...props} sessionId={'unrelated-session' as SessionId} />)
  expect(screen.queryByRole('button', { name: zh['bot.settings'] })).toBeNull()
})

it('uses the main portrait only in its own header and restores ordinary artwork when navigating', () => {
  const source = directory()
  const openSettings = vi.fn()
  const props = { sessionId: main.sessionId, useDirectory: bindSnapshotSelector(source), useChats: bindSnapshotSelector(chatDirectory()),
    openSettings, t } as BotHeaderActionProps
  const view = render(<BotHeaderAction {...props} />)
  const button = screen.getByRole('button', { name: zh['bot.settings'] })
  expect(button.querySelector('img')?.getAttribute('width')).toBe('24')
  expect(button.querySelector('svg')).toBeNull()
  fireEvent.click(button)
  expect(openSettings).toHaveBeenCalledOnce()
  view.rerender(<BotHeaderAction {...props} sessionId={bot.sessionId} />)
  expect(button.querySelector('img')).toBeNull()
  expect(button.querySelector('svg')?.getAttribute('width')).toBe('24')
})

describe('per-member model selection', () => {
  it('shows the saved follow policy separately from the actual Session model and saves a reset without global model calls', async () => {
    const source = directory()
    source.set({ ...source.getSnapshot(), snapshot: { ...snapshot, bots: [main, { ...bot, model: { kind: 'override', provider: 'mock', model: 'fixed' } }],
      modelCapabilities: { override: true, followGlobal: true } } })
    const save = vi.fn<(request: UpdateBotRequest) => Promise<void>>().mockResolvedValue(undefined)
    const props = { sessionId: bot.sessionId, useDirectory: bindSnapshotSelector(source),
      useProjection: () => ({ next: { provider: 'mock', model: 'fixed' }, lastUsed: { provider: 'mock', model: 'fixed' } }), save, t } as BotSettingsProps
    const view = render(<BotSettings {...permissionDefaults} {...props} />)
    expect(screen.getByText(t('bot.lastRequestModel', { model: 'mock / fixed' }))).toBeTruthy()
    fireEvent.click(screen.getByLabelText(zh['bot.model']))
    fireEvent.click(screen.getByRole('menuitem', { name: zh['bot.followGlobal'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['bot.save'] }))
    await waitFor(() => { expect(save).toHaveBeenCalledExactlyOnceWith({ id: bot.id, model: { kind: 'follow-global' } }) })
    act(() => { source.set({ ...source.getSnapshot(), snapshot: { ...snapshot, modelCapabilities: { override: true, followGlobal: true } } }) })
    view.rerender(<BotSettings {...permissionDefaults} {...props} useProjection={() => ({
      next: { provider: 'mock', model: 'new-base' }, lastUsed: { provider: 'mock', model: 'fixed' },
    })} />)
    expect(screen.getByLabelText(zh['bot.model']).textContent).toContain(zh['bot.followGlobal'])
    expect(screen.getByText(t('bot.lastRequestModel', { model: 'mock / fixed' }))).toBeTruthy()
  })

  it('enables fixed overrides independently and shows the actual Session model without a follow-global option', async () => {
    const source = directory()
    source.set({ ...source.getSnapshot(), snapshot: { ...snapshot, modelCapabilities: { override: true, followGlobal: false } },
      catalog: { default: { provider: 'mock', model: 'base' }, routableProviders: ['mock'], failures: [],
        groups: [{ id: 'mock', name: 'Mock', models: [{ id: 'active', name: 'Active' }, { id: 'writer', name: 'Writer' }] }] } })
    const save = vi.fn<(request: UpdateBotRequest) => Promise<void>>().mockResolvedValue(undefined)
    const props = { sessionId: bot.sessionId, useDirectory: bindSnapshotSelector(source),
      useProjection: () => ({ next: { provider: 'mock', model: 'active' } }), save, t } as BotSettingsProps
    render(<BotSettings {...permissionDefaults} {...props} />)
    const control = screen.getByLabelText<HTMLButtonElement>(zh['bot.model'])
    expect(control.disabled).toBe(false)
    expect(control.textContent).toBe('Mock / Active')
    fireEvent.click(control)
    expect(screen.queryByRole('menuitem', { name: zh['bot.followGlobal'] })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mock / Writer' }))
    fireEvent.click(screen.getByRole('button', { name: zh['bot.save'] }))
    await waitFor(() => { expect(save).toHaveBeenCalledWith(expect.objectContaining({
      model: { kind: 'override', provider: 'mock', model: 'writer' },
    })) })
  })

  it('saves unrelated fields without sending the initial unsupported follow-global policy', async () => {
    const source = directory()
    source.set({ ...source.getSnapshot(), snapshot: { ...snapshot, modelCapabilities: { override: true, followGlobal: false } } })
    const save = vi.fn<(request: UpdateBotRequest) => Promise<void>>().mockResolvedValue(undefined)
    const props = { sessionId: bot.sessionId, useDirectory: bindSnapshotSelector(source),
      useProjection: () => ({ next: { provider: 'mock', model: 'active' } }), save, t } as BotSettingsProps
    render(<BotSettings {...permissionDefaults} {...props} />)
    fireEvent.change(screen.getByLabelText(zh['bot.name']), { target: { value: 'Editor' } })
    fireEvent.click(screen.getByRole('button', { name: zh['bot.save'] }))
    await waitFor(() => { expect(save).toHaveBeenCalledOnce() })
    expect(save.mock.calls[0]?.[0]).not.toHaveProperty('model')
  })

  it('captures the base model as a fixed choice even if global settings change before saving', async () => {
    const source = directory()
    source.set({ ...source.getSnapshot(), snapshot: { ...snapshot, modelCapabilities: { override: true, followGlobal: false } },
      catalog: { default: { provider: 'mock', model: 'base', reasoningEffort: 'high' }, routableProviders: ['mock'], failures: [], groups: [] } })
    const save = vi.fn<(request: UpdateBotRequest) => Promise<void>>().mockResolvedValue(undefined)
    const props = { sessionId: bot.sessionId, useDirectory: bindSnapshotSelector(source),
      useProjection: () => ({ next: { provider: 'mock', model: 'active' } }), save, t } as BotSettingsProps
    render(<BotSettings {...permissionDefaults} {...props} />)
    fireEvent.click(screen.getByLabelText(zh['bot.model']))
    fireEvent.click(screen.getByRole('menuitem', { name: zh['bot.useBaseModel'] }))
    act(() => { source.set({ ...source.getSnapshot(), catalog: {
      default: { provider: 'mock', model: 'later' }, routableProviders: ['mock'], failures: [], groups: [],
    } }) })
    fireEvent.click(screen.getByRole('button', { name: zh['bot.save'] }))
    await waitFor(() => { expect(save).toHaveBeenCalledWith(expect.objectContaining({
      model: { kind: 'override', provider: 'mock', model: 'base', reasoningEffort: 'high' },
    })) })
  })

  function modelSettingsFixture(model = 'gpt-6.1-sol') {
    const source = directory()
    const savedBot: TeamBot = { ...bot, model: { kind: 'override', provider: 'chatgpt', model } }
    source.set({ ...source.getSnapshot(), snapshot: { ...snapshot, bots: [main, savedBot],
      modelCapabilities: { override: true, followGlobal: true } }, catalog: {
      default: { provider: 'chatgpt', model: 'gpt-6.1-sol' }, routableProviders: ['chatgpt'], failures: [],
      groups: [{ id: 'chatgpt', name: 'ChatGPT', models: [
        { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' }, { id: 'gpt-6-astra', name: 'GPT-6-Astra' },
      ] }],
    } })
    const save = vi.fn<(request: UpdateBotRequest) => Promise<void>>().mockResolvedValue(undefined)
    const lastUsed = { provider: 'chatgpt', model: 'gpt-6.1-sol' }
    const props = { sessionId: bot.sessionId, useDirectory: bindSnapshotSelector(source),
      useProjection: () => ({ next: lastUsed, lastUsed }), save, t } as BotSettingsProps
    const view = render(<BotSettings {...permissionDefaults} {...props} />)
    return { source, savedBot, save, props, view }
  }

  it('shows the saved override in the selector even when the latest request used a different model', () => {
    const b = modelSettingsFixture('gpt-6-astra')
    expect(screen.getByLabelText(zh['bot.model']).textContent).toBe('ChatGPT / GPT-6-Astra')
    expect(screen.getByText(t('bot.savedModel', { model: 'chatgpt / gpt-6-astra' }))).toBeTruthy()
    expect(screen.getByText(t('bot.lastRequestModel', { model: 'chatgpt / gpt-6.1-sol' }))).toBeTruthy()
    b.view.rerender(<BotSettings {...permissionDefaults} {...b.props}
      useProjection={() => ({ next: { provider: 'chatgpt', model: 'gpt-6-astra' }, lastUsed: null })} />)
    expect(screen.getByText(zh['bot.noRequestModel'])).toBeTruthy()
    expect(screen.queryByText(t('bot.lastRequestModel', { model: 'chatgpt / gpt-6-astra' }))).toBeNull()
  })

  it('distinguishes an unsaved model, confirmed Bot settings and a later recorded model request', async () => {
    const b = modelSettingsFixture()
    const confirmation = Promise.withResolvers<undefined>()
    b.save.mockImplementation(async (request) => {
      await confirmation.promise
      b.source.set({ ...b.source.getSnapshot(), snapshot: { ...snapshot, bots: [main, { ...b.savedBot, ...request }],
        modelCapabilities: { override: true, followGlobal: true } } })
    })
    const previousRequest = t('bot.lastRequestModel', { model: 'chatgpt / gpt-6.1-sol' })
    const pending = t('bot.pendingModel', { model: 'chatgpt / gpt-6-astra' })
    fireEvent.click(screen.getByLabelText(zh['bot.model']))
    fireEvent.click(screen.getByRole('menuitem', { name: 'ChatGPT / GPT-6-Astra' }))
    expect(b.save).not.toHaveBeenCalled()
    expect(screen.getByText(pending)).toBeTruthy()
    expect(screen.getByText(t('bot.savedModel', { model: 'chatgpt / gpt-6.1-sol' }))).toBeTruthy()
    expect(screen.getByText(previousRequest)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['bot.save'] }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText(pending)).toBeTruthy()
    await act(async () => { confirmation.resolve(undefined); await confirmation.promise })
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe(zh['team.saved']) })
    expect(screen.queryByText(pending)).toBeNull()
    const saved = screen.getByText(t('bot.savedModel', { model: 'chatgpt / gpt-6-astra' })).textContent
    expect(screen.getByText(previousRequest)).toBeTruthy()
    expect(screen.getByLabelText(zh['bot.model']).textContent).toBe('ChatGPT / GPT-6-Astra')
    b.view.rerender(<BotSettings {...permissionDefaults} {...b.props} useProjection={() => ({
      next: { provider: 'chatgpt', model: 'gpt-6-astra' }, lastUsed: { provider: 'chatgpt', model: 'gpt-6-astra' },
    })} />)
    expect({ saved, lastRequest: screen.getByText(t('bot.lastRequestModel', { model: 'chatgpt / gpt-6-astra' })).textContent,
      feedback: screen.getByRole('status').textContent }).toMatchInlineSnapshot(`
        {
          "feedback": "已保存 Bot 设置",
          "lastRequest": "最近一次请求模型：chatgpt / gpt-6-astra",
          "saved": "已保存 Bot 模型：chatgpt / gpt-6-astra",
        }
      `)
  })

  it('retains the unsaved model and previous saved route when saving fails', async () => {
    const b = modelSettingsFixture()
    b.save.mockRejectedValue(new Error('fixture save failure'))
    fireEvent.click(screen.getByLabelText(zh['bot.model']))
    fireEvent.click(screen.getByRole('menuitem', { name: 'ChatGPT / GPT-6-Astra' }))
    fireEvent.click(screen.getByRole('button', { name: zh['bot.save'] }))
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['bot.save'] }).disabled).toBe(false) })
    expect(screen.getByText(t('bot.pendingModel', { model: 'chatgpt / gpt-6-astra' }))).toBeTruthy()
    expect(screen.getByText(t('bot.savedModel', { model: 'chatgpt / gpt-6.1-sol' }))).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps model selection in settings instead of rendering a composer control', () => {
    const source = directory()
    source.set({ ...source.getSnapshot(), catalog: { default: { provider: 'mock', model: 'different-global' },
      groups: [], failures: [], routableProviders: [] } })
    const props = { sessionId: bot.sessionId, useDirectory: bindSnapshotSelector(source), useChats: bindSnapshotSelector(chatDirectory()), openSettings: vi.fn(), completeSettings: vi.fn(),
      useSettingsRequest: bindSnapshotSelector(createSnapshotStore<BotSettingsRequest | null>(null)),
      useProjection: () => ({ next: { provider: 'mock', model: 'active-session' } }), t } as BotModelControlProps
    const view = render(<BotModelControl {...props} />)
    expect(screen.queryByRole('button')).toBeNull()
    view.rerender(<BotModelControl {...props} useProjection={() => undefined} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText('different-global')).toBeNull()
  })
})
