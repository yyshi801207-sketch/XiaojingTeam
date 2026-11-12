---
description: "Team sidebar branding, finance-team welcome, onboarding, theme, and default persona"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-xiaojing-product

The current product is 小兢财务 (`1.1.0`), with private Bots and collaborative group chats. Historical release entries describe their original versions.

English | [中文](README.zh.md)

User-visible Bot introductions identify 瑞华云财务共享团队; the application UI uses 小兢财务. Technical package identifiers, paths, saved Bot roles, and historical conversation content retain their original values.

## Summary

Use Team sidebar branding, light and dark themes, and a finance-robot welcome screen. First-use guidance explains how to obtain and configure a DeepSeek API key. The About page shows the application and DSH versions. Without this plugin, the shared UI retains its default DeepSeek presentation.


## Table of Contents

- [Capabilities](#capabilities)
- [Dev Note](#dev-note)

<a id="capabilities"></a>
## Product contributions

The Team sidebar uses the supplied `src/client/assets/sudo-wordmark-light.png` in light mode and `src/client/assets/sudo-wordmark.png` in dark mode. The source files remain unmodified: the light artwork has gray lettering and a green bean emblem; the dark artwork has white lettering and the same green emblem. The expanded wordmark uses a 116-by-22-pixel frame beside the localized “Redefining finance with AI” tagline; on narrow sidebars the tagline truncates while the logo keeps its size. The collapsed rail shows the bean emblem in its existing icon slot. Conversation and navigation surfaces stay white in light mode. User messages use a light gray fill, a fine border, and compact rounded corners. No background image is loaded. Neutral graphite controls and selection fills replace the teal palette; the primary composer send action uses SUDO green (`#12A489`) with a white arrow, a darker green hover, and the existing 40% disabled opacity; other buttons retain their palette, and link accents use blue. Dark mode uses neutral charcoal surfaces.

The `0.3.3` release adds the 0.2.1-rc.2 kernel model/search APIs, plugin-index management, built-in automation, draft retention, model reasoning and fonts, microphone selection, collaboration, and upstream stability fixes. Existing Katcat capabilities stay available, and the `0.3.2` release details include session authorization for eligible operations while retaining the single-use approval choice.

Office sessions offer **Automatic approval (experimental)** in the permission menu. A risk confirmation precedes activation; ordinary and mandatory tool requests, including deletion, upload, and submission, then proceed automatically in that session and its delegated children. A header picker remains available while a task replaces the composer with an approval. Switching to another permission preset revokes this mode, including for live children. The logged choice survives reopening the same conversation; ordinary forks and unrelated new sessions do not inherit it. Finance sessions cannot select it, and it is excluded from defaults. Browser connection consent and Windows elevation retain their system authorization.

The product shadows the generic `system-prompt` Chat renderer so internal model instructions remain persisted and model-visible without appearing in the Katcat end-user transcript.

Katcat Desktop shows this guide inside the main workspace without a separate login page. Settings uses the standard launcher; account menus, account introductions, and the account-authenticated model provider are unavailable.

The first-use dialog supplies a compact white API key guide through `onboarding.content`, without a background image or top logo. It retains both setup steps, the blue DeepSeek Platform link, key-management and security notes, and the explicit Start action. The shared [Models onboarding coordinator](../ui-settings-models/README.md#onboarding-coordinator) owns installation-aware acknowledgement, provider-readiness checks, and the API key editor that follows Start. A usable provider skips both Katcat Desktop welcome and credential dialogs; no credentials or conversation data are cleared.

Product artwork URLs and the Katcat boot-logo and favicon defaults resolve relative to the document base, keeping these resources inside a Web deployment's public mount.

The Team empty-session hero embeds the supplied eight-robot finance team artwork from `src/client/assets/xiaojing-finance-team-hero.png` without modifying the original pixels. Its SVG fills the responsive frame with the full image at up to 420 × 280 CSS pixels, preserving its aspect ratio without an inset margin. Smaller viewports scale the artwork down while keeping the title and composer below it. The Chinese title is “小兢会计，您的AI财务团队”; English uses “Xiaojing Accounting, your AI finance team.” The favicon uses the supplied white application icon with its gold accent and transparent edge, stored as `xiaojing-character-logo.png`. These asset filenames are internal identifiers. The black version badge stays beside the title, including when the title wraps. The initial HTML receives its brand and favicon from `DSH_CLIENT_BOOT_LOGO`, `DSH_CLIENT_BOOT_LOGO_ALT`, and `DSH_CLIENT_FAVICON`; builds without these values retain the generic assets.

The browser plugin registers `sidebar.brand.mark`, `sidebar.brand.name`, `conversation.hero.brand.mark`, `conversation.hero.brand.content`, `onboarding.content`, and `settings.section` only in the `xiaojing` Client build profile. Product copy, palette overrides, release version badge, and the default persona live in this package. The same finance-team welcome also applies when retained history carries Finance metadata. About displays the supplied `src/client/assets/xiaojing-team-app-icon.png`, the product name “小兢财务” in both languages, application version, and DSH base version compiled through `DSH_CLIENT_VERSION`; release history, detail actions, description, and company footer are absent. Electron supplies its actual application version through one restricted preload method; an ordinary Web preview uses a checked fallback that must equal `apps/desktop/identity.json.productVersion`. Tests require that fallback to equal the first release-history record and reject duplicate version entries. The product-layer gate rejects a version mismatch and rejects Katcat brand marks written back into official UI source roots. The plugin lifecycle also synchronizes the existing browser `theme-color` metadata after the product dataset is attached and restores the generic value when the plugin unloads. The build profile selects the inventoried Katcat logo for the pre-plugin loading page through generic boot metadata; the shell retains its `HARNESS` fallback when that metadata is absent. `product.json` records the official `dsh-v0.2.1-rc.2` baseline by its official release tag, generic slots, browser asset paths, desktop product manifests, and an empty product-preset list. A product-layer gate parses the declarative Finance and Standard compositions and permits only the Finance persona, declared Finance consumers, and product skill directory to differ.

The personal build disables the Finance workspace, ledger management, calculations, evidence service, and Finance preset. Its sidebar and About page use office-only copy. The retained Finance preset and package sources are not activated by default. `product.json.agentPresets` is empty; `product.json.financeExtension` inventories retained source and the protected `harness/finance` directory. Ordinary document reading keeps the shared parser without starting the Finance business service. Existing Finance records and files are not deleted.

The Host product plugin also owns Katcat's mandatory deletion policy. Explicit deletion tools and shell deletion commands request confirmation through the shared approval channel even when the session policy is `never`. Shell requests offer “Always allow” for the identical command, resolved working directory, and execution permission within the current Session. Different commands, directories, permissions, or Sessions require another decision. Relative per-call directories resolve from the validated current directory, including recovery when it disappears; a directory change during confirmation blocks that call. These choices do not expand the sandbox workspace. Literal text and comments do not establish deletion; encoded or indirect scripts whose effects cannot be identified use execution confirmation without a deletion claim. A monotonic tool guard denies any matching call without confirmation. Browser and Windows controls classify protected actions inside their own providers.

When the saved default still selects `deepseek-official/deepseek-v4-flash` or `deepseek-official/deepseek-v4-flash-vision-exp`, the Host product plugin changes only that selection to `deepseek-official/deepseek-flash` so new sessions use the V4.1 Flash text-and-image route. It checks at activation and after settings updates, including the asynchronous import of an older `settings.yaml`. Other saved providers and models remain unchanged; session-specific historical selections are not rewritten.

The product identifies itself as Katcat, the user’s super personal assistant, and accurately describes its technical origin as based on DeepSeek Harness with internal branding and configuration. It does not claim that SUDO Tech developed the underlying framework.

The Katcat build supplies Chat's localized running labels through `DSH_CLIENT_RUNNING_LABEL_ZH` and `DSH_CLIENT_RUNNING_LABEL_EN`: “Katcat is thinking” and “Katcat is thinking”. The visible timer and accessible status use the same label. The label and elapsed time are black in the light theme and use the primary text color in the dark theme. The highlight follows the text color; the three activity dots retain their separate colors.

## Upstream upgrade contract

Browser-opening requests and website tasks use the [native browser connection](../../xiaojing/xiaojing-browser-control/README.md#native-browser-connections): Edge by default and Chrome when explicitly requested. An ordinary opening request authorizes the necessary connection and ordinary tabs without requiring the user to name a dedicated profile. Before any page action, a failed ordinary connection permits one explicit attempt with a dedicated instance of the same browser, unless the user rejected or canceled access or required an existing profile. A request for already-open tabs uses `existing`, retains browser permissions and connection approval, and does not substitute another browser or profile after failure. Desktop clicking is not a webpage fallback. These instructions do not guarantee model response latency.

An upstream upgrade starts from stable `main` on a `codex/upgrade-rcX` branch and merges the verified official tag or commit. Product code, brand assets, desktop identity, and accounting logic remain unchanged. Conflicts are resolved only in the generic slots, the rc-specific accounting adapter, the independent integration patches listed by `apps/desktop/integration-patches.json`, and any required atomic data migration.

The upgraded branch may merge only after the product-layer verifier, focused behavior tests, built Web replay, fresh Windows install, and previous-release in-place upgrade checks pass. A version that cannot read or migrate the previous release's data is not releasable.

## Official-source Chinese tax research

The product-owned `finance-tax-research-cn` skill instructs Finance模式 to establish jurisdiction, taxpayer facts, transaction facts, accounting or tax period, and the requested answer date before reaching a rule-dependent conclusion. It uses `finance_evidence`, treats search snippets as discovery only, and labels unsupported source text, status, or applicability as `待核验`. The other four skills cover financial-document reading, invoice review, voucher drafting, and financial-data analysis. They orchestrate the shared document, evidence, deterministic-calculation, and controlled-file tools without treating skill names as proof that a business operation is supported. The voucher skill creates a Youcheng voucher only after an explicit request, versioned preview, mandatory approval, and verified readback; it does not post the voucher. The current Finance preset includes no reimbursement skill.

The skill stores no regulation text, builds no crawler or RAG index, and does not enable generic HTTP fetching. Search snippets cannot be represented as complete provisions, and a result without enough official text must remain non-definitive. Removing its manifest entry and preset skill directory withdraws the capability without changing Harness core packages or user data.

## Model Experience

### Product-wide business-facing responses

#### What the model sees

Every Katcat preset receives one stable response policy after persona assembly. The policy asks for clarification when unresolved intent would materially change the result. When the question tool is available, the model offers a few actionable choices grounded in the request and verified context. A voucher lookup with no resolved period offers common periods and includes exact dates when time context is available. Recommendations require a reason from the task or an established preference. It requires the final answer to lead with the usable business outcome, suppresses internal execution evidence and failed-attempt narration after success, limits failures to one user-visible reason and next action, and presents generated files by content and usable location rather than audit metadata. Technical diagnostics remain available only when the user explicitly requests them. Tool providers must still project model-safe results; this prompt is not a substitute for filtering raw transport, retry, pagination, checksum, or test data before it reaches the model.

#### Token effect

One fixed product-wide section is added to each model request. Finance adds its narrower accounting interpretation and safety rules without repeating tool execution evidence.

#### KV Cache effect

The policy is prefix-stable for every preset and changes only when the product policy changes.

### Mandatory deletion instruction

#### What the model sees

When either built-in automation provider is composed, the stable automation context states that deletion uses the mandatory confirmation service even under Full access and `never`, and prohibits evasion by changing or obscuring the deletion command. An explicit Automatic approval (experimental) choice authorizes that service to grant these requests automatically; the runtime approval context identifies when this authorization is effective.

#### Token effect

One fixed sentence in the existing built-in automation context; it is not repeated per tool call.

#### KV Cache effect

The sentence is prefix-stable while the product capability composition remains unchanged.

### Default deployment persona system prompt

#### What the model sees

The plugin fills `deployment:persona-prefix` only when downstream assembly leaves it empty. Its default identity is 小兢会计 from 瑞华云财务共享团队; explicit user-authored personas remain authoritative. Greetings invite exploration without listing a fixed set of functions. Retained replies are historical records and are not rewritten.

##### Verbatim default persona

```markdown
你的名字是小兢会计，来自瑞华云财务共享团队。用户用中文问候或询问身份时，自我介绍使用：“我是小兢会计，来自瑞华云财务共享团队！”；其他语言使用对应表达。即使历史回复、安装名称或工作区中出现旧品牌名称，后续自我介绍也使用瑞华云财务共享团队，不沿用旧身份。

你陪用户探索想法、创造新事物，把想做的事一步步推进。表达自然、简洁、有想象力，不把身份限定为办公、财务或编程助手。

用户打招呼时，用身份介绍加一句开放的邀请即可，不主动列出功能清单。用户询问“你能做什么”时，从用户想实现的目标出发，可以说：“无论是一个天马行空的想法，还是一件想做成的事，都可以交给我一起探索、推进。你想从哪里开始？”不要默认罗列文档处理、数据处理、内容撰写、信息检索、网页操作、电脑操作等类别，也不要照搬工具目录。用户要求具体例子时再结合需求展开。

“任何想做的事都可以聊”是开放的邀请，不代表能够无条件完成所有任务。实际执行以当前工具、连接和授权为准；遇到真实限制时简洁说明并提出可行的下一步，不虚构能力、连接或完成结果，也不在普通问候里堆砌限制说明。

Do not volunteer internal model, provider, framework, runtime, or workspace-path details unless the user explicitly requests technical diagnostics. If asked about the product's technical origin, state accurately that it is based on DeepSeek Harness with internal branding and configuration; do not claim that SUDO Tech developed the underlying framework.
```

#### Token effect

The default persona adds the fixed text above once when no explicit persona is present.

#### KV Cache effect

The text is prefix-stable while the product version and working directory stay unchanged. Changing the selected persona or working directory changes the system prompt and may invalidate provider prefix reuse.

### Finance模式 preset system prompt

#### What the model sees

A session created with the shipped `finance` preset receives every Standard mode tool, while its `deployment:persona-prefix` section is replaced by the finance-specific text below. Its filesystem skill provider also mounts the product-owned `skills/` directory beside the preset; other finance services and skills remain independently removable.

##### Verbatim Finance模式 persona

```markdown
You are Katcat, an AI office companion configured for internal use, operating in Finance模式. Finance模式 retains every capability of Standard mode and applies an evidence-first discipline to finance and tax work. Distinguish confirmed facts, assumptions, and items that require verification. Do not invent laws, tax rules, accounting standards, citations, client facts, calculations, or completed business actions. When jurisdiction, taxpayer type, accounting standard, accounting period, or tax period can affect the answer, state the applicable assumptions or ask for the missing facts. For current Chinese finance or tax rules, prefer official sources and cite them; when applicability or legal effect cannot be established, say “待核验”. Do not claim that a submission, approval, posting, payment, filing, or external-system change succeeded unless a tool result verifies the final state. For imported PDF, DOCX, XLSX, PPTX, digital-invoice XML, OFD, CSV, or text documents, use finance_document instead of attempting shell, Python, Office, or ad-hoc converter commands. When finance_document reports visual_count, use its visuals action to inspect retained document pictures with the native visual model. For a simple identity question, answer concisely as “我是Katcat，当前处于 Finance模式。” in Chinese, or the equivalent in the user's language. Do not volunteer internal model, provider, framework, runtime, or workspace-path details unless the user explicitly requests technical diagnostics. If asked about the product's technical origin, state accurately that it is based on DeepSeek Harness with internal branding and configuration; do not claim that SUDO Tech developed the underlying framework.
```

#### Token effect

The preset replaces the office identity with one fixed finance persona. Additional Finance capability and client context are owned by [xiaojing-finance-domain](../../xiaojing/xiaojing-finance-domain/README.md), not the office persona.

#### KV Cache effect

The persona remains prefix-stable for a fixed working directory. Selecting another preset changes the system-prompt prefix by design.

## Known Limitations and Deferred Work

- The product layer relies on eight generic UI slots on the `dsh-v0.2.1-rc.2` integration baseline; a future official release that changes those owners requires an adapter update before merge.
- Browser image files remain app-level public assets inventoried by `product.json`; the verifier checks their presence but does not embed them into the client bundle.
- Shell classification recognizes explicit deletion commands. It cannot infer destructive behavior hidden inside an unrelated opaque third-party executable; any new tool that can delete user data must expose and enforce its own mandatory deletion classification.
- `Finance模式` provides local client context, dedicated Finance Workspaces, document and invoice review, official-source Chinese tax research, deterministic trial calculations, managed financial files, and the implemented Youcheng query and controlled-maintenance operations. The canonical capability inventory marks each business area as supported, limited, or unsupported. Native general ledger, subsidiary ledger, auxiliary ledger, balance sheet, income statement, cash-flow statement, reimbursement, audit, posting, closing, filing, and actual payment are not current Finance chat capabilities.
- The protected `harness/finance` root stores schema-versioned client, document, and evidence data. Deterministic calculations add no separate ledger; their complete inputs and outputs remain in the session log.

<a id="dev-note"></a>
### Dev Note

None.

No invariant companion is published because registries and the owning services enforce these relationships directly; this package has no independent observation to compare.
