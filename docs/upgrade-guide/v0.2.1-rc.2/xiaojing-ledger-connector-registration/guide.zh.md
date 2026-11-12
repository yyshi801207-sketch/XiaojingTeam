---
kind: upgrade-guide
description: 小兢建账就绪后先登记连接，再由所有者绑定到群，远程接口由 handoff 改为 addConnector。
---

# 将已就绪的账套添加到连接器

[English](guide.md) | 中文

## 变更

此前，建账助手通过一次操作添加账套并绑定到所选群组。现在，**添加到连接器** 会将标准 Odoo 连接保存到 **我的连接**。所有者可随后在目标群的 **财务连接** 设置中完成绑定。

`xiaojingLedgerSetup/addConnector` 取代 `xiaojingLedgerSetup/handoff`。请求接收方案 ID 和 `{ apiKey, accessMode }`，其中 `accessMode` 为 `read-only` 或 `full`。建账存储格式沿用原版本。已有的 `handed-off` 方案及其已保存的群绑定仍可查看和使用。

## 迁移

1. 在 **连接器 → 建账任务** 中，对已就绪的方案选择 **添加到连接器**。填写有权访问新 Odoo 公司的独立日常记账 API 密钥，再选择 **只读** 或 **完整操作**。调用远程接口时改用 `addConnector(planId, { apiKey, accessMode })`，省略原来的 `chatId`。
2. 在 **我的连接** 中核对已验证的公司和所选操作模式。要在群中使用该账套，请打开群设置的 **财务连接**，完成绑定并查询该公司的数据。
