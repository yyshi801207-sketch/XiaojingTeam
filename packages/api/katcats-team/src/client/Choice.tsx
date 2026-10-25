/** Small selection control using the shared menu material and dismissal lifecycle. */
import { useState } from 'react'
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './team.module.css'

/**
 * Render a labeled choice over plain values.
 * @param props - Current value, localized options and explicit change callback.
 * @returns A shared button and body-portaled selection menu.
 */
export function Choice({ id, label, value, options, disabled, descriptionId, onChange }: {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly options: readonly { readonly value: string; readonly label: string; readonly disabled?: boolean }[]
  readonly disabled: boolean
  readonly descriptionId?: string
  readonly onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  return <Menu open={open} portal onClose={() => { setOpen(false) }} selectedId={value}
    items={options.map(option => ({ id: option.value, label: option.label,
      ...option.disabled === undefined ? {} : { disabled: option.disabled } }))}
    onSelect={(next) => { onChange(next); setOpen(false) }}
    anchor={<Button id={id} className={css.choice} variant="outline" aria-label={label}
      {...descriptionId === undefined ? {} : { 'aria-describedby': descriptionId }}
      aria-expanded={open} aria-haspopup="menu" disabled={disabled} onClick={() => { setOpen(current => !current) }}>
      {options.find(option => option.value === value)?.label}
    </Button>} />
}
