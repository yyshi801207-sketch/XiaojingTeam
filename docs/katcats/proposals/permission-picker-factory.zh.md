# 复用当前 Session 的权限选择器

[English](permission-picker-factory.md) | 中文

## 已批准范围

用户已批准独立 Katcats 副本中的这项有限 DSH API 例外。公开的 `ui-permission-presets/client` 入口提供 Session 作用域的 `permission.select` 组件 Factory。产品通过公开渲染器调用 `renderFactorySlot('permission.select', { locked })`，不导入私有组件，也不重新声明输入框的权限 slot。[所属包说明](../../../packages/client/ui-permission-presets/README.zh.md)描述该 API。

Factory 复用原选择器、进程共享目录及当前 Session 的 `/permission <preset>` 写入。现有选项、风险确认、取消、目录撤回及失败处理保持原行为。`locked` 禁止操作并关闭待确认状态。选择经过所需确认后立即通过原命令生效，与外层表单的保存按钮独立。原输入框、斜杠命令及未来会话默认设置保持原行为。这项例外不增加 Host API、权限策略、持久化字段或授权绕过。

用户随后明确要求通过一次群级选择统一设置成员权限，因此已批准的 UI 范围增加 root 作用域的 `permission.select-batch` Factory。它复用原权限菜单和风险确认，说明群名及成员数量，经勾选确认后只调用一次产品所属回调。受控目标身份或资格变更会使待确认操作失效。此扩展仅涉及公开 UI Factory，不授权新增后端权限 API、策略、持久群默认值，也不绕过原有风险门禁。

## 产品的 Session 管理

Bot 设置使用当前私聊 Session。群设置从本群记录中保留每个当前普通成员的精确执行 Session，等待 `SessionReference.ready`，再通过公开 `SessionProvider` 建立作用域。隐藏、移除、不可用或卸载时释放引用。群 transcript 根 Session 及成员私聊 Session 都不能替代本群执行 Session。

获取引用要求客户端已连接、当前 Bot 与群目录均就绪，并在保留前重新检查成员资格与执行 Session 身份。缺少投影或目录时不开放选择器。单成员选择仅影响绑定的 Session。批量回调校验精确的已保存成员与执行 Session 集合，分别调用各 Session 原有的公开命令 API，检查命令结果而非仅判断是否匹配命令名。设置未保存、目标不可用、隐藏或断线时不接受新批量操作。成功、失败、未执行及结果不确定的成员分别报告；派发后的取消不承诺回滚。不增加持久群级权限策略。

## 隔离验证

[Factory 测试](../../../packages/client/ui-permission-presets/tests/permission-factory.client.spec.tsx)采用真实 SlotRegistry 和 Session 渲染器，以及合成的会话引用，覆盖共享目录与投影、精确会话写入、会话切换、风险确认及取消、选项撤回、命令拒绝、锁定与不可用状态、插件卸载。所属包的 47 项焦点测试通过；最终测试类型修正后，新增的八项 Factory 测试再次通过，包 Client 类型检查、三个文件 lint 及双语 README 检查通过。本记录不声称最终全仓构建或浏览器验证完成，二者由协调集成检查负责。测试不使用真实用户数据、凭据或已安装应用。

[批量 Factory 测试](../../../packages/client/ui-permission-presets/tests/permission-batch-factory.client.spec.tsx)通过同一真实 root Factory 注册表渲染，不提供 Session provider，覆盖每次确认仅调用一次所属产品回调、三项风险门禁、完整中英作用范围文案快照、混合值、目标变更、锁定、隐藏、目录变化、财务资格、未完成或拒绝的回调以及卸载。Factory 自身不调用 Session 命令；精确执行 Session 写入及部分结果由产品层验证负责。
