/** Real member tool executions and loop logs without an invented coordinator response. */
import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { HarnessError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { registerGroupMemberTools, type GroupMemberToolActions } from '../src/group-member-tools.ts'
import type { ChatDeliveryId } from '../src/chats-types.ts'
import { memoryFixture, memorySend } from './memory-fixture.ts'
import { toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

async function worker(script: Parameters<typeof memoryFixture>[0] = []) {
  const h = await memoryFixture(script)
  const member = (await h.ctx.katcatsTeam.createBot({ name: 'Writer' })).bot
  const agent = h.ctx.agents.get(member.sessionId)!
  const deliveryId = brandString<ChatDeliveryId>('member-delivery')
  const list = vi.fn<GroupMemberToolActions['list']>(async () => ({ members: [
    { bot_id: member.id, name: member.name, role: 'Write group content.', is_manager: false },
  ] }))
  const plan = vi.fn<GroupMemberToolActions['plan']>(async request => ({ chat_id: 'group', own_task: request.ownTask,
    assignments: request.assignments.map(task => ({ bot_id: task.botId, message: task.message })) }))
  const setRoles = vi.fn<GroupMemberToolActions['setRoles']>(async request => ({
    chat_id: 'group', manager_id: request.managerId ?? '',
    roles: request.memberRoles?.map(role => ({ bot_id: role.botId, role: role.role })) ?? [],
  }))
  const request = vi.fn<GroupMemberToolActions['request']>(async botId => ({
    chat_id: 'group', delivery_id: 'member-result', bot_id: botId, status: 'completed',
    reply: 'Reviewed the draft.', message_id: 'review-reply',
  }))
  const pass = vi.fn<GroupMemberToolActions['pass']>(async () => deliveryId)
  let active = true
  const actions: GroupMemberToolActions = {
    authorize: (exec) => {
      if (!active || exec.agent !== agent || h.ctx.agents.get(agent.id) !== agent) {
        throw new HarnessError('This tool requires the current group member execution.', 'KATCATS_CHAT_DENIED')
      }
    }, list, plan, setRoles, request, pass,
  }
  const remove = registerGroupMemberTools(agent, actions)
  const execute = (name: string, args: unknown, signal = new AbortController().signal) => h.ctx.tools.execute({
    callId: ToolCallId(`member-${name}`), name, arguments: args, agent, signal,
  })
  return { ...h, agent, member, actions, list, plan, setRoles, request, pass, remove, execute,
    deactivate: () => { active = false } }
}

describe('Tools owned by actual group member executions', () => {
  it('records a concrete work split without pretending any member has executed it', async () => {
    const h = await worker()
    const result = await h.execute('plan_group_work', { own_task: ' Integrate the results. ',
      assignments: [{ bot_id: ' reviewer ', message: ' Check the sources. ' }] })
    expect(result.isError).toBe(false)
    expect(result.meta).toEqual({ chat_id: 'group', own_task: 'Integrate the results.',
      assignments: [{ bot_id: 'reviewer', message: 'Check the sources.' }] })
    expect(h.request).not.toHaveBeenCalled()
    expect(h.plan.mock.calls.map(([request]) => request)).toEqual([{ ownTask: 'Integrate the results.',
      assignments: [{ botId: 'reviewer', message: 'Check the sources.' }] }])
    const invalid = await h.execute('plan_group_work', { own_task: 'Integrate.',
      assignments: [{ bot_id: 'reviewer', message: ' ' }] })
    expect(invalid.isError).toBe(true)
    expect(h.plan).toHaveBeenCalledTimes(1)
  })

  it('logs a real model-selected pass and finishes only that member turn', async () => {
    const h = await worker([toolCallResponse('pass-call', 'pass_group_turn', {})])
    await memorySend(h.agent, 'Contribute only if this group message needs you.')
    const log = await h.ctx.sessionController.inspect(h.agent.id)
    expect(log.events.flatMap<unknown>((event) => {
      if (event.type === 'tool/call') return [{ type: event.type, name: event.data.name, arguments: event.data.arguments }]
      if (event.type === 'tool/result') return [{ type: event.type, content: event.data.message.content,
        isError: event.data.message.isError ?? false, meta: event.data.meta }]
      if (event.type === 'turn/end') return [{ type: event.type, reason: event.data.reason }]
      return []
    })).toMatchInlineSnapshot(`
      [
        {
          "arguments": "{}",
          "name": "pass_group_turn",
          "type": "tool/call",
        },
        {
          "content": [
            {
              "text": "{\"kind\":\"katcats-group-pass\",\"deliveryId\":\"member-delivery\"}",
              "type": "text",
            },
          ],
          "isError": false,
          "meta": {
            "deliveryId": "member-delivery",
            "kind": "katcats-group-pass",
          },
          "type": "tool/result",
        },
        {
          "reason": {
            "kind": "completed",
          },
          "type": "turn/end",
        },
      ]
    `)
    expect(h.adapter.requests).toHaveLength(1)
    expect(h.pass).toHaveBeenCalledTimes(1)
    expect(h.request).not.toHaveBeenCalled()
  })

  it('returns the saved member reply only after the runtime finishes waiting for it', async () => {
    const h = await worker()
    const reply = Promise.withResolvers<Awaited<ReturnType<GroupMemberToolActions['request']>>>()
    h.request.mockImplementationOnce(() => reply.promise)
    let settled = false
    const pending = h.execute('request_group_member', { bot_id: ' reviewer ', message: ' Review this draft. ' })
      .finally(() => { settled = true })
    await vi.waitFor(() => { expect(h.request).toHaveBeenCalledTimes(1) })
    expect(settled).toBe(false)
    reply.resolve({ chat_id: 'group', delivery_id: 'member-result', bot_id: 'reviewer', status: 'completed',
      reply: 'Reviewed the draft.', message_id: 'review-reply' })
    const result = await pending
    expect(result.isError).toBe(false)
    expect(result.concludesTurn).toBeUndefined()
    expect(result.meta).toEqual({ chat_id: 'group', delivery_id: 'member-result', bot_id: 'reviewer', status: 'completed',
      reply: 'Reviewed the draft.', message_id: 'review-reply' })
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.meta) }])
    expect(h.request.mock.calls.map(([botId, message, exec]) => ({ botId, message, sameAgent: exec.agent === h.agent })))
      .toEqual([{ botId: 'reviewer', message: 'Review this draft.', sameAgent: true }])
    expect(h.adapter.requests).toEqual([])
  })

  it('keeps an explicit pass distinct from a member answer', async () => {
    const h = await worker()
    h.request.mockResolvedValueOnce({ chat_id: 'group', delivery_id: 'passed-delivery', bot_id: 'reviewer',
      status: 'passed', reply: null, message_id: null })
    const result = await h.execute('request_group_member', { bot_id: 'reviewer', message: 'Review this draft.' })
    expect(result.isError).toBe(false)
    expect(result.meta).toEqual({ chat_id: 'group', delivery_id: 'passed-delivery', bot_id: 'reviewer',
      status: 'passed', reply: null, message_id: null })
  })

  it('keeps tools in their exact member scope and rechecks current authority for every execution', async () => {
    const h = await worker()
    const other = (await h.ctx.katcatsTeam.createBot({ name: 'Other' })).bot
    const outside = h.ctx.agents.get(other.sessionId)!
    expect(h.ctx.tools.schemas(outside).map(schema => schema.name)).not.toContain('pass_group_turn')
    const borrowed = await h.ctx.tools.execute({ callId: ToolCallId('borrowed'), name: 'pass_group_turn', arguments: {},
      agent: new Proxy(h.agent, {}), signal: new AbortController().signal })
    expect(borrowed.isError).toBe(true)
    expect(h.pass).not.toHaveBeenCalled()
    h.deactivate()
    const stale = await h.execute('list_group_members', {})
    expect(stale.isError).toBe(true)
    expect(h.list).not.toHaveBeenCalled()
    h.remove()
    expect(h.ctx.tools.schemas(h.agent).map(schema => schema.name)).not.toContain('request_group_member')
  })

  it('rejects pass for an explicitly addressed member and invalid group settings without concluding the turn', async () => {
    const h = await worker()
    h.pass.mockRejectedValueOnce(new HarnessError('The user directly addressed this member.', 'KATCATS_CHAT_DENIED'))
    const addressed = await h.execute('pass_group_turn', {})
    expect(addressed.isError).toBe(true)
    expect(addressed.concludesTurn).toBeUndefined()
    for (const args of [{}, { roles: [{ bot_id: h.member.id, role: '  ' }] }, { manager_id: '', target_group: 'foreign' }]) {
      expect((await h.execute('set_group_roles', args)).isError).toBe(true)
    }
    expect(h.setRoles).not.toHaveBeenCalled()
    const saved = await h.execute('set_group_roles', { manager_id: '', roles: [{ bot_id: h.member.id, role: ' Write headlines. ' }] })
    expect(saved.isError).toBe(false)
    expect(h.setRoles.mock.calls.map(([request, exec]) => ({ request, sameAgent: exec.agent === h.agent })))
      .toEqual([{ request: { managerId: null, memberRoles: [{ botId: h.member.id, role: 'Write headlines.' }] }, sameAgent: true }])
  })

  it('reports cancellation during member execution as uncertain and never dispatches a pre-cancelled request', async () => {
    const h = await worker()
    const cancelled = new AbortController()
    cancelled.abort()
    expect((await h.execute('request_group_member', { bot_id: 'reviewer', message: 'Review.' }, cancelled.signal)).isError).toBe(true)
    expect(h.request).not.toHaveBeenCalled()
    const accepted: string[] = []
    const afterAcceptance = new AbortController()
    h.request.mockImplementationOnce(async (_botId, message, exec: ToolRunContext) => {
      accepted.push(message)
      afterAcceptance.abort()
      exec.signal.throwIfAborted()
      throw new Error('Aborted request did not stop')
    })
    const result = await h.execute('request_group_member', { bot_id: 'reviewer', message: 'Review once.' }, afterAcceptance.signal)
    expect(result.isError).toBe(true)
    expect(result.concludesTurn).toBeUndefined()
    expect(result.content).toEqual([{ type: 'text', text: 'The request was stopped. The member may have started or completed work; inspect the group before retrying.' }])
    expect(accepted).toEqual(['Review once.'])
    expect(h.adapter.requests).toEqual([])
  })
})
