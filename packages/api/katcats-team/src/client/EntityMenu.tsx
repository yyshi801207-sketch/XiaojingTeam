/** Shared actions for one saved Bot or group conversation. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  IconCopyOutlineRegular, IconEditOutlineRegular, IconFolderOpenOutlineRegular,
  IconPinFillRegular, IconPinOutlineRegular, IconTrashOutlineRegular, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { BotId, GroupId } from '../types.ts'
import type { ChatId } from '../chats-types.ts'

/** Stable product identity and the saved conversation acted on by the menu. */
export type SidebarEntity = ({ readonly kind: 'bot'; readonly id: BotId } | { readonly kind: 'chat'; readonly id: ChatId }) & {
  readonly sessionId: SessionId
  readonly name: string
  readonly currentGroup: GroupId | null
}

/** A permitted destination, supplied by the current product directory. */
export interface EntityMenuTarget {
  readonly id: GroupId
  readonly name: string
}

/** Localized action text supplied by the product locale owner. */
export interface EntityMenuLabels {
  readonly pin: string
  readonly unpin: string
  readonly moveTo: string
  readonly rename: string
  readonly copyId: string
  readonly remove: string
}

/** Actions are executed and confirmed by the product controller. */
export interface EntityMenuActions {
  /** Persist the requested pin state for the entity's conversation. */
  readonly pin: (entity: SidebarEntity, pinned: boolean) => Promise<void>
  /** Move an entity to a permitted group without changing its conversation. */
  readonly move: (entity: SidebarEntity, groupId: GroupId) => Promise<void>
  /** Open the entity-name editor. */
  readonly rename: (entity: SidebarEntity) => void
  /** Copy the public conversation ID, reporting unavailable clipboard access. */
  readonly copyId: (entity: SidebarEntity) => Promise<void>
  /** Open deletion confirmation; selecting a menu item never simulates deletion. */
  readonly remove: (entity: SidebarEntity) => void
}

/** Menu state and narrow callbacks; no record or pin state is kept here. */
export interface EntityMenuProps {
  readonly entity: SidebarEntity
  readonly open: boolean
  readonly pinned: boolean
  readonly targets: readonly EntityMenuTarget[]
  readonly labels: EntityMenuLabels
  readonly busy: boolean
  readonly pinAvailable: boolean
  readonly getAnchorRect: () => DOMRect | null
  readonly onClose: () => void
  readonly onPin: () => void
  readonly onMove: (groupId: GroupId) => void
  readonly onRename: () => void
  readonly onCopyId: () => void
  readonly onRemove: () => void
}

/**
 * Display the same ordered actions for Bots and group conversations.
 * @param props - Current entity, confirmed pin state, permitted destinations and action callbacks.
 * @returns A primitive menu with one nested destination menu and neutral icons.
 */
export function EntityMenu({
  entity, open, pinned, targets, labels, busy, pinAvailable, getAnchorRect, onClose,
  onPin, onMove, onRename, onCopyId, onRemove,
}: EntityMenuProps) {
  const select = (id: string): void => {
    if (busy) return
    switch (id) {
      case 'pin': if (pinAvailable) onPin(); return
      case 'rename': onRename(); return
      case 'copy': onCopyId(); return
      case 'remove': onRemove(); return
      default: {
        const target = targets.find(group => `move:${group.id}` === id)
        if (target !== undefined && target.id !== entity.currentGroup) onMove(target.id)
      }
    }
  }
  return <Menu open={open} anchor={null} getAnchorRect={getAnchorRect} portal autoFocus compact
    onClose={onClose} onSelect={select} items={[
      { id: 'pin', label: pinned ? labels.unpin : labels.pin, icon: pinned ? <IconPinFillRegular /> : <IconPinOutlineRegular />,
        disabled: busy || !pinAvailable },
      { id: 'move', label: labels.moveTo, icon: <IconFolderOpenOutlineRegular />, disabled: busy || targets.length === 0,
        submenu: targets.map(target => ({ id: `move:${target.id}`, label: target.name, disabled: busy || target.id === entity.currentGroup })) },
      { id: 'rename', label: labels.rename, icon: <IconEditOutlineRegular />, disabled: busy },
      { id: 'copy', label: labels.copyId, icon: <IconCopyOutlineRegular />, disabled: busy },
      { id: 'remove', label: labels.remove, icon: <IconTrashOutlineRegular />, disabled: busy },
    ]} />
}
