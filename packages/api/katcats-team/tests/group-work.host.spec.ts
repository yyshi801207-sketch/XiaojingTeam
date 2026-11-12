/** Real member execution admits draft preparation and requires actual contributions before delivery. */
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { GroupWorkGate } from '../src/group-work.ts'
import type { BotId } from '../src/types.ts'
import type { ChatDeliveryId, TeamChat } from '../src/chats-types.ts'
import { memoryFixture } from './memory-fixture.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

async function send(h: Awaited<ReturnType<typeof memoryFixture>>, chat: TeamChat, text: string): Promise<void> {
  await h.ctx.katcatsChats.sendMessage({ sessionId: chat.rootSessionId,
    requestId: brandString<SessionRequestId>('group-work-owner'), mode: 'queue', content: [{ type: 'text', text }],
  }, new AbortController().signal)
  const abort = new AbortController()
  try {
    for await (const frame of h.ctx.katcatsChats.follow(abort.signal)) {
      if (frame.value.activities.find(activity => activity.chatId === chat.id)?.processing === false) return
    }
    throw new Error('The group closed before the work decision settled')
  } finally { abort.abort() }
}

function files(h: Awaited<ReturnType<typeof memoryFixture>>, chat: TeamChat) {
  const writes: string[] = []
  h.ctx.effect(() => h.ctx.tools.register(defineTool({
    name: 'produce_artifact', description: 'Produce this synthetic group deliverable.',
    parameters: { file: { type: 'string', enum: ['unassigned.md', 'only-b.md', 'team-final.md'], required: true },
      content: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false,
      properties: { file: { type: 'string', required: true } } },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, exec) => {
      expect(exec.agent?.session.header.cwd).toBe(chat.workDir)
      exec.signal.throwIfAborted()
      await writeFile(join(chat.workDir, args.file), args.content)
      writes.push(args.file)
      return { file: args.file }
    },
  })))
  return writes
}

describe('group-wide work admission', () => {
  it('requires a work decision, permits drafts, and holds final replies until every assigned member answers', async () => {
    let bId = '', cId = ''
    const h = await memoryFixture([
      (request) => {
        const logged = JSON.stringify(request.messages)
        expect(logged).toContain('Verify synthetic product facts.')
        expect(logged).toContain('Design the synthetic presentation.')
        expect(logged).toContain(bId)
        expect(logged).toContain(cId)
        return toolCallResponse('unassigned-write', 'produce_artifact', { file: 'unassigned.md', content: 'No colleagues participated.' })
      },
      (request) => {
        expect(JSON.stringify(request.messages)).toContain('First record plan_group_work')
        return toolCallResponse('work-split', 'plan_group_work', { own_task: 'Integrate the reviewed content.', assignments: [
          { bot_id: bId, message: 'Verify the synthetic facts.' }, { bot_id: cId, message: 'Design the synthetic presentation.' },
        ], review: { reason: 'none' } })
      },
      toolCallResponse('record-work', 'record_group_task', { goal: 'Integrate both member contributions.',
        acceptance: ['Use FACT_B_731 and DESIGN_C_953.'], stage: 'preparing', next_step: 'Ask both members.', artifacts: [] }),
      () => toolCallResponse('ask-b', 'request_group_member', { bot_id: bId, message: 'Verify the synthetic facts.' }),
      textResponse('B actually verified FACT_B_731.'),
      toolCallResponse('only-b-write', 'produce_artifact', { file: 'only-b.md', content: 'C has not answered.' }),
      textResponse('The unfinished draft is the final result.'),
      (request) => {
        expect(JSON.stringify(request.messages)).toContain('Obtain every assigned member result')
        return toolCallResponse('ask-c', 'request_group_member', { bot_id: cId, message: 'Design the synthetic presentation.' })
      },
      (request) => {
        const logged = JSON.stringify(request.messages)
        expect(logged).toContain('FACT_B_731')
        expect(logged).toContain('Verify the synthetic facts.')
        return textResponse('C actually designed DESIGN_C_953.')
      },
      (request) => {
        expect(JSON.stringify(request.messages)).toContain('B actually verified FACT_B_731.')
        expect(JSON.stringify(request.messages)).toContain('C actually designed DESIGN_C_953.')
        return toolCallResponse('actual-final-write', 'produce_artifact',
          { file: 'team-final.md', content: 'FACT_B_731 + DESIGN_C_953' })
      },
      toolCallResponse('submit-work', 'record_group_task', { goal: 'Integrate both member contributions.',
        acceptance: ['Use FACT_B_731 and DESIGN_C_953.'], stage: 'delivered', next_step: 'Finished.', artifacts: [], submit_delivery: true }),
      textResponse('The final document uses both actual results: [File](./team-final.md).'),
    ])
    const a = (await h.ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const b = (await h.ctx.katcatsTeam.createBot({ name: 'B' })).bot
    const c = (await h.ctx.katcatsTeam.createBot({ name: 'C' })).bot
    bId = b.id; cId = c.id
    const created = (await h.ctx.katcatsChats.createChat({ name: 'Natural group task', memberIds: [a.id, b.id, c.id] })).chat
    const chat = (await h.ctx.katcatsChats.updateChat({ id: created.id,
      memberRoles: [{ botId: b.id, role: 'Verify synthetic product facts.' },
        { botId: c.id, role: 'Design the synthetic presentation.' }] })).chat
    const privateLogs = [a, b, c].map(bot => ({ id: bot.sessionId,
      events: h.ctx.agents.get(bot.sessionId)!.session.snapshotEvents() }))
    const written = files(h, chat)
    await send(h, chat, '帮我做一份关于合成产品介绍的演示文稿，你自己分配任务。')
    expect(written).toEqual(['only-b.md', 'team-final.md'])
    await expect(stat(join(chat.workDir, 'unassigned.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(chat.workDir, 'only-b.md'), 'utf8')).toBe('C has not answered.')
    expect(await readFile(join(chat.workDir, 'team-final.md'), 'utf8')).toBe('FACT_B_731 + DESIGN_C_953')
    const snapshot = await h.ctx.katcatsChats.snapshot()
    expect(snapshot.deliveries.map(delivery => [delivery.botId, delivery.state])).toEqual([
      [a.id, 'completed'], [b.id, 'completed'], [c.id, 'completed'],
    ])
    expect(h.adapter.requests.some(request => request.sessionId === chat.rootSessionId)).toBe(false)
    for (const log of privateLogs) expect(h.ctx.agents.get(log.id)!.session.snapshotEvents()).toEqual(log.events)
    const root = await h.ctx.sessionController.inspect(chat.rootSessionId)
    const publicHistory = root.events.map((event) => {
      if (event.type === 'katcats/group-task-lifecycle') return { kind: 'task', status: event.data.status,
        actor: event.data.actor.kind === 'member' ? event.data.actor.sender?.name ?? null : event.data.actor.kind,
        target: event.data.target.sender?.name ?? null, message: event.data.message }
      if (event.type !== 'user/message') return undefined
      const text = event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      if (event.data.source.kind === 'katcats-group-relay') return { kind: 'reply', speaker: event.data.source.sender.name, text }
      if (event.data.source.kind === 'user') return { kind: 'owner', text }
      return undefined
    }).filter(event => event !== undefined)
    expect(publicHistory).toMatchInlineSnapshot(`
      [
        {
          "kind": "owner",
          "text": "帮我做一份关于合成产品介绍的演示文稿，你自己分配任务。",
        },
        {
          "actor": "owner",
          "kind": "task",
          "message": "帮我做一份关于合成产品介绍的演示文稿，你自己分配任务。",
          "status": "queued",
          "target": "A",
        },
        {
          "actor": "owner",
          "kind": "task",
          "message": "帮我做一份关于合成产品介绍的演示文稿，你自己分配任务。",
          "status": "started",
          "target": "A",
        },
        {
          "actor": "A",
          "kind": "task",
          "message": "Verify the synthetic facts.",
          "status": "queued",
          "target": "B",
        },
        {
          "actor": "A",
          "kind": "task",
          "message": "Verify the synthetic facts.",
          "status": "started",
          "target": "B",
        },
        {
          "actor": "A",
          "kind": "task",
          "message": "Verify the synthetic facts.",
          "status": "completed",
          "target": "B",
        },
        {
          "kind": "reply",
          "speaker": "B",
          "text": "B actually verified FACT_B_731.",
        },
        {
          "actor": "A",
          "kind": "task",
          "message": "Design the synthetic presentation.",
          "status": "queued",
          "target": "C",
        },
        {
          "actor": "A",
          "kind": "task",
          "message": "Design the synthetic presentation.",
          "status": "started",
          "target": "C",
        },
        {
          "actor": "A",
          "kind": "task",
          "message": "Design the synthetic presentation.",
          "status": "completed",
          "target": "C",
        },
        {
          "kind": "reply",
          "speaker": "C",
          "text": "C actually designed DESIGN_C_953.",
        },
        {
          "actor": "owner",
          "kind": "task",
          "message": "帮我做一份关于合成产品介绍的演示文稿，你自己分配任务。",
          "status": "completed",
          "target": "A",
        },
        {
          "kind": "reply",
          "speaker": "A",
          "text": "The final document uses both actual results: [File](./team-final.md).",
        },
      ]
    `)
  })

  it('lets an explicitly addressed individual use its tools without recruiting colleagues', async () => {
    const h = await memoryFixture([
      toolCallResponse('individual-plan', 'plan_group_work', { own_task: 'Save one requested line.', assignments: [], review: { reason: 'none' } }),
      toolCallResponse('individual-write', 'produce_artifact', { file: 'team-final.md', content: 'An individual response.' }),
      textResponse('A saved the explicitly requested individual file.'),
    ])
    const a = (await h.ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const b = (await h.ctx.katcatsTeam.createBot({ name: 'B' })).bot
    const chat = (await h.ctx.katcatsChats.createChat({ name: 'Addressed member', memberIds: [a.id, b.id] })).chat
    const written = files(h, chat)
    await send(h, chat, '@A 请单独保存这一行。')
    expect(written).toEqual(['team-final.md'])
    expect((await h.ctx.katcatsChats.snapshot()).deliveries.map(delivery => delivery.botId)).toEqual([a.id])
  })

  it('lets a one-member group perform its task without an impossible assignment', async () => {
    const h = await memoryFixture([
      toolCallResponse('single-member-plan', 'plan_group_work', { own_task: 'Save the requested file.', assignments: [], review: { reason: 'none' } }),
      toolCallResponse('single-member-write', 'produce_artifact', { file: 'team-final.md', content: 'Only A exists.' }),
      textResponse('A saved the file.'),
    ])
    const a = (await h.ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const chat = (await h.ctx.katcatsChats.createChat({ name: 'One member', memberIds: [a.id] })).chat
    expect(files(h, chat)).toEqual([])
    await send(h, chat, '请保存文件。')
    expect(await readFile(join(chat.workDir, 'team-final.md'), 'utf8')).toBe('Only A exists.')
  })

  it('keeps greetings as ordinary member replies without planning or manufactured assignments', async () => {
    const h = await memoryFixture([textResponse('A says hello.')])
    const a = (await h.ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const b = (await h.ctx.katcatsTeam.createBot({ name: 'B' })).bot
    const chat = (await h.ctx.katcatsChats.createChat({ name: 'Conversation', memberIds: [a.id, b.id] })).chat
    await send(h, chat, '大家好。')
    expect(h.adapter.requests).toHaveLength(1)
    const snapshot = await h.ctx.katcatsChats.snapshot()
    expect(snapshot.deliveries.every(delivery => delivery.source.kind === 'owner-message')).toBe(true)
    expect(snapshot.deliveries.map(delivery => delivery.receipt?.text)).toEqual(['A says hello.'])
  })

  it('accepts a clarification before planning and records its answer for the next model request', async () => {
    const h = await memoryFixture([
      toolCallResponse('clarify-environment', 'ask_user_question', { question: 'Which test environment do you mean?' }),
      (request) => {
        expect(request.messages.filter(message => message.role === 'tool').map(message => message.content)).toMatchInlineSnapshot(`
          [
            [
              {
                "text": "{\"answer\":\"A test ledger in the production environment.\"}",
                "type": "text",
              },
            ],
          ]
        `)
        return textResponse('Understood: a test ledger in the production environment.')
      },
    ])
    h.ctx.effect(() => h.ctx.tools.register(defineTool({
      name: 'ask_user_question', description: 'Return a synthetic owner answer for group admission testing.',
      parameters: { question: { type: 'string', required: true } },
      output: { schema: { type: 'object', additionalProperties: false,
        properties: { answer: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async () => ({ answer: 'A test ledger in the production environment.' }),
    })))
    const a = (await h.ctx.katcatsTeam.createBot({ name: 'A' })).bot
    const chat = (await h.ctx.katcatsChats.createChat({ name: 'Clarify before planning', memberIds: [a.id] })).chat
    await send(h, chat, 'Use the test environment.')
    expect(h.adapter.requests).toHaveLength(2)
    const snapshot = await h.ctx.katcatsChats.snapshot()
    expect(snapshot.deliveries[0]).toMatchObject({ state: 'completed',
      receipt: { text: 'Understood: a test ledger in the production environment.' } })
  })

  it('allows modern clarification without unlocking business tools or review and retains legacy admission', () => {
    const reviewer = brandString<BotId>('reviewer')
    const gate = new GroupWorkGate(true, [reviewer], {
      policy: 'review-v1', deliveryId: brandString<ChatDeliveryId>('clarification-task'),
    })
    expect(gate.denial('ask_user_question')).toBeUndefined()
    expect(gate.completionDenial()).toBeUndefined()
    expect(gate.denial('produce_artifact')).toContain('First record plan_group_work')
    gate.decide({ ownTask: 'Prepare the financial conclusion.', assignments: [],
      review: { reason: 'financial-conclusion', reviewerBotId: reviewer } })
    expect(gate.denial('ask_user_question')).toBeUndefined()
    expect(gate.denial('present')).toContain('actual approved review')
    expect(gate.completionDenial()).toContain('actual approved review')
    expect(new GroupWorkGate(true, [reviewer]).denial('ask_user_question')).toContain('First use plan_group_work')
  })

  it('rejects foreign and duplicate assignments without unlocking business execution', () => {
    const b = brandString<BotId>('B'), c = brandString<BotId>('C')
    const gate = new GroupWorkGate(true, [b, c])
    for (const assignments of [[], [{ botId: brandString<BotId>('outside'), message: 'Foreign task.' }],
      [{ botId: b, message: 'First.' }, { botId: b, message: 'Duplicate.' }]]) {
      expect(() => gate.decide({ ownTask: 'Integrate.', assignments })).toThrow()
      expect(gate.denial('produce_artifact')).toBeDefined()
    }
    gate.decide({ ownTask: 'Integrate.', assignments: [{ botId: b, message: 'Facts.' }, { botId: c, message: 'Design.' }] })
    gate.receive(b)
    expect(gate.denial('produce_artifact')).toContain('every member')
    gate.receive(c)
    expect(gate.denial('produce_artifact')).toBeUndefined()
  })
})
