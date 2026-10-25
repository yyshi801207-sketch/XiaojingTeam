---
kind: upgrade-guide
description: "Katcats desktop installers use a separate application identity and data directories instead of upgrading Katcat.AI."
---

# Independent Katcats desktop installation

English | [中文](guide.zh.md)

## Change

Katcats.AI 1.0.2 uses app ID `ai.katcats.desktop`, NSIS GUID `f41a22b2-ae23-46e1-9d77-7e317f3e8f4f`, executable and shortcuts `Katcats.AI`, installation and Electron data directory `Katcats-desktop`, and URI scheme `katcats-ai`. Its Host data is under `%APPDATA%\Katcats-desktop\harness`, and its default workspace is `%USERPROFILE%\Documents\Katcats_Home`. It does not upgrade, scan for, or import an existing Katcat.AI installation. Source package names remain unchanged; packaged Electron metadata uses `katcats-desktop` for an independent updater cache.

## Migration

1. Install Katcats.AI as a separate application. Keep existing Katcat.AI and Xiaojing installations and their data directories intact.
2. Configure models and credentials within Katcats.AI. Existing credentials, sessions and workspace content are not copied automatically.
3. Confirm that shortcuts open Katcats.AI, the application uses the new data and workspace directories, and existing products still use their own directories. New Katcats installers can update only the installation registered under its new GUID. See the [desktop identity reference](../../../../apps/desktop/README.md#permanent-installer-identity).
