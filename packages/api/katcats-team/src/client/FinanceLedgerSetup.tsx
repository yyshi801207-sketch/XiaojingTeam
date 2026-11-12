/** Ledger setup review and connector registration. */
import { useId, useRef, useState, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Input, Modal, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LedgerSetupConnectorInput, LedgerSetupSnapshot } from '../finance-setup-types.ts'
import type { FinanceCompany, FinanceOrmAccessMode } from '../finance-types.ts'
import { financeFailureKey, ledgerSetupErrorKey, type FinanceKey } from './finance-locales.ts'
import css from './FinanceConnectorsPage.module.css'

type Locale = PropsLocale<'xiaojing.finance'>
type Connection = LedgerSetupSnapshot['connection']
type Plan = LedgerSetupSnapshot['plans'][number]
type SetupProblem = { readonly key: FinanceKey; readonly row?: number }

/** Safe ledger setup results and optional failing workbook row. */
export type FinanceSetupActionResult =
  | { readonly ok: true; readonly value: LedgerSetupSnapshot }
  | ({ readonly ok: false } & SetupProblem)

/** Current ledger setup directory for the active Host. */
export type FinanceSetupView =
  | { readonly kind: 'disabled' | 'loading' | 'error' }
  | { readonly kind: 'ready'; readonly revision: number; readonly snapshot: LedgerSetupSnapshot }

/** Explicit owner commands supplied to the ledger setup section. */
export interface FinanceSetupActions {
  readonly execute: (planId: Plan['id'], revision: number) => Promise<FinanceSetupActionResult>
  readonly uploadChart: (planId: Plan['id'], revision: number, fileName: string, workbookBase64: string) => Promise<FinanceSetupActionResult>
  readonly addConnector: (planId: Plan['id'], input: LedgerSetupConnectorInput) => Promise<FinanceSetupActionResult>
  readonly recoveryCompanies: (planId: Plan['id'], revision: number) => Promise<{ readonly ok: true; readonly value: readonly FinanceCompany[] } | ({ readonly ok: false } & SetupProblem)>
  readonly reconcile: (planId: Plan['id'], revision: number, companyId: number) => Promise<FinanceSetupActionResult>
  readonly reload: () => void
}

const planStatus = {
  draft: { label: 'setup.status.draft', tone: 'neutral', dot: 'idle' },
  running: { label: 'setup.status.running', tone: 'info', dot: 'ongoing' },
  blocked: { label: 'setup.status.blocked', tone: 'warning', dot: 'warning' },
  uncertain: { label: 'setup.status.uncertain', tone: 'warning', dot: 'warning' },
  ready: { label: 'setup.status.ready', tone: 'success', dot: 'done' },
  'handed-off': { label: 'setup.status.handed-off', tone: 'success', dot: 'done' },
} as const

function PlanFacts({ t, plan }: Locale & { readonly plan: Plan }): ReactNode {
  return (
    <dl className={css.metadata}>
      <div><dt>{t('setup.company')}</dt><dd>{plan.name}</dd></div>
      {plan.taxId !== undefined && <div><dt>{t('setup.taxId')}</dt><dd className={css.technical}>{plan.taxId}</dd></div>}
      <div><dt>{t('setup.country')}</dt><dd>{plan.countryCode}</dd></div>
      <div><dt>{t('setup.currency')}</dt><dd>{plan.currencyCode}</dd></div>
      <div><dt>{t('setup.startDate')}</dt><dd><time dateTime={plan.openingDate}>{plan.openingDate}</time></dd></div>
      <div><dt>{t('setup.template')}</dt><dd>{plan.templateName} <span className={css.technical}>{plan.templateCode}</span></dd></div>
      {plan.companyId !== undefined && <div><dt>{t('setup.companyId')}</dt><dd>{plan.companyId}</dd></div>}
      {plan.mode === 'custom-chart' && <div><dt>{t('setup.accountCount')}</dt><dd>{plan.customAccountCount}</dd></div>}
      {plan.customChart !== undefined && (
        <div className={css.setupFileFact}><dt>{t('setup.workbook')}</dt><dd>{plan.customChart.name}</dd>
          <dd className={css.technical}><small>{plan.customChart.sha256}</small></dd></div>
      )}
      {plan.accountCount !== undefined && <div><dt>{t('setup.verifiedAccounts')}</dt><dd>{plan.accountCount}</dd></div>}
      {plan.journalCount !== undefined && <div><dt>{t('setup.verifiedJournals')}</dt><dd>{plan.journalCount}</dd></div>}
    </dl>
  )
}

function workbookBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onabort = () => reject(new Error('Reading the workbook was cancelled.'))
    reader.onload = () => {
      const data = reader.result
      if (typeof data !== 'string' || !data.includes(',')) {
        reject(new Error('Reading the workbook did not return a data URL.'))
        return
      }
      resolve(data.slice(data.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
}

function PlanCard({ t, plan, actions, canExecute, confirm, addConnector, recover }: Locale & {
  readonly plan: Plan
  readonly actions: FinanceSetupActions
  readonly canExecute: boolean
  readonly confirm: () => void
  readonly addConnector: () => void
  readonly recover: () => void
}): ReactNode {
  const hint = useId()
  const workbook = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [problem, setProblem] = useState<SetupProblem | null>(null)
  const source = plan.mode === 'custom-chart' ? 'setup.source.custom' : 'setup.source.standard'
  const status = planStatus[plan.status]
  const canUpload = plan.mode === 'custom-chart' && canExecute
    && (plan.status === 'draft' || (plan.status === 'blocked' && plan.customChartEditable === true))
  const canConfirm = canExecute && !uploading && (plan.status === 'draft' || plan.status === 'blocked')
    && (plan.mode !== 'custom-chart' || plan.customChart !== undefined)
  const failure = plan.failure === undefined ? null : ledgerSetupErrorKey(financeFailureKey(plan.failure))

  const upload = async (file: File): Promise<void> => {
    if (!canUpload || uploading) return
    setProblem(null)
    if (!/\.xlsx$/i.test(file.name) || file.size === 0 || file.size > 1024 * 1024) {
      setProblem({ key: 'setup.fileInvalid' })
      return
    }
    setUploading(true)
    try {
      const encoded = await workbookBase64(file)
      const result = await actions.uploadChart(plan.id, plan.revision, file.name, encoded)
      if (!result.ok) setProblem(result)
    } catch (_error) {
      // A browser file-read failure leaves the previous validated chart intact.
      setProblem({ key: 'setup.fileUnreadable' })
    } finally {
      setUploading(false)
    }
  }

  return (
    <article className={css.card}>
      <header className={css.cardHeader}>
        <div className={css.identityText}><h3>{plan.name}</h3><span>{t(source)}</span></div>
        <Tag className={css.status} tone={status.tone}>
          <StateDot state={status.dot} size={status.dot === 'ongoing' ? 11 : 6} />{t(status.label)}
        </Tag>
      </header>
      <PlanFacts t={t} plan={plan} />
      {failure !== null && <p className={css.warning} role="alert">{t(failure)}</p>}
      {canUpload && (
        <div className={css.setupUpload}>
          <Button size="sm" variant="outline" className={css.find} disabled={uploading} aria-describedby={hint}
            onClick={() => { workbook.current?.click() }}>{t('setup.upload')}</Button>
          <input hidden ref={workbook} type="file" accept=".xlsx" aria-label={t('setup.upload')} disabled={uploading} onChange={event => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (file !== undefined) void upload(file)
          }} />
          <p id={hint} className={css.companyHint}>{t('setup.uploadHint')}</p>
          {uploading && <p className={css.loading} role="status"><StateDot state="ongoing" />{t('setup.uploading')}</p>}
          {problem !== null && <p className={css.warning} role="alert">
            {problem.row === undefined ? t(problem.key) : t('setup.error.chartRow', { row: problem.row, reason: t(problem.key) })}
          </p>}
        </div>
      )}
      {plan.status === 'uncertain' && <div className={css.cardActions}>
        <Button size="sm" variant="outline" disabled={!canExecute} onClick={recover}>{t('setup.recover')}</Button>
      </div>}
      {(plan.status === 'draft' || plan.status === 'blocked' || plan.status === 'ready') && (
        <div className={css.cardActions}>
          {plan.status === 'ready' ? <Button size="sm" variant="primary" onClick={addConnector}>{t('setup.addConnector')}</Button>
            : <Button size="sm" variant="primary" disabled={!canConfirm} onClick={confirm}>
              {t(plan.status === 'blocked' ? 'setup.retryPlan' : 'setup.approve')}
            </Button>}
        </div>
      )}
    </article>
  )
}

function PlanRecovery({ t, plan, actions, close }: Locale & {
  readonly plan: Plan
  readonly actions: FinanceSetupActions
  readonly close: () => void
}): ReactNode {
  const id = useId()
  const [companies, setCompanies] = useState<readonly FinanceCompany[] | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [pending, setPending] = useState(false)
  const [problem, setProblem] = useState<SetupProblem | null>(null)
  const lookup = async (): Promise<void> => {
    if (pending) return
    setPending(true)
    setProblem(null)
    setSelected(null)
    const result = await actions.recoveryCompanies(plan.id, plan.revision)
    if (result.ok) setCompanies(result.value)
    else setProblem(result)
    setPending(false)
  }
  const confirm = async (): Promise<void> => {
    if (pending || selected === null) return
    setPending(true)
    setProblem(null)
    const result = await actions.reconcile(plan.id, plan.revision, selected)
    if (result.ok) close()
    else {
      setProblem({ key: result.key === 'error.in-use' ? 'setup.error.planChanged' : ledgerSetupErrorKey(result.key) })
      setPending(false)
    }
  }
  return <Modal open title={t('setup.recover')} description={t('setup.recoverDescription')}
    closeLabel={t('editor.close')} onClose={() => { if (!pending) close() }} className={css.editor ?? ''}
    contentClassName={css.editorContent ?? ''} footer={<div className={css.editorFooter}>
      {problem !== null && <p className={css.warning} role="alert">{t(problem.key)}</p>}
      <div className={css.editorActions}>
        <Button variant="outline" disabled={pending} onClick={close}>{t('editor.cancel')}</Button>
        <Button variant="primary" disabled={pending || selected === null} onClick={() => { void confirm() }}>{t('setup.recoverConfirm')}</Button>
      </div>
    </div>}>
    <PlanFacts t={t} plan={plan} />
    <Button variant="outline" disabled={pending} onClick={() => { void lookup() }}>{t('setup.recoverLookup')}</Button>
    {companies?.length === 0 && <p role="status" className={css.companyHint}>{t('setup.recoverEmpty')}</p>}
    {companies !== null && companies.length > 0 && <fieldset className={css.fields} disabled={pending}>
      <legend>{t('setup.recoverChoose')}</legend>
      {companies.map(company => <label key={company.id} className={css.field}>
        <span><input type="radio" name={id} checked={selected === company.id} onChange={() => setSelected(company.id)} />{' '}
          {company.name} · {t('setup.companyId')} {company.id} · {company.currency}</span>
      </label>)}
    </fieldset>}
  </Modal>
}

function PlanApproval({ t, plan, connection, execute, close }: Locale & {
  readonly plan: Plan
  readonly connection: Connection
  readonly execute: FinanceSetupActions['execute']
  readonly close: () => void
}): ReactNode {
  const errorId = useId()
  const [pending, setPending] = useState(false)
  const [problem, setProblem] = useState<SetupProblem | null>(null)
  const submit = async (): Promise<void> => {
    if (pending) return
    setPending(true)
    setProblem(null)
    const result = await execute(plan.id, plan.revision)
    if (result.ok) close()
    else {
      setProblem({ key: result.key === 'error.in-use' ? 'setup.error.planChanged' : ledgerSetupErrorKey(result.key) })
      setPending(false)
    }
  }

  return (
    <Modal open title={t('setup.executeTitle')} description={t(plan.companyId === undefined ? 'setup.executeDescription' : 'setup.resumeDescription', { company: plan.name })}
      closeLabel={t('editor.close')} onClose={() => { if (!pending) close() }} className={css.editor ?? ''}
      contentClassName={css.editorContent ?? ''} footer={(
        <div className={css.editorFooter}>
          {problem !== null && <p id={errorId} className={css.warning} role="alert">{t(problem.key)}</p>}
          <div className={css.editorActions}>
            <Button variant="outline" disabled={pending} onClick={close}>{t('editor.cancel')}</Button>
            <Button variant="primary" disabled={pending} aria-describedby={problem === null ? undefined : errorId}
              onClick={() => { void submit() }}>{t(pending ? 'setup.executePending' : 'setup.approve')}</Button>
          </div>
        </div>
      )}>
      {connection !== null && <p className={css.companyHint}>{t('database')} <span className={css.technical}>{connection.database}</span></p>}
      <PlanFacts t={t} plan={plan} />
    </Modal>
  )
}

function ConnectorRegistration({ t, plan, addConnector, close }: Locale & {
  readonly plan: Plan
  readonly addConnector: FinanceSetupActions['addConnector']
  readonly close: () => void
}): ReactNode {
  const form = useId()
  const [accessMode, setAccessMode] = useState<FinanceOrmAccessMode>('read-only')
  const [apiKey, setApiKey] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<FinanceKey | null>(null)
  const canSubmit = apiKey.trim() !== ''
  const submit = async (): Promise<void> => {
    if (pending || !canSubmit) return
    setPending(true)
    setError(null)
    const result = await addConnector(plan.id, { accessMode, apiKey: apiKey.trim() })
    if (result.ok) {
      setApiKey('')
      close()
    } else {
      setError(result.key === 'error.permissions' ? 'setup.error.connectorPermissions'
        : result.key === 'error.in-use' ? 'setup.error.connectorChanged' : ledgerSetupErrorKey(result.key))
      setPending(false)
    }
  }

  return (
    <Modal open title={t('setup.addConnector')} description={t('setup.addConnectorDescription', { company: plan.name })}
      closeLabel={t('editor.close')} onClose={() => { if (!pending) close() }} className={css.editor ?? ''}
      contentClassName={css.editorContent ?? ''} footer={(
        <div className={css.editorFooter}>
          {error !== null && <p id={form + '-error'} className={css.warning} role="alert">{t(error)}</p>}
          <div className={css.editorActions}>
            <Button variant="outline" disabled={pending} onClick={close}>{t('editor.cancel')}</Button>
            <Button type="submit" form={form} variant="primary" disabled={pending || !canSubmit}
              aria-describedby={error === null ? undefined : form + '-error'}>
              {t(pending ? 'setup.addConnectorPending' : 'setup.addConnector')}
            </Button>
          </div>
        </div>
      )}>
      <form id={form} className={css.form} onSubmit={event => { event.preventDefault(); void submit() }}>
        <fieldset className={css.fields} disabled={pending}>
          <div className={css.field}>
            <label htmlFor={form + '-key'}>{t('setup.dailyKey')}</label>
            <Input id={form + '-key'} type="password" autoComplete="new-password" spellCheck={false} value={apiKey}
              aria-describedby={form + '-key-hint'} onChange={event => setApiKey(event.currentTarget.value)} />
            <small id={form + '-key-hint'}>{t('setup.dailyKeyHint')}</small>
          </div>
          <div className={css.fieldPair} role="group" aria-label={t('editor.accessStep')}>
            <Button type="button" variant={accessMode === 'read-only' ? 'primary' : 'outline'}
              aria-pressed={accessMode === 'read-only'} onClick={() => setAccessMode('read-only')}>{t('scope')}</Button>
            <Button type="button" variant={accessMode === 'full' ? 'primary' : 'outline'}
              aria-pressed={accessMode === 'full'} onClick={() => setAccessMode('full')}>{t('scope.full')}</Button>
          </div>
        </fieldset>
      </form>
    </Modal>
  )
}

/**
 * Show provisioning plans and let the owner register verified ledgers in the connector catalog.
 * @param props - Ledger setup projection and owner commands.
 * @returns The ledger setup panel for supported Hosts.
 */
export function FinanceLedgerSetup({ t, view, actions }: Locale & {
  readonly view: FinanceSetupView
  readonly actions: FinanceSetupActions
}): ReactNode {
  const [dialog, setDialog] = useState<{ kind: 'approve'; plan: Plan; connection: Connection } | { kind: 'add-connector' | 'recover'; plan: Plan } | null>(null)
  if (view.kind !== 'ready') {
    if (view.kind !== 'error') return null
    return (
      <section className={css.setup} aria-label={t('setup.title')}>
        <div className={css.loadError}><p role="alert">{t('setup.loadFailed')}</p>
          <Button variant="outline" onClick={actions.reload}>{t('retry')}</Button></div>
      </section>
    )
  }
  const { connection, plans } = view.snapshot
  const close = (): void => { setDialog(null) }

  return (
    <section className={css.setup} aria-label={t('setup.title')}>
      <div className={css.sectionHeader}><h2>{t('setup.plans')}</h2></div>
      {connection === null && <p className={css.setupHint}>{t('setup.connectionInBot')}</p>}
      {plans.length === 0 ? <p className={css.setupHint}>{t('setup.noPlans')}</p> : (
        <div className={css.cards}>
          {plans.map(plan => <PlanCard key={plan.id} t={t} plan={plan} actions={actions}
            canExecute={connection !== null} confirm={() => setDialog({ kind: 'approve', plan, connection })}
            addConnector={() => setDialog({ kind: 'add-connector', plan })}
            recover={() => setDialog({ kind: 'recover', plan })} />)}
        </div>
      )}
      {dialog?.kind === 'approve' && <PlanApproval t={t} plan={dialog.plan} connection={dialog.connection} execute={actions.execute} close={close} />}
      {dialog?.kind === 'add-connector' && <ConnectorRegistration t={t} plan={dialog.plan} addConnector={actions.addConnector} close={close} />}
      {dialog?.kind === 'recover' && <PlanRecovery t={t} plan={dialog.plan} actions={actions} close={close} />}
    </section>
  )
}
