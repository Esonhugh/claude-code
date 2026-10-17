# Explicit fork mode alignment (2026-10-07)

本批提交 Agent 的显式 fork 路由与模式门禁。整体 Mods 兼容目标仍 active，以下 passed 只覆盖声明的断言。

## 来源与实现

- Source-confirmed：2026-10-07 查询 npm latest 为 2.1.292；[registry](https://registry.npmjs.org/@anthropic-ai/claude-code/latest) 与 [Anthropic fork 模式说明](https://code.claude.com/docs/en/sub-agents#turn-fork-mode-on-or-off)。原始 native 二进制及授权提取模块保留于临时证据，不执行提取 JS、不提交完整官方源码。
- Source-confirmed：chunk-pwkr374y.js 的 YLo/XLo/MZ/IGr 决定交互默认、环境覆盖和会话 latch；chunk-77d4ky2c.js 的 Bn/Cn/Nn/ro 处理显式类型、脚本入口、允许/deny/遮蔽、缺失默认类型、递归/remote 与后台规则。chunk-03d0t1ag.js 的 exact-tools 分支直接继承父工具定义。模块 SHA 和定位片段见证据根 source-evidence.json。
- 本地将省略类型固定为 general-purpose，显式 fork 才共享历史与系统提示；Mods spawn 的 innerCall 是调用标记，createSubagentContext 不继承它。后台执行、事件和日志使用相同判定。
- schema 缓存变体而非导入期的交互判定；fork 模式隐藏 run_in_background，Agent 即时可调用。显式关闭与协调模式优先，会话切换重置 latch。
- fork 模型忽略工具参数及全局子 Agent 覆盖，按父会话权限模式和超过 200k 的真实 usage 边界解析。相关 planning 分支由 Bun 回归覆盖，本轮 tmux 使用 bypassPermissions，未宣称终端覆盖所有 model/mode 组合。
- exact-tools 保留所有父定义；普通 Agent 继续过滤目标工具，fork 调用 SetGoal/ClearGoal 仍由 validateInput/call 拒绝。旧过滤断言改为新的缓存契约，并增加真实调用拒绝断言，既有 SetGoal/ClearGoal 状态保护测试保留。

## RED 与诊断

- candidate-red-tests2：新回归在旧实现中六种环境的顶层 wrapper 均失败，重现门禁、显式类型和默认选择差异。首轮拒绝路径等待启动导致测试超时，改为同时观察真实启动和失败，不提高期限。
- candidate-model-red：全局 Haiku 覆盖改变 fork 模型；candidate-plan-red：子权限 bubble 导致规划父会话的 Opus 模型丢失。保留失败输出后修正生产解析。
- schema 导入期提前缓存使交互启动后仍显示后台字段；修正缓存选择。类型检查发现测试自定义 agent 的 prompt 签名与 readonly permission 字段错误，修正夹具，不添加类型忽略。
- native-workspace-red1：本轮修复前 Make 制品实际报告 background:false，与官方交互默认不同。
- n-candidate-c1：本地 exact-tools 移除两个 Goal 定义，真实父子 schema 不同；已修正生产路径，未放宽工具一致断言。
- 早期官方驱动分别误用了旧子流屏障、比较了子 Agent 账单头、把 fork 占位结果当启动回执。最终驱动只精确排除官方 billing header 的 cc_is_subagent 标记；所有实际系统提示及工具定义仍逐项比较。
- n-candidate-c2：通知计数包含 sidechain 的继承历史副本。最终计数绑定 isSidechain:false 与真实主 session ID，不把历史持久化计为重复主通知。规划大 usage 夹具最初仍是 synthetic model，改为真实模型标识后验证 200k 边界。所有早期记录保留，未扩大超时或放宽沙箱。

## 最终自动化与制品

Evidence root: /private/tmp/mods-fork-mode-i107eh4x

| Check | Exit | Outcome | Source SHA256 |
|---|---:|---|---|
| candidate-tests-final5 | 0 | 25 pass / 0 fail | f84583ba2dde970e50bc9371877ef7ea19fdde54a58b276e1f173d0f7143bbfd |
| candidate-adjacent-final5 | 0 | 5 standalone assertion scripts passed | f84583ba2dde970e50bc9371877ef7ea19fdde54a58b276e1f173d0f7143bbfd |
| candidate-check-final5 | 0 | passed | f84583ba2dde970e50bc9371877ef7ea19fdde54a58b276e1f173d0f7143bbfd |
| candidate-build5 | 0 | passed | f84583ba2dde970e50bc9371877ef7ea19fdde54a58b276e1f173d0f7143bbfd |
| workspace-tests-final3 | 0 | 25 pass / 0 fail | 4e62685f98a8984de3709a33ca50734c1cc4963878e91c4b6feaecc65c957ec7 |
| workspace-adjacent-final3 | 0 | 6 pass / 0 fail plus 5 standalone assertion scripts | 4e62685f98a8984de3709a33ca50734c1cc4963878e91c4b6feaecc65c957ec7 |
| workspace-check-final3 | 0 | passed | 4e62685f98a8984de3709a33ca50734c1cc4963878e91c4b6feaecc65c957ec7 |
| workspace-build3 | 0 | passed | 4e62685f98a8984de3709a33ca50734c1cc4963878e91c4b6feaecc65c957ec7 |

Fork regression uses six isolated child processes, each executing eleven scenario tests (some guards only apply in enabled variants); top-level Bun counts wrappers separately. No new skip, timeout increase or production ForTesting helper. Exact commands, environments, manifests and logs are in each named check directory.

- candidate: /private/tmp/mods-fork-mode-i107eh4x/candidate-build5-output/built-claude; 102067682 bytes; SHA256 a740fab21db71b38f0578c2d622dd7d24e4fbef8c29c866f34e7c32b4cda3a04.
- workspace: /private/tmp/mods-fork-mode-i107eh4x/workspace-build3-output/built-claude; 101968610 bytes; SHA256 a581d9ef1bab8bf6e22d6e7643c8918054a4c5c18f4e11d53a965276aab64b1c.

## Scripted tmux

| Run | Entry | Stable agent ID | API requests | Runtime / validation |
|---|---|---|---:|---|
| n-official-o6 | explicit Agent + Mod fork | a025cfb978c9d0113 | 12 | done / scoped assertions passed |
| n-candidate-c3 | explicit Agent + Mod fork | a5f1cb8aa23ea434b | 14 | done / scoped assertions passed |
| n-workspace-r1 | explicit Agent + Mod fork | a4687e67c8a0a6a55 | 14 | done / scoped assertions passed |
| n-official-oa1 | ordinary / nested / foreground / resume / Workflow attempt | a2908c3e207f4df8a | 41 | done / scoped assertions passed; Workflow passed |
| n-candidate-ca1 | ordinary / nested / foreground / resume / Workflow attempt | a58b71d5fa36460f6 | 42 | done / scoped assertions passed; Workflow not covered |
| n-workspace-ra1 | ordinary / nested / foreground / resume / Workflow attempt | a98d648854b293815 | 42 | done / scoped assertions passed; Workflow not covered |
| n-official-ob1 | background Skill + three guards | a41de1975d9a415c8 | 23 | done / scoped assertions passed |
| n-candidate-cb1 | background Skill + three guards | ac524467dd2364f4c | 25 | done / scoped assertions passed |
| n-workspace-rb1 | background Skill + three guards | ac017d03ee4748800 | 25 | done / scoped assertions passed |

Each row evidence: /private/tmp/mods-fork-mode-i107eh4x/RUN/evidence/result.json, requests.json, source/*.txt, source/*.ansi, source/debug.log, inputs and driver-used.py.

## 断言与边界

| ID | Predicate / required evidence | Verdict |
|---|---|---|
| F1 | 交互默认，schema 隐藏后台字段；省略类型用 general-purpose，真实 hook/background 与子 API 匹配 | passed，三侧 gate 运行及六环境 Bun 回归 |
| F2 | 显式 fork 继承父历史、模型、实际系统提示和所有工具定义；忽略参数及全局 Haiku 覆盖 | passed，三侧同次父/子请求和启动回执 |
| F3 | 递归 fork 拒绝且零被拒子 API；allow/deny/遮蔽/remote/缺失默认类型拒绝 | 递归 passed（三侧真实终端）；其他边界 passed（Bun），未全部终端触发 |
| F4 | 真实 Mods script spawn 走 fork，保留父历史/模型，拥有自己的完成结果 | passed，三侧 command.run / spawn / turn.complete |
| F5 | 普通与 fork 主通知各一次，Mod fork 不重复通知主会话；退出费用、进程组、API 和制品无副作用 | passed，三侧主 transcript、保存费用及 cleanup |
| F6 | 并发、nested、同步 fork slash/Skill、前台转后台和原 ID SendMessage 恢复 | passed，三侧 adjacent 运行 |
| F7 | 默认后台技能等待子任务、原 ID 自动续跑、递归及三项权限记录拒绝 | passed，三侧 background-skill 运行 |
| F8 | Workflow 实际调用 Agent | 官方 passed；本地 not covered，真实模型工具目录未暴露 Workflow/WorkflowTool |

原生门禁对照未设置 FORK_SUBAGENT，并设置全局 SUBAGENT_MODEL=haiku；相邻前台场景两侧都设置 FORK_SUBAGENT=0；后台技能两侧不设置 fork override。各三侧的对应驱动/环境相同，只替换二进制。输入、160x40 pane、debug、请求、任务身份、最终状态和副作用均来自同一次运行。私有 HOME/config/XDG/TMP、虚构 key、本地 API 与沙箱禁止读取真实凭证、Keychain、外网及仓库写入，只清理驱动所属 PGID。

共享入口矩阵因本地 Workflow 缺失整体仍 not covered；/fork 原生命令、fork boilerplate 折叠 UI、完整 agent listing/UI、G5、全量 suite、cold resume 故障矩阵和完整 Mods/API/context/diff 目标继续，不能由本批推导为全部兼容。历史 response.md / fix-instructions.md 的整体验收条件未被声明完成。

## Git 隔离

从 26f97ae 创建独立候选，基线保存 ROOT 的 278 项 WIP。只提交本功能的候选 blobs，ROOT 原有重叠修改保留；签名提交后由 postcommit.json 核对 index、ROOT 字节/mtime、原 WIP 和受保护文件。旧 built-claude、improvment.md、fix-instructions.md、response.md 与旧 diff asset 保留，新制品写入私有目录，不操作其他 Claude 进程、不 push。
