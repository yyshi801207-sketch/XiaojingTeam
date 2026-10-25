---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-24-katcats-group-message-sources

English | [中文](2026-10-24-katcats-group-message-sources.zh.md)

## Summary

Adds Katcats group task, completed-member relay and explicit continuation sources to existing user-role messages and their enclosing recorded request arrays.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-24-katcats-group-message-sources
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "f1f697022143958a6446d942f1752508ef2684ade7f7c5729bb389326e4dac65"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "5b7c42b9bdac7fb9ec4d2fba57e6706fadd4782e12e22cef3ba5a6dded98f76d"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "277950869237fd4023d4806cd2b003f4d48ec748dc3ec60ddbc69aa4107171a2"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "25d308b3d57e977f06fdaa8400acf3096385e2af1a943bff729d90222678f5ac"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The Session header, event names, event envelopes, message roles and existing source alternatives are unchanged. Old records remain readable when these three kinds are absent. Readers without the Katcats producer retain unknown source kinds and their JSON metadata while deriving the same user-role text; the existing relay and notice forms provide generic context presentation. No new message interpreter, replay authority or permission grant is required. The Katcats producer uses its delivery identifiers to reconcile its own durable task receipts; removing it removes coordination rather than converting recorded context into assistant output or executing a member task. Inbox splices and title-request message arrays retain the same embedded messages. Keep the current Session version and preserve accepted historical schemas.

<a id="verification"></a>
## Verification

The focused real-Loader group tests exercise member task and relay persistence, explicit continuation, cold replay without duplicate dispatch, recovery after a member flush preceding a failed receipt write, and captured sender identity. node run/tooling/check-p3-generic-reader.mjs passed against the pre-P3 core artifact without loading Katcats: all three source kinds, metadata, user-role content and recorded event sequence survive public detached restore, with only the documented resume marker added. The first persistence preview reported the four affected roots and requires this explicit same-version review.

<a id="dev-note"></a>
## Dev Note

None.
