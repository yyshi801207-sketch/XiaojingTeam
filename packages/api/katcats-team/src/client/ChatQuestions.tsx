/** Group question cards reuse the original executor-scoped question composer. */
import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConnectionGeneration, ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PendingQuestion } from '@deepseek-ai/dsh-client-ui-user-questions/client'
import type { GroupQuestion, GroupQuestionTarget } from './chat-questions.ts'
import { groupQuestionAvailable } from './chat-questions.ts'
import type { ChatView } from './chat-model.ts'
import type { TeamView } from './model.ts'
import { GroupMemberAvatar } from './GroupMemberAvatar.tsx'
import css from './team.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** The provider panel renders under the verified original executor Session. */
    'katcats.group.question-panel': { kind: 'single'; scope: 'session'; owner: { pending: PendingQuestion } }
  }
}

/**
 * Render the original question provider without claiming the conversation composer's slot.
 * @param props - The original pending question and the framework Factory renderer.
 * @returns The shared answer panel, or localized feedback while the provider is unavailable.
 */
export function GroupQuestionPanel({ pending, renderFactorySlot, t }: PropsRuntime<'katcats.group.question-panel'>
  & PropsRenderFactories & PropsLocale<'katcats.team'>) {
  return renderFactorySlot('question.panel', { matched: pending }, { fallback: <p role="alert">{t('question.unavailable')}</p> })
}

/** Original questions and scoped acquisitions arrive through the group registration. */
export interface ChatQuestionsInjected {
  readonly hooks: {
    readonly chats: ObservableSnapshot<ChatView>
    readonly directory: ObservableSnapshot<TeamView>
    readonly groupQuestions: ObservableSnapshot<readonly GroupQuestion[]>
    readonly questionConnection: ObservableSnapshot<ConnectionState | undefined>
    readonly questionGeneration: ObservableSnapshot<ConnectionGeneration | undefined>
  }
  readonly retainQuestion: (target: GroupQuestionTarget, signal: AbortSignal) => Promise<SessionReference>
  readonly revealQuestion: (target: GroupQuestionTarget) => boolean
}

/** Group dock renders the provider-owned panel under the original Session. */
export type ChatQuestionsProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'katcats.team'>
  & PropsRenderSlots<'katcats.group.question-panel'> & InjectFace<ChatQuestionsInjected>

/**
 * Display only the selected group's original member questions.
 * @param props - Group directory, question identities and public composer renderer.
 * @returns Member-labelled answer panels or their original resume action.
 */
export function ChatQuestions({ sessionId, useChats, useDirectory, useGroupQuestions,
  useQuestionConnection, useQuestionGeneration, ...props }: ChatQuestionsProps) {
  const groups = useChats(value => value)
  const team = useDirectory(value => value)
  const questions = useGroupQuestions(value => value)
  const connected = useQuestionConnection(value => value === 'connected')
  const generation = useQuestionGeneration(value => value?.id)
  const chat = groups.snapshot?.chats.find(item => item.rootSessionId === sessionId)
  if (!connected || generation === undefined || chat === undefined) return null
  const requests = chat.executors.flatMap(executor => questions.filter(item => item.pending.sessionId === executor.sessionId)
    .map(question => ({ ...question, botId: executor.botId, rootSessionId: sessionId })))
    .filter(target => groupQuestionAvailable(target, groups, team))
  if (requests.length === 0) return null
  return <section className={css.approvals} aria-label={props.t('question.groupRequests')}>
    {requests.map((target) => {
      const bot = team.snapshot?.bots.find(item => item.id === target.botId)
      const name = bot?.name ?? props.t('team.general')
      return <div key={`${generation}:${target.pending.key}`} className={css.approvalCard}
        role="group" aria-label={props.t('question.memberRequest', { name })} data-katcats-question={target.pending.key}>
        <div className={css.approvalHeading}>
          {bot !== undefined && <GroupMemberAvatar appearance={bot.avatar} botId={bot.id} managerId={chat.managerId} size={22}
            managerLabel={props.t('chat.managerBadge')} />}
          <strong>{props.t('question.waitingForMember', { name })}</strong>
        </div>
        <QuestionPanel {...props} target={target} visible={target.visible} />
      </div>
    })}
  </section>
}

function QuestionPanel({ target, visible, retainQuestion, revealQuestion, SessionProvider, renderSlot, t }: Pick<ChatQuestionsProps,
  'retainQuestion' | 'revealQuestion' | 'SessionProvider' | 'renderSlot' | 't'> & {
    readonly target: GroupQuestionTarget
    readonly visible: boolean
  }) {
  const [reference, setReference] = useState<SessionReference | undefined>()
  const [failed, setFailed] = useState(false)
  const { rootSessionId, botId, pending } = target
  useEffect(() => {
    const controller = new AbortController()
    let acquired: SessionReference | undefined
    void retainQuestion({ rootSessionId, botId, pending }, controller.signal).then((value) => {
      acquired = value
      if (controller.signal.aborted) { value.release(); return }
      setReference(value)
    }, (_error: unknown) => { if (!controller.signal.aborted) setFailed(true) })
    return () => { controller.abort(); acquired?.release() }
  }, [rootSessionId, botId, pending, retainQuestion])
  if (failed) return <p role="alert">{t('question.unavailable')}</p>
  if (reference === undefined) return null
  if (!visible) return <Button size="sm" variant="outline" onClick={() => {
    if (!revealQuestion(target)) setFailed(true)
  }}>{t('question.resume')}</Button>
  return <SessionProvider session={reference}>{renderSlot('katcats.group.question-panel', { pending })}</SessionProvider>
}
