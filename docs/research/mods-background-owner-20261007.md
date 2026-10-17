# 普通后台 Agent 的父子归属与自动续跑（2026-10-07）

本批修复普通后台父 Agent 提前通知主会话、无法消费自己的子任务通知的问题。仅提交该生命周期、必要状态/模型定义、回归与文档；不宣称 Mods、技能默认后台或 UI/diff 已完整对齐。

证据根：`/private/tmp/mods-bg-owner-20261007-ylfu10fo`。父提交：`773e5f4fd082c689fd9fe8cc54e3818c292daf76`。候选由该提交独立克隆，ROOT 保留已有 278 项 WIP；不 push。

## 官方依据与实现范围

本轮查询 [npm latest 元数据](https://registry.npmjs.org/@anthropic-ai/claude-code/latest) 仍为 2.1.291。官方 native SHA-256：`9a1d2ed6bb4421e8fc80c892c0413f293be3ee50ae3d7dda1a7622197a056690`，233211568 bytes。本地 Makefile 构建版本仍为 2.1.280；本批不改发布版本。

静态片段与文件哈希保存在 `official-owner-source.json`，只分析本机解包源码：

- `chunk-g2d84gj0.js` 的 Y9 在流结束后保存本轮结果、释放名额；Spe 判断仍有 agent 子任务时延后父任务通知与 worktree 清理。
- `chunk-v1gtm86q.js` 的 n3/Ymt/Kmt/jBr/DQ 管理 keepaliveReasons、ownerAgentId、队列 taskId、公开等待状态与通知；owner 与 parentAgentId 的继承关系不同。
- `chunk-scapxbwa.js` 的通知唤醒路径恢复同一 agent 身份。官方还处理重试、闲置窗口与更多消息来源；本批仅实现普通后台子任务通知的自动续跑。

本地后台 Agent 注册明确通知 owner；前台转后台也建立该关系。父任务本轮结束时状态保存为 completed，有子任务保活时 agent.list 显示 waiting。队列和任务变更驱动唤醒，消费带 taskId 的通知、移除对应保活项，并在下一轮保留其他孩子。恢复保持 agent ID、有效模型与已有 transcript/权限处理；完成全部孩子后才发送最终主会话通知。

TaskStop 与 SDK stop_task 的共享逻辑允许停止等待中的任务。取消或恢复初始化失败执行延后的清理，保留最近结果和用量；这是自动化故障验证，不冒充终端中的真实 worktree 或 SDK 控制协议验证。README 包含使用和 debug 说明；一般子代理配置参考 [Anthropic subagents 文档](https://code.claude.com/docs/en/sub-agents)。

## RED 与修复

- `candidate-owner-red`：0 pass / 7 fail，缺失归属、提前通知和无法续跑均由真实任务表/消息队列断言复现。
- `workspace-red-build` 成功后，`native-workspace-red1` 在自己的后台 leaf 尚未完成时已向主会话通知父任务，断言失败；保留同场 pane、API、debug 和清理结果。
- `candidate-owner-extra-red`：9 pass / 2 fail，补充公共 waiting 状态和恢复失败清理。
- `candidate-owner-terminal-red`：9 pass / 2 fail，等待取消/恢复失败的通知遗漏最后结果或 usage；补齐通知数据。
- 首轮 release-check 缺少 keepalive/model 类型并有 lint 错误，均保留日志并修正，没有删除测试、skip、放宽断言、延长超时或增加生产 ForTesting 接口。
- 迁入 ROOT 后，新增列表用例初次 35/1：ROOT 的既有 listModAgents 是异步接口。测试改用 await，保留三段状态断言；不覆盖 ROOT 的既有实现。

## 最终自动化与构建

| 验证 | 干净候选 | ROOT | 证据 |
| --- | --- | --- | --- |
| 7 个核心文件 | 36 pass / 0 fail / 82 expect | 36 pass / 0 fail / 78 expect | candidate-core-final3 / workspace-core-final2 |
| 8 个相邻文件 | 1 Bun 用例 + 7 assert 文件，0 fail | 7 Bun 用例 + 7 assert 文件，0 fail | candidate-neighbors-final / workspace-neighbors |
| Make build | exit 0 | exit 0 | candidate-build4 / workspace-build2 |
| Make release-check | exit 0 | exit 0 | candidate-check4 / workspace-check2 |

新增 backgroundOwner 的 11 个隔离用例覆盖 owner、继承身份分离、通知先/后到达、多孩子多轮、取消、真实 TaskStop 调用、公开列表与恢复失败。相邻文件覆盖 nesting、前台进度/移交、恢复权限、SubagentStop，以及 Workflow 调度/运行会话/执行器。assert 文件确实执行且日志显示 passed，不把它们虚报为 Bun 用例数量。两组源代码中既有 WIP 导致计数差异，不混拼为一份 suite 结果。

每次测试/构建使用独立 HOME、配置、真实 TMPDIR、XDG 与无个人凭据的环境；runner 120 秒期限未变。最终结果均 sourceUnchanged=true，进程组已退出。相邻源码未变，最后仅修正新用例的 await；相邻日志保留各自源码哈希。

| 制品 | runner 源清单 SHA-256 | binary SHA-256 | bytes |
| --- | --- | --- | --- |
| 候选 | `10f227d2db5b9586c05e649c26a61ff8b9d28ea2fa4dc847433c05402cd2a46c` | `5a7c6a4f72a298fd9b60e405b0852388ea9a4980dcdf99ee83efe5d18cf8c281` | 102051170 |
| ROOT | `37e42caa81c94c0e7517d819d38cfc68282db5e45a16cbaf7344d4d953350dee` | `a1ea7d5867c59fd3dbd05f923b6cd73cec1576f5f63c6eb991fe5517f1983da8` | 101952098 |

源码清单包括 CHANGELOG/src/types/vendor/scripts/assets。新研究文档不进入构建；native 记录各自构建身份。ROOT 原有 built-claude 的字节和 mtime 保留，所有 native 使用独立 cold copy。

## 真实父子后台入口

`native-background-owner.py` 以普通 Agent 的 run_in_background=true 显式启动父任务，再由父模型真实调用后台 Agent leaf；此探针不证明技能默认后台路由。160×40 tmux、隔离 dummy auth/配置、本地假 API、禁止外网/Keychain/仓库写入。父/子 API 可分别保持未完成；每场只采用自己的证据。

| 场次 | session | API 请求数 | 终态 |
| --- | --- | --- | --- |
| native-official-o2 | 4b885754-9862-4bb9-b8c1-378238aeb601 | 13 | exit 0 / 无自有进程残留 |
| native-candidate-c5 | d7623481-f69c-431d-91b6-03b1d7100777 | 15 | exit 0 / 无自有进程残留 |
| native-workspace-r1 | 1dd4a2f9-9ffe-4a1a-a2f6-769d73ad66c5 | 15 | exit 0 / 无自有进程残留 |

三场均证明：父后台回执先于 API 完成；第一轮父结果完成而子任务仍运行时，父列表显示 waiting 且没有父完成通知；另一个普通 Agent 能在此时运行，证明名额释放；子任务完成后原父 ID 自动续跑，保持 Haiku；最终父通知恰好一次。成本/启动 epoch/会话 ID 在公开 API、正常退出存盘和模型分项之间一致。官方与本地费用不同，不宣称辅助调用、所有 token/metadata 字段一致。

## 相邻真实入口

`native-plugin-fork.py` 保持插件/全局并发拒绝、真实 nested Agent、同步插件 fork 的 slash 与 SkillTool、Ctrl-B 不重启原流、普通后台通知控制，并补充实际 SendMessage 恢复与 Workflow 入口尝试。

| 场次 | session | API 请求数 | 终态 |
| --- | --- | --- | --- |
| native-official-n8 | e1b15644-7b70-4822-a2cc-8a0a629f1cf1 | 44 | exit 0 / 无自有进程残留 |
| native-candidate-n6 | 8f017efb-97b3-479a-9db2-bde516838200 | 42 | exit 0 / 无自有进程残留 |
| native-workspace-n7 | 998c4507-a485-4fd5-b0d0-21071f3d9753 | 42 | exit 0 / 无自有进程残留 |

三场 SendMessage 都恢复原 task ID，实际模型仍为 Haiku，恢复 API 只执行一次，随后通知主会话。官方实际执行 Workflow 并产生一个 child API；候选与 ROOT 的真实主模型工具目录缺少 Workflow/WorkflowTool，因此本地 Workflow runtime 明确为 not covered，不能用自动化执行器或父 assistant 工具代替。

早期官方 n1 的目录判断误取无工具的 title helper，修正请求分类后完整重跑。候选 n3/n5 出现 ECONNRESET，恢复请求未进入假 API handler，保留失败；n4 偶然通过，未据此宣布问题解决。测试服务改用 HTTP/1.1 并显式 Connection: close 后，最终 n6/n7/n8 全程通过。未改生产传输代码、断言、期限；据未到达 handler 的日志，怀疑短连接复用交互；连接重置的底层根因未完全定位，不宣称修复生产网络层。非敏感传输头和服务错误日志随证据保留。

每场 /exit 都观察 pane_dead/status=1/0；无自有 PGID 残留、API 关闭、cold binary 不变。完整 assertions/proof/source identities 见 native-summary.json；driver-used.py、字面输入、pane/ANSI/PTY、debug、requests、JSONL、meta 与成本保存于各场 evidence。

## 提交与剩余边界

只暂存本批必要 hunks。ROOT 的既有模型类型、异步列表与其他 teammate/Mods 改动原字节保留；干净候选包含本批独立所需定义。原 response/improvment/fix-instructions、289 资产、旧 binary 以及无关文件字节/mtime 均核对保留；不操作其他 Claude 进程，不 push。

技能默认后台路由、独立 fork 权限快照/恢复与递归保护、同步前台父任务和完整通知来源/唤醒重试、实际 worktree/取消/SDK/Workflow 的所有组合、G5、完整 API/类型/上下文/UI/官方 diff viewer 与同进程全量门禁仍未完成。此前 Workflow script 基线失败也不在本批关闭；详细全目标持续验收，不把本批定向通过提升为全量兼容。
