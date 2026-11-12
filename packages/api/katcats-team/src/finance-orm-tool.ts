/** Natural-language access to the bound Odoo account's public ORM methods. */
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-user-approval'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { FinanceOrmCallRequest, FinanceOrmCallResult, FinanceOrmWriteAuthorization } from './finance-types.ts'

/** Logged tool failure for an Odoo mutation whose remote effect is unconfirmed. */
export const FINANCE_ORM_UNKNOWN_OUTCOME = 'KATCATS_ODOO_UNKNOWN_OUTCOME'

/**
 * Recognize a dispatched mutation that requires checking Odoo before retrying.
 * @param error - Connector failure or its model-facing tool failure.
 * @returns Whether the operation may already have changed remote records.
 */
export function isFinanceOrmUnknownOutcome(error: unknown): boolean {
  const remote = remoteErrorOf(error)
  return (remote?.code === 'xiaojing/finance-connector' && remote.details.reason === 'unknown-outcome')
    || (error instanceof HarnessError && error.code === FINANCE_ORM_UNKNOWN_OUTCOME)
}

/**
 * Register one tool definition for a conversation-owned Odoo connector.
 * @param scope - Private Bot or group using the selected ledger.
 * @param call - Authorized ORM call that requests confirmation before a potentially mutating dispatch.
 * @returns The model-facing tool and safe result presentation.
 */
export function createFinanceOrmTool(
  scope: 'bot' | 'group',
  call: (request: FinanceOrmCallRequest, approve: FinanceOrmWriteAuthorization, exec: ToolRunContext) => Promise<FinanceOrmCallResult>,
): ToolDefinition {
  return defineTool({
    name: scope === 'bot' ? 'call_bot_odoo_orm' : 'call_group_odoo_orm',
    description: 'Call a public Odoo JSON-2 ORM method on the accounting connection bound to this conversation. Use fields_get to discover fields, search_read or search_count to query any available model, and formatted_read_group for aggregations. For suppliers, search res.partner with supplier_rank > 0. The complete operations mode supports create, write, unlink and public business actions with explicit user confirmation. Odoo still enforces account permissions. After an uncertain write, inspect the affected records before retrying.',
    parameters: {
      model: { type: 'string', required: true, description: 'Technical Odoo model name, for example res.partner, purchase.order or account.move.' },
      method: { type: 'string', required: true, description: 'Public ORM method name. Use a read operation when the user only asks a question.' },
      parameters_json: { type: 'string', description: 'JSON object with the method’s keyword arguments. For account.move.create, use vals_list containing one or more draft vouchers and their line_ids, without record IDs. Creation and action_post are separate operations. Use fields and domain for search_read and ids for record methods. Page large results. The connector selects the company. Wizard context can contain active_model, active_id or active_ids.' },
      summary: { type: 'string', description: 'For a change, describe what the user is authorizing in the user’s language.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, exec) => {
      const raw = args.parameters_json ?? '{}'
      let params: unknown
      try { params = JSON.parse(raw) } catch (error) {
        throw new HarnessError('Use a valid JSON object for the Odoo keyword arguments.', 'KATCATS_ODOO_INPUT', { cause: error })
      }
      const approve: FinanceOrmWriteAuthorization = async (connector, signal, body) => {
        const agent = exec.agent
        const approval = agent?.ctx.get('approval')
        if (agent === undefined || approval === undefined) {
          throw new HarnessError('Odoo changes require an available confirmation panel.', 'KATCATS_ODOO_APPROVAL')
        }
        const summary = args.summary?.trim()
        const reason = [summary, `Odoo · ${connector.name} · ${connector.company.name}`,
          `${args.model}.${args.method}`, JSON.stringify(body, null, 2)].filter(value => value).join('\n')
        const outcome = await approval.requestMandatory({
          agent, toolName: exec.name, callId: exec.callId, reason, signal,
        })
        signal.throwIfAborted()
        if (outcome !== 'allowed-once') {
          throw new HarnessError('The Odoo change was not confirmed and was not sent.', 'KATCATS_ODOO_APPROVAL')
        }
      }
      try {
        const { connector, company, model, method, data } = await call({ model: args.model, method: args.method, params }, approve, exec)
        return { connector: { ...connector }, company: { ...company }, model, method, data }
      } catch (error) {
        const remote = remoteErrorOf(error)
        if (remote?.code === 'xiaojing/finance-connector') {
          throw new HarnessError(remote.message,
            isFinanceOrmUnknownOutcome(error) ? FINANCE_ORM_UNKNOWN_OUTCOME : 'KATCATS_ODOO_CALL', { cause: error })
        }
        throw error
      }
    },
    presentCall: args => ({ card: 'generic', title: `Odoo · ${args.model}.${args.method}`, kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'Odoo operation incomplete' : 'Odoo result', content: result.content }),
  })
}
