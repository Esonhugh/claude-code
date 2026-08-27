# 官方 Claude Code CHANGELOG 迁移候选研究

## 1. 研究状态

- **研究日期**：2026-08-27
- **当前本地版本线**：`2.1.214`
- **当前本地源码提交**：`65e9d88`
- **官方 CHANGELOG 范围**：`2.1.89–2.1.246`
- **官方来源**：<https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md>
- **官方来源快照**：`cad6304e85e2767eac20044e752b010fff1bb4c3`，提交时间 `2026-08-26T23:06:33Z`
- **结论性质**：基于 CHANGELOG、当前源码、测试入口和 Git 历史的静态研究；不是官方二进制 parity 验收，也不证明候选在运行时一定可复现。

本仓库从官方 `2.1.88` 恢复，但已经独立实现大量后续能力。因此不能按版本号机械搬运；本清单只保留满足以下条件的项目：

1. 官方变更具有明确行为契约。
2. 当前源码能定位到缺失或部分缺失的控制流。
3. 能在本地 CLI 架构中独立实现，不依赖未公开的官方服务端。
4. 没有被官方后续版本回退或替代。

## 2. 状态与优先级

| 标记 | 含义 |
| --- | --- |
| `建议迁移` | 静态证据明确，适合直接进入测试驱动的实现阶段。 |
| `部分缺失` | 已有基础实现，但官方修复覆盖了当前遗漏的边界。 |
| `条件候选` | 需要先确认依赖、产品语义或运行时支持。 |
| `待动态验证` | 静态证据不足，必须先复现，不能直接声称存在 bug。 |

优先级：

- **P0**：权限、安全边界、跨项目隔离、secret 泄漏或确定性数据丢失。
- **P1**：通用 CLI 可靠性、资源上限、状态一致性和高价值兼容能力。
- **P2**：独立功能或 UX 改进，收益明确但不阻断当前安全与正确性。

## 3. P0：安全、权限与数据完整性

### P0-01 有界读取 settings 文件

- **官方版本**：`2.1.214`
- **官方变化**：`--settings` 指向设备文件或超大文件时不再无限读取；超过 2 MiB 明确失败。
- **当前状态**：`建议迁移`
- **本地证据**：`src/utils/settings/settings.ts:203-210`、`src/utils/settings/settings.ts:998-1000` 在路径解析后直接 `readFileSync`，没有 regular-file 和大小上限。
- **最小范围**：集中实现一个有界 settings reader；读取前检查类型和大小，读取过程也必须限制字节数以抵御 stat/read 竞态。
- **最小测试**：2 MiB 边界、超限文件、目录、FIFO/device mock、普通文件 symlink、读取期间扩张。

### P0-02 Agent definition/resume 服从 bypass 禁用策略

- **官方版本**：`2.1.223`
- **官方变化**：Agent definition 的 `bypassPermissions` 不能绕过组织禁用 bypass 的策略。
- **当前状态**：`建议迁移`
- **本地证据**：`src/tools/AgentTool/AgentTool.tsx:603-619` 和 `src/tools/AgentTool/resumeAgent.ts:155-163` 可直接采用 definition/metadata 的 mode，未检查 `isBypassPermissionsModeAvailable`。
- **最小范围**：在 direct spawn、background、nested 和 resume 共用的 effective mode 解析处拒绝或降级不可用的 bypass。
- **最小测试**：availability=false 时 definition 和 resume metadata 均不能获得 bypass；合法的父会话 bypass 继承保持不变。

### P0-03 MCP `headersHelper` 的 trust 与凭据环境隔离

- **官方版本**：`2.1.238`
- **官方变化**：project `.mcp.json`、plugin 和 Agent 文件中的 helper 必须服从目录 trust；低信任 helper 不继承 credential env。
- **当前状态**：`建议迁移`
- **本地证据**：
  - `src/services/mcp/headersHelper.ts:40-57` 在 non-interactive session 明确跳过 trust。
  - `src/services/mcp/headersHelper.ts:59-70` 使用 `shell: true` 并继承全部 `process.env`。
  - `src/tools/AgentTool/runAgent.ts:178-206` 将 inline MCP 改写为 dynamic scope，难以保留 Agent definition provenance。
- **最小范围**：保留 MCP config 来源目录；在 `-p`/SDK 下也执行 trust gate；helper 只获得必要 PATH、代理/证书变量和显式 server metadata，不继承 API/OAuth/cloud/Git/SSH 凭据。
- **最小测试**：未信任 project/`--add-dir` Agent helper 不执行；sentinel secrets 不可见；user/managed scope 保持兼容。

### P0-04 `.claude/worktrees` symlink containment

- **官方版本**：`2.1.212`
- **官方变化**：worktree 创建不能跟随仓库中的 `.claude/worktrees` symlink 在仓库外写入。
- **当前状态**：`建议迁移`
- **本地证据**：`src/utils/worktree.ts:206-228`、`src/utils/worktree.ts:237-260`、`src/utils/worktree.ts:323-333` 在 `mkdir`/`git worktree add` 前没有父目录 symlink/junction containment 检查。
- **最小范围**：创建前拒绝不安全的 symlink/junction；验证 canonical parent 在仓库内；缩小检查与写入间的 TOCTOU。
- **最小测试**：外部 symlink/junction、正常目录、不存在目录和竞态替换；外部目录必须零写入。

### P0-05 worktree Git 重定向逃逸

- **官方版本**：`2.1.216`、`2.1.222`
- **官方变化**：worktree Agent 不能通过 `git -C`、`--git-dir`、`--work-tree`、`GIT_DIR` 或 `GIT_WORK_TREE` 修改主 checkout。
- **当前状态**：`部分缺失`
- **本地证据**：`src/tools/AgentTool/AgentTool.tsx:1012-1041`、`src/tools/AgentTool/AgentTool.tsx:1151-1184` 主要依赖 cwd 隔离；`src/main.tsx:2812-2832` 仍可接收 Git 重定向环境变量。
- **最小范围**：worktree child 剥离 Git redirect env；Bash/Git permission analyzer 拒绝 canonical target 越出 isolation root；File tools 使用同一 containment 语义。
- **最小测试**：官方列出的四类重定向、symlink target 和正常 worktree 内 Git 操作。

### P0-06 `.claude` symlink 下的 Workflow/Cron 写入

- **官方版本**：`2.1.216`
- **官方变化**：Workflow 保存和 scheduled-task 写入不再跟随 `.claude` symlink 写出项目。
- **当前状态**：`建议迁移`
- **本地证据**：`src/tools/WorkflowTool/workflowScriptPersistence.ts:17-33` 先 `mkdir`/`writeFile`，写完才 `realpath`；`src/utils/cronTasks.ts:160-182` 直接写 `.claude/scheduled_tasks.json`。
- **最小范围**：在任何写入前验证 `.claude` 及中间组件；覆盖 Workflow script、run/session/task state、Cron durable state 和 lock file。
- **最小测试**：`.claude -> outside` 时所有入口拒绝且外部零写入；普通目录保持正常。

### P0-07 sandbox 尊重 settings source 和可信 `ripgrep`

- **官方版本**：`2.1.232`、`2.1.246`
- **官方变化**：project/local 不能选择 sandbox 的 `ripgrep` binary；filesystem policy 必须服从 `--setting-sources`。
- **当前状态**：`建议迁移`
- **本地证据**：
  - `src/utils/sandbox/sandbox-adapter.ts:301-349` 无条件遍历全部 `SETTING_SOURCES`。
  - `src/utils/sandbox/sandbox-adapter.ts:350-357` 从 merged settings 读取 `sandbox.ripgrep`。
- **最小范围**：filesystem 只读取 enabled sources；`ripgrep` 只允许 user、managed、flag settings；一个来源的 ripgrep object 必须整体选择，不能跨来源字段合并。
- **最小测试**：user/project/local/flag/policy 矩阵；被排除来源不得进入 runtime config。

### P0-08 nested Git repository 独立 trust

- **官方版本**：`2.1.232`
- **官方变化**：嵌套 Git repository 不能继承父仓库 trust。
- **当前状态**：`建议迁移`
- **本地证据**：`src/utils/config.ts:683-743` 和 `src/utils/config.ts:746-761` 明确沿父目录一直查到文件系统根，没有在新的 repository boundary 停止。
- **最小范围**：同一 repository 内普通子目录可继承；遇到独立 `.git` 目录或文件时停止向父 repository 查询。
- **最小测试**：普通子目录、nested repo、submodule、worktree `.git` file 和显式接受 nested trust。

### P0-09 Windows NT namespace 路径拒绝

- **官方版本**：`2.1.233`、`2.1.234`
- **官方变化**：remote read、session restore、CLAUDE.md include、Workflow script 和 upload 拒绝 `\??\` NT namespace 路径，关闭 NTLM credential leak 路径。
- **当前状态**：`建议迁移`
- **本地证据**：`src/utils/permissions/filesystem.ts:560-599` 覆盖 `\\?\`、`\\.\` 和普通 UNC，但没有 `\??\` namespace。
- **最小范围**：在公共路径边界加入 namespace 检测，并在任何 `stat`、`realpath`、read 或 upload 前调用。
- **最小测试**：`\??\C:\...`、`\??\UNC\host\share`、slash/case 变体；断言底层 I/O 未执行。

### P0-10 第三方 gateway credential 不得发送到 Anthropic telemetry

- **官方版本**：`2.1.246`
- **官方变化**：telemetry/metrics 请求只向 credential 所属 host 携带认证。
- **当前状态**：`建议迁移`
- **本地证据**：`src/services/analytics/firstPartyEventLoggingExporter.ts:572-592` 对固定 1P endpoint 调用通用 `getAuthHeaders()`；`src/utils/http.ts:87-100` 已有 gateway key 会失败的 TODO。
- **最小范围**：认证数据带 origin identity；仅 endpoint 与 credential origin 匹配时附加；第三方 gateway session 对 Anthropic telemetry 匿名发送或跳过。
- **最小测试**：Anthropic、staging、第三方 gateway、telemetry override 与 API key/Auth token/apiKeyHelper 组合矩阵。

### P0-11 Plugin option 禁止 shell-form interpolation，并隔离来源

- **官方版本**：`2.1.207`
- **官方变化**：shell-form hooks/monitors/headersHelper 不接受 `${user_config.*}`；`pluginConfigs` 不读取 project settings。
- **当前状态**：`建议迁移`
- **本地证据**：
  - `src/utils/hooks.ts:821-859` 将 option 替换进 shell command，`src/utils/hooks.ts:976-986` 以 `shell: true` 执行。
  - `src/utils/plugins/pluginOptionsStorage.ts:56-60` 从 merged settings 读取 `pluginConfigs`。
- **最小范围**：shell-form 禁止 user option interpolation；保留 argv exec-form 或 `CLAUDE_PLUGIN_OPTION_*` env；options 仅读取 user、flag 和 managed settings。
- **最小测试**：`;`、`$()`、反引号、引号和换行 payload；settings source precedence。

### P0-12 Hook exit code 2 保持 blocking

- **官方版本**：`2.1.214`
- **官方变化**：即使 hook stdout JSON schema 无效，exit code 2 仍然阻断。
- **当前状态**：`建议迁移`
- **本地证据**：`src/utils/hooks.ts:2521-2553` 先把 schema error 返回为 exitCode 1/non-blocking；`src/utils/hooks.ts:2672-2692` 的 exit 2 blocking 分支因此不可达。
- **最小范围**：进程 exit status 的 blocking 语义优先于 stdout schema；schema error 仅补充诊断。
- **最小测试**：exit 2 + invalid JSON/invalid schema/empty stdout/valid blocking JSON；exit 1 行为不变。

### P0-13 MCP CLI/diagnostics secret 最小披露

- **官方版本**：`2.1.161`、`2.1.234`
- **官方变化**：`mcp list/get/add` 不展开 secret；诊断保留 `${VAR}`，连接失败只显示 server origin。
- **当前状态**：`建议迁移`
- **本地证据**：`src/cli/handlers/mcp.tsx:261-320` 和 `src/commands/mcp/addCommand.ts:185-236` 可输出 URL/headers/env；`src/services/mcp/client.ts:1069-1162` 可记录完整 URL、error 和 stack。
- **最小范围**：统一 MCP display/log sanitizer；URL 只保留安全 origin；清理 userinfo/query/header/env/error cause。
- **最小测试**：Bearer、Cookie、API key、URL token、`${VAR}`、stdio env；stdout/stderr/debug log 均不含 sentinel。

### P0-14 Marketplace policy 和配置覆盖边界

- **官方版本**：`2.1.223`、`2.1.228`、`2.1.234`
- **官方变化**：支持 `owner/*` policy；高优先级同名 marketplace 整体替换，不能继承低层 headers；SCP-style policy 使用 Git 实际连接 host。
- **当前状态**：`建议迁移`
- **本地证据**：
  - `src/utils/plugins/marketplaceHelpers.ts:391-504` repo policy 主要是 exact comparison。
  - `src/utils/settings/settings.ts:529-548` 对 record object 深度合并。
  - `src/utils/plugins/marketplaceHelpers.ts:225-254` 用字符串正则提取 SCP host。
- **最小范围**：policy matcher 支持 owner wildcard 和 canonical Git target；同名 marketplace entry whole-object replacement；无法无歧义解析时拒绝。
- **最小测试**：HTTPS/SSH/SCP、userinfo/IPv6、同名低层 Authorization header、block 优先于 allow。

### P0-15 Agent frontmatter hook 使用定义目录 trust

- **官方版本**：`2.1.218`
- **官方变化**：Agent hook 只有在 Agent 文件自身目录被信任后才能运行。
- **当前状态**：`建议迁移`
- **本地证据**：`src/tools/AgentTool/loadAgentsDir.ts:716-743` 已保存 `baseDir`；`src/tools/AgentTool/runAgent.ts:679-697` 注册 hook 时没有使用目录 trust。
- **最小范围**：将 definition path/baseDir 传到 hook registration；project/`--add-dir` 按 own-directory trust；managed/built-in 保持现有可信语义。
- **最小测试**：trusted cwd 中的 untrusted external Agent 不得执行 hook；接受目标目录 trust 后执行。

### P0-16 Skill/command 参数只展开一次

- **官方版本**：`2.1.233`
- **官方变化**：参数值不能再次被解释成 template marker。
- **当前状态**：`建议迁移`
- **本地证据**：`src/utils/argumentSubstitution.ts:109-136` 依次执行 named、indexed、shorthand 和 full replacement，前一轮插入的 `$ARGUMENTS`/`$0` 会被后续轮再次展开。
- **最小范围**：对原始模板执行一次 token scan；replacement value 作为 opaque text。
- **最小测试**：参数值包含 `$ARGUMENTS`、`$ARGUMENTS[0]`、`$0`、named marker 和混合 marker。

### P0-17 Bash 长命令和 dangling operator fail closed

- **官方版本**：`2.1.214`、`2.1.246`
- **官方变化**：超过 10,000 字符始终 ask；尾随 `&&`/`||` 的 malformed command 始终需要审批。
- **当前状态**：`建议迁移`
- **本地证据**：
  - `src/tools/BashTool/bashPermissions.ts:1729-1737` 只记录 `cmdOverLength` telemetry，没有阻断。
  - `src/utils/bash/bashParser.ts:879-918` 可为缺失右侧 command 构造普通 list；`src/utils/bash/ast.ts:504-564` 可能只收集左侧 command。
- **最小范围**：长度 guard 位于所有 allow/parser 路径之前；parser 或 security walker 对 dangling operator 生成 error/ask。
- **最小测试**：10,000/10,001 边界；allow rule 下的 `echo ok &&`、`||`、newline/comment/redirect 组合。

### P0-18 MCP OAuth refresh lock fail closed

- **官方版本**：`2.1.118`
- **官方变化**：跨进程 refresh lock 失败时不再无锁刷新，避免 token/keychain 竞态。
- **当前状态**：`建议迁移`
- **本地证据**：`src/services/mcp/auth.ts:2160-2197` 在锁错误或耗尽重试后记录 `proceeding without lock` 并继续；`src/services/mcp/auth.ts:1784-1790` 的 XAA 路径仅进程内去重。
- **最小范围**：锁失败返回可重试错误，或等待持锁进程完成后重读 token；所有 refresh backend 复用同一跨进程互斥。
- **最小测试**：双进程成功、持锁进程崩溃、超时、stale/compromised lock；不得发生无锁 exchange。

### P0-19 Mailbox 与 prompt history 不得假成功或丢数据

- **官方版本**：`2.1.218`、`2.1.224`
- **官方变化**：history 写入竞态/失败不丢记录；`SendMessage` inbox 写失败不能报告成功。
- **当前状态**：`建议迁移`
- **本地证据**：
  - `src/history.ts:291-326` 在 `appendFile` 成功前清空 `pendingEntries`，catch 后记录已丢。
  - `src/utils/teammateMailbox.ts:148-191` 吞掉 create/write error；`src/tools/SendMessageTool/SendMessageTool.ts:161-178` 随后无条件返回 success。
- **最小范围**：history batch 只在 append 成功后提交删除，失败按顺序回队；mailbox 返回结构化 delivery result 或抛错。
- **最小测试**：首次失败后恢复、并发新增、create/lock/read/write/disk-full 注入；不丢失、不重复、不假成功。

### P0-20 长项目路径的 session identity

- **官方版本**：`2.1.224`
- **官方变化**：共享前 200 个 sanitized 字符的长路径不能跨项目读取/修改 session。
- **当前状态**：`部分缺失`
- **本地证据**：`src/utils/sessionStoragePortable.ts:288-320` 主路径已有 hash；`src/utils/sessionStoragePortable.ts:348-380` exact lookup 失败后返回第一个 prefix match，没有验证 canonical project identity。
- **最小范围**：项目 session 目录持久化 canonical identity；compat fallback 只接受 identity 匹配项。
- **最小测试**：两个共享 200 字符前缀的长路径，覆盖 list/read/resume/rename/fork/delete。

## 4. P1：可靠性、资源控制和通用兼容

### P1-01 frontmatter brace expansion 预算

- **官方版本**：`2.1.217`
- **当前状态**：`建议迁移`
- **本地证据**：`src/utils/frontmatterParser.ts:189-265` 递归生成完整笛卡尔积，没有输入长度、深度或总展开数限制。
- **建议**：加入硬预算；超限拒绝该 path rule并产生诊断，不能退化为更宽泛匹配。

### P1-02 Agent `maxTurns` 返回 partial

- **官方版本**：`2.1.246`
- **当前状态**：`建议迁移`
- **本地证据**：`src/tools/AgentTool/runAgent.ts:916-934` 收到 `max_turns_reached` 后只 log+break，后续生命周期可按 completed 收束。
- **建议**：保留已有输出，但标记 partial，并提示可通过 `SendMessage` 继续。

### P1-03 超长 diff 与大文件 Write 有界化

- **官方版本**：`2.1.246`
- **当前状态**：`建议迁移`
- **本地证据**：
  - `src/components/StructuredDiff/Fallback.tsx:208-301` 在任何单行截断前执行完整 word diff 和 wrap。
  - `src/tools/FileWriteTool/FileWriteTool.ts:268-392` 同时保留 old/new、生成完整 patch，并在结果中再次保留 `content`/`originalFile`。
- **建议**：单行在 word diff 前截断；大文件超过阈值时返回有界 preview/metadata，保持写入、LSP 和 stale-write 语义。

### P1-04 API 首响应超时

- **官方版本**：`2.1.243`
- **当前状态**：`建议迁移`
- **本地证据**：`src/services/api/claude.ts:1825-1860` 可无限等待 response headers；`src/services/api/claude.ts:1891-1952` watchdog 在 headers 到达后才创建。
- **建议**：dispatch 到 headers/first event 使用独立 deadline；约三分钟后重试一次，再返回专门错误。

### P1-05 MCP abort 返回 interrupted error

- **官方版本**：`2.1.246`
- **当前状态**：`建议迁移`
- **本地证据**：`src/services/mcp/client.ts:3389-3394` 对 `AbortError` 返回 `{ content: undefined }`，上层可能解释为成功空结果。
- **建议**：区分 incoming message、用户 interrupt、timeout、teardown；保持 tool_use/tool_result 配对并返回明确错误。

### P1-06 stream-json backpressure 与退出 drain

- **官方版本**：`2.1.208`、`2.1.214`
- **当前状态**：`建议迁移`
- **本地证据**：`src/utils/streamJsonStdoutGuard.ts:69-109` 不等待 `drain`；`src/utils/gracefulShutdown.ts:506-525` 固定等待 2 秒。
- **建议**：追踪 queued bytes/drain promise；退出等待有上限的动态 drain；正确处理 `EPIPE` 和永不 drain。

### P1-07 transcript persistence 失败契约和可见警告

- **官方版本**：`2.1.217`
- **当前状态**：`建议迁移`
- **本地证据**：`src/utils/sessionStorage.ts:568-689` queue entry 只有 resolve，batch 在 append 前被 splice；持续失败时等待者可能不终止且没有稳定告警。
- **建议**：失败显式 reject/结果化，batch 可恢复；每会话限频提示 disk full、权限失败或保存被环境变量关闭。

### P1-08 MCP stdio、LSP 和 file-read cache 有界化

- **官方版本**：`2.1.208`
- **当前状态**：`建议迁移`
- **本地证据**：
  - `src/services/mcp/client.ts:1009-1023` 每 server 可累积 64 MiB stderr。
  - `src/services/lsp/LSPServerManager.ts:59-64` 使用无界 openedFiles Map，close 尚未完整集成。
  - `src/utils/fileReadCache.ts:14-65` 只限制 1,000 项，不按字节计量。
- **建议**：stderr 用有界 tail；LSP 采用 50-doc LRU 并在 evict 发送 `didClose`；file cache 使用 16 MiB byte-accounted LRU。

### P1-09 plugin marketplace 持久化并发安全

- **官方版本**：`2.1.232`
- **当前状态**：`建议迁移`
- **本地证据**：`src/utils/plugins/marketplaceManager.ts:273-358` 采用独立 load/mutate/save；`src/utils/slowOperations.ts:250-278` 直接覆盖写，无 transaction/atomic rename。
- **建议**：lock 后重读、变更、schema validate、temp+fsync+atomic rename；损坏输入不得以空对象覆盖。

### P1-10 strict MCP config 不询问永不加载的 project server

- **官方版本**：`2.1.246`
- **当前状态**：`建议迁移`
- **本地证据**：`src/main.tsx:2611-2623` strict mode 跳过 auto-discovered configs，但 `src/main.tsx:3129-3139` 的 setup 没有 strict 状态；`src/interactiveHelpers.tsx:219-223` 仍处理 `.mcp.json` approval。
- **建议**：将 effective MCP source policy 传入 setup；strict/bare/remote-owned 路径跳过不会加载的审批。

### P1-11 MCP OAuth redirect 统一为 `127.0.0.1`

- **官方版本**：`2.1.229`、`2.1.231`
- **当前状态**：`建议迁移`
- **本地证据**：`src/services/mcp/oauthPort.ts:15-25` 生成 `http://localhost:<port>/callback`，而 callback listener 使用 `127.0.0.1`。
- **建议**：dynamic registration、authorization 和 token exchange 使用完全相同的 `127.0.0.1` URI。

### P1-12 MCP generic list pagination

- **官方版本**：`2.1.144`、`2.1.147`
- **当前状态**：`建议迁移`
- **本地证据**：`src/services/mcp/client.ts:1829-1835`、`src/services/mcp/client.ts:2139-2148`、`src/services/mcp/client.ts:2172-2184` 的 tools/resources/prompts 路径只请求一页。
- **建议**：通用 cursor paginator，带去重、循环 cursor 检测、最大页数、abort 和部分失败策略。

### P1-13 MCP per-server `request_timeout_ms`

- **官方版本**：`2.1.206`
- **当前状态**：`建议迁移`
- **本地证据**：`src/services/mcp/types.ts:28-134` 没有该字段；`src/services/mcp/client.ts:493-555` 使用固定 60 秒。
- **建议**：扩展 schema/normalization/client request；明确区别 request、tool execution 和 idle timeout。

### P1-14 MCP config 部分成功和 `mcp_server_errors`

- **官方版本**：`2.1.219`
- **当前状态**：`建议迁移`
- **本地证据**：`src/main.tsx:2149-2213` 任何 config validation error 都导致整体退出。
- **建议**：保留合法 servers；terminal startup warning；stream-json init 返回脱敏后的 skipped entries。

### P1-15 Plugin BOM 与 reload skill cache

- **官方版本**：`2.1.246`
- **当前状态**：`建议迁移`
- **本地证据**：`src/utils/plugins/pluginLoader.ts:979-1033` 等路径直接 JSON parse，不剥 BOM；`src/utils/plugins/refresh.ts:88-92` 只刷新 commands/agents，`src/utils/plugins/cacheUtils.ts:26-49` 未清 plugin skill cache。
- **建议**：manifest parser 接受 UTF-8 BOM；reload 刷新并正确统计 `skills/*/SKILL.md`。

### P1-16 Hook matcher exact/list/regex 语义

- **官方版本**：`2.1.191`、`2.1.195`
- **当前状态**：`建议迁移`
- **本地证据**：`src/utils/hooks.ts:1349-1383` 只有有限字符集合进入 exact/pipe 分支；含 `-` 的 identifier 会落入未锚定 regex，逗号列表不会按列表处理。
- **建议**：显式解析 comma/legacy pipe；普通 identifier exact-match；只有明确 regex syntax 才创建 RegExp。

### P1-17 Hook 完整契约

- **官方版本**：`2.1.119`、`2.1.121`、`2.1.139`
- **当前状态**：`建议迁移`
- **本地证据**：
  - `src/utils/hooks.ts:3478-3545` PostToolUse input 缺少 `duration_ms`。
  - `src/types/hooks.ts:101-107` 只有 `updatedMCPToolOutput`。
  - `src/schemas/hooks.ts:31-65` command hook 只有 shell string，没有 argv `args`。
- **建议**：加入纯工具执行时长、所有工具的 `updatedToolOutput`、exec-form argv 和 `continueOnBlock`；替换后重新执行 size/content normalization。

### P1-18 malformed/unknown hooks 局部恢复

- **官方版本**：`2.1.101`、`2.1.122`
- **当前状态**：`建议迁移`
- **本地证据**：`src/schemas/hooks.ts:194-212` 严格解析整个 hooks object；`src/utils/settings/settings.ts:217-225` 除 permission rule 外，schema error 可使整个 settings source 无效。
- **建议**：按 event/matcher/command 做可恢复解析，保留合法项并输出精确错误路径；managed policy 保持严格。

### P1-19 remote managed settings 单字段容错

- **官方版本**：`2.1.166`、`2.1.169`
- **当前状态**：`建议迁移`
- **本地证据**：`src/utils/settings/settings.ts:683-695` 对整个 remote payload `safeParse`，一个无效 UI 字段会丢弃全部有效 policy。
- **建议**：字段级恢复并记录错误；有效 remote policy 不能因无关字段错误而让低优先级 source 接管。

### P1-20 全局后台 Agent 并发和最终深度语义

- **官方版本**：`2.1.217`、`2.1.219`
- **当前状态**：`建议迁移`
- **本地证据**：当前 Workflow 有自身并发控制，但 direct/background Agent 未见统一的进程级 20-agent semaphore；`src/tools/AgentTool/subagentDepth.ts:3-23` 固定深度 5。
- **建议**：所有后台 Agent 共用默认 20 的 semaphore，支持 `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`；采用后续版本的最终默认 depth 3，并支持 `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`。
- **注意**：不要迁移 `2.1.212` 的累计 200-agent cap；该 cap 已在 `2.1.224` 删除。

### P1-21 Workflow container-aware concurrency

- **官方版本**：`2.1.229`
- **当前状态**：`建议迁移`
- **本地证据**：`src/tools/WorkflowTool/validateWorkflowSpec.ts:27-35` 和 `src/tools/WorkflowTool/workflowScriptRuntime.ts:83-88` 直接使用 host `availableParallelism()`。
- **建议**：统一 effective CPU helper，识别 cgroup v2/v1 quota 和 cpuset；spec/runtime 使用同一结果。

### P1-22 resumed Agent 保留显式 model override

- **官方版本**：`2.1.211`
- **当前状态**：`建议迁移`
- **本地证据**：`src/tools/AgentTool/resumeAgent.ts:165-171` 计算 resolved model，但 `src/tools/AgentTool/resumeAgent.ts:187-226` 调用 `runAgent` 时传 `model: undefined`。
- **建议**：持久化“显式 override”而非仅 resolved model；旧记录保持继承行为。

### P1-23 Prompt/Agent transcript 的长期内存

- **官方版本**：`2.1.238`、`2.1.246`
- **当前状态**：`部分缺失`
- **本地证据**：`src/tools/AgentTool/agentToolUtils.ts:629-672` 长期累积 Agent messages；`src/components/Messages.tsx:562-839` 将 transcript-wide lookup 传给每个 row，静态 row 可能保留旧 generation。
- **建议**：最近显示窗口之外释放完整 tool result body；row 只持有所需的 row-local lookup，动态 heap test 证明旧 generation 可 GC。

## 5. P2：独立功能候选

| 候选 | 官方版本 | 当前证据与建议 |
| --- | --- | --- |
| 通用 `Tool(param:value)` permission rule | `2.1.178` | `src/utils/permissions/permissionRuleParser.ts:95-132` 将括号内容视为不透明字符串。价值高但 matcher 错误会造成权限绕过，应独立设计和审计。 |
| `enforceAvailableModels` | `2.1.175–2.1.176` | `src/utils/settings/types.ts:414-425` 只有 `availableModels`；需要覆盖 Default、env aliases、Agent/fallback/fast-mode 等所有选模入口。 |
| 多模型 fallback chain | `2.1.166`、`2.1.178` | `src/main.tsx:1579-1581`、`src/query.ts:933-962` 只支持一个 fallback；compaction 仍固定主模型。 |
| troubleshooting safe mode | `2.1.169` | 当前没有 `--safe-mode`/`CLAUDE_CODE_SAFE_MODE`；应独立于现有 `--bare`，统一禁用 CLAUDE.md、plugins、skills、hooks 和 MCP customization。 |
| nested `.claude` closest-wins/collision | `2.1.178` | Agent/Workflow/output style 扫描顺序可能让远目录覆盖 cwd；skills 同名缺少稳定 qualifier。 |
| `DirectoryAdded` hook | `2.1.219` | `/add-dir` 和 SDK repo-root 更新已存在，但 hook event/schema 缺失。只在 canonical directory 成功注册后触发。 |
| `sandbox.network.strictAllowlist` | `2.1.219` | 当前 sandbox schema/adapter 未见该字段；必须先确认 sandbox-runtime 支持，不能只加无效 schema。 |
| `sandbox.filesystem.disabled` | `2.1.216` | 允许关闭 filesystem isolation 但保留 network isolation；需要明确可信 settings source。 |
| `archive` plugin source | `2.1.224` | 当前无通用 HTTPS ZIP source；需要 HTTPS-only、size/digest、zip-slip/symlink/bomb 防护和原子安装。 |
| GitLab marketplace/MR 集成 | `2.1.232–2.1.234` | 当前已有部分 `glab mr` tracking；可增加 nested subgroup clone、settings aliases、MR footer/statusline。 |
| `modelPicker`/cache TTL/managed pricing | `2.1.243` | settings 尚无 `modelPicker`、`promptCacheTtl`、`subagentPromptCacheTtl`、`modelPricing`。适合企业 gateway 与 API key 场景。 |
| `ANTHROPIC_DEFAULT_MODEL` | `2.1.236` | 当前只有 `ANTHROPIC_MODEL` 和 family defaults；新变量只决定新 session 初始值，不能覆盖持久化 `/model` 选择。 |
| `CLAUDE_CODE_PROJECT_DIR_NAME` | `2.1.234` | transcript dir 当前由 cwd sanitize；覆盖值必须是单个安全目录名，拒绝 separator、`..`、NUL 和 reserved name。 |
| WebFetch cache TTL | `2.1.233` | `src/tools/WebFetchTool/utils.ts:63-70` 固定 15 分钟；可增加严格解析的 `CLAUDE_CODE_WEBFETCH_CACHE_TTL_MS`。 |
| bare `.claude/skills` validation | `2.1.233` | `src/utils/plugins/validatePlugin.ts:754-775` 默认把输入当 plugin root，再拼 `/skills`。 |
| `keybindingFlavor: readline` 与 `selection:clear` | `2.1.234`、`2.1.238` | 当前只有 footer-specific clear action；可作为独立 TUI 输入兼容功能。 |
| `/permissions` Auto tab | `2.1.246` | `src/components/permissions/rules/PermissionRuleList.tsx:905-946` 没有 Auto tab；需要先明确 classifier rule 的持久化来源和作用域。 |
| 内置 Concise output style | `2.1.237` | `src/constants/outputStyles.ts:39-135` 当前只有 Default/Explanatory/Learning。 |

## 6. 只应先动态验证的条目

以下条目具有价值，但当前静态证据不足，实施前应先做最小复现或官方/本地二进制对照：

1. **Workflow dynamic `import()` escape**（`2.1.223`）：official-style runtime 已禁用 string/WASM code generation；legacy discovery VM 较弱，但未证明与官方 payload 等价。
2. **PowerShell 5.1 permission bypass**（`2.1.214`）和 quote/invisible Unicode 变体：需要 Windows PowerShell corpus。
3. **zsh `[[ ]]`、fd redirect、input redirect**：当前有 AST 分析；官方 `2.1.232` 的部分 input-redirection 改动在 `2.1.233` 回退，不能机械照搬。
4. **remote MCP dropped-connection recovery**（`2.1.243`）：当前已有部分 reconnect/error close 逻辑，需真实 server 故障注入。
5. **API mid-stream non-interactive continuation**（`2.1.246`）：需要区分 continuation 与整 turn retry，避免重复副作用。
6. **`apiKeyHelper` 短期 JWT 预刷新**（`2.1.246`）：当前有 401 refresh，但 stale-while-revalidate 和 gateway 403 仍需真实验证。
7. **MCP v2 `subscriptions/listen` fixed-timeout reconnect**（`2.1.233`）：需受控 server。
8. **Plan mode 阻止所有修改型 Bash**（`2.1.212`）：覆盖 redirect、compound command、SDK `canUseTool`。
9. **Windows junction 删除安全**（`2.1.205`）：必须在 Windows/NTFS 上验证。
10. **fullscreen resize/scroll/focus、screen reader、clipboard、IME/Unicode**：属于真实 TUI 行为，静态相似代码不足以定性。
11. **plugin SHA duplicate cache、bare-name update 和 corrupted catalog**（`2.1.246`）：需要安装生命周期 fixture。
12. **MCP HTTP/SSE frame/body cap**（`2.1.139`）：限制可能已经由当前 `@modelcontextprotocol/sdk` 实现。

## 7. 已有本地等价能力或不应重复搬迁

代表性结论：

- PowerShell `$PSDefaultParameterValues` 污染已在 `src/tools/PowerShellTool/powershellSecurity.ts:962-999` 拦截。
- MCP server-level deny 已在 `src/utils/permissions/permissions.ts:262-272` 和 tool exposure 路径实现。
- PreCompact、PermissionDenied hook、symlink target permission check 和 corrupt transcript line recovery 已存在。
- Prompt cache 的 gateway/OpenAI identity、Skill listing 稳定排序和 usage normalization 已属于本地 `2.1.214` 变更，不应按官方 `2.1.237` 重做。
- MCP 大输出已采用截断/文件持久化路径，不能仅凭官方 `2.1.217` note 判定仍保留完整结果。
- malformed `history.jsonl` 已逐行跳过，当前问题是写失败后 pending batch 丢失，而不是读取崩溃。
- Auto mode 对 `SendMessage` 的 permission classification 已存在。
- Agent tool 显式 mode 已有父权限等级限制；缺口是 trusted definition/resume metadata 与 bypass killswitch 的交集。

## 8. 明确排除或被后续版本覆盖

### 8.1 依赖官方服务端，不作为本地迁移项

- Claude Code on the web、Remote Control 云 session ownership、mobile/desktop handoff。
- self-hosted runner lease、work polling、Team/Enterprise usage credits 和 spend-limit 服务端状态机。
- Fable/Opus 新模型 entitlement、官方 gateway pricing 和组织账号特定 onboarding。
- VS Code Focus view、extension sidebar/session group 等扩展专属 UI。
- Claude in Chrome tab lifecycle。

### 8.2 与本项目策略冲突

- 官方 `2.1.221` 的 background session 自动 commit/push 行为不适合本仓库；本项目要求用户检查并明确批准后才能 commit，更不能自动 push。

### 8.3 被后续版本覆盖，禁止照搬旧行为

- `2.1.212` 的每 session 200-subagent 累计 cap 已在 `2.1.224` 删除；只保留并发和深度限制。
- `2.1.217` 的“默认不允许 nested subagent”已被 `2.1.219` 的默认 depth 3 替代。
- `2.1.232` 的宽泛 Cygwin symlink/input-redirection permission 改动在 `2.1.233` 部分回退，应等待窄规则或先做本地复现。
- `2.1.215`/`2.1.218` 对 `/code-review` manual-only/background 的行为在后续版本继续变化；应按本地 Workflow 产品语义单独决定，不能把早期 note 当最终契约。
- `cleanupPeriodDays: 0` 当前是本仓库明确支持的本地语义。官方 `2.1.89` 改为 validation error，但是否迁移属于产品决策，不列入默认修复批次。

## 9. 建议实施批次

### 批次 A：小改动、高风险收益

1. settings 文件大小/类型上限。
2. Agent bypass killswitch。
3. Hook exit 2 blocking。
4. 参数单次替换。
5. Bash 10k/dangling guard。
6. MCP OAuth `127.0.0.1`。
7. mailbox/history failure propagation。

### 批次 B：文件系统与 trust 边界

1. `.claude/worktrees` symlink。
2. `.claude` Workflow/Cron symlink。
3. worktree Git redirect escape。
4. nested repo trust。
5. NT namespace path。
6. sandbox source/ripgrep。
7. Agent frontmatter hook trust。

### 批次 C：secret 与配置来源

1. `headersHelper` trust/env。
2. MCP CLI/diagnostics redaction。
3. telemetry credential origin。
4. plugin option shell/source isolation。
5. marketplace policy、whole-entry merge 和 atomic persistence。

### 批次 D：可靠性与资源边界

1. brace budget。
2. API first-response timeout。
3. MCP abort semantics。
4. stream-json drain。
5. transcript/LSP/MCP/file cache bounds。
6. long diff/large Write。
7. Agent maxTurns partial。
8. global background Agent concurrency。

### 批次 E：独立功能

按实际需求从 P2 中选择，不与安全修复捆绑。

## 10. 每个迁移项的验收标准

1. 先添加能复现当前缺口的最小失败测试。
2. 只修改对应边界，不顺带重构相邻模块。
3. 运行 focused `bun test`。
4. 运行 `make release-check`；涉及 CLI/build/runtime 时再运行 `make build`。
5. 权限、Agent、Workflow、MCP 和 TUI 行为必须使用当前构建产物做真实交互或受控 server 验证。
6. 涉及官方行为 parity 时再用同版本官方 binary 对照；官方 CHANGELOG 文案本身不能替代运行证据。
7. 对无法动态覆盖的平台或服务明确标记 `not covered`，不得计为通过。

## 11. 证据边界

本研究没有实施上述功能，也没有运行会改变外部状态的操作。源码行号对应研究时的工作区快照；后续本地并行改动可能使行号漂移。实施前应重新读取目标文件，并用当前测试和构建结果复核结论。
