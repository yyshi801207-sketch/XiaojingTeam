/** Team question dialogs reuse the provider panel under its original Session. */
import { useEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { Button, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConnectionGeneration, ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PendingQuestion } from '@deepseek-ai/dsh-client-ui-user-questions/client'
import type { GroupQuestion, GroupQuestionTarget } from './chat-questions.ts'
import { groupQuestionAvailable } from './chat-questions.ts'
import type { TeamChat } from '../chats-types.ts'
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
  return renderFactorySlot('question.panel', { matched: pending, surface: 'modal' }, { fallback: <p role="alert">{t('question.unavailable')}</p> })
}

type PrivateQuestionProps = PropsRuntime<'conversation.composer'> & PropsRenderFactories & PropsLocale<'katcats.team'>
  & { matched: PendingQuestion } & InjectFace<{ hooks: { questionDirectory: ObservableSnapshot<TeamView> } }>

function PrivateQuestionComposer({ matched, renderFactorySlot, sessionId, useQuestionDirectory, t }: PrivateQuestionProps) {
  const bot = useQuestionDirectory(view => view.snapshot?.bots.find(item => item.sessionId === sessionId))
  const [shelved, setShelved] = useState<PendingQuestion>()
  if (bot === undefined) return renderFactorySlot('question.panel', { matched })
  if (shelved === matched) {
    return <section className={css.questionQueue} aria-label={t('question.memberRequest', { name: bot.name })}>
      <div className={css.questionRow}>
        <span>{t('question.waitingForMember', { name: bot.name })}</span>
        <Button size="sm" variant="outline" onClick={() => { setShelved(undefined) }}>{t('question.resume')}</Button>
      </div>
    </section>
  }
  return <Modal key={matched.key} open headless className={css.questionModal ?? ''}
    title={t('question.memberRequest', { name: bot.name })} onClose={() => { setShelved(matched) }}>
    {renderFactorySlot('question.panel', { matched, surface: 'modal' })}
  </Modal>
}

/**
 * Put questions in a dialog for saved Bots while retaining the provider for other Sessions.
 * @param ctx - Team plugin context with composer slot registration.
 * @param directory - Current Bot directory used to match the private Session.
 */
export function installPrivateQuestionComposer(ctx: Pick<Context, 'slots'>, directory: ObservableSnapshot<TeamView>): void {
  ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer', priority: -1, locale: 'katcats.team',
    select: ({ pendingInteraction, sessionId }) => pendingInteraction?.kind === 'question'
      && pendingInteraction.sessionId === sessionId ? pendingInteraction : null,
    inject: () => ({ hooks: { questionDirectory: directory } }),
  }, PrivateQuestionComposer))
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

/** Group dock hosts pending shortcuts and the provider panel's modal. */
export type ChatQuestionsProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'katcats.team'>
  & PropsRenderSlots<'katcats.group.question-panel'> & InjectFace<ChatQuestionsInjected>

/**
 * Display only the selected group's original member questions.
 * @param props - Group directory, question identities and public composer renderer.
 * @returns Member-labelled shortcuts and one foreground question modal.
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
  const requests = questions.flatMap(question => {
    const executor = chat.executors.find(item => item.sessionId === question.pending.sessionId)
    if (executor === undefined) return []
    const target = { ...question, botId: executor.botId, rootSessionId: sessionId }
    return groupQuestionAvailable(target, groups, team) ? [target] : []
  })
  if (requests.length === 0) return null

  return <QuestionQueue key={`${generation}:${sessionId}`} {...props} requests={requests} chat={chat} team={team} />
}

type QuestionControls = Pick<ChatQuestionsProps, 'retainQuestion' | 'revealQuestion' | 'SessionProvider' | 'renderSlot' | 't'>

function QuestionQueue({ requests, chat, team, revealQuestion, t, ...props }: QuestionControls & {
  readonly requests: readonly (GroupQuestionTarget & GroupQuestion)[]
  readonly chat: TeamChat
  readonly team: TeamView
}) {
  const [shelved, setShelved] = useState<readonly PendingQuestion[]>([])
  const [preferred, setPreferred] = useState<PendingQuestion>()
  const [failed, setFailed] = useState<PendingQuestion>()
  const available = requests.filter(request => request.visible && !shelved.includes(request.pending))
  const active = available.find(request => request.pending === preferred) ?? available[0]
  const memberOf = (target: GroupQuestionTarget) => team.snapshot?.bots.find(bot => bot.id === target.botId)
  const nameOf = (target: GroupQuestionTarget): string => memberOf(target)?.name ?? t('team.general')
  const avatarOf = (target: GroupQuestionTarget) => {
    const bot = memberOf(target)
    return bot === undefined ? null : <GroupMemberAvatar appearance={bot.avatar} botId={bot.id} managerId={chat.managerId} size={22}
      managerLabel={t('chat.managerBadge')} />
  }
  const shelve = (pending: PendingQuestion): void => {
    setShelved(current => [...current.filter(item => item !== pending && requests.some(request => request.pending === item)), pending])
  }
  const close = (pending: PendingQuestion): void => {
    if (pending.dismissal === 'hide') void pending.dismiss().catch(() => { shelve(pending) })
    else shelve(pending)
  }
  return <>
    <section className={css.questionQueue} aria-label={t('question.groupRequests')}>
      {requests.map(target => <div key={target.pending.key} className={css.questionRow}
        role="group" aria-label={t('question.memberRequest', { name: nameOf(target) })}>
        {avatarOf(target)}
        <span>{t('question.waitingForMember', { name: nameOf(target) })}</span>
        <Button size="sm" variant="outline" onClick={() => {
          if (!target.visible && !revealQuestion(target)) { setFailed(target.pending); return }
          setFailed(undefined)
          setShelved(current => current.filter(item => item !== target.pending && requests.some(request => request.pending === item)))
          setPreferred(target.pending)
        }}>{t('question.resume')}</Button>
        {failed === target.pending && <p role="alert">{t('question.unavailable')}</p>}
      </div>)}
    </section>
    {active !== undefined && <Modal key={active.pending.key} open headless className={css.questionModal ?? ''}
      title={t('question.memberRequest', { name: nameOf(active) })} onClose={() => { close(active.pending) }}>
      <div className={css.questionModalHeading}>
        {avatarOf(active)}
        <span>{t('question.waitingForMember', { name: nameOf(active) })}</span>
      </div>
      <QuestionPanel {...props} t={t} target={active} />
    </Modal>}
  </>
}

function QuestionPanel({ target, retainQuestion, SessionProvider, renderSlot, t }: Omit<QuestionControls, 'revealQuestion'> & {
  readonly target: GroupQuestionTarget
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
  if (failed) return <p className={css.questionModalStatus} role="alert">{t('question.unavailable')}</p>
  if (reference === undefined) return <div className={css.questionModalStatus} aria-busy="true"><StateDot size={16} state="ongoing" /></div>
  return <SessionProvider session={reference}>{renderSlot('katcats.group.question-panel', { pending })}</SessionProvider>
}
