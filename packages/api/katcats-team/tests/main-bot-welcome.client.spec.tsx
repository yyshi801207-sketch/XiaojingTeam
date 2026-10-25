// @vitest-environment jsdom
/** Main-only hero copy over synthetic identities, without opening Session history. */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { BotId, GroupId, TeamBot, TeamSnapshot } from '../src/types.ts'
import type { TeamView } from '../src/client/model.ts'
import { MainBotWelcome } from '../src/client/MainBotWelcome.tsx'
import type { MainBotWelcomeProps } from '../src/client/MainBotWelcome.tsx'
import { en, zh } from '../src/client/locales.ts'

const main: TeamBot = { id: 'main' as BotId, kind: 'main', name: 'Katcats', role: '', avatar: { shape: 'classic', color: '#FF2849' },
  model: { kind: 'follow-global' }, groupId: null, sessionId: 'main-private' as SessionId, workDir: '/synthetic/main' }
const ordinary: TeamBot = { ...main, id: 'writer' as BotId, kind: 'ordinary', groupId: 'ordinary' as GroupId,
  name: 'Writer', sessionId: 'writer-private' as SessionId, workDir: '/synthetic/writer' }
const snapshot: TeamSnapshot = { revision: 0, mainBotId: main.id, bots: [main, ordinary], groups: [],
  modelCapabilities: { override: false, followGlobal: false } }

function setup(sessionId: SessionId | undefined = main.sessionId, locale = zh) {
  const directory = createSnapshotStore<TeamView>({ phase: 'ready', snapshot, catalog: null })
  const props = { sessionId, useDirectory: bindSnapshotSelector(directory), t: makeTranslate(locale) } as MainBotWelcomeProps
  return { props, directory }
}

afterEach(cleanup)

describe('main Bot welcome', () => {
  it('shows the team tagline without the main Bot introduction or responsibilities', () => {
    const { props } = setup()
    const { container } = render(<MainBotWelcome {...props} />)
    expect({ tagline: container.querySelector('h2')?.textContent,
      paragraphs: container.querySelectorAll('p').length }).toMatchInlineSnapshot(`
        {
          "paragraphs": 0,
          "tagline": "Katcats，Your personal AI team.",
        }
      `)
    expect(container.querySelector('img, svg, textarea')).toBeNull()
  })

  it('keeps the same tagline in English without the removed paragraphs', () => {
    const { props } = setup(main.sessionId, en)
    const { container } = render(<MainBotWelcome {...props} />)
    expect({ tagline: container.querySelector('h2')?.textContent,
      paragraphs: container.querySelectorAll('p').length }).toMatchInlineSnapshot(`
        {
          "paragraphs": 0,
          "tagline": "Katcats，Your personal AI team.",
        }
      `)
  })

  it.each([ordinary.sessionId, 'editorial-root' as SessionId, undefined])('does not introduce the main Bot in Session %s', (sessionId) => {
    const { props } = setup()
    const { container } = render(<MainBotWelcome {...props} sessionId={sessionId} />)
    expect(container.textContent).toBe('')
  })

  it('waits for a known main identity and removes stale copy when that identity no longer owns this Session', () => {
    const { props, directory } = setup()
    directory.set({ phase: 'loading', snapshot: null, catalog: null })
    const { container } = render(<MainBotWelcome {...props} />)
    expect(container.textContent).toBe('')
    act(() => { directory.set({ phase: 'ready', snapshot, catalog: null }) })
    expect(container.querySelector('h2')?.textContent).toBe('Katcats，Your personal AI team.')
    act(() => { directory.set({ phase: 'ready', snapshot: { ...snapshot,
      bots: [{ ...main, sessionId: 'replacement-main' as SessionId }, ordinary] }, catalog: null }) })
    expect(container.textContent).toBe('')
  })
})
