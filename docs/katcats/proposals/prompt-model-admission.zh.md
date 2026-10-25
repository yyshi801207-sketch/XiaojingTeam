# 提示消息模型准入提案

[English](prompt-model-admission.md) | 中文

状态：用户已另行批准在 Katcats 独立副本中实施此扩展，授权范围超出先前的[仅限当前会话的模型选择作用域](session-model-scope.zh.md)。两文件 API 改动已应用，并已补 Katcats 模型策略和定向源码测试。已安装应用、真实用户配置与 Agent 指令均未修改。最终生成产物与构建集成检查由 P4 集成步骤负责。

## 已核实的限制

[默认模型服务](../../../packages/core/agent-default-model/src/index.ts) 提供当前选择读取方法。[设置通知](../../../packages/settings/settings/src/types.ts) 只包含命名空间与修订号，不等待监听器完成。两者均未提供一个必须等待完成的时机，让跟随会话在提示消息准入前同步模型。已使用过的会话可能通过 API 所持有的[选择引用](../../../packages/api/session-controller/src/agent.ts) 沿用最近一次请求的模型。

[提示消息准入](../../../packages/api/session-controller/src/commands.ts) 先根据该引用检查图片支持，再接受附件并把消息入队。只修改请求路由或提示组装的策略可能晚于这项检查。仅追加事件也不会更新已加载引用。

## 拟议 API 改动

[未应用补丁](prompt-model-admission.patch) 修改两个现有 API 文件。它声明仅供 Host 使用、按 Agent 隔离的同步 waterfall 事件 `api-session/prompt-model`：参数为真实 `Agent`，返回值为 `ModelSelection | undefined`，最内层 `next()` 返回 `undefined`。监听器调用 `next()`；拥有该 Agent 策略的监听器可返回独立模型选择，其他 Agent 或固定模型 Agent 原样委托。注册使用由 effect 管理的作用域上下文，上下文卸载时同步撤销。

`SessionCommandController.prompt` 在现有单 Agent 准入队列内部、图片模型检查之前调用 waterfall。私有辅助方法与 `selectModel` 共用可用性检查、推理强度校验及规范化。有效策略调用现有 `selectForNextRequest`，追加 `model/selection` 并更新已加载引用；随后图片准入读取同一引用。钩子不递归调用 `selectModel`，不保存应用默认模型，也不新增会话事件或存储格式。显式模型选择作用域与后台默认值保存行为保持不变。

Katcats 策略提供者将同步读取已打开的成员元数据与 `agentDefaultModel.currentSelection()`。回调不能等待 Team 修改队列、写入持久化数据或把模型选择加入准入队列。这样可避免持有会话准入时再获取 Team 队列，与现有 Bot 设置操作形成相反的获取顺序。是否让已有未显式覆盖模型的 Bot 自动跟随仍需单独确定；仅应用此 API 补丁不会开启该功能。

## 顺序与失败

补丁将文本准入、图片准入和显式模型选择串行处理。即使没有策略，同一 Agent 的并发文本提交也可能等待先前的附件准入；此前只有图片提交进入该队列。队列内的请求 ID 检查可防止排队中的重复请求再次应用策略或重复入队。不同 Agent 仍使用独立队列。

有效策略的模型选择可能先写入日志，随后消息因不支持图片、文件凭据或附件错误而失败。选择不代表消息已接受；是否接受仍由现有错误处理与附件归属检查决定。模型不可用或推理强度无效时，现有 `session/model-unavailable` 会在安装无效选择之前返回。补丁不为每条排队消息固定模型、不改变进行中的请求，也不覆盖之后的显式选择；现有步骤组装仍负责捕获选择并记录切换通知。

## 受影响调用方与排除范围

- [SessionController](../../../packages/api/session-controller/src/index.ts) 是被修改命令的产品调用方。Remote 请求、响应、鉴权和严格参数解码保持不变。事件不进入 Client 入口；API 清单已有 scope 与 Agent 依赖。
- [Client 会话提交](../../../packages/api/session-controller/src/client/sessions/session.ts) 与[会话界面提交](../../../packages/client/ui-conversation/src/client/service.ts)，包括 Katcats 私聊和群聊输入框，均通过此 BFF 受到顺序变化影响。现有 Host 直接调用方，包括副本内的[渠道集成](../../../packages/xiaojing/xiaojing-weixin-channel/src/index.ts)，也受影响；它们均无需新增必填参数。仅凭此副本无法穷举外部调用方。
- [模型选择界面](../../../packages/client/ui-model-selection/src/client/directory.ts)、[Bot 设置](../../../packages/api/katcats-team/src/index.ts)、[群创建](../../../packages/api/katcats-team/src/chats.ts) 和[成员模型选择](../../../packages/api/katcats-team/src/chats-runtime.ts) 共用重构后的显式选择校验，需要回归验证作用域与默认值行为。批准后需重新生成 Host 声明、Cordis 参考资料和元数据；不拟修改 Remote 编解码或 SDK 协议字段。
- 直接调用 `Agent.followup`、`steer`、`send` 或注入收件箱会绕过钩子。[群成员与继续协作投递](../../../packages/api/katcats-team/src/chats-runtime.ts)、[定时任务投递](../../../packages/schedule/schedule/src/runtime.ts)、[SDK 服务端](../../../packages/sdk/server/src/server.ts)、[ACP 投递](../../../packages/acp/acp/src/session.ts)、子 Agent 投递及队列编辑均不会自动覆盖。对应实现须先明确安全准入，才能声称这些入口支持动态跟随。补丁不修改上述路径或 Agent 循环。

## 必需的定向验收

实施需要以下不使用真实密钥的用例，扩展[会话模型测试](../../../packages/api/session-controller/tests/session-models.host.spec.ts) 与真实 Katcats Loader 测试夹具。提案包含候选 API 代码，不包含已完成的测试或产品策略提供者。

1. 先使用 A，将基础模型改为 B，再向跟随 Bot 提交文本和图片。验证实际模型请求、选择事件、切换通知和冷启动回放；固定模型 Bot、其他会话和应用默认值不变。对真实模型可见输入与持久化输出保留快照。
2. 覆盖支持图片的 B、仅支持文本的 B、缺失提供者、不可用模型和无效推理强度。在接受无效消息前拒绝；检查之后附件拒绝时的选择保留、凭据归属及 Agent 已销毁检查。
3. 用屏障覆盖文本或图片准入与会话独立模型切换的竞争、排队时基础模型变化、重复请求 ID、拒绝后的恢复和作用域卸载。不依赖睡眠，验证真实顺序、没有递归死锁及另一 Agent 可独立推进。
4. 未注册监听器时，保持普通结果、图片检查和文件凭据行为，并明确接受新的文本顺序。验证协作委托与 Agent 隔离；保持策略失败可见，并确认策略不保存默认值。
5. 回归省略作用域、默认作用域及仅限会话的显式选择，以及投影、回放、取消和鉴权检查。断言直接 `followup` 不触发此事件，避免将未支持路径误认为已覆盖。
6. 批准后增加 Katcats 策略提供者和测试，更新 API 文档与生成参考资料，再执行定向类型、lint、依赖检查、严格构建 Gateway 验证、最新产物构建和构建检查。私聊与群聊各入口满足其验收要求后，才能报告自动跟随可用。

## 审查证据

已批准的 API 补丁增加 58 行、删除 17 行。实施前的隔离上下文与内存类型检查已通过。应用后的 API 已通过定向模型准入、鉴权测试及所属程序的类型检查，不生成文件。Katcats 测试覆盖固定模型切回跟随后的恢复、实际私聊与群聊模型请求，以及冷启动前后成员文件不变。双语配对与本地链接通过。这些源码检查无法证明已覆盖所有外部调用方，也不能代替最终产物构建与构建后的集成验证。
