/**
 * Plugin artwork on a 36×36 canvas. Configuration glyphs use adaptive gray;
 * the default retains its gradient.
 */
import { useId } from 'react'
import type { IconProps } from './icons/props.ts'

const ARTWORK_INK = 'light-dark(#62666f,#b9bdc6)'

/**
 * A per-instance SVG def id prefix: the artwork repeats across cards and rows,
 * and duplicate document ids would make every `url(#…)` resolve to the first instance.
 */
const useArtworkId = (): string => `dsh_plugin_art_${useId().replaceAll(':', '')}`

/** Terminal window and prompt, also used in sidebar guide entries. */
export const PluginArtworkTerminal = ({ size = 36, className }: IconProps) => (
  <svg width={size} height={size} className={className} color={ARTWORK_INK} aria-hidden="true" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
    <rect x="5.2" y="7.7" width="25.6" height="20.6" rx="4.2" strokeWidth="2.2" />
    <path d="M5.8 13.4H30.2" strokeWidth="2" />
    <circle cx="10" cy="10.6" r="1" fill="currentColor" stroke="none" />
    <path d="M10.7 18.1L14.5 21.7L10.7 25.3M18 25.3H24" strokeWidth="2.3" />
  </svg>
)

/** Two dispatch arrows surround the active step in the agent loop. */
export const PluginArtworkLoop = ({ size = 36, className }: IconProps) => (
  <svg width={size} height={size} className={className} color={ARTWORK_INK} aria-hidden="true" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg" strokeLinecap="round" strokeLinejoin="round">
    <g stroke="currentColor" strokeWidth="2.4">
      <path d="M7.2 13.7A11.3 11.3 0 0 1 28 11.3M23.8 11.3H28V7.1" />
      <path d="M28.8 22.3A11.3 11.3 0 0 1 8 24.7M12.2 24.7H8V28.9" />
    </g>
    <circle cx="18" cy="18" r="4.8" stroke="currentColor" strokeWidth="2.1" />
    <circle cx="18" cy="18" r="1.7" fill="currentColor" />
  </svg>
)

/** A parent agent delegates to two task nodes; also supplies missing bundle-row artwork. */
export const PluginArtworkSubagent = ({ size = 36, className }: IconProps) => (
  <svg width={size} height={size} className={className} color={ARTWORK_INK} aria-hidden="true" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M18 14.1V19.7M10.7 23.6V19.7H25.3V23.6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <rect x="13.2" y="5.6" width="9.6" height="8.5" rx="2.8" fill="currentColor" />
    <rect x="6" y="23.6" width="9.4" height="7" rx="2.4" fill="currentColor" />
    <rect x="20.6" y="23.6" width="9.4" height="7" rx="2.4" fill="currentColor" />
  </svg>
)

/** Search lens over two result lines. */
export const PluginArtworkSearch = ({ size = 36, className }: IconProps) => (
  <svg width={size} height={size} className={className} color={ARTWORK_INK} aria-hidden="true" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" strokeLinecap="round">
    <circle cx="15.5" cy="15.3" r="9.5" strokeWidth="2.7" />
    <path d="M11.4 13.5H19M11.4 17.4H16.8" strokeWidth="1.8" />
    <path d="M22.6 22.4L29 28.8" strokeWidth="3.2" />
  </svg>
)

/** Default plugin artwork for plugins without one of their own (connector blocks and a node). */
export const PluginArtworkDefault = ({ size = 36, className }: IconProps) => {
  const uid = useArtworkId()
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M24.6294 8.63696C26.2862 8.63705 27.6294 9.98016 27.6294 11.637V12.7825C27.6292 14.4391 26.2861 15.7824 24.6294 15.7825H23.4839C22.6519 15.7825 21.5454 16.3459 21.5454 17.1778V18.1573C21.5454 18.7757 22.216 19.1966 22.8345 19.1965H24.6294C26.2861 19.1965 27.6292 20.5398 27.6294 22.1965V23.9924C27.6292 25.6491 26.2861 26.9924 24.6294 26.9924H22.8345C21.1778 26.9924 19.8347 25.649 19.8345 23.9924V22.1965C19.8345 21.7148 19.4957 21.2327 19.014 21.2327H16.4792C15.7975 21.2327 15.3374 22.0061 15.3374 22.6877V23.8333C15.3373 25.49 13.9942 26.8333 12.3374 26.8333H11.1919C9.53509 26.8333 8.19198 25.49 8.19189 23.8333V22.6877C8.19189 21.0309 9.53504 19.6877 11.1919 19.6877H12.3374C13.1964 19.6877 14.3999 19.0959 14.3999 18.2369V16.0185C14.3999 14.9518 15.2646 14.0872 16.3312 14.0872H19.435C20.0596 14.0872 20.484 13.4071 20.4839 12.7825V11.637C20.4839 9.98011 21.827 8.63696 23.4839 8.63696H24.6294ZM13.4116 11.2468C13.4116 12.6882 12.2431 13.8567 10.8018 13.8567C9.36037 13.8567 8.19189 12.6882 8.19189 11.2468C8.19189 9.80544 9.36037 8.63696 10.8018 8.63696C12.2431 8.63696 13.4116 9.80544 13.4116 11.2468Z" fill={`url(#${uid}a)`} />
      <defs>
        <linearGradient id={`${uid}a`} x1="15.1481" y1="9.94188" x2="15.1481" y2="13.6375" gradientUnits="userSpaceOnUse">
          <stop stopColor="#54ECE7" />
          <stop offset="1" stopColor="#658EFF" />
        </linearGradient>
      </defs>
    </svg>
  )
}
