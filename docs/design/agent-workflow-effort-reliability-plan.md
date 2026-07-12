# Agent、Workflow 与 Effort 可靠性改进计划

> 状态：设计决策已审查确认，待分阶段实施  
> 适用基线：重点审计范围 `7a2b301..2ddc97f`；文档编写时仓库 `HEAD` 为 `56b91a6`  
> 日期：2026-07-12  
> 目标读者：负责 Agent、Workflow、Plugin、Task 与 SDK effort 功能的开发和审查人员  
> 审查结论：采用既有 `totalTokens` 语义、`completed + warnings`、卸载失败零清理、TaskUpdate partial result、configured → applied 展示、保持当前 OpenAI mapping、四阶段交付

## 1. Problem Statement

提交范围 `7a2b301..2ddc97f` 同时修改了 Agent token 统计、前后台生命周期、Workflow 状态、Plugin UI 和 provider-specific effort 路由。审计确认，当前实现中存在以下几类问题：

1. Agent 的执行终态、通知终态和后处理异常没有完全隔离，可能出现任务已完成但模型收到失败通知。
2. Workflow 实时 token 统计会重复处理同一 assistant message，导致运行中指标被放大。
3. Agent final result、progress tracker、SDK notification 对 `totalTokens` 使用不同统计口径。
4. Anthropic `ultracode` 路由绕过 `max` 能力降级，可向不支持 `max` 的模型发送非法参数。
5. SDK 类型、control response、ModelInfo schema、CLI help 和 UI 展示对 effort 值的表达不一致。
6. Plugin uninstall 和 TaskUpdate 存在非原子更新或错误成功，可能留下持久状态不一致。
7. Script Workflow 和 foreground-to-background Agent 的实时可观测性不完整。

这些问题会导致请求失败、错误重试、状态误报、统计失真、SDK 类型分叉以及部分数据已修改但操作报告失败或成功的情况。

## 2. Scope and Evidence Boundary

### 2.1 范围内回归或同步遗漏

以下问题与 `7a2b301..2ddc97f` 中的改动直接相关：

- Anthropic `ultracode` 绕过 `max` capability clamp，由 `2ddc97f` 引入。
- `get_settings.applied.effort` 与 OpenAI request gate 分叉，由 `2ddc97f` 的 OpenAI bypass 暴露。
- SDK `EffortLevel` 缺少 `none` 和 `ultra`，属于 `566b666` 的类型同步遗漏。
- `/effort` help、argument hint 和错误提示遗漏 `ultra`，属于 `566b666` 的调用点遗漏。
- effort 描述和设计材料未随 `2ddc97f` 的映射调整同步。
- Agent final token 与 tracker 口径分裂，由 `6c2f287` 引入或显著暴露。
- foreground-to-background summarizer 生命周期问题与 `a4dcff6` 的 continuation 调整直接相关。
- TaskUpdate 的错误报告在 `a4dcff6` 中得到改善，但跨文件操作仍没有原子或部分成功语义。

### 2.2 范围之前已经存在、但本次审计发现的问题

这些问题不应错误归因给上述五个提交，但建议一起治理：

- Plugin uninstall 忽略 settings 写入失败。
- Workflow plan runtime 对同一 progress message 的 token 重复累计。
- Script Workflow 运行中 token/tool metrics 固定为零。

### 2.3 需要外部协议确认的事项

仓库内部只能确认 OpenAI effort 实现、测试、文案和历史设计互相矛盾，不能仅凭源码裁决 OpenAI/Codex wire 值究竟应为 `"max"` 还是 `"ultra"`。

在获得权威 schema、本地授权请求响应或明确上游实现证据前：

- 不应修改 wire mapping；
- 可以先修复内部文案与类型不一致，但文案必须避免声称未经验证的 wire contract；
- 应建立可替换的协议 fixture，让最终决定只影响单一映射层。

## 3. Solution

采用分阶段治理，而不是一次性重构：

1. 先修复会造成请求失败、错误终态和破坏性状态不一致的问题。
2. 再统一 token/usage 的术语、协议和实时统计行为。
3. 最后同步 SDK 类型、CLI help、UI 文案和 provider-specific effort 展示。
4. 所有修复都先添加最小失败测试，再做最小实现变更。
5. 不引入新的通用框架；优先复用现有 tracker、task reducer、settings result 和 schema 测试入口。

## 4. User Stories

1. As a Claude user, I want `ultracode` to degrade safely on models that do not support `max`, so that my request does not fail because of an unsupported effort value.
2. As a Claude user, I want a completed Agent to remain completed even if transcript classification fails, so that successful work is not reported as failed.
3. As a Claude user, I want a completed Agent to remain completed if worktree metadata or cleanup fails, so that cleanup diagnostics do not replace the execution result.
4. As a parent model, I want Agent terminal notifications to match the task's stored terminal state, so that I do not unnecessarily repeat successful work.
5. As a user monitoring a Workflow, I want one assistant response to contribute token usage only once, so that live metrics are credible.
6. As a user monitoring a Workflow, I want multiple tool activities to increase tool count without multiplying message token usage, so that activity detail and usage accounting remain independent.
7. As an SDK consumer, I want the same Agent execution to report one documented token metric across result and notification surfaces, so that integrations do not reconcile conflicting numbers.
8. As an SDK consumer, I want failed and killed background Agent notifications to include work already performed, so that cost and progress are observable even when execution does not complete.
9. As a Workflow user, I want Script Workflow Agents to show live token and tool progress, so that running work does not appear idle.
10. As an SDK UI consumer, I want progress summaries to continue after a foreground Agent moves to the background, so that summaries do not become stale.
11. As a plugin user, I want uninstall to stop before destructive cleanup if settings cannot be written, so that enabled state, installation records, secrets and data do not diverge.
12. As a plugin user, I want uninstall failure to produce a non-success CLI/UI result, so that I can correct permissions or malformed settings.
13. As a task consumer, I want TaskUpdate failure results to disclose partial changes, so that retry behavior is safe.
14. As a task consumer, I want deletion to distinguish “task removed but reference cleanup failed” from “task not removed,” so that recovery is possible.
15. As a task consumer, I want dependency edges to remain bidirectionally consistent, so that graph traversal does not observe one-sided relations.
16. As a TypeScript SDK user, I want `none` and `ultra` to be accepted wherever the runtime supports them, so that I do not need unsafe type assertions.
17. As an SDK consumer, I want `get_settings.applied.effort` to reflect the value that request construction will attempt to send, so that control-plane reporting matches the data plane.
18. As an SDK consumer, I want `ModelInfo.supportedEffortLevels` runtime output to satisfy its schema, so that decoding does not fail.
19. As a CLI user, I want `/effort help` and invalid-option messages to list every accepted value, so that supported functionality is discoverable.
20. As a CLI user, I want effort status text to clearly distinguish configured, applied and normalized display values, so that `ultra` is not silently presented as `high` without explanation.
21. As a maintainer, I want provider mapping decisions isolated from UI normalization, so that changing an external protocol does not require scattered edits.
22. As a maintainer, I want tests to state whether a token field is context size, lifecycle progress or billable usage, so that future changes do not mix metrics.
23. As a release reviewer, I want findings tagged as regression, pre-existing issue or external-protocol dependency, so that ownership and release risk are clear.
24. As a release reviewer, I want focused test evidence for each repaired behavior, so that passing unrelated tests does not mask a missing edge case.

## 5. Implementation Decisions

### 5.1 Agent execution terminal state

- Treat Agent execution outcome as authoritative once the Agent stream has completed and its result has been stored.
- 审查已确认采用 `completed + warnings`，不新增 `completed_with_warnings` 终态。
- Classifier、worktree inspection、cleanup 和 notification enrichment 均属于后处理；失败时增加结构化 warning，但不能把已完成执行改为 failed。
- Warning 至少包含 `stage`、稳定错误类别和安全消息；本地路径只进入本地 UI/日志，不默认发送给父模型。
- Before emitting any terminal notification, derive the notification status from current task state rather than from the catch branch alone.
- Keep notification deduplication, but only mark a task notified after the notification has been successfully enqueued. If changing this ordering introduces duplicate risk, use an explicit notification state such as `pending | delivered | failed` instead of a single eager boolean.
- 通知传输失败不改变 Agent 执行终态，并允许安全重试。
- Preserve cleanup failures for logs and warning metadata; do not silently swallow them.

### 5.2 Agent usage contract

审查已确认保留现有 `totalTokens` 设计。所有对外的 `totalTokens`、`total_tokens` 和 UI `tok` 统一表示最后一次完整 API response 的上下文大小：

```text
totalTokens =
  input_tokens
  + cache_creation_input_tokens
  + cache_read_input_tokens
  + output_tokens
```

约束：

- Agent result、实时 progress、Workflow、SDK notification 和后台 terminal notification 使用同一口径。
- 不累计历史 response 的 output token。
- 数值允许在 context compaction 后下降；这表示最新上下文变小，不是统计回退。
- `totalTokens` 不表示生命周期累计消耗、账单 token 或成本。
- 原始 `usage` 继续对应最后一次 response。
- failed/killed terminal notification 使用异常发生前最后一个完整可观察 response；发送前应刷新流式原地更新的 usage。
- 如果未来需要请求级累计消耗，必须新增明确命名的独立字段，不能改变 `totalTokens` 的既有语义。

### 5.3 Workflow progress deduplication

- Treat assistant message identity as the unit of token accounting, not activity count.
- Treat tool-use identity as the unit of tool counting and activity history.
- Reuse the Local Agent progress tracker behavior or extract only the smallest shared accounting primitive if direct reuse is impractical.
- A progress callback for one assistant message may update its usage snapshot, but repeated delivery of the same snapshot must be idempotent.
- Emit all activities from the message while applying the message's token delta once.
- Keep live progress and final result semantically aligned; if final output reports a different metric, label it explicitly rather than allowing a silent jump.

### 5.4 Script Workflow live metrics

- Consume the same Agent progress payload used by normal Workflow execution instead of relying only on a `summary` property.
- Convert cumulative snapshots to deltas before passing them to the Workflow reducer, because the reducer accepts increments.
- Continue using final Agent output as the completion authority.
- Preserve activity summaries independently of token/tool counters.

### 5.5 Foreground-to-background summarization

- Transfer summarizer ownership when an Agent moves to background instead of stopping it permanently.
- If the summarizer cannot be transferred, stop and recreate it against the same Agent message source and task identity.
- Ensure only one summarizer is active at a time.
- Stop it on every terminal path, including completed, failed and killed.

### 5.6 Anthropic effort capability handling

- Route `ultracode` through the same Anthropic `max` capability check as `max`, `xhigh` and `ultra`.
- Preserve OpenAI `ultracode → xhigh` behavior unless external protocol verification changes it.
- Capability fallback must occur before request construction and be shared by CLI, SDK Agent and environment-variable inputs.

### 5.7 Effort types and reporting

- Define a single configured-effort string union used by public SDK options, session options, Agent definitions and parser input where their accepted input contract is the same.
- Keep provider wire types separate from configured values.
- Make `get_settings.applied.effort` call the same resolution/gating decision used by request construction.
- Make `ModelInfo.supportedEffortLevels` producer and schema use one shared source of truth, while excluding internal orchestration values if they are not intended as model capabilities.
- 审查已确认 UI 采用 configured → applied 的分层展示：相同值只显示一个值，不同值显示如 `ultracode → high`、`max → ultra`、`auto → high`。
- `/effort current` 和 SDK settings 分别暴露 configured 与 applied；`ultracode` orchestration mode 和 persistence 另行展示。
- Normalized effort 仅用于颜色、图标或排序，不作为权威文本。
- Applied 暂指本地请求构造前的解析值；不可计算时显示明确的 unavailable/reason，不以普通 `null` 掩盖分叉。
- Update `/effort` help, argument hint and invalid-option text from one shared list or a deliberately filtered user-facing list.
- 审查已确认保持当前 OpenAI mapping：`max → ultra`、`ultra → ultra`、`ultracode → xhigh`。本计划只修内部一致性，不修改 wire mapping，也不宣称它已经获得外部协议验证。

### 5.8 Plugin uninstall consistency

- Check settings persistence before deleting installation records, options, secrets or data.
- On settings failure, return `success: false` and perform no destructive cleanup.
- Do not attempt broad rollback across all plugin storage in this phase; prevent the known partial state by ordering persistence before cleanup.
- Preserve the special project-enabled confirmation path that already checks settings errors.

### 5.9 TaskUpdate partial success

- Do not claim full transactional behavior across multiple task files unless a transaction mechanism is implemented.
- Introduce an explicit partial-result contract for operations that can complete one stage and fail another.
- For delete, distinguish:
  - task not deleted;
  - task deleted, reference cleanup incomplete;
  - task fully deleted and references cleaned.
- For dependency updates, validate first, then use a consistent lock/order strategy for both sides where feasible.
- If rollback of the first edge write fails or is not safe, report the exact committed side in the result.
- Avoid repeating owner assignment messages on retries after a partial result.

## 6. Phased Delivery Plan

### Phase 0: Contract lock and regression fixtures

Deliverables:

- Add focused failing tests for the confirmed range regressions.
- Record token field semantics in test names and API comments.
- Add a local protocol fixture for OpenAI effort mapping without deciding the external `max` versus `ultra` question.

Exit criteria:

- Every Phase 1 behavior has a failing regression test on the target baseline.
- Tests distinguish range regressions from pre-existing findings.

### Phase 1: Request safety and persistent state

Scope:

1. Anthropic `ultracode` clamp.
2. Plugin uninstall settings failure guard with zero destructive cleanup.
3. TaskUpdate explicit partial-result contract for delete and dependency operations.

Exit criteria:

- Unsupported Anthropic models never receive `max` from `ultracode`.
- Plugin uninstall performs no cache clearing or destructive cleanup after settings persistence failure.
- TaskUpdate distinguishes no mutation, partial commit and full success, including committed/pending stages.

完成后暂停，由用户审查 diff 和测试结果，再决定是否进入 Phase 2。

### Phase 2: Agent lifecycle

Scope:

1. `completed + warnings` for classifier/worktree post-processing failures.
2. Notification delivery state and safe retry.
3. Usage in failed/killed background notifications.
4. Foreground-to-background summarizer transfer.

Exit criteria:

- A completed task cannot emit a failed terminal notification solely because post-processing failed.
- Post-processing failures produce structured warnings without exposing unsafe local details to the parent model.
- Failed/killed background notifications include the last complete response usage.
- Summary updates continue after backgrounding and stop exactly once at terminal state.

完成后暂停，由用户审查 diff、debug log 和 tmux 验证结果，再决定是否进入 Phase 3。

### Phase 3: Token and Workflow accounting

Scope:

1. All external token surfaces use last-response context semantics.
2. Deduplicate Workflow assistant message usage and tool-use activities.
3. Connect Script Workflow live metrics.
4. Align Plan/Script live and completion metrics with the same token contract.

Exit criteria:

- Agent result, task progress, Workflow and SDK notification report the last complete response context size.
- One assistant message contributes token once regardless of callback or activity count.
- One tool-use ID contributes one tool count.
- Script Workflow shows non-zero live metrics after progress is received.
- Context compaction may lower the displayed token value without being treated as an error.

完成后暂停，由用户审查 diff 和交互验证结果，再决定是否进入 Phase 4。

### Phase 4: Effort SDK and UI consistency

Scope:

1. Public SDK effort union.
2. `get_settings.applied` parity.
3. ModelInfo schema/producer parity.
4. Configured → applied UI and SDK representation.
5. CLI help and stale effort descriptions/design material.

Exit criteria:

- Type fixtures compile for `none` and `ultra` in public options.
- Runtime-produced ModelInfo objects parse against the public schema.
- Applied effort matches request-construction resolution.
- Every accepted `/effort` value is discoverable in help.
- Status text displays configured → applied when values differ.
- Current OpenAI mapping remains unchanged and is described as current implementation behavior, not externally verified protocol.

完成后暂停，进行最终整体审查；任何 OpenAI wire mapping 变更必须另立任务。

## 7. Testing Decisions

### 7.1 General principles

- Test externally observable behavior at the highest practical seam.
- Use existing AgentTool, Workflow runtime, settings operation and SDK schema seams before introducing helpers.
- Add a minimal failing regression test before each bug fix.
- Do not weaken existing assertions or redefine failure as success.
- Where tests are currently top-level `assert` scripts, preserve local style for focused changes unless converting the test file is itself part of an approved test-infrastructure task.
- Distinguish source-confirmed behavior tests from external protocol conformance tests.

### 7.2 Agent lifecycle tests

Use the existing async lifecycle and foreground/background continuation harnesses.

Required cases:

- Agent completes, classifier rejects: stored state and emitted notification remain completed; warning retained.
- Agent completes, worktree cleanup rejects: same expected behavior.
- Completed notification enqueue fails before and after dedup state transition.
- Background Agent fails after producing usage: failed notification includes usage.
- Background Agent is killed after an in-place usage mutation: killed notification includes refreshed usage.
- Foreground-to-background Agent continues summary updates without duplicate summarizers.

### 7.3 Workflow accounting tests

Use the Workflow plan runner with a fake AgentTool progress producer.

Required cases:

- One assistant message with two tool uses contributes token once and tool count twice.
- Repeated callback with the same message UUID and unchanged usage is idempotent.
- Same message UUID with increased output usage applies only the delta.
- Different assistant response messages follow the explicitly chosen token metric.
- Script Workflow exposes live token/tool progress before completion.
- Completion does not silently change to an unrelated token definition.
- Plan and Script resume cache hits use the same documented usage semantics.

### 7.4 Effort tests

Use table-driven provider/model/input cases.

Required matrix:

- OpenAI: `none`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, `ultracode`.
- Anthropic Opus 4.6: values that resolve to `max` remain `max`.
- Anthropic non-max model: `xhigh`, `max`, `ultra`, `ultracode` clamp to `high`.
- Public SDK compile fixtures accept configured values exposed by runtime.
- `get_settings.applied` equals request builder's resolved effort.
- Runtime ModelInfo parses through the exported schema.
- `/effort` help and invalid-option output include all intended user-facing values.

External OpenAI conformance must be a separate optional test or documented runtime observation. It must not be inferred from internal unit tests.

### 7.5 Plugin tests

Use the core plugin operation seam, not only the ManagePlugins component mock.

Required cases:

- settings returns an error: operation returns failure;
- installation record remains;
- options, secrets and data cleanup are not called;
- CLI does not print success or exit zero through the success path;
- normal uninstall remains successful;
- project-enabled special path remains unchanged.

### 7.6 Task tests

Required cases:

- dependency missing before update produces no mutation;
- dependency disappears after precheck and result reports prior committed fields;
- delete unlink succeeds but cascade cleanup fails, producing an explicit partial result;
- second edge write fails and result identifies or repairs the one-sided relation;
- retry after partial owner assignment does not duplicate assignment notification.

## 8. Acceptance Criteria

The plan is complete when all of the following are true:

1. Relevant focused tests pass with `bun`; no `npm` commands are used.
2. Type checking passes.
3. `git diff --check` passes.
4. Changes affecting build, SDK output or CLI runtime pass the project-required build.
5. Interactive Agent/Workflow UI behavior is validated through scripted tmux sessions when the implementation reaches those phases.
6. Debug logs are retained for Agent routing/lifecycle validation and referenced as runtime evidence.
7. No completed Agent can emit a contradictory failed terminal notification.
8. Workflow live token does not depend on the number of activities in one assistant message.
9. Plugin uninstall cannot delete persistent state after settings write failure.
10. SDK public types, schemas and runtime producers agree on effort values.
11. Findings that predate the target range are not presented as regressions caused by the range.
12. OpenAI `max` versus `ultra` wire behavior remains explicitly marked unverified until authoritative evidence is recorded.

## 9. Risks and Mitigations

### Risk: Token metric compatibility

Changing `totalTokens` semantics may affect UI, telemetry and SDK consumers.

Mitigation:

- Inventory every consumer before changing the formula.
- Prefer additive naming or explicit aliases if compatibility is uncertain.
- Add parity tests across all output surfaces.

### Risk: Notification ordering regressions

Moving dedup state after enqueue could create duplicate notifications under retries.

Mitigation:

- Model notification delivery as an explicit small state machine.
- Test enqueue failure, retry and concurrent terminal paths.

### Risk: Workflow accounting over-correction

Treating all usage as cumulative snapshots could undercount request-level billing usage.

Mitigation:

- Deduplicate by message identity first.
- Decide separately whether cross-message aggregation means billing usage or context progress.

### Risk: Plugin cleanup ordering

Stopping cleanup after settings failure may leave an already broken installation in place.

Mitigation:

- Return a clear actionable error.
- Do not automatically delete more state in an attempt to repair it.

### Risk: Task transaction scope

Cross-file atomicity may be expensive and fragile.

Mitigation:

- Start with truthful partial-result reporting and deterministic lock ordering.
- Treat full transaction support as a separate design if still needed.

### Risk: External effort protocol uncertainty

Changing OpenAI mapping without evidence could break working endpoints.

Mitigation:

- Do not change mapping in the internal-consistency phase.
- Capture authoritative schema or local authorized runtime evidence first.

## 10. Out of Scope

- Broad refactoring of AgentTool, WorkflowTool or task storage architecture.
- Implementing a general filesystem transaction engine.
- Redefining provider billing or estimating monetary cost.
- Changing OpenAI `max`/`ultra` wire mapping without external evidence.
- Adding new effort levels beyond those already present.
- Redesigning the Plugin marketplace or installation format.
- Converting all self-executing assertion files to `bun:test` in the same change.
- Fixing unrelated pre-existing UI or documentation issues.
- Publishing issues, creating commits, PRs or releases as part of this design review.

## 11. Confirmed Review Decisions

2026-07-12 brainstorming 已确认以下决策：

1. **Token 契约**：选择最后一次完整 API response 的 context size，保持现有 `AgentToolResult.totalTokens` 设计；所有对外 token 指标统一到该语义。
2. **Agent 后处理**：采用 `completed + warnings`，不新增 `completed_with_warnings`；classifier/worktree cleanup 失败不能改变已完成终态。
3. **Plugin uninstall**：settings 写入失败立即返回失败，零破坏性清理，不做自动补偿或强制卸载。
4. **TaskUpdate**：采用明确 partial result；安全位置允许 best-effort rollback，但不实现完整跨文件事务。
5. **Effort UI**：采用 configured → applied；相同值简写为单值，normalized 仅用于视觉表现。
6. **OpenAI wire**：保持当前 `max → ultra`、`ultra → ultra`、`ultracode → xhigh` mapping；先修内部一致性，协议验证另立任务。
7. **交付拆分**：按四个领域阶段实施，每阶段完成后暂停供用户审查。
8. **实施纪律**：每项 bug 先增加最小失败测试，再做最小修复；不自动创建 commit。

## 12. Approved Next Step

设计决策已完成审查，但尚未授权实施代码。下一步在用户明确要求后执行：

1. 从 Phase 1 开始；
2. 先复核当前 HEAD 与目标基线的源码差异；
3. 添加最小失败测试；
4. 实施 Request safety and persistent state 范围内的最小修复；
5. 执行定向测试、类型检查及必要构建；
6. 暂停并提交 diff、测试结果、未验证项供用户审查；
7. 未经用户确认不进入下一阶段、不创建 commit。
