# 同步 fork 技能的计数与身份：2026-10-07

基线 HEAD：72883d0716d69d7b96861cb8b29845572d03252c。独立候选不包含 ROOT 的另 278 个 WIP。证据根：/private/tmp/mods-fork-cap-20261007-wz6lfhb6。

## 契约与官方依据

本批只修改同步 context: fork 的 slash 入口：技能 worker 不预留普通 Agent 名额，内部真实 Agent 调用仍执行全局限制；进度、执行和开始/完成 debug 使用同一 agent ID。SkillTool 的同步入口作为相邻消费者验证，其生产代码没有修改。KAIROS 的既有后台分支保留。

- 2026-10-07 读取 [Anthropic npm latest](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)，目标仍为 2.1.291。官方原二进制 SHA256：9a1d2ed6bb4421e8fc80c892c0413f293be3ee50ae3d7dda1a7622197a056690；提取材料只保留在本地。
- Source-confirmed：chunk-y68pt6m4.js 的 kt 技能执行路径向 pk 显式传入同一 agentId，同步路径不调用 takeConcurrencySlot；finally 移除临时 worker 并清理进度。chunk-g0cas2t1.js 的 Gan 默认选择后台，background:false 选择同步；zan 的后台技能任务路径也没有普通 Agent 计数预留。
- Source-confirmed：上一批引用的 chunk-cw79d6zb.js 是缓存共享 fork worker，传递 forkContextMessages/useExactTools 并预留名额。它不是 context: fork 技能入口；不能把不同 producer 的计数规则混为一谈。文件 SHA、精确偏移和有界片段保存于 official-source.json。
- 本地移除同步技能自己的预留/释放，将原有进度 agentId 传入 runAgent.override，并在启动日志中打印。没有改作者 API、共享 Agent guard、resume 或后台生命周期。
- 技能配置参考 [Anthropic 官方文档](https://code.claude.com/docs/en/skills#run-skills-in-a-subagent)。文档不替代版本化源码或实际 CLI 证据。

## RED 与诊断

- candidate-red3-test：旧 HEAD 的 3 个新断言均失败。成功/异常时观察到技能把已有计数 1 改成 2；独立身份断言观察到执行器未取得进度 ID。0 pass / 3 fail，无跳过。
- 本轮先从 ROOT 运行 Make 构建 workspace-red-build，再运行 native-workspace-red1。B 持有一个名额、全局上限 2 时，slash fork 的 leaf 被真实 Agent tool 拒绝，leaf API 为零；脚本在 fork-leaf-accepted 屏障失败。该场保留，没有用后续成功片段覆盖。
- native-official-o1 在本机 API bind 前被沙箱拒绝，没有 CLI 证据。o2 的实际 fork leaf 已接受，但受控 API 的 tool_result 响应错误地返回普通控制文本，导致 fork-completed 断言失败。修正 API 按 tool_use_id 映射响应后，新场 o3 全流程通过；未改变官方 binary、并发上限、timeout 或预期接受断言。
- candidate-green2/3 的新增 SkillTool 邻接夹具未发布到可发现命令表，出现 Unknown skill。最终使用 AppState 中实际 MCP skill 注册表示触发 SkillTool；保留失败日志，没有放宽身份、计数或异常断言。

## 自动化、检查与构建

两侧 candidate-core-test/workspace-core-test 使用同一组 8 个文件：AgentTool/concurrency、subagentConcurrency、processSlashCommand.concurrency、Mods/spawnConcurrency、toolHost.spawnLifetime、toolHost、agents、toolHost.spawnNotifications。各 77 pass / 0 fail / 0 skip；AgentTool 隔离 child 内另有 11 个 case，不重复计入父 Bun 汇总。新增 fork 文件 5 个独立进程覆盖 slash 成功/异常/身份及 SkillTool 成功/异常；满额普通 Agent guard 在技能前后仍拒绝。

命令与完整环境保存在各目录 result.json：

```sh
python3 /private/tmp/mods-fork-cap-20261007-wz6lfhb6/run.py candidate test candidate-core-test src/tools/AgentTool/concurrency.test.ts src/utils/subagentConcurrency.test.ts src/utils/processUserInput/processSlashCommand.concurrency.test.ts src/services/mods/spawnConcurrency.test.ts src/services/mods/toolHost.spawnLifetime.test.ts src/services/mods/toolHost.test.ts src/services/mods/agents.test.ts src/services/mods/toolHost.spawnNotifications.test.ts
```

ROOT 使用相同命令，将 side/label 改为 workspace/workspace-core-test。runner 实际执行 bun test --no-env-file；只使用独立 HOME/config/TMP/XDG 环境与测试自行设置的占位认证。

| 独立相邻文件 | candidate | ROOT |
| --- | --- | --- |
| src/utils/processUserInput/processSlashCommand.test.ts | 0/0/0；exit 0 | 0/0/0；exit 0 |
| src/tools/AgentTool/AgentTool.nesting.test.ts | 0/0/0；exit 0 | 6/0/0；exit 0 |
| src/tools/AgentTool/foregroundProgressUpdate.test.ts | 0/0/0；exit 0 | 0/0/0；exit 0 |
| src/tools/AgentTool/foregroundBackgroundContinuation.test.ts | 0/0/0；exit 0 | 0/0/0；exit 0 |
| src/tools/AgentTool/resumeAgent.permissionMode.test.ts | 0/0/0；exit 0 | 0/0/0；exit 0 |
| src/tools/WorkflowTool/workflowScriptRuntime.test.ts | 0/1/0；exit 1 | 0/1/0；exit 1 |

Workflow 失败保留为既有问题：workflowScriptRuntime.test.ts:376，Agent call 实际 1 / 预期 2。head-baseline/workflow-before 使用未修改 72883d0 独立复现同一失败；未 skip、删断言或算作通过。本轮每侧 14 个相关文件，13 个 exit 0。

candidate-check/workspace-check 的 make release-check 均 exit 0，candidate-build/workspace-build 的 make build 均 exit 0。Make VERSION=2.1.280，输出到私有目录，ROOT 原 built-claude 字节及 mtime 保持。所有最终 core、neighbor、check、build 的源码 manifest 与各侧 build 一致，sourceUnchanged=true，无超时或自有进程组遗留。

| 侧 | sourceSHA256 | binary SHA256 | bytes / mtime ns |
| --- | --- | --- | --- |
| candidate | 893e420d3b8fefdb2324fc749c3ffcfdaea65cd9df311a9000c222be503d390c | f735b16cc2e62132ff8e5944f7eb303797ad7fe157b7a805215c29ce4d6ddaaf | 102051170 / 1791310689050932665 |
| workspace | adfd906243a3903022b692b8b942f6af1e7e8361c1460366fa16a8caa84bd179 | 7f0e8c6c134b03d5fa53a478a97ecb0666d4036d87a359c99049599bd469b75a | 101935586 / 1791310689104534746 |

## 真实入口与副作用

native-fork-cap.py 串行执行完整场 official-o3、candidate-c1、workspace-r1。每场使用唯一 160×40 tmux、cold standalone binary、HOME/config、占位 key 和 localhost API。sandbox 禁止个人 Claude 配置、keychain、外网和仓库写入。字面 stdin、分阶段原 pane/ANSI/PTY、debug、实际请求、二进制身份和进程记录位于各场 evidence；native-summary.json 是后置审计，不替代原始记录。

| 断言 | 必要证据及实际观察 | Runtime / verdict |
| --- | --- | --- |
| F1 slash 接收与内部 Agent 容量 | /cap-fork 字面输入、pane、实际 fork/leaf API 和成功 tool_result；上限 2 且 B 始终持有 1，leaf API 恰好 1 | done / passed（三侧） |
| F2 身份归属 | 开始/完成 debug 与 BOUND_TURN 的实际 agentId 相同；单位测试核对进度 ID 与 runAgent.override | done / passed（两侧本地）；官方源码同 ID，未声称其原日志与本地相同 |
| A1 普通全局与插件额度 | 两个实际 held 子 API；插件重复异常、其他插件 deny、普通 Agent is_error 均精确匹配，被拒绝 child API 为零 | done / passed（三侧） |
| A2 嵌套限制 | 普通 middle 实际 Agent call 到 leaf 时拒绝，leaf API 为零，middle 完成 | done / passed（三侧） |
| A3 foreground/background | child API 挂起时发送 C-b，父查询收到后台回执；释放屏障后通知回来，底层 API 仅 1 次 | done / passed（三侧） |
| A4 通知及账本 | 4 个 Mod 启动/完成，Mod 通知 0；普通后台 Agent 通知恰好 1；/exit 0，session ID、startedAt、公共成本与模型成本总和保存一致 | done / passed（三侧） |
| A5 清理及计数 | binary SHA 不变、API 关闭、自有 PGID 无遗留；本地预留 8 次，最大 2，最终 0 | done / passed（三侧；计数日志仅两侧本地） |

| 侧 | API 请求数 | fork leaf API | session cost USD |
| --- | --- | --- | --- |
| official | 27 | 1 | 0.0025950000000000005 |
| candidate | 28 | 1 | 0.0022100000000000006 |
| workspace | 28 | 1 | 0.0022100000000000006 |

各侧账本保存一致，不声称请求数/成本与官方相同；既有标题及通知 helper 路由差异仍在。本机确定性 API 不代替真实 provider 网络。

## 未覆盖与提交边界

- 官方默认后台技能路由、background frontmatter 的完整加载链、命名任务/SendMessage 恢复/同技能重复启动、fork recursion 和完整技能 UI 仍未对齐；本场显式 background:false，只验证同步技能。KAIROS 旧后台分支仍预留，没有修改或宣称验收。
- 原生 SkillTool 调用未在本场触发；仅实际生产 SkillTool 的注册命令自动化验证。故障、取消、worktree 和完整 logical/physical UI frames 不由普通成功场证明。
- main 请求工具清单官方包含 Workflow，本地默认清单没有 Workflow/WorkflowTool；原生 Workflow not covered。resume 由既有真实 transcript 自动化验证，不能代替原生恢复。没有用 parent-side Agent/Workflow/Task 补证。
- ultracode 组织/模型能力旁路、既有 Workflow 失败、同进程全量 suite、G5 与完整 Mods API/类型/上下文/UI/diff 目标继续处理。本批不是总体兼容完成。
- 仅暂存本批同步入口、回归和文档；原 278 个 WIP、fix-instructions.md、improvment.md、response.md、289 资产及 ROOT 旧 binary 的字节和 mtime 保留。其他 Claude 进程没有被操作，无 push。
