---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-11-finance-group-closure

[English](2026-11-11-finance-group-closure.md) | 中文

## 概述

为群复核候选增加可选的制作者引用和准确的 Odoo 操作。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-11-finance-group-closure
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-10-group-finance-welcome"
    after: "c97081e9487c9df9ce7d9e6b0af899c5a81678f6f1b7f9c0aaf6f81992624c2a"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-10-group-finance-welcome"
    after: "2db78c2f7c1e0b1a4a0f2613a34d92c3a5afa400ab8d50a591875291258e704a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-10-group-finance-welcome"
    after: "252eb716b714faf19ecaf86e96bc2976a9b36a12229010f396035c96329a4bd1"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-10-group-finance-welcome"
    after: "67423077b0527d25525a84ada70b7bf5033a49c2e25a2384e2fc0dabcd1ec766"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

未含新增字段的已有候选保持原内容摘要，继续可读。新读取方将来源以及绑定的连接器、公司、服务地址、数据库、方法和规范化参数纳入摘要。新候选不能通过旧读取方的候选摘要检查，旧运行时拒绝放行，不会借用无关复核执行操作。现有 Session 来源判别类型中的两个字段均为可选，不重写任何历史日志世代。

<a id="verification"></a>
## 验证

群复核聚焦测试已通过，覆盖候选不匹配和冷恢复。group-review-orm-flow 测试已通过，覆盖准确写入复核、回读后交付，以及写入结果未知后的重启。build:artifacts 和 build:check 已通过；最终发包锁修复同时有聚焦运行时测试覆盖。

<a id="dev-note"></a>
## 开发备注

无。
