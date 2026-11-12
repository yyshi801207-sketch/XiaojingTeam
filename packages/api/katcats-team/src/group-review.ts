/** Exact review candidates and durable reviewer decisions for one group delivery. */
import { createHash } from 'node:crypto'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { brandString } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import type { ChatDeliveryId } from './chats-types.ts'
import type { BotId } from './types.ts'
import type { FinanceConnectorId } from './finance-types.ts'

import type { GroupReviewCandidate, GroupReviewCandidateRequest, GroupReviewVersion } from './group-review-types.ts'

/** Validate a persisted candidate before using its paths or completion evidence. */
export const groupReviewCandidateSchema = z.object({
  version: z.string().regex(/^[a-f0-9]{64}$/).transform(value => brandString<GroupReviewVersion>(value)),
  text: z.string().nullable(),
  files: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
  sources: z.array(z.object({
    deliveryId: z.string().min(1).transform(value => brandString<ChatDeliveryId>(value)),
    botId: z.string().min(1).transform(value => brandString<BotId>(value)),
  }).strict()).optional(),
  odooOperation: z.object({
    connectorId: z.string().min(1).transform(value => brandString<FinanceConnectorId>(value)),
    companyId: z.number().int().positive(), baseUrl: z.string().min(1), database: z.string().min(1),
    model: z.string().min(1), method: z.string().min(1), parametersJson: z.string().min(1),
  }).strict().optional(),
}).strict().transform(({ sources, odooOperation, ...candidate }) => ({ ...candidate,
  ...(sources === undefined ? {} : { sources }), ...(odooOperation === undefined ? {} : { odooOperation }),
}))

/**
 * Serialize JSON with stable object-key order; array order remains significant.
 * @param value - Validated ORM arguments or other JSON values.
 * @returns The canonical JSON used to compare an approved operation with dispatch.
 */
export function groupReviewJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : item)
}

/** Validate a persisted review receipt before granting completion. */
export const groupReviewReceiptSchema = z.object({
  parentDeliveryId: z.string().min(1).transform(value => brandString<ChatDeliveryId>(value)),
  deliveryId: z.string().min(1).transform(value => brandString<ChatDeliveryId>(value)),
  reviewerId: z.string().min(1).transform(value => brandString<BotId>(value)),
  candidateVersion: z.string().regex(/^[a-f0-9]{64}$/).transform(value => brandString<GroupReviewVersion>(value)),
  verdict: z.enum(['approved', 'changes_requested']), findings: z.string().trim().min(1),
}).strict()

/**
 * Capture complete candidate bytes through the configured filesystem provider.
 * @param fs - the caller's existing filesystem service and permissions.
 * @param cwd - authoritative group working directory, never a model-selected root.
 * @param request - original candidate text and paths; at least one must be nonempty.
 * @param signal - cancellation covering all filesystem operations.
 * @param maxBytes - configured cumulative byte budget; excess fails without truncation.
 * @param context - host-verified source deliveries and external operation, when provided.
 * @returns stable content identity and canonical file references.
 */
export async function captureGroupReviewCandidate(
  fs: FileSystem, cwd: string, request: GroupReviewCandidateRequest, signal: AbortSignal, maxBytes: number,
  context: Pick<GroupReviewCandidate, 'sources' | 'odooOperation'> = {},
): Promise<GroupReviewCandidate> {
  signal.throwIfAborted()
  const text = request.text ?? null
  if ((text === null || text.trim().length === 0) && (request.files === undefined || request.files.length === 0)
    && context.odooOperation === undefined) {
    throw new HarnessError('Provide the draft text or existing files to review.', 'KATCATS_CHAT_INVALID_REVIEW')
  }
  let remaining = maxBytes - Buffer.byteLength(text ?? '', 'utf8')
    - (Object.keys(context).length === 0 ? 0 : Buffer.byteLength(JSON.stringify(context), 'utf8'))
  if (remaining < 0) throw new HarnessError('The review candidate exceeds the configured byte limit.', 'KATCATS_CHAT_REVIEW_TOO_LARGE')
  const root = await fs.resolve(cwd, { signal })
  const files: { path: string; sha256: string }[] = []
  for (const path of request.files ?? []) {
    const entry = await fs.lstat(path, { cwd }, signal)
    if (entry?.type !== 'file') {
      throw new HarnessError('Review candidates must be existing regular files, not links or directories.', 'KATCATS_CHAT_INVALID_REVIEW')
    }
    const target = await fs.resolve(path, { cwd, signal })
    if (!fs.contains(root, target)) {
      throw new HarnessError('Review candidate files must stay inside this group working directory.', 'KATCATS_CHAT_INVALID_REVIEW')
    }
    const canonical = fs.processPath(target)
    if (files.some(file => file.path === canonical)) {
      throw new HarnessError('Each review candidate file must appear only once.', 'KATCATS_CHAT_INVALID_REVIEW')
    }
    const before = await fs.stat(target, signal)
    if (before?.type !== 'file') throw new HarnessError('The review candidate is no longer a regular file.', 'KATCATS_CHAT_INVALID_REVIEW')
    const bytes = await fs.readBytes(target, signal, remaining)
    const after = await fs.stat(target, signal)
    if (after?.type !== 'file' || before.version !== after.version) {
      throw new HarnessError('The candidate changed while it was being read. Save it before requesting review.', 'KATCATS_CHAT_REVIEW_CHANGED')
    }
    remaining -= bytes.byteLength
    files.push({ path: canonical, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  signal.throwIfAborted()
  const content = { text, files, ...context }
  const version = brandString<GroupReviewVersion>(createHash('sha256').update(JSON.stringify(content)).digest('hex'))
  return { version, ...content }
}

/**
 * Recheck candidate bytes before publication; unavailable versions fail review and unexpected I/O remains unconfirmed.
 * @param fs - the same configured filesystem service used for capture.
 * @param cwd - authoritative group working directory.
 * @param candidate - durably captured candidate.
 * @param signal - cancellation of verification.
 * @param maxBytes - configured cumulative byte budget.
 * @returns whether the candidate exists within its limits and still matches the reviewed version; unexpected I/O and cancellation throw.
 */
export async function verifyGroupReviewCandidate(
  fs: FileSystem, cwd: string, candidate: GroupReviewCandidate, signal: AbortSignal, maxBytes: number,
): Promise<boolean> {
  let current: GroupReviewCandidate
  try {
    current = await captureGroupReviewCandidate(fs, cwd, {
      ...(candidate.text === null ? {} : { text: candidate.text }), files: candidate.files.map(file => file.path),
    }, signal, maxBytes, {
      ...(candidate.sources === undefined ? {} : { sources: candidate.sources }),
      ...(candidate.odooOperation === undefined ? {} : { odooOperation: candidate.odooOperation }),
    })
  } catch (error) {
    if (error instanceof HarnessError && ['KATCATS_CHAT_INVALID_REVIEW', 'KATCATS_CHAT_REVIEW_CHANGED',
      'KATCATS_CHAT_REVIEW_TOO_LARGE', 'FS_NOT_FOUND', 'FS_NOT_REGULAR_FILE', 'FS_TOO_LARGE'].includes(error.code)) return false
    throw error
  }
  return current.version === candidate.version
}
