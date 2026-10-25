---
kind: upgrade-guide
description: "Katcats.AI group transcripts contain task lifecycle records that older product builds refuse to read."
---

# Katcats.AI records task collaboration in group history

English | [中文](guide.zh.md)

## Change

This change affects only the independent Katcats.AI product. Group history includes log-only `katcats/group-task-lifecycle` events for admitted tasks, observed execution states and failures. These records retain the real initiator, recipient and instruction; they do not impersonate member replies or grant permissions. Older builds that do not recognize this required event refuse the updated Session log. The Session format version is unchanged because the existing event discriminator prevents unsafe interpretation.

Updated builds read earlier group history and restore missing task records from the existing durable task journal without repeating model work. Recovered records are marked as recovered; their recording time is not presented as the original execution time. Existing Session generations, messages and files are retained.

## Migration

1. Use the updated independent Katcats.AI build with its existing product data location. No configuration edits, file moves or manual data changes are required.
2. Open a group and submit a task through real members. Verify that its task record shows the actual recipient and queued or started state, followed by the observed result. A member's spoken claim alone does not create an assignment record.
3. Reopen the updated build and confirm that the same task records and member replies remain without duplicate dispatch. Continue using the updated build for these Sessions; an older build's refusal must not be bypassed by removing log events or resetting data. If saving or recovery is unconfirmed, resolve the reported error before continuing the affected group.

See the [product storage reference](../../../../packages/api/katcats-team/README.md) for the independent directory and group behavior.
