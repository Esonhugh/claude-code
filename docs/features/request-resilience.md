# 请求韧性：重试、回退模型与默认模型

> 英文名：`request-resilience` · 领域：模型与 Provider · [返回功能索引](README.md)

## 作用与效果

对齐官方 2.1.303 的请求重试策略：响应流空闲 5 分钟自动中止重试；可配置重试次数、529 退避；无人值守模式下 429/529 持续等待；主模型连续 3 次 529 时按回退链换模型。Anthropic 与 OpenAI provider 都适用。

## 配置

| 配置项 | 位置 | 可选值 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `CLAUDE_ENABLE_STREAM_WATCHDOG` | 环境变量 | `0` | 开启 | 关闭 stream idle watchdog |
| `CLAUDE_STREAM_IDLE_TIMEOUT_MS` | 环境变量 | ≥ `300000` | `300000` | 只能调长 |
| `CLAUDE_CODE_MAX_RETRIES` | 环境变量 | 整数，上限 15 | `10` | 普通重试次数 |
| `CLAUDE_CODE_RETRY_WATCHDOG` | 环境变量 | `1` | 关闭 | 无人值守重试 |
| `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS` | 环境变量 | 毫秒 | — | 429/529 累计等待上限 |
| `CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS` | 环境变量 | 毫秒 | — | 用量窗口重置超过该值就不等 |
| `CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS` / `_MAX_DELAY_MS` | 环境变量 | 毫秒 | `500` / `32000` | 529 退避 |
| `--fallback-model` | CLI | `a,b,c`（最多 3 个） | — | 优先于 settings |
| `fallbackModel` | settings | `["sonnet","haiku"]` | — | `default` 表示默认模型 |
| `ANTHROPIC_DEFAULT_MODEL` | 环境变量 | 模型名 | — | 新会话默认模型，优先级低于 `--model`、`ANTHROPIC_MODEL`、settings `model` |

```json
{ "fallbackModel": ["sonnet", "haiku"] }
```

## 效果

`CLAUDE_CODE_MAX_RETRIES=1` 且网关端口拒绝连接时，`-p` 在一次重试后报错退出，而不是挂起：

```text
API Error: Unable to connect to API (ECONNREFUSED)
```

## 详细说明

以下内容自原 README 迁入，保持原文。

### 请求韧性：重试、回退模型与默认模型

以下行为与官方 2.1.303 对齐，Anthropic 与 OpenAI provider 均适用：

- **Stream idle watchdog** 默认开启：响应流 5 分钟没有事件时中止并重试。`CLAUDE_ENABLE_STREAM_WATCHDOG=0` 关闭；`CLAUDE_STREAM_IDLE_TIMEOUT_MS` 只能把窗口调长（下限 300000）。
- `CLAUDE_CODE_MAX_RETRIES` 上限 15（默认 10）。
- `CLAUDE_CODE_RETRY_WATCHDOG=1`（无人值守重试）：429/529 不受重试次数限制，持续重试；普通退避单次最长 5 分钟，带用量窗口重置时间或 `Retry-After` 的 429 会等到重置时间（单次最长 6 小时），等待期间每 30 秒输出 keep-alive；其他瞬时错误默认重试 300 次且解除 15 次上限；组织 spend cap 等不会自动恢复的 429 立即失败。
  - `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS`：一次请求在 429/529 上累计等待的上限，耗尽后返回错误。
  - `CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS`：用量窗口（usage limit）重置时间超过该值时不再等待。
- `CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS` / `CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS`：529 重试退避的基础与最大延迟（默认 500 / 32000）。
- OpenAI provider 的 408/409/429/5xx 也走同一重试策略（`usage_limit_reached`、`insufficient_quota` 与认证错误仍立即失败）。
- 回退模型：`--fallback-model a,b,c`（交互式与 `--print` 均生效）或 settings `"fallbackModel": ["sonnet", "haiku"]`，CLI 优先，最多 3 个，按顺序尝试；`default` 表示默认模型。配置后任何主模型连续 3 次 529 都会切换到链上下一个模型，下一轮用户输入重新从主模型开始。
- `ANTHROPIC_DEFAULT_MODEL`：新会话的默认模型。`--model`、`ANTHROPIC_MODEL`、settings `model`（含 `/model` 的选择）与组织默认模型优先于它；`default`/`inherit` 视为未设置。
