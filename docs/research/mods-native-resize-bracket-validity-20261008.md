# Owned native resize 的有限验收

父提交 `cbfb0bc2847976647122a34b9d932999ac8c7109` 的 Native32 已完整运行且失败，不能继承为新实现通过。本批补齐 owned broker 实际执行的内核 resize 时序，仍不提供全部 native/UI/Mods 验收结论。

`cc_terminal_native_resize` 执行原 `TIOCSWINSZ` 一次，保持其返回值与 errno；前后 `TIOCGWINSZ` 查询确认实际尺寸，括号使用与 producer 写记录相同的 `mach_absolute_time` 和 timebase。观测失败使采集无效，不增加 writer ACK、等待或同步证据落盘。Python 在启动时解析 FFI，resize 不因 journal registration 校验先行跳过原操作。

`nativeBracket.entry/return` 是非零 uint64 的 ASCII 十进制字符串，禁止浮点、非规范数字和超范围值；PID、result、errno 与 timebase 为严格整数，成功/coverage 标记为布尔。nonce/PID/clock 必须匹配注册原件，括号必须位于 child lifetime 内且顺序完整。IO 的 producer expectation、关闭摘要及连续 raw 覆盖要求继续生效。

回放位置由 resize 前完成的原 syscall 成功字节总数推导，不使用 broker read offset。resize 不能与 write syscall 或 layout→frame-end 的输出事务重叠。比较点明确为 `native-frame-end-v1`；Ink 在同一 producer 线程同步序列化该帧并发布 snapshot，没有 yield 或 intervening output，随后发布快照不会把比较点挪到发布时间。派生 frame/output 必须与原件重新推导的结果完全一致。

## 原始失败与本批证据

| 证据 | 判定及范围 |
| --- | --- |
| `native-resize-clock-red1` | 缺少真实 resize helper，C API RED；不是产品坏帧。 |
| `native-resize-entry-red1` | 新 binary 实际默认入口执行 resize，旧实现没有 native clock receipt，真实入口 RED。 |
| `/private/tmp/cc-journal-y0xrp7fg/cli-0` | frame2 end.return < resize < snapshot.entry；旧方法拒收，随后测试的 `KeyError: frames` 掩盖该原始原因。原件保持不变。 |
| `native-resize-transaction-red1` | 新 wire 类型/顺序回归在旧方法失败；仅为 classifier RED。 |
| `native-resize-transaction-green-resize-cli1` | tmux server 在 install 前消失，未到产品入口；初始化/fixture 失败保留，不算产品 resize 失败。 |
| `native-resize-transaction-green-resize-cli2` | 新私有环境、源码 `309d6ad817052dede02f9b1a9fb21e7a38a5ea98e2fb91a1925d09e7502c6bf1`：实际 200×60→110×34，7 帧/raw6559/IO27，逐 cell 回放 passed；child25906 正常 exit0/EOF/reap，signals=[]/cleanupErrors=[]。 |
| `native-resize-transaction-green-order1` / `green-c-units1` | 3 项 ordering/type classifier 和 23 项 native collector 回归通过；source unchanged、owned PG gone。 |

新真实 CLI 的 resize 发生在 snapshot 后、下一 layout 前，没有再次实际命中旧记录的 end→snapshot 细小间隙。该间隙的接受语义由同步调用链与 ordering unit 支撑，不能宣称新真实进程再次覆盖或 timing equivalent。

用新构建执行 `JOURNAL_TEST_BINARY=/absolute/path/to/fresh/built-claude python3 scripts/test-native-frame-journal.py`，原件目录随输出打印。C probe 另用同一环境运行 `scripts/test-native-terminal-journal.py`；默认 broker 冷路径使用 `BROKER_TEST_EVIDENCE_DIR=/absolute/path/to/new/evidence python3 scripts/test-terminal-evidence-broker-native.py`。

`nativeResizeBracketsCovered=true` 只表示当前 capture 的实际 owned resize 已通过原件关联与回放，不能推导 child-side 所有几何变更、termios lifetime、实际 OS read/parser/唯一 owner、完整 open-close-reopen 或产品调度等价。`productTimingEquivalent=false`、`fullNativeGatePassed=false` 与完整 seal verdict failed 保留；默认完整矩阵及四路发布门禁仍需同一新 epoch 的独立验收。

## Native33 最终处置

在父 HEAD `cbfb0bc` 加本批候选的冻结源码 `c5822fc26d7368529c6746fddee80b539f2ca60bbef61a0744fec776b9aae47c` 上，fresh binary `6438df5cb28b358d9ccd3952236f4acf796803667ca10877dd15565d90356936` 执行 readiness、完整默认串行矩阵及原有追加 targets，348.465 秒正常结束。候选的12个所属文件已原样签名提交为 `95d2947f41b9efea45dc50dc1a096dd551da5b3b`；门禁是在提交前运行，未将之后的文档提交称作重新跑过门禁。

29/29 场景记录齐全，23 passed、6 failed：builtin-mods、code-review、terminal-canonical-diff、terminal-interaction、workflow、workflow-retry-partial-failure。源码与Git状态不变、无bytecode污染，lease释放、auth清理无错误，workflow owned产物已归档清理；27个direct场景的进程/session/mock均关闭，本轮driver PG及两个native child另经signal0确认不存在，未发送清理信号。

- `terminal-canonical-diff`：child38638，52帧、1次真实resize全部physical passed，bounded passed；正常exit0/EOF/reap，signals=[]、cleanupErrors=[]。
- `terminal-interaction`：child39174，73帧、4次真实resize全部physical passed，bounded passed；正常exit0/EOF/reap，signals=[]、cleanupErrors=[]。
- 两个terminal target整体failed来自完整native契约仍缺的范围，不能称为本轮坏帧，也不能从局部125帧通过提升为完整验收通过。builtin独立frame复查通过，但其assertions仍failed；workflow/code-review/retry的生产完成路径继续待修。

原始manifest：[driver-final-manifest.json](/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/full-gate33-evidence/driver-final-manifest.json)，SHA256 `fdb466030929153497de0d1c3fef6c93f43f82e8d098eb3188cf43ef3f269f11`。逐项分类、raw/IO摘要、owned清理证明保存在同目录上层 `full-gate33-disposition.json`。最终只读审计原件为 `/private/tmp/native-resize-final-readonly-eiphnmoa/REPORT.md`，146引用/3121源码无漂移，报告SHA256 `7c60f8717dae32c334770be49b460af0e10aa11314b1612042ff4f1b9e097ce2`。四路正式发布与完整Mods/UI兼容继续未通过。
