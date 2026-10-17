# Pane 焦点环与官方 2.1.295 的对齐

这是 Pane 焦点功能及验证有效性的修复记录。完整 Mods/UI、官方 diff、浏览器 Client 生命周期、实际 OS 输入归属、产品调度时序和默认发布矩阵仍需独立验收。固定官方制品和来源延续 [Button 验收记录](mods-button-295-validity-20261009.md)；未执行解包 JavaScript。

## 操作与实现

已持键 Pane 的 Tab/Shift+Tab 按顺序循环作者控件、其他可见 Pane 的标签及关闭位置。Enter 激活当前标签或关闭位置；关闭位置的焦点不会释放整个 Pane。其他 Pane 移除后，持有的标签或关闭位置按 owner/id/close 身份保留，不能仅存数字索引。

没有可滚动溢出时，上下键在作者控件间循环，不经过标签或关闭位置；空 Pane 不派发无意义的滚动或控件焦点事件。有溢出时，Pane 上下键优先滚动；Input/Select 仍先处理自身编辑键。Client 内部有独立 native focus，Tab 从当前实际注册的控件继续；鼠标使 native focus 为空时，RenderElement 控件仍保留已协商的自定义键盘槽位。

鼠标激活 RenderElement Button 只产生 press；其 wrapper 清除临时 native focus，阻止反向覆盖 custom keyboard focus。按钮反色由当前 native focus、hover 或已接受的实际 DOM 槽位决定，同插件同 key 的两个按钮不会一起错误反色。Client 本地控件保留自己的 native 焦点路径。

Pane 标签反色条件为 shown 或 held 或 hovered；shown 标签加粗，held/hovered 的非 shown 标签使用 dimColor。宽度、截断及窗口激活点击处理与固定官方 r0 规则对齐。

## 类型和协商

`ModUiHostFocusOptions.engine?: true` 是宿主内部参数，不新增 Mods 作者 API。宿主 `focusHost` 只允许 person 来源、无 element 的 engine 移动；公开 person `ui.focus` 的无 element 请求继续表示释放 Pane。真实 middleware 可拒绝、withhold 或改写；没有 core-applied 的假成功回执不能造成引擎槽位跳转。

每次移动仍检查实际 owner、可见性、composer/dialog 所有权、AbortSignal、person generation 及绘制 revision。异步焦点必须等对应发布提交后再处理后续键，不允许旧回执覆盖新的 person move。debug 的 engine-focus-applied 记录 requestId、plugin、origin、focused 和发布 revision。

固定官方静态规则：Bne 根据 scroll.maxOffset 覆盖 ring 的上下键；Une 对 controls+tabCount+close 做模运算；r0 处理标签绘制及鼠标；Qt wrapper 处理临时 native focus。具体模块摘要和 Unicode offset 保存在新证据目录 `official-focus-source.json`，静态规则不代替 binary 对照。

## 回归与真实入口

```sh
bun test --no-env-file \
  ./src/components/ModsPane.focusRing295.test.tsx \
  ./src/services/mods/paneEngineFocus295.test.ts \
  ./src/components/ModsPane.test.tsx \
  ./src/components/ModsPane.buttonChildren295.test.tsx \
  ./src/components/ModsPane.keyboardCapture.test.tsx \
  ./src/components/ModsPane.automaticFocus.test.tsx \
  ./src/components/ModsPane.pluginFocus.test.tsx \
  ./src/services/mods/ui.focusOwnership.test.ts
make release-check
make build
```

新最小回归经过真实 Worker、提取的 REPL onFocus 回调、Ink stdin、AlternateScreen 和独立 xterm cell replay；覆盖 Tab+Enter 同块、鼠标、重复 key、deny/withhold、晚到/abort、标签消失、空 Pane 及真实溢出。pointer fixture 必须定位实际绘制节点，不能从隐藏 Pane 的同名标签取坐标。

使用本轮构建及其 SHA-256 运行：

```sh
bun scripts/validate-mods-button295.mjs \
  --binary /absolute/path/built-claude \
  --binary-sha256 SHA256_LITERAL \
  --evidence-root /private/tmp/claude-test/new-pane-focus-run
```

独立官方对照使用固定官方产物及其 SHA-256，加 `--mode official`，并使用另一个全新证据目录。脚本执行24步骤、7次焦点/hover观察、resize、关闭/重开及正常退出。local 还要求同run bounded native frame/resize replay，official 缺本地logical producer，只判行为。该专项只有两个作者按钮，不覆盖全部多Pane标签矩阵的真实binary流程，后者还须通过完整driver。

本轮新建记录为 `/tmp/claude-test/mods-focus295-20261009-4luam14j/VALIDATION.md`，包含原RED、修复结果、全部准确命令、源码/制品身份、清理及缺项。12项旧回归失败逐项说明于同目录 `test-oracle-changes.md`。归档只保存证据，不改判失败；任何源码或文档变化都需要重跑受影响验证。
