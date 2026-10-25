/** Admit group uploads and preserve the existing composer's request identity without a container model. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import type { AttachmentAdmissionPart } from '@deepseek-ai/dsh-attachment'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { principalOf, RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { canonicalClientTimeZone } from '@deepseek-ai/dsh-util-time'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { TeamBot } from './types.ts'

function clientTimeZone(request: SessionPromptRequest): string | undefined {
  if (request.clientTimeZone === undefined) return undefined
  const zone = canonicalClientTimeZone(request.clientTimeZone)
  if (zone === undefined) throw new RemoteError('gateway/bad-request', 'Select a valid client timezone', {})
  return zone
}

/**
 * Compare retry content without retaining encoded uploads in the group directory.
 * @param request - the original composer request; its ID and delivery mode do not change its content.
 * @returns a canonical digest of ordered content and its client timezone.
 */
export function groupRequestDigest(request: SessionPromptRequest): string {
  const parts = request.content.map((part) => {
    switch (part.type) {
      case 'text': return ['text', part.text]
      case 'image': return ['image', part.mediaType, part.data, part.name ?? null]
      case 'file': return ['file', part.receiptId]
      default: return assertNever(part)
    }
  })
  return createHash('sha256').update(JSON.stringify([parts, clientTimeZone(request) ?? null])).digest('hex')
}

/**
 * Admit attachments for selected real members and bind the composer's staged file receipts.
 * @param ctx - public attachment, model, file-upload, member, and Session services.
 * @param request - the original composer request targeting the group's transcript Session.
 * @param targets - actual initial recipients; the transcript has no model.
 * @param signal - cancellation before durable input acceptance.
 * @param accept - persist the inbound intent, call commitFiles after that write, then publish it.
 * @returns the accepting operation's confirmed result.
 */
export async function admitGroupPrompt<T>(
  ctx: Context, request: SessionPromptRequest, targets: readonly TeamBot[], signal: AbortSignal,
  accept: (message: UserMessage, commitFiles: () => void) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted()
  const principal = principalOf(ctx.invocation)
  if (targets.length === 0) throw new RemoteError('gateway/bad-request', 'Select a group member before sending', {})
  if (!request.content.some(part => part.type !== 'text' || part.text.trim().length > 0)) {
    throw new RemoteError('gateway/bad-request', 'Provide a group message or attachment', {})
  }
  const zone = clientTimeZone(request)
  if (request.content.some(part => part.type === 'image')) {
    for (const bot of targets) {
      const selection = ctx.katcatsTeam.modelSelection(bot.id)
      let model: Awaited<ReturnType<typeof ctx.llm.resolveModelInfo>>
      try {
        model = await ctx.llm.resolveModelInfo(selection.provider, selection.model, signal)
      } catch (error) {
        signal.throwIfAborted()
        throw new RemoteError('session/model-unavailable', 'A selected member model is unavailable',
          { provider: selection.provider, model: selection.model }, { cause: error })
      }
      signal.throwIfAborted()
      if (model.inputModalities !== undefined && !model.inputModalities.includes('image')) {
        throw new RemoteError('session/attachment-invalid', 'A selected member model does not support image input',
          { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' })
      }
    }
  }
  signal.throwIfAborted()
  const resolved = await ctx.sessionController.resolveAgent(request.sessionId)
  signal.throwIfAborted()
  if ('error' in resolved) throw resolved.error
  const agent = resolved.agent
  const receiptIds = new Set<FileUploadReceiptId>()
  const parts = request.content.map((part): AttachmentAdmissionPart => {
    if (part.type !== 'file') return part
    const attachment = ctx.fileUploads.resolve(agent, part.receiptId)
    if (attachment === undefined) throw new RemoteError('session/attachment-invalid',
      'The file was not uploaded to this group', { reason: 'FILE_NOT_STAGED' })
    receiptIds.add(part.receiptId)
    return { type: 'file', attachment }
  })
  let content: Awaited<ReturnType<typeof ctx.attachments.admitPromptContent>>
  try {
    content = await ctx.attachments.admitPromptContent(parts)
  } catch (error) {
    signal.throwIfAborted()
    if (ctx.attachments.isAttachmentError(error)) {
      throw new RemoteError('session/attachment-invalid', error.message, { reason: error.code }, { cause: error })
    }
    throw error
  }
  signal.throwIfAborted()
  if (ctx.agents.get(agent.id) !== agent) throw new RemoteError('session/not-found', 'The group was closed during message admission', { sessionId: agent.id })
  const message = createUserMessage({ content, source: { kind: 'user', rpcId: request.requestId,
    ...(zone === undefined ? {} : { clientTimeZone: zone }),
    ...(principal === undefined ? {} : { principal }) } })
  using binding = ctx.fileUploads.bindPrompt(agent, [...receiptIds], request.requestId)
  return await accept(message, () => { binding.commit() })
}
