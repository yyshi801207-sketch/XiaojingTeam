# Group member mention proposal

English | [中文](group-member-mentions.zh.md)

## Status and verified limitation

This review reference accompanies the [approved API patch](group-member-mentions.patch), applied only to the independent Katcats copy after the user's separate authorization. The user requested that a group's `@` menu show only its current Bot members. The existing [reference source](../../../packages/client/ui-reference/src/client/index.ts) queries files and all discoverable Sessions, while the previous [trigger registry](../../../packages/client/ui-input-trigger/src/client/service.ts) combined every registered source for every Session. Adding a product member source alone could not suppress those unrelated rows. Product registration and browser acceptance remain separate from this API verification.

## Proposed discovery API

The patch adds an optional `InputTriggerSource.exclusive(session): boolean` callback. For one Session and trigger, if any source returns `true`, candidate discovery, menu picking and leading-token Space matching use only those exclusive sources; otherwise they use the existing ordered roster. Reference codecs, Enter adjudication, persisted-claim restoration and reference previews still use the full registered roster. Multiple exclusive sources intentionally contribute together. Existing sources omit the callback and keep their current behavior. The callback reads a synchronous product-owned snapshot and never starts I/O.

The controller rebuilds an open menu when a source's lexicon invalidates, or a source is registered or removed: obsolete rows and headers disappear, superseded fetches are aborted, and no stale candidate can be picked. Source removal aborts its active fetch even when removing the last displayed source closes the menu. The complete registered roster remains available for reference codecs, old draft restoration and historical reference previews; discovery policy neither deletes references nor grants access to another Session. The patch contains no Host API, wire type, persistence format or Agent-loop change.

## Product integration

Katcats owns one `katcats-member` source. It claims `@` exclusively for known group transcript Sessions, including while their directory is reconnecting; unavailable current membership produces an empty list and blocks serialization, never a fallback to global Sessions. Other composers keep their existing sources. Its candidates come from the current `memberIds` joined to the team directory, display the approved cat avatar and member name, and contain no private Session, worker identifier or filesystem path. Group changes and member removal invalidate the source. Duplicate names are distinguished with avatar and group responsibility; still-identical labels receive stable list-order suffixes for the current menu.

Selecting a row inserts a product reference with stable `chatId` and `botId`, never a `dsh-session:` reference. The product serializer emits a canonical `@[name](katcats-member:<encoded-chat-id>/<encoded-bot-id>)` token after checking current membership; it does not open or quote a private or worker Session. A product-owned user-text rule renders that token as a member mention in sent messages. The Host routes by the validated Bot identity, requires the token's chat identity to equal the addressed group, rejects removed, foreign and creator members, and repeats this validation at durable admission. Same-named members remain distinct without name-based guessing. Existing plain `@name` and historical Session references retain their existing validation and display.

This discovery change leaves the `+` attachment action available for files and images. It does not change Bot permissions, approval, member execution Sessions or the ordinary file preview. Product registration and disposal use `ctx.effect`; no monkey-patching, private registry access, CSS-only filtering or DOM interception is permitted.

## Required verification

1. Registry/controller tests: unchanged default and slash discovery; exact Session and trigger selection; multiple exclusive contributors; an open menu invalidated during a pending old lookup; stale pointer and keyboard picks; group switch; source removal; codec and old-draft restoration after discovery suppression; disposal without retained subscriptions.
2. Product Client tests: only current group members, avatar/name display, no other groups or Session/file paths, cold loading and reconnect fail closed, renamed and duplicate members, member removal while the menu is open, and serialization refusal after removal.
3. Product Host tests: canonical token routing by `BotId`; cross-group, nonmember, creator, malformed and removed-member rejection before admission; membership changes during attachment admission; no calls to private Session history readers. Preserve existing ambiguous bare-name rejection and old Session-reference compatibility.
4. A fresh isolated browser composition must exercise the original composer and `@` menu with real product services and only an external Mock model, including keyboard selection, selected member response, group switching, live membership changes and file/image attachment through `+`. No installed product or real user data is used.
5. Complete API and product documentation, focused tests and type checks, and artifacts/build checks before updating the independent preview. The applied API's service suite passes 83 cases, including seven exclusive-discovery cases; this source-test result does not establish browser or built-product acceptance.
