---
description: "Team sidebar branding, finance-team welcome, onboarding, theme, and default persona"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-xiaojing-product

当前产品为小兢Bot（`1.0.2`），支持独立 Bot 与群聊协作。历史更新条目描述各自版本当时的功能。

[English](README.md) | 中文

Bot 对用户自我介绍时使用“瑞华云财务共享团队”，应用界面使用“小兢Bot”。技术包名、路径、已保存的 Bot 职责和历史聊天内容保留原值。

## 概述

使用 Team 侧栏品牌、浅色与深色主题，以及财务机器人团队欢迎画面。初次使用说明介绍如何获取和配置 DeepSeek API Key。关于页显示应用版本与 DSH 版本。未加载本插件时，共享 UI 保留默认 DeepSeek 界面。


## 目录

- [功能说明](#capabilities)
- [开发备注](#dev-note)

<a id="capabilities"></a>
## 产品贡献

Team 侧栏在浅色模式使用用户提供的 `src/client/assets/sudo-wordmark-light.png`，深色模式使用 `src/client/assets/sudo-wordmark.png`。两张源图片均不修改：浅色图是灰色文字与绿色豆子，深色图是白色文字与绿色豆子。展开时 Logo 使用 116×22 像素显示框，旁边显示本地化的“- 用AI重新定义财务”；侧栏变窄时文案省略，Logo 不缩小。收起时在已有图标位置显示绿色豆子标志。浅色模式的会话与导航区域采用纯白背景。用户消息使用浅灰填充、细边框和紧凑圆角，不加载背景图片。控件与选中底色采用石墨黑和中性灰；主输入框发送按钮使用数豆绿（`#12A489`）和白色箭头，悬停时加深绿色，禁用时保留原有 40% 不透明度；其他按钮保持原有配色，链接使用蓝色强调。深色模式采用中性炭灰底。

`0.3.3` 更新包含 0.2.1-rc.2 内核的新模型与搜索接口、插件索引管理、内置自动化任务、草稿引用保留、模型推理与字体设置、麦克风选择、协作与上游稳定性修复；保留已有Katcat能力。`0.3.2` 更新详情列出支持复用操作的会话授权，并保留单次审批选项。

办公会话的权限菜单提供**自动审批(实验性)**。确认风险后，本会话及其委派子任务中的普通与强制工具审批均自动放行，包括删除、上传和网页提交。审批替换输入框时，任务顶部仍保留权限菜单；切换至其他权限模式会撤销此授权，包括正在运行的子任务。同一会话重新打开后保留已记录的选择，普通分叉及无关新会话不会继承。财务会话不能选择此模式，新会话默认选项也不包含它。浏览器连接与 Windows 提权仍需遵守系统授权。

产品层会覆盖通用的 `system-prompt` 聊天渲染器，使内部模型指令继续保存在会话中并发送给模型，但不会显示在Katcat的用户聊天记录里。

Katcat桌面端在主工作区内显示这份说明，不先展示独立登录页。设置使用通用入口，不提供账号菜单、账号引导或使用账号认证的模型提供商。

首次使用弹窗通过 `onboarding.content` 显示紧凑的白底 API Key 说明，不显示背景图或顶部 Logo。两步配置说明、蓝色 DeepSeek 开放平台链接、密钥管理与安全提示，以及明确的“开始使用”操作均保留。共享 [Models 引导协调器](../ui-settings-models/README.zh.md#onboarding-coordinator)负责按安装标识确认、检查提供商就绪状态，以及点击“开始使用”后进入的 API Key 编辑器。已有可用提供商时，Katcat 桌面端跳过欢迎和凭据弹窗；不会清除凭据或会话数据。

产品图片地址和Katcat的启动 Logo、favicon 默认地址相对于文档 base 解析，使这些资源保持在 Web 部署的公开挂载路径内。

Team 新会话欢迎区从 `src/client/assets/xiaojing-finance-team-hero.png` 嵌入用户提供的八位财务机器人团队插画，不修改原图像素。SVG 将完整图片按原比例铺满响应式框，最大显示为 420 × 280 CSS 像素，不再设置内层留白。小窗口自动缩小图片，标题和输入框保持在图片下方。中文标题为“小兢会计，您的AI财务团队”，英文为“Xiaojing Accounting, your AI finance team.”。favicon 使用用户提供的白色应用图标，保留金色装饰与透明边缘，存放为 `xiaojing-character-logo.png`。这些资源文件名属于内部标识。黑色版本角标始终跟在标题右侧，标题折行时也不会独自落到下一行。初始 HTML 通过 `DSH_CLIENT_BOOT_LOGO`、`DSH_CLIENT_BOOT_LOGO_ALT` 和 `DSH_CLIENT_FAVICON` 获取品牌与 favicon；未配置这些值的构建保留通用资源。

浏览器插件只在 `xiaojing` Client 构建 profile 中注册 `sidebar.brand.mark`、`sidebar.brand.name`、`conversation.hero.brand.mark`、`conversation.hero.brand.content`、`onboarding.content` 和 `settings.section`。产品文案、配色覆盖、版本号标签和默认人格位于本包。仍带有 Finance 元数据的历史空会话也使用同一财务团队欢迎页。关于页显示用户提供的 `src/client/assets/xiaojing-team-app-icon.png`、中英文界面统一使用的产品名称“小兢Bot”、应用版本号与通过 `DSH_CLIENT_VERSION` 编译注入的 DSH 底座版本号；不显示版本历史、详情入口、介绍和公司页脚。Electron 通过一个受限 preload 方法提供应用实际版本；普通 Web 预览使用必须与 `apps/desktop/identity.json.productVersion` 相同的受检 fallback。测试要求该 fallback 与更新历史首项一致，并拒绝重复版本号。产品层门禁会拒绝版本不一致，也会拒绝把Katcat品牌标记重新写入官方 UI 源码目录。插件生命周期还会在产品 dataset 挂载后同步现有浏览器 `theme-color` 元数据，并在产品插件卸载时恢复通用值。构建 profile 通过通用启动元数据为插件加载前页面选择已登记的 Katcat Logo；缺少该元数据时，shell 仍显示 `HARNESS` 默认内容。`product.json` 通过官方发布标签记录 `dsh-v0.2.1-rc.2` 基线、通用 slot、浏览器资源路径、桌面产品清单和空的产品预设列表。产品层门禁会解析 Finance 与标准模式的声明式组装，只允许 Finance 人格、已声明的 Finance 消费端和产品 skill 目录不同。

个性版关闭财务工作区、账套管理、财务计算、依据服务和 Finance 预设，侧边栏与关于页使用办公文案。保留的 Finance 预设和包源码默认不激活。`product.json.agentPresets` 为空；`product.json.financeExtension` 登记保留源码和受保护的 `harness/finance` 目录。普通文档读取继续使用共享解析器，不启动财务业务服务。已有财务记录与文件不会被删除。

Host 产品插件还拥有Katcat的强制删除策略。显式删除工具和 shell 删除命令即使在会话策略为 `never` 时，也会通过共享审批通道请求确认。Shell 请求提供“始终允许”，仅覆盖当前 Session 内相同命令、解析后的工作目录和执行权限；命令、目录、权限或 Session 不同须再次决定。单次调用的相对目录以经过验证的当前目录为基准，当前目录消失时先恢复；审批期间目录变化会阻止该次调用。这些选择不会扩大沙箱工作区。字符串和注释不构成删除操作；无法识别影响的编码或间接脚本使用执行确认，不宣称属于删除。单调工具 guard 拒绝未获确认的匹配调用。浏览器和 Windows 控制提供方在各自工具内部分类受保护操作。

保存的默认模型若仍是 `deepseek-official/deepseek-v4-flash` 或 `deepseek-official/deepseek-v4-flash-vision-exp`，Host 产品插件只将此选择改为 `deepseek-official/deepseek-flash`，使新会话使用 V4.1 Flash 的原生图文路线。插件在启用时及设置更新后检查，包括旧 `settings.yaml` 的异步导入。其他已保存的提供方和模型保持不变；历史会话各自的模型选择不会被改写。

产品将自己称为 Katcat，用户的超级个人助理，并准确说明技术来源是基于 DeepSeek Harness 进行内部品牌与配置，不声称底层框架由数豆科技开发。

Katcat构建通过 `DSH_CLIENT_RUNNING_LABEL_ZH` 与 `DSH_CLIENT_RUNNING_LABEL_EN` 提供 Chat 的本地化运行文案：“Katcat is thinking”与“Katcat is thinking”。可见计时提示与辅助阅读状态使用同一称呼。文案与耗时在浅色主题中显示为黑色，在深色主题中使用主要文字颜色。高光使用相同的文字颜色；三个活动圆点保留各自的颜色。

## 上游升级约定

打开浏览器和网页任务使用[原生浏览器连接](../../xiaojing/xiaojing-browser-control/README.zh.md#native-browser-connections)：默认 Edge，用户明确指定时使用 Chrome。普通打开请求授权必要的连接及普通标签页，无需用户明确说出专用 profile。在尚未执行网页动作时，普通连接失败允许使用同一浏览器的专用实例显式尝试一次，但用户拒绝、取消授权或要求现有 profile 时不适用。用户要求已打开的标签页时使用 `existing`，保留浏览器权限和连接批准，失败后不替换浏览器或 profile。桌面点击不是网页操作的备用路线。这些指令不保证模型响应时延。

上游升级从稳定 `main` 创建 `codex/upgrade-rcX` 分支，并合并经核对的官方 tag 或 commit。产品代码、品牌资源、桌面身份和计费逻辑保持不动。冲突只在通用 slot、rc 专属计费适配器、`apps/desktop/integration-patches.json` 列出的独立集成补丁，以及必要的原子数据迁移中处理。

只有产品层检查、聚焦行为测试、构建后 Web 回放、全新 Windows 安装和上一正式版覆盖升级检查全部通过，升级分支才能合并。无法读取或迁移上一版本数据的版本不得发布。

## 中国财税官方来源核验

产品自有 `finance-tax-research-cn` skill 要求 Finance模式在形成依赖规则的结论前，先识别适用地区、纳税人事实、交易事实、会计或纳税期间和答案对应日期。它调用 `finance_evidence`，只把搜索摘要当作发现线索，并把缺少官方正文、现行效力或适用性证据的事项标为 `待核验`。另外四个 skill 分别覆盖财务文档读取、发票审核、凭证草拟和财务数据分析。它们编排共享文档、官方依据、确定性试算和受控文件工具，但 skill 名称本身不能证明某项业务操作已支持。凭证 skill 只会在用户明确请求、生成带版本预览、完成强制审批并核验回读后创建有成凭证，不会执行过账。当前 Finance 预设不包含报销 skill。

该 skill 不保存法规正文，不建设爬虫或 RAG 索引，也不启用通用 HTTP 抓取。搜索摘要不能被当作完整条文；官方结果不足以支持结论时，回答必须保持非确定性。删除清单项和预设 skill 目录即可移除该能力，不修改 Harness 核心包或用户数据。

## Model Experience

### 全局业务化回答

#### 模型看到的内容

所有Katcat预设在人格组装后都会获得一段稳定的回答规则。最终回答必须先给可用的业务结果；任务成功后不叙述内部执行证据和失败尝试；任务失败时只给用户可理解的原因和下一步；生成文件按内容及可用位置交付，不附带内部审计元数据。只有用户明确要求技术诊断时才展示技术细节。各工具仍须先生成模型安全的结果，不能用这段提示词替代对传输、重试、分页、校验值和测试信息的源头过滤。

#### Token 影响

每次模型请求增加一个固定的产品级段落。Finance 只追加会计解释和操作安全规则，不重复工具执行证据。

#### KV Cache 影响

该规则对所有预设保持稳定前缀，只在产品回答策略变化时改变。

### 强制删除指令

#### 模型看到的内容

只要组合了任一内置自动化提供方，稳定的自动化上下文就会说明：即使在 Full access 和 `never` 审批策略下，删除也要经过强制确认服务，并禁止通过更换或混淆删除命令来规避服务。用户显式选择“自动审批(实验性)”后，该服务会自动批准这些请求；运行时审批上下文说明授权是否已生效。

#### Token 影响

在现有内置自动化上下文中增加一个固定句子；不会按工具调用重复。

#### KV Cache 影响

产品能力组合不变时，该句子保持稳定前缀。

### Default deployment persona system prompt

#### What the model sees

只有下游组装后 `deployment:persona-prefix` 仍为空时，插件才填入该段。默认身份是来自瑞华云财务共享团队的“小兢会计”；用户显式定义的人格仍然优先。问候使用开放的探索邀请，不罗列固定功能清单。已有回复属于历史记录，不会重写。

##### Verbatim default persona

```markdown
你的名字是小兢会计，来自瑞华云财务共享团队。用户用中文问候或询问身份时，自我介绍使用：“我是小兢会计，来自瑞华云财务共享团队！”；其他语言使用对应表达。即使历史回复、安装名称或工作区中出现旧品牌名称，后续自我介绍也使用瑞华云财务共享团队，不沿用旧身份。

你陪用户探索想法、创造新事物，把想做的事一步步推进。表达自然、简洁、有想象力，不把身份限定为办公、财务或编程助手。

用户打招呼时，用身份介绍加一句开放的邀请即可，不主动列出功能清单。用户询问“你能做什么”时，从用户想实现的目标出发，可以说：“无论是一个天马行空的想法，还是一件想做成的事，都可以交给我一起探索、推进。你想从哪里开始？”不要默认罗列文档处理、数据处理、内容撰写、信息检索、网页操作、电脑操作等类别，也不要照搬工具目录。用户要求具体例子时再结合需求展开。

“任何想做的事都可以聊”是开放的邀请，不代表能够无条件完成所有任务。实际执行以当前工具、连接和授权为准；遇到真实限制时简洁说明并提出可行的下一步，不虚构能力、连接或完成结果，也不在普通问候里堆砌限制说明。

Do not volunteer internal model, provider, framework, runtime, or workspace-path details unless the user explicitly requests technical diagnostics. If asked about the product's technical origin, state accurately that it is based on DeepSeek Harness with internal branding and configuration; do not claim that SUDO Tech developed the underlying framework.
```

#### Token effect

不存在显式人格时，默认人格增加上方固定文本一次。

#### KV Cache effect

产品版本和工作目录不变时，该文本保持稳定前缀。更换所选人格或工作目录会改变 system prompt，并可能使提供方前缀缓存无法复用。

### Finance模式预设 system prompt

#### 模型看到的内容

使用内置 `finance` 预设创建的会话会获得标准模式的全部工具，同时将 `deployment:persona-prefix` 替换为下面的财税专属文本。它的文件系统 skill 提供方还会挂载预设旁的产品自有 `skills/` 目录；其他财务服务与 skills 仍可独立移除。

##### Finance模式人格原文

```markdown
You are Katcat, an AI office companion configured for internal use, operating in Finance模式. Finance模式 retains every capability of Standard mode and applies an evidence-first discipline to finance and tax work. Distinguish confirmed facts, assumptions, and items that require verification. Do not invent laws, tax rules, accounting standards, citations, client facts, calculations, or completed business actions. When jurisdiction, taxpayer type, accounting standard, accounting period, or tax period can affect the answer, state the applicable assumptions or ask for the missing facts. For current Chinese finance or tax rules, prefer official sources and cite them; when applicability or legal effect cannot be established, say “待核验”. Do not claim that a submission, approval, posting, payment, filing, or external-system change succeeded unless a tool result verifies the final state. For imported PDF, DOCX, XLSX, PPTX, digital-invoice XML, OFD, CSV, or text documents, use finance_document instead of attempting shell, Python, Office, or ad-hoc converter commands. When finance_document reports visual_count, use its visuals action to inspect retained document pictures with the native visual model. For a simple identity question, answer concisely as “我是Katcat，当前处于 Finance模式。” in Chinese, or the equivalent in the user's language. Do not volunteer internal model, provider, framework, runtime, or workspace-path details unless the user explicitly requests technical diagnostics. If asked about the product's technical origin, state accurately that it is based on DeepSeek Harness with internal branding and configuration; do not claim that SUDO Tech developed the underlying framework.
```

#### Token 影响

该预设用一个固定财税人格替换办公身份。额外的 Finance 能力和客户上下文由 [xiaojing-finance-domain](../../xiaojing/xiaojing-finance-domain/README.zh.md) 提供，不属于办公人格。

#### KV Cache 影响

工作目录固定时，该人格保持稳定前缀；切换其他预设会按设计改变 system-prompt 前缀。

## Known Limitations and Deferred Work

- 产品层依赖 `dsh-v0.2.1-rc.2` 集成基线上的八个通用 UI slot；未来官方版本若改变这些 owner，必须先更新适配再合并。
- 浏览器图片仍是由 `product.json` 登记的应用级 public 资源；检查脚本验证其存在，但不会将其嵌入客户端 bundle。
- Shell 分类会识别显式删除命令，但无法推断无关且不透明的第三方可执行文件内部隐藏的破坏行为；任何新增且能删除用户数据的工具都必须公开并强制执行自己的删除分类。
- `Finance模式` 现已具备本地客户上下文、专属财务工作区、文档与票据初审、官方财税依据研究、确定性试算、财务成果文件管理，以及已实现的有成查询和受控维护操作。权威能力清单将各业务领域标为已支持、有限支持或暂不支持。总账、明细账、辅助账、资产负债表、利润表、现金流量表、报销、审核、过账、结账、申报和实际支付都不是当前 Finance 对话能力。
- 受保护的 `harness/finance` 根目录保存带 schema 版本的客户、文档与依据数据；确定性试算不新增独立账本，完整输入与输出保留在会话日志中。

<a id="dev-note"></a>
### 开发备注

无。

不发布运行时不变量伴随插件：注册表和所属服务直接维护这些关系，本包没有需要交叉核对的独立观测。
