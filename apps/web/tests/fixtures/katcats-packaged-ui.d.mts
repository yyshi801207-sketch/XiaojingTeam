/** Browser evidence from the real packaged Host; no model messages are sent. */
export interface PackagedKatcatsUiResult {
  readonly passed: true
  readonly modelCalls: 0
}

/**
 * Capture this serial smoke's stdout with synthetic login credentials redacted.
 * @returns the mandatory restore callback.
 */
export function redactPackagedSmokeOutput(): () => void

/**
 * Exercise a fresh browser and the original Bot/group creation UI against the provided own Host.
 * @param options - own Host and browser paths plus credential-free environment.
 * @returns evidence after all UI checks pass.
 */
export function verifyPackagedKatcatsBrowser(options: {
  readonly loginUrl: string
  readonly directory: string
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly electron: string
}): Promise<PackagedKatcatsUiResult>
