---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-11-finance-group-closure

English | [中文](2026-11-11-finance-group-closure.zh.md)

## Summary

Adds optional preparer references and an exact Odoo operation to persisted group review candidates.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-11-finance-group-closure
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-10-group-finance-welcome"
    after: "c97081e9487c9df9ce7d9e6b0af899c5a81678f6f1b7f9c0aaf6f81992624c2a"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-10-group-finance-welcome"
    after: "2db78c2f7c1e0b1a4a0f2613a34d92c3a5afa400ab8d50a591875291258e704a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-10-group-finance-welcome"
    after: "252eb716b714faf19ecaf86e96bc2976a9b36a12229010f396035c96329a4bd1"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-10-group-finance-welcome"
    after: "67423077b0527d25525a84ada70b7bf5033a49c2e25a2384e2fc0dabcd1ec766"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing candidates without the optional fields keep their original content digest and remain readable. New readers include supplied sources and the bound connector, company, server, database, method and normalized arguments in the digest. New candidates do not satisfy an older reader's candidate digest check, so older runtimes refuse approval instead of executing under an unrelated review. Both fields remain optional in the existing Session source discriminator; no stored log generation is rewritten.

<a id="verification"></a>
## Verification

Focused group review tests passed, including candidate mismatch and cold recovery. The group-review-orm-flow tests passed for reviewed exact writes, final readback and delivery, and unknown write outcomes across restart. build:artifacts and build:check passed; the final dispatch lock fix is also covered by the focused runtime tests.

<a id="dev-note"></a>
## Dev Note

None.
