# Session 模型保存范围提案

[English](session-model-scope.md) | 中文

状态：用户已明确授权在 Katcats 独立副本实施这一项例外。三文件源码扩展已应用，37 项 API 针对性测试通过。构建后的 Gateway 保留三种支持的范围选择，拒绝五种非法值和未授权调用；产品持久化、Loader 与桌面检查见 [P1 验证记录](../verification-p1.json)。

## 已核对的限制

公开签名是 `selectModel(request: SessionSelectModelRequest)`，不是位置参数。没有显式指定仅作用于当前 Session 的范围时，接受模型后会同时更新 Session 并异步调用 `agentDefaultModel.saveSelection`，因此给单个 Bot 换模型会更改应用默认模型，见 [commands.ts](../../../packages/api/session-controller/src/commands.ts#L157)。

直接追加 `model/selection` 事件不能同步 API 已加载的选择引用；仅在请求路由时替换模型还会使图片准入读取到不同的模型，见 [agent.ts](../../../packages/api/session-controller/src/agent.ts#L289) 和 [commands.ts](../../../packages/api/session-controller/src/commands.ts#L326)。现有公开 API 没有给任意 API 所有的已加载 Agent 卸载后恢复的入口；扩大自管 Agent 生命周期与替换发送流程超出本次范围。

## 最小扩展

[已审阅源码补丁](session-model-scope.patch) 在现有请求中增加可选 `scope: 'session' | 'session-and-default'`。省略字段或传 `session-and-default` 保留原行为；传 `session` 仅跳过应用默认模型保存，继续复用现有合法性检查、图片准入串行控制、Session 事件、内存选择和下一次请求路由。不增加独立 setter、模型路由插件或新持久化事件。

Katcats 可调用 `sessionController.selectModel({ sessionId, provider, model, scope: 'session' })`。返回值、权限控制与原调用一致。现有调用者不必改写。该扩展不改变当前正在进行的模型请求，也不自动实现“跟随全局默认”；Katcats 仍需在安全的新任务开始处解析跟随策略并调用此入口，不能声称仅加字段就已完成动态跟随。

## 实施时必须补充的验证

- 在 [session-models.host.spec.ts](../../../packages/api/session-controller/tests/session-models.host.spec.ts) 中用合成模型与默认保存 spy 验证 `session` 不保存默认、仅目标 Session 在下一次组装时改用新模型、归一化结果与 `model/selection` 事件一致；另一 Session 和全局默认不变。
- 保留并扩展现有默认保存用例，分别验证省略范围与显式 `session-and-default`；默认存储失败仍不撤销已经接受的 Session 选择。
- 用现有图片准入用例验证 `session` 从纯文本模型切到支持图片的模型后能接受图片，反向切换时拒绝；无效模型或推理等级不更改 Session 或默认值。
- 经真实 Remote 请求验证未知 `scope` 被生成的严格参数解码拒绝、原 Session 授权限制保持有效；[gateway 参数解码](../../../packages/api/gateway/src/index.ts#L1648) 会使用参数 codec，必须重新生成 Typert 元数据并检查新增联合类型实际生成的校验。
- 验证已记录的待生效选择能重放；本提案不修改 `model/selection` 数据格式，不需要格式迁移。更新 API README 与生成的公开声明；按仓库要求完成相关类型检查、构建与无密钥行为测试。

补丁保留最初供审阅的源码差异。实际实施同时包含针对性测试和 API 文档，生成元数据在构建后验证。
