/** Team publication stays disabled until a product-owned destination is configured. */

/** Local diagnostic shared by upload and publication entry points. */
export const TEAM_PUBLICATION_UNAVAILABLE = 'Team发布目标尚未配置'

/** Refuse publication before reading inherited credentials or starting network operations. */
export function assertTeamPublicationConfigured(): void {
  throw new Error(TEAM_PUBLICATION_UNAVAILABLE)
}
