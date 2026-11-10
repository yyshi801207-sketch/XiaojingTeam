/** Public model-control options shared by the Host and browser halves. */
import z from '@deepseek-ai/schemastery'

/** Model-control options after schema defaults are applied. */
export interface Config {
  /** Register the /model command and composer model selector. */
  controlsEnabled: boolean
}

/** Validate Host configuration and the public page-bootstrap payload. */
export const Config: z<Partial<Config>, Config> = z.object({
  controlsEnabled: z.boolean().default(true),
})

/** Page-global key carrying the public model-control options. */
export const MODEL_SELECTION_CONFIG_GLOBAL = '__DSH_MODEL_SELECTION__'
