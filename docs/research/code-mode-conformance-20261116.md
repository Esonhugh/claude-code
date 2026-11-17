# Code Mode 与官方 2.1.325 的一致性检查

- **类型**：一致性检查报告
- **日期**：2026-11-16
- **方法**：[`.claude/skills/code-mode-conformance`](../../.claude/skills/code-mode-conformance/SKILL.md)
- **相关**：[实施计划](../plan/code-mode.md) · [官方实现分析](code-mode-325-20261115.md) · [功能说明](../features/code-mode.md)

## 基准

- 本地：`code_mode` 分支。逐项检查在 `717d698b`（产品代码与 `759c305a` 相同）上进行；第一轮发现的缺陷在 `90df295e`…`4b27ac4d` 修复，C/D 维度的 4 个缺陷在 `65d93a80`…`4117d7d8` 修复，L3 发现的后台执行差异按官方方式移植（`545c12f5`…`e1cbf885`），回合中 Esc 的中断记录在 `2842064a` 修复。修复后的结论在下面的「缺陷与处理」里逐条对应。
- 复核二进制：`vfy4-*` 用 `e1cbf885` 构建的 `./built-claude` 2.1.297（`1dad3e6a` 之后没有改 `src/`）；`vfy5-*` 用 `2842064a` 构建的 `./built-claude`，sha256 `905f91a135eb1ed109924bd44222b3976b840bd27c68bf4c662cb8888c151072`。
- 官方：2.1.325 darwin-arm64，sha256 `84590fefe6338be9087f5814b61f9a54c5f21524163a4c127cb5a808e31009f2`，拆出 3312 个模块；锚点 `g61t94xb:N` 指 [`recover/claude-v2.1.325-code-mode/pretty/chunk-g61t94xb.js`](../../recover/claude-v2.1.325-code-mode/README.md) 的行号，其他 chunk 是 minified 模块，按函数名定位。
- 证据等级：
  - **L1**：官方 bundle 静态阅读和字符串比对，A、E 维度全部、B/G 的锚点。
  - **L2**：`built-claude` 接测试用假 API（`mock-api.ts`），用 tmux 驱动真实交互界面，B、C、D、G 维度和 E 的 transcript 形状；F 维度在 `bun test` 下跑真实执行器和 `runToolUse`。
  - **L3**：官方 2.1.325 二进制接同一假 API、用同一套场景驱动，见「L3：官方二进制对照」一节。

## 汇总

| 维度 | 内容 | 项数 | 一致 | 有意不同 | 缺陷 | 未验证 |
| --- | --- | --- | --- | --- | --- | --- |
| A | 模型可见内容：工具定义、prompt、d.ts、错误文案 | 61 | 29 | 3 | 23 | 6 |
| E | transcript 和 resume（静态） | 10 | 4 | 1 | 4 | 1 |
| B | 脚本运行语义（L2 + L3） | 20 | 12 | 1 | 7 | 0 |
| G | 子代理、压缩、恢复、启动提示（L2） | 10 | 8 | 1 | 0 | 1 |
| F | 内层调用的权限、hook 与隔离 | 10 | 9 | 0 | 0 | 1 |
| C / D / E / G | 权限对话框、规则、hook、子代理、transcript 形状、稳定性（L2 补充） | 27 | 19 | 2 | 4 | 2 |

缺陷合计 40 项，按根因归成 24 组：21 组已修复，2 组部分修复（第 11 组 E02、第 21 组），1 组未修复（第 13 组）。第 13 组的 A13、E09 按设计保留，记在功能说明的「与官方的差异」里；第 20–22 组（A61、计时器迟到宽限、A32）是 L3 之后新发现或仍有差异的部分；第 23、24 组是用同一场景给官方和本地截图时发现的界面差异（见「L3：官方二进制对照」的界面对照），不在上表的项数里。

## 缺陷与处理

| 组 | 项 | 现象 | 处理 |
| --- | --- | --- | --- |
| 1 | A29、A08、A09、A17、A18、A22 | Poll、async 文本、MODE_CHANGE 段、async d.ts、去掉 `run_in_background` 在所有模式都开；官方只在会话以 auto / bypassPermissions **启动**时开（`x0o = le() && oZ(e) && jy()`） | 已修复 `90df295e`：启动时记录模式（`noteReplLaunchPermissionMode`），`isReplEventDeliveryEnabled()` 决定 Poll 和这些文本 |
| 2 | A04 | prompt 开头恒为 `Your one tool is REPL`，工具列表里却有 Poll | 已修复 `90df295e`：按官方 `${M ? "Your two tools are …" : "Your one tool is …"}` |
| 3 | A53、A54 | 脚本结束时仍在跑、没有 `await` 的调用没有提示 | 已修复 `9eb100aa`：结果末尾追加 `⚠ N tool call(s) still running at script end …` |
| 4 | A19 | d.ts 的 `$` 结果类型保留 `unsandboxedRetry` | 已修复 `044d63d7` |
| 5 | A45、A46、A47 | 墙钟超限只有一种文案，没有「调用卡在等待运行」的变体和 watchdog | 已修复 `824a6eda`：按官方 `ju()` 的三种变体和 watchdog |
| 6 | A48 | 单脚本 50,000 次调用上限的文案和之后的行为不同 | 已修复 `125917b0`：官方文案，只抛一次，之后的调用不再应答 |
| 7 | A41 | 子代理调 Poll 时的后缀文案 | 已修复 `3965d56a` |
| 8 | A14 | MCP 服务器行上限写成 10 | 已修复 `4b245c81`：官方 `Gl = 40` |
| 9 | A31 | Poll prompt 改写超出注释说明的范围 | 已修复 `c0c505fa`：恢复官方开头句和 t_a 末尾两句 |
| 10 | E07、E08 | 关闭开关 resume 时缺 `eval #N never settled …` 行；移出提示缺 `(experimental)` | 已修复 `b472a69b` |
| 11 | E02 | 虚拟 tool_result 的 `is_error` 只在出错时写 | 部分修复 `c2ce8beb`：`is_error` 恒写；`toolDenialAfterRun`、`sandboxViolations`、`sandboxed` 未加，这些消息不发给 API，只影响 transcript |
| 12 | B「回合间 Esc」 | 派发时内层 Bash 还在跑，回合之间按 Esc 停不了脚本 | 已修复 `4b27ac4d`：脚本里的调用拿到 `setToolJSX: undefined`，BashTool 不再把 BackgroundHint 留在界面上挡住 Esc |
| 13 | A13 | REPL prompt 缺 skill 列表 | 未修复：skill 列表要接本地 skill 加载流程，单独做 |
| 13 | E09 | 开关打开时 resume 普通会话，官方提示并继续用普通工具；本地整个进程是 Code Mode | 未修复：本地工具列表在启动时一次确定（D3），按会话切换要改工具池的生命周期 |
| 14 | G「resume 时没结束的 eval（开关 on）」（D-1） | 开关 on 时 resume，上次没结束的 eval 没有 lost 事件，模型不知道结果已丢 | 已修复 `65d93a80`：按官方 `qKa` 注入 `status="lost"` 事件；`d48d9451` 让它走 poll-event 队列、不唤醒 Claude；`1dad3e6a` 不再把已送达的 eval 当成丢失 |
| 15 | C「内层调用对话框的组件」（D-2） | 内层 Bash、Edit 的权限框退化为通用 "Tool use"，Edit 没有 diff | 已修复 `31489a6b`：内层调用不再复制工具对象，计数改走 context 回调 `onReplToolCall` |
| 16 | D「子 agent 工具解析为空」（D-3） | 工具解析为空的子 agent 被启动 | 已修复 `a69326e6`：按官方文案 `Agent '…' would be spawned with zero tools — refusing. …` 拒绝 |
| 17 | D「REPL 脚本里启动的 fork」（D-4） | REPL 脚本里启动的 fork 拿不到 REPL/Poll | 已修复 `4117d7d8`：内层 context 带上会话工具 `replSessionTools`，fork 路径用它 |
| 18 | A11、A20、A30、B「async lane」4 项 | L3 证实官方的 detached lane 一直开着（见「L3：官方二进制对照」）：有 Poll 时每个 REPL 立即返回回执，结果在同一轮由 Poll splice 送回；本地是 30 秒 settle 窗口，没有 `zl()` 文本、`running()`、nonce manifest | 已修复，按官方移植 12 步：`545c12f5` ledger、`da429370` 状态文案、`ccbf1c75` poll-event 队列、`d071b354`+`b5a50f96` nonce manifest 与 splice、`0ec2de1e` 折叠、`8bed0b30` 工具调用后等待（Bu）、`a0f8c310` 始终派发、`bdb005ca` `zl()`/`running()`/Poll 说明、`a0a531e6` Esc、`d48d9451` lost 事件、`bf04f4f8` 删掉 settle 窗口、`07bdb0ed`+`e1cbf885` 场景；`1dad3e6a` 补 resume 和 splice 内层行 |
| 19 | B「回合中 Esc 停掉后台脚本」 | Esc 打断工具调用后的等待时，官方这一轮记 `[Request interrupted by user]`，本地直接结束、没有这条记录 | 已修复 `2842064a`：循环开头刷新上下文时不再抛出 user-cancel；一次迭代开始时已被中止，就按官方写入 `[Request interrupted by user]`，以 `aborted_streaming` 结束 |
| 20 | A61 | 脚本超时或抛错时，官方在错误后加一句 `The script was stopped partway through: …` / `The script threw partway through: …` 和已完成调用的计数，本地没有 | 已修复 `b1bd9e7f`：按官方 `nOi` 移植 `partwayNote`（`stopReport.ts:72`），执行器在脚本抛错、超时或被停后接在错误后面；语法错误和停止报告不接。`vfy6-L3x` 第 1 次 eval 的错误和官方逐字相同 |
| 21 | B「预算计时迟到宽限」 | 官方 `sleep(33000)` 正常返回结果，本地在 30 秒超时 | 部分修复 `15265d59`：按官方 `ic` 移植 `scriptDeadline`（`host.ts:294`），计时器迟到超过 1000 ms 时一次性改为 5000 ms，单元测试覆盖。但 L3 的 LATE 探针仍不同（`vfy6-L3x` 第 3 次 eval 30003 ms 超时，官方 33007 ms 返回 `late-inline`）：官方计时器准时触发时 `ic` 不给宽限，所以这个结果不是 `ic` 带来的，原因没有找到（候选是官方经宿主桥接的 `sleep` 和 `sc` 的 pauseForOthers/charge，都未确认） |
| 22 | A32 | Poll 输出 schema 少 `media`、`toolsUsed`、`provenance`、`declared` 4 个字段；`<tools-used-before-summary>` 行（官方 `Itn`）没有内容 | 已修复 `3e332cb7`：schema 补齐 4 个字段（官方 `Iso`）；按官方 `Itn`/`yNt` 移植 `toolsUsedForDelivery`（`toolsUsed.ts:95`）：`runToolUse` 找到工具后记进会话的 tools-used 记录（官方 `oca`），poll 事件入队时带上，delivery 只列消息里还看不到的名字；`poll_events` 附件和 Poll 结果都带 `provenance`。`media`、`declared` 只有 schema：本路径上没有事件带这两项。`vfy6-L3x`、`vfy6-B-asyncx`、`vfy6-WAKE` 每次 delivery 的 tools-used 行和官方相同（L3x 只有第 1 次 `REPL`；B-asyncx 第 1 次 `REPL`、第 2 次 `Bash`；WAKE `Bash, REPL`） |
| 23 | 界面「Ctrl+O 里的 REPL 行」 | 官方在详细记录里显示 `⏺ Code(Count TODOs under src) · 3 lines (ctrl+e to show)`，按 Ctrl+E 后在 `⎿` 下显示高亮的脚本源码，不显示脚本的返回值；本地显示没有括号的 `⏺ Code`，下面是不缩进的返回值，Ctrl+E 不改变它 | 已修复 `90c2bcbb`：按官方 `ScriptSourceRow`（chunk-eh1rf8gd.js）移植 `src/tools/REPLTool/ScriptSourceRow.tsx`，包括行数统计和官方 `U` 的控制字符转义；REPL 去掉结果渲染（官方结果渲染对 transparent wrapper 返回 null）。没有移植：按行展开（官方 `eAn(toolUseId)` 键、全屏下的点击和 `[`）和 `uN` 的可见性冻结，只有全局 Ctrl+E |
| 24 | 界面「后台脚本运行时的等待」 | 官方 spinner 为 `Gesticulating… (Run the slow build · 4s · ↓ 38 tokens)`，页脚为 `bypass permissions on · 1 background task · esc to interrupt · ↓ to manage`；本地 spinner 没有脚本说明，页脚没有后台任务 | 已修复 `ea342f7b`：按官方 `ros`/`kpe`（chunk-h2wk9qp9.js、chunk-aay5maza.js）在 spinner 里显示最先运行的脚本说明（截到 48 列，多个时加 ` +N more`）；`7c74f63c`：按官方 `registerScriptTask`/`endScriptTask`（chunk-x5qyz3j2.js）把运行中的脚本登记为 `local_script` 后台任务，页脚计数、`↓ to manage` 和任务对话框沿用已有的后台任务界面，退出提醒和 stop hook 里标为 `code`（官方 `AUe`）。没有移植：`kpe` 的密钥脱敏（文字只出现在用户自己的终端）、late/settling 阶段、按原因区分的停止类型；任务对话框里脚本行的样子按代码推断，没有在官方上操作对照 |

修复后全量复跑 20 个场景两次：`vfy4-*` 用 `e1cbf885` 的 `built-claude`，328 项检查过 327 项；`vfy5-*` 用最终构建 `2842064a`，328 项全部通过。

| 场景 | `vfy4-*`（`e1cbf885`） | `vfy5-*`（`2842064a`） |
| --- | --- | --- |
| B-basic | 21/21 | 21/21 |
| B-prompt | 24/24 | 24/24 |
| B-interrupt | 22/22 | 22/22 |
| B-async | 19/20 | 20/20 |
| C-perm | 18/18 | 18/18 |
| C-rules | 14/14 | 14/14 |
| C-hooks | 10/10 | 10/10 |
| C-auto | 9/9 | 9/9 |
| C-mod | 7/7 | 7/7 |
| D-agents | 14/14 | 14/14 |
| D-bg | 12/12 | 12/12 |
| D-main-agent | 11/11 | 11/11 |
| D-team | 7/7 | 7/7 |
| E-shape | 12/12 | 12/12 |
| E-fixture | 41/41 | 41/41 |
| G-robust | 21/21 | 21/21 |
| G-agent-compact | 14/14 | 14/14 |
| G-resume | 20/20 | 20/20 |
| G-notices | 18/18 | 18/18 |
| G-resume-lost | 13/13 | 13/13 |
| 合计 | 327/328 | 328/328 |

官方二进制跑同一版 B-async 为 20/20（`c12-off-B-async`）。`vfy4-*` 唯一没过的是「Esc: the turn is marked interrupted」，即第 19 组，`2842064a` 修复。B-async、G-robust、E-shape、G-resume-lost 的检查已按官方行为改写（`07bdb0ed`、`e1cbf885`）：结果在同一轮的 Poll splice 里，不再是下一轮的 task-notification。

## 结果

结论只用：一致 / 有意不同 / 缺陷 / 未验证。缺陷后面的箭头写修复它的提交；「位置」列的行号是检查时（`717d698b`）的行号；等级里带 L3 的行和 L3 之后改过的行，用 `e1cbf885` 的行号。

### A / E：模型可见内容与 transcript（L1）

| 维度 | 项 | 官方 | 本地 | 等级 | 结论 | 位置 |
|---|---|---|---|---|---|---|
| A | A01 REPL 名称/aliases/searchHint/maxResultSizeChars | REPL, [N5], 'execute JavaScript with programmatic tool access', fo=100000 | 同 | L1 | 一致 | 官方 `g61t94xb:6704-6712`；本地 `src/tools/REPLTool/REPLTool.ts:298-345` |
| A | A02 REPL inputSchema | Mu strictObject{code,timeout?,description?} | 同字段同 describe | L1 | 一致 | 官方 `g61t94xb:5866-5880`；本地 `src/tools/REPLTool/REPLTool.ts:49-65` |
| A | A03 auto 模式 checkPermissions 文案 | `Code Mode` script requires classifier review. | 同 | L1 | 一致 | 官方 `g61t94xb:6755`；本地 `src/tools/REPLTool/REPLTool.ts:334` |
| A | A04 REPL prompt 开头句（有 Poll 时） | M ? 'Your two tools are `REPL` and `Poll`' : 'Your one tool is `REPL`' | Code Mode 下恒为 'Your one tool is `REPL`' | L1 | 缺陷 → 已修复 `90df295e` | 官方 `g61t94xb:1587`；本地 `src/tools/REPLTool/prompt.ts:214-216` |
| A | A05 REPL prompt 正文段落（persistent context / cost / output / preview） | ts() 正文 | 逐字相同 | L1 | 一致 | 官方 `g61t94xb:1600-1612`；本地 `src/tools/REPLTool/prompt.ts:223-229` |
| A | A06 part cap 句 F | AEt()=30000 时出现 | REPL_OUTPUT_PART_CHARS，同文 | L1 | 一致 | 官方 `g61t94xb:1591`；本地 `src/tools/REPLTool/prompt.ts:217` |
| A | A07 转义句 N（yae=false 变体） | In what a script returns, logs or throws, ... | 同 | L1 | 一致 | 官方 `g61t94xb:1594`；本地 `src/tools/REPLTool/prompt.ts:218-219` |
| A | A08 输出段 j 的选择（async/sync） | M=j7()（启动于 auto/bypass）才用 async 文本，否则 SYNC | isCodeModeEnabled() 即用 ASYNC_OUTPUT | L1 | 缺陷 → 已修复 `90df295e` | 官方 `g61t94xb:1567-1577`；本地 `src/tools/REPLTool/prompt.ts:230` |
| A | A09 MODE_CHANGE 段 Y | qc()&&M 才出现 | Code Mode 即出现 | L1 | 缺陷 → 已修复 `90df295e` | 官方 `g61t94xb:1578-1583`；本地 `src/tools/REPLTool/prompt.ts:30-32,230` |
| A | A10 ASYNC_OUTPUT 文本本身 | 1573-1575 非 yae 变体 | 逐字相同 | L1 | 一致 | 官方 `g61t94xb:1573-1575`；本地 `src/tools/REPLTool/prompt.ts:21-25` |
| A | A11 detached 变体 zl()（M&&NUe） | How scripts run: ... `detached` ...；L3 证实 `oV()` 恒为 false，`NUe()` 在 Code Mode 下为真，有 Poll 时总是输出 | 检查时无；移植后 `ASYNC_OUTPUT` 为 zl() 文本，有 Poll 时的 REPL prompt 与官方 off-bypass-REPL.txt 第 1–150 行相同 | L1+L3 | 缺陷 → 已修复 `bdb005ca` | 官方 `g61t94xb:1655-1670`；本地 `src/tools/REPLTool/prompt.ts:21` |
| A | A12 EXAMPLE 示例 | Jo | 逐字相同 | L1 | 一致 | 官方 `g61t94xb:1339-1351`；本地 `src/tools/REPLTool/prompt.ts:34-45` |
| A | A13 REPL prompt 内的 skill 列表 | Q = qc() ? OEs(dko(e),'repl') | 无（注释说明未移植） | L1 | 缺陷（未修复） | 官方 `g61t94xb:1597`；本地 `src/tools/REPLTool/prompt.ts:207` |
| A | A14 MCP 行服务器上限 | Gl=40 | MCP_SERVERS_LISTED=10（注释称猜测） | L1 | 缺陷 → 已修复 `4b245c81` | 官方 `g61t94xb:1557,1672`；本地 `src/tools/REPLTool/prompt.ts:13` |
| A | A15 MCP 行文案 | MCP tools: connected servers are ... | 同 | L1 | 一致 | 官方 `g61t94xb:1561`；本地 `src/tools/REPLTool/prompt.ts:198-204` |
| A | A16 d.ts 外壳与 header 注释 | qo(): ```ts + header + core + Cl(e) | 同结构同 header | L1 | 一致 | 官方 `g61t94xb:1320-1337`；本地 `src/tools/REPLTool/prompt.ts:183-195` |
| A | A17 d.ts core 选择（async/sync lane） | core[bash][asyncLane?async:sync]，asyncLane=M | helpers(isCodeModeEnabled())：Code Mode 即 async 文本 | L1 | 缺陷 → 已修复 `90df295e` | 官方 `g61t94xb:1320-1326`；本地 `src/tools/REPLTool/prompt.ts:178-181,191` |
| A | A18 d.ts sync lane 超时句 Ol→Pl 替换（xl） | qc() 时把 Ol 换成 Pl（'A script is stopped 600000 ms after it starts…'） | 保留 Ol（'Timeouts cap at 600000 ms…'） | L1 | 缺陷 → 已修复 `90df295e` | 官方 `g61t94xb:1310-1318,1332`；本地 `src/tools/REPLTool/prompt.ts:173-181` |
| A | A19 d.ts unsandboxedRetry 字段剥离（xl/Al） | qc() 时删去 2 处 unsandboxedRetry 块 | 保留 2 处 | L1 | 缺陷 → 已修复 `044d63d7` | 官方 `g61t94xb:1314-1318`；本地 `src/tools/REPLTool/prompt.ts:178-181; assets/code-mode-2.1.325.bash.d.ts.txt` |
| A | A20 d.ts async lane 的 running() 全局与 self.running 说明 | async d.ts 第 103-114 行 | 检查时无（prompt.ts:167-172 注释：worker 无对应实现）；移植后有 | L1 | 缺陷 → 已修复 `bdb005ca` | 官方 `core.bash.async.d.ts:103-114`；本地 `src/tools/REPLTool/prompt.ts:197-200`（`running()` 全局、`self.running`，每项带 `abort()`） |
| A | A21 d.ts 其余正文（async 与 sync 资产） | core.bash.sync.d.ts sha 同资产 | assets/code-mode-2.1.325.bash.d.ts.txt 与官方 sync 逐字节相同（cmp） | L1 | 一致 | 官方 `core.bash.sync.d.ts-84d57078`；本地 `assets/code-mode-2.1.325.bash.d.ts.txt` |
| A | A22 interface Tools：async lane 去掉 Bash/PowerShell 的 run_in_background | Vl(h,s,c)：c=j7()&&Poll 在列表 时删属性 | 保留 run_in_background | L1 | 缺陷 → 已修复 `90df295e` | 官方 `g61t94xb:1366,1412-1424`；本地 `src/tools/REPLTool/prompt.ts:142-149` |
| A | A23 declare var tools（Cl） | Tools & {[name]…} & {list()} + mcpThrows 注释 | 同 | L1 | 一致 | 官方 `g61t94xb:1293-1309`；本地 `src/tools/REPLTool/prompt.ts:151-165` |
| A | A24 Qo 'Also callable as tools.<name>(input)…' 行 | schema 为 undefined 的工具列在此行 | 未找到对应分支 | L1 | 未验证 | 官方 `g61t94xb:1371-1379`；本地 `—（需 L2 构造 Dh()/yHs 条件）` |
| A | A25 schema→TS 逐字节 | fr()/An()/KPe | 自写转换 | L1 | 未验证 | 官方 `g61t94xb:1385-1395`；本地 `—（需 L2 抓请求体）` |
| A | A26 team d.ts | 仅 e.agent 时追加；Code Mode 下 D=false | 不追加 | L1 | 一致 | 官方 `g61t94xb:1335`；本地 `src/tools/REPLTool/prompt.ts:183-195` |
| A | A27 PowerShell d.ts | core.powershell.{async,sync} | 只有 bash 资产 | L1 | 未验证 | 官方 `chunk-re27km4a.js`；本地 `—（Windows 未覆盖）` |
| A | A28 Poll 名称/description/searchHint/maxResultSizeChars | Poll, 'Wait for pending harness events', 'wait for and receive queued harness events', 200000 | 同 | L1 | 一致 | 官方 `chunk-pg2sb68f.js:Poll 定义`；本地 `src/tools/PollTool/PollTool.ts:130-133; src/tools/PollTool/prompt.ts:4` |
| A | A29 Poll isEnabled（是否发给模型） | HR()：需 ownEventsRequested，即交互启动时 mode∈{auto,bypassPermissions}（x0o/mrr） | isCodeModeEnabled() | L1 | 缺陷 → 已修复 `90df295e` | 官方 `chunk-jsrfnb7z.js HR; chunk-sbb5xach.js t8t; chunk-m8nhymg4.js mrr/It`；本地 `src/tools/PollTool/PollTool.ts:139-140` |
| A | A30 Poll prompt：nonce manifest / chunk marker / n_a（harness 追加调用）段 | mLo(t_a(),n_a(),…) 含这三段 | 检查时删去，代码注释说明本地无 nonce、无追加调用；移植后 harness 会追加 Poll 调用、带 nonce manifest，Poll prompt 与官方 off-bypass-Poll.txt 逐字节相同 | L1+L3 | 缺陷 → 已修复 `d071b354`、`bdb005ca` | 官方 `chunk-paf3y2vg.js mLo/n_a`；本地 `src/tools/PollTool/prompt.ts:7` |
| A | A31 Poll prompt：开头句与 U 的第二句、t_a 末尾 queued 子句 | 'delivered by your harness (for example notifications from the surface hosting this session).'；U 第二句 'Something may still be queued that this tool never delivers, for example a scheduled prompt…'；'if something is queued for the end of your turn, it ends by then with "(no pending events)" instead.' | 开头改写为 'the outcomes of `REPL` scripts that were dispatched…'；后两处删除 | L1 | 缺陷 → 已修复 `c0c505fa` | 官方 `chunk-paf3y2vg.js U/t_a/mLo`；本地 `src/tools/PollTool/prompt.ts:11-15` |
| A | A32 Poll 输出 schema | content,eventCount,remainingWakeCount,media,toolsUsed,provenance,declared | 同官方 7 个字段；toolsUsed、provenance 按官方填，media、declared 本路径上没有事件带 | L1 | 缺陷 → 已修复 `3e332cb7` | 官方 `chunk-pg2sb68f.js Iso`；本地 `src/tools/PollTool/PollTool.ts:83-114` |
| A | A33 Poll 拒绝文案 / 重复调用结果 | REFUSED 文案；重复调用返回 wBe + hideRow | 同 | L1 | 一致 | 官方 `chunk-pg2sb68f.js`；本地 `src/tools/PollTool/PollTool.ts:46,86` |
| A | A34 无事件结果 wBe | '(no pending events)' | 同 | L1 | 一致 | 官方 `chunk-paf3y2vg.js wBe`；本地 `src/tools/PollTool/prompt.ts:2` |
| A | A35 输入已关闭时的 gzs 变体 | '(no pending events) No script or background task of this session is still due to report, and its input has closed, so no event can arrive.' | 无 | L1 | 未验证 | 官方 `chunk-paf3y2vg.js gzs`；本地 `—（调用点未读，交互入口是否可达未定）` |
| A | A36 系统提示段 repl_working | s7r：isReplMode&&!lean 时 'Few, full scripts: …' | 逐字相同，条件相同 | L1 | 一致 | 官方 `chunk-wqb2b4v0.js s7r`；本地 `src/constants/prompts.ts:892-895` |
| A | A37 memory 段 Write→write() 替换 | O0o | 同 | L1 | 一致 | 官方 `chunk-xjqp3eha.js O0o`；本地 `src/memdir/memdir.ts:138-141` |
| A | A38 Chrome 段（默认变体 + me() + iZ(0)） | Fde() 默认分支，iZ(0)='CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=0 claude'/Windows 句式 | 同 | L1 | 一致 | 官方 `chunk-xjqp3eha.js Fde/me; chunk-yw5xfhrq.js iZ`；本地 `src/tools/REPLTool/codeModeGate.ts:34-47` |
| A | A39 Chrome 段 F() 变体（本次运行早先开过 Code Mode） | '…not available until the user quits Claude Code: … was on earlier in this run…' | 无 | L1 | 未验证 | 官方 `chunk-xjqp3eha.js Fde`；本地 `—（F() 未解析，本地 env-only 开关下是否可达未定）` |
| A | A40 隐藏工具直呼错误 | '. X is only available inside REPL. Use REPL with code: await X({...}).' | 同，条件同（CODE_MODE_ONLY_TOOLS 且 REPL 在列表） | L1 | 一致 | 官方 `chunk-wqb2b4v0.js@4495336`；本地 `src/tools/REPLTool/codeModeGate.ts:192-206` |
| A | A41 子 agent 调 Poll 的 No such tool 后缀 | '. Poll is not available to this agent. Complete the task with the tools provided and return findings to the orchestrator.' | '. Poll is not among the tools available here. Continue with the tools you have.' | L1 | 缺陷 → 已修复 `3965d56a` | 官方 `chunk-wqb2b4v0.js@4495336 后一分支`；本地 `src/services/tools/toolExecution.ts:480-503` |
| A | A42 import 拒绝 | Module loading (X) is not available in REPL — the vm context is sealed. Use the tool globals instead… | 同 | L1 | 一致 | 官方 `g61t94xb:5694`；本地 `src/tools/REPLTool/executor/host.ts:186-191` |
| A | A43 脚本时间超时 | REPL execution timed out after Nms of script time (inner tool calls excluded). Script may still be running — avoid unbounded awaits. | 同（Error: 前缀与官方 stack 头一致） | L1 | 一致 | 官方 `g61t94xb:7059`；本地 `src/tools/REPLTool/executor/host.ts:128-130` |
| A | A44 墙钟上限默认变体（nothing/call） | REPL execution exceeded hard wall-clock limit of Nms. An inner tool call may be hung — … | 同 | L1 | 一致 | 官方 `g61t94xb:6193`；本地 `src/tools/REPLTool/executor/host.ts:132-134` |
| A | A45 墙钟上限：调用仍在等待运行（权限提示）变体 | '…exceeded its wall-clock limit of 10m while its Bash call was waiting to run.… may have been waiting for the user to answer a permission prompt, which is now closed. If so, running it again will ask the user again.' | 无，一律默认变体 | L1 | 缺陷 → 已修复 `824a6eda` | 官方 `g61t94xb:6164-6185`；本地 `src/tools/REPLTool/executor/host.ts:132-134` |
| A | A46 墙钟上限：shellCall 变体 | '…exceeded its wall-clock limit of 10m before a shell call finished. The limit is on the whole script…' | 无 | L1 | 缺陷 → 已修复 `824a6eda` | 官方 `g61t94xb:6187-6190`；本地 `src/tools/REPLTool/executor/host.ts:132-134` |
| A | A47 内层调用 watchdog | 'REPL inner tool call X exceeded Nms watchdog (native timeout …). The call may be hung — try a shorter timeout on the tool itself.' | 无 | L1 | 缺陷 → 已修复 `824a6eda` | 官方 `g61t94xb:7076-7082`；本地 `src/tools/REPLTool/toolWrappers.ts（无 watchdog）` |
| A | A48 单脚本调用上限文案 | 'X: this script has made 50,000 calls, its cap. The call was not made, and no later call of this script will be answered.'（之后的调用永不 settle） | 'The REPL script reached the limit of 50000 tool calls'（每次都抛） | L1 | 缺陷 → 已修复 `125917b0` | 官方 `g61t94xb:5428-5440`；本地 `src/tools/REPLTool/toolWrappers.ts:347-348` |
| A | A49 脚本被停后的多余调用 | 超过 I0o=20 次后返回 Qt()（永不 settle，无文案） | 抛 'The REPL script was stopped; no further tool calls are made' | L1 | 未验证 | 官方 `g61t94xb:5424-5427`；本地 `src/tools/REPLTool/toolWrappers.ts:345-346（行为归 B 维度）` |
| A | A50 run_in_background 拒绝 | 'X: run_in_background is not available in the async REPL. …' | 同 | L1 | 一致 | 官方 `g61t94xb:3417-3419`；本地 `src/tools/REPLTool/toolWrappers.ts:350-357` |
| A | A51 (dispatched #N) 回执 | result '(dispatched #N)' | 同 | L1 | 一致 | 官方 `g61t94xb:6671`；本地 `src/tools/REPLTool/sessions.ts:34; REPLTool.ts` |
| A | A52 'X is not available in this REPL call' | 同 | 同 | L1 | 一致 | 官方 `g61t94xb:4690`；本地 `src/tools/REPLTool/toolWrappers.ts:344` |
| A | A53 脚本结束时仍未结束的调用警告 | async：'⚠ N tool call(s) still running at script end (…) — they run on and their effects happen; …Do not re-issue them; await next time.'；sync：'⚠ N tool call(s) still pending at script end — results discarded: …. Add 'await'.' | 无 | L1 | 缺陷 → 已修复 `9eb100aa` | 官方 `g61t94xb:7330-7333`；本地 `src/tools/REPLTool/REPLTool.ts / executor/host.ts（无此输出）` |
| A | A54 残留代码的调用文案 Xl/ss/Ln/is | '[Tool call not made: the script that started this code has returned…]' 等 4 条 | 无 | L1 | 缺陷 → 已修复 `9eb100aa` | 官方 `g61t94xb:1690-1697`；本地 `src/tools/REPLTool/toolWrappers.ts（无）` |
| A | A55 turn 墙钟 clock-stop / 同步运行步数预算文案 | g61t94xb:5324-5332, 5397 | Worker 方案，无对应文案 | L1 | 有意不同 | 官方 `g61t94xb:5324,5397`；本地 `docs/plan/code-mode.md D2` |
| A | A56 CONTEXT_LOST / REPL_TIMEOUT_RESET_NOTE | 无对应原文 | 自拟 | L1 | 有意不同 | 官方 `—`；本地 `src/tools/REPLTool/REPLTool.ts:44-47（计划第 5 节已列）` |
| A | A57 常量 | Aun=600000, He/TWt/Z1r=30000, dot=7200000, Hjs=50000, I0o=20, fo=100000, zt=120, Gl=40, pending cap=8, 并发=min(env,10) | 除 Gl 外相同；并发固定 10，不读 env | L1 | 一致 | 官方 `g61t94xb:1352-1360,5424-5440,6339; chunk-*`；本地 `src/tools/REPLTool/toolWrappers.ts:29-31; prompt.ts:11-18（Gl 见 A14）` |
| A | A58 启动拒绝提示（bad_value/entrypoint/unattended） | a$r：'Code Mode (experimental) isn't available: <F0o>. Starting with the ordinary tools.' | 同 | L1 | 一致 | 官方 `chunk-yw5xfhrq.js F0o/a$r`；本地 `src/tools/REPLTool/codeModeGate.ts:17-31` |
| A | A59 其余拒绝原因与 declined/opt-in 文案 | own_settings/admin/engine/no_bash/no_setup/tools/unsaved/declined | 无 | L1 | 有意不同 | 官方 `chunk-yw5xfhrq.js F0o/a$r`；本地 `docs/plan/code-mode.md D3（env-only 开关）` |
| A | A60 Remote Control 拒绝与未连接提示 | 'Remote Control isn't available in Code Mode (experimental) yet[, so this session isn't connected]. To use Remote Control, quit Claude Code and start it again with … set to 0.' | 同 | L1 | 一致 | 官方 `chunk-yw5xfhrq.js qjs/zfa; chunk-maa0yxxe.js`；本地 `src/tools/REPLTool/codeModeGate.ts:50-66` |
| A | A61 脚本超时或被停后错误末尾的说明（nOi） | `The script was stopped partway through: statements before the stop ran.` 或 `The script threw partway through: …`，再接 `No tool call had completed.` 或已完成调用的 `名字 ×次数`；L3 的 `await sleep(40000)` 超时结果里有这句 | 同（`partwayNote`，按已完成的调用计数） | L1+L3 | 缺陷 → 已修复 `b1bd9e7f` | 官方 `chunk-3f6f8668.js nOi`；本地 `src/tools/REPLTool/stopReport.ts:72`，`REPLTool.ts:410` 接入；`vfy6-L3x` WAIT |
| E | E01 虚拟 tool_use 消息 | va()：Ha({content:[tool_use{id:repl_…,name,input}],isVirtual:true})，跳过 start/executing | createAssistantMessage({content:[block],isVirtual:true})，id repl_<uuid> | L1 | 一致 | 官方 `g61t94xb:6058-6066`；本地 `src/tools/REPLTool/toolWrappers.ts:237,358` |
| E | E02 虚拟 tool_result 消息字段 | content: error 或 ''；is_error 恒有（false/true）；toolUseResult, permissionDecision, toolDenialKind, toolDenialAfterRun, sandboxViolations, sandboxed, isVirtual | is_error 仅为 true 时写；无 toolDenialAfterRun/sandboxViolations/sandboxed；多 sourceToolAssistantUUID | L1 | 缺陷 → 部分修复 `c2ce8beb` | 官方 `g61t94xb:6067-6090`；本地 `src/tools/REPLTool/toolWrappers.ts:304-316` |
| E | E03 后台脚本失败的虚拟 REPL 对 | 计划 Phase 4.3 所述 | failurePair：repl_eval_<uuid> | L1 | 未验证 | 官方 `—（官方构造点未定位）`；本地 `src/tools/REPLTool/REPLTool.ts:174-187` |
| E | E04 transcript repl-mode 条目 | {type:'repl-mode',replMode,…(typedEvents),sessionId}；yae()=false 故无 typedEvents | {type:'repl-mode',replMode,sessionId} | L1 | 一致 | 官方 `chunk-w140y4g2.js y()`；本地 `src/utils/sessionStorage.ts:3136-3147; src/types/logs.ts:190-196` |
| E | E05 无 repl-mode 时按消息推断 | m()/_()：<repl-output 或 (dispatched #N) 结果判是，答复过的 Code-Mode-only 工具判否 | 同算法 | L1 | 一致 | 官方 `chunk-w140y4g2.js m/_`；本地 `src/utils/codeModeResume.ts:13-66` |
| E | E06 关闭后 resume 的提醒主体 | M(e,n) 的标题与 5 行 | 逐字相同 | L1 | 一致 | 官方 `chunk-w140y4g2.js M`；本地 `src/utils/codeModeResume.ts:69-78` |
| E | E07 关闭后 resume 提醒中的逐 eval 行 | …npr(n).map(o=>_so(o.evalId))：'eval #N never settled: the process that was running it exited. …' | 无（注释称本构建无 async lane，已过时） | L1 | 缺陷 → 已修复 `b472a69b` | 官方 `chunk-w140y4g2.js M; chunk-z3r3ymwt.js _so/npr`；本地 `src/utils/codeModeResume.ts:69-78` |
| E | E08 移出 Code Mode 的提示 | 'This session was started in Code Mode (experimental), which isn't available where it runs now. …'（BS） | '…started in Code Mode, which…'（缺 (experimental)） | L1 | 缺陷 → 已修复 `b472a69b` | 官方 `chunk-w140y4g2.js C()`；本地 `src/utils/codeModeResume.ts:20-21` |
| E | E09 非 Code Mode 会话在开关开启时 resume | 提示 'Code Mode is on, but this session isn't using it, so it continues with the ordinary tools. New sessions use Code Mode.' 并 pin:false | 不提示；replMode 沿用记录值（推断：随后按开关进入 Code Mode） | L1 | 缺陷（未修复） | 官方 `chunk-w140y4g2.js C()`；本地 `src/utils/codeModeResume.ts:87-103` |
| E | E10 拒绝 resume 的文案 E()（opt-in 状态） | '…so it can't be resumed…' 多个变体 | 不拒绝，改为继续并注入提醒 | L1 | 有意不同 | 官方 `chunk-w140y4g2.js E()`；本地 `docs/plan/code-mode.md D3, Phase 3 第 6 条` |

### B / G：运行语义与可用性（L2 + L3）

| 维度 | 项 | 官方 | 本地 | 等级 | 结论 | 位置 |
|---|---|---|---|---|---|---|
| B | Code Mode 工具集（default 模式） | 只有 `REPL`：Poll 要求以 auto / bypassPermissions 启动（`x0o`） | 复跑 `4b27ac4d`：只有 `REPL`；Bash/Read 等只在 REPL 内（检查时为 `Poll,REPL`，见缺陷组 1） | L2 | 一致 | src/tools/REPLTool/codeModeGate.ts；scenarios/B-basic.json |
| B | Code Mode 工具集（bypassPermissions） | REPL + Poll | `Poll,REPL` | L2 | 一致 | scenarios/B-prompt.json ON_BYPASS |
| B | 开关 off（未设置 / =0） | 与非 Code Mode 构建相同 | 两种 off 的 tools、sysSha、sysLen 逐字相同，无 notice，Bash/Read 直接可调 | L2 | 一致 | scenarios/B-prompt.json OFF_UNSET/OFF_ZERO |
| B | Code Mode prompt 段（完整 prompt） | repl_working 段；memory 段写成 `write(path, content)` | `-lean_prompt` 下有 repl_working，memory 段为 write(path, content) | L2 | 一致 | src/constants/prompts.ts:566,892 |
| B | lean prompt（opus-5-5） | `s7r` 省略 repl_working | 省略 repl_working | L2 | 一致 | src/utils/model/leanPrompt.ts |
| B | 表达式、await Read/Glob/Grep/Bash、`$` helper | — | 全部返回预期结果 | L2 | 一致 | scenarios/B-basic.json EXPR/PRIMS/SHELL |
| B | file/write/edit helper；变量跨调用保留 | prelude `edit, write, file, sleep` | 写入、编辑、读回正确；SETVAR→GETVAR 保留 | L2 | 一致 | src/tools/REPLTool/helpers.ts；B-basic FILES/SETVAR/GETVAR |
| B | 直接调用隐藏工具 | No such tool… only available inside REPL | 同文案 | L2 | 一致 | src/tools/REPLTool/codeModeGate.ts:193 |
| B | 内层 Bash 权限（default）接受 / 拒绝 | 拒绝即停脚本并给 refusal 报告 | 接受后执行；拒绝时停止并返回 refusal 报告，文件未创建 | L2 | 一致 | src/tools/REPLTool/stopReport.ts；B-interrupt PERM_YES/PERM_NO |
| B | 超时文案 | `REPL execution timed out after ${U}ms of script time (inner tool calls excluded)…`（chunk-g61t94xb.js:7059） | 逐字相同，30000ms | L2 | 一致 | src/tools/REPLTool/executor/host.ts:128 |
| B | 超时后 context 重置提示 | 官方 vm 不丢变量 | Worker 重启，给 REPL_TIMEOUT_RESET_NOTE / REPL_NEW_CONTEXT_NOTICE，变量为 undefined | L2 | 有意不同 | D2；src/tools/REPLTool/REPLTool.ts:44-47 |
| B | 回合内 Esc | user-stop 报告到达模型 | 报告文案到达下一请求 | L2 | 一致 | src/tools/REPLTool/stopReport.ts:45；B-interrupt SLEEPY |
| B | async lane：短脚本 | L3：detached lane 一直开着（`NUe` 里 `oV()` 恒为 false），短脚本也先返回 `(dispatched #N)`，结果在同一轮的 Poll splice 里 | 检查时：30 s 内结束直接 inline 返回 `<repl-output eval=…>`；移植后与官方相同 | L2+L3 | 缺陷 → 已修复 `a0f8c310`、`d071b354` | B-async QUICK；`src/tools/REPLTool/REPLTool.ts` |
| B | async lane：派发 | 每个 REPL 立即返回 `(dispatched #N)`；30 s（`Z1r()`）只决定排在后面的脚本何时可以和仍在运行的脚本并行 | 检查时：30.03 s 才返回收据；移植后立即返回，`REPL_DETACH_AFTER_MS`=30000 只用于并行 | L2+L3 | 缺陷 → 已修复 `a0f8c310`、`bf04f4f8` | B-async ASYNC |
| B | async lane：Poll 取事件 | 回复的工具调用结束后等结果（防抖 750 ms，最多 3000 ms），以 `poll_<uuid>` 调用对送回：nonce manifest、`<tools-used-before-summary>`、`<event nonce=… kind="repl-eval">` | 检查时：模型自己调 Poll 拿到不带 nonce 的事件；移植后同一轮 splice，格式与官方请求逐字节相同（`delivery.test.ts` 用官方请求做 fixture） | L2+L3 | 缺陷 → 已修复 `ccbf1c75`、`d071b354`、`8bed0b30` | B-async ASYNC；`src/tools/PollTool/delivery.ts` |
| B | async lane：空闲时事件唤醒模型 | 空闲时结束的脚本开始新一轮，事件在 Poll splice 里 | 检查时：以 task-notification 唤醒；移植后走 Poll splice | L2+L3 | 缺陷 → 已修复 `ccbf1c75`、`0ec2de1e`、`a0f8c310` | B-async AUTO |
| B | async lane：回合间 Esc 停止已派发脚本 | Esc 停止脚本并给 user-stop 报告 | 内层 Bash 运行中时 Esc 无效：`sleep 100` 继续，Poll 之后拿到 `<result>never</result>`（ms=100079） | L2 | 缺陷 → 已修复 `4b27ac4d` | src/screens/REPL.tsx:7511-7520；src/tools/BashTool/BashTool.tsx:1563 |
| B | async lane：回合中 Esc 停掉后台脚本 | 这一轮记 `[Request interrupted by user]` | 检查时：停止脚本、user-stop 报告照常送到，但这一轮直接结束，没有这条记录；`2842064a` 之后同官方 | L2+L3 | 缺陷 → 已修复 `2842064a` | B-async ESC_BG「Esc: the turn is marked interrupted」 |
| B | async lane：纯 JS 等待（`await sleep(40000)`） | L3：30040 ms 时超时，`REPL execution timed out after 30000ms…`，后面接 nOi 说明（A61） | 30 s 时同一句超时文案，后面接同一句 nOi 说明（`b1bd9e7f` 之后） | L1+L3 | 一致 | l3-off-L3x、vfy6-L3x WAIT；host.ts:152 |
| B | 预算计时迟到宽限 | `ic`：计时器迟到 >1000 ms 时一次性改为 5000 ms。L3：`await sleep(33000); 'late-inline'` 返回 `late-inline`（ms=33007） | `scriptDeadline` 按 `ic` 移植（host.test.ts 覆盖迟到、准时、调用开始时发现的停顿）。同一脚本仍在 30003 ms 超时（vfy6-L3x 第 3 次 eval）：计时器准时触发，`ic` 不给宽限，官方的 `late-inline` 另有原因，没有找到 | L1+L3 | 缺陷 → 部分修复 `15265d59` | chunk-g61t94xb.js:7647-7680；l3-off-L3x、vfy6-L3x LATE |
| G | 子 agent 中运行 REPL | 子 agent 拿 Code Mode 工具 | 子 agent 请求 tools 含 REPL、不含 Bash/Read，REPL `6*7`→42 | L2 | 一致 | G-agent-compact SUB |
| G | REPL 内 `Agent()` 返回值 | — | fork 模式下交互会话默认异步：返回 `async_launched`，答案以 task-notification 到主线程 | L2 | 一致 | src/tools/AgentTool/forkSubagent.ts:50；AgentTool.tsx:764-785 |
| G | /compact 后 REPL 全局变量 | replStateNote（chunk-nhpp4fne） | 摘要附 `Your REPL VM state was kept… These bindings are still defined: \`cx\`…`；compact 后 `cx + cy`=15 | L2 | 一致 | src/services/compact/replStateNote.ts:29,62；compact/prompt.ts:372 |
| G | `--resume`，Code Mode on | 恢复后仍为 Code Mode | tools `Poll,REPL`，历史保留，无 off 提醒；新 VM context 提示，旧全局为 undefined | L2 | 一致 | src/utils/codeModeResume.ts:94；D2 |
| G | `--resume`，Code Mode off | 官方交互界面拒绝恢复 | 继续会话：注入 codeModeOffReminder、显示 CODE_MODE_TAKEN_OUT_NOTICE，tools 为普通工具，调用 REPL 得 No such tool，transcript 记 repl-mode false | L2 | 有意不同 | SKILL.md 已知有意不同；src/utils/codeModeResume.ts:20,70,94 |
| G | 启动 notice：on | `Gfa`：is on · this session can be resumed only with Code Mode on | 同文案 | L2 | 一致 | src/utils/statusNoticeDefinitions.tsx:68-83 |
| G | 启动 notice：bad_value（=2） | `a$r`：…must be 1 to turn it on. Starting with the ordinary tools. | 同文案，普通工具 | L2 | 一致 | src/tools/REPLTool/codeModeGate.ts:18-30 |
| G | 启动 notice：unattended（Remote Control） | `--rc` 时 …doesn't work in background jobs, in teammates' panes or with Remote Control | 经 `CLAUDE_BRIDGE_REATTACH_SESSION` 触发：同文案，普通工具 | L2 | 一致 | codeModeGate.ts:82-99 |
| G | `--rc` 启动 | 接受 `--rc` | 本构建无 BRIDGE_MODE：`error: unknown option '--rc'` | L2 | 未验证 | src/main.tsx:5912-5926（构建开关，不是 Code Mode 代码） |
| G | `-p` + gate=1 | entrypoint 拒绝；notice 只在交互界面 | 普通工具；拒绝只写 debug log | L2 | 一致 | codeModeGate.ts:111,126 |

### F：权限、hook 与隔离（L1 + L2）

| 维度 | 项 | 官方 | 本地 | 等级 | 结论 | 位置 |
|---|---|---|---|---|---|---|
| F | 内层调用走 runToolUse | 内层调用走完整工具管线 | `run()` 用脚本工具的主名构造 tool_use，交给 `runToolUse`；`replScriptCall`/`innerCall` 只影响 schema 提示、结果落盘、Read 去重和 Code Mode 直接调用拒绝，不跳过权限或 hook | L1+L2 | 一致 | `src/tools/REPLTool/toolWrappers.ts:260-276`；`src/services/tools/toolExecution.ts:594,1094,2002`；`src/tools/FileReadTool/FileReadTool.ts:583` |
| F | PreToolUse/PostToolUse、deny 规则、mods tool.call | 照常触发 | 仓库测试覆盖 PreToolUse 改输入、PreToolUse 拦截、PostToolUse 改输出、mods hook 看到内层调用（25/25 过）；整条 deny 规则在可调用集合里过滤，带内容的 deny 规则在 runToolUse 权限判定里生效 | L2 | 一致（D4） | `toolWrappers.test.ts:253-281`；`toolWrappers.ts:91`；`toolExecution.ts:773` |
| F | 脚本运行中新增 deny 规则 | — | 下一次调用时 `refreshTools()` 重新过滤，工具找不到，不会执行 | L2 | 一致 | `toolWrappers.ts:213-215,274`；sec/grant.test.ts |
| F | worker/vm 全局只暴露文档里的 helper | 隔离的 JS 上下文 | 上下文是 null 原型对象，关闭字符串和 wasm 代码生成；HARDEN 固定 `Error.prepareStackTrace`，删掉 ShadowRealm/WebAssembly/Atomics/SAB/queueMicrotask 等，冻结内建对象；kernel 的 bridge/schedule 只作为闭包参数，不挂到全局；动态 import 被拒绝。17 个探针全部 blocked | L2 | 一致 | `src/tools/REPLTool/executor/worker.ts:56-134,139-261,263,362`；sec/surface.test.ts |
| F | 名字、别名、`tools[...]`、describeTool 只解析到授权内的工具 | 同 | host 侧 `byName` 是从 `getReplCallableTools` 建的 Map，不在里面就抛 “is not available in this REPL call”；`__proto__`/`constructor` 等伪造名同样被拒；describeTool/searchTools 只看 `callable` | L2 | 一致 | `toolWrappers.ts:195-200,343-344`；`REPLTool.ts:391-405`；`executor/host.ts:377` |
| F | 子 agent 和 `--agent` 的授权 | 按 agent 的 tools/disallowedTools 收窄原语 | 子 agent：`primitiveToolGrant(agentDefinition)`；fork 继承父授权；`--agent` 主线程：`computeTools` 先 `resolveAgentTools`，授权在 4261 设定。会话工具本身已按 agent 解析，授权只收窄 Code Mode 原语 | L1+L2 | 一致 | `src/tools/AgentTool/runAgent.ts:1117,1176`；`src/utils/forkedAgent.ts:523`；`src/screens/REPL.tsx:4209-4224,4261`；`src/tools/AgentTool/agentToolUtils.ts:415-422` |
| F | 回合结束后 async lane 的调用用当前权限模式 | 同 | lane 只在派发时按当时模式选一次；之后每次内层调用的权限判定都实时读 `getAppState()`（主线程即 `store.getState()`）。测试里脚本中途从 bypassPermissions 切到 default，第二次调用按 default 判定并被拒 | L1+L2 | 一致 | `REPLTool.ts:142-148,353-354`；`src/utils/permissions/permissions.ts:646`；`src/hooks/useCanUseTool.tsx:146`；sec/grant.test.ts |
| F | stop-wait 和结果块配对到正确的 tool_use id | 同 | `stoppedResultWait` 只对 REPL 自己的 `tool.id` 返回；`takeKeptResult` 只接受 `tool_use_id === tool.id` 的结果；内层结果只认自己的 `repl_<uuid>`；内层调用的虚拟消息不进 API 请求；脚本输出里的 `&<>` 被转义，伪造 `</repl-output><tool_result …>` 无效 | L1+L2 | 一致 | `src/services/tools/StreamingToolExecutor.ts:119-125,447-456,573-574`；`src/services/tools/toolExecution.ts:282,700,1812,2224`；`toolWrappers.ts:282,358`；`src/utils/messages.ts:2148`；`executor/host.ts:148`；sec/blocks.test.ts |
| F | Read 占位符和 stopReport 不多于 Read 本身返回的内容 | 同（官方 `hn`） | 脚本看到 `scriptValue`，base64 换成 `[N base64 chars — … moved …]`，原值只留在 host；stopReport 也用 `scriptValue`；图片/PDF 块只来自已完成的 Read/MCP 调用记录，且只在脚本无错误时附加 | L2 | 一致 | `src/tools/REPLTool/resultBlocks.ts:72-92,95-123`；`src/tools/REPLTool/stopReport.ts:75`；`toolWrappers.ts:301`；`REPLTool.ts:478`；sec/blocks.test.ts |
| F | Worker 内存上限 | 未查 | 没设 heap 上限，脚本能分配 2 GiB ArrayBuffer；死循环在超时后终止并重置上下文 | L2 | 未验证 | `executor/host.ts:291,388`；sec/resource.ts |

### C / D：权限对话框、子代理（L2）

这一节来自第二轮检查（`4b27ac4d` 的 `built-claude`），只列 B / G 表里没有的项；开关关闭时 resume 已在 G 表的「`--resume`，Code Mode off」里。「复跑」指 `vfy4-*`。

| 维度 | 项 | 官方 | 本地 | 等级 | 结论 | 位置 |
|---|---|---|---|---|---|---|
| C | default 模式内层 Bash 对话框显示内层命令 | 内层工具的权限组件 | 对话框里有 `touch perm-c.txt && echo perm-c-ok`，Enter 后执行 | L2 | 一致 | C-perm PERM_BASH |
| C | 内层调用对话框的组件 | `Kd()` 保留原工具对象，权限组件按工具身份选到 Bash / Edit 专用对话框 | 检查时：Bash、Edit 都落到通用 "Tool use" 对话框，Edit 没有 diff，第 2 项写 "Update commands"；复跑：标题为 `Bash command`、`Edit file` | L1+L2 | 缺陷 → 已修复 `31489a6b` | 官方 `g61t94xb:2982-2995`；本地 `src/tools/REPLTool/toolWrappers.ts:400-412`、`src/components/permissions/PermissionRequest.tsx:75-114` |
| C | 拒绝内层调用 | refusal 报告，脚本停在拒绝处 | 下一请求有 `The user declined the permission prompt for Bash(…)…so the script stopped`，后面的 log 没出现，文件没创建 | L2 | 一致 | C-perm PERM_NO/AFTER_NO |
| C | allow / deny / ask 规则按内层工具匹配 | 规则对内层工具生效 | allow 不弹框；deny 返回带规则名的 `{error}`；Read deny 在 validateInput 报 `File is in a directory that is denied by your permission settings.`；ask 弹框 | L2 | 一致 | C-rules |
| C | PreToolUse / PostToolUse 看到内层工具 | hook 的 `tool_name` 是 Bash | Pre / Post 都看到 Bash；updatedInput、deny、updatedToolOutput 生效；REPL 调用本身也触发 hook | L2 | 一致 | C-hooks |
| C | auto 模式分类器 | 整段代码先分类一次，内层调用再逐个检查 | 分类器 transcript 为 `REPL <code>`；内层 curl 单独分类；放行的执行，拦下的得 `{error}` 且没执行；cwd 内 `touch` 走快速路径不分类 | L2 | 一致 | C-auto |
| C | mod `tool.call` hook | 装了这类 mod 时拒绝开启 | hook 触发：deny 得 `{error}`、改写输入生效、没匹配的调用正常 | L2 | 有意不同（D4） | C-mod |
| D | 子 agent `tools: Read, Bash` | REPL 代替 Read / Bash，原语按 agent 收窄（`VQt`） | 请求 tools 只有 REPL；`tools.list()` 为 `["Read","Bash"]`；Write 抛 `Write is not defined`，文件没写；Read 得 hello | L2 | 一致 | D-agents RDKEY；`src/tools/AgentTool/agentToolUtils.ts:372-380,415-422` |
| D | 子 agent 工具解析为空（`tools: Read, Bash` + `disallowedTools: REPL`） | 抛 `Agent '…' would be spawned with zero tools — refusing. …`，不发请求 | 检查时：以零工具启动，返回 `async_launched`；复跑：按官方文案拒绝，没有请求 | L1+L2 | 缺陷 → 已修复 `a69326e6` | 官方 `chunk-ejv07e0c.js`（`yM` 的调用方）；本地 `src/tools/AgentTool/runAgent.ts:817-830` |
| D | 后台子 agent | REPL + Poll，两个工具的文案 | tools 为 `REPL,Poll`；prompt 有 "Your two tools are `REPL` and `Poll`" | L2 | 一致 | D-bg BG |
| D | REPL 脚本里启动的 fork | fork 沿用父工具（`Kd` 的 `options.tools` 含 REPL） | 检查时：子请求是普通工具，调 REPL 得 `No such tool available: REPL`；复跑：子请求 tools 为 REPL 和 Poll，没有普通 Bash / Read | L1（推断）+L2 | 缺陷 → 已修复 `4117d7d8` | `src/tools/REPLTool/toolWrappers.ts:425`；`src/tools/AgentTool/AgentTool.tsx:1315` |
| D | `--agent reader` 交互 | Code Mode，原语按 agent 收窄 | tools 只有 REPL；`tools.list()` 为 Read、Bash；Write 被拒 | L2 | 一致 | D-main-agent MAIN |
| D | `-p --agent reader` | `-p` 拒绝 Code Mode | 普通工具（Bash / Read），没有 REPL / Poll，正常跑完 | L2 | 一致 | D-main-agent HEADLESS |
| D | in-process teammate | teammate 拿 Code Mode | 普通工具，system prompt 里没有 Code Mode 文案 | L2 | 有意不同（D3） | D-team |
| D | REPL 内 `tools.TeamCreate` | — | undefined；`Agent({name, team_name})` 得 `teammate_spawned`（隐式 team `session-…`） | L2 | 未验证 | D-team TEAM |
| E | JSONL：REPL 外壳 | 非 virtual 的 assistant tool_use REPL + user tool_result `<repl-output>` | 同 | L2 | 一致 | E-shape |
| E | JSONL：内层调用对 | `isVirtual:true` 的 tool_use / tool_result，id 前缀 `repl_` | 同 | L2 | 一致 | E-shape |
| E | JSONL：repl-mode 条目 | `{type:"repl-mode",replMode,sessionId}`，last-wins | 同，每次启动追加一条 | L1+L2 | 一致 | E-shape；官方 `chunk-czdvq1ck.js` |
| E | resume 发给 API 的消息 | 完整 `<repl-output>`，不发 virtual 对 | 同 | L2 | 一致 | E-shape AFTER |
| E | 官方格式 transcript 的 resume（6 种 repl-mode 组合） | repl-mode last-wins；没有条目时按 `<repl-output` 推断 | 6 种组合的工具、提醒和 notice 都符合官方规则 | L2 | 一致 | E-fixture；`src/utils/codeModeResume.ts:13-66` |
| G | resume 时没结束的 eval（开关 off） | `_so`：`eval #N never settled: the process that was running it exited…` | 提醒逐字含这句 | L2 | 一致 | G-resume-lost AFTER_OFF |
| G | resume 时没结束的 eval（开关 on） | `qKa`：注入 `status="lost"` 事件，不开始新一轮（startsTurn false） | 检查时：没有 lost 事件；复跑：交互模式下事件不开始新一轮，bypass 下事件在下一请求里 | L1+L2 | 缺陷 → 已修复 `65d93a80`、`d48d9451`、`1dad3e6a` | 官方 `chunk-z3r3ymwt.js qKa`；本地 `src/utils/codeModeResume.ts:138` |
| G | 脚本启动的子 agent 中途 529 | 失败可以看懂，会话继续 | 脚本内 `Agent()` 默认异步，脚本继续；失败在同一轮以 task-notification 事件送回，带 `<status>failed</status>` 和 `API Error: 529 …overloaded_error…` | L2 | 一致 | G-robust SUB529 |
| G | 主线程 429（REPL 结果之后） | 显示错误，会话继续 | 界面显示 API 错误；下一回合 VM 状态还在 | L2 | 一致 | G-robust MAIN429/AFTER429 |
| G | 工具抛错 | `{error}`，脚本继续 | Read 目录得 EISDIR；`Bash({})` 得 InputValidationError；Edit 不存在的文件得 `File does not exist…`；脚本跑到末尾 | L2 | 一致 | G-robust THROWS |
| G | 定时器里 throw、未处理的 rejection | — | 记为 `[stderr] Uncaught Error: late-boom` / `[stderr] Unhandled rejection: Error: unhandled-boom`，脚本和 VM 都还在 | L2 | 一致 | G-robust CRASH_* |
| G | worker 被杀 | 可以看懂的错误，会话继续 | Worker 在进程内，外部没有单独进程可杀；`onerror` 给 `REPL worker crashed: …` 并重建 | L1 | 未验证 | `src/tools/REPLTool/executor/host.ts:270-296` |

## L3：官方二进制对照

官方 2.1.325 二进制（`/tmp/cmx/conformance/official/pkg/claude`）接同一个假 API，用同一套场景驱动，再和本地的请求体、画面对照。

**主要发现：官方的 detached lane 一直开着。** 官方 `NUe(){return le()&&j7()&&!oV()}` 里的 `oV()` 返回常量 false，所以只要会话有 Poll（以 auto 或 bypassPermissions 启动），每次 REPL 都立即返回 `(dispatched #N)`；这一轮的工具调用结束后，harness 等脚本结果，再以 `poll_<uuid>` 调用对把结果 splice 进同一轮。第一轮检查按 L1 推断官方是 30 秒 settle 窗口（短脚本 inline 返回、超过 30 秒才派发、空闲时以 task-notification 唤醒），这个推断是错的。受影响的项：A11、A20、A30 和 B 表 async lane 的短脚本、派发、Poll 取事件、空闲唤醒，归为缺陷第 18 组，已按官方移植（`545c12f5`…`e1cbf885`）。

官方二进制的运行：

| 运行 | 场景 | 通过 | 说明 |
|---|---|---|---|
| `l3-off-B-basic` | B-basic | 21/21 | |
| `l3-off-B-asyncx` | B-async 旧版 | 13/24 | 旧检查按 settle 窗口写，失败都在这些检查上；它们暴露了 detached lane |
| `l3-off-L3x` | L3x | 8/14 | 失败来自按旧 lane 写的 step 1 / task-notification 检查 |
| `l3-off-WAKE` | 空闲唤醒 | 3/4 | 同上 |
| `c12-off-B-async` | B-async（`07bdb0ed` 之后） | 20/20 | 本地 `vfy4-B-async` 19/20，差第 19 组（`2842064a` 修复） |
| `c12-off-G-resume-lost` | G-resume-lost | 9/14 | 见下 |
| `c12-off-G-robust` | G-robust（18:27 的旧版） | 20/22 | 见下 |

L3x 场景（`/tmp/cmx/conformance/l3/L3x.json`）逐项对照（本地是移植前的 `l3-our-L3x`，13/14；移植后的状态另外注明）：

| 探针 | 官方 | 本地 | 结论 |
|---|---|---|---|
| WAIT `await sleep(40000)` | 30040 ms 时超时；delivery 里有 `<tools-used-before-summary>REPL</tools-used-before-summary>`，错误后接 `The script was stopped partway through: statements before the stop ran. No tool call had completed.` | `vfy6-L3x`：30003 ms 超时，delivery 文本除 nonce、`at`、`ms` 外和官方逐字相同，含 `REPL` 那一行和 nOi 说明；之后的 delivery 两边都没有 tools-used 行 | 一致（`b1bd9e7f`、`3e332cb7`） |
| EVALT `eval` / `Function` / WebAssembly | `EvalError:Code generation from strings disallowed for this context`，WebAssembly 为 undefined | 同 | 一致（F 表隔离那一行）；官方失败只因 step 计数 |
| LATE `await sleep(33000); 'late-inline'` | 返回 `late-inline`（ms=33007） | 30003 ms 超时（`vfy6-L3x`，`ic` 移植之后） | 第 21 组，原因未定位 |
| BGFAIL 后台子 agent 失败 | 第 2 步在 Poll 结果里送回 | 移植后没有用 L3x 重跑；`vfy4-G-robust` 的子 agent 529 检查走同一路径，失败在同一轮以事件送回 | 一致 |

G-resume-lost 在官方上：开关 on 时第一次启动会先重启自己（`Restarting Claude Code in Code Mode…`），开关 off 时拒绝 resume（`This session was started in Code Mode (experimental), which is off, so it can't be resumed.`），所以 off 分支的检查不适用，本地继续会话是有意不同（G 表）。开关 on 的两项（交互下 lost 事件不开始新一轮、bypass 下下一请求带 lost 事件）官方通过，本地复跑也通过。「lost row is shown」官方失败，本地也不显示这一行，两边一致，没有列成缺陷。

G-robust 在官方上跑的是 18:27 的旧版：失败的是旧检查「529 … failure arrives as an understandable task-notification」（等下一轮的通知）。改名后的「failure arrives in the same turn as an understandable task-notification event」本地通过，没有在官方上重跑；其余共有的检查两边结论相同。

### 界面对照（截图场景）

功能说明里的截图场景（`/tmp/cmx/shots/scenarios/shots.json`，Ctrl+E 另用 `/tmp/official-cm/ctrle-our.json` / `ctrle-off.json`）在官方二进制和本地上各跑一遍，110×36 tmux pane。官方运行 `official-shots-4901dc`（9/9）、`official-ctrle-4901dc`；本地修复后 `final-shots`（9/9）、`final-ctrle`（3/3），构建为 `7c74f63c`。

| 画面 | 官方 | 本地（修复前） | 本地（修复后） |
| --- | --- | --- | --- |
| Ctrl+O | `⏺ Code(Count TODOs under src) · 3 lines (ctrl+e to show)` | `⏺ Code`，下面是不缩进的脚本返回值 | 与官方相同（第 23 组） |
| Ctrl+O 后 Ctrl+E | `⏺ Code(Count TODOs under src)`，`⎿` 下三行高亮源码 | 与 Ctrl+O 相同 | 与官方相同，header 和源码行的 ANSI 只差官方 `⏺` 前一个 `\e[49m` |
| 后台脚本等待中 | spinner `(Run the slow build · 4s · ↓ 38 tokens)`；页脚 `bypass permissions on · 1 background task · esc to interrupt · ↓ to manage` | spinner `(4s · ↓ 38 tokens)`；页脚 `bypass permissions on (shift+tab to cycle) · esc to interrupt` | 文字与官方相同（第 24 组） |
| 结果送回、Esc | 后台任务消失，页脚恢复 `(shift+tab to cycle)` | 同 | 同 |
| 脚本运行中 `/exit` | `Background work is running` 对话框，列出 `shell · sleep 60 && echo never` 和 `code · probe` | 直接退出 | 同一个对话框，只列 `code · probe`（第 24 组） |

`/exit` 那一行用 G-resume-lost 的前几步单独探测（官方 `exitprobe-off`，本地 `exitprobe`）。第 24 组之后 G-resume-lost 的两次退出要在对话框里选 `Exit and stop tasks`，场景已相应修改，并加了一项检查；选了之后 resume 仍按官方报告 lost 事件（`fin4-G-resume-lost` 18/18）。修复后全量复跑 20 个场景（`fin-*`、`fin4-G-resume-lost`，构建 `7c74f63c`）：333 项检查全部通过。

还没改的 Code Mode 差异：官方在退出对话框里把脚本里正在跑的 `Bash` 列成一个 `shell` 后台工作，本地不列。

剩下的界面差异都不属于 Code Mode，没有改：本地 spinner 的状态括号右对齐（`buildSpinnerAnimationLine`，`395f12ae` 的设计），官方紧跟在动词后面；本地页脚右侧有 `◐ medium · /effort`；官方详细记录页脚右侧有 `verbose`；官方启动时先显示 `Restarting Claude Code in Code Mode…`；Grep 结果里两个文件的顺序不同，来自文件系统顺序。

## 未覆盖与限制

- **A24 / A25** interface Tools 的逐字节输出和 `Also callable as tools.<name>(input)` 行：要在 L2 抓请求体对照。
- **A27** PowerShell d.ts：没有覆盖 Windows。
- **A35 `gzs`、A39 Chrome `F()` 变体**：调用点或条件未读，可达性未定。
- **A49** 停止后多余的调用：官方没有文案（promise 永不 settle），本地抛错，归 B 维度。
- **E03** 后台脚本失败的虚拟 REPL 对：官方构造点未定位。
- **计时器迟到宽限 `ic`**（`J1r=1000` → `Q1r=5000`）：已移植（`15265d59`），但 L3 LATE 探针官方 33007 ms 返回、本地 30 秒超时的差别不是 `ic` 造成的，原因没有找到（第 21 组）。`sc` 的 pauseForOthers/charge 也没有移植。纯 JS 等待本身两边都在 30 秒超时。
- **`--rc`**：本构建没打开 BRIDGE_MODE，选项不存在；unattended 的拒绝文案改用 `CLAUDE_BRIDGE_REATTACH_SESSION` 触发验证。
- **Worker 内存**：没有 heap 上限，脚本能分配 2 GiB ArrayBuffer（主进程 RSS 仍为 110 MB）。只会耗尽自己会话的资源，不绕过权限判定；官方是否设上限没有查。
- **auto 模式分类器**只审一次整段 `code`（`REPLTool.ts:329-335`），每次内层调用仍走 `hasPermissionsToUseTool`。这是计划里记录的风险 D3，Phase 5 的确认对话框会告诉用户。
- **mods**：`mods.tools.projection` 能增加工具，mods 是受信任代码（D4），不改。
- **REPL 里的 `Agent()`** 默认异步来自 fork 模式（`isForkAsyncDefault`），与 Code Mode 无关。
- B、C、D、E、G 是假 API 下的 L2，F 只审本地代码路径；官方二进制在同一假 API 下跑过的场景见「L3：官方二进制对照」，其余场景没有在官方上跑。
- **detached lane 移植后的剩余部分**：
  - `Itn` 已移植（`3e332cb7`），但官方 `xO` 只移植了 poll_events 附件、tool_use / server_tool_use 名字和 Poll 结果 manifest 后的那一行；REPL 输出里的 frame 行、压缩摘要、`queued_command.toolsUsedDelta`、mcp_tool_use 的 `server:name` 没有移植。tools-used 记录是进程级的，`/clear` 时不像官方那样带到新会话。REPL 结果里的 tools-used 行（官方 `bNt`/`SNt`）也没有移植。
  - `KKa`（子 agent resume 时的 lost 事件）没有移植，只做了主线程的 `qKa`。
  - Poll splice 的 refuse 和 second_pair 两种方式没有移植；同一条 assistant 消息的第二次 delivery 改成 user 消息末尾的文本（`delivery.test.ts`）。
  - 官方 `Es` 的去重和 `TGt` 的合并没有移植。
  - `running()` 每项字段的取值是推断的：`ageMs` 按运行时间算，迟到的 eval 记为 settled，`abort()` 总是返回 true。
  - 还没开始就被取消的脚本，事件用 failed 的形式。
  - 没有会话时调用 Poll 返回 `(no pending events)`。
- **resume 时的 lost 行**：官方和本地都不在界面上显示这一行，只把事件发给模型。

## 证据

- 运行目录：`/tmp/cmx/conformance/run/<场景>/`（`mock.jsonl`、`req/req-NNNN.json`、`pane-*.txt`、`debug-*.log`、隔离的 HOME）；脱敏副本在 `/tmp/cmx/conformance/evidence/<场景>/`。这些是本机临时目录，不入库；重现方法是按 skill 重跑同名场景。
- 复跑和 L3 的运行目录（同在 `/tmp/cmx/conformance/run/` 下）：`vfy4-*`（`e1cbf885` 的 `built-claude`，20 个场景）；`c12-*`（`07bdb0ed` 之后的场景，`c12-off-*` 为官方二进制，`c12-our-*` 为本地）；`l3-off-*`、`l3-our-*`（移植前的 L3 对照）。L3 专用场景 `/tmp/cmx/conformance/l3/L3x.json`；官方工具描述 `/tmp/cmx/conformance/l3/desc/off-bypass-REPL.txt`、`off-bypass-Poll.txt`。
- 移植过程的临时文件：`/tmp/cmx/port/`（本地 prompt 导出 `repl.txt`、`poll.txt`、`zl.txt`，和 `off-bypass-*.txt` 对照用）。
- L1 资料：`/tmp/cmx/conformance/l1/`（`official.json`、按 lane 生成的官方与本地 d.ts、`built.strings`、`anchors-ours.json`）。
- F 维度的探针：`/tmp/cmx/conformance/sec/`（`surface.test.ts` 17 pass、`grant.test.ts` 4 pass、`blocks.test.ts` 3 pass、`resource.ts` exit 0），以及仓库内 `src/tools/REPLTool/toolWrappers.test.ts`（25 pass）。
- 脱敏扫描：对 `evidence/` 和报告片段按 Anthropic key 前缀和两个鉴权 header 名做不区分大小写的 `rg`，0 命中；mock 日志不记鉴权 header，只记个数。假 API 使用固定的假 key，不是真实凭据。
