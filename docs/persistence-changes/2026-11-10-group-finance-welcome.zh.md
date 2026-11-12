---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-10-group-finance-welcome

[English](2026-11-10-group-finance-welcome.md) | 中文

## 概述

增加群聊主 Bot 连接欢迎消息的来源类型。消息来源保留已验证的账套、公司、币种及发出者。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-10-group-finance-welcome
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-31-group-context-review"
    after: "535215fa614274db6071f3304ba9105ab329c49493db97b72a4f160a1b1871bb"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-31-group-context-review"
    after: "63ea3fc41e55a68e5993b9c91607c295e89c103eec44bfabffc8d4896f61ec11"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-31-group-context-review"
    after: "ad067196d3888185506b91b663249b85b3c34ab5fad77dd075910afab4539c09"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-31-group-context-review"
    after: "c83213ee2bb491cbd3343dfd070149741bbeb40390bb1e1adb06c57efe59f665"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有来源类型及其字段保持有效。当前会话读取器保留来源类型非空的用户消息及其附带字段。旧版读取器可通过普通正文和通知摘要回放欢迎消息。两个 SDK 保留消息来源，不将其解释为模型回复或轮次完成。群聊执行以保存的绑定为授权依据，历史通知不作为当前账套的证据。

<a id="verification"></a>
## 验证

群聊财务流程与 TypeScript SDK 投影共通过 8 项测试。Python SDK 投影通过 3 项测试。覆盖重开后保留通知、失败和绑定变更时不发出欢迎消息、保留消息来源以及不生成模型回复。

<a id="dev-note"></a>
## 开发备注

无。
