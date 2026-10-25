---
kind: upgrade-guide
description: "Katcats.AI member delegation returns actual completed replies or confirmed passes instead of queue acknowledgements."
---

# Katcats.AI waits for delegated member results

English | [中文](guide.zh.md)

## Change

This change affects only member delegation in the independent Katcats.AI product. `request_group_member` previously returned `status: queued` before the selected member ran. It now waits for that member's actual outcome and returns `completed` with the saved `reply` and `message_id`, or `passed` with both fields null. A pass does not supply an answer. Failed or uncertain work is not returned as a successful reply.

Delegation calls remain exclusive and run in order. The caller reads their real results in its next model step before creating dependent artifacts; other tools already proposed in the delegation step are refused. A busy member is refused immediately, including a member waiting for the caller's reply, to prevent circular waits. Restart still pauses unfinished work and preserves uncertain results for inspection instead of repeating it automatically. Existing storage fields, Session generations and files are unchanged.

## Migration

1. Run the updated independent Katcats.AI build with the existing product data location. No configuration edits, file moves or manual data migration are required.
2. Update any product-specific consumers that expect `queued` to handle `completed` or `passed`. Use `reply` only for `completed`; do not treat a null reply, refusal or unknown result as completed research.
3. Ask one member to obtain input from another. Verify that the selected member starts and publishes its real reply before the caller continues in a new model step. A request to a busy caller must return a refusal rather than wait indefinitely. If work is paused or uncertain, use the group's reported controls and inspect its saved results before retrying.

See the [group conversation reference](../../../../packages/api/katcats-team/README.md#group-conversations) for execution and stopping behavior.
