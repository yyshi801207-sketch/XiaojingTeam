// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContextMenu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

const items = [
  { id: 'copy', label: 'Copy task' },
  { id: 'remove', label: 'Remove task', disabled: true },
  { id: 'details', label: 'View details' },
]

afterEach(() => {
  cleanup()
  window.getSelection()?.removeAllRanges()
  vi.restoreAllMocks()
})

function TaskMenu({ disabled = false, onSelect = () => {} }: { disabled?: boolean; onSelect?: (id: string) => void }) {
  return <>
    <ContextMenu items={items} onSelect={onSelect} disabled={disabled}>
      {trigger => <section {...trigger} tabIndex={0} aria-label="Task">
        <span>Task summary</span>
        <input aria-label="Edit task" />
        <textarea aria-label="Notes" />
        <div contentEditable suppressContentEditableWarning>Editable summary</div>
        <div contentEditable="plaintext-only" suppressContentEditableWarning>Plain text draft</div>
        <a href="https://example.com/task">Task source</a>
        <img src="data:image/png;base64," alt="Task image" />
      </section>}
    </ContextMenu>
    <input aria-label="Other control" />
  </>
}

describe('ContextMenu', () => {
  it('opens at the pointer and keeps the menu outside an overflow-clipped object', () => {
    const { container } = render(<TaskMenu />)
    const task = screen.getByRole('region', { name: 'Task' })
    vi.spyOn(task, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 60, 200, 70))
    expect(fireEvent.contextMenu(task, { clientX: 320, clientY: 180 })).toBe(false)
    const menu = screen.getByRole('menu')
    expect(menu.style.left).toBe('320px')
    expect(menu.style.top).toBe('184px')
    expect(menu.parentElement).toBe(document.body)
    expect(container.contains(menu)).toBe(false)
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Copy task' }))
  })

  it('keeps a pointer menu inside the right and bottom viewport edges', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'menu' ? 180 : 0
    })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'menu' ? 112 : 0
    })
    render(<TaskMenu />)
    fireEvent.contextMenu(screen.getByRole('region', { name: 'Task' }), { clientX: window.innerWidth - 1, clientY: window.innerHeight - 1 })
    const menu = screen.getByRole('menu')
    expect(Number.parseFloat(menu.style.left) + 180).toBeLessThanOrEqual(window.innerWidth - 12)
    expect(Number.parseFloat(menu.style.top) + 112).toBeLessThanOrEqual(window.innerHeight - 12)
  })

  it.each([
    { key: 'F10', shiftKey: true },
    { key: 'ContextMenu' },
  ])('opens from the keyboard with $key, skips disabled actions, and restores focus on Escape', (key) => {
    render(<TaskMenu />)
    const task = screen.getByRole('region', { name: 'Task' })
    vi.spyOn(task, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 60, 200, 70))
    task.focus()
    expect(fireEvent.keyDown(task, key)).toBe(false)
    expect(screen.getByRole('menu').style.left).toBe('40px')
    expect(screen.getByRole('menu').style.top).toBe('134px')
    const copy = screen.getByRole('menuitem', { name: 'Copy task' })
    expect(document.activeElement).toBe(copy)
    fireEvent.keyDown(copy, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'View details' }))
    fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(task)
  })

  it('focuses the first action after the portaled menu becomes visible', () => {
    // oxlint-disable-next-line typescript/unbound-method -- Called below with the target element as its receiver.
    const focus = HTMLElement.prototype.focus
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      // Browsers refuse focus while the portal is hidden for its initial measurement.
      if (this.closest<HTMLElement>('[role="menu"]')?.style.visibility === 'hidden') return
      focus.call(this, options)
    })
    render(<TaskMenu />)
    const task = screen.getByRole('region', { name: 'Task' })
    task.focus()
    fireEvent.keyDown(task, { key: 'F10', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Copy task' }))
    fireEvent.keyDown(document.activeElement ?? document, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'View details' }))
  })

  it('returns focus to the original object after selection without activating the row itself', async () => {
    const onSelect = vi.fn()
    const onRowClick = vi.fn()
    render(<div onClick={onRowClick}><TaskMenu onSelect={onSelect} /></div>)
    const task = screen.getByRole('region', { name: 'Task' })
    fireEvent.contextMenu(task)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy task' }))
    expect(onSelect).toHaveBeenCalledWith('copy')
    expect(onRowClick).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
    await act(async () => { await Promise.resolve() })
    expect(document.activeElement).toBe(task)
  })

  it('closes for outside pointer input without taking focus back from that control', async () => {
    render(<TaskMenu />)
    fireEvent.contextMenu(screen.getByRole('region', { name: 'Task' }))
    const other = screen.getByRole('textbox', { name: 'Other control' })
    fireEvent.pointerDown(other)
    other.focus()
    expect(screen.queryByRole('menu')).toBeNull()
    await act(async () => { await Promise.resolve() })
    expect(document.activeElement).toBe(other)
  })

  it.each(['Edit task', 'Notes', 'Editable summary', 'Plain text draft', 'Task source', 'Task image'])(
    'preserves the native right-click menu on %s', (name) => {
      render(<TaskMenu />)
      const target = screen.queryByLabelText(name) ?? screen.queryByAltText(name) ?? screen.getByText(name)
      expect(fireEvent.contextMenu(target)).toBe(true)
      expect(screen.queryByRole('menu')).toBeNull()
    },
  )

  it('preserves native text-selection actions on a selected task summary', () => {
    render(<TaskMenu />)
    const summary = screen.getByText('Task summary')
    const range = document.createRange()
    range.selectNodeContents(summary)
    window.getSelection()?.addRange(range)
    expect(fireEvent.contextMenu(summary)).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(window.getSelection()?.toString()).toBe('Task summary')
  })

  it('still offers object actions when the browser has no Selection object', () => {
    vi.spyOn(window, 'getSelection').mockReturnValue(null)
    render(<TaskMenu />)
    fireEvent.contextMenu(screen.getByRole('region', { name: 'Task' }))
    expect(screen.getByRole('menu')).toBeDefined()
  })

  it('leaves editable keyboard shortcuts, IME input, and unrelated modifiers alone', () => {
    render(<TaskMenu />)
    expect(fireEvent.keyDown(screen.getByRole('textbox', { name: 'Edit task' }), { key: 'F10', shiftKey: true })).toBe(true)
    const task = screen.getByRole('region', { name: 'Task' })
    for (const key of [
      { key: 'F10' },
      { key: 'F10', shiftKey: true, isComposing: true },
      { key: 'ContextMenu', ctrlKey: true },
      { key: 'ContextMenu', altKey: true },
      { key: 'ContextMenu', metaKey: true },
    ]) expect(fireEvent.keyDown(task, key)).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('does not open while disabled or activate a disabled action', () => {
    const onSelect = vi.fn()
    const view = render(<TaskMenu disabled onSelect={onSelect} />)
    const task = screen.getByRole('region', { name: 'Task' })
    expect(fireEvent.contextMenu(task)).toBe(true)
    expect(fireEvent.keyDown(task, { key: 'ContextMenu' })).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
    view.rerender(<TaskMenu onSelect={onSelect} />)
    fireEvent.contextMenu(task)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove task' }))
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByRole('menu')).toBeDefined()
  })

  it('keeps focus in a dialog opened by an action', async () => {
    function DialogAction() {
      const [open, setOpen] = useState(false)
      return <>
        <TaskMenu onSelect={() => { setOpen(true) }} />
        <Modal open={open} title="Task details" closeLabel="Close" onClose={() => { setOpen(false) }}>
          <input aria-label="Task title" data-modal-autofocus />
        </Modal>
      </>
    }
    render(<DialogAction />)
    fireEvent.contextMenu(screen.getByRole('region', { name: 'Task' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'View details' }))
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Task details' }).contains(document.activeElement)).toBe(true)
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Task title' }))
  })
})
