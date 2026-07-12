# 2026-06-22 工具调用与上下文压缩对比研究过程

## 研究目标

对比当前仓库与 `dist/codex/` 中 Codex Rust 实现，在两个方向上的功能与实现差异：

1. 工具调用：工具定义、API schema、执行调度、并发、权限、hook、MCP、错误/中断处理。
2. 上下文压缩：手动 compact、auto compact、summary 生成、历史替换、压缩后状态恢复、工具输出裁剪。

输出文档：

- `docs/compare-diff-tool-use.md`
- `docs/compare-diff-compact.md`
- 本研究过程记录文件

## 分包逻辑

使用并行研究方式拆成四个相互独立的问题域：

1. 当前仓库工具调用实现
   - 重点文件：`src/Tool.ts`、`src/tools.ts`、`src/services/tools/toolExecution.ts`、`src/services/tools/toolOrchestration.ts`、`src/services/tools/StreamingToolExecutor.ts`、`src/services/api/claude.ts`、`src/query.ts`。
   - 目标：梳理 TypeScript `Tool` contract、Anthropic `tool_use/tool_result`、streaming 执行、权限和 hooks。
2. Codex 工具调用实现
   - 重点文件：`dist/codex/codex-rs/core/src/tools/router.rs`、`registry.rs`、`parallel.rs`、`orchestrator.rs`、`sandboxing.rs`、`handlers/mcp.rs`、`session/turn.rs`。
   - 目标：梳理 Rust `ToolRouter` / `ToolRegistry` / `ToolCallRuntime` / `ToolOrchestrator` 如何处理 OpenAI Responses 风格 tool items。
3. 当前仓库上下文压缩实现
   - 重点文件：`src/services/compact/autoCompact.ts`、`src/services/compact/compact.ts`、`src/commands/compact/compact.ts`、`src/query.ts`。
   - 目标：梳理 manual compact、auto compact、microcompact、session memory compact、post-compact attachments。
4. Codex 上下文压缩实现
   - 重点文件：`dist/codex/codex-rs/core/src/tasks/compact.rs`、`compact.rs`、`compact_remote.rs`、`state/auto_compact_window.rs`、`session/token_budget.rs`。
   - 目标：梳理 local/remote compact、`CompactedItem`、`replacement_history`、auto compact window ids、工具输出裁剪。

实际执行时创建了 team `tool-compact-compare` 并在 team task list 中完成对应研究任务；主会话同步抽样读取关键源码，以避免只依赖 agent 汇总。

## 关键证据索引

### 当前仓库：工具调用

- `src/tools.ts:198` 之后的 `getAllBaseTools()` / `getTools()` / `assembleToolPool()` 是内建工具、权限过滤与 MCP 工具合并的主入口。
- `src/Tool.ts:158` 之后的 `ToolUseContext` 承载工具执行所需的 session、permission、MCP、UI 回调、压缩进度、task/context replacement 等上下文。
- `src/Tool.ts:364` 之后的 `Tool` 接口把执行、权限、渲染、摘要、并发安全、MCP 元信息等能力绑定在一个对象上。
- `src/Tool.ts:404` 定义工具级 `isConcurrencySafe(input)`；`src/Tool.ts:761` 默认 `isConcurrencySafe` 为 false，说明当前仓库默认保守串行。
- `src/Tool.ts:785` 的 `buildTool()` 用默认实现补齐工具定义，是当前仓库工具 contract 的集中入口。
- `src/services/tools/toolOrchestration.ts:8` 从 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` 读取最大并发，默认 10。
- `src/services/tools/toolOrchestration.ts:91` 的 `partitionToolCalls()` 按连续 concurrency-safe 工具分批；`src/services/tools/toolOrchestration.ts:152` 并发执行安全批次。
- `src/services/tools/StreamingToolExecutor.ts:40` 定义 streaming 工具执行器；`src/services/tools/StreamingToolExecutor.ts:129` 根据正在执行工具和 `isConcurrencySafe` 决定是否可启动新工具。
- `src/services/tools/StreamingToolExecutor.ts:367` 将 progress message 放入 `pendingProgress` 以便即时 yield；`src/services/tools/StreamingToolExecutor.ts:453` 在剩余结果收集阶段继续输出 progress/result。
- `src/services/tools/StreamingToolExecutor.ts:358` 仅 Bash 错误会触发 sibling abort，其他工具失败不级联中断。
- `src/services/tools/toolExecution.ts:601` 的 `checkPermissionsAndCallTool()` 是单工具执行链核心；`src/services/tools/toolExecution.ts:637` 处理 input validation error；`src/services/tools/toolExecution.ts:802` 执行 `PreToolUse` hooks；`src/services/tools/toolExecution.ts:1078` 执行 `PermissionDenied` hooks；`src/services/tools/toolExecution.ts:1488` 执行 `PostToolUse` hooks；`src/services/tools/toolExecution.ts:1710` 执行 `PostToolUseFailure` hooks。
- `src/services/api/claude.ts:1140` 检查 ToolSearch 是否启用；`src/services/api/claude.ts:1149` 计算 deferred tool names；`src/services/api/claude.ts:1259` 构造工具 schema；`src/services/api/claude.ts:1290` normalize messages；`src/services/api/claude.ts:1325` 调用 `ensureToolResultPairing()` 修复 tool_use/tool_result 配对；`src/services/api/claude.ts:1420` 合并 `allTools`。
- `src/utils/api.ts:119` 之后的 `toolToAPISchema()` 负责把内部 Tool 转成 API schema，并叠加 `strict`、`defer_loading`、`cache_control`。
- `src/services/mcp/client.ts:1749` 之后把 MCP `tools/list` 映射为内部 Tool；`src/services/mcp/client.ts:3038` 之后执行 `client.callTool()` 并透传 `_meta` / `structuredContent`。
- `src/utils/groupToolUses.ts:56`、`src/utils/collapseReadSearch.ts:143`、`src/services/toolUseSummary/toolUseSummaryGenerator.ts:45` 说明当前仓库还有 UI/transcript 层的 grouped/collapsed/summary 二次结构化。

### Codex：工具调用

- `dist/codex/codex-rs/core/src/tools/spec_plan.rs:158` 之后按 turn 构建 `ToolRouter`，聚合 core、MCP、dynamic、extension、hosted tools；`spec_plan.rs:862` 之后处理 MCP direct/deferred exposure；`spec_plan.rs:940` 之后将 deferred tools 汇总成 tool search。
- `dist/codex/codex-rs/core/src/tools/router.rs:35` 定义 `ToolRouter`，持有 registry 和 model-visible specs；`router.rs:76` 返回模型可见工具 schema。
- `dist/codex/codex-rs/core/src/tools/router.rs:100` 通过 registry 判断工具是否支持并行；`router.rs:113` 将 `ResponseItem::FunctionCall` / `ToolSearchCall` / `CustomToolCall` 转为统一 `ToolCall`。
- `dist/codex/codex-rs/core/src/tools/parallel.rs:36` 的 `parallel_execution: Arc<RwLock<()>>` 是并发门闩；`parallel.rs:114` 用 Tokio spawn 执行工具；`parallel.rs:115` 支持并发工具拿 read lock，不支持并发工具拿 write lock。
- `dist/codex/codex-rs/core/src/tools/parallel.rs:231` 对 shell/unified_exec abort 输出特殊 wall time 文案，其他工具使用通用 abort 文案。
- `dist/codex/codex-rs/core/src/tools/registry.rs:405` 的 `dispatch_any_with_terminal_outcome()` 是 registry 调度入口；`registry.rs:493` 通知 tool start；`registry.rs:496` 执行 pre tool hooks；`registry.rs:585` 执行 post tool hooks；`registry.rs:625` 通知 tool finish。
- `dist/codex/codex-rs/core/src/tools/orchestrator.rs:4` 明确说明 orchestrator 是 approval + sandbox selection + retry semantics 的集中点；`orchestrator.rs:160` 处理 `ExecApprovalRequirement::Skip`；`orchestrator.rs:196` 处理 `NeedsApproval`；`orchestrator.rs:230` 选择 sandbox；`orchestrator.rs:461` 进行 escalated second attempt。
- `dist/codex/codex-rs/core/src/tools/sandboxing.rs:41` 定义 `ApprovalStore`；`sandboxing.rs:72` 的 `with_cached_approval()` 支持 ApprovedForSession 缓存；`sandboxing.rs:161` 定义 `ExecApprovalRequirement`；`sandboxing.rs:204` 根据 approval policy 和 filesystem sandbox policy 计算默认审批需求。
- `dist/codex/codex-rs/core/src/mcp_tool_call.rs:1204` 之后是 MCP 独立审批链，包含 auto approve、permission hook、guardian、elicitation、request_user_input fallback。
- `dist/codex/codex-rs/app-server-protocol/src/protocol/v2/command_exec.rs:27` 与 `app-server/src/request_processors/command_exec_processor.rs:31` 之后说明 Codex 还向 app-server 暴露 command/exec、write、resize、terminate 等结构化协议。

### 当前仓库：上下文压缩

- `src/services/compact/autoCompact.ts:62` 定义 auto compact buffer 为 13,000 tokens；`autoCompact.ts:70` 连续失败 circuit breaker 为 3 次。
- `src/services/compact/autoCompact.ts:40` 支持 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 覆盖 context window；`autoCompact.ts:79` 支持 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`。
- `src/services/compact/autoCompact.ts:147` `DISABLE_COMPACT` 禁用全部 compact，`autoCompact.ts:152` `DISABLE_AUTO_COMPACT` 只禁用 auto compact。
- `src/services/compact/autoCompact.ts:160` `shouldAutoCompact()` 判断是否触发；`autoCompact.ts:241` `autoCompactIfNeeded()` 执行自动压缩；`autoCompact.ts:288` 优先尝试 session memory compaction。
- `src/query.ts:369` 之后的 query 主循环在 autocompact 前还会处理 tool result budget、snip、microcompact、context collapse。
- `src/services/compact/sessionMemoryCompact.ts:49` 定义 session memory keep-tail 默认阈值；`sessionMemoryCompact.ts:331` 之后根据 `lastSummarizedMessageId` 与 compact boundary 计算保留尾部。
- `src/services/compact/apiMicrocompact.ts:16` 定义 API context management 默认 trigger/target；`apiMicrocompact.ts:66` 之后生成 thinking/tool-use clear 策略。
- `src/services/compact/compact.ts:122` 定义 post-compact 文件恢复上限 5；`compact.ts:123` 定义 post-compact token budget 50,000。
- `src/services/compact/compact.ts:333` `buildPostCompactMessages()` 明确压缩后消息顺序：boundary、summary、保留消息、attachments、hook results。
- `src/services/compact/compact.ts:391` `compactConversation()` 是传统压缩核心；`compact.ts:455` 通过 `streamCompactSummary()` 生成 summary；`compact.ts:471` prompt-too-long 时用 `truncateHeadForPTLRetry()` 删除头部再重试。
- `src/services/compact/compact.ts:537` 生成 post-compact file attachments；`compact.ts:562` 注入 skill attachment；`compact.ts:594` 注入 MCP/tool/agent 等 delta；`compact.ts:602` 创建 compact boundary。
- `src/commands/compact/compact.ts:46` 手动 `/compact` 先取 compact boundary 后消息；`compact.ts:58` 优先 session memory compaction；`compact.ts:98` 传统路径前先 microcompact；`compact.ts:101` 调用 `compactConversation()`。

### Codex：上下文压缩

- `dist/codex/codex-rs/core/src/session/turn.rs:320` 之后包含采样后 auto compact、token budget reminder 与 `new_context` 请求处理；`turn.rs:862` 之后处理 pre-turn compact；`turn.rs:965` 之后分派 local/remote/remote_v2。
- `dist/codex/codex-rs/core/src/tasks/compact.rs:34` 根据 provider 判断是否走 remote compact；`tasks/compact.rs:65` local compact 使用 `SUMMARIZATION_PROMPT`。
- `dist/codex/codex-rs/core/src/compact.rs:52` local compact 最多收集 20,000 tokens user messages 到 replacement history。
- `dist/codex/codex-rs/core/src/compact.rs:73` inline auto compact 入口；`compact.rs:105` manual compact task 入口；`compact.rs:260` context window exceeded 时删除最旧输入并重试。
- `dist/codex/codex-rs/core/src/compact.rs:302` 收集近期 user messages；`compact.rs:304` 构建 compacted history；`compact.rs:305` advance auto compact window；`compact.rs:319` 构造 `CompactedItem`；`compact.rs:327` 替换 session compacted history。
- `dist/codex/codex-rs/core/src/compact_remote.rs:41` 定义工具输出过长时的截断文案；`compact_remote.rs:44` inline remote auto compact；`compact_remote.rs:65` manual remote compact。
- `dist/codex/codex-rs/core/src/compact_remote.rs:192` remote compact 前 trim function call history；`compact_remote.rs:243` 调用 remote compact endpoint；`compact_remote.rs:262` 处理 compacted history。
- `dist/codex/codex-rs/core/src/compact_remote.rs:321` 清洗 remote compact 返回历史；`compact_remote.rs:341` 丢弃 developer message、tool call/output、reasoning 等不应保留的 items；`compact_remote.rs:413` 重写 `FunctionCallOutput`；`compact_remote.rs:437` 重写 `ToolSearchOutput`。
- `dist/codex/codex-rs/core/src/compact_remote_v2.rs:49` 定义 retained message 预算 64,000 tokens；`compact_remote_v2.rs:439` 之后保留 user/developer/system 并追加单个 `Compaction` item。
- `dist/codex/codex-rs/core/src/tools/handlers/new_context_window.rs:13` 之后实现 `new_context` 工具：不总结历史，直接请求新上下文窗口。
- `dist/codex/codex-rs/core/src/state/auto_compact_window.rs:23` 之后维护 window ids；`session/token_budget.rs:6` 之后实现 token budget reminder。

## 可靠性边界

- 本次结论基于当前仓库源码和 `dist/codex/` 快照源码，不推断未读取文件中的细节。
- 由于 Codex `dist/codex/` 是随仓库携带的快照，结论只代表该目录当前版本，不代表上游 Codex 最新实现。
- 文档中涉及路径与行号是研究时源码位置；后续代码改动可能导致行号漂移，应以当前文件内容为准。
