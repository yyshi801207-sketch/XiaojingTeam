# 小兢会计团队版 Windows desktop

小兢会计团队版 V1.0.2 uses product version `1.0.2`, app ID `ai.xiaojing.accounting.team.desktop`, install directory `XiaojingAccountingTeam-desktop`, and a separate Documents workspace. It neither upgrades Katcat.AI nor imports its data or Xiaojing Accounting data. Local unsigned Windows packages use `DSH_DESKTOP_APP_ID=ai.xiaojing.accounting.team.desktop` in `.env.windows` and omit mandatory-update policy metadata and update feeds. This product does not embed update feeds or remote mandatory-update policies; inherited release configuration cannot select another product’s service.

English | [中文](README.zh.md)

Fresh installations default to `%LOCALAPPDATA%\Programs\XiaojingAccountingTeam-desktop`. Only installations registered under the Team GUID can be upgraded in place. The installer footer retains the transparent baseline wordmark in `installer-company-source.png`. Each successful installation or reinstallation initializes the light theme once, as described under [user-data paths](#permanent-user-data-paths). Katcat.AI installations, workspaces and session paths remain untouched; the default workspace is `Documents\XiaojingAccountingTeam_Home`.

The private Electron deployment for 小兢会计团队版. It is distributed through the Windows installer rather than npm, starts the bundled Node runtime and Web profile, keeps the renderer isolated from Node, and presents the local Host in one Windows desktop window.

The application document, bundled assets, and top-level PNG, SVG, ICO, and Web manifest files are served from the packaged frontend before the Host starts. API requests, plugin bundles, and event streams are forwarded only after the authenticated Host is ready; they return 503 before readiness and are never treated as those static resources. Every document boot requests the running Host's current injection table over private IPC, so a renderer reload uses current bundle revisions after HMR rebuilds. A failed request or a Host replacement rejects boot instead of reusing startup injections.

The startup uses the supplied 1584×993 website-green PNG without re-encoding. Its #12a489 background matches all four source corners; the image is centered and contained so its icon and text remain visible at different window proportions without contrasting edge bands. A white indeterminate horizontal loading line sits below the text already present in the image. The existing localized startup status remains available to assistive technology, and reduced-motion preferences keep the indicator still. The startup stays in the same application document until the client renders its first interface; the main interface keeps its white background. No extra delay or navigation is added. Closing or minimizing the startup window remains effective when initialization completes, and an explicit open restores it during startup.

Automation tasks are built into the Web application hosted by Desktop. New profiles select the shipped Web bundles without the retired experimental Schedule bundle. The Host's standard profile loader removes that retired declaration during upgrades while retaining other bundle selections, installed dependencies, user metadata, and explicit plugin overrides. Existing tasks remain; a new installation does not create or execute tasks by itself.

The independent 小兢会计团队版 copy uses 小兢会计团队版 for native application menus, About panels, window titles, tray entries, and localized dialogs. Its installation identity and permanent data paths are separate from Katcat.AI. The development process keeps its separate 小兢会计团队版 Dev identity.

<a id="permanent-installer-identity"></a>
## Permanent installer identity

`identity.json` is the source manifest and `verify-desktop-identity.mjs` locks this independent product identity:

| Field | Value |
|---|---|
| Package name | `@deepseek-ai/dsh-desktop` |
| App ID / AppUserModelId | `ai.xiaojing.accounting.team.desktop` |
| NSIS GUID | `c8462347-245f-49dd-8195-e1174bb7e3ef` |
| Installation directory | `XiaojingAccountingTeam-desktop` |
| Executable | `XiaojingAccountingTeam.exe` |
| Product name | `小兢会计团队版` |
| Installation scope | Current Windows user |
| Shortcut | `小兢会计团队版` |
| Packaged application name | `xiaojing-accounting-team-desktop` |
| URI scheme | `xiaojing-accounting-team` |

The product does not expose the shared “Manage dsh Command” menu or register a global `dsh` command. Packaging derives the Windows executable name from `identity.json.executableName` and the macOS executable from `identity.json.productName`. The ASCII Windows batch command uses the bundled primary Node runtime to forward arguments and inherited standard streams to Electron Node mode without changing the console code page; it waits for the CLI's console-interrupt shutdown and preserves its exit status. The CLI joins its parent's console only when unattached; a missing parent console does not prevent background commands.

A fresh installation uses a two-stage branded setup flow. The welcome page presents the Xiaojing mark, a SUDO-green install action, and an optional inline parent-directory picker that appends `XiaojingAccountingTeam-desktop`; the installation page keeps the Xiaojing artwork, hides the stock NSIS details area, shows the real file progress, and then launches the application without a separate finish page. The welcome page carries the installation consent notice, while the internal-use notice, complete upstream license, and third-party notices remain bundled under `resources/legal`. During a fresh installation into a target directory that did not previously exist, closing or cancelling the progress page opens the native confirmation prompt. Confirming cancellation starts an external cleanup helper and exits with code `1602`; after the installer process stops, the helper validates the fixed installation-directory name and removes only the partial application, current-user installer records, and shortcuts. Cancellation is disabled when the target directory already existed. During an in-place upgrade, the welcome page can still be closed before replacement starts, but cancellation is disabled once file installation begins to protect the previous installation. User-data paths are never part of cleanup. An installer with the same identity reads the exact `InstallLocation` from the fixed current-user GUID, hides path selection, asks that installed application to exit for the update, and handles only processes whose executable is inside that exact installation root. Before invoking an earlier uninstaller, the same fixed-root helper removes only legacy program entries whose absolute paths exceed the old Win32 limit, preventing deep unpacked dependencies from being misreported as an application-close failure. The standard updater then replaces application files and refreshes shortcuts and uninstall metadata. Unrelated processes and protected user data are never scanned, terminated, or removed. Moving an installation still requires uninstalling and reinstalling.

The branded installer displays 小兢会计团队版 and the approved two-accountant-robot illustration at up to 480×400 pixels in an 820×680 white window. Short screens reduce the window and artwork together, keeping the title, installation controls, and bottom consent notice visible. The complete square PNG from `视觉资产/双会计机器人标签替换.png` is retained byte-for-byte at `build/installer-robot-source.png`; the bitmap generator centers it proportionally on white without cropping or stretching either character. `prepare:icons` regenerates the welcome, small, header, sidebar and lower brand bitmaps together with the native icons. The uninstall sidebar uses the same robot artwork.

The approved green-and-gold application PNG from `视觉资产/应用程序图标.png` is retained byte-for-byte at `build/installer-icon-source.png`. `scripts/prepare-windows-icon.ps1` validates its SHA-256 and 1254×1254 dimensions, then copies it unchanged to Desktop PNG aliases, browser favicon and download-page icon. `node apps/desktop/scripts/prepare-installer-icon.mjs` generates multi-resolution `build/installer-runtime-icon.ico` and macOS `build/app-icon.icns` with the existing electron-builder icon tool. The Windows executable, installer, uninstaller, content-addressed shortcuts and quit dialogs use that ICO; packaged dialogs read its identical copy at `resources/tray.ico`. Native windows, taskbar and tray use `assets/windows-icon.png`; Linux and native About dialogs use the matching application PNG. These preparation commands neither install nor publish the application. The application opens the Team workspace directly, with first-use API-key guidance owned by the product plugin. DeepSeek account login and the native authentication welcome window are not exposed.

After installing files, the installer copies its icon to `resources/katcat-icon-<sha256>.ico`, updates existing Desktop and Start Menu shortcuts to that content-addressed path, retains their AppUserModelId, and sends a path-specific Windows Shell update notification. A changed icon gets a new path even when the application version stays unchanged. This step also runs for silent upgrades and does not recreate links omitted by the upstream shortcut policy. A write failure offers Retry or returns exit code `2` instead of launching the application as a successful installation. It neither restarts Explorer nor deletes the system icon cache. `dist:win` generates icons and runs `verify:installer-shortcuts`, which compiles the production updater against isolated temporary shortcuts and checks changed artwork, repeated installation, omitted Desktop links, and locked-icon failure.

<a id="permanent-user-data-paths"></a>
## Permanent user-data paths

Electron pins `userData` before the single-instance lock to `%APPDATA%\XiaojingAccountingTeam-desktop`. The bundled Host uses its `harness` child as `DSH_HOME`. The Host starts in `%USERPROFILE%\Documents\XiaojingAccountingTeam_Home`, supplied through `XIAOJING_OFFICE_WORKSPACE_ROOT`. The build does not create a Finance workspace. The Electron directory dialog starts in `XiaojingAccountingTeam_Home` when an add action supplies no initial path; users can select another directory. Existing Katcat.AI and Xiaojing data directories are not read or imported. The [Models onboarding coordinator](../../packages/client/ui-settings-models/README.md#onboarding-coordinator) uses installation identity and usable-provider readiness to decide whether to show guidance. Uninstall retains Team data; deleting the workspace does not remove sessions, settings, or usage records.

Every successful NSIS installation, including a same-version reinstall, writes a fresh GUID to `katcat-installation-id.txt` beside the executable. Before starting the Host, Desktop holds the profile lock and sets only `ui-theme.preference` to `light` for an unconsumed installation ID, then records that ID in `userData/desktop/installation-theme-id.txt`. Other settings, credentials, sessions, and usage data remain intact. Ordinary relaunches retain any subsequent theme choice. Desktop supplies the public, non-secret ID to the Host through `KATCAT_DESKTOP_INSTALLATION_ID`; builds without an installer marker keep their existing behavior.

The 0.2.1 RC2 `DesktopHostProcess` owns the loopback Host lifecycle and pins `DSH_CLIENT_BUILD_PROFILE=xiaojing`, so only the Electron shell loads the application and Xiaojing-only Host plugins remain active in packaged builds. The desktop exchanges the authenticated launch token for a Host cookie used by application HTTP requests; users do not open a printed URL.

The desktop Host sets `KATCATS_PRODUCT_MODE=1` for installed applications and previews. This selects the member directory, group chats, scoped memory and Katcats sidebar settings, and disables the original composer model menu. `KATCATS_DEV_MODE=1` separately selects repository-local `run` data and the temporary development identity only for unpackaged previews; the development wrapper sets both flags. Installed applications keep their independent permanent Katcats paths even when development variables are present.

`user-data-contract.json` protects sessions, settings, credentials, agent presets, profiles, storage, legacy uploads, native image attachments, usage accounting, the dedicated browser-control profile, Weixin channel state, desktop-companion preferences, Electron Local Storage, and the Documents workspace. The installer has `deleteAppDataOnUninstall: false` and never addresses those paths. `verify-user-data-contract.mjs` exercises a synthetic 0.1.9 data set through application replacement and the current readers. It requires protected bytes to remain unchanged except for exact installation-owned Web profile migrations from retired file-upload bundle tuples, with or without ModLens, to the current Web template; it verifies the atomic flat-to-version-1 credential migration on a private copy without creating a plaintext backup, and checks session, credential, preset, settings, upload, storage, and accounting compatibility. The V3 session migration accepts the fixture's immediately pre-step user message without rewriting its source; this gate must pass before an upgraded desktop release. A release that changes another durable format must add an atomic migration and a previous-release fixture before this check may change.

Platform account-page browser storage uses Electron's `session.fromPath` at `sessionData/p/<SHA-256 in base64url>`, retaining the complete issuer/account digest while shortening Windows cache paths. Before opening an account's first Session, an existing `Partitions/dsh-platform-<SHA-256 in hex>` directory moves atomically to that account's new directory. Existing preferences and browser files are retained; simultaneous old and new directories cause an explicit error without overwriting either. Host login credentials and the existing authentication-cookie cleanup remain unchanged. Accounts without a stable identity still use memory-only storage.

The Host pins `DSH_AGENTS_HOME` to `harness/agents`; Electron stores browser session data below `userData/session-data`. Previous product runtime paths, Node injection settings, personal-browser overrides and inherited API credentials are removed. Explicit `XIAOJING_TEAM_*` browser settings belong to this product. No installed product data is imported.

## Development preview isolation

Source-only Electron previews may set `DSH_DESKTOP_PREVIEW_ROOT` to an empty temporary directory before starting the desktop package. Unpackaged runs then place both Electron application data and the Documents workspace below that root; packaged builds ignore the variable and retain the permanent paths above. This keeps development previews from reading or writing an installed user's data. Before creating a development window, the desktop verifies that the shared Client artifacts came from a complete Xiaojing build; a missing or incompatible record stops with an instruction to run `pnpm run build:xiaojing` instead of showing an official or incomplete interface.

## System tray lifecycle

The main-window preload enables the Web layout's 40px Windows caption row before the application renders. Conversation and plugin controls stay below the native window buttons. Drag regions belong to the layout, without an injected overlay over interactive content.

The Team application has no desktop-pet window, settings entry, task-state observer, state stream, pet IPC, or bundled pose assets. The Windows system tray belongs to the shell and offers only Open application and Quit. Previous desktop-pet preference files remain protected user data; the application neither reads nor writes them.

Closing the main window hides it to the tray instead of exiting. The minimize button keeps its normal taskbar behavior, a second application launch restores the existing main window, and the application and tray quit commands use the shared quit controller. It checks running agents, queued inputs, live jobs, and armed reminders through the Desktop Host before confirming interruption, then destroys the main window before stopping the Host so renderer event streams cannot reconnect during shutdown. Platform cleanup and Host exit are awaited before application exit; the tray is released during shell shutdown. The first background transition uses the shared notification controller. Application metadata remains available through the restricted product bridge; directory selection and opening existing absolute workspace paths use separate narrow bridges. The main process validates the owning renderer and path; the renderer receives no Node, filesystem, arbitrary IPC, or BrowserWindow access.

## Built-in automation runtimes

Browser automation uses the [native Edge and Chrome connections](../../packages/xiaojing/xiaojing-browser-control/README.md#native-browser-connections). Edge is the default; an explicit Chrome request selects Chrome. Browser Control settings enable already-open tabs through the browser's remote debugging permission and connection approval, without extension pairing, port entry, or token entry. Managed connections provide separate browser profiles when the requested browser and device policy permit them. Windows application control uses Windows PowerShell 5.1 and the operating system's `System.Windows.Automation` API. End users do not install Node, a browser driver, PowerShell module, or a separate automation service.

Both capabilities are independent Cordis rows. A development overlay can disable either row, while the Xiaojing product composition enables both and tells every new agent session when they are available. Browser and Windows observations use session-owned opaque identifiers and expire after state changes. Protected actions request approval; explicit session authorization applies only to eligible observed operation and target classifications, while unclassified actions remain one-shot.

## Independent integration patches

`integration-patches.json` inventories desktop API-key environment isolation, profile runtime-shadow protection, and file-upload composer repair separately from the product brand plugin. rc.2 owns the writable credential UI; the desktop patch removes inherited API credentials and previous product runtime paths before Host startup. The desktop identity check fails if an inventory entry disappears or its owned path is absent. This keeps upstream conflict review focused without pretending these patches are official Harness behavior.

## Release checks

The desktop package target builds the Xiaojing client profile and passes `--client-profile xiaojing` to DSH tarball packing. The packer checks both the exact public build values and the artifact digest; ordinary npm packing and publishing retain the official profile requirement.

Run the identity, user-data, and product-layer verifiers plus tray lifecycle, real Edge, and Windows UI Automation tests before preparing the bundled runtime. A release also requires a fresh Windows install and an in-place upgrade from the previous installer on both default and custom paths. The installed application must retain sessions, credentials, presets, plugins, attachments, workspaces, accounting data, the dedicated browser profile, Weixin channel state, and desktop-companion preferences before an installer is published.

The 0.2.1 RC2 package target runs `smoke-packaged-runtime.ts` against the assembled application before it writes the release record. The smoke verifies the prepared DSH tree, the packaged executable and primary runtime, including native Office conversion outside ASAR.

<a id="local-desktop-settings"></a>
## Shell settings and packaging

Electron reads `userData/desktop/settings.json` once at launch. The optional `updates.allowTestAuthPopupWindow` boolean defaults to `false`; absent settings are initialized without replacing an existing document, and malformed settings retain their bytes while startup uses the default. This preference controls test update authentication only and does not enable the official account Welcome flow in Xiaojing. Restart after changing it.

The packaged `dshDesktopUpdateChannel` selects `nightly` or `latest`; older manifests default to `nightly`. Team does not perform update checks, emit a remote policy, or expose update and global-command menu entries. Its application preload does not request mandatory-update IPC or mount the inherited update overlay. The channel field remains metadata for the shared packaging implementation. Packaging keeps the Xiaojing product identity independent of the kernel package version. Retained-build upload validation uses the retained original product version even after the checkout advances.

The upstream [packaging reference](packaging/README.md) describes machine presets and signed, unsigned and unnotarized outputs; the [Windows signing guide](windows-signing/README.md) owns hardware signing requirements. Xiaojing additionally requires the identity, data-retention and client-profile checks above. The upstream publication and CI examples target DeepSeek infrastructure; they do not authorize publishing Xiaojing artifacts to those services.

## Known limitations

- Team has no configured update service. Packages omit update feeds and mandatory policies, and the shell disables its updater; hardware signing remains a separate packaging operation.
- In-place upgrades apply only to the same Windows user and cannot move the installation directory.
- The requested Edge or Chrome browser must be installed and permitted by device policy. Existing-tab access additionally requires its native remote debugging permission and connection approval; failures do not switch browsers.
- The built-in automation is semantic, not visual: it cannot operate pixel-only controls, CAPTCHAs, UAC, the secure desktop, or elevated applications.

<a id="bundled-workspace-dependencies"></a>
### Bundled workspace dependencies

Desktop main bundles inline workspace dependencies after the Host build; `desktop-bundle-imports.mjs` checks unresolved imports before packaging.

<a id="release-versions"></a>
### Release versions

`identity.json.productVersion` owns the Xiaojing application version; workspace package versions identify the Harness engine. Unpackaged previews display the identity's product version in About and the product renderer; packaged applications display their packaged version. `DSH_DESKTOP_BUILD_VERSION` must extend the application version through the validated test prerelease format.

<a id="upload-updates"></a>
### Upload updates

No Team update destination is configured. Desktop upload and installed-update publication commands stop with “Team发布目标尚未配置” before loading credentials or starting network access; the Windows credential launcher rejects upload mode before opening its credential file. Upstream uploader examples do not authorize using another product’s storage or feed.

<a id="windows-ev-signing"></a>
### Windows EV signing

Signed packaging requires the configured EV certificate, signing toolchain and signature-cache ownership checks. Unsigned local qualification does not perform hardware signing or authorize publishing a release.
