# 小兢会计 Team 开发预览

[English](development.md) | 中文

本教程在当前工程启动独立的 Team 开发基线，需要 Node.js 24 或更新版本及 Git，首次安装依赖需要联网。产品图片和文案暂时保留复制基线的内容，Team 品牌视觉另行确定。

## 准备开发基线

在 Windows 命令提示符中进入工程根目录，使用 Team 脚本，使依赖、应用数据和缓存保留在本工程内。

```bat
cd /d E:\Projects\小兢会计Team版
npm run team:check
npm run team:deps
npm run team:build
```

依赖命令在本地安装仓库指定的精确 pnpm 版本，并按锁文件安装完整的工作区依赖。构建命令构建本工程的客户端和桌面产物并运行聚合检查，不打包或安装桌面产品。原有 `katcats:*` 脚本名仍是同一套 Team 隔离启动器的兼容入口。

本工程存在 `.git` 目录时，构建使用本工程的 Git `HEAD`。必须先提交本地基线再构建；尚无提交的仓库会明确失败，不会使用旧版本代替。没有 `.git` 的源码快照可以使用 `KATCATS-COPY-VERIFICATION.json` 记录的历史 `sourceHead`。启动器不会打开原工程来解析版本或构建本工程。

## 打开预览

构建成功后，启动一种预览：

```bat
npm run team:web
```

Web 服务监听 `127.0.0.1:3390`，也可明确指定其他端口，例如 `npm run team:web -- --port 3391`。在本项目专用浏览器配置中打开本次启动打印的登录地址。完整登录地址属于凭据，不要粘贴到聊天、文档或版本控制中。

未打包桌面预览使用：

```bat
npm run team:desktop
```

桌面开发身份为 `小兢会计团队版 Dev`，应用 ID 为 `ai.xiaojing.accounting.team.development`，数据目录为 `run/desktop/app-data/XiaojingAccountingTeam-Dev`。渲染进程、主进程和 Host 的调试端口分别为 `19422`、`19429` 和 `19430`。这些值用于隔离开发运行，不代表最终发布身份。必须在本产品设置中单独配置模型凭据；仅页面运行不代表聊天可用。

## 开发数据

启动器传入重新创建的环境，包含指定的操作系统工具变量与本项目路径，不继承模型凭据、现有 DSH 设置、共享智能体配置、代理凭据或登录 shell 配置。工具查找排除其他工程的依赖命令目录及旧产品目录，同时保留本工程工具和系统工具。

| 位置 | 用途 |
|---|---|
| `node_modules` 与工作区的 `node_modules` | 本工程安装的开发及运行依赖 |
| `run/home` | 配置、设置、凭据、Bot 定义、会话、群聊与记忆 |
| `run/agents` | 仅供开发的智能体指令与技能 |
| `run/workspaces` | 默认工作文件 |
| `run/desktop` | Electron 应用数据、浏览器会话存储与日志 |
| `run/user` | 开发 home 与操作系统配置目录 |
| `run/tooling`, `run/cache`, `run/tmp` | 本地包管理器、新生成的依赖缓存与临时文件 |

首次桌面启动还会在本工程的 `apps/desktop/.desktop-build` 准备 Node、Python 和配套依赖资源。这些开发资源在本地准备；开发基线不复制旧应用状态、临时验收文件、缓存或安装包。

启动器拒绝逃逸本工程的路径以及逃逸自有 `run` 目录的链接；桌面初始化还拒绝固定数据目录中的链接。`run/` 已被 Git 忽略，其中的凭据、会话与已登录浏览器存储必须保密。

## 验证修改

```bat
node --test scripts\katcats-dev.test.mjs
```

通过启动器的 `developmentEnvironment` 和 `prepareRun` 函数执行模块测试，使测试子进程继承同样的隔离路径。源码修改后先重新构建再预览，Team 启动器不监听修改。验收报告记录实际执行的命令与失败情况，并与计划检查项区分。
