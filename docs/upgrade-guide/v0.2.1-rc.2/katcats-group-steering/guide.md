---
kind: upgrade-guide
description: "Ordinary Katcats.AI group sends preserve running work and budget pauses; interruption requires an explicit action."
---

# Katcats.AI group sends preserve current work

English | [中文](guide.zh.md)

This guide applies only to the independent Katcats.AI product.

## Change

Ordinary sends from the group composer use `queue` instead of automatically steering current work. The product saves and acknowledges each message while preserving active members and approvals. A member already waiting for a colleague answers queued questions only after that execution chain finishes; the same member Session never runs a second model concurrently. Another group and private conversations are unaffected.

Queueing during a relay-budget pause no longer starts a replacement run or cancels accepted work. Owner, budget and unconfirmed-outcome pauses remain paused after ordinary sends. Continue retains existing member deliveries when continuation is permitted. A new ordinary message starts a run after Stop or completion. Explicit Interrupt and adjust, or Host `mode: 'steer'`, still cancels and drains the old chain after durably accepting the replacement. Completed replies, receipts and files remain; cancellation cannot undo started external effects or turn unknown outcomes into confirmed success. Identical request retries acknowledge the saved input once.

## Migration

1. Run the updated independent Katcats.AI build with its existing product data location. No storage fields, Session generations or file locations require migration; do not edit configuration or move data.
2. Send an ordinary question while a member is working. Confirm receipt appears without cancelling its task or approval; the member answers after its current work finishes. If the group is paused, check its reason and use Continue when permitted.
3. Integrations that previously relied on a queued message to replace budget-paused work must explicitly pass `mode: 'steer'` to `katcatsChats.sendMessage`. In the group UI, choose Interrupt and adjust only when replacement is intended. Inspect saved progress before repeating any uncertain external effect. Keep retries on the same request ID and content; changed content requires a new request ID.

Failure and history guarantees are described in [group conversations](../../../../packages/api/katcats-team/README.md#group-conversations).
