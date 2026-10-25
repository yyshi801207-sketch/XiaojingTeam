---
description: "Private Katcats member directory and team interface"
kind: "package-reference"
---

# Katcats team

English | [中文](README.zh.md)

## Summary

This private development package adds persistent members, logical Bot groups and direct member group chats to the existing Katcat shell. Its workspace package name is provisional and does not select a release identity. The [development plan](../../../docs/katcats/development-plan.md) defines the remaining product stages.

## Table of Contents

- [Configuration and ownership](#configuration-and-ownership)
- [Conversational members](#conversational-members)
- [Group conversations](#group-conversations)
- [Saved memories](#saved-memories)
- [Automation task lists](#automation-task-lists)
- [Persistence and recovery](#persistence-and-recovery)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Configuration and ownership

`workspaceRoot` is required and absolute. Each member receives a directory at `workspaceRoot/bots/<BotId>`; directory links are rejected before creation. `mainName`, `mainRole`, `ordinaryGroupName` and `chatGroupName` configure first-use labels. Moving a member between logical groups changes neither files nor Session identity.

Each private Session belongs to a DSH filesystem Workspace registered for that member's assigned directory. This registration enables the existing conversation and composer; it is independent of logical Bot groups. New members are published only after registration and Session attachment succeed. Startup repairs missing registrations or membership for existing members using their assigned directories, without replacing their Session IDs, moving files, or rewriting conversation history. Workspace identities remain in the existing DSH registry rather than adding fields to the member record.

The Host owns `ctx.katcatsTeam`; its generated Remote namespace is `katcatsTeam`. Owner-only commands read and follow snapshots, create members and groups, edit member identity and appearance, and rename, reorder or delete custom groups. Bot and group-chat entries share custom groups. Deleting a custom group first moves its chats to the system chat section in one group-directory write, then moves its Bots to Ungrouped and removes the section in one team-directory write. Interrupted or rejected writes preserve valid references and can be retried; the section remains if the second write fails. Bot and chat identities, Sessions and working files remain unchanged. The main member and the two system groups remain present. Quick creation needs only a name and optionally an approved avatar, and starts a general assistant without a model request.

New members follow DSH's current base model, without requiring credentials or catalog availability during creation. The prompt-admission hook resolves that policy before image validation; the resulting selection uses the [Session-only selection API](../session-controller/README.md) and never saves the application default or changes another Bot. Fixed choices retain their normalized override. Existing `follow-global` records now follow later base changes without rewriting member records. Owned group dispatch and continuation also resolve this policy; unrelated direct SDK, ACP or scheduled followups are outside this admission hook.

The Client replaces the workspace-list slot and registers a workspace category whose activation opens the same creation dialog. It retains the existing conversation, composer and right-sidebar tools; member settings occupy an additional tab. Explicit member navigation and newly created Bot or group conversations reveal settings from the matching composer's committed view, after the public sidebar surface is available, including blank conversations. Navigation and settings failures are reported separately. Ordinary members choose from seven robot silhouettes distinguished by finance role, independently of color. Existing shape IDs stay valid; choosing an icon does not change the Bot’s saved responsibilities. The main Bot uses the supplied Xiaojing portrait independently of its saved shape and color; its settings do not offer the ordinary appearance picker. Working directories are currently read-only in settings.

Each application open selects the existing main Bot conversation with its right sidebar collapsed, including first use, teams with no ordinary Bots and a saved expanded sidebar. Startup waits for both product directories and an addressable main Session; a catalog refresh or native saved selection cannot consume that choice early. Explicit Bot or group navigation supersedes the pending startup choice and remains selected across later directory updates and reconnection. Manually opening settings cancels a pending startup collapse. Startup does not create a separate general Agent conversation or clear the main Bot's history. Blank conversations show the supplied team artwork and personal-team tagline above the composer.

The sidebar shows the supplied main-Bot portrait in a larger unframed tile, and the same portrait appears in its conversation header and settings. Saved ordinary avatar values are unchanged; an ordinary group manager retains its robot avatar and separate diamond marker. The create-group control appears above custom groups, followed by group chats and Ungrouped; each section folds independently. Each custom group's menu moves it up or down within the saved custom-group order, or opens a deletion confirmation; boundary moves are disabled and system sections stay fixed. Order uses the existing group array and survives restart. Bot and chat entries share pin, move, rename, copy-ID and delete menus, available by their action button or context menu. Moving either entry changes only its logical group; its type's system section is always an available destination. Renaming uses a name-only dialog; deletion requires confirmation and accepts only acknowledged Host results. The list scrolls without a scrollbar and offers a button when more items remain below. The Katcats product composition labels the primary action Create new Bot, folds global tools by default, and places usage below them.

Deleting a Bot requires an idle private Session, no current group membership and no active automation or other reported Session activity. Deleting a group stops its owned work before removing its directory entry and dispatch journal; active automation must be stopped first. Both operations archive exact owned Sessions in the existing Workspace registry while retaining their history and working files. Failed directory writes roll back only the archive changes created by that deletion; an incomplete rollback is reported explicitly rather than claiming success. Retained memories and schedule records are not deleted.

Bot and group settings start at the existing minimum width and retain manual widths per settings provider for the current run. Bot, group and global settings use bold section headings. Forms scroll without a visible scrollbar; the group roster is collapsible. Dedicated main, ordinary Bot and group input hints use locale-owned copy and do not replace actionable blocked, unavailable, queued or plan-mode hints. Their composers hide workspace, preset, model and permission controls while keeping the original editor, attachments and sending. Model selection remains in Bot settings. Permissions use the original selector and risk confirmation in the settings panel: a Bot targets its private Session, and each group member row targets only that member's execution Session in this group. Neither changes the global default. Hidden panels, unavailable members and disconnections release group references; retained directories remain loading until fresh connection snapshots arrive. Missing group bindings never fall back to the transcript or private Sessions.

Group settings also offer one preset for all saved ordinary members, with one shared risk confirmation and individual rows retained. All exact group execution Sessions, permission projections and command access must be ready before selection. Unsaved settings, saving, hidden panels, unsupported legacy members and disconnections disable the batch. Members update sequentially through the public permission command; individual rows are locked during the batch. A changed roster or connection invalidates confirmation. Cancellation or an unconfirmed command stops remaining dispatch and reports each member as applied, not run, command unavailable or unconfirmed. Applied changes are not rolled back, and unconfirmed outcomes require checking the member's permissions. Private chats, other groups and global defaults remain unchanged. Automatic approval is unavailable when any target uses the finance preset.

Owner-sent messages use the light green sampled from the supplied chat reference and dark text in both themes. Avatar palette colors remain independent.

## Conversational members

The main Bot inspects the member roster, creates members with lasting roles and changes member avatars; it has no group-creation tool and does not automatically join or manage group chats. Each member can save only its own private role; tool discovery and execution both enforce the exact live Agent and its membership. Role text does not grant tools, change permissions, switch models or alter working directories. Quick creation remains a general assistant, and one-off work does not implicitly change its saved role.

Conversational creation uses the same serialized member operation as the menu, with the role and selected avatar included in the first durable creation intent. Results report the committed member rather than a proposed identity. Directory streams update the sidebar while the main conversation remains selected. Settings retain explicit drafts and save only edited fields, so saving an appearance change does not overwrite a role saved by a conversation tool. Web uses the existing generic tool cards for actual arguments and results.

The main-only `create_bot` accepts an optional `avatar` with `shape` and `color`; omission preserves `classic` and `#FF2849`. The main-only `set_bot_appearance` changes the identified member's saved avatar without changing its role, model, group, Session or working directory. Creation, roster, role-change and appearance-change results include the actual saved avatar.

`list_bots` labels the built-in default Bot group `未分组`, without renaming persisted groups or user-defined labels. Writing a color in role text does not apply an avatar change; the main Bot confirms appearance from the saved result.

Cancellation is checked before mutation admission. Once a durable intent has been accepted, the operation finishes consistency work even if the caller cancels. A cancelled, interrupted or failed result can therefore coexist with a saved member or appearance change. Tool guidance requires the main Bot to inspect the roster before retrying, without automatically repeating the change. Recovery reuses a matching unfinished intent; a new call after completed creation is a new operation, without an exactly-once guarantee.

## Group conversations

The separate `/chats` Host entry provides `ctx.katcatsChats` and the `katcatsChats` Remote namespace. It requires the same absolute `workspaceRoot`; `relayLimit` defaults to 16 task starts across all group members per round. Existing groups retain their saved limit. Each group uses `workspaceRoot/chats/<ChatId>`. New groups contain only explicitly selected ordinary Bots, with at least one member and an optional responsible member. The creator Bot is not inserted. The owner can select, change or clear the responsible member in group settings.

The group root Session is a transcript container and never makes a model request. The original composer uses an exact-Session transport registration to admit owner messages and stop group work. Its private, internal and unrelated Session routes remain unchanged. Each ordinary member has another Session for that group; two groups and a private conversation never share that member's Session. Group Sessions share the group's working directory. Their prompts use group-local responsibility overrides or saved member roles and public group context, without copying private-chat history. Internal execution Sessions do not become extra team-sidebar members.

An explicit member mention targets that member. Otherwise each current ordinary member receives one opportunity, with the optional responsible member first. Members decide whether to answer from their actual role and the group context; a successful pass tool ends an irrelevant turn without creating a chat bubble. A member's request to another member waits for that member's actual completed reply or confirmed pass. The tool returns the saved outcome and reply identity after publication, so its caller can use the result in the next model step. A busy target is refused immediately instead of creating a circular wait. Replies do not automatically start another broadcast round. Each dispatch applies the selected member's current model policy only to its group execution Session; the container and creator models are not involved.

The user can assign a responsible member and group-specific responsibilities in conversation. A currently executing member's scoped role tool saves the requested group settings before acknowledging them. Changes preserve private Bot identities, other groups, permission grants and historical sender snapshots. Owner settings replace the explicit role list; conversational updates replace only the named members' responsibilities.

Every member prompt includes the current group roster, Bot identities and effective group responsibilities. For work addressed to a multi-member group, business tools remain unavailable until another member has supplied an actual published result. `plan_group_work` records the responding member's own responsibility and selected colleagues' tasks; it does not dispatch them. Separate member requests perform those tasks, and every colleague in the recorded plan must return a completed result before integration tools become available in a new model step. A direct member request without a separate plan also requires its real result. `present` can register existing final files without starting new group work; an unfinished declared plan, same-step delegation, permissions and original file checks still apply. An explicit single-member mention, a one-member group or work already delegated by a colleague does not require another delegation. Greetings, group settings and scoped conversational memory remain ordinary conversation. The responding member chooses relevant colleagues; no separate coordinator model is inserted. Complete public handoff instructions remain readable in the group and can enter later member context, without being presented as assistant speech or importing private conversations.

One owned driver orders each group's initial member opportunities. Delegation tools remain exclusive and execute in order: a delegated member runs in its own idle executor while the calling member awaits its result, and one executor never accepts two running tasks. After a delegation, other tools from the caller's same model step are refused until a new step can read the real result. After the current member and its awaited dependencies finish, a queued owner input takes priority over old automatic handoffs and receives a fresh budgeted run; later inputs retain their order and stable message and request identities. A durable receipt retains the sender's name and avatar snapshot. The member Session is flushed before that receipt commits, and the reply is appended and flushed into the transcript without waking a root Agent. Stable input and reply identities prevent duplicate publication after retries. The Client displays each member's avatar and name beside an individual background, border and rounded message bubble, with corresponding dark-theme styling. Historical root responses retain their original attribution.

Ordinary group sends use `queue`: save and acknowledge the message without cancelling active members or their approvals. A busy member answers queued questions after its current execution and awaited results finish; no second model runs concurrently in that member's Session. Owner pauses, budget pauses and unconfirmed outcomes stay paused when a queued message arrives. Continue resumes a permitted paused run with its saved deliveries; a stopped or completed group starts a new run on its next ordinary message. Only the explicit Interrupt and adjust action or Host `mode: 'steer'` replaces the run: admit attachments and save the new instruction and run together, then cancel and drain the captured old execution chain and its approvals before starting the new run. Rapid sends serialize within that group without delaying another group. Saved messages, completed receipts and files remain; already started external effects cannot be rolled back. Identical request retries reuse the saved input without another interruption. Private conversation transports are unchanged. If saving fails before acceptance, the old run remains; if acceptance or cancellation cannot be confirmed, the group reports failure and stops dependent execution for inspection.

The composer dock displays actual running members through their avatar, name and individual working or approval phase. Multiple members rotate every four seconds; hovering, keyboard focus or a hidden document pauses rotation, and reduced motion lists them statically. Rotation does not announce each change to screen readers. A tiny neutral diamond marks the current saved group manager beside member messages, handoffs, task identities, approvals and group settings, matching Bot IDs while retaining historical sender names. Private and composite group avatars have no manager marker. Ordinary robot avatars reuse the seven existing hover motions on hover-capable pointers; reduced motion disables them. Owner messages use the green avatar color with dark text in main and ordinary Bot chats and groups, in both themes; Bot replies, handoffs and approvals keep their existing colors. Approval cards share the composer width and horizontal alignment.

Group status expresses whether member work is allowed, paused or stopped. The status and control row follows the composer's shared width and centering. Live activity reports the owned driver and actual executing members. Pause blocks new dispatch without cancelling work already running; a nested delegation awaiting dispatch keeps its caller waiting for Continue or Stop. Relay-budget exhaustion retains the unexecuted target for Continue in the same run. Ordinary owner messages stay queued without resetting that budget or resuming a paused run; explicit interruption starts a fresh budgeted run, supersedes pending work and drains the previous call chain before new execution while preserving history. Unknown results block automatic queued-input advancement; an explicit new steered instruction retains those outcomes for inspection. Manual and error pauses remain explicit for queued inputs. Pause guidance describes the saved reason: only an owner pause uses manual-pause guidance, and an unrecognized reason is not attributed to the user. Stop cancels the captured group run and waits for owned work and its original approvals to settle, without cancelling another group or a private conversation. Controls carry the expected run and generation so an old action cannot stop a later run. Pending controls apply only to their captured group, run and generation; a stale response cannot disable another group or a later run, or clear a newer pending action.

The group composer reports durable message acceptance as a system notice, separately from member speech. It names only members present in live group activity, distinguishes paused queues from active processing, and discards acknowledgements from old Session bindings or connections. The explicit interruption action uses the original editor submission, including attachments, mentions and failure recovery.

The sidebar mark beside each group name distinguishes actual execution, a member waiting for approval or confirmation, and completed collaboration with saved, published results. It reads only that group's current generation and original executor interactions. Empty groups remain idle; paused, stopped, failed, unconfirmed and synchronizing states never become completion marks. Tooltips describe the state, and the shared spinner respects reduced motion.

The independent `katcats_chats_v2` domain retains creation and setting intents, admitted owner messages and initial recipients, isolated Session bindings, member progress and completed receipts. Identical composer request IDs reuse saved inputs; changed content with the same ID is rejected before resolving uploads. Restart pauses unfinished work. Recovery reconciles proven member output and missing transcript publication; it does not automatically repeat work whose external result is unknown. Historical replies keep their captured identity after member settings or membership change. Moving a group changes only its saved section, including while its members are working; it does not rename Sessions or move files.

On the first v2 open, the product validates and imports the complete version-one `katcats_chats` record, including pending settings, message references, receipts and owner metadata. The predecessor remains unchanged. A failed import can be retried; once v2 has committed, later opens read only v2 and never fall back to v1. Missing manager, role or input fields retain their compatibility defaults; historical root tool positions become explicitly tagged tool sources. An existing creator member remains in its saved settings until edited, but receives no new dispatch. Existing execution bindings remain after membership changes; removing the old creator clears that manager selection, and new settings cannot add it again. Downgrade is unsupported.

A group composer’s `@` menu lists only current ordinary members, with their robot avatars and names. Selected references carry the group and Bot identities rather than a private Session identity. Serialization and Host admission recheck membership; another group, the creation Bot and removed members are rejected. Complete quoted file references and explicit paths do not target members; their original attachment text remains intact. Directory unavailability returns no candidates instead of falling back to global Sessions. Pointing to a member never reads private conversation history.

Every admitted task records its actual initiator, receiving member, instruction and lifecycle in the group transcript. A queued record confirms admission, not execution or completion; started and terminal records follow saved execution state. Member speech remains a separate message. Cancellation describes work stopped before dispatch; unknown means its external outcome needs inspection. Restored records show only states supported by saved data and are labelled as restored rather than displaying a fabricated historical execution time. Stable task-state identities suppress duplicates during retries and cold recovery. An unconfirmed transcript write pauses only that group and reports the error before more work is dispatched.

The per-group “Show handoff records and status” setting independently autosaves `showHandoffRecords` when clicked, without submitting or discarding other settings drafts. The preference takes effect after Host confirmation; a failed save retains the confirmed value. New groups explicitly enable it; older records without the field remain enabled and are read without migration or rewriting prior storage generations. When off, it hides that group's existing and subsequent handoff instruction and task-progress cards, while owner messages and actual member replies remain visible. Re-enabling displays the retained records again. The display-only update, including a Host update combined with a group move, is allowed during collaboration and preserves the run, generation, deliveries and Session logs without pausing work. Other settings retain their existing unsaved-edit and busy protections; changing the display preference never deletes history.

Completed member replies show original [delivery cards](../../client/ui-deliverables/README.md#explicit-deliveries) for files actually registered by `present`. The group verifies the original executor's recorded task claim and completed closing message, then renders the shared Factory under that executor's retained Session. Preview and native actions retain its filesystem authorization and event coordinates; model-authored paths do not create cards. Cards remain visible with handoff records disabled and after a member leaves while the group retains its original executor. Switching away or losing the connection releases the visible result's Session reference; reopening reconstructs cards from saved events without running a model.

Before tools can request approval, the group worker flushes and publishes the public text from its settled, tool-bearing assistant message, using that original message identity. Reasoning, interrupted output, private turns and the later final reply are excluded from this early publication. Approval can remain pending while that actual member speech is already visible; rejection or stopping does not retract it. Recovery republishes only missing messages and does not repeat tool work. Members are instructed to acknowledge tool-based work briefly before execution; a tool-only response remains speechless while its task record shows the actual state.

Unconfirmed member outcomes keep the group paused without automatic retries. Recorded execution errors, malformed model responses, output limits, cancellation and blocked steps have distinct fixed diagnostics; exception payloads are not copied into the group. The controls show a matching explanation once and retain the error code in collapsed details.

## Saved memories

The independent `/memory` Host entry owns `katcatsMemory` and the `katcats_memory` domain. Private conversations read their Bot scope and team scope; group members read their group scope and team scope. The transcript has no memory tools or model prompt. Members do not extract private conversation transcripts or summaries. Ordinary Bots write only the current scope; the private creator can also write team facts. Only the owner can copy a reviewed entry across scopes. Copies retain the selected source revision, author and timestamps, and later source edits or deletion do not change them.

The owner can inspect, search, edit, delete and explicitly share entries. Edits, deletion and sharing check the observed entry version. `maxEntries`, `maxEntriesPerScope`, `maxTextChars`, `recallLimit` and `maxPromptChars` configure retained and model-visible limits. Incompatible capacity reductions fail visibly instead of discarding data. Tool acknowledgements follow durable writes; cancellation after admission can coexist with a saved entry, so inspect an uncertain outcome before retrying.

Group approvals refer to the original executing Session's pending request. The product exposes its offered choices and cancellation lifecycle instead of granting access or moving the request into the transcript. Stopping a group continues to cancel its owned work while an approval waits.

## Automation task lists

The automation button in Bot or group settings opens a list scoped to that settings Session, without a search field. The central Automations page groups all retained tasks by Bot or group and keeps unmatched records under Unlinked tasks; only this page offers search across task names, instructions and owner names. Both views retain active and inactive status filters, share one public Schedule catalog and refresh on task changes or connection resets; opening a list does not start an Agent or read Session history.

Task ownership comes from the stored Session binding: a private member Session belongs to that Bot; a group root or retained executor Session belongs to that group, including an executor whose member has since left. Group-created tasks do not appear in the member's private list. Renaming a Bot or moving it between logical groups does not rewrite tasks. Existing task identities, Session bindings, timing and delivery history remain in the Schedule domain without migration. Opening a task uses its original Session binding in the existing Schedule detail, which owns editing, deletion and saved-delivery history.

The settings form remains mounted when its automation list or a task detail opens, preserving unsaved edits while that settings tab remains retained. The catalog shows retained task and delivery state, not confirmed execution results; the [limitations below](#known-limitations-and-deferred-work) describe group scheduling support.

## Persistence and recovery

The new `katcats_team` storage domain has version 1 and no migration from another product. A single atomic global record holds groups, members and interrupted-operation state. A member appears only after its private Session is durable. `pendingRename` holds the complete target for title or model settings until the Session flush and member record both commit. Refused model input with no Session change clears that target. An accepted or uncertain model switch retains its target on failure and reports incomplete settings; a later snapshot or restart retries it without reporting success early. Pure title failures restore the old title when possible. Unknown versions and invalid identities fail instead of resetting data.

Member identity is independent of its private Session ID. The plugin uses public Session APIs and scoped prompt sections; it does not modify the agent loop. Fixture tests use temporary directories and synthetic model adapters, separately from development user data.

## Model Experience

### Member identity

#### What the model sees

The member's saved name and role replace the product persona section for that member's private Agent. With no role, the prompt uses this literal:

##### General-assistant role

```markdown
You are a general assistant. Work with the user to establish your role.
```

#### Token effect

The name and current role contribute to each assembled system prompt. Editing a role changes the next assembly; it does not rewrite a request already in progress. The existing system-message events record the effective text.

#### KV Cache effect

Unchanged member identity preserves this prompt section. Editing the name or role replaces its text and may invalidate the affected prompt prefix.

### Model selection

#### What the model sees

Fixed-model changes use the existing [Agent model-selection mechanism](../../core/agent/README.md): the next admitted request records its model-switch notice and route in the Session log. They do not rewrite earlier requests or messages.

#### Token effect

A route change adds the existing model-switch notice to the next admitted request. Choosing a model does not itself run a model request.

#### KV Cache effect

Choosing another model may move the request to a different provider cache; provider caching and eviction remain outside this package.

### Conversational tools

#### What the model sees

Member-tool schemas enter only the owning Agent's requests. Their calls and structured results use the existing tool log; role changes enter the next assembled identity section. Tool guidance requires an explicit lasting-identity request and reserves ordinary tasks for the current conversation.

#### Token effect

Tool schemas, results and saved roles consume request tokens; the main and ordinary members have different tool sets.

#### KV Cache effect

The owning member retains its stable tool definitions; changing a saved role changes the identity prefix on the next assembly.

### Group chat

#### What the model sees

Member requests add the group roster, saved roles, reply-or-pass guidance and public group messages. Delivery guidance asks for usable full text for writing tasks, or a successful `present` registration and brief summary for requested files; delivering an existing finished file again requires no new plan or rewrite. Delegation tool results contain the confirmed member outcome and reply rather than a queue acknowledgement. These inputs use normal prompt and message logging. A member's output is a real result from its group Session and is published with its captured sender identity. The transcript has no model persona or model requests.

#### Token effect

Only actual member requests consume model tokens, including turns that choose to pass. Group task context includes saved public member replies and grows with that group's completed work.

#### KV Cache effect

Changing the roster or guidance can invalidate the affected prompt prefix; unchanged member identities preserve their own prefix within each isolated Session.

### Scoped memories

#### What the model sees

Scoped memory tools and serialized entries use the public tool and system-prompt mechanisms and normal request logs. Saved facts are untrusted data, grant no permissions, and cannot select another Bot's scope. The prompt reports omitted entries, and recall can retrieve saved facts excluded from its bounded context.

#### Token effect

Memory schemas, selected entries and recall results consume tokens within the configured limits. Deleting a fact does not erase earlier requests that already recorded it.

#### KV Cache effect

Changing visible memory replaces its prompt section and may invalidate the affected prefix; unchanged entries keep stable serialized content.

## Known Limitations and Deferred Work

- Dynamic model following covers product prompt admission and owned group dispatch or continuation, without changing unrelated direct SDK, ACP or scheduled followups.
- Group Stop waits for any model-selection metadata lookup already admitted through the public Session API to settle; that API does not accept cancellation. No member model request is dispatched after the captured run has stopped.
- Group receipts publish final member text, Markdown file links and original cards for completed replies' registered final files. Inline visualizations and other tool-result cards remain in the executor's Session. A successful file registration followed by an error or interruption without a completed closing reply stays saved in that Session but has no final group card; inspect the saved result before retrying.
- Recall uses case-insensitive substring matching without embeddings. Credential-pattern rejection is heuristic: it neither echoes nor saves recognizable secrets in memory but cannot erase input already authored in a message or tool call. Deletion preserves earlier shared copies and request logs.
- Automation lists associate existing Schedule records with Bots and groups. Scheduled group execution is not connected: the Schedule service delivers directly to the original Session, while group members accept only product-owned group work. Listing a task or retaining a delivery receipt does not confirm that the task ran or completed. Private handoffs, group schedule delivery and broader capability parity remain in the development plan.
- Settings display the creation-owned work directory. Changing an existing member's directory requires the later file and permission lifecycle work.

### Dev Note

None.
