/** Owner-controlled, verified accounting connection for a group or dedicated finance Bot. */
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import {
  Button, IconChevronDownOutlineRegular, IconDatabaseOutlineMedium, IconEditOutlineRegular,
  IconRefreshOutlineRegular, StateDot, Tag, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { FinanceConnector, FinanceConnectorId, FinanceFailureReason } from '../finance-types.ts'
import type { ChatId } from '../chats-types.ts'
import type { BotId } from '../types.ts'
import { Choice } from './Choice.tsx'
import { financeConnectionStatus, financeConnectorAvailable } from './finance-status.ts'
import { OdooAccountLogin } from './OdooAccountLogin.tsx'
import type { FinanceCatalog } from './FinanceConnectorsPage.tsx'
import odooLogo from './assets/odoo-logo.svg'
import css from './team.module.css'
import bindingCss from './finance-binding.module.css'

const emptyCatalog: ObservableSnapshot<FinanceCatalog | null> = { getSnapshot: () => null, subscribe: () => () => {} }

function connectFailureCopy(failure: FinanceFailureReason) {
  if (failure === 'network') return 'chat.financeConnectNetwork'
  if (failure === 'timeout') return 'chat.financeConnectTimeout'
  if (failure === 'authentication') return 'chat.financeConnectAuth'
  if (failure === 'credential') return 'chat.financeConnectKey'
  if (failure === 'permissions' || failure === 'company') return 'chat.financeConnectPermissions'
  return 'chat.financeConnectFailed'
}

/** Owner-supplied binding and connector directory reads for one group or Bot. */
export interface FinanceBindingActions<OwnerId extends ChatId | BotId> {
  readonly catalog?: ObservableSnapshot<FinanceCatalog>
  readonly load: (ownerId: OwnerId) => Promise<{
    readonly connectors: readonly FinanceConnector[]
    readonly connectorId: FinanceConnectorId | null
  } | null>
  readonly bind: (ownerId: OwnerId, connectorId: FinanceConnectorId | null) => Promise<void>
  readonly connect: (ownerId: OwnerId, connectorId: FinanceConnectorId) => Promise<FinanceConnector>
}

/**
 * Display the durable accounting scope and let the owner explicitly switch or remove it.
 * @param props - Binding state and actions; optional disclosure controls expansion externally, otherwise it starts collapsed locally.
 * @returns A settings section while finance connections are enabled.
 */
export function FinanceBinding<OwnerId extends ChatId | BotId>({ ownerId, scope, active, busy, actions, disclosure, t }: {
  readonly ownerId: OwnerId
  readonly scope: 'group' | 'bot'
  readonly active: boolean
  readonly busy: boolean
  readonly actions: FinanceBindingActions<OwnerId>
  readonly disclosure?: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void }
  readonly t: TranslateNS<'katcats.team'>
}) {
  const id = useId()
  const catalogSource = active ? actions.catalog ?? emptyCatalog : emptyCatalog
  const catalog = useSyncExternalStore(catalogSource.subscribe, catalogSource.getSnapshot)
  const [view, setView] = useState<Awaited<ReturnType<FinanceBindingActions<OwnerId>['load']>>>()
  const [editing, setEditing] = useState(false)
  const [locallyExpanded, setExpanded] = useState(false)
  const expanded = disclosure === undefined ? locallyExpanded : disclosure.open
  const [draft, setDraft] = useState<FinanceConnectorId | null>()
  const [refresh, setRefresh] = useState(0)
  const [status, setStatus] = useState<'loading' | 'ready' | 'load-failed' | 'saving' | 'saved' | 'save-failed' | 'connecting' | 'connect-failed'>('loading')
  const read = useRef<AbortController | null>(null)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    read.current = controller
    setEditing(false)
    setDraft(undefined)
    setStatus('loading')
    void actions.load(ownerId).then((result) => {
      if (controller.signal.aborted) return
      setView(result)
      setStatus('ready')
    }, () => {
      if (!controller.signal.aborted) setStatus('load-failed')
    })
    return () => { controller.abort() }
  }, [actions, active, ownerId, refresh])
  if (view === null || view === undefined && !active) return null
  const hasBinding = view?.connectorId != null
  const rows = catalog?.kind === 'ready' ? catalog.connectors : view?.connectors ?? []
  const bound = rows.find(row => row.id === view?.connectorId)
  const connectionStatus = bound === undefined ? undefined : financeConnectionStatus(bound)
  const dateLocale = t('chat.financeDateLocale')
  const formatDate = new Intl.DateTimeFormat(dateLocale, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const fullDate = new Intl.DateTimeFormat(dateLocale, { dateStyle: 'medium', timeStyle: 'short' })
  const missingBinding = view?.connectorId != null && bound === undefined ? view.connectorId : null
  const connectors = rows.filter(row => financeConnectorAvailable(row) || row.id === view?.connectorId)
  const ready = connectors.some(financeConnectorAvailable)
  const selected = draft === undefined ? view?.connectorId ?? null : draft
  const selectedConnector = connectors.find(row => row.id === selected)
  const disabled = !active || busy || status === 'loading' || status === 'load-failed' || status === 'saving' || status === 'connecting'
  const canSave = !disabled && view !== undefined && selected !== view.connectorId
    && (selected === null || selectedConnector !== undefined && financeConnectorAvailable(selectedConnector))
  const save = () => {
    const controller = read.current
    if (!canSave || controller === null || pending.current === controller) return
    pending.current = controller
    setStatus('saving')
    void actions.bind(ownerId, selected).then(() => {
      if (controller.signal.aborted) return
      setView(previous => previous == null ? previous : { ...previous, connectorId: selected })
      setDraft(undefined)
      setEditing(false)
      setStatus('saved')
    }, () => {
      if (!controller.signal.aborted) setStatus('save-failed')
    }).finally(() => {
      if (pending.current === controller) {
        pending.current = null
        if (controller.signal.aborted && read.current?.signal.aborted === false) setRefresh(value => value + 1)
      }
    })
  }
  const connect = () => {
    const controller = read.current
    if (bound === undefined || disabled || controller === null || pending.current === controller) return
    pending.current = controller
    const revision = catalog?.kind === 'ready' ? catalog.revision : undefined
    setStatus('connecting')
    const settle = (connector?: FinanceConnector): void => {
      if (controller.signal.aborted) return
      const latest = catalogSource.getSnapshot()
      if (revision !== undefined && (latest?.kind !== 'ready' || latest.revision !== revision)) {
        setStatus('ready')
        return
      }
      if (connector === undefined || connector.id !== bound.id) {
        setStatus('connect-failed')
        return
      }
      // The stream remains authoritative when it has a current catalog.
      setView(previous => previous?.connectorId !== connector.id ? previous : { ...previous,
        connectors: previous.connectors.map(row => row.id === connector.id ? connector : row) })
      setStatus('ready')
    }
    void actions.connect(ownerId, bound.id).then(settle, () => { settle() }).finally(() => {
      if (pending.current === controller) pending.current = null
    })
  }
  const financeState = connectionStatus?.status ?? (missingBinding === null ? 'unbound' : 'failed')
  const connected = active && financeState === 'reachable'
  const connectLabel = t(status === 'connecting' ? 'chat.financeConnecting' : connected ? 'chat.financeReconnect' : 'chat.financeConnect')
  const editLabel = t(editing ? 'chat.financeCancelEdit' : 'chat.financeEditBinding')
  const failure = bound?.failure
  const connectFeedback = status === 'connect-failed' ? 'chat.financeConnectUnconfirmed'
    : status !== 'connecting' && financeState !== 'reachable' && failure != null ? connectFailureCopy(failure) : null
  const headingStatus = connectionStatus === undefined
    ? missingBinding === null
      ? { tone: 'neutral', dot: 'idle', label: 'chat.financeUnbound' } as const
      : { tone: 'warning', dot: 'warning', label: 'chat.financeUnavailable' } as const
    : { ...connectionStatus, label: connected ? 'chat.financeConnected' : `chat.financeStatus.${connectionStatus.status}` as const } as const
  const noAvailableLedger = view !== undefined && !ready && bound === undefined && missingBinding === null
  const choosing = view !== undefined && !noAvailableLedger && (!hasBinding || editing)
  const pickerDescription = bound === undefined ? `${id}-description` : undefined
  const body = <div className={bindingCss.body}>
    {status === 'loading' && view === undefined && <p role="status" className={bindingCss.hint}>{t(scope === 'bot' ? 'bot.financeLoading' : 'chat.financeLoading')}</p>}
    {status === 'load-failed' && <div className={bindingCss.feedback}>
      <p role="alert" className={bindingCss.error}>{t('chat.financeLoadFailed')}</p>
      <Button type="button" size="sm" variant="outline" disabled={!active || busy}
        onClick={() => { setRefresh(value => value + 1) }}>{t('chat.financeRetry')}</Button>
    </div>}
    {bound !== undefined && <div className={bindingCss.current}>
      <div className={bindingCss.summary}>
        <span className={bindingCss.provider}>
          <img src={odooLogo} alt={t('chat.financeProviderOdoo')} />
        </span>
        <div className={bindingCss.identity}>
          <strong>{bound.company.name}</strong>
          <span>{bound.name === bound.company.name ? bound.company.currency
            : t('chat.financeCompanyInfo', { name: bound.name, currency: bound.company.currency })}</span>
        </div>
      </div>
      <dl className={bindingCss.connectionFacts}>
        <dt>{t('odoo.login')}</dt>
        <OdooAccountLogin login={bound.account?.login} accessMode={bound.accessMode} t={t} />
      </dl>
    </div>}
    {noAvailableLedger && <p className={bindingCss.hint}>{t('chat.financeNoReady')}</p>}
    {(hasBinding || choosing) && <div className={bindingCss.bindingControls}>
      {hasBinding && <div className={bindingCss.connectionActions}>
        {bound !== undefined && <Tooltip label={connectLabel} disabled={!connected || disabled} side="top" portal>
          <Button type="button" size="sm" variant={connected ? 'outline' : 'primary'}
            className={connected ? bindingCss.actionIcon : undefined} aria-label={connected ? connectLabel : undefined}
            icon={connected ? <IconRefreshOutlineRegular size={14} /> : undefined} disabled={disabled} onClick={connect}>
            {connected ? null : connectLabel}
          </Button>
        </Tooltip>}
        <Tooltip label={editLabel} disabled={disabled} side="top" portal>
          <Button type="button" size="sm" variant="outline" className={bindingCss.actionIcon}
            aria-label={editLabel} aria-expanded={editing} aria-controls={choosing ? `${id}-picker` : undefined}
            icon={<IconEditOutlineRegular size={14} />} disabled={disabled} onClick={() => {
              setEditing(value => !value)
              setDraft(undefined)
              setStatus('ready')
            }} />
        </Tooltip>
      </div>}
      {choosing && <div id={`${id}-picker`} className={bindingCss.picker}>
        {pickerDescription !== undefined && <p id={pickerDescription} className={bindingCss.hint}>
          {t(scope === 'bot' ? 'bot.financeHint' : 'chat.financeHint')}
        </p>}
        <label className={css.label} htmlFor={id}>{t('chat.financeSelect')}</label>
        <div className={bindingCss.actions}>
          <Choice id={id} label={t('chat.financeSelect')} value={selected ?? ''} disabled={disabled}
            {...pickerDescription === undefined ? {} : { descriptionId: pickerDescription }}
            options={[
              { value: '', label: t('chat.financeNoBinding') },
              ...missingBinding === null ? [] : [{ value: missingBinding, label: t('chat.financeUnavailable'), disabled: true }],
              ...connectors.map(row => ({
                value: row.id,
                label: row.name === row.company.name ? row.name : t('chat.financeOption', { name: row.name, company: row.company.name }),
                disabled: !financeConnectorAvailable(row),
              })),
            ]}
            onChange={(value) => {
              setDraft(connectors.find(row => row.id === value)?.id ?? null)
              setStatus('ready')
            }} />
          <Button type="button" size="sm" variant="outline" disabled={!canSave} onClick={save}>
            {t(status === 'saving' ? 'chat.financeSaving' : 'chat.financeSave')}
          </Button>
        </div>
      </div>}
    </div>}
    {connectFeedback !== null && <p role="alert" className={bindingCss.error}>{t(connectFeedback)}</p>}
    {status === 'save-failed' && <p role="alert" className={bindingCss.error}>{t(scope === 'bot' ? 'bot.financeSaveFailed' : 'chat.financeSaveFailed')}</p>}
    {status === 'saved' && <p role="status" className={bindingCss.saved}>{t('chat.financeSaved')}</p>}
    {bound !== undefined && <dl className={bindingCss.verification}>
      <dt>{t('chat.financeLastTest')}</dt>
      <dd><time dateTime={bound.lastTestAt} title={fullDate.format(new Date(bound.lastTestAt))}>
        {formatDate.format(new Date(bound.lastTestAt))}
      </time>
        {' · '}{t(bound.failure === null ? 'chat.financeTestPassed' : 'chat.financeTestFailed')}</dd>
      {bound.accessHealth !== undefined && <>
        <dt>{t('chat.financeLastAccess')}</dt>
        <dd><time dateTime={bound.accessHealth.checkedAt} title={fullDate.format(new Date(bound.accessHealth.checkedAt))}>
          {formatDate.format(new Date(bound.accessHealth.checkedAt))}
        </time>
          {' · '}{t(bound.accessHealth.outcome === 'reachable'
            ? 'chat.financeAccessSucceeded' : 'chat.financeAccessFailed')}</dd>
      </>}
    </dl>}
  </div>
  return <section className={[bindingCss.card, bindingCss.bindingCard].join(' ')} aria-labelledby={`${id}-title`}
    data-finance-state={!active && financeState === 'reachable' ? 'ready' : financeState}
    data-finance-access={connected && bound?.accessMode === 'full' ? 'full' : undefined}
    aria-busy={status === 'loading' || status === 'saving' || status === 'connecting'}>
    <details open={expanded}>
      <summary className={bindingCss.heading} onClick={event => {
        event.preventDefault()
        if (disclosure === undefined) setExpanded(!expanded)
        else disclosure.onOpenChange(!expanded)
      }}>
        <span className={bindingCss.glyph} aria-hidden="true"><IconDatabaseOutlineMedium size={16} /></span>
        <span id={`${id}-title`} className={bindingCss.title}>{t('chat.financeTitle')}</span>
        {view !== undefined ? <Tag className={bindingCss.status} tone={headingStatus.tone}>
          <StateDot size={6} state={headingStatus.dot} />
          {t(headingStatus.label)}
          <IconChevronDownOutlineRegular className={bindingCss.chevron} size={12} aria-hidden="true" />
        </Tag> : <IconChevronDownOutlineRegular className={bindingCss.chevron} size={14} aria-hidden="true" />}
      </summary>
      {expanded && body}
    </details>
  </section>
}
