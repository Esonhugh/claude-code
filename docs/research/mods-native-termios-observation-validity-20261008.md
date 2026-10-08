# Native termios 调用记录与输出重放

本批补充真实 `tcsetattr` 调用观测及按调用顺序解释 write 的 PTY 输出。完整 termios lifetime、直接 mode ioctl、实际 OS read/parser/唯一 owner、child-side geometry 和调度等价仍未验收；`productTimingEquivalent`、`fullNativeGatePassed` 保持 false。

## 原始失败与修复

- `native-termios-red1`：source `09a49079d30723bea6fab470043e59ef9a6c887e7e6fa3164bd069e13df67473`，真实 C probe 修改 ECHO 后恢复，最终 attrs/raw 与未观测运行相同，旧 collector 却没有两次 mode 记录。1 FAIL，原件 `/private/tmp/cc-journal-m9vqmhty`，原始 result 在 `/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/native-termios-red1/result.json`。
- `native-termios-output-red1`：source `dbb3fb75ccf37019ef77a7e0e375f638d4042a370a62d65b919cd940519f22ae`，真实 OPOST 关闭、write、恢复、再 write 产生 `mode\nrestored\r\n`；固定初始 flags 的旧重放拒收。1 ERROR，原件 `/private/tmp/cc-journal-ia7y4mji`。
- `native-termios-output-green-cycles1`：source `8988f0bdffe87a1c75007a6ebe5fe2b502071c6525ce4693037456ee551d98c9`，两个真实 mode 周期通过。同 source 新构建后 collector 25/25、frame/order 9/9；原件 `/private/tmp/cc-journal-gktuj97z`、`/private/tmp/cc-journal-patevrd5`。正常 default CLI `cli-1` 记录实际 fd0/1/2 上10次 tcsetattr、32次 write、6帧，正常0退出/EOF/reap、无清理 signal。并非完整 lifecycle 或最新最终候选发布通过。

Darwin observer 调用原函数恰好一次，保留真实返回值和 errno，用相同 Mach clock 保存 syscall entry/return。记录内核 before/requested/after 的四组64位flags、两组speed及20个control chars，不序列化 struct padding。证据满或观测失败不阻止原调用，失败记录使验收拒收。

`native_write_outputs` 要求 write/mode bracket 无重叠，实际 before output flags 与已知状态连续。OPOST关闭时保留原字节；支持的 OPOST|ONLCR 开启时映射 LF 为 CRLF；未知输出转换、歧义或缺失字节拒收。resize prefix 和 frame 输出边界使用同一映射。新增回归另检查失败 action 的原始 EINVAL、kernel attrs 不变、payload overflow不改变实际 mode/write、mode overlap及未知转换拒收。

## 使用

macOS、现有 clang/Bun/tmux，无依赖安装或共享认证。先 `make build`，再串行运行：

```sh
JOURNAL_TEST_BINARY=/absolute/path/to/fresh/built-claude python3 scripts/test-native-terminal-journal.py
JOURNAL_TEST_BINARY=/absolute/path/to/fresh/built-claude python3 scripts/test-native-frame-journal.py
```

证据目录由脚本输出。所有回归使用隔离 HOME/配置/PTY/socket 和 dummy key，保留原始数据及 cleanup。上述局部执行不能替代默认完整 driver 和四路发布验收；正常最终 attrs 相等也不能证明完整 mode 历史。
