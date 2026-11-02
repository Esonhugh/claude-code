# `claude web`：本地 Web 对话与研究界面设计

状态：设计稿，未实现（计划在 v2.1.296 发版后开始）
基线：`dev` 64fd4f3
日期：2026-11-02
Issue：#502

## 1. 目标

`claude web` 在本机起一个 Web 服务，并打开浏览器，提供类似 ChatGPT 的对话界面。它主要用于聊天和研究，同时补上终端做不到的部分：

- 正确渲染 Markdown、表格、代码高亮、数学公式、Mermaid 图和图片。
- 上传文件和文档，并在页面里预览 PDF、Office 文档、表格、HTML 和图片。
- 管理多个会话：列出历史、恢复、新建和停止。

fork 定位是通用个人 agent，所以 Web UI 默认面向对话和研究，不假设当前目录是代码仓库。

### 非目标

- 不做多用户托管、账号体系或云同步。服务只给本机的当前用户用。
- 不替代 TUI。两者共用同一套 agent 引擎和 transcript。
- 第一版不支持远程访问。局域网和 TLS 放到最后阶段，并且必须显式开启。
- 不追官方 parity，官方没有对应功能。

## 2. 参考：DeepSeek Harness 的 `dsh web`

源码：`deepseek-ai/deepseek-harness`（MIT，读的是 ce7073d）。

| 方面 | dsh web 的做法 | 对本 fork 的取舍 |
|---|---|---|
| 入口 | `dsh web` = `dsh --profile web`（`apps/cli/src/args.ts`、`packages/bundle/web-app`） | 做成独立子命令 |
| 架构 | 一切都是 Cordis 插件；约 70 个 `ui-*` 插件在运行时由 `window.__DSH_BOOT__` 装配 | **不照搬**。耦合太深，拆出任何一个 UI 包都要重写插件胶水和 slot 系统 |
| 协议 | 上行 HTTP `POST /api/*` RPC，下行两条只读 WebSocket；审批用 `waterfall/cancel` 帧 | 只借思路。我们已有 stream-json 和 `claude server`，直接用 |
| 安全 | Host/Origin/`Sec-Fetch-Site` 检查（`api-request-trust.ts`）；启动 token 换 HMAC 签名的 HttpOnly + SameSite=Strict cookie（`browser-auth.ts`）；拒绝通配地址 | **采用**，按 Bun 重写 |
| Markdown | mdast + GFM + math，增量解析（只重解析尾部两个块），自写 mdast→React，raw HTML 当文本输出，URL 协议白名单；shiki + KaTeX | **采用**（保留 MIT 声明，或参照重写） |
| Mermaid | 不支持 | 自己加，懒加载 |
| 预览 | pdf.js；Office 由 LibreOffice（MPL-2.0）转 PDF；xlsx/exceljs；HTML 用 DOMPurify + sandbox iframe | pdf.js、HTML 方案采用；不打包 LibreOffice |
| 输入框 | Lexical，`/` 和 `@` 触发器，附件上传后拿回执 | 第一版先用 textarea，Lexical 留作后续 |
| 打包 | 前端是单独的 npm 包，没有嵌进二进制 | 我们是单文件二进制，要把 dist 嵌进去 |

结论：`dsh web` 作为设计参考和单个模块的来源（安全检查、认证、增量 Markdown、预览），不作为基础应用。前端是一个精简的 React + Vite 应用，直接消费 stream-json。

## 3. 总体架构

```
浏览器 (React SPA)
  │  http://127.0.0.1:<port>（默认仅 loopback）
  │  GET /            → 嵌入的 index.html（需 cookie）
  │  /api/*           → REST：会话、历史、文件、上传
  │  WS /api/sessions/:id/ws → 双向 stream-json
  ▼
claude web 进程（Bun.serve）
  ├─ WebFrontend：认证、信任检查、静态资源、REST
  ├─ SessionManager（复用 src/server/sessionManager.ts）
  └─ DangerousBackend（复用 src/server/backends/dangerousBackend.ts）
        │ spawn
        ▼
   claude -p --input-format stream-json --output-format stream-json
            --verbose --permission-prompt-tool stdio
            --include-partial-messages --session-id <id> [--resume <id>]
```

### 3.1 复用 `claude server`

`claude server`（Direct Connect，`src/main.tsx:5977`）已经做了 Web UI 最难的部分：

- `SessionManager` 管理子进程生命周期、空闲超时、并发上限和 `destroyAll`。
- `DangerousBackend` 以 `claude -p` stream-json 子进程跑每个会话。权限请求通过 `--permission-prompt-tool stdio` 变成 `can_use_tool` control request。
- `server.ts` 已经把 WebSocket 和子进程 stdin/stdout 接起来。

`claude web` 不另写 agent 宿主，只做三件事：

1. 给 `startServer` 加一层浏览器前端：cookie 认证、信任检查、静态资源和 REST。Direct Connect 仍然只用 Bearer token，两套认证分开，互不放宽。
2. 给 `DangerousBackend.spawn` 加可选参数：`includePartialMessages` 和 `resume`。Direct Connect 不传这两个，行为不变。
3. 新增 `src/web/`：CLI action、前端路由、文件服务和上传。前端源码放 `web/`（与 `src/` 平级），单独构建。

### 3.2 浏览器协议

浏览器直接说 stream-json，不另外发明 RPC：

- 发送：`{type:'user', message:{role:'user', content:[...]}}`；中断、切模型、切权限模式用现有 control request（`interrupt`、`set_model`、`set_permission_mode`、`get_context_usage`、`stop_task`、`rewind_files`）。
- 接收：`system/init`、`stream_event`（逐 token）、`assistant`、`user`（工具结果）、`result`、`control_request can_use_tool` 和 `elicitation`。
- 前端在一个 store 里把这些消息归并成"轮次 → 内容块"的视图模型。归并逻辑写成纯函数，单测覆盖。

好处是前端也能当 SDK 协议的一个可视化调试工具；坏处是协议细节暴露给前端，所以归并层要对未知消息类型宽容（忽略并记日志）。

### 3.3 会话与历史

- 列表：服务端读 `~/.claude/projects/<cwd>/*.jsonl`，复用 `src/utils/listSessionsImpl.ts` 的 `listSessionsImpl`，返回 id、标题、最后时间。
- 打开历史：服务端解析 transcript 返回消息，前端渲染；用户继续发言时以 `--resume <id>` 启动子进程。
- 同一会话同一时间只允许一个浏览器标签连接（沿用 `canAttach`）。其余标签只读，并提示"已在别处打开"。
- 默认工作目录：`--workspace`，否则 `~/.claude/web/workspace`。不默认用启动时的 cwd，因为 Web UI 主要用于对话，不一定在项目目录里。也可以在新建会话时选目录。

## 4. 本地服务安全

这个服务可以让 agent 以当前用户的完整权限执行命令，所以把它当作远程 shell 来防护。

| 威胁 | 措施 |
|---|---|
| 别的网站从浏览器里调接口（CSRF / 跨站 WebSocket） | 所有 `/api` 和 WS 升级都检查：`Origin` 必须与服务地址同源，`Origin: null` 拒绝；`Sec-Fetch-Site: cross-site` 拒绝；cookie 设 `SameSite=Strict` |
| DNS rebinding | `Host` 头必须是 `127.0.0.1:<port>`、`localhost:<port>`、`[::1]:<port>` 或 `--trusted-host` 指定的值 |
| 本机其他用户或进程 | 启动时生成 32 字节随机 token，只出现在打印的 URL 和打开浏览器的参数里。`GET /?token=` 校验后换成 HMAC 签名的 HttpOnly cookie，再重定向到不带 token 的 URL。比较用 `timingSafeEqual` |
| 绑到公网 | 默认只绑 `127.0.0.1`。拒绝 `0.0.0.0` 和 `::`。非 loopback 地址需要 `--host <ip>` 并打印警告，且第一版要求同时给 `--tls-cert/--tls-key` |
| 渲染模型输出导致 XSS | Markdown 里的 raw HTML 一律当文本；链接只允许 `http/https/mailto`；图片只允许 `data:image/*` 和 `/api/files/*`；Mermaid 用 `securityLevel: 'strict'`；HTML 预览放在 `sandbox`（不含 `allow-same-origin`）的 iframe 里，并先过 DOMPurify |
| 全局 CSP | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'` |
| 文件接口路径穿越 | `/api/files` 只服务"允许根"下的文件：会话工作目录、上传目录、本会话 transcript 里工具实际读写过的路径。先 `realpath` 再比较前缀，拒绝符号链接逃逸。`~/.claude` 下的凭据文件、`.credentials.json`、`*.key`、`.env` 一律拒绝 |
| 上传滥用 | 单文件和单会话总量上限（默认 50 MB / 500 MB）；文件名只保留 basename 并去掉控制字符；落到 `~/.claude/web/uploads/<session>/` |
| 打开浏览器时泄露环境变量 | 用 `open`/`xdg-open` 时传精简的 env，不继承 API key 等变量；SSH 会话中或 `--no-open` 时只打印 URL |
| 凭据进浏览器 | 浏览器拿不到任何 API key 或 OAuth token；`/api` 不返回 settings 原文 |

权限确认在浏览器里做：`can_use_tool` 显示为审批卡片（工具名、参数预览、"允许 / 允许并记住 / 拒绝"）。默认权限模式与 TUI 相同，不因为是 Web 就自动放宽。页面断开时，未答复的权限请求按拒绝处理。

## 5. 渲染与文档

### 5.1 消息内容

| 内容 | 方案 |
|---|---|
| Markdown | `mdast-util-from-markdown` + GFM + math，增量解析流式输出（参照 dsh `incremental.ts`），自写 mdast→React |
| 代码 | shiki，语法懒加载，常用语言白名单 |
| 数学 | KaTeX |
| Mermaid | fenced code 语言是 `mermaid` 时懒加载 mermaid 渲染 SVG；渲染失败退回代码块；流式输出中的未闭合块先显示代码，结束后再渲染 |
| 图片 | 工具结果中的 base64 image block；Markdown 中引用的本地图片转成 `/api/files/...`；点击放大 |
| 工具调用 | 折叠卡片：标题一行（工具名 + 关键参数），展开看输入和输出；Bash 输出按纯文本显示（strip ANSI） |
| thinking | 默认折叠 |
| 研究类输出 | WebSearch/WebFetch 的来源列成引用列表；deep-research workflow 的进度显示成步骤列表 |

### 5.2 文件和文档预览

右侧面板预览上传的文件和工具写出的文件。

| 类型 | 方案 | 备注 |
|---|---|---|
| PDF | pdf.js（Apache-2.0），worker 内联 | |
| 图片 | 原生 `<img>` + 缩放 | |
| Markdown / 文本 / 代码 | 复用消息渲染器 | |
| HTML | DOMPurify + sandbox iframe | |
| CSV / XLSX | CSV 自己解析；XLSX 用 exceljs（MIT） | SheetJS 社区版的分发方式有问题，不用 |
| DOCX | mammoth（BSD-2）转 HTML，再走 HTML 预览 | 版式不精确，够阅读 |
| PPTX / 旧版 Office | 本机有 `soffice` 时在服务端转 PDF；没有就只提供下载 | 不打包 LibreOffice（MPL-2.0，体积大） |

给模型的部分不变：上传的图片作为 image block 发送；其他文件放到工作目录，在消息里写成 `@路径`，由现有 Read 工具读取（Read 已支持 PDF 和图片）。

### 5.3 Subagent、Workflow 与 Agent Team

终端里这三类东西挤在 spinner 下面的几行状态里，是 Web UI 最能发挥的地方。原则：**主对话流保持干净，只放一张可点开的卡片；细节放在右侧"任务面板"，进度实时更新**。

数据来源全部是现有 stream-json 事件，加上服务端按需读取的落盘文件，不需要子进程新增协议：

| 事件 / 数据 | 内容 | 现有位置 |
|---|---|---|
| `system/task_started` | `task_id`、`task_type`（`local_agent` / `local_workflow` / `in_process_teammate` / `local_bash` 等）、`description`、`subagent_type`、`workflow_name`、`prompt`、`spawn_depth` | `src/entrypoints/sdk/coreSchemas.ts`（`SDKTaskStartedMessageSchema`） |
| `system/task_progress` | 用量（tokens、工具次数、耗时）、`last_tool_name`、`summary`（agent summary），以及 workflow 的 `workflow_progress` 全量快照：`type:'phase'` 条目（阶段 id、状态、说明）和 `type:'agent'` 条目（用 `phaseIndex` 关联阶段，`label` 是 agent id，带状态） | `SDKTaskProgressMessageSchema`；快照由 `src/tools/WorkflowTool/workflowScriptRuntime.ts:390` 生成 |
| `system/task_updated` / `task_notification` | 状态变化、结束状态、`output_file`、最终 summary | 同上 |
| `system/background_tasks_changed` | 当前所有后台任务快照，用于断线重连后对齐 | 同上 |
| 带 `parent_tool_use_id` 的 `assistant` / `user` 消息 | 前台 subagent 的过程；开 `--forward-subagent-text` 后也有其文本输出 | `src/main.tsx:1483` |
| 子 agent transcript、`output_file` | 完整过程，按需加载 | 会话目录下的 subagent jsonl；路径加入 `/api/files` 允许根 |
| team 配置和 inbox | 成员列表、颜色、收发消息 | `~/.claude/teams/<team>/config.json`（`src/utils/swarm/teamHelpers.ts:157`）和 inbox 文件 |

**Subagent（Agent 工具）**

- 对话流里是一张卡片：agent 类型、description、状态灯、实时用量、最近一次工具名、agent summary 一行。
- 展开后按 `parent_tool_use_id` 嵌套显示它的工具调用和文本，样式与主对话相同但缩进一级。嵌套 agent 按 `spawn_depth` 继续缩进，超过两层改成"在面板中打开"。
- 后台 agent 完成时，卡片变成结果摘要，`output_file` 可以在预览面板打开；"停止"按钮发 `stop_task`。

**Workflow**

- 对话流里是一张 workflow 卡片：`workflow_name`、总进度条（`completedAgents/totalAgents`）、当前阶段名、状态（running / paused / completed / failed / killed）。
- 任务面板里画成**阶段泳道**：每个阶段一列（`type:'phase'` 条目），列里是该阶段的 agent 小卡（`type:'agent'` 条目，按 `phaseIndex` 归组，显示 pending / running / completed / failed / skipped）。点 agent 小卡按 agent id 加载它的 transcript。
- 阶段图本身用自定义 React 组件画，不用 Mermaid：Mermaid 每次更新都要整图重绘，不适合每秒变化的状态。workflow 结束后可以"导出为 Mermaid"，方便贴进文档。
- deep-research 就是一个 workflow，所以 M4 的研究模式直接复用这块，另外把各 agent 收集到的来源汇总成引用列表。
- 已知缺口：快照里没有每个 agent 的用量和是否命中缓存（内部 `workflow_agent` 事件有 `cacheHit`，`src/tools/WorkflowTool/workflowSpec.ts:79`），也没有 `workflow_log`。如果 M4 需要，只在快照条目上加可选字段，保持 SDK 兼容。

**Agent Team**

- 页面顶部出现 team 条：team 名、成员头像（用成员颜色）、每人状态（working / idle / 已关闭）。点成员打开他的 transcript。
- 任务面板切到"Team"视图，左边成员列表，右边是**消息时间线**：lead 与成员之间的 `<teammate-message>`、idle 通知、shutdown 请求和确认，按时间排列，像群聊。用户也可以在这里直接给某个成员发消息（复用 SendMessage 的 inbox 机制，经服务端写 inbox，不让浏览器直接碰文件）。
- 成员的权限请求和 lead 的一样走审批卡片，卡片上标明是哪个成员提出的。
- 需要改的地方：headless 模式在输入流关闭时才注入 `SHUTDOWN_TEAM_PROMPT` 要求解散 team（`src/cli/print.ts:501`、`:3007`）。Web 会话的 stdin 一直开着，所以 team 可以跨轮存活，这一点要在 M4 用真实二进制验证。lead 收到的成员消息现在是作为新的 prompt 入队（`src/cli/print.ts:2985` 附近），浏览器需要 `--replay-user-messages` 才看得到，届时在 `DangerousBackend` 里为 Web 打开它。
- team 默认仍需 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`，Web 不单独放开。

**断线和恢复**

浏览器刷新或重连时，服务端先发一次 `background_tasks_changed` 快照，再补发每个活跃任务最近一次 `task_progress`，任务面板据此重建。服务端只在内存里给每个任务保留最近一份进度，不另存一套状态。

## 6. 构建和打包

- 前端放在 `web/`，用 Vite 构建，`bun run build:web` 输出 `web/dist`。
- `scripts/package-binary.mjs` 生成资源清单模块，用 `import x from '...' with { type: 'file' }` 把 dist 每个文件嵌进二进制（与现有 ripgrep、sharp、bfs/ugrep 的嵌入方式一致）。运行时从 `$bunfs` 读取。
- 用 feature flag `WEB_UI` 控制，加进 `scripts/build.mjs` 的默认 feature 列表；关掉时子命令和资源都不进包。
- 体积预算：首屏 JS gzip 后不超过 300 KB；shiki 语法、KaTeX 字体、mermaid、pdf.js、mammoth、exceljs 全部按需加载。整体给二进制增加的体积目标不超过 8 MB，构建时检查。

需要新增的依赖（按 CLAUDE.md，实现前单独确认）：`vite`、`@vitejs/plugin-react`、`react-dom`、`mdast-util-from-markdown` 及 GFM/math 扩展、`shiki`、`katex`、`mermaid`、`pdfjs-dist`、`dompurify`、`mammoth`、`exceljs`。`react` 已有。

## 7. 命令行

```
claude web [--port <n>] [--host <ip>] [--workspace <dir>] [--no-open]
           [--trusted-host <host>] [--idle-timeout <ms>] [--max-sessions <n>]
           [--tls-cert <file> --tls-key <file>]
```

- 默认端口 0（随机），打印 `Claude web UI: http://127.0.0.1:<port>/?token=...`。
- 已有 `claude web` 在跑时，打印已有地址并打开浏览器，不再起第二个（参照 `src/server/lockfile.ts`）。
- Ctrl+C 走 `gracefulShutdown`：停止接受连接、结束子会话、删除 lock。SessionEnd hook 在子会话里照常执行。

## 8. 分阶段计划

每个阶段单独开 PR 到 `dev`，用重新构建的二进制验证。

| 阶段 | 内容 | 验收 |
|---|---|---|
| M0 骨架 | `WEB_UI` flag、子命令、Bun.serve 前端层、token→cookie、Host/Origin 检查、CSP、嵌入 dist；单会话聊天，流式纯文本 | 单测覆盖信任检查和认证；Playwright 在 fake API 下完成一轮对话；跨站 Origin、错误 Host、无 cookie 都被拒 |
| M1 对话体验 | Markdown 增量渲染、代码高亮、KaTeX、Mermaid、图片；工具卡片；审批卡片；中断；切模型和权限模式；用量显示 | 渲染快照测试；XSS 用例（raw HTML、`javascript:` 链接、恶意 mermaid）不执行；审批允许和拒绝都正确回到子进程 |
| M2 会话管理 | 侧边栏历史、恢复、新建、停止、重命名；选择工作目录；单标签独占 | 恢复后上下文延续；TUI 和 Web 打开同一会话时互斥提示 |
| M3 文件与文档 | 上传和拖放、附件条、`/api/files` 允许根、右侧预览面板（PDF、图片、文本、HTML、CSV/XLSX、DOCX，有 soffice 时 PPTX） | 路径穿越和符号链接逃逸用例被拒；上传上限生效；各类型样例文件可预览 |
| M4 Agent 可视化与研究 | 任务面板；subagent 嵌套卡片；workflow 阶段泳道；Agent Team 条和消息时间线；断线重建；引用列表、导出对话为 Markdown/PDF、`/` 命令面板（只列适合 Web 的命令） | fake API 下跑一个两阶段 workflow 和一个两人 team，面板状态与 TUI 一致；刷新页面后面板能恢复；team 跨轮存活且 shutdown 后成员从 config.json 移除；真实 OAuth 跑一次 deep-research |
| M5 加固与文档 | 非 loopback + TLS、移动端布局、无障碍、`docs/features/web-ui.md` 和 README 表格一行、体积检查进 release-check | `make release-check` 通过；功能文档按现有模板附分步截图 |

## 9. 测试

- 单元测试：信任检查、cookie 签名与过期、路径校验、stream-json 归并、Markdown 渲染的安全过滤。
- e2e：Playwright（容器已预装 Chromium）驱动浏览器，后端用项目已有的 fake API 模式，不依赖真实凭据。
- 二进制测试：`make build` 后启动 `./built-claude web --no-open`，用 HTTP 请求验证认证和静态资源来自 `$bunfs`。
- 真实模型只在 M4 做一次验收，用容器 OAuth。

## 10. 待定问题

1. 默认工作目录用 `~/.claude/web/workspace` 还是启动时的 cwd？本稿倾向前者，因为 Web 主要用于对话。
2. 是否允许 TUI 和 Web 同时连同一个会话（一方只读）？本稿第一版只做互斥。
3. 输入框是否在 M2 换成 Lexical 以支持 `@` 文件补全，还是先用 textarea 加简单弹出列表？
4. OpenAI provider 会话是否在 M0 就支持？协议层相同，理论上不需要额外工作，但需要单独验收。
