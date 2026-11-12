---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-10-group-finance-welcome

English | [中文](2026-11-10-group-finance-welcome.zh.md)

## Summary

Adds a source kind for the main Bot’s connection welcome in a group transcript. The source preserves the verified ledger, company, currency and sender.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-10-group-finance-welcome
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-31-group-context-review"
    after: "535215fa614274db6071f3304ba9105ab329c49493db97b72a4f160a1b1871bb"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-31-group-context-review"
    after: "63ea3fc41e55a68e5993b9c91607c295e89c103eec44bfabffc8d4896f61ec11"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-31-group-context-review"
    after: "ad067196d3888185506b91b663249b85b3c34ab5fad77dd075910afab4539c09"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-31-group-context-review"
    after: "c83213ee2bb491cbd3343dfd070149741bbeb40390bb1e1adb06c57efe59f665"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing source kinds and their fields remain valid. The current Session reader preserves the opaque fields of a user message with a nonempty source kind. Older readers can replay the welcome using its ordinary text and notice summary. The SDKs retain the source without projecting an assistant answer or turn completion. Current group execution uses the saved binding for authorization and does not treat these historical notices as current ledger evidence.

<a id="verification"></a>
## Verification

The group finance flow and TypeScript SDK projection suites passed 8 tests. The Python SDK projection suite passed 3 tests. They cover saved notices after reopening, failure and stale-binding suppression, source preservation and the absence of an assistant reply.

<a id="dev-note"></a>
## Dev Note

None.
