---
kind: upgrade-guide
description: "Fixed Odoo assistants isolate database contexts and require reconciliation of unconfirmed administrative writes."
---

# Odoo administration recovery

English | [中文](guide.zh.md)

## Change

The two fixed Odoo assistants stop carrying conversation summaries and saved Bot/team memories across administration databases. A new connection context replaces the old model-visible history while preserving the raw Session log. The first request from an older assistant Session also establishes a fresh context. Changing a key for the same verified account and database preserves that context. Connection changes that would replace the context are refused while an assistant is running.

Administrative writes now persist an intent before dispatch and require affected-record readback. An unresolved write blocks further writes by the same assistant in that database, including after restart. Read-only investigation remains available. Company initialization can use an explicitly selected empty company, and uncertain company creation can be reconciled from its saved setup task.

## Migration

1. Stop active assistant work before changing the administration database or account. Use either assistant’s **Bot settings → Financial system connection** to save and verify the connection.
2. After an upgrade or a context change, restate the current task and resolve target companies and records in the current database. Old conversations and saved memories remain archived; the fixed assistants do not automatically use them.
3. For an unconfirmed administrative write, ask the responsible assistant to inspect its saved operations and reconcile the affected records. If a creation reply was lost, review candidate records before explicitly adopting them. Do not repeat the creation while its outcome is unknown.
4. For uncertain company creation in guided setup, open **Connectors → Ledger setup tasks**, inspect the candidates and confirm the intended company, then separately confirm continuing setup. Verify the task reaches **Ledger ready** and the readback lists the initialized company, accounts and journals.
