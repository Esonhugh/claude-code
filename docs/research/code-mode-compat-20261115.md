# 官方 Code Mode 与本仓库实现的兼容性核对

2026-11-15 核对。官方以 2.1.325（darwin-arm64，SHA-256 前缀 `84590fefe6338be9`）为准，本仓库以 `docs/plan/code-mode.md` 和已提交的 Phase 0–2（`04bd93d8`、`2089e1ed`、`0acc1542`）为准。Phase 3 的 REPL 工具还在开发中，涉及它的条目只按计划判断。

结论：配置、工具名、hook 和权限这几层可以共存。会话 transcript 不兼容：两边都把会话写进 `~/.claude/projects/`，但写法不同，互相 resume 时模型会看到空结果或无法调用的工具。这是唯一需要在 Phase 3 之前修的问题。

## 兼容性表

| 项 | 官方 | 本仓库 | 结论 | 修复位置 |
| --- | --- | --- | --- | --- |
| transcript 写入 | Code Mode 会话保留 REPL 外壳和虚拟消息（`j4e`，wqp.js:25050-25056），只有非 Code Mode 的外部会话才剥离 | 外部用户一律剥离 REPL，并把虚拟消息提升为真实消息（`sessionStorage.ts:4715-4782`） | 不兼容 | `cleanMessagesForLogging`：Code Mode 会话跳过转换 |
| 虚拟 tool_result 内容 | `content: ""`，真实结果在 `toolUseResult`；因为不剥离，模型 resume 后看的是 REPL 的 `<repl-output>` | 同样是 `''`（`toolWrappers.ts:246-249`），但剥离后 API 只剩空内容的原生 Bash/Read 结果 | 不兼容，resume 后结果丢失 | 同上 |
| `repl-mode` 元数据 | 写 `{type:"repl-mode", replMode, typedEvents?}`（wqp.js:17017），读入后决定 resume 方案（chunk-w140y4g2 `planCodeModeFromSession`） | 不写不读，加载时按未知类型忽略 | 不兼容 | sessionStorage 元数据读写 + resume 方案 |
| 无元数据时的推断 | 用 `<repl-output` 正则和 JOe 工具结果推断会话是否 Code Mode（chunk-w140y4g2 `_()`） | 无 | 不兼容 | 同上 |
| Code Mode 关闭时 resume 官方会话 | 注入提醒："Do not call REPL or Poll … The variables … are gone." | 无提醒，历史里有 REPL 但工具列表没有 | 不兼容 | resume 时注入同类提醒 |
| progress 持久化 | `Dw()` 丢弃 `progress` | `isLoggableMessage` 同样丢弃（:4672） | 兼容 | — |
| 虚拟消息字段 | `permissionDecision`、`toolDenialKind`、`sandboxViolations`、`sandboxed` 等 | 有前两个，缺 sandbox 字段 | 兼容（字段可选） | 可选补齐 |
| 环境变量 | `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE`，unset/off/on/bad 四态；来源分 flag/user settings/shell，托管设置或 `~/.claude.json` 里设置时拒绝（`own_settings`） | 同名，解析规则相同，只读 `process.env` | 兼容，来源判断是有意简化 | — |
| `~/.claude.json` 键 | `codeModeCaveatsAcceptedV1`、`codeModeAutoModeCaveatAcceptedV1` | 不读不写 | 兼容（互不干扰） | — |
| 重启变量 | `_RESTART` / `_RESTARTED_FROM`，启动时 unset | 不用 | 兼容 | — |
| 开关拒绝原因 | 20 多种（provider、credentials、model、gate、mods、otel 等） | `bad_value`、`entrypoint`、`unattended` | 有意分歧（D3） | 计划已记录 |
| 工具名 | REPL；`Eval` 别名和 `Code` 显示名都只在已接受时生效（chunk-yb2dtjhc） | 同（Phase 3） | 兼容 | — |
| API 工具列表 | REPL、Poll、StructuredOutput | 同 | 兼容；Poll 要到 Phase 4 才实现 | — |
| 工具集合 | JOe / Djs | `CODE_MODE_ONLY_TOOLS` / `REPL_PRIMITIVE_TOOL_NAMES`，取值相同 | 兼容 | — |
| 隐藏工具报错 | 只对 JOe 名字，文案末尾有句号（wqp.js:163822） | 还覆盖 Write/Edit/MCP，末尾没有句号 | 文案小差异；直接调用 Write/Edit 时本仓库会拒绝，官方会照常执行 | `codeModeOnlyToolError` 补句号；拒绝范围要么写进计划，要么对齐官方 |
| 内层 hook | PreToolUse/PostToolUse 拿到内层工具名和入参 | 走 `runToolUse`，同样如此 | 兼容 | — |
| `Bash(...)` 规则 | 按内层调用逐次判定 | 同 | 兼容 | — |
| auto 分类器 | REPL 输入为整段 code，内层调用还会再判一次 | 同（Phase 3） | 兼容 | — |
| SDK / stream-json | 非交互入口被拒（`entrypoint`） | 同 | 兼容（两边都不开） | — |
| D2 执行器 | 进程内运行，超时后保留上下文 | Worker，超时后上下文丢失，返回 `contextReset` | 有意分歧 | Phase 3 提示文案 |
| D3 teammate | 拒绝（`unattended`、`agent_teams`） | 拒绝 | 兼容 | — |
| D4 mods | 装了检查 tool call 的 mod 时拒绝（`mods`） | mod hook 正常触发 | 有意分歧 | 计划已记录 |

## 运行观察

证据保存在 `/tmp/cmx/evidence/`，已去掉敏感信息，扫描结果为 0 处泄露。

- **run1**：隔离的 `CLAUDE_CONFIG_DIR`、`--settings ~/.claude/settings.ducc.json`、开关=1、`--debug`。走完首次引导后，启动屏显示：
  `⚠ Code Mode (experimental) isn't available: for now it only works with the Anthropic API. Starting with the ordinary tools.`
  拒绝原因是 `provider`：`ANTHROPIC_BASE_URL` 指向自定义网关，所以不是 firstParty。这一步在 `credentials` 检查之前，所以 AUTH_TOKEN 根本没有被检查到。同屏还提示 "Both ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY set"。
- **debug 日志里没有 Code Mode 相关行**：拒绝原因只出现在屏幕提示里。日志中的 `[REPL:mount] REPL mounted` 指的是交互界面组件，和 Code Mode 无关。
- **run2**：用 `env -i` 清空环境，只保留 `ANTHROPIC_API_KEY` 和代理变量，走 firstParty 路径。启动时退出：`Failed to connect to api.anthropic.com: ECONNRESET`。
- **run3**：保留 BASE_URL 和 API_KEY，去掉 AUTH_TOKEN，同样退出。`curl --noproxy` 直连 443 端口被拒绝。

## 需要的修复（按优先级）

1. **transcript 写入**：`sessionStorage.ts` 在 Code Mode 会话中跳过 `transformMessagesForExternalTranscript`，与官方 `j4e` 一致。否则本仓库自己 resume 时，所有内层调用结果都是空字符串。Phase 3 任务里"验证转换为原生调用"那条测试，要改为验证保留。
2. **会话元数据**：写入和读取 `repl-mode`（last-wins），没有元数据时用 `<repl-output` 推断。
3. **resume 方案**：本仓库 Code Mode 关闭时 resume 一个 Code Mode 会话，要注入官方的 "Do not call REPL…" 提醒；开启时 resume 普通会话，就继续用普通工具。
4. **隐藏工具报错**：文案补句号；决定是否只对 `CODE_MODE_ONLY_TOOLS` 报错。

## 无法观察的部分

- 官方 REPL 的实际运行、API 请求里的工具列表、真实 transcript：开关在 `provider` 这一步就拒绝了，firstParty 的端点在本机又连不上，GrowthBook 开关 `tengu_rustling_blossom` 也无法读取。按要求没有修改二进制。
- Phase 3 的 schema 字段和 prompt 还没写完，只能对照计划判断。
- 本仓库加载器遇到 `repl-mode` 条目时会忽略它，这一点是从 if/else 链推断的，没有实测。
