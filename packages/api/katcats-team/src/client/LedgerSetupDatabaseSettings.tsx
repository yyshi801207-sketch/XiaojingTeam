/** Database-only connection controls shared by the Odoo administration Bots. */
import { useId, useState, type ReactNode } from 'react'
import {
  Button, IconChevronDownOutlineRegular, IconDatabaseOutlineMedium, IconRefreshOutlineRegular, Input, StateDot, Tag, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { LedgerSetupConnectionInput, LedgerSetupSnapshot } from '../finance-setup-types.ts'
import type { FinanceSetupActionResult, FinanceSetupView } from './FinanceLedgerSetup.tsx'
import { ledgerSetupErrorKey, type FinanceKey } from './finance-locales.ts'
import { OdooAccountLogin } from './OdooAccountLogin.tsx'
import css from './FinanceConnectorsPage.module.css'
import bindingCss from './finance-binding.module.css'

/** Owner commands and locale for the database controls. */
export interface LedgerSetupDatabaseControls {
  readonly t: TranslateNS<'xiaojing.finance'>
  readonly connect: (input: LedgerSetupConnectionInput) => Promise<FinanceSetupActionResult>
  readonly reload: () => void
}

type Connection = LedgerSetupSnapshot['connection']
type VerifiedConnection = NonNullable<Connection>

function DatabaseFields({ controls, connection, enabled, pending, setPending, confirmed, cancel }: {
  readonly controls: LedgerSetupDatabaseControls
  readonly connection: Connection
  readonly enabled: boolean
  readonly pending: boolean
  readonly setPending: (pending: boolean) => void
  readonly confirmed: (connection: VerifiedConnection) => void
  readonly cancel: () => void
}): ReactNode {
  const { t, connect } = controls
  const id = useId()
  const [urlEdit, setUrlEdit] = useState<string>()
  const [databaseEdit, setDatabaseEdit] = useState<string>()
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState<FinanceKey | null>(null)
  const url = urlEdit ?? connection?.url ?? ''
  const database = databaseEdit ?? connection?.database ?? ''
  const enteredAddress = url.trim()
  const address = URL.parse(enteredAddress)?.href.replace(/\/+$/, '') ?? enteredAddress
  const name = database.trim()
  const keepKey = connection !== null && address === connection.url && name === connection.database
  const keyHint = keepKey ? 'editor.keyExisting' : connection === null ? 'editor.keyRequired' : 'setup.connectionChangedKey'
  const canConnect = enabled && !pending && address !== '' && name !== '' && (keepKey || apiKey.trim() !== '')

  const submit = async (): Promise<void> => {
    if (!canConnect) return
    setPending(true)
    setError(null)
    const result = await connect({ url: address, database: name, ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }) })
    setPending(false)
    if (result.ok) {
      if (result.value.connection !== null) {
        confirmed(result.value.connection)
        return
      }
      setError('setup.connectionUnavailable')
    } else {
      setError(ledgerSetupErrorKey(result.key))
    }
  }

  return (
    <>
      <p className={bindingCss.hint}>{t('setup.connectionHint')}</p>
      <fieldset className={css.databaseFields} disabled={!enabled || pending} onKeyDown={event => {
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
          event.preventDefault()
          void submit()
        }
      }}>
        <div className={css.field}>
          <label htmlFor={id + '-url'}>{t('connection.address')}</label>
          <Input id={id + '-url'} aria-describedby={id + '-url-hint'}
            inputMode="url" autoCapitalize="off" spellCheck={false} value={url}
            placeholder={t('editor.addressPlaceholder')} onChange={event => { setUrlEdit(event.currentTarget.value); setError(null) }} />
          <small id={id + '-url-hint'}>{t('editor.addressHint')}</small>
        </div>
        <label className={css.field}>
          <span>{t('database')}</span>
          <Input autoCapitalize="off" spellCheck={false} value={database}
            placeholder={t('editor.databasePlaceholder')} onChange={event => { setDatabaseEdit(event.currentTarget.value); setError(null) }} />
        </label>
        <div className={css.field}>
          <label htmlFor={id + '-key'}>{t('setup.adminKey')}</label>
          <Input id={id + '-key'} type="password" autoComplete="new-password" spellCheck={false} value={apiKey}
            placeholder={keepKey ? t('editor.keySaved') : undefined}
            aria-describedby={id + '-key-hint'} onChange={event => { setApiKey(event.currentTarget.value); setError(null) }} />
          <small id={id + '-key-hint'}>{t(keyHint)}</small>
        </div>
      </fieldset>
      {error !== null && <p id={id + '-error'} className={bindingCss.error} role="alert">{t(error)}</p>}
      <div className={bindingCss.connectionActions}>
        {connection !== null && <Button type="button" size="sm" variant="outline" disabled={pending} onClick={cancel}>
          {t('editor.cancel')}
        </Button>}
        <Button type="button" size="sm" variant="primary" disabled={!canConnect}
          aria-describedby={error === null ? undefined : id + '-error'} onClick={() => { void submit() }}>
          {t('setup.connect')}
        </Button>
      </div>
    </>
  )
}

function DatabaseCard({ controls, connection, enabled }: {
  readonly controls: LedgerSetupDatabaseControls
  readonly connection: Connection
  readonly enabled: boolean
}): ReactNode {
  const { t, connect } = controls
  const [editing, setEditing] = useState(false)
  const [verified, setVerified] = useState<Connection>(null)
  const [pending, setPending] = useState(false)
  const [reconnectError, setReconnectError] = useState<{ verifiedAt: string; key: FinanceKey } | null>(null)
  // A save reply can arrive before the same confirmed state reaches the follow stream.
  const saved = connection !== null && (verified === null || connection.verifiedAt >= verified.verifiedAt) ? connection : verified
  const date = new Intl.DateTimeFormat(t('date.locale'), { dateStyle: 'medium', timeStyle: 'short' })
  const failure = reconnectError !== null && reconnectError.verifiedAt === saved?.verifiedAt ? reconnectError.key : null
  const status = pending ? 'setup.connecting' : saved === null ? 'setup.disconnected'
    : failure === null ? 'setup.connected' : 'setup.reconnectFailed'
  const reconnectLabel = t('setup.reconnect')
  const actionsDisabled = !enabled || pending
  const reconnect = async (): Promise<void> => {
    if (actionsDisabled || saved === null) return
    setPending(true)
    setReconnectError(null)
    const result = await connect({ url: saved.url, database: saved.database })
    if (result.ok && result.value.connection !== null) {
      setVerified(result.value.connection)
    } else {
      setReconnectError({
        verifiedAt: saved.verifiedAt,
        key: result.ok ? 'setup.connectionUnavailable' : ledgerSetupErrorKey(result.key),
      })
    }
    setPending(false)
  }
  const financeState = saved === null || editing ? 'unbound' : failure === null ? 'reachable' : 'failed'
  return (
    <section className={bindingCss.card} data-finance-state={financeState} aria-label={t('setup.connection')}>
      <details>
        <summary className={bindingCss.heading}>
          <span className={bindingCss.glyph} aria-hidden="true"><IconDatabaseOutlineMedium size={20} /></span>
          <span className={bindingCss.title}>{t('setup.connection')}</span>
          {(!editing || pending) && <Tag className={bindingCss.status}
            tone={pending || saved === null ? 'neutral' : failure === null ? 'success' : 'warning'}>
            <StateDot state={pending ? 'ongoing' : saved === null ? 'idle' : failure === null ? 'done' : 'warning'} size={pending ? 11 : 6} />
            <span role="status">{t(status)}</span>
          </Tag>}
          <IconChevronDownOutlineRegular className={bindingCss.chevron} size={14} aria-hidden="true" />
        </summary>
        <div className={bindingCss.body}>
          {saved === null || editing ? <DatabaseFields controls={controls} connection={saved} enabled={enabled}
            pending={pending} setPending={setPending} confirmed={value => {
              setVerified(value)
              setReconnectError(null)
              setEditing(false)
            }} cancel={() => setEditing(false)} /> : <>
            <dl className={[bindingCss.connectionFacts, css.databaseSummary].join(' ')}>
              <dt>{t('database')}</dt><dd>{saved.database}</dd>
              <dt>{t('connection.address')}</dt><dd>{saved.url}</dd>
              <dt>{t('connection.login')}</dt><OdooAccountLogin login={saved.account?.login} accessMode="full" t={t} />
            </dl>
            <div className={bindingCss.connectionActions}>
              <Tooltip label={reconnectLabel} disabled={actionsDisabled} side="top" portal>
                <Button type="button" size="sm" variant="outline" className={bindingCss.actionIcon} aria-label={reconnectLabel}
                  icon={<IconRefreshOutlineRegular size={14} />} disabled={actionsDisabled} onClick={() => { void reconnect() }} />
              </Tooltip>
              <Button type="button" size="sm" variant="outline" disabled={actionsDisabled} onClick={() => setEditing(true)}>{t('edit')}</Button>
            </div>
            {failure !== null && <p className={bindingCss.error} role="alert">{t(failure)}</p>}
            <dl className={bindingCss.verification}>
              <dt>{t('lastTest')}</dt>
              <dd><time dateTime={saved.verifiedAt}>{date.format(new Date(saved.verifiedAt))}</time>{' · '}{t('lastTest.passed')}</dd>
            </dl>
          </>}
        </div>
      </details>
    </section>
  )
}

/**
 * Render the shared Odoo database connection in an administration Bot’s settings.
 * @param props - Generation-scoped connection state, owner commands, and edit availability.
 * @returns A collapsed database settings card with editing and saved-connection verification.
 */
export function LedgerSetupDatabaseSettings({ view, controls, enabled }: {
  readonly view: FinanceSetupView
  readonly controls: LedgerSetupDatabaseControls
  readonly enabled: boolean
}): ReactNode {
  const { t, reload } = controls
  if (view.kind === 'ready') {
    return <DatabaseCard key={view.revision} controls={controls} connection={view.snapshot.connection} enabled={enabled} />
  }
  return (
    <section className={css.card} aria-label={t('setup.connection')}>
      <div className={css.identityText}><h3>{t('setup.connection')}</h3></div>
      <p className={css.setupHint} role="status">{t(view.kind === 'loading' ? 'loading' : 'setup.connectionUnavailable')}</p>
      {view.kind === 'error' && <div className={css.cardActions}>
        <Button type="button" size="sm" variant="outline" disabled={!enabled} onClick={reload}>{t('retry')}</Button>
      </div>}
    </section>
  )
}
