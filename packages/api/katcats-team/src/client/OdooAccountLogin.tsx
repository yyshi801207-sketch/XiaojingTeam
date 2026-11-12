/** Shared Odoo login and operation-mode display for finance cards. */
import type { FinanceOrmAccessMode } from '../finance-types.ts'
import bindingCss from './finance-binding.module.css'
import teamCss from './team.module.css'

/**
 * Render the last verified login and the configured access mode in a details list.
 * @param props - Optional login, configured access mode and localized labels.
 * @returns The account value and mode badge.
 */
export function OdooAccountLogin({ login, accessMode, t }: {
  readonly login: string | undefined
  readonly accessMode: FinanceOrmAccessMode | undefined
  readonly t: (key: 'odoo.notVerified' | 'odoo.readOnly' | 'odoo.readWrite') => string
}) {
  return <dd className={bindingCss.accountLogin}>
    <bdi>{login ?? t('odoo.notVerified')}</bdi>
    <small className={teamCss.mainBadge} data-finance-access={accessMode ?? 'read-only'}>
      {t(accessMode === 'full' ? 'odoo.readWrite' : 'odoo.readOnly')}
    </small>
  </dd>
}
