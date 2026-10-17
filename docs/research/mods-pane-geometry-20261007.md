# Mods 面板尺寸、框架与 grip 对照（2026-10-07）

本批修复默认及请求宽度、实际 host 高度、inline 高度预算、控件框架、关闭标记，以及 grip 的焦点/悬停颜色和关闭重开时的状态清理。独立提交候选与工作区的新构建都在本轮 19 个阶段，与固定官方 2.1.292 的**完整面板矩形**字符、样式、绝对位置相同。比较包括边界、正文和控件，不覆盖整个终端帧或完整 Mods 能力。

## 来源与隔离

- 基线 `feat/mods@f287fe4f43ab654cfb9ade8f7f99ce56abab4d93`。独立候选是 HEAD 加本批补丁，不包含其他 Claude 的 API、焦点所有权、band、终端客户端及声明草稿。
- 官方版本来源：[Anthropic 包元数据](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)，本轮固定 2.1.292。
- 官方二进制：`/private/tmp/mods-fork-routing-20261007-2afwted_/official/official-claude-2.1.292`。
- 官方 host 解包模块：同目录 `extract-292/all/chunk-8q7p93rh.js`，SHA-256 `62fa248db070e465f3aeb727884b114d1da3b25ab79540ca573dbb152e57cb84`。本批核对宽度、inline 预算、独立 grip、hover/drag 状态和 host 布局；窗口范围记录在 evidence 根的 `official-geometry-provenance.json`。不把官方解包源码加入仓库。
- 本轮证据根：`/private/tmp/mods-pane-host-zlrsp523`。三个 native 流程串行运行在独立 tmux/config/HOME/XDG/TMP 根，使用占位认证、sandbox 禁网和私有 Git 夹具；没有复制用户认证或写入真实配置。正常 `/exit` 均为 0，只清理拥有并核对过身份的进程组。
- 原工作区冻结 3133 个文件、277 条 pending 状态。`preservation.json` 验证本批自有增量逆向后原 WIP 内容相同，其他文件字节未改变；共享 `./built-claude`、`./official-claude` 和原 response/fix-instructions/improvment 保留。

## 行为与断言

| assertion_id | subject / predicate | 必要及实际证据 | runtime_state | verdict |
| --- | --- | --- | --- | --- |
| GEO-1 | 默认 dock 外宽 `min(floor(columns*0.45),90,columns-70)`，body 扣 1 grip 列；显式请求按外宽 24 与对话剩余 24 列夹取 | hostGeometry 9 案验证 snapshot 和真实 drawing props；19 阶段 native 面板比较 | done | passed |
| GEO-2 | 可用 body 高度来自实际 Yoga main row，扣 1 控件行；composer 保持全宽 | hostGeometry 3/12/20/1 行 composer 实际布局；native 160×40 及宽度变化 | done | passed |
| GEO-3 | inline 圆角框、自然高度、独立预算；空内容允许 0 body 行；109/90 列保留官方 diff 扩大终端提示 | hostGeometry 5 案与 ModsPane/ui 回归；两次 inline 全矩形比较 | done | passed |
| GEO-4 | 隐藏 Pane 不提交覆盖旧内容的测量；尺寸更新能保留滚动数据 | ModsPane/ui/runtimeUi 相关自动化；native 长内容 PageDown/PageUp 真正移动及隐藏 diff 重现 | done | passed |
| GEO-5 | 关闭标记位于控件区，点击不冒泡且关闭一次；Esc 遵循 pane 契约 | 真实 Ink 坐标和调用计数；native diff 按钮关闭重开；probe Esc 的 person 事件及实际消失 | done | passed |
| GEO-6 | grip 在 focus 或直接 hover 时使用 suggestion 色，body hover 不点亮；关闭后 hover 清除 | 有颜色的真实屏幕 cell 测试含关闭重开；官方/base→hover→reopen→body/focus 颜色投影；19 阶段包括边界 | done | passed |
| GEO-7 | Enter 回调一次、长内容按实测 bodyRows 翻页，composer 输入保持可用 | 三方同 driver、同输入；KPROBE-PRESS 仅 1、scroll by=±bodyRows、内容行变化、正常 /exit | done | passed |
| GEO-8 | debug metrics 提供 plugin/id/drawing/placement/bodyRows/contentRows/scrollOffset | 候选与工作区实际 debug.log；未要求与官方日志字符串相同 | done | passed |
| FULL-PARITY | 全部 API/类型、所有 UI/操作流程、G5 | 不在本批覆盖范围；没有必要完整证据 | n/a | not covered |

多个 composer 高度、零行/请求高度、隐藏测量的完整组合目前由真实 Ink/service 测试证明；不能把固定 40 行 native 流程扩写为所有终端高度或所有 overlay 组合已通过。

## 精确检查和构建

从两份 source root 各自执行：

```sh
bun test --no-env-file \
  ./src/components/ModsPane.hostGeometry.test.tsx \
  ./src/components/ModsPane.keyboardCapture.test.tsx \
  ./src/components/ModsPane.test.tsx \
  ./src/services/mods/ui.test.ts \
  ./src/services/mods/runtimeUi.test.ts \
  ./src/services/mods/uiEnvironment.test.ts \
  ./src/services/mods/diffTakeover.test.ts \
  ./src/plugins/bundled/shippedDiffStartup.test.ts
make release-check
make build CLAUDE_CODE_BUILD_DIR=<本轮私有产物目录>
```

| source | 本轮 source manifest SHA-256 | 相关测试 | release-check | make build |
| --- | --- | --- | --- | --- |
| candidate | `2f8cf733f80a2ed1527f8881bad8b73dfa2f5f20e8768ab7900f4660b5faacc1` | 364 pass / 0 fail / 1993 expect / 8 files | exit 0, 42.094s | exit 0, 4.778s |
| workspace | `e0e406c54f40f5f5ea257b06aa465752531d44a463654c2b381dc1aafba86556` | 385 pass / 0 fail / 2059 expect / 8 files | exit 0, 43.492s | exit 0, 5.071s |

候选与工作区测试数不同，是工作区仍包含其他未提交回归；两份结果不相加，也不代表全部测试。source manifest 覆盖 src/types/vendor/scripts/assets 和实际内嵌的 CHANGELOG；README、验收报告及账本不进入 binary。最终回填报告后再次核对 source manifest 与 staged blobs。Makefile 的本地版本仍为 2.1.280，未改版本号。

| binary | 本轮 SHA-256 | bytes | evidence |
| --- | --- | --- | --- |
| official | `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f` | 235017328 | `native-official-o5/evidence/result.json` |
| candidate | `e839d618955ddb25eebcecda32f28c1c9d21ac74e612f795c4d767df22c4068d` | 102100706 | `native-candidate-c5/evidence/result.json` |
| workspace | `665594535bc089a65ea3ef8ae05e6671c5fa8436114da1aa53234a3085a4e863` | 102001634 | `native-workspace-r5/evidence/result.json` |

每个 binary 的绝对路径、mtime、精确 argv、环境、terminal、session target、raw PTY、输入字节、pane txt/ANSI 和 debug 均保存在对应 evidence。driver SHA-256 `da39bc60da4806ff2888bc916e8b9a2603fc668cb8dd3094d6cfbe6a89a1be84`。driver 有 90s 全局、15s 常规目标、5s frame convergence 上限；predicate 成立并有稳定 frame 才通过。没有因失败延長预算或用固定 sleep 充当成功。

## 本轮 native 对照

独立候选 `native-candidate-c5` 和工作区 `native-workspace-r5`，分别与 `native-official-o5` 比较。`candidate-final-native-comparison.json`、`workspace-final-native-comparison.json` 均有 19/19 `exactPanelCellsEqual=true`，differenceCount=0；sameDriver、sameFixture、sameKeyboardInputs、sameResizes 均为 true。

阶段覆盖：首次 diff 打开；160→140→160；grip hover、悬停关闭重开、body hover；ask/disarm；Esc 返回 composer；命令关闭重开；109、90、110、120、200、240、160 列 resize；右上角按钮关闭重开；明确 `$.ui.focus` 后的长内容 probe、Enter 单次、PageDown/PageUp。

比较使用已安装的 `@alcalzone/ansi-tokenize`，不自行解析 ANSI。dock 从边界到右端且包含所有面板行；inline 包含上下框、正文和位置。90/109 列框为 3 行，y=32；110/120 列 dock x=70，160 列 x=88，200 列 x=110，240 列 x=150。它是完整面板矩形比较，**不是整个终端帧比较**。

颜色另有投影：官方与候选未持焦点的边界为 dim，hover 为 suggestion，关闭重开后 dim，明确持焦点时 suggestion。日志中的 probe contentRows 为 82，翻页事件与正文可见行都发生变化，避免对短内容把收到 PageDown 等同于真实滚动。

## 保留的失败与修复证据

- `red-geometry`：HEAD 基线 0 pass / 15 fail；保留原 fixture。当时 drawing 记录参数误把 owner 当输入，后续改为真实第二参数，并保留 snapshot/布局断言；不把该 fixture 失败当作额外产品缺陷。
- `green-geometry`：143 pass / 28 fail；9 项涉及上述 drawing fixture，其他涉及旧 frame/坐标断言。修订为实际 cell/框架和真实 drawing 入参后 `geometry-tests2` 192/0。没有删除测试或降低语义断言。
- 初次 release-check 的新 test.each 换行触发 lint；仅修正调用格式，完整 gates 后续通过，旧失败保留。
- 官方 `o1` 90 列 barrier 错误要求 alpha.ts，而官方实际显示扩大终端提示；按观测改 barrier。候选 `c2` 的 close barrier 未通过，输入 readiness 曾匹配历史 transcript；不能仅据此断言是产品或仅是 driver 缺陷。后续要求 actual cursor row 及 frame convergence，三方最终同 driver 通过。
- 首次 grip 测试因颜色关闭误通过；该结果不算颜色证据。启用 chalk 颜色、断言参考样式非空且不同后 `red-grip-colour` 15/1。styles 比较规范化独立 code 的顺序，保留 foreground/background 的全部 code。`red-grip-final` 用受控恢复暗色/无 hover handler 验证最终断言 15/1，`green-grip-final` 16/0。
- `red-grip-reopen` 在关闭前 hover 后重开留下高亮，真实 15/1；关闭 dock 时清理 hover 状态，`green-grip-reopen` 16/0。最终两份 8 文件测试和新 binary 都使用包含此修复的源码。
- 修复 grip 前 `o3/c3/r3` 的 12 个 diff 阶段面板一致，但额外 4 个持焦点 probe 阶段有 36 个 grip 颜色单元格不同、正文无差异。该历史不被最终 19/19 结果改写。

## 验收边界与提交边界

本批不证明首次 open 的自动焦点与全部 autoFocus/hold 组合、所有 tab/close/drop、多主题和全终端帧；grip pointer drag/键盘 resize/尺寸持久化、作者完整 2.1.292 类型及新方法、全部 hook/event 消费者、G5 全量改动仍需独立实现和验收。native probe 明确调用 ui.focus，不能拿它替代自动焦点验证。当前 author 声明仍来自早期快照；本批新增 bodyRowLimit 是内部布局字段。

本批 staged tree 只包含面板 geometry/框架/颜色、相关回归和说明/报告。工作区另有 ModsBandBudgetContext 导出；候选的新 context 文件只提交 HostRows，工作区额外导出作为 WIP 留存。独立候选经过本轮测试/检查/构建/交互后，用精确 blob 补丁暂存，不用 git add -A 收入其他 Claude 改动。签名 commit/actual tree 另核对；没有 push。完整 Mods 目标仍进行中。
