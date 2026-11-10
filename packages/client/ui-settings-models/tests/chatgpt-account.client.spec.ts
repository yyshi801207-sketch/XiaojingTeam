/** Shared account authorization, candidate selection and verification without network requests. */
import { describe, expect, it, vi } from 'vitest'
import type { AuthorizationPromptId, AuthorizationRemoteEvent, LlmDiscoveredModel } from '@deepseek-ai/dsh-api-remotes/client'
import { ChatGptAccountController, type ChatGptAccountOperations, type ChatGptAccountStatus } from '../src/client/chatgpt-account.ts'

const choices: readonly LlmDiscoveredModel[] = [
  { id: 'fixture-fast', name: 'Fixture Fast', contextWindow: 100_000, maxTokens: 5_000 },
  { id: 'fixture-review', name: 'Fixture Review', inputModalities: ['text', 'image'] },
]
const authorized: AuthorizationRemoteEvent = { type: 'settled', outcome: { status: 'authorized' } }
const promptId = 'current-prompt' as AuthorizationPromptId
const prompt: AuthorizationRemoteEvent = { type: 'prompt', id: promptId, prompt: { kind: 'text', message: 'Enter code' } }

function harness(initial: Partial<ChatGptAccountStatus> = {}) {
  let status: ChatGptAccountStatus = { available: true, connected: false, writable: true, modelCount: 0,
    configuredModelIds: [], ...initial }
  const operations = {
    read: vi.fn<ChatGptAccountOperations['read']>(async () => ({ ...status })),
    begin: vi.fn<ChatGptAccountOperations['begin']>(async function* () { status = { ...status, connected: true }; yield authorized }),
    answer: vi.fn<ChatGptAccountOperations['answer']>(async () => {}),
    cancel: vi.fn<ChatGptAccountOperations['cancel']>(async () => {}),
    disconnect: vi.fn<ChatGptAccountOperations['disconnect']>(async () => { status = { ...status, connected: false } }),
    discover: vi.fn<ChatGptAccountOperations['discover']>(async () => choices),
    verify: vi.fn<ChatGptAccountOperations['verify']>(async () => {}),
    adopt: vi.fn<ChatGptAccountOperations['adopt']>(async (models) => {
      status = { ...status, configuredModelIds: models.map(model => model.id), modelCount: models.length }
    }),
  }
  return { operations, controller: new ChatGptAccountController(operations),
    setStatus: (patch: Partial<ChatGptAccountStatus>) => { status = { ...status, ...patch } } }
}

function attempt(initial: readonly AuthorizationRemoteEvent[] = []) {
  const tail = Promise.withResolvers<readonly AuthorizationRemoteEvent[]>()
  let signal: AbortSignal | undefined
  const begin: ChatGptAccountOperations['begin'] = input => (async function* () {
    signal = input
    for (const event of initial) yield event
    for (const event of await tail.promise) yield event
  })()
  return { begin, tail, signal: () => signal }
}

describe('ChatGptAccountController', () => {
  it('discovers shared candidates after authorization without adopting or testing them automatically', async () => {
    const b = harness()
    await b.controller.load()
    await b.controller.connect()
    expect(b.controller.store.getSnapshot()).toMatchObject({
      connected: true, phase: 'ready', candidates: choices, selectedIds: choices.map(model => model.id), modelCount: 0, tests: {},
    })
    expect(b.operations.discover).toHaveBeenCalledOnce()
    expect(b.operations.verify).not.toHaveBeenCalled()
    expect(b.operations.adopt).not.toHaveBeenCalled()
  })

  it('verifies and saves only the selected candidates, leaving model selection to each Bot', async () => {
    const b = harness()
    await b.controller.connect()
    b.controller.toggleModel(choices[0]!.id)
    await b.controller.saveModels()
    expect(b.operations.verify).toHaveBeenCalledExactlyOnceWith(choices[1], expect.any(AbortSignal))
    expect(b.operations.adopt).toHaveBeenCalledExactlyOnceWith([choices[1]])
    const state = b.controller.store.getSnapshot()
    expect({ connected: state.connected, configuredModelIds: state.configuredModelIds,
      modelCount: state.modelCount, selectedIds: state.selectedIds, tests: state.tests }).toMatchInlineSnapshot(`
        {
          "configuredModelIds": [
            "fixture-review",
          ],
          "connected": true,
          "modelCount": 1,
          "selectedIds": [
            "fixture-review",
          ],
          "tests": {
            "fixture-review": "passed",
          },
        }
      `)
  })

  it('restores configured choices and preserves an edited selection while refreshing candidates', async () => {
    const b = harness({ connected: true, configuredModelIds: [choices[1]!.id], modelCount: 1 })
    await b.controller.refreshModels()
    expect(b.controller.store.getSnapshot().selectedIds).toEqual([choices[1]!.id])
    b.controller.toggleModel(choices[0]!.id)
    b.controller.toggleModel('not-a-candidate')
    await b.controller.refreshModels()
    expect(b.controller.store.getSnapshot().selectedIds).toEqual(choices.map(model => model.id))
    expect(b.operations.adopt).not.toHaveBeenCalled()
  })

  it('does not replace unavailable configured choices with an automatic selection', async () => {
    const b = harness({ connected: true, configuredModelIds: ['retired-fixture'], modelCount: 1 })
    await b.controller.refreshModels()
    expect(b.controller.store.getSnapshot().selectedIds).toEqual([])
    await b.controller.saveModels()
    expect(b.operations.verify).not.toHaveBeenCalled()
    expect(b.operations.adopt).not.toHaveBeenCalled()
  })

  it('tests selected models in order and adopts nothing until every test has passed', async () => {
    const b = harness()
    await b.controller.connect()
    const first = Promise.withResolvers<undefined>()
    const second = Promise.withResolvers<undefined>()
    b.operations.verify.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const saving = b.controller.saveModels()
    expect(b.controller.store.getSnapshot()).toMatchObject({ phase: 'syncing', tests: {
      'fixture-fast': 'running', 'fixture-review': 'pending',
    } })
    b.controller.toggleModel(choices[1]!.id)
    await b.controller.connect()
    await b.controller.disconnect()
    await b.controller.refreshModels()
    expect(b.controller.store.getSnapshot().selectedIds).toEqual(choices.map(model => model.id))
    expect(b.operations.adopt).not.toHaveBeenCalled()
    first.resolve(undefined)
    await vi.waitFor(() => { expect(b.operations.verify).toHaveBeenCalledTimes(2) })
    expect(b.controller.store.getSnapshot().tests).toEqual({ 'fixture-fast': 'passed', 'fixture-review': 'running' })
    expect(b.operations.adopt).not.toHaveBeenCalled()
    second.resolve(undefined)
    await saving
    expect(b.operations.adopt).toHaveBeenCalledExactlyOnceWith(choices)
    expect(b.operations.begin).toHaveBeenCalledOnce()
    expect(b.operations.disconnect).not.toHaveBeenCalled()
  })

  it('retains the old configured list on a failed model test and retests the full selection on retry', async () => {
    const b = harness({ connected: true, configuredModelIds: [choices[0]!.id], modelCount: 1 })
    await b.controller.refreshModels()
    b.controller.toggleModel(choices[1]!.id)
    b.operations.verify.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('sensitive provider diagnostic'))
    await b.controller.saveModels()
    expect(b.controller.store.getSnapshot()).toMatchObject({ phase: 'ready', failure: 'catalog', modelCount: 1,
      configuredModelIds: [choices[0]!.id], tests: { 'fixture-fast': 'passed', 'fixture-review': 'failed' } })
    expect(b.operations.adopt).not.toHaveBeenCalled()
    expect(JSON.stringify(b.controller.store.getSnapshot())).not.toContain('sensitive provider diagnostic')
    await b.controller.saveModels()
    expect(b.operations.verify).toHaveBeenCalledTimes(4)
    expect(b.operations.adopt).toHaveBeenCalledExactlyOnceWith(choices)
  })

  it('keeps the candidate draft and saved count when adoption fails', async () => {
    const b = harness({ connected: true, configuredModelIds: [choices[0]!.id], modelCount: 1 })
    await b.controller.refreshModels()
    b.controller.toggleModel(choices[1]!.id)
    b.operations.adopt.mockRejectedValueOnce(new Error('write refused'))
    await b.controller.saveModels()
    expect(b.controller.store.getSnapshot()).toMatchObject({ connected: true, modelCount: 1, phase: 'ready', failure: 'catalog',
      candidates: choices, selectedIds: choices.map(model => model.id) })
    await b.controller.saveModels()
    expect(b.controller.store.getSnapshot()).toMatchObject({ modelCount: 2, failure: null })
  })

  it('does not save an empty candidate selection', async () => {
    const b = harness()
    await b.controller.connect()
    for (const choice of choices) b.controller.toggleModel(choice.id)
    await b.controller.saveModels()
    expect(b.operations.verify).not.toHaveBeenCalled()
    expect(b.operations.adopt).not.toHaveBeenCalled()
  })

  it.each(['disconnected', 'read-only'] as const)('does not adopt choices while %s', async (reason) => {
    const b = harness()
    await b.controller.connect()
    b.setStatus(reason === 'disconnected' ? { connected: false } : { writable: false })
    await b.controller.load()
    await b.controller.saveModels()
    expect(b.operations.verify).not.toHaveBeenCalled()
    expect(b.operations.adopt).not.toHaveBeenCalled()
  })

  it('keeps a committed login when discovery fails and discovers again only on an explicit retry', async () => {
    const b = harness()
    b.operations.discover.mockRejectedValueOnce(new Error('sensitive endpoint failure'))
    await b.controller.connect()
    expect(b.controller.store.getSnapshot()).toMatchObject({ connected: true, phase: 'ready', failure: 'catalog', candidates: [] })
    expect(b.operations.adopt).not.toHaveBeenCalled()
    await b.controller.refreshModels()
    expect(b.controller.store.getSnapshot()).toMatchObject({ connected: true, failure: null, candidates: choices })
    expect(b.operations.discover).toHaveBeenCalledTimes(2)
    expect(b.operations.adopt).not.toHaveBeenCalled()
  })

  it.each(['rejected', 'unsettled'] as const)('does not treat a %s authorization stream as success', async (ending) => {
    const b = harness()
    b.operations.begin.mockImplementationOnce(async function* () {
      yield { type: 'notice', notice: { message: 'Open sign-in', url: 'https://example.test/sign-in' } }
      if (ending === 'rejected') throw new Error('sensitive authorization diagnostic')
    })
    await b.controller.connect()
    expect(b.controller.store.getSnapshot()).toMatchObject({ connected: false, phase: 'ready', failure: 'connection', candidates: [] })
    expect(b.operations.discover).not.toHaveBeenCalled()
    expect(b.operations.adopt).not.toHaveBeenCalled()
    expect(JSON.stringify(b.controller.store.getSnapshot())).not.toContain('sensitive authorization diagnostic')
  })

  it('preserves an existing grant when authorization settles as cancelled', async () => {
    const b = harness({ connected: true })
    b.operations.begin.mockImplementationOnce(async function* () { yield { type: 'settled', outcome: { status: 'cancelled' } } })
    await b.controller.connect()
    expect(b.controller.store.getSnapshot()).toMatchObject({ connected: true, phase: 'ready', failure: null })
    expect(b.operations.discover).not.toHaveBeenCalled()
    expect(b.operations.disconnect).not.toHaveBeenCalled()
  })

  it('cancels the owning attempt and ignores a late authorization settlement', async () => {
    const b = harness()
    const running = attempt([prompt])
    b.operations.begin.mockImplementationOnce(running.begin)
    const connecting = b.controller.connect()
    await vi.waitFor(() => { expect(b.controller.store.getSnapshot().prompt?.id).toBe(promptId) })
    await b.controller.load()
    expect(b.operations.read).not.toHaveBeenCalled()
    await b.controller.cancel()
    expect(running.signal()?.aborted).toBe(true)
    running.tail.resolve([authorized])
    await connecting
    expect(b.controller.store.getSnapshot()).toMatchObject({ phase: 'ready', connected: false, prompt: null, notice: null })
    expect(b.operations.cancel).toHaveBeenCalledOnce()
    expect(b.operations.disconnect).not.toHaveBeenCalled()
    expect(b.operations.discover).not.toHaveBeenCalled()
  })

  it('retains the current prompt after an answer refusal and ignores stale prompt answers', async () => {
    const b = harness()
    const running = attempt([prompt])
    b.operations.begin.mockImplementationOnce(running.begin)
    const connecting = b.controller.connect()
    await vi.waitFor(() => { expect(b.controller.store.getSnapshot().prompt?.id).toBe(promptId) })
    await b.controller.answer('stale' as AuthorizationPromptId, 'ignored')
    expect(b.operations.answer).not.toHaveBeenCalled()
    b.operations.answer.mockRejectedValueOnce(new Error('sensitive prompt diagnostic'))
    await b.controller.answer(promptId, 'first')
    expect(b.controller.store.getSnapshot()).toMatchObject({ phase: 'authorizing', failure: 'answer', prompt: { id: promptId } })
    await b.controller.answer(promptId, 'retry')
    expect(b.controller.store.getSnapshot().failure).toBeNull()
    running.tail.resolve([{ type: 'prompt-withdrawn', id: promptId }, { type: 'settled', outcome: { status: 'cancelled' } }])
    await connecting
    expect(b.controller.store.getSnapshot().prompt).toBeNull()
  })

  it('keeps a newer account read when an older read completes afterwards', async () => {
    const b = harness()
    const old = Promise.withResolvers<ChatGptAccountStatus>()
    const fresh = Promise.withResolvers<ChatGptAccountStatus>()
    b.operations.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const first = b.controller.load()
    const second = b.controller.load()
    const status = { available: true, connected: true, writable: true, modelCount: 1, configuredModelIds: [choices[1]!.id] }
    fresh.resolve(status)
    await second
    old.resolve({ ...status, connected: false, modelCount: 0, configuredModelIds: [] })
    await first
    expect(b.controller.store.getSnapshot()).toMatchObject(status)
  })

  it('does not let a pre-disconnect read restore a removed grant', async () => {
    const b = harness({ connected: true })
    const pending = Promise.withResolvers<ChatGptAccountStatus>()
    b.operations.read.mockReturnValueOnce(pending.promise)
    const loading = b.controller.load()
    await b.controller.disconnect()
    pending.resolve({ available: true, connected: true, writable: true, modelCount: 0, configuredModelIds: [] })
    await loading
    expect(b.controller.store.getSnapshot()).toMatchObject({ phase: 'ready', connected: false, candidates: [] })
    expect(b.operations.disconnect).toHaveBeenCalledOnce()
    expect(b.operations.adopt).not.toHaveBeenCalled()
  })

  it('reports a refused disconnect while retaining the known account', async () => {
    const b = harness({ connected: true })
    await b.controller.load()
    b.operations.disconnect.mockRejectedValueOnce(new Error('disconnect refused'))
    await b.controller.disconnect()
    expect(b.controller.store.getSnapshot()).toMatchObject({ phase: 'ready', connected: true, failure: 'connection' })
  })

  it('does not publish a pending read or issue later actions after disposal', async () => {
    const b = harness()
    const pending = Promise.withResolvers<ChatGptAccountStatus>()
    b.operations.read.mockReturnValueOnce(pending.promise)
    const loading = b.controller.load()
    b.controller.dispose()
    const closed = b.controller.store.getSnapshot()
    pending.resolve({ available: true, connected: true, writable: true, modelCount: 0, configuredModelIds: [] })
    await loading
    await b.controller.load()
    await b.controller.connect()
    await b.controller.cancel()
    await b.controller.disconnect()
    await b.controller.refreshModels()
    await b.controller.saveModels()
    b.controller.toggleModel(choices[0]!.id)
    expect(b.controller.store.getSnapshot()).toEqual(closed)
    expect(b.operations.read).toHaveBeenCalledOnce()
    expect(b.operations.begin).not.toHaveBeenCalled()
    expect(b.operations.cancel).not.toHaveBeenCalled()
    expect(b.operations.disconnect).not.toHaveBeenCalled()
    expect(b.operations.discover).not.toHaveBeenCalled()
  })

  it('aborts an owned authorization and ignores its events after disposal', async () => {
    const b = harness()
    const running = attempt([prompt])
    b.operations.begin.mockImplementationOnce(running.begin)
    const connecting = b.controller.connect()
    await vi.waitFor(() => { expect(b.controller.store.getSnapshot().prompt?.id).toBe(promptId) })
    b.controller.dispose()
    const closed = b.controller.store.getSnapshot()
    expect(running.signal()?.aborted).toBe(true)
    running.tail.resolve([authorized])
    await connecting
    expect(b.controller.store.getSnapshot()).toEqual(closed)
    expect(b.operations.discover).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'close', 'dispose'] as const)('does not adopt or continue testing after %s supersedes verification', async (ending) => {
    const b = harness()
    await b.controller.connect()
    const pending = Promise.withResolvers<undefined>()
    b.operations.verify.mockReturnValueOnce(pending.promise)
    const saving = b.controller.saveModels()
    if (ending === 'cancel') await b.controller.cancel()
    else if (ending === 'close') await b.controller.close()
    else b.controller.dispose()
    expect(b.operations.verify.mock.calls[0]?.[1]?.aborted).toBe(true)
    const stopped = b.controller.store.getSnapshot()
    pending.resolve(undefined)
    await saving
    expect(b.controller.store.getSnapshot()).toEqual(stopped)
    expect(b.operations.verify).toHaveBeenCalledOnce()
    expect(b.operations.adopt).not.toHaveBeenCalled()
  })

  it('withdraws an authorization when the page closes and permits a new connection after reopening', async () => {
    const b = harness()
    const running = attempt([prompt])
    const cancelled = Promise.withResolvers<undefined>()
    b.operations.begin.mockImplementationOnce(running.begin)
    b.operations.cancel.mockReturnValueOnce(cancelled.promise)
    const connecting = b.controller.connect()
    await vi.waitFor(() => { expect(b.controller.store.getSnapshot().prompt?.id).toBe(promptId) })
    const closing = b.controller.close()
    expect(running.signal()?.aborted).toBe(true)
    expect(b.controller.store.getSnapshot().phase).toBe('authorizing')
    cancelled.resolve(undefined)
    await closing
    running.tail.resolve([authorized])
    await connecting
    expect(b.controller.store.getSnapshot()).toMatchObject({ phase: 'ready', connected: false, prompt: null })
    expect(b.operations.read).not.toHaveBeenCalled()
    await b.controller.load()
    await b.controller.connect()
    expect(b.controller.store.getSnapshot()).toMatchObject({ connected: true, candidates: choices })
    expect(b.operations.begin).toHaveBeenCalledTimes(2)
  })

  it('invalidates a pending status read on close without preventing the next page load', async () => {
    const b = harness()
    const pending = Promise.withResolvers<ChatGptAccountStatus>()
    b.operations.read.mockReturnValueOnce(pending.promise)
    const loading = b.controller.load()
    await b.controller.close()
    const closed = b.controller.store.getSnapshot()
    pending.resolve({ available: true, connected: true, writable: true, modelCount: 0, configuredModelIds: [] })
    await loading
    expect(b.controller.store.getSnapshot()).toEqual(closed)
    b.setStatus({ connected: true })
    await b.controller.load()
    expect(b.controller.store.getSnapshot()).toMatchObject({ connected: true, phase: 'ready' })
    expect(b.operations.cancel).not.toHaveBeenCalled()
  })

  it('does not publish a save result after the page closes during an accepted settings write', async () => {
    const b = harness()
    await b.controller.connect()
    const pending = Promise.withResolvers<undefined>()
    b.operations.adopt.mockReturnValueOnce(pending.promise)
    const saving = b.controller.saveModels()
    await vi.waitFor(() => { expect(b.operations.adopt).toHaveBeenCalledOnce() })
    await b.controller.close()
    const closed = b.controller.store.getSnapshot()
    const reads = b.operations.read.mock.calls.length
    pending.resolve(undefined)
    await saving
    expect(b.controller.store.getSnapshot()).toEqual(closed)
    expect(b.operations.read).toHaveBeenCalledTimes(reads)
  })
})
