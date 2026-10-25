# Session model selection scope proposal

English | [中文](session-model-scope.zh.md)

Status: the user explicitly approved this specific exception in the independent Katcats copy. The three-file source extension is applied; 37 focused API tests pass. The built Gateway preserves all three supported scope choices, rejects five invalid values, and rejects unauthorized callers. Product persistence, Loader and desktop checks are recorded in the [P1 evidence](../verification-p1.json).

## Verified limitation

The public signature is `selectModel(request: SessionSelectModelRequest)`, not positional arguments. Without an explicit Session-only scope, an accepted selection updates the Session and asynchronously calls `agentDefaultModel.saveSelection`, so changing one Bot's model also changes the application default; see [commands.ts](../../../packages/api/session-controller/src/commands.ts#L157).

Appending a `model/selection` event alone does not update the API's loaded selection reference. Replacing request routing alone leaves image admission reading a different selection; see [agent.ts](../../../packages/api/session-controller/src/agent.ts#L289) and [commands.ts](../../../packages/api/session-controller/src/commands.ts#L326). The current public API cannot unload arbitrary Agents owned by the API and resume them. Owning all Agent lifecycles and replacing the send flow would expand this step's scope.

## Minimal extension

The [reviewed source patch](session-model-scope.patch) adds optional `scope: 'session' | 'session-and-default'` to the existing request. Omitting it or selecting `session-and-default` keeps current behavior; `session` skips only application-default persistence while retaining model validation, serialized image admission, Session events, in-memory selection and next-request routing. It adds no separate setter, routing plugin or persistence event.

Katcats can call `sessionController.selectModel({ sessionId, provider, model, scope: 'session' })`. The result and authorization remain unchanged, and existing callers need no change. This field does not alter an in-flight model request or automatically implement following the global default. Katcats must resolve that policy at a safe new-task point before claiming automatic following.

## Required implementation checks

- Extend [session-models.host.spec.ts](../../../packages/api/session-controller/tests/session-models.host.spec.ts) with synthetic models and a default-save spy: `session` never saves the default, only the target Session changes at the next assembly, normalized results match its `model/selection` event, and another Session and the global default remain unchanged.
- Preserve default-save coverage for both an omitted scope and explicit `session-and-default`; default-store failure must not undo the accepted Session selection.
- Cover image admission when changing from a text-only model to an image-capable model and back using `session`; invalid models and reasoning efforts must change neither Session nor default.
- Through a real Remote request, reject unknown scopes using generated strict argument decoding and preserve Session authorization. [Gateway decoding](../../../packages/api/gateway/src/index.ts#L1648) uses the parameter codec; regenerate Typert metadata and inspect the actual union validation.
- Verify replay of accepted selection events, update the API README and generated public declarations, and run focused keyless tests, type checks and builds. The existing `model/selection` event format remains unchanged, so no format migration is needed.

The patch preserves the original source diff for review. Implementation also includes focused tests and API documentation; generated metadata is validated after the artifact build.
