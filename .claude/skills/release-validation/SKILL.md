---
name: release-validation
description: Validates release readiness with related bun tests, make release-check, current-binary scripted tmux interactions, and release/docs consistency. Use before declaring a release ready or for release validation, 发布验收, release-check, binary-side verification, README/CHANGELOG accuracy, or a final release gate.
version: 0.1.0
---

# Release Validation

为当前 Claude Code 工作区执行不可拆分的四路发布门禁。该流程用于发布结论，不以单个测试、单次构建或一次手工交互替代完整验收。

## 强制规则

1. 开始前读取 `CLAUDE.md`、`Makefile`、相关 diff，并运行 `scripts/capture-release-baseline.py` 动态记录当前 `HEAD`、分支、Git 状态、版本和 binary 信息。Agent brief 只能引用本轮 baseline 文件，禁止手写或沿用上一轮 commit/hash。
2. Binary interaction 必须使用 `scripts/run-binary-gate.py`。该脚本先执行独立 readiness smoke，只有 smoke 通过才串行启动完整交互矩阵；readiness 失败时停止，不得继续 fan-out 或把 driver/fixture 错误归因于产品 runtime。
3. 使用一条消息并行启动四个独立 Agent；每个 Agent 必须明确写明 **只读验证，不得修改源码、测试、文档、配置、版本或提交**。允许验证命令生成必要的 binary、日志、tmux evidence 和临时 config root，但必须报告路径与 Git side effects。
4. 四路职责不得互相替代：
   - Feature tests：确认 feature 契约和相关 `bun test` 通过，检查测试是否覆盖关键状态矩阵。
   - Release checks：运行并核对 `make release-check` 的全部阶段。
   - Binary interaction：本轮 `make build` 后，用脚本驱动 tmux 验证 `built-claude`；交互场景必须覆盖本次改动、直接受影响的 runtime 入口和相邻组件，通用启动 smoke test 不算 feature 交互验收。
   - Release/docs audit：检查版本、release 范围、README、CHANGELOG、Makefile 与实际代码和验证证据一致。
5. **Feature 验收是不可拆分的组合门禁：无论改动是否直接用户可见，相关 `bun test` 和本轮 `built-claude` 中所有受影响交互流程的 scripted tmux 验收必须同时 `passed`。内部改动必须通过其真实调用入口触发，并检查相邻组件和副作用；任一失败、仍在运行或证据不足，feature 均不得判定为通过。单测与交互证据不能互相替代。**
6. Agent 发现 bug、异常、文档不符、测试缺口或证据不足时，不得自行编辑。它只报告证据、复现命令、文件与行号。
7. 任一路不是明确 `passed`，整体 release gate 即不通过。
8. 需要修复时，由主会话阅读相关实现、先补最小失败测试、完成最小修复并运行相关验证。
9. **任何修复都会使此前四路结果失效。修复完成后必须从头重新并行运行全部四个 Agent，不能只重跑失败项。**
10. 重复上述循环，直到同一轮四个 Agent 全部通过且工作区状态符合预期。
11. 不自动 commit、push、tag、创建 PR 或发布，除非用户明确授权。
12. 不打印凭据，也不把 token、API key 或 OAuth credential 保存到 evidence/repo；交互测试使用 dummy credential，或仅复制到 evidence/repo 外、权限受限且门禁结束后清理的私有临时 HOME。
13. Binary driver 必须按 committed release range + staged/unstaged/untracked 合并路径计算 required targets。release range 优先使用 baseline 中可用 upstream/merge-base；若无法安全推导，必须 fail closed 或要求显式 `--base-ref`。`--targets` 只能在默认完整矩阵之后追加额外 target，不得缩减默认矩阵，且必须拒绝空值与重复。修改 team registry、workflow retry/failure、coordinator selection 或 transcript retention 时，分别强制 `team-concurrency`、`workflow-retry-partial-failure`、`workflow-failure-detail`、`coordinator-selector`、`transcript-retention`；required target 未执行、无 assertions、缺稳定 ID/marker/evidence path、跨 run 拼接或仅有 pane 文本时必须 fail closed。
14. Skill prose、eval assertions 和 executable target 是三层独立覆盖。报告必须区分 `spec exists`、`unit covered`、`fault injection covered`、`binary tmux covered`；任何一层存在不自动代表其他层通过。

## Diff 到 executable target 映射

| 变更区域 | Required target | Binary-side 必要证据 |
|---|---|---|
| `src/utils/swarm/`、`spawnMultiAgent` | `team-concurrency` | 同次运行至少 3 个并发 teammate 的 team config/task/inbox/UI 一致性，以及 `team_mutation_*` debug marker |
| `WorkflowTool`、`LocalWorkflowTask` retry | `workflow-retry-partial-failure` | 受控 transient fault、logical worker/attempt ID、仅失败项重试和 `workflow_worker_*` marker |
| workflow failure/status | `workflow-failure-detail` | terminal pane、Task/Run ID、status/detail 原始根因和同次运行 failure marker |
| coordinator/PromptInput/background task | `coordinator-selector` | 键盘选择前后 stable target ID、pane 与 `coordinator_selection_changed` marker |
| viewed agent/in-process transcript | `transcript-retention` | terminal 前后切出/切回 pane、task ID 与 `transcript_retention_decision` marker |
| 交互式 CLI 入口、PromptInput/keybinding ownership、fullscreen/dialog/pane、ScrollBox、stdin parser、Ink frame/damage、ANSI output、terminal resize | `terminal-interaction` | 根据实际改动生成场景矩阵；使用本轮真实产物、原始输入 bytes、语义状态、逐帧 logical/physical output、ownership、resize/open-close/reopen 和副作用证据 |

普通成功路径不能代替受控 fault injection。上表前五个专项 target 已有 scripted binary-side handler：`workflow-retry-partial-failure` 仅在隔离 gate 中注入精确匹配 logical worker/attempt 的 transient fault，`transcript-retention` 使用 in-process teammate terminal lifecycle assertions。`terminal-interaction` 不是固定某个功能的脚本：driver 必须从本轮 diff、调用链和用户可见契约生成可执行场景与 assertions；若没有对应 executable scenario、场景无 assertions，或只有最终 pane 文本，则 verdict 必须为 `not covered` 或 `failed`。任一 handler 缺少同次运行的 pane、debug marker、稳定 ID 或 lifecycle 证据时必须 fail closed；任何 required target 未实际执行并通过时，整体 release gate 不通过。

## 真实交互与逐帧验收方法

当改动触及任何交互式 CLI 功能、输入 ownership、异步状态发布、布局、滚动、terminal rendering 或 resize 时，`terminal-interaction` 是强制 required target。它是一套通用确认方法，不绑定 `/diff` 或任何单一功能。每轮先从实际变更提取“入口—输入—状态—呈现—副作用”契约，再据此生成场景矩阵；只有以下各项在同一次修复后的验证轮次全部通过，该功能才能判定为 `passed`。

1. **从变更推导契约和矩阵**
   - 从 committed release range、staged/unstaged/untracked diff、调用链和用户报告列出受影响的真实入口、状态转换、输出区域、相邻组件和持久化/进程副作用。
   - 为每项契约定义可观察的前置状态、真实输入、预期状态、稳定 identity/marker、输出不变量和清理条件；不得先写一个固定 smoke 再声称覆盖所有功能。
   - 场景至少覆盖正常路径、边界、错误/取消、重复操作、并发或异步 publish，以及受影响的 presentation/mode；具体按键、尺寸、filter 和 fixture 由目标功能决定。例如 `/diff` 可覆盖连续文件切换、filter、body identity 和 sidebar ownership，但这些只是该目标的实例。

2. **真实产物、真实入口和隔离**
   - 必须先运行本轮 `make build`，再使用该轮新生成的 `./built-claude`；记录 binary 路径、SHA-256、mtime、版本和对应 baseline，并在启动后再次核对。
   - 在全新隔离的临时 fixture、`HOME`、`CLAUDE_CONFIG_DIR`、PTY/tmux session 和 socket 中启动；使用 dummy credential 或受控私有副本，不得读取或改写共享凭据和配置。
   - 必须从用户实际可达的 CLI 入口触发目标代码，并记录决定入口归属的 plugin、feature flag、terminal mode 和 settings。组件 mount、mock host、旧 binary、parent-side 同名工具或普通启动 smoke 不能替代。

3. **真实输入、批处理和 ownership**
   - 保存发送到 PTY 的原始 bytes，既覆盖单个事件，也覆盖同一个 stdin write/chunk 内的连续按键、鼠标或 paste；不能通过逐键等待掩盖 parser、batching 或旧 closure 问题。
   - 对有状态导航，输入累计结果、控制器状态、选中/聚焦 identity、内容 identity 和 scroll/focus anchor 必须一致；不能只断言其中一个状态字段。
   - 当 overlay、pane、dialog、autocomplete 或 composer 竞争输入时，普通字符、navigation、Tab、Enter、Escape、PageUp/PageDown、wheel 和 bracketed paste 必须各有唯一 owner。ownership 转移前后验证 draft、cursor、selection、undo/history、autocomplete、transcript scroll 和 submit 均无丢失或双重消费。

4. **异步状态与生命周期矩阵**
   - 在 loading、partial publish、success、failure、cancel、close/reopen、mode/source/filter 切换及 resize 等受影响状态之间穿插真实输入，检查旧请求 fencing、选中 identity、focus、scroll 和显示内容。
   - fixture 必须使用明显不同的稳定 ID 和内容 marker，规模足以触发预算、截断、滚动、并发和边界条件，才能识别旧内容、残尾、错位或错误归属。
   - 成功同步只能依赖可观察状态、request/revision/frame/write ID、PTY read 或有界 deadline；固定 sleep 只能作为失败超时，不能作为成功屏障。

5. **逐帧 logical/physical 正确性**
   - 不得只检查等待后的最终 `tmux capture-pane`。必须保存并检查每个完整 terminal output transaction，至少包含 stdout 原始 bytes、对应 commit/revision 或独立语义状态、logical frame、physical terminal cell grid、cursor、viewport/buffer 和 terminal size。
   - 为当前场景声明区域、identity、ownership 和生命周期不变量；每一帧都必须无越界、stale cell、残尾、重复文本、错行、半个宽字符、旧 identity 或不可能的中间组合。
   - logical frame 必须与独立 xterm/PTY replay 后的 physical cell grid 逐 cell 一致。最终截图正确不能掩盖中间坏帧；若只有 pane 文本、trim 后 preview 或未经独立 replay 的产品侧状态，则 `frame/physical covered` 必须标为否。

6. **首个分歧、失败测试与修复纪律**
   - bug 修复前必须保存首次真实错误序列，并把它收敛为稳定的最小失败测试；测试应断言跨层 identity/ownership/physical 不变量，而不只是最终状态。
   - 按 input parse/ownership → controller state → async fencing → React commit → layout/logical frame → ANSI/damage → physical terminal 的顺序寻找首个分歧，只修有证据的根因。
   - 不得用增加 sleep、全局 force redraw、每键 `flushSync`、关闭增量渲染、吞输入、扩大预算或放宽断言掩盖问题。
   - 修复后运行新增回归、所有直接与相邻组件测试、`git diff --check` 和 `make build`，再对新 binary 重跑完全相同的错误序列及完整状态矩阵。任何修复都使旧 binary 和旧门禁结果失效。

7. **证据、清理与 verdict**
   - evidence 必须包含 exact command/env（脱敏）、binary identity、session/window/pane/PTY ID、terminal dimensions、每个 input chunk 的 hex、状态/revision/frame/write 映射、逐步 pane/cursor、原始 ANSI 或无损 replay artifact、首次失败或全部断言结果。
   - 比较 fixture、配置、Git 状态和进程清单的前后状态；清理本轮可精确归属的进程、socket 和临时状态，不得覆盖基线已有或来源不明的变化。
   - 报告分别标明 `spec exists`、`unit covered`、`fault injection covered`、`frame/physical covered`、`binary interaction covered`。任一必需层缺失、失败、仍在运行、跨 run 拼接或使用修复前产物，目标和整体 release gate 均不得判定为通过。

## 四个 Agent 的固定任务

### Agent 1 — Feature tests

只读检查并执行：

- 从 diff、实现和测试建立 feature assertions，包括内部契约、共享 runtime 路径和用户可见行为；
- 运行最小相关 `bun test`，必要时运行更广但仍相关的 suite；命令中的每个路径必须先由当前测试文件列表或现有脚本确认可匹配，禁止把“没有匹配测试文件”的目录当作 feature failure；无独立测试文件的实现由实际覆盖它的相邻测试和真实 binary 入口验收；
- 检查主路径、认证/状态矩阵、错误路径、相邻组件和回归边界是否有断言；
- 报告 exact command、pass/fail 数量、遗漏覆盖和文件行号；
- 不得修改测试或代码。

### Agent 2 — Release checks

只读执行并核对：

```bash
make release-check
```

必须分别确认 version guard、TypeScript、ESLint、missing imports/assets audit 和 `git diff --check`。不能只报告最终 exit code；不得修改文件。

### Agent 3 — Binary-side interaction

只读验收：

- 读取 `Makefile` 并在本轮运行 `make build`；
- build 完成后再次运行 `scripts/capture-release-baseline.py`，然后以前台、阻塞方式调用 `scripts/run-binary-gate.py --repo <repo> --baseline <baseline-json> --evidence-root <unique-/tmp-path>`；执行上下文必须覆盖 driver 默认完整串行矩阵及其 cleanup 的最大总耗时，禁止设置可能早于 `driver-final-manifest.json` 生成的外层 Agent/Bash timeout，也禁止用后台 shell或 Agent 返回后会被回收的子进程启动；Agent 只有在 driver 已退出并生成 `driver-final-manifest.json` 后才能返回；driver 必须核对 baseline 的 HEAD 与 binary metadata，不得临时重写另一套 driver；
- 使用 `.claude/skills/claude-agent-workflow-validation` 的 scripted tmux 证据边界；
- 运行当前 `built-claude`，不能使用旧产物或 parent-side 工具代替；
- 从 diff 和调用链列出受影响的真实入口、相邻组件与副作用，并逐项执行对应交互流程；内部实现不得以“用户不可见”为由跳过；
- deep-research 必须证明固定 5 个 Search worker 各成功调用 WebSearch 恰好一次；select-sources 输出的每个实际 URL 必须由对应 Fetch worker 调用 WebFetch 恰好一次，合法 source shortfall 对应的剩余 Fetch worker 必须返回 `url: null`、`missingReason: "source list shortfall"` 且不调用工具；逐项记录 WebFetch 成功或外部来源失败。HTTP 403、paywall 或站点阻断属于来源结果，不得伪造为成功，也不得仅因此把调度契约判失败；缺少 tool result、重复调用、重试、替换来源（包括仅 query 不同）或调用目标工具与必要 `ToolSearch` discovery 之外的工具仍失败；
- Agent 启动、路由或生命周期相关改动必须逐项尝试直接 Agent、Workflow/WorkflowTool 内 Agent、nested Agent、foreground/background continuation、task/notification；共享路径变化不能只验直接 Agent；
- 使用隔离的 dummy credential，或将安全的现有账户认证复制到 evidence/repo 外、权限为 `0700` 且门禁结束后清理的私有临时 HOME；不得打印、保存到 evidence 或改写共享凭据；
- 保存 startup、submitted、running、terminal pane 和必要 debug marker 等绝对证据路径；
- 若 required targets 包含 `terminal-interaction`，严格执行“真实交互与逐帧验收方法”：从本轮变更生成并执行 feature-specific 场景与 assertions，报告 binary identity、真实入口证明、input chunk hex、状态/frame/write 映射、逐帧 logical/physical verdict 和首次错误证据，不能只附最终 pane snapshot；
- 将本轮 binary 产生且可由 Task/Run ID 精确归属的 `.claude/workflow-runs` 复制到 evidence 后清理；基线已有、无法归属、被修改或被删除的路径必须使门禁失败且不得清理；
- 检查进程终态、重复启动/通知、遗留 task/process、配置与 Git 前后状态等副作用；
- 不得修改代码或文档。

### Agent 4 — Release and docs audit

只读检查：

- `Makefile VERSION`、README release line、CHANGELOG version 与预期一致；
- `package.json` 保持项目规定的开发版本；
- README/CHANGELOG 对 credential precedence、状态矩阵、Usage、Codex Apps、Terminal Tool 和实际行为描述准确；
- release 条目覆盖目标提交且没有夸大测试或交互证据；
- 检查未提交文件、敏感信息和不应进入 release 的产物；
- 不得修改文件。

## Agent 输出契约

每个 Agent 返回：

```markdown
Verdict: passed | failed | running | not covered
Commands:
- ...
Evidence:
- ...
Findings:
1. [severity] file:line — observation, expected behavior, reproduction
Coverage gaps:
- ...
Git side effects:
- none | ...
```

无 findings 也必须明确写 `Findings: none`。命令失败、证据不完整或未覆盖关键契约时不能标 `passed`。

## 主会话循环

1. 收集同一轮四个报告。
2. 交叉检查报告是否来自当前 commit/worktree 和本轮新 binary。
3. 如有 finding：
   - 汇总根因，不把症状当修复；
   - 主会话完成最小修复；
   - 运行相关 focused test；
   - 标记本轮全部结果过期；
   - 启动下一轮四 Agent 全量门禁。
4. 只有同一轮四个 verdict 都为 `passed`，才可报告 release validation passed。

## 最终报告

列出：

- validated commit 与 Git 状态；
- 四路 verdict；
- exact commands；
- focused tests、`make release-check`、`make build` 结果；
- tmux session/证据绝对路径；
- 受影响交互流程矩阵及逐项 verdict；
- 重复启动/通知、遗留 task/process、错误状态、配置和 Git 副作用检查；
- README/CHANGELOG/version 审计结果；
- 尚未覆盖的风险；
- 是否执行 commit/push/tag/release。
