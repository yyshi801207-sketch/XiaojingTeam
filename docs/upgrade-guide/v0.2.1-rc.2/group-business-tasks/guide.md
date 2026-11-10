---
kind: upgrade-guide
description: "Group coordination writes a new storage generation for durable business tasks and confirmed-blocker explanations."
---

# Durable group tasks

English | [中文](guide.zh.md)

## Change

The group directory now writes `katcats_chats_v3`. First open imports committed v2, or otherwise v1, without changing predecessors. Once v3 has committed, it is authoritative; malformed data never selects a predecessor as fallback. Old executables cannot consume current task state. Downgrade is unsupported.

New accepted inputs carry `coordinationVersion: 1`. Business task records survive runs, explicit classifications narrow automatically appended history, and confirmed blockers retain a bounded responsible-member explanation. Existing accepted inputs retain their prior behavior. Stop and unknown-result protections remain effective. See the [group reference](../../../../packages/api/katcats-team/README.md) for tools, shared-context behavior and limitations.

## Migration

1. Keep all group storage and Session logs. Start the updated executable against the same profile; do not delete v3 to force reimport.
2. Update custom instructions to use `record_group_task` for task continuations and acceptance criteria, and `find_group_tasks` to locate older work. An ended turn is not user acceptance.
3. After restart, inspect saved outcomes before continuing paused work. A confirmed blocker can trigger an explanation, never permission to repeat its operation. Verify that Stop leaves no automatically resumed follow-up.
4. Verify existing groups, pending work, files and message identities before continuing. Compare actual tasks with the same model before claiming token savings or unchanged quality.
