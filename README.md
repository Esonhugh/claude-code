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

当前源码候选版本为 `2.1.280`；发布历史、具体变更和验收边界统一记录在 [`CHANGELOG.md`](CHANGELOG.md)。

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

以下内容概括当前源码提供的重要本地能力；变更历史见 [`CHANGELOG.md`](CHANGELOG.md)。

| 领域 | 当前能力 |
| --- | --- |
| OpenAI/Codex provider | 支持 OpenAI Responses API、ChatGPT OAuth、device code 登录、token refresh、API key 和 Codex auth 文件；启用 server-side `WebSearch`，将 Anthropic web-search schema、OpenAI Responses `web_search_call`、URL citations 和 usage 转换为 Anthropic-compatible stream 事件；OpenAI 模式自动从 ChatGPT Codex 或 OpenAI-compatible `/v1/models` 发现模型，Anthropic API billing gateway 可通过 `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` 启用同类发现，并统一进入 Model Picker 缓存；`/fast` 映射到 OpenAI priority service tier，手动和重复 remote compaction 会保持稳定 turn scope 与 opaque compaction history。 |
| Effort | CLI 可配置 `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`、`ultra`、`ultracode`，Model Picker/SDK capability 列表仍按 provider 与模型声明可选档位；configured effort 不按 capability 重写并原样传入所选 API，仅本地编排模式 `ultracode` 展开为 API `xhigh`。 |
| Agent | 支持前台/后台 Agent、续跑、nested Agent、Team/SendMessage、usage 聚合、终态通知和可选 worktree isolation；默认提供只读代码搜索 `Explore` 和方案设计 `Plan`，可通过 `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1` 关闭。 |
| 独立会话通信 | 同机独立 CLI session 可通过 official-compatible `msgV: 1` JSON-lines 协议发现和发送纯文本；提供 deferred `ListAgents` / `SendMessage` tools 以及 `/list-agents`（别名 `/peers`），支持 name、`name [ref]`、session UUID 和来信中的精确 `uds:` 地址。该能力使用 macOS/Linux UDS 或 Windows named pipe，不是 Remote Control 或跨机器 transport。 |
| Prompt context | System prompt 按稳定核心、能力和任务动态层组织 cache boundary；Plan + Auto mode 保持只读权限边界；Agent listing 使用增量 attachment，大型 deferred MCP tool 列表按 namespace 汇总，同时保留权限与动态工具发现。 |
| Dynamic Workflow | 提供与官方模式兼容（official-compatible）的 Workflow facade、official-style script parser/runtime、declarative plan、phase、parallel/pipeline、journal cache、暂停、恢复、skip/retry 和生命周期通知。 |
| Codex Apps | OpenAI + ChatGPT OAuth 模式下将 Codex Apps 作为 host-owned MCP tools 与 hosted MCP skills 接入；支持逐项隐藏、`@codex-app:{app-name}` mention、裸 `@`/专用前缀补全和 deferred tool 按需加载，并限制 hosted skill 的可信来源、URI、分页、内容大小与缓存。 |
| Direct Connect | `claude connect <server-url>` 通过 HTTP 创建 session，再以 WebSocket 传输 stream-json；server 负责 Claude child、tools 和项目上下文，本地负责 TUI 与 permission UI。 |
| SSH Remote | 与 Direct Connect 并列的 SSH transport：`claude ssh <host-or-config> [dir]` 在远端 Linux 主机运行 child 与 tools、本地渲染 TUI；支持 remote-owned history/resume、远端 `@` 路径补全、远端 `!command` 和权限状态同步；remote binary 按版本/架构部署，GitHub Release 下载会校验 checksum，OpenAI/Anthropic 凭据只在本地 Unix socket proxy 注入。 |
| Terminal Tool | 提供持久 PTY session 的 `new-session`、`list-panes`、`send-keys`、`capture-pane`、`resize-pane`、`send-signal`、`display-message`、`kill-pane` 生命周期，以及 compact/full/save_file 输出；后台 polling 按 session 同步终态并保留最终输出、command、args 和 cwd。 |
| 自定义 UI / Branding | 支持通过 `uiName` 自定义 Logo、condensed header 和 border title，默认显示 `EsonClaw`；支持加载自定义 `clawd.txt` ASCII 图。 |
| 状态与用量 UI | 当前模型使用 ChatGPT OAuth 且用量请求成功时，自动识别 `Plus`、`Pro`、`Team`、`Business`、`Enterprise` 等 plan，并在启动 pane 和 `/status` Usage 展示权威订阅及 Codex limits，同时展示 ChatGPT 用量窗口与 rate-limit reset credits；用量不可用时启动 pane 回退到 OAuth token 中的 plan，`/status` 显示不可用状态。reset 操作经二次确认后消耗一个 credit 并刷新显示；使用 API key 或 bearer token 时显示 `API Usage Billing`，不展示 ChatGPT subscription usage。Model Picker 支持 effort 显示、切换和持久化。 |
| 自主 Goal | `/goal` 或 `SetGoal` 注册 StopHook 并驱动自主执行；Goal 状态通过 transcript attachment 持久化，resume/continue 可恢复 active Goal 与 hook；交互式 `/goal` 展示进行中、完成或失败状态及耗时、turn、token 和最后检查原因，支持 clear、impossible 终态、后台任务延后检查与自动清理。 |
| Hook 可靠性 | Stop hook 连续阻止结束时默认在第 9 次终止续跑，可用 `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` 调整或禁用上限；正常 tool round 会重置计数，`maxTurns` 保持更高优先级。 |
| 会话命令 | 提供 `/goal`、`/fast`、`/compact`、`/cd`、`/reload-skills`、`/reload-plugins`、`/workflows`、`/list-agents`（别名 `/peers`）；`/cd` 支持目录路径补全。 |
| Skills | 支持 bundled/model-internal skills、运行时 `/reload-skills`、user/project/plugin 分层加载，以及按功能类型路由 source tests、构建、tmux TUI 和 official parity 的 `claude-code-feature-validation` skill。 |
| 定时任务 | 提供 `CronCreate`、`CronDelete`、`CronList` 和 `/loop` 相关能力，可使用 session-only 或 durable task。 |
| Plugin/Marketplace | 扩展 marketplace、favorite scope、auto-update、插件热加载、失败状态回滚及官方插件名称兼容。 |
| Mods / Function Hooks | 可信插件可通过 `hooks/modules` 接入生命周期、tool/prompt/turn middleware、动态命令和 terminal Pane；提供 scoped host capabilities、热重载、在途 generation 保留、取消与卸载。支持范围与官方运行时兼容性边界见下方 Mods 章节。 |
| 调试与构建 | 提供 Bun 构建、binary-only npm 发布、source map/Ink/代理调试、CCH attestation、官方 CLI 对照和 tmux/PTY 验收资料；平台 binary 会内嵌并在运行时提取 ripgrep，避免依赖系统安装。 |

## 配置与使用示例

设置可以写入 Claude Code 用户级或项目级 `settings.json`。以下片段只展示本项目相关字段，使用时应与现有 JSON 合并，不要覆盖其他设置。

### OpenAI provider 与登录

启用 OpenAI provider：

```bash
CLAUDE_CODE_USE_OPENAI=1 claude
```

进入 CLI 后可执行：

```text
/login
```

OpenAI 模型 API 凭证读取优先级为：

1. `OPENAI_AUTH_TOKEN`
2. `OPENAI_API_KEY`
3. `~/.codex/auth.json` 中的 API key
4. `~/.codex/auth.json` 中的 ChatGPT OAuth access token

当前模型凭据决定计费与用量状态：使用 API key 或 `OPENAI_AUTH_TOKEN` 时，启动 pane 显示 `API Usage Billing`，`/status` Usage 显示 `Usage data is unavailable for the current OpenAI authentication.`，不展示 ChatGPT subscription；仅当当前模型凭据为 `~/.codex/auth.json` 中的 ChatGPT OAuth 时，才显示 ChatGPT plan 和 Codex limits。Codex Apps 同样要求当前模型使用 ChatGPT OAuth。

未显式指定 OpenAI 模型时，Anthropic 模型名称默认映射为 `gpt-5.6-luna`；显式指定的 OpenAI 模型名称保持不变。

ChatGPT OAuth 模式下，`/stats` 提供独立 OpenAI activity 标签页，显示 lifetime/peak/streak 指标及 Daily、Weekly、Cumulative 图表。图表内按 `v` 切换视图；Daily 使用 `↑/↓` 移动一天、`←/→` 移动七天，Weekly 使用 `←/→` 选择周并以 `↑/↓` 选择周内日期，Cumulative 使用 `←/→` 选择周。Token 摘要使用 K/M/B 两位有效数字，选中项保留精确数值。

API key 示例：

```bash
CLAUDE_CODE_USE_OPENAI=1 OPENAI_API_KEY=<your-api-key> claude
```

OAuth 登录结果保存在 `~/.codex/auth.json`，文件权限为 `0600`。不要提交或分享该文件。

### OpenAI Fast mode 与 compaction

OpenAI provider 使用 API key 或 ChatGPT OAuth 时均可执行：

```text
/fast
/compact
```

OpenAI 下 `/fast` 对当前模型启用 priority processing，请求映射为 Responses API 的 `service_tier: "priority"`，不会发送内部 `speed` 字段。该路径不使用 Anthropic Fast mode 的 beta header、状态预取或自动降级；endpoint 不支持 priority tier 时会直接显示服务端错误，再次执行 `/fast` 可关闭。

手动 `/compact` 会在 query turn 外创建稳定的 OpenAI session/thread/turn scope。连续 remote compaction 和压缩后继续对话都会携带上一轮 opaque compaction item，避免重复压缩后丢失此前会话上下文。

### 模型自动发现与 Gateway

OpenAI provider 启动时会刷新只属于当前 provider、endpoint 与 credential identity 的 Model Picker 缓存：

- ChatGPT OAuth 使用固定的 ChatGPT Codex models endpoint，并携带当前 account identity；
- API key 或 `OPENAI_AUTH_TOKEN` 在未设置 base URL 时请求 `https://api.openai.com/v1/models`，设置 `OPENAI_BASE_URL` 时请求其规范化后的 `/v1/models`；
- base URL 末尾无论是否已有 `/v1`，最终都只会请求一次 `/v1/models`；
- OpenAI 默认 API 只展示名称前缀为 `gpt-`、`o` 或 `codex`、且未标记为不支持 API 的模型；自定义 OpenAI-compatible base URL 会保留 endpoint 返回的其他未标记为不支持 API 的模型。

OpenAI-compatible gateway 示例：

```bash
CLAUDE_CODE_USE_OPENAI=1 \
OPENAI_BASE_URL=https://gateway.example/api \
OPENAI_API_KEY=<gateway-api-key> \
claude
```

Anthropic API billing 模式下，gateway 模型发现默认关闭。必须同时提供开关、base URL 和可用认证：

```bash
CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 \
ANTHROPIC_BASE_URL=https://gateway.example \
ANTHROPIC_AUTH_TOKEN=<bearer-token> \
claude
```

也可以使用显式的 `ANTHROPIC_API_KEY`，请求会改用 `x-api-key`；当两者同时存在时优先使用 `ANTHROPIC_AUTH_TOKEN`。可信 `apiKeyHelper` 也可提供 gateway bearer credential，但 `/login` 保存的 managed key 和 `CLAUDE_CODE_OAUTH_TOKEN` 不会发送到自定义 gateway。`ANTHROPIC_CUSTOM_HEADERS` 会按大小写不敏感规则覆盖默认 header；最终实际发送的 `Authorization` 与 `x-api-key` 值参与缓存 identity，但原始 credential 不写入缓存。gateway 请求 `${ANTHROPIC_BASE_URL}/v1/models`，并在 Model Picker 中展示未被明确标记为不支持 API 的模型，包括 endpoint 标记为 hidden 的模型；hidden 项会显示 `(Hidden)`。

OpenAI discovery、first-party Anthropic bootstrap 和 Anthropic gateway discovery 使用各自的缓存身份或文件。identity 包含 provider、规范化 endpoint、认证模式以及 credential/account identity；不同 provider、base URL、账户或 credential 不共享模型目录。first-party bootstrap 返回的 `additional_model_options` 只在当前 first-party identity 匹配时追加到内置 Claude catalog，相关 client data 与 compaction window 同样受该 identity 约束。gateway 使用独立磁盘缓存，失败时不会回退到 official bootstrap，也不会覆盖 first-party 数据。

发现请求超时、失败、响应无效或没有认证时，会保留原缓存内容，但 Model Picker 仅在缓存 identity 与当前运行身份完全匹配时读取；成功响应但没有可用模型时会清空当前 identity 的旧模型列表。OpenRouter 仅可作为普通 OpenAI-compatible endpoint 使用，本项目没有为它增加独立 provider 或专用环境变量。

### Codex Apps mention

当前模型使用 OpenAI provider 和 ChatGPT OAuth，且 `codex_apps` MCP 已连接时，在 PromptInput 输入以下前缀即可浏览已发现 Apps：

```text
@codex-app:
```

也可以直接选择具体 App：

```text
@codex-app:github 检查当前仓库的 pull requests
@codex-app:gmail 查找与发布相关的邮件
```

mention 只会解析当前已发现且已过滤的 App 工具，不会恢复禁用 connector、创建未发现工具或绕过工具权限。若工具仍处于 deferred 状态，模型会通过 `ToolSearch` 按需加载。

当前模型使用 ChatGPT OAuth 时，可通过以下界面确认连接和 subscription 状态：

```text
/mcp
/status → Usage
```

### Effort 配置

持久设置示例：

```json
{
  "effortLevel": "ultracode"
}
```

可持久化值：

```text
minimal | low | medium | high | xhigh | max | ultra | ultracode
```

当前会话中切换：

```text
/effort minimal
/effort high
/effort xhigh
/effort ultracode
/effort none
/effort auto
```

也可以用环境变量覆盖：

```bash
CLAUDE_CODE_EFFORT_LEVEL=xhigh claude
```

`auto` 或 `unset` 表示不显式发送 effort。Model Picker 和 SDK capability 列表仍按当前 provider/模型声明可选档位；通过 CLI、settings 或环境变量给出的 configured effort 不再按该 capability 重写并原样进入 API。只有 `ultracode` 是本地编排模式，会以 `xhigh` 作为 API effort。

### 自定义 UI / Branding

通过 `uiName` 可以修改 LogoV2、condensed header 和 compact border title 中显示的本地 UI 名称。未设置或值为空时默认显示 `EsonClaw`：

```json
{
  "uiName": "EsonClaw Lab"
}
```

还可以在 `${CLAUDE_CONFIG_DIR:-~/.claude}/clawd.txt` 中保存自定义 Clawd ASCII 图。文件存在且非空时，Logo 区域优先显示该文件内容；读取失败或文件为空时回退到内置图案。Fullscreen condensed 布局会按图案的终端显示宽度在横排与纵排间切换，超宽行在可用列内截断，图案的实际行数参与布局，不覆盖会话正文。

```bash
mkdir -p ~/.claude
printf '  /\\_/\\\n ( o.o )\n  > ^ <\n' > ~/.claude/clawd.txt
```

如使用自定义配置目录：

```bash
CLAUDE_CONFIG_DIR=/path/to/claude-config claude
```

对应图案文件应放在：

```text
/path/to/claude-config/clawd.txt
```

Status line 沿用 Claude Code 的 `statusLine` command 配置。本地传给 command 的 JSON 输入除 model、workspace、version、cost、context window、rate limit、agent 和 worktree 等状态外，还包含 `goal.active`：

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/statusline.js",
    "padding": 1
  }
}
```

Settings Status 还会显示 OpenAI Account；Usage/Stats 面板区分 Claude 与 ChatGPT/OpenAI 用量；Model Picker 可直接显示、切换并持久化 effort。

### 独立会话通信

普通交互式 CLI 启动时会注册同机 inbox；`--bare` 和 SSH local UI 默认不注册。会话发现使用同一个 `${CLAUDE_CONFIG_DIR:-~/.claude}/sessions` registry，因此不同 `CLAUDE_CONFIG_DIR` 的 session 不会通过名称或 UUID 相互发现。可用 `--name` 设置易识别的 session 名称：

```bash
claude --name reviewer
```

默认 endpoint 无需配置。高级集成可使用 `--messaging-socket-path <endpoint>` 覆盖：Unix 使用绝对 `.sock` 路径，Windows 使用 local named pipe；显式指定后也可让 `--bare` 启动 inbox，但 SSH local UI 仍不启动。显式 endpoint 绑定失败会终止启动；自动 endpoint 不可用时只记录 debug log，CLI 继续运行。

查看当前可发现的其他 session（仅在 messaging inbox 成功启动时显示，结果不包含当前进程）：

```text
/list-agents
/peers
```

模型侧的 `ListAgents` 和 `SendMessage` 默认 deferred，由 `ToolSearch` 按需加载。`SendMessage.to` 可使用列表中的 name、名称冲突时的 `name [ref]`、session UUID，或回复来信时复制其精确 `from="uds:..."` 地址。跨独立 session 只发送纯文本，不传递 Team 的 shutdown/plan approval 等结构化控制消息。普通 assistant 文本不会自动发送给 peer；发送成功只确认 transport write，不代表接收方已经接受或处理消息。Peer 输入保留独立 provenance，不作为用户指令或权限批准，也不会解析 slash commands 或 attachments。

入站策略可在用户级或项目级 settings 中配置：

```json
{
  "crossSessionInbound": "accept"
}
```

可选值：

- `accept`：消息进入接收方队列；
- `hold`：暂存，等待 permission class 或 settings 变化后重新判断；
- `refuse`：拒绝消息。

未配置时不是固定值：接收方尚无 permission context 时为 `hold`；已知发送方 permission class 时，同 class 为 `accept`、不同 class 为 `hold`；来信未声明 class 时，普通 prompting session 为 `accept`，bypass session 为 `hold`。project/local policy 只能比 user/managed policy 更严格，不能在仓库配置中放宽上层限制。

该协议仅用于同机 session：macOS/Linux 使用 Unix domain socket，Windows 使用 local named pipe；Remote Control、Direct Connect 和 SSH Remote 是独立 transport。

### Plan mode 配置

Plan mode 默认不可新进入，需要显式启用：

```json
{
  "planModeAvailable": true
}
```

该设置控制 `/plan`、`EnterPlanMode`、mode cycle，以及 Plan-sensitive tools、Agent schema 和提示。关闭后会阻止新进入 Plan mode；如果 session 已处于 Plan restrictions，退出路径仍保留，避免被锁在该模式中。

### Workflow 配置与使用

本地 Workflow 以**与官方模式兼容（official-compatible）**为目标，兼容 official-style facade、script parser/runtime 和运行生命周期，但不宣称是 Anthropic 官方实现或与任意未来官方版本完全相同。

Workflow 默认关闭，启用只需要一个正式 setting：

```json
{
  "enableWorkflows": true
}
```

关键词触发默认开启；正式 schema-backed setting `ultracodeKeywordTrigger` 可控制兼容关键词：

```json
{
  "enableWorkflows": true,
  "ultracodeKeywordTrigger": false
}
```

运行时还兼容 `workflowKeywordTriggerEnabled` 和 `skipWorkflowUsageWarning`，但它们目前未进入 `SettingsSchema`，属于兼容/实验字段，不作为稳定配置契约。

Workflow spec 可放在：

```text
docs/workflows/
.claude/workflows/
```

`/workflows` 仅用于查看和管理运行状态；实际执行由 `Workflow` / `WorkflowTool` 或注册后的 workflow slash command 发起。

官方模式兼容点包括：

- facade 支持 saved workflow、inline `{ script }`、`{ scriptPath }` 和 declarative `{ plan }`；
- 输入优先级为 `scriptPath > name > script > plan`；
- inline workflow 的运行名称和持久化文件名来自 `meta.name`；
- 支持 `agent`、`pipeline`、`parallel`、`workflow`、`phase`、`log`、`args`、`budget` runtime globals；
- 支持 `resumeFromRunId`、journal/resume cache、`status`、`pause`、`resume`、skip/retry，以及 failed/killed/stopped 生命周期状态。

Official-style inline workflow 的最小结构：

```js
export const meta = {
  name: 'parallel-review',
  description: 'Review two areas concurrently.',
  phases: [{ title: 'Review' }],
}

phase('Review')
return await parallel([
  () => agent('Review area A'),
  () => agent('Review area B'),
])
```

首条语句必须是未注释的 `export const meta = { ... }`。脚本运行时提供 `agent`、`pipeline`、`parallel`、`workflow`、`phase`、`log`、`args` 和 `budget`。

兼容模式仍有明确的安全和可恢复性边界：

- workflow script 必须是 plain JavaScript，不支持 TypeScript syntax；
- `meta` 必须是 pure literal，拒绝 computed key、spread、method/accessor 和 template interpolation；
- 脚本只负责编排 Agent 或 child workflow，shell 和文件系统操作应交给 Agent；
- 不应依赖 Node filesystem/shell API、dynamic import、`Date.now()`、`Math.random()`、`eval`、`Function` 或 WebAssembly；
- child workflow 嵌套限制为一层。

### Codex Apps

Codex Apps 需要同时满足：

- `CLAUDE_CODE_USE_OPENAI=1`；
- 使用 ChatGPT OAuth 登录，而不是 API key；
- 未设置 `CLAUDE_CODE_DISABLE_CODEX_APPS=1`。

隐藏指定 connector：`disabledCodexApps` 仅在用户级 `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json` 中生效；project/local settings 中的同名配置不生效。

```json
{
  "disabledCodexApps": [
    "connector-id-a",
    "connector-id-b"
  ]
}
```

该设置只将对应 Apps 从模型可用 tool pool 中隐藏；host-owned `codex_apps` MCP 仍保持连接，以支持管理和重新启用。

除 Apps tools 外，`codex_apps_plugins` runtime 还会通过 `mcp/skill` resources 发现 hosted skills，并在调用时按需读取。两类投影相互独立：hosted skills 不会重复暴露 Apps tools，host-owned plugin resources 也不会作为普通 MCP resources 出现在 `@` 补全中。

hosted skill 加载具有以下边界：

- 只接受可信的 `codex_apps` 与 `codex_apps_plugins` 来源；
- 校验 skill 名称、resource URI、分页和内容大小；
- 内存缓存绑定当前连接的 MCP client object identity 并设置 TTL，避免同名连接之间复用发现结果；
- Codex Apps transport 只向固定的 Apps 与 plugin runtime MCP endpoints 注入 ChatGPT OAuth 和 account 信息；遇到 `401` 时强制刷新 token，并且只重试一次。

### 远程执行：Direct Connect 与 SSH

`claude connect <server-url>` 先通过 HTTP 创建远端 session，再使用 WebSocket 双向传输 stream-json；远端 server 持有 Claude child、tools 和项目上下文，本地仅渲染 TUI 并处理 permission UI。malformed control frame、permission cancellation 和 late response 由 transport 生命周期处理。

SSH Remote 使用相同的本地 UI / 远端执行边界，但通过 SSH 部署 managed child，并在 child stdio 上传输 stream-json。两者是并列 transport，不会相互转发。

所有 remote execution session 当前都禁用本机 IDE integration、local tools 和 local skill watcher，以免本机 IDE/workspace 与远端执行上下文混用。因此 `--ide` 不会在 Direct Connect 或 SSH session 中暴露本机 IDE MCP tools；即使 Direct Connect server 与本机共享 workspace，也适用这一保守边界。

#### SSH Remote

`claude ssh` 在远端 Linux 主机执行 Claude child 与 tools，本地继续渲染 TUI、处理 permission prompt 和 interrupt：

```bash
claude ssh user@example.com
claude ssh my-ssh-alias ~/project
claude --model gateway-model ssh managed-config-id /srv/project
```

host 可以是 `user@host`、`~/.ssh/config` alias，或 settings 中的 `sshConfigs` ID：

```json
{
  "sshConfigs": [
    {
      "id": "managed-config-id",
      "name": "Managed Linux",
      "sshHost": "user@example.com",
      "sshPort": 2222,
      "sshIdentityFile": "/path/to/private-key",
      "startDirectory": "~/project"
    }
  ]
}
```

启动时会探测 Linux architecture，按当前版本选择并部署 `linux-x64-baseline` 或 `linux-arm64` binary。开发态会直接使用当前可执行文件相邻 `dist/release` 中的对应 artifact；不存在相邻 artifact 时才回退到 GitHub Release，且下载必须同时提供对应 asset 与 `SHA256SUMS.txt`，checksum 缺失或不匹配时拒绝启动。remote cache 位于 `~/.cache/claude-ssh/<version>/<target>/claude`。

模型 API/OAuth credential 不会复制到远端。远端 child 仅连接 reverse-forwarded Unix socket，由本地 proxy 按当前 provider 和本地 credential precedence 注入认证；OpenAI/Anthropic API key、OAuth token、account ID、cookie、client certificate/key/passphrase、`ANTHROPIC_CUSTOM_HEADERS` 和本地 base URL 不会通过 SSH child environment 继承。代理会在本地应用自定义 header 与网络代理设置，并在转发前替换认证 header。

`--settings` 与 `--setting-sources` 始终由本地 launcher 读取，用于解析 `sshConfigs`、provider、upstream 和认证；原始路径、inline JSON 与 secret 不会进入远端 argv。`--model` 或本地 settings 解析出的 model 会显式转发给 remote child。tools、skills、plugins、hooks、MCP、文件索引、项目上下文和 transcript 则由远端 child 及其远端 settings 管理。

连接或 resume 时，本地 UI 会先从远端 canonical transcript 完成 history bootstrap，再接受新输入；消息 UUID、hidden/meta 消息、compact boundary 和 live echo 会按远端 identity 合并去重。正常退出时显示包含原始 target、远端 cwd 和远端 session ID 的完整 `claude ssh ... --resume ...` 命令。本地不保存第二份可 resume transcript，当前也不自动重连断开的 SSH session。

SSH PromptInput 的 `@` fuzzy/path 候选来自远端文件索引和目录扫描，不会读取本机 workspace。目录选择可以继续补全下一级；cold index 完成后会对仍有效的 query 有界刷新。包含空格、引号、反斜杠、美元符号、反引号或 Unicode 的路径会使用可逆 quoted mention，例如：

```text
@"docs/path with spaces/file.md"
```

SSH Remote 当前只支持 interactive TUI。`!command` 在远端 cwd 直接执行并将转义后的结果写入远端 transcript；远端 Agent progress、Bash 和未知 MCP tool card 可在本地显示，但 display-only fallback 不能在本地执行。permission allow/deny/cancel、`/yolo`、Shift+Tab、永久规则、additional workspace directory、Esc interrupt、正常退出和断线均经 capability-protected control channel 同步；启用 `planModeAvailable: true` 时也同步 `/plan`。workspace directory 的存在性由远端验证。

### Terminal Tool

`Terminal` 提供持久 PTY session，可用于需要多轮输入、特殊按键、窗口 resize 或 signal 的交互式程序：

```json
{
  "action": "new-session",
  "command": "bun",
  "args": ["repl"],
  "cwd": "/path/to/project",
  "cols": 120,
  "rows": 30
}
```

创建 session 后，使用返回的 pane target 调用 `send-keys`、`capture-pane`、`resize-pane`、`send-signal`、`display-message` 或 `kill-pane`；`list-panes` 可列出尚未回收的 pane。`capture-pane` 支持 `compact`、`full` 和 `save_file` 三种输出模式。

Terminal task 详情会以 JSON 数组保留启动时的 `args`，并与 `command`、`cwd` 一起展示。任务由统一的后台 polling 逻辑跟踪真实 PTY 状态；每个 session 使用独立 timer：

- 进程自然退出后停止轮询、清理 runtime registry、持久化最终输出，并只发送一次完成通知；
- 根据真实退出状态区分 `completed`、`failed` 和 `killed`，保留 `exitCode`、`signal`、termination reason 与 driver error；
- signal、close 和状态刷新会继续 drain 尾部输出，避免丢失进程退出前的最后内容；
- exited、closed 和 failed session 会在 TTL 到期后主动 dispose。

`send-signal` 表达操作系统 signal；需要向前台程序发送键盘 `Ctrl+C` 时，应使用 `send-keys` 的 `CTRL_C`。

### 调试日志

使用 `--debug` 启用调试输出，可选 category filter；使用 `--debug-file` 将日志写入指定文件并隐式启用 debug mode：

```bash
claude --debug
claude --debug api,hooks
claude --debug-file /tmp/claude-debug.log
```

OpenAI 请求诊断记录请求摘要、大小、压缩 checkpoint 和公共前缀，不记录请求正文；公共前缀稳定不等同于服务端 cache hit。

### Agent 与后台任务

默认内置两个只读专业 Agent：

- `Explore`：快速搜索和理解代码库；
- `Plan`：在不修改代码的前提下分析调用链并设计实施方案。

可通过以下环境变量同时关闭它们：

```bash
CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1 claude
```

Agent 还支持前台执行、后台执行、命名续跑和可选隔离。模型可使用的典型输入为：

```json
{
  "description": "检查配置映射",
  "prompt": "核对 provider effort 的当前行为并报告证据。",
  "subagent_type": "general-purpose",
  "model": "sonnet",
  "run_in_background": true,
  "name": "effort-review",
  "isolation": ""
}
```

禁用后台任务参数暴露：

```bash
CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 claude
```

### fork 技能的代理名称

在 `.claude/skills/review/SKILL.md` 中指定 `context: fork` 和 `agent`，再输入 `/review <任务>`；模型的 SkillTool 调用也使用同一配置。用户技能目录和旧 `.claude/commands/review.md` 使用同一解析器。代理定义放在 `.claude/agents/<名称>.md`，配置方法见 [Anthropic subagents 文档](https://code.claude.com/docs/en/sub-agents)。

```yaml
---
description: Run the review in a separate agent
context: fork
agent: reviewer
background: false
---
Review $ARGUMENTS.
```

`agent` 的非空 YAML 值转换为字符串；例如 `agent: 42` 可以选择名称为 `"42"` 的代理。`agent: null` 或不写该字段使用已有默认代理选择。编写技能时建议显式使用字符串名称。`background: false` 明确选择同步执行；交互模式省略该字段或设为 `true` 时，fork 技能默认后台启动。

本专项以 2026-10-07 获取的官方 2.1.292 为基准，验证七个真实 slash/SkillTool 场景；不代表全部 Mods 声明与 UI 已迁移到该版本。回归命令为 `bun test --no-env-file ./src/skills/loadSkillsDir.forkAgent.test.ts`，终端证据及边界见 [fork agent 类型专项](docs/research/mods-fork-agent-types-20261007.md)。技能配置参考 [Anthropic skills 文档](https://code.claude.com/docs/en/skills#run-skills-in-a-subagent)。

### 会话命令

```text
/goal 完成当前功能并运行相关测试
/goal
/goal clear

/cd ../another-project
/reload-skills
/reload-plugins
/diff
/workflows
/list-agents
```

- `/goal <condition>`：保存当前自主目标，并在停止前检查目标是否完成；主线程也可通过 `SetGoal` 设置同一目标。Goal 状态和 hook 会写入 transcript 并可在 resume/continue 后恢复。
- `/goal`：打开交互式状态视图，展示当前 Goal 的状态、耗时、turn、token 和最后检查原因。
- `/goal clear`：清除当前 Goal 及其 Stop hook，并持久化 cleared 状态。
- `/fast`：切换 Fast mode；OpenAI provider 下发送 `service_tier: "priority"`，API key 与 ChatGPT OAuth 均可使用。
- `/compact`：压缩当前会话；OpenAI provider 下支持手动 remote compaction，并在重复压缩时保留 opaque compaction history。
- `/cd`：切换当前会话工作目录，并将目录加入当前 session 的工作范围。
- `/reload-skills`：不刷新插件，直接重新读取 user/project/plugin skills。
- `/reload-plugins`：应用 `/plugin manage` 中的安装、更新和启停变更，重新加载 plugin commands、skills、hooks、MCP 和 LSP；已安装插件使用本地安装缓存，不会因 reload 自动下载。
- `/diff`：打开当前 Git working tree 的原生 diff。终端至少 110 列且没有可见 Mods dock 时使用右侧 sidebar，否则打开 dialog；sidebar 获得键盘所有权后可连续切换文件、进入详情，并在 resize、关闭和重新打开后保留一致的 selection/body identity。
- `/workflows`：查看 Dynamic Workflow runs，不直接启动 workflow。
- `/list-agents`（别名 `/peers`）：列出当前 messaging registry 中其他可发现的本地 Claude session。

PromptInput 按 UTF-8 stream 处理普通文本、中文等宽字符、Kitty CSI-u 和 bracketed paste。同一个 stdin chunk 中的文本与 Enter/Backspace/方向键按顺序生效；未闭合 paste 会在有界空闲恢复后释放 literal payload 并回到普通输入，避免后续按键被永久吞掉。

### Mods / Function Hooks

Mods 是通过 Function Hooks 扩展运行时的可信 Plugin。以下说明针对当前源码构建，不代表已发布的 `@esonhugh/claude-code` launcher 已包含这些能力。

最小目录为 `.claude-plugin/plugin.json`、`hooks/hooks.json` 和 `hooks/register.ts`。Manifest 使用普通 Plugin 的 `name`、`version`、`description`；在 `hooks/hooks.json` 声明入口（路径相对此文件）：

```json
{
  "modules": ["./register.ts"]
}
```

`register.ts` 导出 `register` 函数，可使用 `import type { Register } from 'claude-code'` 配合目标官方类型。模块支持受限的静态相对导入；为了可移植性使用单入口，不假设支持动态导入、任意 npm/native 模块或 Node 全局对象。完整布局和示例见[研究报告](docs/research/claude-mods.md#73-最小示例)。

从源码构建后加载可信插件；非 builtin Mod 首次加载及声明变化时会自动维护 `.claude-plugin/types/` 下的 `claude-code`、tool、MCP 与测试类型声明：

```bash
./built-claude --plugin-dir /absolute/path/to/my-mod
claude plugin validate /absolute/path/to/my-mod
claude plugin test /absolute/path/to/my-mod
```

作者主声明采用官方 2.1.292 原生制品内的完整声明体：565 个主模块导出、51 个 testing 导出，以及完整事件、操作和全局定义。生成文件头仍记录本地引擎版本，不把声明来源版本当作引擎版本。加载会生成三个基础类型根，并加入启用的直接和间接依赖插件在 manifest `types` 中声明的契约；依赖可不含 hooks。没有 `jsconfig.json` 或自定义根 `tsconfig.json` 时，还会创建插件根目录的 `tsconfig.json`，指向 `.claude-plugin/types/tsconfig.json`。已有根配置保持原样。

新增的 `PromptAutocompleteInput/Result/Suggestion`、`ModelTextBlock/ModelCompleteInput`、`AgentSpawnInput.workflow` 和 `HookFailure` 重入定义均来自官方原文。它们的运行时生产、分发和上下文仍须按功能验收；`prompt.autocomplete` 等剩余差异见 [最新声明专项](docs/research/mods-declarations-292-20261007.md)，不能仅凭类型检查通过推断支持。

依赖插件在自己的 `.claude-plugin/plugin.json` 中设置 `"types": "./types/index.d.ts"`，使用方在 `"dependencies": ["shared-state"]` 中声明它；普通来源的裸名称继承 marketplace，inline 等会话来源按名称查找。同名 inline 插件也可满足带 marketplace 的依赖。生成目录内优先链接依赖的真实契约文件；链接失败时只复制不超过 256 KiB 的普通文件，并去掉 BOM。契约必须留在依赖插件的真实目录内。

`.claude-plugin/types/` 由引擎管理，主声明、内部配置和 ignore 文件在加载或 `/reload-plugins` 时刷新，截断或改写后也会恢复。手写声明请放插件自身的 `types/`，自定义编译选项放根 `tsconfig.json`。移除依赖会删除生成的 `index.d.ts`，保留同目录的作者文件。旧生成 `results.d.ts` 仅在内容校验仍匹配时移除，作者改写和符号链接保留。

在本仓库已安装开发依赖的环境中，加载后可严格检查插件项目：

```bash
bun ./node_modules/typescript/bin/tsc -p /absolute/path/to/my-mod/tsconfig.json --skipLibCheck false --incremental false
```

目录外入口也会参与同一作者项目的类型检查。例如在 `hooks/hooks.json` 使用 `{"modules":["../code/register.ts"]}` 时，生成项目只追加 `code/register.ts`，不会包含整个 `code/` 目录。更改入口后执行 `/reload-plugins` 会更新 include；移回 `hooks/` 后移除旧的目录外入口，已有根配置保持原样。此流程已与官方 `2.1.291` 对照，其完整声明体与 `2.1.290` 相同。

旧本地别名 `CAS`、`HookEvent`、`EventPattern`、`Surface` 分别改用官方的 `StateSetOptions`、`EventName`、`Pattern`、`RenderSurface`；`!*` 不属于官方 pattern。testing 挂载使用对象参数，显式给出 `plugin`、`surface`、`component` 和该组件的完整 `props`。

完整声明不代表所有运行时能力已经接入。当前仍缺 `ui.notice/ask`、`audio.play/speak`、`mcp.connect`、`session.compact/send/append`、`command.run`、`telemetry.log/mark` 和 `process.spawn` 的生产方法；新增 `prompt.mention`、server-tool 记录及权限 ceiling 的宿主流程也需要继续对齐。依赖契约的传递类型根仍待实现。官方 [Mods reference](https://code.claude.com/docs/en/plugins/mods/reference) 与实际运行时支持范围应一起核对。

`plugin validate` 校验 manifest、hook module、依赖、类型契约和 state 读写；`plugin test` 运行 `tests/` 中导入 `claude-code/testing` 的隔离作者测试。会话内可用 `/plugin-authoring` 请求当前 session 的作者目录并打开内置指南，也可显式刷新或启停（`my-mod` 为 manifest 名称）：

```text
/reload-plugins
/plugin disable my-mod
/plugin enable my-mod
```

- 生命周期：扫描并固定模块声明 → 准入 → 加载候选模块并执行 register → `engine.create` → `session.start` barrier；首次输入等待初始化完成。`/clear`、resume 更新会话绑定，不重复启动同一 activation。
- 作者模式：`/plugin-authoring` 的 Enable 只授权当前 session 的独立 `dev-mods` 目录；公开 turn 结束后才加载新模块，取消和迟到结果有 generation fencing。同一 session 的 resume 恢复该授权；`/clear` 和 fork 创建的新 session 不继承，需重新确认。
- 重载与卸载：模块依赖变化可触发热重载，显式 reload 使用同一生命周期；技术加载失败保留旧 activation，禁用、移除或拒绝准入撤下旧能力。已进入调用持有原 generation，结束后释放；Worker 故障不自动重放已发生的宿主副作用。
- 当前接线：tool 注册、列举、描述、调用与检查；prompt compose/read/fill/suggest/submit/context/section/attachment；turn middleware 与流式 model step；agent offer/register/list/spawn；MCP 调用；动态 slash commands；session receive/measure/usage/compact/end/authorize；config/options、accepted settings、fs、受限 HTTP、argv process、env、版本化 state/JSON store，以及 terminal/remote UI 与 terminal media。state 写入支持 owner-only、JSON/大小限制和 `ifVersion` CAS；订阅失效只重绘读取对应 key 的 UI instance。命令、Pane 和 callback 跟随 activation/drawing 生命周期，禁用后释放所有权。
- Prompt 组装：每次真实模型请求及 fallback/retry 都按当次模型与工具目录执行 `prompt.compose`；返回 section 的 shared/session scope 控制缓存边界。嵌套作者调用保持当前 hook snapshot，避免重新进入发起调用的 registration。
- AbovePrompt 与通知：terminal `AbovePrompt` 支持宿主绘制、Client 交互和 engine continuation；只有空 composer 且无 dialog/其他键盘所有权时才能取得焦点。`ui.toast` 校验文本与时长并按插件限流，通知通过宿主 UI 展示。
- Pane 输入：空 composer 且没有 dialog/其他输入所有权时，可用 Tab / Shift+Tab 或鼠标进入可见 dock。裸方向键在可见控件间导航，详情区域可滚动；Input/Select 优先处理自身按键，Escape 关闭或退焦。鼠标滚轮按实际命中的 Pane body 交给插件处理，Pane 外保持 transcript 滚动。
- 焦点与布局：有可见内容的 Button/Select/Input 用高亮提示实际焦点；列表分页按最终落点与已提交绘制顺序导航。Diff 按 Pane 与嵌套 Code 容器的可用宽度排版，终端 resize 后重新适配；dock 正文预算随实际可见高度和 composer 高度更新。内容可达性、长文本与窄屏降级仍受插件自身布局及 wrap 声明约束。
- Diff action：插件声明相应 Button `action` 时，默认 Ctrl/Opt+Up/Down 切换文件，Ctrl+x 后按 b 切换 diff base；沿用现有 keybindings 配置，可重绑或解绑。显示用 `hotkey` 文本本身不会注册动作。
- 权限边界：模型工具仍经过原有 schema、managed hooks 与权限审批。**Worker/VM 不是 OS 安全沙箱**，Mod 的 fs/process 宿主能力不自动等同于模型 Read/Bash 权限；只运行经过审查的可信插件。
- 兼容性边界：已提供自动作者声明、`claude plugin validate`、`claude plugin test` 和 `/plugin-authoring`，但不宣称实现全部官方 API、模型流、桌面/远端 surface 或官方 binary 动态 parity。Node `dist/cli.js` 不是当前作者工具验收目标；跨平台、完整 release gate、逐帧 logical/physical 与未执行的官方 rollout 分支仍记为未覆盖。

#### 可复用测试 Mod

仓库自带 [`examples/mods/mods-test-lab`](examples/mods/mods-test-lab)，用于观察真实插件生命周期、命令、prompt/工具/turn 事件和 Pane 交互。构建后可在独立配置、私有 Git fixture 和 tmux 中启动，不读取个人认证或调用真实模型。`check/run` 当前需要 macOS `sandbox-exec`，`run` 另需已安装的 tmux；没有不隔离的 fallback：

```bash
make build
bun scripts/mods-test-lab.mjs check sample
bun scripts/mods-test-lab.mjs run sample
```

`run` 输出 session/socket、调试日志和连接命令；可用 `--binary /absolute/path/to/built-claude` 指定制品。默认缓存为 `~/Library/Caches/mods-test-lab`，各命令支持 `--cache /private/tmp/mods-test-lab`；路径过长无法创建 Unix socket 时改用短缓存目录。进入会话后使用：

```text
/mods-test
/mods-test status
/mods-test context
/mods-test reset
/mods-test close
```

无参数打开包含 Button、Input、Select、长列表和中英文 diff 的面板；`status` 查看计数，`context` 仅为下一条真正的 prompt 附加固定测试标记，`reset` 清理本 Mod 的测试状态。默认只观察事件，不改变工具输入/结果，不记录 prompt、工具参数或回答正文。最近事件最多 20 条；持久计数与当前 activation 状态分别展示。UI-only 入口没有模型服务，prompt/tool 完整链需要另行配置本地 loopback fixture。

官方 2.1.277 的 `agents-md`、`diff` 和 `telemetry` 已固定 provenance 并内嵌为 builtin Mods；`telemetry` 默认关闭，只有设置 `CLAUDE_CODE_ENABLE_ANTHROPIC_TELEMETRY=1` 或在 `/plugin` 中启用时才加载。生产 Mods 不会获得当前会话的 Anthropic credential，`session.authorize` 恒返回空授权；只有隔离的 builtin acceptance fixture 会注入固定 dummy credential 并限定到 loopback transport。`sec-default` 仍只作为可下载的官方原件检查，不因源码可扫描而获得 managed 安全身份。可用以下入口区分静态检查、手工启动和 compiled 行为验收：

```bash
bun scripts/mods-test-lab.mjs fetch-official
bun scripts/mods-test-lab.mjs check diff
bun scripts/mods-test-lab.mjs check agents-md
bun scripts/mods-test-lab.mjs check sec-default
bun scripts/mods-test-lab.mjs check telemetry
bun scripts/mods-test-lab.mjs run diff
bun scripts/mods-test-lab.mjs run-builtin --binary ./built-claude
bun scripts/mods-test-lab.mjs accept-builtin --binary ./built-claude
```

下载固定官方提交到仓库外缓存，输出来源、内容摘要及实际路径；不全局安装、不修改用户 settings、不运行上游安装脚本。`run-builtin` 使用 binary 内嵌 archive 启动隔离会话，但单纯创建 session 不代表 readiness、activation 或 trigger。`accept-builtin` 使用私有 HOME/config、固定 dummy credential、loopback provider 和 sandbox，差分验证 `agents-md`、builtin/native `diff` Pane 交互以及 telemetry 的隔离授权与 `session.end` flush，并检查清理；它不读取个人认证或访问真实 provider。

停止手工会话后可用 `bun scripts/mods-test-lab.mjs clean <run目录>` 回收工具自己的运行目录，活跃或封存的验收记录不会自动删除。`check` 只检查 discovery/preparation/scan；builtin acceptance 通过也只证明当前制品的这三项场景，不等于全部官方 Mods、远端 surface、官方 binary parity 或完整 release gate 通过。

[`examples/mods`](examples/mods) 另保留 Token Weather、Blast Radius 和 Replay Theater 三个官方 2.1.287 作者示例的原样文件，可在官方与本地 CLI 间互换，用于 `plugin validate`、`plugin test` 和声明检查；示例通过不代表全部 Mods API 或终端场景通过。

测试方案、实际结果和未覆盖项见根目录 [`mods-test.md`](mods-test.md)；生命周期与契约依据见 [`docs/research/claude-mods.md`](docs/research/claude-mods.md)。

### Cron 与 durable task

Cron tools 使用本地时区的标准 5-field cron。默认任务只在当前 session 中存在；`durable: true` 时保存到 `.claude/scheduled_tasks.json`。

```json
{
  "prompt": "检查构建状态并报告失败项",
  "cron": "*/15 * * * *",
  "recurring": true,
  "durable": true
}
```

可通过环境变量关闭 cron 能力：

```bash
CLAUDE_CODE_DISABLE_CRON=1 claude
```

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

研究和归档文档描述的是特定时间点，不应直接视为当前行为保证；当前使用方法以 README 和源码为准，历史与验收记录以 CHANGELOG 为准。

## 安全与适用范围

本仓库用于授权的研究、调试和二次开发。恢复或修改后的 binary 不应未经独立安全、遥测、更新和权限审查直接用于生产环境。

请勿提交 `.env`、`~/.codex/auth.json`、API key、OAuth token、cookie、证书或其他私有配置。涉及外部 provider、插件、MCP、Workflow 和自动化任务时，应先确认权限范围及其对本地或共享环境的影响。


print 模式也提供 `$.ui.log`：两种目标都会写入启用的 debug 日志（如 `--debug-file /tmp/mods-debug.log`），保留插件名；日志最多 10000 个 UTF-16 单元并在截断时保护代理对。`--output-format stream-json --verbose` 还把默认 `transcript` 目标输出为 SDK 事件；`debug` 目标与被 hook 改写为 debug 的日志不产生该事件。text 和普通 JSON 输出保留模型结果，日志不进入模型请求或保存的会话历史。公开便利调用仍返回 `void`，不能用 `await $.ui.log(...)` 作为投递完成屏障。

```json
{"type":"system","subtype":"ui_log","plugin":"example","text":"diff 已加载","uuid":"...","session_id":"..."}
```

交互终端的 transcript 日志按官方 `notice` 级别显示为无圆点的暗色提示，默认模式可见；原有普通 `info` 仍按 verbose 设置显示。

SDK 导出 `SDKUILogMessage`，`SDKMessage` union 和运行时 schema 均接受此事件。聚焦回归：`bun test --no-env-file ./src/cli/print.modsLog.test.ts ./src/cli/print.modsLog.types.test.ts`；官方 2.1.292 实测与范围见 [print 日志专项](docs/research/mods-print-log-20261007.md)。

### 持久状态通知

Mod 可以设置一条属于自己的状态。状态显示在输入框下方，带有插件名和 `⚠` 标记；多个插件的状态可以同时存在，toast 超时不会清除它。同插件再次设置会替换原状态，清除时传入 `undefined`：

```ts
$.ui.status('正在读取 diff')
$.ui.status('diff 已就绪')
$.ui.status(undefined)
```

`$.ui.log(text, { to: 'debug' })`、`$.ui.status(text)` 和 `$.ui.toast(text, { timeoutMs: 4000 })` 按官方2.1.289同步返回 `void`。`await` 这些便利调用不会等待 middleware 或 UI 完成；异步拒绝会记录所属插件、操作名和原因，插件仍可继续执行。文本转换与 options getter 的错误同步抛出。已经进入 middleware 的通知可以在作者 hook 正常返回后完成；调用者取消、hook 失败或超时仍会取消相应工作。

作者声明导出 `UiLogSink`、`UiLogOptions`、`ToastOptions`；清除 status 要显式传入 `undefined`。可运行 `bun test ./src/services/mods/uiVoid289.test.ts ./src/services/mods/uiNotifications.types.test.ts ./src/services/mods/uiNotifications.lifetime.test.ts` 检查真实 Worker、严格作者类型及取消/失败恢复。`toast(..., null)` 的跨 realm `instanceof TypeError` 仍与官方不同；完整操作类型映射和全部 UI 行为继续对齐。

## Diff 的语法颜色

构建后在 Git 仓库中运行 `/diff` 查看变更。默认语法高亮保留新增代码的关键词、字符串和数字颜色，同时显示新增/删除行和词级差异背景；删除代码保持普通前景色。设置 `syntaxHighlightingDisabled: true` 或 `CLAUDE_CODE_SYNTAX_HIGHLIGHT=0` 可关闭语法高亮。

可用 `bun test ./src/native-ts/color-diff/index.test.ts` 检查实际安装的高亮依赖、代码文本、行号和颜色。2026-10-06 对照[官方 2.1.291](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)，已验证样例在真实 `/diff`、resize、ask/取消和重开后的代码前景色；上下文与容器背景、退出日志及完整 diff/API/UI 对齐仍有独立待办，不能将此修复理解为完整兼容已完成。

## Diff 面板的背景

运行 `/diff` 即可使用继承面板背景的代码预览，无需额外设置。未修改代码、行号、空白区域和边框继承容器背景；新增/删除行及词级差异仍保留各自的背景颜色。切换背景或恢复默认背景时，旧颜色不应残留。

运行 `bun test ./src/ink/rawBackground.test.ts` 检查背景、样式重置、行号、差异颜色和缓存更新。2026-10-06 已在真实终端对照官方2.1.291样例；面板底部高度及退出诊断仍有差异，完整兼容进度见 mods-test。

## 验证带颜色的 diff 文本

运行 `bun test ./src/components/diff/DiffView.test.tsx` 验证文件选择、来源切换、滚动、Ask 和面板布局。文本断言读取已去除 ANSI 样式码的 Raw ANSI 文本；颜色与真实屏幕单元格仍分别验证，高亮无需关闭。

## Debug 状态栏

运行 `./built-claude --debug --debug-file /tmp/claude-debug.log` 开启调试日志。标准全屏终端在底部右侧显示黄色 `Debug`；普通终端将状态标记放在通知内容下方。状态标记不再进入全屏提示框上方的通知覆盖层。

运行 `bun test ./src/components/PromptInput/PromptInput.debugFooter.test.tsx` 检查两种模式、调试开关及 Goal 状态共存。2026-10-06 的官方 2.1.291 对照已验证该标记的文字、颜色、右侧位置和通知分层；diff 面板仍有底部空白行和退出诊断差异，完整进度见 mods-test。

## Mods 的原生错误信息

使用 `--debug --debug-file /tmp/claude-debug.log` 查看 Mods 错误。跨 Worker 的 capability 失败保留普通 Error 及原生 DOMException 的消息；不会为读取消息而执行错误对象自定义的 getter 或 Proxy trap。

运行 `bun test ./src/services/mods/environmentNativeError.test.ts` 检查原生消息、原错误对象传播和不可执行的访问器。退出时出现 `The operation was aborted.` 说明等待被取消；本次只修复消息丢失，取消的诊断时机与官方兼容性仍需单独验证，不能据此认为生命周期已完全对齐。

## Dock 尾部与全宽输入框

全屏输入框保持终端全宽。dock 延伸到位于输入区起点的实际 prompt margin；前面有 spinner 或其他内容时不覆盖它们。通知使用 dock 左侧的列宽，缩放或 margin 收缩会清理旧边框。

运行 `bun test ./src/components/FullscreenLayout.dockTail.test.tsx` 检查物理单元格与输入框边界。官方2.1.291的小文件 diff 样例已在打开、160→140→160列缩放和关闭重开后取得右侧36行字符/样式一致；AbovePrompt、grip/focus、inline 和完整交互仍按 `mods-test.md` 的边界记录。

## 内置 Mods 缓存

CLI 启动时校验并自动恢复损坏的内置 Mods 缓存。多个 CLI 同时启动时，损坏缓存的替换串行执行；已完成的缓存会直接复用。macOS 默认路径为 `~/Library/Caches/claude-cli-nodejs/builtin-mods`。

运行 `bun test ./src/plugins/builtinMods.test.ts` 检查缓存复用、持锁等待、多进程修复、来源校验及路径边界。真实新制品的并发启动、草稿输入、正常退出和缓存复用证据见 `mods-test.md`。

## 作者测试的错误诊断

使用 `./built-claude plugin test /absolute/path/to/my-mod` 运行作者测试。失败结果保留 VM 原生 Error 的具体消息和调用栈；调用栈没有消息时补充错误名称和消息。测试失败仍返回非零退出码。

运行 `bun test ./src/services/mods/testing/runner.diagnostics.test.ts` 检查消息与原始 frame 的保留。

## 作者测试的插件路径

可从当前目录运行 `./built-claude plugin test ./my-mod`，也可传入绝对路径或符号链接。带空格的路径使用引号，例如 `./built-claude plugin test "./my mod"`。子进程在真实插件根目录中运行，不会重复拼接相对路径。

运行 `bun test ./src/services/mods/testing/runner.childRoot.test.ts` 检查三种路径及真实作者子进程加载。


### 官方 diff 2.1.292 的离线归档与构建

`scripts/package-official-diff.mjs` 从已核验的官方完整模块生成 `assets/builtin-diff-2.1.292.zip`。它在写入前校验完整模块、身份模块、原始注册闭包和 compiled scan；输出使用固定 ZIP 时间，只创建新文件，拒绝覆盖或接受损坏输入。提取出的官方 JavaScript 不会由打包脚本执行。

```bash
bun scripts/package-official-diff.mjs /path/to/verified-modules /tmp/new-official-diff-292.zip
bun test ./scripts/shipped-diff-production.test.mjs ./scripts/build.test.mjs ./scripts/build-isolated.test.mjs
make build CLAUDE_CODE_BUILD_DIR=/tmp/new-claude-build
```

构建会把该归档同时复制到 `dist/assets` 并嵌入 standalone 二进制，保留已有 `builtin-mods-2.1.277.zip`。归档、构建和运行时接管分别验收；完整 diff UI 对齐仍按 `mods-test.md` 的范围记录。官方版本参考 [Anthropic changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)。

## 官方 Mods 接管 diff

生产启动从内嵌的 `builtin-diff-2.1.292.zip` 校验并加载原始 `cc-plugin-diff` Worker。在全屏 Git 工作区输入 `/diff` 打开或关闭面板。原生 diff 的已保存打开偏好只迁移一次；用户明确关闭后清除请求状态。活跃官方插件接管时，原生 diff 面板与后台刷新暂停；禁用、拒绝或卸载后恢复原生命令。

可以在 settings 中禁用官方插件：

```json
{ "enabledPlugins": { "cc-plugin-diff@builtin": false } }
```

旧键 `diff@builtin` 仍作为兼容别名；同时配置时以 `cc-plugin-diff@builtin` 为准。`--debug --debug-file /tmp/claude-diff-debug.log` 会记录 `[ModsBuiltin]` 的版本、来源哈希及加载失败原因，以及 `[Mods:diff]` 接管状态。缺失或损坏归档不会退回旧官方模块，而由原生 diff 保持可用。

```bash
bun test ./src/plugins/bundled/shippedDiffStartup.test.ts ./src/services/mods/diffTakeover.test.ts ./src/services/mods/diffBackground.test.ts ./src/services/diff/controller.test.ts
```

接管测试直接使用仓库内的真实官方归档，无须外部 diff fixture。原始 scan 的 hooks、calls、环境名称和静态命令名称逐项核对；保留 `runCommands` 元数据不代表 `$.command.run` 已完成实现。这里完成的是加载和接管链路，完整官方API及UI兼容范围仍见 `mods-test.md`。官方背景资料见 [Anthropic plugins文档](https://code.claude.com/docs/en/plugins) 和 [官方变更日志](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)。

### Mods 会话启动时间与恢复

官方 diff 使用 `$.session.usage({}).startedAt` 区分本会话的修改。新建会话、`/clear` 和新分支会取得新的启动时间；`--continue`、`--resume SESSION_ID` 和交互式 `/resume` 通过原有恢复路径保留已记录的时间。`--fork-session` 保留源会话的启动时间并取得新会话 ID；`/branch [name]` 使用新分支的启动时间，与官方 2.1.291 的不同入口语义一致。

启动时间随会话 JSONL 元数据持久化，并在压缩后的恢复中保留。还可读取官方 2.1.291 的完整有效 `cost-state` 记录；成本快照的恢复方式见下方“JSONL 成本快照与历史会话”。直接 JSONL 路径的恢复加载器也传递该字段，但交互式 CLI 的文件启动路径受内部模式限制，普通 `--resume FILE.jsonl` 不能视为直接文件恢复。历史会话没有相关记录时，`startedAt` 沿用既有成本时钟，无法据此还原原始启动时间。禁用会话持久化时不会为恢复文件追加该元数据。

使用 `--debug --debug-file /absolute/path/debug.log` 查看 `[ModsSession]` 恢复日志。日志提供元数据归属会话、当前会话和启动时间，便于核对 diff 的时间边界；不会包含会话正文。CLI 会话参数见 [Anthropic CLI reference](https://code.claude.com/docs/en/cli-reference)。

### 退出时的项目成本保存

交互式 CLI 使用 `/exit` 正常退出时，会在界面卸载期间保存当前会话的成本、运行时长、启动时间、模型用量及 FPS。这些项目汇总记录可供查看最近会话；会话恢复使用下方说明的 JSONL 快照。普通组件卸载不触发这次保存，直接进程退出仍保留原有保存回调。

运行 `bun test ./src/costHook.test.ts` 检查三个真实子进程生命周期和磁盘写入。项目配置只保留最近保存会话的成本；本修复不代表任意历史会话的完整 JSONL 成本账本恢复已经对齐，验收范围见 `mods-test.md`。

### JSONL 成本快照与历史会话

会话日志中的 `cost-state` 保存累计成本、API 和工具时长、修改行数、累计运行时长、启动时间、各模型用量及未知价格标志。恢复会话使用该会话最后一条完整有效的快照；最近项目配置中的 `lastCost` 不再作为历史账本的恢复来源。旧日志没有有效快照时，启动恢复采用新账本，无法还原原始成本。

`--continue`、`--resume SESSION_ID` 和交互式 `/resume` 恢复原有账本；`--fork-session` 使用新会话 ID 并继承源快照；`/branch` 和 `/clear` 开始新账本。非交互模式通过相同快照恢复，例如 `./built-claude --print --resume SESSION_ID "继续任务"`。启动时间的文件加载器边界仍按上一节说明。

快照在现有会话的切换、元数据重写和退出时写入。禁用持久化时不写入，未创建会话文件时也不会只为成本创建文件。用 `--debug --debug-file /absolute/path/debug.log` 的 `[ModsSession]` / `restore-cost-state` 记录核对源和当前 ID、匹配结果及成本时间；日志不含会话正文。

运行 `bun test ./src/utils/sessionCostState.test.ts ./src/utils/sessionStartedAt.restart.test.ts ./src/costHook.test.ts` 检查完整记录、跨进程恢复和退出保存。真实终端的 fork、分支后恢复、非交互恢复及相邻官方 diff 行为见 `mods-test.md`。


### 思考 token 用量

API 返回 `output_tokens_details.thinking_tokens` 时，CLI 在用量归一化、跨消息汇总和模型 `thinkingTokens` 中保留该分项，并通过既有项目汇总及 JSONL `cost-state` 保存。恢复会话后，新请求继续在历史分项上累计；旧日志没有该分项时按零开始累计。SDK `usage.output_tokens_details` 也提供该字段，模型汇总使用 `thinkingTokens`。

思考 token 已包含在 API 的 `output_tokens` 中，费用仍根据原输出总量计算，不额外重复扣费。只有 API 提供的实际 token 计数会被累计，不根据正文长度估算。运行 `bun test ./src/services/api/thinkingUsage.test.ts ./src/utils/sessionCostState.test.ts` 验证这条链路；具体终端及官方对照范围见 `mods-test.md`。

Anthropic 对该字段、最终流式事件与费用口径的说明见 [Steering thinking: pricing](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost#pricing)。


### SDK 模型用量元数据

SDK result 的 `modelUsage` 按原始模型名索引；新请求会填充 `canonicalModel`（当前价格目录使用的模型名）、`provider`（现有 API 提供方）和 `costBasis`。当前目录计价为 `list`，未知模型使用默认价格估算时为 `unknown`，因此不能把它看作已核实的真实账单。三个字段都是可选字段，旧会话和旧 SDK 数据仍可读取；token 数量、contextWindow 和 maxOutputTokens 按官方 schema 要求整数。

JSONL cost-state 和项目汇总保持官方 wire 字段，运行时元数据不会写入历史快照。恢复会话时重建当前模型限制，新的请求再填充上述元数据。运行 `bun test ./src/services/api/modelUsageMetadata.test.ts` 检查传递与恢复行为。schema 接受官方的 `managed` 标签；组织定价及新增提供方的完整计价和路由仍需后续对齐，不能据此声称这些流程已通过。


### 子任务与根会话用量

普通子任务拥有各自的 agent ID 和执行上下文，成本与模型用量汇入所属根会话账本。`$.session.id()` 与 `(await $.session.usage({})).cost.usd` 读取当前根会话身份和累计成本，不能把根会话总额当作某一个 agent 的独立费用。保存及恢复根会话时应保留已累计的子任务用量。

运行 `bun test ./src/services/api/rootLedger.test.ts` 检查两个并发子任务的上下文隔离、共享累计及根会话快照。本用法针对普通子任务；其他独立根会话的账本归属与异常恢复须按各自入口验证。真实 CLI 的 Agent 调用、保存和恢复对照范围见 `mods-test.md`。

### Mod 工具权限查询的原因

公开 `$.tool.check({tool, input})` 返回权限决定；`reason` 只在底层决定提供实际原因时出现。bypass 模式的允许结果是 `{decision:"allow"}`；匹配规则通过 `rule` 提供，不重复生成原因文字。空原因省略，ask／deny 保留实际审批或拒绝原因，权限查询仍不会执行工具或弹出审批。

运行 `bun test ./src/services/mods/toolCheckReason.test.ts` 验证公开 host 的决定、规则、原因和安全检查。完整 hook 来源、递归规则及最新事件字段仍按 `mods-test.md` 分批验收。

### Mod 子任务的完成通知

`$.agent.spawn({prompt, ...})` 在任务启动时返回身份回执。宿主从根任务表认领该本地子任务的完成通知，结果通过 `turn.complete` 提供；完成后不会再把同一结果入队为主会话通知并自动发起额外查询。作者可以按返回的 `agentId` 筛选完成事件，并使用 `e.answer` 展示或处理结果。

此认领只用于公开 Mod spawn 对应的本地任务。普通 Agent 工具的后台完成通知继续送达；teammate 和 remote task 使用各自的生命周期。子任务上下文优先使用 `setAppStateForTasks` 写入根任务表，不改变当前权限视图。

使用 `--debug --debug-file /absolute/path/debug.log` 查看 `[ModsAgent] claimed completion notification`，日志包含 task ID、agent ID 和插件名，不包含任务正文。运行 `bun test ./src/services/mods/toolHost.spawnNotifications.test.ts ./src/tasks/LocalAgentTask/LocalAgentTask.progress.test.ts` 检查通知归属、三种终态和普通通知控制组。完整错误／取消／嵌套及 Workflow 矩阵继续按 `mods-test.md` 验收。

### Mod 主动工具调用的入口

作者使用 `$.tool.call({tool, ...args})` 时，Agent、AskUserQuestion、Workflow 会被 host check 拒绝。使用 `$.agent.spawn({prompt, ...})` 启动子任务，用 `$.ui.ask(...)` 提问；本地 `WorkflowTool` 同样受此限制。Agent 的旧名称 Task 在解析到 Agent 时也会被拒绝。错误包含插件名、工具名称和专用入口，便于定位调用位置。

这个限制作用于作者主动调用。模型正常执行工具产生的 `tool.call` 事件仍可由 Mods 观察及改写，`$.tool.check({tool, input})` 仍可查询权限，不启动工具。普通工具继续经现有权限、hooks 和执行链运行。运行 `bun test ./src/services/mods/toolHost.authorGate.test.ts` 验证这组边界；真实 CLI 对照及未完成项见 `mods-test.md`。


### REPL 提交测试的封闭环境

运行 `env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN bun test --no-env-file ./src/screens/REPL.submit.test.ts`。测试自行创建真实路径的临时 HOME／配置／XDG 目录，使用占位认证，并在结束后恢复环境，不需要调用者的 API key。恢复夹具覆盖所选会话记录传入成本恢复器，以及同 ID 恢复时 diff 和原始上下文的重置。

完整逐文件复验表见 [2026-10-07 验证记录](docs/research/mods-validation-20261007.md)。逐文件通过与同进程全量 suite、官方二进制交互门禁分别验收。


### Mod spawn 的并发上限

`$.agent.spawn` 默认允许同一插件同时保有 20 个启动中的或运行中的子任务。通过 `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=2 ./built-claude --dangerously-skip-permissions` 可改为两个；变量接受去除首尾空白后的带可选正负号十进制正整数，缺失、非整数、非正数或非有限数回退为 20。

收到启动回执不会释放名额；宿主依据根任务表中的 `agentId` 观察任务，`completed/failed/killed` 或已观察记录被移除后释放。失败、拒绝、前台完成、remote 或 teammate 等没有返回 `async_launched` 的执行不会占用后台名额。任务已启动后，调用者退出及插件重载不会重置其计数。达到上限时抛出 `<plugin>: $.agent.spawn refused: <limit> spawns are running at once`，作者可捕获错误并等待已有任务结束后再尝试。

`--debug --debug-file /absolute/path/debug.log` 输出 `[ModsAgent] spawn reserved/settled/released`，包含插件、agent/task ID、状态及计数，不打印任务正文。运行 `bun test --no-env-file ./src/services/mods/spawnConcurrency.test.ts ./src/services/mods/toolHost.spawnLifetime.test.ts` 验证插件计数与实际 Agent 返回状态。普通 Agent 入口还有独立的全局并发检查；两类拒绝的处理方法见下节，完整原生入口矩阵继续验收。

### Agent 并发限制

普通本地 Agent 与 Mod 插件各自检查同时运行数，默认上限为 20。启动 CLI 前可配置：

```sh
export CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=2
```

变量支持 trim 后带可选符号的正十进制整数，无效值回退到 20。启动回执返回后，后台任务继续占用名额；前台转后台保留同一名额，恢复普通 Agent 时重新预留。同步 `context: fork` 技能本身不占普通 Agent 名额，技能内实际调用的 Agent 仍受同一全局限制。

作者应处理全局额度不足的返回值：

```js
const result = await $.agent.spawn({ prompt: 'Review the change', subagentType: 'general-purpose' })
if ('deny' in result) {
  await $.ui.log(result.deny)
} else {
  await $.ui.log(`Started ${result.agentId}`)
}
```

插件自身额度耗尽仍抛出包含插件名的异常。全局计数、拒绝和释放可在 --debug 的 AgentConcurrency 日志中核对。本轮验证及原生入口限制见 [全局并发记录](docs/research/mods-agent-concurrency-20261007.md)。

同步 fork 技能的进度、查询与启动/完成 debug 使用同一个 agent ID。运行 `bun test --no-env-file ./src/utils/processUserInput/processSlashCommand.concurrency.test.ts` 可验证 slash 与 SkillTool 的计数和身份；实际 CLI 对照见 [fork 技能专项](docs/research/mods-fork-capacity-20261007.md)。交互入口默认后台启动 fork 技能，初始技能工作者不占普通 Agent 名额；技能内实际 Agent 和恢复执行仍计数。`background: false`、非交互模式或禁用后台任务时使用同步执行。技能配置参考 [Anthropic 官方 skills 文档](https://code.claude.com/docs/en/skills#run-skills-in-a-subagent)。

插件可在 `skills/review/SKILL.md`（或旧 `commands/review.md`）声明 `context: fork` 和 `agent`。加载器保留这两个字段；slash 与模型的 SkillTool 调用进入已有的独立执行上下文。自定义 agent 使用完整名称，例如 `my-plugin:reviewer`，定义放在插件的 `agents/reviewer.md`。

```yaml
---
description: Review the supplied changes
context: fork
agent: my-plugin:reviewer
background: false
---
Review $ARGUMENTS and report concrete findings.
```

使用 `--plugin-dir /absolute/path/my-plugin` 加载，再运行 `/my-plugin:review <任务>`。`background: false` 使本例同步执行；省略该字段时交互入口默认后台运行。验收记录见 [插件 fork 入口专项](docs/research/mods-plugin-fork-20261007.md)，配置含义见 [Anthropic skills 文档](https://code.claude.com/docs/en/skills#run-skills-in-a-subagent)。

### 后台 Agent 等待子任务与续跑

普通后台 Agent 自己启动后台子任务时，完成当前一轮后会释放执行名额，并保持可接收通知的身份。Mod 使用 `await $.agent.list()` 可看到父任务从 `running` 变为 `waiting`；子任务完成通知会自动触发父任务续跑，保留原 agent ID 与实际模型。所有子任务结束且父任务完成续跑后，主会话收到最终通知。

`parentId` 仍表示上下文继承关系；运行时 `ownerAgentId` 表示通知归属。`TaskStop` 和 SDK `stop_task` 可停止等待中的父任务。`--debug --debug-file /absolute/path/debug.log` 的 `[AgentLifecycle] owner_parked/owner_wake` 日志可核对父任务 ID、待处理数量与续跑；失败会打印关联 ID 和原因。

运行 `bun test --no-env-file ./src/tools/AgentTool/backgroundOwner.test.ts ./src/tasks/LocalAgentTask/LocalAgentTask.progress.test.ts` 验证生命周期。真实终端证据、相邻入口与剩余范围见 [后台父子任务专项](docs/research/mods-background-owner-20261007.md)。fork 技能后台启动和权限记录恢复见下一节；所有前台/工作流/故障组合仍继续验收；子代理的通用配置见 [Anthropic subagents 文档](https://code.claude.com/docs/en/sub-agents)。


### fork 技能后台启动与权限恢复

交互模式调用 `context: fork` 技能时，slash 和 SkillTool 默认返回后台启动回执，父会话可以继续输入。`background: false` 使用同步执行；`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` 或非交互会话也保持同步。存在同名未结束任务、达到嵌套深度限制或无法保存权限记录时，回退到同步路径。

```yaml
---
name: review
description: Review the requested code
context: fork
agent: general-purpose
allowed-tools: Read, Grep, Glob
disallowed-tools: Bash, Write, Edit
---
Review $ARGUMENTS and report findings.
```

后台任务使用独立名称和 agent ID。任务的子任务未结束时，公开 `$.agent.list()` 显示 `waiting`，子任务通知可触发原 ID 续跑。名称可用于 `SendMessage`；fork 技能不能在自己的上下文中再次调用同一技能。

启动前先保存 `.forked-skill.marker.json` 和 `.forked-skill.json` 到该 agent 的 transcript 目录，记录技能身份、effort 和启动时的 command deny 规则。恢复时重新解析当前技能，替换 command allow 规则，合并保存的 deny、当前 deny 和技能 `disallowed-tools`。权限记录缺失、损坏、超限、身份不匹配或技能不再支持 fork 时拒绝恢复。

运行 `bun test --no-env-file ./src/utils/forkedSkill.test.ts ./src/tools/SkillTool/UI.test.tsx` 检查启动、权限和 UI 状态。[专项验收与剩余差异](docs/research/mods-fork-background-20261007.md) 区分自动化、真实终端和未覆盖结果；此批不代表所有 Mods API、Workflow 与 diff/UI 已完成对齐。配置参考 [Anthropic skills 文档](https://code.claude.com/docs/en/skills#run-skills-in-a-subagent)。

### 普通 Agent 的前后台执行

普通 Agent 调用省略 `run_in_background` 时，默认返回后台启动回执。关闭 fork 模式后，需要等待结果再继续时，显式传 `run_in_background: false`；若 agent 定义声明 `background: true`，仍会后台运行。进程内 teammate 的默认子任务保持同步；`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` 禁用后台执行。

对于普通 Agent，Mods 的 `agent.spawn` 事件中，`background` 表示已经解析的执行模式。回调可以将其改为 `false` 以请求前台执行；实际模式仍受后台禁用和已有强制路由规则约束。初始注册、执行和元数据使用相同计算，后台通知、并发计数与 `SendMessage` 恢复沿用现有生命周期。

运行 `bun test --no-env-file ./src/tools/AgentTool/backgroundRouting.test.ts` 检查默认路由及边界。真实官方/本地终端证据与剩余范围见 [专项验收](docs/research/mods-agent-background-default-20261007.md)，背景概念见 [Anthropic subagents 文档](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background)。显式 fork 模式及默认开启方式见下一节；命令与 UI 仍分别验收。

### 显式 fork 模式

交互会话默认启用 fork 模式。模型调用 Agent 时，省略 `subagent_type` 使用独立上下文的 `general-purpose`；显式 `subagent_type: "fork"` 才继承当前对话、系统提示、工具定义及父模型。fork 忽略 `model` 参数和 `CLAUDE_CODE_SUBAGENT_MODEL`，以保留父模型与缓存前缀。

```json
{"description":"核对映射","prompt":"核对 provider effort 映射并报告证据。","subagent_type":"fork","name":"effort-review"}
```

fork 模式强制普通 Agent 后台执行，schema 不暴露 `run_in_background`。需要普通 Agent 支持显式前台执行时，可在启动前设置：

```bash
CLAUDE_CODE_FORK_SUBAGENT=0 claude
```

`CLAUDE_CODE_FORK_SUBAGENT=1` 可为非交互会话启用该模式。模式开启的 headless 子 Agent 默认同步启动自己的子任务；Mods 的 `$.agent.spawn({subagentType: "fork", prompt: "..."})` 属于脚本入口，可在非交互会话显式 fork，但仍尊重显式关闭、协调模式、允许类型与 deny。脚本标记不会继承到子会话的模型工具调用。

自定义同名 agent 遮蔽合成 fork；`Agent(fork)` deny 阻止合成 fork，普通 Agent 的后台规则继续有效。合成 fork 拒绝再次 fork 和 remote 隔离。调试日志的 `[ForkMode]` 记录开启来源与会话 ID，Agent 启动日志记录类型、模型、后台模式和 ID。

运行 `bun test --no-env-file ./src/tools/AgentTool/forkMode.test.ts ./src/tools/AgentTool/backgroundRouting.test.ts` 检查路由。对照依据见 [Anthropic fork 模式说明](https://code.claude.com/docs/en/sub-agents#turn-fork-mode-on-or-off)，实际证据与剩余范围见 [专项验收](docs/research/mods-fork-mode-20261007.md)。本批完成模型 Agent 和 Mods spawn 的门禁迁移；内置 `/fork` 命令与 fork 指令折叠 UI 仍待独立实现和验收。

## 手动启动继承对话的子任务（官方 2.1.292）

在交互会话中输入 `/subtask <task>`，将当前对话交给后台 fork，同时继续使用主会话，例如：

```text
/subtask review the parser changes and report the missing test cases
```

子任务继承主对话的模型、工具定义、系统提示和历史。`CLAUDE_CODE_FORK_SUBAGENT=0` 控制模型的自动 fork 选择，不禁用用户手动的 `/subtask`。命令回执包含名称和 agent ID 后四位；`[ConversationFork]` 调试日志打印完整 ID、模型、深度和 owner。具名 fork 的结果返回后可以通过 `SendMessage` 恢复同一 ID，继续继承主对话模型。Mods 的 `$.agent.list()` 对已结束且可恢复的具名 fork 返回 `idle`；这与内部任务的 `completed` 状态不同。

fork 首条消息按官方格式显示为 `⑂ <directive>`，隐藏固定 worker 说明。只有完整匹配当前模板的消息才折叠，包含同名标签的普通文本、旧模板及被改写的说明仍正常显示。

[Anthropic 官方文档](https://code.claude.com/docs/en/sub-agents#fork-the-current-conversation) 说明：新版本默认使用 `/subtask` 启动子任务，`/fork` 则复制整个后台会话；关闭官方 agent view 时命令映射还会变化。本批实现 `/subtask` 与指令显示；`/fork` 的独立后台会话、agent view 映射和完整交互仍待后续迁移。不要把本批理解为这几项已经兼容。验证与源码依据见 [子任务专项](docs/research/mods-subtask-20261007.md)。

## 禁用后台任务时恢复子 Agent

以 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 claude` 启动交互会话后，向已结束的子 Agent 调用 `SendMessage` 会等待恢复执行完成，再把最终报告返回给调用者。恢复沿用原 Agent ID 和已保存的历史；fork 继承主模型，普通 Agent 保留自己的模型。恢复期间可中断父查询，子执行随之停止。

Mods 可通过 `$.tool.call({tool: 'SendMessage', to: agentId, message: 'Continue the review'})` 触发同一工具路径。结果的 `inlineHandback` 包含 `displayName`、`content`、`harnessNoteCount`、`harnessTailCount` 和 `harnessSectionHash`；这些显示与分段字段由工具格式化器处理。模型收到带来源说明的缩进报告，终端显示 `Resumed agent <name>. Result:`；原始 ID 显示前七位。该次报告不会额外产生后台完成通知。未禁用后台任务时，恢复仍返回后台回执并由完成通知交付结果。

报告默认使用官方框架；`CLAUDE_CODE_HANDBACK_PROVENANCE=0` 可使用原始 JSON 报告格式。`/subtask` 是用户手动启动的后台任务入口，这个开关不改变它的初次启动。

调试日志 `[AgentResume]` 记录 Agent ID、模型、交付方式和同步交付终态。恢复用法参考 [Anthropic 官方文档](https://code.claude.com/docs/en/sub-agents#resume-subagents)，实测与剩余差异见 [同步恢复专项](docs/research/mods-inline-resume-20261007.md)。报告内容扫描、web-fetch 特殊恢复入口及完整任务管理 UI 仍在整体对齐范围内。

## Mods 工具执行的只读标记

`tool.call` hook 的 `await next(e)` 回执可能含 `isReadOnly: true`：工具已对本次实际执行参数判定只读。缺省表示不能据此认定只读，参数改写也参与判定。标记只描述当前调用；Agent 的子工具各自触发事件。

```js
on('tool.call', async ($, e, next) => {
  const output = await next(e)
  if (output.deny === undefined && output.isReadOnly !== true) {
    // 本次执行可能改动文件，可刷新插件维护的 diff。
    await $.ui.invalidate()
  }
  return output
})
```

同一插件内的 hook 可看到本插件其他 hook 的未处理回执；离开插件后才核对标记来源。保留 `next(e)` 的原回执，或保留同一个 `ref` 和未改写的 `result`，才能保留标记；自行设置它不能证明只读。按官方 2.1.292 的运行实现，插件主动调用 `$.tool.call()` 的最终回执会移除该标记，观察该执行的其他 hook 仍可读取它。在启用官方 diff mod 的终端会话中，用 `/diff` 切换视图；文件写入后可查看实际变更。事件和方法索引见 [Anthropic Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)，精确类型以安装版本写出的声明为准。证据与未覆盖项见 [只读标记专项](docs/research/mods-tool-readonly-20261007.md)。

## 停止与恢复子 Agent

按两次 `ctrl+x ctrl+k` 可确认停止后台 Agent；在 Agent 视图按 Escape、关闭运行中的任务或通过 SDK `stop_task` 停止，也属于用户取消。此时原 Agent 的 `stoppedByUser` 标记保存到元数据，`SendMessage` 会拒绝自动恢复，重启会话后仍有效。只有用户明确要求重新开始时，才应创建新的 Agent 任务。

模型调用 `TaskStop` 或系统中断不会设置用户取消标记；这些任务与已完成、失败的任务仍可通过 `SendMessage` 正常恢复。标记表示停止来源，不能只凭内部 `killed` 状态判断。`[AgentCancellation]` 日志记录停止/拒绝的完整 ID 及 live/metadata 来源，不打印消息内容。

回执沿官方分支保留措辞：内存中已取消的任务返回 `was stopped by the user and was not resumed`；从磁盘恢复被拒绝时返回 `was stopped by the user and won't be resumed`。两者都返回 `success: false`，不会启动新的模型请求。源码和测试证据见 [用户取消专项](docs/research/mods-user-cancellation-20261007.md)。该项不代表完整任务 UI、观察者、teammate、Workflow 或跨会话目标解析已完成兼容。

## SendMessage 的会话身份绑定

向本会话的具名子 Agent 发送普通文本时，成功回执包含 `pin: {id, name, ref}`。同一名称换绑至新的 Agent 后，继续使用裸名会返回 `success: false`，消息不投递；按回执中的 `name [ref]` 确认新目标，或用原始启动回执里的 Agent ID 继续旧任务。例如：

```js
await $.tool.call({tool: 'SendMessage', to: 'reviewer', message: 'Continue the review'})
// 名称换绑后，使用拒绝回执给出的准确 ref：
await $.tool.call({tool: 'SendMessage', to: 'reviewer [a1b2c3]', message: 'Review the new change'})
```

同步 Agent 完成后也保留名称寻址。注册名称支持官方的 Unicode 规范化规则和至少三字符的唯一前缀；前缀歧义需要完整名称和准确 ref。历史恢复只接受匹配的 SendMessage 工具调用及成功、非错误结果的 `toolUseResult` 元数据。`/clear` 清空身份绑定，恢复/分支/回退按保留的历史重建；运行中的 Agent 名称仍可使用。

公开工具回执保留 pin；模型结果省略终端专用的 `display`，默认同步恢复报告框架仍采用官方的精简 JSON 头。`[SendMessage]` 日志记录绑定名称、Agent ID 和 ref，不打印消息内容。范围与证据见 [SendMessage 身份绑定专项](docs/research/mods-sendmessage-pin-20261007.md)，相关接口见 [Anthropic Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)。跨会话/云目标的统一解析与完整 Mods API、UI、diff 验收继续进行。


### 官方 diff 2.1.292 的当前固定来源

当前生产归档为 `assets/builtin-diff-2.1.292.zip`，包含官方完整模块、身份模块、编译扫描元数据及原始注册闭包。加载和离线打包均核对固定字节范围与 SHA-256；过期或损坏归档会记录 `[ModsBuiltin]` 错误并保留原生 diff。旧归档仅用于历史来源核对。

```bash
bun scripts/package-official-diff.mjs /path/to/verified-2.1.292-modules /tmp/new-official-diff-292.zip
bun test ./scripts/shipped-diff-production.test.mjs ./src/plugins/bundled/shippedDiffStartup.test.ts ./src/services/mods/diffTakeover.test.ts
make build CLAUDE_CODE_BUILD_DIR=/tmp/new-claude-build
```

在全屏 Git 工作区输入 `/diff` 打开或关闭官方模块的面板；settings 的 `cc-plugin-diff@builtin` 开关及 `diff@builtin` 别名沿用原契约。使用 `--debug --debug-file /tmp/claude-diff-debug.log` 可核对加载版本、来源哈希与接管状态。

官方最新来源核对见 [Anthropic package metadata](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)，使用背景见 [Anthropic plugins 文档](https://code.claude.com/docs/en/plugins)。此升级只更新 diff 的固定官方来源；2.1.292 公共声明的新接口和完整 API/UI 对齐仍须独立验收，详见 `mods-test.md` 和 `docs/research/mods-shipped-diff-292-20261007.md`。


### Mods 面板的键盘处理顺序

持有焦点的 Mods 面板先处理 Enter、方向键和 Esc；面板未处理的按键仍交给输入框。在面板持有键盘焦点时，可用 Esc 返回输入框，再输入 `/diff` 关闭或重开面板。快捷键和 chord 保留原有拦截流程，同一按键不会重复派发 DOM 事件。

运行 `bun test ./src/components/ModsPane.keyboardCapture.test.tsx` 验证这一处理顺序。此修复只覆盖键盘派发，其他面板布局与完整官方 UI 对齐的验收边界见 `mods-test.md`。


### Mods 面板的尺寸与关闭

全屏模式下，默认 dock 宽度为终端列数的 45%，最多 90 列，并为对话预留 70 列；面板 body 再扣除 1 列 grip。`$.ui.open({id, columns})` 的 columns 是 body 宽度请求，实际 outer 宽度会夹在最少 24 列与剩余至少 24 列对话区之间。小于 110 列的全屏终端使用 inline 布局。官方 diff 模块在该宽度下保留面板，并显示扩大终端到至少 110 列的提示。

dock 的 grip 列在面板持有焦点或鼠标直接悬停时高亮；仅悬停在 body 不会点亮 grip。

inline 面板绘制圆角边框和关闭标记，内容按自然高度显示。默认总高度预算为终端行数的三分之一；显式 rows 请求还需预留边框和多面板 tab 行。面板 body 可以是零行。点击右上角关闭标记会产生 `ui.close` 的 person 来源；Esc 是否关闭由 closeOnEscape 决定。

`--debug --debug-file /tmp/claude-pane-debug.log` 中的 `[ModsUI]` metrics 可核对 bodyRows、contentRows、placement、drawing 和 scrollOffset。运行 `bun test ./src/components/ModsPane.hostGeometry.test.tsx` 检查尺寸；实际官方对照与完整验收边界见 `mods-test.md`。


### Mods 面板自动聚焦

面板用 `$.ui.open({ id, focus: true })` 取得键盘后，可在 Button、Input 或 Select 上设置 `autoFocus: true`。多个控件声明时，按注册顺序选择第一个，并通过 `ui.focus` 协商；事件的 `origin` 是控件所属插件，`next.origin` 是 `engine/core`。hook 返回拒绝或不调用 `next` 时不会授予该控件焦点；改写 `element` 则采用已确认的实际落点。

```ts
const { Box, Button } = $.ui.resolve(e)
return Box({ children: [Button({
  key: 'save', label: 'Save', autoFocus: true,
  onPress: press => $.ui.log(`${press.plugin}:${press.element}:${press.surface}`),
})] })
```

`onPress` 收到 `ui.press` 参数，含插件、控件键、surface、component 和 requestId。焦点参数携带插件与控件键。官方终端在不同插件复用同一键时，焦点事件仍指向声明 autoFocus 的插件，但 Enter 会触发第一个同名绘制槽位；本地保留此行为。插件应使用不同控件键来避免这种歧义。官方 2.1.292 的 `display: 'none'` 保留控件注册，隐藏控件也可能获焦点及接收 Enter；不希望它参与焦点时，应从绘制树中省略它。

运行 `bun test --no-env-file ./src/components/ModsPane.automaticFocus.test.tsx ./src/services/mods/uiRealm.test.ts` 检查真实 Worker 和输入。官方源码及终端对照、候选与工作区结果见 [自动聚焦验收](docs/research/mods-automatic-focus-20261007.md)。本批只验证 Pane；Band、Client 和完整 UI 对齐继续单独验收。

当前对照的 35 个完整面板矩形中有 31 个字符、样式及位置相同；Input/Select 的四个状态帧仍有差异，展开列表、光标及重绘状态需继续对齐。焦点与回调行为通过不代表所有控件 UI 已匹配。


### Mods Input 的光标与提交

Input 取得焦点后显示加粗 label、实际字符簇光标与 `⏎ submit` 提示；`submitLabel` 可改提示文字。光标、占位及终端焦点沿用主输入组件的绘制规则。

```ts
const { Input } = $.ui.resolve(e)
return Input({
  key: 'reply', label: 'Reply', placeholder: 'Type a reply', autoFocus: true,
  onInput: (value, input) => $.ui.log(`change: ${input.element} (${value.length})`),
  onSubmit: async (value, input) => {
    $.ui.log(`submit: ${input.plugin}:${input.element}:${input.surface}`)
    // 在这里处理 value；不要将实际输入内容写入 debug 日志。
  },
})
```

成功提交后，host 在没有后续编辑时清空该输入，清空不会再发 `onInput`。回执等待期间重复 Enter 不会重复提交；拒绝或未送达保留文本。显式 value 的新值覆盖缓存，值相同的重绘保留当前编辑。

运行 `bun test --no-env-file ./src/components/ModsPane.inputPresentation.test.tsx` 检查这些状态。官方源码、三侧终端对照与精确验收边界见 [Input 专项](docs/research/mods-input-presentation-20261007.md)；Select 展开列表和完整 UI 仍须继续验收。

本轮最终制品的两个 Input 状态帧与官方 2.1.292 完全相同；整体 35 帧中 **33 帧相同**，其余两个 Select 帧共 50 个差异单元格。完整画面对照仍未通过，详细结果以上述 Input 专项为准。


### Mods Select 的展开与选择

```ts
const { Select } = $.ui.resolve(e)
return Select({
  key: 'base', label: 'Base', value: 'main', autoFocus: true,
  options: [{ value: 'main', label: 'Main' }, { value: 'dev', label: 'Develop' }],
  onSelect: (value, input) => $.ui.log(`picked: ${value} (${input.element})`),
})
```

获得焦点会展开列表；方向键改变高亮，Enter 确认并收起。收起时 Enter 或方向键只展开，不发 onSelect；输入字符循环寻找标签前缀，Space 不会提交。最多展示八项，超出的数量另行显示。空闲时 Ctrl+C 先收起，再释放控件焦点；任务运行时 Ctrl+C 交给取消流程。

回执等待期间显示乐观选择；hook 改写结果的 value 会更新已选值，较晚结果不会覆盖后续选择。相同 value 的重绘保留当前选择，新 value 才覆盖。省略或不匹配选项的 value 显示 none；options 非空且 value 唯一。

运行 `bun test --no-env-file ./src/components/ModsPane.selectPresentation.test.tsx`。官方源码、三侧新制品对照、失败记录和验收范围见 [Select 专项](docs/research/mods-select-state-20261007.md)。

最终官方/候选/工作区对照各 **51/51 个完整面板矩形相同，0 个差异单元格**，含原 35 帧和新增 16 帧 Select 状态。完整作者类型、Band/Client、任务取消、多主题与全终端帧仍需单独验收，不能据此宣称全部 Mods 已对齐。


### Mods 剪贴板操作

使用 `await $.ui.copy({text: '需要复制的文本'})` 复制原文；省略 `surface` 时选择首个附着界面，也可指定 `terminal`、`desktop`、`mobile` 或 `vscode`。`ui.copy` hook 通过 `next({...e,text})` 改写复制内容，或返回 `{value:{isCopied:false,reason:'refused'}}`；`{deny:'原因'}` 会拒绝调用。

成功回执为 `{isCopied:true}`；失败原因包括 `no-surface`、`no-clipboard` 和 `refused`。终端复用既有剪贴板路径；OSC 52 输出上限为 1 MiB，远程目标文本上限为一百万个 UTF-16 code units。远程界面还需要自己的 responder。本轮原生流程和精确范围见 [剪贴板专项](docs/research/mods-ui-copy-20261007.md)。
