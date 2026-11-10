/** Product log-only activity crosses the SDK projection without becoming an assistant reply. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { finalResponse, validatedSessionEvent } from '../src/api.ts'

const fixture = new URL('../../../api/katcats-team/tests/expected/sdk-group-task-event.json', import.meta.url)
const contextFixture = new URL('../../../api/katcats-team/tests/expected/sdk-group-context-events.json', import.meta.url)

describe('Katcats group activity in the TypeScript SDK', () => {
  it('preserves the complete event without producing an assistant reply', () => {
    const expected: unknown = JSON.parse(readFileSync(fixture, 'utf8'))
    const event = validatedSessionEvent(expected)
    expect(event).toEqual(expected)
    expect(finalResponse([event])).toBe('')
  })

  it('retains incremental context and review evidence without treating a correction notice as a reply', () => {
    const expected: unknown = JSON.parse(readFileSync(contextFixture, 'utf8'))
    if (!Array.isArray(expected)) throw new Error('Group context projection fixture must contain event records')
    const events = expected.map(validatedSessionEvent)
    expect(events).toEqual(expected)
    expect(finalResponse(events)).toBe('')
    expect(events.map(event => event.type)).toEqual(['user/message', 'user/message'])
    const restored = Session.create(SessionId('sdk-group-reviewer'), events)
    expect(restored.deriveMessages()).toEqual(events.map(event => event.data))
  })
})
