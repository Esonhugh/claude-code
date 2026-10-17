# 原生终端报告消费契约（2026-10-09）

Native48 使用新构建正常完成原默认矩阵及原七项追加目标共30项：27通过、3失败。源码、Git、binary未漂移，owned process group已退出。canonical的帧关联、生命周期和键盘落点已通过；最终仍拒收旧geometry报告、缺Git host回执及未闭合的完整原生门禁。不能据此宣称Mods或发布通过。

原始manifest：`/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/full-gate48-evidence/driver-final-manifest.json`，SHA256 `5ffacf0ae5bdd1678933f285e1a88c1bd58b1540b63e8249686c93bbcf2f6d13`。旧失败结论和捕获原件保留。

## 修复范围

- `native-journal-ioctl-geometry-replay-v1` 保持原生method及`native-frame-end-v1`边界，固定独立xterm parser digest。逐cell、style、cursor、buffer、完整原始packet和关闭身份校验继续执行。
- 每帧导出独立xterm实际尺寸、文本及语义，`sizeSequence`由实际物理尺寸序列生成。fallback交互使用已有语义契约；canonical仍以真实pane、witness、动作窗口和生命周期验收，不以fallback文本替代。
- `outputBytes`表示native marker包围的成功帧事务字节数；`replayBytes`表示本次连续重放段的字节数，包含帧前非Ink输出。重放段有bytes不能使零输出观察成为实际绘制帧。
- `nativeGeometryProof`使用独立method `native-driver-mach-frame-geometry-v1`。原始launch/send/return与实际内核ACK必须一一对应，实际tmux参数、target、action、尺寸及单调边界匹配；ACK下界是send，不能用异步发布的parent return排除已经发生的ACK。
- 每个ACK必须在下次内核resize前具有同capture/clock、正确尺寸、positive-output且独立physical比较通过的后续帧。仅有tail ACK、logical observation、外国clock或后请求的帧均拒收。所有旧failed frame仍使整份replay失败。
- 三个最终/归档consumer读取对应backend的严格proof，不添加legacy `geometryProof`别名。frameId、尺寸、计数及原生输出字节使用严格整数类型；Python布尔值不能充当frame identity。

## 失败记录与证据边界

`native-canonical-schema-red2-report1`保存旧consumer不认识合法native报告的synthetic RED；它不证明实际产品UI错误。Green1历史原件重算又拒收canonical：其report把完整replay段字节计为帧事务字节。原件hash复读未变，修复只改新report DTO，不覆盖Native48报告或verdict。类型负例也属于报告契约，不是fresh native假通过的证据。

缺少driver几何journal时，物理重放仍只能给出bounded结果，request proof为`not covered`。`actualInputOwnerCovered=false`、`productTimingEquivalent=false`、`fullNativeGatePassed=false`继续保留。Git host回执、suggestion生命周期、历史Native43 resize RED、child read/parser/owner、termios完整lifetime及无观测时序对照仍须各自实现和真实验收；本次没有降低完整门禁。

Green2完整CLI文件15项中14通过、1失败：resize用例实际执行成功并具有内核ACK，但测试producer未保存geometry send/return，严格一一对应检查正确拒收。原捕获17项hash及首次失败由`native-canonical-schema-green2-cli1-fixture-disposition.json`保留。这是fixture证据缺失，不能归为产品resize失败或改判通过；修复在真实tmux命令前后记录当时完整frame/IO前缀和raw长度、实际参数、target及exit code，并要求request/ACK/paint proof通过。历史Native43错误帧仍单独开放。

Green3的真实resize用例另外暴露fixture字段错误：descriptor的target在顶层，修复两处错误读取，首次KeyError与原件保留。Green4完整legacy broker文件又暴露故障夹具的marker发布竞争：exists先于JSON写完，读取在char 0失败；只改该实际EAGAIN观察器先写私有临时文件再原子rename，仍核对真实errno/PID/字节和原取消清理断言，不扩大deadline、不忽略解析错误、不改生产broker。两个失败分别保存在`native-canonical-schema-green3-resize1-field-disposition.json`及`native-canonical-schema-green4-legacy1-marker-disposition.json`；不能把后写完的marker冒充首次失败时读取的bytes。

## 验证入口

使用已有Bun/clang/tmux，私有HOME/config及dummy credential，串行运行：

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-native-report-consumers.py
bun test --no-env-file ./scripts/native-frame-journal-replay.test.mjs
PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-native-canonical-binding.py
PYTHONDONTWRITEBYTECODE=1 python3 .claude/skills/release-validation/scripts/test-release-driver.py
make release-check
make build
JOURNAL_TEST_BINARY="$PWD/built-claude" PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-native-terminal-journal.py
JOURNAL_TEST_BINARY="$PWD/built-claude" PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-native-frame-journal.py
```

文档属于binary输入；最终文档修改后必须重新构建，再运行动态baseline与默认完整矩阵。历史closed原件只读重算只能说明consumer契约，不能替代新binary的open/close/reopen、输入owner、完整termios或四路发布验收。
