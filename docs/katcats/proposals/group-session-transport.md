# Group Session transport proposal

English | [中文](group-session-transport.zh.md)

## Summary

This review reference proposes keeping the existing composer, attachments and message history while a product-owned group container delivers messages directly to its Bot members. The container does not run a separate coordinator model.

Status: the user separately approved this extension for the independent Katcats copy. The [approved API patch](group-session-transport.patch) is applied, including the fail-closed registration and reentrant teardown refinements. Installed applications and their user data remain untouched. Product integration and final built acceptance are checked separately.

## Contents

- [Verified limitation](#verified-limitation)
- [Candidate API](#candidate-api)
- [Lifetime and failures](#lifetime-and-failures)
- [Product responsibilities](#product-responsibilities)
- [Files and consumers](#files-and-consumers)
- [Required acceptance](#required-acceptance)
- [Review evidence](#review-evidence)

<a id="verified-limitation"></a>

## Verified limitation

[InputHub](../../../packages/client/ui-conversation/src/client/input/hub.ts) calls the fixed [attachment-aware send path](../../../packages/client/ui-conversation/src/client/service.ts), which invokes [Session.prompt](../../../packages/api/session-controller/src/client/sessions/session.ts). At review time, no public registration replaced ordinary text delivery; the approved patch adds that registration. [Trigger adjudication](../../../packages/client/ui-input-trigger/src/client/controller.ts) only polls sources for drafts beginning with `/` or `@`. The composer chain can replace the complete input area, but the existing InputBar is not exported for reuse.

<a id="candidate-api"></a>

## Candidate API

The patch adds `ISessions.registerTransport(sessionId, transport): SessionTransportDisposer`. The id must name a known top-level Session in the Host catalog. A transport supplies both `prompt(SessionPromptRequest, signal?)` and `cancel(SessionCancelRequest)`, returning the existing typed Remote results. Duplicate registrations, known subagent identities and registration after service disposal throw immediately. Registration grants no Host authorization.

The provider owns the returned asynchronous disposer through `ctx.effect`. ClientSessions owns an exact-id registry and resolves its current handler for each operation, including after a retained Client generation is replaced. The Session object keeps its existing prompt-error handling, first-send state, local echo, request identity and engagement callback. Existing composer code still serializes attachments and restores failed drafts. Never-claimed Sessions retain their original Remote routes; addressed subagents keep their existing route.

<a id="lifetime-and-failures"></a>

## Lifetime and failures

Each invocation captures one registration; provider failure never retries through the default Agent route. Typed returned or thrown Remote failures remain typed. Unexpected handler exceptions become `session/client-transport-failed` with operation and Session details, so the existing Session error state receives a failure rather than false success.

Release first refuses new custom operations with `session/client-transport-unavailable`, aborts still-pending prompt admission and awaits all captured prompt and cancel calls. It does not abort an already-started cancellation before that handler finishes its cleanup. Overlap stays forbidden while release waits. The idempotent disposer cannot remove a later registration. Invocation ownership is recorded before entering a provider, and the release Promise is fixed before abort callbacks run, including synchronous reentry. Root-service teardown drains providers before releasing Session streams and scopes.

A released claim remains quarantined until explicit re-registration; a new lookup cannot fall back to the ordinary Agent route. Quarantine retains no provider callbacks. The product also disables its group composer before removing registrations and refuses container prompts on ordinary Host Agent endpoints; Client registration does not replace Host authorization. Unknown admission outcomes are checked by the same request id before a user retries.

<a id="product-responsibilities"></a>

## Product responsibilities

Katcats registers only explicit group-container ids after the Session catalog is ready, before enabling their composers; it never registers a private Bot or hidden member executor. The handler forwards the unchanged content order, delivery mode, request id, time zone and cancellation to its own Remote. The Host validates ownership and attachments, persists the human message with `source.kind = 'user'` and `source.rpcId = request.requestId`, then admits actual member work. A durable `user/message` with admitted attachment references retires the existing echo; an arbitrary receipt field does not.

The cancellation handler routes the original container identity to product-owned stop and waits for owned member work and approval waits to settle. It preserves each member's original execution Session, permissions and audit trail. Neither handler auto-approves tools. The product exposes actual activity and conversation lifecycle so Send, Stop and Escape agree; the registry does not invent running states or turn events.

This proposal adds no Agent loop change, coordinator Agent, Session event, storage format, Remote wire field, global renderer override or replacement InputBar. Host container persistence, member response selection, queue editing, ordinary slash commands and attachment admission remain separate product work and require their own acceptance before claiming full group compatibility.

<a id="files-and-consumers"></a>

## Files and consumers

- Five existing API Client files: the public index and sessions interface, plus ClientSessions, SessionManager and Session. Two new files hold transport types and the owned registry. No Host API implementation changes are included.
- Three required typed fixture consumers: [TestSessions](../../../packages/test-support/client-runtime/src/sessions.ts), [workspace fake Sessions](../../../packages/client/ui-workspace/tests/workspaces-service.client.spec.ts) and [Conversation registry fixtures](../../../packages/client/ui-conversation/tests/conversation-registry.client.spec.ts). The shared test runtime gains an explicit registration stub and fails loudly unless a fixture supplies behavior; it does not simulate undisclosed transport semantics.
- Owner-local registry and real ClientSessions tests cover identity, ordered attachments, durable echo retirement, quarantine across generations, subagents without parents, failure handling and reentrant teardown. The API README pair documents the implementation; generated Client catalogs and Session references update during integration. External implementations of ISessions must add this method; send and cancel callers need no new argument.

<a id="required-acceptance"></a>

## Required acceptance

1. Run the registry and real ClientSessions cases: unchanged unregistered prompt/cancel and subagent behavior, exact-id isolation, unknown/subagent/duplicate rejection, replacement generations, provider unload and root teardown without leaks.
2. Drive the actual existing InputBar for text, ordered image/file attachments and references. Check one durable human message, one retired echo, preserved request id, real attachment authorization, unchanged private Bots and success only after admission. Exercise typed rejection, exception, abort, ambiguous acceptance and retry without duplicate messages or lost drafts.
3. Use barriers to race sending, stopping, provider release and switching groups. Stop and keyboard Escape must address the original container, settle original worker approvals and preserve other groups; accepted members' replies remain visible with their actual sender identity.
4. In a fresh isolated Browser fixture, create a group with no main Bot, send a normal greeting and directed work, and assert actual Bot replies without a coordinator-model request. Verify first send, error copy, attachments, stop, cold reopen and retained member permissions. Use synthetic approvals and an explicit Mock provider; separately verify real-model member replies.
5. After approval and implementation, run focused source tests, Client/API type and dependency checks, locale and documentation checks, then the latest artifacts and build checks. Confirm the recorded patch and applied implementation match before opening a user preview.

<a id="review-evidence"></a>

## Review evidence

The approved API extension is applied. Fifty-six source tests cover the registry and real ClientSessions, including ordered image/file content and durable local-echo retirement. Ninety product Client cases cover group-only registration, pure-container Escape, visible member bubbles and existing team features. These are source checks; the isolated Browser fixture and final artifacts/build checks remain separate integration acceptance.

## Dev Note

This approved API reference records the permitted Client extension. Product registration and member-only group delivery require their own integration acceptance; the API patch does not change the Agent loop.
