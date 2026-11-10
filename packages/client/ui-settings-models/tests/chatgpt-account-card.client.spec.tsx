// @vitest-environment jsdom
/** Account card interactions over the real candidate controller and scripted operations. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { AuthorizationRemoteEvent, LlmDiscoveredModel } from '@deepseek-ai/dsh-api-remotes/client'
import { ChatGptAccount } from '../src/client/ChatGptAccount.tsx'
import { ChatGptAccountController, type ChatGptAccountOperations, type ChatGptAccountStatus } from '../src/client/chatgpt-account.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const candidates: readonly LlmDiscoveredModel[] = [
  { id: 'fixture-fast', name: 'Fixture Fast' }, { id: 'fixture-review', name: 'Fixture Review' },
]

function harness(connected = false) {
  let status: ChatGptAccountStatus = { available: true, connected, writable: true, configuredModelIds: [], modelCount: 0 }
  const operations = {
    read: vi.fn<ChatGptAccountOperations['read']>(async () => ({ ...status })),
    begin: vi.fn<ChatGptAccountOperations['begin']>(async function* () {
      status = { ...status, connected: true }
      yield { type: 'settled', outcome: { status: 'authorized' } }
    }),
    answer: vi.fn<ChatGptAccountOperations['answer']>(async () => {}),
    cancel: vi.fn<ChatGptAccountOperations['cancel']>(async () => {}),
    disconnect: vi.fn<ChatGptAccountOperations['disconnect']>(async () => { status = { ...status, connected: false } }),
    discover: vi.fn<ChatGptAccountOperations['discover']>(async () => candidates),
    verify: vi.fn<ChatGptAccountOperations['verify']>(async () => {}),
    adopt: vi.fn<ChatGptAccountOperations['adopt']>(async (models) => {
      status = { ...status, configuredModelIds: models.map(model => model.id), modelCount: models.length }
    }),
  }
  const controller = new ChatGptAccountController(operations)
  return { controller, operations, props: { controller, useAccount: bindSnapshotSelector(controller.store),
    t: (key: keyof typeof en) => en[key] } }
}

describe('ChatGptAccount card', () => {
  it('shows an explicit candidate selection and tests the selected model before making it available', async () => {
    const b = harness()
    render(<ChatGptAccount {...b.props} />)
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: en.chatGptConnect }).disabled).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: en.chatGptConnect }))
    await screen.findByRole('checkbox', { name: /Fixture Fast/u })
    expect(b.operations.adopt).not.toHaveBeenCalled()
    expect({ title: screen.getByRole('region').getAttribute('aria-label'),
      buttons: screen.getAllByRole('button').map(button => button.textContent),
      models: screen.getAllByRole<HTMLInputElement>('checkbox').map(input => ({ checked: input.checked, text: input.closest('label')?.textContent })),
      guidance: screen.getByText(en.chatGptCandidatesHint).textContent }).toMatchInlineSnapshot(`
        {
          "buttons": [
            "Switch account",
            "Configure candidate models",
            "Disconnect",
            "Test and save selected models",
          ],
          "guidance": "Selected models become available in Bot settings only after their connection tests pass.",
          "models": [
            {
              "checked": true,
              "text": "Fixture Fastfixture-fastNot tested",
            },
            {
              "checked": true,
              "text": "Fixture Reviewfixture-reviewNot tested",
            },
          ],
          "title": "ChatGPT subscription",
        }
      `)
    fireEvent.click(screen.getByRole('checkbox', { name: /Fixture Review/u }))
    const verified = Promise.withResolvers<undefined>()
    b.operations.verify.mockReturnValueOnce(verified.promise)
    fireEvent.click(screen.getByRole('button', { name: en.chatGptSaveModels }))
    expect(screen.getByText(en.chatGptTestRunning)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.chatGptSaveModels }).disabled).toBe(true)
    expect(b.operations.adopt).not.toHaveBeenCalled()
    await act(async () => { verified.resolve(undefined); await verified.promise })
    await waitFor(() => { expect(b.operations.adopt).toHaveBeenCalledExactlyOnceWith([candidates[0]]) })
    expect(screen.getByText(en.chatGptTestPassed)).toBeTruthy()
    expect(b.operations.verify).toHaveBeenCalledExactlyOnceWith(candidates[0], expect.any(AbortSignal))
  })

  it('shows a failed connection test while preserving the connected account and avoiding adoption', async () => {
    const b = harness(true)
    render(<ChatGptAccount {...b.props} />)
    fireEvent.click(await screen.findByRole('button', { name: en.chatGptFetchModels }))
    await screen.findByRole('checkbox', { name: /Fixture Fast/u })
    b.operations.verify.mockRejectedValueOnce(new Error('sensitive provider diagnostic'))
    fireEvent.click(screen.getByRole('button', { name: en.chatGptSaveModels }))
    await screen.findByText(en.chatGptTestFailed)
    expect(screen.getByRole('alert').textContent).toBe(en.chatGptCatalogFailed)
    expect(screen.getByText(en.chatGptConnected)).toBeTruthy()
    expect(screen.queryByText('sensitive provider diagnostic')).toBeNull()
    expect(b.operations.adopt).not.toHaveBeenCalled()
  })

  it('requires confirmation before disconnecting the shared account', async () => {
    const b = harness(true)
    render(<ChatGptAccount {...b.props} />)
    fireEvent.click(await screen.findByRole('button', { name: en.chatGptDisconnect }))
    const dialog = await screen.findByRole('dialog', { name: en.chatGptDisconnectTitle })
    expect(b.operations.disconnect).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: en.cancel }))
    expect(b.operations.disconnect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.chatGptDisconnect }))
    const reopened = await screen.findByRole('dialog', { name: en.chatGptDisconnectTitle })
    fireEvent.click(within(reopened).getByRole('button', { name: en.chatGptDisconnect }))
    await waitFor(() => { expect(b.operations.disconnect).toHaveBeenCalledOnce() })
    await screen.findByRole('button', { name: en.chatGptConnect })
    expect(b.operations.adopt).not.toHaveBeenCalled()
  })

  it('withdraws an unfinished authorization when the card unmounts', async () => {
    const b = harness()
    const end = Promise.withResolvers<readonly AuthorizationRemoteEvent[]>()
    let signal: AbortSignal | undefined
    b.operations.begin.mockImplementationOnce(input => (async function* () {
      signal = input
      yield { type: 'notice', notice: { message: 'Open official sign-in', url: 'https://example.test/sign-in' } }
      for (const event of await end.promise) yield event
    })())
    const view = render(<ChatGptAccount {...b.props} />)
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: en.chatGptConnect }).disabled).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: en.chatGptConnect }))
    await screen.findByRole('link', { name: en.chatGptOpenLogin })
    view.unmount()
    await waitFor(() => { expect(b.operations.cancel).toHaveBeenCalledOnce() })
    expect(signal?.aborted).toBe(true)
    end.resolve([{ type: 'settled', outcome: { status: 'authorized' } }])
    await end.promise
    await Promise.resolve()
    expect(b.operations.discover).not.toHaveBeenCalled()
  })

  it('renders localized account copy and hides unavailable account support', async () => {
    const b = harness()
    const view = render(<ChatGptAccount {...b.props} t={key => zh[key]} />)
    await screen.findByRole('button', { name: zh.chatGptConnect })
    expect(screen.getByRole('region', { name: zh.chatGptTitle })).toBeTruthy()
    b.operations.read.mockResolvedValueOnce({ available: false, connected: false, writable: false, modelCount: 0, configuredModelIds: [] })
    await act(() => b.controller.load())
    expect(view.container.innerHTML).toBe('')
  })
})
