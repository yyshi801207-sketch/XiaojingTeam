/** Client-owned presentation options validate without changing the zero-configuration sidebar. */
import { describe, expect, it } from 'vitest'
import { Config } from '@deepseek-ai/dsh-client-ui-sidebar'

describe('sidebar presentation Config', () => {
  it('keeps every display option absent by default', () => {
    expect(Config({})).toEqual({})
  })

  it('accepts localized labels and an explicit initially collapsed panel group', () => {
    const input = { primaryActionLabel: { en: 'Create helper', zh: '创建助手' },
      panelNavigation: { label: { en: 'More', zh: '更多' }, defaultExpanded: false },
      footerActionsPlacement: 'after-panels' as const }
    expect(Config(input)).toEqual(input)
  })

  it.each([
    { primaryActionLabel: { zh: '缺少英文' } },
    { primaryActionLabel: { en: ' ' } },
    { panelNavigation: {} },
    { panelNavigation: { label: { en: 'More', zh: '\t' } } },
    { footerActionsPlacement: 'elsewhere' },
  ])('rejects invalid presentation configuration %j', (input) => {
    expect(() => Config(input as never)).toThrow()
  })
})
