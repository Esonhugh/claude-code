# 模型自动发现与 Gateway

> 英文名：`model-discovery` · 领域：模型与 Provider · [返回功能索引](README.md)

## 作用与效果

启动时按「provider + endpoint + 凭据身份」刷新 Model Picker 缓存：OpenAI 模式请求 ChatGPT Codex models 或 `/v1/models`；Anthropic API billing 走自定义网关时，可选开启网关 `/v1/models` 发现。不同 provider、base URL、账户不共享模型目录；失败时保留旧缓存但只在身份匹配时读取。

## 配置

| 配置项 | 位置 | 可选值 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | 环境变量 | `1` | 关闭 | Anthropic 网关模型发现，需同时有 `ANTHROPIC_BASE_URL` 与认证 |
| `ANTHROPIC_BASE_URL` | 环境变量 | URL | 官方 API | 网关地址，请求 `${ANTHROPIC_BASE_URL}/v1/models` |
| `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` | 环境变量 | 字符串 | — | 两者都有时优先 `ANTHROPIC_AUTH_TOKEN`（Bearer），否则 `x-api-key` |
| `ANTHROPIC_CUSTOM_HEADERS` | 环境变量 | header 列表 | — | 大小写不敏感覆盖默认 header |

```bash
CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 \
ANTHROPIC_BASE_URL=https://gateway.example \
ANTHROPIC_AUTH_TOKEN=<bearer-token> \
claude
```

## 效果

同一个返回 `gw-alpha-1` / `gw-beta-2` 的网关，未开启发现时 `/model` 只有内置目录：

```text
❯ /model
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Select model
  Switch between Claude models. Applies to this session and future Claude Code sessions. For other/previous
  model names, specify with --model.
  ❯ 1. Default (recommended) ✔  Use the default model (currently Opus 5.5) · $4/$20 per Mtok
    2. Fable 5.1                Fable 5.1 · For the hardest and longest-running tasks · $10/$50 per Mtok
    3. Opus 5.5                 Opus 5.5 · For complex coding and agent tasks · $4/$20 per Mtok
    4. Sonnet 5.5               Sonnet 5.5 · Balanced performance for everyday tasks · $2/$10 per Mtok
    5. Haiku                    Haiku 4.5 · Fastest for quick answers · $1/$5 per Mtok
  ◐ Medium effort (default) ← → to adjust
  Enter to confirm · Esc to exit
```

设置 `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` 后，网关模型以 `From gateway` 追加到列表：

```text
 ▐▛███▜▌     EsonClaw v2.1.292
▝▜█████▛▘    Opus 5.5 · API Usage Billing
  ▘▘ ▝▝      ~/work
❯ /model
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Select model
  Switch between Claude models. Applies to this session and future Claude Code sessions. For other/previous
  model names, specify with --model.
  ❯ 1. Default (recommended) ✔  Use the default model (currently Opus 5.5) · $4/$20 per Mtok
    2. Fable 5.1                Fable 5.1 · For the hardest and longest-running tasks · $10/$50 per Mtok
    3. Opus 5.5                 Opus 5.5 · For complex coding and agent tasks · $4/$20 per Mtok
    4. Sonnet 5.5               Sonnet 5.5 · Balanced performance for everyday tasks · $2/$10 per Mtok
    5. Haiku                    Haiku 4.5 · Fastest for quick answers · $1/$5 per Mtok
    6. Gateway Alpha            From gateway
    7. Gateway Beta             From gateway
  ◐ Medium effort (default) ← → to adjust
  Enter to confirm · Esc to exit
```

## 详细说明

以下内容自原 README 迁入，保持原文。

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
