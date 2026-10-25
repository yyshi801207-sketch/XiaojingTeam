// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { allowAllAccess } from '@deepseek-ai/dsh-client-test-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { AgentPresetDisplayRegistry } from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import { AboutSection } from '../src/client/AboutSection.tsx'
import { XIAOJING_PRODUCT_VERSION } from '../src/client/application-info.ts'
import { HeroBrandContent, HeroBrandMark } from '../src/client/HeroBrand.tsx'
import { SidebarBrandMark, SidebarBrandName } from '../src/client/SidebarBrand.tsx'
import { OnboardingContent } from '../src/client/OnboardingContent.tsx'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { XIAOJING_RELEASE_HISTORY } from '../src/client/release-history.ts'

const t = (key: keyof typeof zh): string => zh[key]
const unusedHook = (() => { throw new Error('unused by Xiaojing product components') }) as never
const kit = {
  ...allowAllAccess,
  useSessions: unusedHook, useWorkspaces: unusedHook, usePanelInfo: unusedHook,
  useSessionStatus: unusedHook, useSessionRetainInfo: unusedHook, useResource: unusedHook,
  useSession: unusedHook, useProjection: unusedHook, useConversation: unusedHook,
  useInput: unusedHook, inputActions: undefined, sessionId: undefined,
}

function sessionHook(agentPreset?: string) {
  const summary = { projectionValues: agentPreset === undefined ? {} : { agentPreset } }
  return ((selector: (state: { byId: Record<string, typeof summary> }) => unknown) =>
    selector({ byId: { current: summary } })) as never
}

afterEach(() => {
  cleanup()
  document.getElementById('root')?.remove()
  document.querySelectorAll('meta[name="theme-color"]').forEach((node) => { node.remove() })
  document.body.style.removeProperty('background-color')
  delete document.body.dataset.xiaojingProduct
  delete document.documentElement.dataset.dshClientBuildProfile
  Reflect.deleteProperty(window, 'xiaojingDesktop')
  vi.unstubAllEnvs()
})

const HOLES = [
  'sidebar.brand.mark',
  'sidebar.brand.name',
  'conversation.hero.brand.mark',
  'conversation.hero.brand.content',
  'conversation.chat.node',
  'onboarding.content',
  'settings.section',
] as const

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  ctx.provide('agentPresetDisplay', new AgentPresetDisplayRegistry())
  const disposeHoles = slots.register({
    name: 'root',
    children: Object.fromEntries(HOLES.map(name => [name, {
      kind: name === 'settings.section' ? 'list' : name === 'conversation.chat.node' ? 'keyed' : 'single',
      scope: name === 'conversation.chat.node' ? 'session' : 'root',
    }])),
  } as never, () => null)
  return { ctx, slots, disposeHoles }
}

describe('Xiaojing product UI', () => {
  it('keeps the first-use instructions and platform link without a decorative header', () => {
    const root = document.createElement('div')
    root.id = 'root'
    root.inert = false
    document.body.append(root)
    const acknowledge = vi.fn(async () => {})
    const view = render(<OnboardingContent {...kit} acknowledge={acknowledge} saving={false} failed={false} t={t} />)
    const dialog = screen.getByRole('dialog', { name: '初次使用说明' })
    expect(dialog.querySelectorAll('li')).toHaveLength(2)
    expect(dialog.textContent).not.toContain('Harness')
    expect(dialog.querySelector('img, svg')).toBeNull()
    expect({
      title: dialog.querySelector('h2')?.textContent,
      steps: Array.from(dialog.querySelectorAll('h3'), heading => heading.textContent),
      actions: screen.getAllByRole('button').map(button => button.textContent),
      graphics: dialog.querySelectorAll('img, svg').length,
    }).toMatchInlineSnapshot(`
      {
        "actions": [
          "开始使用",
        ],
        "graphics": 0,
        "steps": [
          "获取 API Key",
          "连接您的智能体团队",
        ],
        "title": "初次使用说明",
      }
    `)
    for (const key of ['onboardingGetKeyBody', 'onboardingConnectBody', 'onboardingManageKey', 'onboardingSecurity', 'onboardingLaterHint'] as const) {
      expect(screen.getByText(zh[key], { exact: true })).toBeTruthy()
    }
    expect(screen.getByRole('link', { name: zh.platform }).getAttribute('href')).toBe('https://platform.deepseek.com/')
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: zh.onboardingTitle }))
    expect(root.inert).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(document.querySelector('[class*="mask"]')!)
    expect(acknowledge).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.start }))
    expect(acknowledge).toHaveBeenCalledOnce()
    view.unmount()
    expect(root.inert).toBe(false)
  })

  it('keeps the guide action disabled during save and reports acknowledgement failure', () => {
    const acknowledge = vi.fn(async () => {})
    const view = render(<OnboardingContent {...kit} acknowledge={acknowledge} saving failed={false} t={t} />)
    const action = screen.getByRole<HTMLButtonElement>('button', { name: zh.start })
    expect(action.disabled).toBe(true)
    fireEvent.click(action)
    expect(acknowledge).not.toHaveBeenCalled()
    view.rerender(<OnboardingContent {...kit} acknowledge={acknowledge} saving={false} failed t={t} />)
    expect(screen.getByRole('alert').textContent).toBe(zh.saveError)
    expect(action.disabled).toBe(false)
  })

  it('uses the English product guide in the English locale', () => {
    render(<OnboardingContent {...kit} acknowledge={async () => {}} saving={false} failed={false} t={key => en[key]} />)
    expect(screen.getByRole('dialog', { name: en.onboardingTitle })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.start })).toBeTruthy()
    for (const key of ['onboardingGetKeyBody', 'onboardingConnectBody', 'onboardingManageKey', 'onboardingSecurity', 'onboardingLaterHint'] as const) {
      expect(screen.getByText(en[key], { exact: true })).toBeTruthy()
    }
  })

  it.each([
    ['zh', zh, '小兢会计，您的AI财务团队'],
    ['en', en, 'Xiaojing Accounting, your AI finance team.'],
  ] as const)('renders the supplied finance team, localized title and current version badge (%s)', (_language, dictionary, title) => {
    const translate = (key: keyof typeof zh): string => dictionary[key]
    render(<HeroBrandMark {...kit} useSessions={sessionHook()} size={34} className="hero-mark" t={translate} />)
    const artwork = screen.getByRole('img', { name: dictionary.teamArtworkAlt })
    expect(artwork.querySelector('image')?.getAttribute('href')).toContain('xiaojing-finance-team-hero.png')
    expect(artwork.style.width.replaceAll(' ', ''))
      .toBe('calc(min(220px,35vh,55vw)*1536/1024)')
    expect(artwork.getAttribute('viewBox')).toBe('0 17 1240 1195')
    expect(artwork.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet')
    render(<HeroBrandContent {...kit} useSessions={sessionHook('standard')} t={translate} />)
    expect(screen.getByText(title)).toBeTruthy()
    expect(screen.getByText(dictionary.betaBadgeFormat.replace('{version}', XIAOJING_PRODUCT_VERSION))).toBeTruthy()
    cleanup()
    render(<HeroBrandContent {...kit} sessionId={'current' as never} useSessions={sessionHook('finance')} t={translate} />)
    expect(screen.getByText(title)).toBeTruthy()
    expect(screen.queryByText('小兢办公，您的AI财务助手')).toBeNull()
  })

  it('keeps office artwork when an older session has Finance metadata', () => {
    const props = { ...kit, sessionId: 'current' as never, size: 34, t }
    const view = render(<HeroBrandMark {...props} useSessions={sessionHook('standard')} />)
    const artwork = () => screen.getByRole('img', { name: zh.teamArtworkAlt }).querySelector('image')?.getAttribute('href')
    expect(artwork()).toContain('xiaojing-finance-team-hero.png')
    view.rerender(<HeroBrandMark {...props} useSessions={sessionHook('finance')} />)
    expect(artwork()).toContain('xiaojing-finance-team-hero.png')
    expect(screen.getByRole('img', { name: zh.teamArtworkAlt }).getAttribute('viewBox')).toBe('0 17 1240 1195')
    expect(screen.getByRole('img', { name: zh.teamArtworkAlt }).style.width.replaceAll(' ', ''))
      .toBe('calc(min(220px,35vh,55vw)*1536/1024)')
    expect(readFileSync('apps/web/public/xiaojing-office-robot-logo.png')
      .equals(readFileSync('apps/web/public/xiaojing-finance-robot-logo.png'))).toBe(true)
    view.rerender(<HeroBrandMark {...props} useSessions={sessionHook('standard')} />)
    expect(artwork()).toContain('xiaojing-finance-team-hero.png')
    expect(screen.getByRole('img', { name: zh.teamArtworkAlt }).getAttribute('viewBox')).toBe('0 17 1240 1195')
  })

  it.each([['zh', zh], ['en', en]] as const)('renders the complete supplied SUDO sidebar wordmark (%s)', (_language, dictionary) => {
    const view = render(<SidebarBrandMark {...kit} size={24} />)
    expect(view.container.querySelector('image')?.getAttribute('href')).toContain('sudo-wordmark.png')
    expect(view.container.querySelector('svg')?.getAttribute('width')).toBe('24')
    expect(view.container.querySelector('svg')?.getAttribute('height')).toBe('24')
    expect(view.container.querySelector('svg')?.getAttribute('viewBox')).toBe('35 59 2106 645')
    render(<SidebarBrandName {...kit} t={key => dictionary[key]} />)
    const wordmark = screen.getByRole('img', { name: dictionary.sidebarBrandAlt })
    expect(wordmark.querySelector('image')?.getAttribute('href')).toContain('sudo-wordmark.png')
    expect(wordmark.querySelector('image')?.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet')
    expect(wordmark.getAttribute('viewBox')).toBe('35 59 2106 645')
    expect(wordmark.getAttribute('preserveAspectRatio')).toBe('xMinYMid meet')
    expect(wordmark.querySelector('filter')).toBeNull()
    expect(screen.queryByText('您的AI办公搭子')).toBeNull()
    const css = readFileSync('packages/client/xiaojing-product/src/client/SidebarBrand.module.css', 'utf8')
    expect(css).toContain('padding-right: 4px')
    expect(css).toContain('width: 148px')
    expect(css).toContain('height: 24px')
    expect(css).toContain('height: 32px')
    expect(css).toContain('min-height: 36px')
    expect(css).not.toMatch(/invert\(|hue-rotate\(/u)
  })

  it('retains the supplied transparent SUDO logo bytes without recoloring or raster edits', () => {
    const source = readFileSync('packages/client/xiaojing-product/src/client/assets/sudo-wordmark.png')
    expect(createHash('sha256').update(source).digest('hex'))
      .toBe('4bc1f518e492d171de515e376be2f8eb88cecfea3741c3c5c2d478593fad00cf')
    expect({ width: source.readUInt32BE(16), height: source.readUInt32BE(20), colorType: source[25] })
      .toEqual({ width: 2172, height: 724, colorType: 6 })
  })

  it('retains the supplied finance robots and foot shadows without raster edits', () => {
    const source = readFileSync('packages/client/xiaojing-product/src/client/assets/xiaojing-finance-team-hero.png')
    expect(createHash('sha256').update(source).digest('hex'))
      .toBe('2e06582e44cabdea0173675f84f06ee83f57ef13fdcd3fae4270b2588a80bdcf')
    expect({ width: source.readUInt32BE(16), height: source.readUInt32BE(20), colorType: source[25] })
      .toEqual({ width: 1254, height: 1254, colorType: 6 })
  })

  it('retains the supplied Team application icon bytes in About', () => {
    const source = readFileSync('packages/client/xiaojing-product/src/client/assets/xiaojing-team-app-icon.png')
    expect(createHash('sha256').update(source).digest('hex'))
      .toBe('2346537b7b2a2b19edb0da53fa7d689b7cd2521470e6fd8dd1cc5d15d895e7bb')
    expect({ width: source.readUInt32BE(16), height: source.readUInt32BE(20), colorType: source[25] })
      .toEqual({ width: 1254, height: 1254, colorType: 6 })
  })

  it.each([
    ['zh', zh, '小兢会计团队版'],
    ['en', en, 'Xiaojing Accounting Team'],
  ] as const)('shows the Team app icon, localized name and installed versions in About (%s)', (_language, dictionary, name) => {
    vi.stubEnv('DSH_CLIENT_VERSION', '0.2.1-rc.2')
    const view = render(<AboutSection {...kit} close={vi.fn()} t={key => dictionary[key]} />)
    expect(screen.getByRole('heading', { name })).toBeTruthy()
    const icon = screen.getByRole<HTMLImageElement>('img', { name })
    expect(icon.getAttribute('src')).toContain('xiaojing-team-app-icon.png')
    expect(screen.queryByText('Katcats.AI')).toBeNull()
    expect(screen.getByText(dictionary.version + ' v' + XIAOJING_PRODUCT_VERSION)).toBeTruthy()
    expect(screen.getByText(dictionary.kernelVersion + ' 0.2.1-rc.2')).toBeTruthy()
    expect(screen.queryByText(dictionary.aboutDescription)).toBeNull()
    expect(screen.queryByText(dictionary.historyTitle)).toBeNull()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(view.container.querySelectorAll('header > *')).toHaveLength(4)
    expect({
      name: screen.getByRole('heading').textContent,
      iconLabel: icon.alt,
      versions: Array.from(view.container.querySelectorAll('span'), span => span.textContent),
    }).toMatchSnapshot()
  })

  it('does not invent a DSH version when build metadata is absent', () => {
    vi.stubEnv('DSH_CLIENT_VERSION', undefined)
    render(<AboutSection {...kit} close={vi.fn()} t={t} />)
    expect(screen.queryByText(/DSH 底座版本/u)).toBeNull()
  })

  it('keeps the current version first and preserves distinct historical versions', () => {
    const versions = XIAOJING_RELEASE_HISTORY.map(release => release.version)
    expect(versions[0]).toBe(XIAOJING_PRODUCT_VERSION)
    expect(new Set(versions).size).toBe(versions.length)
    expect(versions).toEqual(['1.0.2', '1.0.0', '0.3.3', '0.3.2', '0.3.1', '0.2.4', '0.2.3', '0.2.2'])
  })

  it('hides system prompts in Xiaojing transcripts without removing the generic renderer', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'xiaojing')
    const product = await bench()
    const GenericSystemPrompt = () => <div>System prompt</div>
    const disposeGeneric = product.slots.register({
      name: 'conversation.chat.node', key: 'system-prompt',
    }, GenericSystemPrompt as never)
    const fiber = product.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const winner = product.slots.entriesOfSlot('conversation.chat.node')
      .find(entry => entry.options.key === 'system-prompt')
    expect(winner?.options.priority).toBe(-1)
    expect(winner?.component).not.toBe(GenericSystemPrompt)
    expect((winner?.component as () => unknown)()).toBeNull()

    await fiber.dispose()
    expect(product.slots.entriesOfSlot('conversation.chat.node')[0]?.component).toBe(GenericSystemPrompt)
    disposeGeneric()
    await product.ctx.fiber.dispose()
  })

  it('activates every product occupant and theme only for the Xiaojing build profile', async () => {
    const theme = readFileSync('packages/client/xiaojing-product/src/client/theme.module.css', 'utf8')
    expect(theme).toContain(`body[data-xiaojing-product] [data-composer-primary] {
  --dsw-alias-button-info-fill: #12a489;
  --dsw-alias-button-info-hover: #0f8b75;
}`)
    expect(inject).toEqual(['slots', 'locale'])
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'official')
    const official = await bench()
    await official.ctx.plugin({ inject: [...inject], apply }).await()
    for (const hole of HOLES) expect(official.slots.entries(hole)).toHaveLength(0)
    expect(document.body.dataset.xiaojingProduct).toBeUndefined()
    expect(document.documentElement.dataset.dshClientBuildProfile).toBeUndefined()
    await official.ctx.fiber.dispose()

    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'xiaojing')
    const themeColor = document.createElement('meta')
    themeColor.name = 'theme-color'
    themeColor.content = 'rgb(255, 255, 255)'
    document.head.append(themeColor)
    document.body.style.backgroundColor = 'rgb(251, 253, 253)'
    const product = await bench()
    const fiber = product.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    for (const hole of HOLES) expect(product.slots.entries(hole)).toHaveLength(1)
    product.ctx.locale.setLocale('zh')
    expect(resolveSlotLabel(product.slots.entriesOfSlot('settings.section')[0]?.options.label)).toBe('关于 小兢会计团队版')
    product.ctx.locale.setLocale('en')
    expect(resolveSlotLabel(product.slots.entriesOfSlot('settings.section')[0]?.options.label)).toBe('About Xiaojing Accounting Team')
    expect(document.body.dataset.xiaojingProduct).toBe('')
    expect(document.documentElement.dataset.dshClientBuildProfile).toBe('xiaojing')
    expect(themeColor.content).toBe('rgb(251, 253, 253)')
    expect(product.ctx.agentPresetDisplay.resolve({ id: 'finance' }, key => key))
      .toEqual({ name: 'finance' })
    document.body.style.backgroundColor = 'rgb(255, 255, 255)'
    await fiber.dispose()
    for (const hole of HOLES) expect(product.slots.entries(hole)).toHaveLength(0)
    expect(document.body.dataset.xiaojingProduct).toBeUndefined()
    expect(document.documentElement.dataset.dshClientBuildProfile).toBeUndefined()
    expect(themeColor.content).toBe('rgb(255, 255, 255)')
    await product.ctx.fiber.dispose()
  })

})
