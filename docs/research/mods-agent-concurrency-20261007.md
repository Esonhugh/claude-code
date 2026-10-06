# Agent 全局并发专项：2026-10-07

本批对齐默认普通本地 Agent 的全局执行额度、公开 Mod 全局拒绝结果和名额生命周期。基线 HEAD 为 168210a02ee42074445ea6e52c99db18e783d781；独立候选不包含另外 278 个 WIP。证据根为 /private/tmp/mods-agent-cap-20261007-tfmvh1z2。

## 官方依据与实现边界

- 2026-10-07 再次读取 [Anthropic npm latest](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)，最新仍为 2.1.291。对照原 binary SHA256 为 9a1d2ed6bb4421e8fc80c892c0413f293be3ee50ae3d7dda1a7622197a056690。
- Source-confirmed：chunk-9ag6ybmh.js 的真实 registry 增加 runningSubagents，释放回调幂等且夹到零，getConcurrentSubagents 读取该独立值；同文件另有 no-op registry。不会通过任务列表的 running 数量计算执行额度。
- Source-confirmed：chunk-s6pn7fn6.js 的 AgentPreconditionError 保留稳定 name；新建普通 Agent 在准备前和 takeConcurrencySlot 前检查。remote 与较早返回的 named teammate 路径独立。默认 20 与插件上限使用同样的有效正整数环境解析。
- Source-confirmed：chunk-g2d84gj0.js 的生命周期在成功/失败/取消后先调用 onRunSettled，再发布终态、执行后处理，finally 可再次调用。chunk-ebe4qw6e.js 的普通 resume 只预留；observer-activity resume 另有不计数分支。chunk-cw79d6zb.js 的对应 fork worker 只预留，没有新建额度 guard。
- 官方静态模块、摘要、精确偏移与有界片段保存在 official-source.json。静态分析和真实入口结论分开；最新技能 UI 的 fork 路由差异见下文，不能只凭旧函数片段声称整个入口一致。
- 本地新增根 AppState 的 runningSubagents 与 CLI/default 初始值，ToolUseContext 增加根 reader，并在 createSubagentContext 中与根 writer 一起传递。AgentTool 两次检查与实际预留之间没有 await，避免并行准备超过额度。
- 本地 async lifecycle 通过内部 onRunSettled 释放；同步 foreground、移交后的 continuation、resume 和现有 fork 执行函数分别保持名额所有权。Mod toolHost 仅把 AgentPreconditionError 转为 {deny}，普通异常和取消继续拒绝 Promise。没有改变公开作者方法签名，也没有新增 ForTesting 入口。
- 插件名额控制与全局控制共用环境解析器，各自计数。插件计数、启动回执和完成通知认领仍按上一批实现。
- 本地保留 tengu_amber_kestrel 旁路，并按既有本地 Workflow 开关、ultracode effort 和支持模型检查对应旁路；组织可用性、第三方模型能力覆盖和完整官方 ultracode 状态映射仍未关闭，本批不声称这些特殊模式已完全等价。

## RED 与保留诊断

- candidate-red2-test：旧 HEAD 的新增实际 Agent 回归 0 pass / 10 fail，exit 1，无额外 error。最初 candidate-red-test 另有未处理 continuation 失败；补全测试 Promise 清理后消除，原失败日志保留。
- red-build1：本轮 ROOT 修复前 Make binary。native-workspace-red2 实际接受全局满额时的其他插件 spawn，断言失败，自有进程组清理完成。更早 red1 是夹具产物路径错误，未启动 CLI，标记 not covered。
- candidate-green1-test 的唯一失败来自不完整 snapshot 缺少 hasHooks，改为完整合法接口后通过；不是修改生产逻辑绕过断言。
- candidate-check1 因 CLI 初始 AppState 漏字段、现有 host 测试未区分 deny 联合类型及测试 snapshot 类型失败；补齐真实定义和拒绝分支后最终两侧 release-check exit 0。
- candidate-fork1-test 是夹具字符串语法错误，candidate-fork2-test 是尚未调用 enableConfigs 的配置边界错误；只修正夹具。最终 fork 成功/失败分支均执行实际 processSlashCommand 与 slot lifecycle，断言满额时预留及释放，不跳过或放宽。
- 官方 o1 的全局拒绝成功，但夹具复用了拒绝和普通控制的 tool_use ID；o2 给两次调用使用独立 ID，并后置确认普通控制有成功 tool_result。各场原始脚本/失败保留。

## 最终测试、检查与制品身份

八份核心测试一起执行，两侧均 74 pass / 0 fail / 0 skip。新增 Agent fixture 在隔离子进程内另执行 11 条实际 AgentTool/stream 生命周期 case，全部通过；父进程的单一 fixture case 已包含在 74 中，不重复累加。模型 stream 是受控边界，原生证据另列。

十四份相邻测试逐文件独立执行，避免已有文件级 mock 串扰：

| 文件 | 候选 pass/fail/skip 与退出码 | ROOT pass/fail/skip 与退出码 |
| --- | --- | --- |
| `src/services/mods/runtime.test.ts` | 90/0/1; exit 0 | 92/0/1; exit 0 |
| `src/services/mods/runtimeHost.test.ts` | 94/0/3; exit 0 | 105/0/3; exit 0 |
| `src/services/mods/runtimeTools.test.ts` | 24/0/1; exit 0 | 26/0/1; exit 0 |
| `src/services/mods/runtimeHostHooks.test.ts` | 26/0/0; exit 0 | 26/0/0; exit 0 |
| `src/tasks/LocalAgentTask/LocalAgentTask.progress.test.ts` | 0/0/0; exit 0 | 0/0/0; exit 0 |
| `src/tools/AgentTool/asyncLifecycleOrdering.test.ts` | 0/0/0; exit 0 | 0/0/0; exit 0 |
| `src/tools/AgentTool/foregroundBackgroundContinuation.test.ts` | 0/0/0; exit 0 | 0/0/0; exit 0 |
| `src/tools/AgentTool/subagentDepth.test.ts` | 0/0/0; exit 0 | 0/0/0; exit 0 |
| `src/tools/AgentTool/resumeAgent.permissionMode.test.ts` | 0/0/0; exit 0 | 0/0/0; exit 0 |
| `src/utils/processUserInput/processSlashCommand.test.ts` | 0/0/0; exit 0 | 0/0/0; exit 0 |
| `src/tools/AgentTool/AgentTool.nesting.test.ts` | 0/0/0; exit 0 | 6/0/0; exit 0 |
| `src/tools/WorkflowTool/workflowScriptRuntime.test.ts` | 0/1/0; exit 1 | 0/1/0; exit 1 |
| `src/services/tools/toolOrchestration.test.ts` | 18/0/0; exit 0 | 18/0/0; exit 0 |
| `src/tools/AgentTool/foregroundProgressUpdate.test.ts` | 0/0/0; exit 0 | 0/0/0; exit 0 |

本轮共执行 22 个相关文件，21 个 exit 0；Workflow 文件仍有既有失败。候选注册 case 合计 326 pass / 1 fail / 5 skip，ROOT 为 347 pass / 1 fail / 5 skip；node:assert 模块脚本注册为 0 case，按文件退出码记录，不伪计 pass。

Workflow 的失败为 workflowScriptRuntime.test.ts:376，实际 Agent call 1，期望 2。head-baseline/workflow-before 使用未修改 HEAD 独立复现同一失败；候选和 ROOT 均一致。该失败没有被跳过、弱化或算为通过，继续作为后续独立问题处理。

五个既有 skip 各侧均保留：
- (skip) Mods lifecycle > flushes the official agents-md startup row through official telemetry
- (skip) Mods lifecycle > flushes the official agents-md startup row through official telemetry
- (skip) official diff silently yields to the built-in command
- (skip) official diff still logs unexpected command registration errors
- (skip) an author plugin compiles against the complete target declarations and runs unchanged in a Worker
- (skip) official diff silently yields to the built-in command
- (skip) official diff still logs unexpected command registration errors
- (skip) an author plugin compiles against the complete target declarations and runs unchanged in a Worker
- (skip) official native policy blocks Worker author registration before publication
- (skip) official native policy blocks Worker author registration before publication

所有最终核心测试、14 份相邻测试、release-check（候选 check3 / ROOT check2）和 Make build2 使用各侧同一源码清单，sourceUnchanged=true，无超时或自有进程组残留。Make VERSION 2.1.280，输出到私有 build2-output；ROOT 原 built-claude 字节及 mtime 保持。

| 侧 | sourceSHA256 | binary SHA256 | bytes |
| --- | --- | --- | --- |
| candidate | `98f7575101718aee43d84170c4169d7dffcbb7015c427b13e97db5c60e8399a6` | `8ea61e112ea11a75a73e940486a573b0d4ae933ab2e848f20748d2f416bb516b` | 102051170 |
| workspace | `59ca72e62ca60989531f64de4757a5420b686fb616d544564f1605df002ce310` | `1eab333897d93820152654b0f199fc759fa5cf7f582065d52fa2b0baa35f0950` | 101935586 |

## 默认全局额度的真实入口

Runtime-observed：native-global-cap.py 串行驱动 official-o2、candidate-c1、workspace-r1。每场使用独立 160×40 tmux、HOME/config、cold standalone binary、dummy key 与 localhost API；sandbox 禁止个人 Claude 配置、keychain、外网和仓库写入。参数及精确 stdin、原 pane/ANSI/PTY/debug、源码/制品摘要、任务 ID、API 请求均保留在各场 evidence。

1. stdin /boundfill 真正启动 A/B 两个 API 挂起的 Mod 子任务；同一插件第三次和新 hook 再次调用均抛出精确插件上限异常。
2. 其他插件在全局满额时得到精确 {deny}；普通模型调用实际 Agent tool 得到 is_error tool_result。两次均没有被拒绝子任务的 API。
3. A 结束后另一插件成功启动 E，E 结束后原插件启动 D，B 始终仍运行。启动回执没有释放全局名额。
4. A/B/D/E 的 Mod 完成通知为零；普通 Agent 的真实后台控制收到恰好一条通知，父模型实际消费。后置读取确认普通成功 tool_result、四个 Mod receipt 与通知认领 ID 相同。
5. 两侧本地 debug 的全局预留各 5 次、计数最多 2、最终释放为零。项目保存 session ID、startedAt、公共 cost 和各模型 cost 总和一致。

| 侧 | 请求数 | Mod/普通通知 | session cost USD |
| --- | --- | --- | --- |
| official | 12 | 0/1 | 0.0012300000000000002 |
| candidate | 13 | 0/1 | 0.0011250000000000003 |
| workspace | 13 | 0/1 | 0.0011250000000000003 |

## 普通嵌套与前台转后台

Runtime-observed：独立 native-nested-background-cap.py 完整场 official-o4、candidate-c2、workspace-r2 均 observed、正常 /exit 0。不能用上一场成功片段拼接替代这三场。

- B 仍持有一个全局名额时，普通父查询启动 foreground middle Agent。middle 真实尝试 nested leaf，三侧均精确拒绝，leaf API 为零；middle 完成后释放名额。
- 之后普通 foreground Agent 发出一次被屏障挂起的 API；脚本向 CLI 发送 C-b，父查询收到 background 回执时 API 仍未结束。释放屏障后完成通知回来，底层 Agent API 仅一次。
- 两侧本地同场日志各 7 次预留，最大计数 2，最终零；有且仅一次 foreground_to_background，agent/task ID 与实际 stream 关联。

| 侧 | 请求数 | cost USD | nested leaf API | foreground child API |
| --- | --- | --- | --- | --- |
| official | 23 | 0.0023150000000000007 | 0 | 1 |
| candidate | 24 | 0.002000000000000001 | 0 | 1 |
| workspace | 24 | 0.002000000000000001 | 0 | 1 |

全部成功场 binaryUnchanged=true、API 已关闭、自有 PGID 无遗留。native-summary.json 与 entry-summary.json 保存后置审计。成本与请求数仍受既有标题/通知 helper 路由差异影响，只验证各自保存一致，不声称与官方总成本相等；本机 API 不代替真实 provider 网络。

## 未完成的入口与设计

- 官方 native-entry-cap.py o3 已接收 stdin /cap-fork，实际使用 claude-sonnet-5-5，并允许 fork worker 的 leaf 启动；期待全局拒绝的探测失败。证据显示该最新技能入口与普通嵌套不同，但仅凭此不能判定其所有 registry/模式归属。保留 o3 完整失败，不把 fork 自动化通过标为当前技能 UI 等价。后续应继续追踪其新路由和上下文，而不是改官方 binary、隐藏断言或提高上限。
- 本场官方模型工具清单包含 Workflow，本地默认配置不包含 Workflow/WorkflowTool；原生 Workflow 全局计数 not covered。恢复只由实际 transcript/resume 自动化验证，未用 parent-side Agent/Workflow 结果补齐。原生 failed/killed、worktree 清理故障、observer-activity、remote、teammate 与全部组合仍待验收。
- 组织/模型能力下的 ultracode 旁路、同进程全量 suite、G5、标题 helper、新版技能 UI 与完整 Mods API/类型/上下文/UI/diff viewer 目标继续处理。本批不宣称总体完成。
- 其他 278 个 WIP、原 response.md、fix-instructions.md、improvment.md、289 官方资产与原 ROOT 制品的字节和 mtime 保留。无其他 Claude 进程被操作；不 push。
