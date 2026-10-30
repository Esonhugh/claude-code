# Unofficial Claude Code


https://github.com/user-attachments/assets/7299b965-da57-45c4-899a-0a1685ae4bdf


基于 Claude Code 分发产物恢复的非官方 TypeScript/TSX 源码工作区，并持续维护本地 CLI、Agent、Workflow、OpenAI/Codex 兼容和调试能力。

> 本项目不是 Anthropic 官方产品、官方源码分发或官方 Claude Code release，也未获得 Anthropic 背书。公开包只分发 launcher 与对应平台二进制，不包含本仓库源码。

## 作者与维护者

- 项目维护者：**Esonhugh**
- 原始产品与上游实现：**Anthropic Claude Code**
- 公开包：`@esonhugh/claude-code`

本仓库包含从公开 bundle/source map 恢复的上游代码和本地维护改动。上游归属与本地维护者身份应分别理解；完整本地变更以 [`CHANGELOG.md`](CHANGELOG.md) 为准。

## 项目概况

本项目主要用于：

1. 保存从 Claude Code 分发产物恢复的可读 TypeScript/TSX 源码树。
2. 提供可构建、可调试、可进行受控二次开发的本地 Claude Code CLI。
3. 维护 Agent、Workflow、OpenAI/Codex、交互终端和会话命令等扩展。
4. 保留恢复工程中的类型声明、stub 与 build shim，便于后续逐步替换或验证。
5. 通过 binary-only 流程发布非官方 launcher，不公开分发本仓库源码。

### 开发环境与产物

- 包管理器：Bun
- Node.js：`>=18`
- JavaScript 构建产物：`dist/cli.js`
- 本地 binary：`built-claude`

当前发布版本为 `2.1.296`；发布历史、具体变更和验收边界统一记录在 [`CHANGELOG.md`](CHANGELOG.md)。

## 安装与运行

### 方式一：安装公开 launcher

公开包会根据 `process.platform` 和 `process.arch` 加载对应的平台二进制 optional dependency：

```bash
bun add --global @esonhugh/claude-code
claude --version
```

公开包仅包含 launcher 和平台二进制，不包含恢复源码。当前 release workflow 的普通平台包覆盖 Linux x64、Linux arm64、macOS arm64 和 Windows x64；不应假设其他 OS/architecture 组合（例如 macOS x64）已有产物。Linux 还会构建 baseline x64 和 musl 验证产物，但 baseline 不作为普通 npm 平台包。若当前平台没有对应 binary package，launcher 会返回缺少平台包的错误。

### 方式二：从源码构建

```bash
git clone <repository-url>
cd claude-code
bun install
make build
./built-claude --version
```

`make build` 构建平台 binary，并生成根目录下的 `built-claude`。

只构建 JavaScript CLI：

```bash
bun run build
bun ./dist/cli.js --version
bun ./dist/cli.js --help
```

## 主要功能

每项功能的作用、配置写法与可选值、不同配置下的终端效果见对应文档；完整索引见 [`docs/features/`](docs/features/README.md)，变更历史见 [`CHANGELOG.md`](CHANGELOG.md)。设置写入用户级或项目级 `settings.json`，使用时与现有 JSON 合并。

| 领域 | 功能 | 说明 |
| --- | --- | --- |
| 模型与 Provider | [OpenAI / Codex provider](docs/features/openai-provider.md) | 把 Claude Code 的模型换成 OpenAI（GPT / Codex）：用 ChatGPT 账号登录或 API key，工具、界面、命令照常使用 |
|  | [OpenAI 网络安全档位（Daybreak）](docs/features/openai-provider.md#网络安全访问档位daybreak) | OpenAI provider 下用 `/daybreak blue\|red\|off` 切换 OpenAI 的网络安全访问档位，请求自动带上 `access_programs` |
|  | [模型自动发现与 Gateway](docs/features/model-discovery.md) | 走自己的 API 网关或 OpenAI 兼容服务时，自动把网关提供的模型列进 `/model`，不用手打模型名 |
|  | [请求韧性：重试、回退模型与默认模型](docs/features/request-resilience.md) | API 过载或断线时自动重试；主模型一直过载就换备用模型；可以让无人值守任务一直等到额度恢复 |
|  | [Effort 档位](docs/features/effort.md) | 控制 Claude 每次「想多深」：低档快而省，高档慢而仔细；可全局设、按会话切，也可给子代理单独指定 |
|  | [Codex Apps](docs/features/codex-apps.md) | 用 ChatGPT 账号登录 OpenAI provider 时，直接使用 ChatGPT 里连好的 App（GitHub、Gmail 等）：输入 `@codex-app:` 点名即可 |
| Agent 与编排 | [Agent 与后台任务](docs/features/agents.md) | Claude 把一部分工作交给「子代理」在后台做，你继续聊；可以查看、停止、续跑，也可以自己定义专用子代理 |
|  | [Agent Teams](docs/features/agent-teams.md) | 让 Claude 组一个小团队：一个负责人带几个队友并行干活，互相发消息、共享任务清单 |
|  | [Dynamic Workflow](docs/features/workflows.md) | 让 Claude 写一段编排脚本，一次调度多个子 Agent 分阶段、并行地干活；`/workflows` 看进度、保存成可复用的流程 |
|  | [背景会话、daemon 与 agents 视图](docs/features/background-sessions.md) | 把任务交给后台跑、终端立刻空出来；`claude agents` 一屏看谁在等你、谁在干活、谁做完了 |
|  | [独立会话通信](docs/features/peer-messaging.md) | 同一台机器上开着的几个 Claude 会话可以互相发现、互发消息：一个写代码，一个做 review，完成了喊一声 |
| 权限与安全 | [权限规则、权限模式与 Safe mode](docs/features/permissions.md) | Claude 什么时候要先问你：用规则提前放行或禁止，用模式整体调松或调紧；受保护路径在任何模式下都会问 |
|  | [自动模式（Auto mode）](docs/features/auto-mode.md) | 不用一条条点确认：由分类器判断每个操作是否安全，安全的直接做，危险的拦下；可以用一句话加自己的规则 |
|  | [Hooks 事件、匹配与输出校验](docs/features/hooks.md) | 在 Claude 做某件事之前或之后自动跑你的脚本：拦住危险命令、改完自动格式化、开局注入上下文 |
|  | [Bash 沙箱](docs/features/sandbox.md) | 让 Claude 跑的命令只能写项目目录、只能连你允许的域名、读不到你指定的密钥；开了以后命令可以不再逐条确认；Linux、macOS、Windows 都支持 |
| 工具 | [Terminal 工具](docs/features/terminal-tool.md) | 给 Claude 一个能持续交互的终端：开 REPL、操作 TUI、按 Ctrl+C，跑完自动通知；开了 Bash 沙箱时终端也在沙箱里跑 |
|  | [Monitor 工具](docs/features/monitor-tool.md) | 让 Claude 在后台盯着日志或命令输出，有新内容就自动叫醒它，不用反复 sleep 轮询 |
|  | [定时任务：Cron、/loop 与 ScheduleWakeup](docs/features/scheduled-tasks.md) | 让 Claude 按时间自动做事：「每 5 分钟看一下构建」「工作日早上 9 点汇总 PR」；`/loop` 一句话设定 |
|  | [终端程序状态（OSC 7501）](docs/features/terminal-status.md) | 支持的终端能在标签页上显示 Claude 正在忙、在等你批准、还是已经做完，不用切回来看 |
| 上下文与记忆 | [记忆：auto memory 与 SQLite FTS5 检索](docs/features/memory.md) | Claude 把跨会话有用的事（项目约定、你的偏好）记到文件里，下次自动带上；可改成 SQLite 全文检索，按需查找 |
|  | [自动压缩窗口](docs/features/compaction.md) | 对话太长时把早期内容压成摘要；`/autocompact` 决定多长时压缩（按模型分别保存），`/compact` 手动压缩；可换成保留最近原文的 Codex 式压缩（`compact.mode: "codex"`） |
|  | [Prompt context 与 Tool search](docs/features/prompt-context.md) | 让每次请求更省 token：提示词分层利于缓存，MCP 工具用到时才加载，大量同类工具只发一行汇总 |
|  | [用量、成本与状态](docs/features/usage-and-cost.md) | `/usage` 看本次会话花了多少钱、用了多少 token；`/stats` 看长期使用习惯；恢复会话后成本继续累计 |
| 界面与交互 | [会话命令](docs/features/session-commands.md) | 本 fork 新增或补齐的斜杠命令：`/recap` 回顾、`/cd` 换目录、`/focus` 精简显示、`/autocompact` 调压缩时机、`/usage` 用量等 |
|  | [自主 Goal](docs/features/goal.md) | 给 Claude 一个「做到才算完」的条件（如「所有测试通过」），每轮结束时自动检查，没达成就继续干 |
|  | [快捷键与 Vim 模式](docs/features/keybindings-vim.md) | 自己改快捷键、回合中途排队或立即插话、在输入框里用 Vim 的选择和括号跳转 |
|  | [自定义 UI / Branding 与 Status line](docs/features/branding.md) | 改界面上显示的产品名、换掉 Logo 的 ASCII 图，用自己的脚本定制底部状态栏 |
|  | [/diff 视图](docs/features/diff-view.md) | 全屏右侧 diff 面板：会话 / 未提交 / 分支三种基准、按轮次回看、把单个文件 diff 附到下一条提示 |
|  | [调试日志](docs/features/debugging.md) | 遇到问题时打开详细日志，看清楚 Claude Code 在后台做了什么、请求发到了哪 |
|  | [遥测与反馈](docs/features/telemetry.md) | 默认不向 Anthropic 发送使用数据，`/feedback` 也随之隐藏；需要时一个环境变量打开；设了 `DO_NOT_TRACK=1` 则一律不发 |
| 远程执行 | [Direct Connect](docs/features/direct-connect.md) | 在一台机器上 `claude server`，在另一处用 `claude cc://...` 连过去：工具在 server 上执行，界面和权限确认在你这边 |
|  | [SSH Remote](docs/features/ssh-remote.md) | `claude ssh 主机` 让 Claude 在远程 Linux 机器上读写文件、跑命令，界面和权限确认留在本机；API 凭据不离开本机 |
| 插件与扩展 | [插件与 Marketplace](docs/features/plugins-marketplace.md) | 从插件市场一键安装命令、skill、agent、hook 和 MCP；团队可以自建 marketplace，装完 `/reload-plugins` 立即生效 |
|  | [MCP 配置与认证](docs/features/mcp.md) | 接入外部工具服务器（数据库、浏览器、内部 API 等）；配置错一条只跳过那一条，`/mcp` 查看状态、重连、登录 |
|  | [Skills](docs/features/skills.md) | 把一套做事步骤写进 SKILL.md，用 `/名字` 调用，或让 Claude 在合适时自动使用；`/skill-doctor` 找出从没用过却占提示的 skill |
|  | [Channels](docs/features/channels.md) | 让 Telegram、Discord 或你自己写的 MCP server 把消息推进正在运行的会话，还能在手机上远程批准工具调用 |
|  | [Mods / Function Hooks](docs/features/mods.md) | 用一个 JS/TS 文件改造 Claude 本身：加命令、拦截或改写工具调用、在界面上加状态条和侧边面板（基线官方 2.1.303） |
|  | [Mods 远程客户端（stream-json）](docs/features/mods-sdk-client.md) | 给桌面 / IDE 等外部界面用的协议：通过 stream-json 让 Mod 把界面画到你自己的前端上，并把点击、输入传回来 |
|  | [Agent SDK 与 stream-json 控制协议](docs/features/agent-sdk.md) | 在自己的程序里调用 Claude：官方 Agent SDK（TS / Python）可以直接驱动本 fork 的 CLI，用 `env` / `settings` / `plugins` 打开 fork 功能（附示例）；补齐了 SDK 0.3 会用到的控制请求 |
|  | [VS Code 插件](docs/features/vscode-extension.md) | 让官方 VS Code 插件改用本 fork 运行：面板里的 `/status`、`/usage`、`/memory`、`/sandbox` 等对话框都能正常打开 |
| 开发与发布 | [构建、发布与终端验收工具](docs/features/build-and-release.md) | 给贡献者：怎么从源码构建出可运行的 binary、怎么和官方版本对照、发布流程做了什么 |

## 开发约定

修改 TypeScript 后至少运行：

```bash
bunx tsc --noEmit --pretty false
bun run build
bun run lint
bun run audit:missing
git diff --check
```

涉及 binary、CLI 入口或交互行为时，再运行：

```bash
make build
./built-claude --version
./built-claude --help
```

本项目仍包含恢复阶段的类型边界。修复类型时应优先使用精确 interface、discriminated union、`unknown`、assertion function 和 type guard，避免为消除局部错误而放宽全局核心类型。

## 技术文档（Ref）

### 入门与构建

- [`docs/README.md`](docs/README.md) — 文档中心、分类和推荐阅读顺序。
- [`docs/features/`](docs/features/README.md) — 每项功能的说明、配置与终端效果。
- [`docs/guides/build.md`](docs/guides/build.md) — 环境要求、构建、运行、验证和故障排查。
- [`docs/guides/secondary-development.md`](docs/guides/secondary-development.md) — 恢复源码的二次开发流程与约束。
- [`docs/guides/recovery-workspace.md`](docs/guides/recovery-workspace.md) — 源码恢复背景、目录和恢复方法。
- [`docs/guides/agent-development.md`](docs/guides/agent-development.md) — Agent、Tool、Hook 和 Plugin 入门。

### 架构

- [`docs/architecture/runtime-internals.md`](docs/architecture/runtime-internals.md) — CLI、REPL、查询循环、工具和 Agent 主链路。
- [`docs/architecture/agent.md`](docs/architecture/agent.md) — AgentTool、runAgent、前后台运行与恢复。
- [`docs/architecture/agent-team.md`](docs/architecture/agent-team.md) — Team、共享任务、消息和协调者生命周期。
- [`docs/architecture/workflow-orchestration.md`](docs/architecture/workflow-orchestration.md) — Workflow、Agent、Skill、Hook、权限和隔离。
- [`docs/architecture/plugin-marketplace.md`](docs/architecture/plugin-marketplace.md) — Plugin 与 Marketplace 模型。
- [`docs/architecture/agent-sdk-exports.md`](docs/architecture/agent-sdk-exports.md) — Agent SDK 导出面和扩展 API。

### SSH、Workflow、研究与历史

- [`docs/design/ssh-local-ui-coherence.md`](docs/design/ssh-local-ui-coherence.md) — SSH transcript、远端补全、settings/Auth 边界与交互一致性设计。
- [`docs/research/prompt-context-optimization.md`](docs/research/prompt-context-optimization.md) — Prompt context 构成、精简结果、测量方法与剩余风险。
- [`docs/research/claude-mods.md`](docs/research/claude-mods.md) — Mods 契约、生命周期、官方证据与本地兼容性边界。
- [`mods-test.md`](mods-test.md) — Mods 收口测试方案、验收结果与证据索引。
- [`docs/design/workflow-runtime-parity.md`](docs/design/workflow-runtime-parity.md) — Workflow runtime parity 的行为和证据边界。
- [`docs/workflows/`](docs/workflows/) — Workflow 示例、兼容性材料和测试 fixture。
- [`docs/research/`](docs/research/) — 二进制分析、CCH、Workflow 和 Codex 对比研究。
- [`docs/archive/`](docs/archive/) — 已完成计划、测试计划和历史实施记录。
- [`CHANGELOG.md`](CHANGELOG.md) — 权威的本地变更与发布记录。

研究和归档文档描述的是特定时间点，不应直接视为当前行为保证；当前使用方法以 README、`docs/features/` 和源码为准，历史与验收记录以 CHANGELOG 为准。

## 安全与适用范围

本仓库用于授权的研究、调试和二次开发。恢复或修改后的 binary 不应未经独立安全、遥测、更新和权限审查直接用于生产环境。

请勿提交 `.env`、`~/.codex/auth.json`、API key、OAuth token、cookie、证书或其他私有配置。涉及外部 provider、插件、MCP、Workflow 和自动化任务时，应先确认权限范围及其对本地或共享环境的影响。
