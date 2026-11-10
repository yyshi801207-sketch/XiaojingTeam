// @vitest-environment jsdom
/** Latest records follow automatically without moving a reader's historical position. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useHandoffScroll } from '../src/client/use-handoff-scroll.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function Log({ scope, text }: { scope: string; text: string }) {
  const scroll = useHandoffScroll(scope)
  return <><button onClick={scroll.top}>Top</button><button onClick={scroll.bottom}>Bottom</button>
    <div ref={scroll.ref} onScroll={scroll.onScroll} role="log">{text}</div></>
}

it('follows appended records, pauses on upward scrolling and resumes explicitly or for another group', () => {
  let height = 1000
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => height)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200)
  const view = render(<Log scope="first" text="first record" />)
  const log = screen.getByRole('log')
  expect(log.scrollTop).toBe(1000)
  height = 1200
  view.rerender(<Log scope="first" text="new record" />)
  expect(log.scrollTop).toBe(1200)
  log.scrollTop = 300
  fireEvent.scroll(log)
  height = 1400
  view.rerender(<Log scope="first" text="another record" />)
  expect(log.scrollTop).toBe(300)
  fireEvent.click(screen.getByText('Top'))
  fireEvent.scroll(log)
  view.rerender(<Log scope="first" text="updated record" />)
  expect(log.scrollTop).toBe(0)
  fireEvent.click(screen.getByText('Bottom'))
  expect(log.scrollTop).toBe(1400)
  height = 1600
  view.rerender(<Log scope="first" text="latest" />)
  expect(log.scrollTop).toBe(1600)
  log.scrollTop = 800
  fireEvent.scroll(log)
  view.rerender(<Log scope="second" text="another group" />)
  expect(log.scrollTop).toBe(1600)
})
