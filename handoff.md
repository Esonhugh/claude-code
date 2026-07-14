# Claude Code reliability work handoff

## 当前状态

仓库：`/Users/fakeadmin/Workspace/vsc/claude-code-source/claude-code-self`

当前分支工作区干净。没有 push。本轮按功能边界完成了 4 个提交：

- `27090b9 fix: preserve async agent terminal state`
- `8932622 docs: add tmux CLI validation skill`
- `de56c0d test: add tmux validation skill evals`
- `a8961db docs: update changelog for July 13 changes`

总体计划和阶段定义见：

- `docs/design/agent-workflow-effort-reliability-plan.md`
- 最新变更摘要见 `CHANGELOG.md` 的 `2026-07-13` 条目。

不要在新会话中重复计划正文；以这些文档和提交 diff 为准。

## 阶段判断

当前是 **Phase 2 实现完成、Phase 2 binary-side 验收待执行**，尚未正式进入 Phase 3。

- Phase 0：回归 fixture/契约基础基本完成。
- Phase 1：已完成，对应 `4419da4`。
- Phase 2：代码和 focused tests 已完成，对应 `27090b9`。
- Phase 2 门禁仍缺少脚本驱动 tmux + 最新 `built-claude` + debug log 的真实交互证据。
- Phase 3、Phase 4 尚待实施，范围以计划文档第 6 节为准。

## 本轮已验证

已执行并通过：

- `bun test src/tools/AgentTool/asyncLifecycleOrdering.test.ts src/tools/AgentTool/foregroundBackgroundContinuation.test.ts`
- `bun run lint`
- `git diff --cached --check`
- `make build`

构建产物为仓库根目录 `./built-claude`。focused test 文件是 top-level assert 风格，Bun 汇总显示 `0 pass / 0 fail`，但两个脚本各自输出 `... passed` 并以成功状态退出。

曾尝试启动 `plugin-dev:skill-reviewer` 审查新 skill，但因 Agent concurrency limit 未执行；之后做了人工检查。不要把该 reviewer 记为已通过。

## 下一步建议

### 1. 先完成 Phase 2 验收门禁

必须依据以下 project skill 执行：

- `.claude/skills/tmux-cli-workflow-validation/SKILL.md`
- eval 示例：`.claude/skills/tmux-cli-workflow-validation/evals/evals.json`

关键要求：

- 使用当前源码重新运行 `make build`，不可用旧 binary 冒充本轮构建。
- 使用脚本驱动 tmux 中的 `built-claude --dangerously-skip-permissions --debug --debug-file ...`。
- parent assistant 的 Agent/Workflow/Skill 调用不能作为 binary-side 证据。
- 保存 ready/submitted/running/terminal pane、exact input、driver stdout/stderr 和 debug log。
- 不删除 debug log；用户长期要求 Agent 路由/交互调试必须以 debug log 作为流程证据。
- 不使用 worktree。

优先验证：

1. foreground → background continuation 不重启 stream；
2. summarizer 不重复启动，terminal 仅停止一次；
3. completed 后 post-processing failure 不反转为 failed；
4. failed/killed notification usage；
5. notification 状态和用户可见终态一致。

普通交互难以稳定触发的 classifier/worktree fault path，应明确标注为自动化测试覆盖或 `not covered`，不要伪造交互证据。

### 2. 验收通过后请用户决定是否进入 Phase 3

Phase 3 的范围和 exit criteria 见：

- `docs/design/agent-workflow-effort-reliability-plan.md` 的 `Phase 3: Token and Workflow accounting`

不要假设 `6c2f287` 已覆盖整个 Phase 3。仍需重点检查 Workflow assistant message usage 去重、tool-use ID 计数、Script Workflow live metrics，以及 Plan/Script 完成态和运行态 token contract。

### 3. Phase 4 后续

Phase 4 聚焦 Effort SDK/UI 一致性，见计划文档。已有 provider routing 提交不等于 Phase 4 完成。不要在没有外部协议证据时修改 OpenAI wire mapping。

## 提交与仓库约束

- 默认中文、结论优先。
- 包管理和脚本只用 `bun`，不可用 `npm`。
- bug 修复先最小失败测试，再最小实现。
- 涉及 CLI/runtime/build 必须按 `Makefile` 验证。
- 交互验证必须脚本驱动 tmux。
- 不使用 worktree。
- 未经用户明确批准不要 push、创建 PR、tag 或发布。
- 用户本轮已明确授权“分批提交对应代码”；已完成的提交不要 amend。
- 若继续新增修改，完成后记得同步 `CHANGELOG.md`，但不要虚构版本号或测试结果。

## Suggested skills

新会话建议按任务调用：

1. `tmux-cli-workflow-validation`：Phase 2 binary-side 验收的首要 skill。
2. `claude-debug`：读取和解释 `built-claude` debug log，保留证据并处理脱敏边界。
3. `interactive-terminal`：仅当需要持续管理交互终端会话时使用；正式验收仍须遵循 tmux skill 的脚本证据要求。
4. `mattpocock-skills:tdd`：进入 Phase 3/4 实现时用于最小失败测试优先流程。
5. `simplify`：仅在代码修改完成后做范围内复用/质量检查，不要借机扩展重构。

## 敏感信息

本文未包含 token、API key、cookie 或凭证。后续 pane/debug 日志如含用户输入、路径或服务响应，应在报告中脱敏，但保留原始本地证据文件，不自行删除。
