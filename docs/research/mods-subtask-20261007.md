# 手动子任务与 fork 指令显示专项（2026-10-07）

## 范围与结论

本批为官方 2.1.292 的 `/subtask <task>` 添加交互式后台 worker 入口，复用已有 Agent 生命周期，继承父对话，并更新固定 worker 说明及其折叠显示。独立提交候选和完整 ROOT 工作区分别验证。默认配置和仅设置 `CLAUDE_CODE_FORK_SUBAGENT=0` 的配置，本专项结论为 **passed**；整体 Mods 对齐目标仍未完成。

证据根目录：`/private/tmp/mods-fork-command-7_v6800z`。每次使用当前构建的独立二进制副本、隔离 HOME/config/cache、独立 tmux socket 和本地假 Anthropic SSE API；不读取真实 API key，不连接真实模型服务，不操作其他 Claude 进程。单次 runtime deadline 90 秒、API 保持上限 60 秒；未提高超时。

## Source-confirmed：真实入口与模板

本轮再次查询 [registry latest](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)，版本仍为 2.1.292。官方二进制路径为 `/private/tmp/mods-fork-routing-20261007-2afwted_/official/official-claude-2.1.292`，SHA-256 为 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`。

官方同时保留多种命令定义。默认真实入口是 `/subtask`，加载 `chunk-szk49ra9.js` 并调用 `WNt`；默认 `/fork` 加载 `chunk-s77xj1x4.js`，复制后台会话。首次终端探测确认空会话下 `/fork` 返回 “Nothing to fork yet”，不是旧 worker 用法。不能根据旧函数仍存在便推断默认命令映射。

- `chunk-eq3a8md0.js / WNt`：名称、具名 ID、后台任务注册、并发计数、父系统提示、全量父工具、历史和生命周期。
- `chunk-pwkr374y.js / e1e / y6o`：说明模板与完整匹配解析。独立提取 builder，与本地构造逐字比较空指令、普通指令、Unicode/嵌入标签三组输入，均相同。
- `chunk-se94er0s.js / ul`：fork glyph、dim label、用户消息背景和 directive 排版。
- `chunk-pwkr374y.js / tzt`：具名任务完成后的 idle、非 idle-window 子任务的 waiting、finalizing 的 running 映射。本批只提交具名 fork 的相关状态分支；其余 Agent 状态迁移另行处理。

原始模块路径和 SHA-256 存于 `source-evidence.json`；比较程序为 `compare-boilerplate.mjs`。[Anthropic 文档](https://code.claude.com/docs/en/sub-agents#fork-the-current-conversation) 也区分 `/subtask`、新版 `/fork` 和关闭 agent view 后的映射。

## 自动化、检查与制品

候选和 ROOT 各运行六个相关文件，均为 **56 pass / 0 fail**。命令、源码清单、进程组和结果分别存于 `candidate-tests-final2`、`workspace-tests-final2`。子进程隔离 mock 与配置；没有删除、跳过或弱化既有断言，没有产品 ForTesting 接口。

覆盖命令分派、参数与非交互可用性、协调模式拒绝（受控状态）、名称冲突、独立 abort controller、继承上下文/工具/模型、全局 Haiku 覆盖、失败后的槽释放、具名 fork 状态边界、同 ID 恢复、模板完整匹配及 Unicode 实际 Ink 渲染。已有 fork mode、后台 skill、owner 与并发回归同时执行。

两侧 `make release-check` 和 `make build` 均退出 0。最终测试、检查、构建的各侧源码清单 SHA 一致；详细 metadata 见 `check-summary.json`。

| 制品 | 源码清单 SHA-256 | 二进制 SHA-256 |
| --- | --- | --- |
| candidate-build2-output/built-claude | 45c07b5eb846f717e895a8714479c9f6553c015ffc82d18b462e609aef34473c | 127d2419bade6ee5dcaeebc5825514e217730f27a56714838c537e696ebff103 |
| workspace-build2-output/built-claude | 37b92474d125ad4e6058ea03c56d174b5158271bb382fdc529d5d1b0176d5f44 | 932ce197a27f20e0e6f5f0defb9ca5418fa63a23471773d3bfe41f73b4205626 |

## Runtime-observed：scripted tmux

使用 `native-command.py` 以 literal stdin 输入真实命令；多行模板使用 bracketed paste，等待 draft marker 后独立发送 Enter。API 保持 worker 未返回时，必须先观察用户回执与公共 task ID，不能把后台完成后的消息算作启动证明。

| 断言 | 必要及实际证据 | 本专项结论 |
| --- | --- | --- |
| 空任务仅显示用法 | 保存的 /subtask 输入、pane、零 API 请求 | passed |
| 后台 fork 继承父对话 | held API、公共 agent.list running ID、system/tools/model、消息前缀 | passed |
| 独立用户入口 | agent.spawn hook 对该 directive 为零；任务及 turn.complete 仍可观察 | passed |
| 容量与完成 | held fork 阻止普通 Agent 超额启动；唯一通知；公共状态 running → idle | passed |
| 同 ID 同模型恢复 | 实际 SendMessage 工具调用、API、两次 BOUND_TURN 的相同 ID；全局 Haiku 不改变 fork 模型 | passed |
| 模板显示 | canonical pane 含 `⑂ UI-PROBE-DIRECTIVE` 且没有说明；改写模板仍显示 Hard rules 和原 directive，不显示 collapsed glyph | passed |
| 相邻入口 | 普通 Agent 默认后台、嵌套拒绝、slash/SkillTool 自定义 fork、Ctrl+B、普通 SendMessage、跨插件容量及 Mods script fork | passed |

默认三侧为 `n-official-o7`、`n-candidate-c3`、`n-workspace-r3`；仅关闭自动 fork 的三侧为 `n-official-o9off`、`n-candidate-c4off`、`n-workspace-r4off`。相邻流程为 `n-candidate-ca1`、`n-workspace-ra1`；模型 Agent 与 Mods spawn 为 `n-candidate-cg1`、`n-workspace-rg1`。共十次最终运行均退出 0，runtime 为 done，无自身进程组遗留，API server 已关闭；每侧 binary hash 不变。

每个 `evidence` 目录保存 result、requests、driver-used、source 的 input/pane/PTY/debug、debug-marker-search、终端进程状态及成本落盘记录。完整关联见 `validation-summary.json`，运行顺序见两个 native-matrix JSON。只核对各侧自身费用与保存的模型 usage 相加一致，不宣称两侧辅助查询数量或总费用一致。

父消息内容前缀完全保留；wire 上父末尾 text 的 ephemeral cache breakpoint 移到新消息。三侧观察一致，不能将这项 metadata 差别误报为历史丢失，也不能声称整个请求逐字相同。证明是请求结构，不是真实 Anthropic cache hit。

## RED 与失败记录

- `command-tests-red`：旧命令为 recovery local，占位契约失败；`n-workspace-red2`：真实 /subtask 尚不存在。
- `ui-tests-red2`：旧路由实际 Ink 输出完整 worker 说明，没有 fork glyph；修复后有效模板折叠，改写模板继续走 UserPromptMessage。
- `status-resume-red`：具名 fork 公共状态返回 completed，官方实际为 idle。
- `resume-model-red2` 与 `n-workspace-r1`：全局 Haiku 覆盖导致恢复模型偏离 Sonnet；原 ID 仍相同。修复明确采用 fork 的主对话模型。
- 早期官方探测保留：误选会话标题请求导致 system 比较失败；多行 draft 显示 Pasted text marker；普通文本 renderer 没有显示改写的那一行，最终通过保留的 Hard rules/原 directive 和缺失 collapsed glyph 判定正常文本路由。没有扩大 deadline 或删除失败日志。
- `candidate-check1` 的 readonly map 类型问题已修复。`candidate-check2` 虽命令退出 0，但运行时有本方源码编辑，sourceUnchanged=false，所以不作为最终通过证据。

## 尚未完成的边界

- **全局关闭后台任务的 SendMessage 恢复**：额外试验 `n-official-o8off` 同时设置 FORK_SUBAGENT=0 和 DISABLE_BACKGROUND_TASKS=1。官方恢复同步交回 report，没有第二条异步通知，因此该试验的通知断言失败，保留为 failed harness trial；这不是仅关闭自动 fork 的配置。Source-confirmed：本地 SendMessage 当前调用后台恢复分支，两者尚有差异。本批未将该配置的恢复兼容性标为 passed，后续需独立实现和 binary 验证。
- **Workflow**：两个相邻入口均实际尝试，但本地模型工具目录中没有 Workflow/WorkflowTool，结论为 not covered；runtime observed/exit 0 不替代这一缺口。
- 默认 `/fork` 的独立后台会话、agent view 与其命令映射、agent 面板交互、权限弹窗、model-ended 会话分支、冷恢复、多配置下所有后台行为、完整 G5、全量 suite、所有 Mods 声明及官方 diff viewer 不属于本批已完成的证明。协调模式和状态临界值为自动化/源码证据，未宣称实际终端覆盖。
- 本次由假 API 触发真实 CLI/Agent/TUI；不证明真实模型服务行为、Anthropic 缓存命中或整体 UI 视觉一致。

保存 Git 基线和保护文件 checksum；ROOT 原有二进制、fix-instructions.md、improvment.md、response.md 及旧 diff zip 不应因构建或提交被改写。分批提交使用候选 patch，保留其余 Claude 的 WIP。
