// @vitest-environment jsdom
/** Real-row pointer sorting, persistence timing, and interruption behavior. */
import { useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { GroupId } from '../src/types.ts'
import { useSidebarPointerSort, type SidebarSortItem } from '../src/client/use-sidebar-pointer-sort.ts'

const group = 'group' as GroupId
const otherGroup = 'other' as GroupId
const first = 'first' as SessionId
const second = 'second' as SessionId
const third = 'third' as SessionId
const fourth = 'fourth' as SessionId
const entries: readonly SidebarSortItem[] = [first, second, third].map(sessionId => ({ sessionId, groupId: group, pinned: false }))
let frames: Map<number, FrameRequestCallback>
let nextFrame: number

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number
  readonly pointerType: string
  readonly isPrimary: boolean
  constructor(type: string, options: PointerEventInit = {}) {
    super(type, options)
    this.pointerId = options.pointerId ?? 1
    this.pointerType = options.pointerType ?? 'mouse'
    this.isPrimary = options.isPrimary ?? true
  }
}

function Harness({ items = entries, enabled = true, commit, click }: {
  readonly items?: readonly SidebarSortItem[]
  readonly enabled?: boolean
  readonly commit: (id: GroupId, ids: readonly SessionId[]) => void
  readonly click: () => void
}) {
  const scrollList = useRef<HTMLDivElement>(null)
  const [saved, setSaved] = useState<readonly SessionId[]>([])
  const sorted = [...items].sort((left, right) => {
    if (saved.length === 0 || left.groupId !== right.groupId) return 0
    return saved.indexOf(left.sessionId) - saved.indexOf(right.sessionId)
  })
  const sorting = useSidebarPointerSort({ scrollList, items: sorted, enabled,
    onCommit: (id, ids) => { commit(id, ids); setSaved(ids) } })
  return <div onClickCapture={sorting.suppressClick}>
    <output data-testid="active">{String(sorting.active)}</output>
    <button type="button" data-testid="outside" onClick={click}>outside control</button>
    <div ref={scrollList} data-testid="list">
      {sorted.map(item => <div key={item.sessionId} data-sidebar-sort-entry={item.sessionId}>
        <button type="button" onPointerDown={(event) => { sorting.onPointerDown(event, item.sessionId) }} onClick={click}>{item.sessionId}</button>
      </div>)}
    </div>
  </div>
}

function setup(items = entries) {
  const commit = vi.fn<(id: GroupId, ids: readonly SessionId[]) => void>()
  const click = vi.fn()
  const rendered = render(<Harness items={items} commit={commit} click={click} />)
  const list = screen.getByTestId('list')
  vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 200))
  Object.defineProperties(list, { scrollHeight: { configurable: true, value: 500 }, clientHeight: { configurable: true, value: 200 } })
  for (const row of list.querySelectorAll<HTMLElement>('[data-sidebar-sort-entry]')) {
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => {
      const index = [...list.children].indexOf(row)
      const shift = Number.parseFloat(row.style.getPropertyValue('--sidebar-sort-y')) || 0
      return new DOMRect(0, 20 + index * 40 - list.scrollTop + shift, 200, 40)
    })
  }
  const button = (id: SessionId) => screen.getByRole('button', { name: id })
  const row = (id: SessionId) => button(id).parentElement!
  const order = () => [...list.children].map(child => child.getAttribute('data-sidebar-sort-entry'))
  return { ...rendered, list, commit, click, button, row, order,
    rerenderItems: (next: readonly SidebarSortItem[], enabled = true) => {
      rendered.rerender(<Harness items={next} enabled={enabled} commit={commit} click={click} />)
    } }
}

function down(target: HTMLElement, y: number, options: PointerEventInit = {}): void {
  fireEvent.pointerDown(target, { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, clientX: 80, clientY: y, ...options })
}

function move(y: number, options: PointerEventInit = {}): void {
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 80, clientY: y, ...options })
}

function up(y: number, options: PointerEventInit = {}): void {
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 80, clientY: y, ...options })
}

function frame(time: number): void {
  act(() => {
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(time)
  })
}

beforeEach(() => {
  frames = new Map()
  nextFrame = 0
  vi.stubGlobal('PointerEvent', TestPointerEvent)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  Object.defineProperties(HTMLElement.prototype, {
    setPointerCapture: { configurable: true, value: vi.fn() },
    hasPointerCapture: { configurable: true, value: vi.fn().mockReturnValue(false) },
    releasePointerCapture: { configurable: true, value: vi.fn() },
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('sidebar pointer sorting', () => {
  it('keeps an ordinary click intact before the movement threshold', () => {
    const { button, row, commit, click } = setup()
    down(button(first), 40)
    move(44)
    expect(screen.getByTestId('active').textContent).toBe('false')
    expect(row(first).style.getPropertyValue('--sidebar-sort-y')).toBe('')
    up(44)
    fireEvent.click(button(first), { detail: 1 })
    expect(click).toHaveBeenCalledOnce()
    expect(commit).not.toHaveBeenCalled()
  })

  it('moves the original row, slides neighbors, and commits once before clearing transforms', () => {
    const { button, row, order, commit, click, list } = setup()
    const source = row(first)
    down(button(first), 40)
    move(125)
    expect(row(first)).toBe(source)
    expect(source.getAttribute('data-sort-active')).toBe('true')
    expect(source.style.getPropertyValue('--sidebar-sort-y')).toBe('80px')
    expect(row(second).style.getPropertyValue('--sidebar-sort-y')).toBe('-40px')
    expect(row(third).style.getPropertyValue('--sidebar-sort-y')).toBe('-40px')
    expect(order()).toEqual([first, second, third])
    expect(commit).not.toHaveBeenCalled()
    up(125)
    expect(commit).toHaveBeenCalledExactlyOnceWith(group, [second, third, first])
    expect(order()).toEqual([second, third, first])
    expect(row(first)).toBe(source)
    expect(source.style.getPropertyValue('--sidebar-sort-y')).toBe('')
    expect(list.hasAttribute('data-sidebar-sorting')).toBe(false)
    expect(frames.size).toBe(0)
    up(125)
    fireEvent.click(button(first), { detail: 1 })
    expect(click).not.toHaveBeenCalled()
    down(button(first), 120)
    up(120)
    fireEvent.click(button(first), { detail: 1 })
    expect(click).toHaveBeenCalledOnce()
  })

  it('moves an entry upward and leaves its original slot available for the other rows', () => {
    const { button, row, commit } = setup()
    down(button(third), 120)
    move(35)
    expect(row(first).style.getPropertyValue('--sidebar-sort-y')).toBe('40px')
    expect(row(second).style.getPropertyValue('--sidebar-sort-y')).toBe('40px')
    up(35)
    expect(commit).toHaveBeenCalledExactlyOnceWith(group, [third, first, second])
  })

  it('preserves keyboard activation after a cancelled pointer drag', () => {
    const { button, click, commit } = setup()
    down(button(first), 40)
    move(125)
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(button(first), { detail: 0 })
    expect(click).toHaveBeenCalledOnce()
    up(125)
    fireEvent.click(button(first), { detail: 1 })
    expect(click).toHaveBeenCalledOnce()
    expect(commit).not.toHaveBeenCalled()
  })

  it('handles Escape before application shortcuts and releases its capture listener afterward', () => {
    const { button, commit } = setup()
    const applicationShortcut = vi.fn()
    window.addEventListener('keydown', applicationShortcut)
    try {
      down(button(first), 40)
      move(125)
      fireEvent.keyDown(button(first), { key: 'Escape' })
      expect(applicationShortcut).not.toHaveBeenCalled()
      expect(screen.getByTestId('active').textContent).toBe('false')
      expect(commit).not.toHaveBeenCalled()
      fireEvent.keyDown(button(first), { key: 'Escape' })
      expect(applicationShortcut).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener('keydown', applicationShortcut)
    }
  })

  it.each(['Escape', 'pointercancel', 'blur'] as const)('preserves a new click on an outside control after %s cancels the drag', (reason) => {
    const { button, click, commit } = setup()
    down(button(first), 40)
    move(125)
    if (reason === 'Escape') fireEvent.keyDown(button(first), { key: 'Escape' })
    else if (reason === 'blur') fireEvent.blur(window)
    else fireEvent.pointerCancel(window, { pointerId: 1 })
    const outside = screen.getByTestId('outside')
    down(outside, 5)
    fireEvent.click(outside, { detail: 1 })
    expect(click).toHaveBeenCalledOnce()
    expect(commit).not.toHaveBeenCalled()
  })

  it('retains the pinned layer while saving the complete group order', () => {
    const { button, commit } = setup([{ ...entries[0]!, pinned: true }, entries[1]!, entries[2]!])
    down(button(third), 120)
    move(75)
    up(75)
    expect(commit).toHaveBeenCalledExactlyOnceWith(group, [first, third, second])
  })

  it.each(['pinned row', 'other group', 'outside viewport'] as const)('does not save a drop over %s', (target) => {
    const items = target === 'pinned row' ? [{ ...entries[0]!, pinned: true }, entries[1]!, entries[2]!]
      : [...entries, { sessionId: fourth, groupId: otherGroup, pinned: false }]
    const { button, row, commit } = setup(items)
    down(button(third), 120)
    const y = target === 'pinned row' ? 35 : target === 'other group' ? 165 : 250
    move(y)
    up(y)
    expect(commit).not.toHaveBeenCalled()
    expect(row(third).style.getPropertyValue('--sidebar-sort-y')).toBe('')
  })

  it.each(['Escape', 'pointercancel', 'lostpointercapture', 'blur', 'resize'] as const)('cancels on %s without persisting or leaking frames', (reason) => {
    const { button, row, commit } = setup()
    down(button(first), 40)
    move(125)
    if (reason === 'Escape') fireEvent.keyDown(window, { key: 'Escape' })
    else if (reason === 'blur') fireEvent.blur(window)
    else if (reason === 'resize') fireEvent.resize(window)
    else fireEvent(window, new TestPointerEvent(reason, { pointerId: 1 }))
    expect(screen.getByTestId('active').textContent).toBe('false')
    expect(row(first).hasAttribute('data-sort-active')).toBe(false)
    expect(row(second).style.getPropertyValue('--sidebar-sort-y')).toBe('')
    expect(frames.size).toBe(0)
    up(125)
    expect(commit).not.toHaveBeenCalled()
  })

  it.each(['disabled', 'removed', 'group changed', 'pin changed', 'order changed'] as const)('cancels when the source data becomes %s', (reason) => {
    const { button, commit, rerenderItems } = setup()
    down(button(first), 40)
    move(125)
    const next = reason === 'removed' ? entries.slice(1) : reason === 'group changed'
      ? [{ ...entries[0]!, groupId: otherGroup }, ...entries.slice(1)] : reason === 'pin changed'
        ? [{ ...entries[0]!, pinned: true }, ...entries.slice(1)] : reason === 'order changed'
          ? [entries[1]!, entries[0]!, entries[2]!] : entries
    rerenderItems(next, reason !== 'disabled')
    up(125)
    expect(commit).not.toHaveBeenCalled()
    expect(frames.size).toBe(0)
    expect(screen.getByTestId('active').textContent).toBe('false')
  })

  it('auto-scrolls at the edge and includes the scroll delta in the row position', () => {
    const items = Array.from({ length: 10 }, (_, index) => ({ sessionId: `row-${index}` as SessionId, groupId: group, pinned: false }))
    const { button, row, list, commit } = setup(items)
    down(button(items[0]!.sessionId), 40)
    move(190)
    frame(16)
    frame(32)
    expect(list.scrollTop).toBeGreaterThan(0)
    expect(Number.parseFloat(row(items[0]!.sessionId).style.getPropertyValue('--sidebar-sort-y'))).toBeGreaterThan(150)
    up(190)
    expect(commit).toHaveBeenCalledOnce()
    expect(frames.size).toBe(0)
  })

  it('ignores a different pointer and preserves touch scrolling and right-click', () => {
    const { button, commit } = setup()
    down(button(first), 40, { pointerType: 'touch' })
    move(125)
    up(125)
    down(button(first), 40, { button: 2 })
    move(125)
    up(125)
    down(button(first), 40)
    move(125, { pointerId: 2 })
    up(125, { pointerId: 2 })
    expect(screen.getByTestId('active').textContent).toBe('false')
    expect(commit).not.toHaveBeenCalled()
    up(40)
  })

  it('releases listeners and restores the actual rows when unmounted mid-drag', () => {
    const { button, row, commit, unmount } = setup()
    const source = row(first)
    down(button(first), 40)
    move(125)
    unmount()
    expect(source.style.getPropertyValue('--sidebar-sort-y')).toBe('')
    expect(frames.size).toBe(0)
    move(35)
    up(35)
    expect(commit).not.toHaveBeenCalled()
  })
})
