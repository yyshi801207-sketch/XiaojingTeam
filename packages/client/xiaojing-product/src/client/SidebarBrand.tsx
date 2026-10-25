/** Xiaojing sidebar brand occupants. */

import type { ReactNode } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { XiaojingProductKey } from './locales.ts'
import wordmark from './assets/sudo-wordmark.png'
import css from './SidebarBrand.module.css'

/** Product copy injected into the sidebar name. */
export interface SidebarBrandInjected {
  t: (key: XiaojingProductKey) => string
}

/** Fit the supplied SUDO wordmark into the collapsed navigation rail without cropping its content. */
export function SidebarBrandMark({ size }: PropsRuntime<'sidebar.brand.mark'>): ReactNode {
  return (
    <svg className={css.avatar} width={size} height={size} viewBox="35 59 2106 645" aria-hidden="true">
      <image href={wordmark} width="2172" height="724" preserveAspectRatio="xMidYMid meet" />
    </svg>
  )
}

/** Render the supplied SUDO wordmark, trimming only the transparent canvas margin. */
export function SidebarBrandName(
  { t }: PropsRuntime<'sidebar.brand.name'> & InjectFace<SidebarBrandInjected>,
): ReactNode {
  return (
    <span className={css.name}>
      <svg className={css.wordmark} viewBox="35 59 2106 645" role="img" aria-label={t('sidebarBrandAlt')}>
        <image href={wordmark} width="2172" height="724" preserveAspectRatio="xMidYMid meet" />
      </svg>
    </span>
  )
}
