# Mods 面板的键盘处理顺序

本批修复持有焦点的面板被 legacy composer 提前消费按键的问题。完整 API、最新类型、UI 和 G5 对齐仍未完成。

## 实现与最小回归

基线为 `f6b576f531230a5d5e7a24934b74c84689cb3ca0`，独立候选位于 `/private/tmp/mods-diff-292-yah16a95/keyboard-owned/candidate`。

`ModsPane` 在 capture 阶段给当前面板的活动 DOM 节点派发离散 KeyboardEvent；先检查 wheel、全局 binding/chord、可见性和事件是否已经派发。面板阻止默认操作或立即停止传播时，不再让 composer 消费同一按键；未处理输入继续传递，Tab 保留焦点遍历。隐藏或不持有焦点的面板不接管输入。

`Source-confirmed`：独立补丁仅新增这条 capture 路由及必要 import。工作区原本存在同一路由及其他 UI WIP，本轮没有改写它的 ModsPane.tsx 或 ModsPane.test.tsx；暂存的是独立候选的最小补丁，其他源码改动继续留在工作区。

- `red-capture`：真实 Ink Readable/Writable 输入流中，先订阅的 composer 停止传播，Enter 未到达按钮，0 pass / 1 fail。该 RED 是修复必要性的证据。
- 新测试检查未处理 z 只透传一次、Enter 只触发一次按钮、Down 调用一次滚动、非关闭 CSI-u Esc 交还焦点并等待 React 提交，随后 Enter 只到达 composer。
- 保留旧用例并修正六处布局期待值及一个名称：当前基线 composer 已全宽，pane bodyRows 随 composer 高度扣减。这些旧断言不是官方视觉一致性的证据，不删除、跳过或降低交互断言。
- 其他回归覆盖 Tab/BackTab、完整/取消 chord、unbound、隐藏目标、focus deny、绘制清理、关闭与非关闭 Escape。

## 可复现门禁

证据根：`/private/tmp/mods-diff-292-yah16a95`；以下路径相对该目录。

| 门禁 | 独立候选 | 工作区 |
| --- | --- | --- |
| 两个真实相关测试文件 | keyboard-owned/keyboard-rebased-tests：156 pass / 0 fail | keyboard-owned/keyboard-workspace-final：181 pass / 0 fail |
| make release-check | keyboard-owned/keyboard-rebased-check：exit 0 | workspace-current-check：exit 0 |
| 本轮 make build | keyboard-owned/keyboard-final-build2：exit 0 | workspace-keyboard-build：exit 0 |

测试命令：`bun test --no-env-file ./src/components/ModsPane.keyboardCapture.test.tsx ./src/components/ModsPane.test.tsx`。release-check 包含 changelog、tsc、lint、missing audit 与 git diff --check。make build 通过 CLAUDE_CODE_BUILD_DIR 输出到私有目录，共享 ./built-claude 没有替换。

三个门禁的完整源码 manifest 逐项相同，source SHA-256：

- 独立候选：`64013bc6bc54d09d8abc08e034de2461ddb1a508d7a1ca62634621b17a46380a`
- 工作区：`30cbb0d3bb9be884613a6c125f6f19b62f54f89524d5e71e1dbc36cb9278712d`

之后只补充 README、mods-test 和本报告；这些文件不进入上述源码 manifest。CHANGELOG、源码、测试和资产没有在门禁后变更。每项保留 before.json、result.json、stdout、进程归属及清理结果。

## 实际二进制对照

`Runtime-observed`：同一最终 `keyboard-owned/native-probe.py` 串行运行官方 2.1.292、独立候选和工作区新构建。对应 o10/c10/r10 的 result.json 均为 observed、normalExitPassed:true、pressCalls:["1"]、binaryUnchanged:true，无 cleanupError。最终 driver SHA-256 为 `ac26c40aa853e1fa8691cf7bfcb87e7772b3244908f3eb094e280b3bddfb3ce2`。

- 私有 HOME/config/tmp/cache/runtime、Git fixture、占位认证；禁止网络、真实 Claude 配置与 Keychain 访问，验证结束只清理本次拥有的 PGID/tmux。没有读取机器认证或干预用户已有 Claude 进程。
- 终端 160×40，dark/fullscreen；先 /diff 打开、160→140→160 缩放、鼠标 ask/取消、Esc、/diff 关闭与重开。稳定屏障为 ANSI 单元格连续至少 400ms 不变。
- 私有插件以 ui.open({focus:true,closeOnEscape:true}) 打开面板，再只通过 ui.focus({requestId,key}) 取得按钮焦点；不同时设置 autoFocus，避免两个焦点请求竞态。
- Enter 的真实 Worker 回调计数、PageDown/PageUp 的 ui.scroll 事件及 Esc 的 ui.close(person) 均通过 $.ui.log 到私有 debug 文件；页距离等于各 host 实际 bodyRows，内容仅两行，因此本次不证明长内容实际滚动位置。
- Esc 后 /exit 字面命令到达 composer 并以状态 0 退出。非关闭 Esc 的交还路径另外由真实 Ink 输入回归覆盖，不把本次关闭面板当成非关闭路径实测。
- 三侧完全相同的键盘输入、resize、Git fixture 均由 comparison.json 核对；鼠标坐标随真实控件位置计算并保留。

## 保留的失败与边界

1. 裸 Esc 紧接后续文本的旧驱动被解析成 Alt；a1/a2 等失败保留，CSI-u 明确编码后通过，未延长 deadline。它们不证明生产键盘 bug。
2. o4：点击官方 diff 按钮后直接 Enter 的假设失败；鼠标点击不会主动取得键盘焦点。
3. o5：错误 fixture 传 closeOnEscape:false，被官方 host check 拒绝。合法输入只为 true 或省略；省略时交还焦点并保留面板。o6 错把省略理解为关闭，关闭屏障失败。
4. o7/o8 的官方 autoFocus 流程通过；c8 未观察到候选 autoFocus 的 ui.focus 日志，且退出时还持有焦点，两个屏障失败。自动焦点 hook 的完整对齐仍待单独验证，最终主动 ui.focus 的通过不能替它背书。
5. o9 同时 autoFocus 与主动 ui.focus，官方主动调用得到 deny: the focus moved meanwhile。最终 fixture 只保留主动入口，使用公开合法 API 建立可核对的前置条件；全部失败文件和 driver-used.py 保留。

| 断言 | 结论 | 证据 |
| --- | --- | --- |
| 面板键盘先于 legacy composer，且不重复派发 | passed | 最小 RED、新回归、相关 156/181 项 |
| 显式 focus 后 Enter、页键、关闭 Esc 及恢复命令输入 | passed | native-official-o10 / native-candidate-c10 / native-workspace-r10 |
| 独立候选完整 diff 面板字符、样式、位置 | failed | candidate-native-comparison.json：四阶段 border 80/70 vs 官方 88/77，完整单元格不等 |
| 工作区四帧右侧 diff 面板字符、样式、位置 | passed，依赖其他 WIP | workspace-native-comparison.json：四阶段完整 36 行相等，不能推广为独立提交效果 |
| 完整 autoFocus hook、长内容滚动、全部 UI/类型/G5 | not covered | 保持后续专项与整体门禁待验收 |

[Anthropic plugins 文档](https://code.claude.com/docs/en/plugins) 是使用背景；本次内部键盘与焦点契约取自固定 2.1.292 制品、其作者声明和上述真实调用。
