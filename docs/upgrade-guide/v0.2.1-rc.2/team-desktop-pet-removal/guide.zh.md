---
kind: upgrade-guide
description: "小兢会计团队版移除桌面宠物窗口、设置页、状态接口和宠物专用 IPC。"
---

# 小兢会计团队版移除桌面宠物

[English](guide.md) | 中文

## 变更

独立的小兢会计团队版不再提供桌面宠物。透明窗口、设置栏目、姿态素材、任务状态观察器、loopback 快照与事件接口、宠物 preload 方法均已移除。本变更仅影响这个 Team 项目，其他安装和项目保持不变。

Windows 系统托盘保留“打开应用”和“退出”。关闭主窗口仍会让后台工作继续运行。退出时仍通过 Desktop Host 检查正在运行的 agent、排队输入、后台作业和已启用的提醒。

## 迁移

1. 更新构建后重启团队版。旧进程在退出前仍会保留已有窗口。
2. 从自定义 overlay 中移除名为 `xiaojing-desktop-companion` 或 `ui-desktop-companion` 的条目；对应包已不在此源码树内。自定义集成需要停止调用宠物专用 preload 方法或 `/xiaojing-desktop-companion` 接口。应用元数据仍通过 `xiaojingDesktop.getApplicationInfo()` 提供。
3. 确认设置中没有桌面宠物入口，托盘仅提供打开应用和退出操作。已有 `desktop-companion/preferences-v1.json` 文件保持原样，不再读取或写入，无需重置用户数据。
