/** Browser geometry for the Xiaojing fixed Bot switcher. */
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator } from 'playwright'
import { expect, it, vi } from 'vitest'
import { launchWebScaffold, watchConsole, webClientProfile } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

const overlay = fileURLToPath(new URL('./assistant-switch-layout.overlay.yml', import.meta.url))

function labelStyle(label: Locator) {
  return label.evaluate(node => {
    const { fontFamily, fontSize, fontWeight, fontStyle, lineHeight, letterSpacing, color, backgroundColor } = getComputedStyle(node)
    return { fontFamily, fontSize, fontWeight, fontStyle, lineHeight, letterSpacing, color, backgroundColor }
  })
}

function separator(list: Locator) {
  return list.evaluate(node => {
    for (let parent = node.parentElement; parent !== null; parent = parent.parentElement) {
      const { borderRightWidth, borderRightStyle, borderRightColor } = getComputedStyle(parent)
      if (borderRightStyle === 'none' || parseFloat(borderRightWidth) === 0) continue
      const { right, top, height } = parent.getBoundingClientRect()
      return { right, top, height, borderRightWidth, borderRightStyle, borderRightColor }
    }
    throw new Error('Expected a visible sidebar separator')
  })
}

it.skipIf(webClientProfile() !== 'xiaojing')('keeps group geometry and label typography when switching the fixed assistants', async () => {
  vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'xiaojing')
  vi.stubEnv('KATCATS_PRODUCT_MODE', '1')
  let scaffold: Awaited<ReturnType<typeof launchWebScaffold>> | undefined
  let browser: Browser | undefined
  try {
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE, reducedMotion: 'reduce' })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    const mainRole = page.getByText('Bot 创建助手', { exact: true })

    const toggle = page.getByRole('button', { name: '切换主 Bot 与 Odoo 助理', exact: true })
    const ledger = page.getByRole('button', { name: '建账助手', exact: true })
    const access = page.getByRole('button', { name: '系统助手', exact: true })
    const artwork = page.getByRole('group', { name: 'Odoo 助理', exact: true }).locator('img')
    const headquarters = page.getByRole('button', { name: '总调度室', exact: true })
    const createGroup = page.getByRole('button', { name: '创建分组', exact: true })
    const list = page.getByRole('region', { name: 'Bot 和群聊列表', exact: true })
    await mainRole.waitFor()
    await list.locator('section').first().waitFor()
    const capture = async () => ({
      createGroup: await createGroup.boundingBox(), list: await list.boundingBox(), separator: await separator(list),
      groups: await list.locator('section').evaluateAll(groups => groups.map(group => {
        const { x, y, width, height } = group.getBoundingClientRect()
        return { x, y, width, height }
      })),
    })
    const mainStyle = await labelStyle(mainRole)
    const badgeStyle = await labelStyle(page.getByText('主 Bot', { exact: true }))
    const expanded = await capture()
    expect(expanded.createGroup).not.toBeNull()
    expect(expanded.list).not.toBeNull()
    expect(expanded.groups.length).toBeGreaterThan(0)
    expect(await toggle.getAttribute('aria-pressed')).toBe('false')
    expect(await headquarters.isVisible()).toBe(true)
    const switchFrame = () => toggle.evaluate(element => {
      const { borderWidth, backgroundColor } = getComputedStyle(element)
      return { borderWidth, backgroundColor }
    })
    const framelessSwitch = { borderWidth: '0px', backgroundColor: 'rgba(0, 0, 0, 0)' }
    expect(await switchFrame()).toEqual(framelessSwitch)
    await toggle.click()
    await access.waitFor()
    expect(await switchFrame()).toEqual(framelessSwitch)
    expect(await mainRole.isVisible()).toBe(false)
    expect(await headquarters.isVisible()).toBe(false)
    expect(await capture()).toEqual(expanded)
    const ledgerName = ledger.getByText('兢兢', { exact: true })
    const accessName = access.getByText('业业', { exact: true })
    for (const name of [ledgerName, accessName]) {
      expect(await labelStyle(name)).toEqual(mainStyle)
      expect(await name.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    }
    const ledgerBadge = ledger.getByText('建账助手', { exact: true })
    const accessBadge = access.getByText('系统助手', { exact: true })
    expect(await labelStyle(ledgerBadge)).toEqual(badgeStyle)
    expect(await labelStyle(accessBadge)).toEqual(badgeStyle)
    expect(await artwork.count()).toBe(1)
    const { artworkMiddle, feetBottom, ledgerFeetCenter, accessFeetCenter } = await artwork.evaluate(async node => {
      const image = node as HTMLImageElement
      await image.decode()
      const { x, y, width, height } = image.getBoundingClientRect()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0)
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
      const lastVisiblePixel = data.findLastIndex((value, index) => index % 4 === 3 && value >= 128)
      const visibleHeight = Math.floor(lastVisiblePixel / (4 * canvas.width)) + 1
      const scale = Math.min(width / canvas.width, height / canvas.height)
      const imageLeft = x + (width - canvas.width * scale) / 2
      const imageMidpoint = Math.floor(canvas.width / 2)
      const feetTop = visibleHeight - Math.round(canvas.height * 0.08)
      function feetCenter(start: number, end: number) {
        let left = end
        let right = start
        for (let row = feetTop; row < visibleHeight; row++) {
          for (let column = start; column < end; column++) {
            if (data[4 * (row * canvas.width + column) + 3]! < 128) continue
            left = Math.min(left, column)
            right = Math.max(right, column)
          }
        }
        return imageLeft + (left + right + 1) * scale / 2
      }
      return {
        artworkMiddle: y + height / 2,
        feetBottom: y + (height - canvas.height * scale) / 2 + visibleHeight * scale,
        ledgerFeetCenter: feetCenter(0, imageMidpoint),
        accessFeetCenter: feetCenter(imageMidpoint, canvas.width),
      }
    })
    const ledgerBadgeBox = (await ledgerBadge.boundingBox())!
    const ledgerBox = (await ledgerName.boundingBox())!
    const accessBox = (await accessName.boundingBox())!
    const accessBadgeBox = (await accessBadge.boundingBox())!
    expect(ledgerBadgeBox.x + ledgerBadgeBox.width).toBeLessThan(ledgerBox.x)
    expect(ledgerBox.x + ledgerBox.width).toBeLessThan(accessBox.x)
    expect(accessBox.x + accessBox.width).toBeLessThan(accessBadgeBox.x)
    expect(Math.abs(ledgerBox.x + ledgerBox.width / 2 - ledgerFeetCenter)).toBeLessThanOrEqual(4)
    expect(Math.abs(accessBox.x + accessBox.width / 2 - accessFeetCenter)).toBeLessThanOrEqual(4)
    const rowCenter = ledgerBadgeBox.y + ledgerBadgeBox.height / 2
    for (const label of [ledgerBox, accessBox, accessBadgeBox]) {
      expect(label.y + label.height / 2).toBeCloseTo(rowCenter, 0)
    }
    for (const badge of [ledgerBadgeBox, accessBadgeBox]) {
      expect(badge.y - feetBottom).toBeGreaterThanOrEqual(1)
      expect(badge.y - feetBottom).toBeLessThanOrEqual(7)
    }
    for (const button of [ledger, access]) {
      expect(await button.evaluate((element, y) => {
        const { x, width } = element.getBoundingClientRect()
        return element.contains(document.elementFromPoint(x + width / 2, y))
      }, artworkMiddle)).toBe(true)
    }

    const screenshot = process.env.DSH_ASSISTANT_SWITCH_SCREENSHOT
    if (screenshot !== undefined) {
      const header = toggle.locator('xpath=ancestor::div[@data-switchable][1]')
      await page.mouse.move(0, 0)
      await header.locator('img').evaluateAll(images => Promise.all(images.map(image => (image as HTMLImageElement).decode())))
      await header.screenshot({ path: screenshot, animations: 'disabled' })
    }

    await toggle.click()
    await mainRole.waitFor()
    expect(await capture()).toEqual(expanded)
    expect(await ledger.isVisible()).toBe(false)
    expect(await headquarters.isVisible()).toBe(true)

    await page.getByRole('button', { name: '收起 Bot 卡片', exact: true }).click()
    await page.getByRole('button', { name: '展开 Bot 卡片', exact: true }).waitFor()
    const collapsed = await capture()
    expect(collapsed.list!.y).toBeLessThan(expanded.list!.y)
    await toggle.click()
    await access.waitFor()
    expect(await capture()).toEqual(collapsed)
    await toggle.click()
    await access.waitFor({ state: 'hidden' })
    expect(await capture()).toEqual(collapsed)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    try { await browser?.close() } finally {
      try { await scaffold?.close() } finally { vi.unstubAllEnvs() }
    }
  }
})
