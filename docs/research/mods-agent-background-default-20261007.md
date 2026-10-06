# Ordinary Agent background defaults (2026-10-07)

本批独立修复普通 Agent 未传 `run_in_background` 时的默认执行模式，以及 Mods 回调、执行和任务元数据的不一致。候选从签名提交 `c2253ec12e2af1ae83ab391aedd1338fd12ca9b1` 建立；ROOT 保留其他 Claude 的 278 项改动。只提交本功能。

## Source and contract

- Source-confirmed：官方 2.1.292 的 `chunk-77d4ky2c.ro` 对普通调用省略后台参数时默认异步。显式 false 保持前台，定义 background true 可要求异步；进程内 teammate 不适用隐式异步，内置 web-fetch helper 排除隐式路由。禁用后台覆盖普通本地路由。
- 本地在 AgentTool 中共享模式计算。Mods `agent.spawn` 得到解析后的 background 值；回调改写后重新计算执行，任务 metadata.isAsync 与 runAgent.isAsync 相同。Agent schema 和模型提示同步说明默认值。
- Source-confirmed：`chunk-pwkr374y.MZ/XLo/YLo` 的官方 fork 门禁是会话默认与环境覆盖，并非本地旧的编译门禁。完整 fork 默认值、headless/innerCall 分类与相关入口未在本批迁移。前批说明已追加修正。
- 官方 latest 本轮仍为 2.1.292：[Anthropic package registry](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)。概念与配置参考 [Anthropic subagents](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background)。更细运行规则以本地授权提取的当前 native 模块及真实终端结果为证据。
- `source-evidence.json` 保存模块 SHA256、符号和片段来源；原始提取 JS、二进制和请求日志仅保留于临时目录，没有发布。

## RED and repairs

- candidate-red-tests：隔离子进程 4 pass / 5 fail，复现省略后台参数的同步执行及回调仍看到 false；顶层 0 pass / 1 fail。
- 修复前 ROOT 本轮 make build 成功；native-workspace-red1 在保持子任务响应未放行时无法观察提前回执，failed，原始证据保留。
- candidate-green-tests1：Bun 不允许在 && 表达式中调用 feature；改为支持的 ternary，未更改断言。
- candidate-green-tests2：旧前台转后台夹具省略后台参数，因此已自动后台；夹具明确传 false，保留重启、进度、完成/失败等原断言。
- candidate-check1：web-fetch 测试定义不满足 CustomAgentDefinition 的 getSystemPrompt 签名；修正夹具类型，没有添加类型忽略。
- native-candidate-c1：默认路由、提前回执和回调已经符合预期；临时目录过长让 UDS 回退到沙箱外，SendMessage 未启用。c2 在启动前长度检查中拒绝；缩短驱动目录后重新执行全部断言，不放宽沙箱、超时或恢复条件。早期 o1/o2 证据保留，最终比较使用相同驱动的 o3/c3/r1。

## Bun / Make results


| Check | Exit | Source SHA256 | Outcome |
|---|---:|---|---|
| candidate-final-tests | 0 | d028a8c0affbe54f3aec67608ae3dbb5394a6c94116bca5f49cd8aa72f0512c0 | 14 pass / 0 fail |
| candidate-prompt-tests | 0 | a64024a34785e8cf54d6790d8e96e5797d590ee3c49cd18e52b3649d990b4348 | 5 pass / 0 fail |
| candidate-nesting-tests | 0 | a64024a34785e8cf54d6790d8e96e5797d590ee3c49cd18e52b3649d990b4348 | 0 pass / 0 fail; standalone assertion script passed (not zero coverage) |
| candidate-build1 | 0 | d028a8c0affbe54f3aec67608ae3dbb5394a6c94116bca5f49cd8aa72f0512c0 | passed |
| candidate-final-check | 0 | d028a8c0affbe54f3aec67608ae3dbb5394a6c94116bca5f49cd8aa72f0512c0 | 5 pass / 0 fail |
| workspace-main-tests | 0 | bea5d28641e69bbbade0013447ce40f387f2cc040ca6630a4801dd4cd5eab199 | 14 pass / 0 fail |
| workspace-prompt-tests | 0 | bea5d28641e69bbbade0013447ce40f387f2cc040ca6630a4801dd4cd5eab199 | 5 pass / 0 fail |
| workspace-nesting-tests | 0 | bea5d28641e69bbbade0013447ce40f387f2cc040ca6630a4801dd4cd5eab199 | 6 pass / 0 fail |
| workspace-build1 | 0 | bea5d28641e69bbbade0013447ce40f387f2cc040ca6630a4801dd4cd5eab199 | passed |
| workspace-check1 | 0 | bea5d28641e69bbbade0013447ce40f387f2cc040ca6630a4801dd4cd5eab199 | 5 pass / 0 fail |

Exact command/environment and before/after manifests: each check directory contains start.json, result.json and log.txt. Tests use bun test --no-env-file; build uses make build CLAUDE_CODE_BUILD_DIR=...; checks use make release-check. Candidate prompt/nesting checks precede only the changelog addition; all runtime-code hashes are identical to candidate-build1. The final core tests, build and release-check share the final manifest. ROOT tests/build/check share one manifest.

New routing regression: two isolated child processes, with background enabled/disabled, each covering eleven lifecycle cases. ROOT has 25 top-level Bun pass / 0 fail across the scoped groups, plus standalone assertion scripts; candidate has 19 / 0 plus standalone scripts.

- candidate binary: `/private/tmp/mods-agent-default-background-20261007-3ygzdx47/candidate-build1-output/built-claude`; 102067682 bytes; SHA256 `5923717e75c350de33d354ec482699bce68ce02e0511425263430df45461d9c4`.
- workspace binary: `/private/tmp/mods-agent-default-background-20261007-3ygzdx47/workspace-build1-output/built-claude`; 101952098 bytes; SHA256 `b09b89544623e2bce6301fed466d0b34c493e51e9a073b6a95240be8c3bdc582`.

## Scripted tmux results

| Run | Entry | Stable agent ID | Requests | Scope / evidence |
|---|---|---|---:|---|
| n-official-o3 | ordinary / adjacent | adb40cbc973348b39 | 41 | ordinary assertions passed; Workflow passed; /private/tmp/mods-agent-default-background-20261007-3ygzdx47/n-official-o3/evidence |
| n-candidate-c3 | ordinary / adjacent | aa58103aba8f721b1 | 42 | ordinary assertions passed; Workflow not covered; /private/tmp/mods-agent-default-background-20261007-3ygzdx47/n-candidate-c3/evidence |
| n-workspace-r1 | ordinary / adjacent | a22dd43a975abcccc | 42 | ordinary assertions passed; Workflow not covered; /private/tmp/mods-agent-default-background-20261007-3ygzdx47/n-workspace-r1/evidence |
| n-official-b1 | background SkillTool / guards | a705fa693c510874f | 23 | background / recursion / three guards passed; /private/tmp/mods-agent-default-background-20261007-3ygzdx47/n-official-b1/evidence |
| n-candidate-b2 | background SkillTool / guards | aeb4343ac39c92c95 | 25 | background / recursion / three guards passed; /private/tmp/mods-agent-default-background-20261007-3ygzdx47/n-candidate-b2/evidence |
| n-workspace-b3 | background SkillTool / guards | a8996b25b5af05d13 | 25 | background / recursion / three guards passed; /private/tmp/mods-agent-default-background-20261007-3ygzdx47/n-workspace-b3/evidence |

| Assertion | Required evidence | Outcome |
|---|---|---|
| D1 omitted flag launches before child settles; hook true | same-run held API, model tool result, BOUND_SPAWN, pane | passed on official / candidate / ROOT |
| D2 explicit foreground, no restart after Ctrl+B | held foreground API, key input, one worker request and notification | passed on all three |
| D3 capacity, nested refusal, sync fork slash/Skill | same-run tool results, API counts, markers/model and no denied worker | passed on all three |
| D4 SendMessage resumes same ID/model once | actual tool call, transcript, task/debug and one resumed API request | passed on all three |
| D5 background fork owns child and resumes once | actual SkillTool, public running/waiting list, child barrier, original ID and final notification | passed on all three |
| D6 recursive skill and missing/malformed/oversized scope refuse without worker launch | actual tools, refusal results, API absence | passed on all three |
| D7 Workflow uses Agent | actual model catalog and tool results | official passed; candidate/ROOT not covered: tool absent |
| D8 no leaked processes, duplicated notifications or cost mismatch | final transcript, exit0, cost totals, API closed and owned PGIDs absent | passed for all six final runs |


## Evidence boundaries and remaining work

- 默认后台、回调模式、既有普通通知/恢复和相邻后台技能断言 passed；共享入口矩阵中的本地 Workflow 为 not covered。因此不能把整个 Agent/Workflow 验收或完整 Mods/API/上下文/UI/diff 兼容性标记为完成。
- 实际终端的普通/同步 fork 流程显式设置 CLAUDE_CODE_FORK_SUBAGENT=0，以隔离默认后台规则与尚未迁移的 fork 门禁；两侧环境等价。后台技能对照没有这一覆盖，子 Agent 两侧明确传 true。
- 禁用后台、进程内 teammate 和内置/用户 web-fetch 身份由新的隔离 Bun 回归覆盖，未声称每一种组合都执行过真实终端。Mods 改写 false/true 由真实 AgentTool 生命周期的回归覆盖；本轮 native 回调记录实际输入，不改写它。
- Native targets serial；每次独立 HOME、config、XDG、tmp、160x40 终端、虚构 key、本机 API、sandbox 与 tmux socket。拒绝真实 Keychain、用户 Claude 配置、外部网络和仓库写入。只清理本驱动拥有的 PGID；不操作其他 Claude 进程。
- 辅助请求模型/数量与官方不同；每次退出时项目费用和模型用量之和一致，不声称两侧请求预算或全部 UI 文案相同。

## Git isolation

- 本批开始 ROOT index 为空；baseline.json 保存原有 278 项状态、逐文件 SHA/size/mtime 和受保护输入。
- 候选仅包含此功能；ROOT 合入时保留原有 AgentTool Mods/teammate 改动与其他 WIP。签名提交使用候选 blobs，不 stage 全部工作区。
- built-claude 原制品、fix-instructions.md、improvment.md、response.md 和旧 diff asset 的内容/mtime 均保持。新 Make 制品使用私有输出目录。postcommit.json 和 verified-signature.json 记录最终提交隔离和签名结果。
