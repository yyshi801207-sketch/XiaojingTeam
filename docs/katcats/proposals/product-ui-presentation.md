# Product UI presentation proposal

English | [中文](product-ui-presentation.zh.md)

## Status and verified limits

This reference records the reviewed [base patch](product-ui-presentation.patch) for product-neutral sidebar, right-panel and composer presentation. The user authorized this API exception, and it is applied in the independent copy with optional-schema, default-call compatibility and Host-to-Client configuration fixes. The base patch contains no Katcats branding or product consumer; the current owner source and package READMEs describe the implemented APIs. The patch is a review record and must not be reapplied over the implementation.

The [locale registry](../../../packages/client/locale/src/client/index.ts) rejects a second registration for the same namespace and locale; it provides no safe per-key override. The [sidebar shell](../../../packages/client/ui-sidebar/src/client/SidebarRoot.tsx) owns the New Session label and the order of footer actions, panel navigation and Settings, so product slot order cannot make the requested changes. The [layout store](../../../packages/client/ui-layout/src/client/stores.ts) has one transient right-panel width, initialized from the existing 45% preference. The [conversation body](../../../packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx) owns the empty-state workspace selector and default hints; replacing a preset contribution alone cannot hide that selector.

## Proposed extension points

All new public options are optional. Omitting them preserves the current labels, panel navigation, footer order, width preference, composer hints and empty-state row. The patch updates the owning implementations and their internal injected sources; it does not replace the shell, editor or private components from another feature.

| Owner | Optional API | Product outcome | Omitted behavior |
| --- | --- | --- | --- |
| `ui-sidebar` Config | `primaryActionLabel` | Product-localized primary create label | Existing New Session copy |
| `ui-sidebar` Config | `panelNavigation: { label, defaultExpanded? }` | Fold existing global panel rows under one heading | Existing ungrouped rows |
| `ui-sidebar` Config | `footerActionsPlacement: 'after-panels'` | Place existing usage/footer actions below panel navigation | Existing actions-before-panels order |
| `sidebarRightTabs.register` definition | `initialWidth: 'minimum'` | Start this provider at the existing minimum; remember its manual width during this run | Existing 45% preference and manual width |
| `ctx.composerPresentation` | `register(sessionId, observable)` | Session-addressed `defaultPlaceholder` and `hideWorkspaceRow` | Standard composer presentation |

### Sidebar configuration

The label maps require a nonblank English `en` fallback and accept other localized labels; the existing locale service resolves them and refreshes mounted copy after a language change. The primary option changes the visible label, accessible name and tooltip together. It does not change the command identifier, shortcut, icon or create callback, and it does not rename unrelated command-menu entries.

The optional panel heading uses the existing panel rows, icons, selected state and navigation callback. `defaultExpanded` defaults to `true`; the product can explicitly choose `false`. The shell retains the user's subsequent toggle while mounted, and a locale change does not reset it. The narrow rail retains its existing navigation icons. The optional footer placement moves the existing action slot as a whole; Settings stays last. The fold is a keyboard-operable button with `aria-expanded` and `aria-controls`.

The sidebar package exports its Config schema on Host and Client and declares its direct Schemastery dependency. The Host publishes only public presentation fields through `webserver/index-inject` as the `__DSH_SIDEBAR_PRESENTATION__` global. The Client reads and validates that bootstrap before mounting; its activation metadata does not transport Host configuration. Missing bootstrap retains the standard sidebar. An omitted `panelNavigation` remains absent despite Schemastery's object default; it must not manufacture an unlabeled fold. Missing English or blank configured labels fail configuration validation. No locale namespace is replaced or mutated by a consumer.

### Right-panel width

The [tab definition](../../../packages/client/ui-sidebar-right/src/client/tab-registry.ts) gains `initialWidth?: 'minimum'`. The right-panel owner reports the active docked provider's identity through the existing presentation callback and an optional third `layout.openRightbar` argument. The layout owns one transient width preference per opted-in provider, starts it at `RIGHTBAR_MIN` (currently 300 px), and updates it through the original resize path. It preserves that manual preference across closing, Session changes and later openings during the same application run. Two settings providers have separate preferences; all Sessions using one provider share its preference.

Providers that omit the option keep the existing ordinary width preference, including its first-open 45% behavior. Opted-in settings do not overwrite that preference. The current minimum/maximum constraints, narrow-screen fullscreen behavior and drag handle remain authoritative. Width hints neither enter a persisted layout record nor change a Session or settings format. The product later opts its Bot and group settings providers in explicitly; this patch contains no such consumer edits.

### Session composer presentation

The Conversation plugin provides `ctx.composerPresentation.register(sessionId, source)`, where `source` is an `ObservableSnapshot` of localized display defaults. The caller registers through `ctx.effect` and owns the returned idempotent disposer. One provider may own a Session; a duplicate throws. Live source updates refresh that Session's retained composers. Disposal restores the standard presentation, unsubscribes the source and prevents queued old notifications from restoring an obsolete override. Plugin unload releases all sources.

`defaultPlaceholder` is an ordinary hint, subordinate to the existing workspace prerequisite, explicit block, connection/unavailable, queue and plan hints. It does not enable input or change submit, model, tool or permission behavior. `hideWorkspaceRow: true` hides the complete empty-state workspace/preset/context/options row only when a real Session already satisfies the existing workspace prerequisite; otherwise that row remains available for recovery. Attachments, permission controls and model selection in the original input bar stay mounted. Product code may also use the existing `conversation.hero.agentPreset` slot when only preset presentation needs customization; no new preset-specific API is proposed.

The product later registers by the exact private-chat or group-transcript Session ID and publishes its own typed localized placeholder. The service does not read a global selected Session, modify working directories, grant filesystem access, change durable Session data or add model-visible input. The patch has no Agent-loop, Host wire, credential or public SDK change.

## Required verification after authorization

1. Sidebar tests: zero-config behavior; localized visible/accessible/tooltip copy; missing English and blank label rejection; omitted nested configuration; fold default and keyboard toggle; language-change stability; narrow-rail navigation; both footer orders with Settings retained.
2. Right-panel tests: opted-in first-open minimum; resizing and reopen; switching between opted-in providers, Sessions and ordinary tabs; ordinary first-open 45%; registry removal; fullscreen, split/floating focus and viewport clamp; no persisted width fields.
3. Composer tests: exact Session isolation; live updates; duplicate registration; idempotent removal; a queued old notification after removal or replacement; plugin disposal; retained composer updates; hero and established conversations; workspace/block/offline/unavailable/queue/plan hint precedence; recovery controls retained when prerequisites fail.
4. Update existing internal hook fixtures and public API/package documentation, then run focused behavior tests, Client type checks and required API/documentation checks. After the reviewed source is authorized and applied, complete `build:artifacts` and `build:check` before claiming implementation completion. Any discovered failing consumer belongs in that implementation change.
5. Product integration uses its existing create callback, original panel registrations, Bot/group tab definitions and Session-owned presentation snapshots. A fresh independent preview must verify the original editor, attachment/permission/model controls, keyboard focus, light/dark themes and manual resize behavior with an external Mock model; no installed product or real user data is used.

## Proposal checks

Before authorized application, `cmd /c "git apply --check --whitespace=error docs\katcats\proposals\product-ui-presentation.patch"` succeeded in the independent `E:\Projects\Katcats.AI` copy. With the Host-to-Client bootstrap implemented, `cmd /c "node run\tmp\presentation-api-buildcheck-tests.mjs"` passed 419 focused tests, recorded in `run/tmp/presentation-api-buildcheck-1792848285852.json`. The five bridge source/test files pass lint; all four owner README pairs and this proposal pair are consistent. The coordinating agent owns final artifacts/build checks and independent preview verification; neither is claimed here.
