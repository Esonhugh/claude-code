# 桌面应用（Electron，实验性）

<!-- lang: zh-Hans -->

> 英文名：`desktop-app` · 领域：界面与交互 · [返回功能索引](README.md)

## 这是什么

`desktop/` 子项目用 Electron 把 [Claude Web](web-ui.md) 打包成 Windows、macOS 和 Linux 桌面应用。窗口里就是 claude web 的界面，功能和浏览器里一样。应用内带一份 `claude` binary，启动时以 `claude web --stdio` 运行它，页面和它之间的请求、会话连接都走这个进程的 stdin/stdout，不监听任何端口，也不需要终端里打印的登录地址。

目前是实验性功能：没有发布安装包，需要从源码构建；安装包未签名。

<details lang="en"><summary>English</summary>

> Name: `desktop-app` · Area: UI and interaction · [Back to index](README.md)

## What it is

The `desktop/` subproject packages [Claude Web](web-ui.md) as a Windows, macOS and Linux desktop app with Electron. The window shows the claude web UI and works as it does in the browser. The app ships its own `claude` binary and runs it as `claude web --stdio`: the page's requests and session connections go over that process's stdin and stdout, so nothing listens on a port and there is no login URL to open.

It is experimental: there are no released installers, you build them from source, and they are not signed.

</details>
<details lang="zh-Hant"><summary>繁體中文</summary>

> 英文名：`desktop-app` · 領域：介面與互動 · [返回功能索引](README.md)

## 這是什麼

`desktop/` 子專案用 Electron 把 [Claude Web](web-ui.md) 打包成 Windows、macOS 和 Linux 桌面應用。視窗裡就是 claude web 的介面，功能和瀏覽器裡一樣。應用內帶一份 `claude` binary，啟動時以 `claude web --stdio` 執行它，頁面和它之間的請求、會話連線都走這個行程的 stdin/stdout，不監聽任何埠，也不需要終端裡印出的登入網址。

目前是實驗性功能：沒有發布安裝包，需要從原始碼建置；安裝包未簽名。

</details>

## 什么时候用

- 想要一个独立窗口用 Claude Web，从 Dock、开始菜单或桌面菜单打开，不占浏览器标签页。
- 不希望本机多开一个 HTTP 端口：桌面应用的 claude 只通过管道和应用通信，别的程序连不上它。
- 浏览器里已经开着 `claude web`，还想再开一个窗口：桌面应用不检查是否已有 `claude web` 在运行，两者可以同时跑。

只在浏览器里用、或者要从另一台设备访问时，直接用 `claude web` 即可，见 [Claude Web](web-ui.md)。

## 快速上手

**第 1 步：构建。** 需要 Bun。在仓库根目录：

```sh
make desktop
```

它先 `make build` 得到 `./built-claude`，再把这个 binary 复制到 `desktop/sidecar/`，用 electron-builder 打出本平台的安装包，放在 `desktop/release/`。electron-builder 只能打运行它的平台，所以每个平台要用自己的 binary 各打一次；CI 的 `.github/workflows/desktop.yml` 就是这样做的（手动触发，或 PR 改动 `desktop/**` 时运行，安装包作为 artifact 上传，不创建 Release）。

| 平台 | 产物 |
| --- | --- |
| Windows | NSIS 安装程序（可以选安装目录） |
| macOS | dmg、zip |
| Linux | AppImage、deb |

文件名形如 `claude-code-desktop-<版本>-<os>-<arch>.<扩展名>`，版本取 Makefile 的 `VERSION`。

**第 2 步：安装并打开。** 安装包没有签名。macOS 上第一次打开要在应用上右键选“打开”。应用图标是陶土色圆角方块上的像素蟹（`desktop/build/icon.png`，和网页侧边栏的 Clawd 同形），窗口标题是 Claude Code。应用只运行一个实例，再次打开只会把已有窗口切到前面。

**第 3 步：登录并开始对话。** 窗口里是 claude web 的起始页，不需要 token 或 cookie。账号、认证、会话列表、项目和设置的用法和浏览器里相同，见 [Claude Web](web-ui.md)。Claude 账号登录时，授权页交给系统浏览器打开，应用里不会多出窗口。

**第 4 步：外观。** 设置 → 常规 → 外观选跟随系统、浅色或深色后，窗口的标题栏、菜单和滚动条也跟着变，下次启动在建窗口前就按上次的选择设置，页面载入前窗口背景是 clay 配色的背景色（浅色 `#faf9f5`、深色 `#1f1d1a`），不会先闪白。

不想打安装包、只想在仓库里跑一下：

```sh
make build                  # 得到 ./built-claude
make desktop-start          # 复制到 desktop/sidecar/，安装依赖并打开应用
```

也可以手动指定 binary：

```sh
cd desktop
bun install
CLAUDE_DESKTOP_SIDECAR=../built-claude bun run start
```

## 命令速查

在仓库根目录：

| 命令 | 作用 |
| --- | --- |
| `make desktop` | `make build`，再打出本平台的安装包到 `desktop/release/` |
| `make desktop-package` | 用已经构建好的 binary 打安装包 |
| `make desktop-start` | 用这个 binary 打开应用 |
| `make desktop-test` | 在 `desktop/` 里跑 `bun test` |
| `make desktop-e2e` | 打开应用做端到端检查；Linux 没有显示器时用 `xvfb-run` |
| `make clean-desktop` | 删除 `desktop/sidecar/` 和 `desktop/release/` |

默认用 `./built-claude`；`make` 时 `DESKTOP_SIDECAR=<路径>` 换成别的 binary。

在 `desktop/` 里：

| 命令 | 作用 |
| --- | --- |
| `bun run stage [<路径>]` | 把 binary 复制到 `desktop/sidecar/`，默认 `../built-claude` |
| `bun run start` | 打开应用；设了 `CLAUDE_DESKTOP_SIDECAR` 时用它指向的 binary，否则用 `desktop/sidecar/` 里的 |
| `bunx electron-builder --publish never` | 打安装包 |
| `bun test` | 单元测试 |
| `bun run e2e` | 端到端检查 |

## 和浏览器里的 claude web 有什么不同

- **不监听端口。** HTTP 请求和会话 WebSocket 以带 `\x1eclaude-web ` 前缀的 JSON 行走 stdin/stdout，body 用 base64。应用关掉管道时 claude 退出。唯一的例外是 Claude 登录进行中：和命令行 `/login` 一样，claude 为 OAuth 回调在 `localhost` 上临时监听一个端口，取消后关闭。
- **不用登录地址。** 管道只有启动它的应用能访问，所以不检查登录 cookie；Host（`claude-desktop`）和 Origin 照常检查。不写 `~/.claude/web/server.json`，也不检查是否已有 `claude web` 在运行。
- **页面地址是 `claude-app://app/`。** 会话连接经 preload 暴露的 `window.claudeDesktop` 转给 claude，只接受应用主框架、`/api/` 开头的路径；刷新或离开页面时关闭这一页的连接，之后可以重新连上同一个会话。Chromium 转给自定义协议的请求不带 Origin，应用按发起请求的框架补上：GET、HEAD 以外的请求里，页面自己的 fetch 带应用的 Origin，预览页面等其他框架的 fetch 带它们自己的 Origin，表单提交等其他请求的 Origin 是 `null`，服务端照常拒绝后两种。
- **外部链接交给系统浏览器。** 跳到应用以外的 http(s) 地址、打开新窗口都在系统浏览器里打开；只有应用页面能申请剪贴板、通知等权限。
- **意外退出。** claude 进程意外退出时，应用弹出 `claude stopped unexpectedly (<退出码或信号>)` 对话框，附上最后 20 行日志，然后退出。
- **环境变量。** 从 Dock 或桌面菜单打开的应用拿不到登录 shell 的 `PATH` 和 export，会话里的 Bash 和 API key 设置要用到它们，所以应用启动时用 `$SHELL -ilc` 读一次登录 shell 的环境（10 秒超时，失败时用应用自己的环境）。Windows 不做这一步。
- **配置目录相同，设置文件分开。** 应用里的 claude 和命令行一样使用 claude 配置目录（默认 `~/.claude`），会话记录、项目（`~/.claude/web/projects.sqlite`）和上传文件（`~/.claude/web/uploads/`）与浏览器里的 `claude web` 是同一份。settings.json 和 `.claude.json` 用 `~/.claude/desktop/` 下自己的一份，首次启动时从命令行那份复制，规则见 [Web UI 的设置文件](web-ui.md#设置文件)。
- **外观保存在应用自己的目录。** 网页设置里的外观通过 `window.claudeDesktop.setTheme(mode)` 告诉应用（只接受 `system`、`light`、`dark`），存进 Electron userData 目录的 `appearance.json`；文件缺失或损坏时按 `system`。

## 实际输出

以下来自 PR #1448 的验证（macOS arm64，Electron 45.4.1，`make build` 的 binary）：

- 应用运行时 claude 没有 TCP 监听（`lsof` 确认）。
- 从预览 iframe（`http://127.0.0.1:*`）向 `claude-app://app/api/sessions` 发 no-cors fetch 或表单 POST，服务端返回 403（`untrusted origin`）；带 CORS 的 fetch 被 Chromium 直接拦下。
- 页面加载后控制台没有 CSP 报错；新建会话发消息能收到回复；`electron-builder --mac` 产出 dmg 和 zip，打包后的 `.app` 从 `Resources/sidecar/` 启动 claude；强制结束应用后没有残留进程。

`desktop/e2e.mjs`（`make desktop-e2e`）在 CI 的四个平台上用临时配置目录打开应用，检查页面渲染、新建会话、会话连接开关、Mod 和 MCP App 在各自的框架里运行、登录页交给系统浏览器、MCP App 读不到应用 API 和 `window.claudeDesktop`、预览页面的写请求被拒绝、`setTheme` 改变原生外观。

## 已知限制

- 实验性，安装包未签名，没有自动更新。
- 只在 macOS 实机上手动验证过；Windows 和 Linux 只跑过 CI 的构建、测试和端到端检查。
- 下载和打印没有在桌面应用里专门验证过。
- Windows 上结束应用时，会话的子进程可能残留。

源码和更多构建说明见 [`desktop/README.md`](../../desktop/README.md)。
