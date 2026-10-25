---
kind: upgrade-guide
description: "Xiaojing Accounting Team removes the desktop pet window, settings page, state endpoints, and private pet IPC."
---

# Xiaojing Accounting Team removes the desktop pet

English | [中文](guide.zh.md)

## Change

The independent Xiaojing Accounting Team application no longer includes a desktop pet. Its transparent window, settings page, pose assets, task-state observer, loopback snapshot and event endpoints, and pet preload methods are removed. This affects only this Team project; other installations and projects are unchanged.

The Windows system tray retains Open application and Quit. Closing the main window still keeps background work running. Quit checks still inspect running agents, queued inputs, jobs, and armed reminders through the Desktop Host.

## Migration

1. Restart the Team application after updating its build. A currently running older process retains its existing window until exit.
2. Remove custom overlay rows named `xiaojing-desktop-companion` or `ui-desktop-companion`; their packages are no longer part of this source tree. Custom integrations must stop calling pet-specific preload methods or `/xiaojing-desktop-companion` endpoints. Application metadata remains available through `xiaojingDesktop.getApplicationInfo()`.
3. Confirm Settings has no desktop-pet entry and the tray offers only application open and quit controls. Existing `desktop-companion/preferences-v1.json` files remain untouched and are no longer read or written; no user data reset is required.
