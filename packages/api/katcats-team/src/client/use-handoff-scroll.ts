/** Independent task-log scrolling shared by the two dispatch views. */
import { useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * Follow rendered handoffs until the reader scrolls away or jumps to the top.
 * @param scope - Group and member filter identity; a different list starts at its latest record.
 * @returns Scroll container reference and controls that never scroll the surrounding room.
 */
export function useHandoffScroll(scope: string): {
  ref: RefObject<HTMLDivElement>
  onScroll: () => void
  top: () => void
  bottom: () => void
} {
  const ref = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const previousScope = useRef(scope)
  useLayoutEffect(() => {
    if (previousScope.current !== scope) {
      previousScope.current = scope
      following.current = true
    }
    if (following.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  })
  return {
    ref,
    onScroll: () => {
      const element = ref.current
      if (element) following.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 1
    },
    top: () => {
      following.current = false
      if (ref.current) ref.current.scrollTop = 0
    },
    bottom: () => {
      following.current = true
      if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
    },
  }
}
