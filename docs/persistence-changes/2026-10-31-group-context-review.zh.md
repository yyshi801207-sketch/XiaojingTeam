---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-31-group-context-review

[English](2026-10-31-group-context-review.md) | 中文

## 概述

为群成员输入来源增加可选的带版本投递覆盖清单和独立复核候选元数据，并增加独立的群复核纠正通知来源。这些来源类型也出现在 inbox、developer 消息及标题请求记录中。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-31-group-context-review
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-24-katcats-group-message-sources"
    after: "f8225012a8b43de20001cb098ba13c08bd37a359902c1f248e46e3834e2afeb9"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-24-katcats-group-message-sources"
    after: "4905ff043fef7395e317d6cd704cd09ba3f0e6af8a7930a91b8fd6da05e4692a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-24-katcats-group-message-sources"
    after: "8b6f470440993f3cd3d8ff271659acef66ba0bc154b16f78c6fa9e9416ead7dc"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-24-katcats-group-message-sources"
    after: "b26023d51ba2427d323d0956ccc318fc729ef3784d29b2581f738a24c9a10baa"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有来源种类及必填字段不变。新读取方将缺少协作版本的已接受任务按旧规则处理；缺少上下文覆盖清单时使用有上限的首次投递，不假定历史已经提供；缺少复核请求不会授予复核权限。原有 Session 读取方只要求 user/developer 消息的 source.kind 非空，并保留其不透明 JSON 字段；未修改的 TypeScript 和 Python SDK 读取方保留这些消息，不将通知当作助手回答或轮次完成。新增通知沿用已有 notice 形式，模型可见的纠正内容存为普通消息正文。Session.create 回放和两套 SDK 投影检查验证了该读取行为。可选字段不授予工具或复核权限：当前群 Host 校验父子任务归属、已持久化成功意见及候选版本。本确认保留 Session 可读性，不承诺旧产品调度器可以安全恢复新协作策略，也不授权应用降级。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/sdk/client/tests/katcats-task-projection.spec.ts --reporter=dot --maxWorkers=1：2 个测试通过，包含新任务元数据和通知的 Session.create 回放。Python test_katcats_task_projection.py：针对同一预期事件内容的 2 个测试通过。group-review-flow 与 group-review 定向测试：17 个通过，包含重启复核限制及文件系统未知结果的隔离。包回归：797 个通过，1 个无关的既有头像顺序 UI 测试失败；头像源码与改动前保存基线一致。新增旧版本存储检查及上下文重启检查包含在该包回归中。未修改 Session 核心读取方及 SDK 读取实现。缺少 DEEPSEEK_API_KEY，未执行真实 API 质量和计费验证。

<a id="dev-note"></a>
## 开发备注

无。
