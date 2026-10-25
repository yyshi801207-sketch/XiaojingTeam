import { describe, expect, it } from 'vitest'
import {
  DEFAULT_COMPANION_SCALE,
  IDLE_COMPANION_SNAPSHOT,
  defaultCompanionBounds,
  composerCompanionBounds,
  isCompanionLayout,
  isCompanionScale,
  isCompanionSnapshot,
  normalizeCompanionPreferences,
  resolveCompanionBounds,
} from '../src/xiaojing-companion-geometry.ts'

const primary = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
const left = { id: 2, workArea: { x: -1280, y: 0, width: 1280, height: 984 } }
const mainWindow = { x: 180, y: 70, width: 1440, height: 900 }

describe('desktop companion persistence and geometry', () => {
  it('defaults new and malformed preferences to a visible companion', () => {
    expect(normalizeCompanionPreferences(undefined)).toEqual({
      schemaVersion: 1, visible: true, scale: DEFAULT_COMPANION_SCALE, trayHintShown: false,
    })
    expect(normalizeCompanionPreferences({ visible: false, trayHintShown: true, position: { x: 'bad' } })).toEqual({
      schemaVersion: 1, visible: false, scale: DEFAULT_COMPANION_SCALE, trayHintShown: true,
    })
    expect(normalizeCompanionPreferences(undefined).scale).toBe(0.35)
  })

  it('normalizes a remembered cross-display position', () => {
    expect(normalizeCompanionPreferences({
      schemaVersion: 99,
      visible: true,
      position: { x: -900.4, y: 111.6, displayId: '2' },
    })).toEqual({
      schemaVersion: 1,
      visible: true,
      scale: DEFAULT_COMPANION_SCALE,
      trayHintShown: false,
      position: { x: -900, y: 112, displayId: '2' },
    })
  })

  it('keeps a supported saved scale and defaults invalid persisted values to 35 percent', () => {
    expect(normalizeCompanionPreferences({ scale: 0.5 }).scale).toBe(0.5)
    expect(normalizeCompanionPreferences({ scale: 0.75 }).scale).toBe(0.75)
    expect(normalizeCompanionPreferences({ scale: 1.1 }).scale).toBe(DEFAULT_COMPANION_SCALE)
    expect(isCompanionScale(0.3)).toBe(true)
    expect(isCompanionScale(1)).toBe(true)
    expect(isCompanionScale(0.25)).toBe(false)
  })

  it('places the companion at the primary work-area bottom right', () => {
    expect(defaultCompanionBounds(primary)).toEqual({ x: 1584, y: 644, width: 320, height: 380 })
  })

  it('places a new companion fully inside the main-window bottom right', () => {
    expect(defaultCompanionBounds(primary, mainWindow)).toEqual({
      x: 1284, y: 574, width: 320, height: 380,
    })
    expect(resolveCompanionBounds({}, [primary], primary, mainWindow)).toEqual({
      x: 1284, y: 574, width: 320, height: 380,
    })
  })

  it('falls back to the display when an anchor cannot contain the companion', () => {
    expect(defaultCompanionBounds(primary, { x: 100, y: 100, width: 300, height: 300 })).toEqual({
      x: 1584, y: 644, width: 320, height: 380,
    })
  })

  it('keeps saved bounds visible and recovers a removed display', () => {
    expect(resolveCompanionBounds({ position: { x: -2_000, y: 900, displayId: 2 } }, [primary, left], primary)).toEqual({
      x: -1280, y: 604, width: 320, height: 380,
    })
    expect(resolveCompanionBounds({ position: { x: -800, y: 100, displayId: 404 } }, [primary], primary)).toEqual({
      x: 0, y: 100, width: 320, height: 380,
    })
  })

  it('accepts only the redacted snapshot vocabulary', () => {
    expect(isCompanionSnapshot(IDLE_COMPANION_SNAPSHOT)).toBe(true)
    expect(isCompanionSnapshot({ ...IDLE_COMPANION_SNAPSHOT, activeTaskCount: -1 })).toBe(false)
    expect(isCompanionSnapshot({ ...IDLE_COMPANION_SNAPSHOT, state: 'secret', task: 'private' })).toBe(false)
    expect(isCompanionSnapshot(null)).toBe(false)
  })
})

describe('desktop companion responsive right composer gutter', () => {
  it.each([1366, 1920, 2560, 3840].flatMap(width => [1, 1.25, 1.5, 2].map(dpiScale => [width, dpiScale])))
  ('centers in the right gutter with aligned lower edges at screen width %s and DPI scale %s', (width, dpiScale) => {
    for (const zoom of [0.8, 1, 1.25]) {
      const content = { x: 80, y: 30, width: width / dpiScale, height: 900 / dpiScale }
      const display = { id: 1, workArea: { x: 0, y: 0, width: content.width + 160, height: content.height + 100 } }
      const layout = {
        viewportWidth: content.width / zoom, viewportHeight: content.height / zoom,
        contentRight: content.width / zoom,
        composerRight: (content.width - 220) / zoom, composerTop: (content.height - 170) / zoom,
        composerBottom: (content.height - 30) / zoom,
      }
      const bounds = composerCompanionBounds(layout, content, 0.35, display)
      const characterCenter = bounds.x + 320 - 20 - 98 / 2
      const leftGap = characterCenter - 49 - (content.x + content.width - 220)
      const rightGap = content.x + content.width - characterCenter - 49
      expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(1)
      expect(Math.abs(bounds.y + 380 + 4 - (content.y + content.height - 30))).toBeLessThanOrEqual(0.5)
    }
  })

  it('moves above the input on its right when the gutter cannot contain the full character', () => {
    const content = { x: 0, y: 0, width: 960, height: 600 }
    const layout = {
      viewportWidth: 960, viewportHeight: 600, contentRight: 960,
      composerRight: 944, composerTop: 430, composerBottom: 570,
    }
    const bounds = composerCompanionBounds(layout, content, 0.35, primary)
    const characterRight = bounds.x + 320 - 20
    expect(bounds.y + bounds.height + 4).toBe(layout.composerTop - 16)
    expect(characterRight).toBe(layout.composerRight)
    expect(characterRight).toBeLessThan(layout.contentRight)
  })

  it('centers every saved size outside the input on a monitor left of the primary', () => {
    const content = { x: -1200, y: 40, width: 1100, height: 800 }
    const layout = {
      viewportWidth: 1100, viewportHeight: 800, contentRight: 1100,
      composerRight: 740, composerTop: 640, composerBottom: 770,
    }
    for (const scale of [0.3, 0.5, 1]) {
      const bounds = composerCompanionBounds(layout, content, scale, left)
      const center = bounds.x + 320 - 20 - 280 * scale / 2
      const leftGap = center - 140 * scale - (content.x + layout.composerRight)
      const rightGap = content.x + layout.contentRight - center - 140 * scale
      expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(1)
      expect(center - 140 * scale).toBeGreaterThan(content.x + layout.composerRight)
    }
  })

  it('preserves a large saved size above a narrow composer without covering the right settings panel', () => {
    const content = { x: 0, y: 0, width: 640, height: 600 }
    const layout = {
      viewportWidth: 640, viewportHeight: 600, contentRight: 440,
      composerRight: 424, composerTop: 430, composerBottom: 570,
    }
    const bounds = composerCompanionBounds(layout, content, 1, primary)
    expect(bounds.x + 320 - 20 - 280).toBeGreaterThan(0)
    expect(bounds.x + 320 - 20).toBeLessThanOrEqual(layout.contentRight)
    expect(bounds.y + bounds.height + 4).toBeLessThan(layout.composerTop)
  })

  it('balances the blank gutter as the window widens and follows the real composer lower edge', () => {
    for (const width of [1280, 1440, 1920]) {
      const content = { x: 120, y: 40, width, height: 900 }
      for (const bottom of [640, 860]) {
        const bounds = composerCompanionBounds({
          viewportWidth: width, viewportHeight: 900, contentRight: width,
          composerRight: 1000, composerTop: bottom - 140, composerBottom: bottom,
        }, content, 0.35, { id: 1, workArea: { x: 0, y: 0, width: 2400, height: 1200 } })
        const characterRight = bounds.x + 320 - 20
        const leftGap = characterRight - 98 - (content.x + 1000)
        const rightGap = content.x + width - characterRight
        expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(1)
        expect(bounds.y + 380 + 4).toBe(content.y + bottom)
      }
    }
  })

  const valid = {
    viewportWidth: 960, viewportHeight: 600, contentRight: 960,
    composerRight: 944, composerTop: 430, composerBottom: 570,
  }
  it('accepts complete ordered conversation and composer coordinates', () => {
    expect(isCompanionLayout(valid)).toBe(true)
  })
  it.each([null, {}, { viewportWidth: 0 },
    { ...valid, composerRight: Infinity }, { ...valid, composerRight: 1000 },
    { ...valid, composerTop: -1 }, { ...valid, contentRight: 920 },
    { ...valid, contentRight: -1 }, { ...valid, composerBottom: 601 },
    { ...valid, composerTop: 580 },
  ])('rejects invalid layout input %j', (value) => {
    expect(isCompanionLayout(value)).toBe(false)
  })
})
