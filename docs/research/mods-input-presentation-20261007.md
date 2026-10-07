# Mods Input：光标与提交状态（2026-10-07）

本批只提交 Input 的呈现与提交生命周期，基于 `dfec4b2b4676f3916cad2bc969622e3e64c7d69e`。候选由该 HEAD 构造，工作区含既有 WIP，分别验证且不混用源码身份。证据根 `/private/tmp/mods-controls-0qncgv34`；旧焦点批次 31/35 的结果保留在其原报告。

## 官方来源与契约

本轮核对 npm [latest 元数据](https://registry.npmjs.org/@anthropic-ai/claude-code/latest) 为 **2.1.292**，package shasum `ecf88deee4c6b1b099d14a8571f1d5cad2ff1897`。原生文件 `/private/tmp/mods-fork-routing-20261007-2afwted_/official/official-claude-2.1.292`，235017328 bytes，SHA-256 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`。

解包目录 `/private/tmp/mods-fork-routing-20261007-2afwted_/official/extract-292/all`，偏移是解码后 JavaScript 字符偏移：

- `chunk-hx89w1md.js:22350` 的 Kt：仅持焦点加粗 label，使用既有 TextInput 光标与占位规则；hint 为 ` ⏎ submitLabel`，输入预算 `max(12, bodyColumns-labelWidth-hintWidth)`。模块 SHA-256 `106552c2ce33318eda853913f7cddef73b29a777ad906e37e70c8f8a2d93dce9`。
- `chunk-8q7p93rh.js:432711` 的 jV：以 plugin/element 保存编辑缓存，绘制值变化才替换；pending Set 防重复 submit，收到送达结果且文本未再编辑才清空，不产生 change。模块 SHA-256 `62fa248db070e465f3aeb727884b114d1da3b25ab79540ca573dbb152e57cb84`。
- `official-input-render-window.txt`、`official-input-controller-window.txt` 保存有界源码窗口。该实现不是完整官方模块复制；复用本地 Cursor、renderPlaceholder、Ansi，保留本地 dispatch/owner fencing。

类型对照为仓库现有 `assets/mods-2.1.290.d.ts.txt:13590` 的 UiInputResult：成功结果须有 string element/value。这仍是 **2.1.290 作者声明**，不能当作 2.1.292 类型快照。空对象或缺 value 不算成功。最新声明整体同步继续独立处理。

## 修复与回归

- 单个字符簇光标替代全值反显；Left/Right/Home/End 更新显示，focus 时移至尾部；终端失焦使用原输入规则。
- 焦点标签、占位首字符、剩余占位 dim 与 ⏎ hint 对齐。显式 value 相同的重绘保留编辑缓存，变化时采用新值。
- submit 等待回执时抑制重复提交；有效回执返回后，只有当前 owner、仍挂载且没有后续编辑才清空，不生成 onInput。拒绝、undefined/null、空对象、缺 value 的回执保留文本。
- 改旧测试以观察实际焦点 Box 与独立 caret span，保留原意图、用例数量和副作用断言；临时诊断已移除，没有删案、skip、放宽输出断言或新固定 sleep。Input Client 分支沿用原 autofocus WIP，本批不宣称 Client/Band 已完整匹配。

新增 `ModsPane.inputPresentation.test.tsx` 的 10 案使用真实 Ink DOM/输入、观测屏障和延迟回执：焦点/占位/提示、family emoji 光标、提交后清空、无 synthetic change、pending 去重与新编辑、五种无效/拒绝回执、同值/新值重绘。隔离 realpath HOME/config，占位 key 与 chalk level 在结束时恢复。

## 最终源码与 Make 门禁

源码清单包含 `src/types/vendor/scripts/assets` 与 CHANGELOG；README、台账、报告的后续证据追加不进入制品源清单。候选和工作区 SHA 分别：

- candidate：`ae25737e5e41bac5c248cffde8cc70c25b8b5fa3e95ac326ef05848d564e9ed7`。
- workspace：`09a141bb668f6e17f973696537fe61b0fa7dafb081e0feadc36a8288d0bf72a9`。

命令由 `/private/tmp/mods-controls-0qncgv34/run.py` 运行。每项有独立 HOME/config/cache、无开发者 key/token，120 秒硬截止，独立 process group，并在完成后核实 sourceUnchanged=true、processGroupExistsAfter=false。

| 最终门禁 | candidate | workspace |
| --- | --- | --- |
| 11 文件相邻 suite | 392 pass / 0 fail / 2213 expect，61.867s | 414 pass / 0 fail / 2303 expect，62.720s |
| Input 文件独立运行 | 10/0/58，1.083s | 10/0/58，1.067s |
| 原 ModsPane 文件独立运行 | 176/0/1078，47.989s | 180/0/1098，48.954s |
| make release-check | exit 0，40.987s | exit 0，43.341s |
| make build | exit 0，5.408s | exit 0，5.949s |

相邻 suite 明确包含 Input presentation、automaticFocus、ModsPane、keyboardCapture、hostGeometry、uiRealm、ui、runtimeUi、uiEnvironment、diffTakeover、shippedDiffStartup。不是全部 WIP 的全量测试，也不宣称整个发布门禁通过。每项完整 command/env/日志与 before.json/result.json 保存在 `candidate-final2-*`、`workspace-final2-*`。

| 制品 | SHA-256 | bytes / mtime ns |
| --- | --- | --- |
| candidate-final2-build-output/built-claude | `4c7181b8b5d348d29ed7fbc91fcccc7ddee3452276967ce0834f32e52345086d` | 102117218 / 1791345376210056653 |
| workspace-final2-build-output/built-claude | `7a1fbcfbcbc512cfa1d4b97aef608bbdfce5b21c85a4ac5d31b734c1b79f7d87` | 102001634 / 1791345376777400319 |

## 最终终端对照

官方 o2、候选 c2、工作区 r2 各自完成九种自动焦点/输入流程，正确 plugin/element/component/requestId/surface、change/submit value、engine caller、拒绝/不下传/改写/隐藏/重复 key 的作者参数相同；普通退出、恰好一次激活和制品运行前后 SHA 均通过。耗时分别 37.025s、41.700s、41.871s。

`candidate-c2-comparison.json`、`workspace-r2-comparison.json` 均为 **35 帧中 33 帧完全一致，50 个不同单元格，完整 comparator exit 1**。所有 keyboard inputs、resizes、fixture、driver 与作者参数一致。两个 Input held/action 帧的完整矩形、位置、字符和样式 **完全一致**；`candidate-c2-input-scope.json`、`workspace-r2-input-scope.json` 的严格 Input 专项 passed=true（checker exit 0），没有修改全量 comparator 结论。

余下是 `af-select-held-stable`（37 cells）与 `af-select-action-stable`（13 cells）。相较上一焦点批次 103 个差异，本批消除 Input 的 53 个差异；这不是完整 UI/diff 通过。相邻官方内置 diff 开关/reopen/scroll/宽度矩阵稳定画面相同。官方 builtin 模块 debug 与本地 package-registration marker 格式不同，official packageRegistered=false 不计错误；它的真实 builtin render 调用和 diff 画面另由 debug/capture 证明。

复现命令：`python3 native-input.py official o2`、`python3 native-input.py candidate c2`、`python3 native-input.py workspace r2`（证据目录必须新建，不复用）；比较命令 `python3 compare-final.py candidate-c2` / `workspace-r2`。所有脚本在上述证据根；native 启动参数和环境取对应 evidence/result.json。


所有侧串行使用完全相同的 `native-input.py`（SHA-256 `d0c1f56b1e90e3432d636bc07c392c408951e50eed9e994debdf56e6c68ad360`），新隔离 fixture/HOME/config、专属 PTY/tmux/socket、dummy key，网络和系统凭据读取被沙箱禁止。总预算 90s，状态屏障最多 15s，稳定 ANSI cells 需持续 400ms 且限时 5s；不延长预算或将 sleep 当成功屏障。保存原始 input hex、raw PTY、ANSI、完整矩形 cells/styles/position、debug、状态与正常退出证据。

该矩阵核对稳定帧；不把稳定 capture 说成每个 output transaction 的独立 xterm physical replay。多主题、drag resize、全帧 logical/physical 等继续验收。debug 作者事件参数逐项核对，不能以日志格式相同代替参数一致。

## 保留的 RED 与诊断

- `red-input-presentation` 2 pass / 5 fail 记录最初呈现与状态问题，同时包含测试 ThemeProvider 包装导致重挂的夹具错误，不能将全部五案归为产品回归。
- 首轮 green 仍失败：DOM 投影漏 ink-virtual-text，chalk level 为零，以及 rerender 未保持 ThemeProvider。以正确 DOM/颜色/包装观察真实效果，不改产品实现掩盖夹具问题。临时 parser/production console 诊断恢复原字节。
- 原 ModsPane 测试持有的 Text 在 focused Ansi/unfocused Text 切换时卸载；改为持有实际 Input tabIndex Box，保留焦点与 identity 检查。
- `red-input-receipt-shape` **8 pass / 2 fail**，复现空对象和缺 value 回执误清空；按 UiInputResult 修复后最终独立 10/0。旧结果和失败日志均保留。
- `candidate-isolated-pane` 的旧阶段 sourceUnchanged=false，及旧 final/c1 cohort 只属诊断历史；不用于当前制品门禁。最终只引用 final2/o2/c2/r2 的同源结果。

## 提交与剩余范围

本批七路径：ModsPane 实现、原夹具、新 Input 回归、CHANGELOG、README、mods-test、此报告；从 clean HEAD 候选精确暂存。迁入工作区时保留此前 Client autoFocus 与其他 WIP；原 response.md、fix-instructions.md、improvment.md、共享 built-claude/official-claude 和其他冻结路径逐字节保护。

Select 的展开/高亮/导航/值缓存仍有差异，另做根因与提交。Band/Client、最新作者声明、完整 API/上下文、动态 matcher 扫描、全 UI/官方 diff、G5 和全部 WIP 门禁不由本批推导完成。受保护 Claude PID 94223/70780 只读检查，本批不向它们发送输入或信号，不 push。
