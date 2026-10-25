import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { unpackIco } from '../scripts/render-tray-icon.ts'

const icon = readFileSync(new URL('../build/installer-icon-source.png', import.meta.url))
const robots = readFileSync(new URL('../build/installer-robot-source.png', import.meta.url))
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

describe('approved Team application and installation artwork', () => {
  it('retains the supplied PNG bytes across native application aliases', () => {
    expect(hash(icon)).toBe('8100ec52214d60d470370d43b871fcf531939c8a47a1da1294b97a8a2e9ac9d8')
    expect(hash(robots)).toBe('3e836ebf876836ce8174ad4c2c449e07b386945901e2bbd0568ab1c49400a7b5')
    for (const path of ['build/app-icon.png', 'build/installer-company-source.png', 'assets/windows-icon.png',
      'assets/app-icon.png', 'assets/taskbar-icon.png', 'resources/icon.png', 'resources/icon-windows.png', 'resources/icon-macos.png']) {
      expect(readFileSync(new URL(`../${path}`, import.meta.url)).equals(icon), path).toBe(true)
    }
  })

  it('provides the white Team artwork with transparency at taskbar, shortcut and installer sizes', async () => {
    const entries = unpackIco(readFileSync(new URL('../build/installer-runtime-icon.ico', import.meta.url)))
    expect(entries.map(entry => entry.size)).toEqual([16, 24, 32, 48, 64, 128, 256])
    const samples = []
    for (const entry of entries) {
      const { data, info } = await sharp(entry.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      expect(info.width).toBe(entry.size)
      expect(info.height).toBe(entry.size)
      expect(data[3]).toBeLessThanOrEqual(8)
      const at = (Math.floor(entry.size / 2) * entry.size + Math.floor(entry.size / 8)) * 4
      const rgba = [...data.subarray(at, at + 4)]
      expect(rgba[0]).toBeGreaterThan(230)
      expect(rgba[1]).toBeGreaterThan(230)
      expect(rgba[2]).toBeGreaterThan(230)
      expect(rgba[3]).toBeGreaterThan(240)
      samples.push({ size: entry.size, rgba, sha256: hash(entry.png) })
    }
    expect(samples).toMatchSnapshot()
  })

  it('ships a complete macOS icon container', () => {
    const bytes = readFileSync(new URL('../build/app-icon.icns', import.meta.url))
    expect(bytes.subarray(0, 4).toString()).toBe('icns')
    expect(bytes.readUInt32BE(4)).toBe(bytes.length)
    const types = []
    for (let offset = 8; offset < bytes.length;) {
      types.push(bytes.subarray(offset, offset + 4).toString())
      const length = bytes.readUInt32BE(offset + 4)
      expect(length).toBeGreaterThan(8)
      offset += length
      expect(offset).toBeLessThanOrEqual(bytes.length)
    }
    expect(types).toContain('ic10')
    expect({ types, sha256: hash(bytes) }).toMatchSnapshot()
  })

  it('keeps both installer characters on white bitmaps with an uncut outer border', () => {
    const summaries = []
    for (const [name, width, height] of [
      ['installer-product-logo.bmp', 480, 400], ['installer-product-logo-small.bmp', 72, 72],
      ['installer-sidebar.bmp', 164, 314], ['installer-header.bmp', 150, 57], ['installer-company-logo.bmp', 110, 28],
    ] as const) {
      const bytes = readFileSync(new URL(`../build/${name}`, import.meta.url))
      expect(bytes.subarray(0, 2).toString()).toBe('BM')
      expect(bytes.readInt32LE(18)).toBe(width)
      expect(bytes.readInt32LE(22)).toBe(height)
      expect(bytes.readUInt16LE(28)).toBe(24)
      const offset = bytes.readUInt32LE(10)
      const stride = Math.ceil(width * 3 / 4) * 4
      const pixel = (x: number, y: number) => {
        const at = offset + (height - 1 - y) * stride + x * 3
        return [...bytes.subarray(at, at + 3)]
      }
      for (let x = 0; x < width; x += 1) {
        expect(pixel(x, 0)).toEqual([255, 255, 255])
        expect(pixel(x, height - 1)).toEqual([255, 255, 255])
      }
      for (let y = 0; y < height; y += 1) {
        expect(pixel(0, y)).toEqual([255, 255, 255])
        expect(pixel(width - 1, y)).toEqual([255, 255, 255])
      }
      summaries.push({ name, width, height, sha256: hash(bytes) })
    }
    expect(summaries).toMatchSnapshot()
  })
})
