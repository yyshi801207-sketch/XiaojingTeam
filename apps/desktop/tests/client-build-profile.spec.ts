import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  XIAOJING_IDENTITY, assertXiaojingDesktopClientBuild, initializeXiaojingApplication, xiaojingHostEnvironment,
} from '../src/xiaojing-product.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(record?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'xiaojing-desktop-build-'))
  roots.push(root)
  if (record !== undefined) {
    const path = join(root, '.dsh-build', 'client-build-environment.json')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(record)}\n`)
  }
  return root
}

describe('desktop Client build profile', () => {
  it('creates an isolated office preview without a Finance workspace', () => {
    const root = fixture()
    const applicationPaths = new Map<string, string>()
    const application = {
      isPackaged: false,
      getPath: (name: string): string => {
        const value = applicationPaths.get(name)
        if (value === undefined) throw new Error(`Missing preview path: ${name}`)
        return value
      },
      setPath: (name: string, value: string): void => { applicationPaths.set(name, value) },
      setName: (_name: string): void => {},
      setAppUserModelId: (_id: string): void => {},
    }
    const environment: NodeJS.ProcessEnv = { DSH_DESKTOP_PREVIEW_ROOT: root }
    const previousWorkspace = join(root, 'documents', '小兢办公工作区', '办公工作区')
    mkdirSync(previousWorkspace, { recursive: true })
    writeFileSync(join(previousWorkspace, 'keep.txt'), 'existing work')
    const previousData = join(root, 'app-data', '@sudotech', 'xiaojing-office-desktop', 'harness')
    mkdirSync(previousData, { recursive: true })
    writeFileSync(join(previousData, 'keep.txt'), 'previous sessions and usage')
    const paths = initializeXiaojingApplication(application, environment)
    expect(paths.userData).toBe(join(root, 'app-data', 'XiaojingAccountingTeam-desktop'))
    expect(readFileSync(join(previousData, 'keep.txt'), 'utf8')).toBe('previous sessions and usage')
    expect(existsSync(join(paths.dshHome, 'keep.txt'))).toBe(false)
    expect(paths.officeWorkspace).toBe(join(root, 'documents', 'XiaojingAccountingTeam_Home'))
    expect(existsSync(paths.officeWorkspace)).toBe(true)
    expect(paths.workspaceRoot).toBe(paths.officeWorkspace)
    expect(readFileSync(join(previousWorkspace, 'keep.txt'), 'utf8')).toBe('existing work')
    expect(existsSync(join(paths.workspaceRoot, 'Finance工作区'))).toBe(false)
    const host = xiaojingHostEnvironment(application, paths, environment)
    expect(host.DSH_HOME).toBe(paths.dshHome)
    expect(host.XIAOJING_OFFICE_WORKSPACE_ROOT).toBe(paths.officeWorkspace)
    expect(host.XIAOJING_FINANCE_WORKSPACE_ROOT).toBeUndefined()
    expect(host.KATCATS_PRODUCT_MODE).toBe('1')
    expect(host.KATCATS_DEV_MODE).toBeUndefined()
  })

  it('accepts only Xiaojing artifacts for an unpackaged preview', () => {
    const root = fixture({ environment: { DSH_CLIENT_BUILD_PROFILE: 'xiaojing' } })
    expect(() => { assertXiaojingDesktopClientBuild(root, false) }).not.toThrow()
  })

  it('rejects missing and non-Xiaojing build records before opening a preview', () => {
    expect(() => { assertXiaojingDesktopClientBuild(fixture(), false) }).toThrow(/build:xiaojing/u)
    expect(() => {
      assertXiaojingDesktopClientBuild(
        fixture({ environment: { DSH_CLIENT_BUILD_PROFILE: 'official' } }),
        false,
      )
    }).toThrow(/build:xiaojing/u)
  })

  it('does not require the repository-only record in a packaged application', () => {
    expect(() => { assertXiaojingDesktopClientBuild(fixture(), true) }).not.toThrow()
  })
})

function developmentEnvironment(repository: string): NodeJS.ProcessEnv {
  const root = join(repository, 'run')
  return {
    KATCATS_DEV_MODE: '1',
    KATCATS_DEV_ROOT: root,
    DSH_HOME: join(root, 'home'),
    DSH_AGENTS_HOME: join(root, 'agents'),
    DSH_DESKTOP_PREVIEW_ROOT: join(root, 'desktop'),
    XIAOJING_OFFICE_WORKSPACE_ROOT: join(root, 'workspaces'),
  }
}

function developmentApplication(repository: string, isPackaged = false) {
  const paths = new Map([
    ['appData', join(repository, 'permanent-app-data')],
    ['documents', join(repository, 'permanent-documents')],
  ])
  return {
    paths,
    isPackaged,
    getPath: vi.fn((name: string) => {
      const value = paths.get(name)
      if (value === undefined) throw new Error(`Missing application path: ${name}`)
      return value
    }),
    setPath: vi.fn((name: string, value: string) => { paths.set(name, value) }),
    setName: vi.fn(),
    setAppUserModelId: vi.fn(),
  }
}

describe('Katcats development isolation', () => {
  it('keeps original Katcat paths outside the independent packaged identity', () => {
    const repository = fixture()
    const originalHome = join(repository, 'permanent-app-data', 'Katcat-desktop', 'harness')
    const originalWorkspace = join(repository, 'permanent-documents', 'Katcat_Home')
    for (const directory of [originalHome, originalWorkspace]) {
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'keep.txt'), 'original Katcat data')
    }
    const application = developmentApplication(repository, true)
    const environment = { DSH_HOME: originalHome }
    const paths = initializeXiaojingApplication(application, environment, repository)
    const previousResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: join(repository, 'resources') })
    let host: NodeJS.ProcessEnv
    try {
      host = xiaojingHostEnvironment(application, paths, environment)
    } finally {
      if (previousResources === undefined) Reflect.deleteProperty(process, 'resourcesPath')
      else Object.defineProperty(process, 'resourcesPath', previousResources)
    }
    expect(existsSync(join(paths.dshHome, 'keep.txt'))).toBe(false)
    expect(existsSync(join(paths.officeWorkspace, 'keep.txt'))).toBe(false)
    expect([originalHome, originalWorkspace].map(directory => readFileSync(join(directory, 'keep.txt'), 'utf8')))
      .toEqual(['original Katcat data', 'original Katcat data'])
    expect({
      appId: XIAOJING_IDENTITY.appId,
      guid: XIAOJING_IDENTITY.nsisGuid,
      product: XIAOJING_IDENTITY.productName,
      userData: relative(repository, paths.userData).replaceAll('\\', '/'),
      home: relative(repository, host.DSH_HOME!).replaceAll('\\', '/'),
      workspace: relative(repository, paths.officeWorkspace).replaceAll('\\', '/'),
      productMode: host.KATCATS_PRODUCT_MODE,
      developmentMode: host.KATCATS_DEV_MODE,
    }).toMatchInlineSnapshot(`
      {
        "appId": "ai.xiaojing.accounting.team.desktop",
        "developmentMode": undefined,
        "guid": "c8462347-245f-49dd-8195-e1174bb7e3ef",
        "home": "permanent-app-data/XiaojingAccountingTeam-desktop/harness",
        "product": "小兢财务",
        "productMode": "1",
        "userData": "permanent-app-data/XiaojingAccountingTeam-desktop",
        "workspace": "permanent-documents/XiaojingAccountingTeam_Home",
      }
    `)
  })

  it('pins Electron, browser sessions and the Host inside this checkout without consulting installed paths', () => {
    const repository = fixture()
    const environment = developmentEnvironment(repository)
    const application = developmentApplication(repository)
    const paths = initializeXiaojingApplication(application, environment, repository)
    const root = join(repository, 'run')
    expect(application.getPath).not.toHaveBeenCalled()
    expect(application.paths.get('userData')).toBe(join(root, 'desktop', 'app-data', 'XiaojingAccountingTeam-Dev'))
    expect(application.paths.get('sessionData')).toBe(join(root, 'desktop', 'session-data'))
    expect(application.setName).toHaveBeenCalledWith('小兢财务 Dev')
    expect(application.setAppUserModelId).toHaveBeenCalledWith('ai.xiaojing.accounting.team.development')
    expect(paths.dshHome).toBe(join(root, 'home'))
    expect(paths.officeWorkspace).toBe(join(root, 'workspaces'))
    expect(existsSync(join(paths.userData, 'logs'))).toBe(true)
    const host = xiaojingHostEnvironment(application, paths, environment)
    expect(host.DSH_HOME).toBe(environment.DSH_HOME)
    expect(host.DSH_AGENTS_HOME).toBe(join(root, 'agents'))
    expect(host.XIAOJING_OFFICE_WORKSPACE_ROOT).toBe(paths.officeWorkspace)
    expect(host.KATCATS_PRODUCT_MODE).toBe('1')
    expect(host.KATCATS_DEV_MODE).toBe('1')
    expect(existsSync(join(repository, 'permanent-app-data'))).toBe(false)
    expect(existsSync(join(repository, 'permanent-documents'))).toBe(false)
  })

  it.each([
    'KATCATS_DEV_ROOT', 'DSH_HOME', 'DSH_AGENTS_HOME', 'DSH_DESKTOP_PREVIEW_ROOT', 'XIAOJING_OFFICE_WORKSPACE_ROOT',
  ])('rejects an external %s override before creating runtime directories', (name) => {
    const repository = fixture()
    const environment = { ...developmentEnvironment(repository), [name]: join(repository, 'outside-run') }
    const application = developmentApplication(repository)
    expect(() => initializeXiaojingApplication(application, environment, repository)).toThrow(name)
    expect(application.setPath).not.toHaveBeenCalled()
    expect(existsSync(join(repository, 'run'))).toBe(false)
  })

  it.each(['run', join('run', 'home'), join('run', 'desktop', 'session-data')])('refuses a linked %s directory', (location) => {
    const repository = fixture()
    const external = join(repository, 'outside-run')
    mkdirSync(external)
    writeFileSync(join(external, 'keep.txt'), 'unrelated data')
    const link = join(repository, location)
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      expect(() => initializeXiaojingApplication(developmentApplication(repository), developmentEnvironment(repository), repository))
        .toThrow(/unlinked directory/u)
      expect(readFileSync(join(external, 'keep.txt'), 'utf8')).toBe('unrelated data')
      expect(readdirSync(external)).toEqual(['keep.txt'])
    } finally {
      unlinkSync(link)
    }
  })

  it('keeps packaged identity and permanent paths when development variables are present', () => {
    const repository = fixture()
    const environment = developmentEnvironment(repository)
    const application = developmentApplication(repository, true)
    const paths = initializeXiaojingApplication(application, environment, repository)
    expect(paths.userData).toBe(join(repository, 'permanent-app-data', 'XiaojingAccountingTeam-desktop'))
    expect(paths.dshHome).toBe(join(paths.userData, 'harness'))
    expect(paths.officeWorkspace).toBe(join(repository, 'permanent-documents', 'XiaojingAccountingTeam_Home'))
    expect(application.setName).toHaveBeenCalledWith('小兢财务')
    expect(application.setAppUserModelId).toHaveBeenCalledWith('ai.xiaojing.accounting.team.desktop')
    expect(application.paths.get('sessionData')).toBe(join(paths.userData, 'session-data'))
    expect(existsSync(join(repository, 'run'))).toBe(false)
  })

  it('replaces inherited product roots and runtime overrides without reading previous installations', () => {
    const repository = fixture()
    const application = developmentApplication(repository, true)
    const previous = join(repository, 'Katcats-desktop')
    const environment: NodeJS.ProcessEnv = {
      DSH_HOME: previous, DSH_AGENTS_HOME: join(previous, 'agents'),
      DSH_DESKTOP_PRIMARY_RUNTIME_DIR: join(previous, 'runtime'),
      DSH_DESKTOP_DSH_DIR: previous, DSH_DESKTOP_PNPM_ENTRY: join(previous, 'pnpm.mjs'),
      DSH_DESKTOP_UPDATE_JOURNAL_DIR: previous, DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: 'old-policy',
      XIAOJING_EDGE_CDP_URL: 'http://127.0.0.1:9222', XIAOJING_EDGE_EXTENSION_TOKEN: 'previous-product',
      NODE_PATH: previous, NODE_OPTIONS: '--require previous-product',
      KATCATS_DEV_MODE: '1', KATCATS_DEV_ROOT: previous, DSH_DESKTOP_PREVIEW_ROOT: previous,
      XIAOJING_TEAM_EDGE_CDP_URL: 'http://127.0.0.1:19333',
    }
    const paths = initializeXiaojingApplication(application, environment, repository)
    expect(environment.DSH_HOME).toBe(paths.dshHome)
    expect(environment.DSH_AGENTS_HOME).toBe(join(paths.dshHome, 'agents'))
    expect(environment.XIAOJING_OFFICE_WORKSPACE_ROOT).toBe(paths.officeWorkspace)
    expect(environment.XIAOJING_TEAM_EDGE_CDP_URL).toBe('http://127.0.0.1:19333')
    expect(Object.keys(environment).sort()).toEqual([
      'DSH_AGENTS_HOME', 'DSH_HOME', 'XIAOJING_OFFICE_WORKSPACE_ROOT', 'XIAOJING_TEAM_EDGE_CDP_URL',
    ])
    expect(existsSync(previous)).toBe(false)
  })

  it('pins Host roots after a login shell reintroduces old paths and credentials', () => {
    const repository = fixture()
    const application = developmentApplication(repository)
    const environment = developmentEnvironment(repository)
    const paths = initializeXiaojingApplication(application, environment, repository)
    const host = xiaojingHostEnvironment(application, paths, {
      DSH_HOME: '/other-product', DSH_AGENTS_HOME: '/other-agents', DSH_BUNDLED_SKILL_DIR: '/other-skills',
      DSH_DESKTOP_PRIMARY_RUNTIME_DIR: '/other-runtime',
      XIAOJING_FINANCE_WORKSPACE_ROOT: '/other-finance', XIAOJING_EDGE_CDP_URL: 'http://127.0.0.1:9222',
      XIAOJING_EDGE_EXTENSION_DIR: '/other-extension', OPENAI_API_KEY: 'previous-product',
      XIAOJING_TEAM_EDGE_CDP_URL: 'http://127.0.0.1:19333',
    })
    expect(host.DSH_HOME).toBe(paths.dshHome)
    expect(host.DSH_AGENTS_HOME).toBe(join(paths.dshHome, 'agents'))
    expect(host.XIAOJING_OFFICE_WORKSPACE_ROOT).toBe(paths.officeWorkspace)
    expect(host.XIAOJING_TEAM_EDGE_CDP_URL).toBe('http://127.0.0.1:19333')
    expect(host.XIAOJING_TEAM_EDGE_EXTENSION_DIR).toContain('xiaojing-browser-control')
    for (const name of ['DSH_BUNDLED_SKILL_DIR', 'DSH_DESKTOP_PRIMARY_RUNTIME_DIR', 'XIAOJING_FINANCE_WORKSPACE_ROOT',
      'XIAOJING_EDGE_CDP_URL', 'XIAOJING_EDGE_EXTENSION_DIR', 'OPENAI_API_KEY']) {
      expect(host[name]).toBeUndefined()
    }
  })

  it.each(['Katcat-desktop', 'Katcats-desktop', join('@sudotech', 'xiaojing-accounting-desktop')])(
    'preserves existing %s data while initializing Team paths', (name) => {
      const repository = fixture()
      const previous = join(repository, 'permanent-app-data', name)
      mkdirSync(previous, { recursive: true })
      writeFileSync(join(previous, 'keep.json'), '{"previous":true}\n')
      const application = developmentApplication(repository, true)
      const paths = initializeXiaojingApplication(application, { DSH_HOME: previous }, repository)
      expect(paths.userData).toBe(join(repository, 'permanent-app-data', 'XiaojingAccountingTeam-desktop'))
      expect(readFileSync(join(previous, 'keep.json'), 'utf8')).toBe('{"previous":true}\n')
      expect(readdirSync(previous)).toEqual(['keep.json'])
    },
  )

  it.each([
    join('permanent-app-data', 'XiaojingAccountingTeam-desktop'),
    join('permanent-app-data', 'XiaojingAccountingTeam-desktop', 'harness'),
    join('permanent-documents', 'XiaojingAccountingTeam_Home'),
  ])('refuses a linked permanent Team directory: %s', (location) => {
    const repository = fixture()
    const previous = join(repository, 'previous-product')
    mkdirSync(previous)
    writeFileSync(join(previous, 'keep.txt'), 'previous product data')
    const link = join(repository, location)
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(previous, link, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      expect(() => initializeXiaojingApplication(developmentApplication(repository, true), {}, repository))
        .toThrow(/unlinked directory/u)
      expect(readdirSync(previous)).toEqual(['keep.txt'])
      expect(readFileSync(join(previous, 'keep.txt'), 'utf8')).toBe('previous product data')
    } finally {
      unlinkSync(link)
    }
  })
})
