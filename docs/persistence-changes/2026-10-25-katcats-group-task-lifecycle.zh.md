---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-25-katcats-group-task-lifecycle

[English](2026-10-25-katcats-group-task-lifecycle.md) | 中文

## 概述

新增产品拥有的 katcats/group-task-lifecycle 日志事件，记录已持久接收的群任务及其实际状态，包含稳定标识、已记录参与者及恢复标记。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-25-katcats-group-task-lifecycle
baseline: false
changes:
  - root: "event:katcats/group-task-lifecycle"
    previous: null
    after: "b2e773007bb506562cf53b4d5750ec6046cbe18a12465f83a5f9809b197c3cbf"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新读取方接受不含该事件的旧 Session，并保留既有消息与已提交代。该事件仅用于日志，不改变模型可见消息或授权。旧读取方在恢复或截断 Session 前，会拒绝不识别的必读事件类型，不会静默误解任务历史。因此可依靠现有事件类型标识保持格式版本不变。恢复仅从产品任务记录补齐历史，明确标注重建记录，不会为了重建历史而派发任务。既有确认记录和已提交代均保持不变。

<a id="verification"></a>
## 验证

node run/tmp/presentation-api-buildcheck-tests.mjs packages/api/katcats-team/tests/group-transcript.host.spec.ts packages/api/katcats-team/tests/team-loader.host.spec.ts packages/api/katcats-team/tests/entity-lifecycle.host.spec.ts packages/api/katcats-team/tests/chats.host.spec.ts：91 项通过，覆盖真实成员工具交接、接收写入拒绝、群记录 flush 未确认时阻断后续工作、冷恢复及去重、取消与结果不明区分、固定身份，以及私聊和其他群隔离。七个变更的 Host 源码及测试文件通过焦点 lint。

<a id="dev-note"></a>
## 开发备注

无。
