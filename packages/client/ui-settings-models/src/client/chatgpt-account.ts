/** Shared ChatGPT account connection and model adoption, independent of Bot selections. */
import type {
  AuthorizationNotice, AuthorizationPromptId, AuthorizationRemoteEvent, AuthorizationPromptContent,
  CredentialKey, LlmDiscoveredModel,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelsOperations } from './operations.ts'
import type { ModelsSettingsStore } from './store.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'

/** The account's own record; OpenAI API-key credentials are never replaced. */
const ACCOUNT = 'llm-pi-ai/chatgpt' as CredentialKey
const PROVIDER_PATH = ['providers', 'chatgpt']

/** Redacted account and installed-model facts. */
export interface ChatGptAccountStatus {
  available: boolean
  connected: boolean
  writable: boolean
  modelCount: number
  configuredModelIds: readonly string[]
}

/** State rendered by the account connection card. No credential values enter this state. */
export interface ChatGptAccountState extends ChatGptAccountStatus {
  phase: 'idle' | 'loading' | 'ready' | 'authorizing' | 'syncing' | 'disconnecting'
  notice: AuthorizationNotice | null
  prompt: { id: AuthorizationPromptId; value: AuthorizationPromptContent } | null
  failure: 'connection' | 'catalog' | 'answer' | null
  candidates: readonly LlmDiscoveredModel[]
  selectedIds: readonly string[]
  tests: Readonly<Record<string, 'pending' | 'running' | 'passed' | 'failed'>>
}

/** Browser transport and settings writes used by the account controller. */
export interface ChatGptAccountOperations {
  /** Read redacted account and configured-model state. */
  read(): Promise<ChatGptAccountStatus>
  /** Start one user-requested authorization, cancelled with the supplied signal. */
  begin(signal: AbortSignal): AsyncIterable<AuthorizationRemoteEvent>
  /** Answer the current attempt's prompt. */
  answer(id: AuthorizationPromptId, answer: string): Promise<void>
  /** Withdraw this page's authorization attempt and wait for settlement. */
  cancel(): Promise<void>
  /** Remove only the ChatGPT account grant. */
  disconnect(): Promise<void>
  /** Fetch this account's current model choices. */
  discover(): Promise<readonly LlmDiscoveredModel[]>
  /** Confirm this exact account model accepts a minimal inference request. */
  verify(model: LlmDiscoveredModel, signal?: AbortSignal): Promise<void>
  /** Persist the dedicated account route, without changing any model selection. */
  adopt(models: readonly LlmDiscoveredModel[]): Promise<void>
}

/**
 * Bind account actions to the owning Remote services and the Models settings join.
 * @param ctx - Settings plugin declaring the authorization, LLM and settings namespaces.
 * @param models - Existing provider-settings controller.
 * @param operations - Existing revision-fenced settings and discovery operations.
 * @param schema - Settings-owned path access.
 * @returns Account operations that never expose access or refresh tokens.
 */
export function createChatGptAccountOperations(
  ctx: Context,
  models: ModelsSettingsStore,
  operations: ModelsOperations,
  schema: SettingsSchemaOperations,
): ChatGptAccountOperations {
  return {
    async read() {
      const [flow, status] = await Promise.all([
        ctx.remote.authorization.describe(ACCOUNT),
        ctx.remote.authorization.status(ACCOUNT),
        models.load(),
      ])
      if (!flow.ok || !status.ok) throw new Error('Account status is unavailable')
      const settings = models.store.getSnapshot()
      if (settings.status !== 'ready') throw new Error('Model settings are unavailable')
      const namespace = settings.namespaces.get('llm-pi-ai')
      const configuredModels = namespace === undefined ? undefined
        : schema.getPath(namespace.value, [...PROVIDER_PATH, 'models'])
      const configuredModelIds = Array.isArray(configuredModels) ? configuredModels.flatMap((model: unknown) =>
        typeof model === 'object' && model !== null && 'id' in model && typeof model.id === 'string' ? [model.id] : []) : []
      return {
        available: flow.value?.methods.some(method => method.id === 'oauth') === true,
        connected: status.value.configured && status.value.kind === 'grant',
        writable: status.value.writable && settings.writable,
        modelCount: configuredModelIds.length,
        configuredModelIds,
      }
    },
    begin: signal => ctx.remote.authorization.begin({ key: ACCOUNT, method: 'oauth' }, signal),
    async answer(id, answer) {
      const result = await ctx.remote.authorization.answer({ key: ACCOUNT, id, answer })
      if (!result.ok) throw new Error('Authorization answer was refused')
    },
    async cancel() {
      const result = await ctx.remote.authorization.cancelAttempt(ACCOUNT)
      if (!result.ok) throw new Error('Authorization cancellation was refused')
    },
    async disconnect() {
      const result = await ctx.remote.authorization.disconnect(ACCOUNT)
      if (!result.ok) throw new Error('Account disconnection was refused')
    },
    async discover() {
      const result = await operations.discoverModels('llm-pi-ai', { provider: 'chatgpt' })
      if (result.kind !== 'found' || result.models.length === 0) throw new Error('Account listed no available models')
      return result.models
    },
    async verify(model, signal) {
      const result = await ctx.remote.modelVerification.verify({ provider: 'chatgpt', model }, signal)
      if (!result.ok || result.value.status !== 'passed') throw new Error('Model connection test did not pass')
    },
    async adopt(choices) {
      await models.load()
      const namespace = models.store.getSnapshot().namespaces.get('llm-pi-ai')
      if (namespace === undefined) throw new Error('Model namespace is unavailable')
      const result = await operations.writeSettings('llm-pi-ai', [{
        op: 'set', path: PROVIDER_PATH,
        value: {
          displayName: 'ChatGPT', api: 'openai-responses', baseURL: 'https://api.openai.com/v1',
          models: choices.map(({ id, name, contextWindow, maxTokens, inputModalities }) => ({
            id, ...name === undefined ? {} : { name },
            ...contextWindow === undefined ? {} : { contextWindow },
            ...maxTokens === undefined ? {} : { maxTokens },
            ...inputModalities === undefined ? {} : { input: [...inputModalities] },
          })),
        },
      }], namespace.revision)
      if (result.kind !== 'written') throw new Error('Model settings write was refused')
      await models.load()
    },
  }
}

/** Account state and cancellation ownership shared across Models page mounts. */
export class ChatGptAccountController {
  /** Read-only presentation source bound by the slot renderer. */
  readonly store = createSnapshotStore<ChatGptAccountState>({
    available: false, connected: false, writable: false, modelCount: 0, configuredModelIds: [],
    phase: 'idle', notice: null, prompt: null, failure: null, candidates: [], selectedIds: [], tests: {},
  })
  private generation = 0
  private activity: AbortController | undefined
  private disposed = false

  constructor(private readonly operations: ChatGptAccountOperations) {}

  /** Refresh account facts after an explicit page open or an invalidation. */
  async load(): Promise<void> {
    if (this.disposed || this.busy()) return
    const generation = ++this.generation
    this.store.update((s) => { s.phase = 'loading'; s.failure = null })
    try {
      const status = await this.operations.read()
      if (!this.current(generation)) return
      this.store.update((s) => {
        Object.assign(s, status)
        if (!status.connected) { s.candidates = []; s.selectedIds = []; s.tests = {} }
        s.phase = 'ready'
      })
    } catch (_error) {
      // Provider diagnostics can contain credentials; only localized failure categories reach the card.
      this.fail(generation, 'connection')
    }
  }

  /** Start authorization only after the user chooses to connect or switch accounts. */
  async connect(): Promise<void> {
    if (this.disposed || this.busy()) return
    const generation = ++this.generation
    const attempt = new AbortController()
    this.activity = attempt
    this.store.update((s) => {
      s.phase = 'authorizing'; s.failure = null; s.notice = null; s.prompt = null
      s.candidates = []; s.selectedIds = []; s.tests = {}
    })
    let settlement: 'authorized' | 'cancelled' | undefined
    try {
      for await (const event of this.operations.begin(attempt.signal)) {
        if (!this.current(generation)) return
        if (event.type === 'notice') this.store.update((s) => { s.notice = event.notice })
        else if (event.type === 'prompt') this.store.update((s) => { s.prompt = { id: event.id, value: event.prompt } })
        else if (event.type === 'prompt-withdrawn') this.store.update((s) => { if (s.prompt?.id === event.id) s.prompt = null })
        else settlement = event.outcome.status
      }
      if (!this.current(generation)) return
      this.store.update((s) => { s.prompt = null; s.notice = null; s.phase = 'ready' })
      if (settlement === 'authorized') await this.refreshModels()
      else if (settlement === 'cancelled') await this.load()
      else this.fail(generation, 'connection')
    } catch (_error) {
      // The transport owns redaction; raw rejected values still never enter browser state.
      this.fail(generation, 'connection')
    } finally {
      if (this.activity === attempt) this.activity = undefined
    }
  }

  /** Fetch account candidates for explicit selection; discovery never changes the configured model list. */
  async refreshModels(): Promise<void> {
    if (this.disposed || this.busy()) return
    const generation = ++this.generation
    const previous = this.store.getSnapshot()
    this.store.update((s) => { s.phase = 'syncing'; s.failure = null })
    try {
      const choices = await this.operations.discover()
      if (!this.current(generation)) return
      const status = await this.operations.read()
      if (!this.current(generation)) return
      const selected = previous.candidates.length > 0 ? previous.selectedIds
        : status.configuredModelIds.length > 0 ? status.configuredModelIds : choices.map(model => model.id)
      this.store.update((s) => {
        Object.assign(s, status)
        s.candidates = status.connected ? [...choices] : []
        s.selectedIds = status.connected ? choices.filter(model => selected.includes(model.id)).map(model => model.id) : []
        s.tests = {}
        s.phase = 'ready'
      })
    } catch (_error) {
      // Keep a committed login available for retry when model discovery or a settings write fails.
      this.fail(generation, 'catalog')
      if (this.current(generation)) {
        try {
          const status = await this.operations.read()
          if (this.current(generation)) this.store.update((s) => { Object.assign(s, status) })
        } catch (_readError) { /* The visible catalog failure remains until the next explicit retry. */ }
      }
    }
  }

  /**
   * Toggle a discovered candidate in the local draft without writing settings.
   * @param id - Candidate model identity.
   */
  toggleModel(id: string): void {
    if (this.disposed || this.busy()) return
    const state = this.store.getSnapshot()
    if (!state.connected || !state.writable || !state.candidates.some(model => model.id === id)) return
    this.store.update((s) => {
      s.selectedIds = s.selectedIds.includes(id) ? s.selectedIds.filter(selected => selected !== id) : [...s.selectedIds, id]
    })
  }

  /** Save the non-empty candidate selection without choosing a model for any Bot or changing the application default. */
  async saveModels(): Promise<void> {
    if (this.disposed || this.busy()) return
    const state = this.store.getSnapshot()
    const choices = state.candidates.filter(model => state.selectedIds.includes(model.id))
    if (!state.connected || !state.writable || choices.length === 0) return
    const generation = ++this.generation
    const activity = new AbortController()
    this.activity = activity
    this.store.update((s) => {
      s.phase = 'syncing'; s.failure = null
      s.tests = Object.fromEntries(choices.map(model => [model.id, 'pending']))
    })
    try {
      for (const model of choices) {
        if (!this.current(generation)) return
        this.store.update((s) => { s.tests = { ...s.tests, [model.id]: 'running' } })
        try {
          await this.operations.verify(model, activity.signal)
        } catch (_error) {
          if (this.current(generation)) this.store.update((s) => { s.tests = { ...s.tests, [model.id]: 'failed' } })
          this.fail(generation, 'catalog')
          return
        }
        if (!this.current(generation)) return
        this.store.update((s) => { s.tests = { ...s.tests, [model.id]: 'passed' } })
      }
      await this.operations.adopt(choices)
      if (!this.current(generation)) return
      this.store.update((s) => { s.phase = 'ready' })
      await this.load()
    } catch (_error) {
      // Keep the candidate draft for an explicit retry; provider diagnostics never enter state.
      this.fail(generation, 'catalog')
    } finally {
      if (this.activity === activity) this.activity = undefined
    }
  }

  /** Submit only the currently displayed prompt; stale prompt answers are ignored. */
  async answer(id: AuthorizationPromptId, answer: string): Promise<void> {
    if (this.store.getSnapshot().prompt?.id !== id || this.disposed) return
    const generation = this.generation
    try {
      await this.operations.answer(id, answer)
      if (this.current(generation) && this.store.getSnapshot().prompt?.id === id) this.store.update((s) => { s.failure = null })
    }
    catch (_error) {
      if (this.current(generation)) this.store.update((s) => { s.failure = 'answer' })
    }
  }

  /** Cancel this page's sign-in without deleting an existing saved account. */
  async cancel(): Promise<void> {
    if (this.disposed) return
    await this.stopActivity(true)
  }

  /** Cancel page-owned interaction on close while preserving candidates for a later page mount. */
  async close(): Promise<void> {
    if (this.disposed) return
    await this.stopActivity(false)
  }

  /** Disconnect the shared account without deleting provider configurations or changing Bot choices. */
  async disconnect(): Promise<void> {
    if (this.disposed || this.busy()) return
    const generation = ++this.generation
    this.store.update((s) => { s.phase = 'disconnecting'; s.failure = null })
    try {
      await this.operations.disconnect()
      if (!this.current(generation)) return
      this.store.update((s) => { s.phase = 'ready' })
      await this.load()
    } catch (_error) { this.fail(generation, 'connection') }
  }

  /** Withdraw transport ownership when the settings plugin is unloaded. */
  dispose(): void {
    this.disposed = true
    ++this.generation
    this.activity?.abort()
  }

  private async stopActivity(reload: boolean): Promise<void> {
    const authorizing = this.store.getSnapshot().phase === 'authorizing'
    const generation = ++this.generation
    this.activity?.abort()
    this.activity = undefined
    try {
      if (authorizing) await this.operations.cancel()
      if (!this.current(generation)) return
      this.store.update((s) => {
        s.phase = 'ready'; s.prompt = null; s.notice = null
        s.tests = Object.fromEntries(Object.entries(s.tests).map(([id, status]) => [id, status === 'running' ? 'pending' : status]))
      })
      if (reload) await this.load()
    } catch (_error) { this.fail(generation, 'connection') }
  }

  private busy(): boolean {
    return ['authorizing', 'syncing', 'disconnecting'].includes(this.store.getSnapshot().phase)
  }

  private current(generation: number): boolean { return !this.disposed && generation === this.generation }

  private fail(generation: number, failure: ChatGptAccountState['failure']): void {
    if (this.current(generation)) this.store.update((s) => { s.phase = 'ready'; s.failure = failure; s.prompt = null })
  }
}
