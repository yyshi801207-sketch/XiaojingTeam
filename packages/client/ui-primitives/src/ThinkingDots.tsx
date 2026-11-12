/** Decorative activity indicator with three dots that move in sequence. */
import css from './ThinkingDots.module.css'

/**
 * Render three colored thinking dots in the shared font-scaled footprint.
 * @returns A decorative indicator whose accessible label belongs to its caller.
 */
export function ThinkingDots() {
  return <span className={css.dots} data-running-dots aria-hidden="true">
    <span className={css.dot} />
    <span className={css.dot} />
    <span className={css.dot} />
  </span>
}
