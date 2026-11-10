/** Team composition isolates browser overrides, workspace defaults, and product collection. */
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import * as yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { interpolate } from '@deepseek-ai/cordis-plugin-loader'
import * as ModelSelectionHost from '@deepseek-ai/dsh-client-ui-model-selection'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it, onTestFinished } from 'vitest'

interface Row {
  id: string
  config?: Record<string, unknown>
  disabled?: unknown
}

const patches = yaml.load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), {
  schema: entryListSchema,
}) as { insert?: Row[] }[]
const rows = patches.flatMap(patch => patch.insert ?? [])
const browserSuffixes = [
  'BROWSER_EXECUTABLE', 'EDGE_EXTENSION_DIR', 'NATIVE_EDGE_EXECUTABLE', 'EDGE_CDP_ENDPOINT',
  'EDGE_PLAYWRIGHT_EXTENSION_TOKEN', 'CHROME_EXECUTABLE', 'CHROME_CDP_ENDPOINT', 'CHROME_PLAYWRIGHT_EXTENSION_TOKEN',
]
const oldEnvironment = {
  DSH_CLIENT_BUILD_PROFILE: 'xiaojing',
  ...Object.fromEntries(browserSuffixes.map(suffix => [`XIAOJING_${suffix}`, `old:${suffix}`])),
}
const teamEnvironment = Object.fromEntries(browserSuffixes.map(suffix => [`XIAOJING_TEAM_${suffix}`, `team:${suffix}`]))

function resolved(id: string, env: Record<string, string | undefined> = {}, profile = 'desktop'): Row {
  const row = rows.find(candidate => candidate.id === id)
  if (row === undefined) throw new Error(`Team composition must contain ${id}`)
  const scope = {
    process: {
      env,
      getBuiltinModule(name: string) {
        if (name === 'node:path') return posix
        if (name === 'node:os') return { homedir: () => '/fixture/user' }
        throw new Error(`Unexpected builtin ${name}`)
      },
    },
    ctx: { get: () => ({ name: profile }) },
    dshHomePath: (...segments: string[]) => posix.join('/fixture/team-harness', ...segments),
  }
  return interpolate(scope, row) as Row
}

describe('Team product composition', () => {
  it('omits the removed desktop pet host and settings plugins from the assembled application', () => {
    expect(rows.filter(row => /desktop-companion/u.test(row.id))).toEqual([])
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> }
    expect(Object.keys(manifest.dependencies).filter(name => name.includes('desktop-companion'))).toEqual([])
  })

  it('uses one footer fold with direct panel entries only in the Team product presentation', () => {
    expect(resolved('ui-sidebar').config).toEqual({})
    expect(resolved('ui-sidebar', { KATCATS_PRODUCT_MODE: '1' }).config).toEqual({
      primaryActionLabel: { zh: '创建新 Bot', en: 'Create new Bot' },
      footerNavigation: { label: { zh: '工具与设置', en: 'Tools and settings' }, defaultExpanded: false },
      footerActionsPlacement: 'after-panels',
    })
  })

  it('ignores browser executable, connector, endpoint, and token overrides from other editions', () => {
    expect(resolved('xiaojing-native-browser-control', oldEnvironment).disabled).toBe(false)
    expect(resolved('xiaojing-browser-control', oldEnvironment).config).toMatchObject({
      profileDir: '/fixture/team-harness/browser-control/profile', executablePath: undefined, extensionDir: undefined,
    })
    expect(resolved('xiaojing-native-browser-control', oldEnvironment).config).toMatchObject({
      edge: { executablePath: undefined, existingEndpoint: undefined, extensionToken: undefined },
      chrome: { executablePath: undefined, existingEndpoint: undefined, extensionToken: undefined },
    })
  })

  it('uses Team browser overrides when other editions are present in the same parent environment', () => {
    const env = { ...oldEnvironment, ...teamEnvironment }
    expect(resolved('xiaojing-browser-control', env).config).toMatchObject({
      executablePath: 'team:BROWSER_EXECUTABLE', extensionDir: 'team:EDGE_EXTENSION_DIR',
    })
    expect(resolved('xiaojing-native-browser-control', env).config).toMatchObject({
      requireUserSettings: true,
      edge: {
        existingConnection: 'auto-connect', executablePath: 'team:NATIVE_EDGE_EXECUTABLE',
        existingEndpoint: 'team:EDGE_CDP_ENDPOINT', extensionToken: 'team:EDGE_PLAYWRIGHT_EXTENSION_TOKEN',
      },
      chrome: {
        existingConnection: 'auto-connect', executablePath: 'team:CHROME_EXECUTABLE',
        existingEndpoint: 'team:CHROME_CDP_ENDPOINT', extensionToken: 'team:CHROME_PLAYWRIGHT_EXTENSION_TOKEN',
      },
    })
    expect(resolved('xiaojing-native-browser-control', { ...env, XIAOJING_TEAM_NATIVE_EDGE_EXECUTABLE: undefined }).config)
      .toMatchObject({ edge: { executablePath: 'team:BROWSER_EXECUTABLE' } })
  })

  it('keeps the Team workspace default and picker together, with an explicit Team launcher override', () => {
    const env = { DSH_CLIENT_BUILD_PROFILE: 'xiaojing' }
    expect(resolved('workspace-controller', env).config).toMatchInlineSnapshot(`
      {
        "defaultWorkspacePath": "/fixture/user/Documents/XiaojingAccountingTeam_Home",
        "directoryPickerInitialPath": "/fixture/user/Documents/XiaojingAccountingTeam_Home",
      }
    `)
    expect(resolved('workspace-controller', { ...env, XIAOJING_OFFICE_WORKSPACE_ROOT: '/fixture/team-workspace' }).config)
      .toEqual({ defaultWorkspacePath: '/fixture/team-workspace', directoryPickerInitialPath: '/fixture/team-workspace' })
    expect(resolved('workspace-controller').config)
      .toEqual({ defaultWorkspacePath: undefined, directoryPickerInitialPath: undefined })
  })

  it.each(['desktop', 'web'])('does not enable the original product collectors for %s', (profile) => {
    const env = { DSH_CLIENT_BUILD_PROFILE: 'xiaojing', DSH_CLIENT_VERSION: 'team-fixture', DSH_PRODUCT_ANALYTICS_OTLP_URL: 'https://collector.invalid/logs' }
    expect(resolved('desktop-product-telemetry', env, profile).disabled).toBe(true)
    expect(resolved('product-analytics', env, profile)).toMatchObject({ disabled: true, config: { enabled: false } })
  })

  it('keeps the original account UI and controller closed while retaining custom model settings', () => {
    expect(['ui-settings-account', 'account-controller'].map(id => ({ id, disabled: resolved(id).disabled })))
      .toMatchInlineSnapshot(`
        [
          {
            "disabled": true,
            "id": "ui-settings-account",
          },
          {
            "disabled": true,
            "id": "account-controller",
          },
        ]
      `)
    expect(resolved('ui-settings-models').disabled).toBeUndefined()
  })

  it('keeps the Team model-directory plugin enabled while publishing disabled native controls', async () => {
    const env = { DSH_CLIENT_BUILD_PROFILE: 'xiaojing', KATCATS_PRODUCT_MODE: '1' }
    const row = resolved('ui-model-selection', env)
    expect(row.disabled).toBeUndefined()
    expect(row.config).toEqual({ controlsEnabled: false })
    expect(resolved('katcats-team', env).disabled).toBe(false)
    const host = new Context()
    onTestFinished(() => host.fiber.dispose())
    host.baseUrl = 'file:///'
    await host.plugin(Loader)
    host.loader.builtins.models = ModelSelectionHost
    await host.loader.root.update([{ id: row.id, name: 'cordis:models', config: row.config }])
    await host.loader.await()
    const injections: IndexInjection[] = []
    host.emit('webserver/index-inject', injections)
    expect(injections).toEqual([{
      kind: 'global', name: '__DSH_MODEL_SELECTION__', value: { controlsEnabled: false },
    }])
  })
})
