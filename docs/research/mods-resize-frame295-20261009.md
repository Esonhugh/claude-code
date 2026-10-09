# Mods 2.1.295：重新建立 resize 验证记录

本记录复核 [Pane 焦点验证](mods-pane-focus295-20261009.md) 中隔离 candidate 的 `native-local3` 失败。**原运行和完整 Mods/UI 发布验收仍未通过。** 本次没有修改产品、放宽逐帧断言或重新运行 CLI 来替换失败结果。

新的完整证据目录：`/tmp/claude-test/mods-resize-frame295-20261009-_0hyibpw/`。旧原件、归档及失败回执保留。诊断、证据完整性核验和产品验收分别记录结果，不能互相替代。

## 来源与本次执行

- 冻结 checkout：`0139ccc4acfe4981a968665aaf68aa195ab09fb4`；本次测试前的 3189 文件源码摘要：`a61362f99b6d1790f76af96e17999d678f2c76b8daa098698efbd6373d24eaef`。
- 原 binary SHA-256：`d4a7b7125e2913e1038c79c8c775d05c11bc875d907a16d658fdf08007b753fd`；captureId：`4efb9c24-db33-4467-9d4b-5f3d660e0500`。
- 原运行：`/private/tmp/claude-test/mb-BKYBt9/cache/runs/r-8b2386aceb0c`，110 个原生帧、4 次测得 resize。
- 本次重新执行几何请求合同测试 22 项和原生 resize 排序测试 5 项，全部通过；测试前后源码一致，测试进程组已回收。它们验证验收器的判断规则，不是新的 binary 交互结果。
- 重新运行未修改的严格验收器，仍为 exit 1：`Native resize overlaps output transaction (frameId=44)`。
- 原文档清单中的 4270 个文件重新计算 SHA-256，全部一致。原始 ledger 解码得到的 frames 与保存的 JSONL 逐项相同；4 个 resize 原生时钟区间均未与 write syscall 重叠，raw prefix 逐一重新推导。

## 第 44 帧的原始顺序

以下值为同一原生 Mach clock 的整数 tick，不能转成浮点数，也不能用 broker 已读取的字节数代替内核已写前缀。

| 事件 | entry | return | 含义 |
|---|---|---|---|
| layout，sequence 217 | `86250748097264` | `86250748097398` | 按 144×40 布局 |
| resize ioctl，ioId 42 | `86250748145134` | `86250748145775` | 实际终端变为 160×40 |
| write，sequence 219 | `86250748159382` | `86250748159474` | 成功写入 45 字节 |
| frame end，sequence 220 | `86250748160066` | `86250748160113` | 原严格比较边界 |

resize 的 broker read tail 是 17661，原生 write 账本证明的内核前缀是 18386；该帧写到 18431。它是有真实 write 的 output transaction，不能使用零写入观察例外。

按实际 raw prefix **和原生比较时刻**回放后，110 帧中仅第 44 帧在严格比较边界存在尺寸分歧。其 immutable logical snapshot 为 144×40，独立 xterm 为 160×40；buffer 均为 alternate，光标均为 `(2,37)` 且隐藏。

另作明确不参与验收的诊断：保留 snapshot 的全部原有单元格与样式，假设扩出的 16 列为默认空白，逐格检查 160×40 未发现内容、宽字符或样式差异。这支持将问题继续定位到并发几何与比较合同；不能据此把原失败改判为通过，也不能证明所有缩放方向、正常 buffer、行数变化或产品时序正确。

下一帧 45 已使用 160×40。最终画面或后续帧正确，仍不能代替第 44 帧的严格验证。

## 诊断过程中的无效结果

第一次诊断仅按 raw offset 应用 resize，错误地把同一字节偏移处、发生在较早 frame-end **之后**的 resize 提前应用到了该帧，得到额外尺寸分歧。该结果保留为 `old-local3-cell-diagnosis.json`，明确作废于时序结论和验收。

修正后的 `old-local3-cell-diagnosis2.json` 同时使用每帧原生比较 tick；对第 40、43、78、84 帧逐一核对 frame-end 先于对应 resize entry，排除同偏移误排序。诊断脚本摘要、所有输入和原件哈希记录在 `evidence-reverification.json`。此修正没有改动产品验收脚本。

私有测试包装器还曾因 case 名白名单不接受 `uint64` 中的数字，在启动测试前拒绝命令。该包装器失败独立保存；修正私有白名单后才执行上述 5 项原有测试，没有修改或跳过测试断言。

## 复现与边界

在匹配的源码 checkout 中执行：

```sh
bun test --no-env-file ./scripts/native-frame-journal-replay.test.mjs
PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-native-frame-journal.py NativeResizeOrderingTest
python3 scripts/verify-native-frame-journal.py \
  /private/tmp/claude-test/mb-BKYBt9/cache/runs/r-8b2386aceb0c \
  /private/tmp/claude-test/mb-BKYBt9/cache/runs/r-8b2386aceb0c/expected-native.json
```

最后一个命令预期 exit 1，保留原失败。诊断及证据复核脚本采用新建输出文件；如需重新执行，应使用全新证据目录，不能覆盖旧回执。

完整记录与链接校验见同目录 `VALIDATION.md`、`document-verification.json`；准确执行命令及环境见各测试的 `result.json`。本次没有构建新 binary、执行新的双端 CLI、改变完整验收结果或覆盖其他 Claude 的未提交实现。

仍需独立完成：并发几何的完整可验证合同与逐帧证明；最新官方 API/上下文/远程控制、G5 和取消原因整合回归；官方 diff viewer 与浏览器/终端 Client 生命周期；OS input/parser/owner、termios、child geometry 与产品时序；默认完整发布矩阵及同轮四路只读审查。`fullReleasePassed` 与 `fullNativeGatePassed` 继续为 false。
