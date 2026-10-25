// @vitest-environment jsdom
/** Shared entity actions remain owner-controlled over synthetic conversation IDs. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { BotId, GroupId } from '../src/types.ts'
import type { ChatId } from '../src/chats-types.ts'
import { EntityMenu } from '../src/client/EntityMenu.tsx'
import type { EntityMenuProps, SidebarEntity } from '../src/client/EntityMenu.tsx'

const current = 'current' as GroupId
const target = 'shared' as GroupId
const labels = { pin: 'Pin', unpin: 'Unpin', moveTo: 'Move to', rename: 'Rename', copyId: 'Copy conversation ID', remove: 'Delete' }
const bot: SidebarEntity = { kind: 'bot', id: 'writer' as BotId, name: 'Writer', sessionId: 'writer-session' as SessionId, currentGroup: current }
const chat: SidebarEntity = { kind: 'chat', id: 'editorial' as ChatId, name: 'Editorial', sessionId: 'chat-session' as SessionId, currentGroup: current }

function setup(entity: SidebarEntity = bot): EntityMenuProps {
  return { entity, open: true, pinned: false, targets: [{ id: current, name: 'Current' }, { id: target, name: 'Shared' }], labels,
    busy: false, pinAvailable: true, getAnchorRect: () => new DOMRect(20, 20, 28, 28), onClose: vi.fn(),
    onPin: vi.fn(), onMove: vi.fn(), onRename: vi.fn(), onCopyId: vi.fn(), onRemove: vi.fn() }
}

afterEach(cleanup)

describe('entity menu', () => {
  it.each([bot, chat])('offers the same five neutral actions for $kind entities', (entity) => {
    const props = setup(entity)
    render(<EntityMenu {...props} />)
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      labels.pin, labels.moveTo, labels.rename, labels.copyId, labels.remove,
    ])
    expect(screen.getAllByRole('menuitem').every(item => item.querySelector('svg') !== null)).toBe(true)
    fireEvent.click(screen.getByRole('menuitem', { name: labels.pin }))
    fireEvent.click(screen.getByRole('menuitem', { name: labels.rename }))
    fireEvent.click(screen.getByRole('menuitem', { name: labels.copyId }))
    fireEvent.click(screen.getByRole('menuitem', { name: labels.remove }))
    expect(props.onPin).toHaveBeenCalledOnce()
    expect(props.onRename).toHaveBeenCalledOnce()
    expect(props.onCopyId).toHaveBeenCalledOnce()
    expect(props.onRemove).toHaveBeenCalledOnce()
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('uses the supplied confirmed pin state without creating an optimistic pin', () => {
    const props = setup()
    const { rerender } = render(<EntityMenu {...props} />)
    fireEvent.click(screen.getByRole('menuitem', { name: labels.pin }))
    expect(screen.queryByRole('menuitem', { name: labels.unpin })).toBeNull()
    rerender(<EntityMenu {...props} pinned />)
    expect(screen.getByRole('menuitem', { name: labels.unpin })).toBeTruthy()
  })

  it('nests destinations and rejects the saved group while keeping stable group IDs', () => {
    const props = setup(chat)
    render(<EntityMenu {...props} />)
    expect(screen.queryByRole('menuitem', { name: 'Shared' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: labels.moveTo }))
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Current' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Current' }))
    expect(props.onMove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Shared' }))
    expect(props.onMove).toHaveBeenCalledExactlyOnceWith(target)
  })

  it('locks mutations while an owner action is pending and prevents pin changes before the pin snapshot is ready', () => {
    const props = setup()
    const { rerender } = render(<EntityMenu {...props} pinAvailable={false} />)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: labels.pin }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('menuitem', { name: labels.pin }))
    expect(props.onPin).not.toHaveBeenCalled()
    rerender(<EntityMenu {...props} busy />)
    expect(screen.getAllByRole<HTMLButtonElement>('menuitem').every(item => item.disabled)).toBe(true)
    fireEvent.click(screen.getByRole('menuitem', { name: labels.remove }))
    expect(props.onRemove).not.toHaveBeenCalled()
  })

  it('removes a deleted destination from an open submenu and closes only when the owner requests it', () => {
    const props = setup()
    const { rerender } = render(<EntityMenu {...props} />)
    fireEvent.click(screen.getByRole('menuitem', { name: labels.moveTo }))
    rerender(<EntityMenu {...props} targets={[{ id: current, name: 'Current' }]} />)
    expect(screen.queryByRole('menuitem', { name: 'Shared' })).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalledOnce()
    rerender(<EntityMenu {...props} open={false} />)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
