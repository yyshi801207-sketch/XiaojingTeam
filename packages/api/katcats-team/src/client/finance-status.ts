/** Presentation states for the last saved connection test and actual ORM access. */
import type { FinanceConnector } from '../finance-types.ts'

/**
 * Select the most relevant connection result to display in owner settings.
 * @param connector - Connector verification and access observations.
 * @returns The badge copy key, tone and dot state.
 */
export function financeConnectionStatus(connector: FinanceConnector):
  | { readonly status: 'unreachable' | 'failed'; readonly tone: 'warning'; readonly dot: 'warning' }
  | { readonly status: 'reachable'; readonly tone: 'success'; readonly dot: 'done' }
  | { readonly status: 'ready'; readonly tone: 'neutral'; readonly dot: 'idle' } {
  const { accessHealth, failure, lastTestAt } = connector
  if (accessHealth !== undefined && Date.parse(accessHealth.checkedAt) >= Date.parse(lastTestAt)) {
    if (accessHealth.outcome === 'unreachable') return { status: 'unreachable', tone: 'warning', dot: 'warning' } as const
    return { status: 'reachable', tone: 'success', dot: 'done' } as const
  }
  if (failure !== null) return { status: 'failed', tone: 'warning', dot: 'warning' } as const
  return { status: 'ready', tone: 'neutral', dot: 'idle' } as const
}

/**
 * Reflect the Host’s binding rule after an actual access recovers from a temporary test failure.
 * @param connector - Connector verification and access observations.
 * @returns Whether it can be selected for a new binding.
 */
export function financeConnectorAvailable(connector: FinanceConnector): boolean {
  return connector.failure === null || (connector.failure === 'network' || connector.failure === 'timeout')
    && financeConnectionStatus(connector).status === 'reachable'
}
