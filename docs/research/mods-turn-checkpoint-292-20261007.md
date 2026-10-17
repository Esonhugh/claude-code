# 短轮次完成 checkpoint：官方 2.1.292 对照

本批基线为 `db6db7dea7149d8a6af757d51fd4be623777bf73`，只提交 REPL 完成记录逻辑、新回归和 README/CHANGELOG/mods-test/本记录，共六个路径。准确提交候选与工作区分别构建、验证；工作区其他未提交实现不并入候选。

## 官方来源与实际差异

2026-10-07 核对的 [npm latest](https://registry.npmjs.org/@anthropic-ai/claude-code/latest) 为 2.1.292。固定官方原生制品 SHA-256 为 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`，235017328 字节。静态提取只分析源文件，不执行提取片段；来源、偏移和完整文件/片段哈希保存在 `official-source.json`。

| 源码位置 | 核实事实 |
| --- | --- |
| chunk-03d0t1ag.js，13013 | `turn.step.messageCount` 来自请求原始 messages.length；不按公共聊天投影计数 |
| chunk-8q7p93rh.js，1364234 邻域 | 主轮次 finally 无 30 秒门槛；排除非查询/拒绝/取消，仍考虑后台延后 |
| chunk-pwkr374y.js，4416141 | `turn_duration` 是带 timestamp、uuid、messageCount、isMeta=false 的 system checkpoint |
| chunk-z5k73jc7.js，1959 | 最新完成时间显示使用 locale、timeFormat、timeZone 及日期范围格式化 |

本地旧逻辑只在耗时超过 30 秒或有 budget 时记录 checkpoint。原始 13 项回归为 **7 pass / 6 fail / 18 expect**，四个短时边界、短 swarm 延后和历史增长失败；取消、循环、budget 与长时控制用例通过。移除门槛后，首次终端观察还发现 `/exit` 也打印完成日志：它走 onQuery 的 finally，但没有模型查询。

最终增加 `didQuery`：查询前置回调允许继续后、调用 onQueryImpl 前才取 shouldQuery；非查询命令与前置拒绝不记录。取消/proactive 与 swarm 延后保持原有规则。日志位于状态 updater 外，只打印 `[turn-duration] completed elapsedMs=`，避免 updater 重跑产生重复日志，不含 prompt、回复或凭据。

checkpoint 留在原始历史中，现有 `showTurnDuration=false` 只隐藏 UI；API normalization 与公共 session.messages 不将其转换为聊天条目。本批没有改计数器，也不通过附加常数或过滤差异声称完整上下文一致。

## 自动化回归与未通过的相邻门禁

新增文件执行实际 REPL 完成语句，并执行实际查询前置 try block 与完成 guard，使用真实消息构造器、日志过滤、API normalization 和 session projection。最后 **19 pass / 0 fail / 42 expect**，包含五个时长边界、budget、取消、循环、swarm 延后/原始开始时间、投影、不查询以及前置拒绝/允许的四种组合。

所有 Bun 命令均为 `bun test --no-env-file`，独立 HOME/config/TMP/XDG、白名单环境；没有真实凭据和用户配置。八份相关文件逐文件执行，随后组合执行；命令、exit、timeout、源清单、PID/PGID 和日志分别保留。较宽门禁如实记录为 failed，不能用聚焦测试覆盖其失败。

| 逐文件命令中的源码路径 | 准确候选 pass/fail | 工作区 pass/fail |
| --- | --- | --- |
| src/screens/REPL.turnCheckpoint292.test.ts（最终） | 19/0 | 19/0 |
| src/screens/REPL.submit.test.ts | 115/2 | 124/1 |
| src/query.mods.test.ts | 113/7 | 118/7 |
| src/query.promptCompose.test.ts | 6/0 | 6/0 |
| src/services/mods/modelParent292.test.ts | 3/0 | 3/0 |
| src/services/mods/modelFork292.test.ts | 5/0 | 5/0 |
| src/services/mods/turnStepUsage292.test.ts | 2/0 | 2/0 |
| src/utils/sessionStorage.restart.test.ts | 9/0 | 9/0 |

未修改的 HEAD 加入相同初始 13 项新回归、用完全相同 argv 运行：**260 pass / 15 fail / 1236 expect**。其中六项是 checkpoint RED，另九项与首次候选组合的 **266/9/1246** 失败名称及重复次数完全一致；工作区 **280/8/1344** 的失败均在该基线集合内。最后补齐非查询 guard 和 19 项用例后再次组合：候选 **272/9/1260**、工作区 **286/8/1358**；旧失败集合不变。未新增相邻失败，不等于较宽门禁已通过。

仍失败的相邻断言：dock body width（候选独有，26/25）、rewind 的 restoreSendMessagePins 缺失依赖、turn.abort 工具取消超时、Worker 自行终止 stream、两项有效 tool input 重写、两种 executor 的 author host 上下文以及 query 中 Worker author tool 调用。基线隔离目录另对 REPL/query 组合复现旧九项失败。这些不是 response.md 原先九项逐文件清单的替代结果，也没有关闭旧清单。

| 最终检查 | 准确候选 | 工作区 |
| --- | --- | --- |
| make release-check | exit 0，39.926 秒 | exit 0，42.293 秒 |
| make build（独立输出） | exit 0，3.704 秒 | exit 0，3.666 秒 |

release-check 包括 CHANGELOG 格式及原有五项格式测试、完整 TypeScript 和 lint。最终检查、构建、组合回归均使用相同清单；源码运行前后不变、无外层 timeout、自有进程组已退出。

- candidate 源清单 SHA-256：`78053bcbb1e2e81cd779834045deb025ed853ca5538b5eb3df6404f5f3f489ef`。
- workspace 源清单 SHA-256：`b694540c757cc9b969ce8249cd996e2d7b7a656f1acb17855f7de6a828a250ce`。

## 当前制品的原生终端证据

脚本串行驱动自有 tmux stdin，保存逐字输入十六进制、ready/提交/回复/退出 pane、ANSI、PTY 原始数据、debug、主 transcript 和 loopback HTTP 请求。环境只含占位认证；文件写权限限于自有目录，禁止读取用户 ~/.claude 和系统 Keychain，网络只允许本次 localhost 模型夹具。PRIVACY_MODE=1，不设置 CLAUDE_CODE_SIMPLE 或禁用 attachment 的开关。完整副作用检查还确认两个插件原件未改、仅生成预期 12 份作者类型/config 文件、拒绝的 Bash 文件不存在、HTTP 与自有 tmux 清理完成。

| 制品/独立运行 | 二进制 SHA-256 | 普通成功 checkpoint | 取消 checkpoint | 正常退出 |
| --- | --- | --- | --- | --- |
| official/o1 | `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f` | 13 | 0（六次） | exit 0 |
| candidate/c2 | `8ace554762e1dadd9f4ce2ef5ab0ca693fe153b1b6f1701cb153952e73589183` | 13 | 0（六次） | exit 0 |
| workspace/w2 | `cacdc1ee31e2898e9d09850baf080f1becaa0d6d84c8034d1ed3cc47bf0bea69` | 13 | 0（六次） | exit 0 |

十三次成功包含 warm、六种正常完成和六次取消后的 recovery，所有 checkpoint 耗时小于 30 秒、类型与 timestamp/uuid/messageCount 正确。取消覆盖 complete/classify/fork 的 HTTP 与 Mods hook 两种等待。每侧 67 条 Mods 回执，其中 55 条模型结果/取消语义与官方严格一致；十二条 parent-enter 的 messageCount 差异单列，未隐藏。

另外 `official/oh2`、`candidate/ch2`、`workspace/wh2` 使用独立私有全局配置 showTurnDuration=false：warm 与 /cost 后的主查询均保存 checkpoint，UI 不显示完成行；/cost 与 /exit 不新增模型 checkpoint。每侧两条历史记录，本地 debug 正好两条。普通矩阵本地 debug 正好十三条，退出没有额外记录。

初次 hidden driver 错把官方 /cost 的设置页当作已返回 prompt；本地 /cost 实际输出文本，额外向空闲输入框发送 Escape 又影响紧随其后的自动输入。失败的 `official/oh1`、`candidate/ch1`、`workspace/wh1` 完整保留，不计通过。最终脚本观察实际 cost 页面/输出，仅在官方对话框发送 Escape，等待 prompt 后再输入。两种 /cost UI 和流程目前不同，不能声明该相邻 UI 与官方相同；最终隐藏行矩阵按各自真实流程验证 checkpoint。最终通过的矩阵各自串行完成，不拼接失败尝试的片段。

初次候选 c1/工作区 w1 的短轮次结果曾出现十四条日志（多出的 /exit）；它们绑定旧 build1，只作缺口证据。正式 c2/w2 使用本轮最终 build2，十三条日志且退出正常；不复用旧制品作为最终验收。

## 保留的完整上下文与 UI 差异

| parent-enter 场景 | 官方 messageCount | 候选/工作区 messageCount |
| --- | --- | --- |
| complete-done | 15 | 7 |
| classify-done | 19 | 10 |
| fork-done | 23 | 13 |
| complete-http | 27 | 16 |
| classify-http | 31 | 21 |
| fork-http | 35 | 26 |
| complete-hook | 39 | 32 |
| classify-hook | 43 | 37 |
| fork-hook | 47 | 42 |
| fork-empty-done | 52 | 47 |
| fork-api-done | 56 | 50 |
| fork-tool-done | 60 | 53 |

官方拥有 environment/model/total_tokens_reminder/session_context/date/remote_session_change/prompt_snapshot 等新历史生产路径；本地仍缺少多项，且许多现有附件不落盘。cancel/rewind 后持久化 transcript 的全部行也不能当作当前内存历史长度。完整 API 请求正文与 fork 快照内容相同尚未证明；不能由 55 条结果回执一致推导上下文一致。

原生 warm pane 显示官方 `for 0s · done …`，本地 `for 0s`；日期/locale/timeFormat/timeZone 尚待对齐。官方实际 ui.render 挂载 TurnDuration 并传入 word/durationMs，本地只有声明，通用原生挂载尚缺；待处理 pending background agent/workflow 与 detached-tool 延后路径。swarm 延后本批只作源码回归，不声明其完整原生后台流程通过。

因此 checkpoint 新契约通过；包含相邻回归的整体门禁仍为 failed，完整 Mods 兼容未完成。其他 API、类型定义、UI、官方 diff viewer、G5 的真实入口及全量/HEAD 门禁继续开放。本次按用户明确的增量提交要求独立提交，不发布或 push。

## 证据索引与并发保护

证据根目录：`/private/tmp/mods-turn-checkpoint-292-20261007-6lrnaww5`。

- official-source.json / official-source/：固定官方源码来源、偏移与哈希。
- candidate-red-checkpoint/、candidate-green-checkpoint/、*-checkpoint2/、*-checkpoint3/：原始 RED、初次绿色、边界补充及最终聚焦回归。
- baseline-related1/、baseline-repl-query1/、*-single-*/、*-related1/、*-related2/、adjacent-failure-comparison.json：基线、逐文件及组合的原始失败/最终结果。
- *-check2/、*-build2/、*-build2-output/：准确最终源清单、检查及新构建，不覆盖共享 built-claude。
- native-*/evidence/：独立原生输入、pane、debug、请求、制品身份及自有进程清理；失败尝试也保留。
- native-comparison.json、checkpoint-native-assertions.json：55 条回执严格对照、十二条计数差异、六个正式运行的 checkpoint/UI/非查询断言。
- before.json / before-source/、owned-diff-proof.json、preservation-final.json：原文件及其前像；准确候选补丁应用于工作区前像后逐字一致，既有 WIP 未被替换。
- commit-plan.json / candidate.patch / commit-verification.json：六路径候选 blob、准确暂存树、签名及提交前后文件核对。

保留另外两条既有 Claude 进程及共享 official-claude/built-claude。只管理本次新启动的 PID/PGID/socket，不向其他进程发送输入或信号。
