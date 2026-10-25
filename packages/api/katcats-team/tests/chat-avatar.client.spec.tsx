// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { ChatAvatar } from '../src/client/ChatAvatar.tsx'
import type { BotAvatar } from '../src/types.ts'

afterEach(cleanup)
const appearances: readonly BotAvatar[] = [
  { shape: 'classic', color: '#FF2849' }, { shape: 'round', color: '#2288FF' },
  { shape: 'point', color: '#10C477' }, { shape: 'fold', color: '#9253FF' },
  { shape: 'tilt', color: '#FF6B0B' }, { shape: 'fluffy', color: '#10B8A6' },
]

describe('non-overlapping group avatar', () => {
  it.each([false, true])('uses the approved default for an empty selection, large=%s', (large) => {
    const { container } = render(<ChatAvatar appearances={[]} large={large} />)
    expect(container.firstElementChild?.getAttribute('data-count')).toBe('1')
    expect(container.querySelectorAll('svg')).toHaveLength(1)
    expect(container.querySelector('svg')?.getAttribute('width')).toBe(large ? '56' : '28')
    expect(container.querySelector('svg')?.style.getPropertyValue('--katcats-avatar-color')).toBe('#FF2849')
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
  })

  it.each([1, 2, 3, 4])('keeps all %i members and their own colors', (count) => {
    const { container } = render(<ChatAvatar appearances={appearances.slice(0, count)} />)
    expect(container.firstElementChild?.getAttribute('data-count')).toBe(String(count))
    expect(container.querySelectorAll('svg')).toHaveLength(count)
    expect([...container.querySelectorAll('svg')].map(svg => svg.style.getPropertyValue('--katcats-avatar-color')))
      .toEqual(appearances.slice(0, count).map(value => value.color))
    expect([...container.querySelectorAll('svg')].map(svg => svg.getAttribute('width')))
      .toEqual(Array.from({ length: count }, () => count === 1 ? '28' : '15'))
    expect(container.textContent).toBe('')
  })

  it.each([2, 3, 4])('uses the same layout and color order for %i large members', (count) => {
    const { container } = render(<ChatAvatar appearances={appearances.slice(0, count)} large />)
    expect(container.firstElementChild?.hasAttribute('data-large')).toBe(true)
    expect([...container.querySelectorAll('svg')].map(svg => svg.getAttribute('width'))).toEqual(Array.from({ length: count }, () => '30'))
    expect([...container.querySelectorAll('svg')].map(svg => svg.style.getPropertyValue('--katcats-avatar-color')))
      .toEqual(appearances.slice(0, count).map(value => value.color))
  })

  it('uses the fourth cell for the exact remaining count when a group has more than four members', () => {
    const { container, rerender } = render(<ChatAvatar appearances={appearances} />)
    expect(container.firstElementChild?.getAttribute('data-count')).toBe('4')
    expect(container.querySelectorAll('svg')).toHaveLength(3)
    expect(container.textContent).toMatchInlineSnapshot('"+3"')
    rerender(<ChatAvatar appearances={appearances.slice(0, 5)} large />)
    expect(container.querySelectorAll('svg')).toHaveLength(3)
    expect(container.textContent).toBe('+2')
  })
})
