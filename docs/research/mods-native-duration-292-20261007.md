# TurnDuration 的原生 Mods render：官方 2.1.292 对照

## 范围与变更契约

基线为 `fdb50dcac046a419939b989e18c454e4f8148c46`。本批将生产 `SystemTextMessage` 的完成行接入可复用的原生绘制宿主：真实 Worker、原生 `next(e)`、多次续绘、Client、按钮回调、按输入匹配的启用/禁用、生命周期及实际 viewport/onScreen。完成动词使用消息 UUID 的 UTF-16 哈希，保留历史原始耗时。`showTurnDuration=false` 仍允许插件替换行。

原生行和 engine ref 只在宿主内转为 React 元素，不编码到插件 Worker。共享组件树渲染没有 Pane 外框/滚动容器，不创建公共 Pane；实际回调依赖当前 drawing/owner。非法树回退原生；旧站点迟到绘制不写入新行。全屏范围在 renderer 已确定本帧实际滚动位置后读取，未知不伪造，视口外为 null。

`next(e)` 禁止添加、删去或改变宿主报告的 `props.onScreen`，与官方八种 transcript 组件的规则一致。输入框 presentation 更新只重画 Pane/AbovePrompt；原生站点依赖自己的输入、显式 invalidate 或插件重载，避免用户输入/轮次状态造成重复调用。

该提交还纳入必要的原生站点焦点接口及路由、TerminalSize.global 可选定义和相关旧夹具接口。没有纳入工作区完整的 Client VM、pane/scroll/fault、其他会话/模型变更。全量目标保持开放，不代表全部 Mods、UI 或官方 diff viewer 已一致。

## 官方证据

2026-10-07 重新核对的 [npm latest](https://registry.npmjs.org/@anthropic-ai/claude-code/latest) 为 **2.1.292**，npm shasum `ecf88deee4c6b1b099d14a8571f1d5cad2ff1897`。固定原生二进制为 `/private/tmp/mods-fork-routing-20261007-2afwted_/official/official-claude-2.1.292`，SHA-256 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`，235017328 字节。只静态分析提取文件，不执行提取片段。

| 原生源码 | 核实内容 |
| --- | --- |
| chunk-se94er0s.js，199467，`function jg(` | 真实 TurnDuration 入口和 next 的原生 props 绘制 |
| chunk-se94er0s.js，191099，`function Mg(` | 完成动词表与 UUID 选择 |
| chunk-hx89w1md.js，37086，`function ct(` | 自定义树内的 engine ref 和组件渲染 |
| chunk-hx89w1md.js，41830，`function Ern(` | 站点输入、pending、回退和 viewport 测量 |
| chunk-hx89w1md.js，42647，`function y0(` | 实际 terminal conversationColumns/rows/fullscreen |
| chunk-8jczcb92.js，472075，`var aZe=` | 按组件/输入筛选匹配钩子 |
| chunk-nbtsgw2h.js，25270，`function Xe(` | 实际滚动视口中的相对行范围 |
| chunk-nbtsgw2h.js，26096，`function y2n(` | 按绘制帧稳定订阅范围 |
| chunk-9wa5fx9n.js，615，`function Are(` | UTF-16 32 位字符串哈希 |
| chunk-r9hj3tk2.js，86663，`function mn(` | 禁止重写由 surface 报告的 onScreen |

来源全文件/片段 SHA、偏移在 `official-source.json`。作者接口取自实际官方生成的 `claude-code/index.d.ts`；本地既有 `assets/mods-2.1.292.d.ts.txt` 已声明 TurnDuration 的 word/durationMs 和只读 onScreen，本批不新增作者 noun 或私自放宽声明。

## 自动化回归与修复记录

新增 `src/components/messages/SystemTextMessage.modsRender292.test.tsx` 用实际 Mods runtime/Worker、生产消息组件和 Ink。最初两项替换/续绘 **0 pass / 2 fail**。实现时出现过候选缺少 matcher import、组件默认横排导致文字换行、ScrollBox 宽度/绘制位置未记录、换行夹具转义以及未启用输入监听的测试问题；原始日志全部保留，不拿这些尝试充当最终验收。

最终 **19 项新回归**覆盖替换、续绘、多个独立 next、稳定/重挂载动词、无匹配零调用、隐藏配置、异常回退、启用/重载/移除、Client、真实 viewport、部分可见/视口外、绘制后 scroll clamp、实际 Ink 键盘按钮焦点/Worker 回调、按输入的匹配及宿主订阅、迟到卸载绘制、添加/删除/更改只读范围，以及 presentation 不重复触发原生站点。空 Box 隐藏另由正式原生终端矩阵验证。

首次 11 文件相邻门禁为候选 479/3、工作区 504/2：新原生焦点路由改变了未知 site 的拒绝结果，候选旧断言未更新；watcher 故障夹具缺少新 renderHooks；原有 managed PostToolUse 的 Tool 夹具缺 `isReadOnly`。补齐夹具契约，保留原来的断言和工具输出检查。官方原生 `$.ui.focus` 对不存在站点返回 `not this plugin's site`，候选对应断言与既有工作区一致。

只读字段的首次文字断言还因真实终端换行失败，调整为折叠显示空白后检查完整错误文本，拒绝行为/断言仍保留。三文件中间结果 117 pass / 0 fail。首次正式终端又发现输入框 presentation 导致本地已有行反复收到相同 render 输入，原生初版 184 次 render，官方 68 次；修复后重新构建并运行独立新目标。

最终组合文件如下（所有 Bun 测试使用 `--no-env-file`）：

```text
src/components/messages/SystemTextMessage.modsRender292.test.tsx
src/components/ModsPane.test.tsx
src/components/ModsAbovePrompt.test.tsx
src/services/mods/ui.test.ts
src/services/mods/uiRealm.test.ts
src/services/mods/uiEnvironment.test.ts
src/services/mods/runtimeUi.test.ts
src/services/mods/dispatch.test.ts
src/services/mods/session.test.ts
src/screens/REPL.turnCheckpoint292.test.ts
src/ink/components/ScrollBox.test.tsx
```

| 最终层级 | 准确候选 | 工作区 |
| --- | --- | --- |
| L1：上述 11 文件 | 485 pass / 0 fail / 2240 expect | 509 pass / 0 fail / 2342 expect |
| L2：make release-check | exit 0 | exit 0 |
| L3：make build，独立输出 | exit 0 | exit 0 |

release-check 包含 CHANGELOG 检查和五项既有格式测试、完整 TypeScript、完整 lint、missing-import audit 和 diff whitespace。audit 仍列既有测试引用诊断但 exit 0。每侧三个最终层级使用同一源码清单；硬 timeout 120 秒，源前后相同，全部自有进程组已消失。未运行全仓库所有测试；之前 checkpoint/query 门禁中的九项旧失败、response.md 的旧清单没有据此关闭。

| 侧 / evidence 目录 | 精确命令 | 秒 / exit | 源清单 SHA-256 |
| --- | --- | --- | --- |
| candidate / `candidate-check-final4` | `/usr/bin/make release-check` | 39.974 / 0 | `79f14f500282a668b4fa107ed47583eef9d0697694769da802549277b04afc2f` |
| candidate / `candidate-related-final4` | `/opt/homebrew/bin/bun test --no-env-file ./src/components/messages/SystemTextMessage.modsRender292.test.tsx ./src/components/ModsPane.test.tsx ./src/components/ModsAbovePrompt.test.tsx ./src/services/mods/ui.test.ts ./src/services/mods/uiRealm.test.ts ./src/services/mods/uiEnvironment.test.ts ./src/services/mods/runtimeUi.test.ts ./src/services/mods/dispatch.test.ts ./src/services/mods/session.test.ts ./src/screens/REPL.turnCheckpoint292.test.ts ./src/ink/components/ScrollBox.test.tsx` | 58.581 / 0 | `79f14f500282a668b4fa107ed47583eef9d0697694769da802549277b04afc2f` |
| candidate / `candidate-build-final2` | `/usr/bin/make build CLAUDE_CODE_BUILD_DIR=candidate-build-final2-output` | 3.453 / 0 | `79f14f500282a668b4fa107ed47583eef9d0697694769da802549277b04afc2f` |
| workspace / `workspace-check-final3` | `/usr/bin/make release-check` | 42.295 / 0 | `1999e1a2b0bf20d3a3f9bcb66dd04d8468d2177c7971bb15e96ac59a27235cf9` |
| workspace / `workspace-related-final3` | `/opt/homebrew/bin/bun test --no-env-file ./src/components/messages/SystemTextMessage.modsRender292.test.tsx ./src/components/ModsPane.test.tsx ./src/components/ModsAbovePrompt.test.tsx ./src/services/mods/ui.test.ts ./src/services/mods/uiRealm.test.ts ./src/services/mods/uiEnvironment.test.ts ./src/services/mods/runtimeUi.test.ts ./src/services/mods/dispatch.test.ts ./src/services/mods/session.test.ts ./src/screens/REPL.turnCheckpoint292.test.ts ./src/ink/components/ScrollBox.test.tsx` | 59.125 / 0 | `1999e1a2b0bf20d3a3f9bcb66dd04d8468d2177c7971bb15e96ac59a27235cf9` |
| workspace / `workspace-build-final2` | `/usr/bin/make build CLAUDE_CODE_BUILD_DIR=/private/tmp/mods-native-duration-292-20261007-5n5ztn_j/workspace-build-final2-output` | 3.581 / 0 | `1999e1a2b0bf20d3a3f9bcb66dd04d8468d2177c7971bb15e96ac59a27235cf9` |

## 原生终端交互与副作用

`native-duration.py` 串行运行完整目标直至清理完成；通过 stdin 的逐字十六进制输入注册命令并触发真正模型轮次，记录 ready/submitted/完成/退出 pane、ANSI、PTY、debug 和 transcript。每个目标使用独立 HOME/config/TMP/XDG/cache/socket、占位认证和 localhost API 夹具；禁止访问用户 ~/.claude、Keychain 和外网。没有复制真实凭据、禁用 attachment 或使用 SIMPLE 入口。没有向已有 Claude/VS Code 会话发送输入。

普通矩阵八种状态：替换、上下装饰、两次 next、Client + 原生行、空 Box 隐藏、非法树回退、只读字段拒绝、未知焦点站点拒绝。隐藏配置矩阵单独确认完成行仍能被插件替换。L5 仅对本次两个最新本地制品；L6 固定官方制品。tmux target 均为各自私有 socket 的 `status:0.0`，160 列 × 40 行。

| 独立正式目标 | checkpoint | ui.render 回执 | 秒 | 二进制 SHA-256 / 字节 | 正常退出 |
| --- | --- | --- | --- | --- | --- |
| native-official-o2 | 8 | 68 | 9.352 | `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f` / 235017328 | exit 0 |
| native-candidate-c2 | 8 | 64 | 10.331 | `982c54255a65a498362d8cc83005b484bd5efd4cb42a62775591b368d23f4203` / 102183266 | exit 0 |
| native-workspace-w2 | 8 | 64 | 10.837 | `b1539a360d26d43de2432133da4ddbe7a909f48827bb00a4760dd2241ce77377` / 102051170 | exit 0 |
| native-official-oh1hidden | 1 | 2 | 3.418 | `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f` / 235017328 | exit 0 |
| native-candidate-ch1hidden | 1 | 2 | 4.036 | `982c54255a65a498362d8cc83005b484bd5efd4cb42a62775591b368d23f4203` / 102183266 | exit 0 |
| native-workspace-wh1hidden | 1 | 2 | 4.305 | `b1539a360d26d43de2432133da4ddbe7a909f48827bb00a4760dd2241ce77377` / 102051170 | exit 0 |

`compare-native.py` 对三侧每条 render 输入都核对：terminal/TurnDuration、实际 UUID、与 transcript 原值相同的 durationMs、独立 UTF-16 计算得到的 word、完整 viewport、被冻结的输入/props，以及合法的 first/last/of 或 null/未知。所有八条历史完成记录保留真实时长，不写入绘制改写的 2000/3000/4000ms。只读错误包含实际 props.onScreen 原因，未知焦点拒绝结果三侧一致。隐藏配置三侧各保存一条历史、仍实际显示替换行。

每侧源插件原件 SHA 前后相同，仅创建正常作者生成文件。二进制 SHA 未变，HTTP 所有请求线程停止，tmux pane 和 server 的自有进程/进程组消失。第一次官方 o1 的隐藏断言错把底栏“for agents”当作完成行，故失败；正式 o2 用准确完成动词表达式，原失败未删除。c1/w1 绑定前一版 build-final，作为额外重绘缺口证据；正式 c2/w2 与 hidden 目标绑定最终 build-final2，没有覆盖旧制品或拼接片段。

## 未覆盖与剩余差异

- 全界面像素/单元格等同 **not covered**：官方原生行还有 `· done` 的 locale/timeFormat/timeZone、briefHiddenCount、后台 agent/workflow waiting 等新格式，本批仍保留原 formatter 的这些缺口。
- 完整 Client 初始帧/范围序列及精确回执次数 **未对齐**：普通矩阵官方 68、候选/工作区 64，主要在 Client、readonly、后续 viewport 阶段；不归一化或抹去差异。修复的是输入框 presentation 引起的冗余 native render，不能据此声称所有调用时序相同。
- 滚动 clamp、部分可见/null 的精确控制在真实 Ink 自动化中验证；原生终端矩阵有真实 viewport/范围，未执行所有物理滚轮/resize 场景。
- 按钮 focus/press 为真实 Worker + Ink 输入测试；原生 tmux 矩阵仅验证 Client 画面和未知焦点拒绝，没有据此标记 CLI 的全部交互控件/弹窗焦点流程完成。
- 其他原生 ui.render 站点、完整附件/fork 上下文、官方 diff viewer 全流程、G5/plugin-authoring 六会话测试仍需继续。make 构建本地版本名沿用既有 **2.1.280**；验证的是从当前源码回补的行为，没有把版本号或所有行为升格为已匹配官方 2.1.292。

## Git 与工作区保护

暂存前 HEAD 仍为基线，index 为空。准确候选从 HEAD 单独构造，只包含本批功能和必需依赖；原工作区有大量其他 Claude/WIP，未通过整文件 git add 纳入。`owned-diff-proof.json` 将候选三方投影到冻结 WIP，逐字确认等于当前文件，并保留独立的 Client boundary、dispose 和 fault 方法插入；三个必要的类型/夹具片段原本就存在于工作区，只把相关片段纳入候选。没有覆盖真实文件来“解决”这些证明用的合并。

保护清单含所有原始 Git 可见文件、共享 built-claude/official-claude 和 `/tmp/claude-502/response.md`；只允许本批保留路径变化。提交前再次核对原始 SHA/mtime、已有 Claude PID/启动时间、源清单以及 candidate/index 补丁一致。只做本地 GPG 签名提交，不 push。最终记录存放于：

`/private/tmp/mods-native-duration-292-20261007-5n5ztn_j`
