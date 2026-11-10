/** A sandboxed renderer receives display data, never credentials or execution capabilities. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { BotId, TeamBot } from '../types.ts'
import type { RoomProjection } from './group-room-model.ts'
import { hqSceneDocument } from './hq-scene.generated.ts'

/**
 * Own the scene iframe, message listener and WebGL lifetime together.
 * @param props - Sanitized display projection and member-selection callback.
 * @returns An isolated scene; failure leaves the surrounding accessible task list intact.
 */
export default function RoomScene({ projection, visitors, cameraTarget, cameraMode, managerId,
  onSelect, onClose, t, frameClassName, errorClassName }: {
  readonly projection: RoomProjection
  readonly visitors: readonly TeamBot[]
  readonly cameraTarget: BotId | null
  readonly cameraMode: 0 | 1 | 2
  readonly managerId: BotId | null
  readonly onSelect: (id: BotId) => void
  readonly onClose: () => void
  readonly t: TranslateNS<'katcats.room'>
  readonly frameClassName: string | undefined
  readonly errorClassName: string | undefined
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const payload = useMemo(() => ({ members: projection.members.map(member => ({ id: member.id, name: member.name,
    role: member.role, color: member.avatar.color, phase: member.phase, label: t(`phase.${member.phase}`),
    manager: member.id === managerId, position: t(member.id === managerId ? 'manager' : 'person.member') })),
  visitors: visitors.map(bot => ({ id: bot.id, name: bot.name, role: bot.role, color: bot.avatar.color,
    label: t('visitor'), position: t('visitor') })),
  cameraTarget, cameraMode,
  links: projection.tasks.filter(task => task.from !== null).map(task => ({ from: task.from, to: task.botId,
    active: task.status === 'queued' || task.status === 'started' })) }), [projection, visitors, cameraTarget, cameraMode, managerId, t])
  const current = useRef({ projection, onSelect, onClose })
  current.current = { projection, onSelect, onClose }
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
      const data: unknown = event.data
      if (typeof data !== 'object' || data === null || !('type' in data)) return
      if (data.type === 'katcats-room-ready') { setReady(true); setFailed(false) }
      else if (data.type === 'katcats-room-error') setFailed(true)
      else if (data.type === 'katcats-room-close') current.current.onClose()
      else if (data.type === 'katcats-room-member' && 'id' in data && typeof data.id === 'string') {
        const member = current.current.projection.members.find(item => item.id === data.id)
        if (member !== undefined) current.current.onSelect(member.id)
      }
    }
    window.addEventListener('message', receive)
    return () => { window.removeEventListener('message', receive) }
  }, [])
  useEffect(() => {
    if (ready) frame.current?.contentWindow?.postMessage({ type: 'katcats-room-state', payload }, '*')
  }, [ready, payload])
  return <>
    <iframe ref={frame} title={t('scene')} className={frameClassName} sandbox="allow-scripts" srcDoc={hqSceneDocument} />
    {failed && <p className={errorClassName} role="alert">{t('sceneFailed')}</p>}
  </>
}
