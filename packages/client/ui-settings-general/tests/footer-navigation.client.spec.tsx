// @vitest-environment jsdom
/** The folded sidebar keeps the production settings command and modal owner alive. */
import { expect, onTestFinished, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { initialShortcutConfig } from '@deepseek-ai/dsh-client-shortcuts/src/protocol.ts'

const it = createClientTest({ roster: webApp.closure(['@deepseek-ai/dsh-client-ui-settings-general']) }, { mount: true })

function DraftSettings() { return <input aria-label="Unsaved setting" defaultValue="" /> }

it('opens settings with Ctrl+, while the footer is closed and retains its draft through footer toggles', async ({ start }) => {
  document.documentElement.dataset.platform = 'linux'
  vi.stubGlobal('dshDesktop', {
    protocolVersion: 1,
    keyboard: { subscribe: () => () => {}, closeWindow: async () => {} },
    shortcuts: { get: async () => ({ ...initialShortcutConfig(), status: 'ready' }),
      subscribe: () => () => {}, recording: async () => {} },
  })
  vi.stubGlobal('__DSH_SIDEBAR_PRESENTATION__', {
    footerNavigation: { label: { en: 'Tools and settings' }, defaultExpanded: false },
  })
  onTestFinished(() => { delete document.documentElement.dataset.platform; vi.unstubAllGlobals() })
  const client = await start()
  await client.flush()
  const disposeDraft = client.ctx.slots.register({ name: 'settings.section', id: 'footer-draft', order: -100, label: 'Draft' }, DraftSettings)
  onTestFinished(disposeDraft)
  const toggle = await screen.findByRole('button', { name: /Tools and settings/ })
  expect(screen.queryByRole('button', { name: /^(Settings|设置)$/ })).toBeNull()
  fireEvent.keyDown(document, { key: ',', code: 'Comma', ctrlKey: true })
  const panel = await screen.findByRole('dialog')
  const draft = screen.getByRole<HTMLInputElement>('textbox', { name: 'Unsaved setting' })
  fireEvent.change(draft, { target: { value: 'Uncommitted draft' } })
  fireEvent.click(toggle)
  fireEvent.click(toggle)
  expect(screen.getByRole('dialog')).toBe(panel)
  expect(screen.getByRole('textbox', { name: 'Unsaved setting' })).toBe(draft)
  expect(draft.value).toBe('Uncommitted draft')
  fireEvent.keyDown(document, { key: ',', code: 'Comma', ctrlKey: true })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('button', { name: /^(Settings|设置)$/ })).toBeNull()
}, 60_000)
