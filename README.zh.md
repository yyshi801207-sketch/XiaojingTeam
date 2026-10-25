# 小兢会计团队版

[English](README.md) | 中文

本仓库是小兢会计团队版的独立开发基线，包含完整应用源码、工作区依赖、桌面运行时准备和打包工具。团队版使用指定的 SUDO 字标、财务机器人和小兢应用图标，数据与安装目录继续和其他产品隔离。

<a id="run"></a>

<a id="run-from-source"></a>

## 本地开发

使用 Node.js 24 和 Git。在本项目目录打开命令提示符，执行：

```bat
cd /d E:\Projects\小兢会计Team版
npm run team:check
npm run team:deps
npm run team:build
npm run team:desktop
```

依赖命令在当前工程内安装固定版本的包管理器及锁文件规定的完整依赖。构建同时生成产物并执行聚合检查。首次桌面预览会准备自己的 Node 和 Python 资源。依赖和资源属于本项目，构建与启动不需要其他应用的工程目录。数据路径和 Web 预览见[开发预览指南](docs/katcats/development.zh.md)。

请在本应用设置中单独配置模型和 API 密钥。应用不会导入其他产品的凭据、Bot、聊天、记忆、浏览器配对和工作区。开发数据位于 Git 忽略的 `run/` 目录，请妥善保管。模型 API 费用由服务商另行计收。

## 产品隔离

桌面身份、安装器标识、可执行文件、URL 协议、应用数据、默认工作区、开发端口和浏览器扩展配对均为团队版专用。应用不会注册共享的全局 `dsh` 命令，不使用继承的产品更新源，也不向继承的采集端发送产品埋点。各项设置分别见[桌面身份与打包](apps/desktop/README.zh.md)和[浏览器配置](packages/xiaojing/xiaojing-browser-control/README.zh.md)。

本地 Git 仓库拥有自己的历史，未配置发布远端。基线复制记录仅用于记载历史来源；启动与构建命令从本工程解析路径，并使用当前 Git 版本。保留的内部包名属于实现标识。

## 应用能力

- 创建具有独立职责、头像、模型、权限和持久记忆的 Bot。
- 通过私聊或群聊协作，为群聊指定负责人和成员职责。
- 查看交接记录与任务状态、批量调整权限，并选择何时打断后台工作。
- 发送附件，并在聊天中直接打开交付文件。
- 使用中英文、明暗主题和桌面宠物。

## 验证与打包

修改模块后运行对应的聚焦测试，预览前重新构建。[架构](docs/architecture.zh.md)、[测试指南](docs/testing.zh.md)和[贡献指南](CONTRIBUTING.zh.md)说明继承的工程工作流。[基线验证记录](TEAM-BASELINE-VERIFICATION.json)记载本地环境和已完成的隔离检查。

Windows x64 安装包的生成方式见[桌面打包指南](apps/desktop/packaging/README.zh.md)。本开发基线没有发布团队版安装包或公开下载。发布需要另行配置团队版仓库及发布目标。

## 来源与许可证

本项目源自复制的 Katcats 代码基线和 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，后者使用 [Cordis](https://github.com/cordiverse/cordis) 提供智能体运行时。历史名称和上游声明用于注明代码来源，不会使运行中的应用连接其他产品。本项目并非 DeepSeek 官方产品。

源码采用 [MIT 许可证](LICENSE)，保留上游版权声明。第三方依赖继续使用各自许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 [vendored 源码声明](vendor/README.md)。
