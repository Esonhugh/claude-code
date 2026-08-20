# SSH 会话、本地 UI、远程补全与配置边界综合改进方案

状态：已实现，待真实远端主机验收
适用版本：Claude Code `2.1.212`
日期：2026-08-20

## 1. 目标

本文统一解决三个相互关联的问题：

1. `claude ssh` 的远端 transcript 已存在或已恢复，但本地 Claude UI 没有显示完整历史，live 消息与 transcript 的 UUID、顺序和 resume identity 也可能分叉。
2. SSH 模式为了避免读取本机工作区而关闭了本地文件补全，但没有远端替代实现，导致 `@` 无法补全远端文件系统路径。
3. `settings.json`、`--settings`、`--setting-sources` 以及 provider/Auth 路由不应作为原始路径、配置或凭据透传到远端。它们应在本地读取和验证，API 请求通过本地受控代理完成鉴权和转发。

本方案不扩大到 Direct Connect、Remote Session、MCP 同步、远端插件同步或通用远程文件浏览器。

## 2. 核心原则

### 2.1 单一 transcript 事实源

SSH 模式以远端 child 的 transcript 为唯一事实源。本地 UI 是远端会话的 viewer/controller：

- 远端负责 session identity、resume/continue 解析、模型上下文和 transcript 持久化。
- 本地负责终端 UI、输入、权限确认、取消、远程文件补全和 Auth 代理。
- 本地不得再把 SSH 消息通过普通 `useLogMessages` 写成第二份独立 transcript，否则 fresh、resume、断线和 `--local` 模式都可能产生双写或分叉。
- 本地可以采用远端 `session_id` 作为当前 UI identity，但不能据此取得远端 transcript 的写入所有权。

### 2.2 控制面与数据面分离

- 对话数据面继续使用现有 stream-json 消息。
- history bootstrap 使用 SSH-only control request 和有界 history chunk，并保留原始 UUID、timestamp 和远端 `session_id`。
- 文件补全使用独立、结构化、只读的 control request，不执行任意 shell 命令，也不解析 shell stdout。
- control request 必须使用现有 `CLAUDE_CODE_SSH_REMOTE_TOKEN` capability，并具有请求关联、超时、取消、断线清理和迟到响应丢弃。

### 2.3 Auth 与 provider 由本地主机管理

- 真实 API key、OAuth token、cookie、account id、base URL、provider 选择及 Auth helper 只在本地解析和使用。
- 远端 child 只得到 Unix socket、host-managed 标记、SSH capability 和 provider 所需的非敏感占位变量。
- 本地代理删除远端请求携带的 Auth headers，再注入本地验证后的 headers。
- 远端 settings 不得覆盖 host-managed provider/Auth/session 变量。
- 日志、control response、远端 argv 和环境变量中都不得出现真实 secret 或完整本地 settings 内容。

## 3. 当前问题与证据

### 3.1 SSH transcript 与本地 UI

当前 SSH 启动分支仅给本地 REPL 注入连接提示，见 `src/main.tsx:4298-4389`。`--resume`/`--continue` 作为远端参数交给 print child，远端会加载自己的 `initialMessages`，但这些历史不会自动输出给本地 UI。

同时：

- `src/ssh/SSHSessionManager.ts:171-177` 发送 user 消息时写死 `session_id: ''`，并未携带本地 REPL 已生成的 UUID。
- `src/screens/REPL.tsx:4931` 已经向 remote interface 传入 `{ uuid }`，但 `src/hooks/useSSHSession.ts` 当前接口丢弃了该参数。
- `src/hooks/useSSHSession.ts:94-122` 只转换 live SDK 消息；普通 user echo 默认被 adapter 忽略。
- `src/screens/REPL.tsx:5383` 对 SSH 仍启用普通本地 transcript writer，导致本地镜像与远端 canonical transcript 可能分叉。
- SSH 断线当前是终止式行为，不存在自动 reconnect/catch-up。

因此，不显示并非单纯的 React 渲染问题，而是 history 没有进入本地消息流、user identity 丢失，以及本地错误取得 transcript 写入权三个问题叠加。

### 3.2 SSH 下的 `@` 补全

`src/screens/REPL.tsx:7106` 对所有 remote execution session 设置 `enableLocalIOCompletions=false`，这是正确的隔离行为；本地 UI 不应索引本机项目来冒充远端项目。

但 `src/hooks/useTypeahead.tsx:575-580`、`src/hooks/useTypeahead.tsx:1077-1095` 只存在本地 `generateUnifiedSuggestions()` 和 `getPathCompletions()` 路径。SSH manager 和远端 print child 没有文件候选协议，因此 SSH 下 `@` 必然没有远程文件候选。

### 3.3 settings 与 Auth 边界

SSH argv 在 `src/main.tsx:1012-1035` 被提前拆分，而本地 `eagerLoadSettings()` 到 `src/main.tsx:1109-1110` 才运行。当前 `src/ssh/rootSSHArgv.ts:71-94` 把 `--settings`、`--setting-sources` 标记为 `remote`，结果是：

- 本地进程在 settings 初始化前失去这两个参数。
- 本地文件路径被原样加入远端 child argv；远端通常不存在该路径。
- 本地 settings 中的 `sshConfigs`、provider、upstream 和 Auth 选择可能无法影响本地 SSH launcher/Auth proxy。

另一方面，`src/ssh/sshAuthProxy.ts` 和 `src/ssh/createSSHSession.ts` 已经提供正确的安全基础：本地读取/刷新凭据，远端通过反向 Unix socket 请求本地代理，远端环境只使用占位值。改进应补齐 argv/settings ownership，而不是再设计一套凭据传输协议。

## 4. 目标架构

```text
本地 Claude UI
  ├─ 读取并验证本地 settings / --settings / --setting-sources
  ├─ 解析 sshConfigs、provider、upstream、Auth mode
  ├─ 启动本地 Auth proxy（持有真实凭据）
  ├─ 显示远端 replay history + live stream
  ├─ 发送保留 UUID 的 user turn
  └─ 请求远端文件补全候选
            │
            │ SSH stdio control + stream-json
            │ reverse Unix socket（API data plane）
            ▼
远端 managed child
  ├─ 持有 canonical session_id 与 transcript
  ├─ 加载 remote user/project settings
  ├─ replay initial history（只读输出）
  ├─ 执行模型与工具
  ├─ 查询远端文件候选
  └─ API 请求经 Unix socket 回到本地代理
            │
            ▼
本地 Auth proxy
  ├─ 只允许模型 API 路由
  ├─ 删除远端 Auth headers
  ├─ 注入本地验证/刷新后的 Auth
  └─ 转发到本地确定的 upstream
```

## 5. 改进一：SSH transcript 与 UI 同步

### 5.1 原子 history bootstrap

`SSHSessionManager.connect()` 建立 stdio 后立即发起带 capability 的 `replay_history` control request。远端从已经加载的 `initialMessages` 投影历史，并用匹配 request ID 的有界 chunk 输出：

```ts
type SSHReplayHistoryRequest = {
  subtype: 'replay_history'
  ssh_remote_token: string
}

type SSHHistoryChunk = {
  type: 'ssh_history_chunk'
  request_id: string
  sequence: number
  messages: SDKMessage[]
}
```

所有 chunk 完成后，远端发送匹配的 control response：

```ts
{
  session_id: string
  count: number
  last_uuid?: string
}
```

manager 校验 sequence、count、last UUID 和 session ID，在完成 response 前只缓冲 history；成功后一次性调用：

```ts
onBootstrap({ sessionId, history })
```

bootstrap 完成后才开放 `sendMessage()` 并把暂存的非 history SDK 事件交给 `onMessage()`。这样 history 有明确完成边界，大型 transcript 也不会形成单个超大 JSON 行。

history projector 规则：

- user、assistant、tool result、compact boundary 保留 UUID。
- user replay 明确带 `isReplay: true`。
- replay 不重新进入模型队列、不再次持久化、不触发 permission prompt。
- 不 replay UI-only、queue-only、progress-only、未支持的 system 噪声。
- fresh session 返回 count 为 0 的成功 bootstrap。

history 输出必须限定在 managed SSH 上下文，不能改变普通 SDK/print/bridge 的 `--replay-user-messages` 语义。本地不得直接通过 SSH 读取 `~/.claude/projects`；continue/resume/fork/compaction 解析仍由远端现有 loader 负责。

### 5.2 本地采用远端 identity

本地收到成功 bootstrap 时：

1. 校验 session ID 格式。
2. 将远端 ID 保存为独立 `remoteSessionId`，不调用 `switchSession(remoteId)`。
3. 保存 SSH resume context：原始 target、remote cwd、remote session ID。
4. history bootstrap 完成前禁止提交 user turn，避免 history/live 交错。

`--resume <id>`、`--continue`、按 title resume 和 fresh session 最终都以远端实际返回的 ID 为准，不由本地猜测。

### 5.3 UUID 与去重

- REPL 创建 user message 后，将同一个 UUID 传给 `useSSHSession.sendMessage()` 和 `SSHSessionManager.sendMessage()`；envelope 使用 bootstrap 得到的 `remoteSessionId`。
- 远端 transcript 使用该 UUID；远端 user ack/replay 返回同一 UUID。
- 本地维护有界 UUID 集合：history 和 live 统一去重。
- 本地已乐观插入的 current user 收到 echo 时不重复显示。
- assistant/tool result/compact boundary 仍按远端 UUID 显示一次。
- 去重依据 UUID，不依据文本内容，避免合法重复输入被误删。

### 5.4 禁止本地 SSH transcript 双写

SSH 模式关闭 `useLogMessages`。本地连接提示、history 和 live 消息可以显示，但不写入本地对话 transcript。远端 transcript 是唯一可 resume 的文件。

退出提示应使用：

```text
claude ssh <target> <remote-cwd> --resume <remote-session-id>
```

不能显示普通 `claude --resume <local-id>`。参数必须按 shell 安全规则引用。

### 5.5 失败行为

- history replay 失败：连接 fail-closed，不允许在“看不到历史但继续写原会话”的状态提交消息。
- live 消息中断：维持当前终止式行为，本阶段不实现自动 reconnect。
- 收到无效 session ID、重复 bootstrap 或顺序倒置：报告协议错误并终止 SSH session。

## 6. 改进二：SSH 远程 `@` 文件补全

### 6.1 协议

新增 SSH-only control request：

```ts
type SSHFileSuggestionRequest = {
  subtype: 'ssh_file_suggestions'
  version: 1
  query: string
  mode: 'fuzzy' | 'path'
  show_on_empty?: boolean
  limit: number
  ssh_remote_token: string
}

type SSHFileSuggestionResponse = {
  items: Array<{
    path: string
    kind: 'file' | 'directory'
    score?: number
  }>
  incomplete: boolean
}
```

约束：

- `query` 最大 4096 字符、拒绝 NUL；响应总字节数有上限。
- `limit` 限制为 `1..50` 并在远端再次 clamp；UI 默认 fuzzy 15、path 10。
- capability 必须与远端进程环境中的 token 常量时间语义匹配；不得接受缺失 token。
- response 不包含文件内容、权限、owner、mtime 或任意 shell stdout。
- fuzzy/path 复用远端内建索引和路径扫描，但明确禁用 `settings.fileSuggestion.command`，防止补全请求间接执行配置命令。
- `~/`、`./`、`../`、绝对路径的语义与远端本机 CLI 一致，访问权限仍由远端 OS 用户限制。

### 6.2 生命周期

- 每次请求使用独立 request ID 和 `AbortController`。
- 新输入、dismiss、模式切换、unmount 或断线取消旧请求。
- 取消使用相同 request ID 的 `control_cancel_request`，不能使用全局 interrupt。
- host 侧建议 2 秒超时，remote 侧建议 1.5 秒硬期限；迟到响应丢弃。remote 收到 cancel 后停止查询并不再输出结果。
- 冷缓存最多等待约 750ms；未完成时返回 `incomplete: true`，输入未变化时 UI 只重试一次。
- `StdinMessageSchema` 必须正式接纳 `SDKControlCancelRequestSchema`；print 主循环必须消费它。

### 6.3 UI 接入

为 `REPL → PromptInput → useTypeahead` 增加可选的 `remoteFileSuggestionProvider`：

- local session：继续使用现有本地实现。
- SSH session：只调用远端 provider。
- Direct Connect/Remote Session：没有 provider 时继续不提供文件补全。
- SSH 下不重新开启本地 MCP resource、agent、shell history、`/cd`、`/add-dir` 或本地文件索引。

## 7. 改进三：settings 与 Auth 本地边界

### 7.1 argv ownership

`--settings` 与 `--setting-sources` 改为 local-only：

- 保留在 `parseRootSSHArgv().remainingArgs`。
- 不进入 `PendingSSH.extraCliArgs`。
- 支持 flag 位于 `ssh` 前后、`--flag=value`、JSON inline 和路径形式。
- 继续由现有 `loadSettingsFromFlag()`、`loadSettingSourcesFromFlag()` 完成本地路径解析、JSON/schema 校验和 source 设置。
- 本地路径、inline JSON 及其内容不得出现在 remote command、debug log 或 child environment。
- `childArgs()`/`buildRemoteLaunchCommand()` 增加 fail-closed 防线，即使未来调用方绕过 root parser，也拒绝 `--settings`、`--setting-sources` 和等价 managed-settings 参数。

### 7.2 配置分类

| 分类 | 所有者 | 是否透传原值 | 处理方式 |
| --- | --- | --- | --- |
| `settings.json` / `--settings` / `--setting-sources` | 本地 | 否 | 本地读取、校验、合并 |
| `sshConfigs`、identity file、port、start directory | 本地 | 否 | 本地解析成 SSH 连接参数 |
| API key、OAuth、cookie、account id、Auth helper | 本地 | 否 | 本地刷新/验证，代理注入 headers；远端禁止执行 helper |
| provider、base URL、OpenAI Auth mode | 本地 | 否 | 本地选择并配置 Auth proxy；远端只得安全派生标记 |
| model 名称、effort、thinking、permission mode | 执行语义 | 只透传规范化值 | 本地解析后传递非敏感最终值 |
| resume/continue/session 语义 | 远端 | 是 | 远端 canonical transcript 所需 |
| tools、MCP、plugins、agents、system prompt | 远端执行配置 | 按现有显式 CLI 行为 | 保持远端文件语义；不从本地 settings 隐式投影 |
| 远端 user/project settings | 远端 | 不跨主机 | 由远端 child 按默认 sources 加载 |
| host-managed session/Auth env | 本地派生 | 仅占位/capability/socket | 远端 settings 永远不能覆盖 |

这里的关键边界是：本地 `--settings` 不被“安全地序列化后再传一次”。这样仍会泄露本地配置并混淆本地/远端路径语义。远端需要的执行配置必须来自显式、已分类的 CLI 参数，或来自远端自己的 settings。

### 7.3 本地 Auth 验证与代理

启动远端 child 前，本地必须完成：

1. 解析 provider 与 upstream。
2. 校验 upstream URL；非 loopback HTTP 继续拒绝。
3. 获取或刷新 Auth，至少完成一次可用性检查。
4. 启动 Unix socket proxy。
5. 仅在上述步骤成功后部署/启动远端 child。

代理继续执行：

- 只允许 Anthropic messages/count_tokens 或 OpenAI responses 路由。
- 限制请求体大小。
- 删除远端提供的 Auth、cookie、origin、referer 等 headers。
- 注入本地 headers。
- 删除上游 `set-cookie`。
- 不记录请求 body、Auth headers 或 settings 内容。

本地 gateway 的 custom headers 也必须由 proxy 读取和校验：拒绝 CRLF、hop-by-hop、`host` 以及覆盖最终 Auth 的 header；Auth header 最后写入。proxy 的上游 fetch 必须显式复用本地 proxy/CA/mTLS transport 配置，不能依赖 Bun 是否继承全局 dispatcher 的隐含行为。

远端 `managedEnv` 必须过滤全部 provider/Auth/session 变量，防止 remote settings 改写本地确定的路由。由于以下字段不是 `env`，还必须在 Auth getter/启动预取处显式短路：

- `apiKeyHelper`
- `awsAuthRefresh`
- `awsCredentialExport`
- `gcpAuthRefresh`

该短路只在 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` 的 inference 路径生效，不得破坏远端 Bash、MCP、hooks 对普通 `AWS_*`、proxy 或工具环境的合法使用。

## 8. TDD 实施顺序

每个切片执行一轮 RED→GREEN，不一次性编写所有测试。

### 切片 A：settings ownership

1. RED：`--settings` 在 `ssh` 前后均保留给本地且不出现在 `extraCliArgs`。
2. GREEN：调整 `rootSSHArgv` disposition。
3. RED：使用只存在于本地的 settings 文件能够解析 `sshConfigs`，remote command 不包含其路径/内容。
4. GREEN：复用现有本地 eager settings 流程。
5. RED：settings 中 Auth/provider 生效于本地 proxy，remote env 仍只有占位值。
6. GREEN：补齐本地校验与边界断言。

### 切片 B：user identity

1. RED：REPL 生成的 UUID 出现在 SSH stdin user envelope 中，session ID 为 bootstrap 得到的远端 ID。
2. GREEN：扩展 SSH send interface 并保存 remote session ID。
3. RED：相同 UUID 的 remote user echo 不重复显示。
4. GREEN：增加有界 UUID 去重。

### 切片 C：history replay

1. RED：空历史、正常历史、错误 capability、乱序/缺失 chunk、count/last UUID 不符、重复 bootstrap 均有确定结果。
2. GREEN：实现 managed SSH-only `replay_history`、chunk 和 readiness。
3. RED：本地按顺序显示 user/assistant tool_use/tool result/compact boundary/summary，且不本地写 transcript。
4. GREEN：接入 replay conversion、UUID 去重、compact reducer 和 SSH transcript writer gate。
5. RED：history bootstrap 失败时禁止发送新 turn。
6. GREEN：保持 fail-closed 状态并显示协议错误。

### 切片 D：远端文件补全

1. RED：schema 接受合法 file suggestion request，拒绝缺 token、超限 query/limit。
2. GREEN：增加协议类型/schema。
3. RED：远端 fuzzy/path 请求返回远端 fixture，错误 capability 被拒绝。
4. GREEN：实现远端 handler。
5. RED：host manager 支持并发关联、超时、取消、迟到响应和断线。
6. GREEN：实现 manager 生命周期。
7. RED：SSH `@` 使用 remote provider 且从不调用 local filesystem provider。
8. GREEN：接入 PromptInput/typeahead。

### 切片 E：resume hint

1. RED：SSH session 退出时显示 `claude ssh <target> <remote-cwd> --resume <remote-id>`，不显示本地 resume 命令。
2. GREEN：增加受控 resume-command override/context。

## 9. Agent 拆分与文件所有权

为避免多个 Agent 在共享 worktree 中互相覆盖，按文件所有权拆分，而不是简单按问题名称拆分。

### Agent 1：SSH 协议与远端 child

负责：

- `src/entrypoints/sdk/controlTypes.ts`
- `src/entrypoints/sdk/controlSchemas.ts`
- `src/cli/structuredIO.ts`
- `src/cli/print.ts`
- 相应 schema/structuredIO/print 测试

任务：history bootstrap/chunk、file suggestion control request、capability、取消与远端查询。先冻结协议接口，供其他 Agent 使用。

### Agent 2：SSH transcript/UI identity

负责：

- `src/hooks/useSSHSession.ts`
- `src/remote/sdkMessageAdapter.ts`（仅 SSH replay 所需的局部能力）
- `src/utils/gracefulShutdown.ts` 的 SSH resume context
- 相应 hook/adapter/shutdown 测试

任务：独立 remote identity、UUID 传递/去重、history 显示和 SSH resume hint。不得修改 `REPL.tsx` 或 `main.tsx`。

### Agent 3：settings 与 Auth boundary

负责：

- `src/ssh/rootSSHArgv.ts`
- `src/ssh/createSSHSession.ts`
- `src/ssh/sshAuthProxy.ts`（只有证据表明边界缺失时才修改）
- `src/utils/auth.ts`（host-managed inference helper 短路）
- `src/utils/managedEnv.ts` / `managedEnvConstants.ts`（只有缺失字段才修改）
- `src/ssh/mainIntegration.test.ts`
- `src/ssh/createSSHSession.test.ts`
- `src/ssh/sshAuthProxy.test.ts`

任务：local-only settings、无配置/secret 泄漏、本地 Auth/provider 校验、远端 helper 禁用。为 `SSHSession` 暴露非敏感 original target + remote cwd；不得修改 `SSHSessionManager.ts`。

### 主 Agent：远端 `@` UI 接入与整合

负责：

- `src/ssh/SSHSessionManager.ts`
- `src/hooks/useTypeahead.tsx`
- `src/components/PromptInput/PromptInput.tsx`
- `src/screens/REPL.tsx`（唯一所有者：transcript gate、readiness、remote file provider 接线）
- `src/main.tsx`（唯一所有者：SSH 启动/退出上下文整合）
- 相应 manager/typeahead 测试

主 Agent 还负责处理共享类型冲突、统一测试、构建和真实 SSH 验收。Agent 1 的协议先落地；Agent 2 与主 Agent 只依赖已约定接口，不重复修改协议文件。`createSSHSession.ts` 只由 Agent 3 修改，`SSHSessionManager.ts` 只由主 Agent 修改。

## 10. 验证矩阵

### 自动测试

- argv：settings flag 的位置、equals、inline JSON、缺值、dash-prefixed value、无 remote 泄漏。
- Auth proxy：Anthropic/OpenAI API key/OAuth、header stripping、route allowlist、body limit、invalid upstream。
- transcript：fresh、resume by ID、continue、history ordering、UUID round trip、history/live 去重、tool result、compact boundary。
- manager：history bootstrap/chunk 完整性；file suggestion 并发、超时、取消、迟到 response、disconnect、invalid payload/capability。
- UI：SSH provider、无 local filesystem 调用、快速输入 stale suppression、dismiss/unmount cancel。
- shutdown：SSH 与普通 local session 的 resume hint 分离。

### 构建与静态检查

```sh
bun test <focused test files>
bunx tsc --noEmit --pretty false
bun run lint
git diff --check
make build
```

以项目实际脚本为准，不使用 `npm`。

### 真实 SSH/tmux 验收

使用构建后的同一二进制和稳定测试主机，保存 debug log 与 pane capture：

1. fresh SSH：第一条 user UUID 在本地 UI、远端 transcript 和 ack 中一致。
2. resume：本地 UI 在输入前显示远端旧历史，发送新 turn 后无重复。
3. `@name` 与 `@./dir/`：只出现远端 fixture，不出现本地同名 fixture。
4. 快速修改/dismiss `@` 查询：无迟到候选。
5. 本地 `--settings` 定义 SSH config/provider；远端不存在该路径仍可启动，remote command/log 无该路径和内容。
6. 远端 settings 尝试覆盖 provider/Auth/session env：覆盖无效。
7. 退出：显示 SSH resume 命令；remote child、socket、proxy、ControlMaster 清理完成。

### 本次实施结果

- 三个并行 Agent 分别完成协议/远端 child、transcript/UI identity、settings/Auth boundary；主 Agent 完成 manager、typeahead、PromptInput、REPL 和启动整合。
- SSH 聚焦回归共 128 项通过；TypeScript、全项目 ESLint、`git diff --check` 和 `make build` 均通过。
- 使用 `built-claude ssh local --local` 在隔离 tmux 中完成真实进程验证：UI 在 history bootstrap 后进入 ready；`@./src/ssh/SSH` 返回 child 工作目录中的远端 provider 候选；退出提示使用远端 session ID、target 和 remote cwd。
- Auth proxy 的 Unix socket、custom headers、credential stripping、local transport options 由进程级测试覆盖。
- 尚未连接真实 Linux SSH 主机验证部署、`ssh -R`、ControlMaster 和远端已有大 transcript；这些仍按上面的真实 SSH 矩阵执行。

## 11. 非目标与后续工作

- 本阶段不实现 SSH 自动重连；断线后通过正确 resume 命令恢复。
- 不同步本地和远端的完整 settings 文件。
- 不把本地 MCP、plugins、hooks、skills 自动复制到远端。
- 不通过 shell 命令实现文件补全。
- 不把 Direct Connect 的历史或补全语义全局改成 SSH 语义。

如果后续需要自动重连，应基于本方案的 canonical remote identity、history replay 和 UUID 去重另立设计，而不是在本地 transcript 上继续补丁式合并。
