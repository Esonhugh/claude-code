# Fork skill background and saved permission scope (2026-10-07)

本批为默认后台 fork 技能、技能权限保存与恢复的一次功能提交。参考官方 2.1.292；ROOT 保留原有其他 Claude 的工作。生产改动前保存 RED，最终候选及 ROOT 均重新构建并执行实际终端入口。

## Implementation and reference

- Source-confirmed：官方交互 fork 技能默认后台执行；background false、非交互及禁用后台保持同步。注册前校验深度/重复任务并持久化 scope，初始技能不占普通 Agent 容量。
- Source-confirmed：marker 先于 scope 写入；scope 记录技能身份、attribution、effort 和冻结 command deny。恢复需要 live task 或 cold marker 的身份见证，重新解析当前 fork 技能并应用当前允许/禁止规则。
- 本地共享启动器用于 slash 与实际 SkillTool。沿用已有后台父子任务生命周期等待通知并自动续跑；恢复命名路由、effort 与递归身份。权限范围在技能正文展开前应用，read-file cache 使用独立快照。
- SkillTool UI 与模型回执区分启动和完成；debug 打印技能、agent ID、名称、depth、owner、权限保存回退及恢复拒绝。未新增生产 ForTesting helper。

- Official native: `/private/tmp/mods-fork-routing-20261007-2afwted_/official/official-claude-2.1.292`; SHA256 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`. Latest registry was checked this turn: [Anthropic npm package](https://registry.npmjs.org/@anthropic-ai/claude-code/latest).
- Extracted native modules (local only): `chunk-e58dgtfs` launch, `chunk-ep02th27` scope storage, `chunk-h53p3mjv` resume, `chunk-wnag64dq` permissions, `chunk-7z59fevc` slash, `chunk-m17pesyg` SkillTool and `chunk-c0j7686v` SkillTool UI. Public SDK declaration SHA256: `d850d83ecd9e5f92be6e1d98b54b228e68ce0cc32767391f6e20573a4870e024`. SDK declarations alone do not prove runtime parity.
- Configuration: [Anthropic skills](https://code.claude.com/docs/en/skills#run-skills-in-a-subagent), [Anthropic subagents](https://code.claude.com/docs/en/sub-agents). No extracted code, binaries or request logs were published.

## Final Bun / Make identities

| Check | Exit | Source SHA256 | Result |
|---|---:|---|---|
| candidate-final-tests4 | 0 | c9ae67286b44f0122f5204e7bbdc27411968f240c2cb40e52f2c6694baf90118 | 53 pass / 0 fail / 54 expect; 9 files |
| workspace-final-tests2 | 0 | 4100a1b32c3ff1f3d149caf63a7a590d828b2b387939a6c849df7002d0a2f92f | 53 pass / 0 fail / 54 expect; 9 files |
| candidate-build6 | 0 | c9ae67286b44f0122f5204e7bbdc27411968f240c2cb40e52f2c6694baf90118 | passed |
| workspace-build6 | 0 | 4100a1b32c3ff1f3d149caf63a7a590d828b2b387939a6c849df7002d0a2f92f | passed |
| candidate-final-check3 | 0 | c9ae67286b44f0122f5204e7bbdc27411968f240c2cb40e52f2c6694baf90118 | passed |
| workspace-final-check2 | 0 | 4100a1b32c3ff1f3d149caf63a7a590d828b2b387939a6c849df7002d0a2f92f | passed |

Exact commands, isolated environment, manifests and process ownership are in each `start.json`, `result.json` and `log.txt` under `/private/tmp/mods-fork-background-20261007-0vhau1sh`. Commands use `run.py SIDE test LABEL` with the nine related files; build is `make build CLAUDE_CODE_BUILD_DIR=...`; check is `make release-check`.

- candidate-build6: `/private/tmp/mods-fork-background-20261007-0vhau1sh/candidate-build6-output/built-claude`, 102067682 bytes, SHA256 `7318536528194c8de0001911934f8b17f6e0c74bf47873d941a77a9358d35472`.
- workspace-build6: `/private/tmp/mods-fork-background-20261007-0vhau1sh/workspace-build6-output/built-claude`, 101952098 bytes, SHA256 `62743538d2ea67519bdf8209b528ac0aff05552b681b84653fc4d77a2a1e8e40`.

## Real binary / tmux assertions

| Run | Entry | Stable identity | Requests | Verdict / evidence |
|---|---|---|---:|---|
| official-o5 | slash | a5c677133b06af0b4 | 20 | passed; /private/tmp/mods-fork-background-20261007-0vhau1sh/native-official-o5/evidence |
| official-o6 | skill | a2ed7cddc3a45a083 | 23 | passed; /private/tmp/mods-fork-background-20261007-0vhau1sh/native-official-o6/evidence |
| candidate-c6 | slash | a3958ab88ca99b539 | 22 | passed; /private/tmp/mods-fork-background-20261007-0vhau1sh/native-candidate-c6/evidence |
| candidate-c7 | skill | a8ac2e8ec9cb910b1 | 25 | passed; /private/tmp/mods-fork-background-20261007-0vhau1sh/native-candidate-c7/evidence |
| workspace-r3 | slash | ac9dc7df8a6274fe1 | 22 | passed; /private/tmp/mods-fork-background-20261007-0vhau1sh/native-workspace-r3/evidence |
| workspace-r4 | skill | a46a1d9c1ab50e93b | 25 | passed; /private/tmp/mods-fork-background-20261007-0vhau1sh/native-workspace-r4/evidence |
| official-a1 | adjacent | 5fa34ea6-80d4-4569-b377-10151b0b702a | 44 | passed; /private/tmp/mods-fork-background-20261007-0vhau1sh/native-official-a1/evidence |
| candidate-a2 | adjacent | 5df1f80a-b137-462c-a0c6-1bba67658ba5 | 42 | passed; /private/tmp/mods-fork-background-20261007-0vhau1sh/native-candidate-a2/evidence |
| workspace-a3 | adjacent | 644c7c70-f335-4db5-b796-59e0f9b0ba30 | 42 | passed; /private/tmp/mods-fork-background-20261007-0vhau1sh/native-workspace-a3/evidence |

Runtime-observed: all six fork runs passed early receipt, public named running/waiting state, max=1 ordinary control, actual self-recursion refusal, child settlement and automatic same-ID continuation, one parent/ordinary notification, three actual SendMessage refusals, persisted scope/witness, accounting and exit/cleanup. UI receipt is asserted for both slash and actual model-called SkillTool. Equivalent prompts, dimensions (160x40), models, flags and dummy/local auth are isolated per run; targets ran serially.

Runtime-observed: adjacent runs attempt per-plugin/global capacity, ordinary and nested Agent, plugin fork slash/SkillTool with background false, Ctrl+B without restarting the held stream, ordinary notification, same-ID SendMessage/model resume and Workflow. Non-Workflow assertions pass on both local binaries; local Workflow is not covered. Per-assertion records and raw observation paths are in `validation-summary.json` and each native `result.json`.

## RED and repairs retained

- candidate-red1：9 pass / 14 fail，复现解析、默认启动、权限范围、递归及损坏记录仍能恢复的缺口。
- candidate-green1/green2：task identity 字段误加到 foreground 注册，3 项失败；修正 async 注册后通过。candidate-check1：4 项实际 TypeScript 错误，保留日志并修正。
- candidate-ui-red1：后台 UI 仍显示 Done，1 pass / 1 fail；修正为官方 Running in the background。
- candidate-prepare-red：25 pass / 1 fail；正文展开的权限视图仍为父会话，修正为先准备技能权限。
- native-workspace-red1：沙箱不能监听本机端口，驱动未启动目标；经授权升级使用隔离本机 API。native-workspace-red2：真实当前构建缺少早期后台回执。
- native-candidate-c1：另一个 fork feature gate 差异，见限制。native-candidate-c2：驱动只接受 is_error，但 SendMessage 用 success:false 返回拒绝；请求与 pane 已证实产品拒绝正确。修正夹具接受实际逻辑失败格式，不弱化拒绝/不启动断言。

## Limits and remaining work

- 不能据此宣称完整 Mods/API/类型/上下文/UI/diff 已兼容 2.1.292；本批没有迁移所有官方模块。
- 当前本地真实工具目录缺少 Workflow/WorkflowTool。已尝试模型调用，Workflow 子流程为 not covered；官方相同场景成功。独立 WorkflowScriptRuntime 历史失败及 G5、同进程全量门禁未关闭。
- 初始 native-candidate-c1 用 run_in_background:false 的子 Agent：官方 fork feature gate 强制后台，本地该编译开关默认关闭，子任务仍同步。保留失败证据；最终探针两侧明确使用 true，验证后台子任务归属，未修改该门禁差异。
- 冷路径见证、当前命令解析与冻结/当前 deny 合并、部分写入等由隔离 Bun 回归覆盖；跨进程真实冷恢复、所有停止/故障/并发篡改与命名碰撞组合未完整终端覆盖。
- 本地尚无官方 storageV5、permissionLayers 与所有 host background capability/synced skill policy 结构；本批使用现有文件和权限机制，不把这些完整接口宣称为已对齐。
- 官方和本地的辅助标题/权限请求模型及数量不同，项目费用不同；各运行保存的 model usage 与项目总费用之和一致，并非两侧调用预算完全相等。

## Worktree and commit isolation

- Parent `aa2e3071c1549521bc9d4f9b204cf47d8e24f768`, branch `feat/mods`. Original 278 visible WIP rows and SHA/mtime baselines are in `baseline.json`; original overlapping files in `baseline-files`.
- Candidate clone stages only this feature. ROOT merge preserves its existing Mod hooks and unrelated edits; its pre-existing metadata name declaration is retained. ROOT index was empty before staging. Signed commit stages candidate blobs without staging other Claude edits.
- Protected old built-claude, fix-instructions.md, improvment.md, response.md and old assets keep bytes and mtime. No shared auth/config was copied, other Claude processes stopped, push or publish performed. Post-commit hashes/signature and staged artifacts are recorded beside the batch evidence.
