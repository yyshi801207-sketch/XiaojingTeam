---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-24-katcats-group-message-sources

[English](2026-10-24-katcats-group-message-sources.md) | 中文

## 概述

在现有用户角色消息及其所属请求消息数组中增加 Katcats 群任务、已完成成员回复转交与明确继续三种来源。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-24-katcats-group-message-sources
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "f1f697022143958a6446d942f1752508ef2684ade7f7c5729bb389326e4dac65"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "5b7c42b9bdac7fb9ec4d2fba57e6706fadd4782e12e22cef3ba5a6dded98f76d"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "277950869237fd4023d4806cd2b003f4d48ec748dc3ec60ddbc69aa4107171a2"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "25d308b3d57e977f06fdaa8400acf3096385e2af1a943bff729d90222678f5ac"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

Session 头、事件名称、事件封套、消息角色与现有来源分支不变。旧记录缺少这三种来源时仍可读取。未加载 Katcats 生产方的读取器保留未知来源种类及其 JSON 元数据，派生相同的 user 角色正文；既有 relay 与 notice 形式提供通用上下文展示。不要求新增消息解释器、回放权限或权限授予。Katcats 生产方使用派活标识核对自身持久任务回执；移除生产方会移除协调能力，不会把已记录上下文转换成 assistant 输出或执行成员任务。收件箱拼接和标题请求消息数组保留相同的嵌入消息。保持当前 Session 版本，并保留已接受的历史模式。

<a id="verification"></a>
## 验证

真实 Loader 的群聊专项测试覆盖成员任务与转交回复持久化、明确继续、冷回放不重复派活、成员刷盘后回执写入失败的恢复，以及发送者身份快照。node run/tooling/check-p3-generic-reader.mjs 使用 P3 前的核心构建产物且不加载 Katcats，验证通过：三种来源、元数据、user 角色正文和已记录事件序列均经公开的独立恢复保留，只增加已说明的恢复标记。首次持久化预检报告四个受影响根，并要求本次明确的同版本兼容审查。

<a id="dev-note"></a>
## 开发备注

无。
