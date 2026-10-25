---
kind: upgrade-guide
description: "Katcats.AI group organization writes a separate v2 domain that older product builds do not read."
---

# Katcats.AI group directory uses a separate v2 domain

English | [中文](guide.zh.md)

## Change

This change affects only the independent Katcats.AI product. Group chats can share custom sidebar groups with Bots. The previous `katcats_chats` domain permits only the default chat section; new writes use `katcats_chats_v2`, version 2.

On its first start without a committed v2 record, Katcats.AI reads and validates v1, then imports its complete group directory and pending operations into v2. The original v1 generation remains byte-for-byte unchanged. Session identities, history and working-directory files are retained. Once v2 is committed, it is authoritative: validation or read failures never fall back to v1. Downgrading against migrated product data is unsupported because the preserved v1 record does not include subsequent v2 changes.

## Migration

1. Start the updated Katcats.AI build with the same independently configured product data location. No manual file movement, editing or configuration changes are required. The application's existing Katcats.AI startup performs the import.
2. Confirm that the existing Bots and group chats remain listed, their conversations open, and a group chat can move into a custom sidebar group. With the JSON backend, `katcats_chats_v2.json` is the new record; `katcats_chats.json` remains unchanged.
3. If startup reports a validation or migration error, stop and resolve the reported problem before retrying the updated build. Failed migration does not reset the records. Do not delete or edit either generation to bypass the error, or reopen the migrated data with an older product build.

See the [Katcats team storage documentation](../../../../packages/api/katcats-team/README.md) for the current product behavior.
