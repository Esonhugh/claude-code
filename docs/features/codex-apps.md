# Codex Apps

> 英文名：`codex-apps` · 领域：模型与 Provider · [返回功能索引](README.md)

## 作用与效果

OpenAI + ChatGPT OAuth 模式下，Codex Apps 作为 host-owned MCP tools 与 hosted MCP skills 接入。输入 `@codex-app:` 可浏览已发现的 App，`@codex-app:github ...` 直接点名；未加载的工具经 `ToolSearch` 按需加载。可按 connector 隐藏。

## 配置

| 配置项 | 位置 | 可选值 | 说明 |
| --- | --- | --- | --- |
| `CLAUDE_CODE_USE_OPENAI` | 环境变量 | `1` | 前提 |
| ChatGPT OAuth 登录 | `/login` | — | 前提；API key 模式不可用 |
| `CLAUDE_CODE_DISABLE_CODEX_APPS` | 环境变量 | `1` | 关闭 Codex Apps |
| `disabledCodexApps` | 用户级 settings（项目/本地不生效） | connector id 数组 | 从工具池隐藏，连接保留 |

```json
{ "disabledCodexApps": ["connector-id-a", "connector-id-b"] }
```

## 效果

需要真实 ChatGPT OAuth 账户与 `codex_apps` MCP 连接，本次文档采集环境没有可用账户，未附终端画面。可用 `/mcp` 确认 `codex_apps` 连接，用 `/status` → Usage 确认订阅状态。

## 详细说明

以下内容自原 README 迁入，保持原文。

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
