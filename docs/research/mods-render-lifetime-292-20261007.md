# 原生 Mods 绘制生命周期：官方 2.1.292 对照

## 变更与来源

基线 `087a8fd65aa1ac8df00d3f44e0ab2a096a9681ac`。上一批已接通 TurnDuration，但只防止迟到绘制，未真正取消正在运行的 Worker。本批将 site 绑定提前至首次异步绘制之前，以宿主 lifetime 控制初始挂载与卸载；实际输入取代和显式 invalidate 中止旧 ui.render，丢弃未执行的旧输入。重复输入保留当前请求，非法输入不会取消有效绘制。已绘制画面及旧 callback lease 保留至新绘制提交，被取代的错误不发布，新的有效失败仍回退原生。

作者接口没有增加 noun、方法或参数。onMount/cancelPending 是宿主内部绑定与调度，draw 的 AbortSignal 留在宿主，通过既有 Worker 协议只传递取消事实与原因。原有组合信号会丢弃 reason，因此 ui.render 改用既有的保留 reason 的组合器；环境 abort 分支加入 ui.render，Worker 内可读到 `HooksError: ui.render: superseded`。debug 记录 component/requestId/drawing/reason，不记录完整绘制 props 或认证。

2026-10-07 重新读取 [npm latest](https://registry.npmjs.org/@anthropic-ai/claude-code/latest) 为 2.1.292，shasum `ecf88deee4c6b1b099d14a8571f1d5cad2ff1897`。官方解包源码仅本地静态阅读，没有执行提取片段或上传代码。

| 官方原生源码证据 | Source-confirmed |
| --- | --- |
| chunk-hx89w1md.js，ur，41261 | effect 的新输入/版本和卸载调用 AbortController.abort，reason 为 ui.render: superseded；已取消的响应不改变已绘制结果 |
| chunk-hx89w1md.js，Ern，41830 | 未完成的新绘制与既有 settled drawing、原生 fallback 的消费关系 |
| chunk-vnyc2bdc.js，He，661 | 官方取消原因的类为 HooksError |

全文件与片段 SHA 在 `official-source.json`。作者的 `next.signal` 与 clock.sleep 参数依照既有官方 2.1.292 生成声明；用法同步至 README，参考 [Anthropic Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)。

## 回归证据

原始 RED：在未实现取消的准确候选，既有 19 项通过，三项新增生产回归全部失败，运行 4.766 秒；记录 `candidate-red` 保留。中间阶段还发现干净 HEAD 与工作区 WIP 的接口差别、Worker 未传递原因，以及组合信号把准确原因改为通用 The operation was aborted。都在实际调用链中修复，没有改成宽松 reason 断言。

生产 SystemTextMessage + 实际 Worker/Ink 新增四项：首次绘制等待期间输入变化、初始挂载卸载、已完成画面保留/新等待取代、取消后新绘制失败回退。`uiRenderLifetime292.test.ts` 新增六项：提前绑定/相同和非法输入、只绘制最新排队输入及 release、旧回调等待时仍有效/提交后过期、lifetime abort 和 dispose 只清理一次、预取消不绘制、重复失效立即取消正在重绘的请求。

既有慢绘制相邻测试继续验证独立目标不被阻塞、并发上限和 trailing batch。只调整原生 site 中已被取代错误的预期为忽略，并增加准确 signal.aborted/reason 断言；Pane 的有效失败断言保留。没有删除原测试或通过延迟掩盖真实 Worker 的取消。

最终 13 文件组合包含原生行和 lifecycle 新测试、ModsPane/ModsAbovePrompt、ui/uiRealm/uiEnvironment/runtimeUi、dispatch/session、REPL.turnCheckpoint292、ScrollBox 和 modelAbort。以下不是全仓库测试，不能关闭 response.md 的旧九文件清单或 checkpoint/query 的更宽失败门禁。

| 最终层级 / evidence | 结果 | 秒 | 源清单 SHA-256 |
| --- | --- | --- | --- |
| candidate-related-final | 499 pass / 0 fail / 2327 expect | 65.635 | `12ffffd87a7c43083e67cd0f9ecd23f9be2342d1e8f2f173f61d8d336efecc9a` |
| candidate-check-final | exit 0 | 41.655 | `12ffffd87a7c43083e67cd0f9ecd23f9be2342d1e8f2f173f61d8d336efecc9a` |
| candidate-build-final | exit 0 | 5.414 | `12ffffd87a7c43083e67cd0f9ecd23f9be2342d1e8f2f173f61d8d336efecc9a` |
| workspace-related-final | 523 pass / 0 fail / 2429 expect | 66.726 | `487c69ed98b7096a611456c3895fe901805c18803f06199139ce6e5be7fd518e` |
| workspace-check-final | exit 0 | 44.095 | `487c69ed98b7096a611456c3895fe901805c18803f06199139ce6e5be7fd518e` |
| workspace-build-final | exit 0 | 5.4 | `487c69ed98b7096a611456c3895fe901805c18803f06199139ce6e5be7fd518e` |

每个 runner 使用独立 HOME/config/TMP/XDG/cache、空白凭据环境与 `--no-env-file`，120 秒硬边界；源前后不变，自有进程组停止。release-check 包含 CHANGELOG 检查、类型、lint、missing-import audit 和 whitespace；audit 的既有诊断仍以其真实 exit 0 记录。精确 argv、cwd、环境和 PID/PGID 在各 result.json，日志保存完整命令输出。

```text
bun test --no-env-file ./src/components/messages/SystemTextMessage.modsRender292.test.tsx ./src/services/mods/uiRenderLifetime292.test.ts ./src/components/ModsPane.test.tsx ./src/components/ModsAbovePrompt.test.tsx ./src/services/mods/ui.test.ts ./src/services/mods/uiRealm.test.ts ./src/services/mods/uiEnvironment.test.ts ./src/services/mods/runtimeUi.test.ts ./src/services/mods/dispatch.test.ts ./src/services/mods/session.test.ts ./src/screens/REPL.turnCheckpoint292.test.ts ./src/ink/components/ScrollBox.test.tsx ./src/services/mods/modelAbort.test.ts
make release-check
make build CLAUDE_CODE_BUILD_DIR=<本轮独立输出目录>
```

## 原生终端对照

`native-lifetime.py` 对固定官方和两个本轮新构建严格串行，全部清理后才启动下一个目标。只使用各自私有 HOME/config/TMP/XDG/tmux socket 和 localhost SSE 夹具，阻止真实 ~/.claude、Keychain 与外网；占位认证不复制真实凭据。固定 160×40，首次绘制等待期间实际 resize 至 159×40。逐字 stdin、PTY、ANSI/pane、debug、transcript 和 driver 原件均保存。三个 60 秒等待全部被取消，没有等超时自然完成。

- 已绘制完成行 → 原生 command.run 触发 invalidate → Worker 正在等待时仍显示旧行 → 再次 invalidate 中止它，显示新行。
- 新的真实模型轮次产生 TurnDuration → 初次 Worker 绘制等待 → tmux resize → 旧绘制被中止，使用真实新 viewport 绘制。
- 同一行再次等待 → 真正输入 `/clear` → transcript 消费者卸载，Worker 被中止，清空后没有旧画面。

| 原生目标 | checkpoint | ui.render | 取消 | 秒 | binary SHA-256 / 字节 | 退出 |
| --- | --- | --- | --- | --- | --- | --- |
| native-official-o1 | 2 | 11 | 3 | 6.671 | `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f` / 235017328 | 0 |
| native-candidate-c1 | 2 | 11 | 3 | 7.499 | `a7667b6270cac3e74b5a5a4d006213f1a4a98724bcd429d0cfd12a0df1ca7d04` / 102183266 | 0 |
| native-workspace-w1 | 2 | 11 | 3 | 8.473 | `660da4fe3bd76804bfbb823d3c8b8a9aa0eb930a457acb2c4dd1637675514366` / 102051170 | 0 |

`compare-lifetime.py` 校验每条原始 word/耗时与自己的 transcript UUID、独立 UTF-16 哈希一致；所有 render 输入与 props 冻结，viewport 和实际 onScreen 合法。三侧实际 render **各 11 次**、总回执 **各 29 条**，mode/held/viewport/onScreen 的完整字段序列一致；三个 hold/abort 逐一关联同一真实 requestId，准确 HooksError 原因一致。已显示行、新行和 /clear 后消失分别从同次 pane 核对。没有用恒定时长、固定 UUID 或删除回执来归一化结果。

`native-neighbors.py` 用这两个相同新制品另跑八种替换、next、多次 next、Client、隐藏、非法树、只读字段与未知焦点拒绝；官方同样新运行。每侧均保存 8 条原始 checkpoint，全部使用真实 durationMs，临时绘制的 2/3/4 秒不写回历史。

| 邻接矩阵目标 | checkpoint | ui.render | 秒 | 正常退出 |
| --- | --- | --- | --- | --- |
| native-official-o2 | 8 | 68 | 8.059 | 0 |
| native-candidate-c2 | 8 | 64 | 10.041 | 0 |
| native-workspace-w2 | 8 | 64 | 9.66 | 0 |

两个比较器检查所有原件 fixture SHA 不变、binary SHA 不变、pane/server 的自有进程组消失、HTTP 所有线程停止和无 dropped UI warning。普通矩阵仍是官方 68 次、本地 64 次，原有 Client/viewport 序列差异没有被本专项的 11 次相等掩盖。没有宣称全界面或所有调用序列一致。

## 验收边界和工作区保护

- 通过：实际 Worker 中的原生绘制 supersede/unmount 信号、准确取消原因、新输入及时消费、等待时保留已有画面、回调 lease 和同次终端 resize/clear；相关组合、类型/lint、当前构建及邻接绘制矩阵。
- 未覆盖：Client 模块在异步初始化/同步过程中被取消的完整矩阵、全部焦点/弹窗/键鼠控件与 physical frame 一致性、桌面/mobile/vscode 的 attach 取消全流程。终端通过不能扩展为这些场景通过。
- 仍开放：官方 held rows、TurnDuration 的 doneAt/briefHiddenCount/agent/workflow waiting formatter、其他 12 个原生 site、完整附件/fork 上下文、官方 diff Mod 全流程、G5 与全量门禁。故总体目标继续 active；构建版本仍为已有 2.1.280，行为按 2.1.292 对照。

冻结 3173 个原始文件，只修改 9 个保留路径，3164 个原件 SHA/mtime 不变；共享 built-claude、official-claude 与外部 response.md 均保留。两个已知其他 Claude PID 94223、70780 的启动时间与命令未变，未发送输入或信号。候选只从 HEAD 构造，不纳入完整 Client VM、fault/caller-chain/overrun 等 WIP。

必要 rollback 小段已存在于原工作区，但干净 HEAD 尚缺；本批候选只采纳保持旧 drawing 的变量/回滚分支。`owned-diff-proof.json` 对十个代码/文档路径作三方投影并逐字等于实际工作区：proof 中保留已有 terminalSize、恢复 scope、callerChain 和 overrun bookkeeping，加入本次取消信息；冲突只在临时证明文件中处理，没有重写实际文件或覆盖其他工作。

本次精确候选的 11 文件增量经分层验证后，本地 GPG 签名提交，不 push。完整本地证据目录：

`/private/tmp/mods-render-cancel-292-20261007-6o82zqil`
