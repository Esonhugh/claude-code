# 客户端版本号（versionNumber）

<!-- lang: zh-Hans -->

> 英文名：`client-version-numbers` · 领域：模型与 Provider · [返回功能索引](README.md)

## 这是什么

Claude Code 发出的请求会在 `User-Agent` 等请求头里带上客户端版本号，服务端据此识别客户端。这个构建默认按官方 Claude Code 2.1.327 和 Codex CLI 0.170.0 发送版本号，不发送自己的构建版本。设置里的 `versionNumber` 可以逐项改这些版本号，例如官方发了新版、服务端要求更高的客户端版本时，不用等新构建。

它只改请求里的版本标识，不改 `claude --version` 显示的构建版本，也不升级实际使用的 SDK。

<details lang="en"><summary>English</summary>

> Name: `client-version-numbers` · Area: Models and providers · [Back to index](README.md)

## What it is

Requests carry a client version in `User-Agent` and a few other headers, and the server uses it to identify the client. By default this build sends the versions of official Claude Code 2.1.327 and Codex CLI 0.170.0, not its own build version. The `versionNumber` setting overrides each of them, for example when a new official release is out or a server asks for a newer client, without waiting for a new build.

It only changes the version identifiers in requests. It does not change the build version shown by `claude --version` or upgrade the SDK in use.

</details>
<details lang="zh-Hant"><summary>繁體中文</summary>

> 英文名：`client-version-numbers` · 領域：模型與 Provider · [返回功能索引](README.md)

## 這是什麼

Claude Code 發出的請求會在 `User-Agent` 等請求標頭裡帶上客戶端版本號，伺服端據此識別客戶端。這個構建預設按官方 Claude Code 2.1.327 和 Codex CLI 0.170.0 發送版本號，不發送自己的構建版本。設定裡的 `versionNumber` 可以逐項改這些版本號，例如官方發了新版、伺服端要求更高的客戶端版本時，不用等新構建。

它只改請求裡的版本標識，不改 `claude --version` 顯示的構建版本，也不升級實際使用的 SDK。

</details>

## 快速上手

在任意一层设置文件（例如 `~/.claude/settings.json`）里写要改的字段，没写的字段用默认值：

```json
{
  "versionNumber": {
    "ClaudeOAuthClientVersion": "2.1.328",
    "CodexVersion": "0.171.0"
  }
}
```

新会话启动后生效。

## 字段

| 字段 | 默认值 | 用在哪里 |
| --- | --- | --- |
| `ClaudeOAuthClientVersion` | `2.1.327` | 用 Claude 账号登录时，模型请求的 `User-Agent: claude-cli/<版本> (external, cli…)` |
| `ClaudeApiClientVersion` | `2.1.327` | API key、自定义 `ANTHROPIC_BASE_URL` 网关、Bedrock、Vertex、Foundry 的模型请求 `User-Agent: claude-cli/<版本> (…)`；其他请求的 `claude-code/<版本>`，包括 bootstrap、用量、设置同步、远程托管设置、策略限制、团队记忆、远程会话、模型发现和 MCP；WebFetch 的 `Claude-User (claude-code/<版本>; …)`；OpenAI provider 用 API key 时的 `User-Agent` |
| `ClaudeSDKVersion` | `0.128.0` | Claude 一侧模型请求的 `X-Stainless-Package-Version`（Anthropic API、自定义网关、Bedrock、Vertex、Foundry）。OpenAI 模式不发送这个头 |
| `CodexVersion` | `0.170.0` | 用 ChatGPT 账号登录 OpenAI provider 时：Responses 请求和模型列表请求的 `version` 头、模型列表的 `client_version` 参数、[`claude ssh`](ssh-remote.md) 代理转发的请求。API key 和兼容网关不发送 |

默认值与官方 Claude Code 2.1.327（内置 SDK 0.128.0）和 Codex CLI 0.170.0 发送的一致。

不受这个设置影响的：`claude --version`、实际安装的 SDK、`anthropic-version` 头，以及请求内容里记账用的 `cc_version`，它们仍然是这个构建自己的值。

## 规则

- 每个字段单独生效，可以只写一个。多层设置文件按通常的优先级合并（命令行 `--settings` 和托管设置 > 项目本地 > 项目 > 用户），同一字段取优先级高的那一层。
- 项目的 `.claude/settings.json` 也能设置这些字段，在别人的仓库里运行时请求头会跟着变。
- 值必须是非空、不含空白和控制字符的字符串。不合法的字段会被忽略并回落到默认值，同时给出设置警告；`versionNumber` 本身不是对象时整个忽略。同一个文件里的其他设置照常生效。
- 自己在 `ANTHROPIC_CUSTOM_HEADERS` 里写的 `User-Agent` 或 `X-Stainless-Package-Version` 优先于这里的设置。

## 说明

服务端是否接受任意版本号没有在真实服务上验证过。请求头的取值由单元测试和发布门禁的 `client-version-headers` 检查，后者用假的 OpenAI 服务和 ChatGPT 服务录下请求；Claude 账号登录和 Anthropic 模型请求只有单元测试。
