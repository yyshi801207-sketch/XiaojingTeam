/** Xiaojing sidebar brand occupants. */

import type { ReactNode } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { XiaojingProductKey } from './locales.ts'
import { WordmarkImage } from './WordmarkImage.tsx'
import css from './SidebarBrand.module.css'

/** Product copy injected into the sidebar name. */
export interface SidebarBrandInjected {
  t: (key: XiaojingProductKey) => string
}

/** Render the wordmark's K in the collapsed navigation rail. */
export function SidebarBrandMark({ size }: PropsRuntime<'sidebar.brand.mark'>): ReactNode {
  return (
    <svg className={css.avatar} width={size} height={size} viewBox="68 132 380 400" aria-hidden="true">
      <WordmarkImage />
    </svg>
  )
}

/** Render the supplied Katcats.AI wordmark without its outer canvas margin. */
export function SidebarBrandName(
  { t }: PropsRuntime<'sidebar.brand.name'> & InjectFace<SidebarBrandInjected>,
): ReactNode {
  return (
    <span className={css.name}>
      <svg className={css.wordmark} viewBox="68 132 2040 400" role="img" aria-label={t('sidebarBrandAlt')}>
        <WordmarkImage />
      </svg>
    </span>
  )
}
