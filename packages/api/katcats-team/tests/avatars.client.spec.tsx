// @vitest-environment jsdom
/** Bean Bot avatars retain saved identifiers and independent appearance controls. */
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { AppearancePicker, CatAvatar, DEFAULT_APPEARANCE, type CatAppearance } from '../src/client/avatars.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

function AppearanceDraft() {
  const [appearance, setAppearance] = useState(DEFAULT_APPEARANCE)
  return <AppearancePicker value={appearance} onChange={setAppearance} t={makeTranslate(zh)} />
}

describe('Bean Bot appearance', () => {
  it('keeps ten avatars and all eight colors independently selectable', () => {
    render(<AppearanceDraft />)
    const shapes = within(screen.getByRole('group', { name: zh['avatar.shape'] })).getAllByRole('button')
    const colors = within(screen.getByRole('group', { name: zh['avatar.color'] })).getAllByRole('button')
    expect(shapes.map(button => button.getAttribute('aria-label'))).toEqual([
      'B01 豆子 Bot', 'B02 豆子 Bot', 'B03 豆子 Bot', 'B04 豆子 Bot', 'B05 豆子 Bot',
      'B06 豆子 Bot', 'B07 豆子 Bot', 'B08 豆子 Bot', 'B09 豆子 Bot', 'B10 豆子 Bot',
    ])
    expect(colors).toHaveLength(8)
    for (const shape of shapes) {
      fireEvent.click(shape)
      expect(shapes.filter(button => button.getAttribute('aria-pressed') === 'true')).toEqual([shape])
      for (const color of colors) {
        fireEvent.click(color)
        expect(colors.filter(button => button.getAttribute('aria-pressed') === 'true')).toEqual([color])
        expect(shape.getAttribute('aria-pressed')).toBe('true')
        expect(shape.querySelector('svg')?.style.getPropertyValue('--katcats-avatar-color'))
          .toBe(color.style.getPropertyValue('--katcats-avatar-color'))
      }
    }
  })

  it('keeps appearance edits unavailable while the owning form is saving', () => {
    const onChange = vi.fn<(value: CatAppearance) => void>()
    render(<AppearancePicker value={DEFAULT_APPEARANCE} onChange={onChange} t={makeTranslate(en)} disabled />)
    expect(screen.getAllByRole('group').every(group => group.hasAttribute('disabled'))).toBe(true)
    screen.getByRole<HTMLButtonElement>('button', { name: en['avatar.slim'] }).click()
    screen.getByRole<HTMLButtonElement>('button', { name: en['color.teal'] }).click()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('renders ten distinct supplied Bean Bot avatars at picker and compact row sizes', () => {
    const appearances = [
      { shape: 'classic', color: '#10C477' }, { shape: 'round', color: '#2288FF' },
      { shape: 'point', color: '#FF6B0B' }, { shape: 'tilt', color: '#10B8A6' },
      { shape: 'slim', color: '#202124' }, { shape: 'layered', color: '#2288FF' },
      { shape: 'fluffy', color: '#F52C93' }, { shape: 'wave', color: '#12A489' },
      { shape: 'fold', color: '#9253FF' }, { shape: 'ponytail', color: '#FF6B0B' },
    ]
    const { container } = render(<>{appearances.map(appearance => <span key={appearance.shape}>
      <CatAvatar appearance={appearance} /><CatAvatar appearance={appearance} size={24} />
    </span>)}</>)
    const avatars = [...container.querySelectorAll('svg')]
    expect(avatars.map(svg => ({
      head: svg.getAttribute('data-head'), viewBox: svg.getAttribute('viewBox'),
      size: svg.getAttribute('width'), hidden: svg.getAttribute('aria-hidden'),
      color: svg.style.getPropertyValue('--katcats-avatar-color'),
      neutral: svg.hasAttribute('data-neutral'),
    }))).toMatchSnapshot()
    const masks = avatars.map(svg => svg.style.getPropertyValue('--katcats-avatar-mask'))
    expect(masks.every(mask => mask.startsWith('url('))).toBe(true)
    expect(new Set(masks).size).toBe(10)
    for (let index = 0; index < masks.length; index += 2) expect(masks[index]).toBe(masks[index + 1])
    expect(container.textContent).toBe('')
  })

  it('shows the first avatar for an unrecognized shape without changing its saved color', () => {
    const { container } = render(<CatAvatar appearance={{ shape: 'unrecognized', color: '#2288FF' }} />)
    const avatar = container.querySelector('svg')
    expect(avatar?.getAttribute('data-head')).toBe('classic')
    expect(avatar?.style.getPropertyValue('--katcats-avatar-color')).toBe('#2288FF')
  })
})
