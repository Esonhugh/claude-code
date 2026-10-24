# Unofficial Claude Code

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

当前发布版本为 `2.1.292`；发布历史、具体变更和验收边界统一记录在 [`CHANGELOG.md`](CHANGELOG.md)。

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
| 模型与 Provider | [OpenAI / Codex provider](docs/features/openai-provider.md) | OpenAI Responses API、ChatGPT OAuth / API key、OpenAI 下的 `/fast` 与 remote compaction |
|  | [模型自动发现与 Gateway](docs/features/model-discovery.md) | OpenAI `/v1/models` 与 Anthropic 网关模型发现，结果进入 Model Picker |
|  | [请求韧性：重试、回退模型与默认模型](docs/features/request-resilience.md) | stream idle watchdog、重试上限、无人值守重试、`fallbackModel` 链、`ANTHROPIC_DEFAULT_MODEL` |
|  | [Effort 档位](docs/features/effort.md) | `none`…`ultracode` 九档 effort，会话、settings、环境变量与 SubAgent 按次指定 |
|  | [Codex Apps](docs/features/codex-apps.md) | ChatGPT OAuth 下把 Codex Apps 接成 host-owned MCP 工具与 hosted skills，支持 `@codex-app:` mention |
| Agent 与编排 | [Agent 与后台任务](docs/features/agents.md) | Claude 把一部分工作交给「子代理」在后台做，你继续聊；可以查看、停止、续跑，也可以自己定义专用子代理 |
|  | [Agent Teams](docs/features/agent-teams.md) | 让 Claude 组一个小团队：一个负责人带几个队友并行干活，互相发消息、共享任务清单 |
|  | [Dynamic Workflow](docs/features/workflows.md) | 让 Claude 写一段编排脚本，一次调度多个子 Agent 分阶段、并行地干活；`/workflows` 看进度、保存成可复用的流程 |
|  | [背景会话、daemon 与 agents 视图](docs/features/background-sessions.md) | 把任务交给后台跑、终端立刻空出来；`claude agents` 一屏看谁在等你、谁在干活、谁做完了 |
|  | [独立会话通信](docs/features/peer-messaging.md) | 同机独立 CLI 会话经 UDS / named pipe 互发纯文本，`ListAgents` / `SendMessage` / `/peers` |
| 权限与安全 | [权限规则、权限模式与 Safe mode](docs/features/permissions.md) | Claude 什么时候要先问你：用规则提前放行或禁止，用模式整体调松或调紧；受保护路径在任何模式下都会问 |
|  | [自动模式（Auto mode）](docs/features/auto-mode.md) | 不用一条条点确认：由分类器判断每个操作是否安全，安全的直接做，危险的拦下；可以用一句话加自己的规则 |
|  | [Hooks 事件、匹配与输出校验](docs/features/hooks.md) | 在 Claude 做某件事之前或之后自动跑你的脚本：拦住危险命令、改完自动格式化、开局注入上下文 |
| 工具 | [Terminal 工具](docs/features/terminal-tool.md) | 持久 PTY session：`new-session`、`send-keys`、`capture-pane`、resize、signal，按 Bash 规则判权限 |
|  | [Monitor 工具](docs/features/monitor-tool.md) | 后台运行监看脚本，每行输出唤醒模型；Bash 前景 `sleep` 改用 Monitor |
|  | [定时任务：Cron、/loop 与 ScheduleWakeup](docs/features/scheduled-tasks.md) | `CronCreate/Delete/List`、session-only 或 durable 任务、`/loop` 自定节奏 |
|  | [终端程序状态（OSC 7501）](docs/features/terminal-status.md) | 支持 OSC 7501 的终端里上报 idle/working/blocked/done/error 状态 |
| 上下文与记忆 | [记忆：auto memory 与 SQLite FTS5 检索](docs/features/memory.md) | Claude 把跨会话有用的事（项目约定、你的偏好）记到文件里，下次自动带上；可改成 SQLite 全文检索，按需查找 |
|  | [自动压缩窗口](docs/features/compaction.md) | `/autocompact`、按模型 / 按 agent 的压缩窗口、`CLAUDE_CODE_AUTO_COMPACT_WINDOW` |
|  | [Prompt context 与 Tool search](docs/features/prompt-context.md) | 分层 cache boundary、增量 agent listing、MCP 工具汇总；自定义网关下 tool search 保持开启 |
|  | [用量、成本与状态](docs/features/usage-and-cost.md) | `/usage`（含 `/cost`、`/stats`）、ChatGPT plan 与 Codex limits、Fable 周额度、成本快照跨 resume 保留 |
| 界面与交互 | [会话命令](docs/features/session-commands.md) | 本 fork 新增或补齐的斜杠命令：`/recap` 回顾、`/cd` 换目录、`/focus` 精简显示、`/autocompact` 调压缩时机、`/usage` 用量等 |
|  | [自主 Goal](docs/features/goal.md) | `/goal` / `SetGoal` 设定目标，Stop hook 检查完成度，可跨 resume 恢复 |
|  | [快捷键与 Vim 模式](docs/features/keybindings-vim.md) | `keybindings.json` 热重载、send-now / queue-submit、`Ctrl+J`、Vim `%` 与 VISUAL 模式 |
|  | [自定义 UI / Branding 与 Status line](docs/features/branding.md) | `uiName` 改名、`clawd.txt` 自定义 Logo、statusLine 输入含 `goal.active` |
|  | [/diff 视图](docs/features/diff-view.md) | 全屏右侧 diff 面板：会话 / 未提交 / 分支三种基准、按轮次回看、把单个文件 diff 附到下一条提示 |
|  | [调试日志](docs/features/debugging.md) | `--debug [filter]`、`--debug-file`，全屏 footer 的 Debug 标记 |
|  | [遥测与反馈](docs/features/telemetry.md) | Anthropic 一方遥测默认关闭；`/feedback` 与问卷跟随开关；OTel `tool_decision` 带权限模式 |
| 远程执行 | [Direct Connect](docs/features/direct-connect.md) | `claude server` 在执行端起 session server，本地用 `cc://host:port/token` 连接 |
|  | [SSH Remote](docs/features/ssh-remote.md) | `claude ssh <host> [dir]` 在远端 Linux 跑 child 与工具，本地渲染 TUI，凭据只在本地 proxy 注入 |
| 插件与扩展 | [插件与 Marketplace](docs/features/plugins-marketplace.md) | `--plugin-dir`/`--plugin-url`、manifest `defaultEnabled`、Esonhugh-Marketplace、热加载与回滚 |
|  | [MCP 配置与认证](docs/features/mcp.md) | 接入外部工具服务器（数据库、浏览器、内部 API 等）；配置错一条只跳过那一条，`/mcp` 查看状态、重连、登录 |
|  | [Skills](docs/features/skills.md) | 把一套做事步骤写进 SKILL.md，用 `/名字` 调用，或让 Claude 在合适时自动使用；`/skill-doctor` 找出从没用过却占提示的 skill |
|  | [Channels](docs/features/channels.md) | `--channels` 让批准的频道插件 / MCP server 把消息推入会话，支持远程工具审批 |
|  | [Mods / Function Hooks](docs/features/mods.md) | 可信插件经 `hooks/modules` 接入生命周期、tool/prompt/turn middleware、动态命令与终端 Pane（基线官方 2.1.303） |
|  | [Mods 远程客户端（stream-json）](docs/features/mods-sdk-client.md) | SDK 父进程启动时传入插件、远程绘制 / 焦点 / 滚动 / 草稿编辑协议 |
|  | [Agent SDK 与 stream-json 控制协议](docs/features/agent-sdk.md) | 兼容 Agent SDK 0.3：`reload_skills`、`read_file`、`update_settings`、模型 / 权限模式切换校验、动态 MCP |
| 开发与发布 | [构建、发布与终端验收工具](docs/features/build-and-release.md) | Bun 构建、bytecode binary、binary-only npm 发布、内嵌 ripgrep、Linux 发布门禁与终端采集 |

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
