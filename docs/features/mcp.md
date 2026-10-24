# MCP 配置与认证

> 英文名：`mcp` · 领域：插件与扩展 · [返回功能索引](README.md)

## 作用与效果

MCP 配置文件按 server 逐个校验：坏条目带原因跳过（`invalid_config` / `unknown_type` / `url_missing_type`），不会连累整份文件。`claude mcp login/logout` 为 HTTP/SSE server 做 OAuth；`claude mcp list` 显示待批准与停用的项目 server 而不连接；`/mcp reconnect all` 重连失败与待认证的 server。README 原先缺这一项。

## 配置

| 配置项 | 位置 | 可选值 | 说明 |
| --- | --- | --- | --- |
| `timeout` | server 配置 | ≥ `1000`（毫秒） | 单 server 工具超时，优先于 `MCP_TOOL_TIMEOUT` |
| `alwaysLoad` | server 配置 | `true` | 不延迟加载 |
| `oauth.scopes` | server 配置 | 字符串数组 | OAuth 请求的 scope |
| `bareElicitationCapability` | server 配置 | `true` | — |
| `claude mcp login <name> [--no-browser]` / `logout` | CLI | — | claude.ai connector 请用 `/mcp` |
| `/mcp reconnect all` | 斜杠命令 | — | `-p` 下 `/mcp` 只打印状态 |

```json
{ "mcpServers": { "search": { "type": "http", "url": "https://mcp.example.com", "timeout": 30000, "oauth": { "scopes": ["read"] } } } }
```

## 效果

`.mcp.json` 里一个合法、一个未知 type 的 server，`claude mcp list`：

```text
Checking MCP server health...
good: true  - ⏸ Pending approval (run `claude` to approve)
MCP Config Diagnostics
For help configuring MCP servers, see: https://code.claude.com/docs/en/mcp
[Contains warnings] Project config (shared via .mcp.json)
Location:~/work/.mcp.jso
         n
 └ [Warning] [bad] mcpServers.bad: Skipped — unknown MCP server type "weird" for server "bad"
```

```text
Usage: claude mcp login [options] <name>
Authenticate with an MCP server (HTTP or SSE)
Options:
  -h, --help    Display help for command
  --no-browser  Print the authorization URL instead of opening a browser (for SSH/headless sessions — paste
                the redirect URL back when prompted)
```
