/** Read-only group history tool with structured attachment output and exact continuation cursors. */
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { HarnessError, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type InferValue, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { GroupHistoryQuery, GroupHistoryResult } from './group-context.ts'

const historyBlockSchema = {
  oneOf: [
    { type: 'object', additionalProperties: false, properties: {
      type: { type: 'string', const: 'text', required: true }, text: { type: 'string', required: true },
    } },
    { type: 'object', additionalProperties: false, properties: {
      type: { type: 'string', const: 'image', required: true }, offloaded: { type: 'boolean', const: true },
      attachment: { type: 'object', additionalProperties: false, required: true, properties: {
        attachmentId: { type: 'string', required: true },
        mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
        bytes: { type: 'integer', required: true }, width: { type: 'integer', required: true }, height: { type: 'integer', required: true },
        name: { type: 'string' }, originalDimensions: { type: 'object', additionalProperties: false, properties: {
          width: { type: 'integer', required: true }, height: { type: 'integer', required: true },
        } },
      } },
    } },
    { type: 'object', additionalProperties: false, properties: {
      type: { type: 'string', const: 'file', required: true },
      attachment: { type: 'object', additionalProperties: false, required: true, properties: {
        attachmentId: { type: 'string', required: true }, name: { type: 'string', required: true }, bytes: { type: 'integer', required: true },
      } },
    } },
  ],
} as const

function canonicalBlock(block: ContentBlock): InferValue<typeof historyBlockSchema> {
  if (block.type === 'text' || block.type === 'image' || block.type === 'file') return block
  throw new HarnessError('The saved public history contains an unsupported content type.', 'KATCATS_CHAT_HISTORY_CONTENT')
}

/**
 * Create a current-member history reader whose authorization is rechecked by the runtime callback.
 * @param authorize - current worker authorization, called before any history lookup.
 * @param history - bounded public-history query within the authorized group and owner-message cutoff.
 * @returns scoped tool definition that logs the exact returned text and original image references.
 */
export function createGroupHistoryTool(
  authorize: (exec: ToolRunContext) => void,
  history: (query: GroupHistoryQuery, exec: ToolRunContext) => Promise<GroupHistoryResult>,
): ToolDefinition {
  return defineTool({
    name: 'read_group_history',
    description: 'Read original public messages and handoffs from this group. Use this to verify archived or summarized requirements, corrections, figures, sources and unresolved decisions. Supply exact message/handoff IDs or a keyword, or omit both for recent history. Results are newest first. Continue with next_cursor until a partial item is complete. This never reads private chats or another group.',
    parameters: {
      ids: { type: 'array', items: { type: 'string' }, description: 'Exact public item IDs from group context or earlier history results.' },
      keyword: { type: 'string', description: 'Case-insensitive text to find in original public content; combined with IDs when supplied.' },
      cursor: { type: 'string', description: 'Opaque next_cursor returned by the previous page using these same filters.' },
      limit: { type: 'integer', required: true, description: 'Positive maximum number of original items to return, capped by this group runtime.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        content: { type: 'array', items: historyBlockSchema, required: true },
        next_cursor: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        item_ids: { type: 'array', items: { type: 'string' }, required: true },
        partial_ids: { type: 'array', items: { type: 'string' }, required: true },
      } },
      render: (_args, value) => value.content.map((block): ContentBlock => {
        if (block.type === 'text') return block
        if (block.type === 'image') return { ...block, attachment: { ...block.attachment, attachmentId: AttachmentId(block.attachment.attachmentId) } }
        return { ...block, attachment: { ...block.attachment, attachmentId: AttachmentId(block.attachment.attachmentId) } }
      }),
      presentationMeta: (_args, value) => ({ itemIds: value.item_ids, partialIds: value.partial_ids, nextCursor: value.next_cursor }),
    },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      authorize(exec)
      exec.signal.throwIfAborted()
      if (Object.keys(args).some(key => !['ids', 'keyword', 'cursor', 'limit'].includes(key)) || args.limit < 1
        || args.ids?.some(id => id.trim().length === 0) === true || args.ids?.length === 0
        || args.keyword !== undefined && args.keyword.trim().length === 0
        || args.cursor !== undefined && args.cursor.trim().length === 0) {
        throw new HarnessError('Use a positive limit and non-empty history IDs, keyword or cursor.', 'KATCATS_CHAT_INVALID_INPUT')
      }
      const result = await history(args, exec)
      exec.signal.throwIfAborted()
      return { content: result.content.map(canonicalBlock), next_cursor: result.nextCursor,
        item_ids: result.entries.map(entry => entry.id), partial_ids: result.entries.filter(entry => entry.partial).map(entry => entry.id) }
    },
    presentCall: () => ({ card: 'generic', title: 'Read group history', kind: 'read' }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'Group history could not be read' : 'Original group history', content: result.content }),
  })
}
