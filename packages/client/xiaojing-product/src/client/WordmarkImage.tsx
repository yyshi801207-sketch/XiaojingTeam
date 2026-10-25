/** Supplied Katcats.AI wordmark shared by product-owned SVGs. */

import { useId, type ReactNode } from 'react'
import wordmark from './assets/katcats-wordmark.png'

/** Render the supplied raster without its white canvas. */
export function WordmarkImage(): ReactNode {
  const matte = useId()
  return (
    <>
      <defs>
        <filter id={matte} colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 -1 -1 -1 0 3" />
          <feComposite in2="SourceGraphic" operator="in" />
        </filter>
      </defs>
      <image href={wordmark} width="2172" height="724" filter={`url(#${matte})`} />
    </>
  )
}
