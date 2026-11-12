---
kind: upgrade-guide
description: Xiaojing groups restrict ledger changes during runs and save new task archive states.
---

# Group task archives and ledger changes

English | [中文](guide.zh.md)

## Change

Group settings and `katcatsChats/bindFinance` reject ledger changes while a group run is pending or paused. Previous builds could change the binding during a saved run. Group task continuation uses the ledger associated with the saved task.

The current build reads older task records. Saved awaiting-acceptance and completed states require the updated archive reader. A standalone chat acceptance also records an owner message without dispatch recipients. Earlier builds require recipients on every saved group input.

Ordinary tasks now complete after their submitted result passes required review and is durably published. Only tasks marked for human review await owner acceptance. Natural-language acceptance can also be saved by the current responsible member with the original execution recipients, so older readers cannot reopen those records. Odoo operation approval remains separate and occurs before writes.

Declared group data changes require review of the exact Odoo target and normalized operation before dispatch. Review replies no longer count as separate business assignments, and a candidate's declared preparers cannot approve their own work. Unknown write outcomes remain unconfirmed across restart.

## Migration

1. In the group chat, finish the current run or use Stop. Inspect saved results if the outcome of a previous operation is unknown.
2. In group settings, open Finance connection, change the binding, and verify the new ledger. Existing task records remain visible. Open the archive to confirm which tasks can continue on this ledger.
3. Keep using the updated build with that data directory after delivering or accepting an archived task or sending a standalone acceptance in group chat. Use a copy made before updating if you need to reopen the data in an earlier build.
4. For an open task without acceptance criteria, have its responsible member record the criteria on the same task ID before submitting its result. Set `human_review_required` only when a person must review the final result; do not use it to duplicate a completed operation approval.
5. For pending Odoo changes, request a new review with `review_candidate.odoo_operation` and any `source_delivery_ids`. After execution, read back the records and review the final result. If an earlier write outcome is unknown, inspect the records before deciding whether another attempt is needed.
