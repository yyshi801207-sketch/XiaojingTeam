# 小兢Bot Windows 桌面端

小兢Bot V1.0.2 的产品版本为 `1.0.2`，应用标识为 `ai.xiaojing.accounting.team.desktop`，安装目录为 `XiaojingAccountingTeam-desktop`，并使用独立文档工作区。它不覆盖升级 Katcat.AI，也不导入 Katcat.AI 或小兢会计数据。本地未签名 Windows 包在 `.env.windows` 使用 `DSH_DESKTOP_APP_ID=ai.xiaojing.accounting.team.desktop`，不嵌入强制更新策略和更新源；本产品不嵌入更新源或远程强制更新策略，继承的发布配置不能选择其他产品的服务。

[English](README.md) | 中文

全新安装默认进入 `%LOCALAPPDATA%\Programs\XiaojingAccountingTeam-desktop`，只有团队版 GUID 登记的安装可以覆盖升级。安装页底部保留 `installer-company-source.png` 中的基线字标。每次成功安装或重装都会初始化一次浅色主题，详见[用户数据路径](#permanent-user-data-paths)。Katcat.AI 安装、工作区和会话路径保持不变，新默认工作区为 `Documents\XiaojingAccountingTeam_Home`。

“小兢Bot”的私有 Electron 部署应用。它通过 Windows 安装包而不是 npm 分发，启动随包提供的 Node 运行时和 Web profile，将 renderer 与 Node 隔离，并在一个 Windows 桌面窗口中呈现本地 Host。

应用文档、随包资源以及顶层 PNG、SVG、ICO 和 Web manifest 文件在 Host 启动前由随包前端目录提供。API 请求、插件代码和事件流仅在已认证的 Host 就绪后转发；就绪前返回 503，不会被当作这些静态资源处理。每次文档启动都通过私有 IPC 获取运行中 Host 的当前注入表，HMR 重新构建后刷新 renderer 会使用当前插件代码版本。请求失败或读取期间 Host 被替换时，启动直接报错，不复用首次启动的注入表。

启动界面直接使用用户提供的 3840×2400 纸纹 PNG，不重新编码。图片在浅色背景上居中等比完整显示，不同窗口比例下均保留中央标识与边角图案。标识下方显示一条较短的绿色加载条，下方以较小字号显示本地化的“正在启动”；减少动态效果偏好会让加载指示保持静止。启动界面留在同一应用文档中，直到客户端渲染第一个界面；主界面继续使用白色背景，不新增等待或页面跳转。启动期间关闭或最小化窗口，在初始化完成后仍然有效，显式打开操作可在启动时恢复窗口。

自动化任务已内置于 Desktop 承载的 Web 应用。新 profile 只选择随包提供的 Web 组合，不再加入退役的实验性 Schedule bundle。升级时由 Host 的标准 profile 加载器移除该退役声明，并保留其它组合包选择、已安装依赖、用户元数据和显式插件覆盖。既有任务保持不变；全新安装本身不会创建或执行任务。

独立 小兢Bot 副本的原生应用菜单、关于面板、窗口标题、托盘入口和本地化对话框统一显示 小兢Bot。Windows 主程序和安装器的文件描述及商标元数据均标识团队版产品。产品显示名称和快捷方式为“小兢Bot”；既有团队版的 App ID、NSIS GUID、可执行文件、安装目录、URI 协议和永久数据路径固定不变，支持覆盖升级。开发进程继续使用独立的 小兢Bot Dev 身份。

<a id="permanent-installer-identity"></a>
## 永久安装器身份

`identity.json` 是身份源配置，`verify-desktop-identity.mjs` 固定校验这套独立产品身份：

| 字段 | 值 |
|---|---|
| Package name | `@deepseek-ai/dsh-desktop` |
| App ID / AppUserModelId | `ai.xiaojing.accounting.team.desktop` |
| NSIS GUID | `c8462347-245f-49dd-8195-e1174bb7e3ef` |
| 安装目录 | `XiaojingAccountingTeam-desktop` |
| 可执行文件 | `XiaojingAccountingTeam.exe` |
| 产品名称 | `小兢Bot` |
| 安装范围 | 当前 Windows 用户 |
| 快捷方式 | `小兢Bot` |
| 打包应用名称 | `xiaojing-accounting-team-desktop` |
| URI 协议 | `xiaojing-accounting-team` |

本产品不提供共享的“管理 dsh 命令”菜单，也不注册全局 `dsh` 命令。打包时，Windows 可执行文件名取自 `identity.json.executableName`，macOS 可执行文件名取自 `identity.json.productName`。仅含 ASCII 的 Windows 批处理命令通过随包 primary Node 运行时，将参数和继承的标准流转交给 Electron Node mode，不改变控制台代码页；它等待 CLI 完成控制台中断退出，并保留退出码。CLI 仅在未附着控制台时连接父进程的控制台；父进程没有控制台也不会阻止后台命令执行。

全新安装使用两阶段品牌安装流程。欢迎页显示小兢标识、数豆绿色安装操作和可选的行内父目录选择器，并自动补齐 `XiaojingAccountingTeam-desktop`；安装页继续显示小兢图片，隐藏 NSIS 默认详情区域，显示真实文件进度，完成后直接启动应用，不再显示单独的完成页。欢迎页包含安装许可提示，内部使用说明、完整的上游许可和第三方声明仍随包保存在 `resources/legal`。全新安装到原本不存在的目标目录时，关闭或取消进度页会显示原生确认提示。确认取消会启动外部清理程序并以 `1602` 退出；安装器进程停止后，清理程序校验固定安装目录名，只删除部分应用、当前用户安装记录和快捷方式。目标目录在安装前已存在时禁用取消。覆盖升级在开始替换文件前仍可从欢迎页退出；文件安装一旦开始，为保护原版本将禁用取消。用户数据路径不参与任何清理。具有相同身份的新版安装器会从固定的当前用户 GUID 精确读取 `InstallLocation`、隐藏路径选择、请求已安装应用为升级退出，并且只处理可执行文件位于该安装根目录内的进程。调用旧卸载器前，同一个固定根目录辅助程序只清理绝对路径超过旧式 Win32 限制的旧版程序项，避免深层解包依赖被误报为应用关闭失败。随后标准更新流程替换应用文件并刷新快捷方式和卸载信息。无关进程和受保护的用户数据不会被扫描、终止或删除。迁移安装位置仍需卸载后重装。

品牌安装界面显示小兢Bot和用户指定的财务团队插画，在 820×680 白底窗口中以最高 640×360 像素显示。短屏幕会同步缩小窗口和插画，保留标题、安装操作和底部说明。完整的 1536×1024 PNG 原样保存在 `build/installer-robot-source.png`；位图生成器在白底上按原比例居中，不裁切或拉伸人物。用户提供的四色数豆科技字标单独保存在 `build/installer-company-source.png`，以 180×58 像素显示在页脚。`prepare:icons` 一并生成欢迎页、小图、页眉、侧栏、底部品牌位图与原生图标。卸载侧栏使用相同的团队插画。

用户指定的白色应用 PNG `应用程序图标.png` 原样保存在 `build/installer-icon-source.png`，保留透明边缘与金色装饰。`scripts/prepare-windows-icon.ps1` 校验 SHA-256 与 1254×1254 尺寸后，原样复制到桌面 PNG 别名、产品关于页图标、浏览器标签和下载页图标，并保留独立的安装页底部字标。`node apps/desktop/scripts/prepare-installer-icon.mjs` 使用现有 electron-builder 图标工具生成多尺寸 `build/installer-runtime-icon.ico` 与 macOS `build/app-icon.icns`。Windows 程序、安装、卸载、内容寻址快捷方式和退出对话框使用该 ICO；打包对话框读取其相同副本 `resources/tray.ico`。原生窗口、任务栏和托盘使用 `assets/windows-icon.png`，Linux 与原生关于对话框使用相同的应用 PNG。这些准备命令不会安装或发布应用。应用直接打开 Team 工作区，由产品插件显示首次使用的 API Key 说明，不提供 DeepSeek 账号登录或原生认证欢迎窗口。

程序文件安装后，安装器将图标复制到 `resources/katcat-icon-<sha256>.ico`，把现有桌面和开始菜单快捷方式的图标引用更新为这个按内容命名的路径，保留 AppUserModelId，并向 Windows Shell 发送针对快捷方式路径的更新通知。即使应用版本号不变，更换图标也会得到新路径。此步骤也适用于静默升级，不会重建上游快捷方式策略省略的链接。写入失败时提供重试，或返回退出码 `2`，不会按安装成功启动应用。此流程不重启资源管理器，也不删除系统图标缓存。`dist:win` 会生成图标并运行 `verify:installer-shortcuts`；该检查使用隔离的临时快捷方式编译实际更新逻辑，验证图标变更、重复安装、省略桌面链接和图标文件锁定失败。

<a id="permanent-user-data-paths"></a>
## 永久用户数据路径

Electron 在获取单实例锁之前，将 `userData` 固定为 `%APPDATA%\XiaojingAccountingTeam-desktop`。随包 Host 使用其 `harness` 子目录作为 `DSH_HOME`。Host 从 `%USERPROFILE%\Documents\XiaojingAccountingTeam_Home` 启动，并通过 `XIAOJING_OFFICE_WORKSPACE_ROOT` 传入。此构建不创建财务工作区。添加操作未提供初始路径时，Electron 目录对话框默认进入 `XiaojingAccountingTeam_Home`，用户可以选择其他目录。现有 Katcat.AI 与小兢数据目录不读取、不导入。[Models 引导协调器](../../packages/client/ui-settings-models/README.zh.md#onboarding-coordinator)根据安装标识和可用提供商状态决定是否显示引导。卸载保留团队版数据，删除工作区不等于清除会话、配置或计费记录。

每次成功的 NSIS 安装（包括同版本重装）都会在可执行文件旁的 `katcat-installation-id.txt` 中写入新 GUID。Desktop 在启动 Host 前持有 profile 锁；安装标识尚未处理时，只将 `ui-theme.preference` 设为 `light`，再把该标识记录到 `userData/desktop/installation-theme-id.txt`。其他设置、凭据、会话和用量数据保持完整。普通重启保留用户此后选择的主题。Desktop 通过 `KATCAT_DESKTOP_INSTALLATION_ID` 向 Host 提供这个公开、非机密的标识；没有安装标记的构建保持原有行为。

0.2.1 RC2 的 `DesktopHostProcess` 负责 loopback Host 生命周期，并固定 `DSH_CLIENT_BUILD_PROFILE=xiaojing`，因此只有 Electron shell 会加载应用，打包后的小兢专属 Host 插件也会保持启用。桌面端将认证令牌交换为应用 HTTP 请求使用的 Host Cookie，用户无需手动打开日志中的地址。

桌面 Host 为安装版和预览版设置 `KATCATS_PRODUCT_MODE=1`，启用成员名录、群聊、分作用域记忆和 Katcats 侧栏配置，并禁用原输入区模型菜单。独立的 `KATCATS_DEV_MODE=1` 仅让未打包预览使用仓库 `run` 数据和临时开发身份；开发入口同时设置两个标志。即使存在开发环境变量，安装版仍使用独立的 Katcats 永久路径。

`user-data-contract.json` 保护会话、设置、凭据、agent 预设、profile、storage、旧版上传文件、原生图片附件、用量统计、专用浏览器操控 profile、微信频道状态、桌面宠物偏好、Electron Local Storage 和“文档”工作区。安装器设置 `deleteAppDataOnUninstall: false`，且不会访问这些路径。`verify-user-data-contract.mjs` 使用合成的 0.1.9 数据集验证应用文件替换和当前读取实现；除将包含旧版文件上传组合包的精确安装默认 Web 列表（含或不含 ModLens）迁移为当前 Web 模板外，所有受保护数据必须保持字节不变。它还会在私有副本上验证扁平凭据到 version 1 的原子迁移不会生成明文备份，并检查会话、凭据、预设、设置、上传、storage 和用量兼容。V3 会话迁移接纳此样本紧挨首个步骤之前的用户消息，同时不改写源文件；升级版发布前仍必须通过该门禁。若发布版改变其他持久格式，必须先增加原子迁移和上一正式版 fixture，才能调整此检查。

平台账号页面通过 Electron 的 `session.fromPath` 使用 `sessionData/p/<SHA-256 的 base64url 编码>` 保存浏览器数据，保留完整的签发方与账号摘要，同时缩短 Windows 缓存路径。首次打开账号的 Session 前，会将已有 `Partitions/dsh-platform-<SHA-256 十六进制编码>` 目录原子移动到该账号的新目录，保留偏好和浏览器文件；新旧目录同时存在时明确报错，不覆盖任何一方。Host 登录凭据和原有认证 Cookie 清理规则不变。没有稳定账号身份时仍使用内存存储。

Host 将 `DSH_AGENTS_HOME` 固定到 `harness/agents`；Electron 将浏览器会话数据放入 `userData/session-data`。旧产品的运行时路径、Node 注入配置、个人浏览器覆盖和继承 API 凭据均被清除。显式 `XIAOJING_TEAM_*` 浏览器配置只属于本产品，不导入其他安装产品的数据。

## 开发预览隔离

仅源码 Electron 预览可以在启动桌面包之前，将 `DSH_DESKTOP_PREVIEW_ROOT` 指向一个空的临时目录。未打包运行会把 Electron 应用数据和“文档”工作区同时放到该目录下；打包后的应用忽略此变量，并继续使用上文固定的永久路径。这样可避免开发预览读取或写入已安装用户的数据。创建开发窗口前，桌面端会校验共享 Client 产物是否来自一次完整的小兢构建；记录缺失或 profile 不匹配时直接提示运行 `pnpm run build:xiaojing`，不再展示官方或残缺界面。

## 系统托盘生命周期

主窗口的 preload 在应用渲染前启用 Web 布局的 40px Windows 标题栏。会话与插件控件位于原生窗口按钮下方。拖拽区域由布局管理，不向可交互内容上方注入遮挡层。

团队版不提供桌面宠物窗口、设置入口、任务状态观察器、状态流、宠物 IPC 或随包姿态素材。Windows 系统托盘由 shell 独立管理，仅提供打开应用和退出操作。旧桌面宠物偏好文件仍属于受保护的用户数据，应用不会读取或写入这些文件。

关闭主窗口会将其隐藏到托盘，应用继续运行。最小化按钮保持正常的任务栏行为；再次启动会恢复现有主窗口；应用菜单和托盘中的退出使用同一退出控制器。控制器通过 Desktop Host 检查运行中的 agent、排队输入、后台作业和已启用提醒，再决定是否确认中断；随后先销毁主窗口，再停止 Host，避免 renderer 事件流在退出期间重连。应用退出前会等待 Platform 清理和 Host 退出；shell 关闭时释放托盘。首次转入后台使用共享通知控制器。受限产品 bridge 继续提供应用元数据；目录选择和打开现有绝对工作区路径使用独立的窄接口。主进程验证所属 renderer 和路径；renderer 不会获得 Node、文件系统、任意 IPC 或 BrowserWindow 访问能力。

## 内置自动化运行环境

浏览器操控使用[原生 Edge 与 Chrome 连接](../../packages/xiaojing/xiaojing-browser-control/README.zh.md#native-browser-connections)。默认使用 Edge；用户明确要求 Chrome 时选择 Chrome。浏览器控制设置通过浏览器的远程调试权限与连接批准启用已经打开的标签页，无需扩展配对、填写端口或 Token。在所选浏览器和设备策略允许时，专用连接提供独立浏览器 profile。Windows 应用操控使用 Windows PowerShell 5.1 和操作系统自带的 `System.Windows.Automation` API。终端用户无需安装 Node、浏览器驱动、PowerShell 模块或独立自动化服务。

两项能力分别位于独立 Cordis 配置行中。开发 overlay 可以单独禁用任意一项，小兢产品组合则默认启用二者，并在每个新 agent 会话中说明当前可用能力。浏览器和 Windows 观察都使用会话独占的不透明 ID，并在状态变化后过期。受保护动作请求审批；明确的会话授权仅适用于合格的已观察操作与目标分类，未分类的动作仍逐次授权。

## 独立集成补丁

`integration-patches.json` 将桌面 API Key 环境隔离、profile 运行时遮蔽防护和附件上传输入区修复与品牌产品插件分开登记。可写凭据界面由 rc.2 提供；桌面补丁在 Host 启动前清除继承的 API 凭据和旧产品运行时路径。某个条目消失或所属路径不存在时，桌面身份检查会失败。这样可以聚焦上游冲突审查，同时不会把这些补丁冒充为 Harness 官方行为。

## 发布检查

桌面打包目标构建小兢 Client profile，并向 DSH tarball 打包传入 `--client-profile xiaojing`。打包器同时校验精确公开构建值和产物摘要；普通 npm 打包与发布继续要求官方 profile。

准备随包运行时前，先运行身份、用户数据、产品层、托盘生命周期、真实 Edge 和 Windows UI Automation 测试。正式发布还必须在默认路径与自定义路径分别完成全新 Windows 安装，以及从上一安装包覆盖升级。安装后确认会话、凭据、预设、插件、附件、工作区、用量数据、专用浏览器 profile、微信频道状态和桌面宠物偏好全部保留，才能发布安装器。

0.2.1 RC2 打包流程会在写入发布记录前对组装后的应用运行 `smoke-packaged-runtime.ts`。该检查会验证准备好的 DSH 目录、随包可执行文件和主运行时，包括 ASAR 外的原生 Office 转换。

<a id="local-desktop-settings"></a>
## 桌面设置与打包

Electron 在启动时读取一次 `userData/desktop/settings.json`。可选布尔项 `updates.allowTestAuthPopupWindow` 默认为 `false`；设置文件缺失时创建默认文档，不覆盖已有文件，设置无效时保留原始文件并使用默认值继续启动。该选项只控制测试更新认证，不会启用小兢隐藏的官方账号欢迎流程。修改后须重启。

随包的 `dshDesktopUpdateChannel` 选择 `nightly` 或 `latest`，旧清单默认使用 `nightly`。团队版不执行更新检查、不嵌入远程策略，也不显示更新和共享命令菜单；应用 preload 不请求强制更新 IPC，也不挂载继承的更新浮层；频道字段仅作为共享打包实现的元数据。打包继续区分小兢产品身份与内核包版本。保留构建的上传验证使用该构建的原产品版本，不受后来源码版本变化影响。

Electron 运行时准备使用已安装 Electron 包附带的校验值验证缓存档案，与其安装器保持一致，无须单独下载校验文件。

上游[打包参考](packaging/README.zh.md)说明机器预设、签名、未签名及未公证输出；[Windows 签名指南](windows-signing/README.zh.md)说明硬件签名要求。小兢还须通过前述身份、数据保留及 Client profile 检查。上游发布及 CI 示例指向 DeepSeek 基础设施，不代表允许向这些服务发布小兢产物。

## 已知限制

- 团队版尚未配置更新服务。安装包不带更新源或强制策略，桌面端禁用更新器；硬件签名仍属于独立打包操作。
- 覆盖升级只适用于同一 Windows 用户，且不能在升级过程中迁移安装目录。
- 所选 Edge 或 Chrome 必须已经安装且设备策略允许使用。现有标签页访问还需要原生远程调试权限与连接批准；失败不会切换浏览器。
- 内置自动化依赖语义而不是视觉，不能操作纯像素控件、验证码、UAC、安全桌面或管理员权限应用。

<a id="bundled-workspace-dependencies"></a>
### 随包工作区依赖

桌面主进程在 Host 构建完成后内联工作区依赖；`desktop-bundle-imports.mjs` 在打包前检查无法解析的导入。

<a id="release-versions"></a>
### 发布版本

`identity.json.productVersion` 决定小兢应用版本，工作区包版本标识 Harness 引擎。未打包预览的关于页面和产品界面显示身份清单中的产品版本，已打包应用显示其打包版本。`DSH_DESKTOP_BUILD_VERSION` 必须以经过验证的 test 预发布格式扩展应用版本。

<a id="upload-updates"></a>
### 上传更新

团队版尚未配置更新发布目标。桌面上传和安装更新发布命令在读取凭据、访问网络之前，直接报“Team发布目标尚未配置”；Windows 凭据启动器也在打开凭据文件前拒绝上传模式。上游上传示例不授权使用其他产品的存储或更新源。

<a id="windows-ev-signing"></a>
### Windows EV 签名

签名打包需要已配置的 EV 证书、签名工具链及签名缓存归属检查。本地 unsigned 验收不执行硬件签名，也不授权发布正式版本。
