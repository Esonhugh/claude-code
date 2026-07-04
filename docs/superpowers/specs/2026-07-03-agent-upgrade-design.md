# AgentTool 官方一致性升级设计

## 背景

`docs/agent-update-plan.md` 已对当前 `AgentTool` / Agent 调度逻辑与官方 v2.1.165 恢复 bundle 做过静态对比，列出 9 个可优化方向。用户进一步要求：升级逻辑应尽量与官方逻辑靠近或一致；如果官方当前版本已对整个 Agent lifecycle 做架构级重构，则不能只做局部 patch，必须先识别差异。

本设计给出 Agent 升级的 spec。它不直接实现代码，而是定义范围、官方一致性原则、lifecycle parity gate、组件边界、数据流、错误处理和测试要求。

## 目标

让当前 `AgentTool` / Agent 调度逻辑尽量靠近或一致于官方 Claude Code 行为。

默认覆盖 `docs/agent-update-plan.md` 的 9 项：

1. `subagent_type` normalized matching 与 ambiguous 提示。
2. 后台 agent `async_launched` 文案避免鼓励读取完整 JSONL。
3. agent 类型 miss 的错误信息改进。
4. required MCP server 检查合并当前 tool pool。
5. `runAgentParams` 补充上下文字段。
6. MCP blocked / unavailable notification。
7. 保留当前后台完成顺序：优先 complete task，再做慢操作。
8. sync agent progress payload 补充 `agentType` / `description`。
9. `cwd` 与 `isolation: "worktree"` 早期互斥校验。

同时新增 Agent lifecycle parity gate：如果官方当前版本已架构级重构 Agent lifecycle，先产出 lifecycle 对照矩阵，再决定局部升级还是扩大为 lifecycle 迁移。

## 非目标

- 不在没有对照证据时重写 `AgentTool`。
- 不为了内部结构 parity 回退当前已知更安全的本地行为。
- 不引入新外部依赖。
- 不改与 Agent lifecycle 无关的工具、UI 或任务系统。
- 不在 spec 阶段实现代码。
- 不做无关重构；只改服务于 Agent 官方一致性升级的边界。

## 官方一致性原则

采用“官方行为一致优先，本地安全差异保留”的策略。

优先对齐用户可见行为和工具契约：

- `Agent` tool schema 与参数约束。
- `subagent_type` 查找、容错、歧义、deny/unavailable 错误。
- `run_in_background` 返回内容。
- foreground / background task 状态变化。
- required MCP server 检查结果。
- `cwd` / `isolation: "worktree"` 互斥。
- progress payload 的 `agentId`、`agentType`、`description` 等字段。
- sync agent 与 async agent 的完成通知。
- output file / transcript 指引。
- failure path 的错误信息和副作用。

只有在当前实现有明确稳定性收益时，才允许 intentional divergence。每个 intentional divergence 必须在 spec、实现注释或测试名中说明原因，并用正反路径测试证明不会破坏用户可见行为。

## Agent lifecycle parity gate

实现前必须先检查最新可用官方 Claude Code 的 Agent lifecycle。如果官方当前实现只是内部整理，且外部行为可通过局部 patch 对齐，则继续执行本 spec 的局部升级。

如果官方当前 lifecycle 已架构级重构，则先产出 lifecycle parity matrix，再由用户确认是否扩大为 lifecycle 迁移。

对照矩阵至少覆盖：

| 维度 | 本地当前实现 | 官方当前实现 | 行为是否一致 | 结构是否一致 | 处理方式 |
| --- | --- | --- | --- | --- | --- |
| schema/input |  |  |  |  |  |
| agent type selection |  |  |  |  |  |
| permission/tools assembly |  |  |  |  |  |
| MCP required server |  |  |  |  |  |
| sync lifecycle |  |  |  |  |  |
| async lifecycle |  |  |  |  |  |
| foreground→background |  |  |  |  |  |
| task registry/completion |  |  |  |  |  |
| worktree/cwd cleanup |  |  |  |  |  |
| progress events |  |  |  |  |  |
| result mapping |  |  |  |  |  |
| classifier/cleanup order |  |  |  |  |  |

处理方式只能使用以下值：

- `local patch`：局部修正即可达到官方行为。
- `intentional divergence`：当前本地行为更安全，保留并补测试。
- `migration candidate`：局部补丁不足，建议升级为架构迁移。
- `out of scope`：与本次 Agent 升级无关。

如果出现 `migration candidate`，实现前必须暂停并让用户确认是否扩大范围。不能在同一实现计划中静默升级为大迁移。

## 组件设计

### Agent type resolver

新增或抽取小型 resolver，避免在 `AgentTool.call()` 中继续堆叠查找分支。

职责：

- 接收 requested `subagent_type`。
- 先 exact match。
- exact miss 后做 official-style normalized match：
  - `normalize("NFKC")`
  - `toLowerCase()`
  - 去除 whitespace、dash punctuation、underscore。
- 区分四类结果：
  - 唯一可用匹配：接受。
  - 多个匹配：报 ambiguous，并列出候选。
  - 匹配存在但被 deny/unavailable：报对应错误。
  - 完全不存在：报 available agents。
- 输出 selected agent 和 resolution metadata，供 telemetry、debug 或测试断言使用。

resolver 不能绕过现有 allowed/deny rule。normalized fallback 只提升容错性，不提升权限。

### Agent launch validation

在 agent selection 之后、创建 worktree 或启动 lifecycle 之前做早期校验：

- `cwd` 与 `isolation: "worktree"` 互斥。
- required MCP server 可用性。
- teammate / in-process / background 限制继续沿用现有规则。

早期校验的目标是避免进入半启动状态，尤其不能在 `cwd` + `worktree` 错误输入下创建无用 worktree 或注册 agent task。

### MCP availability checker

required MCP server 检查从只读 `currentAppState.mcp.tools` 扩展为合并：

- `currentAppState.mcp.tools`
- 当前 `toolUseContext.options.tools` 中实际可用的 MCP tools

checker 需要去重 server name，并避免把被权限过滤掉或未传给 agent 的 MCP tool 误判为可用。如果 app state 与 tool pool 冲突，以实际可传给 agent 的 tool pool 为优先证据。

### Agent run params enrichment

在 `runAgentParams` 中补充官方接近字段，但只在当前类型系统支持或可安全扩展时加入：

- `name`
- `toolUseId`
- `spawnedBySkill`
- `onMcpServersBlocked`
- fork path 相关 hydration 字段，如果当前架构已有对应概念

如果字段只是 telemetry attribution，不应改变行为。如果字段会影响 lifecycle，必须增加对应正反路径测试。

### MCP blocked notification

支持可选 `onMcpServersBlocked` 回调，用于在 agent 内部 MCP server blocked / unavailable 时向父上下文发送非致命通知。

要求：

- notification failure 不能影响 agent task completion。
- 文案应指出 agent 与 MCP server blocked/unavailable 的关系。
- 不泄露敏感配置或 token。
- 若当前 progress event 类型不支持 notification，先在类型层设计清楚，再实现。

### Progress payload enrichment

sync agent progress payload 增加：

- `agentType`
- `description`

用途是让 UI / SDK consumer 更准确展示子 Agent 类型与任务说明。字段补充应保持向后兼容，不删除现有 `prompt` / `agentId` 等字段。

### Async result text

后台 agent 启动返回文案改为官方更保守的方向：

- 告知 task id / output file。
- 明确不要主动 `Read` 或 `tail` transcript，除非确实需要。
- 如果用户问进度，应说明 agent 仍在运行，完成会通知。
- 避免鼓励读取完整 JSONL 造成上下文爆炸。

### Lifecycle ordering intentional divergence

保留当前“后台任务优先 complete，再执行 classifier / cleanup / notification”等慢操作的顺序。

这是 intentional divergence。理由：

- 防止 `TaskOutput(block=true)` 被 classifier 或 cleanup 卡住。
- 当前分析文档已指出该行为更稳。
- 用户可见行为是后台任务完成后应尽快可观察 completed 状态。

测试必须证明 classifier / cleanup 慢或失败不会阻塞 task completion。

## 数据流

### 正常 sync agent

1. Tool input 进入 `AgentTool.call()`。
2. 解析基础参数。
3. agent type resolver 选择 agent。
4. early validation：
   - team/teammate 限制；
   - `cwd` / `worktree` 互斥；
   - MCP required server 可用。
5. 组装 enriched `runAgentParams`。
6. 注册 foreground task。
7. 发送 enriched progress event。
8. agent 执行。
9. finalize result。
10. 返回 tool result。

### 正常 async agent

1. Tool input 进入 `AgentTool.call()`。
2. resolver + validation。
3. 组装 enriched `runAgentParams`。
4. 注册 async agent。
5. 启动 async lifecycle。
6. 立即返回 conservative `async_launched` result。
7. agent 完成后：
   - 先 complete async task；
   - 再执行 classifier / cleanup / notification；
   - 通知用户完成。

### 失败路径

- `cwd` + `worktree`：启动前失败，不创建 worktree，不注册 agent task。
- ambiguous `subagent_type`：启动前失败，列出候选。
- denied `subagent_type`：启动前失败，保留 deny rule 信息，不被 normalized fallback 绕过。
- unknown `subagent_type`：启动前失败，列出 available agents。
- missing MCP server：启动前失败或按官方行为给出 blocked/unavailable notification。
- async transcript 指引：不鼓励读取大文件。
- notification failure：不能影响 agent task completion。

## 错误处理要求

错误信息应可操作，但不能泄露敏感信息。

- ambiguous agent type：说明输入与多个候选 normalized 后匹配，列出候选 agent type。
- denied agent type：说明 agent type 不可用或被规则拒绝，信息粒度与现有 permission error 一致。
- missing MCP server：指出缺失 server name，不输出 token、URL credentials 或私有配置。
- `cwd` + `worktree`：明确说明二者互斥。
- notification failure：记录或忽略为非致命错误，不改变 agent task result。

## 测试策略

测试必须覆盖正反对照、成功路径、失败路径和功能全流程终态。

### Agent type resolver

正向：

- exact match 成功。
- normalized match 成功，例如 `code reviewer` → `code-reviewer`。
- Unicode / case / underscore / dash 差异可匹配。

反向：

- ambiguous normalized candidates 报错。
- denied candidate 不被绕过。
- unknown type 报 available agents。

全流程：

- 通过真实 `Agent` tool input 触发 resolver，而不是只测 helper。

### cwd/worktree validation

正向：

- 只传 `cwd` 正常。
- 只传 `isolation: "worktree"` 正常。

反向：

- 同时传 `cwd` 和 `isolation: "worktree"` 直接失败。
- 失败时不创建 worktree、不注册 agent task。

### MCP checker

正向：

- required server 在 app state 中存在。
- required server 只在 current tool pool 中存在。

反向：

- required server 缺失时报错。
- 被权限过滤的 MCP tool 不应误判可用。

全流程：

- agent definition 带 required MCP server，真实调用 AgentTool 通过或失败。

### Async result text

正向：

- background agent 返回 task id / output file。
- 完成后能收到 completion notification。

反向：

- 文案不包含鼓励 `Read` / `tail` 完整 transcript 的说明。
- 如果用户询问进度，指引不要求读取完整 JSONL。

全流程：

- 后台 agent 能完成，task 状态变为 completed，通知正常出现。

### Lifecycle completion ordering

正向：

- agent result 结束后 async task 先进入 completed。

反向：

- classifier / cleanup 慢或失败不阻塞 task completion。

全流程：

- `TaskOutput(block=true)` 或等价等待逻辑能在 agent 结果完成后返回。

### Progress payload

正向：

- sync agent initial progress 包含 `agentType` / `description`。
- 后续 progress 仍保留 `agentId`。

反向：

- 缺省 description 或默认 agent type 不应破坏旧 consumer。

### Interactive / parity 测试

涉及真实 binary-side behavior 时：

- 用 tmux 启动 `official-claude` 与 `built-claude`。
- 使用相同 terminal size、相同 prompt、相同 config。
- 输入等价 Agent tool 调用或 prompt。
- 捕获 pane output。
- 对比：
  - 错误信息；
  - async launched text；
  - task completion 行为；
  - progress/UI 表现。

交互式测试必须跑到功能完成信号，不能只截取中间状态。

## 实施前检查项

实现前必须完成：

1. 检查最新可用官方 Claude Code Agent lifecycle。
2. 判断是否触发 lifecycle parity gate。
3. 如果触发，产出 lifecycle parity matrix 并让用户确认范围。
4. 阅读当前 `AgentTool`、LocalAgentTask、runAgent、task registry、progress event 类型。
5. 明确哪些差异是 local patch，哪些是 intentional divergence。
6. 为每项实现列出正向、反向、全流程测试。

## 成功标准

本设计实施后应满足：

- Agent type 解析行为更接近官方，支持 normalized fallback 和 ambiguous/denied/unknown 区分。
- `cwd` + `worktree` 在启动前失败，无半启动副作用。
- required MCP server 检查更接近官方，不因 app state/tool pool 差异误判。
- async launched 文案不再鼓励读取完整 transcript。
- progress payload 提供 agent type 和 description。
- 后台完成顺序保持本地更安全行为，并有测试证明。
- 如果官方 lifecycle 已重构，实施前会先生成对照矩阵，不会静默做大迁移。
