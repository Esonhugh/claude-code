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

- 列表：服务端读 `~/.claude/projects/<cwd>/*.jsonl`，复用 `src/utils/listSessionsImpl.ts` 的 `listSessionsImpl`，返回 id、标题、最后时间。左侧按项目目录分组（组名是目录名，下面一行是完整路径），组内按最后时间倒序，组可以折叠，悬停组名出现“+”在该目录新建会话。当前会话所在的组默认展开，其余按上次的折叠状态。列表分页加载，每组先显示最近 20 个，滚到底再取。
- 新会话页：点"+ 新会话"或组名旁的"+"，对话区换成一个起始页，不弹菜单：居中是按时间段的问候和账号名（图标用侧边栏同一个），下面是大输入框，"+"和对话输入框是同一个菜单（上传文件、添加图片、使用 skill、引用工作区文件），也支持粘贴和拖入；输入框下方左边是目录选择（可搜索，列出最近的项目目录、临时对话和"打开文件夹…"），右边是权限模式和模型。权限模式从 settings 的 `permissions.defaultMode` 起（没设置就是 default），不沿用当前会话中途切换过的模式，可以在这里改，选项和输入框下方的一样（含 bypass permissions）。输入框里同样支持 `/` 命令 / skill 和 `@` 文件补全。再往下是所选目录最近的 3 个会话卡片（标题、时间、最后一段回复的摘要），点卡片按只读方式打开那个会话，"查看全部"跳到侧边栏搜索。第一条消息发出时才在所选目录启动子进程，会话标题先取消息前段，之后再换成生成的标题。Esc 关闭起始页回到原会话。
- 临时对话：新会话页目录选择里的第一项。不选目录，在 `~/.claude/web/tmp/<id>/` 这样的独立临时目录里运行，不加载任何项目的 CLAUDE.md 和项目级设置（只用用户级设置和记忆），在历史里单独成组。适合翻译、问答这类和项目无关的对话。另外两项是“在当前项目新建”和“打开文件夹…”（未信任的目录先走信任确认）。
- 打开历史：切到一个历史会话时只读，服务端解析 transcript 分页返回消息，前端渲染，不启动子进程，切来切去不花钱也不占进程。用户点进输入框或开始输入时，才在后台以 `--resume <id>` 在该会话原来的工作目录里启动子进程（输入期间完成预热，发送时不用等冷启动）；还在运行的会话（绿点）直接接上，不重新 resume。恢复失败时输入框上方提示原因，草稿保留。
- 同一会话同一时间只允许一个浏览器标签连接（沿用 `canAttach`）。其余标签只读，并提示"已在别处打开"。
- 默认工作目录：`--workspace`，否则 `~/.claude/web/workspace`。不默认用启动时的 cwd，因为 Web UI 主要用于对话，不一定在项目目录里。也可以在新建会话时选目录。

## 4. 本地服务安全

这个服务可以让 agent 以当前用户的完整权限执行命令，所以把它当作远程 shell 来防护。

| 威胁 | 措施 |
|---|---|
| 别的网站从浏览器里调接口（CSRF / 跨站 WebSocket） | 所有 `/api` 和 WS 升级都检查：`Origin` 必须与服务地址同源，`Origin: null` 拒绝；`Sec-Fetch-Site: cross-site` 拒绝；cookie 设 `SameSite=Strict` |
| DNS rebinding | `Host` 头必须是 `127.0.0.1:<port>`、`localhost:<port>`、`[::1]:<port>` 或 `--trusted-host` 指定的值；开了 `--dangerously-allow-local-network` 时，再加上本机各网卡的局域网地址和 `<hostname>.local` |
| 本机其他用户或进程 | 启动时生成 32 字节随机 token，只出现在打印的 URL 和打开浏览器的参数里。`GET /?token=` 校验后换成 HMAC 签名的 HttpOnly cookie，再重定向到不带 token 的 URL。比较用 `timingSafeEqual` |
| 绑到局域网 | 默认只绑 `127.0.0.1`。`--dangerously-allow-local-network` 改绑 `0.0.0.0`（有 IPv6 时同时绑 `::`），让同一局域网的手机、平板能打开。启动时打印醒目警告和每个局域网地址的带 token URL。只接受来源地址属于 loopback、RFC 1918（10/8、172.16/12、192.168/16）、链路本地（169.254/16、fe80::/10）、CGNAT 100.64/10（Tailscale）和 ULA fc00::/7 的连接，其他来源直接断开，这样机器有公网 IP 时也不会暴露到外网。token、cookie、Origin/Host 检查照常生效。没给 `--tls-cert/--tls-key` 时流量是明文，同网段可被嗅探，警告里写明 |
| 绑到公网 | 第一版不支持。`--host` 只接受 loopback 或上面的局域网地址，其他地址报错退出 |
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
| 发送者 | 用户消息标“你”；助手消息标 `Claude (模型)`，例如 `Claude (Opus 5.5)`，模型取这条 assistant 消息的 `message.model` 映射成显示名，所以中途换过模型的会话每条显示各自的模型 |
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

**懒加载**：预览器和大依赖都不进首屏包。pdf.js、exceljs、mammoth、mermaid、KaTeX、shiki 各自是独立 chunk，第一次用到对应类型时才 `import()`。文件内容也按需取：

- PDF 只渲染可见页和前后各一页，其余页滚动到附近再渲染；超过 50 MB 只提供下载。
- 文本和代码文件超过 1 MB 或 2 万行时只取前 2000 行，给“继续加载”；CSV/XLSX 只解析前 500 行并显示总行数，翻页再取。
- `/api/files` 支持 `Range`，大文件分段读，不整读进内存。
- 对话里的长工具输出默认折叠，只显示头尾若干行，展开时再向服务端取全文；历史会话打开时先取最近 50 轮，往上滚再分页取更早的。
- 长列表（消息、文件、事件、历史会话）用虚拟滚动，只挂载可见行。

**预览交互**：PDF 和 PPTX（转成 PDF 后）上方是翻页条：上一页、可输入的页码、总页数、下一页，放大视图里也可以用 ← / →。DOCX 渲染成白底页面，批注高亮显示，悬停看批注人和内容。XLSX 显示工作表页签，切换工作表时才解析那一张。PDF、PPTX、DOCX、XLSX 和图片的预览卡片有"放大"，打开大弹窗用更大的版式看同一个文件，翻到第几页两边同步。文件列表限高滚动，预览不会被挤到屏幕外。

给模型的部分不变：上传的图片作为 image block 发送；其他文件放到工作目录，在消息里写成 `@路径`，由现有 Read 工具读取（Read 已支持 PDF 和图片）。

### 5.3 Subagent、Workflow 与 Agent Team

终端里这三类东西挤在 spinner 下面的几行状态里，是 Web UI 最能发挥的地方。原则：**主对话流保持干净，只放一张可点开的卡片；细节放在右侧边栏的 Agents 页签，进度实时更新**（布局和交互见 5.4）。

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
- 侧边栏里画成**阶段泳道**：每个阶段一列（`type:'phase'` 条目），列里是该阶段的 agent 小卡（`type:'agent'` 条目，按 `phaseIndex` 归组，显示 pending / running / completed / failed / skipped）。点 agent 小卡按 agent id 加载它的 transcript。
- 阶段图本身用自定义 React 组件画，不用 Mermaid：Mermaid 每次更新都要整图重绘，不适合每秒变化的状态。workflow 结束后可以"导出为 Mermaid"，方便贴进文档。
- deep-research 就是一个 workflow，所以 M4 的研究模式直接复用这块，另外把各 agent 收集到的来源汇总成引用列表。
- 已知缺口：快照里没有每个 agent 的用量和是否命中缓存（内部 `workflow_agent` 事件有 `cacheHit`，`src/tools/WorkflowTool/workflowSpec.ts:79`），也没有 `workflow_log`。如果 M4 需要，只在快照条目上加可选字段，保持 SDK 兼容。

**Agent Team**

- 页面顶部出现 team 条：team 名、成员头像（用成员颜色）、每人状态（working / idle / 已关闭）。点成员打开他的 transcript。
- 侧边栏的 team 分组下有**消息时间线**：lead 与成员之间的 `<teammate-message>`、idle 通知、shutdown 请求和确认，按时间排列，像群聊。直接给成员发消息见 5.4。
- 成员的权限请求和 lead 的一样走审批卡片，卡片上标明是哪个成员提出的。
- 需要改的地方：headless 模式在输入流关闭时才注入 `SHUTDOWN_TEAM_PROMPT` 要求解散 team（`src/cli/print.ts:501`、`:3007`）。Web 会话的 stdin 一直开着，所以 team 可以跨轮存活，这一点要在 M4 用真实二进制验证。lead 收到的成员消息现在是作为新的 prompt 入队（`src/cli/print.ts:2985` 附近），浏览器需要 `--replay-user-messages` 才看得到，届时在 `DangerousBackend` 里为 Web 打开它。
- team 默认仍需 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`，Web 不单独放开。

### 5.4 右侧边栏：Agents 页签与直接对话

右侧边栏的页签依次是 **Status**、**Files**、**Agents**、**Workflow**、**Terminals**、**Monitor**、**Background Tasks**（见 5.5、5.7），默认打开 Status。有 agent 在跑时可以切到 Agents，边栏可以拖宽；workflow 视图可以"展开到全屏"。窄屏时边栏变成抽屉。

**1. 存活 agents 的层级树**

```
● 主会话                              running · 2m10s
├─ ● researcher  搜集 2026 年资料       running · 41s · 12k tok · WebSearch
│   └─ ○ Explore  读 PDF 附录           completed · 18s
├─ ◆ workflow deep-research            phase 2/3 · 5/9 agents
└─ ▣ team paper-review                 3 working · 2 idle
    ├─ ● alice (蓝)  审方法论            working · Read
    ├─ ● bob (绿)    审实验              working
    └─ 2 idle agents                    (点开展开)
```

- 根是主会话。subagent 按派生关系挂在父节点下面，workflow 和 team 各是一个分组节点。
- 每行显示状态、名字或类型、description、耗时、tokens、最近一次工具，数据来自 `task_progress`。
- 分成运行中、空闲、已结束三组，已结束的默认折叠。空闲成员超过 3 个时折叠成"N idle agents"，与 TUI 一致（`src/components/CoordinatorAgentStatusRows.ts`）。
- 每行有停止按钮（`stop_task`）。
- 父子关系：`task_started` 只有 `spawn_depth` 和 `tool_use_id`，父节点由服务端按 `tool_use_id` 在 transcript 里反查（见下文）。

**2. Workflow：多列关系图**

点 workflow 节点，边栏切换成 workflow 视图。边栏宽度有限，只显示当前阶段：一行阶段信息（第几阶段、完成数、正在跑的 agent）加这个阶段的 agent 卡片，点卡片在下方看输出。完整的多列图只在"展开"后的大弹窗里画：

- 每个阶段一列，从左到右按执行顺序排，列头是阶段名、说明和完成数，当前阶段高亮。
- 列里是这个阶段的 agent 卡片（状态、耗时），相邻两列之间有箭头，表示上一阶段的输出流向下一阶段。
- 子 workflow 显示成一张可展开的卡片，展开后在卡片内部再画一层列。
- 列多时横向滚动。点 agent 卡片在图下方显示它的任务、最近步骤或结构化输出。

**3. 点开 agent 后直接对话**

点树里任意 agent，边栏切换成这个 agent 的对话视图：上面是它的完整过程（工具调用、文本，渲染与主对话相同），底部是输入框，标着"发送给 researcher"。按 Esc 或点面包屑回到树。

消息的投递规则照搬 REPL 现有逻辑（`src/screens/REPL.tsx:5935`），不另外设计：

| agent 类型和状态 | 发送后的行为 | 现有函数 |
|---|---|---|
| subagent，运行中 | 进入它的待处理队列，在下一个工具间隙送达 | `queuePendingMessage`（`src/tasks/LocalAgentTask/LocalAgentTask.tsx:316`） |
| subagent，已结束 | 带着原有上下文在后台恢复，这条消息作为新的 prompt | `resumeAgentBackground`（`src/tools/AgentTool/resumeAgent.ts:75`） |
| team 成员，运行中 | 直接插入成员的对话 | `injectUserMessageToTeammate`（`src/tasks/InProcessTeammateTask/InProcessTeammateTask.tsx:83`） |
| team 成员，已停止 | 输入框禁用，提示"成员已停止" | 与 REPL 的提示相同 |
| workflow 里的 agent | 只读，只能停止 | workflow 脚本依赖 agent 的结构化输出，中途插话会破坏结果 |

**为什么还要加一个请求**

现有机制都不能直接从外部把一句话投给某个 agent：

- REPL 的路由只存在于 Ink UI 里（`src/screens/REPL.tsx:5935`），headless 子进程没有对应入口。
- stream-json 里 `user` 消息的 `agent_id` 是输出字段，表示"哪个 subagent 产生了这条消息"（`src/entrypoints/sdk/coreSchemas.ts:1681`），`print.ts` 不会按它把输入路由出去。control request 里只有 `stop_task`。
- SendMessage 是给模型用的工具。让主 agent 转达要占主对话一轮，也不是直接对话。
- `claude ssh` / Direct Connect 有同样的缺口：远端 task 事件被收进 `AppState.remoteTasks`，但没有组件读取它，远端 agent 既看不到也发不了消息。单独记在 #503。

所以只加**一个** fork 专用 control request，Web、SSH、Direct Connect 三处共用：

- `send_task_message {task_id, text, model?}`：在 `src/cli/print.ts` 里按上表调用同一组函数，返回 `queued`、`resumed`、`injected` 或失败原因。`model` 只对已结束的 subagent 有效：恢复时覆盖 `resumeAgentBackground` 从元数据读出的 `meta.model`（`src/tools/AgentTool/resumeAgent.ts`），运行中的 agent 和 team 成员带了 `model` 直接报错。

agent 输入框右侧显示它的模型（来自 agent 元数据或 `system/task_started`）。已结束的 subagent 可以在这里选别的模型，下一条消息恢复时生效，投递结果写明"模型 A → B"；运行中的 subagent 和 team 成员只读显示，因为模型在启动时就定了；workflow 里的 agent 没有输入框。

其余都用现有机制：

- agent 的过程：服务端和子进程在同一台机器、同一个二进制，直接复用 `getAgentTranscriptPath`（`src/utils/sessionStorage.ts:259`）读 transcript，不加协议。对话视图打开期间，浏览器每收到这个 agent 的一条 `task_progress`，就从服务端拉一次增量。
- 父子关系：先用 `task_started.tool_use_id` 在父 agent 的 transcript 里找到发起它的 Agent 调用来确定父节点；只有这条路走不通时，才考虑给 `task_started` 加可选的 `parent_task_id`。

### 5.5 Terminals 页签

Terminal 工具是 fork 独有的（官方没有），它开的每个 PTY 会话注册成 `interactive_terminal` 类型的 task（`src/tasks/TerminalTask.ts:26`），在这个页签里列出。后台 Bash 和 Monitor（`local_bash` task）以及定时任务放在 Background Tasks 页签（5.7）。

- 列表：来自 `task_started` / `task_updated` / `background_tasks_changed`，每行显示命令、状态（running / completed / failed / killed）、退出码、尺寸和是哪个 agent 开的。点一行展开屏幕。
- 屏幕内容：复用官方已有的 `get_task_output` control request（官方 2.1.316 也有，返回最后 8 KiB；fork 实现在 `src/cli/hostControlRequests.ts:597`，目前只认 shell 和 Monitor task）。fork 让它也接受 `interactive_terminal`，默认返回当前屏幕的纯文本（`screenToPreview`，`src/utils/pty/terminalScreenToPreview.ts:33`），不另加请求。浏览器每收到这个 task 的事件或每秒最多拉一次。
- 颜色：请求里带 fork 独有的可选字段 `format: "screen"` 时，回包多一个结构化的 `screen: { cols, rows, lines: [[{ text, fg? }]] }`，按 `TerminalScreenCell.style.fg`（`src/utils/pty/terminalScreen.ts`）把同色的连续字符合成一段。浏览器把 `fg`（30–37、90–97）映射成 CSS 类上色，不收也不解析 ANSI 文本。现在屏幕模型只记前景色，背景色、粗体等以后加到 `style` 里，`screen` 的段落结构不变。不带这个字段时行为和官方一致，TUI 的 preview 仍按纯文本处理。
- 操作：第一版只读，加"停止"按钮（`stop_task`）。终端由 agent 驱动，用户从页面往里打字会和 agent 抢输入，放到后续版本，届时要单独走权限确认。
- `claude ssh` / Direct Connect 的终端列表有和 #503 一样的缺口（`remoteTasks` 没人渲染），一起处理。

**断线和恢复**

浏览器刷新或重连时，服务端先发一次 `background_tasks_changed` 快照，再补发每个活跃任务最近一次 `task_progress`，侧边栏据此重建。服务端只在内存里给每个任务保留最近一份进度，不另存一套状态。

### 5.7 其他边栏页签、扩展管理和外部输入

- **Status**：对应 TUI 的 `/status` 和 `/context`。显示会话名称、ID、工作目录、轮次和压缩次数；模型、思考强度、权限模式；上下文占用；本会话 token 和折合价格、订阅额度；后台 agent、workflow、终端、待确认请求的数量；版本、账号、MCP 连接数、channels、已加载的指令文件、记忆、沙箱和 hooks。数据来自 `initialize` 回包、`get_context_usage`、`get_settings` 和 `/usage`，每秒刷新。
- **Files**：列出本会话上传、读取、修改和生成的文件，每行是类型、文件名、所在目录、来源（上传 / 读取 / 修改 / 生成）、时间和来源工具。点一行在下方预览（5.2 的预览器），修改过的文件显示本会话的 diff。数据从 transcript 里的工具调用推出来，不另建索引。
- **Monitor**：每个 Monitor 一行（描述、谁启动的、耗时、事件数），点开显示命令和按时间倒序的事件列表，可以停止（`stop_task`）。
- **Background Tasks**：后台 Bash（`run_in_background`）、`CronCreate` 和 `ScheduleWakeup`。每行是类型、命令或计划、谁启动的、耗时、最后一行输出或下次运行时间；运行中的可以停止，计划中的可以取消，都走 `stop_task`。
- **Workflow 输出**：点已完成的 agent 卡片显示它的摘要和结构化输出（workflow schema 校验后的 JSON），可以复制或在对话中引用；点阶段名显示该阶段每个 agent 的状态和摘要。运行中的 agent 只显示最新进度，结构化输出要等它结束。边栏只放一行当前阶段（第几阶段、完成数、正在跑的 agent）和当前阶段的 agent 卡片，不画多列图；旁边"展开"打开大弹窗：顶部是 workflow 名、问题、开始时间、耗时、token 和"停止 workflow"，中间是完整的多列阶段图（每列一个阶段，当前阶段高亮，箭头表示输出流向），下面左右两栏，左边是"中间结果预览"，右边是选中 agent 的任务、最近步骤或结构化输出；中间结果预览把已完成 agent 的输出拼成表格，汇总阶段还没跑完也能先看。
- **MCP、Skills、插件、记忆**：放在左侧边栏历史会话上方，依次是 MCP、Skills、插件、记忆、Hooks、Mods，底部只留设置、快捷键和账号。MCP 弹窗列出服务器的来源（用户、项目、插件、`--channels`）、传输方式、连接状态和工具数，需要登录或连接失败时给出登录 / 重连，和 `claude mcp`、`/mcp` 共用配置。Skills 弹窗按项目、用户、插件、内置分组，可以搜索、启用 / 停用、查看 SKILL.md、一键插入 `/name`。插件弹窗有三个页签：已安装（启用、更新、卸载，显示包含的 skills / commands / hooks / MCP）、发现（市场搜索和安装）、市场源（添加、刷新、移除）。和 `claude plugin`、`/plugin` 共用配置。启用、停用 skill 后自动发一次 `reload_skills`，插件的启用、停用、安装、更新、卸载后自动发一次 `reload_plugins`，当前会话立刻生效，不用手动重载。设置里不再放模型和权限，它们只在输入框下方切换：左侧是权限模式（图标加 `plan mode on` 这类 TUI 同款文字，点击选择，输入框里按 Shift+Tab 也能轮换，但不显示按键提示，切换时也不往对话里插提示行，避免连按时刷屏），右侧是 `Opus 5.5 · high`，点击选模型和思考强度。不显示“模型：”之类的标签。有目标时，模型左边多一个“◎ 目标 · N 次检查”。
- **Channel 消息**：channel 是发 `notifications/claude/channel` 的 MCP 服务器（`src/services/mcp/channelNotification.ts`）。入站消息在对话里单独渲染，带来源徽标和 `meta` 里的发送者，不显示成"你"。回复走 channel 自己的 MCP 工具，显示为普通工具卡片。声明了 `claude/channel/permission` 能力的 channel 会收到权限请求，审批卡片上注明"也已推送到 X"，从 channel 批准后卡片显示批准来源。
- **Channels 管理**：左侧边栏在 MCP 下面加 Channels 入口。弹窗列出已有的 channel（所属插件、本会话是否启用、今天收到几条和最近一条、能否远程审批），未启用的可以"在本会话启用"，走现有的 `channel_enable` control request（`src/cli/print.ts`），只接受已连接的插件提供的服务器；"新会话默认"开关写进新会话启动时的 `--channels` 列表。不是插件提供的服务器只能用 `--dangerously-load-development-channels` 启动，这里只显示原因、不给按钮。下方从已添加的 marketplace 列出可安装的 channel 插件，"安装并启用"先装插件、`reload_plugins`，再 `channel_enable`。`CLAUDE_CODE_DISABLE_CHANNELS` 或托管策略 `channelsEnabled: false` 时整个入口显示为已被策略关闭。
- **MCP 交互**：MCP 工具调用和内置工具一样渲染成工具卡片，标出服务器名。服务器发来的 elicitation 渲染成表单卡片（按 schema 生成字段，提交 / 拒绝 / 取消分别回 accept / decline / cancel）。需要 OAuth 的服务器在浏览器新标签里完成登录，凭据只留在本机。

- **待确认请求**：权限请求和 MCP elicitation 不插在对话流里等人看到，而是从输入框正上方弹出（同一时间只显示一个，其余排队显示“还有 N 个待处理”），同时只把对话区淡出（顶部状态、成员条和对话流降低不透明度），左右侧栏照常可以看和点，不用整页遮罩。数字键选项、↑↓ 加 Enter 确认、Esc 拒绝（焦点在侧栏或输入控件里时不拦截这些键）；对话里原位置留一行占位，处理后写上结果。
- **Goal、待办和 recap**：`/goal` 的状态来自 `system/goal_state_changed`（`src/entrypoints/sdk/coreSchemas.ts:2404`），显示在输入框下方模型旁边，点开看目标原文、已运行时长、每次检查没通过的原因，可以清除；目标结束时对话里插一条细分隔线。待办来自 TodoWrite 的 `todos` 和 TaskCreate / TaskUpdate，折叠成输入框上方一行“待办 2/5 · 正在…”，展开是清单；TodoWrite 的工具卡片只显示“更新了待办”。recap 对应 TUI 的 away summary（`src/services/awaySummary.ts`，以 `※` 开头的灰色一行）：headless 下不会自动生成，所以网页在标签页隐藏 5 分钟以上再回来、没有回合在跑、上次用户消息之后还没有 recap 时发一次 `/recap`（`supportsNonInteractive`），也可以手动输入 `/recap`。
- **文件改动**：Edit、Write、NotebookEdit 的工具卡片显示 git diff 样式：左边两列旧 / 新行号，删除行红底、新增行绿底，标题右侧是 `+N −M`。新文件只渲染前几行，其余点“展开”再渲染。diff 由服务端从工具输入算出，浏览器不跑 diff。
- **账号和登录**：账号属于这台机器上的 claude，不属于某个会话。左下角账号卡片显示当前账号（Claude 订阅、API key、ChatGPT），点开可以切换或退出。未登录时输入框禁用，上方显示登录卡片：用 Claude 账号登录走已有的 `claude_authenticate` / `claude_oauth_callback`；用 ChatGPT 登录需要新增一个 fork 独有的 control request，复用 TUI 的 ChatGPT OAuth（localhost:1455 回调）；两者都先尝试本机回调，从局域网其他设备访问时显示授权链接，让用户把授权码或跳转后的地址粘贴回来。API key 只提示在启动 claude web 的环境里设置 `ANTHROPIC_API_KEY` 或 `apiKeyHelper`，网页不收集 key；服务端报告已检测到的 key 来源（`apiKeySource`）时，登录卡片和账号菜单直接提供“使用 API key”。很多用户只用 API key、从不登录，所以界面不能假设有账号名和订阅。API key 分两种，要分开显示：Anthropic API key（`ANTHROPIC_API_KEY` 或 `apiKeyHelper`，可配 `ANTHROPIC_BASE_URL`）和 OpenAI API key（`CLAUDE_CODE_USE_OPENAI=1` 加 `OPENAI_API_KEY` / `OPENAI_AUTH_TOKEN` 或 `~/.codex/auth.json` 里的 `OPENAI_API_KEY`，可配 `OPENAI_BASE_URL`，默认 `api.openai.com/v1`，见 `src/utils/auth.ts` 的 `getOpenAIAuthInfo`）。两种都是：账号卡片显示 “Anthropic API key” / “OpenAI API key” 和 key 来源，菜单里再显示 base URL；没有退出登录（key 来自环境），可以改用另一种 key 或登录账号；起始页问候不带名字；状态栏和设置的用量里不显示 5 小时 / 每周额度，改为按量费用（本会话、今天、本月）。OpenAI API key 和 ChatGPT 登录的区别：模型列表同为 OpenAI 模型，Daybreak 两者都有（`/daybreak` 只看 provider 是 openai）；没有用量额度、活动记录和限额重置（`src/services/api/usage.ts` 只在 `isChatGPT` 时取）；没有 auto 模式，权限模式菜单里 auto 置灰并注明需要 ChatGPT 登录，Shift+Tab 循环跳过它，切到 OpenAI key 时若正在 auto 就退回 default（`isApproveForMeAvailable`，`src/utils/permissions/approveForMe.ts`）；ChatGPT 登录下 auto 显示为 `auto (Approve for me)`；Codex apps 不可用（`src/services/apps/auth.ts` 要求 ChatGPT 登录）。用 ChatGPT 登录时模型列表换成 OpenAI 模型，插件弹窗多一组“ChatGPT 应用（Codex apps）”（`src/services/apps/`，市场名 `chatgpt-connectors`），按应用状态显示可用、未连接（`missing_link`，去 chatgpt.com 连接）、需要重新授权、出错（重试）；不是 ChatGPT 账号时这一组只显示说明。
- **Daybreak**：用 ChatGPT 账号（OpenAI 模型）时，模型菜单底部多一组 Daybreak 选项 off / blue / red，对应 settings.json 的 `daybreak`（和 `/daybreak` 同一个设置，`src/commands/daybreak/`），请求里带 `access_programs.cyber`（`src/services/api/openai-compat.ts`）。开启时输入框下方模型名前显示日出图标，blue / red 用对应颜色；Claude 账号下不显示。
- **Hooks**：弹窗按事件分组列出所有 hook，每条显示匹配、命令、超时和来源（用户、项目、插件、本会话）。用户和项目的 hook 可以添加、编辑、删除，写回对应的 settings.json；插件和本会话（skill / agent frontmatter、SDK 注册）的 hook 只读，本会话的随会话结束失效。顶部有“停用全部 hooks”（`disableAllHooks`）。
- **Mods**：弹窗列出已加载的 mod（所属插件、用到的界面位置和事件、上次加载错误），可以启用 / 停用、重新加载，或打开源文件编辑，保存后热重载（`$.state` 保留）。mod 的界面走已有的远程 UI 协议（`src/services/mods/remoteUiRender.ts`，`ui_render` / `ui_press` / `ui_input` / `ui_select` / `ui_invalidate`）：服务端把 `ui.render` 的结果作为元素树发给浏览器，浏览器用 DOM 画 `Box`、`Text`、`Button`、`Input`、`Select`、`Link`、`Code`、`Markdown`、`Svg`，不接受 mod 给的原始 HTML。位置和 TUI 一一对应（`ModRenderComponent`，`src/services/mods/ui.ts:8`）：`AbovePrompt` 画在输入框上方；`Pane` 变成右侧的一个页签（以 mod 名命名，排在 Background Tasks 后面，带 × 关闭，关闭发 `ui.close`）；`UserMessage`、`AssistantMessage`、`ToolUse`、`ToolResult`、`ToolGroup`、`ToolProgress`、`CommandOutput`、`TurnDuration`、`InfoNotice` 替换对话流里对应的消息或卡片，mod 不处理时用默认渲染；`Spinner` 是对话底部的状态行，`SessionMode` 是输入框下方左侧的权限模式文字，`PromptHint` 是输入框的提示文字，`AskUserQuestion` 在输入框上方的待确认区域里显示。按钮和输入通过 `ui_press` 等交回 mod。不经过渲染的调用也有对应位置：`ui.toast` 是底部的短暂提示，`ui.notice` 是持续显示的提示条，`ui.notify` 走浏览器通知，`ui.copy` 写剪贴板；改写、补全输入框的 `ui_prompt_*` 依赖 #511，接通后作用在网页输入框上。网页以 `surface: "desktop"` 参与渲染（`ModRenderSurface`，`src/services/mods/ui.ts:7`），和官方桌面端走同一分支，`viewport.columns` / `rows` 按面板宽高和等宽字体估算。已知不能完全一致的地方：按终端列数手工排版或画字符画的 mod（非等宽 Text 会错位）、只在 `surface === "terminal"` 分支里画界面的 mod、和浏览器快捷键冲突的组合键（这类组合键需要换绑）。主题色名（`success`、`inactive`、`diffAddedWord` 等）映射到网页的颜色变量。M 阶段用 `examples/mods/` 和 mods-test-lab 跑一遍兼容矩阵。`Client` 组件（mod 自带的前端模块）第一版不支持，显示占位。`Code` 的 `format: "diff"` 用和 Edit 卡片同一套红绿行渲染（服务端或前端解析统一 diff 文本，不是 ANSI）；内置的官方 diff mod（`assets/builtin-diff-2.1.295.zip`，接管 `/diff`）只用 Select、Button、Text 和 diff 格式的 Code，所以在网页里能完整显示：比较基准（未提交 / 相对分支 / 某一轮）、文件列表、选中文件的 diff，`ask` 把选中的 diff 附到下一条消息，并用 `PromptHint` 改输入框提示。
- **设置补充**：常规页有界面名称，对应 settings.json 的 `uiName`（`src/components/LogoV2/uiName.ts`），左上角和浏览器标签页标题跟着变，留空是 EsonClaw。设置的页签在滚动时固定在顶部，切换页签回到顶部。
- **Stats**：左侧边栏"设置"下面是一个纯文字入口 Stats，打开弹窗，用和 `/stats` 相同的聚合（`src/utils/stats.ts` 的 `aggregateClaudeCodeStatsForRange`，范围 7 天 / 30 天 / 全部）：最常用模型、输出 tokens、会话数和最长会话、连续使用天数、最活跃的一天、高峰时段；按模型分色的每日输出曲线（全部范围按周汇总，悬停显示当时每个模型的数字）；模型占比；最近 25 周的活跃度格子；一天中各小时的使用分布。模型颜色固定按模型分配，不随排名变化。侧边栏不放用量小组件。设置的用量页签另有本会话指标（缓存命中率、工具调用、首 token 延迟、API 重试、改动行数、subagent 占比）。
- **输入框**：参照 Claude 应用的样式，输入区是一个圆角框，右下角是圆形的发送箭头（没输入时变灰）；框下方一行，左边是“+”（上传文件、图片、skill、引用文件）和权限模式，右边是目标和模型。输入区和对话流同一底色，不加分隔线。起始页的大输入框用同样的发送按钮。
- **宽度自适应**：对话流、待确认区、待办、mod 横条和输入框共用同一个最大列宽（约 880px）并左右对齐，窄于列宽时铺满中间栏；右侧面板宽度随窗口在 300–420px 之间变化，页签始终单行横向滚动，不折成多行；1100px 以下左侧栏收起。
- **手机**：宽度 760px 以下，左侧会话栏和右侧面板都收起：会话栏从左边滑出，右侧面板变成从底部升起的抽屉（顶栏右侧按钮打开，页签单行横向滑动）；对话流里点 Files、Agents 等链接也打开这个抽屉。顶栏压成一行，隐藏副标题和语言选择（设置里可以切换），工作目录徽标和成员提示隐藏，spinner 行按整段换行，输入框占位文字改短。
- **本机会话（UDS）**：Status 面板单列一组，显示本会话名（其他会话用它寻址）、socket 路径、收件状态，以及本机其他 claude 会话（忙 / 空闲 / 暂缓模式）。Agents 页签底部也列出这些会话，点开可以直接发消息，投递结果按对方状态显示 delivered / queued / held。别的会话发来的消息在暂缓模式下显示成待放行卡片（放行 / 丢弃），对应 TUI 的 `PeerInboundDialog`。左侧历史里正在运行的会话带绿点。
- **压缩**：压缩点只显示一条细分隔线（`✻ 上下文在这里压缩过 · 时间 · 自动 / /compact`），下面可以展开摘要。压缩前的消息不默认渲染：滚到对话顶部时自动从 transcript 分页取回并插到上方，保持当前滚动位置不跳；取完显示"已经到会话开头"。这些消息照常显示，只是模型那边已经只看摘要（fork 保留最近一轮原文，`splitKeptTail`）。上下文占用点开有明细和自动压缩阈值，`/compact` 和自动压缩时在对话里显示进度和可取消的 spinner。
- **按消息回退**：悬停用户消息出现“回退”，确认后可选只回退对话（`rewind_conversation`）或同时还原文件（再发 `rewind_files`）。之后的轮次从对话里移除，原消息放回输入框，完整记录仍在 transcript。
- **说明文字**：弹窗和面板里不放解释实现或机制的段落（例如"和 claude mcp 共用配置""停止走 stop_task"），按钮和状态本身要能看懂；只保留用户需要动手时的提示（例如未登录时怎么登录）。记忆弹窗顶部是"自动记忆"开关（`autoMemoryEnabled`），不是一行状态说明。
- **快捷键**：`?` 或左下角“快捷键”打开帮助。和 TUI 一致的有 Enter、Shift+Enter、Shift+Tab、Esc、`/`、`@`；页面级的有 Ctrl/⌘+K 搜索历史会话、Ctrl/⌘+. 打开 Status。

### 5.6 界面语言

- 界面支持简体中文、繁體中文和 English。首次打开按 `navigator.languages` 选择：`zh-TW`、`zh-HK`、`zh-MO` 和 `*-Hant` 用繁体，其他 `zh*` 用简体，其余用英文。设置“常规”页和顶栏可以切换，选择存在浏览器 `localStorage`，不写 settings.json。
- 文案放在前端的 `locales/{zh-Hans,zh-Hant,en}.json`，键名用英文 id，组件里不写死中文。缺失的键回退到 English，单测检查三份文件键集一致。繁体文案人工维护，不在运行时做简繁转换。
- 只翻译界面文案。模型回复、工具输出、记忆和文件内容原样显示；回复语言由模型和 settings 里的 `language` 决定。
- 日期和数字用 `Intl.DateTimeFormat` / `Intl.NumberFormat` 按当前语言格式化。

## 6. 构建和打包

- 前端放在 `web/`，用 Vite 构建，`bun run build:web` 输出 `web/dist`。
- `scripts/package-binary.mjs` 生成资源清单模块，用 `import x from '...' with { type: 'file' }` 把 dist 每个文件嵌进二进制（与现有 ripgrep、sharp、bfs/ugrep 的嵌入方式一致）。运行时从 `$bunfs` 读取。
- 用 feature flag `WEB_UI` 控制，加进 `scripts/build.mjs` 的默认 feature 列表；关掉时子命令和资源都不进包。
- 体积预算：首屏 JS gzip 后不超过 300 KB；shiki 语法、KaTeX 字体、mermaid、pdf.js、mammoth、exceljs 全部按需加载。整体给二进制增加的体积目标不超过 8 MB，构建时检查。

需要新增的依赖（按 CLAUDE.md，实现前单独确认）：`vite`、`@vitejs/plugin-react`、`react-dom`、`mdast-util-from-markdown` 及 GFM/math 扩展、`shiki`、`katex`、`mermaid`、`pdfjs-dist`、`dompurify`、`mammoth`、`exceljs`。`react` 已有。

## 7. 命令行

```
claude web [--port <n>] [--host <ip>] [--workspace <dir>] [--no-open]
           [--dangerously-allow-local-network]
           [--trusted-host <host>] [--idle-timeout <ms>] [--max-sessions <n>]
           [--tls-cert <file> --tls-key <file>]
```

- `--dangerously-allow-local-network`：绑 `0.0.0.0`，只放行局域网来源（见第 4 节），启动时打印警告，不自动打开浏览器之外的任何东西。和 `--host` 同时给时以 `--host` 为准，但 `--host` 是局域网地址时必须带这个参数。

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
| M4 Agent 可视化与研究 | 右侧边栏 Agents 页签（层级树、workflow 多列图、team 分组和消息时间线）；点开 agent 直接对话（新增 `send_task_message`，与 #503 共用）；断线重建；引用列表、导出对话为 Markdown/PDF、`/` 命令面板（只列适合 Web 的命令） | fake API 下跑一个两阶段 workflow 和一个两人 team，侧边栏状态与 TUI 一致；给运行中和已结束的 subagent、运行中的成员各发一条消息，投递结果与 REPL 相同；刷新页面后面板能恢复；team 跨轮存活且 shutdown 后成员从 config.json 移除；真实 OAuth 跑一次 deep-research |
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
