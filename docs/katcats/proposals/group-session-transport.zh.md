# 群聊 Session 发送通道提案

[English](group-session-transport.md) | 中文

## 摘要

本审查参考提议保留现有输入框、附件和聊天记录，由产品层群聊容器将消息直接交给 Bot 成员处理。容器不运行独立的协调模型。

状态：用户已为独立 Katcats 副本单独授权此扩展。[已批准的 API 补丁](group-session-transport.patch)已应用，包含失败关闭注册和可重入释放修正。已安装应用及其用户数据未被触碰。产品接线与最终构建验收分别验证。

## 目录

- [已核实的限制](#verified-limitation)
- [候选 API](#candidate-api)
- [生命周期和失败](#lifetime-and-failures)
- [产品层职责](#product-responsibilities)
- [文件与调用方](#files-and-consumers)
- [必需验收](#required-acceptance)
- [审查证据](#review-evidence)

<a id="verified-limitation"></a>

## 已核实的限制

[InputHub](../../../packages/client/ui-conversation/src/client/input/hub.ts) 调用固定的[附件发送流程](../../../packages/client/ui-conversation/src/client/service.ts)，后者执行 [Session.prompt](../../../packages/api/session-controller/src/client/sessions/session.ts)。审查时没有公开注册方法可替换普通文本发送；已批准补丁补上了该注册方法。[触发器判定](../../../packages/client/ui-input-trigger/src/client/controller.ts)只查询以 `/` 或 `@` 开头的草稿。输入框链可以替换整个输入区域，但现有 InputBar 没有公开复用出口。

<a id="candidate-api"></a>

## 候选 API

补丁新增 `ISessions.registerTransport(sessionId, transport): SessionTransportDisposer`。该 id 必须指向 Host 目录中已知的普通 Session。通道必须同时提供 `prompt(SessionPromptRequest, signal?)` 和 `cancel(SessionCancelRequest)`，返回现有的有类型 Remote 结果。重复注册、已知子智能体身份以及服务释放后的注册会立即报错。注册本身不授予任何 Host 权限。

提供方通过 `ctx.effect` 持有返回的异步释放函数。ClientSessions 持有按确切 id 注册的表，并为每次操作解析当前处理器，包括已保留 Client 实例代次被替换之后。Session 对象继续负责现有发送错误、首次发送状态、本地回显、请求身份和接入回调。现有输入框代码继续序列化附件并恢复失败草稿。从未被接管的 Session 继续沿用原 Remote 路径；具备地址的子智能体保留原有路径。

<a id="lifetime-and-failures"></a>

## 生命周期和失败

每次调用固定使用一份注册；提供方失败时绝不转而重试默认 Agent 路径。直接返回或抛出的 Remote 失败保留其类型。意外处理器异常转换为包含操作和 Session 信息的 `session/client-transport-failed`，让现有 Session 错误状态记录失败，而不是误报成功。

释放先以 `session/client-transport-unavailable` 拒绝新的自定义操作，中止尚未完成的发送准入，并等待已捕获的发送和取消调用完成。已开始的取消操作在完成自身清理前不会被释放流程中止。释放等待期间继续禁止重叠注册。可重复调用的释放函数不会删除后来的新注册。进入提供方之前先记录调用归属，中止回调执行前先固定释放 Promise，因此也涵盖同步重入。根服务退出前先等待提供方完成，再释放 Session 消息流和上下文。

已释放的注册会保持隔离，直到显式重新注册；后续查询不会回落到普通 Agent 路径。隔离记录不保留提供方回调。产品层仍需先禁用群聊输入框，再移除注册，并在普通 Host Agent 入口拒绝群容器请求；Client 注册不能替代 Host 权限校验。发送结果未知时，应使用同一请求 id 核对后再由用户重试。

<a id="product-responsibilities"></a>

## 产品层职责

Katcats 仅在 Session 目录就绪后、启用输入框之前，为明确的群容器 id 注册；不为私聊 Bot 或隐藏成员执行会话注册。处理器将未经改序的内容、发送模式、请求 id、时区和取消信号传给自身 Remote。Host 校验归属和附件，以 `source.kind = 'user'`、`source.rpcId = request.requestId` 持久化用户消息，再接纳真实成员任务。含已准入附件引用的持久 `user/message` 可撤除现有回显；任意自定义回执字段不能替代它。

取消处理器以原容器身份调用产品层停止操作，并等待所属成员工作和审批等待结束。每个成员的原执行 Session、权限和审计记录均被保留。两个处理器都不能自动批准工具。产品层应提供真实活动和对话生命周期，使发送、停止和 Escape 行为一致；注册表不会伪造运行状态或轮次事件。

本提案不修改 Agent 循环，不新增协调 Agent、Session 事件、存储格式、Remote 传输字段、全局渲染覆盖或替代 InputBar。Host 容器持久化、成员回应选择、队列编辑、普通斜杠命令和附件准入仍属于独立的产品工作，只有完成各自验收后才能声称群聊完全兼容。

<a id="files-and-consumers"></a>

## 文件与调用方

- 五个现有 API Client 文件：公开入口、sessions 接口，以及 ClientSessions、SessionManager、Session。另两个新增文件分别定义通道类型和有归属的注册表。补丁不包含 Host API 实现修改。
- 三个必须同步的有类型测试替身：[TestSessions](../../../packages/test-support/client-runtime/src/sessions.ts)、[工作区 fake Sessions](../../../packages/client/ui-workspace/tests/workspaces-service.client.spec.ts) 和 [Conversation 注册表测试](../../../packages/client/ui-conversation/tests/conversation-registry.client.spec.ts)。共享测试运行时新增显式注册替身入口，未配置行为时明确报错，不模拟未声明的通道语义。
- 包内注册表和真实 ClientSessions 测试覆盖身份、有序附件、持久回显撤除、跨实例代次隔离、缺少父级的子智能体、失败处理和可重入释放。API 中英文 README 已记录实现；生成的 Client API 目录及 Session 参考在集成时更新。外部 ISessions 实现需要补上该方法；发送和取消调用方无需增加参数。

<a id="required-acceptance"></a>

## 必需验收

1. 运行注册表和真实 ClientSessions 案例：未注册的发送、取消和子智能体行为保持，确切 id 隔离，未知、子智能体和重复注册拒绝，实例代次替换，以及提供方和根服务释放无泄漏。
2. 驱动实际现有 InputBar，覆盖文本、有序图片和文件附件以及引用。核对单条持久用户消息、单次回显撤除、请求 id 保留、真实附件权限、私聊不变，并且只在准入成功后报告成功。覆盖有类型拒绝、异常、中止、结果未知和重试，防止重复消息或草稿丢失。
3. 使用屏障控制发送、停止、提供方释放和切群的竞态。停止和键盘 Escape 必须指向原容器，结束原成员审批等待，并保持其他群不变；已完成成员回复保留真实发言身份且仍可见。
4. 在全新隔离 Browser 测试环境中创建不含主 Bot 的群，发送普通问候和定向任务，核对真实 Bot 回复且没有协调模型请求。验证首次发送、错误文案、附件、停止、冷启动恢复和成员权限保留。使用合成审批及显式 Mock 模型，并单独验证真实模型的成员回复。
5. 授权并实施后运行聚焦源码测试、Client/API 类型和依赖检查、本地化和文档检查，再运行最新产物构建与构建后检查。打开用户预览前核对记录的补丁与实际实施一致。

<a id="review-evidence"></a>

## 审查证据

已批准的 API 扩展已应用。56 项源码测试覆盖注册表和真实 ClientSessions，包括有序图片、文件内容和持久本地回显撤除。90 项产品 Client 案例覆盖群聊专属注册、纯容器 Escape、可见成员气泡和现有团队功能。这些属于源码检查；隔离 Browser 测试及最终产物构建、构建后检查仍是独立的集成验收。

## 开发备注

这份已批准的 API 参考记录获准的 Client 扩展。产品接线和仅成员发言的群聊需要各自的集成验收；API 补丁不修改 Agent 循环。
