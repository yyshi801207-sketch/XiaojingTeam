// @vitest-environment jsdom
/** Financial robot portraits retain the saved identifiers and independent appearance controls. */
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

describe('financial robot appearance', () => {
  it('keeps seven robot shapes and all eight colors independently selectable', () => {
    render(<AppearanceDraft />)
    const shapes = within(screen.getByRole('group', { name: zh['avatar.shape'] })).getAllByRole('button')
    const colors = within(screen.getByRole('group', { name: zh['avatar.color'] })).getAllByRole('button')
    expect(shapes.map(button => button.getAttribute('aria-label'))).toEqual([
      '总账机器人', '出纳机器人', '税务机器人', '报表机器人', '审计机器人', '成本机器人', '主管机器人',
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

  it('renders solid, rounded robot silhouettes at picker and compact row sizes', () => {
    const appearances = [
      { shape: 'classic', color: '#10C477' }, { shape: 'round', color: '#2288FF' },
      { shape: 'point', color: '#FF6B0B' }, { shape: 'fold', color: '#9253FF' },
      { shape: 'tilt', color: '#10B8A6' }, { shape: 'fluffy', color: '#F52C93' },
      { shape: 'slim', color: '#202124' },
    ]
    const { container } = render(<>{appearances.map(appearance => <span key={appearance.shape}>
      <CatAvatar appearance={appearance} /><CatAvatar appearance={appearance} size={24} />
    </span>)}</>)
    expect([...container.querySelectorAll('svg')].map(svg => ({
      head: svg.getAttribute('data-head'), viewBox: svg.getAttribute('viewBox'),
      size: svg.getAttribute('width'), hidden: svg.getAttribute('aria-hidden'),
      color: svg.style.getPropertyValue('--katcats-avatar-color'),
      neutral: svg.hasAttribute('data-neutral'), artwork: svg.innerHTML,
    }))).toMatchSnapshot()
    for (const avatar of container.querySelectorAll('svg')) {
      const paths = avatar.querySelectorAll('path')
      expect(paths).toHaveLength(1)
      const outline = paths[0]?.getAttribute('d') ?? ''
      expect(outline).toMatch(/^M[^MZ]+Z$/)
      expect(outline.replace(/[MCZ0-9 .,-]/g, '')).toBe('')
      expect(paths[0]?.hasAttribute('fill-rule')).toBe(false)
    }
    expect(container.textContent).toBe('')
  })

  it('shows the ledger robot for a previously unrecognized shape without changing its saved color', () => {
    const { container } = render(<CatAvatar appearance={{ shape: 'unrecognized', color: '#2288FF' }} />)
    const avatar = container.querySelector('svg')
    expect(avatar?.getAttribute('data-head')).toBe('classic')
    expect(avatar?.style.getPropertyValue('--katcats-avatar-color')).toBe('#2288FF')
  })
})
