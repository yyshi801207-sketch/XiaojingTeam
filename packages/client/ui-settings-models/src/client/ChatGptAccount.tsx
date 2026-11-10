/** Shared ChatGPT connection and candidate-model picker in Models settings. */
import { useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatGptAccountController } from './chatgpt-account.ts'
import type { ModelsKey } from './locales.ts'
import styles from './ChatGptAccount.module.css'
import formStyles from './ModelsSection.module.css'

/** Settings-owned dependencies bound by the slot renderer. */
export interface ChatGptAccountInjected {
  /** The shared account controller; Bot settings never own credentials. */
  controller: ChatGptAccountController
  hooks: {
    /** Redacted account state and candidate selections. */
    account: ChatGptAccountController['store']
  }
  /** Model settings copy. */
  t: (key: ModelsKey) => string
}

/**
 * Render account setup and candidate choices using the settings theme.
 * @param props - Settings account controller, snapshot hook and localized copy.
 * @returns The shared connection card.
 */
export function ChatGptAccount(props: InjectFace<ChatGptAccountInjected> & { onClose?: () => void }): ReactNode {
  const { controller, useAccount, t } = props
  const account = useAccount(value => value)
  const [answer, setAnswer] = useState('')
  const [disconnectOpen, setDisconnectOpen] = useState(false)
  const promptId = useId()
  const busy = account.phase !== 'ready' && account.phase !== 'idle'
  useEffect(() => { void controller.load(); return () => { void controller.close() } }, [controller])
  useEffect(() => { setAnswer('') }, [account.prompt?.id])
  if (account.phase === 'ready' && !account.available && account.failure === null) return null
  const failure = account.failure === 'catalog' ? t('chatGptCatalogFailed')
    : account.failure === 'answer' ? t('chatGptAnswerFailed') : t('chatGptConnectionFailed')
  return (
    <section id="chatgpt-account" className={styles['card']} aria-label={t('chatGptTitle')}>
      <div className={styles['head']}>
        <div className={styles['identity']}>
          <h3 className={styles['title']}>{t('chatGptTitle')}</h3>
          <span className={styles['tag']}>{t('chatGptSubscription')}</span>
        </div>
        {account.connected ? <span className={styles['connected']}>{t('chatGptConnected')}</span> : null}
      </div>
      <p className={styles['description']}>{t('chatGptDescription')}</p>
      <div className={styles['actions']}>
        <Button variant="primary" size="sm" disabled={busy || !account.writable || !account.available}
          onClick={() => { void controller.connect() }}>
          {account.phase === 'authorizing' ? t('chatGptConnecting')
            : account.connected ? t('chatGptSwitchAccount') : t('chatGptConnect')}
        </Button>
        {account.connected ? <>
          <Button variant="outline" size="sm" disabled={busy || !account.writable}
            onClick={() => { void controller.refreshModels() }}>{t('chatGptFetchModels')}</Button>
          <Button variant="ghost" size="sm" disabled={busy || !account.writable}
            onClick={() => { setDisconnectOpen(true) }}>{t('chatGptDisconnect')}</Button>
        </> : null}
        {account.phase === 'authorizing' || account.phase === 'syncing'
          ? <Button variant="outline" size="sm" onClick={() => { void controller.cancel() }}>{t('cancel')}</Button> : null}
      </div>
      {account.phase === 'loading' || account.phase === 'syncing' || account.phase === 'disconnecting'
        ? <p className={styles['hint']} role="status">{account.phase === 'syncing'
          ? Object.values(account.tests).some(status => status === 'running') ? t('chatGptTesting') : t('chatGptSyncing')
          : account.phase === 'disconnecting' ? t('chatGptDisconnecting') : t('chatGptLoading')}</p> : null}
      {account.notice === null ? null : <div className={styles['notice']} role="status">
        <p>{account.notice.message}</p>
        {account.notice.url === undefined ? null
          : <a href={account.notice.url} target="_blank" rel="noopener noreferrer">{t('chatGptOpenLogin')}</a>}
        {account.notice.code === undefined ? null : <code>{account.notice.code}</code>}
      </div>}
      {account.prompt === null ? null : <form className={styles['prompt']} onSubmit={(event) => {
        event.preventDefault()
        if (account.prompt !== null && answer.trim().length > 0) void controller.answer(account.prompt.id, answer)
      }}>
        <label htmlFor={promptId}>{account.prompt.value.message}</label>
        {account.prompt.value.kind === 'select'
          ? <select id={promptId} className={`${formStyles['input']} ${formStyles['selectInput']}`}
            value={answer} onChange={(event) => { setAnswer(event.target.value) }}>
            <option value="">{t('chatGptChooseOption')}</option>
            {account.prompt.value.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          : <Input id={promptId} type={account.prompt.value.kind === 'secret' ? 'password' : 'text'}
            value={answer} autoComplete="off" placeholder={account.prompt.value.placeholder}
            onChange={(event) => { setAnswer(event.target.value) }} />}
        <Button type="submit" variant="outline" size="sm" disabled={answer.trim().length === 0}>{t('chatGptSubmit')}</Button>
      </form>}
      {account.failure === null ? null : <div className={styles['actions']}>
        <p className={styles['error']} role="alert">{failure}</p>
        {account.failure === 'connection'
          ? <Button variant="outline" size="sm" disabled={busy} onClick={() => { void controller.load() }}>{t('retry')}</Button> : null}
      </div>}
      {account.candidates.length === 0 ? null : <div className={styles['candidates']}>
        <div className={styles['candidateHead']}>
          <span>{t('chatGptCandidates')}</span>
          <span className={styles['count']}>{account.selectedIds.length} / {account.candidates.length}</span>
        </div>
        <div className={styles['modelList']}>
          {account.candidates.map(model => <label key={model.id} className={styles['model']}>
            <input type="checkbox" checked={account.selectedIds.includes(model.id)} disabled={busy}
              onChange={() => { controller.toggleModel(model.id) }} />
            <span className={styles['modelIdentity']}><span>{model.name ?? model.id}</span>
              {model.name !== undefined && model.name !== model.id ? <span className={styles['modelId']}>{model.id}</span> : null}
            </span>
            <span className={`${styles['testStatus']} ${account.tests[model.id] === 'passed' ? styles['passed']
              : account.tests[model.id] === 'failed' ? styles['failed'] : ''}`}>
              {account.tests[model.id] === 'passed' ? t('chatGptTestPassed')
                : account.tests[model.id] === 'failed' ? t('chatGptTestFailed')
                  : account.tests[model.id] === 'running' ? t('chatGptTestRunning') : t('chatGptTestPending')}
            </span>
          </label>)}
        </div>
        <div className={styles['saveRow']}>
          <p className={styles['hint']}>{t('chatGptCandidatesHint')}</p>
          <Button variant="primary" size="sm" disabled={busy || account.selectedIds.length === 0 || !account.writable}
            onClick={() => { void controller.saveModels() }}>{t('chatGptSaveModels')}</Button>
        </div>
      </div>}
      {account.connected && account.modelCount > 0
        ? <p className={styles['hint']}>{t('chatGptSavedModels').replace('{count}', String(account.modelCount))}</p> : null}
      <p className={styles['footnote']}>{t('chatGptAvailability')}</p>
      {props.onClose === undefined ? null : <div className={styles['actions']}>
        <Button variant="outline" size="sm" onClick={props.onClose}>{t('close')}</Button>
      </div>}
      <Modal open={disconnectOpen} onClose={() => { setDisconnectOpen(false) }} title={t('chatGptDisconnectTitle')} headless>
        <div className={styles['confirm']}>
          <h3 className={styles['title']}>{t('chatGptDisconnectTitle')}</h3>
          <p className={styles['description']}>{t('chatGptDisconnectDescription')}</p>
          <div className={styles['actions']}>
            <Button variant="outline" onClick={() => { setDisconnectOpen(false) }}>{t('cancel')}</Button>
            <Button variant="primary" onClick={() => { setDisconnectOpen(false); void controller.disconnect() }}>
              {t('chatGptDisconnect')}
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  )
}
