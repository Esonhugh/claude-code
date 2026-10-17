# Mods 终端验收有效性（2026-10-08）

## 当前结论

验收没有整体通过。新增实现把终端身份绑定到已经提交的DOM；新发布结论仍须同时通过业务、真实输入归属、逐帧物理回放、产品时序和完整清理。无法证明的层次保留失败/未覆盖，不接受缺实现的豁免。

## 本批实现与提交范围

17条源码/测试路径引入私有snapshot activation/lease/revision、可信focus clone、reconciler commit注册，以及真实FocusManager和控件几何观测。新host snapshot不会重标旧DOM，隐藏的mount不等于关闭后的缺席，reopen使用新lease。字段不进入作者Mods接口。

plain空label且无hotkey的Button可拥有合法逻辑焦点席位；只使用私有DOM注册标记区别于未绘制的普通控件。官方292 diff register.js中base对应空Button与app:cycleDiffBase。控件必须真的登记且actual plugin/key匹配，空字段不允许补造正面积。隐藏、缺席、普通零面积和foreign focus不取得例外。

干净提交候选 source8e32cd2a2a86a43457ce2bccfe6eabba8131abbfafac310b91e03664325e2100来自HEAD d10f0a8：378/0/2234，六个文件；check/build通过。与共享工作区N2有四处上下文适配：保留各自Band/keyboard类型和既有来源差异，不整文件吸收其他Claude工作。仅验证脚本覆盖的真实入口副本 source efc7bbe0f9fe3b45ef50fbcedde3519bd9f9afa2c81fc17521eb07e9486f5db0，其2860份src逐文件等于代码候选；该副本driver/check/build通过。新文档与代码候选的source epoch分别记录，不能把旧binary升级为新文档构建。

## 第十七轮独立证据

完整矩阵29/29完成，27通过、2失败，退出1；失败builtin-mods及terminal-canonical-diff，terminal-interaction本轮通过。源码/清理正常，lease已释放。

- source：b946a5ca773eb0dcb323f82d38b96bb9fe9be6340cf1a215f6bdbe145218339b。
- binary：ec2cac81d16ffb68753f673e0368e59f2d748c2b3a93449616a5bbdab210cfbd。
- final manifest：b605aabce6b709b5d37a8ea897c28fc6f920d5dc2ea8e033c7a4b52aeba588dd。
- evidence：/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/full-gate17-evidence。
- 只读复核：native17-empty-button-readonly-audit-r1/REPORT.md，SHA86fa49f8cda1335f9929a0f6aef52dc88ee47b804ee1a59e454e58afb4e3bac0。122份输入复读零漂移，269份proof哈希匹配。

23个canonical checkpoint全部成功。Tab1的base在frames69–70中actualFocusedElement=base、plugin=cc-plugin-diff，controls明确emptyButton=true/paintable=false/rect=null。随后Tab2/3、omega Enter/body、Esc、109/110缩放、人工关闭、重开和命令关闭都有同案输入/回执/帧，不拼接Native16。

canonical121帧唯一失败是startup frame7：start io24/g0/raw5117→真实io25的110×34 ACK/g1→end io26/g1/raw5117，logical仍200×60，交易内零输出。它证明采集边界跨几何epoch，不足以证明UI内容错误；不能删帧或用frame8覆盖来判通过。terminal-interaction99帧/5次ACK本案通过，但其bounded target不覆盖时序等价。builtin七侧364帧均回放成功，时序门禁仍失败。

## 非阻塞采集的推进与未完成项

私有journal原型不在此17路径提交中。产品write的receiver、参数/重载、callback身份、返回和异常对象保持原样；复制字节和逻辑帧后异步落盘，记录frame/write组、零写入与rootReset；队列有容量和收尾时限。同步TTY尾部写入被单独观测；正常产品清理之后才等待日志收尾。启用此原型时旧FIFO同步ACK路径退出。旧v1归档与productTimingEquivalent=false保持原样。

真实失败与修复：实际Writable默认latin1时旧记录器错误编码UTF8；先失败再修复。同步writeSync和缓冲Writable同fd不能共享一个顺序假设；先失败再以独立原writer队列的所有byte交织校验。相同字节多解、零字节边界多解、未知前缀/尾部、搜索上限、不完整footer、错producer/分组、overflow和写入异常均拒绝完整通过。逻辑cells/cursor/尺寸不能参与选择归属。该纯byte判定不等于独立termios/geometry/physical证明。

原型source a5c60dcf49ad1369b9ab83cc09e58a0744068641e8e81019adf96487eef11b62的测试/check/build通过。真实CLI --version字节在开关前后相同，但Bun console.log绕过process.stdout.write，journal有footer而writeCount=0；完整byte校验failed。此失败保存于terminal-journal-native-bootstrap1，不把footer.complete冒充全部原始输出已覆盖。后续queue-order修复有新的source epoch与RED/GREEN，旧build不冒充新修复构建。

仍必须完成Bun原生输出、完整启动/退出/非Ink/image/hyperlink范围，独立termios与geometry epoch、每帧paint/culled证明、真实输入到消费owner/代次/副作用的链条、更多empty↔nonempty/hotkey动态导航、293真实CLI与浏览器Client。同步ACK、新增sleep/串行resize、全局重绘和丢帧都不能替代这些实现。

## 官方版本边界

固定解包与本案运行oracle为2.1.292。2026-10-08T00:53:52Z公开registry核实latest为2.1.293，293静态阅读不自动代表293原生UI测试完成。作者契约见[Anthropic Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)，键位见[官方keybindings](https://code.claude.com/docs/en/keybindings)。

## 测试异常清理处置

只读审计报告 mods-committed-dom-readonly-audit-3_4jbq3t/report.md（SHA1bc0d14e58fd1516bec29469aa1706980cb5377a137ef00238f11c648444b21f）确证旧 C 中 render/setup 在 try 外，unmount/dispose 抛错也跳过环境恢复。final 测试使用同一 scope，从首次环境修改起覆盖所有步骤，资源创建后立即登记清理，逆序逐个尝试，即使 cleanup 失败仍恢复环境；单错误保留对象，多错误 AggregateError 保留全部。

新增同 scope 的失败注入先得到 RED 2 pass/2 fail，故障是环境泄漏；GREEN 5 pass/0 fail，包含原两条真实 Ink 业务测试，以及 setup、unmount、setup+dispose 错误保留回归。它们验证测试夹具的失败处置，不声称复现生产 render 失败或证明 native 时序。原 C/D 候选、旧 378 项与 Native17/18 不改写；最终完整测试/check/build使用新 source epoch。

最终测试夹具先创建可清理的 Ink root、登记 unmount，再执行首次 render；单独 scope 失败测试覆盖环境和错误保留。最终代码/测试 epoch `7879224706f66ef766e609e01a2b6cde24997b8d5d2009ea339257b55e53550b`：terminal-dom-final-tests3 为381 pass/0 fail/2243 expects，check2/build2 exit0、输入无漂移、各自进程组已回收。与 C/D 的2383份非 test 的 src 文件逐字相同；文档、脚本和最终 binary 身份不能据此借用旧结果。

第十八轮真实入口副本 source `efc7bbe0f9fe3b45ef50fbcedde3519bd9f9afa2c81fc17521eb07e9486f5db0` 完成29/29，22通过、7失败，退出1；binary `eeb7bc442c3c947c22757a90c6ef305bf3d87eaffbcbe10e6e1eb11108dfc5cf`，manifest `04a2a3e430910025f8f03f5f51654ba06eab3360d09040c6586a5c53b3af02f3`，证据目录 full-gate18-evidence。失败builtin-mods、code-review、nested-agent、terminal-canonical-diff、terminal-interaction、workflow、workflow-retry-partial-failure。此副本未包含其他工作区功能改动，不能把第十七轮结果继承给它。

canonical在首次独立Tab（canonical_tab_landing_0）停止：输入09的floor frame64之后，frames65–67的public与actual焦点仍为source；base实际登记且emptyButton=true，但未取得实际焦点。后续resize/关闭重开未执行。77帧physical回放本轮成功不代表输入业务链通过。terminal-interaction缺少native-pty-eof/有效帧，broker childReaped=false；driver pane进程清理不能替代原native进程组与EOF证明。整体及功能组合门禁保持未通过，不借旧成功片段、不放宽断言，也不宣称293或四路正式发布通过。

CHANGELOG补充第十八轮22/7摘要后，最终source epoch为 `7a49839887a8f8178ae3b3506e7e9fff1aab36e1cfd6f69c137cd346697b3523`；terminal-dom-final-tests4仍381 pass/0 fail/2243 expects，check3/build3均exit0/sourceUnchanged，且PG已回收。旧787代码与14份生产源码保持逐字一致，旧结果封存。Native18独立矩阵仍failed；terminal-interaction同时存在diff_closed业务失败与采集/EOF缺口，不能描述为只有观测失败。
