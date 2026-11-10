/** Ten supplied bean Bot avatars with independently selected colors. */
import type { CSSProperties } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import css from './team.module.css'
import motion from './avatar-motion.module.css'
import { AVATAR_COLORS as COLORS } from '../avatar-palette.ts'
import B01 from './assets/bot-avatars/B01.png'
import B02 from './assets/bot-avatars/B02.png'
import B03 from './assets/bot-avatars/B03.png'
import B04 from './assets/bot-avatars/B04.png'
import B05 from './assets/bot-avatars/B05.png'
import B06 from './assets/bot-avatars/B06.png'
import B07 from './assets/bot-avatars/B07.png'
import B08 from './assets/bot-avatars/B08.png'
import B09 from './assets/bot-avatars/B09.png'
import B10 from './assets/bot-avatars/B10.png'

/** Saved appearance IDs mapped to the supplied bean artwork. */
export const CAT_HEADS = [
  { id: 'classic', image: B01 },
  { id: 'round', image: B02 },
  { id: 'point', image: B03 },
  { id: 'tilt', image: B04 },
  { id: 'slim', image: B05 },
  { id: 'layered', image: B06 },
  { id: 'fluffy', image: B07 },
  { id: 'wave', image: B08 },
  { id: 'fold', image: B09 },
  { id: 'ponytail', image: B10 },
] as const

/** Appearance values travel as member data rather than browser-local preferences. */
export interface CatAppearance { shape: string; color: string }

/** Default appearance for newly created members. */
export const DEFAULT_APPEARANCE: CatAppearance = { shape: 'classic', color: '#FF2849' }

/**
 * Draw one member bean avatar, preserving the chosen shape and color independently. The legacy CatAvatar name keeps existing callers compatible.
 * @param props - Saved appearance and requested edge size.
 * @returns A decorative masked bean using the chosen color and inherited head-specific hover motion, respecting reduced motion.
 */
export function CatAvatar({ appearance, size = 32 }: { appearance: CatAppearance; size?: number }) {
  const head = CAT_HEADS.find(candidate => candidate.id === appearance.shape) ?? CAT_HEADS[0]
  return <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" className={[css.avatar, motion.avatar].join(' ')}
    data-head={head.id}
    data-neutral={appearance.color.toLowerCase() === '#202124' ? '' : undefined}
    style={{ '--katcats-avatar-color': appearance.color, '--katcats-avatar-mask': `url("${head.image}")` } as CSSProperties} />
}

/**
 * One small appearance editor shared by quick creation and member settings.
 * @param props - Current appearance, localized labels and explicit draft mutation.
 * @returns Independent shape and color selections.
 */
export function AppearancePicker({ value, onChange, t, disabled = false }: {
  value: CatAppearance
  onChange: (value: CatAppearance) => void
  t: TranslateNS<'katcats.team'>
  disabled?: boolean
}) {
  return <>
    <fieldset className={css.appearanceField} disabled={disabled}>
      <legend>{t('avatar.shape')}</legend>
      <div className={css.shapes}>
        {CAT_HEADS.map(head => <button key={head.id} type="button" className={css.shape}
          aria-label={t(`avatar.${head.id}`)} aria-pressed={value.shape === head.id}
          onClick={() => { onChange({ ...value, shape: head.id }) }}>
          <CatAvatar appearance={{ ...value, shape: head.id }} size={32} />
        </button>)}
      </div>
    </fieldset>
    <fieldset className={css.appearanceField} disabled={disabled}>
      <legend>{t('avatar.color')}</legend>
      <div className={css.colors}>
        {COLORS.map(item => <button key={item.color} type="button" className={css.swatch}
          aria-label={t(item.key)} aria-pressed={value.color.toLowerCase() === item.color.toLowerCase()}
          style={{ '--katcats-avatar-color': item.color } as CSSProperties}
          onClick={() => { onChange({ ...value, color: item.color }) }} />)}
      </div>
    </fieldset>
  </>
}
