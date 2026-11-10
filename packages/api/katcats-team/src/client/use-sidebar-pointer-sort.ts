/** Pointer-driven sidebar ordering that moves the existing rows rather than a drag image. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { GroupId } from '../types.ts'

/** One currently rendered sidebar entry, in its displayed order. */
export interface SidebarSortItem {
  readonly sessionId: SessionId
  readonly groupId: GroupId
  readonly pinned: boolean
}

interface SortOptions {
  readonly scrollList: RefObject<HTMLDivElement | null>
  readonly items: readonly SidebarSortItem[]
  readonly enabled: boolean
  readonly onCommit: (groupId: GroupId, ids: readonly SessionId[]) => void
}

interface Row {
  readonly item: SidebarSortItem
  readonly node: HTMLElement
  readonly top: number
  readonly height: number
}

interface Gesture {
  readonly item: SidebarSortItem
  readonly items: readonly SidebarSortItem[]
  readonly list: HTMLDivElement
  readonly button: HTMLButtonElement
  readonly rows: readonly Row[]
  readonly source: Row
  readonly pointerId: number
  readonly startX: number
  readonly startY: number
  readonly startScroll: number
  started: boolean
  x: number
  y: number
  order: readonly SessionId[]
  valid: boolean
  frame: number | null
  lastFrame: number | null
  detach: () => void
}

function clearRows(gesture: Gesture): void {
  gesture.list.removeAttribute('data-sidebar-sorting')
  for (const { node } of gesture.rows) {
    node.style.removeProperty('--sidebar-sort-y')
    node.removeAttribute('data-sort-active')
    node.removeAttribute('data-sort-shifting')
  }
}

function sameItems(left: readonly SidebarSortItem[], right: readonly SidebarSortItem[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index]
    return item.sessionId === other?.sessionId && item.groupId === other.groupId && item.pinned === other.pinned
  })
}

function moveRows(gesture: Gesture): void {
  const { list, source, rows } = gesture
  const first = rows[0]
  const last = rows[rows.length - 1]
  if (first === undefined || last === undefined) return
  const viewport = list.getBoundingClientRect()
  const pointer = gesture.y + list.scrollTop
  const pointerTop = source.top + gesture.y - gesture.startY + list.scrollTop - gesture.startScroll
  const top = Math.max(first.top, Math.min(last.top + last.height - source.height, pointerTop))
  const otherRows = rows.filter(row => row !== source)
  const center = pointerTop + source.height / 2
  const index = otherRows.filter(row => pointerTop >= source.top
    ? center >= row.top + row.height / 2 : center > row.top + row.height / 2).length
  const ordered = [...otherRows]
  ordered.splice(index, 0, source)
  gesture.order = ordered.map(row => row.item.sessionId)
  gesture.valid = gesture.x >= viewport.left && gesture.x <= viewport.right
    && gesture.y >= viewport.top && gesture.y <= viewport.bottom
    && pointer >= first.top && pointer <= last.top + last.height
  let nextTop = first.top
  for (const [slot, row] of ordered.entries()) {
    const offset = row === source ? top - source.top : nextTop - row.top
    row.node.style.setProperty('--sidebar-sort-y', `${offset}px`)
    if (row !== source) row.node.setAttribute('data-sort-shifting', 'true')
    const original = rows[slot]
    const following = rows[slot + 1]
    const gap = original === undefined || following === undefined ? 0 : following.top - original.top - original.height
    nextTop += row.height + gap
  }
}

/**
 * Move real sidebar rows under a mouse or pen and save one same-group, same-pin-layer reorder on release.
 * @param options - Visible identities, the existing scroll viewport, readiness, and a synchronous order action.
 * @returns Pointer entry, cancellation, click suppression, and whether a row is currently following the pointer.
 */
export function useSidebarPointerSort(options: SortOptions): {
  active: boolean
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>, sessionId: SessionId) => void
  cancel: () => void
  suppressClick: (event: MouseEvent) => boolean
} {
  const [active, setActive] = useState(false)
  const latest = useRef(options)
  const current = useRef<Gesture | null>(null)
  const completed = useRef<Gesture | null>(null)
  const blockClick = useRef(false)

  const finish = useCallback((commit: boolean): void => {
    const gesture = current.current
    if (gesture === null) return
    current.current = null
    gesture.detach()
    if (gesture.frame !== null) cancelAnimationFrame(gesture.frame)
    if (gesture.button.hasPointerCapture(gesture.pointerId)) gesture.button.releasePointerCapture(gesture.pointerId)
    if (!gesture.started) return
    blockClick.current = true
    const group = gesture.items.filter(item => item.groupId === gesture.item.groupId)
    const otherLayer = group.filter(item => item.pinned !== gesture.item.pinned).map(item => item.sessionId)
    const ids = gesture.item.pinned ? [...gesture.order, ...otherLayer] : [...otherLayer, ...gesture.order]
    const changed = group.some((item, index) => item.sessionId !== ids[index])
    if (commit && gesture.valid && changed) {
      completed.current = gesture
      try {
        latest.current.onCommit(gesture.item.groupId, ids)
      } finally {
        setActive(false)
      }
    } else {
      clearRows(gesture)
      setActive(false)
    }
  }, [])

  const cancel = useCallback((): void => { finish(false) }, [finish])

  useLayoutEffect(() => {
    latest.current = options
    const gesture = current.current
    if (gesture !== null && (!options.enabled || !sameItems(gesture.items, options.items)
      || !gesture.source.node.isConnected || gesture.source.node.closest('[hidden]') !== null)) cancel()
    if (completed.current !== null) {
      clearRows(completed.current)
      completed.current = null
    }
  })

  useEffect(() => {
    const resetClick = (): void => { blockClick.current = false }
    window.addEventListener('pointerdown', resetClick, true)
    return () => {
      window.removeEventListener('pointerdown', resetClick, true)
      const gesture = current.current
      if (gesture !== null) {
        gesture.detach()
        if (gesture.frame !== null) cancelAnimationFrame(gesture.frame)
        current.current = null
        if (gesture.button.hasPointerCapture(gesture.pointerId)) gesture.button.releasePointerCapture(gesture.pointerId)
        clearRows(gesture)
      }
      if (completed.current !== null) clearRows(completed.current)
    }
  }, [])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>, sessionId: SessionId): void => {
    if (event.button !== 0 || !event.isPrimary || event.pointerType === 'touch'
      || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    cancel()
    blockClick.current = false
    const { items, enabled, scrollList } = latest.current
    const list = scrollList.current
    const item = items.find(candidate => candidate.sessionId === sessionId)
    if (!enabled || list === null || item === undefined) return
    const nodes = new Map(Array.from(list.querySelectorAll<HTMLElement>('[data-sidebar-sort-entry]'))
      .map(node => [node.dataset.sidebarSortEntry, node]))
    const rows = items.filter(candidate => candidate.groupId === item.groupId && candidate.pinned === item.pinned)
      .flatMap((candidate) => {
        const node = nodes.get(candidate.sessionId)
        if (node === undefined || node.closest('[hidden]') !== null) return []
        const rect = node.getBoundingClientRect()
        return [{ item: candidate, node, top: rect.top + list.scrollTop, height: rect.height }]
      })
    const source = rows.find(row => row.item.sessionId === sessionId)
    if (source === undefined || rows.length < 2) return
    const gesture: Gesture = {
      item, items, list, rows, source, button: event.currentTarget, pointerId: event.pointerId,
      startX: event.clientX, startY: event.clientY, startScroll: list.scrollTop,
      x: event.clientX, y: event.clientY, order: rows.map(row => row.item.sessionId),
      started: false, valid: false, frame: null, lastFrame: null, detach: () => {},
    }
    current.current = gesture
    const frame = (time: number): void => {
      if (current.current !== gesture) return
      const viewport = list.getBoundingClientRect()
      const margin = Math.min(36, viewport.height / 4)
      const direction = gesture.y < viewport.top + margin ? -Math.min(1, (viewport.top + margin - gesture.y) / margin)
        : gesture.y > viewport.bottom - margin ? Math.min(1, (gesture.y - viewport.bottom + margin) / margin) : 0
      const elapsed = gesture.lastFrame === null ? 16 : Math.min(32, time - gesture.lastFrame)
      gesture.lastFrame = time
      if (gesture.x >= viewport.left && gesture.x <= viewport.right) {
        list.scrollTop = Math.max(0, Math.min(list.scrollHeight - list.clientHeight, list.scrollTop + direction * elapsed * .6))
      }
      moveRows(gesture)
      gesture.frame = requestAnimationFrame(frame)
    }
    const move = (pointer: PointerEvent): void => {
      if (pointer.pointerId !== gesture.pointerId) return
      gesture.x = pointer.clientX
      gesture.y = pointer.clientY
      if (!gesture.started) {
        if (Math.hypot(gesture.x - gesture.startX, gesture.y - gesture.startY) < 6) return
        gesture.started = true
        gesture.button.setPointerCapture(gesture.pointerId)
        list.setAttribute('data-sidebar-sorting', 'true')
        source.node.setAttribute('data-sort-active', 'true')
        window.getSelection()?.removeAllRanges()
        setActive(true)
        gesture.frame = requestAnimationFrame(frame)
      }
      pointer.preventDefault()
      moveRows(gesture)
    }
    const up = (pointer: PointerEvent): void => {
      if (pointer.pointerId !== gesture.pointerId) return
      gesture.x = pointer.clientX
      gesture.y = pointer.clientY
      if (gesture.started) moveRows(gesture)
      finish(true)
    }
    const interrupted = (pointer: PointerEvent): void => {
      if (pointer.pointerId === gesture.pointerId) cancel()
    }
    const key = (keyboard: KeyboardEvent): void => {
      if (keyboard.key !== 'Escape') return
      keyboard.preventDefault()
      keyboard.stopPropagation()
      cancel()
    }
    const nativeDrag = (drag: DragEvent): void => { drag.preventDefault() }
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', interrupted)
    window.addEventListener('lostpointercapture', interrupted)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', cancel)
    window.addEventListener('resize', cancel)
    window.addEventListener('dragstart', nativeDrag)
    gesture.detach = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', interrupted)
      window.removeEventListener('lostpointercapture', interrupted)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('resize', cancel)
      window.removeEventListener('dragstart', nativeDrag)
    }
  }, [cancel, finish])

  const suppressClick = useCallback((event: MouseEvent): boolean => {
    if (!blockClick.current || event.detail === 0) return false
    blockClick.current = false
    event.preventDefault()
    event.stopPropagation()
    return true
  }, [])

  return { active, onPointerDown, cancel, suppressClick }
}
