# Unofficial Claude Code

基于 Claude Code `2.1.88` 分发产物恢复的非官方 TypeScript/TSX 源码工作区，并持续维护本地 CLI、Agent、Workflow、OpenAI/Codex 兼容和调试能力。

> 本项目不是 Anthropic 官方产品、官方源码分发或官方 Claude Code release，也未获得 Anthropic 背书。公开包只分发 launcher 与对应平台二进制，不包含本仓库源码。

## 作者与维护者

- 项目维护者：**Esonhugh**
- 原始产品与上游实现：**Anthropic Claude Code**
- 公开包：`@esonhugh/claude-code`
- 恢复基线：Claude Code `2.1.88`
- 当前本地发布线：`2.1.215`

本仓库包含从公开 bundle/source map 恢复的上游代码和本地维护改动。上游归属与本地维护者身份应分别理解；完整本地变更以 [`CHANGELOG.md`](CHANGELOG.md) 为准。

## 项目概况

本项目主要用于：

1. 保存从 Claude Code 分发产物恢复的可读 TypeScript/TSX 源码树。
2. 提供可构建、可调试、可进行受控二次开发的本地 Claude Code CLI。
3. 在 `2.1.88` 基线上维护 Agent、Workflow、OpenAI/Codex、交互终端和会话命令等扩展。
4. 保留恢复工程中的类型声明、stub 与 build shim，便于后续逐步替换或验证。
5. 通过 binary-only 流程发布非官方 launcher：正式公开发布由 tag 驱动，本地 binary 由 `Makefile VERSION` 注入版本；两者都不公开分发本仓库源码。

### 当前基线

| 项目 | 当前值 |
| --- | --- |
| 恢复基线 | `2.1.88` |
| 本地发布线 | `2.1.215` |
| 源码版本 | `0.0.0-dev` |
| 包管理器 | `bun@1.3.14` |
| Node.js | `>=18` |
| JS 构建产物 | `dist/cli.js` |
| 本地 binary | `built-claude` |

源码中的 `package.json` 始终保留 `0.0.0-dev`。正式构建版本由 Git tag 或 `CLAUDE_CODE_VERSION` 注入，`Makefile` 中的 `VERSION` 用于本地 binary 构建。

## 安装与运行

### 方式一：安装公开 launcher

公开包会根据 `process.platform` 和 `process.arch` 加载对应的平台二进制 optional dependency：

```bash
bun add --global @esonhugh/claude-code
claude --version
```

公开包仅包含 launcher 和平台二进制，不包含恢复源码。若当前平台没有对应 binary package，launcher 会返回缺少平台包的错误。

### 方式二：从源码构建

```bash
git clone <repository-url>
cd claude-code
bun install
make build
./built-claude --version
```

`make build` 使用 `Makefile` 当前 `VERSION` 构建平台 binary，并生成根目录下的 `built-claude`。

只构建 JavaScript CLI：

```bash
bun run build
bun ./dist/cli.js --version
bun ./dist/cli.js --help
```

本地开发版本的预期输出为：

```text
0.0.0-dev (Claude Code)
```

## 与恢复基线的主要差异

以下内容概括 `2.1.88` 基线之后的重要本地特性；详细提交、测试和版本边界见 [`CHANGELOG.md`](CHANGELOG.md)。

| 领域 | 本地特性与更新 |
| --- | --- |
| OpenAI/Codex provider | 支持 OpenAI Responses API、ChatGPT OAuth、device code 登录、token refresh、API key 和 Codex auth 文件；启用 server-side `WebSearch`，将 Anthropic web-search schema、OpenAI Responses `web_search_call`、URL citations 和 usage 转换为 Anthropic-compatible stream 事件；OpenAI 模式自动从 ChatGPT Codex 或 OpenAI-compatible `/v1/models` 发现模型，Anthropic API billing gateway 可通过 `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` 启用同类发现，并统一进入 Model Picker 缓存。 |
| Effort | CLI 可配置 `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`、`ultra`、`ultracode`，Model Picker/SDK capability 列表仍按 provider 与模型声明可选档位；configured effort 不按 capability 重写并原样传入所选 API，仅本地编排模式 `ultracode` 展开为 API `xhigh`。 |
| Agent | 支持前台/后台 Agent、续跑、nested Agent、Team/SendMessage、usage 聚合、终态通知和可选 worktree isolation；默认注册只读代码搜索 `Explore` 和方案设计 `Plan`，可通过 `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1` 关闭。 |
| Prompt context | 精简主会话安全、Bash Git/PR、Explore/Plan 与 Agent orchestration 的重复说明；system prompt 按稳定核心、能力和任务动态层组织 cache boundary，Plan + Auto mode 保持只读权限边界；Agent listing 使用增量 attachment，大型 deferred MCP tool 列表按 namespace 汇总，同时保留完整权限、动态发现和精确增删状态。 |
| Dynamic Workflow | 提供与官方模式兼容（official-compatible）的 Workflow facade、official-style script parser/runtime、declarative plan、phase、parallel/pipeline、journal cache、暂停、恢复、skip/retry 和生命周期通知。 |
| Codex Apps | OpenAI + ChatGPT OAuth 模式下将 Codex Apps 作为 host-owned MCP tools 与 hosted MCP skills 接入；支持逐项隐藏、`@codex-app:{app-name}` mention、裸 `@`/专用前缀补全和 deferred tool 按需加载，并限制 hosted skill 的可信来源、URI、分页、内容大小与缓存。 |
| Direct Connect | `v2.1.212` 之前已有的 remote transport：`claude connect <server-url>` 通过 HTTP 创建 session，再以 WebSocket 传输 stream-json；server 负责 Claude child、tools 和项目上下文，本地负责 TUI 与 permission UI。 |
| SSH Remote | 与 Direct Connect 并列的 SSH transport：`claude ssh <host-or-config> [dir]` 在远端 Linux 主机运行 child 与 tools、本地渲染 TUI；支持 remote-owned history/resume、远端 `@` 路径补全、远端 `!command` 和权限状态同步；remote binary 按版本/架构部署，GitHub Release 下载会校验 checksum，OpenAI/Anthropic 凭据只在本地 Unix socket proxy 注入。 |
| Terminal Tool | 将旧 `InteractiveTerminal` 统一为 `Terminal`，提供持久 PTY session 的 `new-session`、`list-panes`、`send-keys`、`capture-pane`、`resize-pane`、`send-signal`、`display-message`、`kill-pane` 生命周期，以及 compact/full/save_file 输出；统一的后台 polling 逻辑会按 session 同步终态、drain 尾部输出、持久化最终结果并发送一次完成通知，任务详情保留 command、args 和 cwd。 |
| 自定义 UI / Branding | 支持通过 `uiName` 自定义 Logo、condensed header 和 border title，默认显示 `EsonClaw`；支持加载自定义 `clawd.txt` ASCII 图。 |
| 状态与用量 UI | 当前模型使用 ChatGPT OAuth 且用量请求成功时，自动识别 `Plus`、`Pro`、`Team`、`Business`、`Enterprise` 等 plan，并在启动 pane 和 `/status` Usage 展示权威订阅及 Codex limits，同时展示 ChatGPT 用量窗口与 rate-limit reset credits；用量不可用时启动 pane 回退到 OAuth token 中的 plan，`/status` 显示不可用状态。reset 操作经二次确认后消耗一个 credit 并刷新显示；使用 API key 或 bearer token 时显示 `API Usage Billing`，不展示 ChatGPT subscription usage。Model Picker 支持 effort 显示、切换和持久化。 |
| 自主 Goal | `/goal` 或 `SetGoal` 注册 StopHook 并驱动自主执行；目标内容显示在 tool output、Prompt footer 和 Status line，并支持 compact/session restore 与自动清理。 |
| 会话命令 | 新增 `/goal`、`/cd`、`/reload-skills`、`/workflows`，并为 `/cd` 增加仅目录路径补全。 |
| Skills | 支持 bundled/model-internal skills、运行时 `/reload-skills`、user/project/plugin 分层加载，以及按功能类型路由 source tests、构建、tmux TUI 和 official parity 的 `claude-code-feature-validation` skill。 |
| 定时任务 | 提供 `CronCreate`、`CronDelete`、`CronList` 和 `/loop` 相关能力，可使用 session-only 或 durable task。 |
| Plugin/Marketplace | 扩展 marketplace、favorite scope、auto-update、插件热加载、失败状态回滚及官方插件名称兼容。 |
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

API key 示例：

```bash
CLAUDE_CODE_USE_OPENAI=1 OPENAI_API_KEY=<your-api-key> claude
```

OAuth 登录结果保存在 `~/.codex/auth.json`，文件权限为 `0600`。不要提交或分享该文件。

### 模型自动发现与 Gateway

OpenAI provider 启动时会刷新 Model Picker 的共享模型缓存：

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

也可以使用 `ANTHROPIC_API_KEY`，请求会改用 `x-api-key`；当两者同时存在时优先使用 `ANTHROPIC_AUTH_TOKEN`。`CLAUDE_CODE_OAUTH_TOKEN` 不作为自定义 Anthropic gateway 的发现凭据。gateway 请求 `${ANTHROPIC_BASE_URL}/v1/models`，并在 Model Picker 中展示未被明确标记为不支持 API 的模型，包括 endpoint 标记为 hidden 的模型；hidden 项会显示 `(Hidden)`。

发现请求超时、失败或没有认证时，不会清空同一 provider/auth/endpoint identity 的 `additionalModelOptionsCache`；成功响应但没有可用模型时会清空该 identity 的旧模型列表。identity 匹配时 Model Picker 使用已有发现缓存，否则使用当前 provider 的内置 fallback，避免跨 provider、账户、credential 或 gateway 混用陈旧模型；模型发现关闭时，first-party bootstrap 返回的无 identity `additional_model_options` 仍按既有行为显示。OpenRouter 仅可作为普通 OpenAI-compatible endpoint 使用，本项目没有为它增加独立 provider 或专用环境变量。

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

还可以在 `${CLAUDE_CONFIG_DIR:-~/.claude}/clawd.txt` 中保存自定义 Clawd ASCII 图。文件存在且非空时，Logo 区域优先显示该文件内容；读取失败或文件为空时回退到内置图案。

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

### Workflow 配置与使用

本地 Workflow 以**与官方模式兼容（official-compatible）**为目标，兼容 official-style facade、script parser/runtime 和运行生命周期，但不宣称是 Anthropic 官方实现或与任意未来官方版本完全相同。

启用 Workflow 和关键词触发：

```json
{
  "enableWorkflows": true,
  "workflowKeywordTriggerEnabled": true,
  "ultracodeKeywordTrigger": true
}
```

可用的相关设置：

```json
{
  "enableWorkflows": true,
  "disableWorkflows": false,
  "workflowKeywordTriggerEnabled": true,
  "ultracodeKeywordTrigger": true,
  "skipWorkflowUsageWarning": false
}
```

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

隐藏指定 connector：

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

Direct Connect 在 `v2.1.211` 中已经存在。`claude connect <server-url>` 先通过 HTTP 创建远端 session，再使用 WebSocket 双向传输 stream-json；远端 server 持有 Claude child、tools 和项目上下文，本地仅渲染 TUI 并处理 permission UI。v2.1.212 加固的是 malformed control frame、permission cancellation 和 late response 生命周期，并非新增 Direct Connect。

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

SSH Remote 当前只支持 interactive TUI。`!command` 在远端 cwd 直接执行并将转义后的结果写入远端 transcript；远端 Agent progress、Bash 和未知 MCP tool card 可在本地显示，但 display-only fallback 不能在本地执行。permission allow/deny/cancel、`/plan`、`/yolo`、Shift+Tab、永久规则、additional workspace directory、Esc interrupt、正常退出和断线均经 capability-protected control channel 同步；workspace directory 的存在性也由远端验证。

### Terminal Tool

`Terminal` 提供持久 PTY session，可用于需要多轮输入、特殊按键、窗口 resize 或 signal 的交互式程序：

```json
{
  "action": "new-session",
  "command": "bun repl",
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
/workflows
```

- `/goal`：保存当前自主目标，并在停止前检查目标是否完成；主线程也可通过 `SetGoal` 设置同一目标，tool output 会显示目标内容。
- `/cd`：切换当前会话工作目录，并将目录加入当前 session 的工作范围。
- `/reload-skills`：不刷新插件，直接重新读取 user/project/plugin skills。
- `/workflows`：查看 Dynamic Workflow runs，不直接启动 workflow。

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
- [`docs/guides/recovery-workspace.md`](docs/guides/recovery-workspace.md) — `2.1.88` 恢复背景、目录和恢复方法。
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
- [`docs/design/workflow-runtime-parity.md`](docs/design/workflow-runtime-parity.md) — Workflow runtime parity 的行为和证据边界。
- [`docs/workflows/`](docs/workflows/) — Workflow 示例、兼容性材料和测试 fixture。
- [`docs/research/`](docs/research/) — 二进制分析、CCH、Workflow 和 Codex 对比研究。
- [`docs/archive/`](docs/archive/) — 已完成计划、测试计划和历史实施记录。
- [`CHANGELOG.md`](CHANGELOG.md) — 从 `2.1.88` 基线开始的权威本地变更记录。

研究和归档文档描述的是特定时间点，不应直接视为当前行为保证；实际使用前应同时检查当前源码、测试和 CHANGELOG 的版本边界。

## 安全与适用范围

本仓库用于授权的研究、调试和二次开发。恢复或修改后的 binary 不应未经独立安全、遥测、更新和权限审查直接用于生产环境。

请勿提交 `.env`、`~/.codex/auth.json`、API key、OAuth token、cookie、证书或其他私有配置。涉及外部 provider、插件、MCP、Workflow 和自动化任务时，应先确认权限范围及其对本地或共享环境的影响。
