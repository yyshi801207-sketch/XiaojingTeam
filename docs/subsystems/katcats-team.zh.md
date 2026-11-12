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
 * Accept an archive task after the owner inspects its published result.
 * @param chatId - Group owning the task.
 * @param taskId - Task chosen in the archive.
 * @param expectedRevision - Exact delivered revision shown to the owner.
 * @param acceptanceRequestId - Saved ambiguous chat instruction resolved by this choice, if any.
 * @returns The group and directory after acceptance.
 */
@Remote async completeTask(chatId: ChatId, taskId: GroupTicketId, expectedRevision: number, acceptanceRequestId?: SessionRequestId): Promise<ChatMutationValue>

/**
 * Read the verified accounting connection selected in this group's settings.
 * @param chatId - Existing group identity.
 * @returns The binding identity, or null when the group has no enabled connection.
 */
@Remote async financeBinding(chatId: ChatId): Promise<FinanceConnectorId | null>

/**
 * Change the group's verified accounting connection while the group has no saved run.
 * @param chatId - Existing group identity.
 * @param connectorId - Verified connection or null to remove access.
 * @param expectedBinding - The prior binding a prepared handoff may replace. Omit for a direct settings change.
 */
@Remote async bindFinance(chatId: ChatId, connectorId: FinanceConnectorId | null, expectedBinding?: FinanceConnectorId | null): Promise<void>

/**
 * Verify this group’s bound ledger and publish the main Bot’s welcome on success.
 * @param chatId - Group containing the bound ledger.
 * @param connectorId - Connection selected in the group’s settings.
 * @param signal - Cancels verification before the welcome is accepted.
 * @returns The verified connector or its recorded failure.
 */
@Remote async connectFinance(chatId: ChatId, connectorId: FinanceConnectorId, signal: AbortSignal): Promise<FinanceConnector>

/**
 * Admit the original composer's message into a pure group transcript and schedule actual members.
 * Identical request retries reuse the durable input; a changed retry is rejected before resolving uploads.
 * Queue requests preserve active work and pauses; stopped groups start a new run. Steering replaces the run and drains its old work.
 * @param request - owner message targeting the group's exact transcript Session.
 * @param signal - cancellation before durable input acceptance.
 * @returns confirmation after the owner message is flushed and any interrupted work settles; member replies arrive separately.
 */
@Remote async sendMessage(request: SessionPromptRequest, signal: AbortSignal): Promise<ChatPromptValue>

/**
 * Continue the explicitly selected archived task. A paused matching run resumes its saved work.
 * An idle group admits a new owner instruction bound to the original task and responsible member.
 * @param request - Exact task revision, group run, and retry identity shown to the owner.
 * @param signal - Cancels the request before the continuation is accepted.
 * @returns The saved group and current archive activity.
 */
@Remote async continueTask(request: ContinueGroupTaskRequest, signal: AbortSignal): Promise<ChatMutationValue>

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
 * Newly created groups precede existing groups in the durable directory.
 * @param request - name, ordinary members, and optional sidebar folder and positive dispatch limit.
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

Types: [SessionCancelRequest](session.zh.md) · [SessionCancelValue](session.zh.md) · [SessionId](core.zh.md) · [SessionPromptRequest](session.zh.md)

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
 * Read the finance connector directory for the product owner.
 * @returns the redacted directory, or null when the deployment disables finance connectors.
 */
@Remote async financeSnapshot(): Promise<FinanceConnectorSnapshot | null>

/**
 * Follow the owner’s finance connector catalog and observed access status.
 * @param signal - Cancels delivery when the client disconnects.
 * @returns The baseline catalog and later replacements, or null when finance connectors are disabled.
 */
@Remote({ mode: 'stream' }) async *followFinance(signal: AbortSignal): AsyncIterable<FinanceConnectorSnapshot | null>

/**
 * Discover companies accessible to an Odoo credential.
 * @param input - proposed destination and credential.
 * @param signal - cancels discovery if the owner leaves the page.
 * @returns the companies available for selection.
 */
@Remote async discoverFinanceCompanies(input: FinanceConnectionDraft, signal: AbortSignal): Promise<readonly FinanceCompany[]>

/**
 * Verify and persist a finance connector with its selected access mode.
 * @param input - configuration and selected company.
 * @param signal - cancels verification before the accepted save.
 * @returns the saved configuration with its key omitted.
 */
@Remote async saveFinanceConnector(input: SaveFinanceConnectorRequest, signal: AbortSignal): Promise<FinanceConnector>

/**
 * Test an existing connector against its stored company.
 * @param id - the connector to test.
 * @param signal - cancels the test without replacing its last result.
 * @returns the updated public test status.
 */
@Remote async testFinanceConnector(id: FinanceConnectorId, signal: AbortSignal): Promise<FinanceConnector>

/**
 * Delete an unbound finance connector.
 * @param id - the connector to remove.
 */
@Remote async deleteFinanceConnector(id: FinanceConnectorId): Promise<void>

/**
 * Read the ledger bound to a dedicated finance Bot's private conversation.
 * @param botId - Existing dedicated finance Bot identity.
 * @returns Its verified connection identity, or null when unbound.
 */
@Remote async financeBotBinding(botId: BotId): Promise<FinanceConnectorId | null>

/**
 * Bind one verified ledger for a dedicated finance Bot's private queries.
 * @param botId - Existing dedicated finance Bot identity.
 * @param connectorId - Verified connection, or null to unbind.
 */
@Remote async bindFinanceBot(botId: BotId, connectorId: FinanceConnectorId | null): Promise<void>

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
 * New members precede existing ordinary members; an omitted group uses 未分组.
 * A retry matching a still-pending name, group, avatar, and empty role returns that recovered member.
 * @param request - member name, optional explicit group, and optional approved avatar.
 * @returns the committed member and replacement snapshot.
 */
@Remote async createBot(request: CreateBotRequest): Promise<BotMutationValue>

/**
 * Provision the private Odoo administration Bots for the ledger setup plugin.
 * Existing private Sessions are retained while their fixed identities are synchronized.
 * @returns Once both private Bot records and their Sessions are saved.
 */
async ensureOdooAdminBots(): Promise<void>

/**
 * Resolve the original creator tool to the already provisioned ledger Bot.
 * @param agent Live main Bot authorized to locate the fixed ledger assistant.
 * @param signal Cancels the lookup.
 * @returns The saved ledger Bot and its private Session.
 */
async ensureLedgerSetupBot(agent: Agent, signal: AbortSignal): Promise<TeamBot>

/**
 * Save a versioned finance roster once, resuming its allocated identities after interruption.
 * Existing saved roles, model selections and names remain editable and are not reset by a retry.
 * @param agent Live main Bot requesting the team.
 * @param template Fixed compact or standard definition.
 * @param name Requested group name identifying this creation within its sidebar folder.
 * @param groupId Selected custom folder, or undefined for default member/chat placement.
 * @param signal Cancels before the next durable member is accepted.
 * @returns Saved ordered members, with the finance manager first.
 */
async createFinanceTeamMembers(agent: Agent, template: FinanceTeamTemplate, name: string, groupId: GroupId | undefined, signal: AbortSignal): Promise<readonly TeamBot[]>

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
 * Create a logical group before existing custom groups, retaining system-group order.
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

Types: [Agent](core.zh.md) · [ModelSelection](core.zh.md) · [SessionId](core.zh.md)

Source: [`packages/api/katcats-team/src/index.ts`](../../packages/api/katcats-team/src/index.ts)

<a id="ctxxiaojingledgersetup--xiaojingledgersetup"></a>

### `ctx.xiaojingLedgerSetup` — `XiaojingLedgerSetup`

Stores setup plans before Odoo writes and checkpoints the confirmed company ID before initialization.

```ts cordis-catalog
/**
 * Read redacted setup configuration and plans.
 * @returns The database status and saved setup plans.
 */
@Remote async snapshot(): Promise<LedgerSetupSnapshot>

/**
 * Follow saved setup changes after the initial snapshot.
 * @param signal Client connection lifetime.
 * @returns Redacted snapshots of the setup database and plans.
 */
@Remote({ mode: 'stream' }) async *follow(signal: AbortSignal): AsyncIterable<LedgerSetupSnapshot>

/**
 * Verify and save a database-level setup credential without selecting a company.
 * @param request Address, database and an optional replacement key for the same destination.
 * @param signal Cancels verification before settings are committed.
 * @returns The redacted setup snapshot.
 */
@Remote async saveConnection(request: LedgerSetupConnectionInput, signal: AbortSignal): Promise<LedgerSetupSnapshot>

/**
 * Resolve the available Odoo template choices without changing server data.
 * @param request Country and currency codes confirmed for this proposed plan.
 * @param signal Tool execution lifetime.
 * @returns The matching Odoo country, currency and installed templates.
 */
choices(request: { countryCode: string; currencyCode: string }, signal: AbortSignal): Promise<OdooSetupChoices>

/**
 * Discover the companies accessible to the saved administration account.
 * @param signal Tool execution lifetime.
 * @returns The verified database name and accessible company summaries.
 */
adminCompanies(signal: AbortSignal): Promise<{ readonly database: string; readonly companies: readonly FinanceCompany[] }>

/**
 * Call a role-scoped Odoo administration method after confirming its exact write target and arguments.
 * @param role Fixed Bot responsibility derived from the private Session.
 * @param request Odoo model, method, arguments and optional selected company.
 * @param confirm Obtains explicit user approval before a mutation is sent.
 * @param signal Tool execution lifetime.
 * @returns The verified database and company scope with the Odoo response.
 */
adminCall(role: 'ledger' | 'access', request: FinanceOrmCallRequest & { readonly companyId?: number }, confirm: (details: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<void>, signal: AbortSignal): Promise<{ readonly database: string; readonly company: FinanceCompany | null; readonly model: string; readonly method: string; readonly data: FinanceOrmJsonValue }>

/**
 * Save a reviewable draft from the dedicated assistant without changing Odoo.
 * @param request Proposed company settings and template selection.
 * @param signal Tool execution lifetime.
 * @returns The persisted draft or identical existing plan.
 */
propose(request: LedgerSetupDraftInput, signal: AbortSignal): Promise<LedgerSetupPlan>

/**
 * Validate an uploaded chart and save its normalized rows on the expected draft.
 * @param id Setup plan that receives the workbook.
 * @param expectedRevision Plan revision reviewed before the upload.
 * @param fileName Workbook label displayed on the approval.
 * @param workbookBase64 XLSX bytes encoded by the owner UI.
 * @returns The redacted snapshot after the workbook is accepted.
 */
@Remote async uploadChart(id: LedgerSetupPlanId, expectedRevision: number, fileName: string, workbookBase64: string): Promise<LedgerSetupSnapshot>

/**
 * Execute the owner-approved plan and durably record the resulting company and readiness.
 * @param id Plan to execute.
 * @param expectedRevision Exact revision presented for confirmation.
 * @param signal Cancels work before writes or leaves the dispatched step for reconciliation.
 * @returns The current snapshot including the plan's settled status.
 */
@Remote async execute(id: LedgerSetupPlanId, expectedRevision: number, signal: AbortSignal): Promise<LedgerSetupSnapshot>

/**
 * Verify a separate bookkeeping account and publish its company in finance connectors.
 * @param id Ready plan to add.
 * @param request Access mode and bookkeeping account key.
 * @param signal Cancels account verification before the connector save is accepted.
 * @returns The redacted snapshot with registration confirmed after the connector is saved.
 */
@Remote async addConnector(id: LedgerSetupPlanId, request: LedgerSetupConnectorInput, signal: AbortSignal): Promise<LedgerSetupSnapshot>
```

Source: [`packages/api/katcats-team/src/finance-setup.ts`](../../packages/api/katcats-team/src/finance-setup.ts)
<!-- END GENERATED cordis-surface -->
