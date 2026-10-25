# Katcats.AI development and acceptance plan

English | [中文](development-plan.zh.md)

This reference defines the implementation stages and acceptance criteria for the independent Katcats.AI project. Targets in this plan are not claims that features already work. Stages proceed in order, and implementation continues autonomously after the preceding stage passes its checks.

## Product scope

- Develop the independent Katcat.AI source copy in `E:\Projects\Katcats.AI`, retaining DSH and the existing product interface. Use Grok Bot as the product reference and DeepSeek Bot as an implementation reference; installing the complete ds-bot plugin is not a requirement.
- Keep a main Bot fixed above the sidebar list for member creation and configuration. It creates members from natural-language requirements and reports success only after saving them; it does not automatically join or manage group chats.
- Provide quick creation using only a name and avatar. A manually created Bot starts as a general assistant, and the user can assign a lasting identity by chatting with it.
- Reuse the workspace-list interaction for logical Bot groups. Start with visible Ordinary Bots and Group Chats sections, even when empty; each group has a contextual create button.
- Selecting a Bot opens its conversation and right-side settings for name, role, avatar, color and model. New Bots use the separately configured DSH base model, initially DeepSeek.
- Support group creation, member identities, genuine model-driven replies, handoffs, memory, permissions, approvals and usage. Compare the delivered scope against DeepSeek Bot through the feature matrix below.
- Use the Katcats.AI name and approved cat assets, including the supplied orange-S wordmark. Preserve licenses, a light default, saved theme preferences, complete dark styling and reduced-motion support.

## Initial implementation decisions

The following defaults resolve details not explicitly fixed by the user. They are implementation choices, not claims about Grok Bot or DeepSeek Bot, and may be adjusted without changing the confirmed product scope.

| Subject | Initial decision |
|---|---|
| Bot identity | Persist one member identity independently from its private Session and its per-group execution Sessions. Hide internal execution Sessions from the member list. |
| Model default | A Bot without an explicit choice uses the base model for its first request and then retains its Session selection. P1 supports fixed per-Bot choices. Automatic following of later global changes belongs to P4 and requires safe prompt-admission integration. |
| Files | Allocate default Bot and group folders inside the Katcats working root; allow an explicit project directory. Logical groups do not change paths or permissions. Directory changes preserve existing files. |
| Group replies | New groups include only explicitly selected Bots. A responsible member is optional and can be assigned conversationally. The transcript runs no coordinator model: real members answer or pass, with exact mentions routed directly. Save roles separately from private identities and other groups. Render member replies as individual chat bubbles with avatars and names. Make relay limits, pause, continue and stop explicit. |
| Memory | Separate Bot, group and team memory. Do not automatically inject raw private-chat history or private-chat summaries into a group; make cross-context sharing explicit. |
| Permissions | Use DSH tool and approval interfaces from the first executable feature. Bots cannot grant themselves additional access. File-location separation is not a claim of read isolation. |
| Lifecycle | Keep hiding, stopping current work and pausing schedules separate. Preserve shared files and historical references when a member is removed. |

## Stages

Each stage produces a runnable increment. A failed required check is resolved or explicitly classified before the next stage; scope does not expand into unrelated refactoring.

| Stage | Goal and deliverable | Tests and acceptance |
|---|---|---|
| P0: isolated baseline | Create a project-local development launcher, separate homes, temporary files, logs and Electron storage, with a development identity. Install project build dependencies independently, build the copied baseline and open an isolated preview. | A01–A02; synthetic conflicting-environment tests; no old profiles, credentials, command registration, protocol registration or update actions. Record actual build and startup results. |
| P1: members and sidebar | Add durable Bot and logical-group records, the fixed main Bot, the two default sections, quick creation, private chat and right-side settings. Reuse existing visual conventions and approved avatars. | A03–A06 (fixed model selection); domain and persistence tests, component tests, browser create/edit/restart checks, light and dark previews. |
| P2: conversational creation | Give the main Bot registered create/manage tools backed by the same member service as the menu. Let a Bot save its own lasting role through a real tool call. | A07; scripted model tool-call replay and failure cases; persistent role changes, no false success, no role change for a one-off task. |
| P3: group collaboration | Add group membership and settings, separate member execution Sessions, mention routing, natural responder selection, visible handoffs and recoverable relay pauses. | A08 and A09 execution controls; routing, multi-group and private-chat concurrency tests; browser two-member collaboration; member failure, departure and stop do not stall the group. Approval forwarding is completed with P4/A11. |
| P4: team capability parity | Complete private handoff chains, memory and knowledge, file deliverables, permissions and approvals, schedules, usage accounting and interrupted-work recovery. Retain existing Katcat tools through public interfaces. | A06 automatic following, A10–A13 and every feature-matrix row; scoped unit/integration/snapshot checks; synthetic secret handling and restart fixtures; visible failures and cancellation. |
| P5: product acceptance | Finish branding, empty/loading/error states, keyboard access, theme and motion behavior, then validate the independent desktop preview and real DeepSeek collaboration. Produce usage and verification notes. | Full relevant regression checks, current build artifacts followed by build checks, browser and unpackaged desktop review, and real-model A07–A09 using separately configured credentials. |

## Acceptance scenarios

The acceptance IDs define observable outcomes. Model replays verify orchestration deterministically; they do not substitute for the final real-model checks.

| ID | Scenario and required result |
|---|---|
| A01 | Supply fake inherited model keys, old homes and desktop flags. The launcher excludes them, confines state and cache paths to this project and never opens a protected location. Test path escapes and linked paths with synthetic fixtures. |
| A02 | Open the isolated preview with no copied credentials, then restart it. First-use state belongs to Katcats; missing models show setup guidance. Mock mode is explicit and cannot masquerade as a real-model pass. |
| A03 | Initial sidebar has a fixed main Bot and empty Ordinary Bots and Group Chats sections. Create and rename a custom Bot group, then move a Bot between groups without changing member identity, files or permissions. |
| A04 | Create a general Bot from the global menu and from a group's create button using a name and avatar. No model call is needed for creation; membership, selection and restart persistence are correct. |
| A05 | Edit avatar shape and color independently, using the approved seven cats and bright palette. The default is classic in #FF2849. Name and avatar update consistently in the sidebar, chat and details. |
| A06 | P1: a previously unused Bot resolves the current Katcats base model; creating one requires no model credentials. Test a fixed per-Bot override, an unavailable model, failures and a change during an active response. Only that Bot changes; other Bots and the global default remain unchanged. P4: verify automatic global following at prompt admission, including images, before exposing that choice. |
| A07 | Ask the main Bot to create a role, then assign a lasting identity to a manually created Bot. Actual tool results match saved records and UI. Restart retains roles; invalid requests and failed writes do not report success. |
| A08 | Create a group with two selected Bots without automatically adding the creator. Test optional manager selection, collaboration with no manager, and conversational assignment of a manager and member responsibilities. Restart retains group-local roles without changing private identities or other groups. Send a targeted task and complete a multi-step handoff with genuine member identities and visible results; internal Sessions do not appear as extra members. |
| A09 | Run the same Bot in two groups and privately. Test ordinary group messages, mentions, relay limits, pause/continue/stop, approval waits, slow work, one failed member and restart; contexts and outputs remain associated with the correct destination. |
| A10 | Produce a file privately and a shared group deliverable. Change the working folder without moving or deleting old files. File and command tools cannot bypass configured access limits or use another product's configuration. |
| A11 | Save, inspect, edit and recall Bot/group/team memories. Share context explicitly. Test approval allow/deny/cancel/expiry and ensure a Bot cannot change its own permission grants. |
| A12 | Create a scheduled task, pause/resume it, inspect usage and recover interrupted handoffs. Hiding a Bot, stopping current work and pausing its schedules have distinct tested effects. |
| A13 | Give a group a concrete task: one actual member saves a draft, another reads and reviews that file, and the first reads the review and saves the final deliverable. Open the final file from the group, inspect its content, and retrieve it through a later owner question. Test scripts must not create the members' output files. Speech, queued work and a usable delivered result have separate acceptance checks. |

## DeepSeek Bot feature matrix

A row passes only with implemented behavior and recorded evidence. Differences from the reference must be intentional and documented; existing Katcat capabilities are regression targets rather than features to rebuild.

| Capability | Owning stage | Required evidence |
|---|---|---|
| Member identity, creation, groups, settings and private chat | P1–P2 | A03–A07, persistence and tool-call snapshots |
| Group membership, routing, asynchronous work and relay control | P3 | A08–A09, multi-session and failure tests |
| Private delegation, task ownership, reporting and recovery | P3–P4 | Task-tree, cancellation, deduplication and restart checks |
| Working folders, files, attachments, knowledge and deliverables | P1/P4 | A10/A13 and existing file/preview regression checks |
| Memory scopes, history lookup and long-conversation continuity | P4 | A11, scope separation and fresh recall tests |
| Tool permissions, approvals and secure configuration | P0/P4 | A01/A11, synthetic grants and secret-request checks |
| Schedules, work status, stop controls and usage | P4 | A12, scheduling and accounting regression checks |
| Capability and MCP configuration, enabled skills and connector availability | P4 | Per-Bot configuration tests and explicit unavailable-service states |
| Secure credential requests and interactive forms or views | P4 | Synthetic secret inputs, tool-result cards and no secrets in model-visible history |
| Browser and desktop tools retained from Katcat | P0/P5 | Independent browser storage and existing tool regression checks |
| Brand, accessibility, rich results and desktop integration | P1/P5 | Theme screenshots, keyboard review, artifact and desktop checks |

## Verification and execution policy

- Run focused tests for each changed owner, typechecks and relevant recorded snapshots. A frontend change also uses the repository GUI and browser checks; complete the current artifact build before its build checks. Record commands and actual results, including baseline failures.
- Test persistent changes with temporary or synthetic data and explicit migration fixtures. Never use existing product data as a test fixture. Verify recovery after partial writes and interrupted work.
- Use an explicit Mock model for repeatable workflow tests. Run the final collaboration checks with a separately configured real DeepSeek model. Request configuration in the new settings UI when needed, never plaintext secrets in chat.
- After a stage passes, update its evidence and status, send a concise progress report, and continue. Ask only when missing information, an external credential or a materially destructive decision prevents safe progress; otherwise resolve ordinary implementation choices autonomously.
- Limit work to this copy. Do not read or write the original applications, their user data or environment configuration, `C:\Users\Administrator\.dsh`, or `C:\Users\Administrator\AppData\Roaming\Katcat-desktop`. Do not reuse their running services or logged-in browsers.
- Install only project build dependencies as needed; do not package, install, uninstall or publish a desktop product, push Git changes, or choose final release package IDs, app IDs, versions or release URLs. Development-only identifiers remain explicitly provisional.
- Use public DSH plugin APIs, slots and theme mechanisms without changing the DSH loop. The user approved the [Session-only model selection extension](proposals/session-model-scope.md), [prompt-model admission](proposals/prompt-model-admission.md), [exact-Session group transport](proposals/group-session-transport.md), [optional product UI presentation](proposals/product-ui-presentation.md), [group-member discovery](proposals/group-member-mentions.md), and [reusable current-Session permission picker](proposals/permission-picker-factory.md). These do not authorize unrelated core changes. Keep existing user changes, licenses and font notices.

## Current progress

The source copy is verified by [the copy report](../../KATCATS-COPY-VERIFICATION.json). The independent baseline build and desktop cold restart passed; [verification evidence](verification.json) records the checks actually run. Test counts from the earlier DeepSeek Bot project are not this project’s baseline.

| Stage | State | Evidence |
|---|---|---|
| P0 | Passed | 12 launcher tests, 157 desktop tests, identity check, all 9 build checks, and isolated preview with cold restart passed. |
| P1 | Passed | [P1 evidence](verification-p1.json): member and model checks, 31 Client tests, fresh browser creation/edit/cold restart, themes, real private reply, and current artifact/aggregate checks passed. |
| P2 | Passed | [P2 evidence](verification-p2.json): scoped tools, failure and cancellation checks, 33 Client tests, fresh browser cold replay, current build checks, and real DeepSeek creation and role saving passed. |
| P3 | Passed with direct member chat | [Collaboration verification](verification-collaboration.json) covers queued owner questions, renewed budgets after automatic pauses, stable delivery identities, manual Pause/Stop and per-group cold recovery. Real DeepSeek verified individual member replies and a writer–reviewer–writer task chain. [Current task-history verification](verification-main-home-and-collaboration.json) adds durable visible handoffs and actual public member speech before pending approval. [Earlier direct-chat evidence](verification-group-chat.json) covers attachments, approvals and themes; the original [P3 evidence](verification-p3.json) describes the previous coordinator flow. |
| P4 | In progress | Model following, scoped memory and executor approval access are implemented. A13 passed with actual draft, review and final files, working file links, follow-up retrieval and cold reopening; see [verification](verification-collaboration.json). Remaining capability parity, including group projection of inline rich tool results, is pending. |
| P5 | UI details verified; full product acceptance pending | [Interface verification](verification-interface.json) covers the sidebar, settings, welcome artwork, three input hints, linked automation lists and current-group member mentions. Remaining acceptance depends on P4. [Further interface verification](verification-interface-refinement.json) covers shared groups, context actions, safe deletion, the v2 import and exact supplied app icons. [Main-home verification](verification-main-home-and-collaboration.json) covers default entry, preserved history, welcome copy, composer simplification and scoped permissions in settings. |

## References

- [DSH architecture](../architecture.md) and [working-directory semantics](../subsystems/working-directory.md).
- [Desktop preview isolation](../../apps/desktop/README.md).
- Grok Bot: [member creation](https://docs.x.ai/grok-bot/bots), [collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration), and [shared computer](https://docs.x.ai/grok-bot/computer-and-apps).
