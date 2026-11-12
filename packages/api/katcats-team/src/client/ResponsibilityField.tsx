/** Read-only responsibility text with an explicit inline editor. */
import { useEffect, useRef, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { Button, IconChevronDownOutlineRegular, IconEditOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import teamCss from './team.module.css'
import css from './responsibility-field.module.css'

const previewLines = 8

/**
 * Show an eight-line responsibility preview and save edits independently of the surrounding settings.
 * @param props - Field identity, displayed role, localized labels and optional scoped save command.
 * @returns A read-only role card unless a save command enables editing; failed saves retain the draft.
 */
export function ResponsibilityField({ id, label, value, placeholder, disabled, t, save }: {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly placeholder: string
  readonly disabled: boolean
  readonly t: TranslateNS<'katcats.team'>
  readonly save?: (value: string) => Promise<void>
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const text = useRef<HTMLParagraphElement>(null)
  const saving = useRef(false)
  const headingId = id + '-label'
  const preview = id + '-preview'
  const editing = draft !== null && save !== undefined
  const editLabel = t('role.edit')
  const disclosureLabel = t(expanded ? 'role.collapse' : 'role.expand')

  useEffect(() => {
    const paragraph = text.current
    if (editing || paragraph === null) return
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(paragraph).lineHeight)
      setOverflows(paragraph.offsetHeight > Math.ceil(lineHeight * previewLines))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(paragraph)
    return () => { observer.disconnect() }
  }, [editing, value, placeholder])

  const submit = async (): Promise<void> => {
    if (save === undefined || disabled || saving.current || draft === null || draft === value) return
    saving.current = true
    setPending(true)
    try {
      await save(draft)
      setDraft(null)
    } catch (_error) {
      // The settings frame reports the failure. Keep the draft available.
    } finally {
      saving.current = false
      setPending(false)
    }
  }

  return <section className={css.card} aria-labelledby={headingId} aria-busy={pending}>
    <header className={css.header}>
      <h3 id={headingId} className={teamCss.label}>{label}</h3>
      {save !== undefined && (!editing ? <Tooltip label={editLabel} disabled={disabled} side="top" portal>
        <Button type="button" size="sm" variant="ghost" className={css.edit} aria-label={editLabel}
          icon={<IconEditOutlineRegular size={14} />} disabled={disabled} onClick={() => { setDraft(value) }} />
      </Tooltip> : <div className={css.actions}>
        <Button type="button" size="sm" variant="ghost" disabled={pending}
          onClick={() => { if (!saving.current) setDraft(null) }}>{t('role.cancel')}</Button>
        <Button type="button" size="sm" variant="outline" disabled={disabled || pending || draft === value}
          onClick={() => { void submit() }}>{t(pending ? 'role.saving' : 'role.save')}</Button>
      </div>)}
    </header>
    {!editing ? <div className={css.text} data-empty={value === ''}>
      <div id={preview} className={css.preview} data-expanded={expanded}
        style={expanded ? undefined : { maxBlockSize: `${previewLines}lh` }}>
        <p ref={text} className={css.content}>{value || placeholder}</p>
      </div>
      {overflows && <Tooltip label={disclosureLabel} side="top" portal>
        <Button size="sm" variant="ghost" className={css.disclosure} aria-label={disclosureLabel}
          aria-controls={preview} aria-expanded={expanded} onClick={() => { setExpanded(current => !current) }}
          icon={<IconChevronDownOutlineRegular size={14} aria-hidden="true" />} />
      </Tooltip>}
    </div>
      : <textarea id={id} aria-labelledby={headingId} className={css.editor} rows={3} autoFocus
        value={draft} placeholder={placeholder} disabled={disabled || pending}
        onChange={event => { setDraft(event.currentTarget.value) }} />}
  </section>
}
