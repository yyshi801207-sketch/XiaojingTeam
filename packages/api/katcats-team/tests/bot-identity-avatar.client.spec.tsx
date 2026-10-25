// @vitest-environment jsdom
/** Main identity stays distinct from ordinary members and group management. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { BotId } from '../src/types.ts'
import { BotIdentityAvatar } from '../src/client/BotIdentityAvatar.tsx'
import { GroupMemberAvatar } from '../src/client/GroupMemberAvatar.tsx'

afterEach(cleanup)

describe('member identity artwork', () => {
  it('uses the supplied main portrait across sidebar, header, and settings sizes', () => {
    const { container } = render(<>{[96, 30, 24, 60].map(size => <BotIdentityAvatar key={size}
      bot={{ kind: 'main', avatar: { shape: 'fluffy', color: '#2288FF' } }} size={size} />)}</>)
    const portraits = [...container.querySelectorAll('img')]
    expect(portraits).toHaveLength(4)
    for (const portrait of portraits) expect(portrait.getAttribute('src')).toContain('main-bot-avatar.png')
    expect(portraits.map(portrait => ({ width: portrait.width, height: portrait.height, decorative: portrait.alt === '' })))
      .toMatchInlineSnapshot(`
        [
          {
            "decorative": true,
            "height": 96,
            "width": 96,
          },
          {
            "decorative": true,
            "height": 30,
            "width": 30,
          },
          {
            "decorative": true,
            "height": 24,
            "width": 24,
          },
          {
            "decorative": true,
            "height": 60,
            "width": 60,
          },
        ]
      `)
    expect(container.querySelector('svg')).toBeNull()
  })

  it('retains ordinary robot selection and never replaces a group manager with the main portrait', () => {
    const appearance = { shape: 'round', color: '#10C477' }
    const managerId = 'ordinary-manager' as BotId
    const { container } = render(<>
      <BotIdentityAvatar bot={{ kind: 'ordinary', avatar: appearance }} size={28} />
      <GroupMemberAvatar botId={managerId} managerId={managerId} appearance={appearance} size={28} managerLabel="Manager" />
    </>)
    expect(container.querySelector('img')).toBeNull()
    expect([...container.querySelectorAll<SVGSVGElement>('svg[data-head]')].map(avatar => ({
      head: avatar.getAttribute('data-head'), color: avatar.style.getPropertyValue('--katcats-avatar-color'),
    }))).toEqual([{ head: 'round', color: '#10C477' }, { head: 'round', color: '#10C477' }])
    expect(container.querySelector('[data-katcats-manager-avatar]')?.getAttribute('data-katcats-manager-avatar')).toBe(managerId)
  })
})
