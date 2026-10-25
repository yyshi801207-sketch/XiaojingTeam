// @vitest-environment jsdom
/** Pending controls belong to the clicked group run, not a later dock selection. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { BotId, GroupId } from '../src/types.ts'
import type { ChatId, ChatRunId, ChatSnapshot, TeamChat } from '../src/chats-types.ts'
import type { ChatView } from '../src/client/chat-model.ts'
import type { TeamView } from '../src/client/model.ts'
import { ChatControls, type ChatControlsProps } from '../src/client/ChatControls.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const first: TeamChat = { id: 'first' as ChatId, name: 'First', groupId: 'chats' as GroupId,
  rootSessionId: 'first-root' as SessionId, workDir: '/synthetic/first', memberIds: [], managerId: null,
  memberRoles: [], executors: [], relayLimit: 16, status: 'paused', pauseReason: 'owner', error: null,
  generation: 1, run: { id: 'first-run' as ChatRunId, generation: 1, relayCount: 0 } }
const second: TeamChat = { ...first, id: 'second' as ChatId, name: 'Second', rootSessionId: 'second-root' as SessionId,
  run: { id: 'second-run' as ChatRunId, generation: 1, relayCount: 0 } }
const initial: ChatSnapshot = { revision: 1, chats: [first, second], deliveries: [], relayLimit: 16, activities: [] }

function fixture() {
  const chats = createSnapshotStore<ChatView>({ phase: 'ready', snapshot: initial })
  const team = createSnapshotStore<TeamView>({ phase: 'ready', catalog: null, snapshot: {
    revision: 1, mainBotId: 'main' as BotId, bots: [], groups: [], modelCapabilities: { override: true, followGlobal: true },
  } })
  const pending = Promise.withResolvers<undefined>()
  const control = vi.fn(async () => { await pending.promise })
  const props = { sessionId: first.rootSessionId, useChats: bindSnapshotSelector(chats),
    useDirectory: bindSnapshotSelector(team),
    useSessionStatus: bindSnapshotSelector(createSnapshotStore<SessionStatusSnapshot>(new Map())),
    control, t: makeTranslate(zh) } as ChatControlsProps
  return { chats, pending, control, props }
}

describe('group control scope', () => {
  it('leaves another group controllable while the previous group request is waiting for its reply', async () => {
    const { pending, control, props } = fixture()
    const following = Promise.withResolvers<undefined>()
    control.mockImplementationOnce(async () => { await pending.promise })
      .mockImplementationOnce(async () => { await following.promise })
    const view = render(<ChatControls {...props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['chat.resume'] }))
    view.rerender(<ChatControls {...props} sessionId={second.rootSessionId} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['chat.resume'] }).disabled).toBe(false)
    expect(screen.queryByText(zh['chat.controlPending'])).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh['chat.resume'] }))
    expect(control).toHaveBeenNthCalledWith(2, 'resume', { id: second.id,
      expectedRunId: second.run!.id, expectedGeneration: second.generation })
    await act(async () => { pending.resolve(undefined) })
    expect({ pending: screen.queryByText(zh['chat.controlPending'])?.textContent,
      continueDisabled: screen.getByRole<HTMLButtonElement>('button', { name: zh['chat.resume'] }).disabled,
      stopDisabled: screen.getByRole<HTMLButtonElement>('button', { name: zh['chat.stop'] }).disabled,
    }).toMatchInlineSnapshot(`
      {
        "continueDisabled": true,
        "pending": "正在确认操作",
        "stopDisabled": false,
      }
    `)
    await act(async () => { following.resolve(undefined) })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['chat.resume'] }).disabled).toBe(false)
  })

  it('leaves a fresh run controllable while an old run control reply is delayed', async () => {
    const { chats, pending, control, props } = fixture()
    render(<ChatControls {...props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['chat.resume'] }))
    const next: TeamChat = { ...first, generation: 3,
      run: { id: 'fresh-run' as ChatRunId, generation: 3, relayCount: 0 } }
    act(() => { chats.set({ phase: 'ready', snapshot: { ...initial, revision: 3, chats: [next, second] } }) })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['chat.resume'] }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: zh['chat.resume'] }))
    expect(control).toHaveBeenNthCalledWith(2, 'resume', { id: first.id,
      expectedRunId: next.run!.id, expectedGeneration: next.generation })
    await act(async () => { pending.resolve(undefined) })
  })
})

for (const [locale, dictionary] of [['zh', zh], ['en', en]] as const) {
  describe(`group pause explanations (${locale})`, () => {
    it.each([
      ['owner', 'chat.pauseHint'],
      [null, 'chat.pauseOther'],
      ['unrecognized-reason', 'chat.pauseOther'],
      ['continuation-failed', 'chat.pauseExecution'],
      ['dispatch-failed', 'chat.pauseExecution'],
      ['legacy-queue', 'chat.pauseExecution'],
      ['member-execution-unconfirmed', 'chat.pauseUnknown'],
      ['member-dependency-unconfirmed', 'chat.pauseUnknown'],
      ['interruption-unconfirmed', 'chat.pauseUnknown'],
      ['relay-limit', 'chat.pauseLimit'],
    ] as const)('explains %s without attributing another cause to a manual pause', (reason, key) => {
      const { chats, props } = fixture()
      chats.set({ phase: 'ready', snapshot: { ...initial, chats: [{ ...first, pauseReason: reason }] } })
      render(<ChatControls {...props} t={makeTranslate(dictionary)} />)
      expect(screen.getAllByText(dictionary[key])).toHaveLength(1)
      if (reason !== 'owner') expect(screen.queryByText(dictionary['chat.pauseHint'])).toBeNull()
      expect(screen.getByRole<HTMLButtonElement>('button', { name: dictionary['chat.resume'] }).disabled).toBe(false)
      expect(screen.getByRole<HTMLButtonElement>('button', { name: dictionary['chat.stop'] }).disabled).toBe(false)
      if (reason === 'unrecognized-reason' && locale === 'zh') {
        expect({ explanation: screen.getByText(dictionary[key]).textContent,
          actions: screen.getAllByRole('button').map(button => button.textContent),
          errorDetails: screen.queryByText(dictionary['chat.errorDetails'])?.textContent ?? null,
        }).toMatchInlineSnapshot(`
          {
            "actions": [
              "继续",
              "停止",
            ],
            "errorDetails": null,
            "explanation": "群聊已暂停，原因尚未确认。请核对当前任务后再继续",
          }
        `)
      }
    })

    it.each(['member-execution-unconfirmed', 'unrecognized-reason'])(
      'shows the actual structured member failure once for %s', (reason) => {
        const { chats, props } = fixture()
        chats.set({ phase: 'ready', snapshot: { ...initial, chats: [{ ...first, pauseReason: reason,
          error: { code: 'KATCATS_CHAT_MEMBER_MALFORMED_RESPONSE', message: 'Fixed synthetic response diagnostic.' } }] } })
        render(<ChatControls {...props} t={makeTranslate(dictionary)} />)
        expect(screen.getAllByText(dictionary['chat.errorMemberMalformedResponse'])).toHaveLength(1)
        expect(screen.queryByText(dictionary['chat.pauseHint'])).toBeNull()
        expect(screen.queryByText(dictionary['chat.pauseOther'])).toBeNull()
        expect(screen.queryByText(dictionary['chat.pauseUnknown'])).toBeNull()
        expect(screen.getByRole('alert').textContent).toBe(dictionary['chat.errorMemberMalformedResponse'])
        expect(screen.getByRole('button', { name: dictionary['chat.resume'] })).toBeTruthy()
        expect(screen.getByRole('button', { name: dictionary['chat.stop'] })).toBeTruthy()
      })
  })
}
