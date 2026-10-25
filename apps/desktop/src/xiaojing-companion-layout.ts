/** Main-preload layout observation for the desktop companion's composer gutter. */

import type { DesktopCompanionLayout } from './xiaojing-companion-geometry.ts'

/**
 * Report visible composer geometry after DOM changes, resizing, or scrolling; omit identical observations.
 * @param send - Private IPC sender owned by the main application preload.
 * @returns Disposer for DOM observers, animation frames, and window listeners.
 */
export function installXiaojingCompanionLayout(send: (layout: DesktopCompanionLayout) => void): () => void {
  let frame: number | undefined
  let last: string | undefined
  let disposed = false
  const measure = (): void => {
    frame = undefined
    const cards = [...document.querySelectorAll<HTMLElement>('[data-composer-card]')]
      .map(card => ({ rect: card.getBoundingClientRect(), content: card.closest('[data-conversation-content]') }))
      .filter(({ rect, content }) => rect.width > 0 && rect.height > 0 && content !== null)
      .sort((a, b) => b.rect.width - a.rect.width)
    const current = cards[0]
    if (current === undefined || current.content === null || window.innerWidth <= 0 || window.innerHeight <= 0) return
    const clampX = (value: number): number => Math.min(window.innerWidth, Math.max(0, value))
    const clampY = (value: number): number => Math.min(window.innerHeight, Math.max(0, value))
    const layout = {
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
      contentRight: clampX(current.content.getBoundingClientRect().right),
      composerRight: clampX(current.rect.right),
      composerTop: clampY(current.rect.top),
      composerBottom: clampY(current.rect.bottom),
    }
    const next = JSON.stringify(layout)
    if (next === last) return
    last = next
    send(layout)
  }
  const schedule = (): void => { if (!disposed) frame ??= window.requestAnimationFrame(measure) }
  const resize = new ResizeObserver(schedule)
  const observed = new Set<Element>()
  const observeCards = (): void => {
    const cards = new Set(document.querySelectorAll('[data-composer-card]'))
    for (const card of observed) {
      if (cards.has(card)) continue
      resize.unobserve(card)
      observed.delete(card)
    }
    for (const card of cards) {
      if (observed.has(card)) continue
      resize.observe(card)
      observed.add(card)
    }
  }
  const mutation = new MutationObserver(() => { observeCards(); schedule() })
  mutation.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'data-phase', 'data-content-phase'] })
  window.addEventListener('resize', schedule)
  window.addEventListener('scroll', schedule, true)
  observeCards()
  schedule()
  return () => {
    disposed = true
    resize.disconnect()
    observed.clear()
    mutation.disconnect()
    if (frame !== undefined) window.cancelAnimationFrame(frame)
    window.removeEventListener('resize', schedule)
    window.removeEventListener('scroll', schedule, true)
  }
}
