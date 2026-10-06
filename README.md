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

作者主声明采用官方 2.1.290 原生制品内的完整声明体（与 2.1.291 相同），保留全部公开类型、操作映射、testing 和全局定义。加载会生成三个基础类型根，并加入启用的直接和间接依赖插件在 manifest `types` 中声明的契约；依赖可不含 hooks。没有 `jsconfig.json` 或自定义根 `tsconfig.json` 时，还会创建插件根目录的 `tsconfig.json`，指向 `.claude-plugin/types/tsconfig.json`。已有根配置保持原样。

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
