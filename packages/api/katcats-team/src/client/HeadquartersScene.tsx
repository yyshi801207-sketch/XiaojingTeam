/** Isolated global HQ renderer; it receives display fields only. */
import { useEffect, useRef, useState } from 'react'
import type { ChatId } from '../chats-types.ts'
import type { BotId } from '../types.ts'
import { hqSceneDocument } from './headquarters-scene.generated.ts'

/** One appearance belongs to a group instance or the independent main/private session. */
export interface HeadquartersPerson {
  readonly id: BotId
  readonly name: string
  readonly role: string
  readonly color: string
  readonly position: string
  readonly phase: string
  readonly label: string
  readonly manager: boolean
}

/** Sanitized state passed into the sandboxed WebGL document. */
export interface HeadquartersSceneState {
  readonly groups: readonly {
    readonly id: ChatId
    readonly name: string
    readonly slot: number
    readonly color: string
    readonly caption: string
    readonly members: readonly HeadquartersPerson[]
    readonly links: readonly { readonly from: BotId | null; readonly to: BotId; readonly active: boolean }[]
  }[]
  readonly main: HeadquartersPerson | null
  readonly independent: readonly HeadquartersPerson[]
  readonly selected: ChatId | null
  readonly focus: ChatId | null
  readonly cameraMode: 0 | 1 | 2
}

/**
 * Mount one floor's native furniture, with a distinct character for each group membership.
 * @param props - Display-only state, localized labels and validated selection callbacks.
 * @returns Sandboxed scene with an explicit renderer failure notice.
 */
export default function HeadquartersScene({ state, title, failure, onSelect, onClose, className }: {
  readonly state: HeadquartersSceneState
  readonly title: string
  readonly failure: string
  readonly onSelect: (id: ChatId | null, botId?: BotId) => void
  readonly onClose: () => void
  readonly className: string | undefined
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const current = useRef({ state, onSelect, onClose })
  current.current = { state, onSelect, onClose }
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
      const data: unknown = event.data
      if (typeof data !== 'object' || data === null || !('type' in data)) return
      if (data.type === 'headquarters-ready') setReady(true)
      else if (data.type === 'katcats-room-error') setFailed(true)
      else if (data.type === 'katcats-room-close') current.current.onClose()
      else if (data.type === 'headquarters-select' && 'id' in data) {
        const group = current.current.state.groups.find(item => item.id === data.id)
        if (group) current.current.onSelect(group.id)
        else if (data.id === null && 'botId' in data) {
          const bot = [current.current.state.main, ...current.current.state.independent].find(item => item?.id === data.botId)
          if (bot) current.current.onSelect(null, bot.id)
        }
      }
    }
    window.addEventListener('message', receive)
    return () => { window.removeEventListener('message', receive) }
  }, [])
  useEffect(() => {
    if (ready) frame.current?.contentWindow?.postMessage({ type: 'headquarters-state', payload: state }, '*')
  }, [ready, state])
  return <><iframe ref={frame} title={title} className={className} sandbox="allow-scripts" srcDoc={hqSceneDocument} />
    {failed && <p role="alert">{failure}</p>}</>
}
