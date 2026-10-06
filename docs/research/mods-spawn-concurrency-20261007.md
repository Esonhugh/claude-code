# Mod spawn 插件并发专项：2026-10-07

本批关闭公开 `$.agent.spawn` 的插件计数与后台观察周期缺口。普通 Agent 的全局检查、全部原生生命周期组合与整体 G5 继续验收。

基线为 `9dd700f9c62023f817af8cd7dc9e4333496201ca`。相邻的过期用量 mock 先独立签名提交 `add651499b678a372061490a9165832967349f51`；并发候选基于该提交，未折入另外 278 个 WIP。证据根：`/private/tmp/mods-spawn-bound-20261007-xsy7g593`。

## 官方依据

- 2026-10-07 重新读取 [Anthropic npm latest 元数据](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)：2.1.291。
- Source-confirmed，官方提取模块 `chunk-v1gtm86q.js` 中 `p0o` 按插件名计数，`xPo=20`；启动前预留，启动失败立即释放，`leftRunning` 观察结束后释放。该控制器挂在 manager 的 budgets 上，不随单次 host 调用或插件重载重新创建。
- Source-confirmed，`DPo` 仅把 Agent 的 `async_launched` 和字符串 agentId 交给观察器；completed、teammate_spawned、remote_launched 使用普通返回路径。`bYt` 使用独立 AbortController 与无限的已注册任务等待时间。
- Source-confirmed，`wYt` 每 150ms 按 local_agent.agentId 寻找任务，初次注册等候最多十分钟；找到后等待 completed/failed/killed，或者已找到的记录被移除。不是等 AgentTool 的启动 Promise 结束。
- Source-confirmed，环境模块使用 `M.int({min:1,digitsOnly:true})`；支持 trim 后可选符号加十进制整数，非有限或小于一的值回退到 20。`chunk-acyswsc6.js` 的 js 只认三种终态。
- 官方 binary SHA256：`9a1d2ed6bb4421e8fc80c892c0413f293be3ee50ae3d7dda1a7622197a056690`。提取目录仅用于静态依据，真实对照使用原 binary。

## 实现范围

- runtime 保存按插件名的计数，拒绝文字与官方一致；预留发生在启动回执之前。计数独立于调用者、捕获快照和插件激活代际。
- toolHost 的内部回调仅由实际 Agent 返回的 async_launched 触发，使用该结果中的 agentId。其他结果及启动异常立即释放；callback 不进入公开作者类型。
- 使用既有根任务 reader 与终态谓词观察任务，任务已启动后不跟随调用者取消；初次记录未出现、已找到记录被移除和观察异常分别记录原因。计时器不阻止进程正常退出。
- 调试日志输出插件、任务 ID、agent ID、终态、预留及释放计数。公开事件格式、普通 Agent/Workflow 执行源码和依赖未改变。

## RED 与夹具诊断

- 最终两份新增测试在 clean HEAD 上为 1 pass、20 fail、无额外 error，exit 1：`head-red/final-red2-test`。断言完全保留，清理未确认启动的测试 Promise 后消除了最初 RED 的额外未处理取消异常。
- ROOT 本轮修复前 Make 制品的真实 tmux 复现 `native-workspace-red1`：第三个 spawn 被接受并启动真实子代理，断言失败；清理后自有进程组无遗留。
- 首轮实现候选遗漏 HEAD 中需要新增的两个 import，观察器 ReferenceError 导致名额提前释放；诊断日志保留在 candidate-green-test、candidate-debug-test、candidate-debug2-test，随后补全 imports 并删除临时 console 输出。
- 首次两侧 release-check 均因新增测试的 receipt 类型遗漏 deny 分支失败；按实际返回联合类型修正测试定义，未放宽断言。最终 check3 两侧均 exit 0。
- 官方 o1/o2 在其他插件启动处遇到现有的普通 Agent 全局并发拒绝；o2 的缓存 flag 没有绕过该限制。保留失败记录。最终 o3 移除该 flag，在释放足够全局名额后执行其他插件及普通 Agent 控制组；未修改官方 binary、增加 timeout 或删除断言。
- 相邻 runtimeHostHooks 旧 HEAD 25／1 的原因是 mock 缺少 startedAt；独立夹具提交只给 mock 和完整结果断言各补字段，独立候选、ROOT 都 26／0。原 session.version WIP 保留。

## 最终测试与源码身份

五份核心测试用 `bun test --no-env-file` 一起执行；八份相邻测试逐文件独立执行，避免不同测试文件的全局 mock 互相影响。所有命令使用独立 HOME/config/TMPDIR，不继承个人 API key 或 OAuth 凭据，既定上限 120 秒。

| 范围 | 候选 pass / fail / skip | ROOT pass / fail / skip |
| --- | --- | --- |
| 五份核心：spawnConcurrency、toolHost.spawnLifetime、agents、toolHost、spawnNotifications | 65 / 0 / 0 | 65 / 0 / 0 |
| src/services/mods/runtime.test.ts | 90 / 0 / 1 | 92 / 0 / 1 |
| src/services/mods/runtimeHost.test.ts | 94 / 0 / 3 | 105 / 0 / 3 |
| src/services/mods/runtimeTools.test.ts | 24 / 0 / 1 | 26 / 0 / 1 |
| src/services/mods/runtimeHostHooks.test.ts | 26 / 0 / 0 | 26 / 0 / 0 |
| src/tasks/LocalAgentTask/LocalAgentTask.progress.test.ts | 0 / 0 / 0 | 0 / 0 / 0 |
| src/tools/AgentTool/asyncLifecycleOrdering.test.ts | 0 / 0 / 0 | 0 / 0 / 0 |
| src/tools/AgentTool/foregroundBackgroundContinuation.test.ts | 0 / 0 / 0 | 0 / 0 / 0 |
| src/tools/AgentTool/subagentDepth.test.ts | 0 / 0 / 0 | 0 / 0 / 0 |

候选注册的 Bun case 合计 299 pass、0 fail、5 既有 skip；ROOT 314 pass、0 fail、5 既有 skip。最后四个文件是实际执行 node:assert 的模块脚本，均输出对应文件的 passed 标记并 exit 0；它们注册 0 个 Bun case，不重复计入 pass。13 个相关文件全部 exit 0，未新增 skip 或弱化断言。

既有 skip 保留为：
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

| 身份 | 候选 | ROOT |
| --- | --- | --- |
| sourceSHA256 | `73179d86883933211eda1564b49d7823b7760f9f450f5af5defe7ad18b40f1c1` | `e2c372c56d815205ec3a05d1b913df0e2a03a073609510e27e4e735f0dac550b` |
| binary SHA256 | `b26340969d2088c3c7f0ccbfec4eafc00b57b906d7880b2c31fb2e13e57cf847` | `f9d810a4976973fc5aebed4d86501dfbebb474f9695496a27c0a5f3dccc4309d` |
| binary bytes | `102034658` | `101935586` |

两侧最终核心测试、8 份相邻测试、release-check 和 Make build 均绑定各自同一源码清单，sourceUnchanged=true、exit 0、无超时或自有 PGID 遗留。Make VERSION 为 2.1.280，输出到各自私有 build3-output，ROOT 原 built-claude 的字节与 mtime 不变。

## 编译制品真实入口

Runtime-observed：官方 o3、候选 c1、ROOT r1 使用同一 `native-spawn-bound.py` 操作自有 tmux，160×40，冷拷贝独立制品，`--dangerously-skip-permissions --debug --debug-file --plugin-dir`。HOME/config 分别隔离，API key 是虚拟值，网络仅允许本地可控 API；sandbox 禁止读取个人 Claude 配置、keychain 和外网。三场均正常 /exit，binaryUnchanged=true、API 关闭、自有进程组无遗留。

1. `/boundfill` 真正启动两个 API 仍被挂起的子任务，收到两个不同 agentId；第三个调用精确拒绝，C 子任务 API 请求为零。
2. `/boundmore` 在新的 hook 调用中仍精确拒绝，启动回执未释放名额。
3. 释放 A 的 API 响应并观察完成事件后，另一插件启动 E 成功；E 完成后原插件启动替代任务 D 成功，B 仍运行。
4. B/D 完成后，通过模型真实执行普通后台 Agent；收到恰好一个普通任务通知，Mod 的完成通知为零。四个 Mod task 的 turn.complete answer 对应 A/B/D/E。
5. 根会话公开 usage、退出保存的 lastStartTime、session ID、lastCost 与各模型成本总和一致。日志后置核对由 verify-evidence.py 执行：四次认领与四个实际 receipt agentId 相同，四次 completed 观察、两次拒绝、原插件预留序列 1/2/2、另一插件 1、各自最终释放到零。

| 侧 | 请求总数 | Mod 通知 / 普通通知 | 保存的 session cost USD |
| --- | --- | --- |
| official | 9 | 0 / 1 | 0.000915 |
| candidate | 10 | 0 / 1 | 0.0008800000000000001 |
| workspace | 10 | 0 / 1 | 0.0008800000000000001 |

## 未完成边界

- 官方普通 Agent 的全局并发 guard 仍待对齐；本次的不同插件成功发生在实际全局名额可用时，不能声称在全局满额时仍可无限启动其他插件。源码级 fixture 的独立计数测试只验证插件控制器。
- 官方与本地的请求数和总成本仍不同，已有标题 helper 的模型路由和任务通知额外 helper 差异继续处理。本次验证成本保存的一致性，不宣称 API 请求或全部成本值与官方一致。
- 三种终态、记录移除、取消、重载及 foreground/remote/teammate 的返回分流有回归覆盖；各组合的完整编译制品错误／取消／nested／Workflow 矩阵尚未全部完成。
- 不把旧 147 文件 gate 或旧 binary 证据拼接为本轮全量通过；同进程全量 suite 的既有失败、完整官方 API/UI/diff 效果和整体 G5 保持未完成。
- 原 response.md、fix-instructions.md、improvment.md、289 官方资产以及另外 278 个 WIP 保留；没有操作其他 Claude 进程，没有 push。
