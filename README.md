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
| Agent | 支持前台/后台 Agent、续跑、nested Agent、Team/SendMessage、usage 聚合、终态通知和可选 worktree isolation；支持按次指定 `model` 和 `effort`，未配置 effort 时继承调用方；默认提供只读代码搜索 `Explore` 和方案设计 `Plan`，可通过 `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1` 关闭。 |
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
| Channels | 默认开放 `--channels`、交互式开发频道和 IDE/SDK `channel_enable`；支持 Anthropic API Key、OpenAI 兼容接口等已配置 provider，保留组织策略、插件来源验证和逐项授权；支持独立能力声明的远程工具审批。 |
| Mods / Function Hooks | 可信插件可通过 `hooks/modules` 接入生命周期、tool/prompt/turn middleware、动态命令和 terminal Pane；提供 scoped host capabilities、热重载、在途 generation 保留、取消与卸载。支持范围与官方运行时兼容性边界见下方 Mods 章节。 |
| 调试与构建 | 提供 Bun 构建、binary-only npm 发布、source map/Ink/代理调试、CCH attestation、官方 CLI 对照和 tmux/PTY 验收资料；平台 binary 会内嵌并在运行时提取 ripgrep，避免依赖系统安装。 |

## 配置与使用示例

设置可以写入 Claude Code 用户级或项目级 `settings.json`。以下片段只展示本项目相关字段，使用时应与现有 JSON 合并，不要覆盖其他设置。

### SubAgent effort

`Agent` 工具支持可选的 `effort`，与 `model` 一起按次指定：

```json
{
  "description": "检查相关实现",
  "prompt": "检查此次改动的调用链和边界条件",
  "subagent_type": "general-purpose",
  "model": "inherit",
  "effort": "low"
}
```

选择优先级为：本次 `effort` 参数 → agent 定义中的 `effort` → 调用方当前 effort → 已知的调用方模型默认 effort。未设置参数和 agent 定义时，子 agent 默认继承主 agent；嵌套调用继承直接父 agent。单独设置子 agent 不会修改主 agent 或共享 agent 定义。已有的 `CLAUDE_CODE_EFFORT_LEVEL` 环境覆盖在 API 请求层继续具有最高优先级。

支持 `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`、`ultra`、`ultracode`，并保留 agent 定义已有的整数 effort 兼容性；省略字段即使用上述默认规则。具体 API 支持由 provider 决定，沿用现有 effort 转换规则。前台、后台、进程内 teammate 和 tmux teammate 均传递所选值；后台 agent 续跑时保留启动时的 effort。验证范围见 [SubAgent effort 检查记录](docs/research/agent-effort-20261007.md)。

### Channels

默认构建包含 Channels，两个参数均可通过 `--help` 查看，不需要额外设置 `CLAUDE_CODE_RECOVER_FEATURES`，也不依赖 Anthropic OAuth 或远程灰度资格。模型调用仍使用当前 provider 的正常认证配置。

```bash
# 已安装的批准插件；可以空格分隔多个 plugin:<name>@<marketplace>
claude --channels plugin:telegram@claude-plugins-official

# 本地 .mcp.json 中的自定义频道；启动时须在终端确认
claude --dangerously-load-development-channels server:webhook
```

`--channels` 只允许有效白名单中的插件，并核对已安装插件的 marketplace 来源；仅配置 MCP server 不会开启消息注入。远程白名单不可用时默认批准 `claude-plugins-official` 的 `telegram`、`discord`、`imessage`、`fakechat`。远程返回的有效空名单仍然生效，非法名单不会扩大权限。

自定义 MCP server 使用 `server:<name>`，自定义插件使用 `plugin:<name>@<marketplace>`，均通过开发参数逐项确认；开发豁免只跳过对应条目的插件白名单，不跳过来源检查或组织策略。开发参数只支持交互模式，在 `-p` / Agent SDK 中不会授权；普通 `--channels` 和 SDK `channel_enable` 支持非交互模式。

存在 managed settings 或使用 Anthropic Team/Enterprise 时，管理员须设置 `channelsEnabled: true`。managed settings 中的 `allowedChannelPlugins` 替换默认名单，包括 API Key / 兼容 provider；空数组阻止普通插件，关闭 `channelsEnabled` 同时阻止开发频道。项目和用户 settings 不能覆盖管理员设置。

协议沿用 [Channels reference](https://code.claude.com/docs/en/channels-reference)：服务器声明 `experimental['claude/channel']: {}`，发送 `notifications/claude/channel`，参数为字符串 `content` 和可选字符串字典 `meta`。消息通过队列进入下一轮，SDK 空闲时也会开始处理；启动参数选择的已连接频道无需首条用户输入即可监听。`source` 由实际连接名决定，非法元数据键和伪造 `source` 被忽略。双向频道通过标准 MCP reply tool 回发；发送方身份认证与配对名单由频道服务器实现。

远程工具审批只发给通过完整频道准入检查且声明 `experimental['claude/channel/permission']: {}` 的服务器；缺失或 `false` 均不启用。审批使用独立的 `permission_request` / `permission` 通知和待审批 ID，普通聊天文本不能授权；本地与远程首先完成的答复生效。发送前清理 Unicode、遮罩可识别凭据，并按顶层参数分别保留最多 3,500 个码点的预览，长值保留首尾，无法序列化的字段单独标记。SDK/print 的权限审批仍由消费者的 `canUseTool` 处理。

现有 MCP SDK 要求实验能力为对象；本项目在握手前将审批能力的显式 `false` 转为缺失，保留普通频道和其他能力，使选择退出审批的服务器仍可连接。实现核对、回归和二进制验收见 [Channels 检查记录](docs/research/channels-20261007.md)。

可通过 `CLAUDE_CODE_DISABLE_CHANNELS=1` 关闭全部频道，或通过 `CLAUDE_CODE_DISABLE_CHANNEL_PERMISSION_RELAY=1` 单独关闭远程审批。第三方 provider 支持和可见 CLI help 属于本项目扩展，不表示官方产品提供相同行为。

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

脚本中的 `await agent(...)` 和 declarative plan 会等待实际 worker 的终态。普通 Agent 被 fork 模式或定义路由到后台时，Workflow 继续等待同一个任务；用户把前台 worker 切到后台也不重放执行。进度来自实际消息，取消保留原原因并只停止本次调用的 worker。无需为 Workflow 关闭 fork 模式。

运行完成、执行失败或通过 `TaskStop` 停止后，主会话会收到对应的任务通知，包含已测 token/tool 用量、持续时间和输出文件；已完成分支的结果也保留在输出中。暂停保留恢复状态，不发送终态通知；对已经结束的 run 再次执行不会重复启动或通知。Native39 完整门禁正常收尾：30项 / 27通过 / 3失败。code-review、workflow、workflow-retry-partial-failure、workflow-failure-detail 均通过最终验收；其余失败为 builtin-mods、terminal-canonical-diff、terminal-interaction。整体仍未通过。 本批完整回归、类型检查、新构建及默认验收驱动均通过；不代表完整 Mods/UI、browser/Client 或发布通过。详见[生命周期验收](docs/research/workflow-agent-lifecycle-validity-20261009.md)。

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

### 终端程序状态（OSC 7501）

交互式终端只有在启动探测确认支持 OSC 7501 后才会上报程序状态；未应答的终端不接收状态报告或退出清理。主记录使用协议 root，报告 `idle`、`working`、`blocked`、`done` 或 `error`，权限、问题和认证等待附带对应 `kind`。已完成回合的状态不会因焦点变化或普通按键消失；任务进度和后台任务子记录随真实状态更新，移除子记录及退出时清理终端记录。

无需为支持该协议的终端额外配置。关闭终端标题和状态上报可使用：

```bash
CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 ./built-claude
```

`CLAUDE_CODE_SESSION_KIND=bg` 同样关闭探测和上报。为匹配固定官方 2.1.296，等待提示的 `msg` 会包含完整 Bash 命令、文件路径或 URL；文字经过控制字符清理和 UTF-8 长度限制，Base64 是协议编码，不是脱敏。目前缺少官方回合结束摘要和活动文本的数据源，因此 `done` 的摘要 `msg`、`working` 的活动 `msg` 仍待接入。已验收的后台子记录不代表父子回合的完整时序已经等价。

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
- `/diff`：由已加载且获准接管该命令的官方内置 diff Mod 处理；未接管时使用原生 Git diff。原生视图在终端至少 110 列且没有可见 Mods dock 时使用右侧 sidebar，否则打开 dialog。官方 Mod 的完整详情、刷新、滚动、关闭重开及终端/浏览器 Client 生命周期仍须完成验收。
- `/workflows`：查看 Dynamic Workflow runs，不直接启动 workflow。
- `/list-agents`（别名 `/peers`）：列出当前 messaging registry 中其他可发现的本地 Claude session。

PromptInput 按 UTF-8 stream 处理普通文本、中文等宽字符、Kitty CSI-u 和 bracketed paste。同一个 stdin chunk 中的文本与 Enter/Backspace/方向键按顺序生效；未闭合 paste 会在有界空闲恢复后释放 literal payload 并回到普通输入，避免后续按键被永久吞掉。

### Mods / Function Hooks

Mods 是通过 Function Hooks 扩展运行时的可信 Plugin。以下说明针对当前源码构建，不代表已发布的 `@esonhugh/claude-code` launcher 已包含这些能力。

对齐目标包括官方 Mods 的函数、参数和回执、上下文传递、加载生命周期、作者测试及 UI 行为。除用户明确指定的 Privacy Mode 等差异外，现有本地行为不能自动视为例外。下文的未实现项是待完成工作；当前结果与分批修复顺序见 [兼容性清单](docs/research/mods-parity.md)，实际验收记录见 [mods-test.md](mods-test.md)。

当前 Mods/API 批次固定以官方 **2.1.292** 为基准；已提交的 Button、Pane 和内置 diff 专项保留其固定 **2.1.295** 来源，终端 OSC 7501 专项使用 **2.1.296**。这些专项不改变其余 API 的基线，也不表示全部 UI 已完成迁移。作者声明以 2.1.292 完整声明体为基础，只投影已核对的 2.1.295 Button children 定义。兼容目标包含官方 diff Mod 原样实现的 diff viewer：注册和打开、文件/base/turn选择、ask上下文、刷新、滚动与显示效果都需一致；当前原生 `/diff` 不能代替这项验收。关键调试信息应准确记录状态和来源，日志文字无需与官方逐字相同。官方接口说明见 [Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)。

`Button` 可以持有字符串和嵌套 `Text` children，整段仍是一个可点击控件和一个焦点位置。例如在 `ui.render` 中使用 `const {Button, Text} = $.ui.resolve(event)`，返回 `Button({key:'save', label:'Save', children:['Save ', Text({dimColor:true, children:'2m'})], onPress:() => {}})`。`label` 是无 children 显示能力的 surface 使用的名称；仅单字符串 child 的旧写法继续默认以 label 为 key。其他元素会被拒绝；复合 children 应给出稳定 key。终端鼠标沿用官方的挂载后 300ms 点击稳定期和窗口激活处理，Enter/Space 不等待此稳定期。已接受的 press 绑定原 guest handle，重绘期间只要仍有 drawing 持有它就可继续；新 Button 即使复用 key 或函数也不能接管旧 guest。

按钮移动或终端 resize 时，静止指针下的 hover 会在绘制后重新命中；为防止 hover 样式反复改变自身布局，连续四次变化后暂停跟随 1000ms，新的鼠标移动立即恢复。同一 Text 内两侧均有字符的空格仍属于该文本，跨 Text 或外侧的空白按空白处理。上述策略来自固定官方 2.1.295 的 Ink 实现，不新增 Mods 作者参数。专项脚本同时检查按钮在静止指针下移出/移回、两次额外 resize 的实际反色样式和关闭重开；可见 absolute 子树可以在父框之外命中，hidden/scroll 按对应轴裁剪；真实布局、重挂载与 hover 回归入口为 `bun test ./src/ink/hoverFollowsPaint295.test.tsx ./src/ink/hit-testAbsolute295.test.tsx`。

本批可重复终端脚本为 `bun scripts/validate-mods-button295.mjs --binary /absolute/built-claude --binary-sha256 SHA256 --evidence-root /private/tmp/claude-test/new-button-run`。先运行 `make build`，传入该新产物的 SHA-256；证据目录必须不存在。脚本使用隔离配置、dummy credential、关闭的 loopback provider 和私有 tmux，验证子文本绘制、重绘中的 press、重复 Enter、单次发送 Tab+Enter、两次实际 resize、子文本鼠标点击、Tab 到关闭位置及 Shift+Tab 返回，再完成关闭/重开。七次观察同时核对焦点与 hover 样式。Pane 的 Tab/Shift+Tab 依次访问作者控件、其他 Pane 标签及关闭位置；Enter 激活关闭或切换，保留 Pane 持键。无溢出时上下键循环作者控件，有溢出时优先滚动，Input/Select 先处理自己的编辑键。鼠标按 RenderElement Button 只激活按钮，保留原 custom keyboard focus；标签样式同时响应显示状态、键盘持有和 hover。类型、回归与验收边界见 [Pane 焦点记录](docs/research/mods-pane-focus295-20261009.md)。两种模式都核对实际 child 的零退出码、reap、EOF、无清理信号/错误及原关闭身份。默认 local 模式还要求原生逐帧与 resize 证据通过，不能只靠 pane 文本；官方对照加 `--mode official`，只报告行为验收。两种模式均不宣称完整 input owner、调度时序或 Mods 发布通过。覆盖边界和回归入口见 [Button 与鼠标验收](docs/research/mods-button-295-validity-20261009.md)。

最小目录为 `.claude-plugin/plugin.json`、`hooks/hooks.json` 和 `hooks/register.ts`。Manifest 使用普通 Plugin 的 `name`、`version`、`description`；在 `hooks/hooks.json` 声明入口（路径相对此文件）：

```json
{
  "modules": ["./register.ts"]
}
```

`register.ts` 导出 `register` 函数，可使用 `import type { Register } from 'claude-code'` 配合本次构建自动生成的类型。模块支持受限的静态相对导入；使用单入口，不假设支持动态导入、任意 npm/native 模块或 Node 全局对象。完整布局和示例见[研究报告](docs/research/claude-mods.md#73-最小示例)。例如在会话开始时注册一条本地命令：

```ts
import type { Register } from 'claude-code'

export const register: Register = on => {
  on('session.start', async ($, event, next) => {
    await $.command.register({ name: 'hello-mod', description: 'Show a greeting', immediate: true })
    return next(event)
  })
  on('command.run', { command: 'hello-mod' }, () => ({ text: 'Hello from my-mod' }))
}
```

从源码构建后加载可信插件；非 builtin Mod 首次加载及声明变化时会自动维护 `.claude-plugin/types/` 下的 `claude-code`、tool、MCP 与测试类型声明：

```bash
./built-claude --plugin-dir /absolute/path/to/my-mod
./built-claude plugin validate /absolute/path/to/my-mod
./built-claude plugin test /absolute/path/to/my-mod
```

`plugin validate` 静态扫描 hook 模块，不执行模块的顶层代码。`hooks:` 按注册顺序列出每个事件及 matcher，重复事件的不同 matcher 分别保留；`calls:` 列出能力调用，仅在该能力没有直接调用时补充已排序的 helper 来源，例如 `$.fs.read (via alpha, zebra)`。matcher 中的正则、列表和嵌套字段保留结构；无法静态确定的值显示 `?`，诊断字符串进行转义并限制长度。这些输出已与固定官方 2.1.292 的七个真实 CLI 场景对照；gating-hook 警告及其他诊断尚未纳入本项兼容结论。回归入口为 `bun test ./src/services/mods/validateDescriptions.test.ts ./src/cli/handlers/plugins.validate.test.ts`。插件目录与 manifest 字段参考 [Anthropic plugin manifest reference](https://code.claude.com/docs/en/plugins-reference)。

作者主声明采用官方 2.1.292 原生制品内的完整声明体作为基线：565 个主模块导出、51 个 testing 导出，以及完整事件、操作和全局定义。仅 ButtonProps 与 RenderElement 的 Button 分支追加固定 2.1.295 制品核对过的 children 定义；基线、增量和片段摘要均在生成前校验，文件头明确两者来源。生成文件头仍记录本地引擎版本，不把声明来源版本当作引擎版本。加载会生成三个基础类型根，并加入启用的直接和间接依赖插件在 manifest `types` 中声明的契约；依赖可不含 hooks。没有 `jsconfig.json` 或自定义根 `tsconfig.json` 时，还会创建插件根目录的 `tsconfig.json`，指向 `.claude-plugin/types/tsconfig.json`。已有根配置保持原样。

新增的 `PromptAutocompleteInput/Result/Suggestion`、`ModelTextBlock/ModelCompleteInput`、`AgentSpawnInput.workflow` 和 `HookFailure` 重入定义均来自官方原文。它们的运行时生产、分发和上下文仍须按功能验收；声明增量的历史差异见[声明专项](docs/research/mods-declarations-292-20261007.md)，本批 prompt.autocomplete 的实际实现与有限验收见[编辑和焦点专项](docs/research/mods-remote-composer-292-20261008.md)，不能仅凭类型检查通过推断其他功能支持。

依赖插件在自己的 `.claude-plugin/plugin.json` 中设置 `"types": "./types/index.d.ts"`，使用方在 `"dependencies": ["shared-state"]` 中声明它；普通来源的裸名称继承 marketplace，inline 等会话来源按名称查找。同名 inline 插件也可满足带 marketplace 的依赖。生成目录内优先链接依赖的真实契约文件；链接失败时只复制不超过 256 KiB 的普通文件，并去掉 BOM。契约必须留在依赖插件的真实目录内。

`.claude-plugin/types/` 由引擎管理，主声明、内部配置和 ignore 文件在加载或 `/reload-plugins` 时刷新，截断或改写后也会恢复。手写声明请放插件自身的 `types/`，自定义编译选项放根 `tsconfig.json`。移除依赖会删除生成的 `index.d.ts`，保留同目录的作者文件。旧生成 `results.d.ts` 仅在内容校验仍匹配时移除，作者改写和符号链接保留。

在本仓库已安装开发依赖的环境中，加载后可严格检查插件项目：

```bash
bun ./node_modules/typescript/bin/tsc -p /absolute/path/to/my-mod/tsconfig.json --skipLibCheck false --incremental false
```

目录外入口也会参与同一作者项目的类型检查。例如在 `hooks/hooks.json` 使用 `{"modules":["../code/register.ts"]}` 时，生成项目只追加 `code/register.ts`，不会包含整个 `code/` 目录。更改入口后执行 `/reload-plugins` 会更新 include；移回 `hooks/` 后移除旧的目录外入口，已有根配置保持原样。此流程已与官方 `2.1.291` 对照，其完整声明体与 `2.1.290` 相同。

旧本地别名 `CAS`、`HookEvent`、`EventPattern`、`Surface` 分别改用官方的 `StateSetOptions`、`EventName`、`Pattern`、`RenderSurface`；`!*` 不属于官方 pattern。testing 挂载使用对象参数，显式给出 `plugin`、`surface`、`component` 和该组件的完整 `props`。

完整声明与可加载能力不等于全部运行时行为已兼容。声明中的官方方法不再仅因缺少本地实现而阻止整个 Mod 加载；尚不可用的方法会返回可捕获的 `$.noun.method is not available in this build` 错误，这类回执仍属于待实现项。

| 能力 | 已提交行为与验收边界 |
| --- | --- |
| `ui.notice` / `ui.ask` | 已有生产入口；notice 放在 AskUserQuestion 对话框底部。单选、多选、自由输入、取消及多插件归属仍须分别验收。 |
| `command.run` | 已修复 headless `turn.complete` 中等待命令队列造成的死锁及未结算回执；交互式和嵌套命令流程仍待完整对照。 |
| `telemetry.log` / `telemetry.mark` | 公开调用经过 hook 链，内置插件执行发送门控；Privacy Mode 保留。剩余 matcher 与多插件归属继续验收。 |
| `mcp.connect` / `session.send` | 已有宿主入口；完整连接和跨会话生命周期不能由类型检查或入口存在推断。 |
| `audio.play` / `audio.speak` / `session.compact` / `session.append` | 尚有生产接线或交互生命周期缺口，未宣告完整实现。 |

新增 `prompt.mention`、server-tool 记录及权限 ceiling 的宿主流程也需继续对齐。依赖契约的直接和间接类型根已接入，详见上文的作者项目生成规则。[Anthropic Mods reference](https://code.claude.com/docs/en/plugins/mods/reference) 说明接口与事件；版本冲突时以固定版本实际生成的声明及实测行为为准。历史生命周期审查见[实现审查](docs/research/mods-implementation-audit-20261007.md)。

`$.process.spawn(request)` 已接通真实子进程与流式 middleware。它同步返回 `HookStream`，不是 Promise；request 仅有 argv/cwd/env/input。公开结果是 `{code,signal}`，hook 的 `next(e).result` 是 `{value:{code,signal}}` 或 `{deny}`：

```ts
export function register(on) {
  on('session.start', async ($, event, next) => {
    await $.command.register({name:'inspect',description:'Inspect git status',immediate:true})
    return next(event)
  })
  on('command.run', {command:'inspect'}, async ($) => {
    const child = $.process.spawn({argv:['git','status','--short']})
    let text = ''
    for await (const chunk of child) text += chunk.text
    const {code, signal} = await child.result
    return {text:`${text}\ncode=${code}, signal=${signal}`}
  })
}
```

块使用 `{stream:'stdout'|'stderr',text}`，以 UTF-8 解码，不承诺两根管道的相互顺序。spawn 没有输出截断或 timeoutMs；积压超过 1 MiB 字符时暂停读取。结束消费、真实取消、钩子超时及模块卸载会停止归属该操作的孩子，正常 hook 返回可继续保有已启动流。process.spawn 普通 hook 的自身预算按块重置，catch 共用一段 1000ms 恢复预算。首次拉取前 return 不启动孩子、result pending；结束已读块的流会拒绝未完成结果；关闭仍在等待的拉取按官方语义完成该拉取与结果。复现见[流与验收专项](docs/research/mods-process-spawn-validity-293-20261008.md)。

插件测试工具同样同步返回流，但测试主体读取 wrapped receipt，插件和测试 hook 的公开方法读取 raw receipt。测试底层需由 `on('process.spawn', async function* ...)` 应答，无 stub 时明确拒绝，不启动真实孩子。完整 gate 根据源码强制加入 mods-process-spawn，用新 binary 的真实作者命令检查八个 CLI 契约，重核关闭收据、原始日志、孩子副作用与 binary 身份；完整 Mods/UI 与发布仍需独立验收。

Native36 完整门禁正常结束：30项 / 24通过 / 6失败，overall failed。新增 mods-process-spawn 通过实际八项作者 CLI 契约和最终关闭原件重查；其余失败为 builtin-mods、code-review、terminal-canonical-diff、terminal-interaction、workflow、workflow-retry-partial-failure。 本批14文件回归746通过、7项原有skip、0失败；私有合并快照另有44项通过。构建、release-check及默认验收回归均通过，仍不代表完整Mods/UI或发布通过。完整源码身份与原件摘要见[流与验收专项](docs/research/mods-process-spawn-validity-293-20261008.md)。

`plugin validate` 校验 manifest、hook module、依赖、类型契约和 state 读写；`plugin test` 运行 `tests/` 中导入 `claude-code/testing` 的隔离作者测试。会话内可用 `/plugin-authoring` 请求当前 session 的作者目录并打开内置指南，也可显式刷新或启停（`my-mod` 为 manifest 名称）：

```text
/reload-plugins
/plugin disable my-mod
/plugin enable my-mod
```

`plugin test ./my-mod` 支持相对路径，子进程使用解析后的插件根目录。每个测试文件使用独立的临时 HOME；inline 测试插件保留在本次独立目录内，正常结束、失败或超时后，在子进程退出之后回收。runner 不扫删历史残留或其他并发运行的目录。

例如把以下测试保存为 `tests/hello.test.ts`。作者 runner 会在首次调用时自动启动测试 session；底层宿主调用需要由测试 hook 应答，不能直接调用真实 UI、进程或模型：

```ts
import { test, expect } from 'claude-code/testing'

test('registers and runs the greeting', async ($, on) => {
  const registered: string[] = []
  on('session.start', ($, event) => ({ cwd: event.cwd }))
  on('command.register', ($, event) => {
    registered.push(String(event.name))
    return { value: { command: event.name } }
  })
  expect(await $.command.run({ command: 'hello-mod', args: '' }))
    .toEqual({ text: 'Hello from my-mod' })
  expect(registered).toEqual(['hello-mod'])
})
```

作者测试 body 中的 `$` 是事件驱动器：参数为事件输入对象，返回未解包的事件回执。例如先用 `on('session.start', (_, event) => ({ cwd: event.cwd }))` 提供桩，`await $.session.start({ cwd: '/fixture', surface: null, isInteractive: false })` 得到 `{ cwd: '/fixture' }`。生产 `register` 的 `$` 则按公开方法签名调用并解包 `{ value }`，例如 `$.http.fetch(url, init)`。测试 hook 内的 `$` 也使用生产接口签名。

`testing` 已为 session、tool、command、config、prompt、skill、attribution、agent、turn 和 UI 的 31 个已有事件提供显式输入及原回执类型，包括 session.start/receive/compact/attach/detach/measure/end。例如 `$.tool.check({ tool, input, tool_use_id })` 返回 `ToolCheckResult`；`$.prompt.submit` 接受完整 `PromptSubmitInput`，`$.session.compact` 接受带 trigger 和 messages 的完整 `SessionCompactInput`。`Args<'prompt.fill'>`、`EventOf`、`ResultOf` 与 testing 的 `EngineCall` 保留事件签名；生产便利调用的默认参数和回执解包不适用于测试驱动器。builtin 工具输出按生成的 `outputSchema` 推导，MCP 输出保持 `unknown`。testing `Engine` 只从 `EventCalls` 的事件调用构造，不继承生产操作方法或任意 namespace；`$.ui.resolve`、`$.prompt.edit`、`$.ui.invalidate`、`$.ui.selection`、`$.ui.panes`、HTTP 和 session 元数据读取不是它的方便方法。生产 `$` 与 `On` 继续按各自声明使用。`ui.invalidate` 的 `Args` 为 `{ event: InvalidatableEventName }`，`ResultOf` / `OpEventResult` 是 `{ value: void }` 或 `{ deny: string }`，generic `EngineCall` 保留这份回执；生产 sugar 同步返回 `void`。当前声明保留官方完整 `OpEventOf/OpValueOf`，包括 `ui.invalidate` 和 `ui.panes`；`ui.panes` 的空输入、readonly `UiPane[]` 值和包装回执进入 generic `EngineCall`，testing `Engine` 不新增 `panes` 方便方法。session.append/send、telemetry 和其他缺失生产方法的运行时实现仍在补齐。

`Frozen<T>` 按官方定义递归固定对象字段，并保留数组原声明的可变类型；这不允许修改运行时已冻结的 hook 输入。作者需要修改装饰等数组时，应创建新的数组与对象后传给 `next`。

`prompt.edit` 是 composer 事件，没有公开的 `$.prompt.edit()` 方法。普通输入及 Vim Insert 的实际编辑进入 hook；输入包含编辑前的 `text/cursor`、UTF-16 `start/end`、`inputText`、可选 `key` 和固定的 `{ kind: 'composer' }` 来源。`next(event)` 返回编辑后的 `{ text, cursor }`，hook 可附加装饰，例如：

```ts
import type { Register } from 'claude-code'

export const register: Register = on => {
  on('prompt.edit', async ($, event, next) => {
    const box = await next(event)
    return {
      ...box,
      decorations: box.text ? [{ start: 0, end: box.text.length, color: 'green' }] : [],
    }
  })
}
```

装饰支持 `color/backgroundColor/dimColor/bold/italic/underline/strikethrough`，范围相对返回文本。编辑链使用官方 50ms 自身预算；调用 hook 前准备 UI 访问权限的宿主等待不计入其中，完成后恢复计时。同批编辑合并首个编辑前状态与最后编辑后状态，多项合并时省略 `key`。异步回复按期间输入重新计算，失效草稿和已卸载编辑器不接受旧绘制。插件 `prompt.fill` 不冒充人工编辑事件。这些路径已有真实 Worker 和挂载输入组件的源码测试；普通/Vim 的 fill、编辑回执、50ms 默认预算与整条 composer ANSI 已与固定官方 2.1.292 实测一致，完整主题及 terminal/diff/browser Client 生命周期仍待验收。

会话 hook 返回对应事件的回执，例如 session.start 返回 `{ cwd }`、session.end 返回 `{ sessionId }`；忽略 `register` 自身的返回值不等于可以从这些 hook 返回 `undefined`。`SessionContextBreakdown` 保留官方原始数组类型，传给 hook 的输入再应用 `Frozen`；旧 `UsageBreakdown` 接口仍保留现有定义。

同一注册环境对每个原始事件 pattern 只允许一个不带 matcher 的注册；`*`、`namespace.*` 或 `!event` 等 broad pattern 即使带 matcher，也不能重复注册。精确事件可以有多个带 matcher 的 hook，包括 `{}`，并可以与一个不带 matcher 的 hook 共存；不同 pattern 独立计数。静态校验和实际 Worker 都会拒绝违规注册，错误包含 `registered twice`；静态错误附带编译后的位置。导入 helper 共享该注册环境，跨入口的官方分组语义仍待核对。

原先依赖多个无 matcher hook 的顺序或兄弟调用示例，应给第二个精确事件注册加空 matcher，例如 `on('tool.call', {}, async ($, e, next) => next(e))`；空 matcher 保留对全部输入匹配的意图。2026-10-06 的官方2.1.289 CLI对12个真实夹具分别确认原写法拒绝、此写法接受；五个runtime测试保留原断言。运行 `env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN bun test ./src/services/mods/runtime.test.ts` 等逐文件回归时，测试内部会隔离配置和占位认证；完整官方声明分支可通过 `CLAUDE_CODE_OFFICIAL_MOD_TYPES=/absolute/path/to/claude-code-2.1.289.d.ts` 启用。当前六文件ROOT复验289 pass/0 fail/4 skip，跳过的telemetry、旧官方diff命令和sec-default原件分支仍待补齐，不能作为完整门禁通过。

`toolAdapter.test.ts` 和 `runtimePromptCompose.test.ts` 中的下游 context/嵌套 compose 夹具也采用上述合法写法，原上下文及调用帧断言保留。两份原件由官方289逐一拒绝，加空 matcher 后逐一接受；两文件在用户仓库路径、调用方无凭据时分别50/0和5/0，无skip。可分别运行 `env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN bun test ./src/services/mods/toolAdapter.test.ts` 和 `env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN bun test ./src/services/mods/runtimePromptCompose.test.ts`；测试内部隔离HOME/config/XDG并恢复环境。该55项上下文回归与前批六文件289项分别记录，不拼成完整门禁结果。

额外的 `PromptInput.modsEdit.test.tsx` 已采用相同的内部认证和配置隔离，逐文件无需调用方key；`openai-compat.test.ts` 是含 `node:assert` 的模块级脚本，应检查其 `openai-compat.test.ts passed` 输出与退出码。它在 `bun test` 中注册0个case，不能将该统计解释为断言未执行或虚报为新增pass；也可用 `env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN bun ./src/services/api/openai-compat.test.ts` 直接执行。

同批 Worker 按键夹具也应自行隔离 HOME/config/XDG、恢复环境，并使用测试内部占位认证；无需调用方提供真实 key。当前原4案已在实际工作区通过，尚未提交该新UI文件。

历史工作区的 `teammateResume.test.ts` 报告使用独立 HOME/config/XDG/TMP 和测试占位认证；该夹具尚未进入当前提交，不能作为当前 checkout 的可执行命令或通过项。

`SendMessageTool.test.ts` 同样自行隔离子进程配置并提供测试占位认证，可直接运行 `bun test ./src/tools/SendMessageTool/SendMessageTool.test.ts`。构建路径检查可用 `bun ./scripts/build-isolated.test.mjs`；它使用调用者的 `TMPDIR` 保留证据，拒绝覆盖仓库根或祖先目录，不执行真实二进制构建。

逐文件验证还需独立设置系统 `TMPDIR` 与 `CLAUDE_CODE_TMPDIR`，后者用于真实任务输出；冻结副本需有自己的 Git 仓库，才能验证依赖 Git 的 `/diff`。大型文件的整文件进程上限应覆盖全部用例的正常耗时，保持每案原预算不变。2026-10-06 对报告原155文件的完整独立进程复验均exit0；完整官方API/UI/diff交互验收仍待完成。

测试卫生已分批签名提交：`eb5e545` 处理两份上下文夹具，`265c3db` 处理 OpenAI 测试环境，`4e28238` 处理 compact 注册与请求准入夹具，`734480c` 处理 SendMessage 隔离，`d9cdbbe` 处理构建路径检查。每份实际暂存版本均在对应 HEAD 上独立检查后提交；其余功能与完整兼容门禁继续验证。 主请求测试应显式传入 `publicTurn`；复用冻结请求的内部 fork 应移除该准入，避免测试设置赋予额外 turn 所有权。

作者测试的 `on` 可以在普通 `await`、timer 或读取 `$` 属性之后注册；首次实际 `$` 调用开始加载后，不能再添加 `on`。`$.turn.step(input)` 只构造流，第一次 `next()` 才开始加载；从未拉取的流先 `return()` 或 `throw()` 不会进入 hook，也不会结束注册准备。

`on(...).catch(handler)` 返回 `undefined`，注册句柄本身冻结。测试 kit 在加载前保存最后一次附加的 handler；生产 Mod 的 `register` 中每个注册只能附加一次。catch 的 `next.error` 是冻结的 `{ kind: 'throw' | 'timeout', message?, budget }`，`next.called` 表示原 hook 是否已调用下层；这些字段只存在于 catch 中。已调用下层时，catch 的 `next` 重放原结算结果，不重复运行下层；返回 `undefined` 表示继续下层。流事件的 catch 使用 `async function*`，其 `undefined` 返回同样继续下层。

```ts
import { test, expect } from 'claude-code/testing'

test('recovers an engine hook', async ($, on) => {
  await Promise.resolve()
  on('env.get', () => { throw new Error('temporary failure') })
    .catch((_, event, next) => {
      expect(next.error.kind).toBe('throw')
      expect(next.called).toBe(false)
      return { value: 'recovered' }
    })
  expect(await $.env.get({ name: 'example' })).toEqual({ value: 'recovered' })
})
```

Hook 的宿主预算可以结束调用等待，不能立即抢占模块的同步 CPU 循环。取消后 5 秒仍未结算时，仅拒绝该请求；共享 Worker 的独立心跳负责识别无响应和退役。已归因的故障模块不会在自动恢复中重新加载，其他已准入模块按已固定的声明重建；旧 catch、句柄及在途调用不会迁移。连续第三次未归因 Worker 崩溃停用其 JS Mods，显式 reload 重置累计计数。卸载先撤销本地能力，不等待 guest 确认。debug log 记录故障原因、Worker 年龄、等待请求数量及可确认的模块和执行来源；已结算请求使用独立 ID，真实 callback 单独标记，未知来源保持未知。同样错误文字的不同崩溃分别记录，输入、选项和私密字段不序列化。custom 方法和 UI constructor 的调用者由宿主验证后传递，保留最先七项并在同步返回或抛错后恢复；无法确认祖先对应请求时不打印叶请求 ID。公开 Worker custom 方法 10 秒未回答时拒绝宿主 Promise，guest 的迟到结果被忽略；普通 hook 和 engine.create 不套用这一期限。严格 dispatch fallback、独立 nativeHost、全部等待类别及原生故障恢复仍在对齐中。

catch 成功或测试已断言某个引擎调用的拒绝时，单独的 hook 诊断不会把已完成的测试改成失败。测试 body 实际抛错、未处理的拒绝、超时和卸载失败仍判为失败，并附带引擎诊断及原错误栈。这些行为已有源码入口验证，当前制品与官方原生执行的对照另行记录。

`register` 的返回值会被忽略，异步函数会等待完成；因此可以使用返回注册句柄的简写，例如 `export const register: Register = on => on('session.start', ($, event, next) => next(event))`。生成声明与实际 Worker 保持一致，返回句柄不会代替模块的 hooks 注册结果。

作者项目使用完整的主声明、tool 和 MCP 辅助声明及依赖类型根；对生成项目执行严格检查：

```bash
bunx tsc -p /absolute/path/to/my-mod/.claude-plugin/types/tsconfig.json --skipLibCheck false
```

`$.tool.call` 根据实际 builtin `outputSchema` 推导输出，工具名保持字面量时，`next(event)` 和 `next.to(event, 'core')` 也保留对应结果类型；MCP、宽泛字符串或没有输出 schema 的工具按官方契约返回 `unknown`。先区分拒绝、错误与成功，再读取结果，例如：

```ts
import type { EngineInterface, ToolCallResult } from 'claude-code'
declare const $: EngineInterface

const receipt: ToolCallResult<'Read'> = await $.tool.call({
  tool: 'Read', file_path: '/workspace/README.md',
})
if (receipt.deny === undefined && receipt.isError !== true && receipt.result.type === 'text') {
  const content: string = receipt.result.file.content
}
```

`next.to` 的类型推导不授予跨 tier 权限：`prepend` 可继续到 `append/builtin/core`，`append` 可继续到 `core`；普通用户 Mod 使用 `next(event)`。

生成目录按官方规则刷新；内容校验仅用于清理旧本地生成的辅助模块。本批补齐 command/config/tool 列表、注册回执、`agent.spawn`、`mcp.call`、UI 返回，以及官方 289 的 `AgentSpec`、七态 `AgentStatus` 和精确 Agent/tool.check hook 定义；全部官方类型及真实生产路径仍在对齐中。

`$.agent.register` 接受具名 `AgentSpec`，保留 `permissionMode`、`hooks`、`mcpServers`、`omitClaudeMd` 等官方字段。公开 `$.agent.spawn` 接受 `prompt` 与可选 `description/subagentType/model/name/cwd`，默认描述取 prompt 的前五个空白分词；hook 输入另含宿主固定的父身份、provider、permission、fork 与 teammate 字段，不能改写这些身份。返回可带 `agentId` 和 `teammateId`；当前同进程 teammate 已生成独立的 logical ID，完整生命周期仍待对照。`tool.check` 返回 `allow/ask/deny` 和可选 `reason/rule/hook`，来源字段来自实际权限决策。

同进程 teammate 停止或任务记录被回收后，`SendMessage` 可用其名称或 logical ID 恢复原对话。恢复会重新检查当前 agent 定义、允许类型、权限规则、`agent.offer` 和定义所在项目的信任；不恢复已保存的 `bypassPermissions`。可读历史保留消息 UUID 与父链，发送者身份进入新提示，并发消息只启动一个恢复任务，其余进入邮箱。当前读取器无法读取历史时会冷启动；官方完整历史清洗、hydration、延迟加载定义和所有原生生命周期仍待补齐。上述行为有源码验证，新制品同操作验证待完成。

公开 `$.config.list()` 的 `config.describe` 保留调用插件的来源，每次重新计算这份描述；引擎菜单使用独立的 `engine/core` 描述缓存。公开命令列表同样保留调用者，引擎命令投影使用自身来源。

文件读取按官方重载声明：`$.fs.read(path)` 返回文本，`$.fs.read(path, { as: 'bytes' })` 返回 `{ base64 }`；使用 `FsReadOptions` 的一般重载返回 `string | FsBytes`，需要判断结果类型。显式 options 必须包含 `as`。`$.fs.stat(path)` 使用默认选项，传 options 时必须包含 `resolve: boolean`，例如 `$.fs.stat(path, { resolve: true })`；`realPath` 仍为可选字段。空对象会被运行时拒绝，也应被作者类型检查拒绝。

- 生命周期：扫描并固定模块声明 → 准入 → 加载候选模块并执行 register → `engine.create` → `session.start` barrier；首次输入等待初始化完成。`/clear`、resume 更新会话绑定，不重复启动同一 activation。
- 作者模式：`/plugin-authoring` 的 Enable 只授权当前 session 的独立 `dev-mods` 目录；公开 turn 结束后才加载新模块，取消和迟到结果有 generation fencing。同一 session 的 resume 恢复该授权；`/clear` 和 fork 创建的新 session 不继承，需重新确认。
- 重载与卸载：模块依赖变化可触发热重载，显式 reload 使用同一生命周期；技术加载失败保留旧 activation，禁用、移除、拒绝准入或接口构建失败撤下对应能力。相同声明及加载集合下不重复执行失败的 engine.create；声明、动态导入或集合变化时重新尝试。已进入调用持有原 generation，结束后释放；Worker 故障不自动重放已发生的宿主副作用。
- Worker 故障恢复：识别到造成 CPU 阻塞的插件后，自动恢复其余插件，已挂载的 AbovePrompt 会使用恢复后的插件重新绘制，无需额外输入或调用 invalidate。正在执行的失败调用不会自动重放；显式 reload 会重新尝试崩溃插件，刷新等待恢复完成，有 transcript 日志的宿主会提示崩溃插件已卸载。恢复本身失败仍返回错误；完整终端呈现仍待对照。
- 环境目录：`CLAUDE_CODE_PLUGIN_DIRS` 加载绝对目录，macOS/Linux 用 `:` 分隔，Windows 用 `;`；与重复的 `--plugin-dir` 合并去重，相对路径会输出配置错误并以非零状态退出。交互会话自动观察模块变化；长期非交互会话需设置 `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` 才自动重载，未设置时仍可显式刷新。
- 缓存清理：按官方 289 的暂存目录命名和时间边界保留有效安装暂存区，孤立版本使用 14 天期限。清理先读取有效安装记录；缺失、损坏或没有安装记录时不继续删除。安装路径按真实文件系统位置比较，marker 和递归删除不跟随链接。运行中的 `.in_use` 生命周期、发布链及平台专属边界仍待补齐。 当前加载契约可运行 `bun test ./src/utils/plugins/pluginLoader.contract.test.ts`。历史工作区 GC 的20案子进程夹具尚未交付，不能计入当前提交的可复现覆盖。
- Managed 加载：组织 Mods 必须由 managed `enabledPlugins` 启用，并通过 managed `extraKnownMarketplaces` 中的绝对目录市场、相对插件路径原地加载。远程或复制到缓存的插件保留用户身份；设置 `allowManagedHooksOnly` 时不运行这些模块。`disableAllHooks` 在个人设置中保留组织 Mods，在 managed settings 中阻止全部安装插件的 Mods；宿主内置 Mods 和 guard 仍按自身开关与 seating 规则加载。
- 当前接线：tool 注册、列举、描述、调用与检查；prompt compose/edit/read/fill/suggest/submit/context/section/attachment；turn middleware 与流式 model step；agent offer/register/list/spawn；MCP 调用；动态 slash commands；session receive/measure/usage/compact/end/authorize；config/options、accepted settings、fs、受限 HTTP、argv process、env、版本化 state/JSON store，以及 terminal/remote UI 与 terminal media。state 写入支持 owner-only、JSON/大小限制和 `ifVersion` CAS；订阅失效只重绘读取对应 key 的 UI instance。命令、Pane 和 callback 跟随 activation/drawing 生命周期，禁用后释放所有权。
- 会话版本：`await $.session.version()` 返回 `{ version, base?, builtAt? }`，不接受参数，terminal、非交互和未绑定 session 时均可读取。`version` 与当前 binary 的 `--version` 一致；`base` 沿用引擎 analytics 的基础版本提取规则，`builtAt` 使用 binary 内嵌的构建时间戳，源码运行没有时间戳时省略。调用经过 `session.version` 中间件；作者测试需用 `on('session.version', () => ({ value: { version: 'test-engine' } }))` 提供桩。
- 时钟：`await $.clock.sleep(ms, { signal: next.signal })` 可在当前事件取消时提前结束等待。`$.clock.after(ms, callback)` 和 `$.clock.every(ms, callback)` 同步返回 `Timer` 句柄，调用 `timer.cancel()` 停止；模块卸载或重载也会停止旧计时器。回调发起的宿主调用使用实际存活的调度上下文：原 hook 仍在执行时保留 registration，并允许同插件其他 hook；原 hook 回执已结算后以插件作为独立来源，排除该插件自己的中间件。普通 hook 结束后，已经启动的异步宿主调用可以完成；真正取消、抛错、超时或卸载仍会阻止迟到的 UI 写入。
- 草稿：`await $.prompt.read()` 返回 `{ text, cursor }`，`cursor` 是 UTF-16 偏移。`prompt.fill({ text, mode, decorations? })` 返回 `{ isFilled, text, cursor, refusal? }`；缺少 composer 或被对话框阻挡时分别返回 `no_composer`、`dialog`。draft 仍受调用者的 `prompt.read` 准入控制，没有声明读取或读取被拒绝时字段为空。replace 将编辑器切回 prompt 模式，装饰相对填入文本的 UTF-16 范围计算；宿主以实际接受的文本判断能否绘制。Unicode 清理在 hook 改写之后按缓存功能开关执行，装饰范围同步换算。`prompt.suggest({ text })` 返回 `{ isShown }`，可据此判断是否显示建议。
- 插件提交：`await $.prompt.submit({ text: '检查当前变更', asUser: true })` 在当前 turn 完成后进入队列。省略 `asUser` 时模型文本带插件 sender 标记；`asUser: true` 省略该标记，但事件和 transcript 仍保留 `{ kind: 'plugin', name, asUser: true }` 来历。Promise 在 prompt 准入后返回原始或中间件改写的 `{ text, context?, origin }`，不会等待模型回答；被丢弃时返回 `{ drop }`。在 `prompt.submit`、tool/command 等可能持有 turn 的 hook 内等待它会被拒绝；应在独立 UI 回调等入口提交，prompt hook 中使用 `next`。
- 宿主回执：`await $.fs.list()` 的每项包含 `mtimeMs`，普通文件使用同次 stat 的修改时间与字节大小，目录、链接和其他项为0，列表不跟随链接。`await $.process.run(['git', 'status', '--short'])` 返回 `exitCode/stdout/stderr/isStdoutTruncated/isStderrTruncated`；stdout、stderr 各自限4MiB，恰好限值不算截断；发生溢出时丢弃被上限切断的UTF-8尾部，没有溢出则按完整Buffer解码。可分别检查两项截断标志后处理输出。取消或超时会尝试终止真实子进程；终止失败会拒绝调用，未收到实际close不视为清理完成。公开失败使用带插件/命令前缀的HooksError，超时消息包含实际预算。
- 原生验收：resize请求记录真实控制器Mach时钟，并与实际内核ACK及后续物理绘制帧关联；异步已发布文件尾仅说明可见prefix。使用方法、历史失败和剩余验收范围见[请求时钟有效性处置](docs/research/mods-native-driver-clock-validity-20261009.md)。完整输入owner与时序门禁仍未通过。
- 会话数据：`session.repo()` 返回只读 `SessionRepo` 或 `null`；无参数 `session.messages()` 返回最近 4096 条主会话的 `SessionMessage`，保留文本、tool use 与已有 tool result。在 Agent 或嵌套查询中调用也读取主会话，每次调用读取实时绑定。`{ as: 'api' }` 返回引擎规范化后的 `{ role, content }` 消息，content 始终为数组，保留图片、文档、thinking 和配对的工具块，省略每次发送的 cache control。`{ agentId }` 读取当前 session 中前台/后台 Agent、持久 fork 或同进程 teammate 的实时或已保存对话；不可读取的 ID 返回包含该 ID 的 `{ deny }`。Workflow 的内部 Agent、其他 session 和无法读取记录的其他进程不在此接口范围内。resume 重新绑定后不会读到旧 session 的记录。`session.usage()` 的 `startedAt` 始终为 epoch 毫秒数，已记录的启动时间在恢复时保留、`/clear` 时重置；缺少记录的历史会话使用官方活动时钟回退，详见下面的兼容边界。
- 中间件声明：已有 session 读取、授权和 HTTP hook 名称均可直接用于 `on`，支持 `!*`、命名空间 pattern 和否定 pattern；`next.trace` 提供只读 `received`、`returned`、`outcome` 及流事件的可选 `chunks`。`next.called/error` 只在 catch handler 提供，普通 handler 不应要求它们存在。
- Validate 输出：`claude plugin validate /absolute/path/to/my-mod` 按注册顺序显示 matcher，例如 `ui.render{component=Pane, requestId=review}`；同名事件的不同注册分别保留。仅经 helper 调用的方法显示 `$.fs.read (via loadFile)`，helper 名去重后排序；同一方法也直接调用时省略 `via`。诊断静态读取 AST，不执行模块代码；未知值显示 `?`。这批输出修复不扩大已有模块准入范围。
- 命令投影：宿主获取 command 描述时以 `engine/core` 发起独立 `command.describe`；公开 `$.command.list()` 的中间件仍保留实际调用插件的来源。
- 调用历史：嵌套宿主调用和插件提交队列保留内部 caller history，避免重新进入已经发起调用的 registration；独立插件来源排除该插件全部 hook。该历史由宿主固定，不进入公开参数或回执，也不能通过 `prompt.submit` 额外字段伪造。UI 重绘作为新的引擎事件进入渲染 hook，不沿用触发 invalidate 的插件排除项。
- Prompt 组装：每次真实模型请求及 fallback/retry 都按当次模型与工具目录执行 `prompt.compose`；返回 section 的 shared/session scope 控制缓存边界。嵌套作者调用保持当前 hook snapshot，避免重新进入发起调用的 registration。
- AbovePrompt 与通知：terminal `AbovePrompt` 支持宿主绘制、Client 交互和 engine continuation。无 dialog/其他键盘所有权时，显式 `Ctrl+X` 后按 `Tab` 可进入 Band，保留当前草稿与光标；草稿值随后实际改变时退焦。自动取得站点键盘仍要求空 composer；已经显式持键后的首控件协商允许保留非空草稿。`ui.toast` 校验文本与时长并按插件限流，通知通过宿主 UI 展示。
- 请求重绘：更新插件状态后调用 `$.ui.invalidate('ui.render')`。公开方法同步返回 `void`；即使写成 `await $.ui.invalidate(...)`，也不会等待新画面发布。`InvalidatableEventName` 限定为 `ui.render`、`prompt.section`、`prompt.context`、`prompt.attachment`、`tool.describe`、`command.describe` 或 `config.describe`。宿主排队刷新对应绘制或描述缓存，后台失败按发起插件与 `ui.invalidate` 记录诊断。正常 hook 结束后，已发起的有效调用可以继续；卸载后的旧调用不能发布新画面。此操作已有精确事件输入和包装回执声明；所有原生 surface 仍待完整验收。
- 重绘回归：宿主测试应在触发交互前登记绘制回调，或订阅画面发布并检查当前快照，等到目标状态出现后再断言；不要用固定 sleep。运行 `bun test ./src/services/mods/render.test.ts ./src/services/mods/testLab.test.ts` 检查示例交互和旧绘制回调失效；设置 `CLAUDE_CODE_OFFICIAL_MOD_TYPES` 为官方完整 `.d.ts` 文件的绝对路径，才能同时执行示例的官方类型检查。当前声明回归可运行 `bun test ./src/services/mods/declarations.test.ts`。历史工作区的三个事件声明夹具尚未交付，不作为当前提交的通过项。
- Client 与恢复回归：当前可运行 `bun test ./src/services/mods/client.test.ts ./src/services/mods/runtimeUi.test.ts`，检查 Client 异步消息、绘制替换，以及 Worker 的 Pane 生命周期和恢复后发布。历史工作区的 terminal Client、CPU 故障 consumer、session 恢复专项夹具尚未交付，其报告不能算作当前提交的可复现覆盖；完整 CLI/物理画面仍需另行对照。
- Client 回调与重绘：已经接受的 Button/Input/Select 操作保留当时的回调，区域 resize 或新绘制不会静默丢掉排队输入。新画面替换后再次调用旧回调会拒绝；卸载会取消尚未执行的操作。当前回归可运行 `bun test ./src/services/mods/client.test.ts ./src/services/mods/clientRealm.test.ts`；历史工作区的 held-callback 专项夹具尚未交付，不声称这两个文件覆盖其全部排队契约。该回归与完整 Band UI 验收分别记录。
- Pane 输入：没有 dialog 或其他输入所有权时，`Ctrl+X` 后按 `Tab` 依次经过 Band 实际控件、各可见 Pane 正文，再回到 composer；鼠标可直接进入可见控件。显式进入 Pane 保留当前草稿与光标，实际草稿值改变后退焦并作废旧请求；未显式持键时自动入焦要求空 composer，已持键后的 autoFocus 首控件允许未变更的非空草稿。未持键 Pane 的裸 Tab / Shift+Tab 由 composer 处理。已持键 Pane 内的 Tab、方向键和热键按实际控件处理，Input/Select 优先消费自身按键，Escape 关闭或退焦。控件未消费的普通字符继续进入 composer 并释放 Pane 持键；例如点击 diff 的 ask 后，可以直接输入下一条 prompt 或 `/exit`。同一个键盘事件不会重复派发。鼠标滚轮按实际命中的 Pane body 交给插件处理，Pane 外保持 transcript 滚动。
- Band 使用：`Ctrl+X` 后按 `Tab`，把当前实际控件的 `component/requestId/plugin/element/origin` 交给 `ui.focus` 协商；合法改写按发布的真实控件落点，空格激活 Button。拒绝或不调用 next 时保留 Band body 持键，不虚构 Button 焦点。Band 未持键时，裸 Tab/Shift+Tab 留给 composer。点击 `[-]` 或 `Ctrl+X` 后按 `Ctrl+A` 折叠，按相同快捷键或点击提示展开；折叠值在同进程组件重挂和 runtime 替换后保留。快捷键可通过现有 keybindings 重绑或解绑。
- 同 key 控件：人工 Band 及已持键 Pane 导航按实际控件顺序访问，即使同一插件的两个控件使用相同 key，Tab、Shift+Tab、上下键及 Enter 仍作用于当前槽位。人工跨插件移动保留目标控件的 plugin 与 person 来源。自动或插件改写焦点按 plugin/element 查找首个匹配；插件不调用 `next()` 时保留原槽位。定向官方 2.1.293 证据、回归和完整验收边界见[焦点与有效性记录](docs/research/mods-focus-chord-validity-20261008.md)。
- Band 验证边界：固定官方2.1.289与本轮隔离Makefile新制品，均在160×40独立tmux中完成逐步Band→两Pane→composer以及六chord一次发送对照，作者focus DTO/原回执、按钮和Pane热键结果一致，双方正常 `/exit 0`。ROOT的 `built-claude` 未替换。完整公共scroll、动态上下文、modal、diff交互及所有logical/physical帧仍待验收，详见 `mods-test.md`。一次tmux发送不证明官方一次OS读取；源码测试另覆盖真正单次stdin读取。
- 初始焦点：已持有键盘的可见 Pane，会把首个实际可见、带 `autoFocus: true` 的非 Client Button/Input/Select 交给真实 `ui.focus` 中间件协商。事件保留绘制控件的插件来源，从新的引擎调用开始，允许自身 hook 观察；只按宿主发布的真实落点应用 DOM 焦点。拒绝、不调用下层或无效改写不会虚构焦点，普通重绘保留已持有的输入和文本，卸载后的旧回执不能抢回键盘。Client 与 AbovePrompt 的完整焦点行为仍待对齐。
- 焦点组合键回归：运行 `bun test --no-env-file ./src/components/ModsPane.chordNavigation.test.tsx ./src/components/ModsPane.test.tsx ./src/components/ModsAbovePrompt.test.tsx ./src/services/mods/ui.test.ts ./src/services/mods/diffTakeover.test.ts ./src/commands/diff/diff.test.tsx`。应在独立临时 HOME、CLAUDE_CONFIG_DIR、TMPDIR 和 XDG 目录内执行，并移除调用方认证环境变量。新增回归同时检查默认按键解析、`pendingChord` 清空、宿主快照、实际 DOM 焦点、`source`、空 `base` 控件及返回 composer 的完整循环。历史工作区的 Band/PromptInput 专项报告与当前提交可复现的回归分别记录；源码通过不能替代当前 binary 的逐帧和官方双端验收。
- 组合键验收边界：官方 2.1.293 的默认定义为 `Chat` 上下文的 `ctrl+x tab -> abovePrompt:focus` 和 `ctrl+x ctrl+a -> abovePrompt:toggle`。面板尚未持键时不提前消费裸 Tab；组合键的前缀、完成、取消和解绑由现有按键系统处理。官方 2.1.293 的跨插件同 key 自动首焦定向运行确认原作者控件持焦并收到唯一 Enter 回调，装饰插件不收到回调，正常退出；旧 2.1.292 的同场景落点预期单独保留。该定向结果不等于最新版本完整验收。完整原生矩阵必须记录当前构建、同次运行的输入、快照、DOM 焦点、原始 PTY 输出和清理结果；零输出帧跨 resize、同步帧 ACK 和异常退出均不能据最终截图判为通过。诊断与准确证据边界见[焦点组合键记录](docs/research/mods-focus-chord-validity-20261008.md)。
- 焦点回归：运行 `bun test --no-env-file ./src/components/ModsPane.automaticFocus.test.tsx ./src/components/ModsPane.pluginFocus.test.tsx ./src/services/mods/ui.focusOwnership.test.ts ./src/ink/components/App.keyboardDispatch.test.tsx`。已有 automaticFocus 夹具覆盖真实 Worker、宿主入口、拒绝和改写；新增回归分别检查跨插件同 key 的实际 DOM/按键 owner，以及草稿变更的异步 fencing 和显式非空草稿持键后的首控件。新增组件夹具不冒充 Worker/CLI。历史 focusOwner/autofocusHost/registrationMultiplicity 专项未交付，不计入当前通过项。测试需按上述要求隔离 HOME/config/认证；源码测试不替代双端 CLI 的界面验收。
- 焦点与布局：有可见内容的 Button/Select/Input 用高亮提示实际焦点；列表分页按最终落点与已提交绘制顺序导航。Diff 按 Pane 与嵌套 Code 容器的可用宽度排版，终端 resize 后重新适配；dock 正文预算随实际可见高度和 composer 高度更新。内容可达性、长文本与窄屏降级仍受插件自身布局及 wrap 声明约束。
- Pane 入场与宽度：自动打开的未入场面板通常等待144列；保留人工打开资格的面板等待110列。已入场的面板缩窄后仍保留，低于110列切换 inline，实际关闭后重新打开才重新计算入场条件。默认 dock outer 宽度为 `min(floor(columns * 0.45), 90, columns - 70)`，正文减去一列 grip；插件的 `columns` 请求正文宽度，dock outer 在24列至终端宽度减24列之间限制。inline 按实际自然内容高度与官方预算取较小值，正文边框和 padding 占4列、2行；多 tab 另占1行，空正文可为0行。fullscreen 输入区保持全宽；按官方2.1.289，dock 顶部始终预留1行，正文预算为输入区上方实际空间减1行。右上角 ✕ 与正文独立绘制，为人工关闭，不受 `closeOnEscape` 限制。用户手动尺寸持久化、grip拖拽和完整 resize 交互仍待对齐。
- Button：`onPress(press)` 收到中间件处理后的 `UiPressArgument`，包含 `plugin/element/component/requestId/surface`；可用 `press.surface` 判断点击来自哪里。`variant: 'primary'` 在终端使用 `suggestion` 主题色，`secondary` 或省略时保留普通样式；`plain: true` 优先，hover 样式最后覆盖。`role: 'dismiss'` 只是绘制提示，关闭仍由回调调用 `$.ui.close({ id })` 完成。生成声明导出 `ButtonProps`、`UiPressArgument`、`RenderSurface`、`PressedLink` 和 `TextHoverProps`。
- Diff action：插件声明相应 Button `action` 时，默认 Ctrl/Opt+Up/Down 切换文件，Ctrl+x 后按 b 切换 diff base；沿用现有 keybindings 配置，可重绑或解绑。显示用 `hotkey` 文本本身不会注册动作。
- Pane 关闭：面板实际持有键盘焦点时，按 `Ctrl+X` 后按 `x` 请求人工关闭；Input/Select 字段持焦时也可使用。关闭先释放字段与宿主焦点，再执行 `ui.close`；插件保持面板打开或抛错时，旧的挂起焦点请求不能恢复焦点，后续新的聚焦请求仍可进入。AbovePrompt Band 不注册这组关闭上下文。自定义 keybindings 已启用的构建可在 `~/.claude/keybindings.json` 的 `Pane` / `PaneField` bindings 中把 `pane:close` 重绑或设为 `null`；两种上下文须分别配置。格式与上下文说明见 [Anthropic keybindings 文档](https://code.claude.com/docs/en/keybindings)，Mods API 见 [官方参考](https://code.claude.com/docs/en/plugins/mods/reference)。本批的测试与尚未完成的真实终端验收见[关闭与验收记录](docs/research/mods-pane-close-and-acceptance-20261008.md)。
- 官方 diff 使用：运行 `/diff` 打开面板。全屏中可用 `Ctrl+X` 后按 `b` 切换 base，`Ctrl/Opt+Up/Down` 翻动文件列表，点击文件定位正文；点击 `ask` 后选中 diff 随下一条被接受的 prompt 传入。再次点击 `asked ✓` 取消附加。按键仍遵循当前 keybindings 和插件实际声明的 action。已验证的接受路径与待验证的取消、内联及 resize 路径分别记录在 `mods-test.md`。
- 权限边界：模型工具仍经过原有 schema、managed hooks 与权限审批。**Worker/VM 不是 OS 安全沙箱**，Mod 的 fs/process 宿主能力不自动等同于模型 Read/Bash 权限；只运行经过审查的可信插件。
- 兼容性边界：已提供自动作者声明、`claude plugin validate`、`claude plugin test` 和 `/plugin-authoring`，但不宣称实现全部官方 API、模型流、桌面/远端 surface 或官方 binary 动态 parity。Node `dist/cli.js` 不是当前作者工具验收目标；跨平台、完整 release gate、逐帧 logical/physical 与未执行的官方 rollout 分支仍记为未覆盖。

插件缓存由启动流程自动清理：普通孤立版本的 `.orphaned_at` 标记超过 14 天后才删除，已安装版本会清除过时标记，新临时目录按其命名时间获得保留期保护。安装记录读取失败时保留缓存；版本和标记链接不作为普通文件递归处理。本批真实启动对照限 macOS 普通文件系统，Windows/WSL 及其他存储后端仍单独验收。

内置 guard 的运行时名称为 `cc-plugin-sec-default`，存储 ID 为 `cc-plugin-sec-default@builtin`。排序配置也接受官方保留的旧名称 `sec-default@builtin`，两种名称均按大小写归一化处理。排序只信任管理员策略及本次会话中服务器已验证的远程策略。未获验证的 `remote-settings.json` 磁盘缓存仍可提供普通 policy 值，但不能通过 `prependPlugins: []` 或省略 guard 的列表移除它。直接嵌入 Mods 宿主并自行提供策略的调用者保留原有排序契约。

官方用于“仅允许组织 Mods，同时保留个人 settings hooks”的 **managed settings** 配置如下。本地该选项的准入及刷新仍待完成，暂不视为已交付功能。官方若显式配置 managed `prependPlugins`，需包含 `cc-plugin-sec-default@builtin` 或 `sec-default@builtin`；组织仍有改名前的官方版本时，排序列表应使用旧别名：

```json
{
  "pluginConfigs": {
    "cc-plugin-sec-default@builtin": {
      "options": { "allowManagedModsOnly": true }
    }
  }
}
```

发布验收器的逻辑回归可在私有临时目录执行：

```sh
validation_tmp="$(mktemp -d /tmp/claude-release-tests.XXXXXX)"
TMPDIR="$validation_tmp" python3 .claude/skills/release-validation/scripts/test-release-driver.py
```

逐帧验证器回归可运行 `bun test ./scripts/verify-pty-terminal-evidence.test.mjs ./scripts/builtin-terminal-evidence.test.mjs ./scripts/terminal-input-evidence.test.mjs ./scripts/mods-test-lab.test.mjs`。测试需要私有短路径 TMPDIR、sandbox-exec 及仅本机 loopback/Unix socket 权限；使用 dummy 凭据。帧比较、输入归属、收尾和 fresh replay 各自保留原始证据，保存的 passed 字段不能替代重算。

该入口执行所有已定义的 retained 回归。真实门禁仍须新构建、动态 baseline 和完整 `run-binary-gate.py` 矩阵；`--targets` 只追加目标，不能缩减必验范围。缺失、跨运行或仅空文件/目录的证据不能通过。code-review 的空变更 Scope 核对本案真实父子调用、请求及通知，最终汇总重验输入快照与证明 JSON 的哈希；其完整后续阶段仍需验收。该历史 Scope 轮矩阵为 28 项完成、26通过、2失败，整体未通过（不是最新门禁结果），见[Scope 与封存复核](docs/research/release-scope-identity-validity-20261008.md)；[上一批验收记录](docs/research/release-acceptance-validity-20261008.md)保留历史结果。

Darwin native journal 另记录实际 child 的 `read/readv` 与两种 `NOCANCEL` 入口：保存原返回值、errno 和成功读取的字节前缀，识别同一注册 PTY 的 fd 别名。它不把 broker 发出的 bytes 当作 child 已读取，也不把读取成功当作解析或输入消费证明。`records.bin` 的 kind 3 与 stdout 输出分开；实际 CLI 回归另生成 `child-input-read-proof.json`，Mach 时间按十进制字符串保存。运行方式与剩余输入链见[child 读入证据](docs/research/mods-native-child-input-read-validity-20261009.md)。

Native30 是历史记录；已封存的 Native35 完整矩阵仍为29项完成、23通过、6失败，准确范围见[Native35处置](docs/research/mods-native-payload-closure-validity-20261008.md#native35-最终处置)。零输出观察只有在实际raw区间为零且resize位于其start/end之间时，才与start的物理网格比较；仍回放全部resize并要求后续新尺寸帧。ACK在start前生效的旧快照继续失败，同步ACK的时序门禁也继续失败，详见[帧与验收记录](docs/research/mods-terminal-noack-validity-20261008.md)。

Anthropic 的 [Mods overview](https://code.claude.com/docs/en/plugins/mods/overview)、[API reference](https://code.claude.com/docs/en/plugins/mods/reference)、[organization policy](https://code.claude.com/docs/en/plugins/mods/admin) 和 [官方示例源码](https://github.com/anthropics/claude-code/tree/main/mods) 可用于了解官方设计（2026-10-04 核对）。作者应以目标 binary 生成的声明与 `plugin validate` 为可调用 API 的依据；`ui.notice`、公开 telemetry 和 headless `command.run` 已分别提交生产路径修复；`ui.ask`、音频、MCP 与 session 操作等仍需按实际宿主和完整生命周期逐项验收。已存在同名方法也仍需检查参数、返回值、生产入口和 UI，不能仅凭名称认定兼容。源码已支持已准入且存活的 builtin/inline 官方 diff Mod 接管 `/diff`，同步暂停原生 sidebar 的自动打开与轮询，在卸载或失效后释放接管。普通 Mod 无法通过名称、manifest 或公开字段取得该身份。生产启动已加载独立的官方 2.1.295 diff 归档，并接入官方交互 surface、可用性开关和首次偏好恢复；`agents-md` 与 `telemetry` 仍保留 2.1.277。真实 startup、原样 Worker、接管及资源打包控制有源码验证。官方289和隔离新制品已在160×40全屏九文件 fixture 中完成 uncommitted 切换、列表翻页、选中文件、ask、直接输入及正常退出对照；两条真实 composer prompt 的准入结果一致，首条附加选中 diff，第二条不重复附加。只有本地64/93帧完成logical/physical核对；通知位置、辅助模型选择仍有差异，普通终端内联、resize、取消/丢弃、上下文预算和官方全帧仍待验收，详见 `mods-test.md`。

### 复制文本

`$.ui.copy` 异步返回复制回执，文本保持原样，不做字符串转换。省略 `surface` 时，宿主先选择当前绘制的 surface，再进入 `ui.copy` middleware；middleware 可以改写文本和目标，也可以拒绝操作。

```ts
const receipt = await $.ui.copy({ text: '待复制的文本' })
if (!receipt.isCopied) {
  $.ui.log(`复制未完成：${receipt.reason}`, { to: 'debug' })
}
```

导出 `UiCopyArgs` 和 `UiCopyResult`；失败原因是 `no-surface`、`no-clipboard` 或 middleware 返回的 `refused`。`{ deny }` 会使 Promise 拒绝。当前 terminal 接入既有剪贴板工具和 OSC 52，单次 OSC 写入最多 1 MiB；实际复制还取决于终端支持。远端应用的 clipboard responder、能力广告和超时协议仍待接通，当前没有对应设施时返回 `no-clipboard`。源码回归可运行 `bun test ./src/services/mods/uiCopy.test.ts ./src/services/mods/uiCopy.types.test.ts ./src/services/mods/uiCopyTerminal.test.ts`。


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

`$.ui.log`、`$.ui.status` 和 `$.ui.toast` 同步返回 `void`，与官方2.1.289的公开便利调用一致。`await` 这些方法不能用作通知完成的屏障，也不会捕获后台 dispatch 的拒绝；异步失败会在 debug 日志记录插件、操作名和原因。作者声明保留 `string` 参数；JavaScript 调用会先做 `String(text)`，status 的 `null`/`undefined` 则清除状态。作者类型要求清除时显式传入 `undefined`。

```ts
$.ui.log('diff 已加载')
$.ui.log('正在分析文件', { to: 'debug' })
$.ui.toast('检查完成', { timeoutMs: 4000 })
```

`UiLogSink`、`UiLogOptions` 和 `ToastOptions` 已导出；canonical `ui.log/status/toast` 的事件输入与 `ValueOrDeny<void>` 回执仍是异步事件调用。运行 `bun test ./src/services/mods/uiVoid289.test.ts ./src/services/mods/uiNotifications.types.test.ts ./src/services/mods/uiNotifications.lifetime.test.ts` 检查真实 Worker、参数转换、同步作者异常、后台拒绝和精确声明。后台失败后插件仍可继续执行。完整 UI 和跨 realm 错误原型仍有待对齐的项目，见 `mods-test.md`。

Mod 可用无参数的 `await $.ui.panes()` 查询自己的 Pane。返回类型为 `Promise<readonly UiPane[]>`，每项只含 `id`、`title`、`isShown`、`isFocused` 和 `isPlaced`；已放置的 Pane 在前，各组保持打开顺序。记录属于引擎，模块重载后仍能找到原 Pane；其他插件的 Pane 不会列出。修改返回副本不会修改引擎状态。可以在激活时避免重复打开：

```ts
on('session.start', async ($, event, next) => {
  if (!(await $.ui.panes()).some(pane => pane.id === 'clock')) {
    await $.ui.open({ id: 'clock', title: 'Clock' })
  }
  return next(event)
})
```

运行 `bun test ./src/services/mods/uiPanes.test.ts ./src/services/mods/uiPanes.types.test.ts` 检查真实 Worker、middleware、重载、回调回收及精确作者类型。官方289与本轮新制品已完成相同的查询、`/reload-plugins`、焦点 chord、按钮、持键重开和关闭流程；稳定返回值一致，双方正常退出。首次 open 后立即查询焦点的发布时间、传递依赖的作者项目与所有 UI 帧仍有差异或未覆盖，详见 `mods-test.md`。通过 composer 键入命令会先交出 Pane 持键；查询返回的是调用当时的状态。

终端 Mod 可调用 `const selection = await $.ui.selection()`，得到 `{ text, requestId? }` 或 `undefined`。读取不复制、不清除高亮；复制或按键清除高亮后，选区保留到随后一次 prompt/command 结束。选区落在同一已挂载 transcript 消息范围内时附带消息 UUID 或 `tool_use_id`；跨消息和侧边 Pane 选区只返回文字。当前没有选区支持的 host 返回 `undefined`。滚动按实际绘制距离移动选区，保留离屏文字与原列，反向滚动恢复端点；相邻 Pane、边框和 padding 限定选区范围。新版跨 scope 的 softWrap 编码、已卸载历史消息的身份和完整原生终端操作仍待验证；源码检查不能视为全部选区行为一致。

Client Mod 可注册 `ui.fault` 观察自己的 surface 故障：

```ts
on('ui.fault', async ($, e, next) => {
  await $.ui.status(`${e.module}: ${e.phase}: ${e.reason}`)
  return next(e)
})
```

`e` 包含宿主固定的 `surface/component/requestId/element/module/phase/reason`；`phase` 只有 `load/render/run`。该事件返回空对象，不提供 `$.ui.fault()` 调用，也不能用 `next` 改写地址或原因。自己的匹配 hook 结算后，仍存活的绘制可自动重试一次；连续失败不无限重绘。未返回的 Promise 被拒绝时记录错误并继续运行该 surface；回调返回的 Promise 或 thenable 被拒绝时，停止所属实例并发送 `run` 故障，其他实例和 hook 继续运行。成功返回值不替换画面，render 返回 Promise 仍会同步失败。已排队的旧实例拒绝可记录警告。终端 Pane 和 AbovePrompt 的真实 React 绘制异常限制在 Client 区域：相同传入 props 值及全局 columns/rows/conversationColumns 保持失败缓存；这些输入变化后，须有新的宿主绘制才重建实例，单独区域 resize 不重试。跨 owner 共享、异步绘制期间 resize、完整长链晚警告及各 surface 的原生流程仍待对照。

调试 Mods 时，可用 `claude --debug-file /tmp/claude-mods-debug.log`。`[ModsPrompt]` 用 UUID 关联入队与 admitted/dropped/aborted 回执，记录入口、asUser 与队列优先级；`[ModsUI]` 记录 open/close 来源、绘制 generation、发布 revision、可见性、焦点、实际正文/自然内容尺寸及滚动 offset；`[ModsSession]` 记录按 session 匹配的费用恢复时间。`[ModsUI]` 的 `ui.fault` 记录插件、七个故障字段及结算耗时；`reason` 来自模块错误，清理控制字符并限制为200个UTF-16代码单元。队列与布局记录不新增 prompt/context/provider 正文；模块错误原因与其他既有 debug 内容需按实际输出检查。日志有助于定位空白、旧绘制和布局问题，仍需结合真实终端帧验证。

#### 模型辅助调用

`model.complete` 返回 `ModelCompleteResult`，成功时为 `{ isAnswered: true, text, usage }`；请求失败、回复没有文本或被取消时返回 `isAnswered: false` 和 `reason`。每个已发起请求的分支都有四项实际 token 计数：`input_tokens`、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens`；未报告的计数为零。`api-error` 另有 HTTP `status`（没有响应时为 `null`）与 `error` 分类，不公开错误正文或 headers。非法参数、被限制的模型与 middleware 的 `{ deny }` 仍拒绝调用。

例如在 `hooks/register.ts` 注册一个摘要命令：

```ts
import type { Register } from 'claude-code'

export const register: Register = on => {
  on('session.start', async ($, event, next) => {
    await $.command.register({ name: 'model-note', description: 'Summarize the supplied text' })
    return next(event)
  })
  on('command.run', { command: 'model-note' }, async ($, event) => {
    const reply = await $.model.complete({
      model: 'haiku', prompt: `Summarize briefly: ${event.args}`, maxTokens: 1024,
      effort: 'medium', timeoutMs: 10_000,
    })
    if (reply.isAnswered) return { text: reply.text }
    return { text: reply.reason === 'api-error'
      ? `Request failed: ${reply.error} (${reply.status})`
      : `No reply: ${reply.reason}` }
  })
}
```

`model.fork({ prompt })` 使用主会话保存的缓存共享上下文，追加一个问题，禁止工具调用和 fork 自己尾部的缓存写入。完成主会话后再调用的上下文包含刚完成的助手回复；官方 2.1.287 的同操作二进制对照也观察到这一行为，详细请求与文档表述差异见 `mods-test.md`。它返回同样的结构化结果；主会话尚无可 fork 的响应时为 `{ isAnswered: false, reason: 'nothing-to-fork' }`，这个分支不带 usage。fork 汇总所有非错误回复的文本和各响应的用量，取消或失败保留已测得的用量。`model.classify` 仅在成功回复不属于给定标签时返回 `undefined`；请求失败、取消或空回复会拒绝并指出原因。

`turn.step` 和 `turn.complete` 由宿主登记的实际 turn 触发；真实 Agent 和 teammate 每轮都有自己的 `turnId`，内部 `model.fork` 查询不会因取得新 `agentId` 而成为新的 turn。`turn.complete` 在登记释放后获取当前 hooks 和查询服务；它不能再取消刚结束的主 turn，子代理的完成文本也不会追加到主会话。取消查询仍可完成当前逻辑会话内的收尾；会话结束、切换或 runtime 卸载后，旧 turn 不会向新会话发送完成事件。这些边界已通过真实 QueryLoop、runAgent、teammate 和有界 fork 的源码验证；完整 compact/settings producer、普通父 step 中的 fork 以及原生制品对照仍待验收，详见 `mods-test.md`。

`complete` 的 `effort` 可选 `low`、`medium`、`high`、`xhigh` 或 `max`；仅对支持 effort 的模型发送，未指定时不添加新的请求默认值。`timeoutMs` 必须是正整数，实际计时最大为 2147483647 毫秒，从核心请求开始计时，超时返回 `aborted`。第二个参数可传 `{ signal: controller.signal }`，其中 `controller` 是插件内的 `AbortController`；信号对象和取消原因不进入 hook 输入，只传递所属调用的取消事件。已取消的信号不会发起请求，完成后的监听器会释放。父 turn 取消时，complete/fork 的调用结果为 `aborted`，fork 保留已测用量；外层 turn 仍按取消结束，classify 拒绝并指出 `aborted`。参数错误与中间件拒绝仍抛出异常。

当前源码和生成声明已覆盖这些选项；实际 SDK effort 请求、Worker 取消及超时回归已通过，新的 compiled 验收结果见 `mods-test.md`。官方 API 的其他缺口仍按上面的兼容性边界列出。

#### 读取主会话和 Agent 对话

在模块的 `register` 中注册命令，再在命令 hook 里调用读取接口。命令参数留空时读取主会话，指定 Agent ID 时必须检查拒绝结果：

```ts
import type { Register } from 'claude-code'

export const register: Register = on => {
  on('session.start', async ($, event, next) => {
    await $.command.register({ name: 'conversation', description: 'Inspect main or agent messages' })
    return next(event)
  })
  on('command.run', { command: 'conversation' }, async ($, event) => {
    const agentId = String(event.args ?? '').trim()
    const messages = agentId
      ? await $.session.messages({ agentId, as: 'api' })
      : await $.session.messages({ as: 'api' })
    if ('deny' in messages) return { text: messages.deny }
    return { text: JSON.stringify(messages, null, 2) }
  })
}
```

加载插件后执行 `/conversation` 或 `/conversation <agentId>`。ID 可来自 `agent.list()` 或 Agent tool use 的 `toolUses[].agentId`；仅在实际启动 Agent 后提供，已完成结果有测得的时长时还包含 `durationMs`。无参数读取和 `{ as: 'api' }` 主会话读取总是返回数组；带 ID 的读取检查 `deny` 区分消息与拒绝，拒绝时不替换为主会话。生成声明将消息表示为只读数组，使用 `'deny' in messages` 可完成 TypeScript 的拒绝分支收窄。

API 消息最多 4096 条，从 user 开始，反映最近一次 compaction 后引擎将用于下一次请求的内容。可同时使用 `{ agentId, as: 'api' }`；文本行用法为 `await $.session.messages({ agentId })`。这些格式与 Anthropic 的 [Messages API](https://platform.claude.com/docs/en/api/messages/create) 对应；每次发送的缓存标记仍由宿主根据 [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) 规则处理，读取不会改动原始对话。源码、声明与真实制品的验收范围分别记录在 `mods-test.md`。

#### 查询会话用量与首次启动时间

`await $.session.usage()` 返回 `context`、`rateLimits`、可用的 `cost` 和 `startedAt`。`startedAt` 始终返回 number，使用 epoch 毫秒；有启动记录的 resume/continue 保留原值，离开会话期间的文件修改也可据此判断归属。`/clear`、新会话和 `/branch` 使用各自的新时间。它与 `/cost` 累积活动时长的内部时钟分开，计费恢复不会改写首次启动时间；带 breakdown 的异步读取也保留调用时的快照。

```ts
import type { Register } from 'claude-code'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'session-age',
      description: 'Show the first launch time of this session',
    })
    return next(e)
  })
  on('command.run', { command: 'session-age' }, async $ => {
    const { startedAt } = await $.session.usage()
    return { text: new Date(startedAt).toISOString() }
  })
}
```

开启 transcript 持久化时，新会话将启动时间按 session ID 写入 `session-started-at` 元数据，压缩和恢复保留它；读取官方 transcript 时也接受同 session 的 `cost-state.startTime`，项目费用恢复接入 `lastStartTime`。分支使用自己的新时间。缺少启动记录的历史会话遵循官方 2.1.287 的活动时钟回退规则，返回恢复时刻减去已保存的活动时长（没有活动时长时使用当前会话时钟）；这个回退值不是可证明的历史首次启动时间，不应用它断言精确的历史编辑归属。首次 prompt 时间和文件创建时间不参与这个回退。公共声明保持官方的 `startedAt: number`。参考 [官方 Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)，实际可调用 API 仍以目标制品生成的声明为准。

#### 向其他 Mod 暴露函数

在 manifest 中增加 `"types": "./types/index.d.ts"`，以声明合并公开命名空间；调用方通过普通 plugin dependencies 引用提供方。`types/index.d.ts` 只包含自包含类型，例如：

```ts
export type Greeting = { read(input: { text: string }): Promise<string> }
declare module 'claude-code' {
  interface EngineInterface { greeting: Greeting }
}
```

对应 `hooks/register.ts` 可以构建接口，并在同一模块注册中间件和命令：

```ts
import type { Register } from 'claude-code'

export const register: Register = on => {
  on('engine.create', async (_, event, next) => {
    const built = await next(event)
    return { ...built, greeting: { read: async (input: { text: string }) => input.text } }
  })
  on('greeting.read', async (_, event, next) => {
    const result = await next(event)
    return 'deny' in result ? result : { value: result.value + '!' }
  })
  on('session.start', async ($, event, next) => {
    await $.command.register({ name: 'greet-mod', description: 'Run the greeting' })
    return next(event)
  })
  on('command.run', { command: 'greet-mod' }, async ($, event) => ({
    text: await $.greeting.read({ text: String(event.args || 'Hello') }),
  }))
}
```

自定义方法接收一个对象或不接收参数；可调用成员自动成为有类型的 `noun.method` hook，hook 返回 `{ value }` 或 `{ deny }`，而调用方读取解包后的方法返回值。`engine.create` 的第一参数尚未构建，读取接口应使用 `await next(event)`；生成类型保留这一阶段差别。接口只能在该 hook 的直接返回对象中公开，如示例的 `return { ...beneath, greeting: ... }`；不能枚举 `$` 或 `beneath`，也不能把包含它们的接口对象存入普通变量再返回。原样转发已有命名空间，不覆盖其他 Mod 或 engine 持有的命名空间。非函数字段不成为 hook，也不能作为运行时自定义命名空间成员发布。

#### 可复用测试 Mod

仓库自带 [`examples/mods/mods-test-lab`](examples/mods/mods-test-lab)，用于观察真实插件生命周期、命令、prompt/工具/turn 事件和 Pane 交互。构建后可在独立配置、私有 Git fixture 和 tmux 中启动，不读取个人认证或调用真实模型。`check/run` 当前需要 macOS `sandbox-exec`，`run` 另需已安装的 tmux；没有不隔离的 fallback：

```bash
make build
bun scripts/mods-test-lab.mjs check sample
bun scripts/mods-test-lab.mjs run sample
```

其他 Claude 正在使用仓库的制品时，使用独立构建目录；`output` 交给构建脚本创建，不要预先创建。后续运行、validate、test 必须使用同一个 `MODS_CLI`：

```bash
MODS_BUILD_ROOT=$(mktemp -d /private/tmp/mods-build.XXXXXX)
make build CLAUDE_CODE_BUILD_DIR="$MODS_BUILD_ROOT/output"
MODS_CLI="$MODS_BUILD_ROOT/output/built-claude"
"$MODS_CLI" plugin validate /absolute/path/to/my-mod
"$MODS_CLI" plugin test /absolute/path/to/my-mod
bun scripts/mods-test-lab.mjs run sample --binary "$MODS_CLI" --cache "$MODS_BUILD_ROOT/lab"
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

官方 `agents-md` 和 `telemetry` 保留固定 provenance 的 2.1.277 内置归档；diff 使用独立的 `assets/builtin-diff-2.1.295.zip`，校验完整模块、原样注册闭包、扫描元数据和归档来源后加载。归档缺失或校验失败会打印错误并恢复原生 diff。`telemetry` 默认关闭，只有设置 `CLAUDE_CODE_ENABLE_ANTHROPIC_TELEMETRY=1` 或在 `/plugin` 中启用时才加载。生产 Mods 不会获得当前会话的 Anthropic credential，`session.authorize` 恒返回空授权；只有隔离的 builtin acceptance fixture 会注入固定 dummy credential 并限定到 loopback transport。`sec-default` 的宿主实现保护当前已接线的 managed 事件；下载的官方原件用于作者兼容检查，不因其名称或 manifest 获得宿主身份。可用以下入口区分静态检查、手工启动和 compiled 行为验收：

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

最新 diff 归档可用 `bun scripts/package-official-diff.mjs VERIFIED_DECODED_MODULE_DIR NEW_ARCHIVE_PATH` 离线重现；输入必须是已核实的官方 2.1.292 完整模块，输出路径必须尚不存在。`[ModsBuiltin]` 调试记录包含版本、插件、storageId、归档及模块 SHA，加载失败另记录 phase 和 error。此操作仅生成归档，不替代构建及真实界面验收。

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


### 官方 diff 2.1.295 的离线归档与构建

`scripts/package-official-diff.mjs` 从已核验的官方完整模块生成 `assets/builtin-diff-2.1.295.zip`。它在写入前校验完整模块、身份模块、原始注册闭包和 compiled scan；输出使用固定 ZIP 时间，只创建新文件，拒绝覆盖或接受损坏输入。提取出的官方 JavaScript 不会由打包脚本执行。

```bash
bun scripts/package-official-diff.mjs /path/to/verified-2.1.295-modules /tmp/new-official-diff-295.zip
bun test ./scripts/shipped-diff-production.test.mjs ./scripts/build.test.mjs ./scripts/build-isolated.test.mjs
make build CLAUDE_CODE_BUILD_DIR=/tmp/new-claude-build
```

构建会把该归档同时复制到 `dist/assets` 并嵌入 standalone 二进制，保留已有 `builtin-mods-2.1.277.zip`。归档、构建和运行时接管分别验收；完整 diff UI 对齐仍按 `mods-test.md` 的范围记录。官方版本参考 [Anthropic changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)。

## 官方 Mods 接管 diff

生产启动从内嵌的 `builtin-diff-2.1.295.zip` 校验并加载原始 `cc-plugin-diff` Worker。在全屏 Git 工作区输入 `/diff` 打开或关闭面板。原生 diff 的已保存打开偏好只迁移一次；用户明确关闭后清除请求状态。活跃官方插件接管时，原生 diff 面板与后台刷新暂停；禁用、拒绝或卸载后恢复原生命令。

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

公开 `$.tool.check({tool, input})` 返回权限决定；`reason` 只在底层决定提供实际原因时出现。bypass 模式的允许结果是 `{decision:"allow"}`；匹配规则通过 `rule` 提供，不重复生成原因文字。核心回执省略空原因；插件显式返回的空 `reason` 则保留。ask／deny 保留实际审批或拒绝原因，权限查询不会执行工具或弹出审批。

`tool.check` hook 的 `next(e)` 还会返回权限来源：`rule` 保留设置中的规则原文，嵌套子命令按最终裁决寻找首条匹配规则；allow／ask 可回退到实际命中的 ask 规则，deny 不借用该规则。真实工具调用经过经典 Hook 时，`hook` 为 `PreToolUse`、`PermissionRequest` 等事件名；在经典 PreToolUse 的 ask 限制下产生的裁决也保留该来源。公开 `$.tool.check` 查询本身不运行经典 Hook，因此 core 的查询回执不带 `hook`。经典命令 Hook 的阻止消息使用 `PreToolUse:<工具名> hook error: <原因>` 格式，格式化后仍保留实际策略来源。

`tool.check` hook 调用 `next(e)` 后保持相同 decision 时，真实工具权限保留原裁决来源和已批准的输入；非空 `reason` 可以替换 ask／deny 的显示消息，空字符串不会清除原拒绝原因。未调用 `next(e)` 时，不采用核心尚未返回给插件的输入改写。hook 改变裁决时，拒绝显示 `Permission to use <工具名> denied by plugin <插件名>: <原因>`，审批显示 `<工具名> needs approval (asked by plugin <插件名>: <原因>)`。多个匹配插件使用 `plugins A, B`，包括因短路未执行的匹配 hook；同一插件只列一次，不匹配的 hook 和被排除的调用者不列入。省略 `reason` 不添加冒号，显式空字符串仍保留 `: `。

真实调用的 `tool.check` 带本次 `tool_use_id`，子 Agent 循环中还带与 `tool.call` 相同的 `agentId`；主循环、插件主动工具调用和公开权限查询不携带 Agent 身份。调用 `next(e)` 时，省略 `tool_use_id`、`agentId` 或 `ceiling` 会恢复收到的值；显式改成不同值（包括把已有值设为 `undefined`）则拒绝。`tool` 和 `input` 同样固定，输入按内容比较，可以传入等值副本。拒绝抛出带实际 hook 插件名及被改字段名的 `HooksError`；插件不能借权限查询替换被检查的调用。

作者 `$.tool.call({tool, ...args})` 返回最终工具消息的 `{result, text}`；普通工具执行失败带 `isError: true`，权限或插件拒绝返回 `{deny}`。错误文字即使包含“Permission denied”，也不会被误当成拒绝。合成结果同样通过工具 mapper 生成 `text`。`ref`、`isReadOnly` 和 model-only `context` 保留在 middleware 的 `next(e)` 回执中，作者公开调用不返回这些内部字段。 当前 session 不提供的工具会抛出 `HooksError`，消息为 `<插件名>: $.tool.call: no tool named "<工具名>" in this session`；`$.tool.check` 使用对应的方法名。错误中的插件名由宿主传入，不能通过工具参数改写。

运行 `bun test ./src/services/mods/dispatch.test.ts`、`bun test ./src/services/mods/toolHost.test.ts`、`bun test ./src/services/mods/runtimeTools.test.ts`、`bun test ./src/services/mods/toolCheckReason.test.ts` 和 `bun test ./src/services/tools/toolHooks.test.ts`，检查匹配插件名单、真实 Worker 身份边界、作者入口、经典 Hook 生产路径及权限来源。`--debug-file /absolute/path/mods-debug.log` 中的 `[ModsToolCheck]` 记录工具、tool use ID、Agent ID、检查阶段、核心是否被调用、hook 裁决及匹配插件名，不打印参数或原因正文。固定官方 2.1.292 的十一组真实 CLI 场景中，权限查询、作者调用和插件事件记录逐项一致，覆盖多插件短路、重复注册、matcher、同裁决改写及空原因；不可用工具的三项错误对照也一致。另外四个真实 CLI 场景按调用 ID 核对了子 Agent 身份、公开查询、缺省元信息恢复及完整拒绝错误，均与官方一致；原始请求交错仍有差异；控制子任务返回时机后，官方和本地均会产生额外完成请求，因此不以请求次数单独判定流程失败。connector ceiling 的策略数据源、取消和完整 Agent／工具生命周期继续独立验收。

### Mod 子任务的完成通知

`$.agent.spawn({prompt, ...})` 在任务启动时返回身份回执。宿主从根任务表认领该本地子任务的完成通知，结果通过 `turn.complete` 提供；完成后不会再把同一结果入队为主会话通知并自动发起额外查询。作者可以按返回的 `agentId` 筛选完成事件，并使用 `e.answer` 展示或处理结果。

此认领只用于公开 Mod spawn 对应的本地任务。普通 Agent 工具的后台完成通知继续送达；teammate 和 remote task 使用各自的生命周期。子任务上下文优先使用 `setAppStateForTasks` 写入根任务表，不改变当前权限视图。

使用 `--debug --debug-file /absolute/path/debug.log` 查看 `[ModsAgent] claimed completion notification`，日志包含 task ID、agent ID 和插件名，不包含任务正文。运行 `bun test ./src/services/mods/toolHost.spawnNotifications.test.ts ./src/tasks/LocalAgentTask/LocalAgentTask.progress.test.ts` 检查通知归属、三种终态和普通通知控制组。完整错误／取消／嵌套及 Workflow 矩阵继续按 `mods-test.md` 验收。

### Agent 启动回执与异步通知

模型通过 Agent 工具启动后台任务时，`tool_result` 是内部启动信息，不能把原始回执或 Agent ID 直接展示给用户。续接 Agent 时，使用 `SendMessage` 的 `to` 和 `summary`。收到完成通知前，启动回执不提供任务结果；可以继续其他工作或回复用户，询问进度时说明任务仍在运行。

调用者有 Read／Bash 且输出路径非空时，回执包含 `output_file`；该文件是完整子任务 JSONL，不应使用 Read 或 shell 读取／跟踪来查询进度，应等待完成通知。缺少读取工具或路径为空时，返回不含文件路径的说明。此工具回执与 `$.agent.spawn` 的身份回执分别验收，Mods 仍可通过真实工具 middleware 观察工具结果。

运行 `bun test ./src/tools/AgentTool/AgentTool.receipt292.test.ts` 核对完整文字及空路径回退。固定官方 2.1.292 的两组真实 CLI 场景中，默认启动回执文字逐字一致，仅归一化实际子 Agent ID 和对应输出路径；Messages 的缓存字段、条件共享目录提示、其他结果分支与完整生命周期仍待独立验收。异步任务的请求交错受完成时机影响；延后子任务返回时，双方都需要再次处理完成通知，不能把单次运行的请求数量作为唯一判据。

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


### 官方 diff 2.1.295 的当前固定来源

当前生产归档为 `assets/builtin-diff-2.1.295.zip`，包含官方完整模块、身份模块、编译扫描元数据及原始注册闭包。加载和离线打包均核对固定字节范围与 SHA-256；过期或损坏归档会记录 `[ModsBuiltin]` 错误并保留原生 diff。旧归档仅用于历史来源核对。

```bash
bun scripts/package-official-diff.mjs /path/to/verified-2.1.295-modules /tmp/new-official-diff-295.zip
bun test ./scripts/shipped-diff-production.test.mjs ./src/plugins/bundled/shippedDiffStartup.test.ts ./src/services/mods/diffTakeover.test.ts
make build CLAUDE_CODE_BUILD_DIR=/tmp/new-claude-build
```

在全屏 Git 工作区输入 `/diff` 打开或关闭官方模块的面板；settings 的 `cc-plugin-diff@builtin` 开关及 `diff@builtin` 别名沿用原契约。使用 `--debug --debug-file /tmp/claude-diff-debug.log` 可核对加载版本、来源哈希与接管状态。

`Ctrl+X B` 切换比较 base，`Ctrl+↑/↓` 滚动文件列表。Pane 的 action 在绘制提交阶段登记，重绘后使用当前 drawing；`[ModsPaneAction]` 调试日志记录动作、绘制代次及准入状态，不记录输入正文。提交时序回归可运行 `bun test ./src/components/ModsPane.actionCommit.test.tsx`。

官方最新来源核对见 [Anthropic package metadata](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)，使用背景见 [Anthropic plugins 文档](https://code.claude.com/docs/en/plugins)。此升级原样加载官方 2.1.295 diff 注册闭包，使用最新 dock 行数与滚动计算，移除旧版顶部留白。公开声明基线及完整 API/UI 对齐仍须独立验收，详见 `mods-test.md` 和 [diff 2.1.295 来源与边界](docs/research/mods-shipped-diff-295-20261010.md)。


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

`onPress` 收到 `ui.press` 参数，含插件、控件键、surface、component 和 requestId。焦点参数携带插件与控件键。历史官方 2.1.292 对照中，不同插件复用同一键时焦点事件与 Enter actor 曾不一致。官方 2.1.293 的定向原生对照改为按 plugin 与 key 落到作者控件；本地采用该已核实行为。插件应使用不同控件键来避免这种歧义。官方 2.1.292 的 `display: 'none'` 保留控件注册，隐藏控件也可能获焦点及接收 Enter；不希望它参与焦点时，应从绘制树中省略它。

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


### Mod 模型文本块与完成回执

在命令或其他可调用 Hook 中使用 `$.model.complete`：

```ts
const reply = await $.model.complete({
  model: 'sonnet',
  system: [{ text: 'Summarize the supplied data briefly.', cache: true }],
  prompt: [{ text: 'Shared context\n', cache: true }, { text: event.args }],
  maxTokens: 1024,
  effort: 'low',
  timeoutMs: 10_000,
})
if (reply.isAnswered) $.ui.log(reply.text)
else $.ui.log(reply.reason)
```

成功回执为 `{ isAnswered: true, text, usage }`；核心失败以 `isAnswered: false` 返回 `empty-reply`、`aborted` 或 `api-error`。四项 usage 保留实际计数，未提供的计数为零；API 错误只提供 `status` 和分类，不返回错误正文或 headers。非法参数、模型准入拒绝和 Hook 的 `{deny}` 仍拒绝调用。JavaScript Hook 可覆盖 `{value}`，作者不能假设它一定来自核心；生成 TypeScript 声明仍使用精确的官方结果类型。

作者的 prompt/system 接受字符串或 `{text, cache?: true}[]`。Hook 收到合并的字符串及对应的 promptBlocks/systemBlocks，可以改写字符串；请求只为仍匹配的新文本前缀保留原缓存标记，剩余文本不加标记。空列表合并为空字符串，未配对 UTF-16 在发送前修复。`DISABLE_PROMPT_CACHING=1` 或现有模型缓存开关生效时，请求中的缓存标记会被移除；这不改变 Hook 看到的块。JavaScript 的 cache:false 也作为无标记处理，公开声明的 cache 仍只允许 true。

`timeoutMs` 接受正整数，实际计时最大为 2147483647 毫秒；从核心请求开始计时，Hook 执行使用自己的预算。超时返回 aborted。effort 使用官方五个名称，按现有模型能力选择是否发送。已取消的作者 signal 可以在调用前阻止请求；完整在途取消、其他 provider 能力和 fork/classify 最新行为仍按专项验收范围检查。

使用 `--debug --debug-file /absolute/path/debug.log` 查看 `[Mods] model.complete`：包含模型、字符长度、块数、结果、HTTP 分类和用量。运行 `bun test --no-env-file ./src/services/mods/modelTextBlocks.test.ts ./src/services/mods/modelResults.test.ts ./src/services/mods/modelOptions.test.ts` 检查相关契约；[专项对照](docs/research/mods-model-complete-292-20261007.md) 列出实际覆盖与剩余差异。接口背景见 [Anthropic Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)。


### Mod 分类器与分类 Hook

```js
on('prompt.submit', async ($, e, next) => {
  const kind = await $.model.classify(e.text, ['bug', 'feature'])
  if (kind === undefined) return next(e)
  $.ui.log(`分类：${kind}`)
  return next(e)
})
```

`classify(text, labels, { model })` 要求至少两个非空字符串标签，默认使用引擎的小型快速模型，也可指定别名或模型 ID。公开 `model.classify` Hook 可以改写文本、标签和模型，或返回 `{value}` / `{deny}`；底层分类推理直接调用核心服务，每次分类不会再派发公开 `model.complete` 事件。直接调用 `$.model.complete` 仍走它自己的 Hook。

按官方 2.1.292，分类提示词把每一行文本标成数据，使用 20 个基础输出 token。回复去掉首尾空白、引号和尾部句点，先进行大小写无关的完整匹配，再按标签长度选择有边界的命中，返回标签原来的拼写；重复标签允许，长度相同时保持输入顺序。未命中返回 `undefined`；空回复、请求错误、取消和策略拒绝抛出 `HooksError` 并指出原因。初始文本与标签列表形状在 Hook 前检查，标签内容在核心检查，Hook 可以修复标签。最终交给核心的数据仍检查文本和标签列表的形状；JavaScript Hook 的 `{value}` 保持不透明，公开 TypeScript 类型仍限定分类结果为标签或 `undefined`。

`--debug --debug-file /absolute/path/debug.log` 中的 `[Mods] model.classify` 记录插件、模型、文本长度、标签数量、命中索引或失败原因，不新增正文日志。运行 `bun test --no-env-file ./src/services/mods/modelClassify.test.ts ./src/services/mods/modelRuntime.test.ts` 检查分类和真实 Worker 路径。原生对照范围与剩余限制见 [分类器专项](docs/research/mods-classify-292-20261007.md)；公开类型以本版本生成的声明为准，参考 [Anthropic Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)。


### Mod 模型完成参数与错误

`$.model.complete` 的 `maxTokens`、`timeoutMs` 必须为正整数；`effort` 支持 `low | medium | high | xhigh | max`。输出上限取解析后模型的单次回复限制与 64000 中较小者。超长 deadline 的实际 timer 钳制到 2147483647 毫秒，完成后清理。Hook 可以先改写参数，最终请求仍按输入形状、输出整数、deadline、effort、允许列表、输出上限的顺序检查。

```ts
on('command.run', { command: 'summarize' }, async ($, event) => {
  const answer = await $.model.complete({
    model: 'sonnet', prompt: event.args, maxTokens: 128,
    effort: 'low', timeoutMs: 2000,
  })
  if (answer.isAnswered) $.ui.log(answer.text, { to: 'debug' })
  return {}
})
```

参数错误和策略 `deny` 抛出 `HooksError`，包含调用插件名；API、空回复和请求取消继续使用此前定义的结构化回执。模型允许列表忽略解析名称中的 `[1m]` 上下文标记。JavaScript 的非有限数值可以进入 Hook 修复；最终模型参数仍按正整数规则拒绝。模型字符串交给已有解析器，包括空字符串；这表示 Mods 不提前拒绝，不保证真实服务会接受空模型名。未知第一方模型在完成请求中留出 2048 个 thinking token；`CLAUDE_CODE_MODEL_CAPABILITIES` 的 `rejects_disabled_thinking` / `-rejects_disabled_thinking` 控制该决定，已知允许关闭 thinking 的旧模型保留官方优先规则。

调试日志记录模型、请求输出、实际 cap、thinking 余量和钳制后的 deadline。运行 `bun test --no-env-file ./src/services/mods/modelValidation.test.ts ./src/services/mods/modelOptions.test.ts ./src/services/mods/modelRuntime.test.ts` 检查参数和 Worker 路径。精确原生验收与限制见 [模型参数专项](docs/research/mods-model-params-292-20261007.md)，作者类型参考 [Anthropic Mods reference](https://code.claude.com/docs/en/plugins/mods/reference) 及安装版本生成的声明。


### 模型完成的独立取消信号

把插件自己的 `AbortController` 留在后续处理函数可访问的位置，用 `{ signal: stop.signal }` 取消该次完成：

```ts
const stop = new AbortController();
const pending = $.model.complete({ model: "haiku", prompt: "Summarize this text" }, {
  signal: stop.signal,
});
// 在后续 Cancel 处理函数中调用；其他完成调用继续运行。
stop.abort(new Error("Cancelled by the plugin"));
const reply = await pending;
if (!reply.isAnswered && reply.reason === "aborted") {
  // 当前调用已取消。
}
```

信号属于 options，模型 Hook 的 `e` 中没有 `signal`。已取消的信号优先于请求检查，不派发模型 Hook、不发送请求；普通完成或核心超时/取消的回执和用量可修改，作者端提前取消或 Hook 取消返回共享冻结回执。信号 getter 只读取一次，结算后移除监听器。JavaScript 会忽略未使用的 options 与额外参数，但公开 TypeScript 仍要求 `ModelCompleteOptions` 的 `signal?: AbortSignal`；非法信号报带插件名的 `HooksError`。模型 Hook 在处理取消时仍可用 `$.ui.log(..., { to: "debug" })` 输出最终诊断。

本批次验证命令：`bun test --no-env-file ./src/services/mods/modelSignals.test.ts ./src/services/mods/modelLocalCancellation.test.ts ./src/services/mods/modelAbort.test.ts`。精确原生对照和未覆盖范围见 [取消专项](docs/research/mods-model-signals-292-20261007.md)，作者契约参见 [Anthropic Mods reference](https://code.claude.com/docs/en/plugins/mods/reference) 和插件生成的声明。

### Mods 模型 fork 与父轮次取消

`$.model.fork({prompt})` 在已有主会话响应后使用保存的会话快照。不要将结果当作 `null | {text, usage}`；按 `isAnswered` 和 `reason` 分支：

```ts
const answer = await $.model.fork({prompt: '检查当前讨论中的遗漏'})
if (answer.isAnswered) {
  $.ui.log(answer.text)
} else if (answer.reason === 'nothing-to-fork') {
  $.ui.log('主会话还没有可复用的响应')
} else if (answer.reason === 'api-error') {
  $.ui.log(`模型请求失败：${answer.status ?? 'unknown'} / ${answer.error}`)
} else {
  $.ui.log(`模型未回答：${answer.reason}`) // empty-reply 或 aborted
}
```

fork 沿用快照模型和工具定义；工具调用由权限回调拒绝，最多运行两轮，不写侧链 transcript 或新 prompt cache。`nothing-to-fork` 不含 usage；其他结果含四个 token 字段。回复按 assistant 消息顺序连接，每条消息的文本块用换行连接并 trim，已有有效文本优先于后续 API 错误。

在 `turn.step` hook 中调用模型时，父轮次取消会传入 `next.signal`：模型核心中的 complete/fork 返回普通可修改的 `aborted` 回执；classify 抛出 `${plugin}: $.model.classify: the request was aborted`。若取消发生在模型 Mods hook 内，则调用拒绝为 `HooksError: user-cancel`，finally 可读取相同的 `next.signal.reason` 并写日志。调用者自己的 complete `options.signal` 仍使用共享冻结取消回执，详见上一节。

对照来源为官方 2.1.292 原生制品和生成的作者声明；[验收边界与证据](docs/research/mods-model-parent-fork-292-20261007.md)。SSE 部分 usage 字段的协议见 [Anthropic Streaming 文档](https://platform.claude.com/docs/en/build-with-claude/streaming)。完整请求上下文和所有 UI/diff 行为仍在逐项验证。

### Mods 宿主取消原因

嵌入方调用 `runtime.dispatch(..., {signal})` 或 `runtime.stream(..., {signal})` 时，取消会保留原始 `signal.reason`；trusted host callback 发起的嵌套操作继承该原因，局部 `$.clock.sleep(ms, {signal})` 也保留其取消原因。跨 Worker 的错误仍按公开协议传递，不能依赖跨 realm 的对象身份。回调结束后能力失效，取消继续回收所属进程，并有界等待 stream 收尾。源码回归、真实 CLI 相邻验证和未完成兼容范围见[取消与缺口复核](docs/research/mods-cancellation-audit-292-20261008.md)。

## Mods 测试环境隔离

`prompt.compose` 与 `model.fork` 的以下回归自行设置占位凭据及独立临时 HOME/config/XDG 目录，运行结束恢复原环境并清理自有目录。可以直接在没有 API key 的环境运行，不需要修改用户认证配置：

```bash
bun test --no-env-file ./src/query.promptCompose.test.ts
bun test --no-env-file ./src/services/mods/modelFork292.test.ts
```

这些是模型替身驱动的源码回归；完整运行时、UI、官方 diff 和 G5 验收仍需对应的真实入口证据。详见 [测试隔离记录](docs/research/mods-test-isolation-20261007.md)。

## Mods 轮次完成 checkpoint

官方 2.1.292 的普通主轮次完成后，即使耗时不足 30 秒，也在原始历史中记录 `turn_duration`。本地已移除旧门槛：未取消的普通轮次都会记录；swarm 仍在运行时继续等待。本地非查询命令、查询前拒绝、取消与自动循环轮次不记录模型完成 checkpoint。调试模式可查找 `[turn-duration] completed elapsedMs=`，日志不包含输入或回复正文。

`showTurnDuration` 控制现有完成时间行的显示，隐藏该行也保留历史 checkpoint。它可增加下一轮 `turn.step.messageCount`，但不成为 API 请求或 `$.session.messages` 的聊天条目。不要把该计数与公共聊天条目数量等同。

```bash
bun test --no-env-file ./src/screens/REPL.turnCheckpoint292.test.ts
```

[本批验证与已知差异](docs/research/mods-turn-checkpoint-292-20261007.md)区分准确提交候选、工作区与官方。完整附件、官方 `· done` 时间显示和其他原生 `ui.render` 站点继续对齐；当前结果不代表完整上下文或 UI 已一致。

## Mods 原生完成行的绘制

`ui.render` 现在可以拦截真实的 `TurnDuration` 消息行。`e.requestId` 是该消息的 UUID；`e.props.word` 是按 UUID 稳定选择的完成动词，`e.props.durationMs` 是原始耗时。可取得时还传递实际终端的 `viewport`。全屏 transcript 可见性已知时，`e.props.onScreen` 包含从 0 开始的 `first`、包含末行的 `last` 和绘制总行数 `of`；完全离开视口时为 `null`，未知时不添加字段。它描述实际绘制；`next(e)` 添加、删去或改写该字段会被拒绝，插件应保留收到的只读上下文。

在插件 `hooks/register.ts` 中注册：

```ts
export function register(on) {
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e)
    return Box({
      flexDirection: 'column',
      children: [
        Text({ children: '本轮已完成' }),
        await next({ ...e, props: { ...e.props, word: 'Completed' } }),
      ],
    })
  })
}
```

`next(e)` 保留原生行，也可在一个自定义树中使用多次；改写 `word` 或 `durationMs` 只影响这次绘制，不修改历史 checkpoint。返回 `Text` 可替换整行，返回空 `Box` 可隐藏。即使配置 `showTurnDuration=false`，插件仍能替换完成行。按作者声明构建 Client、按钮等组件时，宿主保留其绘制和回调的生命周期；卸载、重载或失效的旧绘制不能继续操作新行。


异步绘制应使用 `next.signal` 取消等待，例如 `await $.clock.sleep(500, { signal: next.signal })`。原生站点的新输入、`$.ui.invalidate('ui.render')` 或组件卸载会中止旧绘制；Worker 内的原因是 `HooksError: ui.render: superseded`。已有画面在新绘制等待时继续显示，新画面提交后才释放旧回调；相同输入不重新调用钩子。不要把被取消的绘制作为成功结果，也不要在旧绘制中继续更新状态。源码、实际终端 resize、重复失效和 `/clear` 的对照见[绘制生命周期验收](docs/research/mods-render-lifetime-292-20261007.md)；作者参数和类型以[官方 Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)及生成声明为准。

没有匹配当前输入的 `ui.render` 钩子时，完成行直接走原生绘制。实际终端和源码对照范围见[本批验收](docs/research/mods-native-duration-292-20261007.md)。其他原生组件和官方完成时间/后台等待格式仍需后续对齐；本节不宣称所有 UI 或 diff viewer 已匹配。


## Mods 助手文本行

真实助手回复现在触发 `ui.render` 的 `AssistantMessage`。`e.requestId` 是会话中该消息的 UUID；`e.props.text` 是移除隐藏分析块和 cc-memory 标签外壳后的显示正文，`e.props.isFirstOfReply` 控制首行标记。实际可用的终端 `viewport` 和全屏 `onScreen` 仍由宿主传递。

```js
on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
  const { Box, Text } = $.ui.resolve(e)
  return Box({ flexDirection: 'column', children: [
    Text({ children: '插件提示' }),
    await next({ ...e, props: { ...e.props, text: '**重新绘制的回复**' } }),
  ] })
})
```

`next(e)` 保留原生 Markdown 和错误消息处理；可多次调用以绘制不同文本，也可直接返回自己的树。这些改写只影响显示，原始会话正文仍保存。`isSummary`、`onScreen` 和消息身份由宿主确定；不得在普通行中添加 `isSummary: true`。非法续绘或自定义树失败时回退原生回复。

[本批验收](docs/research/mods-assistant-text-292-20261007.md)记录准确提交候选、工作区和官方制品的独立证据。narration 摘要见下节；其他原生消息站点、完整模型显示适配及 diff viewer 继续对齐。


## Mods narration 摘要

非空 narration thinking 块在普通及展开视图中均触发 `AssistantMessage`，并带宿主确定的 `e.props.isSummary === true`。签名分类只用于显示；插件收到清理后的正文，不修改原始 thinking 或 signature。普通私有 thinking 保持其展开规则。

```js
on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
  if (!e.props.isSummary) return next(e)
  return next({ ...e, props: { ...e.props, text: '**摘要显示正文**' } })
})
```

`isSummary` 保留为只读字段，不能删除、设置 false 或加入普通行。`next(e)` 使用原生摘要 Markdown 和模型相关的 “· summary” 标记；直接返回插件树时，其内容由插件绘制。`isFirstOfReply` 可改写以控制首行标记，空显示文本可隐藏该次原生续绘。

已签名的非空 narration 消息完成时，宿主清空其短时 thinking 预览，再交给原生消息行和 Mods 绘制，避免摘要在普通视图或 transcript 中出现两份。普通私有 thinking 的预览保留规则沿用现有路径；本批完成交接与剩余流式差异见[验收记录](docs/research/mods-summary-handoff-292-20261007.md)。

`maxProseWidth` 是可选的终端列数设置，整数且至少 40。摘要 prose 按该宽度换行，顶层代码和表格保留终端宽度；不在保存正文中增加换行。当前已接线的消费者与尚未验证的复杂 Markdown、模型缓存和动态桌面路径见[本批验收](docs/research/mods-assistant-summary-292-20261007.md)。


## Mods 执行型工具测试

在仓库内编写会经过真实 executor 的 Mods 测试时，用 `buildTool` 创建 Tool，补齐 schema、描述、prompt、调用、结果映射和渲染方法。不要用 `as unknown as Tool` 把不完整对象送入执行器；只读分类、权限和取消等默认方法由生产构造函数补齐。

```ts
import { buildTool } from './src/Tool.js'
import { z } from 'zod/v4'

const fixtureTool = buildTool({
  name: 'FixtureTool',
  inputSchema: z.object({ value: z.string() }),
  maxResultSizeChars: Infinity,
  description: async () => '测试工具',
  prompt: async () => '测试工具',
  renderToolUseMessage: () => null,
  call: async (input: { value: string }) => ({ data: input }),
  mapToolResultToToolResultBlockParam: (data: { value: string }, id: string) => ({
    type: 'tool_result', tool_use_id: id, content: data.value,
  }),
})
```

需要在测试中替换 `call` 以观察取消或进度时，显式标注 `Tool<typeof inputSchema, Output>`，保留 executor 的完整回调签名。这是仓库测试的内部构造方式；插件作者的公开工具接口仍见前面的 Mods API 用法。当前 query/tool 测试定义修正、保留的主动 abort 失败和官方真实终端差异见[验收记录](docs/research/mods-query-tool-fixtures-20261007.md)。


### turn.step 主动取消与收尾

`$.turn.abort({turnId:e.turnId})` 取消当前 turn 的模型和工具，不添加用户中断提示。调用成功后 hook 仍应处理 `next.signal` 并返回合法结果；取消期间输出的 text chunk 可以进入显示、历史和 `turn.complete.answer`，返回结果的 `answer` 不会替代实际输出。

```js
on('turn.step', async function* ($, e, next) {
  yield {kind: 'text', index: 0, text: '本轮已停止。'}
  await $.turn.abort({turnId: e.turnId})
  // next.signal.aborted 为 true；reason.message 为 turn-abort。
  return {
    turnId: e.turnId, index: e.index, answer: '',
    toolUses: [], stopReason: 'end_turn', usage: null,
  }
})
```

公开 stream 有有限的取消收尾时间，应及时结束并清理资源；显式 iterator `return()` 和 runtime disposal 会立即开始取消并等待清理。没有完整消费 `next(e)` 的 hook 必须返回合法 `TurnStepResult`，省略返回会诊断并回退，取消后不会因此再发主模型请求。真实 hook/模型错误仍保留错误信息，不因为 signal 已取消就全部吞掉。

合法返回、协作取消、缺少返回、真实异常与模型清理的测试、官方源码依据和终端对照见[主动取消专项](docs/research/mods-stream-abort-parity-292-20261007.md)。前一批记录的 self-abort 缺口由此专项继续验收；远程 attach/detach、完整 UI/diff/G5 和全量 WIP 的结果另行记录。


## Mods 远程客户端连接（stream-json）

### 启动时传入插件

由 SDK 父进程在启动时写入首条 `initialize` 请求，并启用 `--await-initialize`，即可在命令、Mods 和 MCP 发现之前登记本次会话的插件路径：

```bash
printf '%s\n' '{"type":"control_request","request_id":"init","request":{"subtype":"initialize","plugins":[{"type":"local","path":"/absolute/path/to/plugin","skipMcpDiscovery":true}]}}' |
  ./built-claude -p --verbose --input-format=stream-json --output-format=stream-json --await-initialize
```

将示例路径替换为已有插件目录、父目录或 ZIP。每项必须为 `{type:"local", path:string, skipMcpDiscovery?:boolean}`；相对路径按启动工作目录解析。`skipMcpDiscovery:true` 跳过 `.mcp.json`、manifest 及 MCPB 的 MCP 发现，保留插件的其他内容。`--plugin-dir` 与初始化目录合并；同一路径同时以普通和跳过 MCP 的方式登记时，普通加载仍会发现 MCP。

调用方已管理 MCP 连接时，也可用隐藏选项 `--plugin-dir-no-mcp <path>` 登记跳过 MCP 的会话来源；重复参数可登记多个路径，无需 `--await-initialize`。它与初始化请求中的跳过 MCP 来源合并。解析后相同的 `CLAUDE_CODE_PLUGIN_DIRS` 来源会被排除；显式普通 `--plugin-dir` 或 SDK 普通来源仍会发现 MCP。管理员的 `disableSideloadFlags` 同样拒绝此选项。

会话路径支持单个插件目录、父目录和 ZIP（扩展名忽略大小写）。父目录按名称展开具有 `.claude-plugin/plugin.json` 的非隐藏直接子目录；根目录自身构成插件时优先加载该插件。ZIP 可包含一层包装目录，包装判断忽略 `__MACOSX` 和 `.DS_Store`。归档从本次会话的临时缓存加载，退出时清理；内容变化时整体替换，损坏或越界归档不会覆盖已有缓存。预览归档更新时使用独立目录，不替换运行中的版本。

首条非空白行必须是完整的 initialize JSON，并以换行结束；其内容及后续输入会继续交给 SDK 处理。EOF 前没有换行时，不应用其中的启动插件，initialize 请求本身仍会被处理。此开关仅用于本地非 TTY 的 `stream-json` 输入，不用于远程 `--sdk-url` 传输。

initialize 成功回执中的 `plugins_applied` 表示所列路径是否全部属于对应类别的启动来源；它不保证目录存在、插件有效或 MCP 握手成功。未列出插件或空数组时省略此字段。不启用开关时，`initialize.plugins` 不加载插件；重复 initialize 也只返回此状态，不会追加新插件。管理员的 `disableSideloadFlags` 策略同样拒绝这个启动入口。

本项按固定官方 2.1.292 的本地 stdio 行为验收；完整 SDK 初始化字段、远程传输及 MCP 故障恢复生命周期继续单独验收。

将以下 JSON 行保存为 `requests.jsonl`；每条请求的 `request_id` 应唯一：

```json
{"type":"control_request","request_id":"init-1","request":{"subtype":"initialize"}}
{"type":"control_request","request_id":"attach-1","request":{"subtype":"ui_attach","surface":"desktop","client_id":"desktop-main","viewport":{"columns":90,"rows":30,"isFullscreen":true}}}
{"type":"control_request","request_id":"detach-1","request":{"subtype":"ui_detach","client_id":"desktop-main"}}
```

使用 stdin 管道启动（EOF 会结束会话并移除剩余连接）：

```bash
cat requests.jsonl | claude -p --input-format stream-json --output-format stream-json --verbose --plugin-dir /path/to/plugin
```

远程 surface 为 `desktop`、`mobile` 或 `vscode`；客户端 ID 限 1–64 个 ASCII 字母、数字、`.`、`_`、`-`，冒号保留给引擎。viewport 的列、行须为正整数。attach 回执为 `{surfaces:[...]}`，detach 回执为 `{detached:boolean,surfaces:[...]}`。重复 attach 不重复通知 hook；未知客户端的 detach 返回 `detached:false`。显式连接独立于单个绘制站点，结束时自动移除。

`session.attach` 和 `session.detach` 是观察事件：调用 `$.session.surfaces()` 已能看到更新后的 roster，`next(e)` 不负责提交连接，返回伪造 clientId、抛错或取消通知也不会回滚传输状态。终端 binding 不发 attach；session.end 的 detach 使用 `reason:'end'`。调试日志可查找 `[ModsUIClient]`。

当前入口接通全部18类客户端控制，包括连接、绘制、回调、Client 模块、Pane、滚动、焦点及 prompt 控制。五类远程 responder 和完整 UI/diff 继续实现与验收；已接通控制的有限对跑见下文专项。`answers` 只接受官方声明的五类 responder 名称，数组最多 5 项（重复值仍合法），不能据此认为 responder 已实现。实际 SDK 协议对照与限制见 [远程连接专项](docs/research/mods-remote-roster-292-20261007.md)，作者事件定义见 [Anthropic Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)。


### SDK 远程 UI 协议类型与校验

开发客户端协议时，从 `src/entrypoints/sdk/controlTypes.ts` 使用有限的 `SDKControlUIRequest`，并用 `SDKControlUIResponseFor<Request>` 关联回执。18 类客户端请求与 5 类引擎发给客户端的 responder 请求分别为 `SDKControlUIClientRequest` / `SDKControlUILoopRequest`。同名 Zod schema 从 `controlSchemas.ts` 导出；这些是仓库内部协议定义，不是额外的作者 `$` capability。

下面的代码只构造并校验协议数据：

```ts
import type { SDKControlUIRenderRequest, SDKControlUIResponseFor } from './src/entrypoints/sdk/controlTypes.js'
import { SDKControlUIRenderRequestSchema } from './src/entrypoints/sdk/controlSchemas.js'

const request: SDKControlUIRenderRequest = {
  subtype: 'ui_render', surface: 'desktop', component: 'ToolUse',
  instance_id: 'tool-1', props: { input: { command: 'pwd' } }, on_screen: null,
}
const parsed = SDKControlUIRenderRequestSchema().parse(request)
type RenderResponse = SDKControlUIResponseFor<typeof request>
```

绘制回执含 `tree`、`props`、`rewritten` 和 `hooked`，可带插件到 hash 的 `client_modules` 及 `bench`；客户端模块回执另含 entry、runtime、limits 和 files。树通过 handle 传递回调，通过路径传递 Client 模块。pane roster 的三个 nullable ID 和 focus 的 nullable element 都是必填字段；`ui_message.data` 必须存在，`null` 合法。输入校验与绘制、客户端资源及 hook 的运行时语义分别验收。

执行 `make check-mods-control-types` 做独立严格类型检查；`make release-check` 已包含此项。协议回归：

```bash
bun test --no-env-file ./src/entrypoints/sdk/controlSchemas.mods.test.ts ./src/entrypoints/sdk/controlSchemas.ssh.test.ts ./src/services/mods/remoteUiControl.test.ts
```

协议定义覆盖其余远程控制及 system pane/scroll/focus 消息，当前 CLI 接通 `ui_attach` / `ui_detach` / `ui_render` / `ui_press` / `ui_input` / `ui_select` / `ui_client_module` / `ui_client_press` / `ui_message` / `ui_client_fault` 及 `ui_invalidate` 推送；Pane/scroll 的控制与推送见下文专项；元素 focus、prompt 控制和 focus 推送见下文新专项。18类客户端控制有运行入口，五类 responder 尚待完成；23类协议定义不代表23类功能均已验收。完整 UI/diff 继续单独验收。官方原生回执、字段限制与验证范围见[SDK UI 协议专项](docs/research/mods-sdk-ui-protocol-292-20261007.md)。


### SDK 动态 MCP stdio 参数

`mcp_set_servers` 中的 stdio 配置应显式填写 `args`；没有命令行参数时也写 `[]`：

```jsonl
{"type":"control_request","request_id":"mcp-1","request":{"subtype":"mcp_set_servers","servers":{"example":{"type":"stdio","command":"node","args":["/absolute/path/server.mjs"]}}}}
{"type":"control_request","request_id":"mcp-remove-1","request":{"subtype":"mcp_set_servers","servers":{}}}
```

省略 `args` 时，在创建连接前返回 `errors.example: "Spread syntax requires ...iterable not be null or undefined"`，与固定官方 2.1.292 一致。控制请求本身仍返回成功回执，并将服务器名称列入 `added`；调用方必须检查 `errors`。失败配置可通过后续空 `servers` 请求移除，移除回执的 `removed` 包含该名称。

本项验收覆盖不存在和存在的命令省略 `args`、完整控制回执、移除及退出。缺失可执行文件的系统错误路径文案仍与官方有差异；完整 MCP、Mods 及 SDK 生命周期继续单独验收。

### SDK MCP 定义来源

查询当前服务器时发送：

```jsonl
{"type":"control_request","request_id":"mcp-status-1","request":{"subtype":"mcp_status"}}
```

`mcpServers[].source` 是可选字符串，表示服务器定义来自何处：SDK 宿主注册的服务器为 `sdk`，插件提供的服务器为 `plugin`，普通配置返回其配置范围（如 `user`、`project`、`local`、`dynamic`）。`scope` 与 `source` 分开：插件和 SDK 服务器可以同属 `dynamic` 范围。读取来源应使用 `source`；服务器名称只是配置键，不能据其名称判定来源。兼容旧 CLI 未返回该字段的状态对象。

SDK 服务器连接成功后，`serverInfo` 来自 MCP initialize 响应的服务器实现信息，包含名称和版本；等待握手完成后再读取。`source: "sdk"` 表示定义来源，连接是否成功仍以 `status` 和实际握手结果为准。

MCP 服务器可在 initialize 响应的 `result.instructions` 中返回使用工具和资源的可选字符串。SDK 宿主也通过同一握手返回；等待连接完成后发送用户请求。非空指令通过持久化的 `system-reminder` 消息进入模型上下文，SDK 与普通连接使用同一路径。字段位置见 MCP 的[初始化规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)。

指令默认最多保留 2048 个 UTF-16 单元。`CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` 可设置正整数上限，支持前后空格和正号；非法值回退默认值。超长时附加 `… [truncated]`，截断不会留下半个 Unicode 代理对。`--debug-file` 中会记录服务器名称、原始长度和上限。

这条上下文路径按固定官方 2.1.292 对照了 9 个 SDK、3 个 stdio 场景，包括缺省、空、超长、Unicode 边界及有效／无效上限；实际模型请求中的完整指令段和消息位置、状态／移除／结束回执及退出结果一致。重连后的指令变化及完整 MCP/Mods/UI 生命周期继续单独验收。

固定官方 2.1.292 的对照覆盖用户、动态和插件连接失败，以及 SDK 基本和完整 Implementation 元数据的成功握手；这些场景的完整状态、移除和退出回执相同。运行时 mod 注册服务器及完整 MCP/SDK 生命周期继续单独验收。

### SDK 模型切换校验

在 stream-json 会话中发送 `set_model`，并等待相同 `request_id` 的 `control_response`：

```jsonl
{"type":"control_request","request_id":"model-1","request":{"subtype":"set_model","model":"claude-sonnet-4-6"}}
```

自定义模型先用最小 API 请求验证；验证成功才修改会话模型，同一进程的成功结果可复用。验证失败保留原模型，返回具体错误及可选 `error_code`：网络／可重试服务器失败为 `check_failed`，认证失败为 `auth_failed`，模型不存在为 `catalog_unknown`。普通 API 拒绝可以不带错误码，调用方应始终读取 `error`。错误码在类型定义和 schema 解析中保留。

API 验证的期限为 5 秒，超时会取消请求并返回 `check_failed`；晚到结果不会进入成功缓存。模型切换按接收顺序处理，等待验证期间仍可处理 `interrupt` 等控制消息。空模型名被拒绝；`default` 使用当前默认模型。通用配置见 Anthropic 的[模型配置文档](https://code.claude.com/docs/en/model-config)。

本项按固定官方 2.1.292 验收受控 API、缓存、错误回执、失败不改模型及等待期间的 `interrupt` 顺序。成功切换后的压缩状态来源见下节；远程 Mods 提示仍与官方不同。组织目录／授权覆盖、模型切换 Hook、`system_prompt` 和完整 SDK 生命周期仍需独立对齐与验收。

### 自动压缩窗口来源与限制

远程 stream-json 会话的 `autocompact_state` 包含 `enabled`、`effective_window`、`threshold`、`enforced` 和 `source`。窗口与阈值来自共享压缩解析器。原生 1M 模型默认来源为 `model-default`；未知模型启用自动压缩时为 `unknown-model`，保护其保守窗口。显式 `[1m]`、已知旧模型以及关闭自动压缩时可以返回 `auto`，不能把所有默认窗口都视为同一种来源。

`CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1` 关闭未知模型的隐式窗口保护，保留原窗口大小；`0` 不关闭。环境值与显式窗口设置仍优先。声明且被接受的模型窗口、显式 1M 选择和未解析的 Bedrock application inference profile 不按未知模型处理。来源还参与 reactive 模式的限制判定：`auto` 可以不强制窗口，`unknown-model` 和 `model-default` 保留限制。

固定官方 2.1.292 的 16 种真实 CLI 初始状态、4 种显式启用 reactive 开关的状态，以及模型切换后的完整压缩状态值通过对照；限制选择另有生产函数回归。本地远程实验开关仍遵循 Privacy Mode 设置。API 超限后的实际 reactive 压缩、组织模型目录与完整压缩生命周期仍需独立验收。

### 自动压缩窗口环境变量

设置 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000` 可将自动压缩窗口设为 200,000 tokens，再按模型窗口限制；实际触发阈值还会预留摘要输出和缓冲。环境值按固定官方 2.1.292 的整数规则解析，支持 `2e5`、`200_000` 等整值写法。`k` / `m` 后缀不作为单位：`200k` 只取整数前缀 200，随后限制为最低 100,000 tokens。建议直接写完整整数。

有效环境值优先于设置项，范围限制为 100,000–1,000,000 tokens，再受模型窗口限制；零、负数和无效值回退到原有设置与模型默认选择。`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 按解析后的有效窗口计算。远程会话的 `autocompact_state` 使用同一窗口和阈值；普通本地会话不发送该状态帧。本项只对齐环境解析及状态投影，远程 Mods 不可用提示仍与官方有差异；完整压缩引擎与 SDK 生命周期继续单独验收。

### SDK 远程绘制与 Client 模块

在已初始化的 stream-json 会话中发送绘制请求，读取对应 request_id 的 control_response：

```jsonl
{"type":"control_request","request_id":"draw-1","request":{"subtype":"ui_render","surface":"desktop","component":"ToolUse","instance_id":"tool-1","props":{"input":{"command":"pwd"}},"on_screen":null}}
```

`props.tool_use_id` 缺失或不是字符串时由 instance_id 补齐；transcript 组件的 onScreen 只来自 on_screen。output 超过 65536 个 UTF-16 单元时截断，避免切开代理对。`hooked` 表示该组件存在 hook，surface 没命中仍可为 true。`rewritten` 来自返回树选中的第一个非零 engine ref，因此 `next(e)` 也返回 true。

Button / Input / Select 回执的 press 含 plugin 和 opaque handle。将它们原样用于 ui_press，或带 kind/value 的 ui_input、带 value 的 ui_select；key 可选。替换绘制树后旧 handle 返回 handled:false。control_cancel_request 只抑制同 request_id 的绘制回包，不终止 hook；EOF 等待运行收尾并释放绘制 lease。

桌面 Client 节点通过 client.plugin 标识所有者，client_modules 给出插件到模块包 hash 的映射。用 ui_client_module 查询 {plugin,hash,modules,runtime,limits,files}。宿主从已准入的源快照编译和重写 import，模块由外部 surface 执行；不得将包中的源代码当成宿主 hook 运行。随包返回官方 2.1.292 的固定 surface runtime/types 数据，hash 包含文件、模块清单和 limits。

调试日志 `[ModsUIRemote]` 记录 surface/component/instance/drawing、hooked 和 rewritten，不新增 props 正文日志。实际三方回执、来源和边界见 [远程绘制专项](docs/research/mods-render-bridge-292-20261007.md)。客户端浏览器挂载、focus 及五类 responder 仍需独立完成和验收；Pane/scroll 见后续专项，Client 交互、消息和故障见后续专项。


### 外部 Client 的交互与消息

拿到 desktop `ui_render` 的 Client 树后，使用回包中 `client.plugin`、`props.key` 和 `props.module`，加上渲染的 `component` / `instance_id` 构造地址；模块名已规范化，不要使用作者传给 `ui.Client` 的相对拼写。

```json
{"type":"control_request","request_id":"client-click-1","request":{"subtype":"ui_client_press","plugin":"example","component":"Pane","instance_id":"pane-1","client":"view","module":"hooks/view.ts","element":"save","event":{"type":"press"}}}
```

`event` 还可为 `{"type":"input","kind":"change","value":"draft"}`、submit 或 select。`handled:true` 表示地址可达；只有回包含 `reached` 时，外部 Client 才对该最终输入调用自己的回调，Mods 可以重写或拦截。服务端不执行 Client 源码。

将同一地址放进 `ui_message`，附 `data`（必填，允许 null），会只触发所属插件的 `ui.message`。`next.origin` 为 client；回包可带替换 `props`。消息有 100000 字符、20000 值和 32 层深度限制；过期地址返回 `handled:false`。input、select、message 各自按插件排队，press 独立执行。

运行专项回归：

```bash
bun test --no-env-file ./src/services/mods/remoteUiClient.test.ts ./src/services/mods/remoteUiRender.test.ts
```

真实官方/候选/完整工作区的验证和未完成范围见 [Client 交互验收](docs/research/mods-client-events-292-20261007.md)。当前接通 18 类客户端控制和 ui_invalidate/ui_panes/ui_scroll/ui_focus；有限官方对跑及验收边界见[远程编辑与焦点专项](docs/research/mods-remote-composer-292-20261008.md)。五类 responder、完整浏览器 Client 和官方 diff viewer 流程继续闭合。


### 外部 Client 故障与恢复

外部 surface 在模块加载、组件绘制或回调运行失败时，以当前 Client 的地址发送 `ui_client_fault`，phase 分别为 load、render、run，reason 最多 200 个 UTF-16 单元：

```json
{"type":"control_request","request_id":"client-fault-1","request":{"subtype":"ui_client_fault","plugin":"example","component":"Pane","instance_id":"pane-1","client":"view","module":"hooks/view.ts","phase":"render","reason":"View failed"}}
```

地址存在时回包为 `{"handled":true}`，失效时为 false。只有所属插件收到 `ui.fault`，next.origin 为 engine/core；surface、component、requestId、element、module、phase、reason 都只读，`next({})` 恢复原输入。作者可以 `on('ui.fault', ...)` 观察故障，返回空结果；没有 `$.ui.fault()` 调用。

当非空实例仍在绘制且所属插件监听此故障时，服务端发送以下推送（实际包含 uuid / session_id）。客户端据此重新发送 ui_render；服务端不会自动执行远程 Client 模块或重复执行绘制 hook。

```json
{"type":"system","subtype":"ui_invalidate","event":"ui.render","instances":[{"surface":"desktop","component":"Pane","instance_id":"pane-1"}]}
```

省略 instances 表示全局绘制失效；有 instances 时只重绘对应实例。同一故障代次的重复错误、相同请求及 props 变化不会持续触发恢复；绘制依赖再次失效后才允许新一轮恢复。故障控制没有可取消任务；control_cancel_request 不影响观察 hook、恢复通知或故障回包。`[ModsUIRemote]` 日志包含归属、规范模块、实例、来源 surface、故障 phase 和完成耗时。

```bash
bun test --no-env-file ./src/services/mods/remoteUiFault.test.ts ./src/services/mods/remoteUiFaultTypes.test.ts
make check-mods-control-types
```

原生回执、故障文本、恢复次数与取消顺序的证据见 [Client 故障验收](docs/research/mods-client-fault-292-20261007.md)。此项不替代完整浏览器 Client、终端内部故障、官方 diff viewer 或全部 Mods 兼容验收。

官方作者说明见 [Anthropic Mods 概览](https://code.claude.com/docs/en/plugins/mods/overview) 与 [Mods 接口参考](https://code.claude.com/docs/en/plugins/mods/reference)。接口参考将 ui.fault 定义为 Client 加载、绘制或运行失败的观察事件；本项目的具体类型与传输行为以固定官方版本的声明和专项验收为依据。


### 查询 Mods 自己的 pane

`await $.ui.panes()` 返回本插件登记在引擎中的 pane，包括暂未放置的记录。每项只有 `id`、`title`、`isShown`、`isFocused` 和 `isPlaced`。列表按打开顺序排列，已放置的记录在前；`isShown` 表示当前显示，`isFocused` 表示持有键盘，两者分别读取。

```js
on('session.start', async ($, e, next) => {
  const panes = await $.ui.panes()
  if (!panes.some(pane => pane.id === 'clock')) {
    await $.ui.open({id: 'clock', title: 'Clock'})
  }
  return next(e)
})
```

重载后的模块能查询仍在引擎中的自有 pane。准备阶段的开关操作在新代次发布时生效，旧绘制回调随后失效。`ui.panes` hook 收到冻结的空参数，可返回 `{value: panes}` 或 `{deny: 'reason'}`。TypeScript 方法无参数，返回 `Promise<readonly UiPane[]>`；Worker 中的结果是独立副本，修改它不会改变引擎状态。JavaScript 的额外便捷调用参数会被忽略。

无终端 SDK 会话也支持 pane 登记与查询，外部客户端另行请求 ui_render 绘制内容。作者接口见 [Anthropic Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)，精确验证结果见[自有 pane 查询专项](docs/research/mods-pane-list-292-20261007.md)。


### SDK Pane 控制

在 `--input-format stream-json --output-format stream-json --verbose` 会话中，客户端可发送以下请求。每个请求使用独立的 `request_id`，通过同 ID 的 `control_response` 读取结果。

```json
{"type":"control_request","request_id":"panes-1","request":{"subtype":"ui_panes"}}
{"type":"control_request","request_id":"show-1","request":{"subtype":"ui_pane_show","id":"clock"}}
{"type":"control_request","request_id":"focus-1","request":{"subtype":"ui_pane_focus","id":"clock","surface":"desktop"}}
{"type":"control_request","request_id":"blur-1","request":{"subtype":"ui_pane_focus","id":null}}
{"type":"control_request","request_id":"close-1","request":{"subtype":"ui_close","id":"clock"}}
```

`ui_panes` 返回已放置记录的 `panes` 和 `shown_id`、`focused_id`、`focus_requested_id`，空值为 `null`。打开时的 `focus:true` 提出焦点请求；客户端确认焦点后以 `ui_pane_focus` 更新实际状态。未放置项不会因此获得焦点。切换显示项时，已有键盘焦点随显示项移动。状态变化另以带 `uuid` 和 `session_id` 的 `system/ui_panes` 推送；客户端应更新自己的视图，这些消息不进入模型对话。

远程 `ui_attach` 的 viewport 若带布尔 `isFullscreen`，表明该 surface 可以放置 pane，值为 `false` 也有效。只有不支持放置的已测量 viewport 时，新 pane 等待；可放置 surface 接入或这些客户端全部离开后，等待项转为已放置，已放置项不会因 detach 被撤回。没有已测量 viewport 的无终端会话可登记 pane，但登记本身不调用终端绘制。

`ui_close` 以 person 来源经过 `ui.close` hooks，回复 `{closed:true|false}`；拒绝关闭或重复关闭仍在处理的 pane 时为 `false`。不存在的 ID 返回 `true`。已关闭 pane 的外部回调与 Client 地址随后失效。同 ID 更新保留最初的插件归属，并替换可选标题、行列和行为属性；跨插件更新不让调用者在 `$.ui.panes()` 中取得该记录。

作者接口和安装版本声明的取用规则见 [Anthropic Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)。本批对照与边界见 [SDK Pane 专项](docs/research/mods-pane-controls-292-20261007.md)；远程 focus、prompt edit/autocomplete 见后续用法；五类 responder 和完整 UI/diff 流程仍需独立验收。


### SDK 远程滚动与插件定位

已接通 `ui_scroll`，当前 18 类客户端控制均有运行入口。渲染 Pane 或 AbovePrompt 后，用非负整数表示窗口行数和位置，用整数 `by` 表示滚动增量：

```jsonl
{"type":"control_request","request_id":"scroll-1","request":{"subtype":"ui_scroll","client_id":"reader","component":"Pane","instance_id":"pane-1","offset":0,"by":3,"body_rows":20,"content_rows":100}}
```

Pane 必须已经登记且处于可放置状态；AbovePrompt 的 `instance_id` 固定为 `above-prompt`。尚未绘制时，已连接客户端也可以提交报告。布局客户端 attach 的回执后会补发当前 `ui_panes`，若放置变化已经发过清单则不会再补发。服务器沿用同一站点的缓存位置，首次未绘制报告从 0 开始；后续 `offset` 不覆盖缓存。回执为 `{moved,offset,deny?,follow_end?}`，合法请求被拒绝仍返回成功的控制响应，格式非法则返回错误。

无终端会话中的插件 `$.ui.scroll({to:"end",in:"pane-1"})`、`to:"start"` 或 `to:{key:"item"}` 共用这份状态；控件定位只查找所属插件的 `keyed` 行，支持 `block:"nearest"|"start"|"center"|"end"`。外部界面收到 `system/ui_scroll` 后应用该位置，`follow_end:true` 表示继续跟随末尾。人的滚动报告不会生成同名推送。插件在报告处理期间移动窗口后，原报告会以 `the window moved meanwhile` 拒绝，避免覆盖新位置；排队的普通报告合并增量，控制取消仍保留回执。

`[ModsUIRemote] ui.scroll` 调试日志记录站点、客户端、来源、增量、结果位置与拒绝原因。运行 `bun test --no-env-file ./src/services/mods/remoteUiScroll.test.ts`，完整证据见[滚动专项](docs/research/mods-remote-scroll-292-20261008.md)。`ui_focus` 和 prompt edit/autocomplete 的用法与对跑见后续章节；五类 responder、浏览器 Client 和完整官方 diff viewer 继续闭合验收；终端滚动继续走既有宿主路径。作者契约参考 [Anthropic Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)。


### SDK 远程草稿编辑与补全

客户端在 stream-json 会话中以自己的 `client_id` 维护草稿。`by:"app"` 同步应用草稿；省略 by 或 `by:"person"` 经过 `prompt.edit`。cursor 和 decorations 使用 UTF-16 位置，cursor 超过文本末尾会 clamp。

```jsonl
{"type":"control_request","request_id":"draft-1","request":{"subtype":"ui_prompt_edit","client_id":"editor","by":"app","text":"ask #12","cursor":7}}
{"type":"control_request","request_id":"edit-2","request":{"subtype":"ui_prompt_edit","client_id":"editor","text":"ask #123","cursor":8}}
{"type":"control_request","request_id":"complete-3","request":{"subtype":"ui_prompt_autocomplete","client_id":"editor","text":"ask #123","cursor":8}}
```

编辑回包为 text/cursor，可带 decorations。补全回包为 suggestions，可带 start。重叠输入会合并或撤销旧请求，旧回包可能带 `superseded:true`；客户端应以最新草稿处理回包，不把被替代建议覆盖回编辑器。

作者可注册补全事件；没有 `$.prompt.edit()` 或 `$.prompt.autocomplete()` 便捷方法。

```js
on('prompt.autocomplete', async ($, e, next) => {
  if (!e.token.startsWith('#')) return next(e)
  return {suggestions: [{text: '#123', label: 'Issue 123', description: 'Open issue'}]}
})
```

text/cursor/token/start 是只读事实；`next({})` 恢复省略字段，不能改写它们。原始候选 text 必须非空，label/description 若存在必须是字符串。通过契约检查后再清理 Unicode，清理后空候选移除，label 合并空白并省略空值。空 token 不触发 hook。输入、取消和排队会经过实际 Worker 与 runtime。

### SDK 远程元素焦点

Pane 或 AbovePrompt 绘制后，客户端报告键盘归属及实际元素；element 取自当前绘制中的 Button/Input/Select，保留 plugin 与 key。

```jsonl
{"type":"control_request","request_id":"element-1","request":{"subtype":"ui_focus","client_id":"editor","component":"Pane","instance_id":"clock","is_held":true,"element":{"plugin":"example","key":"save"},"by":"person"}}
{"type":"control_request","request_id":"release-2","request":{"subtype":"ui_focus","client_id":"editor","component":"Pane","instance_id":"clock","is_held":false}}
```

回包提供 moved、当前 element（无 holder 为 null）与可选 deny。失去键盘时省略 element；is_held=true 且省略 element 只报告键盘状态，不发起移动，element=null 则明确移动到站点本身。等待队列合并状态报告时会保留最近显式指定的落点及其 by。AbovePrompt 的 instance_id 固定为 `above-prompt`。渲染请求的 isFocused 会在 hook 运行前同步归属，移除控件后旧 holder 失效；Client 节点自身不进入这组可聚焦控件。

作者 `$.ui.focus()` 经相同归属与绘制校验，在远程站点成功移动时另推送 `system/ui_focus`，带 client_id/component/instance_id/plugin/key、uuid 和 session_id，客户端据此更新视图。该推送不进入模型历史。component/requestId/plugin/origin 只读；hook 可改写已有 element 的 key，不能添加或删去 element。拒绝原因必须非空，已执行成功的 next 不能再被迟到 deny 撤销。

```bash
bun test --no-env-file ./src/services/mods/remoteUiPrompt.test.ts ./src/services/mods/remoteUiFocus.test.ts
make check-mods-control-types
```

`--debug --debug-file /absolute/path/debug.log` 的 `[ModsRemotePrompt]` 与 `[ModsUIRemote]` 记录客户端、站点、来源、长度/位置和拒绝原因。宿主 capability 异常的 Proxy/getter 安全提取见[异常边界专项](docs/research/mods-capability-error-audit-20261008.md)。本批真实原生对跑与完整发布门禁分别记录在[编辑和焦点专项](docs/research/mods-remote-composer-292-20261008.md)；完整 terminal/diff/浏览器生命周期仍需闭合。作者接口参考 [Anthropic Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)。


### Mods 终端观测与验收边界

终端 Pane 的观测读取已提交的 Ink DOM，记录插件/pane、activation、lease、drawing、实际焦点、控件注册及几何；host 发布新状态不能替旧帧更换身份。关闭、隐藏、缩放和重开需要分别核对。官方 diff 的 `base` 是一个合法的 plain 空 Button：它可进入焦点环，没有像素面积；仅该明确登记的类别允许 `rect=null`，仍必须有正确的实际 plugin/key 焦点，缺失控件不能通过。上述身份是内部验收信息，不是作者 API。

相关回归可离线执行：

```bash
bun test --no-env-file ./src/components/ModsPane.evidence.test.tsx ./src/ink/terminalEvidence.viewport.test.ts
```

整体验收继续保留失败。固定官方 2.1.292 的第十七轮矩阵完成 29 项，27 通过、2 失败；diff 的 Tab、文件切换、关闭/重开业务链完成，但启动帧跨 resize epoch，且同步 ACK 采集仍不具备产品时序等价性。新异步 journal 的纯字节校验也必须拒绝未知前缀/尾部、归属歧义和不完整收尾；Bun 原生 console 的遗漏已由真实 CLI 检查检出，尚未补齐。不能用成功片段、较新的帧或候选构建替代完整通过。实现、身份和后续必验项见[终端验收有效性](docs/research/mods-terminal-evidence-validity-20261008.md)。作者契约见 [Anthropic Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)。

新增 DOM 测试从设置采集环境开始覆盖整个生命周期；setup、unmount、dispose 失败均尝试全部清理并恢复环境，多个错误一起保留。失败注入回归与真实 Ink 成功路径独立检查，不把异常清理成功当作终端时序通过。

本批干净源码真实入口的第十八轮结果为22通过、7失败（29项完整执行），包含首次Tab未前进及终端采集未完整收尾；它与含其他工作区变更的第十七轮是不同构建。实现提交不等于功能或发布验收通过，后续仍须补齐对应功能和证据。


### 原生输出采集有效性

Darwin 可用 `scripts/capture-native-terminal-writes.py --evidence-root <新目录> --executable ./built-claude --mode pty -- --version` 独立采集原 syscall 与 PTY 字节、EOF 和退出。脚本自动编译自身观测库，使用私有配置，无 writer ACK；记录真实别名 fd、原返回值及 errno，缺片/丢包/超限/缺少封口均失败。协议与清理回归、pipe 模式、已验证范围及尚未覆盖的逐帧/时序限制见[原生采集记录](docs/research/mods-native-write-capture-validity-20261008.md)。此启动检查不代表完整 UI/diff 或发布通过。


显式 nested Agent：当子 Agent 的过滤后工具池包含 `Agent` 时，`tools: Agent(child)` 正常解析为可调用工具；缺席或被禁止时只保留类型限制元数据，权限和深度检查继续生效。配置示例、固定292代码边界和同轮真实入口要求见[嵌套工具准入](docs/research/mods-nested-agent-availability-20261008.md)。完整 Mods/UI 与最新版 native 验收仍在进行。

内置 Mods 验收驱动自动归档证据：识别并记录本轮 FIFO/socket，核对源与副本 manifest，保留原报告及独立路径映射报告。归档失败、缺 producer EOF/reap，或删除前源/副本与原快照失配或出现新增/替换特殊端点时保留源缓存，`builtin-mods-checks.json` 的 `retained_cache` 指明路径并保持失败。回归命令、收据位置与未闭合边界见[归档有效性](docs/research/mods-builtin-evidence-archive-20261008.md)。文件复制成功不替代原生退出、逐帧或业务验收。


### 终端采集的退出与清理回执

`python3 scripts/test-terminal-evidence-broker.py` 验证真实 PTY 的启动、输入/resize、退出和故障清理。broker 只以实际 PTY EOF 与 waitpid 记录退出；清理错误和异常停止保持失败，资源清理后的终态 seal 防止迟到信号改写回执分类，原件删除还要求正常完成且无错误。采集命令、回执字段、有效/无效测试处置与完整验收边界见[broker 生命周期记录](docs/research/mods-broker-lifecycle-validity-20261008.md)。完整 Mods/UI、时序与最新版 native 验收继续进行。

`make release-check` 会运行 `bun ./scripts/check-readme-test-paths.mjs`，确认 README 引用的测试文件实际存在于当前 checkout。该检查只验证命令入口可用，不替代测试执行、官方双端、物理帧或完整发布门禁。


原生 shared-slot 采集器的局部回归（macOS、现有 Xcode clang 和 Bun；只使用私有目录及 dummy 配置）可在一次新构建后运行：`JOURNAL_TEST_BINARY=/absolute/path/to/fresh/built-claude python3 scripts/test-native-terminal-journal.py`。脚本不会自行构建、安装依赖或读取共享认证，证据保存在其输出的 `/private/tmp/cc-journal-*`。21 项覆盖真实 CLI `--version`、原 write/writev/NOCANCEL、完整 5000 字节、实际 partial/EFAULT、不可变记录、队列饥饿拒收、两采集器独占、4 槽循环采集 44 条记录、受控异常与初始化回收、单实例线程 ownership 和领取前 registration/PID 绑定。此处“局部回归通过”只证明 native collector；完整 geometry/termios 历史、OS input/owner 和正常 diff lifecycle 仍未闭合。22 项回归另覆盖 signed dev_t 的准确 native identity 表示。

实际 Ink 帧连接可在新构建后单独运行：`JOURNAL_TEST_BINARY=/absolute/path/to/fresh/built-claude python3 scripts/test-native-frame-journal.py`（macOS、既有 Bun/clang/tmux）。它用私有 HOME、配置、socket、PTY 和 dummy key 从真实 CLI 启动并输入 `/exit`，按原生 syscall prefix 关联 immutable logical frame，再独立回放；每次回放先重新校验原始 packets/raw/registration/PID 与本轮身份，篡改派生 output/cells 不会通过。包含实际 tmux 启动后 client Timeout 的 owned cleanup 回归。证据目录随输出提供；默认完整 driver 的 no-ACK、resize/termios、input owner、diff reopen 和官方完整比较仍未通过，不能作为发布或全部 Mods 兼容结论。详情见[原生帧连接与拒收规则](docs/research/mods-native-frame-journal-validity-20261008.md)。

默认 terminal capture 的 `prepare` 现在预编译并绑定 Darwin observer，最终 native exec 由同一个 broker 接入 shared-slot backend。运行时不写 raw/frame 证据文件、不等待 frame ACK；64 MiB 内存上限溢出会使采集失败，PTY 仍继续转发。退出后保存原生 packet/raw prefix 与实际清理结果，预存证据文件不会被登记或覆盖。上述帧测试也运行实际默认 prepare/install、launcher、CLI `/exit` 和 seal，以及启动故障清理；`BROKER_TEST_EVIDENCE_DIR=/absolute/path/to/new/evidence python3 scripts/test-terminal-evidence-broker-native.py` 检查内存溢出、预存文件保护和缺失 enrollment 的拒收。完整 seal 明确列出尚缺的 termios/resize 历史、OS input/owner 和时序证明，局部回放通过不提升为完整验收通过。见[默认无 ACK 采集记录](docs/research/mods-default-native-broker-validity-20261008.md)。

native replay 要求默认 backend 的独立身份及完整 IO 初始几何收据。resize 必须另有实际 `TIOCSWINSZ` 的 Mach-clock 括号、内核前后尺寸、PID/nonce/timebase 与正常生命周期绑定；没有括号或与布局/输出重叠时拒收，不能凭 broker raw read offset 推断顺序。独立 xterm 按原 syscall prefix 应用 resize，在 `native-frame-end-v1` 比较每帧；随后同步发布的 immutable snapshot 不改变该比较点。帧测试还覆盖精确 uint64 字符串、拒收篡改和默认入口故障清理。运行方法仍是上述新构建后的 `test-native-frame-journal.py`；详情见[resize 时序验收](docs/research/mods-native-resize-bracket-validity-20261008.md)和[历史固定几何边界](docs/research/mods-fixed-geometry-acceptance-validity-20261008.md)。这只覆盖 owned broker 实际执行的 resize；child-side geometry、termios、OS input ownership、时序等价及完整发布门禁仍未通过。

默认 native IO 另由 owned broker 的关闭收据固定原始JSONL摘要、记录数量、最终geometry identity及raw字节数；expected独立保留该收据，回放要求每个output区间连续覆盖全部raw，其他事件offset不跳动。截断、重新编号或同时改写IO和普通cleanup仍会拒收；这项完整性绑定不代表native resize时序或OS input ownership已得到证明。

默认 native broker 另在退出前独占写入 producer-expected-native.json，摘要来自其内存原件及实际PID/初始几何。第一次 seal 只读该producer expectation并核对prepare身份；缺失、预存、发布失败均不能通过，不会从当前IO或cleanup重算。真实入口负例在首次seal前删input、重编号并更新两份cleanup，保持producer expectation不变，仍被拒收。若prepare identity、producer expectation及所有原件都同时被替换，仍需外层可信封存；这里没有加密认证或完整native时序证明。

原生采集另记录真实 `tcsetattr` 的 Mach-clock entry/return、原始 retval/errno及内核 before/requested/after flags、speed、control chars。write重放、frame与resize prefix按已观测 mode 顺序使用实际 output flags；mode/write重叠、未知输出转换或证据缺失拒收。可继续用上述新构建后的两项 Python 脚本串行运行，包含关闭/恢复 OPOST、ECHO、失败 action和观测溢出的回归。此处只覆盖实际捕获的 tcsetattr 调用，直接 mode ioctl、完整 termios lifetime、OS input owner和时序等价仍未通过。见[终端模式观测与回归](docs/research/mods-native-termios-observation-validity-20261008.md)。

首封还要求producer的 `nativeClose` 内容回执：从采集器内存固定raw三alias、完整records（含mode与snapshot）、header、registration及initial的字节数/SHA256与record count。verifier先核对原件并从同一份已校验bytes解码；缺失内容回执、等长耦合改写或缩水schema拒收，sealer最终manifest也必须匹配。新构建后可串行运行上述帧脚本，其中包含实际default CLI首封负例；详情及单项命令见[内容来源闭包](docs/research/mods-native-payload-closure-validity-20261008.md)。这未改变完整native/Mods尚未通过的结论。

outer seal 在真实独立重放之后生成最终manifest时，也重新比较IO清单SHA与producer的 `ioClose.sha256`；`nativeContentMatched` 和 `nativeIOMatched` 均须为true才能取得bounded通过。帧脚本另覆盖重放成功后、终态摘要前删input/重编号的真实副本负例，避免沿用旧physical passed掩盖IO变动；完整native与发布结论仍独立。

默认原生 broker 现异步发布运行中的完整帧与 IO JSONL 前缀；关闭时重新绑定 held copies、实际文件身份和最终 closed 原件。可用 `PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-native-live-prefix.py` 跑协议/写入器回归，再按上述新构建命令运行完整 frame-journal 文件，含 child alive 与正常退出后 exact prefix 检查。Native40 完整30项27通过3失败；旧 FIFO schema 的 canonical/resize/退出关联、输入 owner 和时序证明仍未闭合，完整发布继续失败。使用方法、失败处置和同轮身份见[实时前缀验收](docs/research/mods-native-live-prefix-validity-20261009.md)。


原生验收按backend绑定本轮关闭原件，严格拒收错误JSON类型、FIFO/链接及不完整diff子测试；正常EOF/reap与bounded replay不提升为完整通过。新增guard可用`PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-native-acceptance-contracts.py`运行，实际CLI仍需上述fresh build与完整frame-journal命令。Native41 完整默认动态矩阵及原有七项追加目标共30项：27通过、3失败。完整发布继续失败；失败分类、固定子测试及独占收据用法见[原生身份验收处置](docs/research/mods-native-identity-validity-20261009.md)。CHANGELOG参与二进制构建，更新后必须重新生成产物。


原生证据writer按已排队prefix批处理并保留未完成snapshot；producer关闭和外层collector EOF分阶段严格检查，2秒关闭预算与64MiB上限保持。协议及退出guard运行方法、受控积压probe的IO缺失边界与后续完整门禁见[发布积压与关闭验收](docs/research/mods-native-publication-close-validity-20261009.md)。正常producer退出不替代完整采集或产品时序通过。


Native43完整30项仍为27通过、3失败；canonical和interaction实际normal_native_exit均true，interaction保存全部90帧/122项IO并正常关闭。完整CLI/frame文件14通过、1失败：真实resize后零输出快照仍为旧尺寸；此RED继续保留，未完成geometry handoff与完整发布。证据与首次分歧见[发布积压与关闭验收](docs/research/mods-native-publication-close-validity-20261009.md)。

canonical 验收新增 native span、动作窗口与 Mach geometry 关联；零输出观察只可引用同 root/几何的实际输出帧，不能补造 FIFO ACK 或证明 child input owner。回归入口：`PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-native-canonical-binding.py`，随后仍须上述 fresh build、完整 CLI/frame 文件和默认完整矩阵。实现、拒收条件及历史重算边界见[原生 canonical 绑定](docs/research/mods-native-canonical-binding-validity-20261009.md)。旧 resize RED 和完整发布失败继续保留。

原生 canonical 验收认证已经记录的 frame identity，并保持完整 checkpoint/action/IO/geometry 校验；输入原件使用 exclusive/no-follow 0600 创建。历史门禁和未覆盖边界见 [原生 canonical 绑定验收](docs/research/mods-native-canonical-binding-validity-20261009.md)，现场检查点通过不替代最终完整门禁。

原生终端报告保留独立backend，区分帧事务输出与连续replay段，并将原resize请求、真实内核ACK与后续正确尺寸的实际绘制帧一一对应。回归入口为 `scripts/test-native-report-consumers.py` 和 `scripts/native-frame-journal-replay.test.mjs`；使用方法与仍未闭合的完整门禁见[原生报告消费契约](docs/research/mods-native-report-contract-validity-20261009.md)。

`--debug-file /absolute/path/mods-debug.log` 可记录 `[ModsProcess]` 的实际启动、停止、终止和close。日志绑定宿主生成的operationId、owner、PID、参数摘要、预算与单调耗时，以及实际读取/保留字节、摘要和截断标志；不打印argv、stdin、env或输出内容。首次TERM与2000ms宽限后身份复验的KILL分开记录；group失败仍尝试独立PID，逐目标失败记录errno。初次ps不可用、后次恢复也允许真实仍存活的owned child handle回退；已捕获身份冲突及后代查询失败不能声称清理完成；日志保留实际查询exitCode与未闭合PID，缺行须以真实ESRCH确认退出。见[process.run生命周期与取消契约](docs/research/mods-process-run-lifecycle-validity-20261009.md)。

原生终端验证的 `seal` 与 `verify --bounded` 仅结算闭合身份/物理证据；默认 `verify` 和发布门禁仍要求完整覆盖。后端文件清单、资源关闭及未覆盖条件见[验收结算说明](docs/research/mods-native-capture-scope-validity-20261009.md)。

归档后的 builtin recheck 使用同次运行的 `builtin-cache-archive.json` 将原始 producer run 映射到 `acceptance-cache`，同时核对原始 `capture-launch.json` 的摘要。不会改写启动记录；源、归档目录、完成标志或原件摘要不符均拒收。独立重放可用 `bun scripts/recheck-builtin-terminal-evidence.mjs ACCEPTANCE_REMAPPED.json BINARY_SHA256 OUTPUT.json ARCHIVE_RECEIPT.json`，其通过只代表所声明的证据范围；完整门禁另外对照 parent 在归档完成时固定的收据摘要，拒收启动原件与收据同时改写。


#### Builtin 原生普通屏幕与归档回放

`run-builtin` 的 native broker 在现有 sandbox 内执行，启动前保存 tmux 物理状态、空白屏幕和未完成 parser 输入。当前起点证明限定 tmux **3.6b** 的新建私有 pane；未知版本、非初始模式或残留输入会拒收。普通屏幕按真实输出前缀取得物理 marker，再检查相对光标、宽字符、样式和缩短后的尾行。

```sh
make build
BUILTIN_NATIVE_TEST_BINARY="$PWD/built-claude" bun test --no-env-file ./scripts/builtin-native-launch.integration.test.mjs
bun test --no-env-file ./scripts/native-normal-root.test.mjs
python3 scripts/test-owned-evidence-copy.py
```

编译入口测试使用私有 tmux/socket/config，等待真实 prompt 后正常 `/exit`，随后在原 cache 路径暂不可用时重验归档，并保留所有原件。未设置 `BUILTIN_NATIVE_TEST_BINARY` 时该入口测试会跳过，不能计为通过。APFS 副本仅改变存储分配，逻辑字节、SHA 和原断言保持一致；其他平台使用普通复制。`boundedVerdict` 仅表示已覆盖的关闭和物理帧证据，`fullNativeGatePassed`、输入归属与产品时序不会由此升级。详见[实际失败、修复和边界](docs/research/mods-builtin-native-normal-root-validity-20261009.md)。

原生 child 读取证明保留所有字节，包括插入命令之间的 tmux 应答；只有原始输出 parser 已识别对应查询时才分类协议响应，随后严格核对完整预期输入。未读入、删改、额外或无查询的控制字节仍拒收，应用 tokenizer/owner 另外验收。
