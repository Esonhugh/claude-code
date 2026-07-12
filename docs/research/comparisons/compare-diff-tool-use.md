# 当前仓库与 Codex 工具调用实现差异

## 结论摘要

当前仓库和 `dist/codex/` 的工具调用系统目标相近，但抽象边界不同：

- 当前仓库是 TypeScript 客户端工具框架，核心是 `Tool` object contract、Anthropic Messages API 的 `tool_use/tool_result` block、`query.ts` 主循环、`StreamingToolExecutor` 与 `runTools()`。
- Codex 是 Rust session runtime，核心是 OpenAI Responses 风格 `ResponseItem`、`ToolRouter`、`ToolRegistry`、`ToolCallRuntime`、`ToolOrchestrator`，并把 approval、sandbox、network approval、Guardian review 放在 typed runtime 层统一处理。
- 当前仓库更强调 streaming 时边生成边执行工具、工具结果配对修复、UI/progress 与 hooks 的客户端集成。
- Codex 更强调工具 registry 化、协议事件生命周期、sandbox policy、审批缓存、远端/本地执行一致性。

## 1. 工具模型与 API 表达

### 当前仓库

当前仓库的工具池先由 `src/tools.ts` 组装，再由 `src/Tool.ts` 定义单个工具 contract：

- `src/tools.ts:198` 之后的 `getAllBaseTools()` 汇总内建工具。
- `src/tools.ts:277` 之后的 `getTools()` 按权限与模式过滤内建工具。
- `src/tools.ts:330` 之后的 `assembleToolPool()` 合并内建工具与 MCP 工具，并排序去重。
- `src/Tool.ts:158` 之后的 `ToolUseContext` 承载工具执行、permission、MCP、UI 回调、压缩进度、task/context replacement 等上下文。
- `src/Tool.ts:364` 之后的 `Tool` 接口把执行、权限、渲染、摘要、并发安全、MCP 元信息等能力绑定在一个对象上。
- `src/Tool.ts:404` 定义每个工具可按输入判断 `isConcurrencySafe(input)`。
- `src/Tool.ts:752` 说明默认 `isConcurrencySafe` 为 false，`src/Tool.ts:761` 具体默认实现也是 false。
- `src/Tool.ts:785` 的 `buildTool()` 用默认值补齐工具定义。

这意味着工具自身不仅提供执行逻辑，还承担：

- input schema / JSON schema；
- permission check；
- read-only / destructive / concurrency-safe 标记；
- UI 渲染；
- MCP 元信息；
- ToolSearch deferred loading；
- tool result 映射到 Anthropic `tool_result` block。

`src/utils/api.ts:119` 之后的 `toolToAPISchema()` 把内部 Tool 转为 API schema，并按请求叠加 `strict`、`defer_loading`、`cache_control`。因此 Tool 的内部能力和发给模型的 schema 并不是一一静态映射，而是会被请求上下文改写。

API 请求构造位于 `src/services/api/claude.ts`：

- `src/services/api/claude.ts:1140` 判断 ToolSearch 是否启用。
- `src/services/api/claude.ts:1149` 计算 deferred tool names。
- `src/services/api/claude.ts:1259` 构造 tool schemas。
- `src/services/api/claude.ts:1290` normalize messages。
- `src/services/api/claude.ts:1325` 调用 `ensureToolResultPairing()` 修复不完整 tool_use/tool_result。
- `src/services/api/claude.ts:1420` 合并最终 `allTools`。

因此当前仓库的工具 schema 不是独立注册中心生成，而是在 API 请求阶段结合模型、ToolSearch、MCP、缓存策略和消息历史动态生成。

### Codex

Codex 的工具集是 turn 级动态规划出来的，而不是固定静态表：

- `dist/codex/codex-rs/core/src/tools/spec_plan.rs:158` 之后构建 `ToolRouter`，统一聚合 core tools、MCP tools、dynamic tools、extension tools、hosted tools。
- `dist/codex/codex-rs/core/src/tools/spec_plan.rs:628` 之后注册 shell/exec 工具。
- `dist/codex/codex-rs/core/src/tools/spec_plan.rs:690` 之后注册 `RequestUserInput` / `RequestPermissions`。
- `dist/codex/codex-rs/core/src/tools/spec_plan.rs:862` 之后注册 MCP 工具，并支持 direct / deferred exposure。
- `dist/codex/codex-rs/core/src/tools/spec_plan.rs:893` 之后注册 dynamic tools。
- `dist/codex/codex-rs/core/src/tools/spec_plan.rs:940` 之后将 deferred tools 汇总成 `tool_search` 搜索执行器。

Codex 的模型响应先被转换为统一工具调用：

- `dist/codex/codex-rs/core/src/tools/router.rs:35` 定义 `ToolRouter`，持有 `ToolRegistry` 和 model-visible specs。
- `dist/codex/codex-rs/core/src/tools/router.rs:76` 返回模型可见工具 specs。
- `dist/codex/codex-rs/core/src/tools/router.rs:113` 将 `ResponseItem::FunctionCall`、`ToolSearchCall`、`CustomToolCall` 转成 `ToolCall`。

Codex 的工具定义和调度在 registry/runtime 中完成：

- `dist/codex/codex-rs/core/src/tools/registry.rs:405` 的 `dispatch_any_with_terminal_outcome()` 是 registry 调度入口。
- `dist/codex/codex-rs/core/src/tools/registry.rs:735` 对不支持的调用生成 `unsupported call` 文案。

Codex 的工具协议更接近“typed router + runtime handler”：模型只看到 specs，执行时由 `ToolRouter` 找 handler，再由 registry/orchestrator 执行。

## 2. 工具执行链

### 当前仓库

当前仓库单个工具调用执行链在 `src/services/tools/toolExecution.ts`：

1. 查找工具；找不到时返回模型可见错误。
   - `src/services/tools/toolExecution.ts:376` 记录 no such tool error。
   - `src/services/tools/toolExecution.ts:403` 生成 `<tool_use_error>Error: No such tool available...`。
2. 校验 input schema。
   - `src/services/tools/toolExecution.ts:637` 记录 `InputValidationError`。
   - `src/services/tools/toolExecution.ts:672` 生成 validation error tool result。
3. 执行工具自定义 `validateInput()`。
   - `src/services/tools/toolExecution.ts:685` 调用 `tool.validateInput?.(...)`。
4. 执行 PreToolUse hooks。
   - `src/services/tools/toolExecution.ts:802` 调用 `runPreToolUseHooks()`。
   - `src/services/tools/toolExecution.ts:876` 会把 PreToolUse summary 作为 progress 立即展示。
5. 解析 hook permission decision / canUseTool / 工具 permission。
6. 权限拒绝时执行 PermissionDenied hooks。
   - `src/services/tools/toolExecution.ts:1078` 注释说明 PermissionDenied hooks 可让模型 retry。
   - `src/services/tools/toolExecution.ts:1086` 调用 `executePermissionDeniedHooks()`。
7. 工具执行成功后执行 PostToolUse hooks。
   - `src/services/tools/toolExecution.ts:1402` 开始 PostToolUse。
   - `src/services/tools/toolExecution.ts:1488` 调用 `runPostToolUseHooks()`。
8. 工具执行失败后执行 PostToolUseFailure hooks。
   - `src/services/tools/toolExecution.ts:1706` 开始 PostToolUseFailure。
   - `src/services/tools/toolExecution.ts:1710` 调用 `runPostToolUseFailureHooks()`。

这个链路显示，当前仓库把 validation、hooks、permission、UI progress、结果映射都放在 TypeScript 执行路径中。

### Codex

Codex 的执行链分层更明显：

1. `ToolRouter::build_tool_call()` 从 `ResponseItem` 解析 `ToolCall`。
2. `ToolCallRuntime::handle_tool_call()` 决定并发门闩并 spawn 执行。
3. `ToolRegistry::dispatch_any_with_terminal_outcome()` 执行生命周期。
4. 对需要 sandbox/approval 的 runtime，`ToolOrchestrator` 统一处理审批、sandbox、重试。

Codex 还存在 app-server 外部调用链：`dist/codex/codex-rs/app-server/src/message_processor.rs:1390` 之后按 JSON-RPC method 分发 MCP 与 command/exec 请求；`app-server/src/request_processors/mcp_processor.rs:423` 之后转发 MCP 调用；`app-server/src/request_processors/command_exec_processor.rs:31` 之后处理 command/exec write/resize/terminate。这使 Codex 工具系统同时服务模型工具调用和外部客户端协议。

关键证据：

- `dist/codex/codex-rs/core/src/tools/parallel.rs:114` 使用 `tokio::spawn` 执行工具。
- `dist/codex/codex-rs/core/src/tools/registry.rs:493` 通知 tool start。
- `dist/codex/codex-rs/core/src/tools/registry.rs:496` 执行 pre tool hooks。
- `dist/codex/codex-rs/core/src/tools/registry.rs:585` 执行 post tool hooks。
- `dist/codex/codex-rs/core/src/tools/registry.rs:625` 通知 tool finish。
- `dist/codex/codex-rs/core/src/tools/orchestrator.rs:4` 注释说明 orchestrator 是 approval + sandbox selection + retry semantics 的中心。

相比当前仓库，Codex 工具执行链更偏系统 runtime：工具生命周期事件、approval/sandbox、terminal outcome 由 Rust runtime 管理。

## 3. 并发策略差异

### 当前仓库：按工具声明和相邻批次并发

非 streaming 工具编排在 `src/services/tools/toolOrchestration.ts`：

- `src/services/tools/toolOrchestration.ts:8` 最大并发来自 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`，默认 10。
- `src/services/tools/toolOrchestration.ts:91` `partitionToolCalls()` 按 block 顺序分批。
- `src/services/tools/toolOrchestration.ts:98` 对每个工具解析 input 后调用 `tool.isConcurrencySafe(parsedInput.data)`。
- `src/services/tools/toolOrchestration.ts:109` consecutive concurrency-safe 工具合并到同一批。
- `src/services/tools/toolOrchestration.ts:152` 并发执行 safe 批次。

streaming 路径在 `src/services/tools/StreamingToolExecutor.ts`：

- `src/services/tools/StreamingToolExecutor.ts:40` 定义 streaming executor。
- `src/services/tools/StreamingToolExecutor.ts:129` `canExecuteTool()` 判断：没有执行中工具，或当前工具 safe 且所有执行中工具 safe，则可执行。
- `src/services/tools/StreamingToolExecutor.ts:144` 对 queued tool 尝试启动。
- `src/services/tools/StreamingToolExecutor.ts:147` 如果遇到不能并发的工具则停止，维护顺序。

当前仓库并发的核心是工具级 `isConcurrencySafe(input)`，并且 streaming 模式可以在 assistant 消息还没完全结束时提前执行工具。

### Codex：全局 read/write lock 门闩

Codex 的并发控制在 `dist/codex/codex-rs/core/src/tools/parallel.rs`：

- `parallel.rs:36` `parallel_execution: Arc<RwLock<()>>` 是全局并发门闩。
- `parallel.rs:88` 通过 `router.tool_supports_parallel(&call)` 判断工具是否并发安全。
- `parallel.rs:115` 支持并发工具获取 read lock。
- `parallel.rs:118` 不支持并发工具获取 write lock。

这表示 Codex 并发策略不是“相邻分批”，而是所有工具调用在同一 runtime lock 下排队：多个 parallel-safe 工具可共享 read lock；任何 non-parallel 工具独占 write lock。

## 4. Streaming 与结果输出顺序

### 当前仓库

当前仓库有专门的 `StreamingToolExecutor`，功能包括：

- streaming 中发现 tool_use 后提前 enqueue/execute；
- progress message 立即 yield；
- result 仍按原始工具顺序输出；
- fallback/discard/abort 时生成 synthetic tool_result，避免 Anthropic API 出现 orphan tool_use。

证据：

- `src/services/tools/StreamingToolExecutor.ts:29` `pendingProgress` 专门保存 progress。
- `src/services/tools/StreamingToolExecutor.ts:367` progress 放入 `pendingProgress`。
- `src/services/tools/StreamingToolExecutor.ts:417` 总是优先 yield pending progress。
- `src/services/tools/StreamingToolExecutor.ts:453` `getRemainingResults()` 收集剩余结果。
- `src/services/tools/StreamingToolExecutor.ts:65` `discard()` 用于 streaming fallback，queued 工具不再启动，in-progress 工具收到 synthetic errors。

### Codex

Codex 也支持工具执行中的 protocol events，但结构不是 Anthropic `tool_use/tool_result` block 配对修复模式，而是围绕 `ToolInvocation`、lifecycle notification 和 `AnyToolResult`：

- `dist/codex/codex-rs/core/src/tools/registry.rs:493` `notify_tool_start()`。
- `dist/codex/codex-rs/core/src/tools/registry.rs:625` `notify_tool_finish_if_unclaimed()`。
- `dist/codex/codex-rs/core/src/tools/parallel.rs:114` 工具执行是 Tokio task。

Codex 的重点是 runtime lifecycle 和 terminal outcome，而不是在客户端消息数组中修复 Anthropic block 配对。

## 5. 权限、审批与 sandbox

### 当前仓库

当前仓库的权限由多层共同决定：

- 工具自己的 `checkPermissions` / `validateInput`；
- `CanUseToolFn`；
- permission mode；
- PreToolUse hooks 返回的 permission decision；
- PermissionDenied hooks 的 retry 指示；
- Bash 等工具内部 sandbox/权限逻辑。

对应执行入口仍在 `checkPermissionsAndCallTool()`，例如：

- `src/services/tools/toolExecution.ts:802` PreToolUse hooks。
- `src/services/tools/toolExecution.ts:1078` PermissionDenied hooks。

这套机制灵活，且方便与 React Ink UI 和用户确认流程结合，但 approval/sandbox 不是所有工具共享的统一 typed orchestrator。

### Codex

Codex 把 approval/sandbox 集中在 `ToolOrchestrator` 和 `sandboxing.rs`：

- `dist/codex/codex-rs/core/src/tools/orchestrator.rs:4` 注释明确流程：approval → select sandbox → attempt → retry with escalated sandbox strategy。
- `dist/codex/codex-rs/core/src/tools/orchestrator.rs:160` 处理无需审批的 skip。
- `dist/codex/codex-rs/core/src/tools/orchestrator.rs:196` 处理需要审批的 `NeedsApproval`。
- `dist/codex/codex-rs/core/src/tools/orchestrator.rs:230` 根据 sandbox override 和 policy 选择 sandbox。
- `dist/codex/codex-rs/core/src/tools/orchestrator.rs:461` 进行第二次 escalated attempt。
- `dist/codex/codex-rs/core/src/tools/sandboxing.rs:72` `with_cached_approval()` 对 ApprovedForSession 做缓存。
- `dist/codex/codex-rs/core/src/tools/sandboxing.rs:204` 根据 `AskForApproval` 和 filesystem sandbox policy 得出默认 approval requirement。

Codex 的优势是 approval、sandbox、network、Guardian review、retry 都在系统层有统一类型和策略。

## 6. MCP 工具处理

### 当前仓库

当前仓库把 MCP 工具纳入 `Tool` object：工具可以带 `isMcp`、`mcpInfo`、`shouldDefer` 等信息，并在 `src/services/api/claude.ts` 与 ToolSearch/deferred loading 一起决定是否发送 schema。MCP 工具因此共享 TypeScript 工具链、hooks、permission 和 result mapping。

### Codex

Codex MCP 是 registry handler 的一种。根据已读 `dist/codex/codex-rs/core/src/tools/handlers/mcp.rs`：

- MCP handler 生成 canonical tool name 和 model-visible spec；
- 是否支持 parallel tool calls 可由 MCP 标记或 `annotations.read_only_hint` 决定；
- handler 通过 registry 生命周期运行 pre/post hooks 和 telemetry。

MCP 调用本身还有独立审批和事件链：

- `dist/codex/codex-rs/core/src/mcp_tool_call.rs:112` 之后是 MCP 调用主入口。
- `dist/codex/codex-rs/core/src/mcp_tool_call.rs:1204` 之后执行 MCP 审批流：auto approve、permission hook、guardian、elicitation、request_user_input fallback。
- `dist/codex/codex-rs/core/src/mcp_tool_call.rs:334` 之后执行已批准 MCP 调用并记录 telemetry。
- `dist/codex/codex-rs/core/src/mcp_tool_call.rs:850` 之后把大型 MCP 结果压缩成事件预览，避免 rollout/thread history 存入多 MB payload。
- `dist/codex/codex-rs/core/src/mcp_tool_call.rs:891` 之后发送 MCP started/completed TurnItem 事件。

核心差异：当前仓库把 MCP 工具对象化并混入 API schema 动态过滤；Codex 把 MCP handler 注册进 registry，并额外拥有独立 MCP 审批链和事件预览存储层。

## 7. 错误、中断与 tool result 配对

### 当前仓库

当前仓库需要满足 Anthropic Messages API 对 tool_use/tool_result 的配对要求，因此非常关注配对修复：

- `src/services/api/claude.ts:1325` `ensureToolResultPairing()` 会插入 synthetic error tool_results 或移除 orphan tool_results。
- `src/services/tools/StreamingToolExecutor.ts:65` fallback discard 时生成 synthetic errors。
- `src/services/tools/StreamingToolExecutor.ts:277` 如果工具启动前已 abort，则生成 synthetic error block。
- `src/services/tools/StreamingToolExecutor.ts:334` sibling abort / user interruption 时也生成 synthetic error。

Bash 工具错误还会中断 sibling 工具：

- `src/services/tools/StreamingToolExecutor.ts:358` 注释说明 Read/WebFetch 等独立工具失败不影响其他工具。
- `src/services/tools/StreamingToolExecutor.ts:359` 只有 Bash 工具错误设置 `hasErrored`。

### Codex

Codex 的中断由 runtime cancellation token 和 task abort 管理：

- `dist/codex/codex-rs/core/src/tools/parallel.rs:229` shell/unified_exec abort 输出包含 wall time。
- `dist/codex/codex-rs/core/src/tools/parallel.rs:233` 其他工具输出 `aborted by user after ...`。

Codex 不需要修复 Anthropic block 配对，而是返回对应的 `AnyToolResult` / protocol item。

## 8. 差异表

| 维度 | 当前仓库 | Codex |
| --- | --- | --- |
| 语言/运行时 | TypeScript / Node | Rust / Tokio |
| API 形态 | Anthropic Messages `tool_use/tool_result` | OpenAI Responses `ResponseItem` function/custom/tool-search calls |
| 工具抽象 | `Tool` object，包含 schema、执行、权限、UI、MCP、defer | turn 级 `spec_plan` + `ToolRouter` + `ToolRegistry` + runtime handler |
| Schema 构造 | API 请求阶段动态过滤和生成，`toolToAPISchema()` 叠加 defer/cache | router/registry 提供 model-visible specs，支持 direct/deferred/hidden exposure |
| 并发判断 | `tool.isConcurrencySafe(input)` | `supports_parallel_tool_calls()` |
| 并发执行 | 相邻 safe 工具分批；streaming 可提前执行 | 全局 `RwLock`：parallel read lock，non-parallel write lock |
| Streaming | 专门 `StreamingToolExecutor`，progress 即时 yield，结果按序 | Tokio task + protocol lifecycle events |
| 权限 | `canUseTool`、tool permission、hooks、permission mode | `ToolOrchestrator` 统一 approval/sandbox/retry |
| Sandbox | 分散在具体工具/执行层 | runtime typed policy，支持 escalated retry |
| Hooks | PreToolUse/PostToolUse/PermissionDenied/PostToolUseFailure | pre/post tool hooks + PermissionRequest hooks |
| MCP | MCP tool 是 `Tool` object，参与 ToolSearch/defer，并透传 `_meta/structuredContent` | MCP handler 注册入 registry，另有 MCP 审批链、elicitation、TurnItem 事件和大结果 preview |
| 外部协议 | 主要是本地工具接口与 Anthropic Messages 请求 | app-server JSON-RPC 暴露 MCP、command/exec、permission profile 等结构化协议 |
| 错误配对 | 需要修复 orphan tool_use/tool_result | 无 Anthropic block 配对问题，返回 typed result |

## 9. 对实现差异的判断

1. 当前仓库的工具系统更“产品客户端化”。
   - 工具 contract 同时服务模型 schema、执行、权限、UI、MCP、缓存和 ToolSearch。
   - `StreamingToolExecutor` 直接优化用户感知延迟。

2. Codex 的工具系统更“runtime 内核化”。
   - spec_plan/router/registry/orchestrator 分层明确。
   - approval、sandbox、network、Guardian review 是核心 runtime policy，而不是工具自由实现的附属逻辑。
   - app-server protocol 让工具能力不只服务模型调用，也服务外部客户端的 command/exec/MCP 请求。

3. 两者并发模型不可直接一一映射。
   - 当前仓库强调 block 顺序和 safe 批次，且支持 streaming 早执行。
   - Codex 强调统一 lock 门闩，parallel-safe 与 non-parallel 之间由 read/write lock 自然互斥。

4. 如果要互相借鉴：
   - 当前仓库可借鉴 Codex 的 approval/sandbox typed orchestration，以减少工具间权限行为差异。
   - Codex 可借鉴当前仓库 streaming executor 中的 progress/result ordering 设计，提升工具长耗时场景的交互反馈。
