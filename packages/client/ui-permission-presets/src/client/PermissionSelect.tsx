import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconChevronDownOutlineRegular, Menu, PermissionIconAutoApprovalRegular, PermissionIconAutoReviewRegular, PermissionIconFullAccessRegular,
  PermissionIconReadOnlyRegular, PermissionIconWorkspaceWriteRegular, RiskConfirmation,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  FactoryComponentPropsOf, HostObservable, InjectFace, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { PermissionCatalog, PresetOption } from '@deepseek-ai/dsh-permission-presets/client'
// Type-only: pulls the conversation-owned permission slot declaration and
// the standard session projection hook into this package's Client face.
import type { InputControlOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PermissionCatalogState } from './catalog.ts'
import { PERMISSION_ACCESS_NS } from './locales.ts'
import {
  AUTO_REVIEW_PRESET as AUTO_REVIEW,
  displayPermissionPreset,
  FULL_ACCESS_PRESET as FULL_ACCESS,
} from './presentation.ts'
import css from './PermissionSelect.module.css'

/** Product-specific, session-only permission identity published by Xiaojing. */
export const NO_APPROVAL_PRESET = 'xiaojing-no-approval'

/* Permission glyphs follow currentColor so the trigger and menu rows tint the
   shared product artwork with their own text color. */

const permissionGlyphs = new Map<string, ReactNode>([
  ['read-only', <PermissionIconReadOnlyRegular />],
  ['workspace-write', <PermissionIconWorkspaceWriteRegular />],
  [FULL_ACCESS, <PermissionIconFullAccessRegular />],
  [NO_APPROVAL_PRESET, <PermissionIconAutoApprovalRegular />],
  [AUTO_REVIEW, <PermissionIconAutoReviewRegular />],
])

/** Glyph for a permission option value; host-configured names outside the design set get none. */
function permissionGlyph(value: string): ReactNode | undefined {
  return permissionGlyphs.get(value)
}

function permissionLabel(
  value: string,
  name: string,
  t: PermissionSelectProps['t'],
): string {
  if (value === AUTO_REVIEW) return t('auto.label')
  if (value === NO_APPROVAL_PRESET) return t('noApproval.label')
  return displayPermissionPreset(value, name, key => t(key))
}

function optionBadge(value: string, t: PermissionSelectProps['t']): string | undefined {
  return value === AUTO_REVIEW ? t('auto.badge') : undefined
}

/** Resolve locale-owned copy for the shipped Auto option; preserve host copy for other presets. */
function optionDescription(
  option: PresetOption,
  t: PermissionSelectProps['t'],
): string | undefined {
  return option.value === NO_APPROVAL_PRESET ? t('noApproval.description')
    : option.value === AUTO_REVIEW ? t('auto.description') : option.description
}

/** Business face injected by the permission package's slot registration. */
export interface PermissionSelectInjected {
  hooks: {
    /** One process catalog shared with the slash popup. */
    permissionCatalog: HostObservable<PermissionCatalogState>
  }
  /** Submit one current-session preset through the existing command writer. */
  select: (preset: string) => Promise<boolean>
}

/** Product-owned targets and result reporting for one explicitly confirmed batch. */
export interface PermissionBatchSelectOwnerProps {
  /** Disable while targets, drafts, visibility or connection state prevent an exact operation. */
  readonly locked: boolean
  /** Common effective preset, or null when the selected Sessions differ. */
  readonly currentValue: string | null
  /** Identity of the exact target bindings and connection generation; changing it discards confirmation. */
  readonly targetKey: string
  /** Number of ready, selected execution Sessions covered by confirmation. */
  readonly targetCount: number
  /** User-visible name of the group receiving the change. */
  readonly targetLabel: string
  /** False when any target is Finance or its preset eligibility is unavailable. */
  readonly allowNoApproval: boolean
  /** Execute once after confirmation; the owner validates targets and reports individual outcomes. */
  readonly onSelect: (preset: string) => Promise<void>
}

/** The batch Factory shares only the permission package's catalog hook. */
export type PermissionBatchSelectInjected = Pick<PermissionSelectInjected, 'hooks'>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    /** Original current-Session permission selector, reusable outside the composer. */
    'permission.select': {
      scope: 'session'
      props: InputControlOwnerProps
      inject: PermissionSelectInjected
      locale: 'permission.access'
    }
    /** Controlled multi-Session picker; the product owns target validation and individual writes. */
    'permission.select-batch': {
      scope: 'root'
      props: PermissionBatchSelectOwnerProps
      inject: PermissionBatchSelectInjected
      locale: 'permission.access'
    }
  }
}

/** Complete props derived from the conversation slot, injected hooks, and locale. */
export type PermissionSelectProps =
  PropsRuntime<'conversation.input.permission'>
  & InjectFace<PermissionSelectInjected>
  & PropsLocale<typeof PERMISSION_ACCESS_NS>

/** Framework-derived root-scope batch picker props, without an implicit Session writer. */
export type PermissionBatchSelectProps = FactoryComponentPropsOf<'permission.select-batch'>

/** Header entry keeps the permission picker reachable when an approval replaces the composer. */
type RunningPermissionProps = PropsRuntime<'conversation.session.header.actions'>
  & InjectFace<PermissionSelectInjected> & PropsLocale<typeof PERMISSION_ACCESS_NS>

/**
 * Render the current-session picker during a Xiaojing task.
 * @param props - session hooks, catalog, and the existing preset command writer.
 * @returns the same picker used by the composer, or no header entry while idle.
 */
export function RunningPermissionSelect(props: RunningPermissionProps) {
  const running = props.useSession(session => session.running)
  const available = props.usePermissionCatalog(state => state.value?.options.some(option => option.value === NO_APPROVAL_PRESET) === true)
  return running && available ? <PermissionSelect {...props} locked={false} /> : null
}

export function PermissionSelect({
  locked, select, usePermissionCatalog, useProjection, t,
}: PermissionSelectProps) {
  const selection = useProjection('permissions')
  const agentPreset = useProjection('agentPreset')
  const catalog = usePermissionCatalog(state => state.value)
  return <PermissionPicker locked={locked} select={select} catalog={catalog} currentValue={selection?.currentValue}
    allowNoApproval={agentPreset !== 'finance'} t={t} />
}

/**
 * Confirm one product-owned batch without acquiring or writing any Session itself.
 * @param props - Exact target identity, common permission state, shared catalog and one owner callback.
 * @returns The shared picker with scope-correct risk copy and mixed-state presentation.
 */
export function PermissionBatchSelect({
  locked, currentValue, targetKey, targetCount, targetLabel, allowNoApproval, onSelect, usePermissionCatalog, t,
}: PermissionBatchSelectProps) {
  const catalog = usePermissionCatalog(state => state.value)
  return <PermissionPicker key={targetKey} locked={locked} currentValue={currentValue} catalog={catalog}
    allowNoApproval={allowNoApproval} select={onSelect} target={{ label: targetLabel, count: targetCount }} t={t} />
}

function PermissionPicker({
  locked, select, catalog, currentValue: selection, allowNoApproval, target, t,
}: {
  readonly locked: boolean
  readonly select: (preset: string) => Promise<boolean | void>
  readonly catalog: PermissionCatalog | null
  readonly currentValue: string | null | undefined
  readonly allowNoApproval: boolean
  readonly target?: { readonly label: string; readonly count: number }
  readonly t: PermissionSelectProps['t']
}) {
  const [pick, setPick] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const pending = useRef<object | null>(null)
  const batch = target !== undefined

  useEffect(() => () => { pending.current = null }, [])
  useEffect(() => {
    if (!batch) return
    setOpen(false)
    setAcknowledged(false)
    setConfirmation(null)
  }, [allowNoApproval, batch, catalog])

  useEffect(() => {
    if (!locked && selection !== undefined && catalog !== null
      && (confirmation === null || catalog.options.some(option => option.value === confirmation)
        && (confirmation !== NO_APPROVAL_PRESET || allowNoApproval))) return
    setOpen(false)
    setAcknowledged(false)
    setConfirmation(null)
  }, [allowNoApproval, catalog, confirmation, locked, selection])

  if (selection === undefined || catalog === null) return null

  const currentValue = pick !== null && catalog.options.some(option => option.value === pick)
    ? pick : selection
  const current = catalog.options.find(option => option.value === currentValue)
  const currentLabel = currentValue === null ? t('batch.mixed') : current === undefined
    ? permissionLabel(currentValue, currentValue, t)
    : permissionLabel(current.value, current.name, t)
  const busy = pick !== null || confirmation !== null

  const items: MenuEntry[] = catalog.options.filter(option => option.value !== NO_APPROVAL_PRESET || allowNoApproval).map((option) => {
    const icon = permissionGlyph(option.value)
    const label = permissionLabel(option.value, option.name, t)
    const badge = optionBadge(option.value, t)
    return {
      id: option.value,
      label: badge === undefined
        ? label
        : (
          <span className={css.optionLabel} aria-label={`${label} ${badge}`}>
            <span className={css.optionLabelText}>{label}</span>
            <span className={css.badge}>{badge}</span>
          </span>
        ),
      ...icon === undefined ? {} : { icon },
    }
  })

  const submit = (id: string): void => {
    if (locked || pending.current !== null) return
    const ticket = {}
    pending.current = ticket
    setPick(id)
    void select(id)
      .catch(() => false)
      .then(() => {
        if (pending.current !== ticket) return
        pending.current = null
        setPick(null)
      })
  }

  const choose = (id: string): void => {
    setOpen(false)
    if (locked || pending.current !== null || !items.some(item => item.id === id)) return
    if (target === undefined && id === selection) return
    if (id === FULL_ACCESS || id === AUTO_REVIEW || id === NO_APPROVAL_PRESET) {
      setAcknowledged(false)
      setConfirmation(id)
      return
    }
    submit(id)
  }

  const closeConfirmation = (): void => {
    setAcknowledged(false)
    setConfirmation(null)
  }

  const confirmSelection = (id: string): void => {
    if (locked || !acknowledged || !items.some(item => item.id === id)) return
    closeConfirmation()
    submit(id)
  }

  const confirmationTitle = confirmation === NO_APPROVAL_PRESET ? t('noApproval.confirm.title') : confirmation === AUTO_REVIEW
    ? t('auto.confirm.title')
    : t('confirm.title')
  const riskDescription = confirmation === NO_APPROVAL_PRESET
    ? t(target === undefined ? 'noApproval.confirm.description' : 'batch.noApproval.description') : confirmation === AUTO_REVIEW
      ? t('auto.confirm.description')
      : t('confirm.description')
  const confirmationDescription = target === undefined ? riskDescription
    : `${t('batch.confirm.scope', { name: target.label, count: target.count })}\n${riskDescription}`
  const confirmationAcknowledge = confirmation === NO_APPROVAL_PRESET
    ? t(target === undefined ? 'noApproval.confirm.acknowledge' : 'batch.noApproval.acknowledge') : confirmation === AUTO_REVIEW
      ? t('auto.confirm.acknowledge')
      : t('confirm.acknowledge')
  const confirmationEnable = confirmation === NO_APPROVAL_PRESET ? t('noApproval.confirm.enable') : confirmation === AUTO_REVIEW
    ? t('auto.confirm.enable')
    : t('confirm.enable')

  return (
    <>
      <Menu
        open={open}
        items={items}
        {...currentValue === null ? {} : { selectedId: currentValue }}
        onSelect={choose}
        onClose={() => { setOpen(false) }}
        side="top"
        portal
        anchor={
          <button
            type="button"
            className={css.trigger}
            aria-label={t(target === undefined ? 'mode' : 'batch.mode', { name: currentLabel })}
            title={current === undefined ? undefined : optionDescription(current, t)}
            disabled={locked || busy}
            onClick={() => { setOpen(!open) }}
          >
            {currentValue !== null && permissionGlyph(currentValue) !== undefined && (
              <span className={css.triggerIcon} aria-hidden>{permissionGlyph(currentValue)}</span>
            )}
            <span className={css.triggerLabel}>{currentLabel}</span>
            <span className={clsx(css.chevron, open && css.chevronOpen)} aria-hidden>
              <IconChevronDownOutlineRegular />
            </span>
          </button>
        }
      />
      {confirmation !== null && (
        <RiskConfirmation
          open
          title={confirmationTitle}
          description={confirmationDescription}
          acknowledgeLabel={confirmationAcknowledge}
          cancelLabel={t('confirm.cancel')}
          closeLabel={t('close')}
          confirmLabel={confirmationEnable}
          acknowledged={acknowledged}
          disabled={locked}
          onAcknowledgedChange={setAcknowledged}
          onCancel={closeConfirmation}
          onConfirm={() => { confirmSelection(confirmation) }}
        />
      )}
    </>
  )
}
