---
kind: upgrade-guide
description: "Katcats 桌面安装器采用独立应用身份和数据目录，不覆盖升级 Katcat.AI。"
---

# 独立安装 Katcats 桌面版

[English](guide.md) | 中文

## 变更

Katcats.AI 1.0.2 使用应用标识 `ai.katcats.desktop`、NSIS GUID `f41a22b2-ae23-46e1-9d77-7e317f3e8f4f`、可执行文件与快捷方式 `Katcats.AI`、安装及 Electron 数据目录 `Katcats-desktop`，以及 URI 协议 `katcats-ai`。Host 数据位于 `%APPDATA%\Katcats-desktop\harness`，默认工作区为 `%USERPROFILE%\Documents\Katcats_Home`。它不覆盖升级、扫描或导入现有 Katcat.AI 安装。源码包名保持不变，打包后的 Electron 元数据使用 `katcats-desktop`，以隔离更新缓存。

## 迁移

1. 将 Katcats.AI 作为独立应用安装，保留现有 Katcat.AI 和小兢安装及其数据目录。
2. 在 Katcats.AI 内单独配置模型和凭据；现有凭据、会话和工作区内容不会自动复制。
3. 确认快捷方式打开 Katcats.AI，应用使用新数据目录和工作区，现有产品仍使用各自的目录。新的 Katcats 安装器只会覆盖更新新 GUID 登记的安装。参见[桌面身份说明](../../../../apps/desktop/README.zh.md#permanent-installer-identity)。
