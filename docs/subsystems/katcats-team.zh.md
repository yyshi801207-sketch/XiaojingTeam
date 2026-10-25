# Katcats 团队

[English](katcats-team.md) | 中文

本参考页收录 Katcats 私有成员、群聊和作用域记忆服务。[包参考](../../packages/api/katcats-team/README.zh.md)定义配置、权限、Session 归属、持久化与模型行为；包身份属于临时标识。

## 数据归属

| 来源 | 记录 |
|---|---|
| [成员类型](../../packages/api/katcats-team/src/types.ts) | Bot 身份、逻辑分组、成员设置与名录流值 |
| [群聊类型](../../packages/api/katcats-team/src/chats-types.ts) | 群成员、独立 Session 绑定、协调策略、活动与已完成派活回执 |
| [记忆类型](../../packages/api/katcats-team/src/memory-types.ts) | 作用域条目、作者、所选来源版本、用户审阅后创建的副本与记忆流 |

[开发计划](../katcats/development-plan.zh.md)区分已实现能力与待验收工作。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxkatcatschats--katcatschats"></a>

### `ctx.katcatsChats` — `KatcatsChats`

Persistent groups and owner controls; model execution belongs to the composed group runtime.

```ts cordis-catalog
/**
 * Read a group's Session binding without executing work or entering the mutation queue.
 * Historical executor bindings remain after member removal; callers must check current membership.
 * @param sessionId - transcript or executor Session identity, including accepted pending creation.
 * @returns the group and executor identity, or undefined for a Session outside the group directory.
 */
binding(sessionId: SessionId): { chatId: ChatId; botId: BotId | 'root' } | undefined

/**
 * Read committed groups after recovering any accepted create/settings target.
 * @returns the owner directory and current public Agent activity.
 */
@Remote async snapshot(): Promise<ChatSnapshot>

/**
 * Admit the original composer's message into a pure group transcript and schedule actual members.
 * Identical request retries reuse the durable input; a changed retry is rejected before resolving uploads.
 * Steering atomically replaces the run before cancelling and draining its owned work; explicit queue requests retain normal queuing.
 * @param request - owner message targeting the group's exact transcript Session.
 * @param signal - cancellation before durable input acceptance.
 * @returns confirmation after the owner message is flushed and any interrupted work settles; member replies arrive separately.
 */
@Remote async sendMessage(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue>

/**
 * Stop the current group work from the original composer, using a fresh captured run generation.
 * @param request - the exact transcript Session selected when Stop was pressed.
 * @returns confirmation after owned member work and approvals have settled.
 */
@Remote async cancelSession(request: SessionCancelRequest): Promise<SessionCancelValue>

/**
 * Follow directory and live activity replacements, including activity-only changes.
 * @param signal - caller-owned cancellation.
 * @returns a baseline and later complete replacements until disconnect or plugin disposal.
 */
@Remote({ mode: 'stream' }) async *follow(signal: AbortSignal): AsyncIterable<ChatFrame>

/**
 * Create an isolated group and one persistent execution Session per selected ordinary member.
 * @param request - name, ordinary members, and optional positive dispatch limit.
 * @returns the fully committed group and replacement directory.
 */
@Remote async createChat(request: CreateChatRequest): Promise<ChatMutationValue>

/**
 * Update group settings while idle or paused without replacing any existing Session identity.
 * Grouping and transcript-presentation updates use one directory write and may run while members are working.
 * @param request - group identity and explicit settings to replace.
 * @returns the committed group and replacement directory.
 */
@Remote async updateChat(request: UpdateChatRequest): Promise<ChatMutationValue>

/**
 * Stop one group's owned work and remove its directory and dispatch journal, retaining Sessions and files.
 * @param request - group identity; active scheduled tasks must be stopped first.
 * @returns the replacement group snapshot after durable removal.
 */
@Remote async deleteChat(request: DeleteChatRequest): Promise<ChatSnapshot>

/**
 * Request a pause after currently dispatched work without cancelling its result.
 * @param request - group and the exact run generation displayed by the owner.
 * @returns the accepted policy and actual current Agent activity.
 */
@Remote async pause(request: ChatControlRequest): Promise<ChatMutationValue>

/**
 * Grant another dispatch window and explicitly continue a paused or stopped group.
 * @param request - group and the exact run generation displayed by the owner.
 * @returns the committed policy and immediately renderable directory.
 */
@Remote async resume(request: ChatControlRequest): Promise<ChatMutationValue>

/**
 * Invalidate this run, cancel only its captured work, and await its owned drivers.
 * @param request - group and the exact run generation displayed by the owner.
 * @returns the stopped policy after cancellation settles.
 */
@Remote async stop(request: ChatControlRequest): Promise<ChatMutationValue>
```

Types: [SessionCancelRequest](session.zh.md) · [SessionCancelValue](session.zh.md) · [SessionId](core.zh.md) · [SessionPromptRequest](session.zh.md) · [SessionPromptValue](session.zh.md)

Source: [`packages/api/katcats-team/src/chats.ts`](../../packages/api/katcats-team/src/chats.ts)

<a id="ctxkatcatsmemory--katcatsmemory"></a>

### `ctx.katcatsMemory` — `KatcatsMemory`

Persistent entries remain isolated by conversation; only the owner may copy between scopes.

```ts cordis-catalog
/** Read saved entries in one explicitly selected scope without reading Session history.
 * @param request - owner-selected scope and optional saved-text query.
 * @returns the complete matching scope result.
 */
@Remote async list(request: MemoryListRequest): Promise<MemoryList>

/** Follow saved entries after committed changes; retained text never includes chat transcripts.
 * @param request - owner-selected scope and optional query.
 * @param signal - cancellation owned by the subscribing client.
 * @returns complete scope replacements until disconnect or plugin disposal.
 */
@Remote({ mode: 'stream' }) async *follow(request: MemoryListRequest, signal: AbortSignal): AsyncIterable<MemoryFrame>

/** Save an owner-authored fact after validating its scope and rejecting credential-shaped text.
 * @param request - selected scope and one lasting fact.
 * @param signal - cancellation checked before accepting a durable write.
 * @returns the entry only after its write succeeds.
 */
@Remote async save(request: MemorySaveRequest, signal?: AbortSignal): Promise<MemoryMutationValue>

/** Replace the text of the exact observed entry revision, preserving attribution and source.
 * @param request - entry identity, observed version, and replacement text.
 * @param signal - cancellation checked before accepting a durable write.
 * @returns the durably updated entry.
 */
@Remote async edit(request: MemoryEditRequest, signal?: AbortSignal): Promise<MemoryMutationValue>

/** Remove the selected revision without deleting copies previously shared by the owner.
 * @param request - entry identity and observed version.
 * @param signal - cancellation checked before accepting a durable write.
 * @returns the confirmed deletion.
 */
@Remote async delete(request: MemorySelectRequest, signal?: AbortSignal): Promise<MemoryDeleteValue>

/** Copy one reviewed entry to another scope, retaining its source author and timestamps.
 * @param request - exact source revision and an explicit destination.
 * @param signal - cancellation checked before accepting a durable write.
 * @returns the new durable copy; editing or deleting the original does not change it.
 */
@Remote async share(request: MemoryShareRequest, signal?: AbortSignal): Promise<MemoryMutationValue>
```

Source: [`packages/api/katcats-team/src/memory.ts`](../../packages/api/katcats-team/src/memory.ts)

<a id="ctxkatcatsteam--katcatsteam"></a>

### `ctx.katcatsTeam` — `KatcatsTeam`

Team metadata and private Sessions, with durable interrupted-creation recovery.

```ts cordis-catalog
/**
 * Read the complete product directory, finishing accepted creation and Session-setting intents first.
 * @returns the persisted member and group snapshot.
 */
@Remote async snapshot(): Promise<TeamSnapshot>

/**
 * Follow complete durable directory replacements, starting with a baseline.
 * @param signal - caller-owned stream cancellation.
 * @returns one baseline and later committed snapshots until cancellation.
 */
@Remote({ mode: 'stream' }) async *follow(signal: AbortSignal): AsyncIterable<TeamFrame>

/**
 * Read the current owner of a private Session without entering the mutation queue.
 * @param sessionId - private Session identity to match, including pending creation.
 * @returns the persisted member, or undefined for a Session outside the private directory.
 */
memberForSession(sessionId: SessionId): TeamBot | undefined

/**
 * Resolve one member's committed model policy without entering the mutation queue.
 * Pending creation is visible; an incomplete setting target retains its previous policy.
 * @param botId - member whose private or group task is being admitted.
 * @returns the current base for followers, or the member's explicit fixed route.
 */
modelSelection(botId: BotId): ModelSelection

/**
 * Create a general member and a durable ordinary private Session.
 * A retry matching a still-pending name, group, avatar, and empty role returns that recovered member.
 * @param request - member name, optional group, and optional approved avatar.
 * @returns the committed member and replacement snapshot.
 */
@Remote async createBot(request: CreateBotRequest): Promise<BotMutationValue>

/**
 * Update member settings and synchronize title or model policy changes with the private Session.
 * Refused model input is discarded; an accepted or uncertain switch retains its target until both stores commit.
 * Pure title failures restore the old title when possible and retain their target for recovery.
 * @param request - member identity and explicit fields to replace.
 * @returns the committed member and replacement snapshot.
 */
@Remote async updateBot(request: UpdateBotRequest): Promise<BotMutationValue>

/**
 * Remove an idle, unreferenced ordinary Bot while retaining its Session and files.
 * @param request - ordinary Bot identity; main Bots, group members and active tasks reject.
 * @returns the replacement member directory after archival and durable removal.
 */
@Remote async deleteBot(request: DeleteBotRequest): Promise<TeamSnapshot>

/**
 * Create a logical group for ordinary members.
 * @param request - non-empty group name.
 * @returns the committed group and replacement snapshot.
 */
@Remote async createGroup(request: CreateGroupRequest): Promise<GroupMutationValue>

/**
 * Rename an ordinary user-created group.
 * @param request - group identity and replacement name.
 * @returns the committed group and replacement snapshot.
 */
@Remote async updateGroup(request: UpdateGroupRequest): Promise<GroupMutationValue>

/**
 * Move one custom group within the saved custom-group order; system group positions remain unchanged.
 * @param request - group identity and one adjacent position to move.
 * @returns the committed directory; rejects system groups and moves beyond either end.
 */
@Remote async moveGroup(request: MoveGroupRequest): Promise<TeamSnapshot>

/**
 * Move chats to their system group before removing a custom group and moving its Bots.
 * The two durable writes preserve valid references if interrupted and can be retried.
 * Member identities, private Sessions and files remain unchanged.
 * @param request - group identity to remove.
 * @returns the replacement directory snapshot.
 */
@Remote async removeGroup(request: RemoveGroupRequest): Promise<TeamSnapshot>
```

Types: [ModelSelection](core.zh.md) · [SessionId](core.zh.md)

Source: [`packages/api/katcats-team/src/index.ts`](../../packages/api/katcats-team/src/index.ts)
<!-- END GENERATED cordis-surface -->
