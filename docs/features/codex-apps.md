# Codex Apps

> 英文名：`codex-apps` · 领域：模型与 Provider · [返回功能索引](README.md)

## 这是什么

如果你在 ChatGPT 里已经连接了一些 App（GitHub、Gmail、Google Drive 等），用 ChatGPT 账号登录 [OpenAI provider](openai-provider.md) 后，这些 App 会自动作为工具出现在 Claude Code 里，不用再单独配 MCP。

还会一并带来 ChatGPT 侧托管的 skill，用到时才加载。

## 前提

三个条件都要满足：

1. 开启 OpenAI provider：`CLAUDE_CODE_USE_OPENAI=1`；
2. 用 **ChatGPT 账号**登录（`/login` 选 OAuth 或设备码），API key 不行；
3. 没有设置 `CLAUDE_CODE_DISABLE_CODEX_APPS=1`。

确认方法：`/mcp` 里能看到 `codex_apps` 已连接；`/status` 的 Usage 显示你的 ChatGPT 套餐。

## 怎么用

**直接说就行**：「看看这个仓库的 PR」，Claude 会自己找到合适的 App 工具（还没加载的会通过 `ToolSearch` 按需加载）。

**想指定 App 时**，在输入框打 `@codex-app:`，会列出已发现的 App 供选择；也可以直接写全：

```text
@codex-app:github 检查当前仓库的 pull requests
@codex-app:gmail 查找与发布相关的邮件
```

点名只会用到已发现、未被隐藏的 App，调用时照常走工具权限确认。

## 隐藏不想用的 App

在**用户级** `~/.claude/settings.json`（项目和本地设置里写了不生效）：

```json
{ "disabledCodexApps": ["connector-id-a", "connector-id-b"] }
```

只是不让 Claude 看到这些 App，连接本身保留，删掉配置即可恢复。完全关闭用 `CLAUDE_CODE_DISABLE_CODEX_APPS=1`。

## 安全边界

- 只信任 `codex_apps` 和 `codex_apps_plugins` 这两个固定来源；skill 名称、地址、分页和大小都会校验。
- ChatGPT 登录凭据只发给这两个固定的 App 服务地址；遇到 401 会刷新一次 token 再重试，只重试一次。
- 发现结果的缓存绑定到当前连接，不同连接之间不会串用。
- 托管 skill 不会重复暴露成工具，也不会出现在 `@` 补全的普通资源里。

## 设置

| 配置项 | 写法 | 说明 |
| --- | --- | --- |
| `CLAUDE_CODE_USE_OPENAI` | `1` | 前提 |
| `/login`（ChatGPT 账号） | — | 前提 |
| `CLAUDE_CODE_DISABLE_CODEX_APPS` | `1` | 关闭 Codex Apps |
| `disabledCodexApps`（仅用户级设置） | connector id 数组 | 隐藏指定 App |

## 说明

这项功能需要真实的 ChatGPT 账号和已连接的 App，文档采集环境没有可用账号，所以没有附终端画面。
