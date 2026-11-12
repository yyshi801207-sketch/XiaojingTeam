---
kind: upgrade-guide
description: s’s switchable card alongside 系统助手.
---

# Open the Odoo administration assistants from the main Bot card

English | [中文](guide.zh.md)

## Change

The standalone ledger setup assistant moves into the main Bot view as 建账助手 and manages companies, organization and ledger setup and maintenance. 系统助手 manages users and permissions. Both use the same verified Odoo administration connection and keep separate private conversations. 建账助手 keeps the previous ledger setup Session and setup records.

## Migration

1. Select the assistant thumbnail at the upper left of the main Bot card to show both assistants side by side, each with a 64 px avatar and name. Select 建账助手 for existing ledger setup conversations or 系统助手 for user and permission changes. Select the main Bot thumbnail to restore its card.
2. In either assistant’s **Bot settings → Odoo database connection**, check the saved address and database. Open **Connectors → Ledger setup tasks** to confirm that existing plans are available. Review the exact Odoo operation in the confirmation panel before approving an administration write.

See the [Odoo administration and ledger setup reference](../../../../packages/api/katcats-team/README.md#odoo-administration-and-ledger-setup) for supported operations and the shared connection.
