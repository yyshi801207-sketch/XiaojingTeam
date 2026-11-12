/** Durable database identity and conversation isolation for the two fixed Odoo assistants. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type XiaojingLedgerSetup from './finance-setup.ts'

const contextName = 'xiaojing:administration-database'
const projectionKey = 'xiaojing:administration-context'
const installed = new WeakSet<XiaojingLedgerSetup>()
const admitted = new WeakMap<Agent, string>()

/** Verified administration destination; rotating a key does not change this identity. */
export interface FinanceAdminContextScope {
  readonly url: string
  readonly database: string
  readonly databaseUuid: string
  readonly userId: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Last logged administration identity and whether this Session has model-visible history. */
    'xiaojing:administration-context': { readonly text: string | null; readonly hasHistory: boolean }
  }
}

function contextText(scope: FinanceAdminContextScope | null): string {
  return 'Current Odoo administration connection: ' + JSON.stringify({ version: 1, connection: scope })
    + '\nUse only this database and account. Resolve company, user, group and accounting record IDs in this database before operating. '
    + 'If no connection is configured, ask the user to connect in this assistant’s settings. Never reuse another database’s records or permissions.'
}

/**
 * Install logged identity context and replace old database history before a new request.
 * @param ctx Setup plugin context owning the projection and listeners.
 * @param setup Saved administration connection owner.
 * @param agent Fixed assistant receiving isolated model context.
 */
export function registerFinanceAdminContext(ctx: Context, setup: XiaojingLedgerSetup, agent: Agent): void {
  if (!installed.has(setup)) {
    ctx.effect(() => ctx.sessionProjections.register({
      key: projectionKey,
      stateVersion: 1,
      stateSchema: z.object({ text: z.string().nullable(), hasHistory: z.boolean() }),
      init: () => ({ text: null, hasHistory: false }),
      apply: (state, event) => {
        if (event.type !== 'user/message' && event.type !== 'assistant/message') return state
        if (event.type === 'user/message' && 'form' in event.data.source && event.data.source.form === 'snapshot') {
          const section = event.data.source.sections.find(item => item.name === contextName)
          if (section) return { text: section.text, hasHistory: true }
        }
        return state.hasHistory ? state : { ...state, hasHistory: true }
      },
    }))
    installed.add(setup)
  }
  ctx.effect(() => agent.ctx.on('agent/pre-step', async (_payload, next) => {
    await setup.snapshot()
    const text = contextText(setup.adminContextScope())
    const recorded = ctx.sessionProjections.stateOf(agent.session, projectionKey)
    if (recorded === undefined) throw new Error('The administration context projection is not registered.')
    if (recorded.text !== text) {
      const nodes = agent.session.surface.nodes.slice(agent.session.deriveMessages()[0]?.role === 'system' ? 1 : 0)
      const startSeq = nodes[0]
      const endSeq = nodes.at(-1)
      if (startSeq !== undefined && endSeq !== undefined) {
        agent.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'The administration database or account changed, or earlier history had no verified database identity. '
            + 'Previous conversation history is retained in the audit log but is excluded from this request. '
            + 'Do not infer previous company names, record IDs, permissions, drafts or unfinished operations. Use the current database context and current user request.' }],
          source: { kind: 'system-prompt' },
        }), { surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs: nodes })
      }
    }
    admitted.set(agent, text)
    return next()
  }))
  ctx.effect(() => agent.ctx.systemPrompt.context({
    name: contextName, order: agent.ctx.systemPrompt.getContextOrder('TEAM_IDENTITY'),
    required: true, interpolate: false, text: () => admitted.get(agent) ?? '',
  }))
}

/**
 * Reject a tool whose request context belongs to a previous administration destination.
 * @param setup Current saved connection owner.
 * @param agent Fixed assistant executing the tool.
 * @throws When existing conversation history has no admitted current database identity.
 */
export function authorizeFinanceAdminContext(setup: XiaojingLedgerSetup, agent: Agent): void {
  const recorded = agent.ctx.sessionProjections.stateOf(agent.session, projectionKey)
  if (recorded === undefined) throw new Error('The administration context projection is not registered.')
  const expected = admitted.get(agent) ?? recorded.text
  if (expected === null && !recorded.hasHistory) return
  if (expected !== contextText(setup.adminContextScope())) {
    throw new HarnessError('The administration database or account changed. Start a new turn to refresh its context before continuing.', 'XIAOJING_ADMIN_CONTEXT_CHANGED')
  }
}
