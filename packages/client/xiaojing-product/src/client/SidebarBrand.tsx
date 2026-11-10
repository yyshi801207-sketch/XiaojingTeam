/** Xiaojing sidebar brand occupants. */

import type { ReactNode } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { XiaojingProductKey } from './locales.ts'
import darkWordmark from './assets/sudo-wordmark.png'
import lightWordmark from './assets/sudo-wordmark-light.png'
import css from './SidebarBrand.module.css'

/** Product copy injected into the sidebar name. */
export interface SidebarBrandInjected {
  t: (key: XiaojingProductKey) => string
}

/** Show the bean emblem from the supplied SUDO wordmark in the collapsed rail. */
export function SidebarBrandMark({ size }: PropsRuntime<'sidebar.brand.mark'>): ReactNode {
  return (
    <>
      <svg className={[css.avatar, css.wordmarkLight].join(' ')} width={size} height={size}
        viewBox="635 110 295 310" aria-hidden="true">
        <image href={lightWordmark} width="1600" height="520" preserveAspectRatio="xMidYMid meet" />
      </svg>
      <svg className={[css.avatar, css.wordmarkDark].join(' ')} width={size} height={size}
        viewBox="835 150 360 420" aria-hidden="true">
        <image href={darkWordmark} width="2202" height="714" preserveAspectRatio="xMidYMid meet" />
      </svg>
    </>
  )
}

/** Render the supplied SUDO wordmark and localized tagline in the expanded rail. */
export function SidebarBrandName(
  { t }: PropsRuntime<'sidebar.brand.name'> & InjectFace<SidebarBrandInjected>,
): ReactNode {
  return (
    <span className={css.name}>
      <svg className={[css.wordmark, css.wordmarkLight].join(' ')} viewBox="20 110 1560 300" preserveAspectRatio="xMinYMid meet"
        role="img" aria-label={t('sidebarBrandAlt')}>
        <image href={lightWordmark} width="1600" height="520" preserveAspectRatio="xMidYMid meet" />
      </svg>
      <svg className={[css.wordmark, css.wordmarkDark].join(' ')} viewBox="25 145 2150 420" preserveAspectRatio="xMinYMid meet"
        role="img" aria-label={t('sidebarBrandAlt')}>
        <image href={darkWordmark} width="2202" height="714" preserveAspectRatio="xMidYMid meet" />
      </svg>
      <span className={css.tagline}>{t('sidebarBrandTagline')}</span>
    </span>
  )
}
