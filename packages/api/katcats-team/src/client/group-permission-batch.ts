/** Visible group-settings ownership of exact, sequential permission commands. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { CommandExecution } from '@deepseek-ai/dsh-commands/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamView } from './model.ts'
import type { ChatView } from './chat-model.ts'
import type { PermissionMemberTarget, PermissionSessionRetainer } from './PermissionSettings.tsx'

/** A saved ordinary member, with its name captured for the operation report. */
export interface GroupPermissionTarget extends PermissionMemberTarget { readonly name: string }
/** Only a confirmed command success is reported as applied. */
export interface GroupPermissionResult {
  readonly target: GroupPermissionTarget
  readonly status: 'success' | 'failed' | 'not-run' | 'unknown'
}
/** Read-only batch state; no Session or mutable reference reaches a component. */
export interface GroupPermissionBatchView {
  readonly targetKey: string
  readonly targetLabel: string
  readonly targets: readonly GroupPermissionTarget[]
  readonly ready: boolean
  readonly currentValue: string | null
  readonly allowNoApproval: boolean
  readonly busy: boolean
  readonly results: readonly GroupPermissionResult[]
}
/** Public dependencies owned by the settings occurrence, never a selected global Session. */
export interface GroupPermissionBatchOptions {
  readonly rootSessionId: SessionId
  readonly directory: ObservableSnapshot<TeamView>
  readonly chats: ObservableSnapshot<ChatView>
  readonly connection: Pick<ConnectionHandle, 'state' | 'generation'>
  readonly retain: PermissionSessionRetainer
  readonly binding: (id: SessionId) => SessionBinding | undefined
  readonly capability: (id: SessionId) => ObservableSnapshot<boolean>
  readonly execute: (id: SessionId, line: string, signal: AbortSignal) => Promise<RemoteResult<CommandExecution | undefined>>
}
/** A settings occurrence acquires resources only while its visible, saved form is enabled. */
export interface GroupPermissionBatch {
  readonly state: ObservableSnapshot<GroupPermissionBatchView>
  /** Acquire all saved member Sessions until this visibility signal aborts. */
  readonly activate: (signal: AbortSignal) => void
  /** Execute against the captured confirmation target, stopping after the first unconfirmed result. */
  readonly apply: (preset: string, targetKey: string) => Promise<void>
  /** Stop future dispatch; an already dispatched command can have an unknown outcome. */
  readonly cancel: () => void
}

interface Capture { readonly key: string; readonly label: string; readonly targets: readonly GroupPermissionTarget[] }
interface Retained {
  readonly target: GroupPermissionTarget
  readonly binding: SessionBinding
  readonly capability: ObservableSnapshot<boolean>
}
const EMPTY: GroupPermissionBatchView = {
  targetKey: '', targetLabel: '', targets: [], ready: false, currentValue: null,
  allowNoApproval: false, busy: false, results: [],
}

/**
 * Retain every target before offering one confirmation and dispatch only to its exact binding.
 * @param options - Public Session, projection, access and command services for this occurrence.
 * @returns Read-only view and visibility-scoped operations; aborting visibility releases all subscriptions and references.
 */
export function createGroupPermissionBatch(options: GroupPermissionBatchOptions): GroupPermissionBatch {
  const state = createSnapshotStore<GroupPermissionBatchView>(EMPTY)
  let revision = 0
  let visible: { signal: AbortSignal; stop: () => void } | undefined
  let releaseTargets = (): void => {}
  let captured: Capture | undefined
  let retained: readonly Retained[] = []
  let operation: AbortController | undefined
  const cancel = (): void => { operation?.abort() }
  const read = (): Capture | undefined => {
    const team = options.directory.getSnapshot()
    const groups = options.chats.getSnapshot()
    const generation = options.connection.generation.getSnapshot()
    if (options.connection.state.getSnapshot() !== 'connected' || generation === undefined
      || team.phase !== 'ready' || groups.phase !== 'ready') return
    const chat = groups.snapshot?.chats.find(item => item.rootSessionId === options.rootSessionId)
    const bots = team.snapshot?.bots
    if (chat === undefined || bots === undefined) return
    const targets: GroupPermissionTarget[] = []
    for (const id of chat.memberIds) {
      const bot = bots.find(item => item.id === id)
      const executor = chat.executors.find(item => item.botId === id)
      if (bot?.kind !== 'ordinary' || executor === undefined || executor.sessionId === chat.rootSessionId
        || bots.some(item => item.sessionId === executor.sessionId)
        || targets.some(item => item.sessionId === executor.sessionId)
        || groups.snapshot?.chats.some(item => item.id !== chat.id
          && (item.rootSessionId === executor.sessionId || item.executors.some(worker => worker.sessionId === executor.sessionId)))) return
      targets.push({ chatId: chat.id, botId: bot.id, sessionId: executor.sessionId, name: bot.name })
    }
    if (targets.length === 0) return
    return { key: JSON.stringify([generation.id, chat.id, chat.name, targets]), label: chat.name, targets }
  }
  const inspect = (): void => {
    const current = state.getSnapshot()
    const values: string[] = []
    let ready = captured !== undefined && retained.length > 0 && retained.length === captured.targets.length
      && read()?.key === captured.key
    let allowNoApproval = ready
    for (const item of retained) {
      const session = item.binding.session
      const permission = session.projections.faceOf('permissions').getSnapshot()
      const preset = session.projections.faceOf('agentPreset').getSnapshot()
      const value = typeof permission === 'object' && permission !== null && 'currentValue' in permission
        && typeof permission.currentValue === 'string' ? permission.currentValue : undefined
      const usable = item.binding.sessionId === item.target.sessionId && options.binding(item.target.sessionId) === item.binding
        && session.getSnapshot().openState === 'open' && item.capability.getSnapshot()
        && value !== undefined && typeof preset === 'string'
      ready &&= usable
      allowNoApproval &&= usable && preset !== 'finance'
      if (value !== undefined) values.push(value)
    }
    if (!ready && operation !== undefined) cancel()
    const currentValue = ready && values.every(value => value === values[0]) ? values[0] ?? null : null
    state.set({ ...current, ready, currentValue, allowNoApproval: ready && allowNoApproval,
      ...current.ready && !ready ? { targetKey: `${captured?.key ?? ''}:${++revision}` } : {} })
  }
  const sync = (): void => {
    const next = read()
    if (captured?.key === next?.key) { inspect(); return }
    cancel()
    releaseTargets()
    retained = []
    captured = next
    const key = `${next?.key ?? ''}:${++revision}`
    state.set({ ...state.getSnapshot(), targetKey: key, targetLabel: next?.label ?? '', targets: next?.targets ?? [],
      ready: false, currentValue: null, allowNoApproval: false })
    if (next === undefined || visible === undefined) return
    const lifetime = new AbortController()
    const stops: Array<() => void> = []
    let released = false
    releaseTargets = (): void => {
      if (released) return
      released = true
      lifetime.abort()
      for (const stop of stops.splice(0)) stop()
    }
    try {
      const references = next.targets.map((target) => {
        const reference = options.retain(target, lifetime.signal)
        stops.push(() => { reference.release() })
        return { target, reference }
      })
      const openings = references.map(({ target, reference }) => reference.ready.then(binding => ({ target, binding })))
      void Promise.all(openings).then((bindings) => {
        if (lifetime.signal.aborted || captured !== next) return
        retained = bindings.map(({ target, binding }) => {
          const capability = options.capability(target.sessionId)
          stops.push(binding.session.subscribe(inspect), capability.subscribe(inspect),
            binding.session.projections.faceOf('permissions').subscribe(inspect),
            binding.session.projections.faceOf('agentPreset').subscribe(inspect))
          return { target, binding, capability }
        })
        inspect()
      }, (_error: unknown) => {
        // A failed opening never admits a command; release every successful acquisition too.
        if (lifetime.signal.aborted) return
        releaseTargets()
        retained = []
        inspect()
      })
    } catch (_error) {
      // Synchronous acquisition refusal leaves the whole batch unavailable.
      releaseTargets()
      retained = []
      inspect()
    }
  }
  const activate = (signal: AbortSignal): void => {
    visible?.stop()
    if (signal.aborted) return
    const stops: Array<() => void> = []
    const stop = (): void => {
      signal.removeEventListener('abort', stop)
      if (visible?.signal !== signal) return
      cancel()
      for (const dispose of stops) dispose()
      releaseTargets()
      retained = []
      captured = undefined
      visible = undefined
      state.set({ ...state.getSnapshot(), ready: false, currentValue: null, allowNoApproval: false,
        targetKey: `hidden:${++revision}` })
    }
    visible = { signal, stop }
    signal.addEventListener('abort', stop, { once: true })
    stops.push(options.directory.subscribe(sync), options.chats.subscribe(sync),
      options.connection.state.subscribe(sync), options.connection.generation.subscribe(sync))
    sync()
  }
  const apply = async (preset: string, targetKey: string): Promise<void> => {
    inspect()
    const initial = state.getSnapshot()
    if (!initial.ready || initial.busy || initial.targetKey !== targetKey) return
    if (preset === 'xiaojing-no-approval' && !initial.allowNoApproval) return
    const controller = new AbortController()
    operation = controller
    const targets = [...retained]
    const results: GroupPermissionResult[] = targets.map(item => ({ target: item.target, status: 'not-run' }))
    state.set({ ...initial, busy: true, results: [...results] })
    try {
      for (const [index, item] of targets.entries()) {
        inspect()
        const view = state.getSnapshot()
        if (controller.signal.aborted || !view.ready || view.targetKey !== targetKey
          || preset === 'xiaojing-no-approval' && !view.allowNoApproval) break
        let status: GroupPermissionResult['status'] = 'unknown'
        try {
          const result = await abortable(options.execute(item.target.sessionId, `/permission ${preset}`, controller.signal), controller.signal)
          controller.signal.throwIfAborted()
          if (result.ok) {
            if (result.value === undefined) status = 'failed'
            else if (result.value.result.kind === 'success') status = 'success'
            // A command's error result can follow a partial side effect: keep its outcome unconfirmed.
          }
        } catch (_error) {
          // The request may already have changed permissions. Preserve uncertainty and stop dispatch.
        }
        results[index] = { target: item.target, status }
        state.set({ ...state.getSnapshot(), results: [...results] })
        if (status !== 'success') break
      }
    } finally {
      if (operation === controller) operation = undefined
      state.set({ ...state.getSnapshot(), busy: false })
    }
  }
  return { state, activate, apply, cancel }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = (): void => { reject(new Error('Group permission operation cancelled')) }
    if (signal.aborted) aborted()
    else signal.addEventListener('abort', aborted, { once: true })
    void promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', aborted) })
  })
}
