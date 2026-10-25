// @vitest-environment jsdom
/** Explicit custom-group confirmation and persistent overlay ownership. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GroupId, RemoveGroupRequest, TeamGroup } from '../src/types.ts'
import { TeamOverlays, type TeamOverlaysProps } from '../src/client/Overlays.tsx'
import { createTeamUi } from '../src/client/ui-state.ts'
import { en, zh } from '../src/client/locales.ts'

const group: TeamGroup = { id: 'editorial' as GroupId, name: 'Editorial', kind: 'bots', system: false }
const t = makeTranslate(zh)
afterEach(cleanup)

function setup() {
  const ui = createTeamUi()
  const remove = vi.fn<(request: RemoveGroupRequest) => Promise<void>>().mockResolvedValue(undefined)
  const props = { useTeamUi: bindSnapshotSelector(ui.source), close: ui.closeDialog,
    createBot: vi.fn(), createGroup: vi.fn(), renameGroup: vi.fn(), removeGroup: remove, renameEntity: vi.fn(), deleteEntity: vi.fn(),
    dismissNotice: ui.dismissNotice, t } as TeamOverlaysProps
  return { ui, remove, props }
}

describe('custom-group removal', () => {
  it('explains the retained Bot data and cancels without issuing a mutation', () => {
    const { ui, remove, props } = setup()
    ui.removeGroup(group)
    render(<TeamOverlays {...props} />)
    const dialog = screen.getByRole('dialog', { name: zh['team.removeGroup'] })
    expect(within(dialog).getByText(group.name)).toBeTruthy()
    expect(within(dialog).getByText(zh['team.removeGroupDescription'])).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: zh['team.cancel'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(remove).not.toHaveBeenCalled()
  })

  it('submits only the captured group identity once and blocks closing while it is pending', async () => {
    const { ui, remove, props } = setup()
    let finish!: () => void
    remove.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    ui.removeGroup(group)
    render(<TeamOverlays {...props} />)
    const dialog = screen.getByRole('dialog', { name: zh['team.removeGroup'] })
    fireEvent.click(within(dialog).getByRole('button', { name: zh['team.removeGroup'] }))
    expect(remove).toHaveBeenCalledExactlyOnceWith({ id: group.id })
    const pending = within(dialog).getByRole<HTMLButtonElement>('button', { name: zh['team.removingGroup'] })
    expect(pending.disabled).toBe(true)
    fireEvent.click(pending)
    fireEvent.click(within(dialog).getByRole('button', { name: zh['team.cancel'] }))
    fireEvent.click(within(dialog).getByRole('button', { name: zh['team.close'] }))
    expect(ui.source.getSnapshot().dialog).toMatchObject({ kind: 'remove-group', group })
    expect(remove).toHaveBeenCalledOnce()
    finish()
    await waitFor(() => { expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: zh['team.removeGroup'] }).disabled).toBe(false) })
  })

  it('preserves a failed confirmation for retry and uses the English locale on rerender', async () => {
    const { ui, remove, props } = setup()
    remove.mockImplementationOnce(async () => { ui.notify('team.groupRemoveFailed', false) })
    ui.removeGroup(group)
    const view = render(<TeamOverlays {...props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['team.removeGroup'] }))
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['team.removeGroup'] }).disabled).toBe(false) })
    expect(ui.source.getSnapshot().dialog).toMatchObject({ kind: 'remove-group', group })
    expect(screen.getByText(zh['team.groupRemoveFailed'])).toBeTruthy()
    act(() => { ui.dismissNotice(ui.source.getSnapshot().notice!.id) })
    view.rerender(<TeamOverlays {...props} t={makeTranslate(en)} />)
    expect(screen.getByRole('dialog', { name: en['team.removeGroup'] })).toBeTruthy()
    expect(screen.getByText(en['team.removeGroupDescription'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['team.removeGroup'] }))
    await waitFor(() => { expect(remove).toHaveBeenCalledTimes(2) })
  })
})
