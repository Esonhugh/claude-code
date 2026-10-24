# OpenAI / Codex provider

> 英文名：`openai-provider` · 领域：模型与 Provider · [返回功能索引](README.md)

## 这是什么

Claude Code 默认调用 Anthropic 的 Claude 模型。打开 OpenAI provider 后，同一套界面、工具、权限、命令不变，只是**背后的模型换成 OpenAI 的**（通过 Responses API）。可以用：

- **ChatGPT 账号登录**（OAuth 或设备码），用订阅里的 Codex 额度；
- **OpenAI API key**，按量计费；
- **OpenAI 兼容网关**（公司网关、OpenRouter 等）。

## 快速上手

**1. 开启：**

```bash
CLAUDE_CODE_USE_OPENAI=1 claude
```

**2. 登录：** 输入 `/login`，选一种方式：

![OpenAI 登录](images/openai-provider-login.png)

| 选项 | 适合 |
| --- | --- |
| Use API key | 已有 OpenAI API key，粘贴后保存到 `~/.codex/auth.json` |
| Sign in with OAuth | 本机有浏览器，用 ChatGPT 账号登录 |
| Sign in with device code | SSH / 无界面机器：在任何设备打开链接、输入一次性码 |

也可以不登录，直接用环境变量：

```bash
CLAUDE_CODE_USE_OPENAI=1 OPENAI_API_KEY=<your-api-key> claude
```

**3. 选模型：** 默认 `gpt-5.6-sol`，欢迎画面会显示。`/model` 列出当前账号或网关可用的模型（下图是一个返回两个模型的兼容网关）：

![OpenAI 模型列表](images/openai-provider-model.png)

## 用兼容网关

```bash
CLAUDE_CODE_USE_OPENAI=1 OPENAI_BASE_URL=https://gateway.example/api OPENAI_API_KEY=<key> claude
```

地址末尾有没有 `/v1` 都可以。模型列表的获取规则见 [model-discovery.md](model-discovery.md)。

## 模型名怎么对应

| 你写的 | 实际发送 | 可用环境变量覆盖 |
| --- | --- | --- |
| 不指定 / `opus` | `gpt-5.6-sol` | `ANTHROPIC_DEFAULT_OPUS_MODEL` |
| `sonnet` | `gpt-5.6-terra` | `ANTHROPIC_DEFAULT_SONNET_MODEL` |
| `haiku` | `gpt-5.6-luna` | `ANTHROPIC_DEFAULT_HAIKU_MODEL` |
| 其他名字（包括完整的 Claude 模型 ID） | 原样发送 | — |

## 凭据从哪里来

按顺序取第一个有的：

1. `OPENAI_AUTH_TOKEN`
2. `OPENAI_API_KEY`
3. `~/.codex/auth.json` 里的 API key
4. `~/.codex/auth.json` 里的 ChatGPT 登录凭据

`~/.codex/auth.json` 权限为 `0600`，**不要提交或分享**。和 Codex CLI 共用这个文件。

## 用 ChatGPT 账号时多出来的

- 启动画面和 `/status` 显示套餐、Codex 用量上限和速率限制重置额度（重置需二次确认）；API key 时只显示 `API Usage Billing`。
- `/stats` 多一个 OpenAI activity 分页：累计、峰值、连续天数，以及日 / 周 / 累计图表（`v` 切换视图，方向键选日期）。
- 可以使用 [Codex Apps](codex-apps.md)。

## 命令在 OpenAI 下的行为

| 命令 / 工具 | 行为 |
| --- | --- |
| `/fast` | 开启优先处理，发送 `service_tier: "priority"`；网关不支持时直接显示服务端错误，再执行一次关闭 |
| `/compact` | 走 OpenAI 远端压缩，并保留之前的压缩历史，多次压缩不丢上下文 |
| `WebSearch` | 使用 OpenAI 服务端搜索，结果和引用转换成和 Claude 一致的格式 |

## 设置

| 配置项 | 写法 | 说明 |
| --- | --- | --- |
| `CLAUDE_CODE_USE_OPENAI` | `1` | 开启 OpenAI provider |
| `OPENAI_AUTH_TOKEN` / `OPENAI_API_KEY` | 字符串 | 凭据 |
| `OPENAI_BASE_URL` | URL | 兼容网关地址 |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` / `_SONNET_MODEL` / `_HAIKU_MODEL` | 模型名 | 别名映射 |

## 说明

画面来自实际运行：`OPENAI_BASE_URL` 指向测试用假服务，它返回两个模型（Gateway Alpha / Gateway Beta）。
