# Reusable current-Session permission picker

English | [中文](permission-picker-factory.zh.md)

## Approved scope

The user authorized this narrow DSH API exception in the independent Katcats copy. The public `ui-permission-presets/client` entry exposes the Session-scoped `permission.select` Component Factory. Products render it with `renderFactorySlot('permission.select', { locked })` through the public renderer; they do not import its private component or redeclare the composer's permission slot. The [owning package reference](../../../packages/client/ui-permission-presets/README.md) describes the API.

The Factory reuses the original selector, shared process catalog and current-Session `/permission <preset>` writer. Existing options, risk acknowledgement, cancellation, catalog withdrawal and failure handling remain authoritative. `locked` disables interaction and closes pending confirmation. Selection takes effect immediately through the existing command after any required acknowledgement; it is independent of a surrounding form's Save button. Original composer, slash-command and future-default settings behavior is retained. This exception adds no Host API, permission policy, durable field or authorization bypass.

The user's subsequent explicit request for one group-wide selection extends the approved UI scope with the root-scoped `permission.select-batch` Factory. It reuses the existing permission menu and risk confirmation, names the group and member count, and calls one product-owned callback after acknowledgement. Its controlled target identity and eligibility invalidate stale confirmation. This extends only the public UI Factory; it does not authorize a new backend permission API, policy, persistent group default or bypass of the original risk gate.

## Product Session ownership

Bot settings use their current private-chat Session. Group settings retain each current ordinary member's exact executor Session from that group, await its `SessionReference.ready`, and render under the public `SessionProvider`. They release the reference when hidden, removed, unavailable or disposed. Neither the group transcript root nor a member's private-chat Session substitutes for a group executor.

Acquisition requires a connected client and ready current Bot and group directories; membership and executor identity are rechecked before retaining. Missing projection or catalog does not enable a selector. An individual choice affects only its bound Session. The batch callback validates the exact saved member/executor set and uses the existing public command API separately for each Session, inspecting the command result rather than merely matching its name. Unsaved settings, unavailable targets, hiding or disconnecting prevent a new batch. Successful, failed, unexecuted and uncertain members are reported separately; cancellation after dispatch does not promise rollback. No persistent group-wide permission policy is added.

## Isolated verification

The [Factory tests](../../../packages/client/ui-permission-presets/tests/permission-factory.client.spec.tsx) use the real SlotRegistry and Session renderer with synthetic retained Sessions. They cover shared catalog/projection, exact-Session writes, Session switching, risk acknowledgement and cancellation, withdrawn options, command rejection, locked/unavailable states and plugin teardown. The owner package's 47 focused tests passed; after the final test-type correction the eight Factory tests passed again, with the package Client type check, three-file lint and bilingual README checks passing. This record does not claim final repository build or browser verification; those belong to the coordinating integration checks. No real user data, credentials or installed application are used.

The [batch Factory tests](../../../packages/client/ui-permission-presets/tests/permission-batch-factory.client.spec.tsx) render through the same real root Factory registry without a Session provider. They cover one owner callback per confirmed selection, all three risk gates, complete bilingual scope-copy snapshots, mixed values, changed targets, locking, hidden controls, catalog changes, Finance eligibility, pending or rejected callbacks and teardown. The Factory itself calls no Session command; product-level verification owns exact executor writes and partial outcomes.
