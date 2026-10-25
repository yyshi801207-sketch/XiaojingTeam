/** Soft, solid financial robot silhouettes with independently selected colors. */
import type { CSSProperties } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import css from './team.module.css'
import motion from './avatar-motion.module.css'

/** Robot silhouettes keyed by the existing persisted avatar identifiers. The legacy export name is retained for callers. */
export const CAT_HEADS = [
  { id: 'classic', path: 'M29 16C29 13 29 12 28 11C24 8 27 3 32 3C37 3 40 8 36 11C35 12 35 13 35 16C46 16 53 21 54 29C61 29 62 33 62 38C62 43 59 46 54 46C52 55 45 59 32 59C19 59 12 55 10 46C5 46 2 43 2 38C2 33 3 29 10 29C11 21 18 16 29 16Z' },
  { id: 'round', path: 'M28 15C28 13 28 12 27 10C24 6 27 2 32 2C37 2 40 6 37 10C36 12 36 13 36 15C47 17 53 24 53 32C60 32 61 37 60 41C59 45 56 47 52 47C49 56 42 61 32 61C22 61 15 56 12 47C8 47 5 45 4 41C3 37 4 32 11 32C11 24 17 17 28 15Z' },
  { id: 'point', path: 'M25 17C24 14 22 13 20 12C15 10 16 4 20 4C24 4 27 8 25 11C27 13 28 15 29 16C41 14 51 19 55 29C61 30 63 34 62 39C62 43 60 46 55 46C51 55 43 60 31 60C19 60 11 57 8 49C3 48 1 44 2 39C3 34 6 33 10 34C12 25 17 20 25 17Z' },
  { id: 'fold', path: 'M40 20C40 17 41 15 42 13C38 10 40 5 45 5C50 5 53 10 49 13C47 15 47 17 47 20C54 22 58 26 58 31C64 32 65 36 63 40C62 44 59 46 55 46C50 53 41 56 29 55C17 54 9 51 7 44C1 43 0 39 2 35C3 31 6 30 9 30C13 22 24 18 40 20Z' },
  { id: 'tilt', path: 'M31 18C30 15 29 13 27 12C23 11 23 6 27 4C31 2 35 6 33 10C35 12 36 13 37 16C47 13 55 17 57 26C62 25 65 29 63 34C62 39 59 41 56 42C55 51 48 57 36 60C24 63 14 60 11 51C5 53 1 50 2 45C3 40 6 37 10 37C10 27 17 21 31 18Z' },
  { id: 'fluffy', path: 'M28 16C27 13 27 12 26 10C23 6 27 2 31 3C36 3 38 7 35 11C34 13 34 14 34 16C42 10 50 15 51 23C59 20 64 27 60 35C65 41 60 49 53 49C51 59 42 61 35 57C28 63 18 60 16 53C6 55 0 48 4 40C0 32 5 25 13 26C15 17 21 13 28 16Z' },
  { id: 'slim', path: 'M29 15C29 12 28 11 27 10C24 7 27 3 31 3C36 3 39 7 36 10C35 11 35 12 35 15C44 17 48 23 48 30C54 30 57 34 56 39C56 43 53 46 48 46C47 56 41 62 32 62C23 62 17 56 16 46C11 46 8 43 8 39C7 34 10 30 16 30C16 23 20 17 29 15Z' },
] as const

/** Appearance values travel as member data rather than browser-local preferences. */
export interface CatAppearance { shape: string; color: string }

/** Default appearance for newly created members. */
export const DEFAULT_APPEARANCE: CatAppearance = { shape: 'classic', color: '#FF2849' }

const COLORS = [
  { color: '#202124', key: 'color.graphite' }, { color: '#FF2849', key: 'color.red' },
  { color: '#FF6B0B', key: 'color.orange' }, { color: '#10C477', key: 'color.green' },
  { color: '#2288FF', key: 'color.blue' }, { color: '#9253FF', key: 'color.purple' },
  { color: '#F52C93', key: 'color.pink' }, { color: '#10B8A6', key: 'color.teal' },
] as const

/**
 * Draw one robot head, preserving the chosen shape and color independently. The legacy CatAvatar name keeps existing callers compatible.
 * @param props - Saved appearance and requested edge size.
 * @returns A decorative SVG using the chosen color and inherited head-specific hover motion, respecting reduced motion.
 */
export function CatAvatar({ appearance, size = 32 }: { appearance: CatAppearance; size?: number }) {
  const head = CAT_HEADS.find(candidate => candidate.id === appearance.shape) ?? CAT_HEADS[0]
  return <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" className={[css.avatar, motion.avatar].join(' ')}
    data-head={head.id}
    data-neutral={appearance.color.toLowerCase() === '#202124' ? '' : undefined}
    style={{ '--katcats-avatar-color': appearance.color } as CSSProperties}>
    <path d={head.path} />
  </svg>
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
