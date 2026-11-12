---
kind: upgrade-guide
description: Ready Xiaojing ledgers now register a connector before the owner binds a group, and addConnector replaces handoff in the remote API.
---

# Registering a ready ledger in Connectors

English | [中文](guide.zh.md)

## Change

The ledger setup assistant previously added the ledger and bound it to the chosen group in one action. **Add to connectors** saves a standard Odoo connection under **My connections**. The owner chooses a group later in its **Finance connection** settings.

`xiaojingLedgerSetup/addConnector` replaces `xiaojingLedgerSetup/handoff`. The request takes the plan ID and `{ apiKey, accessMode }`. Pass `read-only` or `full` for `accessMode`. The setup storage format retains its version. Existing `handed-off` plans and their saved group bindings remain readable and usable.

## Migration

1. On a ready plan in **Connectors → Ledger setup tasks**, select **Add to connectors**. Enter a separate daily bookkeeping API key with access to the new Odoo company and select **Read only** or **Full access**. Remote API callers should use `addConnector(planId, { apiKey, accessMode })` and omit the former `chatId`.
2. Confirm the verified company and the selected mode under **My connections**. To use the ledger in a group, open its **Finance connection** settings, bind this connection and run a read query for that company.
