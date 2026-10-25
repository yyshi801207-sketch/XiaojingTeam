/** Optional product-neutral presentation for the shared sidebar. */
import z from '@deepseek-ai/schemastery'

/** Locale-owned labels; lowercase locale ids include the required English fallback. */
export type SidebarLabel = {
  /** English fallback used when the active locale has no label. */
  readonly en: string
  readonly [locale: string]: string
}

/** Optional presentation only; navigation and panel registrations remain unchanged. */
export interface Config {
  /** Replaces the New Session button's visible and accessible label. */
  primaryActionLabel?: SidebarLabel
  /** Adds an expandable group around the registered global panel rows. */
  panelNavigation?: {
    /** Localized heading for the expandable global panel group. */
    label: SidebarLabel
    /** Initial expansion state before the user toggles the panel group. */
    defaultExpanded?: boolean
  }
  /** Placement of existing footer actions relative to global panel rows. */
  footerActionsPlacement?: 'before-panels' | 'after-panels'
}

const labelSchema = (): z<SidebarLabel> => z.union([z.intersect([
  z.object({ en: z.string().pattern(/\S/).required() }),
  z.dict(z.string().pattern(/\S/)),
])])

/** Validate optional presentation at the configuration boundary. */
export const Config: z<Config> = z.object({
  primaryActionLabel: labelSchema(),
  // An omitted object must stay absent rather than acquire Schemastery's empty-object default.
  panelNavigation: z.union([z.object({ label: labelSchema().required(), defaultExpanded: z.boolean() })]),
  footerActionsPlacement: z.union(['before-panels', 'after-panels']),
})

/** Page-bootstrap key carrying only the public sidebar presentation options. */
export const SIDEBAR_PRESENTATION_GLOBAL = '__DSH_SIDEBAR_PRESENTATION__'
