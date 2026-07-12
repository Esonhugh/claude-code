# Codex Compact Mode 设计文档

- 日期：2026-06-22
- 状态：已确认方向，待用户 review 后进入实现计划
- 主题：通过 settings 支持切换到 OpenAI Codex 风格的 compact 模式

## 1. 背景与目标

当前 Claude Code 的 compact 以客户端 Message[] 重写为核心：生成 summary，插入 compact boundary，再通过 post-compact attachments 恢复近期文件、技能、计划、agent、MCP/tool delta 等客户端状态。这种方式连续性强，但也带来更高 token 成本、更复杂的附件复水逻辑，以及多次 compact 后边界和状态迁移不够结构化的问题。

Codex 的 compact 更接近 session history replacement：生成或获取 compacted history，安装 `CompactedItem` / `replacement_history`，并维护 compact window 状态。它更强调压缩后的会话历史本身成为新的上下文事实，并倾向于过滤或截断工具调用/输出。

本设计目标是在当前 TypeScript Message[] 架构内增加一个可配置的 Codex 风格 compact 模式：

- 默认不改变现有 compact 行为。
- 通过 settings 显式切换 compact 模式。
- 第一版不引入完整 Codex `replacement_history` 存储模型。
- 在保持 Anthropic Messages API 合法性的前提下，减少 post-compact attachments 和大工具输出带来的 token 负担。
- 提供明确的有效性检验，避免只做表面 parity。

## 2. 非目标

第一版明确不做：

- 不实现真正的 Rust Codex `CompactedItem` / `replacement_history` 持久化模型。
- 不改造 transcript / resume / query loop 的核心历史存储结构。
- 不实现 remote compact endpoint。
- 不实现 `new_context` 工具或无 summary 新窗口语义。
- 不要求与 Codex Rust 输出逐字一致。
- 不移除现有 Claude compact 模式。

## 3. Settings 设计

新增 settings 字段：

```json
{
  "compact": {
    "mode": "claude"
  }
}
```

支持：

```json
{
  "compact": {
    "mode": "codex",
    "codex": {
      "retainedUserMessageTokens": 20000,
      "keepPostCompactAttachments": false
    }
  }
}
```

语义：

- `compact.mode` 缺省为 `"claude"`。
- `"claude"` 完全保留当前行为。
- `"codex"` 启用 Codex-style compact projection。
- `compact.codex.retainedUserMessageTokens` 默认 `20000`，参考 Codex local compact 的近期 user message budget。
- `compact.codex.keepPostCompactAttachments` 默认 `false`，表示默认不执行现有的大规模附件复水。

建议 schema 位于 `src/utils/settings/types.ts`：

```ts
compact: z.object({
  mode: z.enum(['claude', 'codex']).optional(),
  codex: z.object({
    retainedUserMessageTokens: z.number().int().positive().optional(),
    keepPostCompactAttachments: z.boolean().optional(),
  }).optional(),
}).optional()
```

## 4. 总体方案

推荐方案是新增 settings 驱动的实验性 compact strategy，而不是直接替换现有 compact。

### 4.1 Mode resolver

新增一个小的 mode resolver：

- 从有效 settings 读取 `compact.mode`。
- 无配置或非法配置不可进入运行时；schema 层处理非法值。
- 返回 `"claude" | "codex"`。
- 所有 compact 入口统一通过 resolver 判断分流。

### 4.2 Claude mode

`claude` mode 保持现状：

- `/compact` 仍走当前 `compactConversation()`。
- auto compact 仍走当前 `autoCompactIfNeeded()` 中的 legacy compact 分支。
- session memory compact、reactive compact、post-compact cleanup 行为不变。
- 所有现有测试应继续通过。

### 4.3 Codex mode

`codex` mode 新增 `compactConversationCodexStyle(...)` 或等价 service 函数。

该函数仍返回当前代码可消费的 `CompactionResult`，但构造更接近 Codex compact 的 post-compact Message[]：

1. compact boundary
2. retained recent messages
3. compact summary message
4. minimal hook results / required context attachments

第一版不改变外部 Message[] 边界，只改变 compact 结果的构造策略。

## 5. Codex-style compact 行为

### 5.1 Summary 生成

第一版复用当前 summary 生成机制：

- 仍通过 Claude 模型请求生成 summary。
- prompt-too-long 仍使用现有 retry / head truncation 策略。
- 不新增 remote compact。

差异只发生在 summary 前后的输入清理和 compact 结果构造。

### 5.2 Retained recent messages

Codex mode 保留一段近期用户相关消息，默认 token budget 为 `20000`。

保留策略：

- 从尾部向前选择近期 user messages。
- 必须保持 API invariants，不切断 `tool_use` / `tool_result` pair。
- 如果某个 message 超预算，可截断纯文本；不得截断 JSON/tool pair 结构导致 API 非法。
- 遇到 compact boundary 时不跨越旧 boundary。

### 5.3 Tool output filtering

Codex mode 在 compact 前或 retained history 构造时处理大工具输出：

- 对超大 `tool_result` body 替换为固定提示文本，例如：

```text
[tool output truncated during codex-style compaction]
```

- 保留 `tool_use_id` 和必要结构。
- 目标是避免大工具输出同时污染 summary、retained history 和 attachments。

### 5.4 Post-compact attachments

Codex mode 默认减少 attachments：

默认不生成：

- 最近读取文件 attachments
- invoked skill 内容 attachments
- async agent attachments

可保留或预算化生成：

- tool/deferred-tool delta
- MCP instructions delta
- agent listing delta
- hook results
- plan mode 必需上下文

如果 `compact.codex.keepPostCompactAttachments = true`，可以复用现有 attachment 生成逻辑，作为兼容/调试模式。

### 5.5 Compact metadata

Codex mode 的 compact boundary 应增加可观测 metadata：

- `mode: "codex"`
- `retainedMessageCount`
- `retainedApproxTokens`
- `truncatedToolResultCount`
- `droppedAttachmentCount`
- `retainedUserMessageTokens`

如果后续实现 compact window，可继续增加：

- `windowNumber`
- `previousBoundaryUuid`
- `summaryUuid`

第一版可先做统计 metadata，不强制实现完整 window state。

## 6. 分流点

### 6.1 Manual compact

`src/commands/compact/compact.ts` 中，在传统 `compactConversation()` 前读取 mode：

- `claude`：现有路径。
- `codex`：调用 codex-style compact。

session memory compact 是否优先有两种选择：

- 第一版推荐：`codex` mode 下跳过 session memory compact，避免两套压缩模型叠加导致语义不清。
- 后续可评估：让 session memory compact 也输出 codex-style result。

### 6.2 Auto compact

`src/services/compact/autoCompact.ts` 中，在 legacy `compactConversation()` 分支处按 mode 分流。

要求：

- 阈值、disable flags、circuit breaker 保持现状。
- 成功后 `consecutiveFailures` 仍重置为 0。
- 失败后仍进入现有 failure 计数。

### 6.3 Reactive compact

第一版不改变 reactive compact。

原因：reactive compact 是 prompt-too-long fallback，优先保证恢复能力；Codex mode 第一版先覆盖 manual / auto compact 即可。

## 7. 有效性定义

Codex compact mode 有效，当且仅当它能生成：

> 更小、API 合法、能延续当前任务的 compact 后消息历史，并默认避免当前 Claude mode 的大量 post-compact attachment rehydration。

不要求第一版完全等价 Codex Rust 的 `replacement_history`。

## 8. 有效性检验矩阵

### 8.1 API 合法性

必须证明：

- compact 后 Message[] 满足 Anthropic Messages API 要求。
- 不产生 orphan `tool_use` / `tool_result`。
- `ensureToolResultPairing()` 不需要大量 synthetic repair。

建议测试：

- 构造 `assistant(tool_use A) -> user(tool_result A)`，retained budget 刚好切到边界附近。
- 断言 codex mode 不保留半个 pair。
- 断言 normalize / pairing 后没有新增 synthetic repair，或 repair count 为 0。

### 8.2 上下文可用性

必须证明：

- compact 后模型仍能继续当前任务。
- 最近用户意图和关键上下文不丢失。
- 默认少 attachments 的情况下，模型可以继续任务；如果缺文件内容，应能合理要求重新读取，而不是完全丢失任务目标。

建议交互验收：

1. 启动本地构建。
2. 设置 `compact.mode = "codex"`。
3. 让模型读取 compact 相关源码并总结流程。
4. 触发 `/compact`。
5. 追问刚才流程中的关键函数位置。
6. 通过标准：模型能保持任务目标和大致源码位置；允许重新读取文件确认细节。

### 8.3 Token 收益

必须证明：

- 在“大工具输出 + 多 post-compact attachments”场景中，codex mode 的 post-compact token 明显低于 claude mode。
- 大工具输出不会被重复带入 summary、retained history 和 attachments。

建议 A/B 指标：

| 指标 | claude | codex | 目标 |
| --- | ---: | ---: | --- |
| preCompactTokenCount | x | x | 相同或接近 |
| postCompactTokenCount | x | y | codex 更低 |
| truePostCompactTokenCount | x | y | codex 更低 |
| attachments count | x | y | codex 更少 |
| synthetic tool repairs | x | y | codex 不增加 |
| follow-up success | pass/fail | pass/fail | codex 可继续任务 |

在大输出场景中，可设置目标：

```text
codexPostCompactTokens < claudePostCompactTokens * 0.8
```

该阈值只用于大输出/多附件基准，不用于所有 compact 场景。

### 8.4 可回滚性

必须证明：

- settings 切回 `claude` 后恢复旧行为。
- `codex` mode 失败时不污染 session memory、transcript 或后续 compact boundary。
- 默认 settings 下所有旧 compact 测试仍通过。

## 9. 测试计划

### 9.1 Settings schema tests

覆盖合法配置：

```json
{
  "compact": {
    "mode": "codex",
    "codex": {
      "retainedUserMessageTokens": 20000,
      "keepPostCompactAttachments": false
    }
  }
}
```

覆盖非法配置：

```json
{
  "compact": {
    "mode": "openai"
  }
}
```

期望非法配置被 settings validation 拒绝。

### 9.2 Unit tests

覆盖：

- 默认 mode resolver 返回 `claude`。
- `compact.mode = "codex"` 时分流到 codex-style builder。
- codex boundary metadata 存在。
- retained recent messages 遵守 token budget。
- 不切断 tool pair。
- 大 tool output 被截断。
- attachments 默认减少。
- `keepPostCompactAttachments = true` 时可保留现有附件行为。

### 9.3 Integration tests

Manual compact：

- 构造带工具调用、文件读取、长工具输出的 conversation。
- 分别运行 claude / codex mode。
- 比较 token、attachments、pairing 合法性。

Auto compact：

- 构造超过 threshold 的消息。
- mock session memory compact 为 null。
- codex mode 下 `autoCompactIfNeeded()` 返回 `wasCompacted: true`。
- 成功后 failure count reset。
- 失败时沿用现有 circuit breaker。

### 9.4 Local interactive verification

按项目现有验证方式：

1. 构建：`make build`
2. 配置 `.claude/settings.local.json`：

```json
{
  "compact": {
    "mode": "codex"
  }
}
```

3. 启动本地 CLI：`./built-claude --dangerously-skip-permissions`
4. 执行真实 `/compact` 场景。
5. 记录 compact 前后关键输出与 follow-up 表现。

## 10. 风险与缓解

### 风险 1：上下文连续性下降

原因：Codex mode 默认减少 attachments，可能导致模型缺少文件内容。

缓解：

- 第一版保留 `keepPostCompactAttachments` escape hatch。
- 保留必要 tool/MCP/agent delta。
- 交互验收允许模型重新读取文件，但不允许丢失任务目标。

### 风险 2：Message[] API invariant 被破坏

原因：retained budget 可能切断 tool pair。

缓解：

- retained selector 必须复用或新增 API invariant preserving helper。
- 测试覆盖 tool pair 边界。
- compact 后运行 pairing validation。

### 风险 3：与 session memory compact 语义冲突

原因：session memory compact 本身已有 preserved tail 策略。

缓解：

- 第一版 codex mode 下跳过 session memory compact。
- 后续单独设计 session memory + codex mode 组合。

### 风险 4：命名误导

原因：第一版不是完整 Codex replacement history。

缓解：

- 文档和 metadata 使用 `codex-style` 描述内部实现。
- settings 用户可见仍叫 `codex`，但说明它是在当前 Message[] 架构内模拟 Codex compact 语义。

## 11. 推荐实施顺序

1. Settings schema 与 mode resolver。
2. Codex-style compact result builder。
3. Manual compact 分流。
4. Auto compact 分流。
5. Tool output truncation 与 retained message budget。
6. Metadata 与 A/B 指标。
7. 单元测试、集成测试、本地交互验证。

## 12. 验收标准

MVP 必须满足：

- 默认 settings 下旧行为不变。
- `compact.mode = "codex"` 可分流。
- manual compact 可用。
- auto compact 可用。
- compact 后 Message[] API 合法。
- 大工具输出场景 token 明显下降。
- settings 切回 `claude` 后恢复旧行为。
- 本地交互验证能在 compact 后延续当前任务。
