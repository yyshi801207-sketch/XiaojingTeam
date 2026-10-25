# Xiaojing Accounting Team

English | [中文](README.zh.md)

This repository is the independent development baseline for 小兢会计团队版. It contains the complete application source, workspace dependencies, desktop runtime preparation, and packaging tools. Team brand graphics are pending; copied artwork does not select another product's data or installation.

<a id="run"></a>
<a id="run-from-source"></a>

## Develop locally

Use Node.js 24 and Git. Open Command Prompt in this project and run:

```bat
cd /d E:\Projects\小兢会计Team版
npm run team:check
npm run team:deps
npm run team:build
npm run team:desktop
```

The dependency command installs the pinned package manager and the full lockfile dependencies inside this checkout. The build includes artifacts and aggregate checks. The first desktop preview prepares its own Node and Python resources. Dependencies and resources belong to this project; no other application checkout is needed to build or start it. See the [development preview guide](docs/katcats/development.md) for data paths and Web mode.

Configure models and API credentials in this application's settings. Existing products' credentials, Bots, conversations, memory, browser pairing, and workspaces are not imported. Keep development data in the ignored `run/` directory private. Model API usage is billed separately by your provider.

## Product isolation

The desktop identity, installer identifier, executable, URL protocol, application data, default workspace, development ports, and browser extension pairing are dedicated to the Team product. The application does not register the shared global `dsh` command, use inherited product update feeds, or send product analytics to the inherited collector. See [desktop identity and packaging](apps/desktop/README.md) and [browser configuration](packages/xiaojing/xiaojing-browser-control/README.md) for the owning settings.

The local Git repository has its own history and no configured publishing remote. The baseline copy report records historical source information; launch and build commands resolve paths from this checkout and use its current Git revision. Legacy internal package names remain implementation identifiers.

## Application capabilities

- Create Bots with individual responsibilities, avatars, models, permissions, and persistent memory.
- Work in private conversations or group chats with a coordinator and member-specific responsibilities.
- Follow handoff records and task states, change permissions in bulk, and choose when to interrupt background work.
- Send attachments and open delivered files directly in the conversation.
- Use Chinese or English, light or dark themes, and the desktop companion.

## Verify and package

Run focused tests for the modules you change and rebuild before previewing. The [architecture](docs/architecture.md), [testing guide](docs/testing.md), and [contribution guide](CONTRIBUTING.md) describe the inherited engineering workflow. The [baseline verification report](TEAM-BASELINE-VERIFICATION.json) records the local setup and completed isolation checks.

To create a Windows x64 installer, follow the [desktop packaging guide](apps/desktop/packaging/README.md). No Team installer or public download is published by this development baseline. Publication requires a separately configured Team repository and release destination.

## Attribution and license

This project derives from the copied Katcats code baseline and [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), whose agent runtime uses [Cordis](https://github.com/cordiverse/cordis). Historical names and upstream notices document source attribution; they do not connect the running application to another product. This is not an official DeepSeek product.

Source code is distributed under the [MIT License](LICENSE), retaining the upstream copyright notice. Third-party dependencies retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [vendored source notices](vendor/README.md).
