/** Finance connector catalog, connection verification, and company selection. */
import { useId, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import {
  Button, IconChevronDownOutlineRegular, IconDatabaseOutlineMedium, IconPlusOutlineRegular,
  IconRefreshOutlineRegular, IconShieldOutlineRegular, Input, Menu, Modal, StateDot, Tag, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  FinanceCompany, FinanceConnectionDraft, FinanceConnector, FinanceConnectorId, SaveFinanceConnectorRequest,
} from '../finance-types.ts'
import { financeFailureKey, type FinanceErrorKey, type FinanceKey } from './finance-locales.ts'
import { financeConnectionStatus } from './finance-status.ts'
import { OdooAccountLogin } from './OdooAccountLogin.tsx'
import bindingCss from './finance-binding.module.css'
import { FinanceLedgerSetup, type FinanceSetupActions, type FinanceSetupView } from './FinanceLedgerSetup.tsx'
import css from './FinanceConnectorsPage.module.css'

/** Result of a connector action with an error safe to show in the UI. */
export type FinanceAction<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly key: FinanceErrorKey }

/** Current catalog state, scoped to the active Host connection. */
export type FinanceCatalog =
  | { readonly kind: 'loading' | 'disabled' }
  | { readonly kind: 'error'; readonly key: FinanceErrorKey }
  | { readonly kind: 'ready'; readonly revision: number; readonly connectors: readonly FinanceConnector[] }

/** Localized notification for a completed operation. */
export interface FinanceNotice {
  readonly sequence: number
  readonly key: FinanceKey
  readonly success: boolean
}

/** Sources and commands supplied by the finance panel registration. */
export interface FinancePageInjected {
  readonly hooks: {
    readonly financeCatalog: ObservableSnapshot<FinanceCatalog>
    readonly financeNotice: ObservableSnapshot<FinanceNotice | null>
    readonly financeSetup: ObservableSnapshot<FinanceSetupView>
  }
  readonly reload: () => void
  readonly discover: (draft: FinanceConnectionDraft) => Promise<FinanceAction<readonly FinanceCompany[]>>
  readonly save: (draft: SaveFinanceConnectorRequest) => Promise<FinanceAction<FinanceConnector>>
  readonly test: (id: FinanceConnectorId) => Promise<FinanceAction<FinanceConnector>>
  readonly remove: (id: FinanceConnectorId) => Promise<FinanceAction<void>>
  readonly setup: FinanceSetupActions | null
  readonly dismissNotice: (sequence: number) => void
}

type FinanceLocale = PropsLocale<'xiaojing.finance'>
type FinancePageProps = PropsRuntime<'main'> & FinanceLocale & InjectFace<FinancePageInjected>
type FinanceToastProps = PropsRuntime<'shell.overlay'> & FinanceLocale & InjectFace<Pick<FinancePageInjected, 'dismissNotice' | 'hooks'>>

function ConnectorCard({ t, connector, testing, locked, onTest, onEdit, onRemove }: FinanceLocale & {
  connector: FinanceConnector
  testing: boolean
  locked: boolean
  onTest: () => void
  onEdit: () => void
  onRemove: () => void
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const nameId = useId()
  const stateId = useId()
  const { accessHealth, company, database, failure, lastTestAt, name, url } = connector
  const status = financeConnectionStatus(connector)
  const dateLocale = t('date.locale')
  const formatDate = new Intl.DateTimeFormat(dateLocale, { dateStyle: 'medium', timeStyle: 'short' })
  const formatAccessDate = new Intl.DateTimeFormat(dateLocale, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return (
    <article className={css.connectorCard}>
      <details open={expanded} onToggle={event => { setExpanded(event.currentTarget.open) }}>
        <summary className={css.connectorSummary} aria-labelledby={nameId} aria-describedby={stateId}>
          <span id={nameId} className={css.connectorName}>{name}</span>
          <span id={stateId} className={css.connectorHealth}>
            <Tag className={css.status} tone={testing ? 'neutral' : status.tone}>
              <StateDot size={testing ? 11 : 6} state={testing ? 'ongoing' : status.dot} />
              {t(testing ? 'testing' : `status.${status.status}`)}
            </Tag>
            {expanded && accessHealth !== undefined && <span className={css.connectorAccess}>
              <span>{t('lastAccess')}</span>{' '}
              <time dateTime={accessHealth.checkedAt} title={formatDate.format(new Date(accessHealth.checkedAt))}>
                {formatAccessDate.format(new Date(accessHealth.checkedAt))}
              </time>
            </span>}
          </span>
          <IconChevronDownOutlineRegular className={css.connectorChevron} size={15} aria-hidden="true" />
        </summary>
        {expanded && <div className={css.connectorBody}>
          <div className={css.connectorFacts}>
            <dl className={css.connectorFactGroup}>
              <div><dt>{t('company')}</dt><dd>{company.name} <span>{company.currency}</span></dd></div>
              <div><dt>{t('connection.login')}</dt>
                <OdooAccountLogin login={connector.account?.login} accessMode={connector.accessMode} t={t} />
              </div>
            </dl>
            <dl className={css.connectorFactGroup}>
              <div><dt>{t('database')}</dt><dd className={css.technical}>{database}</dd></div>
              <div><dt>{t('connection.address')}</dt><dd className={css.technical}>{url}</dd></div>
            </dl>
          </div>
          {status.status === 'failed' && failure !== null && <p className={css.warning}>{t(financeFailureKey(failure))}</p>}
          <div className={css.cardActions}>
            <Button size="sm" variant="outline" disabled={locked} icon={<IconRefreshOutlineRegular size={13} />} onClick={onTest}>
              {t('test')}
            </Button>
            <Button size="sm" disabled={locked} onClick={onEdit}>{t('edit')}</Button>
            <Button size="sm" className={css.remove} disabled={locked} onClick={onRemove}>{t('remove.short')}</Button>
          </div>
          <dl className={[bindingCss.verification, css.connectorVerification].join(' ')}>
            <dt>{t('lastTest')}</dt>
            <dd><time dateTime={lastTestAt}>{formatDate.format(new Date(lastTestAt))}</time>
              {' · '}{t(failure === null ? 'lastTest.passed' : 'lastTest.failed')}</dd>
          </dl>
        </div>}
      </details>
    </article>
  )
}

function ConnectorEditor({ t, connector, discover, save, onClose }: FinanceLocale & Pick<FinancePageInjected, 'discover' | 'save'> & {
  connector: FinanceConnector | null
  onClose: () => void
}): ReactNode {
  const formId = useId()
  const [name, setName] = useState(connector?.name ?? '')
  const [url, setUrl] = useState(connector?.url ?? '')
  const [database, setDatabase] = useState(connector?.database ?? '')
  const [apiKey, setApiKey] = useState('')
  const [accessMode, setAccessMode] = useState<'read-only' | 'full'>(connector?.accessMode ?? 'read-only')
  const [companies, setCompanies] = useState<readonly FinanceCompany[]>(connector === null ? [] : [connector.company])
  const [companyId, setCompanyId] = useState<number | null>(connector?.company.id ?? null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [pending, setPending] = useState<'discover' | 'save' | null>(null)
  const [error, setError] = useState<{ action: 'discover' | 'save'; key: FinanceErrorKey } | null>(null)
  const canKeepKey = connector !== null && connector.database === database.trim()
  const canDiscover = url.trim() !== '' && database.trim() !== '' && (apiKey.trim() !== '' || canKeepKey)
  const selected = companies.find(company => company.id === companyId)
  const saveError = error?.action === 'save' ? error.key : null
  const discoverError = error?.action === 'discover' ? error.key : null

  const resetVerification = (keepSavedCompany = false): void => {
    const company = keepSavedCompany ? connector?.company : undefined
    setCompanies(company === undefined ? [] : [company])
    setCompanyId(company?.id ?? null)
    setMenuOpen(false)
    setError(null)
  }
  const connection = (): FinanceConnectionDraft => ({
    url: url.trim(),
    database: database.trim(),
    ...(connector === null ? {} : { id: connector.id }),
    ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
  })
  const verify = async (): Promise<void> => {
    if (!canDiscover || pending !== null) return
    setPending('discover')
    resetVerification()
    const result = await discover(connection())
    if (result.ok) {
      setCompanies(result.value)
      const previousSelection = result.value.find(company => company.id === companyId)
      setCompanyId(previousSelection?.id ?? (result.value.length === 1 ? result.value[0]?.id ?? null : null))
      if (result.value.length === 0) setError({ action: 'discover', key: 'error.company' })
    } else {
      setError({ action: 'discover', key: result.key })
    }
    setPending(null)
  }
  const submit = async (): Promise<void> => {
    if (pending !== null || selected === undefined || !canDiscover || name.trim() === '') return
    setPending('save')
    setError(null)
    const result = await save({ ...connection(), name: name.trim(), companyId: selected.id,
      ...(accessMode === 'full' || connector?.accessMode === 'full' ? { accessMode } : {}) })
    if (result.ok) {
      setApiKey('')
      onClose()
    } else {
      setError({ action: 'save', key: result.key })
      setPending(null)
    }
  }

  return (
    <Modal
      open
      title={t(connector === null ? 'editor.create' : 'editor.edit')}
      description={t('editor.description')}
      closeLabel={t('editor.close')}
      onClose={() => { if (pending === null) onClose() }}
      className={css.editor ?? ''}
      contentClassName={css.editorContent ?? ''}
      footer={(
        <div className={css.editorFooter}>
          {saveError !== null && <p id={formId + '-save-error'} className={css.warning} role="alert">{t(saveError)}</p>}
          <div className={css.editorActions}>
            <Button variant="outline" disabled={pending !== null} onClick={onClose}>{t('editor.cancel')}</Button>
            <Button
              type="submit"
              form={formId}
              variant="primary"
              aria-describedby={saveError === null ? undefined : formId + '-save-error'}
              disabled={pending !== null || selected === undefined || !canDiscover || name.trim() === ''}
            >
              {t(pending === 'save' ? 'editor.saving' : 'editor.save')}
            </Button>
          </div>
        </div>
      )}
    >
      <form id={formId} className={css.form} onSubmit={event => { event.preventDefault(); void submit() }}>
        <fieldset disabled={pending !== null} className={css.fields}>
          <legend className={css.step}><span aria-hidden="true">01</span>{t('editor.connectionStep')}</legend>
          <label className={css.field}>
            <span>{t('editor.name')}</span>
            <Input data-modal-autofocus value={name} placeholder={t('editor.namePlaceholder')} onChange={event => setName(event.currentTarget.value)} />
          </label>
          <div className={css.field}>
            <label htmlFor={formId + '-url'}>{t('address')}</label>
            <Input id={formId + '-url'} aria-describedby={formId + '-url-hint'} inputMode="url" autoCapitalize="off"
              spellCheck={false} value={url} placeholder={t('editor.addressPlaceholder')}
              onChange={event => { setUrl(event.currentTarget.value); resetVerification(canKeepKey && apiKey.trim() === '') }} />
            <small id={formId + '-url-hint'}>{t('editor.addressHint')}</small>
          </div>
          <div className={css.fieldPair}>
            <label className={css.field}>
              <span>{t('database')}</span>
              <Input autoCapitalize="off" spellCheck={false} value={database} placeholder={t('editor.databasePlaceholder')}
                onChange={event => {
                  const value = event.currentTarget.value
                  setDatabase(value)
                  resetVerification(connector?.database === value.trim() && apiKey.trim() === '')
                }} />
            </label>
            <div className={css.field}>
              <label htmlFor={formId + '-key'}>{t('editor.key')}</label>
              <Input id={formId + '-key'} type="password" autoComplete="new-password" spellCheck={false} value={apiKey}
                aria-describedby={canKeepKey ? formId + '-key-hint' : undefined}
                placeholder={canKeepKey ? undefined : t('editor.keyRequired')}
                onChange={event => {
                  const value = event.currentTarget.value
                  setApiKey(value)
                  resetVerification(canKeepKey && value.trim() === '')
                }} />
              {canKeepKey && <small id={formId + '-key-hint'}>{t('editor.keyExisting')}</small>}
            </div>
          </div>
          <Button className={css.find} variant="outline" disabled={!canDiscover || pending !== null}
            aria-describedby={discoverError === null ? undefined : formId + '-discover-error'}
            icon={pending === 'discover' ? <StateDot state="ongoing" /> : <IconRefreshOutlineRegular />}
            onClick={() => { void verify() }}>
            {t(pending === 'discover' ? 'editor.finding' : 'editor.find')}
          </Button>
          {discoverError !== null && <p id={formId + '-discover-error'} className={css.warning} role="alert">{t(discoverError)}</p>}
        </fieldset>
        <fieldset disabled={pending !== null} className={css.fields}>
          <legend className={css.step}><span aria-hidden="true">02</span>{t('editor.companyStep')}</legend>
          {companies.length === 0 ? <p className={css.companyHint}>{t('editor.selectHint')}</p> : (
            <>
              <Menu
                open={menuOpen}
                autoFocus
                portal
                className={css.companyMenu}
                listClassName={css.companyOptions}
                items={companies.map(company => ({ id: String(company.id), label: company.name }))}
                selectedId={selected === undefined ? undefined : String(selected.id)}
                onSelect={id => { setCompanyId(Number(id)); setMenuOpen(false) }}
                onClose={() => setMenuOpen(false)}
                anchor={(
                  <Button className={css.companyTrigger} variant="outline" aria-haspopup="menu" aria-expanded={menuOpen}
                    disabled={pending !== null} onClick={() => setMenuOpen(open => !open)}>
                    <span>{selected?.name ?? t('editor.select')}</span>
                    {selected !== undefined && <small>{selected.currency}</small>}
                    <IconChevronDownOutlineRegular size={13} />
                  </Button>
                )}
              />
              <p className={css.companyHint} role="status">{t('editor.found', { count: companies.length })}</p>
            </>
          )}
        </fieldset>
        <fieldset disabled={pending !== null} className={css.fields}>
          <legend className={css.step}><span aria-hidden="true">03</span>{t('editor.accessStep')}</legend>
          <div className={css.fieldPair}>
            <Button type="button" variant={accessMode === 'read-only' ? 'primary' : 'outline'}
              aria-pressed={accessMode === 'read-only'} onClick={() => setAccessMode('read-only')}>{t('scope')}</Button>
            <Button type="button" variant={accessMode === 'full' ? 'primary' : 'outline'}
              aria-pressed={accessMode === 'full'} onClick={() => setAccessMode('full')}>{t('scope.full')}</Button>
          </div>
          <p className={css.companyHint}>{t(accessMode === 'full' ? 'editor.fullHint' : 'editor.readOnlyHint')}</p>
        </fieldset>
      </form>
    </Modal>
  )
}

function FinanceCatalogContent({ t, catalog, setup, setupView, reload, discover, save, test, remove }: FinanceLocale
  & Pick<FinancePageInjected, 'reload' | 'discover' | 'save' | 'test' | 'remove' | 'setup'>
  & { catalog: FinanceCatalog; setupView: FinanceSetupView }): ReactNode {
  const [editing, setEditing] = useState<FinanceConnector | null | undefined>(undefined)
  const [deleting, setDeleting] = useState<FinanceConnector | null>(null)
  const [testing, setTesting] = useState<FinanceConnectorId | null>(null)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<FinanceErrorKey | null>(null)
  const ready = catalog.kind === 'ready'
  const closeDelete = (): void => { setDeleting(null); setRemoveError(null) }

  return (
    <div className={css.page}>
      <div className={css.column}>
        <header className={css.header} data-window-drag="">
          <div>
            <p className={css.eyebrow}>{t('eyebrow')}</p>
            <h1>{t('heading')}</h1>
            <p className={css.intro}>{t('intro')}</p>
          </div>
          <Button variant="primary" className={css.add} icon={<IconPlusOutlineRegular />} disabled={!ready || testing !== null} onClick={() => setEditing(null)}>
            {t('add')}
          </Button>
        </header>
        <section className={css.catalog} aria-label={t('catalog')}>
          {catalog.kind === 'loading' && <p className={css.loading} role="status"><StateDot state="ongoing" />{t('loading')}</p>}
          {catalog.kind === 'disabled' && <p className={css.loading} role="status">{t('disabled')}</p>}
          {catalog.kind === 'error' && (
            <div className={css.loadError}>
              <p role="alert">{t(catalog.key)}</p>
              <Button variant="outline" onClick={reload}>{t('retry')}</Button>
            </div>
          )}
          {ready && (
            <>
              <div className={css.sectionHeader}>
                <h2>{t('catalog')}</h2>
                <span>{t('count', { count: catalog.connectors.length })}</span>
              </div>
              {catalog.connectors.length === 0 ? (
                <div className={css.empty}>
                  <span className={css.emptyGlyph} aria-hidden="true"><IconDatabaseOutlineMedium size={23} /></span>
                  <h3>{t('empty.title')}</h3>
                  <p>{t('empty.description')}</p>
                  <p className={css.note}><IconShieldOutlineRegular size={14} />{t('empty.scope')}</p>
                </div>
              ) : (
                <div className={css.cards}>
                  {catalog.connectors.map(connector => (
                    <ConnectorCard
                      key={connector.id} t={t} connector={connector} testing={testing === connector.id} locked={testing !== null}
                      onTest={() => {
                        setTesting(connector.id)
                        void test(connector.id).finally(() => setTesting(null))
                      }}
                      onEdit={() => setEditing(connector)}
                      onRemove={() => setDeleting(connector)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </section>
        {ready && setup !== null && <FinanceLedgerSetup t={t} view={setupView} actions={setup} />}
      </div>
      {editing !== undefined && <ConnectorEditor t={t} connector={editing} discover={discover} save={save} onClose={() => setEditing(undefined)} />}
      {deleting !== null && (
        <Modal
          open title={t('remove')} description={t('remove.description', { name: deleting.name })}
          closeLabel={t('editor.close')} onClose={() => { if (!removing) closeDelete() }}
          footer={<>
            <Button variant="outline" disabled={removing} onClick={closeDelete}>{t('editor.cancel')}</Button>
            <Button variant="outline" disabled={removing} className={css.remove} onClick={() => {
              setRemoving(true)
              setRemoveError(null)
              void remove(deleting.id).then(result => {
                setRemoving(false)
                if (result.ok) closeDelete()
                else setRemoveError(result.key)
              })
            }}>{t(removing ? 'remove.pending' : 'remove.short')}</Button>
          </>}
        >
          {removeError !== null && <p className={css.warning} role="alert">{t(removeError)}</p>}
        </Modal>
      )}
    </div>
  )
}

/**
 * Render the read-only finance connector catalog and its management actions.
 * @param props - Main panel data, labels, and finance commands.
 * @returns The finance connector page.
 */
export function FinanceConnectorsPage({ t, useFinanceCatalog, useFinanceSetup, setup, reload, discover, save, test, remove }: FinancePageProps): ReactNode {
  const catalog = useFinanceCatalog(value => value)
  const setupView = useFinanceSetup(value => value)
  const key = catalog.kind === 'ready' ? catalog.revision : catalog.kind
  return <FinanceCatalogContent key={key} t={t} catalog={catalog} setup={setup} setupView={setupView}
    reload={reload} discover={discover} save={save} test={test} remove={remove} />
}

/**
 * Report connector command outcomes above the product shell.
 * @param props - Notification source, labels, and dismissal command.
 * @returns The active notification, if any.
 */
export function FinanceConnectorToast({ t, useFinanceNotice, dismissNotice }: FinanceToastProps): ReactNode {
  const notice = useFinanceNotice(value => value)
  if (notice === null) return null
  const props = notice.success ? { tone: 'success' as const } : {}
  return <Toast key={notice.sequence} {...props} text={t(notice.key)} onDone={() => dismissNotice(notice.sequence)} />
}
