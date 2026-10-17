# Button 2.1.295、输入处置与 resize 消费有效性

此批是功能和验收修复，不是完整 Mods、UI 或发布通过声明。2026-10-09 [公开包登记处](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)核对的 latest 为 2.1.295；[官方 Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)仍以较早版本描述接口，实际核对使用固定原生制品内的声明与静态模块，未执行解包 JS。

## 来源及实现边界

固定官方 Darwin arm64 制品 SHA-256 为 `0116ee2e0a513900b633d9951367f18747686478e2b462805b8c31609f047f70`。声明基线 2.1.292 的 SHA-256 为 `ec9fb8b86b52427c134e267749aa04ca84e419735e75810f5d2e5fa23f657ab3`；仅替换 `ButtonProps` 和 `RenderElement` 内 Button 分支。增量文件摘要为 `528493b3222e0be73a7a8bac76a5cb89c079bf118524d41863bb0e7f47d2c4b0`，投影后声明体摘要为 `78e405db69f99001ca9fc4e0dc1dd89776742fa5f8163f2d0779aa5a37677b25`。生成器核对基线、增量及唯一片段，其他定义保持原样；不伪造新的具名 `RenderNode.Button` 导出。

Button 的字符串或递归 Text children 绘制为同一控件。没有独立 Yoga 子节点的 virtual Text 使用实际父控件命中区域；一个 press 与一个 Tab 位置。无 children 的旧 label 绘制和单字符串 sugar 保留；非 Text 元素拒收。主要按钮使用终端主题颜色，inactive dim 使用 Text 的实际颜色语义。

官方回调注册表是 guest handle 身份。重复发布同一个缓存 Button 保持 guest；重建 Button 即使回调函数或 key 相同也产生新 guest。host 按当前实际控件接受操作后，core 必须在全体实际 drawing 中检查原 handle 是否仍被持有，包括 `setUiAccess` ACK 前后。最后持有者释放或环境销毁时拒绝尚未进入的调用；已经开始执行的回调不会因之后释放而消失。检查涵盖当前 drawing pool 的合法 UI 回调，不声称该池只含 Button。

静态主证据位置（Unicode scalar offset，非字节 offset）：

| 制品模块 | 区间 | 核对内容 |
| --- | --- | --- |
| 00157 | 20658–21007 | press 获取原 guest closure |
| 00294 | 224805–226072 | drawing 持有/释放 |
| 00783 | 18071–19730 | Button 挂载稳定期及键盘路径 |
| 00510 | 1379–2403 | 单调 Clock 起点及 timeout 取消 |
| 00512 | 135682–136139 | ClickEvent flags/disposition |
| 00512 | 238952–240935 | 同批多语义事件刷新 |
| 00512 | 241814–244400 | 鼠标按下/释放与激活处理 |
| 00512 | 249122–250874 | hit-test、bubble/default focus |
| 00512 | 345128–345597 | mouse dispatch |

终端 Button 挂载后不足 300ms 的鼠标点击处置为 stray；恰好 300ms 可进入。键盘 Enter/Space 立即执行。实例重绘不重置挂载时间。focus gain 后不足 400ms 的首个窗口激活鼠标事件不触发 Button 或 hyperlink；键盘/paste 消耗激活 latch，wheel/response 不消耗。一次输入块包含多个语义事件时在实际语义边界刷新；单个文本或 paste 不逐字符无条件刷新。这里不宣称已证明 OS 输入到 tokenizer/owner 的完整因果链。

## resize tail 首次失败

原记录 `/private/tmp/bb-3EPmTU/cache/runs/r-5fb8fc4eac8d` 的行为通过但 physical 报告失败，原件和 verdict 保持。第一次 resize 的 ACK io35 记录 broker 已消费 tail `12427`；内核 ioctl 前最后成功 write 的完整前缀为 `12472`。原 packet sequence188 的45字节 payload 与 raw 区间逐字节相同，Mach write return 早于 resize entry；第二次 resize 两者均为 `18344`。

Python 从不可变原记录及非重叠 write/resize 括号推导 kernel prefix；JS 旧 equality 将其误当 broker tail。修复只要求 `brokerTail <= verifiedKernelPrefix <= finalRawTail`，并保留原 entries 深比较、目标/调用者/nonce、唯一请求窗口、实际 resize 尺寸及其后的 positive-output physical frame。不是从目标画面选择 resize 位置，也不改写 ACK、原件或 producer expectation。合成回归覆盖合法 lag、低于 ACK 和超过 raw 的拒收；其他原负例保留。

Green6 的42项回归通过；原记录用新 consumer 重放58帧、两次 resize 通过，只是 posthoc 修复证明。该结果不能替代新构建、同序列真实终端、完整动态矩阵，不能改判原历史失败。

## 可重复执行入口

先在目标源运行 `make build`，计算该产物 SHA-256，然后执行：

```sh
bun scripts/validate-mods-button295.mjs \
  --binary /absolute/path/built-claude \
  --binary-sha256 SHA256_LITERAL \
  --evidence-root /private/tmp/new-button-acceptance
```

`--evidence-root` 必须是不存在的绝对目录；脚本另建短路径私有 tmux root，保留原始运行与记录，在报告中引用。使用隔离 HOME/config、dummy credential 和关闭的 loopback provider，不读取共享凭据。脚本核对输入产物、复制产物及结束后的摘要。

行为步骤为：就绪 → 实际 slash 打开 → children 绘制 → middleware 重绘中缓存 guest 的 Enter → 重复 Enter → 同一次 tmux send 命令的 Tab+Enter → 两次尺寸请求及实际控件位置变化 → 同一次 tmux send 命令的子文本 mouse press/release → Escape → 重开 → 原 guest 再按 → Escape → 正常 `/exit`。同步依据实际 pane/状态、请求尺寸和控件位置，deadline 仅作失败超时。每次 resize 使用精确 pane target，输入 bytes、请求/返回、原 native records 和逐帧结果由现有采集链保存。一次 send 不证明一次 child read/tokenizer 批次；实际读取分组未覆盖，App 的语义批次另由单元入口验证。

两种模式都独立读取实际 broker 的 start/launch/cleanup 原件，严格核对同 capture、产物和 child 身份、零退出码、reaped、physical EOF、没有信号及清理错误，并比较两份关闭收据。官方只允许明确的缺本地 producer 状态，不能借它忽略其他采集错误。local 默认还要求业务完成、正常退出/资源关闭、同 run/产物的 bounded native frames 与 resize 全部通过；仅业务完成不足以退出成功。官方对照传固定官方产物和摘要并加 `--mode official`，同样检查行为和清理，明确不具备本地 logical-frame producer，不能声称官方 physical 对比通过。

回归入口：

```sh
bun test --no-env-file \
  ./src/services/mods/buttonChildren295.test.ts \
  ./src/services/mods/buttonDrawingCallbacks295.test.ts \
  ./src/services/mods/declarationsButton295.test.ts \
  ./src/components/ModsPane.buttonChildren295.test.tsx \
  ./src/ink/components/Button.settle295.test.tsx \
  ./src/ink/components/App.windowActivation295.test.ts \
  ./src/ink/components/App.semanticInput295.test.tsx \
  ./src/ink/hit-test295.test.ts \
  ./scripts/native-frame-journal-replay.test.mjs \
  ./scripts/validate-mods-button295.test.mjs
make release-check
make build
```

源或文档变化后须重新冻结并执行验证；不得拼接跨源结果。原 resize probe3 错用旧尺寸的 paint barrier、probe4 resize target 不一致，分别保存为夹具问题，不能当产品 RED。独立 semanticInput295 九案保留真实语义批次；工作区另有 TextInput.onEdit 测试依赖未纳入本批的实现，不声称已覆盖该能力。

## 专项关闭合同复核

Green7 的专项双端原运行业务完成、local70帧及两次resize通过；实际 child 均 exit0/reaped/EOF，原结果保留。但只读审查发现旧 standalone validator 没有独立强制检查官方 child 的退出码，dead pane 不能证明成功退出。red8 最小回归在旧脚本得到3通过/1失败；新拒收覆盖非0/null退出、未reap/EOF、错child/capture、信号和清理错误。官方缺本地producer不能成为非0退出或其他采集失败的例外。修复后重新冻结、构建和运行；不借Green7的实际exit0掩盖缺少拒收的合同。


## 绘制后 hover 与空白命中

固定模块 00512 的 nv/iv/Os/ev/jd（Unicode scalar 250874–252200）分别处理 pointer motion、paint follow、文本内部空白和 hover 资格；Ink followHover 在 scalar346309，四次连续变化后的1000ms暂停由同模块常量控制。00783 的 Button 设置 hoverFollowsPaint；Box 的两个内部属性与 Text 的事件/跟随属性单独转发，不能混入 Yoga style 或新增为 Mods 作者参数。静态模块只读取，不执行。

绘制或布局改变后只重新计算 opted-in 节点，普通 hover 仍由鼠标移动更新；不重复进入已持有的祖先，不调用已卸载节点的 leave。空白像素只有在同一 Text 的两侧都找到该 Text 的字符时才算文本内部；外侧空白及跨 Text 间隙仍为空白。已持有且忽略空白的 hover 在原坐标点击时保持非空，避免自身 hover 绘制抹去字符后丢失点击。非 motion 鼠标事件改坐标、恢复或外部终端交接及退出 alternate screen 会忘记旧指针。连续四次 paint 反馈改变 hover 后暂停1000ms；新 motion 复位，普通无变化的 paint 清空连续计数。

干净前像的最小实际回归为0通过/3失败，独立旧 validator 合同为5通过/1失败。它们已在工作区忽略证据目录重新保存；环境清理中缺失的历史原件不能替代本轮验收。新的 Ink 回归入口为：

```sh
bun test --no-env-file ./src/ink/hoverFollowsPaint295.test.tsx
```

专项脚本在既有 children/press/关闭重开流程内加入：点击 Save 后保留 Other 的 custom focus，Tab 到关闭位置时两按钮均不反色，再 Shift+Tab 回 Other，检查 Save 没有反色；真实 motion 进入 Save 后反色；保持指针不动，用 Other 的两次按键把 Save 移出/移回；随后144/160列 resize 再次离开/进入。七次观察逐字符核对 Save 的反色与 Other 的焦点样式、计数、坐标及 capture ID；ANSI 用独立 xterm 解析，原始记录另存，缺步骤、错案、错误样式/位置或计数拒收。四次实际 resize 均由原 native 消费链验证。

这些 selected-cell 样式观察与 local 的同案 native 逐帧校验分别结算；官方没有本地 logical producer，不能提升为双端全屏逐帧相同。一次 tmux send 仍不证明单个 child read 或完整 input owner。所有相关测试、release-check、build、专项和完整默认矩阵必须在修复后重新冻结的同一源上执行；旧成功不能填补本轮缺口。

## 继续待闭合

专项脚本不替代 `scripts/run-binary-gate.py` 默认完整动态矩阵。此前完整30项27通过/3失败保持原结论；新专项不能降低 required targets 或改变它。真实 input owner/tokenizer、完整 termios、产品调度、所有 Band/Pane/terminal/browser/Client 生命周期、官方 diff viewer、local autocomplete 及其余 2.1.295 新 API/定义仍须逐项实现和验收。`fullReleasePassed`、`fullNativeGatePassed`、`actualInputOwnerCovered`、`productTimingEquivalent` 保持 false。

## 新目录中的复验与剩余焦点差异

新验证文档及每轮独立结果位于 `/tmp/claude-test/mods-hover295-20261009-29pwecpw/`；运行时短 socket 目录使用同根 `mb-*`。旧 failed 原件不更改，复制原件时另存映射及完整哈希。

固定源码 `1a993f5d477cbeaceebc79054a21d60b3e7d063abe478e1462418be3208cd7f0`，12文件86项/301 expect、release-check及build均通过。官方 native-official2 完成24业务步骤、7样式观察、关闭重开和exit0/EOF/reap，仅为专项行为 passed。相同操作的 local2 在 focus-stop 超时，整体 failed；88帧和两次真实resize的有限native replay、原始内容与IO及正常退出通过。各轮明确不覆盖 actual input owner、产品时序或完整发布；本文后续补录不重新签发旧轮通过。

官方静态模块 Qt 的 wrapper 在 click 后 gKn blur，内部 Button tabIndex=-1，chrome 同时取 custom hasKeyboardFocus；鼠标 press 不迁 custom keyboard slot。真实官方原日志和新专项均证实 Other→点击Save→Tab到关闭位置。当前本地 onFocus→requestFocus 和末项Tab钳住仍不同，必须补独立键盘 holder/关闭位置实现，不能改通用 Ink clickFocus 或将 public undefined element 的 relinquish 语义改作 engine slot。

新增 absolute 命中基于官方 ZV（原模块00512 Unicode scalar249122）及DOM祖先保守标记。实际最小RED为4通过/6失败；修复后合并hover/hit-test23通过，含真实布局。插入、重挂载、后设absolute与overflowX/Y分别覆盖，未新增 Mods 作者私有参数。

零输出观察新增 `native-pre-layout-observation-v1` 边界：必须无任何成功、失败或零结果write记录穿过原layout至不可变copy，layout/begin前缀相同。普通帧仍按 `native-frame-end-v1`；新报告是 `native-per-frame-boundary-v2`，逐帧字段由原记录派生，全部cell/style/cursor/root/shrink-tail照常比较。ACK严格在原clock/raw位置应用，保留帧间output与tail，resize必须有后续真正positive-output paint。验证器/canonical/final/archive同步消费；原local1重算到frame80仍拒绝真实事务重叠，不能跳过或升级该旧失败。
