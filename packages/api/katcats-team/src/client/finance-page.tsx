/** Register the finance catalog against the active Host connection. */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionGenerationState } from '@deepseek-ai/dsh-client-connection/client'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { IconLinkOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { RemoteError, type RemoteFailure, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { LedgerSetupConnectionInput, LedgerSetupConnectorInput, LedgerSetupPlanId, LedgerSetupSnapshot } from '../finance-setup-types.ts'
import type {
  FinanceCompany, FinanceConnectionDraft, FinanceConnector, FinanceConnectorId,
  FinanceConnectorSnapshot, SaveFinanceConnectorRequest,
} from '../finance-types.ts'
import {
  FinanceConnectorToast, FinanceConnectorsPage, type FinanceAction, type FinanceCatalog,
  type FinanceNotice, type FinancePageInjected,
} from './FinanceConnectorsPage.tsx'
import { FINANCE_NS, financeEn, financeFailureKey, financeZh, type FinanceErrorKey, type FinanceKey } from './finance-locales.ts'
import type { FinanceSetupActionResult, FinanceSetupActions, FinanceSetupView } from './FinanceLedgerSetup.tsx'
import type { LedgerSetupDatabaseControls } from './LedgerSetupDatabaseSettings.tsx'

const PANEL = '@deepseek-ai/dsh-client-katcats-team/finance-connectors' as MainPanelId

/** Browser face of the owner-only finance management methods. */
export interface FinanceRemote {
  readonly financeSnapshot: () => Promise<RemoteResult<FinanceConnectorSnapshot | null>>
  readonly followFinance: (signal?: AbortSignal) => AsyncIterable<FinanceConnectorSnapshot | null>
  readonly discoverFinanceCompanies: (input: FinanceConnectionDraft) => Promise<RemoteResult<readonly FinanceCompany[]>>
  readonly saveFinanceConnector: (input: SaveFinanceConnectorRequest) => Promise<RemoteResult<FinanceConnector>>
  readonly testFinanceConnector: (id: FinanceConnectorId) => Promise<RemoteResult<FinanceConnector>>
  readonly deleteFinanceConnector: (id: FinanceConnectorId) => Promise<RemoteResult<void>>
}

/** The optional ledger setup namespace alongside the existing finance Remote. */
export interface FinanceSetupRemote {
  readonly follow: (signal?: AbortSignal) => AsyncIterable<LedgerSetupSnapshot | null>
  readonly saveConnection: (input: LedgerSetupConnectionInput) => Promise<RemoteResult<LedgerSetupSnapshot>>
  readonly execute: (planId: LedgerSetupPlanId, expectedRevision: number) => Promise<RemoteResult<LedgerSetupSnapshot>>
  readonly uploadChart: (planId: LedgerSetupPlanId, expectedRevision: number, fileName: string, workbookBase64: string) => Promise<RemoteResult<LedgerSetupSnapshot>>
  readonly addConnector: (planId: LedgerSetupPlanId, input: LedgerSetupConnectorInput) => Promise<RemoteResult<LedgerSetupSnapshot>>
  readonly recoveryCompanies: (planId: LedgerSetupPlanId, expectedRevision: number) => Promise<RemoteResult<readonly FinanceCompany[]>>
  readonly reconcile: (planId: LedgerSetupPlanId, expectedRevision: number, companyId: number) => Promise<RemoteResult<LedgerSetupSnapshot>>
}

/** Shared finance data for connector and Bot settings contributions. */
interface FinancePageRegistration {
  readonly catalog: ObservableSnapshot<FinanceCatalog>
  readonly setupView: ObservableSnapshot<FinanceSetupView>
  readonly setupDatabase: LedgerSetupDatabaseControls | null
}

function FinancePanelIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconLinkOutlineRegular size={size} />
}

function errorKey(error: RemoteFailure, changed: boolean): FinanceErrorKey {
  if (error.code === 'xiaojing/finance-connector') return financeFailureKey(error.details.reason)
  if (error.code === 'gateway/bad-request') return 'error.invalid-input'
  return changed ? 'error.outcome' : 'error.unavailable'
}

const chartErrorKeys: ReadonlyMap<string, FinanceKey> = new Map([
  ['size', 'setup.fileInvalid'],
  ['workbook', 'setup.error.chartWorkbook'],
  ['worksheet', 'setup.error.chartSheet'],
  ['headers', 'setup.error.chartHeaders'],
  ['empty', 'setup.error.chartEmpty'],
  ['rows', 'setup.error.chartRows'],
  ['formula', 'setup.error.chartFormula'],
  ['code', 'setup.error.chartCode'],
  ['name', 'setup.error.chartName'],
  ['account-type', 'setup.error.chartType'],
  ['reconcile', 'setup.error.chartReconcile'],
  ['duplicate-code', 'setup.error.chartDuplicate'],
  ['extra-column', 'setup.error.chartExtra'],
])

/**
 * Contribute the sidebar entry after the Host confirms finance is enabled.
 * @param ctx - Client plugin context that owns the slots and locale.
 * @param remote - Owner management methods on the team Remote.
 * @param generation - Active Host identity, reset on disconnect.
 * @param setup - Optional ledger setup Remote.
 * @returns The connector catalog and the generation-scoped database connection for the Odoo administration Bots.
 */
export function installFinancePage(ctx: Context, remote: FinanceRemote, generation: ConnectionGenerationState, setup?: FinanceSetupRemote): FinancePageRegistration {
  ctx.effect(() => ctx.locale.register(FINANCE_NS, { zh: financeZh, en: financeEn }), 'katcats-team: finance copy')
  const t = ctx.locale.bind(FINANCE_NS)
  const catalog = createSnapshotStore<FinanceCatalog>({ kind: 'loading' })
  const notice = createSnapshotStore<FinanceNotice | null>(null)
  const setupView = createSnapshotStore<FinanceSetupView>({ kind: 'disabled' })
  let sequence = 0
  let revision = 0
  let live = true
  let stream: AbortController | undefined
  let setupStream: AbortController | undefined
  let contributions: Array<() => void> = []

  const publish = (key: FinanceKey, success: boolean): void => {
    notice.set({ sequence: ++sequence, key, success })
  }
  const followSetup = async (setupRemote: FinanceSetupRemote, signal: AbortSignal, request: number, host: number): Promise<void> => {
    const current = (): boolean => live && !signal.aborted && revision === request && generation.getSnapshot()?.id === host
    try {
      for await (const snapshot of setupRemote.follow(signal)) {
        if (!current()) return
        if (snapshot === null) {
          setupView.set({ kind: 'disabled' })
          return
        }
        setupView.set({ kind: 'ready', revision: request, snapshot })
      }
    } catch (error) {
      if (current() && error instanceof RemoteError
        && (error.code === 'gateway/invocation-unavailable' || error.code === 'gateway/service-unavailable')) {
        setupView.set({ kind: 'disabled' })
        return
      }
    }
    if (current()) setupView.set({ kind: 'error' })
  }

  const follow = async (signal: AbortSignal, request: number, host: number): Promise<void> => {
    const current = (): boolean => live && !signal.aborted && revision === request && generation.getSnapshot()?.id === host
    try {
      for await (const snapshot of remote.followFinance(signal)) {
        if (!current()) return
        if (snapshot === null) {
          catalog.set({ kind: 'disabled' })
          setupStream?.abort()
          setupView.set({ kind: 'disabled' })
          removeContributions()
          return
        }
        catalog.set({ kind: 'ready', revision: request, connectors: snapshot.connectors })
        if (setup !== undefined && setupStream === undefined) {
          setupStream = new AbortController()
          setupView.set({ kind: 'loading' })
          void followSetup(setup, setupStream.signal, request, host)
        }
        if (contributions.length === 0) registerContributions()
      }
    } catch (_error) {
      // The Remote can reject when the Host drops its subscription.
    }
    if (current()) catalog.set({ kind: 'error', key: 'error.unavailable' })
  }

  const reload = (): void => {
    const request = ++revision
    stream?.abort()
    setupStream?.abort()
    setupStream = undefined
    setupView.set({ kind: 'disabled' })
    const host = generation.getSnapshot()?.id
    if (host === undefined) {
      catalog.set({ kind: 'error', key: 'error.unavailable' })
      return
    }
    stream = new AbortController()
    catalog.set({ kind: 'loading' })
    void follow(stream.signal, request, host)
  }

  const operate = async <T,>(
    run: () => Promise<RemoteResult<T>>,
    onResult?: (value: T) => void,
  ): Promise<FinanceAction<T>> => {
    const before = catalog.getSnapshot()
    const host = generation.getSnapshot()?.id
    if (before.kind !== 'ready' || host === undefined) return { ok: false, key: 'error.unavailable' }
    let result: RemoteResult<T> | undefined
    try {
      result = await run()
    } catch (_error) {
      // An unmounted Remote can reject before returning its typed failure.
    }
    const changed = onResult !== undefined
    if (!live || generation.getSnapshot()?.id !== host || revision !== before.revision) {
      if (live && changed) publish('error.outcome', false)
      return { ok: false, key: changed ? 'error.outcome' : 'error.unavailable' }
    }
    if (result?.ok) {
      onResult?.(result.value)
      return result
    }
    const key = result === undefined ? changed ? 'error.outcome' : 'error.unavailable' : errorKey(result.error, changed)
    if (key === 'error.outcome') {
      publish(key, false)
      reload()
    }
    return { ok: false, key }
  }

  const operateSetup = async (
    run: () => Promise<RemoteResult<LedgerSetupSnapshot>>, resultNotice: (value: LedgerSetupSnapshot) => FinanceKey | undefined,
  ): Promise<FinanceSetupActionResult> => {
    const host = generation.getSnapshot()?.id
    const request = revision
    if (setupView.getSnapshot().kind !== 'ready' || catalog.getSnapshot().kind !== 'ready' || host === undefined) {
      return { ok: false, key: 'error.unavailable' }
    }
    let result: RemoteResult<LedgerSetupSnapshot> | undefined
    try {
      result = await run()
    } catch (_error) {
      // A dropped reply does not establish whether the command committed.
    }
    if (!live || generation.getSnapshot()?.id !== host || revision !== request) {
      if (live) publish('error.outcome', false)
      return { ok: false, key: 'error.outcome' }
    }
    if (result?.ok) {
      const key = resultNotice(result.value)
      if (key !== undefined) publish(key, true)
      return result
    }
    if (result?.error.code === 'xiaojing/ledger-setup-chart') {
      const { reason, row } = result.error.details
      return { ok: false, key: chartErrorKeys.get(reason) ?? 'setup.error.chart', ...(row === undefined ? {} : { row }) }
    }
    const key = result === undefined ? 'error.outcome' : errorKey(result.error, true)
    if (key === 'error.outcome') {
      publish(key, false)
      reload()
    }
    return { ok: false, key }
  }
  const setupActions: FinanceSetupActions | null = setup === undefined ? null : {
    recoveryCompanies: (id, expectedRevision) => operate(() => setup.recoveryCompanies(id, expectedRevision)),
    reconcile: (id, expectedRevision, companyId) => operateSetup(() => setup.reconcile(id, expectedRevision, companyId), () => 'setup.recovered'),
    execute: (id, expectedRevision) => operateSetup(() => setup.execute(id, expectedRevision), snapshot =>
      snapshot.plans.find(plan => plan.id === id)?.status === 'ready' ? 'setup.initialized' : undefined),
    uploadChart: (id, expectedRevision, fileName, workbookBase64) =>
      operateSetup(() => setup.uploadChart(id, expectedRevision, fileName, workbookBase64), () => 'setup.uploaded'),
    addConnector: async (id, input) => {
      const added = (snapshot: LedgerSetupSnapshot): boolean =>
        snapshot.plans.some(plan => plan.id === id && plan.status === 'handed-off')
      const result = await operateSetup(() => setup.addConnector(id, input), snapshot => added(snapshot) ? 'setup.addConnectorDone' : undefined)
      return result.ok && !added(result.value) ? { ok: false, key: 'setup.error.connectorUnverified' } : result
    },
    reload,
  }
  const setupDatabase: LedgerSetupDatabaseControls | null = setup === undefined ? null : {
    t,
    connect: input => operateSetup(() => setup.saveConnection(input), () => 'setup.saved'),
    reload,
  }

  const face: FinancePageInjected = {
    hooks: { financeCatalog: catalog, financeNotice: notice, financeSetup: setupView },
    setup: setupActions,
    reload,
    discover: draft => operate(() => remote.discoverFinanceCompanies(draft)),
    save: draft => operate(() => remote.saveFinanceConnector(draft), () => { publish('notice.saved', true) }),
    test: async id => {
      const result = await operate(() => remote.testFinanceConnector(id), connector => {
        if (connector.failure === null) publish('notice.tested', true)
      })
      if (!result.ok && result.key !== 'error.outcome' && live) publish(result.key, false)
      return result
    },
    remove: id => operate(() => remote.deleteFinanceConnector(id), () => { publish('notice.removed', true) }),
    dismissNotice: id => { if (notice.getSnapshot()?.sequence === id) notice.set(null) },
  }

  function registerContributions(): void {
    contributions.push(
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: PANEL, locale: FINANCE_NS, inject: () => face,
      }, FinanceConnectorsPage)),
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL, order: 5, label: () => t('nav'), locale: FINANCE_NS,
      }, FinancePanelIcon)),
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay', id: 'finance-connectors.toast', locale: FINANCE_NS, inject: () => face,
      }, FinanceConnectorToast)),
    )
  }

  function removeContributions(): void {
    for (const dispose of contributions.reverse()) dispose()
    contributions = []
  }

  ctx.effect(() => {
    const refresh = (): void => {
      if (notice.getSnapshot()?.key !== 'error.outcome') notice.set(null)
      reload()
    }
    const stop = generation.subscribe(refresh)
    refresh()
    return () => {
      live = false
      stream?.abort()
      setupStream?.abort()
      stop()
      removeContributions()
    }
  }, 'katcats-team: finance catalog')
  return { catalog, setupView, setupDatabase }
}
