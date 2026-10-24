# OpenAI / Codex provider

> 英文名：`openai-provider` · 领域：模型与 Provider · [返回功能索引](README.md)

## 作用与效果

把模型请求切到 OpenAI Responses API。支持 ChatGPT OAuth（device code 登录、token refresh，凭据写入 `~/.codex/auth.json`）、API key 与 Codex auth 文件；启用 server-side `WebSearch`，把 `web_search_call`、URL citations 和 usage 转换成 Anthropic 兼容的 stream 事件。`/fast` 映射为 `service_tier: "priority"`，`/compact` 走 OpenAI remote compaction 并保留 opaque compaction history。ChatGPT OAuth 下 `/stats` 另有 OpenAI activity 标签页。

## 配置

| 配置项 | 位置 | 可选值 / 写法 | 说明 |
| --- | --- | --- | --- |
| `CLAUDE_CODE_USE_OPENAI` | 环境变量 | `1` | 开启 OpenAI provider |
| `OPENAI_AUTH_TOKEN` / `OPENAI_API_KEY` | 环境变量 | 字符串 | 凭据优先级：`OPENAI_AUTH_TOKEN` → `OPENAI_API_KEY` → `~/.codex/auth.json` API key → `~/.codex/auth.json` ChatGPT OAuth |
| `OPENAI_BASE_URL` | 环境变量 | URL | OpenAI 兼容网关；末尾有无 `/v1` 都只请求一次 `/v1/models` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` / `_SONNET_` / `_HAIKU_` | 环境变量 | 模型名 | 覆盖别名映射（默认 `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna`） |
| `/login` | 斜杠命令 | — | ChatGPT OAuth 登录 |
| `/fast` | 斜杠命令 | 切换 | OpenAI 下发送 `service_tier: "priority"` |

```bash
CLAUDE_CODE_USE_OPENAI=1 claude                                  # 之后 /login
CLAUDE_CODE_USE_OPENAI=1 OPENAI_API_KEY=<key> claude             # API key
CLAUDE_CODE_USE_OPENAI=1 OPENAI_BASE_URL=https://gateway.example/api OPENAI_API_KEY=<key> claude
```

## 效果

API key 启动时，启动 pane 显示默认模型 `gpt-5.6-sol` 与 `API Usage Billing`（ChatGPT OAuth 时改为显示 plan 与 Codex limits）：

```text
 ▐▛███▜▌     EsonClaw v2.1.292
▝▜█████▛▘    gpt-5.6-sol · API Usage Billing
  ▘▘ ▝▝      ~/work
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ? for shortcuts                        ✓ Esonhugh-Marketplace installed · /plugin to see available plugins
```

## 详细说明

以下内容自原 README 迁入，保持原文。

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

未显式指定模型时，OpenAI provider 默认使用 `gpt-5.6-sol`；别名 `opus`、`sonnet`、`haiku` 分别解析为 `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`（可由 `ANTHROPIC_DEFAULT_OPUS_MODEL`、`ANTHROPIC_DEFAULT_SONNET_MODEL`、`ANTHROPIC_DEFAULT_HAIKU_MODEL` 覆盖）。其他显式模型名称（包括完整 Claude 模型 ID）不做改写，原样发送到 endpoint，实际可用性取决于服务端。

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
