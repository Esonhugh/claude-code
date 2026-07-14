# Codex Apps 特性移植计划

## 1. 目标与结论

目标是在当前 TypeScript Claude Code 中兼容 Codex 的 Apps（Connectors）能力，使一个受信任、host-owned 的 `codex_apps` MCP 服务可以：

- 将多个 App/Connector 的工具安全地接入现有 MCP 和 `Tool[]` 体系；
- 保留 connector metadata，并为不同 App 建立互不冲突的模型工具命名空间；
- 支持现有 `ToolSearch` 延迟发现、MCP 调用、进度、elicitation、结果透传和动态刷新；
- 在具备正确的 ChatGPT/Codex 文件服务时处理 Apps SDK `openai/fileParams`；
- 可选地向 UI 暴露 accessible Apps 列表、启用状态和认证状态。

本计划不新建一套平行的 ToolSet runtime。Codex Apps 最终仍转换为当前项目的 `Tool[]`，进入 `appState.mcp.tools`，并由 `assembleToolPool()` 统一过滤、排序和去重。

推荐分为三个交付层级：

1. **MVP：模型侧工具兼容**——可信连接、metadata、命名、调用和 ToolSearch。
2. **完整工具兼容**——文件参数、App 级策略、认证失败处理和缓存。
3. **可选 control-plane parity**——accessible Apps、目录合并和 UI/API。

不能把“把一个普通 HTTP MCP server 命名为 `codex_apps`”视为完成移植。Codex Apps 是一个带有特殊认证、metadata 信任、缓存、文件上传和策略语义的受信任边界。

### 1.1 前提条件（硬门槛）

本特性只在当前进程处于 **OpenAI provider 模式**且完成 **ChatGPT OAuth** 登录时启用。两个条件缺一不可：

```text
getAPIProvider() === "openai"
        AND
getOpenAIAuthInfo()?.isChatGPT === true
        AND
存在可用的 OAuth access_token
```

在当前项目中，这通常意味着：

- `CLAUDE_CODE_USE_OPENAI=1`；
- `~/.codex/auth.json` 的 `auth_mode` 为 `chatgpt`；
- `tokens.access_token` 可用，并在需要时能通过 `tokens.refresh_token` 刷新；
- 浏览器授权码流程和 device-code 流程都属于可接受的 OAuth 登录，只要最终写入上述 `chatgpt` auth 记录。

以下凭证即使能调用 OpenAI Responses API，也**不能**启用 Codex Apps：

- `OPENAI_API_KEY` 或 `~/.codex/auth.json` 中的 `OPENAI_API_KEY`；
- 当前被标记为 `isChatGPT: false` 的 `OPENAI_AUTH_TOKEN`；
- 自定义 `OPENAI_BASE_URL` 上的 bearer token；
- Claude.ai OAuth、Anthropic API key 或 `claudeai-proxy` token；
- 仅设置 OpenAI 模式但尚未完成 OAuth 登录。

资格不满足时必须 fail closed：不注册 `codex_apps`、不连接 endpoint、不读取或缓存 Apps tools，也不向模型注入 Apps instructions。CLI/UI 应提示用户运行 `/login` 并选择 OpenAI OAuth，而不是建议填写 API key。

## 2. 研究来源

本计划基于以下两类证据：

- Claude Code session `2998ee86-c4a1-4ecd-a7ab-bd0573bca988` 的主日志：
  `~/.claude/projects/-Users-esonhugh-workspace-projects-WebStormProjects-cc-claude-code-dist-codex/2998ee86-c4a1-4ecd-a7ab-bd0573bca988.jsonl`；
- 当前工作区内的 Codex Rust 源码：`dist/codex/codex-rs/`，以及本项目 `src/` 下的 TypeScript 实现。

该 session 的主要结论是：`codex_apps` 不是 Codex 的整个 app-server，也不是普通 connector directory，而是 ChatGPT-hosted Apps 与 Codex MCP runtime 之间的受信任适配层。session 曾生成 `dist/codex/docs/plan/codex-apps-toolset-compatibility.md`；本文在重新核对当前代码后对其进行了目标仓库适配，并修正了 metadata schema、认证和文件上传边界。

本文不复制 session 中无关的命令输出、认证信息或其他私有内容。

## 3. Codex 中 `codex_apps` 的设计

### 3.1 分层

Codex 的实际层次是：

```text
VS Code / rich client
        │ JSON-RPC app/list、thread/*、turn/*
        ▼
app-server
        │
        ├── Connector Directory：所有可发现 Apps 的产品 metadata
        │
        └── core::connectors：合并 directory、accessible、enabled 和 plugin 来源
                        │
                        ▼
               codex-mcp / codex_apps
               host-owned MCP server
                        │
                        ▼
               ChatGPT Apps backend
```

对应源码：

- `dist/codex/codex-rs/codex-mcp/src/codex_apps.rs`：工具名称、title 和 namespace 规范化；
- `dist/codex/codex-rs/codex-mcp/src/codex_apps/file_params.rs`：`openai/fileParams` 模型 schema；
- `dist/codex/codex-rs/core/src/mcp_openai_file.rs`：执行时读取并上传本地文件；
- `dist/codex/codex-rs/core/src/connectors.rs`：从 MCP tools 聚合 accessible Apps；
- `dist/codex/codex-rs/connectors/src/app_tool_policy.rs`：App/tool enablement 和 approval policy；
- `dist/codex/codex-rs/app-server/src/request_processors/apps_processor.rs`：`app/list`、缓存和异步更新；
- `dist/codex/codex-rs/core/src/context/apps_instructions.rs`：模型侧 Apps 使用说明。

### 3.2 一台 MCP server 承载多个 App

普通 MCP server 通常只有 server/tool 两级命名。当前 `dist/codex` 实现从每个 MCP tool 的标准 `_meta` 对象读取 Connector 扩展字段，而不是从 tool 顶层读取：

```json
{
  "_meta": {
    "connector_id": "calendar",
    "connector_name": "Google Calendar",
    "connector_description": "Manage calendar events"
  }
}
```

兼容别名包括 `connector_display_name` 和 `connectorDescription`。普通 MCP server 上的这些保留字段会被主动删除；只有解析后的保留 `codex_apps` connection 才会把它们提升为可信 Connector metadata。

然后将模型可调用名称拆为：

```text
callable namespace = codex_apps__<sanitized connector name>
callable name      = <去除 connector 前缀后的 tool name>
```

原始 MCP tool name 必须继续保存，用于真正的 `tools/call`。

### 3.3 accessible Apps 从工具反推

Codex 只接受来自保留的 `codex_apps` server 的可信 connector metadata。一个 connector 至少包含一个有效工具时，才能被聚合为 accessible App。

`_meta["_codex_apps"].synthetic_link = true` 的工具只用于连接/安装入口，不应让 connector 被误判为已经可用。

### 3.4 Apps 目录和 accessible Apps 是两件事

- Connector Directory 表示“可以发现或安装什么”；
- `codex_apps` MCP tools 表示“当前账号实际上能调用什么”；
- `app/list` 将两者与 enabled config、plugin provenance 合并。

MVP 不需要复制整个 `app/list`。只实现模型工具兼容时，可以仅从 tools 得到 accessible 子集。

### 3.5 host-owned 认证

Codex Apps 存在两层不同的认证，移植时不能混为一个 token：

1. **宿主到 `codex_apps` MCP 的认证**：Codex 根据 ChatGPT backend base URL 构造 Streamable HTTP endpoint；`chatgpt.com` 对应 `/backend-api/wham/apps`，Codex API base 对应 `/apps`。连接由 host-owned ChatGPT auth provider 注入当前 OAuth access token、账号/workspace identity，并发送 product SKU/originator headers。
2. **单个 App/Connector 的授权**：Google Drive、GitHub 等 connector 是否已绑定由 ChatGPT Apps backend 管理。MCP tool 返回可信 auth failure/link 后，客户端只负责提示或打开授权流程；授权完成后定向刷新 `codex_apps` tools。客户端不得自行拼接第三方 OAuth URL，也不得把第三方 connector token 保存到项目配置。

宿主认证链路应固定为：

```text
/login（browser 或 device code）
  → auth.openai.com OAuth
  → ~/.codex/auth.json（auth_mode: chatgpt，0600）
  → 启动 Apps 前 refresh/eligibility check
  → host-owned auth provider 按请求读取 access token
  → 仅向受信任 ChatGPT Apps origin 发送 Bearer token + account identity
  → （目标增强）401 时强制 refresh 并重连一次；仍失败则 needs-auth
```

Codex Rust 实现还包含几条关键安全语义：

- 上游的实际启用门是 `apps_enabled && CodexAuth::uses_codex_backend()`，会接受 ChatGPT OAuth、外部 ChatGPT tokens、headers、Agent Identity 和 Personal Access Token，但拒绝 OpenAI API key；本文要求的 OAuth-only 是目标项目主动收紧的产品约束，而不是上游条件的逐字复制；
- 只有显式标记为 `McpServerAuth::ChatGpt` 的 server 才会收到 ChatGPT auth provider；
- ChatGPT token 只应发送到匹配的 ChatGPT origin；origin 不匹配时上游会降级为 generic OAuth，本文移植方案则直接 fail closed，不允许把 OAuth token 转发到自定义 endpoint；
- 保留的 `codex_apps` connection 复用共享 `AuthManager`，每次请求重新读取同一 account/workspace identity 下的 auth，因此能够跟随已经发生的 token refresh；
- `CODEX_CONNECTORS_TOKEN` 是 Codex 上游的调试覆盖，使用时会改变共享认证/缓存行为。由于本计划要求 OAuth-only，本项目不支持该覆盖作为 Apps 资格或生产回退路径。

需要区分“上游现状”和“本移植目标”：在所检查的 Apps MCP 路径中，没有看到 MCP 401 主动调用 `AuthManager::refresh_token_from_authority()`。上游动态 provider 能使用别处已经刷新的 token，但 MCP 401 本身通常转成 auth-required。上图中的“401 强制 refresh 并重连一次”是本文建议增加的恢复策略，不是对当前上游实现的逐行复刻。

这不是本项目已有的 `claudeai-proxy`：后者使用 Claude.ai OAuth、Anthropic MCP proxy 和 `user:mcp_servers` scope。两者不能混用。

### 3.6 文件参数是双阶段转换

对于 `_meta["openai/fileParams"]` 声明的参数，Codex：

1. 列工具时，把模型 schema 改成绝对本地路径字符串或字符串数组；
2. 调用工具时，读取文件、限制大小、上传至 OpenAI 文件服务；
3. 将本地路径改写为 downstream App 需要的 provided-file 对象，包括 `file_id`，以及 schema 接受时的 `mime_type`、`file_name`。

只做第 1 步会让模型生成本地路径，但 downstream 收到错误参数，因此必须把 schema shaping 和执行时上传作为一个不可拆分的能力交付。

## 4. 当前项目的可复用基础

### 4.1 单一工具池

- `src/Tool.ts` 定义 `Tool` 和 `Tools = readonly Tool[]`；
- `src/tools.ts` 的 `assembleToolPool()` 是 built-in + MCP 的单一聚合入口；
- MCP tools 已存入 `appState.mcp.tools`；
- deny rules、名称去重和 prompt-cache 稳定排序已经集中处理。

Codex Apps tools 应自然进入这条路径，不在 API request builder 中旁路注入，也不注册一个新的 built-in “Apps 调用工具”。

### 4.2 MCP runtime

`src/services/mcp/client.ts` 已提供：

- stdio/SSE/HTTP/WebSocket/Claude.ai proxy transport；
- `pending/connected/needs-auth/failed/disabled` 生命周期；
- tools、prompts、resources 拉取；
- annotations 到 read-only/destructive/open-world 的映射；
- progress、elicitation、session recovery 和 result metadata 透传；
- `tools/list_changed` 后的 cache invalidation 和 server-scoped replacement。

这些都应复用。

### 4.3 ToolSearch

现有 MCP tools 已能：

- 通过 `ToolSearch` 延迟加载；
- 使用 `_meta['anthropic/searchHint']` 增加关键词；
- 使用 `_meta['anthropic/alwaysLoad']` 强制首轮可见；
- 在 server 断开或工具变化时更新 deferred tool 提示。

因此 Apps 不需要复制 Codex 的 `tool_search` 实现，只需要提供稳定名称、connector search hint 和条件式模型说明。

### 4.4 Claude.ai connectors

`src/services/mcp/claudeai.ts` 已实现另一个 connector 产品面：从 Claude.ai 拉取组织 MCP server，并通过 `claudeai-proxy` 连接 Anthropic proxy。

它可以提供生命周期、去重、状态提示方面的实现参考，但不是 Codex Apps 的认证或协议实现，不能直接改名复用。

## 5. 当前差距与硬性约束

### 5.1 必须条件式信任 `_meta` 中的 connector 字段

最新 `dist/codex` 证据表明，`connector_id`、`connector_name` 和 `connector_description` 位于 MCP tool 的标准 `_meta`，并不要求扩展 tool 顶层 schema。当前项目真正缺少的是“按可信来源提取”和“对普通 MCP 剥离保留字段”的双路径：

1. 先继续使用标准 `ListToolsResultSchema` 解析 tool 和 `_meta`；
2. 只有内部 host-owned Apps registration 才从 `_meta` 提取 connector 字段；
3. 接受 `connector_display_name`、`connectorDescription` 兼容别名；
4. 对普通 MCP 删除这些保留 key，且不得把它们复制进 `mcpInfo`、权限 prompt、telemetry 或 App 列表；
5. malformed、空白或类型错误的值按缺失处理，不能让单个坏 tool 污染整个列表。

因此不再建议为 tool 顶层设计 `ToolWithConnectorSchema`。如当前 TypeScript MCP SDK 会保留 `_meta`，应直接在标准 parse 后做 trust-aware adapter；只有实测 SDK 连 `_meta` 都会丢失时才新增专用 raw parser。

### 5.2 信任不能只依赖 server name

如果普通 `.mcp.json` 用户配置只要命名为 `codex_apps` 就能获得特殊 metadata、文件上传或策略权限，会形成伪造边界。

特殊行为必须依赖内部来源标记，例如：

```ts
type McpConnectionTrust =
  | { kind: 'ordinary' }
  | {
      kind: 'host-owned-codex-apps'
      authKind: 'chatgpt-oauth'
      backendOrigin: string
      accountKey: string
      workspaceKey?: string
    }
```

该标记必须由内部 host integration/factory 创建，不得作为公共 MCP JSON schema 中可自由设置的字段。server name 只能作为 wire identity，不能作为唯一授权依据。

上游 Codex 主要通过 MCP catalog 来源优先级保护保留名称：`Compatibility` registration 高于普通 `Config`，host `Extension` 又可显式覆盖 compatibility；完成 catalog resolution 后，许多特殊分支仍直接判断 `server_name == "codex_apps"`。目标项目没有完全相同的 catalog，因此不能只移植最后的名称判断，必须保留显式 trust/source discriminator。

### 5.3 扁平 Anthropic tool name 需要额外设计

Codex 内部可分别保存 namespace 和 callable name；当前项目向模型暴露一个扁平名称。建议格式：

```text
mcp__codex_apps__<connector_slug>__<callable_name>
```

实现必须满足 Anthropic tool name 的长度和字符约束。超长时使用稳定截断 + 短 hash，且在一次工具列表构建中检测碰撞。不能静默依赖 `uniqBy()` 丢弃后出现的工具。

### 5.4 模型名、权限名和 wire 名不同

至少需要区分：

- `modelName`：上面的 connector namespaced 名称；
- `permissionName`：默认与 `modelName` 一致；
- `wireToolName`：server 返回的原始名称，用于 `tools/call`。

当前 `mcpInfo.toolName` 同时参与 CLI 序列化、显示和权限重建。移植时应集中定义 `McpToolInfo`，增加 `wireToolName`/connector metadata，或调整 `getToolNameForPermissionCheck()`：有 `mcp__` 前缀时优先使用 `tool.name`，仅在 SDK no-prefix 模式下由 `mcpInfo` 重建。

必须保证：精确 allow/deny rule 使用模型实际看到的名字，`mcp__codex_apps` 和 `mcp__codex_apps__*` 仍可阻断整个 host-owned server，而实际 MCP call 始终使用 wire name。

### 5.5 必须复用现有 OpenAI OAuth 凭证所有者

当前项目已经具备可复用的 OpenAI OAuth 基础：

- `src/utils/auth.ts` 的 `getOpenAIAuthInfo()` 可区分 ChatGPT OAuth 与 API key，并返回 `accessToken`、`accountId` 和 `isChatGPT`；
- `src/services/openai-oauth/storage.ts` 以 `0600` 写入 `~/.codex/auth.json`，并在写入后清理认证 memoize cache；
- `src/services/openai-oauth/refresh.ts` 在 token 临近过期或刷新周期到达时使用 refresh token 更新 `auth_mode: "chatgpt"` 的凭证；
- OpenAI compat 请求已在 ChatGPT 模式发送 `chatgpt-account-id`。

因此不应再新建第二套 Apps token store。应在 Apps connection factory 前增加专用资格门：先确认 OpenAI provider，再刷新 token，随后重新读取 `getOpenAIAuthInfo()`，且只有 `isChatGPT === true` 才创建 host-owned registration。

Apps auth provider 必须按请求异步取得最新 token，而不是在连接建立时永久捕获字符串。收到 401 时只允许：强制 refresh 一次、清理认证缓存、重建连接并重试一次；再次 401 则进入 `needs-auth`，清理该账号的 Apps tools/cache 并提示重新 `/login`，禁止无限重试。

该 401 策略是目标项目的可靠性增强。实现和测试不得错误声称这是当前 `dist/codex` Apps MCP 已有行为；上游当前只保证动态 provider 跟随同一身份下已经刷新的 token。

不得默认读取 Claude.ai token，不得把 OAuth token 写入 `.mcp.json` 或普通项目配置，不得在日志、错误、telemetry 中输出 token/header。API key 和 `OPENAI_AUTH_TOKEN` 不能作为降级路径。

### 5.6 Anthropic Files API 不能替代 OpenAI Apps 文件协议

本项目虽有 `src/services/api/filesApi.ts`，其文件 ID 和认证域属于 Anthropic。除非 backend 明确支持，不能把它生成的 ID 填进 OpenAI provided-file 参数。

没有兼容 uploader 时，应 fail closed：不向模型暴露声明了 `openai/fileParams` 的 App tool，或保留原始 provided-file schema 并明确不支持本地路径。推荐前者，避免模型误调用。

## 6. 建议架构

```text
OpenAI mode + ChatGPT OAuth eligibility gate
        │ 从现有 OAuth owner 产生可信 registration（不是公共 MCP JSON）
        ▼
MCP connection manager
        │ Streamable HTTP + 动态 OAuth provider + account identity
        ▼
Codex Apps tools/list parser
        │ 从可信 tool `_meta` 提取 connector 字段
        ▼
Apps tool adapter（纯函数）
        ├── metadata validation
        ├── namespace/name/title normalization
        ├── fileParams capability check
        ├── App policy evaluation
        └── structured McpToolInfo
        ▼
现有 MCP Tool converter/call runtime
        ▼
appState.mcp.tools
        ▼
assembleToolPool() + ToolSearch + permissions
```

建议新增目录：

```text
src/services/apps/
  types.ts
  trust.ts
  toolMetadata.ts
  toolNormalization.ts
  fileParams.ts
  auth.ts
  policy.ts
  accessibleApps.ts          # 第二阶段
  prompt.ts
```

其中纯工具转换不得依赖 React、全局 AppState 或网络，以便 fixture 单测。

## 7. 建议数据模型

### 7.1 可信连接来源

公共 `McpServerConfigSchema` 保持不接受可信标记。内部 resolved registration 可以扩展为：

```ts
type ResolvedMcpRegistration = {
  name: string
  config: ScopedMcpServerConfig
  trust: McpConnectionTrust
}
```

如果修改所有配置流成本过高，第一版可以只在 `ConnectedMCPServer` 上增加由内部连接工厂写入的 `trust`，但任何 reconnect/cache key 都必须保留该值。

### 7.2 Apps tool metadata

```ts
type CodexAppConnectorMetadata = {
  id: string
  name?: string
  description?: string
  syntheticLink: boolean
  pluginDisplayNames?: string[]
}

type McpToolInfo = {
  serverName: string
  wireToolName: string
  permissionName: string
  connector?: CodexAppConnectorMetadata
  openaiFileParams?: Record<string, Array<'mime_type' | 'file_name'>>
}
```

现有消费者如果暂时仍需要 `toolName`，可在迁移期保留别名，但新代码不得通过拆解 `Tool.name` 恢复 connector ID 或 wire name。

### 7.3 accessible App

第二阶段最小类型：

```ts
type AccessibleApp = {
  id: string
  name: string
  description?: string
  isAccessible: true
  isEnabled: boolean
  pluginDisplayNames: string[]
  toolNames: string[]
}
```

在没有 connector directory 数据源时，不伪造 logo、screenshots、install URL、review 或 branding。

## 8. 实施阶段

### Phase 0：协议、认证和产品边界确认

目标：在写生产 transport 前取得可重复、脱敏的真实协议样本。

工作项：

1. 保存一份脱敏 `tools/list` fixture，至少包含两个 connectors、同名工具、一个 synthetic link、一个 fileParams 工具；
2. fixture 固定 connector 字段位于 tool `_meta`，覆盖兼容别名、错误类型和空白值；验证当前 backend 是否返回 `nextCursor`；
3. 确认 `tools/call` 所需 request `_meta`、session/thread headers；
4. 确认 endpoint、Streamable HTTP 版本、product SKU/originator headers；
5. 用现有 OpenAI OAuth 实际验证 token refresh、`chatgpt-account-id`、workspace/account identity、401 和 logout 清理；
6. 确认文件上传 endpoint、大小限制、provided-file shape；
7. 确认 connector auth failure/link elicitation 的正式 result schema；
8. 决定与现有 Claude.ai connectors 并存时的产品优先级。

退出条件：协议 fixture 可离线驱动 adapter 测试；只接受 OpenAI 模式下的 ChatGPT OAuth；API key、通用 bearer token、Claude.ai/Anthropic 凭证均被资格门拒绝；未决项有明确 owner。

### Phase 1：可信来源与 connector `_meta` adapter

修改候选：

```text
src/services/mcp/types.ts
src/services/mcp/client.ts
src/services/mcp/config.ts
src/services/apps/trust.ts
src/services/apps/toolMetadata.ts
```

工作项：

1. 引入不可由公共 MCP JSON 伪造的 trust/source discriminator；
2. 普通和 Apps MCP 均先使用官方 `ListToolsResultSchema`，Apps adapter 再从标准 `_meta` 提取保留字段；
3. 普通 MCP 主动剥离 connector 保留 key，避免其进入下游结构；
4. reconnect、config equality、cache 和 AppState 更新保留 trust；
5. 未经信任的 server 即使同名或发送相同 `_meta`，也按普通 MCP 处理；
6. 加入 feature flag，默认关闭真实 backend 接入；feature flag 不能绕过 OpenAI + OAuth 资格门；
7. 在不满足资格时完全不创建 registration，并输出不含敏感信息的可操作状态原因；
8. 实现完整 `tools/list` cursor 循环；上游 `dist/codex` 当前保留 `next_cursor` 但调用方未继续分页，目标项目不要复制这一缺口。

测试：普通同名 server 伪造失败、可信 `_meta` 被提取、普通 `_meta` 保留字段被 strip、分页和 malformed metadata fail closed、reconnect 不丢 trust、API key/Claude.ai/custom-origin 均无法启用 Apps。

### Phase 2：纯函数名称和 metadata adapter

新增：

```text
src/services/apps/types.ts
src/services/apps/toolNormalization.ts
src/services/apps/toolNormalization.test.ts
```

实现：

- `parseTrustedConnectorMetadata()`；
- `normalizeCodexAppsToolTitle()`；
- `normalizeCodexAppsCallableName()`；
- `buildCodexAppsModelToolName()`；
- `isSyntheticLinkTool()`；
- 长度截断、hash 和 collision detection；
- connector name 缺失时按 ID fallback；
- `searchHint` 合并 connector name、描述和工具能力，并折叠换行。

要求：

- `Tool.name` 使用 connector namespace；
- wire tool name 原样保存；
- connector ID 作为结构化字段保存；
- 两个 connector 的同名工具不碰撞；
- 普通 MCP converter 输出保持不变。

### Phase 3：接入现有 MCP Tool converter 和权限

主要修改：

```text
src/services/mcp/client.ts
src/services/mcp/mcpStringUtils.ts
src/utils/permissions/permissions.ts
src/Tool.ts                         # 仅用于集中 McpToolInfo 类型时
```

工作项：

1. 从 `fetchToolsForClient()` 提取“单个 raw MCP tool → Tool”函数；
2. adapter 在转换前生成 model name、schema、metadata；
3. 调用闭包继续向 `callMCPToolWithUrlElicitationRetry()` 传 wire name；
4. permission suggestion 使用 model/permission name；
5. server wildcard 继续匹配全部 Apps tools；
6. SDK no-prefix 模式保持原行为；
7. 保持 annotations、progress、elicitation、session recovery、`structuredContent` 和 `_meta` 透传；
8. 不允许 connector metadata 降低 destructive/open-world 风险分类。

退出条件：Apps tools 出现在 `appState.mcp.tools`；`assembleToolPool()` 无需 Apps 特判；精确规则、server wildcard 和 wire call 都正确。

### Phase 4：连接、认证和动态生命周期

新增/修改候选：

```text
src/services/apps/auth.ts
src/services/apps/registration.ts
src/services/mcp/useManageMCPConnections.ts
src/main.tsx
src/cli/print.ts
```

工作项：

1. 实现 `getCodexAppsEligibility()`：严格检查 OpenAI provider、`isChatGPT`、access token 和受支持的 ChatGPT origin；
2. 复用 `checkAndRefreshOpenAITokenIfNeeded()`，定义按请求读取最新 OAuth token 的 host auth provider；
3. endpoint 只从受信任 ChatGPT backend 推导，不接受项目级 MCP URL 或任意 `OPENAI_BASE_URL`；
4. 构造 Streamable HTTP transport，发送经 fixture 验证的 Authorization、`chatgpt-account-id`、product SKU/originator headers；
5. 401 时强制 refresh 并重试一次；refresh/login 失败进入 `needs-auth`，不得回退 API key 或环境 bearer token；
6. 交互模式异步启动，不阻塞首屏；headless 模式有限等待，超时后不挂住主请求；
7. 复用 `tools/list_changed`、自动重连和 server-scoped tool replacement；
8. OAuth refresh、logout、account/workspace 变化时清理连接、工具和 account-scoped cache；
9. enterprise/strict/bare/policy 模式下默认 fail closed；
10. 明确与 `claudeai-proxy` connector 重复时的去重规则，不能只按展示名猜测。

### Phase 5：ToolSearch、Apps instructions 和显式 mention

新增/修改候选：

```text
src/services/apps/prompt.ts
src/utils/attachments.ts
src/utils/processUserInput/*        # 如决定结构化解析 app:// mention
src/tools/ToolSearchTool/*          # 仅在现有搜索信息不足时
```

仅当至少一个可调用 Apps tool 存在时，向模型注入短说明：

```text
Apps (Connectors) are represented by trusted MCP tools under codex_apps.
Use an already loaded app tool or discover deferred app tools with ToolSearch.
Do not list MCP resources merely to discover Apps.
```

工作项：

- 验证 connector name/description 能被 ToolSearch keyword 命中；
- 保持 `_meta['anthropic/alwaysLoad']` 行为；
- 支持 `[$name](app://connector_id)` 作为显式提示；
- 第一版可以把 app link 转为隐藏 attachment/search hint，不必复制 Codex 全部 structured user-input protocol；
- app mention 不得自动授权、安装或绕过权限；
- 无 Apps 时不注入说明，避免污染 prompt cache。

### Phase 6：`openai/fileParams` 端到端支持

新增：

```text
src/services/apps/fileParams.ts
src/services/apps/fileParams.test.ts
src/services/apps/fileUpload.ts
```

工作项：

1. 从 `_meta['openai/fileParams']` 解析声明字段；
2. 遍历 `$ref`、`anyOf/oneOf/allOf`、array/object schema，记录 downstream 接受的 optional fields；
3. 模型 schema 改为本地路径 string/string[]；
4. 工具调用前做路径解析、文件类型/大小/权限检查；
5. 通过正确的 ChatGPT/OpenAI uploader 上传；
6. 构造 provided-file 参数，仅发送 downstream schema 接受的字段；
7. abort 时取消读取/上传；同一调用内相同文件可去重；
8. 错误信息不泄露 token，路径只在允许的本地诊断/UI 中显示；
9. uploader 不可用时过滤相关工具并给出状态原因。

不得用 Anthropic Files API ID 代替 OpenAI file ID。

### Phase 7：App policy 与 connector auth failure

新增：

```text
src/services/apps/policy.ts
src/services/apps/policy.test.ts
src/services/apps/authFailure.ts
```

工作项：

- 实现 default → app → tool 的 enabled/approval 覆盖顺序；
- managed requirements 只能收紧，不能被用户配置放宽；
- missing destructive/open-world hints 按保守值处理；
- disabled App tools 在进入工具池前过滤；
- 将 Codex 的 `auto/prompt/writes/approve` 精确映射到当前 permission system；映射未确认前不得凭名称猜测；
- 只接受 connector ID 匹配的可信 auth failure；
- 与上游保持兼容时，可仅用可信 connector name/ID 构造 `https://chatgpt.com/apps/<slug>/<connector_id>`；必须 URL encode/校验 ID，并拒绝任意 origin、任意 scheme 或 result 中未经验证的 URL；
- auth 完成后定向刷新 `codex_apps` tools。

### Phase 8：accessible Apps、缓存和 UI（可选）

新增候选：

```text
src/services/apps/accessibleApps.ts
src/services/apps/cache.ts
src/components/apps/*               # 或扩展 src/components/mcp/*
```

工作项：

1. 只从可信 Apps tools 按 connector ID 聚合；
2. synthetic-only connector 不算 accessible；
3. cache key 至少包含 backend origin、account、ChatGPT user、workspace 类型和产品 SKU；上游 Apps tools cache 当前没有 backend origin，而 Directory cache 有，本项目应主动补齐；
4. cached-first，刷新完成后原子替换；失败时不以空结果覆盖有效缓存；
5. 暴露 `ready`，区分“尚未加载”和“确实为空”；
6. UI 第一版优先扩展 `/mcp`：按 App 分组 tools，显示 connected/needs-auth/disabled；
7. 只有具备合法 Connector Directory API 时才实现 discoverable/not-installed Apps；
8. 如外部 rich client 确实需要，再定义 `app/list`/updated API；不要为表面 wire parity 复制整个 Codex app-server。

## 9. 测试计划

### 9.1 Fixture

建立脱敏 fixture MCP server，覆盖：

- 两个 connectors，各有同名 `search` tool；
- connector name/ID 前缀工具；
- Unicode、非法字符和超长名称；
- read-only、destructive、open-world 和缺失 annotations；
- synthetic link；
- fileParams 单文件/数组/$ref/组合 schema；
- `tools/list_changed`；
- progress、elicitation、auth failure；
- malformed connector metadata。

### 9.2 单元测试

- 标准 MCP parse 保留 `_meta`；可信 adapter 提取 connector 字段，普通 adapter 剥离同名字段；
- 名称规范化、长度、hash、碰撞；
- wire/model/permission name 分离；
- fileParams schema 和执行参数改写；
- policy precedence 和 managed fail-closed；
- synthetic filtering 和 accessible 聚合；
- account/workspace cache 隔离。

### 9.3 集成测试

- pending → connected → tools available；
- ToolSearch 发现并加载 Apps tool；
- tool call 使用原始 wire name；
- allow/ask/deny 精确规则和 server wildcard；
- reconnect/list_changed 不产生 stale/duplicate tools；
- auth refresh/account switch 清理旧 tools；
- 非 OpenAI provider、OpenAI API key、`OPENAI_AUTH_TOKEN`、custom origin 和 Claude.ai OAuth 都不会注册 Apps；
- ChatGPT OAuth 过期后刷新成功；401 仅重试一次，失败后进入 `needs-auth`；
- file upload 成功、过大、非文件、权限拒绝、abort；
- 普通名为 `codex_apps` 的 MCP server 无法获得可信能力；
- strict/enterprise policy 阻断。

### 9.4 回归和交互验证

实施阶段使用项目现有 `bun` 测试脚本，先跑相关 MCP/permissions/ToolSearch 测试，再执行项目构建。不要使用 `npm` 替代项目约定。

交互验证至少包括：

1. `/mcp` 连接状态；
2. ToolSearch 按 connector 名发现工具；
3. 两个 connector 同名工具均可选择；
4. permission prompt 显示稳定的 namespaced 名称；
5. `tools/list_changed` 后工具原子更新；
6. 认证失败和重连；
7. fileParams 端到端调用；
8. 关闭 feature flag 后普通 MCP 行为完全不变。

## 10. 安全与兼容性检查表

- [ ] 可信 Apps source 不能由 `.mcp.json` 伪造；
- [ ] 只有 OpenAI provider + `auth_mode: chatgpt` OAuth 能创建 Apps registration；
- [ ] API key、通用 bearer token、自定义 origin 不能启用 Apps；
- [ ] ChatGPT OAuth token 只发送到受信任且匹配的 ChatGPT origin；
- [ ] 401 最多强制刷新并重试一次，失败后清理旧连接和工具；
- [ ] cache key 隔离 backend origin、account、workspace 和产品 SKU；
- [ ] 不记录 access token、authorization header 或 provided-file credential；
- [ ] 不复用 Claude.ai OAuth 作为 Codex Apps token；
- [ ] 不复用 Anthropic file ID 作为 OpenAI file ID；
- [ ] connector metadata 不能降低工具风险或权限要求；
- [ ] missing annotations 按保守值处理；
- [ ] App disabled/账号切换/连接失败时不残留旧工具；
- [ ] 所有名称在送入模型前满足字符、长度和唯一性约束；
- [ ] MCP 调用使用 wire name，而权限规则使用 model/permission name；
- [ ] auth/install URL 只能由可信 connector name/ID 按固定 ChatGPT Apps 模板构造，或来自未来明确验证过的可信协议字段；
- [ ] 普通 MCP、Claude.ai connectors、IDE MCP 和 SDK MCP 回归通过。

## 11. 非目标

第一阶段明确不做：

- 完整复制 Codex app-server 的 thread/turn/item JSON-RPC；
- 在没有合法数据源时伪造 Connector Directory 或 marketplace；
- 新建第二套 OpenAI/ChatGPT 登录或 Apps token store；
- 使用 API key、`OPENAI_AUTH_TOKEN` 或 `CODEX_CONNECTORS_TOKEN` 绕过 OAuth-only 前提；
- 将 `app/list` 暴露为普通模型工具；
- 让模型通过 `list_mcp_resources` 发现 Apps；
- 从工具名反解析 connector ID；
- 允许普通第三方 MCP 使用 host-owned file upload 或 connector auth；
- 为 Codex Apps 建立第二套绕过 `assembleToolPool()` 的工具池。

## 12. 验收标准

MVP（Phase 0–5）完成需同时满足：

- 仅在 OpenAI provider + ChatGPT OAuth 下启用，所有 API key/Claude.ai/custom-origin 路径 fail closed；
- token refresh、单次 401 retry、logout 和 account/workspace switch 生命周期通过集成测试；
- 只有内部可信 registration 能启用 Apps connector `_meta` 语义；
- connector metadata 在 `tools/list` parse 后完整保留；
- Apps tools 进入 `appState.mcp.tools`，工具池仍由 `assembleToolPool()` 唯一组装；
- 两个 connector 的同名工具无碰撞，长名称稳定；
- ToolSearch 可按 App 和能力发现 deferred tools；
- MCP call 使用原始 wire name；
- permission rules 使用模型可见 namespaced name，server wildcard 有效；
- `tools/list_changed`、reconnect、logout/account switch 不残留旧工具；
- 普通 MCP server 无法伪造 Apps metadata；
- 相关测试和构建通过。

完整工具兼容还要求 Phase 6–7：

- fileParams 从模型路径到 OpenAI provided-file 参数端到端成功；
- uploader 不可用时相关工具 fail closed；
- App/tool policy 和 managed constraints 生效；
- connector auth failure 可以安全触发认证并定向刷新。

`app/list`、directory 和 rich UI 属 Phase 8 的独立验收范围，不阻塞模型侧工具兼容。

## 13. 推荐执行顺序

```text
Phase 0 取得协议/认证/文件 fixture
  → Phase 1 建立不可伪造的信任边界和 connector `_meta` adapter
  → Phase 2 名称与 metadata 纯函数
  → Phase 3 接入 Tool、权限和 wire call
  → Phase 4 host auth 与动态生命周期
  → Phase 5 ToolSearch / instructions / app mention
  → MVP 构建、回归和交互验证
  → Phase 6 fileParams 端到端
  → Phase 7 App policy 与 connector auth
  → 按产品需求选择 Phase 8 control-plane/UI
```

最大的前置阻塞不是 ToolSet 或登录能力本身：当前项目已有 ChatGPT OAuth owner。真正需要确认的是 OAuth token 对 Apps endpoint 的请求契约、真实 `tools/list` connector `_meta` fixture 以及 OpenAI 文件上传协议。三者确认前可以安全完成资格门、离线 schema/normalization/permission 设计，但不应猜测生产 header、connector auth result 或文件 ID 语义。

## 14. Agent Handoff

本节面向后续接手实现或继续研究的 agent。除非有新的真实协议证据，否则应把下面的“已确认事实”和“目标项目决策”视为当前基线，不要重新从名称猜测架构。

### 14.1 当前状态与固定决策

当前只完成了源码研究和移植计划，尚未在 `src/` 实现 Codex Apps。固定决策如下：

1. 目标项目只在 OpenAI provider 模式启用 Apps；
2. 只接受 `~/.codex/auth.json` 中 `auth_mode: "chatgpt"` 的 ChatGPT OAuth；browser OAuth 和 device-code OAuth 都可，API key、`OPENAI_AUTH_TOKEN`、Claude.ai OAuth 和 `CODEX_CONNECTORS_TOKEN` 均不可；
3. 不新增第二套 token store，复用现有 OpenAI OAuth storage/refresh；
4. `codex_apps` 必须是内部 host-owned registration，不能由 `.mcp.json` 设置可信标记；
5. connector metadata 从 tool `_meta` 读取；普通 MCP 上的保留 connector keys 必须被剥离；
6. 模型名称、权限名称和 wire tool name 必须分离；
7. Connector 的第三方 OAuth token 永远由 ChatGPT backend 持有，目标项目只处理 auth failure、跳转和刷新；
8. 第一版继续复用现有 `Tool[]`、`appState.mcp.tools`、`assembleToolPool()` 和 `ToolSearch`，不新建工具 runtime。

### 14.2 上游 Codex 源码地图

以下路径均相对于项目根目录：

| 关注点 | 相对路径 | 关键内容 |
|---|---|---|
| host-owned server 注册 | `dist/codex/codex-rs/core/src/mcp.rs` | `McpManager::runtime_config_with_context()` 注册 compatibility `codex_apps`，合并 plugin/extension overlays |
| Apps feature/auth gate | `dist/codex/codex-rs/codex-mcp/src/mcp/mod.rs` | `host_owned_codex_apps_enabled()`、`effective_mcp_servers()`、origin downgrade、endpoint/header 构造 |
| MCP catalog 信任来源 | `dist/codex/codex-rs/codex-mcp/src/catalog.rs` | registration source 和 `Plugin < SelectedPlugin < Config < Compatibility < Extension` 优先级 |
| ChatGPT auth 注入 | `dist/codex/codex-rs/codex-mcp/src/connection_manager.rs` | 共享 `AuthManager` provider、env bearer override、Apps cache sharing、动态启动 |
| HTTP auth 优先级 | `dist/codex/codex-rs/rmcp-client/src/rmcp_client.rs` | bearer/header > runtime provider > stored MCP OAuth > unauthenticated |
| HTTP header 写入/401 | `dist/codex/codex-rs/rmcp-client/src/http_client_adapter.rs` | runtime auth header、MCP session header、401/AuthRequired 转换 |
| Connector metadata 解析 | `dist/codex/codex-rs/rmcp-client/src/rmcp_client.rs` | `list_tools_with_connector_ids()` 从 tool `_meta` 读取 connector 字段和别名 |
| Apps tool adapter | `dist/codex/codex-rs/codex-mcp/src/rmcp_client.rs` | trust-aware conversion、普通 MCP metadata strip、cache-first startup、reconnect |
| 名称与身份模型 | `dist/codex/codex-rs/codex-mcp/src/tools.rs` | `ToolInfo`、raw/model identity、64-byte 名称、hash/collision 处理 |
| Connector 名称规范化 | `dist/codex/codex-rs/codex-mcp/src/codex_apps.rs` | callable namespace/name/title 规范化 |
| Apps tools cache | `dist/codex/codex-rs/codex-mcp/src/codex_apps_cache.rs` | account/user/workspace scoped memory+disk cache、generation 防旧请求覆盖新值 |
| accessible Apps | `dist/codex/codex-rs/core/src/connectors.rs` | 从可信 Apps tools 聚合、synthetic link 过滤、ready 状态、accessible cache |
| Connector Directory | `dist/codex/codex-rs/connectors/src/lib.rs` | directory/workspace endpoints、分页、规范化、一小时 cache |
| Directory 请求鉴权 | `dist/codex/codex-rs/chatgpt/src/chatgpt_client.rs` | Bearer、`ChatGPT-Account-ID`、`OAI-Product-Sku`、account ID 要求 |
| Directory + accessible 合并 | `dist/codex/codex-rs/chatgpt/src/connectors.rs` | discoverable/accessibility 合并和 cache context |
| `app/list` control plane | `dist/codex/codex-rs/app-server/src/request_processors/apps_processor.rs` | cached-first、并行加载、updated notification、force refresh、分页 |
| App/tool policy | `dist/codex/codex-rs/connectors/src/app_tool_policy.rs` | enabled/approval precedence、managed constraints、保守 annotations |
| Tool 注册与 ToolSearch | `dist/codex/codex-rs/core/src/tools/handlers/mcp.rs` | namespace ToolSpec、search text、raw wire name 调用 |
| 调用、权限、auth failure | `dist/codex/codex-rs/core/src/mcp_tool_call.rs` | policy、approval、file rewrite、auth elicitation、hard refresh |
| Connector auth failure schema | `dist/codex/codex-rs/codex-mcp/src/auth_elicitation.rs` | `_codex_apps.connector_auth_failure` 校验与 URL elicitation |
| fileParams 模型 schema | `dist/codex/codex-rs/codex-mcp/src/codex_apps/file_params.rs` | `_meta["openai/fileParams"]`、local-path schema shaping |
| fileParams 执行上传 | `dist/codex/codex-rs/core/src/mcp_openai_file.rs` | 本地读取、大小检查、OpenAI upload、provided-file 参数重写 |
| Auth mode 语义 | `dist/codex/codex-rs/protocol/src/auth.rs` | `AuthMode::uses_codex_backend()` 与 `has_chatgpt_account()` |
| OAuth refresh/401 recovery | `dist/codex/codex-rs/login/src/auth/manager.rs` | ChatGPT token 持久化、refresh、模型 API 的 unauthorized recovery state machine |
| 动态 auth provider | `dist/codex/codex-rs/model-provider/src/auth.rs` | 每次请求读 AuthManager，并阻止 account/workspace switch 后复用旧状态 |
| Bearer/account headers | `dist/codex/codex-rs/model-provider/src/bearer_auth_provider.rs` | `Authorization`、`ChatGPT-Account-ID`、FedRAMP header |

阅读顺序建议：先看 `core/src/mcp.rs` → `codex-mcp/src/mcp/mod.rs` → `connection_manager.rs` → `codex-mcp/src/rmcp_client.rs` → `core/src/mcp_tool_call.rs`；需要 control-plane parity 时再看 connectors 和 app-server。

### 14.3 目标项目源码地图

| 关注点 | 现有相对路径 | 预期改动 |
|---|---|---|
| OpenAI/ChatGPT auth 读取 | `src/utils/auth.ts` | 复用 `getOpenAIAuthInfo()`；Apps gate 必须额外检查 `isChatGPT === true`；注意 env token/API key 的读取优先级高于 auth file |
| OAuth refresh | `src/services/openai-oauth/refresh.ts` | 复用 `checkAndRefreshOpenAITokenIfNeeded()`；为目标增强支持受控的 force refresh |
| OAuth storage/cache clear | `src/services/openai-oauth/storage.ts` | 继续使用 `~/.codex/auth.json` 和 `0600`；auth 更新后触发 Apps lifecycle invalidation |
| OAuth 类型 | `src/services/openai-oauth/types.ts` | 不为 Apps 新建 token 格式；如需事件只扩展生命周期类型 |
| 登录产品入口 | `src/components/OpenAIOAuthFlow.tsx`、`src/commands/login/login.tsx` | Apps 状态提示只能引导 browser/device-code OAuth，不能引导 API key |
| ChatGPT 请求 header 参考 | `src/services/api/openai-compat.ts` | 复用/抽取 Bearer 与 `chatgpt-account-id` 逻辑，避免复制后漂移 |
| MCP 配置与 transport | `src/services/mcp/config.ts`、`src/services/mcp/types.ts` | 公共 schema 不暴露 trust；增加内部 resolved registration/source 类型 |
| MCP list/call runtime | `src/services/mcp/client.ts` | cursor list、trust-aware metadata adapter、wire name、动态 auth、auth failure |
| MCP 生命周期 | `src/services/mcp/useManageMCPConnections.ts` | 内部 Apps registration、异步启动、auth/account switch 清理、重连 |
| MCP 名称/权限辅助 | `src/services/mcp/mcpStringUtils.ts`、`src/utils/permissions/permissions.ts` | model/permission/wire name 分离与 wildcard 保持 |
| Tool 数据模型 | `src/Tool.ts` | 集中定义扩展后的 `McpToolInfo`，避免消费者解析 tool name |
| 单一工具池 | `src/tools.ts` | 不增加 Apps 旁路；只验证过滤、去重和稳定排序 |
| ToolSearch | `src/tools/ToolSearchTool/ToolSearchTool.ts`、`src/tools/ToolSearchTool/prompt.ts` | 使用 connector name/description/plugin provenance 作为搜索文本 |
| app mention 输入 | `src/utils/attachments.ts` | 可选处理 `app://<connector_id>`，不得隐式授权或安装 |
| 新模块 | `src/services/apps/` | 建议放 `auth.ts`、`trust.ts`、`types.ts`、`toolNormalization.ts`、`fileParams.ts`、`policy.ts`、`authFailure.ts`、`cache.ts` |

不要直接修改 `dist/codex`；它是参考实现。生产改动应落在当前 TypeScript 项目的 `src/`。

### 14.4 必须保持的端到端时序

启动与发现：

```text
OpenAI provider gate
  → refresh existing ChatGPT OAuth if needed
  → 重新读取 auth，确认 isChatGPT、account identity 和可信 origin
  → 内部创建 host-owned codex_apps registration
  → Streamable HTTP initialize
  → 带 cursor 循环执行 tools/list
  → 从可信 tool._meta 提取 connector metadata
  → 规范化 model namespace/name，同时保留 wire name
  → 应用 App/tool enabled policy
  → 写入 account-scoped cache
  → 更新 appState.mcp.tools
  → assembleToolPool() / ToolSearch
```

工具调用：

```text
模型选择 namespaced tool
  → 使用结构化 McpToolInfo 找到 server + wireToolName
  → permission/App policy
  → 如有 openai/fileParams，先上传并改写参数
  → tools/call(wireToolName)
  → 普通结果：透传 content/structuredContent/_meta
  → connector auth failure：校验可信来源和 connector ID
  → URL elicitation 到固定 ChatGPT Apps URL
  → 用户完成授权后 hard refresh tools
  → 原子更新 accessible/tool cache，并允许模型重试
```

目标项目的宿主 OAuth 恢复：

```text
MCP 401
  → 同一 account/workspace 下 force refresh 一次
  → 清理 auth memoize，重建 transport
  → 原请求最多重试一次
  → 再次 401：needs-auth + 清理旧 Apps tools/cache + 提示 /login
```

### 14.5 不可破坏的安全不变量

- `server_name == "codex_apps"` 不是充分信任条件；必须同时具备内部 trust/source；
- 公共 `.mcp.json`、plugin tool metadata 和普通 MCP `_meta` 不能创建 host-owned trust；
- ChatGPT OAuth token 只能发往精确 allowlist 的 ChatGPT origin，不跟随跨 origin redirect；
- feature flag、debug 模式和测试配置不能绕过 OAuth-only gate；
- 如果 `OPENAI_AUTH_TOKEN` 或 `OPENAI_API_KEY` 遮蔽了磁盘上的 ChatGPT OAuth，资格门应直接拒绝，不得绕过现有读取优先级偷偷回退到 auth file；
- token、Authorization header、refresh token、provided-file credential 不进入日志、错误文本、telemetry 或 fixture；
- cache 至少隔离 backend origin、account ID、ChatGPT user ID、workspace 类型和产品 SKU；
- auth identity 变化必须重建 connection，不允许只换 header 后继续复用旧 account-scoped runtime；
- connector metadata 只能影响显示、搜索、路由和更严格的策略，不能降低权限风险；
- `wireToolName` 始终原样用于 `tools/call`，模型名不能反解析为 wire identity；
- `openai/fileParams` 只允许 host-owned Apps 使用，普通 MCP 不能借此获得 OpenAI 文件上传能力；
- Connector auth failure 必须来自 error result，且 failure connector ID 必须与当前可信 tool metadata 一致；
- auth/install URL 只能使用固定 HTTPS ChatGPT Apps origin和经过编码的可信 connector ID；
- refresh/list 失败不得以空数组覆盖仍有效的 last-known-good cache。

### 14.6 上游事实与目标项目有意差异

| 主题 | 当前 `dist/codex` | 本计划目标 |
|---|---|---|
| Apps auth gate | 任意 `uses_codex_backend()` auth | 仅 OpenAI provider + managed ChatGPT OAuth |
| debug bearer | 支持 `CODEX_CONNECTORS_TOKEN`，并绕过共享 cache | 不支持作为资格或回退路径 |
| Connector metadata | tool `_meta` | 相同，但增加显式内部 trust discriminator |
| 信任实现 | catalog 保护保留名称，后续大量 name check | 不依赖名称，使用结构化 trust/source |
| `tools/list` 分页 | 返回 `next_cursor`，当前调用方未继续翻页 | 实现完整 cursor 循环 |
| Apps MCP 401 | 动态 provider 跟随已发生 refresh；未见主动 AuthManager refresh | force refresh + reconnect + 单次 retry |
| install URL | 本地构造 `https://chatgpt.com/apps/<slug>/<id>` | 固定模板构造并加强 URL/ID 校验 |
| tools cache key | account/user/workspace，不含 backend origin | 加入 origin 和 product SKU |
| Directory cache key | 包含 ChatGPT base URL/account/user/workspace | 保持至少同等隔离 |

### 14.7 推荐的实现批次

后续 agent 应按可独立验证的批次提交，避免一个变更同时引入 transport、权限、文件上传和 UI：

1. **Batch A：资格门与 trust**——实现 `getCodexAppsEligibility()`、内部 registration、origin allowlist；先不连接真实 endpoint；
2. **Batch B：离线 tool adapter**——用 fixture 完成 `_meta` 提取/strip、namespacing、wire identity、cursor pagination、collision；
3. **Batch C：接入 MCP runtime**——连接 lifecycle、Tool[] 转换、ToolSearch、permissions、cache；
4. **Batch D：真实 OAuth transport**——动态 token provider、account identity、logout/switch invalidation、401 单次恢复；
5. **Batch E：Connector auth failure**——URL elicitation、hard refresh、accessible cache；
6. **Batch F：fileParams**——schema shaping、OpenAI uploader、provided-file rewrite；
7. **Batch G：可选 control plane**——Directory、`app/list`、rich UI。

每个 batch 都应保持 feature flag 关闭时的普通 MCP 行为不变。Batch B 可以在没有生产 endpoint 的情况下先完成，是最安全的首个实现任务。

### 14.8 仍需真实样本确认的事项

以下内容不能仅凭源码名字猜测，接手 agent 应优先获取脱敏 fixture 或用受控账号验证：

1. 当前生产 `tools/list` 的完整 `_meta`、pagination 和 MCP protocol version；
2. Apps endpoint 是否还要求 thread/session/request `_meta` 或额外 headers；
3. `X-OpenAI-Product-Sku`、`originator`、`ChatGPT-Account-ID` 的精确大小写和必填条件；
4. MCP 401 是否带 `WWW-Authenticate`，以及 refresh 后能否安全重放 initialize/list/call；
5. connector auth failure 的所有 `auth_reason`、`link_id`、error code 和 UI completion 语义；
6. Connector install URL 是否始终使用 `chatgpt.com/apps/<slug>/<id>`，以及 workspace/FedRAMP 是否有不同 origin；
7. OpenAI file upload endpoint、大小限制、download URL 生命周期和 provided-file 必填字段；
8. logout、OAuth refresh、account switch 在当前项目中的可观察事件入口；
9. 同一账号多个 workspace 时 `accountId` 是否已经充分表示 workspace，还是需要独立 workspace key。

所有 fixture 必须脱敏：删除 token、email、真实账号 ID、内部 URL query、文件下载 credential 和用户内容。

### 14.9 接手后的验证命令

项目使用 Bun。根据变更范围至少执行：

```bash
bun test
bun run lint
bun run build
```

开发时优先先跑新增的 `src/services/apps/*.test.ts`、相关 MCP、ToolSearch 和 permissions 测试，再跑全量命令。不得用 `npm install` 或生成新的 npm lockfile。交付说明必须列出：修改文件、实际运行的命令、未运行项及原因、真实 backend 是否验证、仍未解决的协议假设。
