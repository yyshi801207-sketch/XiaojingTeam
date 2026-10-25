# 产品界面展示接口提案

[English](product-ui-presentation.md) | 中文

## 状态与已核对的限制

本文记录供产品层使用的侧栏、右栏及输入框展示接口[基础评审补丁](product-ui-presentation.patch)。用户已批准这项 API 例外，独立副本已经应用，并修复了可选 schema、默认调用兼容及 Host→Client 配置通路问题。基础补丁不包含 Katcats 品牌或产品消费代码；当前拥有者源码及包 README 说明已实现的 API。此补丁保留作评审记录，不应再次叠加应用到已有实现。

[语言注册器](../../../packages/client/locale/src/client/index.ts)会拒绝同一命名空间、同一语言的重复注册，没有安全的逐 key 覆盖接口。[侧栏外壳](../../../packages/client/ui-sidebar/src/client/SidebarRoot.tsx)拥有新会话文案，以及底部操作、全局面板导航、设置的排列顺序，产品 slot 的 order 无法完成这些要求。[布局 store](../../../packages/client/ui-layout/src/client/stores.ts)只有一个运行期右栏宽度，采用现有的 45% 初始偏好。[会话正文](../../../packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx)拥有空态工作区选择器和默认提示，仅替换 preset 的贡献无法隐藏该选择器。

## 建议的扩展点

所有新增公开选项均可省略。省略后沿用现有文案、面板导航、底部顺序、宽度偏好、输入提示和空态行。补丁同步修改拥有者的实现及内部注入源，不替换完整外壳、编辑器，也不引用其他功能的私有组件。

| 拥有者 | 可选 API | 产品层效果 | 省略后的行为 |
| --- | --- | --- | --- |
| `ui-sidebar` Config | `primaryActionLabel` | 产品提供主创建操作的本地化文案 | 现有新会话文案 |
| `ui-sidebar` Config | `panelNavigation: { label, defaultExpanded? }` | 将原有全局面板行放入一个可折叠分组 | 现有平铺面板行 |
| `ui-sidebar` Config | `footerActionsPlacement: 'after-panels'` | 将现有用量等底部操作排在面板导航下方 | 现有操作在面板之前的顺序 |
| `sidebarRightTabs.register` 定义 | `initialWidth: 'minimum'` | 此 provider 首次采用现有最小宽度，本次运行记住手动宽度 | 现有 45% 偏好与手动宽度 |
| `ctx.composerPresentation` | `register(sessionId, observable)` | 按 Session 提供 `defaultPlaceholder` 与 `hideWorkspaceRow` | 标准输入框展示 |

### 侧栏配置

文案映射必须包含非空白的英文 `en` 兜底，也可提供其他语言；现有语言服务负责解析，并在切换语言后更新已挂载的文案。主操作选项同步改变可见文本、可访问名称和 tooltip，不改变命令标识、快捷键、图标或创建回调，也不重命名其他命令菜单入口。

可选面板标题沿用现有面板行、图标、选中状态和导航回调。`defaultExpanded` 默认 `true`，产品可明确配置 `false`。外壳挂载期间保留用户后续的展开状态，切换语言不会重置。窄侧栏仍显示原有导航图标。可选底部顺序会整体移动原有 action slot，设置仍位于最后。折叠按钮支持键盘，并提供 `aria-expanded` 和 `aria-controls`。

侧栏包在 Host、Client 均导出 Config schema，并声明直接使用的 Schemastery 依赖。Host 通过 `webserver/index-inject` 将公开展示字段发布为 `__DSH_SIDEBAR_PRESENTATION__` 全局值；Client 在挂载前读取并校验该 bootstrap，入口的激活元数据不传递 Host 配置。缺少 bootstrap 时沿用标准侧栏。省略 `panelNavigation` 时，即使 Schemastery 默认会为 object 补空对象，该选项也必须保持缺省，不能产生无标题的折叠分组。缺少英文或配置空白文案时，配置校验失败。消费方不替换或修改语言命名空间。

### 右栏宽度

[标签页定义](../../../packages/client/ui-sidebar-right/src/client/tab-registry.ts)新增 `initialWidth?: 'minimum'`。右栏拥有者通过现有展示回调，以及 `layout.openRightbar` 新增的可选第三参数，报告当前停靠 provider 的标识。布局为明确启用的每个 provider 维护独立运行期宽度，初始取 `RIGHTBAR_MIN`（当前 300 px），并由原有拖动路径更新。同一次应用运行中，关闭、切换 Session、再次打开均保留该手动偏好。两个设置 provider 各自记忆，同一个 provider 的多个 Session 共用其偏好。

未配置该选项的 provider 继续使用原有普通宽度偏好，包括首次打开的 45% 行为。启用最小初始宽度的设置页不会覆盖普通偏好。当前最小/最大宽度约束、窄屏全屏逻辑和拖动把手仍然有效。宽度提示不写入持久化布局记录，也不改变 Session 或设置格式。产品后续明确为 Bot、群聊设置 provider 启用；本补丁不包含这些消费代码。

### 按 Session 设置输入框展示

Conversation 插件提供 `ctx.composerPresentation.register(sessionId, source)`，`source` 是包含已本地化展示默认值的 `ObservableSnapshot`。调用方通过 `ctx.effect` 注册，并拥有返回的幂等 disposer。每个 Session 只允许一个 provider，重复注册会抛错。源更新会刷新该 Session 保留挂载的输入框。注销恢复标准展示、取消源订阅，并阻止旧通知延迟到达后恢复过期覆盖。插件卸载释放所有源。

`defaultPlaceholder` 只是普通提示，优先级低于现有工作区前置条件、明确阻塞、连接/不可用、排队和计划提示，不会启用输入或改变提交、模型、工具及权限行为。`hideWorkspaceRow: true` 仅在真实 Session 已满足原有工作区前置条件后，隐藏整行空态工作区/preset/context/options；否则仍保留该行供用户恢复。原输入栏的附件、权限与模型选择保持挂载。如果只需定制 preset 展示，产品也可使用现有 `conversation.hero.agentPreset` slot，本提案不新增 preset 专用 API。

产品后续按准确的私聊或群聊记录 Session ID 注册，并发布自己类型化词典中的本地化提示。服务不读取全局选中 Session，不改变工作目录、不授予文件访问权限、不改变持久化 Session 数据，也不增加模型可见输入。补丁不涉及 Agent loop、Host 传输、凭据或公开 SDK。

## 授权后必须完成的验证

1. 侧栏测试：零配置行为；可见文本/可访问名称/tooltip 本地化；缺英文和空白文案拒绝；可选嵌套配置省略；默认折叠和键盘切换；语言切换保留状态；窄栏导航；两种底部顺序均保留设置。
2. 右栏测试：启用 provider 首次为最小宽度；拖宽和重开；不同 provider、Session、普通标签页间切换；普通页首次 45%；注册注销；全屏、拆分/浮窗焦点和视口约束；不增加持久化宽度字段。
3. 输入框测试：准确 Session 隔离；实时更新；重复注册；幂等移除；注销或替换后的旧通知；插件卸载；保留挂载的输入框更新；空态和已有对话；工作区/阻塞/离线/不可用/排队/计划提示优先级；前置条件失效时保留恢复入口。
4. 更新既有内部 hook 测试夹具和公开 API/包文档，执行聚焦行为测试、Client 类型检查与所需 API/文档检查。评审源码获准并应用后，必须完成 `build:artifacts` 与 `build:check`，才能宣称实现完成。发现的消费方失败必须在该实施变更中修复。
5. 产品集成沿用现有创建回调、面板注册、Bot/群设置标签页定义，以及按 Session 持有的展示快照。全新独立预览必须使用外部 Mock 模型验证原编辑器、附件/权限/模型控制、键盘焦点、深浅主题和手动拖宽，不使用已安装产品或真实用户数据。

## 本提案的检查

获准应用前，在独立副本 `E:\Projects\Katcats.AI` 执行 `cmd /c "git apply --check --whitespace=error docs\katcats\proposals\product-ui-presentation.patch"` 成功。完成 Host→Client bootstrap 后，`cmd /c "node run\tmp\presentation-api-buildcheck-tests.mjs"` 通过 419 项聚焦测试，记录在 `run/tmp/presentation-api-buildcheck-1792848285852.json`。五个 bridge 源码/测试文件通过 lint，四组拥有者 README 及本提案的中英配对一致。最终 artifacts/build 检查及独立预览验收由协调代理负责，本文不宣称已完成。
