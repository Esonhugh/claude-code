# 当前仓库与 Codex 上下文压缩实现差异

## 结论摘要

当前仓库和 `dist/codex/` 都有上下文压缩能力，但设计目标和状态迁移方式不同：

- 当前仓库的压缩是客户端消息数组重写：生成 summary，插入 compact boundary，再补充 post-compact attachments，用于恢复文件、技能、计划、异步 agent、MCP/tool 等上下文。
- Codex 的压缩是 session history replacement：生成或获取 compacted history，写入 `CompactedItem` 与 `replacement_history`，并维护 auto compact window ids。
- 当前仓库压缩后会主动“复水”大量客户端状态；Codex 更倾向于让 compacted history 成为新的会话事实，并过滤掉工具调用/输出等不适合保留的 response items。
- 当前仓库 auto compact 主要由本地 token threshold 触发；Codex 还维护 auto compact window state 和 token budget reminder，并支持 remote compaction endpoint。

## 1. 入口与触发方式

### 当前仓库

当前仓库有手动 `/compact` 和 query loop 中的 auto compact。

手动入口在 `src/commands/compact/compact.ts`：

- `src/commands/compact/compact.ts:46` 先调用 `getMessagesAfterCompactBoundary()`，只压缩上一次 boundary 之后的消息。
- `src/commands/compact/compact.ts:58` 无 custom instructions 时优先尝试 session memory compaction。
- `src/commands/compact/compact.ts:88` reactive-only 模式走 `compactViaReactive()`。
- `src/commands/compact/compact.ts:98` 传统路径先 `microcompactMessages()`。
- `src/commands/compact/compact.ts:101` 调用 `compactConversation()`。
- `src/commands/compact/compact.ts:118` 成功后执行 `runPostCompactCleanup()`。

自动入口在 `src/query.ts` 和 `src/services/compact/autoCompact.ts`：

- `src/query.ts:369` 之后的 query 主循环先裁到最近 compact boundary 后，再执行 tool result budget、snip、microcompact、context collapse，最后调用 `deps.autocompact(...)`。
- `src/query/deps.ts:33` 之后把生产实现绑定到 `autoCompactIfNeeded()`。
- `src/services/compact/autoCompact.ts:160` `shouldAutoCompact()` 判断是否需要压缩。
- `src/services/compact/autoCompact.ts:241` `autoCompactIfNeeded()` 执行 auto compact。
- `src/services/compact/autoCompact.ts:288` auto compact 也先尝试 session memory compaction。

### Codex

Codex 的 compact 是 session task 或 inline task，并且 auto compact 触发点在 turn 主循环内：

- `dist/codex/codex-rs/core/src/session/turn.rs:320` 之后采样后计算 token 状态、记录 token budget reminder，并在 mid-turn 超限且需要 follow-up 时触发 auto compact。
- `dist/codex/codex-rs/core/src/session/turn.rs:862` 之后处理 pre-turn token limit reached。
- `dist/codex/codex-rs/core/src/session/turn.rs:899` 之后处理模型切换、`comp_hash` 变化、大窗口切小窗口时的 pre-turn compact。
- `dist/codex/codex-rs/core/src/session/turn.rs:965` 之后统一分派 local / remote / remote_v2。
- `dist/codex/codex-rs/core/src/tasks/compact.rs:34` 手动 compact 根据 provider 判断是否使用 remote compact。
- `dist/codex/codex-rs/core/src/tasks/compact.rs:65` local compact 使用 `SUMMARIZATION_PROMPT`。
- `dist/codex/codex-rs/core/src/tasks/compact.rs:70` 调用 local `run_compact_task()`。
- `dist/codex/codex-rs/core/src/compact.rs:73` 是 inline auto compact 入口。
- `dist/codex/codex-rs/core/src/compact.rs:105` 是 local manual compact task 入口。
- `dist/codex/codex-rs/core/src/compact_remote.rs:44` 是 inline remote auto compact 入口。
- `dist/codex/codex-rs/core/src/compact_remote.rs:65` 是 manual remote compact 入口。

Codex 从入口上就分为 local compact 与 remote compact，而当前仓库主要是客户端 summary compact，另有 session memory / reactive compact 分支。

## 2. Auto compact 阈值与开关

### 当前仓库

当前仓库的 auto compact 使用显式 token buffer：

- `src/services/compact/autoCompact.ts:62` `AUTOCOMPACT_BUFFER_TOKENS = 13_000`。
- `src/services/compact/autoCompact.ts:76` threshold = effective context window - buffer。
- `src/services/compact/autoCompact.ts:40` `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 可覆盖 context window。
- `src/services/compact/autoCompact.ts:79` `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 可覆盖百分比。
- `src/services/compact/autoCompact.ts:147` `DISABLE_COMPACT` 禁用全部 compact。
- `src/services/compact/autoCompact.ts:152` `DISABLE_AUTO_COMPACT` 仅禁用 auto compact。
- `src/services/compact/autoCompact.ts:70` 连续失败 circuit breaker 为 3 次。
- `src/services/compact/autoCompact.ts:262` 达到连续失败上限后跳过未来 auto compact。

这说明当前仓库 auto compact 是本地估算 + 阈值触发 + failure circuit breaker 的产品化机制。需要注意，真正 auto compact 前还可能已经发生 API context management、snip、microcompact、context collapse 等轻量裁剪，因此“正式摘要压缩”和“预处理/轻量压缩”应分开比较。

### Codex

Codex 的 auto compact 状态由 session window 管理。根据已读 `dist/codex/codex-rs/core/src/state/auto_compact_window.rs` 和 `dist/codex/codex-rs/core/src/session/token_budget.rs`：

- `AutoCompactWindow` 保存 window number、window ids、prefill baseline、new context window request、token budget reminder 状态。
- `advance()` 会推进 window id 并重置相关状态。
- token budget reminder 会在接近压缩预算时写入 `ContextualUserFragment::TokenBudgetReminder`，且通过 claim 机制避免重复。

Codex 更强调“压缩窗口”作为 session state 的一部分，而不是单次 query 的本地阈值判断。

## 3. Summary 生成与 prompt-too-long 重试

### 当前仓库

传统压缩核心在 `src/services/compact/compact.ts`：

- `src/services/compact/compact.ts:391` `compactConversation()` 是核心函数。
- `src/services/compact/compact.ts:455` 通过 `streamCompactSummary()` 生成 summary。
- `src/services/compact/compact.ts:471` prompt-too-long 时调用 `truncateHeadForPTLRetry()`。
- `src/services/compact/compact.ts:245` `truncateHeadForPTLRetry()` 从头部删除旧 API round group，保留近期消息。

当前仓库 summary 生成仍通过 Claude 模型请求完成；如果 compact 请求本身超上下文，会裁掉最旧消息后重试。

### Codex local compact

Codex local compact 在 `dist/codex/codex-rs/core/src/compact.rs`：

- `dist/codex/codex-rs/core/src/compact.rs:202` `run_compact_task_inner_impl()` 执行 local compact。
- `dist/codex/codex-rs/core/src/compact.rs:260` `ContextWindowExceeded` 时删除最旧输入再重试。
- `dist/codex/codex-rs/core/src/compact.rs:300` 从 compact turn 最后一条 assistant message 取 summary suffix。
- `dist/codex/codex-rs/core/src/compact.rs:301` 用 `SUMMARY_PREFIX` 拼出 summary text。

两者都在 prompt-too-long 时偏向删除最旧内容、保留近期上下文；但当前仓库删除的是消息数组中的 API round group，Codex 删除的是 compact turn input 中的最旧 item。

## 4. 压缩后历史形态

### 当前仓库：boundary + summary + attachments

当前仓库构造压缩后消息的方式是显式消息拼接：

- `src/services/compact/compact.ts:333` `buildPostCompactMessages()` 返回顺序：
  1. boundary marker；
  2. summary messages；
  3. messagesToKeep；
  4. attachments；
  5. hookResults。
- `src/services/compact/compact.ts:602` 创建 compact boundary。

这说明压缩后会话仍是普通 message list，只是前面插入 boundary 和 summary，再补充必要附件。

### Codex：CompactedItem + replacement_history

Codex local compact 会安装 compacted history：

- `dist/codex/codex-rs/core/src/compact.rs:304` 调用 `build_compacted_history()`。
- `dist/codex/codex-rs/core/src/compact.rs:305` 调用 `sess.advance_auto_compact_window()`。
- `dist/codex/codex-rs/core/src/compact.rs:319` 构造 `CompactedItem`。
- `dist/codex/codex-rs/core/src/compact.rs:321` `replacement_history: Some(new_history.clone())`。
- `dist/codex/codex-rs/core/src/compact.rs:327` 调用 `sess.replace_compacted_history()`。

Codex 把 compact 作为 conversation history 的替换操作，并通过 `CompactedItem` 保留 summary、replacement history 和 window ids。

## 5. 压缩后状态恢复

### 当前仓库：主动复水客户端上下文

当前仓库压缩后会恢复多类客户端上下文：

- `src/services/compact/compact.ts:122` 最多恢复 5 个最近读取文件。
- `src/services/compact/compact.ts:123` post-compact token budget 为 50,000。
- `src/services/compact/compact.ts:537` 生成 file attachments。
- `src/services/compact/compact.ts:562` 添加 skill attachment。
- `src/services/compact/compact.ts:594` 添加 deferred tools、agent listing、MCP instructions 等 delta。
- `src/services/compact/compact.ts:1594` 生成 async agent attachments。

这体现了当前仓库压缩的关键目标：不仅保留对话摘要，还要恢复“模型继续工作需要的隐式客户端状态”，例如近期读过的文件、已加载技能、计划模式、异步 agent 结果、MCP/tool instructions。

### Codex：通过 compacted history 和 initial context 注入

Codex local compact 构建 replacement history 时主要保留：

- compact summary；
- 最多 20,000 tokens 的近期 user messages；
- 必要时注入 initial context。

证据：

- `dist/codex/codex-rs/core/src/compact.rs:52` `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`。
- `dist/codex/codex-rs/core/src/compact.rs:302` `collect_user_messages()`。
- `dist/codex/codex-rs/core/src/compact.rs:548` `build_compacted_history()`。

Codex remote compact 则可能由远端返回 compacted history，客户端再做过滤和 initial context 注入。

相比当前仓库，Codex 没有等价的“恢复最近读取文件/技能/计划/MCP delta”的附件复水机制；它更依赖 replacement history 作为压缩后的上下文事实。

### 当前仓库：Session memory preserved tail

当前仓库还有 session memory compaction 分支，不等同于传统 legacy compact：

- `src/services/compact/sessionMemoryCompact.ts:49` 之后定义默认保留策略：`minTokens=10000`、`minTextBlockMessages=5`、`maxTokens=40000`。
- `src/services/compact/sessionMemoryCompact.ts:331` 之后根据 `lastSummarizedMessageId` 计算 preserved tail 起点。
- `src/services/compact/sessionMemoryCompact.ts:377` 之后向前扩展时不会穿过最近 compact boundary。
- `src/services/compact/sessionMemoryCompact.ts:154` 之后显式避免切断 tool_use/tool_result 配对，并保留同 message id 的 earlier thinking/tool_use 片段。

这使当前仓库并非单纯“摘要后清空历史”，而是可把 session memory 已覆盖的前缀和仍需保留的尾部组合起来。

## 6. 工具输出处理

### 当前仓库

当前仓库在 compact 前后有多种客户端侧处理：

- 手动 compact 前会执行 `microcompactMessages()`：`src/commands/compact/compact.ts:98`。
- query 主循环在 auto compact 前会先执行 tool result budget、snip、microcompact、context collapse：`src/query.ts:400` 之后。
- `compactConversation()` 会 strip images、strip reinjected attachments、清理 readFileState / nested memory 状态，并在压缩后用 attachments 恢复需要的文件内容。
- `src/services/compact/compact.ts:1439` `createPostCompactFileAttachments()` 只把符合 token budget 的近期文件注入。
- `src/services/compact/compact.ts:1484` 检查附件 token 是否不超过 `POST_COMPACT_TOKEN_BUDGET`。

当前仓库的设计重点是：把不适合总结或会重复污染上下文的内容移除，再把仍需继续工作的资料以附件形式补回。此外，`src/services/compact/apiMicrocompact.ts:16` 之后定义的 API context management 默认 trigger 180k、target 40k；`apiMicrocompact.ts:66` 之后会生成 `clear_thinking_20251015` 和 `clear_tool_uses_20250919` 策略，最后由 `src/services/api/claude.ts:1656` / `1742` 附加到 API 请求体。它属于比正式 compact 更轻量的上下文管理层。

### Codex remote compact

Codex remote compact 对工具输出处理更直接：

- `dist/codex/codex-rs/core/src/compact_remote.rs:41` 定义 `CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE`。
- `dist/codex/codex-rs/core/src/compact_remote.rs:192` 调用 `trim_function_call_history_to_fit_context_window()`。
- `dist/codex/codex-rs/core/src/compact_remote.rs:413` 重写 `FunctionCallOutput`。
- `dist/codex/codex-rs/core/src/compact_remote.rs:437` 重写 `ToolSearchOutput`。
- `dist/codex/codex-rs/core/src/compact_remote.rs:455` 用固定文案替换过长输出 body。

remote compact 返回后还会过滤历史：

- `dist/codex/codex-rs/core/src/compact_remote.rs:321` `retain(should_keep_compacted_history_item)`。
- `dist/codex/codex-rs/core/src/compact_remote.rs:341` `should_keep_compacted_history_item()`。
- `dist/codex/codex-rs/core/src/compact_remote.rs:357` 至 `compact_remote.rs:363` 丢弃 FunctionCall、ToolSearchCall、FunctionCallOutput、ToolSearchOutput、CustomToolCall、CustomToolCallOutput 等。

Codex remote compact 的策略是：在 remote compact 前裁掉超预算工具输出；remote 返回后从 compacted history 中移除工具调用/输出类 item。

## 7. Hooks 差异

### 当前仓库

当前仓库 compact hooks 在 `compactConversation()` 内执行，且 compact 后还有 hook results 进入消息数组：

- `src/services/compact/compact.ts:333` `buildPostCompactMessages()` 包含 `hookResults`。
- `src/commands/compact/compact.ts:25` 引入 `executePreCompactHooks()`，手动命令也涉及 pre compact hook。

此外 compact 后会执行 cleanup、清缓存、重置 summary 状态等客户端动作。

### Codex

Codex local/remote compact 也支持 PreCompact/PostCompact hooks。根据已读 `compact.rs` / `compact_remote.rs`，compact task 内会执行 hooks 并通过 session event 通知状态。但 Codex 的 hook 结果不是作为 post-compact attachments 拼进普通 message list，而是嵌入 session task / event / history replacement 流程。

## 8. Remote compact 与 new context 能力

### 当前仓库

当前仓库已读路径中没有等价的 provider remote compact endpoint 分流；传统 compact 是客户端发起 summary 请求，然后本地构造 post-compact message list。另有 session memory compaction 和 reactive compact 分支，但它们仍属于当前仓库客户端 compact 策略的一部分。

### Codex

Codex 在 task 入口直接分流 remote compact：

- `dist/codex/codex-rs/core/src/tasks/compact.rs:34` `should_use_remote_compact_task(ctx.provider.info())`。
- `dist/codex/codex-rs/core/src/tasks/compact.rs:45` 可走 remote v2。
- `dist/codex/codex-rs/core/src/tasks/compact.rs:52` 可走 remote compact。
- `dist/codex/codex-rs/core/src/compact_remote.rs:243` 调用 `compact_conversation_history()`。

Codex 还有 remote v2 与 new context：

- `dist/codex/codex-rs/core/src/compact_remote_v2.rs:49` 定义 retained message 预算为 64,000 tokens。
- `dist/codex/codex-rs/core/src/compact_remote_v2.rs:439` 之后只保留 `user|developer|system` message，裁剪到固定预算，再追加单个 `Compaction` item。
- `dist/codex/codex-rs/core/src/tools/handlers/new_context_window.rs:13` 之后实现 `new_context` 工具，返回语义是“不开 summary，直接开新上下文窗口”。
- `dist/codex/codex-rs/core/src/session/mod.rs:3349` 之后 `maybe_start_new_context_window()` 用 initial context 替换 history，并持久化空 message 的 `CompactedItem`。

这表示 Codex provider 可以直接提供 compacted history，客户端负责前处理和后处理；同时 Codex 还支持完全跳过 summary 的新上下文窗口机制。

## 9. 差异表

| 维度 | 当前仓库 | Codex |
| --- | --- | --- |
| 入口 | `/compact` command + query loop auto compact；query 中还先做 budget/snip/microcompact/collapse | SessionTask compact + inline auto compact；turn loop 支持 pre-turn/mid-turn/model-switch 触发 |
| 主要形态 | message list 重写；session memory 分支保留 preserved tail | session history replacement；另有 `new_context` 直接新窗口 |
| Summary 生成 | 客户端调用模型 summary | local 模型 summary 或 remote endpoint |
| 压缩后结构 | boundary + summary + kept messages + attachments + hook results | `CompactedItem` + `replacement_history` + window ids |
| Auto compact 阈值 | effective window - 13k buffer，可 env override | auto compact window state + token budget reminder |
| 失败保护 | 连续 auto compact 失败 3 次 circuit breaker | local compact context exceeded 删除最旧 item 重试 |
| 状态恢复 | 恢复近期文件、skills、plan、agent、MCP/tool delta | 主要依赖 replacement history 和 initial context 注入 |
| 工具输出 | microcompact / tool result budget / API context management / strip attachments / post-compact file restore | remote 前裁剪 tool output；remote 后过滤 tool call/output items；history 层 normalize tool call/output pairing |
| Hooks | PreCompact/PostCompact 结果可进入 post-compact messages | hooks 走 session task/event/history replacement 流程，可中断 compact |
| Remote compact | 未见同构 provider compact endpoint 分流 | provider 可选择 remote / remote v2 compact |
| 新上下文窗口 | 主要通过 summary/boundary/attachments 延续上下文 | `new_context` 可不总结历史，直接安装新 initial context |

## 10. 对实现差异的判断

1. 当前仓库压缩更像“客户端工作区状态迁移”。
   - 压缩不仅为了减少 token，还要保证模型压缩后仍知道最近读过哪些文件、加载过哪些技能、有哪些计划和异步 agent 状态。
   - 这解释了为什么当前仓库有大量 post-compact attachments。

2. Codex 压缩更像“会话历史重写”。
   - `CompactedItem` 和 `replacement_history` 是核心。
   - window ids 让 auto compact 具备连续窗口语义。
   - `new_context` 说明 Codex 还有“不总结，直接新窗口”的旁路机制。

3. 两者对工具输出的态度不同。
   - 当前仓库会尽量通过 microcompact、strip、attachments 在保真和预算之间平衡。
   - Codex remote compact 更倾向于直接截断或过滤工具调用/输出类 items，避免它们进入 compacted history。

4. 如果要互相借鉴：
   - 当前仓库可借鉴 Codex 的 `CompactedItem` / window ids，把多次 compact 的历史边界建模得更结构化。
   - Codex 可借鉴当前仓库 post-compact attachments，在压缩后显式恢复文件/技能/计划等客户端隐式状态，减少 summary 遗漏导致的工作中断。
