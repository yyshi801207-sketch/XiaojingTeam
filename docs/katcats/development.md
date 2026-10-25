# Xiaojing Accounting Team development preview

English | [中文](development.zh.md)

This tutorial starts the independent Team development baseline in this checkout. It requires Node.js 24 or newer, Git, and network access for the first dependency installation. Product graphics and text retain the copied baseline until the Team branding is selected.

## Prepare the baseline

Open Command Prompt at the checkout root on Windows and use the Team scripts so dependencies, application data, and caches stay in this project.

```bat
cd /d E:\Projects\小兢会计Team版
npm run team:check
npm run team:deps
npm run team:build
```

The dependency command installs the exact repository pnpm version locally and installs the complete workspace dependencies from the lockfile. The build command builds this checkout's client and desktop artifacts and runs the aggregate checks. It does not package or install a desktop product. Existing `katcats:*` script names remain aliases to the same isolated Team launcher.

The build uses this checkout's Git `HEAD` when its `.git` directory exists. Commit the local baseline before building; a repository without a commit fails instead of using an older revision. A source snapshot without `.git` can use the historical `sourceHead` recorded in `KATCATS-COPY-VERIFICATION.json`. The launcher does not open the original project to resolve either revision or build this checkout.

## Open a preview

After a successful build, start one preview:

```bat
npm run team:web
```

The Web server listens on `127.0.0.1:3390`; an explicit alternative is `npm run team:web -- --port 3391`. Open the login URL printed by that invocation in a browser profile dedicated to this project. Treat the full login URL as a credential; do not paste it into chat, documentation, or source control.

For an unpackaged desktop preview, use:

```bat
npm run team:desktop
```

The desktop development identity is `小兢会计团队版 Dev` with application ID `ai.xiaojing.accounting.team.development` and data directory `run/desktop/app-data/XiaojingAccountingTeam-Dev`. The renderer, main-process, and Host debugging ports are `19422`, `19429`, and `19430`. These values isolate development and do not select the final release identity. Configure model credentials independently in this product's settings; a running page alone does not establish that chat works.

## Development data

The launcher passes a new environment containing selected operating-system tool variables and project-owned locations. It does not inherit model credentials, existing DSH settings, shared agent configuration, proxy credentials, or login-shell configuration. Tool lookup excludes other projects' dependency bins and the previous product directories while retaining this checkout's tools and system tools.

| Location | Purpose |
|---|---|
| `node_modules` and workspace `node_modules` | This checkout's installed development and runtime dependencies |
| `run/home` | Profiles, settings, credentials, Bot definitions, sessions, group chats, and memory |
| `run/agents` | Development-only agent instructions and skills |
| `run/workspaces` | Default work files |
| `run/desktop` | Electron app data, browser session storage, and logs |
| `run/user` | Development home and operating-system configuration directories |
| `run/tooling`, `run/cache`, `run/tmp` | Local package manager, newly generated dependency caches, and temporary files |

The first desktop launch also prepares Node, Python, and supporting dependencies under this checkout's `apps/desktop/.desktop-build`. These development resources are prepared locally; old application state, temporary verification files, caches, and installers are not copied into the baseline.

The launcher rejects paths escaping its checkout and links escaping the owned `run` tree; desktop initialization also rejects links in its fixed data directories. The private electron-builder cache declares CommonJS so downloaded `.js` tools do not inherit the checkout's ESM setting. `run/` is ignored by Git. Keep its credentials, session data, and authenticated browser storage private.

## Verify changes

```bat
node --test scripts\katcats-dev.test.mjs
```

Run module-specific tests with the launcher's `developmentEnvironment` and `prepareRun` helpers so test subprocesses inherit the same isolated locations. Rebuild before previewing source changes; the Team launcher does not watch edits. The verification report records commands actually run and any failures separately from planned checks.
