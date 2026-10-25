// @vitest-environment jsdom
/** Product settings reuse the original permission Factory under exact retained member Sessions. */
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { remoteDefaultResponses } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/remote-default-responses.ts'
import { RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as permissionApply, inject as permissionInject } from '@deepseek-ai/dsh-client-ui-permission-presets/client'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PermissionCatalog } from '@deepseek-ai/dsh-permission-presets/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConnectionGeneration, ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import type { CommandExecution } from '@deepseek-ai/dsh-commands/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-commands/remote'
import type { BotId, GroupId, TeamBot } from '../src/types.ts'
import type { ChatId, TeamChat } from '../src/chats-types.ts'
import { GroupPermissionSettings, SettingsPermissionPicker } from '../src/client/PermissionSettings.tsx'
import type { PermissionMemberTarget } from '../src/client/PermissionSettings.tsx'
import { createGroupPermissionBatch } from '../src/client/group-permission-batch.ts'
import type { GroupPermissionBatchView } from '../src/client/group-permission-batch.ts'
import type { TeamView } from '../src/client/model.ts'
import type { ChatView } from '../src/client/chat-model.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const writer: TeamBot = { id: 'writer' as BotId, kind: 'ordinary', name: 'Writer', role: 'Writing',
  avatar: { shape: 'classic', color: '#FF2849' }, model: { kind: 'follow-global' },
  workDir: '/synthetic/writer', groupId: 'bots' as GroupId, sessionId: 'writer-private' as SessionId }
const reviewer: TeamBot = { ...writer, id: 'reviewer' as BotId, name: 'Reviewer', sessionId: 'reviewer-private' as SessionId }
const outsider: TeamBot = { ...writer, id: 'outsider' as BotId, name: 'Outsider', sessionId: 'outsider-private' as SessionId }
const group: TeamChat = { id: 'editorial' as ChatId, name: 'Editorial', groupId: 'chats' as GroupId,
  rootSessionId: 'editorial-root' as SessionId, workDir: '/synthetic/editorial', memberIds: [writer.id, reviewer.id],
  managerId: null, memberRoles: [], executors: [
    { botId: writer.id, sessionId: 'editorial-writer' as SessionId },
    { botId: reviewer.id, sessionId: 'editorial-reviewer' as SessionId },
  ], relayLimit: 20, generation: 0, status: 'active', pauseReason: null, run: null, error: null }
const CATALOG: PermissionCatalog = { defaultPreset: 'workspace-write',
  defaultOptions: [{ value: 'read-only', name: 'read-only' }, { value: 'workspace-write', name: 'workspace-write' }],
  options: [{ value: 'read-only', name: 'read-only' }, { value: 'workspace-write', name: 'workspace-write' },
    { value: 'danger-full-access', name: 'danger-full-access' }, { value: 'auto', name: 'auto' },
    { value: 'xiaojing-no-approval', name: 'xiaojing-no-approval' }] }

async function setup(options: { readonly pending?: boolean; readonly rejectRetain?: boolean; readonly batch?: boolean } = {}) {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale('zh')
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  runtime.ctx.effect(() => locale.register('katcats.team', { zh, en }))
  const connection = createSnapshotStore<ConnectionState | undefined>('connected')
  const generation = createSnapshotStore<ConnectionGeneration | undefined>({ id: 1, host: { home: '/synthetic' } })
  runtime.ctx.provide('connection', { generation, state: connection } as never)
  runtime.ctx.provide('commandUi', { decorate: () => () => {}, dismiss: () => {} } as never)
  const mock = RemoteMock.create().load(remoteDefaultResponses)
  onTestFinished(() => { mock.assertNoUnmatched() })
  const readCatalog = vi.fn(async () => ({ ok: true as const, value: CATALOG }))
  const execute = vi.fn<(id: SessionId, line: string, attachments: readonly object[], signal?: AbortSignal)
  => Promise<RemoteResult<CommandExecution | undefined>>>()
    .mockResolvedValue({ ok: true, value: { commandId: 'batch-command' as CommandExecution['commandId'], result: { kind: 'success' } } })
  runtime.remote.provideNamespaces({ settings: mock.remote.settings, permissionPresets: { catalog: readCatalog }, commands: { execute } })
  const calls: { id: string; line: string }[] = []
  const opening = Promise.withResolvers<undefined>()
  const sessionIds = [writer.sessionId, reviewer.sessionId, outsider.sessionId, group.rootSessionId,
    ...group.executors.map(item => item.sessionId), 'other-group-writer' as SessionId]
  for (const id of sessionIds) {
    await runtime.sessions.add({ id, session: { command: async (line: string) => {
      calls.push({ id, line })
      return { ok: true as const, value: { matched: true } }
    } }, ...options.pending && id === group.executors[0]!.sessionId ? {
      initialOpen: (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('Synthetic member opening aborted')) }, { once: true })
        void opening.promise.then(() => { resolve() }, reject)
      }),
    } : {} })
    await runtime.sessions.setProjection(id, 'permissions', { currentValue: 'workspace-write' })
    await runtime.sessions.setProjection(id, 'agentPreset', 'default')
  }
  const privateReference = runtime.sessions.retainFor(runtime.ctx, writer.sessionId)
  await privateReference.ready
  const state = createSnapshotStore({ chat: group, bots: [writer, reviewer, outsider],
    selectedMemberIds: [...group.memberIds], enabled: true, locked: false, dirty: false, mode: 'group' })
  const useView = bindSnapshotSelector(state)
  const retainPermissionSession = vi.fn((target: PermissionMemberTarget, signal: AbortSignal) => {
    if (options.rejectRetain) throw new Error('Synthetic unavailable member scope')
    return runtime.sessions.retain(target.sessionId, { source: 'katcatsPermissions', signal })
  })
  const directory = createSnapshotStore<TeamView>({ phase: 'ready', catalog: null, snapshot: {
    revision: 1, mainBotId: 'main' as BotId, bots: state.getSnapshot().bots, groups: [],
    modelCapabilities: { override: false, followGlobal: false },
  } })
  const chats = createSnapshotStore<ChatView>({ phase: 'ready', snapshot: {
    revision: 1, chats: [group], deliveries: [], activities: [], relayLimit: 16,
  } })
  const capabilities = new Map(sessionIds.map(id => [id, createSnapshotStore(true)]))
  const batch = createGroupPermissionBatch({ rootSessionId: group.rootSessionId, directory, chats,
    connection: { state: connection, generation }, retain: retainPermissionSession,
    binding: id => runtime.sessions.binding(id), capability: id => capabilities.get(id)!,
    execute: (id, line, signal) => runtime.ctx.remote.commands.execute(id, line, [], signal),
  })
  const dormant = createSnapshotStore<GroupPermissionBatchView>({ targetKey: '', targetLabel: '', targets: [],
    ready: false, currentValue: null, allowNoApproval: false, busy: false, results: [] })
  const useBatch = bindSnapshotSelector(options.batch ? batch.state : dormant)
  type RootProps = PropsRuntime<'root'> & PropsRenderFactories
    & PropsRenderSlots<'katcats.settings.permission' | 'conversation.input.permission' | 'settings.general.item'>
  await runtime.root.declare({
    'katcats.settings.permission': { kind: 'single', scope: 'session' },
    'settings.general.item': { kind: 'list', scope: 'root' },
    'conversation.input.permission': { kind: 'single', scope: 'session' },
  }, ({ renderFactorySlot, renderSlot, SessionProvider }: RootProps) => {
    const view = useView(value => value)
    const batchView = useBatch(value => value)
    return view.mode === 'private'
      ? <SessionProvider session={privateReference}>{renderFactorySlot('permission.select', { locked: view.locked })}</SessionProvider>
      : <GroupPermissionSettings {...view} retainPermissionSession={retainPermissionSession}
        batch={batchView} activateBatch={options.batch ? batch.activate : () => {}}
        applyBatch={batch.apply} cancelBatch={batch.cancel} renderFactorySlot={options.batch ? renderFactorySlot : () => null}
        renderSlot={renderSlot} SessionProvider={SessionProvider} t={locale.bind('katcats.team')} />
  })
  runtime.slots.register({ name: 'katcats.settings.permission', locale: 'katcats.team' }, SettingsPermissionPicker)
  await runtime.mount({ inject: [...settingsInject], apply: settingsApply })
  await runtime.mount({ inject: [...permissionInject], apply: permissionApply })
  const view = runtime.renderRoot()
  await vi.waitFor(() => { expect(readCatalog).toHaveBeenCalledOnce() })
  const row = (name = writer.name) => view.getByRole('group', { name: `${name}的群内权限` })
  const trigger = (name = writer.name) => within(row(name)).getByRole<HTMLButtonElement>('button', { name: /^访问模式/u })
  const change = async (patch: Partial<ReturnType<typeof state.getSnapshot>>) => {
    await act(async () => {
      state.set({ ...state.getSnapshot(), ...patch })
      const value = state.getSnapshot()
      directory.set({ ...directory.getSnapshot(), snapshot: { ...directory.getSnapshot().snapshot!, bots: value.bots } })
      chats.set({ ...chats.getSnapshot(), snapshot: { ...chats.getSnapshot().snapshot!, chats: [value.chat] } })
    })
  }
  const batchTrigger = () => within(view.getByRole('group', { name: zh['permissions.batch'] }))
    .getByRole<HTMLButtonElement>('button', { name: /^所有成员权限/u })
  return { runtime, view, state, change, calls, row, trigger, opening, retainPermissionSession,
    batch, batchTrigger, execute, connection, generation, directory, chats, capabilities,
    retained: (id: SessionId) => runtime.sessions.retainInfo(id).getSnapshot().retainedBy.katcatsPermissions ?? 0 }
}

function chooseFullAccess(trigger: HTMLButtonElement) {
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('menuitem', { name: '完全权限' }))
  fireEvent.click(screen.getByRole('checkbox'))
}

const success: RemoteResult<CommandExecution | undefined> = { ok: true, value: {
  commandId: 'public-permission-command' as CommandExecution['commandId'], result: { kind: 'success' },
} }

describe('group permission batch through the public command Remote', () => {
  it('pre-retains all exact worker bindings and applies in saved-member order without using matched-only Session commands', async () => {
    const b = await setup({ batch: true })
    await vi.waitFor(() => { expect(b.batchTrigger().disabled).toBe(false) })
    expect(group.executors.map(item => b.retained(item.sessionId))).toEqual([2, 2])
    expect([group.rootSessionId, writer.sessionId, reviewer.sessionId, 'other-group-writer' as SessionId]
      .map(id => b.retained(id))).toEqual([0, 0, 0, 0])
    fireEvent.click(b.batchTrigger())
    fireEvent.click(screen.getByRole('menuitem', { name: '仅可查看' }))
    await vi.waitFor(() => { expect(b.execute).toHaveBeenCalledTimes(2) })
    expect(b.execute.mock.calls.map(([id, line, attachments]) => ({ id, line, attachments }))).toEqual([
      { id: 'editorial-writer', line: '/permission read-only', attachments: [] },
      { id: 'editorial-reviewer', line: '/permission read-only', attachments: [] },
    ])
    expect(b.calls).toEqual([])
    expect(b.batch.state.getSnapshot().results.map(item => [item.target.name, item.status])).toMatchInlineSnapshot(`
      [
        [
          "Writer",
          "success",
        ],
        [
          "Reviewer",
          "success",
        ],
      ]
    `)
    expect(screen.getAllByText(zh['permissions.batchResult.success'])).toHaveLength(2)
  })

  it('uses one scoped risk confirmation and dispatches nothing after its cancellation', async () => {
    const b = await setup({ batch: true })
    await vi.waitFor(() => { expect(b.batchTrigger().disabled).toBe(false) })
    chooseFullAccess(b.batchTrigger())
    expect(screen.getByRole('dialog').textContent).toContain('“Editorial”中 2 位成员')
    expect(b.execute).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(b.execute).not.toHaveBeenCalled()
    chooseFullAccess(b.batchTrigger())
    fireEvent.click(screen.getByRole('button', { name: '启用完全权限' }))
    await vi.waitFor(() => { expect(b.execute).toHaveBeenCalledTimes(2) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps the whole batch unavailable until every saved executor and projection is ready', async () => {
    const b = await setup({ batch: true, pending: true })
    expect(b.batchTrigger().disabled).toBe(true)
    expect(b.execute).not.toHaveBeenCalled()
    await act(async () => { b.opening.resolve(undefined) })
    expect(b.batchTrigger().disabled).toBe(false)
    await act(async () => { await b.runtime.sessions.setProjection(group.executors[1]!.sessionId, 'permissions', undefined) })
    expect(b.batchTrigger().disabled).toBe(true)
    const key = b.batch.state.getSnapshot().targetKey
    await act(async () => { await b.batch.apply('read-only', key) })
    expect(b.execute).not.toHaveBeenCalled()
  })

  it('releases batch ownership and blocks changes for unsaved settings, saving or a hidden panel', async () => {
    const b = await setup({ batch: true })
    await vi.waitFor(() => { expect(b.batchTrigger().disabled).toBe(false) })
    for (const patch of [{ dirty: true }, { dirty: false, locked: true }, { locked: false, enabled: false }]) {
      await b.change(patch)
      expect(b.batchTrigger().disabled).toBe(true)
      expect(group.executors.map(item => b.retained(item.sessionId))).toEqual(patch.enabled === false ? [0, 0] : [1, 1])
    }
    expect(b.execute).not.toHaveBeenCalled()
    await b.change({ enabled: true })
    await vi.waitFor(() => { expect(b.batchTrigger().disabled).toBe(false) })
  })

  it.each(['missing', 'legacy-main', 'private-alias', 'root-alias'] as const)('rejects the entire target set for %s instead of claiming all members were updated', async (kind) => {
    const b = await setup({ batch: true })
    await vi.waitFor(() => { expect(b.batchTrigger().disabled).toBe(false) })
    const bots = kind === 'missing' ? [writer, outsider]
      : kind === 'legacy-main' ? [writer, { ...reviewer, kind: 'main' as const }, outsider] : [writer, reviewer, outsider]
    const executors = kind === 'private-alias' || kind === 'root-alias'
      ? [group.executors[0]!, { botId: reviewer.id, sessionId: kind === 'private-alias' ? reviewer.sessionId : group.rootSessionId }]
      : group.executors
    await b.change({ bots, chat: { ...group, executors } })
    expect(b.batchTrigger().disabled).toBe(true)
    expect(b.batch.state.getSnapshot().targets).toEqual([])
    expect(b.execute).not.toHaveBeenCalled()
  })

  it('closes a stale confirmation when roster, connection generation or command capability changes', async () => {
    const b = await setup({ batch: true })
    await vi.waitFor(() => { expect(b.batchTrigger().disabled).toBe(false) })
    chooseFullAccess(b.batchTrigger())
    await b.change({ chat: { ...group, memberIds: [writer.id], executors: [group.executors[0]!] } })
    expect(screen.queryByRole('dialog')).toBeNull()
    await vi.waitFor(() => { expect(b.batchTrigger().disabled).toBe(false) })
    chooseFullAccess(b.batchTrigger())
    await act(async () => { b.generation.set({ id: 2, host: { home: '/synthetic' } }) })
    expect(screen.queryByRole('dialog')).toBeNull()
    await vi.waitFor(() => { expect(b.batchTrigger().disabled).toBe(false) })
    chooseFullAccess(b.batchTrigger())
    await act(async () => { b.capabilities.get(group.executors[0]!.sessionId)!.set(false) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(b.batchTrigger().disabled).toBe(true)
    expect(b.execute).not.toHaveBeenCalled()
  })

  it('excludes no-approval when any member is finance and invalidates an already acknowledged unsafe choice', async () => {
    const b = await setup({ batch: true })
    await vi.waitFor(() => { expect(b.batchTrigger().disabled).toBe(false) })
    fireEvent.click(b.batchTrigger())
    fireEvent.click(screen.getByRole('menuitem', { name: '自动审批(实验性)' }))
    fireEvent.click(screen.getByRole('checkbox'))
    await act(async () => { await b.runtime.sessions.setProjection(group.executors[1]!.sessionId, 'agentPreset', 'finance') })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(b.batchTrigger())
    expect(screen.queryByRole('menuitem', { name: '自动审批(实验性)' })).toBeNull()
    expect(b.batch.state.getSnapshot().allowNoApproval).toBe(false)
    await act(async () => { await b.batch.apply('xiaojing-no-approval', b.batch.state.getSnapshot().targetKey) })
    expect(b.execute).not.toHaveBeenCalled()
  })

  it('stops on a command-reported error and keeps confirmed changes, uncertain and unstarted members distinct', async () => {
    const b = await setup({ batch: true })
    await b.change({ chat: { ...group, memberIds: [...group.memberIds, outsider.id], executors: [...group.executors,
      { botId: outsider.id, sessionId: 'other-group-writer' as SessionId }] }, selectedMemberIds: [...group.memberIds, outsider.id] })
    await vi.waitFor(() => { expect(b.batchTrigger().disabled).toBe(false) })
    b.execute.mockResolvedValueOnce(success).mockResolvedValueOnce({ ok: true, value: {
      commandId: 'reported-error' as CommandExecution['commandId'], result: { kind: 'error', text: 'Synthetic failure after possible mutation' },
    } })
    await act(async () => { await b.batch.apply('read-only', b.batch.state.getSnapshot().targetKey) })
    expect(b.execute).toHaveBeenCalledTimes(2)
    expect(b.batch.state.getSnapshot().results.map(item => item.status)).toEqual(['success', 'unknown', 'not-run'])
    expect(screen.getByText(zh['permissions.batchResult.unknown'])).toBeTruthy()
    expect(screen.getByText(zh['permissions.batchResult.not-run'])).toBeTruthy()
    expect(screen.queryByText('Synthetic failure after possible mutation')).toBeNull()
  })

  it.each(['cancel', 'disconnect', 'hide'] as const)('halts future dispatch on %s and reports an in-flight command as unconfirmed', async (reason) => {
    const b = await setup({ batch: true })
    await vi.waitFor(() => { expect(b.batchTrigger().disabled).toBe(false) })
    const pending = Promise.withResolvers<RemoteResult<CommandExecution | undefined>>()
    b.execute.mockReturnValueOnce(pending.promise)
    let applying!: Promise<void>
    await act(async () => { applying = b.batch.apply('read-only', b.batch.state.getSnapshot().targetKey) })
    expect(b.trigger().disabled).toBe(true)
    const signal = b.execute.mock.calls[0]![3]!
    if (reason === 'cancel') fireEvent.click(screen.getByRole('button', { name: zh['permissions.batchCancel'] }))
    if (reason === 'disconnect') await act(async () => { b.connection.set('disconnected') })
    if (reason === 'hide') await b.change({ enabled: false })
    await act(async () => { await applying })
    expect(signal.aborted).toBe(true)
    expect(b.batch.state.getSnapshot().results.map(item => item.status)).toEqual(['unknown', 'not-run'])
    expect(b.execute).toHaveBeenCalledOnce()
    await act(async () => { pending.resolve(success) })
    expect(b.execute).toHaveBeenCalledOnce()
    if (reason === 'cancel') expect(b.trigger().disabled).toBe(false)
    else expect(group.executors.map(item => b.retained(item.sessionId))).toEqual(reason === 'hide' ? [0, 0] : [1, 1])
  })

  it('reports a missing command as not applied and a carrier failure as unconfirmed without continuing', async () => {
    const b = await setup({ batch: true })
    await vi.waitFor(() => { expect(b.batchTrigger().disabled).toBe(false) })
    b.execute.mockResolvedValueOnce({ ok: true, value: undefined })
    await act(async () => { await b.batch.apply('read-only', b.batch.state.getSnapshot().targetKey) })
    expect(b.batch.state.getSnapshot().results.map(item => item.status)).toEqual(['failed', 'not-run'])
    b.execute.mockRejectedValueOnce(new Error('Synthetic carrier lost'))
    await act(async () => { await b.batch.apply('read-only', b.batch.state.getSnapshot().targetKey) })
    expect(b.batch.state.getSnapshot().results.map(item => item.status)).toEqual(['unknown', 'not-run'])
    expect(b.execute).toHaveBeenCalledTimes(2)
  })

  it('revalidates a changed executor before the next command and never sends to a newly selected binding', async () => {
    const b = await setup({ batch: true })
    await vi.waitFor(() => { expect(b.batchTrigger().disabled).toBe(false) })
    const pending = Promise.withResolvers<RemoteResult<CommandExecution | undefined>>()
    b.execute.mockReturnValueOnce(pending.promise)
    let applying!: Promise<void>
    await act(async () => { applying = b.batch.apply('read-only', b.batch.state.getSnapshot().targetKey) })
    await b.change({ chat: { ...group, executors: [group.executors[0]!,
      { botId: reviewer.id, sessionId: 'other-group-writer' as SessionId }] } })
    await act(async () => { await applying; pending.resolve(success) })
    expect(b.execute).toHaveBeenCalledOnce()
    expect(b.batch.state.getSnapshot().results.map(item => item.status)).toEqual(['unknown', 'not-run'])
    expect(b.execute.mock.calls.map(([id]) => id)).toEqual(['editorial-writer'])
  })

  it('releases every visibility subscription and target reference when a settings occurrence closes', async () => {
    const b = await setup({ batch: true })
    await b.change({ enabled: false })
    const disposers: Array<ReturnType<typeof vi.fn>> = []
    for (const source of [b.directory, b.chats, b.connection, b.generation]) {
      const subscribe = source.subscribe.bind(source)
      vi.spyOn(source, 'subscribe').mockImplementation((listener) => {
        const dispose = vi.fn(subscribe(listener))
        disposers.push(dispose)
        return dispose
      })
    }
    await b.change({ enabled: true })
    await vi.waitFor(() => { expect(b.batchTrigger().disabled).toBe(false) })
    await b.change({ enabled: false })
    expect(disposers).toHaveLength(4)
    for (const dispose of disposers) expect(dispose).toHaveBeenCalledOnce()
    expect(group.executors.map(item => b.retained(item.sessionId))).toEqual([0, 0])
    b.execute.mockClear()
    await act(async () => { b.generation.set({ id: 3, host: { home: '/synthetic' } }) })
    expect(group.executors.map(item => b.retained(item.sessionId))).toEqual([0, 0])
    expect(b.execute).not.toHaveBeenCalled()
  })
})

describe('Katcats settings permission scopes', () => {
  it('renders member identities and writes only the corresponding group worker, preserving private and root scopes', async () => {
    const b = await setup()
    await vi.waitFor(() => { expect(b.trigger().textContent).toBe('工作区内修改') })
    expect(b.view.getAllByRole('group').map(row => row.getAttribute('aria-label'))).toMatchInlineSnapshot(`
      [
        "统一设置成员权限",
        "Writer的群内权限",
        "Reviewer的群内权限",
      ]
    `)
    fireEvent.click(b.trigger(reviewer.name))
    fireEvent.click(screen.getByRole('menuitem', { name: '仅可查看' }))
    await act(async () => {})
    expect(b.calls).toEqual([{ id: 'editorial-reviewer', line: '/permission read-only' }])
    expect(b.retainPermissionSession.mock.calls.map(([target]) => target)).toEqual(group.executors.map(executor => ({
      chatId: group.id, botId: executor.botId, sessionId: executor.sessionId,
    })))
    expect(b.retained(group.rootSessionId)).toBe(0)
    expect(b.retained(writer.sessionId)).toBe(0)
    expect(b.retained('other-group-writer' as SessionId)).toBe(0)
  })

  it('preserves native risk acknowledgement and cancellation before changing one group member', async () => {
    const b = await setup()
    await vi.waitFor(() => { expect(b.trigger()).toBeTruthy() })
    fireEvent.click(b.trigger())
    fireEvent.click(screen.getByRole('menuitem', { name: '完全权限' }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '启用完全权限' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(b.calls).toEqual([])
    chooseFullAccess(b.trigger())
    fireEvent.click(screen.getByRole('button', { name: '启用完全权限' }))
    await act(async () => {})
    expect(b.calls).toEqual([{ id: 'editorial-writer', line: '/permission danger-full-access' }])
  })

  it('releases member references and pending risk UI while settings are hidden or disconnected', async () => {
    const b = await setup()
    await vi.waitFor(() => { expect(b.trigger()).toBeTruthy() })
    chooseFullAccess(b.trigger())
    await b.change({ enabled: false })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(b.view.queryByRole('button', { name: /^访问模式/u })).toBeNull()
    expect(group.executors.map(item => b.retained(item.sessionId))).toEqual([0, 0])
    expect(b.calls).toEqual([])
    await b.change({ enabled: true })
    await vi.waitFor(() => { expect(b.trigger()).toBeTruthy() })
    expect(group.executors.map(item => b.retained(item.sessionId))).toEqual([1, 1])
  })

  it('removes a deselected member immediately and never acquires a newly drafted outsider before save', async () => {
    const b = await setup()
    await vi.waitFor(() => { expect(b.trigger()).toBeTruthy() })
    chooseFullAccess(b.trigger())
    await b.change({ selectedMemberIds: [reviewer.id, outsider.id] })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(b.view.queryByRole('group', { name: 'Writer的群内权限' })).toBeNull()
    expect(b.view.queryByRole('group', { name: 'Outsider的群内权限' })).toBeNull()
    expect(b.retained(group.executors[0]!.sessionId)).toBe(0)
    expect(b.retained(outsider.sessionId)).toBe(0)
    expect(b.calls).toEqual([])
  })

  it('switches a member to another group executor without retaining its previous confirmation', async () => {
    const b = await setup()
    await vi.waitFor(() => { expect(b.trigger()).toBeTruthy() })
    chooseFullAccess(b.trigger())
    const next: TeamChat = { ...group, id: 'second' as ChatId, rootSessionId: 'second-root' as SessionId,
      memberIds: [writer.id], executors: [{ botId: writer.id, sessionId: 'other-group-writer' as SessionId }] }
    await b.change({ chat: next })
    await vi.waitFor(() => { expect(b.trigger()).toBeTruthy() })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(b.retained(group.executors[0]!.sessionId)).toBe(0)
    expect(b.retained('other-group-writer' as SessionId)).toBe(1)
    fireEvent.click(b.trigger())
    fireEvent.click(screen.getByRole('menuitem', { name: '仅可查看' }))
    await act(async () => {})
    expect(b.calls).toEqual([{ id: 'other-group-writer', line: '/permission read-only' }])
  })

  it('shows unavailable instead of falling back when a group executor aliases private or root Session', async () => {
    const b = await setup()
    await b.change({ enabled: false })
    b.retainPermissionSession.mockClear()
    await b.change({ enabled: true, chat: { ...group, executors: [
      { botId: writer.id, sessionId: writer.sessionId }, { botId: reviewer.id, sessionId: group.rootSessionId },
    ] } })
    expect(b.view.queryByRole('button', { name: /^访问模式/u })).toBeNull()
    expect(b.retainPermissionSession).not.toHaveBeenCalled()
    expect(b.view.getAllByText(zh['permissions.unavailable'])).toHaveLength(3)
    expect(b.calls).toEqual([])
  })

  it('waits for readiness and discards an opening member scope when its row disappears', async () => {
    const b = await setup({ pending: true })
    expect(within(b.row()).queryByRole('button')).toBeNull()
    expect(within(b.row()).getByText(zh['permissions.loading'])).toBeTruthy()
    expect(b.retained(group.executors[0]!.sessionId)).toBe(1)
    await b.change({ selectedMemberIds: [reviewer.id] })
    expect(b.retained(group.executors[0]!.sessionId)).toBe(0)
    await act(async () => { b.opening.resolve(undefined) })
    expect(b.view.queryByRole('group', { name: 'Writer的群内权限' })).toBeNull()
    expect(b.calls).toEqual([])
  })

  it('reports failed Session opening and releases its retained scope', async () => {
    const b = await setup({ pending: true })
    await act(async () => { b.opening.reject(new Error('Synthetic member open rejected')) })
    expect(within(b.row()).getByText(zh['permissions.unavailable'])).toBeTruthy()
    expect(within(b.row()).queryByRole('button')).toBeNull()
    expect(b.retained(group.executors[0]!.sessionId)).toBe(0)
    expect(b.calls).toEqual([])
  })

  it('publishes an exact member provider only after its initial open succeeds', async () => {
    const b = await setup({ pending: true })
    expect(within(b.row()).queryByRole('button')).toBeNull()
    await act(async () => { b.opening.resolve(undefined) })
    expect(b.trigger().textContent).toBe('工作区内修改')
    fireEvent.click(b.trigger())
    fireEvent.click(screen.getByRole('menuitem', { name: '仅可查看' }))
    await act(async () => {})
    expect(b.calls).toEqual([{ id: 'editorial-writer', line: '/permission read-only' }])
  })

  it('releases a member removed from the saved roster even while a stale draft still selects it', async () => {
    const b = await setup()
    await vi.waitFor(() => { expect(b.trigger()).toBeTruthy() })
    chooseFullAccess(b.trigger())
    await b.change({ chat: { ...group, memberIds: [reviewer.id] } })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(b.view.queryByRole('group', { name: 'Writer的群内权限' })).toBeNull()
    expect(b.retained(group.executors[0]!.sessionId)).toBe(0)
    expect(b.calls).toEqual([])
  })

  it('leaves a missing executor unavailable without looking up another Session', async () => {
    const b = await setup()
    await b.change({ enabled: false })
    b.retainPermissionSession.mockClear()
    await b.change({ enabled: true, chat: { ...group, executors: [] } })
    expect(b.view.getAllByText(zh['permissions.unavailable'])).toHaveLength(3)
    expect(b.view.queryByRole('button', { name: /^访问模式/u })).toBeNull()
    expect(b.retainPermissionSession).not.toHaveBeenCalled()
    expect(b.calls).toEqual([])
  })

  it('contains synchronous membership refusal without opening any Session or creating native controls', async () => {
    const b = await setup({ rejectRetain: true })
    expect(b.view.getAllByText(zh['permissions.unavailable'])).toHaveLength(3)
    expect(b.view.queryByRole('button', { name: /^访问模式/u })).toBeNull()
    expect(group.executors.map(item => b.retained(item.sessionId))).toEqual([0, 0])
    expect(b.calls).toEqual([])
  })

  it('locks the native picker during settings saves and removes it when permissions disappear', async () => {
    const b = await setup()
    await vi.waitFor(() => { expect(b.trigger()).toBeTruthy() })
    chooseFullAccess(b.trigger())
    await b.change({ locked: true })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(b.trigger().disabled).toBe(true)
    await b.runtime.sessions.setProjection(group.executors[0]!.sessionId, 'permissions', undefined)
    expect(within(b.row()).queryByRole('button')).toBeNull()
    expect(within(b.row()).getByText(zh['permissions.unavailable'])).toBeTruthy()
    expect(b.calls).toEqual([])
  })

  it('keeps a private Bot picker on its private scope after closing group settings', async () => {
    const b = await setup()
    await b.change({ mode: 'private' })
    const trigger = b.view.getByRole('button', { name: /^访问模式/u })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: '仅可查看' }))
    await act(async () => {})
    expect(b.calls).toEqual([{ id: 'writer-private', line: '/permission read-only' }])
    expect(group.executors.map(item => b.retained(item.sessionId))).toEqual([0, 0])
  })
})
