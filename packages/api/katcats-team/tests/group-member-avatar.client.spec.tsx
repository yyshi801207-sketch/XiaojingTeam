// @vitest-environment jsdom
/** Group manager markers remain local, and shared hover motion matches the inherited Katcat artwork behavior. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { BotId } from '../src/types.ts'
import { CatAvatar, CAT_HEADS } from '../src/client/avatars.tsx'
import { GroupMemberAvatar } from '../src/client/GroupMemberAvatar.tsx'

afterEach(cleanup)

describe('group member appearance', () => {
  it('adds a tiny neutral marker only when the exact Bot identity is the current group manager', () => {
    const appearance = { shape: 'classic', color: '#FF2849' }
    const view = render(<GroupMemberAvatar botId={'writer' as BotId} managerId={'writer' as BotId}
      appearance={appearance} size={28} managerLabel="群负责人" />)
    const marker = screen.getByRole('img', { name: '群负责人' })
    expect({ label: marker.getAttribute('aria-label'), glyphs: marker.querySelectorAll('svg').length,
      size: view.container.querySelector<HTMLElement>('[data-katcats-manager-avatar]')?.style.getPropertyValue('--katcats-manager-badge-size') })
      .toMatchInlineSnapshot(`
        {
          "glyphs": 0,
          "label": "群负责人",
          "size": "6px",
        }
      `)
    expect(view.container.querySelector<SVGSVGElement>('svg[data-head]')?.style.getPropertyValue('--katcats-avatar-color')).toBe('#FF2849')
    expect(view.container.textContent).toBe('')
    for (const [size, expected] of [[20, '5px'], [40, '7px']] as const) {
      view.rerender(<GroupMemberAvatar botId={'writer' as BotId} managerId={'writer' as BotId}
        appearance={appearance} size={size} managerLabel="群负责人" />)
      expect(view.container.querySelector<HTMLElement>('[data-katcats-manager-avatar]')?.style.getPropertyValue('--katcats-manager-badge-size')).toBe(expected)
    }
    view.rerender(<GroupMemberAvatar botId={'writer' as BotId} managerId={'reviewer' as BotId}
      appearance={appearance} managerLabel="群负责人" />)
    expect(screen.queryByRole('img')).toBeNull()
    view.rerender(<GroupMemberAvatar botId={'writer' as BotId} managerId={null} appearance={appearance} managerLabel="群负责人" />)
    expect(screen.queryByRole('img')).toBeNull()
    view.rerender(<CatAvatar appearance={appearance} />)
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('keeps all ten selected silhouettes and bright colors available to the shared hover behavior', () => {
    const view = render(<>{CAT_HEADS.map(head => <CatAvatar key={head.id} appearance={{ shape: head.id, color: '#9253FF' }} />)}</>)
    expect([...view.container.querySelectorAll('svg')].map(svg => svg.getAttribute('data-head'))).toEqual([
      'classic', 'round', 'point', 'tilt', 'slim', 'fold', 'fluffy', 'wave', 'layered', 'ponytail',
    ])
    expect([...view.container.querySelectorAll('svg')].map(svg => svg.style.getPropertyValue('--katcats-avatar-color')))
      .toEqual(Array.from({ length: 10 }, () => '#9253FF'))
  })

  it('reuses seven hover transforms across ten silhouettes with reduced-motion rules', () => {
    const inherited = readFileSync(resolve(import.meta.dirname,
      '../../../client/ui-workspace/src/client/session-avatar/SessionAvatar.module.css'), 'utf8')
    const current = readFileSync(resolve(import.meta.dirname, '../src/client/avatar-motion.module.css'), 'utf8')
    const frames = (source: string) => [...source.matchAll(/@keyframes (cat-[a-z]+) \{\n([\s\S]*?)\n\}/g)]
      .filter(match => match[1] !== 'cat-breathe').map(match => [match[1], match[2]])
    expect(frames(current)).toEqual(frames(inherited))
    expect(frames(current)).toHaveLength(7)
    for (const head of CAT_HEADS) expect(current).toContain(`[data-head='${head.id}']`)
    expect(current).toContain('@media (hover: hover)')
    expect(current).toContain('animation-duration: 600ms')
    expect(current).toContain('cubic-bezier(0.22, 1, 0.36, 1)')
    expect(current).toContain('@media (prefers-reduced-motion: reduce)')
    expect(current).toContain('animation: none !important')
    expect(current).not.toContain('infinite')
  })
})
