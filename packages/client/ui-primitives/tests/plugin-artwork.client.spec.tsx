// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GuideArtworkBrowser, GuideArtworkFiles,
  PluginArtworkDefault, PluginArtworkLoop, PluginArtworkSearch, PluginArtworkSubagent, PluginArtworkTerminal,
} from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

const artworks = {
  GuideArtworkBrowser,
  GuideArtworkFiles,
  PluginArtworkTerminal,
  PluginArtworkLoop,
  PluginArtworkSubagent,
  PluginArtworkSearch,
  PluginArtworkDefault,
} as const

describe('plugin artwork', () => {
  it.each(Object.entries(artworks))('%s renders its 36-viewBox svg honoring size and className', (_name, Artwork) => {
    const { container } = render(<Artwork size={30} className="deco" />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('viewBox')).toBe('0 0 36 36')
    expect(svg?.getAttribute('width')).toBe('30')
    expect(svg?.getAttribute('height')).toBe('30')
    expect(svg?.classList.contains('deco')).toBe(true)
  })

  it('leaves the search lens transparent and shows results inside it', () => {
    const { container } = render(<PluginArtworkSearch />)
    expect(container.querySelector('svg')?.getAttribute('fill')).toBe('none')
    expect(container.querySelector('svg')?.getAttribute('stroke')).toBe('currentColor')
    expect(container.querySelector('mask')).toBeNull()
    expect(container.querySelector('foreignObject')).toBeNull()
  })

  it.each(Object.entries({ PluginArtworkTerminal, PluginArtworkLoop, PluginArtworkSubagent, PluginArtworkSearch }))(
    '%s uses adaptive gray without accent colors', (_name, Artwork) => {
      const { container } = render(<Artwork />)
      expect(container.querySelector('svg')?.getAttribute('color')).toBe('light-dark(#62666f,#b9bdc6)')
      const paint = [...container.querySelectorAll('[stroke], [fill]')].filter(node => node.closest('defs') === null)
      expect(paint.every(node => ['stroke', 'fill'].every(attribute =>
        [null, 'none', 'currentColor'].includes(node.getAttribute(attribute))))).toBe(true)
      expect(container.querySelector('linearGradient')).toBeNull()
      expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    },
  )

  it('centers an active step between the dispatch arrows', () => {
    const { container } = render(<PluginArtworkLoop />)
    expect(container.querySelectorAll('circle')).toHaveLength(2)
    expect(container.querySelector('mask')).toBeNull()
    expect(container.querySelector('circle[fill="currentColor"]')).not.toBeNull()
  })

  it('draws a terminal prompt on an open window', () => {
    const { container } = render(<PluginArtworkTerminal />)
    expect(container.querySelector('mask')).toBeNull()
    expect(container.querySelector('rect')?.getAttribute('fill')).toBeNull()
    expect(container.querySelector('path[stroke-width="2.3"]')).not.toBeNull()
  })

  it.each(Object.entries(artworks))('%s renders at 36 by default and repeats without document-global ids', (_name, Artwork) => {
    const { container } = render(
      <>
        <Artwork />
        <Artwork />
      </>,
    )
    for (const svg of container.querySelectorAll('svg')) expect(svg.getAttribute('width')).toBe('36')
    const ids = [...container.querySelectorAll('[id]')].map(node => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const node of container.querySelectorAll('[fill], [stroke], [clip-path], [mask]')) {
      for (const attribute of ['fill', 'stroke', 'clip-path', 'mask']) {
        const reference = node.getAttribute(attribute)
        if (reference?.startsWith('url(#')) expect(ids).toContain(reference.slice('url(#'.length, -1))
      }
    }
  })
})
