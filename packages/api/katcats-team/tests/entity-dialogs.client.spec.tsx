// @vitest-environment jsdom
/** Captured list identities, explicit confirmation and acknowledged entity mutations. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { BotId } from '../src/types.ts'
import type { ChatId } from '../src/chats-types.ts'
import { TeamOverlays, type TeamOverlaysProps } from '../src/client/Overlays.tsx'
import { createTeamUi, type TeamEntity } from '../src/client/ui-state.ts'
import { en, zh } from '../src/client/locales.ts'

const bot: TeamEntity = { kind: 'bot', id: 'writer' as BotId, name: 'Writer' }
const chat: TeamEntity = { kind: 'chat', id: 'editorial' as ChatId, name: 'Editorial' }
afterEach(cleanup)

function setup() {
  const ui = createTeamUi()
  const renameEntity = vi.fn<(entity: TeamEntity, name: string) => Promise<void>>().mockResolvedValue(undefined)
  const deleteEntity = vi.fn<(entity: TeamEntity) => Promise<void>>().mockResolvedValue(undefined)
  const props = { useTeamUi: bindSnapshotSelector(ui.source), close: ui.closeDialog,
    createBot: vi.fn(), createGroup: vi.fn(), renameGroup: vi.fn(), removeGroup: vi.fn(), renameEntity, deleteEntity,
    dismissNotice: ui.dismissNotice, t: makeTranslate(zh) } as TeamOverlaysProps
  return { ui, props, renameEntity, deleteEntity }
}

describe('entity list dialogs', () => {
  it.each([bot, chat])('renames the captured $kind with a trimmed name and blocks a second dialog', async (entity) => {
    const { ui, props, renameEntity } = setup()
    ui.renameEntity(entity)
    ui.deleteEntity(entity)
    render(<TeamOverlays {...props} />)
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: zh['bot.name'] })
    expect(input.value).toBe(entity.name)
    fireEvent.change(input, { target: { value: '   ' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['bot.save'] }).disabled).toBe(true)
    fireEvent.change(input, { target: { value: '  New name  ' } })
    fireEvent.click(screen.getByRole('button', { name: zh['bot.save'] }))
    await waitFor(() => { expect(renameEntity).toHaveBeenCalledExactlyOnceWith(entity, 'New name') })
    expect(ui.source.getSnapshot().dialog).toMatchObject({ kind: 'rename-entity', entity })
  })

  it('keeps a pending rename captured and disables close and duplicate submission', async () => {
    const { ui, props, renameEntity } = setup()
    const pending = Promise.withResolvers<undefined>()
    renameEntity.mockReturnValueOnce(pending.promise)
    ui.renameEntity(bot)
    render(<TeamOverlays {...props} />)
    const dialog = screen.getByRole('dialog')
    const save = within(dialog).getByRole<HTMLButtonElement>('button', { name: zh['bot.save'] })
    fireEvent.click(save)
    fireEvent.click(save)
    fireEvent.click(within(dialog).getByRole('button', { name: zh['team.cancel'] }))
    fireEvent.click(within(dialog).getByRole('button', { name: zh['team.close'] }))
    expect(save.disabled).toBe(true)
    expect(renameEntity).toHaveBeenCalledExactlyOnceWith(bot, bot.name)
    expect(ui.source.getSnapshot().dialog).toMatchObject({ kind: 'rename-entity', entity: bot })
    pending.resolve(undefined)
    await waitFor(() => { expect(save.disabled).toBe(false) })
  })

  it.each([bot, chat])('cancels deleting a $kind without changing its record', (entity) => {
    const { ui, props, deleteEntity } = setup()
    ui.deleteEntity(entity)
    render(<TeamOverlays {...props} />)
    const title = entity.kind === 'bot' ? 'team.deleteBot' : 'team.deleteChat'
    const description = entity.kind === 'bot' ? 'team.deleteBotDescription' : 'team.deleteChatDescription'
    const dialog = screen.getByRole('dialog', { name: zh[title] })
    expect(within(dialog).getByText(entity.name)).toBeTruthy()
    expect(within(dialog).getByText(zh[description])).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: zh['team.cancel'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(deleteEntity).not.toHaveBeenCalled()
  })

  it('waits for the deletion owner and leaves a failed confirmation available for retry', async () => {
    const { ui, props, deleteEntity } = setup()
    const pending = Promise.withResolvers<undefined>()
    deleteEntity.mockReturnValueOnce(pending.promise)
    ui.deleteEntity(chat)
    const view = render(<TeamOverlays {...props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['team.deleteChat'] }))
    const deleting = screen.getByRole<HTMLButtonElement>('button', { name: zh['team.deletingEntity'] })
    fireEvent.click(deleting)
    fireEvent.click(screen.getByRole('button', { name: zh['team.close'] }))
    expect(deleting.disabled).toBe(true)
    expect(deleteEntity).toHaveBeenCalledExactlyOnceWith(chat)
    expect(ui.source.getSnapshot().dialog).toMatchObject({ kind: 'delete-entity', entity: chat })
    pending.resolve(undefined)
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['team.deleteChat'] }).disabled).toBe(false) })
    view.rerender(<TeamOverlays {...props} t={makeTranslate(en)} />)
    expect(screen.getByRole('dialog', { name: en['team.deleteChat'] })).toBeTruthy()
    expect(screen.getByText(en['team.deleteChatDescription'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['team.deleteChat'] }))
    await waitFor(() => { expect(deleteEntity).toHaveBeenCalledTimes(2) })
  })
})
