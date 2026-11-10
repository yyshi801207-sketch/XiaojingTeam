/** Execution feed snapshots keep tool state while excluding replies and argument payloads. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, createUserMessage, type ToolCallId } from '@deepseek-ai/dsh-llm'
import type { BotId } from '../src/types.ts'
import { projectRoomExecution, ROOM_ACTIVITY_ROWS } from '../src/client/room-activity-model.ts'

beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(1000) })
afterEach(() => { vi.restoreAllMocks() })

describe('member execution records', () => {
  it('pairs repeated tools independently and records nested execution without exposing payloads', () => {
    const session = Session.create(SessionId('worker'))
    const first = 'first' as ToolCallId, second = 'second' as ToolCallId, nested = 'nested' as ToolCallId
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'PRIVATE USER TEXT' }] }), { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: first, name: 'read_file', arguments: '{"secret":"PRIVATE ARGUMENT"}' })
    session.append('tool/call', { turn: 1, step: 1, callId: second, name: 'read_file', arguments: '{}' })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: second, isError: true,
      content: [{ type: 'text', text: 'PRIVATE RESULT' }] }) }, { surfaceOp: 'append' })
    session.append('tool/ptc-dispatch-start', { rootCallId: first, parentCallId: first, subCallId: nested, name: 'web_search', arguments: {} })
    session.append('tool/ptc-dispatch', { rootCallId: first, parentCallId: first, subCallId: nested, name: 'web_search', arguments: {}, isError: false, content: [] })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: first, isError: false, content: [] }) }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const entries = session.snapshotEvents().map(event => ({ type: 'event' as const, event }))
    const rows = projectRoomExecution('bot' as BotId, session.id, [...entries, ...entries])
    expect(rows).toHaveLength(9)
    expect(JSON.stringify(rows)).not.toContain('PRIVATE')
    expect(rows).toMatchSnapshot()
  })
  it('keeps cancellation, failure and unknown completion distinct and bounds only display rows', () => {
    const session = Session.create(SessionId('worker'))
    for (let turn = 1; turn <= ROOM_ACTIVITY_ROWS + 2; turn++) session.append('turn/start', { turn })
    session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    session.append('turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'private error' } } })
    session.append('turn/end', { turn: 3, reason: { kind: 'interrupted' } })
    const rows = projectRoomExecution('bot' as BotId, session.id, session.snapshotEvents().map(event => ({ type: 'event', event })))
    expect(rows).toHaveLength(ROOM_ACTIVITY_ROWS)
    expect(rows.slice(-3).map(row => row.kind)).toEqual(['turnCancelled', 'turnFailed', 'turnUnknown'])
  })
  it('does not reuse a removed call name when a history window is replaced', () => {
    const session = Session.create(SessionId('worker'))
    const callId = 'call' as ToolCallId
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'old_tool', arguments: '{}' })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, isError: false, content: [] }) }, { surfaceOp: 'append' })
    const entries = session.snapshotEvents().map(event => ({ type: 'event' as const, event }))
    expect(projectRoomExecution('bot' as BotId, session.id, entries)[1]?.tool).toBe('old_tool')
    expect(projectRoomExecution('bot' as BotId, session.id, entries.slice(1))[0]?.tool).toBe('')
  })
})
