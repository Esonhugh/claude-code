---
name: release-validation
description: Use this skill automatically before declaring a release ready, or when the user asks for release validation, 发布验收, release-check, binary-side verification, README/CHANGELOG accuracy, or a final release gate. It launches four independent read-only Agents in parallel to validate feature tests, make release-check, current built-claude scripted tmux behavior, and release/docs consistency. If any finding requires a fix, fix it outside the validation Agents and rerun all four gates from the beginning.
version: 0.1.0
---

# Release Validation

为当前 Claude Code 工作区执行不可拆分的四路发布门禁。该流程用于发布结论，不以单个测试、单次构建或一次手工交互替代完整验收。

## 强制规则

1. 开始前读取 `CLAUDE.md`、`Makefile`、相关 diff、当前 Git 状态和待发布版本。
2. 使用一条消息并行启动四个独立 Agent；每个 Agent 必须明确写明 **只读验证，不得修改、创建、删除、格式化或提交文件**。
3. 四路职责不得互相替代：
   - Feature tests：确认 feature 契约和相关 `bun test` 通过，检查测试是否覆盖关键状态矩阵。
   - Release checks：运行并核对 `make release-check` 的全部阶段。
   - Binary interaction：本轮 `make build` 后，用脚本驱动 tmux 验证 `built-claude` 的真实用户可见行为。
   - Release/docs audit：检查版本、release 范围、README、CHANGELOG、Makefile 与实际代码和验证证据一致。
4. Agent 发现 bug、异常、文档不符、测试缺口或证据不足时，不得自行编辑。它只报告证据、复现命令、文件与行号。
5. 任一路不是明确 `passed`，整体 release gate 即不通过。
6. 需要修复时，由主会话阅读相关实现、先补最小失败测试、完成最小修复并运行相关验证。
7. **任何修复都会使此前四路结果失效。修复完成后必须从头重新并行运行全部四个 Agent，不能只重跑失败项。**
8. 重复上述循环，直到同一轮四个 Agent 全部通过且工作区状态符合预期。
9. 不自动 commit、push、tag、创建 PR 或发布，除非用户明确授权。
10. 不打印、复制或保存 token、API key、OAuth credential；交互测试使用 dummy credential 或安全的现有认证环境。

## 四个 Agent 的固定任务

### Agent 1 — Feature tests

只读检查并执行：

- 从 diff、实现和测试建立 user-visible feature assertions；
- 运行最小相关 `bun test`，必要时运行更广但仍相关的 suite；
- 检查主路径、认证/状态矩阵、错误路径和回归边界是否有断言；
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
- 使用 `.claude/skills/claude-agent-workflow-validation` 的 scripted tmux 证据边界；
- 运行当前 `built-claude`，不能使用旧产物或 parent-side 工具代替；
- 使用 dummy credential 覆盖 API credential 分支；需要 OAuth 分支时不得暴露凭据；
- 保存 startup、submitted、terminal pane 等绝对证据路径；
- 检查进程终态和 Git 前后状态；
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
Verdict: passed | failed | not-covered
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
- README/CHANGELOG/version 审计结果；
- 尚未覆盖的风险；
- 是否执行 commit/push/tag/release。
