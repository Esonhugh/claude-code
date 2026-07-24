# Workflow/Agent release gate — 2026-07-23

## 范围与变更契约

- 仓库：`/Users/fakeadmin/Workspace/vsc/claude-code-source/claude-code-self`
- 当前基线 commit：`ea2b35081597f6d951ec809e5dd80c26ace0c350`
- 分支：`master`，跟踪 `origin/master`
- 发布状态：`[not ready]`
- `Makefile` / `package.json`：`2.1.203` / `0.0.0-dev`
- 验证对象：当前工作区全部 Workflow/Agent、OpenAI WebSearch compatibility、bundled deep-research 和 release validation driver 变更。
- 禁止操作：worktree、PR、tag、release；门禁 Agent 只读，不修改源码、测试、文档或配置。

变更必须满足：

1. failure/retry accounting 分离 logical Agent 与 physical attempt；retry lineage 连续，stale completion 不覆盖新 attempt。
2. declarative resume 只复用 `completed` entry；Agent label 在 run 范围唯一。
3. permission mode 不提升父会话权限；foreground → background continuation 不重启 Agent stream。
4. script Workflow 无固定 run-level Agent lifetime cap，1001-Agent probe 全部执行且活跃并发 `<=16`。
5. OpenAI/ChatGPT server-side WebSearch 在 Responses request/stream 中正确映射。
6. bundled deep-research 固定执行 5 个 Search、15 个 Fetch、3 个 Verify 和 1 个 Synthesize logical workers；每个 fanout worker只执行自己的职责。
7. 本轮 `built-claude` 的 direct/nested Agent、foreground/background continuation、Workflow 内 Agent、`/workflows`、`/deep-research`、`/code-review high`、task/notification 和 prompt 恢复必须取得同次运行证据。

## 最终基线

- Round 7 baseline：`/tmp/cc-release-final-20260723/final-round-7-start-baseline.json`
- Baseline SHA-256：`7350379f310237b3d163d90706b36aa70270c0160863df226c8509f17c220b0b`
- HEAD：`ea2b35081597f6d951ec809e5dd80c26ace0c350`
- staged diff SHA-256：`f4f2a3e3858a8384daaaa3d4b841aaf55b2dcb10ab983d097960c34fb34e4a55`
- unstaged diff SHA-256：`767191554451cb691b2226c65d7fdb0a76dd761a55ec53f27edd2db401ce3431`
- Round 7 验证未改变 HEAD、index、tracked diff 或非 ignored untracked manifest。

## 同轮四路门禁

| Gate | Required result | Verdict | Evidence |
|---|---|---|---|
| Feature tests | A1–A9、相关 `bun test`、Python driver tests、TypeScript、1001-Agent probe 全部通过 | passed | `/tmp/cc-release-final-20260723/final-round-7/feature/` |
| Release checks | `make release-check` 每个阶段通过 | passed | `/tmp/cc-release-final-20260723/final-round-7/release-checks/` |
| Binary interaction | 本轮 `make build` 后 scripted tmux 全矩阵通过 | passed | `/tmp/cc-release-final-20260723/final-round-7/binary/` |
| Release/docs audit | version、scope、CHANGELOG、报告、敏感信息和工作区一致 | passed | `/tmp/cc-release-final-20260723/final-round-7/docs-audit/`；审计发现的唯一 blocking placeholder 已由本次最终证据刷新关闭 |
| Overall | 同轮四路的功能、release、binary 和文档要求全部满足 | passed | Round 7 evidence roots 如上 |

## Assertions

| ID | Subject / predicate | Required evidence | Runtime | Verdict / evidence |
|---|---|---|---|---|
| A1 | failure/retry accounting and stale completion guard | focused tests + source inspection | n/a | passed — `runWorkflow.test.ts`、`LocalWorkflowTask.test.ts` |
| A2 | completed-only resume cache and retry identity | focused tests | n/a | passed — completed-only/non-completed resume cases |
| A3 | run-wide unique labels with linear suffix allocation | focused tests | n/a | passed — duplicate-label and suffix-allocation cases |
| A4 | permission snapshot/non-escalation and continuation reuse | tests + binary direct/nested/continuation flows | done | passed — AgentTool tests and binary `agent-fg-bg`/`nested-agent` |
| A5 | no script lifetime cap; active concurrency bounded | 1001-Agent probe | done | passed — 1001 completed; maximum physical concurrency 8 (`<=16`) |
| A6 | OpenAI WebSearch request and stream mapping | focused tests + binary `/deep-research` Search evidence | done | passed — request/action/query/status/citation/non-streaming coverage and WebSearch `5/5` |
| A7 | deep-research 5 Search / 15 Fetch / 3 Verify / Synthesize terminates | transcript IDs + pane/debug + notification | done | passed — 25/25 workers, exact tool counts, one terminal notification |
| A8 | Workflow TUI and code-review terminal state/prompt restore | same-run tmux evidence | done | passed — inline Workflow and `/code-review high` terminal flows |
| A9 | no unexpected config, process, notification, or Git side effects | cleanup + Git baselines | done | passed — owned artifacts archived/removed, no residual tmux session, repository state unchanged |

## Feature tests

以下命令均 exit `0`：

```text
bun test src/tools/AgentTool/agentProgressPayload.test.ts src/tools/AgentTool/mcpAvailability.test.ts src/tools/AgentTool/foregroundProgressUpdate.test.ts src/tools/AgentTool/subagentDepth.test.ts src/tools/AgentTool/prompt.test.ts src/tools/AgentTool/builtInAgents.test.ts src/tools/AgentTool/agentTypeResolver.test.ts src/tools/AgentTool/asyncLifecycleOrdering.test.ts src/tools/AgentTool/foregroundBackgroundContinuation.test.ts src/tools/AgentTool/AgentTool.nesting.test.ts src/tools/AgentTool/agentLaunchParams.test.ts
bun test src/tools/WorkflowTool/runWorkflow.test.ts src/tools/WorkflowTool/workflowScriptRuntime.test.ts src/tools/WorkflowTool/bundled/index.test.ts src/tools/WorkflowTool/workflowResumeCache.test.ts src/tools/WorkflowTool/workflowEvents.test.ts src/tools/WorkflowTool/workflowOrchestrator.test.ts src/tools/WorkflowTool/workflowRuntimeGlobals.test.ts src/tools/WorkflowTool/WorkflowTool.test.ts src/tools/WorkflowTool/workflowCommand.test.ts src/tools/WorkflowTool/workflowSpec.test.ts
bun test src/tasks/LocalWorkflowTask/LocalWorkflowTask.test.ts src/tasks/LocalWorkflowTask/formatWorkflowStatus.test.ts
bun test src/services/api/openai-compat.test.ts
bun test src/tools/WorkflowTool/*.test.ts src/tools/WorkflowTool/compatibility/*.test.ts src/tools/WorkflowTool/bundled/index.test.ts
PYTHONDONTWRITEBYTECODE=1 python3 .claude/skills/release-validation/scripts/test-release-driver.py
bunx tsc --noEmit --pretty false
bun /tmp/cc-release-final-20260723/final-round-7/feature/probe-1001-logical-agent.ts
```

- AgentTool focused suite：`10 pass`, `0 fail`。
- WorkflowTool 全相关 suite：`33 pass`, `0 fail`；其余恢复源码 self-executing assertion suites 均正常退出。
- 1001 probe：`logicalAgentCount=1001`、`taskResultCount=1001`、`physicalCallCount=1001`、`maxPhysicalConcurrency=8`、task `completed`。
- 详细命令结果：`/tmp/cc-release-final-20260723/final-round-7/feature/command-results.json`。

## Release checks

一次完整执行：

```text
make release-check
```

exit `0`，并分别通过：

- `package.json` version guard；
- `bunx tsc --noEmit --pretty false`；
- `bun run lint`；
- `bun run audit:missing`，四类 missing count 均为 `0`；
- `git diff --check`。

前后 baseline 无 drift。完整输出：`/tmp/cc-release-final-20260723/final-round-7/release-checks/make-release-check.full-output.log`。

## Binary interaction

本轮执行：

```text
make build
python3 .claude/skills/release-validation/scripts/capture-release-baseline.py --repo /Users/fakeadmin/Workspace/vsc/claude-code-source/claude-code-self --output /tmp/cc-release-final-20260723/final-round-7/post-build-baseline.json
python3 .claude/skills/release-validation/scripts/run-binary-gate.py --repo /Users/fakeadmin/Workspace/vsc/claude-code-source/claude-code-self --baseline /tmp/cc-release-final-20260723/final-round-7/post-build-baseline.json --evidence-root /tmp/cc-release-final-20260723/final-round-7/binary
```

Binary metadata：

- path：`/Users/fakeadmin/Workspace/vsc/claude-code-source/claude-code-self/built-claude`
- version：`2.1.203 (Claude Code)`
- size：`83165218`
- mtime：`2026-07-24T19:23:34+0800`
- SHA-256：`92de658c9bf9b451d2c462c9f764fce9d0989ac11922993cd43f807569154fb7`
- final manifest：`/tmp/cc-release-final-20260723/final-round-7/binary/driver-final-manifest.json`
- manifest SHA-256：`5d13598cc5a9c49a54db916df15647fb4b986015ce828d3303922b3e9f6484af`

| Flow | tmux target | Binary-side IDs | Verdict |
|---|---|---|---|
| readiness | `cc-release-readiness-smoke-20260724T192422-5338-1:0.0` | readiness smoke | passed |
| foreground/background Agent | `cc-release-agent-fg-bg-20260724T192422-5338-2:0.0` | Agent `ae55b9e6ceb19074e` | passed |
| nested Agent | `cc-release-nested-agent-20260724T192422-5338-3:0.0` | Agents `a0f5bf8d6e66fa52b`, `a2436ea43d17a0101` | passed |
| inline Workflow + `/workflows` | `cc-release-inline-workflow-20260724T192422-5338-4:0.0` | Task `w5q841jac`; Run `wf_f0c0715c-cba`; 2 Agents | passed |
| `/deep-research` | `cc-release-deep-research-20260724T192422-5338-5:0.0` | Task `wlptb2oao`; Run `wf_3e49cf60-66d`; 25 Agents | passed |
| `/code-review high` | `cc-release-code-review-20260724T192422-5338-6:0.0` | Task `wz0sezjak`; Run `wf_ee25a3f2-de6`; 15 Agents | passed |

`/deep-research` exact matrix：

- Search：5 tool uses、5 successful results、0 retries/invalid/unexpected tools；
- Fetch：15 tool uses、11 successful results、4 accepted external source failures、0 retries/invalid/non-external failures/unexpected tools；
- Verify：`3/3`，无工具调用或 delegation；
- Synthesize：`1/1`，无工具调用或 delegation；
- 仅发送一次 terminal notification，父 prompt 恢复。

## Release/docs audit 与副作用

- `Makefile`、`package.json`、README release line 分别保持 `2.1.203`、`0.0.0-dev`、`2.1.203`。
- README 的 credential precedence、ChatGPT status、Codex Apps 和 Terminal Tool 描述与实现一致。
- staged/unstaged diff 和 file-list secret scan 未发现高置信度 token、API key 或 private key。
- 非 ignored untracked files 为 `0`；ignored 本地 evidence、workflow runs、binary 和私有本地配置均未进入 release diff。
- Docs Agent 在最终验证完成前仅因本报告仍为 `running` placeholder 返回 `failed`；该 finding 不涉及源码、版本或行为，已由本次最终证据刷新关闭。
- Workflow-owned task/run artifacts 已归档到 `/tmp/cc-release-final-20260723/final-round-7/binary/workflow-runs-artifacts` 并从项目运行目录清理。
- Driver 退出后无遗留 tmux server/session；通知计数符合预期；post-build CLI 前后 repository state 一致。
- 已知未覆盖风险：无。4 个 WebFetch external source failures 是真实外部来源不可用，已按 `claims=[]`、`sourceQuality=unreliable` 契约接受，不代表调度失败。

## 前序证据

Round 6 及更早证据不作为本轮通过依据。Round 6 的 Git index drift 已由 VS Code built-in Git 日志归因到两条外部逐文件 `git add`，不是 `built-claude`、release driver、build、release-check 或 FileHistory 的副作用。Round 7 baseline、feature、release-check、binary 和 docs evidence 未再出现该 drift。

## 发布操作

- Gate 本身未执行 commit 或 push；门禁完成后按用户已授权范围创建新的 `[not ready]` commit 并 push。
- PR/tag/release：不执行。
- 未使用 worktree。
- `/tmp/cc-release-final-20260723` 下的 pane、debug log 和其他原始 evidence 保留。
