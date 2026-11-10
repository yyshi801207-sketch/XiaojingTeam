/** Native HQ light arcs reflect only recorded directions and honor reduced motion. */
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const adapter = readFileSync(new URL('../artwork/hq/adapter.js.txt', import.meta.url), 'utf8')
function fixture(reducedMotion = false) {
  const arc = vi.fn<(a: number[], b: number[], height: number, color: number[], alpha: number, dots: number, speed: number) => void>()
  const people = [{ botId: 'a', point: [0, 1, 0] }, { botId: 'b', point: [10, 1, 5] }]
  const context = { host: { addEventListener() {} }, SR: { addEventListener() {} }, window: { addEventListener() {} }, gl: true,
    parent: { postMessage() {} }, NODES: [], HALL_N: -5, HALL_S: 5, COR_W: -5, COR_E: 5,
    PEOPLE: people, RM: reducedMotion, CYAN: [0.42, 0.88, 1], arc,
    headPt: (p: typeof people[number]) => p.point, v3len: () => 10, v3sub: () => [10, 0, 5] }
  return { arc, run: (links: readonly { from: string; to: string; active: boolean }[]) => {
    runInNewContext(adapter + `\nroomPayload = { links: ${JSON.stringify(links)} }; roomLinks();`, context)
  } }
}

describe('recorded handoff light arcs', () => {
  it('uses native 3D glow and directional particles once per member pair', () => {
    const f = fixture()
    f.run([{ from: 'a', to: 'b', active: false }, { from: 'a', to: 'b', active: true }, { from: 'a', to: 'b', active: false },
      { from: 'a', to: 'missing', active: true }, { from: 'a', to: 'a', active: true }])
    expect(f.arc).toHaveBeenCalledExactlyOnceWith([0, 1, 0], [10, 1, 5], 3.8, [0.42, 0.88, 1], 0.85, 3, 0.32)
  })
  it('dims completed links and stops particle motion for reduced motion', () => {
    const f = fixture(true)
    f.run([{ from: 'a', to: 'b', active: true }, { from: 'b', to: 'a', active: false }])
    expect(f.arc.mock.calls.map(call => [call[4], call[5]])).toEqual([[0.85, 0], [0.14, 0]])
  })
})

describe('ambient visitor movement', () => {
  it('moves only visitors through public waypoints and honors reduced motion', () => {
    const walkTo = vi.fn<(person: object, place: { x: number; z: number }, onArrive: () => void) => void>()
    const stepWalk = vi.fn<(person: object, dt: number) => void>()
    const member = { visitor: false, ph: 0, mode: 'sit', wait: 0 }
    const visitor = { visitor: true, ph: 0, mode: 'stand', wait: 0, yaw: 0, yawT: 0, at: null }
    const context = { host: { addEventListener() {} }, SR: { addEventListener() {} }, window: { addEventListener() {} }, gl: true,
      parent: { postMessage() {} }, NODES: [[0, -5], [0, 5], [0, 0]], HALL_N: -5, HALL_S: 5, COR_W: -5, COR_E: 5,
      PEOPLE: [member, visitor], RM: false, walkTo, stepWalk, angDiff: () => 0,
      mkPlace: (x: number, z: number) => ({ x, z, occ: null }) }
    runInNewContext(adapter + '\nroomAnimate(1);', context)
    expect(walkTo).toHaveBeenCalledOnce()
    expect(walkTo.mock.calls[0]?.[0]).toBe(visitor)
    expect(walkTo.mock.calls[0]?.[1].x).toBe(0)
    expect(Math.abs(walkTo.mock.calls[0]![1].z)).toBe(5)
    expect(member.mode).toBe('sit')
    visitor.mode = 'walk'
    runInNewContext('roomAnimate(1);', context)
    expect(stepWalk).toHaveBeenCalledExactlyOnceWith(visitor, 1)
    context.RM = true
    runInNewContext('roomAnimate(1);', context)
    expect(stepWalk).toHaveBeenCalledOnce()
    expect(walkTo).toHaveBeenCalledOnce()
  })
})

describe('native room camera', () => {
  it('keeps a tour running across data refreshes and resets only on camera selection', () => {
    const goView = vi.fn(), startFly = vi.fn()
    const context = { host: { addEventListener() {} }, SR: { addEventListener() {} }, window: { addEventListener() {} }, gl: true,
      parent: { postMessage() {} }, NODES: [], HALL_N: -5, HALL_S: 5, COR_W: -5, COR_E: 5,
      PEOPLE: [], DEPTS: [], CHIEF_SEAT: {}, TOUR: { i: 4, t: 3 }, goView, startFly }
    runInNewContext(adapter + '\nhost.applyRoom({members:[],visitors:[],links:[],cameraMode:1,cameraTarget:null});', context)
    expect(context.TOUR).toEqual({ i: -1, t: 0 })
    context.TOUR.i = 2; context.TOUR.t = 5
    runInNewContext('host.applyRoom({members:[],visitors:[],links:[],cameraMode:1,cameraTarget:null});', context)
    expect(context.TOUR).toEqual({ i: 2, t: 5 })
    expect(goView).toHaveBeenCalledOnce()
    runInNewContext('host.applyRoom({members:[],visitors:[],links:[],cameraMode:2,cameraTarget:null});', context)
    expect(startFly).toHaveBeenCalledExactlyOnceWith(0)
  })
})

describe('visitor identity labels', () => {
  it('shows only the visitor under the pointer and clears it on movement, drag and exit', () => {
    const handlers: Record<string, (event: object) => void> = {}
    const member = { botId: 'member', visitor: false, tag: { el: { hidden: false } } }
    const visitor = { botId: 'visitor', visitor: true, tag: { el: { hidden: false } } }
    const other = { botId: 'other', visitor: true, tag: { el: { hidden: false } } }
    const canvas = {}
    const pick = vi.fn((): { p: typeof visitor } | null => null)
    const context = { host: { addEventListener: (name: string, fn: (event: object) => void) => { handlers[name] = fn } },
      SR: { addEventListener: (name: string, fn: (event: object) => void) => { handlers[name] = fn } },
      window: { addEventListener() {} }, gl: true, glc: canvas, VP: true, dragging: false,
      parent: { postMessage() {} }, NODES: [], HALL_N: -5, HALL_S: 5, COR_W: -5, COR_E: 5,
      PEOPLE: [member, visitor, other], L: { dpr2: 1, w: 800, h: 600 }, fx: { setTransform() {}, clearRect() {} },
      headPt: () => [0, 0, 0], proj: () => [100, 100], bx: () => 100, by: () => 100,
      hideLabel() {}, placeAt() {}, pick, hostXY: () => [100, 100] }
    runInNewContext(adapter + '\nroomPayload = {}; roomHud();', context)
    expect([member.tag.el.hidden, visitor.tag.el.hidden, other.tag.el.hidden]).toEqual([false, true, true])
    pick.mockReturnValue({ p: visitor })
    handlers.pointermove?.({ target: canvas })
    runInNewContext('roomHud();', context)
    expect([member.tag.el.hidden, visitor.tag.el.hidden, other.tag.el.hidden]).toEqual([false, false, true])
    // Walking or a camera move changes the hit even without another pointer event.
    pick.mockReturnValue(null)
    runInNewContext('roomHud();', context)
    expect(visitor.tag.el.hidden).toBe(true)
    pick.mockReturnValue({ p: other })
    runInNewContext('roomHud();', context)
    expect(other.tag.el.hidden).toBe(false)
    context.dragging = true
    runInNewContext('roomHud();', context)
    expect(other.tag.el.hidden).toBe(true)
    context.dragging = false
    runInNewContext('roomHud();', context)
    expect(other.tag.el.hidden).toBe(false)
    handlers.pointerleave?.({})
    runInNewContext('roomHud();', context)
    expect([visitor.tag.el.hidden, other.tag.el.hidden]).toEqual([true, true])
  })
})
