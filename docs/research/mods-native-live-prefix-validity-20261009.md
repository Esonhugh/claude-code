# 原生运行中证据发布与验收处置（2026-10-09）

真实 CLI RED 确认：CLI 已 ready，但 `/exit` 前没有可读帧/IO 前缀；正常退出后才有 42 帧。`native-live-prefix-red1` 的 actual child exit0、EOF/reap、无 signal/cleanup error，故不是 startup 或清理夹具失败。原件 `/private/tmp/cc-journal-nej44bgv/cli-0` 与旧失败保持不变。

## 实现及边界

默认原生 broker 现由独立写入线程异步发布 `frames.jsonl`、`pty-io.jsonl`。主 owner 仍负责 native acquire/copy/release，只向有界队列提交 immutable packet/header/raw/IO copies；writer 不读取共享 mapping，没有 writer ACK，也不在主 capture loop 等待磁盘。内存/队列溢出或写入错误使证据失败，PTY 转发和有效 slot 回收继续。

前缀解码只接受真实已提交记录和已实际读取的 syscall/termios 物理前缀。尾部未完成帧等待后续数据；不创造 close marker、终止时间或退出回执。final decoder 继续要求真实 close、精确全量 record count、registration/PID/nonce、无 loss 和原 write 返回值。仅完整 JSONL 行可作为运行中观察。

正常退出后，writer 在预算内关闭；内存持有的前缀须与严格 closed decoder 的最终帧、原始 IO 完全一致，实际文件还须匹配 held bytes 及原 fd/inode/owner/mode。替换、篡改、缩水、溢出及关闭超时拒收。producer 的 IO/native 内容回执仍在内存原件上固定；首次 seal 与独立 final replay 的既有拒收规则保留。

## 同轮验证

- 冻结 source：`c93da67757d29ce1a636d4ec1503dd4110fcd0365f62bcc653c0d0507c8a0f6e`。
- 新 binary：`9559d76ab5173cf3244495d93bac2875d7bb63be4a83e48afd6a94276a5f6be8`。
- 10 项 prefix/publisher 回归（含阻塞磁盘不阻塞 offer、溢出、外来 packet、预存/替换/同 inode 篡改和 final IO/frame 不一致）；28 项完整 native journal；4 项 native broker；13 项旧 broker；45 项/4 文件终端证据 Bun 回归，0 fail。协议 fixture 不是产品 native oracle。
- 完整 `make release-check`、新构建、完整实际 `test-release-driver.py` 通过。12 项完整实际 frame-journal 文件通过，使用新 binary，含 CLI/resize、首封/最终 IO 篡改和实际启动失败清理。
- live case 在读取时确认实际 child alive、broker 尚未关闭、尚未输入 `/exit`；parent 持有的完整帧/IO 前缀与最终原件逐项一致。单独旧 binary 的诊断通过不替代本轮新 binary 文件结果。
- Native40 正常完成完整动态 required + 原有七项追加矩阵：30 项，27 passed，3 failed（builtin-mods、terminal-canonical-diff、terminal-interaction）。源码/Git/binary identity 无漂移，owned group 已退出；Workflow/code-review/process.spawn 最终 closure 继续通过。没有删减目标或继承旧 GREEN。
- manifest：`/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/full-gate40-evidence/driver-final-manifest.json`，SHA `a0f3d8dd6b25ef5d43a4ac2f1b547cb45433144257f8b532a3706ff3efbb5c0e`。本轮 before/start/result/log 和 disposition 保留 exact command/env/SHA。disposition 初稿错读 verdict 字段的报告解析错误另存 field-error，改按原件 validation_verdict 计算；原 manifest 没有改写。

最初 publisher-cli1 在 sandbox 内丢失刚启动的 owned tmux socket，未到 CLI readiness，不能算产品 RED。相同冻结源码 publisher-cli2 使用独立 tmux/PTY 环境后完成；最终 full-file CLI 使用新构建重新通过。未改写失败原件，未停止其他 Claude 进程。

## 使用方法

先运行 `make build`，再将本轮产物绝对路径传给实际 CLI 文件；无需安装依赖或共享认证，只使用已有 Bun/clang/tmux、私有配置和 dummy key。

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-native-live-prefix.py
JOURNAL_TEST_BINARY=/absolute/path/to/fresh/built-claude PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-native-terminal-journal.py
JOURNAL_TEST_BINARY=/absolute/path/to/fresh/built-claude PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-native-frame-journal.py
```

Python 脚本打印 `/private/tmp/cc-journal-*` 原件位置。完整发布仍使用 release-validation 的动态默认矩阵，单个文件或 bounded replay 不能替代它。

## 继续保持失败的事项

原生后端不提供旧 FIFO 的 frame-begin/end ACK、native-input.jsonl、native-pty-eof.json 或 geometryProof。当前部分 classifier、canonical frame/action association、normal exit 与 resize 场景仍按旧 schema 验收：不能补造字段或仅改名取得通过。Native40 canonical 的 broker 自身实际 exit0/EOF/reap、无 signal/error，physical replay passed，但旧字段路径和 action/frame 关联未通过。legacy diff 关闭要求的 `[diff] dialog close user` 未从实际 callback 记录，失败后的 double-Escape cleanup 也未正常退出；原件保留该失败，不能称全部 terminal 清理通过。

实时发布仅补齐观察及时性与前缀完整性。`productTimingEquivalent=false`、`fullNativeGatePassed=false` 继续保留：实际 OS read→parser→唯一 owner、完整 termios/direct ioctl 与 geometry lifetime、open-close-reopen、无观测对照及官方/browser/Client 生命周期仍须独立实现和证明。生产公开接口的其余缺口与四路发布门禁也没有由本批关闭，不宣称完整 Mods 或 release passed。
