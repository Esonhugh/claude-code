# Mods Pane 自动聚焦与控件回调验收（2026-10-07）

本批基于 `1a078f49bd1ea24063ae49990fd5bd4dbce485c2`，只提交 Pane 自动聚焦、焦点后激活顺序与 Button 回调参数。独立候选与工作区分别验证，工作区已有的其他改动不进入该候选。完整 Mods/API/上下文/UI/diff 目标仍未完成。

## 实现与官方依据

- Button/Input/Select 的 `autoFocus` 由 Pane host 发起 `ui.focus` 协商，取消控件直接使用 Ink 原生 autoFocus 的旁路。事件的 plugin/origin 取绘制控件实际回调插件，`next.origin` 为 `engine/core`。
- 私有 `focusHost` 保存 AbortSignal 和预期落点；这些控制状态不从作者请求解码。站点失效、键盘交还、composer/dialog 阻挡、焦点已变化及组件卸载后，旧请求不能取得焦点。REPL 返回实际已发布的落点与 revision，等待渲染提交后再应用。
- 拒绝、不调用 next、改写到另一控件、改写到不存在的控件均按确认结果处理。不存在控件的 deny 文本与官方相同。
- 同一 stdin 读取中的方向键与 Enter/Space 有序执行；激活等待焦点协商及其绘制提交，不触发原落点。
- Button `onPress` 转发完整 `ui.press` 参数，与 Input/Select 已有事件回调约定一致；保留 plugin、element、surface、component、requestId。

官方 2.1.292 native 实测有两项必须明确记录的边界行为：`display: 'none'` 的控件仍参与注册顺序并可接收 Enter；不同插件复用同一 key 时，自动焦点事件指向声明 autoFocus 的插件，但终端落在第一个同名绘制槽位，其 callback 参数属于实际被激活插件。本地按此前要求匹配官方行为，作者可省略隐藏控件或使用不重名的 key 避免歧义。

本轮再次核对 [Anthropic package metadata](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)：latest 为 2.1.292，package shasum `ecf88deee4c6b1b099d14a8571f1d5cad2ff1897`。本次固定 native SHA-256 为 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`（235017328 bytes）。这不是公共作者声明已更新到 2.1.292 的证明；现有 `assets/mods-2.1.290.d.ts.txt` 仍为原快照。

解包后的只读源码核对与窗口位于证据根的 `official-source-provenance.json`、`official-focus-source-window.txt`、`official-focusable-order-window.txt`、`official-pane-focus-host-window.txt`。`FVo` 核对首次自动请求和 expected-index 防护；`c4e` 核对包含隐藏控件的注册顺序；Pane host 核对实际焦点落点。源模块身份：

| 模块 | SHA-256 | 本次窗口偏移 |
| --- | --- | --- |
| chunk-pwkr374y.js | 8b93f8413302c356042d9ae35eefb64605e2eb82432f0c3c24d4d0e29a8d078d | 2308705 / 2309372 |
| chunk-5zgdeqqz.js | bdb01e259aeda18e7e81cca5a5ce96d14eb8c6353de6f90a7e1015bda2a3d3c7 | 110740 |
| chunk-8q7p93rh.js | 62fa248db070e465f3aeb727884b114d1da3b25ab79540ca573dbb152e57cb84 | 451217 |

## 最终源码与制品身份

证据根：`/private/tmp/mods-autofocus-1zfoa9oa`。源码 manifest 包含 src/types/vendor/scripts/assets 与 CHANGELOG；README、研究报告与验收账本不参与二进制内容。本轮最终三个门禁使用同一源码身份，报告回填没有改变该 manifest。

| 项目 | 独立候选 | 工作区 |
| --- | --- | --- |
| source SHA-256 | 9d1bb997076dc19ec9629877930d2cacbfbebeb845bb8a94207709487c9be86b | e678de60e12913f657ac62df4c3054d6b58db539899b8123f1de1ff563a732e0 |
| 10 文件测试 | 382 pass / 0 fail / 2154 expect | 404 pass / 0 fail / 2244 expect |
| make release-check | exit 0，42.178s | exit 0，44.821s |
| 私有 make build | exit 0，5.368s | exit 0，5.584s |
| binary SHA-256 | e480843760912e367ea03a7f80fb487389d7212daeb058574d7be2b162d1517d | 09ff6cd770d52fd57b845000c2d7be73cd03fd26742e26d8799eff03261c0cf0 |
| binary bytes | 102117218 | 102001634 |
| binary mtime ns | 1791343681865919821 | 1791343682126739346 |

最终日志分别位于 `candidate-final3-{tests,check,build}`、`workspace-final3-{tests,check,build}`；二进制位于对应的 `*-final3-build-output/built-claude`。本地 Makefile 版本仍为 2.1.280，不能用版本字符串替代二进制身份。每项 120s 硬截止，exitCode/sourceUnchanged/processGroupExistsAfter 逐项核对；全部无超时、源码变化或自有进程残留。

```bash
bun test --no-env-file   ./src/components/ModsPane.automaticFocus.test.tsx   ./src/components/ModsPane.test.tsx   ./src/components/ModsPane.keyboardCapture.test.tsx   ./src/components/ModsPane.hostGeometry.test.tsx   ./src/services/mods/uiRealm.test.ts   ./src/services/mods/ui.test.ts   ./src/services/mods/runtimeUi.test.ts   ./src/services/mods/uiEnvironment.test.ts   ./src/services/mods/diffTakeover.test.ts   ./src/plugins/bundled/shippedDiffStartup.test.ts
make release-check
make build CLAUDE_CODE_BUILD_DIR=/tmp/private-mods-build
```

测试 runner 清除认证环境并隔离 HOME/CONFIG/XDG/TMP/cache；新 Worker+Ink 测试自己设置并恢复占位 key，目录 realpath 后使用。REPL 的 onFocus 回调由 TypeScript AST 从真实文件提取执行，不用模拟回调替代产品路径。旧编辑/Tab 测试保留意图并明确提供已确认的焦点快照；隐藏导航按官方更新断言。自动协商、拒绝与真实输入由新增 10 项测试单独覆盖。

## 改动测试的逐文件独立门禁

最终源码在两侧分别无调用方凭据、独立 HOME/config/cache 与真实 TMPDIR 下逐文件运行；不能将组合 suite 的结果代替此表。每项 exit0、源码 manifest 不变、无自有进程残留。日志位于 `candidate-isolated-*`、`workspace-isolated-*`。

| 文件 | 独立候选 pass/fail | 工作区 pass/fail |
| --- | --- | --- |
| ModsPane.automaticFocus.test.tsx | 10/0 | 10/0 |
| ModsPane.test.tsx | 176/0 | 180/0 |
| uiRealm.test.ts | 8/0 | 9/0 |
| runtimeUi.test.ts | 38/0 | 39/0 |

## 三侧实际终端对照

`native-af.py` 固定 90s 总截止、15s 阶段截止与稳定帧屏障；同脚本/同插件字节/同键盘输入/同 resize，串行启动官方、候选和工作区。每侧独立 HOME/config/tmux socket/sandbox，使用占位 key，禁止真实凭据、keychain 和 TCP；本批无需模型请求。保存 driver、输入、ANSI/txt/pane capture、debug 与完整回调事件。driver SHA-256：`688628f4284889b6970b121cc950635fa5436c6017f5048b71372d26984952fd`。

最终运行：`native-official-o7`、`native-candidate-c7`、`native-workspace-r7`，每侧九种焦点场景均通过逐项断言并正常退出。`status: observed` 本身不计为通过；以 caseResults、pressExactlyOnce、normalExitPassed、binaryUnchanged 及 comparator 结果判断。

| 场景 | 已观察的结果（三侧相同） |
| --- | --- |
| Button / Input / Select | 每次一次 engine/core 自动焦点，正确控件动作及事件参数 |
| deny / withhold | 不授予控件焦点；Enter 不产生控件动作 |
| rewrite | 落在 second，动作与改写落点相符 |
| unknown | 拒绝不存在控件；无动作，deny 文本相同 |
| hidden | first/second/first 的注册顺序；Down+Enter、Up+Enter 同次读取各只激活一次 |
| duplicate | 原插件焦点事件；实际首槽 decorator 被激活一次，来源参数正确 |

相邻真实官方 diff 流程包含打开、140/160 resize、grip 悬停/移开/关闭重开、ask/取消、Esc 交还、90/109/110/120/160/200/240 列、点击关闭重开及 /exit。原始完整证据保留在三个 native 目录的 evidence/；构建二进制前后 SHA、大小、mtime 不变，自有 tmux 清理完成。

## 视觉结果与未完成项

`compare-af.mjs` 使用已安装的 ANSI tokenizer 比较完整面板矩形的字符、样式及绝对位置，未过滤 body 差异。`candidate-final-native-comparison.json` 和 `workspace-final-native-comparison.json` 结果相同：**35 帧中 31 帧完全相同，四帧共 103 个差异单元格，comparator exit 1**。键盘输入、resize、fixture、driver 与作者事件参数分别相同，动作通过不能替代视觉通过。

剩余四帧是 Input/Select 的 held/action。Input 有持焦点 label、占位光标、提交提示，以及重绘后编辑值保留方式的差异；Select 有展开列表、箭头、持焦点 label 与布局差异。它们作为独立控件 UI/状态批次处理，本批没有将 comparator 失败改成通过。`style-red-all-cells.json` 保留全部 103 个原始单元格差异。

Band/Client 自动焦点、全部 API/上下文、2.1.292 公共作者声明、多主题/drag resize/全终端帧、完整 diff viewer、G5 与全部 WIP 的全量门禁均不由本批推导为通过。官方接受动态 command matcher 循环而本地静态扫描拒绝的差异也仍待单独处理。

## RED 与夹具诊断

- 初始 `red-af` 复现 host 未自动派发焦点；后续 `af-fixture-fixed` 暴露 Button 回调未携带事件。分别保留旧失败日志与修复结果。
- 错误的隐藏控件假设经官方 native 证据纠正；不以跳过 display:none 的旧预期改变官方行为。
- `red-same-read-activation` 为 9 pass / 1 fail，Down+Enter 激活了旧 first；队列修复后 10 pass / 0 fail，并由最终三侧 native 隐藏流程复验。
- 早期 observer 顺序、旧焦点夹具、动态 matcher 扫描、decorator JavaScript/加载缺失及观察错误 drawing revision 的诊断日志保留。修正屏障与合法夹具，不加固定 sleep、不吞异常、不延长截止时间。
- 早期 o2/o3/o4 的 duplicate 场景实际上未加载 decorator，其结果无效；以确实绘制 Duplicate 的 o7/c7/r7 为准。临时 Worker 诊断已恢复，未包含在提交中。

工作区原 response.md、fix-instructions.md、improvment.md 与共享 built-claude/official-claude 保留原字节；冻结清单及最终 preservation.json 核对其他 WIP。受保护 Claude PID 94223/70780 仍运行，本轮不向它们发送信号。不 push。
