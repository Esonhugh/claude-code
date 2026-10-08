# 原生身份、退出与拒收验收处置（2026-10-09）

本批处置的是验收入口本身的误判和阻塞。bounded 原生回放与完整产品验收分别判定；`productTimingEquivalent=false`、`fullNativeGatePassed=false` 继续保留，不用标签、旧日志或成功片段提升结论。

## 实现

native 身份校验直接绑定本轮 binary/capture/PID、producer expectation、native/IO 内容回执、22项必须原件及最终帧。native 和旧 FIFO 后端分别使用自己的校验规则，不补造旧 ACK、EOF alias 或 geometry 字段。首封、fresh replay 和最终原件重读必须一致；frames 由生产 broker 发布，真实入口测试只能比较原字节，不能重写为期望数据。

正常退出另以实际 child exit0、PTY EOF、waitpid reap、无 signal/error 和 producer close 判断；它不等于完整 terminal passed。PID/exit code 必须为准确整数，布尔值或同值浮点数不能借用 Python equality。双份 cleanup 与嵌套 nativeClose/ioClose 比较保留 JSON 类型。collector 初始 termios/EOF 原件从创建时使用0600。

closed 原件读取先检查 owned regular file，再以 O_NOFOLLOW/O_NONBLOCK 打开并核对实际 fd/inode、owner、link、尺寸和适用权限；FIFO、链接及身份替换拒收。相同规则覆盖 native 首封/replay、legacy 封存及 paste intent 文件。覆盖范围是关闭原件与这些读取入口；未宣称全部 live 文件替换竞争或 OS input ownership 已证明。

diff 子测试不能只凭子进程 exit0：必须实际完成固定36项 DiffView roster，七个 Git sidebar 场景各完成自身那一项，并保留完整 stdout/stderr。空执行、漏项、重复、外来项、skip/todo 或计数不符拒收。outer17项、DiffView子进程36项、七个scenario各1项分别记录，不相加冒充独立测试总数。实际 DiffDialog onClose 在完成 onDone 后记录关闭 marker；清理按观察到的 detail/files/composer 状态发 Escape，避免关闭后额外 Escape 打开 Rewind。

## 同轮证据

- feature source：`c55f5639e1a7503f0eaedfa0c88bf770f1fa33f6bec3b91eb955979143addbe8`；本轮新 binary：`d4086ffe9006e0851ded9adfa75a29afb549fc9dc06d87631ece43bd62e8f7cf`。
- 7项 receipt/type contract、45项终端证据 Bun回归、17项diff outer测试及其固定子测试、10项prefix、28项native journal、4项native broker、13项legacy broker通过。contract/type fixture不作为native或UI oracle。
- 完整release-check、fresh build、完整test-release-driver.py通过；新binary完整test-native-frame-journal.py的15项通过。实际关闭CLI原件另驱动8项文件/type负例；其中模拟错类型和paste intent的fixture仅证明guard拒收。正常路径和预期启动/发布失败路径分开验收，不能声称所有CLI启动都正常退出。
- Native41 完整默认动态矩阵及原有七项追加目标共30项：27通过、3失败。driver正常完成、matrix_complete=true，源/Git/binary无漂移，本轮owned group已退出。完整验收继续失败。
- 原manifest：`/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/full-gate41-evidence/driver-final-manifest.json`，SHA256：`f4618d01d8f98e6e1b95f402c3b08d748b21ad9e1d450be08ef24bdcbe2e612e`；exact command/environment、before/start/result/log、source reread和disposition保存在同目录。没有删减目标或继承旧GREEN。

失败事项：

- `builtin-mods`：`subprocess`, `assertions`。
- `terminal-canonical-diff`：`canonical_alpha_dock`, `scenario_completed`, `normal_native_exit`, `cleanup`, `independent_pty_resize_sequence`, `canonical_wire_complete`, `canonical_wire_identity`, `canonical_wire_tool_receipts`, `canonical_git_release_causal`, `canonical_git_success`, `canonical_pane_frame_association`, `canonical_pane_lifecycle`, `canonical_keyboard_landing`；首次场景错误：`canonical terminal interaction failed: canonical_alpha_dock`。
- `terminal-interaction`：`frame_physical`, `frame_resize_sequence`, `frame_semantics`, `cleanup`, `independent_pty_capture_identity`, `independent_pty_resize_sequence`, `normal_native_exit`。

Native41 canonical最终原件实际exit0/EOF/reap、无signal/error、bounded identity及独立回放通过；驱动较早记录的normal_native_exit仍为false，不能把该观察点误判表述成producer异常。terminal-interaction实际交互和关闭/重开步骤完成，但producer cleanup含close-live-publication TimeoutError：异步writer未在原预算内关闭，完整物理/身份收尾失败。这是真实采集器失败，需要后续修复，不能与旧geometryProof字段缺失合并掩盖。

## RED及管理错误的分类

实际原生closed originals曾被legacy字段拒收；首轮真实原件的termios/EOF权限、stream-map清单缺失也分别保留RED。legacy封存被误套native规则的回归已恢复原判定。真实FIFO deadline失败、PID float/boolean及broker-only复制类型误判、paste intent FIFO阻塞均在修复前保留失败，修复后使用相同入口和新的完整文件执行。

sandbox Unix socket/killpg权限错误、测试helper IndentationError和startup readiness之前的管理失败不能计为产品RED。一次旧诊断helper曾覆盖其补充的file-type-guard-receipts文件；该旧补充收据不作为不可变原件证据，旧RED日志仍保留。native/raw/capture originals没有由该helper改写。新helper使用独占创建和每轮唯一外部收据，并在结束时重读实际原件摘要；拒收测试的owned子进程deadline与清理探针也单独记录。

## 使用

macOS、已有Bun/clang/tmux；只使用私有配置和dummy key。先运行本轮新构建，串行执行：

```sh
make build
PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-native-acceptance-contracts.py
bun test --no-env-file ./src/components/diff/testChildEvidence.test.ts ./src/components/diff/DiffView.test.tsx ./src/components/diff/DiffSidebar.test.tsx ./src/components/diff/DiffTerminal.test.tsx
JOURNAL_TEST_BINARY="$PWD/built-claude" PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-native-frame-journal.py
```

最后一个文件打印实际`/private/tmp/cc-journal-*`证据位置。`scripts/test-native-evidence-file-types.py /absolute/path/to/independent-pty-checks.json`只接受已经关闭的实际CLI原件；`NATIVE_FILE_TYPE_RECEIPTS`可指定尚不存在的独占收据路径。它复制原件后注入负例，不改变生产原件。

完整发布仍需release-validation规定的独立门禁与默认完整矩阵。CHANGELOG.md由src/utils/releaseNotes.ts编入产物，更新文档后的候选必须重新构建并记录新的source/binary identity；上述Native41是feature候选证据，不能冒充文档变更后的二进制。后续文档候选验证另保留完整原件。

## 尚未闭合

native frame/action/resize应使用实际原生schema关联；当前完整失败不允许通过补造FIFO字段或放宽原断言处理。OS read→parser→唯一owner、完整termios/direct ioctl及geometry lifetime、无观测对照、官方完整diff/browser/Client生命周期和其余公开功能继续实施。这里只完成上述验收入口与拒收修复，不宣称完整Mods兼容、四路发布或时序等价通过。
