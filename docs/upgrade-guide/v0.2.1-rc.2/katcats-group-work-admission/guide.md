---
kind: upgrade-guide
description: "Group-wide Katcats.AI tasks require real member contributions before business tools can produce a deliverable."
---

# Katcats.AI group work requires member contributions

English | [中文](guide.zh.md)

## Change

An owner task addressed to a multi-member group can no longer use business tools before another member actually contributes. The responding member receives the complete current roster and effective group responsibilities. It can record a work split with `plan_group_work`, then make separate `request_group_member` calls. Every member in that plan must supply an actual completed result before integration proceeds in a later model step. Recording a plan, queueing a task or confirming a pass does not satisfy this requirement.

An explicit single-member mention, a one-member group and work already assigned by another member remain independently executable. Greetings, group settings and scoped memory do not require unnecessary assignments. `present` can register an existing final file without starting new work; unfinished declared plans, same-step delegation and original permission and file checks still apply. Complete actual handoff instructions are readable in the group and can be included in later member context. They retain their tool origin rather than becoming invented assistant speech. Storage fields and Session event types are unchanged; unfinished work still pauses on restart.

## Migration

1. Run the updated independent Katcats.AI build. No manual data migration is needed.
2. For a group-wide task, let the responding member select relevant colleagues and wait for their actual results. A task explicitly assigned to one member can still run independently.
3. Verify that work split records, real member replies and the final file appear in order. Read the full handoff content and open its file links when reviewing a draft.

See the [group conversation reference](../../../../packages/api/katcats-team/README.md#group-conversations).
