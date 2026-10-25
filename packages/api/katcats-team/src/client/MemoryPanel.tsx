/** Owner-managed memories remain separated by explicit member, group and team scopes. */
import { useEffect, useId, useRef, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { MemoryAuthor, MemoryDeleteValue, MemoryEditRequest, MemoryEntry, MemoryFrame, MemoryList,
  MemoryListRequest, MemoryMutationValue, MemorySaveRequest, MemoryScope, MemorySelectRequest, MemoryShareRequest } from '../memory-types.ts'
import type { TeamView } from './model.ts'
import type { ChatView } from './chat-model.ts'
import { Choice } from './Choice.tsx'
import css from './team.module.css'

/** Existing owner Remote; no method reads or shares conversation history. */
export interface MemoryRemote {
  list(request: MemoryListRequest): Promise<RemoteResult<MemoryList>>
  follow(request: MemoryListRequest, signal: AbortSignal): AsyncIterable<MemoryFrame>
  save(request: MemorySaveRequest): Promise<RemoteResult<MemoryMutationValue>>
  edit(request: MemoryEditRequest): Promise<RemoteResult<MemoryMutationValue>>
  delete(request: MemorySelectRequest): Promise<RemoteResult<MemoryDeleteValue>>
  share(request: MemoryShareRequest): Promise<RemoteResult<MemoryMutationValue>>
}

/** One visible scope stream is disposed when its panel, query or scope changes. */
export interface MemorySubscription {
  /** @returns completion after the original scope stream has stopped. */
  dispose(): Promise<void>
}

/** Narrow owner operations; reads and mutations retain their explicit scopes and versions. */
export interface MemoryPanelInjected {
  readonly hooks: { readonly directory: ObservableSnapshot<TeamView>; readonly chats: ObservableSnapshot<ChatView> }
  readonly watch: (request: MemoryListRequest, replace: (value: MemoryList) => void, failed: () => void) => MemorySubscription
  readonly saveMemory: (request: MemorySaveRequest) => Promise<void>
  readonly editMemory: (request: MemoryEditRequest) => Promise<void>
  readonly deleteMemory: (request: MemorySelectRequest) => Promise<void>
  readonly shareMemory: (request: MemoryShareRequest) => Promise<void>
}

/** Existing per-Session right sidebar; choosing team memory is explicit. */
export type MemoryPanelProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'katcats.team'> & InjectFace<MemoryPanelInjected>

interface ScopeOption { readonly value: string; readonly label: string; readonly scope: MemoryScope }
const scopeKey = (scope: MemoryScope) => JSON.stringify(scope)

/**
 * Open member or group memory by default and expose explicit team sharing.
 * @param props - Scoped visible conversation and narrow memory operations.
 * @returns The selected memory scope, without loading other conversations.
 */
export function MemoryPanel(props: MemoryPanelProps) {
  const directory = props.useDirectory(view => view.snapshot)
  const groups = props.useChats(view => view.snapshot?.chats ?? [])
  const bot = directory?.bots.find(item => item.sessionId === props.sessionId)
  const chat = groups.find(item => item.rootSessionId === props.sessionId)
  const scope: MemoryScope | undefined = bot !== undefined ? { kind: 'bot', botId: bot.id }
    : chat === undefined ? undefined : { kind: 'group', chatId: chat.id }
  if (scope === undefined) return <p className={css.empty}>{props.t('memory.missing')}</p>
  const options: ScopeOption[] = [
    ...directory?.bots.map(item => ({ value: scopeKey({ kind: 'bot', botId: item.id }),
      label: item.name, scope: { kind: 'bot' as const, botId: item.id } })) ?? [],
    ...groups.map(item => ({ value: scopeKey({ kind: 'group', chatId: item.id }),
      label: item.name, scope: { kind: 'group' as const, chatId: item.id } })),
    { value: scopeKey({ kind: 'team' }), label: props.t('memory.team'), scope: { kind: 'team' } },
  ]
  return <MemoryScopes key={props.sessionId} {...props} initial={scope} options={options} />
}

function MemoryScopes({ initial, options, ...props }: MemoryPanelProps & {
  readonly initial: MemoryScope
  readonly options: readonly ScopeOption[]
}) {
  const [selected, setSelected] = useState(initial)
  const id = useId()
  return <div className={css.settings}>
    <label className={css.label} htmlFor={id}>{props.t('memory.scope')}</label>
    <Choice id={id} label={props.t('memory.scope')} value={scopeKey(selected)} disabled={false}
      options={options.map(option => ({ value: option.value, label: option.label }))}
      onChange={(value) => {
        const option = options.find(item => item.value === value)
        if (option !== undefined) setSelected(option.scope)
      }} />
    <p className={css.hint}>{props.t('memory.scopeHint')}</p>
    <MemoryScopeView key={scopeKey(selected)} {...props} scope={selected} options={options} />
  </div>
}

function MemoryScopeView({ scope, options, watch, saveMemory, editMemory, deleteMemory, shareMemory, t }: MemoryPanelProps & {
  readonly scope: MemoryScope
  readonly options: readonly ScopeOption[]
}) {
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [snapshot, setSnapshot] = useState<MemoryList | null>(null)
  const [failed, setFailed] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [mutationFailed, setMutationFailed] = useState(false)
  const active = useRef(true)
  const id = useId()
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => {
    let current = true
    setSnapshot(null)
    setFailed(false)
    const subscription = watch({ scope, ...query === '' ? {} : { query } }, (value) => {
      if (current) { setSnapshot(value); setFailed(false) }
    }, () => { if (current) setFailed(true) })
    return () => { current = false; void subscription.dispose() }
  }, [scope, query, refresh, watch])
  const name = (value: MemoryScope) => options.find(option => option.value === scopeKey(value))?.label ?? t('memory.missing')
  const author = (value: MemoryAuthor): string => {
    switch (value.kind) {
      case 'owner': return t('memory.owner')
      case 'bot': return name({ kind: 'bot', botId: value.botId })
      case 'group': return name({ kind: 'group', chatId: value.chatId })
    }
  }
  return <>
    <form className={css.memorySearch} onSubmit={(event) => { event.preventDefault(); setQuery(search.trim()) }}>
      <Input aria-label={t('memory.search')} value={search} onChange={(event) => { setSearch(event.target.value) }} />
      <Button type="submit" size="sm" variant="outline">{t('memory.search')}</Button>
      <Button size="sm" variant="outline" onClick={() => { setRefresh(value => value + 1) }}>{t('memory.refresh')}</Button>
    </form>
    {failed && <p role="alert">{t('memory.loadFailed')}</p>}
    {snapshot === null && !failed && <p role="status">{t('memory.loading')}</p>}
    <form onSubmit={(event) => {
      event.preventDefault()
      if (busy || text.trim() === '') return
      setBusy(true); setSaved(false); setMutationFailed(false)
      void saveMemory({ scope, text: text.trim() }).then(() => {
        if (active.current) { setText(''); setSaved(true) }
      }, () => { if (active.current) setMutationFailed(true) }).finally(() => { if (active.current) setBusy(false) })
    }}>
      <label className={css.label} htmlFor={`${id}-new`}>{t('memory.new')}</label>
      <textarea id={`${id}-new`} className={css.textarea} value={text} disabled={busy}
        placeholder={t('memory.newHint')} onChange={(event) => { setText(event.target.value); setSaved(false) }} />
      <div className={css.saveBar}><Button type="submit" size="sm" variant="outline" disabled={busy || text.trim() === ''}>{t('memory.add')}</Button></div>
      {saved && <p role="status">{t('memory.saved')}</p>}
      {mutationFailed && <p role="alert">{t('memory.mutationFailed')}</p>}
    </form>
    {snapshot?.entries.length === 0 && <p className={css.empty}>{t(query === '' ? 'memory.empty' : 'memory.noResults')}</p>}
    <div className={css.memoryList}>{snapshot?.entries.map(entry => <MemoryCard key={entry.id} entry={entry}
      options={options.filter(option => option.value !== scopeKey(scope))} scopeName={name} authorName={author}
      edit={editMemory} remove={deleteMemory} share={shareMemory} t={t} />)}</div>
  </>
}

function MemoryCard({ entry, options, scopeName, authorName, edit, remove, share, t }: {
  readonly entry: MemoryEntry
  readonly options: readonly ScopeOption[]
  readonly scopeName: (scope: MemoryScope) => string
  readonly authorName: (author: MemoryAuthor) => string
  readonly edit: MemoryPanelInjected['editMemory']
  readonly remove: MemoryPanelInjected['deleteMemory']
  readonly share: MemoryPanelInjected['shareMemory']
  readonly t: MemoryPanelProps['t']
}) {
  const [draft, setDraft] = useState<{ readonly text: string; readonly version: number } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null)
  const [target, setTarget] = useState(options.find(option => option.scope.kind === 'team')?.value ?? options[0]?.value ?? '')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [shared, setShared] = useState(false)
  const active = useRef(true)
  const id = useId()
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const invoke = (command: () => Promise<void>, done: () => void): void => {
    if (busy) return
    setBusy(true); setFailed(false); setShared(false)
    void command().then(() => { if (active.current) done() }, () => { if (active.current) setFailed(true) })
      .finally(() => { if (active.current) setBusy(false) })
  }
  return <article className={css.memoryCard} aria-label={t('memory.entry')} aria-busy={busy}>
    {draft === null ? <p className={css.memoryText}>{entry.text}</p> : <>
      <label className={css.label} htmlFor={`${id}-text`}>{t('memory.editText')}</label>
      <textarea id={`${id}-text`} className={css.textarea} value={draft.text} disabled={busy}
        onChange={(event) => { setDraft({ ...draft, text: event.target.value }) }} /></>}
    <p className={css.hint}>{t('memory.author', { name: authorName(entry.author) })} · {new Date(entry.updatedAt).toLocaleString()}</p>
    {entry.source !== null && <p className={css.hint}>{t('memory.sharedSource', {
      scope: scopeName(entry.source.scope), name: authorName(entry.source.author), version: entry.source.version,
    })}</p>}
    <div className={css.approvalActions}>
      {draft === null ? <Button size="sm" variant="outline" disabled={busy} onClick={() => { setDraft({ text: entry.text, version: entry.version }) }}>{t('memory.edit')}</Button>
        : <><Button size="sm" disabled={busy} onClick={() => { setDraft(null) }}>{t('team.cancel')}</Button>
          <Button size="sm" variant="outline" disabled={busy || draft.text.trim() === ''} onClick={() => {
            invoke(() => edit({ id: entry.id, expectedVersion: draft.version, text: draft.text.trim() }), () => { setDraft(null) })
          }}>{t('memory.saveEdit')}</Button></>}
      <Button size="sm" disabled={busy} onClick={() => { setConfirmDelete(entry.version) }}>{t('memory.delete')}</Button>
    </div>
    {confirmDelete !== null && <div className={css.memoryDelete} role="group" aria-label={t('memory.deleteConfirm')}>
      <p>{t('memory.deleteConfirm')}</p><Button size="sm" disabled={busy} onClick={() => { setConfirmDelete(null) }}>{t('team.cancel')}</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => {
        invoke(() => remove({ id: entry.id, expectedVersion: confirmDelete }), () => { setConfirmDelete(null) })
      }}>{t('memory.confirmDelete')}</Button>
    </div>}
    <details className={css.memoryShare}><summary>{t('memory.share')}</summary>
      <p className={css.hint}>{t('memory.shareHint')}</p>
      <label className={css.label} htmlFor={`${id}-target`}>{t('memory.target')}</label>
      <Choice id={`${id}-target`} label={t('memory.target')} value={target} disabled={busy}
        options={options.map(option => ({ value: option.value, label: option.label }))} onChange={setTarget} />
      <Button size="sm" variant="outline" disabled={busy || !options.some(option => option.value === target)} onClick={() => {
        const option = options.find(item => item.value === target)
        if (option !== undefined) invoke(
          () => share({ id: entry.id, expectedVersion: entry.version, target: option.scope }), () => { setShared(true) },
        )
      }}>{t('memory.shareCopy')}</Button>
    </details>
    {shared && <p role="status">{t('memory.shared')}</p>}
    {failed && <p role="alert">{t('memory.mutationFailed')}</p>}
  </article>
}
