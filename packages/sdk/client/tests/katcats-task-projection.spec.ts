/** Product log-only activity crosses the SDK projection without becoming an assistant reply. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { finalResponse, validatedSessionEvent } from '../src/api.ts'

const fixture = new URL('../../../api/katcats-team/tests/expected/sdk-group-task-event.json', import.meta.url)

describe('Katcats group activity in the TypeScript SDK', () => {
  it('preserves the complete event without producing an assistant reply', () => {
    const expected: unknown = JSON.parse(readFileSync(fixture, 'utf8'))
    const event = validatedSessionEvent(expected)
    expect(event).toEqual(expected)
    expect(finalResponse([event])).toBe('')
  })
})
