// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installXiaojingCompanionLayout } from '../src/xiaojing-companion-layout.ts'
import type { DesktopCompanionLayout } from '../src/xiaojing-companion-geometry.ts'

let dispose: (() => void) | undefined
let resized: (() => void) | undefined
const disconnect = vi.fn()
const observe = vi.fn()
const unobserve = vi.fn()
const send = vi.fn<(layout: DesktopCompanionLayout) => void>()
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resized = callback }
    observe = observe
    unobserve = unobserve
    disconnect = disconnect
  })
  vi.stubGlobal('innerWidth', 1280)
  vi.stubGlobal('innerHeight', 820)
})
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.useRealTimers()
})

function card(rect: DOMRect): HTMLDivElement {
  const content = document.createElement('div')
  content.setAttribute('data-conversation-content', '')
  vi.spyOn(content, 'getBoundingClientRect').mockImplementation(() => new DOMRect(200, 40, 1080, 780))
  const element = document.createElement('div')
  element.setAttribute('data-composer-card', '')
  vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => rect)
  content.append(element)
  document.body.append(content)
  return element
}
async function flush(): Promise<void> { await vi.advanceTimersByTimeAsync(40) }

describe('main preload companion layout observation', () => {
  it('waits for the composer to mount and reports its actual edge once', async () => {
    dispose = installXiaojingCompanionLayout(send)
    await flush()
    expect(send).not.toHaveBeenCalled()
    const rect = new DOMRect(300, 640, 750, 130)
    const element = card(rect)
    await flush()
    expect(send).toHaveBeenCalledExactlyOnceWith({
      viewportWidth: 1280, viewportHeight: 820, contentRight: 1280,
      composerRight: 1050, composerTop: 640, composerBottom: 770,
    })
    document.body.setAttribute('class', 'changed-without-geometry')
    resized?.()
    await flush()
    expect(send).toHaveBeenCalledOnce()
    expect(observe).toHaveBeenCalledExactlyOnceWith(element)
    rect.width = 700
    resized?.()
    await flush()
    expect(send).toHaveBeenLastCalledWith({
      viewportWidth: 1280, viewportHeight: 820, contentRight: 1280,
      composerRight: 1000, composerTop: 640, composerBottom: 770,
    })
    element.remove()
    await flush()
    expect(unobserve).toHaveBeenCalledExactlyOnceWith(element)
  })

  it('uses the largest visible composer and refreshes after window resizing', async () => {
    card(new DOMRect(0, 0, 0, 0))
    card(new DOMRect(1000, 200, 200, 100))
    card(new DOMRect(300, 640, 750, 130))
    dispose = installXiaojingCompanionLayout(send)
    await flush()
    expect(send.mock.lastCall?.[0].composerRight).toBe(1050)
    vi.stubGlobal('innerWidth', 1440)
    window.dispatchEvent(new Event('resize'))
    await flush()
    expect(send.mock.lastCall?.[0].viewportWidth).toBe(1440)
  })

  it.each(['data-phase', 'data-content-phase'])('follows the first-message %s layout change without resizing the composer', async (attribute) => {
    const rect = new DOMRect(300, 320, 750, 130)
    const element = card(rect)
    const content = element.parentElement
    if (content === null) throw new Error('Missing conversation fixture')
    content.setAttribute(attribute, 'hero')
    dispose = installXiaojingCompanionLayout(send)
    await flush()
    expect(send.mock.lastCall?.[0].composerBottom).toBe(450)

    rect.y = 640
    content.setAttribute(attribute, 'active')
    await flush()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.lastCall?.[0]).toMatchObject({ composerTop: 640, composerBottom: 770 })
    expect(observe).toHaveBeenCalledExactlyOnceWith(element)
    await flush()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases pending measurements and cannot restart after disposal', async () => {
    card(new DOMRect(300, 640, 750, 130))
    dispose = installXiaojingCompanionLayout(send)
    dispose()
    resized?.()
    window.dispatchEvent(new Event('resize'))
    await flush()
    expect(send).not.toHaveBeenCalled()
    expect(disconnect).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not use an input outside a conversation as a desktop placement anchor', async () => {
    const input = card(new DOMRect(300, 640, 750, 130))
    document.body.append(input)
    dispose = installXiaojingCompanionLayout(send)
    await flush()
    expect(send).not.toHaveBeenCalled()
  })
})
