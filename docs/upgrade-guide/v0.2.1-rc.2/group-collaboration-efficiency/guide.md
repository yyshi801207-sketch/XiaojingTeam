---
kind: upgrade-guide
description: "New group inputs use responsible-member routing, incremental history and recorded independent review instead of automatically calling every member."
---

# Group routing and reviewed delivery

English | [中文](guide.zh.md)

## Change

New unmentioned group messages go only to the current ordinary manager, or the first ordinary member when no eligible manager exists. Explicit mentions select only those members. Accepted inputs record `collaborationVersion: 1` and fixed recipients. Older accepted inputs retain their saved recipients and legacy execution behavior; their files and logs are not rewritten.

Member context contains unseen public messages, with bounded recent history on first entry and `read_group_history` for originals. `plan_group_work` accepts empty assignments and records whether another member must review the result. Financial conclusions, data changes and explicitly requested reviews require an independent approval tied to the exact candidate and child task. Missing review prevents formal completion. Task classification is model-driven; this does not guarantee that every important task is classified correctly.

For versioned group tasks, `report_group_blocker` records why work remains incomplete, the member-reported effects and a safe next step, then ends that task without an approved receipt. Authentication, permissions, missing inputs, service failures and unavailable review use the same path. A durably failed child returns `status: failed` and its diagnostic to the waiting caller; it does not cancel the caller or satisfy an assignment or review. The caller must report or resolve the blocker without claiming success or blindly repeating writes. A working reviewer is rejected before the plan is recorded, including a caller waiting for this member. Unknown effects, cancellation and unconfirmed persistence retain the pause and inspection protections. Restart restores blocker reports from their original successful tool results; it neither approves delivery nor replays operations.

## Migration

1. Keep existing group data and Session logs. The optional inbound version distinguishes accepted legacy work from new work without rewriting old records. The `/chats` plugin now requires the composed `fs` service used to inspect review candidates.
2. Update Bot role instructions that expect everyone to answer every message. Use explicit mentions or `request_group_member` when another member must participate. Ordinary tasks can use `plan_group_work` with no assignments; important tasks select another current member for review.
3. Custom `/chats` configurations can set `initialHistoryMessages` (default 20), `historyPageSize` (20), `historyPageMaxChars` (16000) and `reviewCandidateMaxBytes` (8388608 cumulative bytes). All require positive integers. Existing configurations receive these defaults.
4. Submit the original candidate through `request_group_member`; only its assigned review child can use `submit_group_review`. After requested changes, submit the revised candidate again. Existing approval permissions continue to govern external changes; review provides no rollback.
5. Confirm one unmentioned input wakes only its responsible member, explicit mentions select the named members, old queued inputs retain their recipients, and an important unreviewed or subsequently changed deliverable remains blocked. Compare identical tasks with the same model before making claims about real-model quality or billing savings. See the [package reference](../../../../packages/api/katcats-team/README.md#group-conversations) for history and review limits.
