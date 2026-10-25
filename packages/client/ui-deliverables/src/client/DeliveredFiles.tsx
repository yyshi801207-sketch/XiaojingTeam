/** Original delivery cards selected from one actual closing message in the retained Session. */
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import { Deliverables, type DeliverablesInjected } from './Deliverables.tsx'
import { presentedForClosing } from './turn-deliverables.ts'

/** The provider derives file paths and authorized event coordinates from its own Session. */
export interface DeliveredFilesInput {
  readonly messageId: MessageId
}

/** Existing Sidebar preview addressed with the Factory's exact Session identity. */
export interface DeliveredFilesInjected extends DeliverablesInjected {
  readonly openResource: (address: string) => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    /** Original file cards for a real closing assistant message in the current Session. */
    'deliverables.files': {
      scope: 'session'
      props: DeliveredFilesInput
      locale: 'deliverables'
      inject: DeliveredFilesInjected
      children: { 'deliverables.files.actions': { kind: 'list'; scope: 'session' } }
    }
  }
}

/**
 * Reuse delivery cards without accepting file paths or synthetic Turn data from another feature.
 * @param props - Exact closing message, existing preview callback and original delivery services.
 * @returns Persisted final-file cards, or nothing for partial, unrelated or unpresented output.
 */
export function DeliveredFiles(props: FactoryComponentPropsOf<'deliverables.files'>) {
  const cwd = props.useSessions(snapshot => snapshot.byId[props.sessionId]?.cwd)
  const turn = props.useChat(snapshot => [...snapshot.timeline.turns.values()].find(item => item.status === 'closed'
    && item.data.get('turn-tail')?.closing?.finalNode.messageId === props.messageId))
  const closing = turn?.data.get('turn-tail')?.closing
  if (turn === undefined || closing === undefined || closing === null) return null
  const openFile = (path: string): void => { props.openResource(fileAddressFor(props.sessionId, cwd, path)) }
  const presented = presentedForClosing({ turn, seq: closing.finalNode.seq, openFile })
  if (presented.length === 0) return null
  return <Deliverables {...props} openFile={openFile}
    renderFileActions={owner => props.renderSlot('deliverables.files.actions', owner)} matched={{ changes: null, presented }} />
}
