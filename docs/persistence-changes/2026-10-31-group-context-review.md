---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-31-group-context-review

English | [中文](2026-10-31-group-context-review.zh.md)

## Summary

Adds optional versioned delivery coverage and independent-review candidate metadata to group member input sources, plus a distinct group review correction notice. These source types also appear in inbox, developer-message and title-request records.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-31-group-context-review
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-24-katcats-group-message-sources"
    after: "f8225012a8b43de20001cb098ba13c08bd37a359902c1f248e46e3834e2afeb9"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-24-katcats-group-message-sources"
    after: "4905ff043fef7395e317d6cd704cd09ba3f0e6af8a7930a91b8fd6da05e4692a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-24-katcats-group-message-sources"
    after: "8b6f470440993f3cd3d8ff271659acef66ba0bc154b16f78c6fa9e9416ead7dc"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-24-katcats-group-message-sources"
    after: "b26023d51ba2427d323d0956ccc318fc729ef3784d29b2581f738a24c9a10baa"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing source kinds and required fields remain unchanged. New readers treat an absent collaboration version as legacy accepted work; missing context coverage triggers bounded bootstrap rather than assuming earlier delivery, and a missing review request never grants review authority. The preexisting Session reader validates nonempty source.kind for user/developer messages and preserves their opaque JSON fields; the unchanged TypeScript and Python SDK readers retain these messages without turning the notice into an assistant answer or a completed turn. The added notice uses the existing notice form and carries its model-visible correction as ordinary message content. Session.create replay and both SDK projections exercise this reader behavior. Optional fields do not confer tool or review authority: the current group host validates parent/child ownership, persisted successful verdicts and candidate version. This acknowledgement preserves Session readability; it does not promise that an older product dispatcher can resume new collaboration policy safely or authorize application downgrade.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/sdk/client/tests/katcats-task-projection.spec.ts --reporter=dot --maxWorkers=1: 2 passed, including Session.create replay of the new task metadata and notice. Python test_katcats_task_projection.py: 2 passed against the same expected event payload. Scoped group-review-flow and group-review tests: 17 passed, including restart review enforcement and contained unknown filesystem outcomes. Package regression: 797 passed and one unrelated existing avatar-order UI test failed; avatar source matches the saved pre-change baseline. New legacy-version storage checks and context restart checks are included in that package run. No Session core reader or SDK reader implementation changed. Real API quality and billing verification was not run because DEEPSEEK_API_KEY was unavailable.

<a id="dev-note"></a>
## Dev Note

None.
