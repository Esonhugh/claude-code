# MCP 配置与认证

<!-- lang: zh-Hans -->

> 英文名：`mcp` · 领域：插件与扩展 · [返回功能索引](README.md)

## 这是什么

MCP（Model Context Protocol）是一种「给 Claude 装外部工具」的标准。一个 MCP server 是一个小程序或网址，它告诉 Claude「我提供这些工具」，例如查天气、查数据库、操作浏览器。接上后，这些工具和内置的 Read、Bash 一样可以被 Claude 调用，名字形如 `mcp__<server>__<工具>`。

server 有两种接法：

- **本地命令（stdio）**：Claude 启动一个进程，通过标准输入输出通信；
- **远程网址（http / sse）**：连到一个 URL，通常需要 OAuth 登录。

<details lang="en"><summary>English</summary>

> Name: `mcp` · Area: Plugins and extensions · [Back to index](README.md)

## What it is

MCP (Model Context Protocol) is a standard way to give Claude external tools. An MCP server is a small program or URL that tells Claude "I provide these tools", for example weather lookup, database queries or browser control. Once connected, its tools can be called like the built-in Read and Bash, with names of the form `mcp__<server>__<tool>`.

There are two ways to connect a server:

- **Local command (stdio)**: Claude starts a process and talks to it over standard input and output.
- **Remote URL (http / sse)**: connect to a URL, usually with an OAuth sign-in.

</details>
<details lang="zh-Hant"><summary>繁體中文</summary>

> 英文名：`mcp` · 領域：插件與擴充 · [返回功能索引](README.md)

## 這是什麼

MCP（Model Context Protocol）是一種「給 Claude 裝外部工具」的標準。一個 MCP server 是一個小程式或網址，它告訴 Claude「我提供這些工具」，例如查天氣、查資料庫、操作瀏覽器。接上後，這些工具和內建的 Read、Bash 一樣可以被 Claude 呼叫，名字形如 `mcp__<server>__<工具>`。

server 有兩種接法：

- **本地命令（stdio）**：Claude 啟動一個程序，通過標準輸入輸出通訊；
- **遠端網址（http / sse）**：連到一個 URL，通常需要 OAuth 登入。

</details>

## 快速上手：给项目接一个 MCP server

**1. 写配置。** 在项目根目录建 `.mcp.json`（会提交进仓库，团队共用）：

```json
{
  "mcpServers": {
    "weather": { "command": "bun", "args": ["./weather-mcp.mjs"] }
  }
}
```

也可以用命令添加：`claude mcp add weather -- bun ./weather-mcp.mjs`（加 `-s project` 写进 `.mcp.json`，默认只对你自己生效）。

`claude mcp add -s project` 和 `claude mcp remove <name> -s project` 只增删 `.mcp.json` 里的那一条，其余内容原样写回：`"${MY_SECRET}"` 这样的变量引用不会被展开成明文，`$schema` 等其他顶层键和本版本不认识 `type` 的条目都保留。是否已存在按文件里的键名判断，所以不认识的条目也不会被同名 `add` 覆盖，也可以 `remove`。`.mcp.json` 不是合法 JSON、顶层不是对象或 `mcpServers` 不是对象时报 `.mcp.json is malformed (not valid JSON, or mcpServers is not an object)`，读不了文件（例如 `EACCES`）时直接报错，两种情况都不写文件，退出码为 1。文件不存在或只有空白时新建。

已经有一份 JSON 配置时用 `claude mcp add-json`。JSON 写成 `-` 时从标准输入读：

```bash
echo '{"type":"stdio","command":"echo"}' | claude mcp add-json -s user x -
# Added stdio MCP server x to user config
```

标准输入为空、只有空白或是终端时报 `There is no JSON on stdin. Pipe it in, or pass it as the argument.`；超过 1 MiB 时报 `The JSON on stdin is over the limit of 1 MiB.`。在 Claude Code 会话里运行（设置了 `CLAUDE_CODE_CHILD_SESSION`）时拒绝从标准输入读，因为权限确认看不到 server 的内容，要到会话外运行。JSON 直接写在参数里时不读标准输入。

**2. 批准。** 项目里的 server 可能执行任意代码，所以第一次打开时会问你是否启用：

![批准项目 MCP server](images/mcp-approve.png)

| 选项 | 效果 |
| --- | --- |
| Use this MCP server | 只启用这一个 |
| Use this and all future MCP servers in this project | 这个和以后新加的项目 server 都自动启用 |
| Continue without using this MCP server（默认选中） | 不启用，之后可以在 `/mcp` 里改 |

文案、选项顺序和默认选项与官方 2.1.303 一致；一次发现多个新 server 时改成多选列表。

**3. 用 `/mcp` 看状态。** 列出所有 server 和连接状态；配置里有问题的条目会在上方列出原因（这里故意放了一条类型写错的 `broken`，它被跳过，不影响 `weather`）：

![/mcp 列表](images/mcp-panel.png)

**4. 选中一个 server 按 `Enter`** 看详情，可以查看工具、重连、停用：

![server 详情](images/mcp-detail.png)

![工具列表](images/mcp-tools.png)

**5. Claude 调用 MCP 工具时**，和其他工具一样先问你。选第 2 项以后这个工具不再询问：

![调用前确认](images/mcp-ask.png)

![调用结果](images/mcp-call.png)

## 远程 server 与登录

```json
{
  "mcpServers": {
    "search": {
      "type": "http",
      "url": "https://mcp.example.com",
      "timeout": 30000,
      "oauth": { "scopes": ["read"] }
    }
  }
}
```

需要登录的 server 在 `/mcp` 里显示待认证，选中后按提示在浏览器完成授权。也可以在命令行：

```sh
claude mcp login search              # 打开浏览器做 OAuth
claude mcp login search --no-browser # SSH / 无界面时：打印授权链接，把跳转后的网址贴回来
claude mcp logout search
```

claude.ai 上的 connector 请在 `/mcp` 里登录，不走 `claude mcp login`。

## 配置写错了会怎样

每个 server **单独检查**：某一条写错（类型未知、缺 URL、字段不合法）只跳过那一条，并给出原因；其他 server 照常加载、照常弹出批准。`claude mcp list` 不实际连接未批准的 server，只显示状态和问题：

```text
Checking MCP server health...

weather: /root/.bun/bin/bun /tmp/claude-0/weather-mcp.mjs - ✓ Connected

MCP Config Diagnostics

For help configuring MCP servers, see: https://code.claude.com/docs/en/mcp

[Contains warnings] Project config (shared via .mcp.json)
Location: /tmp/claude-0/mcpw/.mcp.json
 └ [Warning] [broken] mcpServers.broken: Skipped — unknown MCP server type
 "weird" for server "broken"
```

跳过原因：`invalid_config`（字段不合法）、`unknown_type`（type 不认识）、`url_missing_type`（写了 url 却没写 type）。整份文件格式坏掉（例如 `mcpServers` 不是对象）时才整体不加载。

**同一个名字写在多个范围里。** 用户配置和项目 `.mcp.json` 都有 `dup`、项目那条还没批准时，`mcp list` 和 `mcp get dup` 用的是已批准的用户配置（`Scope: User config`），未批准的项目条目不再把它盖掉。两边地址不同时，诊断区多出一段 `[Conflicting scopes]`：`Server "dup" is defined in multiple scopes with different endpoints: user (…), project (…). OAuth tokens are stored per endpoint, so authenticating in one context will not carry over.`，下一行建议用 `claude mcp remove dup -s <范围>` 删掉多余的那条。

**添加时的检查和提示：**

- `claude mcp add -H` 回显 header 时，名字里带 `authorization`、`token`、`secret`、`api-key`、`cookie` 等字样的值显示为 `[REDACTED]`，写进配置的仍是原值。
- `claude mcp add-json` 不接受 `sdk`、`sse-ide`、`ws-ide`、`claudeai-proxy` 类型，例如 `Cannot add MCP server "sdkx": type "sdk" servers are registered by the host application at runtime, not stored in configuration`，退出码为 1。字段不合法时指出是哪个字段，例如 `Invalid configuration: url: expected string, received undefined`。
- `claude mcp add x https://example.com/mcp` 没写 `--transport` 时，警告文案为 `… looks like a URL, but is treated as a stdio server because --transport wasn't set.`。
- `claude mcp remove st -s user` 找不到时报 `No MCP server named "st" in user scope`。`claude mcp reset-project-choices` 在有待批准的 server 时多一行 `You will be prompted for approval next time you start Claude Code.`。

**连接失败的原因。** HTTP server 返回 404 时显示 `MCP endpoint not found at <origin>. Check the URL in your MCP config.`；返回 500 时显示 `HTTP 500: Error POSTing to endpoint: <响应正文>`。

## 调用工具时的结果与报错

- **结果太大。** MCP 工具结果超过 token 上限（环境变量 `MAX_MCP_OUTPUT_TOKENS`，不设时默认 25000）时存到文件，模型拿到的是文件路径和读取方式。用 `count_tokens` 计数失败或返回空时，改按字符数估算，不再直接放行整段结果。结果只有一个 text 块时存成纯文本 `.txt`（`Format: Plain text`），提示里写字符数和行数，例如 `Error: result (5,000 characters across 1 line) exceeds maximum allowed tokens. Output has been saved to …`，行太长不能用 Read 的 offset / limit 分段时会说明改用按字符范围读取。
- **读不存在的资源。** `ReadMcpResourceTool` 读到不存在的 URI（server 返回 -32002 或 invalid params）时不再算工具错误，而是返回 `Resource not found: <uri> — it may have been deleted or the URI is stale. Re-run ListMcpResourcesTool to refresh.`。
- **模型没见过 schema 的工具报错。** 工具按需加载（tool search）且这个工具的 input schema 还没发给模型时，工具返回错误后会在结果末尾附上它的 input schema；schema 超过 10,000 字符时只说明用 `ToolSearch` 的 `select:<工具名>` 加载后再调用。每个工具只附一次。
- **刚出现的工具。** server 发出 `tools/list_changed` 后模型立刻调用新工具，会等这次工具列表刷新完成再找工具，不再报 `No such tool available`。这项修复针对 `-p` 模式，交互模式下工具列表的批量刷新没有改，也没有验证过。

## 命令速查

| 命令 | 作用 |
| --- | --- |
| `/mcp` | 查看、启用 / 停用、重连、登录 server，查看工具 |
| `/mcp reconnect all` | 重连所有失败或待认证的 server；`-p` 模式下 `/mcp` 只打印状态 |
| `claude mcp add <name> -- <命令>` | 添加 stdio server；`--transport http <url>` 添加远程 server；`-s user/project/local` 选范围 |
| `claude mcp add-json <name> <json>` | 用一段 JSON 添加；`<json>` 写 `-` 时从标准输入读（上限 1 MiB） |
| `claude mcp list` | 列出 server 和健康状态（待批准、已停用的项目 server 不连接） |
| `claude mcp get <name>` / `remove <name>` | 查看 / 删除；`-s project` 只改 `.mcp.json` 里的这一条 |
| `claude mcp reset-project-choices` | 清除对项目 server 的批准 / 拒绝选择，下次启动重新询问 |
| `claude mcp login <name> [--no-browser]` / `logout <name>` | HTTP / SSE server 的 OAuth 登录与登出 |

## 设置（写在每个 server 的配置里）

| 字段 | 写法 | 说明 |
| --- | --- | --- |
| `timeout` | ≥ `1000`（毫秒） | 这个 server 的工具超时，优先于环境变量 `MCP_TOOL_TIMEOUT` |
| `alwaysLoad` | `true` | 工具定义一开始就全部加载，不走按需搜索 |
| `oauth.scopes` | 字符串数组 | OAuth 登录时请求的权限范围 |
| `bareElicitationCapability` | `true` | 只声明最基础的 elicitation 能力，兼容不支持新字段的 server |

配置来源：项目 `.mcp.json`、用户 `~/.claude.json`（`-s user`）、本地（`-s local`，只对当前项目的你生效）、插件、`--mcp-config` 参数。

## MCP Apps（工具自带界面）

有些 MCP server 的工具会在 `_meta.ui.resourceUri` 里指向一个 `ui://` 页面（MCP Apps，SEP-1865）。`claude web` 会把这个页面显示在工具卡片下方：

![claude web 显示 MCP App](images/mcp-apps-web.png)

- 页面跑在沙箱 frame 里，origin 是不透明的，读不到网页的登录状态，也调不了网页的 API。默认不能联网，只有 server 在资源的 `_meta.ui.csp` 里声明过的域名可以连。
- 页面能收到工具的输入和结果，能读同一个 server 的 `ui://` 资源，也能调用同一个 server 的工具。只给页面用的工具（`visibility: ["app"]`）和只读工具直接执行，其他工具要你先确认。
- `visibility` 里没有 `"model"` 的工具不会发给模型。`ListMcpResourcesTool` 的列表里也不列出 `ui://` 页面和 MIME 为 `text/html;profile=mcp-app` 的资源，模型知道 URI 的话仍然可以直接读。
- 终端界面不显示这些页面，只显示文字结果，和官方一致。`mcp_status` 的工具总会带上 `_meta.ui`（system init 的 capabilities 含 `mcp_tool_ui_meta_v1` 时可用）。SDK 客户端要显示页面时，启动 CLI 前设置 `CLAUDE_CODE_MCP_APPS_HOST=1`，CLI 会向 server 声明 `io.modelcontextprotocol/ui` 扩展，客户端再用 `mcp_read_resource` 和 `mcp_call` 读页面、调工具。

## 说明

画面来自实际运行：`weather` 是一个用 MCP SDK 写的 20 行示例 server；模型回复由测试用假 API 按脚本生成。
