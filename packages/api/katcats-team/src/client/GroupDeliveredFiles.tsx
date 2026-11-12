/** Original final-file cards under the exact member executor, independently of handoff visibility. */
import { useEffect, useState } from 'react'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConnectionGeneration, ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { InjectFace, PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-deliverables/client'
import type {} from '@deepseek-ai/dsh-xiaojing-visualize/client'
import type { GroupFilesTarget, RetainedGroupFiles } from './group-delivered-files.ts'
import { groupFilesTargetAvailable } from './group-delivered-files.ts'
import type { ChatView } from './chat-model.ts'
import type { TeamView } from './model.ts'
import css from './team.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Final files belonging to the actual completed member result, not a task-progress card. */
    'katcats.group.delivered-files': { kind: 'single'; scope: 'session'; owner: Omit<GroupFilesTarget, 'rootSessionId'> }
    /** The original card Factory is rendered only under its verified member Session. */
    'katcats.group.delivered-cards': { kind: 'single'; scope: 'session'; owner: { readonly messageId: MessageId; readonly visualizationCallIds: readonly string[] } }
  }
}

/** Acquisition remains in the product service; original file behavior remains in the delivery provider. */
export interface GroupDeliveredFilesInjected {
  readonly hooks: {
    readonly groupDirectory: ObservableSnapshot<ChatView>
    readonly deliveryDirectory: ObservableSnapshot<TeamView>
    readonly deliveryConnection: ObservableSnapshot<ConnectionState | undefined>
    readonly deliveryGeneration: ObservableSnapshot<ConnectionGeneration | undefined>
  }
  readonly retainFiles: (target: GroupFilesTarget, signal: AbortSignal) => Promise<RetainedGroupFiles>
}

/** Exact group-root result seat with the shared public delivery Factory. */
export type GroupDeliveredFilesProps = PropsRuntime<'katcats.group.delivered-files'> & PropsLocale<'katcats.team'>
  & PropsRenderSlots<'katcats.group.delivered-cards'> & InjectFace<GroupDeliveredFilesInjected>

/**
 * Render the original public delivery Factory inside the verified executor scope.
 * @param props - Original closing message and the existing Factory renderer.
 * @returns The provider's unchanged delivery cards and file actions.
 */
export function GroupDeliveredCards({ messageId, visualizationCallIds, renderFactorySlot }:
  PropsRuntime<'katcats.group.delivered-cards'> & PropsRenderFactories) {
  return <>
    {renderFactorySlot('deliverables.files', { messageId })}
    {visualizationCallIds.length > 0 && renderFactorySlot('xiaojing.visualize.cards', { messageId, callIds: visualizationCallIds })}
  </>
}

/**
 * Keep final-file acquisition limited to visible, ready, confirmed group results.
 * @param props - Original relay identity, current catalogs, connection and scope owner.
 * @returns Original delivery cards, or no file access while the group is unavailable.
 */
export function GroupDeliveredFiles({ sessionId, source, messageId, useGroupDirectory, useDeliveryDirectory,
  useDeliveryConnection, useDeliveryGeneration, ...props }: GroupDeliveredFilesProps) {
  const groups = useGroupDirectory(value => value)
  const team = useDeliveryDirectory(value => value)
  const connected = useDeliveryConnection(value => value === 'connected')
  const generation = useDeliveryGeneration(value => value?.id)
  const target: GroupFilesTarget = { rootSessionId: sessionId, source, messageId }
  if (!connected || generation === undefined || !groupFilesTargetAvailable(target, groups, team)) return null
  return <RetainedFiles key={`${generation}:${messageId}:${source.executionSessionId}`} {...props} target={target} />
}

function RetainedFiles({ target, retainFiles, SessionProvider, renderSlot, t }: Pick<GroupDeliveredFilesProps,
  'retainFiles' | 'SessionProvider' | 'renderSlot' | 't'> & { readonly target: GroupFilesTarget }) {
  const [result, setResult] = useState<RetainedGroupFiles | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const { rootSessionId, messageId, source } = target
  useEffect(() => {
    const controller = new AbortController()
    let acquired: SessionReference | undefined
    void retainFiles({ rootSessionId, messageId, source }, controller.signal).then((value) => {
      acquired = value.reference
      if (controller.signal.aborted) { acquired.release(); return }
      setResult(value)
    }, (_error: unknown) => {
      if (!controller.signal.aborted) setFailed(true)
    })
    return () => { controller.abort(); acquired?.release() }
  }, [rootSessionId, messageId, source, retainFiles])
  if (failed) return <p className={css.hint}>{t('chat.filesUnavailable')}</p>
  if (result === undefined) return null
  return <SessionProvider session={result.reference}>{renderSlot('katcats.group.delivered-cards', {
    messageId: source.outputMessageId, visualizationCallIds: result.visualizationCallIds,
  })}</SessionProvider>
}
