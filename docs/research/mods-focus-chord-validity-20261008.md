# Mods 焦点组合键和验收有效性

## 可观察契约

默认 `Ctrl+X Tab` 由按键系统完成 `abovePrompt:focus`，结束前缀状态；宿主按收键时的实际站点依次访问 Band 控件、可见 Pane 正文、composer。未持键面板的裸 Tab / Shift+Tab 归 composer。已持键 Pane 内的独立 Tab 按实际 DOM 控件顺序导航，空文本的合法 Button 仍保留，不因没有矩形或可见标签被删除。

显式进入保留当前草稿；值改变、关闭、卸载或所有权转移后，旧异步回执不得恢复旧焦点。公开插件 focus 仍受已持键和插件归属约束。Band 拒绝或 withholding 的回执保留实际 body holder，不伪造控件落点。

## 首个真实分歧

Native27 的固定官方 diff 2.1.292 作者代码已通过实际 Read/Write、Git batch 和 Pane 绘制入口执行。原始 `18 09` 中的 Tab 被未持键 Pane 提前捕获，source 协商回执为 focused=true / element=source / revision=9。下一次独立 `09` 的解析结果为 chord_cancelled，pendingChord=true，尚未派发 DOM keydown。故障位于输入所有权及组合键终态，不是空 base 控件缺失。

最小回归在真实 KeybindingSetup、ModUi、ModsAbovePrompt、ModsPane 与 Ink 输入中复现：取得焦点后仍保留 Ctrl+X 前缀。修复使用官方默认动作和正常按键派发，移除提前抢占；后续同时断言宿主快照、实际 DOM source/base/file 控件，以及最终退回 composer。组件回归不冒充真实 Worker、完整 CLI、逐帧或官方双端验收。

新增的焦点实现从已有工作区按功能相关 hunk 单独提取，排除 terminal Client、故障恢复、selection 与 prompt edit 的并行改动；临时候选保留独立输入清单，主工作区的其他 Claude 修改不被覆盖。

## 版本与证据边界

官方 2.1.293 提取的 chunk-n5qp0a1h.js 定义 Chat 的 ctrl+x tab / ctrl+x ctrl+a，chunk-me4xzjyw.js 的 AbovePrompt handler 选择实际控件及 Pane holder。该默认键定义为源码核对；完整diff矩阵仍固定2.1.292，后续2.1.293定向原生证据见下文，不声称完整最新版本parity。

Native27 的完整矩阵为 29 场景、23 passed / 6 failed，整体 failed。Native26 在 readiness 前被执行环境拒绝，0 场景；它是初始化错误，不作为产品 RED。退出后 9 个精确归属的 native PID 均已消失，无信号操作；此观察不能替代原始 EOF/reap，也不能补写历史通过结果。

原始证据根：`/private/tmp/mods-remote-composer-292-20261008-rptx4ocs`。`full-gate26-startup-disposition.json`、`full-gate27-evidence/driver-final-manifest.json`、`full-gate27-all-capture-process-probe.json`、`diff-focus-repair-red1/disposition.json` 和 `diff-focus-repair-red3` 各保留原始失败与来源。RED1 的借用夹具在发送输入前依赖候选缺失的 selectionScope 标记而失败；明确不计入产品 RED。RED3 使用同一更强回归及原始产品代码，首次失败仍是 pendingChord 非空，不增加等待预算或删除断言。

## 未闭合的验收有效性

Native25 的首次物理尺寸分歧在零输出 frame6：frame-start ioId=22 / rawOffset=5012 / geometryId=0，resize-ack ioId=23 / 110×34 / geometryId=1，frame-end ioId=24 / rawOffset=5012 / geometryId=1。逻辑快照仍为 200×60，期间没有产品输出。该证据需正确关联逻辑快照、实际写入及 geometry 生效时点；当前 failed 保留，不以跳过帧、抑制 resize、追加等待或最后截图掩盖。

同步帧 ACK 仍改变产品写入时序，productTimingEquivalent=false。独立原始 syscall observer 的现有字节证据不能替代完整终端的 termios、geometry、输入、帧及所有权生命周期。完整 native、diff 和浏览器 Client 同轮闭合前，不能报告完整 feature/release 验收通过。


## Native28 与新的所有权回归

冻结 Native28 正常完成29场景，23通过6失败；canonical23语义checkpoint、四次实际Tab的snapshot/DOM source、base、alpha、omega均通过。Builtin七侧业务9项及361物理帧通过，七侧正常EOF/reap，但同步ACK仍使时序门禁失败。Canonical零输出frame6的start/end跨geometry；实际Git wrapper有start/blocked/released，而debug缺宿主start/close关联，不能补写git_success。Interaction已有真实EOF/reap，SIGHUP/status9和未完成的diff关闭条件仍失败。三份独立只读报告均封存零漂移；它们不替代正式四路通过。

后续发现并用稳定最小回归复现：草稿清空后旧person focus通过过期generation重新持键；显式canonical hold后非空草稿错误阻止autoFocus；Band跨插件同key只按element选DOM，导致plugin B回执落到A。这些行为与293提取源码的真实input store变更释放holder、o4o按plugin+element查找及已持键首控件规则不同。修复让presentation变更作废旧焦点代次、清理控件身份；automatic协商使用未变更的持键草稿；DOM及handoff保留plugin身份。

原件及结果：`focus-ownership-red1/disposition.json`明确Band第一控件括号预期错误不计产品RED；`focus-ownership-red2`的3案失败发生在实际草稿、hold、首控件及plugin B回执前置完成之后；`focus-ownership-green1`的同一回归3通过0失败。回归可运行README所列ui.focusOwnership与ModsPane.pluginFocus文件；前者是真实ModUi core，后者是有明确边界的宿主receipt组件夹具。README中13个未交付测试路径的原件与失败检查保存于`focus-readme-paths-red1`；新的release-check脚本只证明路径在本checkout存在，不能把它解读为测试执行或原生通过。


最新版自动首焦的定向复核：官方2.1.293完整校验来源的私有可执行副本，在独立HOME/config/dummy provider/tmux中运行合法跨插件同key绘制。`ui.focus`事件指向原作者plugin/first，Enter恰好调用该作者，装饰插件无回调，正常`/exit 0`。原件`native-official-pane293r2`被借用的292旧A预期拒收，保留failed并标为过时oracle；`native-official-pane293r3`同夹具按实际293契约检查通过，不使用固定稳定等待。旧本地automaticFocus测试已绑定已提交绘制revision与真实DOM，并更新为plugin B落点；真实Worker中另一个REPL AST夹具漏注入withModUiPaneFocus，作为测试初始化错误修复，不计产品RED。该定向运行未完成全部默认矩阵或逐帧证据，不能报告293完整原生兼容。


## 官方 2.1.293 同 key 控件导航

官方定向原生运行 `native-official-band293r1` 在同一插件绘制两个相同 key、不同 handle 的 Button，三次默认 Ctrl+X Tab / Enter 实际回调依次为 slot1、slot2、slot1；三个 ui.focus DTO 的 plugin/element 相同，origin 均为 person，正常 /exit 0。此为独立 HOME/config/tmux 的实际行为证据，不是完整四路或逐帧通过。

本地 `focus-slot-red1` 在第二次合法回执后，实际 DOM 仍为 CONTROL-1，稳定复现控件被 plugin+key 去重的问题。人工导航应保留选中的真实槽位；自动或改写焦点的 fallback 仍按 plugin+key 查找首个绘制控件。宿主用私有 WeakMap 保存 core 是否实际接受这次移动，并在 REPL 回执副本间传递，不增加作者 DTO 的字段或 symbol。插件没有调用 next 时，即使旧 holder 的 plugin/element 相同，也不能把它误认成这次移动已接受。

`focus-slot-green1` 的新真实 consumer 夹具误用了 invokeDrawing 参数，保留为夹具失败，不计产品 RED。修正签名后的 `focus-slot-green2` 六案通过，包含真实 KeybindingSetup、AbovePrompt、ModUi core、DOM 与 callback handle，以及 withholding 保留原槽位和 1→2→1 导航；仍不冒充 Worker 或完整 CLI。修复后的完整 native 门禁须使用新的冻结源码、build 和动态 baseline，旧轮通过数不沿用。


## Native29 与三项后续回归

Native29 使用本轮新构建及动态 baseline 完成29场景，23通过、6失败，整体 failed。canonical23语义checkpoint及四次实际Tab通过；frame5在frame-start前已发生resize ACK，旧200×60快照不能与实际110×34匹配。该帧不是跨边界零输出情形，不可通过新关联规则放行。Builtin七侧364物理帧和9项业务通过，时序门禁仍失败；interaction缺geometryProof且SIGHUP退出，不能凭EOF/reap改判正常退出。

只读审计的三项实现差异已取得同字节有效RED：重复key的已持键Pane裸导航留在第一槽位；第三个不同key请求被withholding后从第二槽位错误跳回第一；REPL人工Pane导航丢失目标plugin，被实际ModUi core拒绝。`focus-person-red1`的43案中40通过、3失败；修复后的`focus-person-green1`为43通过、0失败。前两案经过真实Ink输入、DOM与callback，第三案使用生产REPL函数与真实core，边界为AST调用夹具，均不声称覆盖完整Worker/native。

修复保存裸导航目标槽位，在dedup守卫检查实际DOM；withholding不触发改写handoff；宿主内部focusPerson通过私有WeakMap携带绘制actor，仅person分支读取，不改变作者DTO，也不复用automatic标记。最新官方源码的person与automatic规则分别保留，关键信息包括plugin、key、origin、实际接受结果。

独立验收脚本回归证明：只有实际原始字节区间长度为零且resize位于frame-start/end之间，才将逻辑观察与resize前物理网格比较，然后无条件回放到end并检查后续新geometry帧。`frame-resize-red1`为14通过3失败，`frame-resize-green1`为17通过0失败；Native28新离线诊断107帧通过，Native29新诊断仍拒收frame5。原始两轮failed manifest未修改；离线诊断不是新的完整门禁，不证明时序等价。
