---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-25-katcats-group-task-lifecycle

English | [中文](2026-10-25-katcats-group-task-lifecycle.zh.md)

## Summary

Adds the product-owned katcats/group-task-lifecycle log event for a durably admitted group task and its observed state, with stable identifiers, recorded participants and recovery attribution.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-25-katcats-group-task-lifecycle
baseline: false
changes:
  - root: "event:katcats/group-task-lifecycle"
    previous: null
    after: "b2e773007bb506562cf53b4d5750ec6046cbe18a12465f83a5f9809b197c3cbf"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

New readers accept earlier Sessions without this event and preserve existing messages and generations. The event is log-only and never changes the model-visible surface or authorization. Older readers reject its unknown required discriminator before resuming or truncating the Session; they cannot silently misinterpret the task history. The existing Session event discriminator therefore permits the same format version. Recovery restores missing records from the product task journal, marks reconstructed records and never dispatches work merely to recreate history. Existing acknowledgement records and committed generations remain unchanged.

<a id="verification"></a>
## Verification

node run/tmp/presentation-api-buildcheck-tests.mjs packages/api/katcats-team/tests/group-transcript.host.spec.ts packages/api/katcats-team/tests/team-loader.host.spec.ts packages/api/katcats-team/tests/entity-lifecycle.host.spec.ts packages/api/katcats-team/tests/chats.host.spec.ts: 91 passed. Coverage includes actual member tool handoffs, rejected admission writes, unconfirmed transcript flush containment, cold restore and deduplication, cancellation versus uncertain results, fixed identities, and private/other-group isolation. The seven changed Host source/test files pass focused lint.

<a id="dev-note"></a>
## Dev Note

None.
