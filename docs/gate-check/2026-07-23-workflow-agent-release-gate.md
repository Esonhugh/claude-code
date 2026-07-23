# Workflow/Agent release gate — 2026-07-23

## 范围

- 仓库：`/Users/fakeadmin/Workspace/vsc/claude-code-source/claude-code-self`
- 基线 commit：`aac126ccac8c8547a2b30433baacdf2bd246f12f`
- 分支：`master`，跟踪 `origin/master`
- 发布状态：`[not ready]`
- `Makefile` 版本：`2.1.203`
- `package.json` 版本：`0.0.0-dev`
- 验证对象：当前未提交 Workflow/Agent 代码与测试（包括新增的 `src/tools/AgentTool/permissionMode.ts`）、`CHANGELOG.md`、`CLAUDE.md` 的简化设计约束、`docs/research/official-workflow-binary.md` 的 hard-cap 契约修正，以及本报告。
- 禁止操作：worktree、PR、tag、release；门禁阶段不得修改、创建、删除、格式化或提交文件。

## 变更契约

1. Agent terminal/API/structured-output 失败不会被记为 `completed`，logical Agent 与 physical attempt 的计数保持独立。
2. automatic/manual retry 使用连续 attempt identity，旧 attempt 的迟到结果不能覆盖当前结果。
3. declarative resume 只消费 `completed` cache entry；非完成 entry 不会遮蔽同 identity 的 completed entry。
4. explicit/default permission mode 在声明式 Workflow 按 phase 调度时的实际权限快照进入 worker context、resume identity 与 Agent metadata；显式 `plan` 不继承 bypass 可用状态，`dontAsk`、`plan`、`auto` 不会被 `bubble` 放宽，`acceptEdits` 不能提升为 `auto`，子 Agent 不得提升父会话权限。
5. Agent label 在整个 Workflow run 内唯一，重复 label 的 suffix 分配保持线性。
6. script Workflow 不存在固定的 run-level Agent launch hard cap；声明式 spec 的 `defaults.maxAgents` 规划校验保留；大规模 `parallel()`/`pipeline()` 通过 bounded concurrency 调度，避免在执行槽位前物化全部 Agent 状态。
7. `/deep-research`、`/code-review` 和 `/workflows` 必须通过本轮新构建 `built-claude` 的 scripted tmux 入口验证，不能用 parent-side Agent/Workflow 代替。

## 验证方法

四路门禁必须从包含本报告的同一工作区状态并行开始：

1. Feature tests：建立 assertion 矩阵，运行相关 `bun test`、focused TypeScript 检查和 1001-Agent probe。
2. Release checks：完整运行 `make release-check`，分别核对 version guard、TypeScript、ESLint、missing imports/assets audit 与 `git diff --check`。
3. Binary interaction：本轮运行 `make build`，使用独立 HOME/config 和 scripted tmux 驱动最新 `built-claude`；保留 pane、debug log、Task/Run ID、prompt 恢复和 Git 前后状态。
4. Release/docs audit：核对版本、变更范围、README、CHANGELOG、本报告、敏感信息与未提交产物。

任一路不是明确 `passed`，整体 verdict 即不是 `passed`。普通 CLI 无法稳定触发的故障路径只能由 focused test/受控 probe 覆盖或标记 `not covered`。

## 前序证据（不作为最终通过依据）

- 修复阶段 focused tests、`make release-check` 和 `make build` 曾通过。
- 修复阶段 binary：`/Users/fakeadmin/Workspace/vsc/claude-code-source/claude-code-self/built-claude`
  - version：`2.1.203`
  - SHA-256：`bf680e8a6565aff15b5db655bbc92e8c40a6b5267164f9f25740a4d42294549e`
  - mtime：`2026-07-22T22:38:35+0800`
- 前序 tmux evidence：`/tmp/tmux-cli-validation/20260722-223746-release-gate3-clean-98903`
  - session：`cc-gate3-binary-20260722-223746-clean`
  - target：`cc-gate3-binary-20260722-223746-clean:0.0`
  - 观察到 `/deep-research` 进入 `WorkflowTool`，`/workflows` 显示 `1/25 agents` running。
  - 该轮未取得两个 Workflow 的 terminal 与 prompt-restored 完整证据，且输入/按键调度造成干预，verdict 为 `not covered`，不能提升为 passed。

## 最终门禁结果

本轮从当前 runtime/test 基线执行了完整受影响测试、`make release-check`、`make build` 与 scripted tmux。自动化、release checks、direct Agent foreground→background、Workflow 内 Agent 调度、`/workflows` 页面和 `/code-review high` 均形成完整证据；`/deep-research` 入口与调度正常，但 bundled workflow 固定要求 WebSearch/WebFetch，与本次明确的 repository-only/no-web 输入冲突。拒绝外部 fetch 后该 Workflow 以 `6/25 agents`、`failed` 终止，因此 Binary interaction 和整体门禁不能标记为 `passed`。

`/code-review high` 完成 `21/21 agents` 并返回 5 项 finding。源码复核后均不采纳：其中两项与既定的 phase-level permission snapshot 和“effective mode 变化产生 cache miss”契约相反；其余三项分别把显式 Agent deny rules、workspace scope 和进程级 auto/plan 生命周期误判为 requested child mode 应改写的状态。未据此修改 runtime 代码。

| Gate | Required result | Verdict | Evidence |
|---|---|---|---|
| Feature tests | all selected assertions and commands pass | passed | `/tmp/cc-final-gate-final-pBPF94/01-feature-tests.log`：43 pass、0 fail，包含 1001-Agent probe |
| Release checks | every `make release-check` stage passes | passed | `/tmp/cc-final-gate-final-pBPF94/02-release-check.log` |
| Binary interaction | current binary dispatch/running/terminal/prompt/Git evidence complete | failed | direct Agent、inline Workflow、`/workflows`、`/code-review high` passed；`/deep-research` failed |
| Release/docs audit | versions, scope, docs and workspace artifacts consistent | passed | `2.1.203` / `0.0.0-dev` 一致；evidence 仅写入 `/tmp`；Git-visible 状态对照无额外变化 |
| Overall | all four gates passed in the same round | failed | 必需的 `/deep-research` binary interaction 未通过 |

## Assertions

| ID | Subject / predicate | Required evidence | Runtime | Verdict / evidence |
|---|---|---|---|---|
| A1 | failure/retry accounting is consistent | focused tests and source inspection | n/a | passed — `01-feature-tests.log` |
| A2 | resume cache only reuses completed entries | focused tests including stale-then-completed | n/a | passed — `01-feature-tests.log` |
| A3 | labels are run-unique and linear | cross-phase and 1000-label tests | n/a | passed — `01-feature-tests.log` |
| A4 | permission snapshot/propagation/resume is correct | AgentTool metadata and Workflow focused tests | n/a | passed — `01-feature-tests.log` |
| A5 | no fixed script runtime Agent cap remains and large fan-out is bounded | source search and 1001-Agent probe | n/a | passed — 1001 calls completed，active concurrency `<=16` |
| A6 | release checks pass | complete `make release-check` output | n/a | passed — `02-release-check.log` |
| A7 | binary slash commands and Workflows TUI behave correctly | same-run tmux panes/debug/IDs/terminal state | failed | failed — `/deep-research` 外部 fetch 被拒后 Workflow failed；其余交互 passed |
| A8 | validation has no unexpected Git-visible side effects | before/build/pre-CLI/after status comparison | done | passed — post-build 与 CLI 期间 status compare exit `0` |

## Binary interaction 证据

- Binary：`/Users/fakeadmin/Workspace/vsc/claude-code-source/claude-code-self/built-claude`
  - version：`2.1.203`
  - SHA-256：`de62b7895f2ae26e4d429bed20a2b08d33046b6af795c16d2e85c27d6d438c67`
  - size：`83165218`
  - mtime：`2026-07-23T17:06:57+0800`
- Direct Agent foreground→background：`passed`
  - session/target：`cc-gate3-fgbg-inherit-03:0.0`
  - Agent/Task ID：`a9f989e27510a7eee`
  - markers：`foreground_registered=1`、`foreground_to_background=1`、`background_terminal=1`
  - notification：1；terminal：`completed`；parent prompt restored
  - evidence：`/tmp/cc-final-gate-final-pBPF94/binary/fgbg-agent/20260723T174100-fgbg-inherit-03`
- Inline Workflow + `/workflows`：`passed`
  - session/target：`cc-gate3-workflow-inline-20260723T170957-77692-5592:0.0`
  - Task ID：`w6xp1s1ak`；Run ID：`wf_50311cf4-ff0`
  - Agent IDs：`a62b1c50c548ecdb2`、`aadec06b439fde1c4`
  - page/detail/terminal：`2/2 agents`、`done`、Agent terminal `Completed`；notification：1；parent prompt restored
  - evidence：`/tmp/cc-final-gate-final-pBPF94/binary/workflow-inline/20260723T170957-workflow-inline-77692-5592`
- `/code-review high`：`passed`（runtime）
  - session/target：`cc-gate3-code-review-20260723T174748-2509:0.0`
  - Task ID：`wbjolwtb3`；Run ID：`wf_f5dc3d1e-461`
  - Agent IDs：21 个，见 `driver-result.json`；terminal pane 显示 `21/21 agents`、`718.9k tok`、`done`
  - 同一 parent transcript 中恰有 1 个 `origin.kind=task-notification` 的 completed notification；parent prompt restored
  - 5 项 review finding 经源码复核均被 refute，未引入代码变更
  - evidence：`/tmp/cc-final-gate-final-pBPF94/binary/code-review/20260723T174748-code-review-2509`
- `/deep-research`：`failed`
  - session/target：`cc-gate3-deep-research-20260723T173739-96634:0.0`
  - Task ID：`w119u5vry`；Run ID：`wf_c7889e9b-cab`
  - 启动至少 6 个 Agent；初始 driver 在 600 秒超时时仍为 `running`
  - bundled workflow 忽略 no-web 约束并请求 DuckDuckGo WebFetch；拒绝 permission 后 terminal pane 显示 `6/25 agents`、`62.3k tok`、`failed`
  - evidence：`/tmp/cc-final-gate-final-pBPF94/binary/deep-research/20260723T173739-deep-research-96634`

## Git 状态对照

- build/CLI 前：`/tmp/cc-final-gate-final-pBPF94/03-git-status-pre-build.txt`
- build 后：`/tmp/cc-final-gate-final-pBPF94/05-git-status-post-build.txt`
- CLI 期间：`/tmp/cc-final-gate-final-pBPF94/06-git-status-during-cli.txt`
- post-build 与 CLI 期间 compare exit：`0`
- 构建与 binary interaction 未产生额外 Git-visible 变更；报告与 CHANGELOG 的最终结果更新属于预期文档变更。

## 已知限制

- retry、迟到 completion、非完成 cache 与 1001-Agent 边界主要依靠 deterministic tests/probe；普通 CLI smoke 不应伪造这些 fault paths。
- 网络数据源、模型响应和外部权限可能使 `/deep-research` runtime 失败；若证据不完整，Binary interaction 必须报告 `failed`、`running` 或 `not covered`，不能只凭入口和 running UI 判为通过。
- ignored 文件不由 `git status --short` 完整证明；binary Agent 还需记录隔离目录和明确 deny rules。

## 发布操作

- commit：尚未执行
- push：尚未执行
- PR/tag/release：未授权，不执行
