/** Explicit candidate tests in an independent Agent world, persisted through the Host's session store. */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-credentials'
import LlmRuntime, { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { createChatGPTAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import SessionStore, { type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import SessionPersistence, {
  type SessionAccess, type SessionHandle, type SessionPersistenceCreateOptions, type SessionPersistenceListOptions,
  type SessionPersistenceOpenOptions, type SessionPersistenceSnapshot, type SessionPersistenceStatOptions,
} from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry, { type ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { principalOf, Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type { ModelVerificationRequest, ModelVerificationResult } from './types.ts'

interface VerificationState {
  nonempty: boolean
  status: 'pending' | ModelVerificationResult['status']
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    modelVerification: ModelVerificationService
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    modelVerification: VerificationState
  }
}

const verification: ProjectionDefinition<'modelVerification'> = {
  key: 'modelVerification',
  stateVersion: 1,
  stateSchema: z.object({ nonempty: z.boolean(), status: z.enum(['pending', 'passed', 'failed', 'cancelled']) }),
  init: () => ({ nonempty: false, status: 'pending' }),
  apply: (state, event) => {
    switch (event.type) {
      case 'assistant/message':
        return {
          ...state,
          nonempty: event.data.interrupted !== true
            && event.data.message.content.some(block => block.type === 'text' && block.text.trim().length > 0),
        }
      case 'turn/end':
        return {
          ...state,
          status: event.data.reason.kind === 'aborted' ? 'cancelled'
            : event.data.reason.kind === 'completed' && state.nonempty ? 'passed' : 'failed',
        }
      default:
        return state
    }
  },
}

/** Route only this world's original events into the Host-owned backing handles. */
class VerificationPersistence extends SessionPersistence {
  private writer: SessionHandle | undefined
  private queued: Promise<void> = Promise.resolve()

  constructor(ctx: Context, private readonly backing: SessionPersistence) {
    super(ctx)
    ctx.on('session/event', (session, event) => {
      const writer = this.writer
      if (writer === undefined || writer.id !== session.id) return
      this.queued = this.queued.then(() => writer.append([event]))
      void this.queued.catch((_queuedWriteFailure: unknown) => {
        // The operation's flush and handle close report this rejection after draining.
      })
    })
    ctx.on('session/flush', () => this.flush())
  }

  override async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    const writer = this.writer = await this.backing.create(header, options)
    const close = async (): Promise<void> => {
      try { await this.queued } finally { await writer.close() }
    }
    return {
      id: writer.id, header: writer.header, inheritedEventCount: writer.inheritedEventCount, access: writer.access,
      read: (...args) => writer.read(...args),
      append: (...args) => writer.append(...args),
      flush: (...args) => writer.flush(...args),
      close,
      [Symbol.asyncDispose]: close,
    }
  }

  override open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    return this.backing.open(id, access, options)
  }

  override async flush(): Promise<void> {
    await this.queued
    await this.writer?.flush()
  }

  override stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined> {
    return this.backing.stat(id, options)
  }

  override list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    return this.backing.list(options)
  }
}

/** Owns user-requested verification; no test modifies the application's model routes. */
export class ModelVerificationService extends TypertRemoteService {
  static inject = ['credentials', 'sessionPersistence']

  private readonly closing = new AbortController()
  private readonly pending = new Set<Promise<ModelVerificationResult>>()

  constructor(ctx: Context) {
    super(ctx, 'modelVerification')
    ctx.effect(() => async () => {
      this.closing.abort()
      const results = await Promise.allSettled([...this.pending])
      if (results.some(result => result.status === 'rejected')) {
        ctx.logger.warn('Model verification did not finish storing its audit log; the candidate was not adopted.')
      }
    })
  }

  /**
   * Test one candidate with a fixed short prompt. A pass requires a nonempty,
   * uninterrupted completion and normal turn termination, with the request,
   * response, and reported usage durably stored before return.
   * @param request - explicit candidate; no settings or live catalog are changed.
   * @param signal - cancels setup or the running test; absent means only owner disposal cancels it.
   * @returns outcome and the independent persisted session identity for audit.
   * @throws when setup or persistence prevents a trusted result; diagnostics contain no credential.
   */
  @Remote
  async verify(request: ModelVerificationRequest, signal: AbortSignal): Promise<ModelVerificationResult> {
    const invocation = this.ctx.invocation
    const principal = principalOf(invocation)
    if (invocation === undefined || principal !== undefined) {
      throw new RemoteError('model-verification/failed', 'Model verification requires the Host owner', {})
    }
    const source: UserMessage['source'] = { kind: 'user' }
    const abort = AbortSignal.any([signal, invocation.peer.signal, this.closing.signal])
    const running = this.run(request, source, abort)
    this.pending.add(running)
    try {
      return await running
    } catch (error) {
      if (abort.aborted && error === abort.reason) throw new RemoteError('gateway/cancelled', 'Model verification was cancelled', {})
      throw new RemoteError('model-verification/failed', 'Model verification could not finish; retry the connection test', {}, { cause: error })
    } finally {
      this.pending.delete(running)
    }
  }

  private async run(request: ModelVerificationRequest, source: UserMessage['source'], signal: AbortSignal): Promise<ModelVerificationResult> {
    signal.throwIfAborted()
    const world = new Context()
    const persistence = this.ctx.sessionPersistence
    const adapter = createChatGPTAdapter(this.ctx, [request.model])
    const runtime = world.plugin({
      async apply(ctx: Context) {
        new VerificationPersistence(ctx, persistence)
        await ctx.plugin(LlmRuntime)
        await ctx.plugin(SessionStore)
        await ctx.plugin(SessionProjectionRegistry)
        const projections = ctx.get('sessionProjections')
        const llm = ctx.get('llm')
        if (projections === undefined || llm === undefined) throw new Error('model verification prerequisites did not activate')
        projections.register(verification)
        await ctx.plugin(SystemPrompt, {})
        await ctx.plugin(Tools)
        const tools = ctx.get('tools')
        if (tools === undefined) throw new Error('model verification tools did not activate')
        tools.register(defineTool({
          name: 'model_verification_probe',
          description: 'Verify tool schema support. Accepts no arguments and returns OK without reading or changing any state.',
          parameters: {},
          output: {
            schema: { type: 'string', const: 'OK' },
            render: (_args, value) => [{ type: 'text', text: value }],
          },
          execute: (): Promise<'OK'> => Promise.resolve('OK'),
        }))
        await ctx.plugin(AgentRegistry)
        llm.registerAdapter(['chatgpt'], adapter)
        await ctx.plugin(AgentLoop, { agents: [] })
      },
    })
    let handle: AgentHandle | undefined
    try {
      await runtime
      signal.throwIfAborted()
      const testSessionId = brandString<SessionId>(`model-verification-${randomUUID()}`)
      handle = await world.agents.create({
        sessionId: testSessionId,
        agentOptions: { provider: request.provider, model: request.model.id },
        signal,
      })
      const agent = handle.agent
      const cancel = (): void => { agent.cancel({ kind: 'user' }) }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Reply with exactly OK.' }], source }))
        if (signal.aborted) cancel()
        await agent.whenIdle()
        await world.sessions.flush(agent.session)
        const result = world.sessionProjections.stateOf(agent.session, 'modelVerification')
        if (result === undefined || result.status === 'pending') {
          throw new Error('model verification ended without a terminal projection')
        }
        return { status: signal.aborted ? 'cancelled' : result.status, testSessionId }
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    } finally {
      try { await handle?.dispose() } finally { await runtime.dispose() }
    }
  }
}
