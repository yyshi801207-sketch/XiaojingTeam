// @vitest-environment jsdom
/** Feed following, member filtering and failure presentation do not touch execution controls. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatId } from '../src/chats-types.ts'
import type { BotId } from '../src/types.ts'
import { RoomActivity, type WatchRoomActivity } from '../src/client/RoomActivity.tsx'
import type { RoomActivitySnapshot } from '../src/client/room-activity.ts'
import type { RoomMember } from '../src/client/group-room-model.ts'
import { roomZh } from '../src/client/room-locales.ts'

afterEach(cleanup)
const member: RoomMember = { id: 'bot' as BotId, name: '核验员', role: 'Review', avatar: { shape: 'classic', color: '#2288FF' }, phase: 'started', current: true }
function setup() {
  const state = createSnapshotStore<RoomActivitySnapshot>({ connected: true, members: [{ botId: member.id, sessionId: 'worker' as SessionId, state: 'ready',
    rows: [{ id: 'one', botId: member.id, sessionId: 'worker' as SessionId, seq: 1, time: 1000, kind: 'toolRequested', tool: 'web_search', step: 1 }] }] })
  const watch = vi.fn<WatchRoomActivity>(() => state)
  const props = { chatId: 'group' as ChatId, members: [member], selected: null, watch, t: makeTranslate(roomZh) }
  const view = render(<RoomActivity {...props} />)
  return { state, watch, props, view }
}

describe('member execution panel', () => {
  it('pauses scroll following while the reader scrolls up and resumes explicitly', () => {
    const f = setup()
    const log = screen.getByRole('log')
    expect([...log.querySelectorAll('[title], strong')].map(element => element.textContent)).toMatchSnapshot()
    Object.defineProperties(log, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { value: 200 } })
    log.scrollTop = 100
    fireEvent.scroll(log)
    expect(screen.getByRole('button', { name: '跟随最新' })).toBeTruthy()
    act(() => { f.state.set({ ...f.state.getSnapshot(), members: [...f.state.getSnapshot().members] }) })
    expect(log.scrollTop).toBe(100)
    fireEvent.click(screen.getByRole('button', { name: '跟随最新' }))
    expect(log.scrollTop).toBe(1000)
    f.view.unmount()
    expect(f.watch.mock.calls[0]?.[1].aborted).toBe(true)
  })
  it('keeps execution failure visible while filtering the compact log', () => {
    const f = setup()
    act(() => { f.state.set({ connected: false, members: [{ ...f.state.getSnapshot().members[0]!, state: 'failed' }] }) })
    expect(screen.getByRole('alert').textContent).toContain('暂不可用')
    expect(screen.getByRole('status').textContent).toContain('连接已断开')
    f.view.rerender(<RoomActivity {...f.props} selected={'another-bot' as BotId} />)
    expect(screen.getByRole('log').textContent).not.toContain('web_search')
    expect(screen.queryByText('各成员当前状态')).toBeNull()
    expect(screen.getByText('暂无执行动态')).toBeTruthy()
  })
})
