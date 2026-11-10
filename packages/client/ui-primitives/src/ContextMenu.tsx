/** Pointer and keyboard entry into the shared menu without adding a layout wrapper. */
import { useCallback, useRef, useState, type KeyboardEventHandler, type MouseEventHandler, type ReactNode } from 'react'
import { Menu, type MenuEntry } from './Menu.tsx'
import css from './Menu.module.css'

/** Event handlers attached to the existing focusable object. */
export interface ContextMenuTrigger {
  readonly onContextMenu: MouseEventHandler<HTMLElement>
  readonly onKeyDown: KeyboardEventHandler<HTMLElement>
}

/** Shared object actions; features own localized labels and permitted actions. */
export interface ContextMenuProps {
  readonly items: readonly MenuEntry[]
  readonly onSelect: (id: string) => void
  readonly children: (trigger: ContextMenuTrigger) => ReactNode
  readonly disabled?: boolean
  readonly listClassName?: string | undefined
}

function usesNativeMenu(target: EventTarget | null): boolean {
  return target instanceof Element
    && target.closest('input, textarea, [contenteditable]:not([contenteditable="false"]), a[href], img, video, audio') !== null
}

/**
 * Open actions at the pointer or focused object and retain native text-editing menus.
 * @param props - Actions and the existing object receiving pointer and keyboard handlers.
 * @returns The original object and a viewport-clamped menu with wider action rows while open.
 */
export function ContextMenu({ items, onSelect, children, disabled = false, listClassName }: ContextMenuProps): ReactNode {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null)
  const target = useRef<HTMLElement | null>(null)
  const getReturnFocusTarget = useCallback(() => target.current, [])
  const getAnchorRect = useCallback(() => point === null ? null : new DOMRect(point.x, point.y, 0, 0), [point])
  const trigger: ContextMenuTrigger = {
    onContextMenu: (event) => {
      if (disabled || event.defaultPrevented || usesNativeMenu(event.target) || window.getSelection()?.isCollapsed === false) return
      event.preventDefault()
      event.stopPropagation()
      target.current = event.currentTarget
      setPoint({ x: event.clientX, y: event.clientY })
    },
    onKeyDown: (event) => {
      if (disabled || event.defaultPrevented || event.nativeEvent.isComposing || usesNativeMenu(event.target)) return
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
      if (event.altKey || event.ctrlKey || event.metaKey) return
      event.preventDefault()
      event.stopPropagation()
      target.current = event.currentTarget
      const rect = event.currentTarget.getBoundingClientRect()
      setPoint({ x: rect.left, y: rect.bottom })
    },
  }
  return <>
    {children(trigger)}
    <Menu open={point !== null && !disabled} anchor={null} items={items} portal autoFocus spacious className={css.contextRoot}
      getAnchorRect={getAnchorRect} getReturnFocusTarget={getReturnFocusTarget} listClassName={listClassName}
      onClose={() => { setPoint(null) }} onSelect={(id) => { setPoint(null); onSelect(id) }} />
  </>
}
