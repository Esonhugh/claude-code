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
- deep-research 必须证明固定 5 个 Search worker 各成功调用 WebSearch 恰好一次、15 个 Fetch worker 各调用 WebFetch 恰好一次，并逐项记录 WebFetch 成功或外部来源失败；HTTP 403、paywall 或站点阻断属于来源结果，不得伪造为成功，也不得仅因此把调度契约判失败；缺少 tool result、重复调用、重试、替换来源（包括仅 query 不同）或调用目标工具与必要 `ToolSearch` discovery 之外的工具仍失败；
- Agent 启动、路由或生命周期相关改动必须逐项尝试直接 Agent、Workflow/WorkflowTool 内 Agent、nested Agent、foreground/background continuation、task/notification；共享路径变化不能只验直接 Agent；
- 使用隔离的 dummy credential，或将安全的现有账户认证复制到 evidence/repo 外、权限为 `0700` 且门禁结束后清理的私有临时 HOME；不得打印、保存到 evidence 或改写共享凭据；
- 保存 startup、submitted、running、terminal pane 和必要 debug marker 等绝对证据路径；
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
