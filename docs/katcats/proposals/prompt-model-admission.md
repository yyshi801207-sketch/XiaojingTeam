# Prompt model admission proposal

English | [中文](prompt-model-admission.zh.md)

Status: the user separately approved this extension for the independent Katcats copy, beyond the earlier [Session-only selection scope](session-model-scope.md). The two-file API change is applied, together with the Katcats model policy and focused source tests. Installed applications, real user configuration and Agent instructions remain untouched. Final generated artifacts and built integration checks are owned by the P4 integration step.

## Verified limitation

The [default-model service](../../../packages/core/agent-default-model/src/index.ts) exposes a current selection getter. [Settings notifications](../../../packages/settings/settings/src/types.ts) contain a namespace and revision and do not await listeners. Neither provides an awaited opportunity to update following Sessions before prompt admission. A used Session can retain its latest request model through the API-owned [selection reference](../../../packages/api/session-controller/src/agent.ts).

[Prompt admission](../../../packages/api/session-controller/src/commands.ts) checks image support against that reference before accepting attachments and enqueueing a message. A routing-only or prompt-assembly policy can run after this check. Appending an event alone also leaves the loaded reference unchanged.

## Proposed API change

The [unapplied patch](prompt-model-admission.patch) changes two existing API files. It declares the Host-only, Agent-scoped synchronous waterfall `api-session/prompt-model`: its payload is the real `Agent`, its result is `ModelSelection | undefined`, and the terminal `next()` returns `undefined`. Listeners call `next()`; an owning policy can return its own detached selection, while unrelated or fixed-model Agents delegate unchanged. Registration uses an effect-owned scoped context and disappears when that context unloads.

`SessionCommandController.prompt` invokes the waterfall inside the existing per-Agent admission queue, before the image-model check. A private helper shares availability checks, reasoning-effort validation and normalization with `selectModel`. An accepted policy uses existing `selectForNextRequest` to append `model/selection` and update its loaded reference; image admission then reads that reference. The hook never recursively calls `selectModel`, never saves the application default, and introduces no new Session event or storage format. Explicit selection scopes and background default-save behavior remain unchanged.

A Katcats provider would synchronously read already-open member metadata and `agentDefaultModel.currentSelection()`. It must not await the Team mutation queue, perform persistence, or enqueue selection from the callback. This avoids acquiring the Team queue while holding Session admission, opposite to existing Bot-setting operations. Enabling automatic following for existing unoverridden Bots remains a separate product decision; this API patch alone does not enable it.

## Ordering and failures

The patch serializes text admission with image admission and explicit selection. Even without a policy, concurrent text submissions for one Agent can wait for earlier attachment admission; previously only image submissions used this queue. An in-queue request-id check prevents a queued duplicate from applying the policy or enqueueing twice. Different Agents retain separate queues.

A valid policy selection can be logged before a later unsupported-image, file-receipt or attachment failure. Selection does not mean prompt acceptance; existing errors and attachment-ownership checks still decide acceptance. An unavailable model or invalid effort produces existing `session/model-unavailable` before installing the invalid selection. The patch does not pin a model to each queued message, change an in-flight request, or override a later explicit selection; existing step assembly captures the selection and logs switch notices.

## Affected consumers and exclusions

- [SessionController](../../../packages/api/session-controller/src/index.ts) is the production caller of the changed command. Remote requests, responses, authorization and strict wire decoding stay unchanged. The event is absent from the Client entry; the API manifest already declares scope and Agent dependencies.
- [Client Session submission](../../../packages/api/session-controller/src/client/sessions/session.ts) and [conversation submission](../../../packages/client/ui-conversation/src/client/service.ts), including Katcats private and group composers, inherit the ordering change through this BFF. Existing direct Host callers, including the copied [channel integration](../../../packages/xiaojing/xiaojing-weixin-channel/src/index.ts), do too; none receives a new required argument. External consumers cannot be exhaustively enumerated from this copy.
- [Model-picker submission](../../../packages/client/ui-model-selection/src/client/directory.ts), [Bot settings](../../../packages/api/katcats-team/src/index.ts), [group creation](../../../packages/api/katcats-team/src/chats.ts) and [worker model selection](../../../packages/api/katcats-team/src/chats-runtime.ts) share the refactored explicit-selection validation. Their scope/default behavior needs regression coverage. Host declarations, generated Cordis references and metadata require regeneration if approved; no Remote codec or SDK protocol field changes are proposed.
- Direct `Agent.followup`, `steer`, `send` and inbox injection bypass this hook. [Group worker and continuation delivery](../../../packages/api/katcats-team/src/chats-runtime.ts), [schedule delivery](../../../packages/schedule/schedule/src/runtime.ts), [SDK server](../../../packages/sdk/server/src/server.ts), [ACP delivery](../../../packages/acp/acp/src/session.ts), subagent delivery and queue editing are not automatically covered. Their owners must define safe admission before claiming dynamic following there. The patch changes none of those paths or the Agent loop.

## Required focused acceptance

Implementation requires these keyless cases, extending [Session model tests](../../../packages/api/session-controller/tests/session-models.host.spec.ts) and the real Katcats Loader fixture. The proposal contains candidate API code, not completed tests or the product provider.

1. Use A, change the base to B, then submit text and images to a following Bot. Assert actual model requests, selection events, switch notices and cold replay; fixed Bots, another Session and the application default stay unchanged. Snapshot actual model-visible input and persisted output.
2. Cover image-capable B, text-only B, missing providers, unavailable models and invalid effort. Reject before accepting an invalid message; check selection retention after a later attachment rejection, receipt ownership and disposed-Agent checks.
3. Use barriers to cover text/image admission racing explicit Session-only selection, a base change while admission waits, duplicate request ids, rejection recovery and scoped unload. Assert real ordering without sleeps, no recursive deadlock and another Agent's independent progress.
4. Without a listener, preserve ordinary results, image validation and file receipts while explicitly accepting the new text ordering. Test cooperative delegation and Agent isolation; keep policy failures visible and verify that policy never saves defaults.
5. Re-run omitted/default and Session-only explicit selection, projection/replay, cancellation and authorization checks. Assert direct `followup` does not invoke this event so unsupported paths cannot be mistaken for covered paths.
6. After approval, add the Katcats provider and tests, update API documentation and generated references, then run focused type/lint/dependency checks, strict built Gateway smoke, latest artifacts and build checks. Claim automatic following only after private and group entry points each meet their stated acceptance.

## Review evidence

The approved API patch contains 58 added and 17 removed lines. Its initial isolated applicability and in-memory type checks passed before implementation. The applied API now passes focused model/admission and authorization tests and an owner-program type check without emitting files. Katcats tests cover fixed-to-following recovery, actual private and group model requests, and unchanged member files across a cold reopen. Bilingual pairing and local links pass. These source checks do not establish complete external-consumer coverage or replace the final artifact build and built integration verification.
