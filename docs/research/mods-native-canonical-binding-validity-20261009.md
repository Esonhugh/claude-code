# 原生 canonical 帧与动作绑定（2026-10-09）

默认 native capture 已有真实 frame/IO 前缀，但 canonical consumer 仍读取旧 FIFO `broker.start/end`。Native44 的真实 `canonical_alpha_dock` 因关联缺失而失败；旧失败和原件保持不变。这里实现 native 专用关联，不补造旧 ACK 字段，也不改原输出、帧号或默认完整矩阵。

## 实现与拒收条件

- 原始 packets 解码后为每帧导出 `nativeSpan`：原 nonce/PID/timebase/openedAt、线程、四种 marker 的序号及 entry/return、原 write 返回值/errno/成功物理字节数。所有 uint64 时钟跨 JSON 使用精确十进制字符串；超过 `2**53` 仍准确。live 与 closed 原件必须逐字一致。
- context 绑定本案 host launch、expected binary digest 和实际 child PID；只读取 owned regular 0600 `start.json` 及两次有界 256 字节 journal header，不消费 live slots/counters。缺少身份、错误 JSON 类型、截断、FIFO/链接或 inode/size 漂移均拒收。最终仍必须重验 closed originals 和独立 replay。
- 帧按 marker/write brackets 绑定真实 Mach `TIOCSWINSZ` 及 IO prefix；跨 resize、旧几何和外国 clock 不允许借用。合法失败 write 保留 `result=-1`、原 errno 和零输出；随后成功 retry 独立计入真实 prefix。成功 syscall 可以保留 stale errno，不能因 errno 非零误拒收。
- 零输出快照标为 `logical-observation`，只有此前同 capture/clock/renderer/root/geometry、相同 rawEnd 且完整 decoded frame 相等的真实输出帧可以成为 source；它没有新的物理绘制事务。跨 root 的旧帧或 resize 后的旧尺寸继续拒收。
- 输入关联只在 action receipt 到 checkpoint 的 frame/IO/raw 有界窗口内匹配唯一完整 bytes；允许记录中的真实分片，排除动作前输出和清理阶段的相同输入。原输入文件必须为本案 owned regular 0600，bytes/hash 与 receipt 相同，tmux parent `sent` 命令结果必须成功。resize 动作以同 actionId 的 `resize-send` 为下界；严格核对 `resize-return` 的尺寸、成功命令和单调边界，再绑定窗口内的真实 ACK。ACK/帧可以先于 parent command return 到达，不能用 return 的观测边界排除它们。最终重验要求内嵌 send 与原 geometry journal 唯一收据相同。
- live pane probe、dock fallback、最终 UI 检查和归档重验使用同一个 native 关联；继续要求当前 UI revision、实际 DOM pane、focus、painted geometry、keyboard 与完整 lifecycle，不以文本 marker 代替。

最终检查认证现场已经记录的 exact frame，保留 checkpoint 上界和所有原 action/IO/geometry 校验；不会在稍后已经推进的边界重新选择另一帧，也不会让后来正确的帧覆盖原记录的坏帧。输入 producer 使用 exclusive/no-follow `0600` 创建原始 bytes 文件，拒绝覆盖已有记录或 symlink；不修改历史原件的权限，也不放宽 native reader。

## 已保存的证据与边界

历史 Native44 原件经新 consumer 只读重算：47 帧的已有字段与原 frames 完全相同，仅追加原 packet 导出的 span；原件 hash 复读不变。新匹配能找到 frame41/UI revision5 的 alpha dock。报告位于 `/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/native-canonical-span-green4-recorded1/report.json`。这是历史 closed originals 的 consumer 契约验证，不能修改原 failed verdict，不能当新 binary 的 open/close/reopen 通过。

新增 synthetic binding 测试及 producer DTO 回归覆盖错误身份/类型、uint64、几何重叠、旧 root、动作前帧、窗口外重复输入、真实分片以及 regular-file 条件。首次 consumer interface 缺失、launch 身份变量覆盖、旧 fixture 把 frame 当 IO 和验证脚本引用未构建 binary 分别保留；夹具/运行条件错误不记为产品 RED。`native-canonical-span-red5-canonical1` 保留合法失败 write 被误拒收的最小失败回归，它也不是实际产品 UI 错误。

Native46 新 binary 的原默认完整30项仍为27通过、3失败，源/Git/binary无漂移且本轮 owned group 已退出。canonical 首次失败已推进到 `canonical_inline_same_identity`：同一 action 的 send 为 IO64，实际成功 ACK 为 IO65，parent return 为 IO66；旧 consumer 错把 IO66 作下界，误排除 ACK。最小回归 `native-canonical-span-red8-canonical1` 保存该 consumer RED，本次改用实际 send 下界；它不证明产品 resize 错误，也不替代修复后 fresh build/完整矩阵。历史 manifest 为 `/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/full-gate46-evidence/driver-final-manifest.json`，SHA256 `9172874db3a752868ba2deeb504c4a6f51d8f694bd591d63637728d9e12c2ca4`。

Native47 的完整原矩阵仍为27/3，源码、Git、binary无漂移且 owned group 已退出；现场 canonical 23个检查点全部true，但最终门禁仍失败。首次 UI拒收：alpha记录frame36，而保存边界已到37；重新选37使DTO身份不同。另一缺口是14个真实输入文件为0644，reader要求0600。`native-canonical-span-red12-canonical1` 保存这两项最小失败回归；本次修复不把原Native47改成passed。manifest SHA256为 `1bd7f184bb9860a8163001a79796a122610699e6ce71689dc5ad7d789e27d63a`，路径 `/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/full-gate47-evidence/driver-final-manifest.json`。

该轮另有独立未闭合项：native replay的 `geometryEvents` 与最终 consumer旧 `geometryProof` 不兼容；canonical真实Git有成功原始输出但缺host process receipt；builtin securityOrdinary在suggestion replacement阶段实际超时，缺正常关闭。这些不由本次关联修复冒充通过，仍需各自实现、回归与新构建验收。

Native43 真实 resize RED 仍未解决：kernel resize 后的零输出快照仍为旧尺寸，后续实际输出正确。这里继续拒收该旧几何关联；没有通过移动 resize、跳过零输出帧或重跑覆盖 RED。SIGWINCH/handleResize/Yoga handoff 需要进一步实现和验收。

transport bytes 到达与 native span/geometry 关联不证明 child-side read、parser、唯一 input owner 或时序等价。`actualInputOwnerCovered=false`、`productTimingEquivalent=false` 和 `fullNativeGatePassed=false` 保留。完整 termios/geometry lifetime、无观测对照、官方 diff/browser/Client 和公开功能仍须同轮真实验收；本次不宣称完整 Mods 或发布通过。

## 使用方法

macOS 使用已有 Bun/clang/tmux，私有 HOME/config 与 dummy credential，串行运行：

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-native-canonical-binding.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-native-live-prefix.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-native-acceptance-contracts.py
PYTHONDONTWRITEBYTECODE=1 python3 .claude/skills/release-validation/scripts/test-release-driver.py
make release-check
make build
JOURNAL_TEST_BINARY="$PWD/built-claude" PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-native-terminal-journal.py
JOURNAL_TEST_BINARY="$PWD/built-claude" PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-native-frame-journal.py
```

CHANGELOG 是 binary input，文档更改后需新构建。`release-validation` 仍要求动态 baseline、默认完整矩阵及原有追加目标，并要求同一轮四路发布门禁。单测、历史重算、bounded replay 或一次正常退出不能替代完整验收。

red10/green11 的 input producer synthetic receipt 最初缺少 phase/transport，不能据其首次失败证明权限根因；原结果保留为夹具缺口。补齐真实 receipt shape 后，red12在旧producer明确失败，修复不放宽consumer条件。
