# 原生输出采集与验收有效性（2026-10-08）

整体验收仍失败。此批只增加 Darwin 上可重复运行的 syscall 字节采集器及严格验证器，不改变 Mods 作者接口，不替换现有完整交互矩阵。Native18 的 29 项中 22 项通过、7 项失败仍有效；首次 Tab、Workflow/nested Agent、EOF、逐帧 paint/输入归属、同步 ACK 时序和官方最新版本等工作必须继续处理。

## 实现及使用

`native-terminal-write-witness.c` 观测 `write/writev` 及 Darwin 的 `write$NOCANCEL/writev$NOCANCEL`，原函数只调用一次，保留参数、返回值和 errno。实际输出端点的别名 fd 通过启动时端点身份和当前 fstat 识别，记录真实 fd、线程和成功写入的前缀；不根据 JS console 参数预测格式，也不重复执行 getter/formatter。端点 mask=3 表示 stdout/stderr 共享终端，不能捏造成两个独立通道。

私有 Unix datagram 用非阻塞分片发送，没有 ACK；设置非阻塞或 close-on-exec 失败会关闭观测 fd，采集缺失不能通过。每次请求的采集上限是 4096 字节、每片 1024 字节；无效内存、超限、发送失败、缺失/重复分片、错误 producer 和缺少 footer 都拒收。设置 fd 属性失败的路径有实现，尚无原生注入覆盖，不能列为该故障已验收。

采集器从自身源码编译 dylib，只加载到它新开的子进程；使用私有 HOME/config/tmp/cache、控制 PTY 或两个独立 pipe，有明确 deadline。原始 packet 保存为 little-endian uint32 长度加原 datagram。记录 command/env、binary/source/library SHA、原始字节、真实 EOF、退出与进程组状态；spawn 失败也回收自身 socket。不覆盖已有 evidence 目录。使用新目录运行：

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-native-terminal-writes.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-capture-native-terminal-writes.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/capture-native-terminal-writes.py \
  --evidence-root /tmp/mods-native-write-new-run \
  --executable ./built-claude --mode pty -- --version
```

`--mode pipe` 独立保存 stdout/stderr；`--mode pty` 保存共享原始流和前后 termios/尺寸。无交互输入驱动；输入等待、EOF 超时、非零退出、残存进程组均失败。`--version` 只是启动字节检查，不是 UI 或业务验收。只能在隔离实验中使用 dummy 认证，不能带入共享认证。

## 已保留的真实对照

私有原生实验的基线和观测输出逐字节相同：

- 旧 ordinary write/writev 版本漏掉实际 Bun `write$NOCANCEL` 输出，保留 negative，不改判。
- 旧单包采集遇到 Darwin datagram 容量限制；分片后依旧保留丢包/超限为失败。
- 只观察 fd1/2 的版本漏掉 Bun FileSink 的 4 字节二进制输出；真实 alias fd5 的定位记录保留。
- 新观测在编译后的 Bun fixture 中覆盖对象、多参数、Error、Unicode 和二进制字节：pipe 的 stdout167/stderr369 字节全部覆盖；getterCalls 在基线与观测均为0。
- 控制 PTY 的 8 次实际 syscall 源字节1287，按已记录 OPOST|ONLCR 转换后1311，与原始 PTY、基线完全一致，真实 EOF/退出/进程组消失。仅此单线程 fixture 提供写入顺序；多线程不能按 syscall 开始编号猜内核顺序。
- 七类真实实验保留 normal/无效指针/关闭fd、write部分成功、writev部分成功、超限、故意不读采集 socket、直接 `_exit` 和 Bun console。部分成功只认可返回的前缀；无效内存、超限、丢包和缺少 footer 正确拒收。输出、返回值与 errno 对照一致。常规路径含故障的场景被判 failed 是预期，不能作为完整产品通过。

本批协议回归包括未封口、重复/缺片、跨 producer、返回前缀、errno、伪造容量、原始流未知前后缀/重排、共享端点和多线程顺序拒绝；采集夹具回归覆盖真实 socket 绑定后 spawn 失败的清理，以及拒绝覆盖已有目录。后者在普通沙箱中因 bind 被拒绝而未到达注入点；权限允许的同源码运行才到达并通过该断言，不把沙箱拒绝当作产品缺陷或故障注入成功。

## 必须继续闭合

验证器不使用 logical cell、预期截图或 UI 状态选字节。单线程原 syscall 顺序才能用于当前 byte proof；多线程或未知终端转换拒收。PTY 前后设置一致不是中间 termios 事件历史证明，byte coverage 不是每帧 write group/paint generation、输入消费归属、resize epoch 或 browser Client 生命周期证明。

没有 ACK 不等于已经证明产品时序等价；observer 的观测开销仍存在。4096 字节上限会拒绝较大绘制，不能丢帧、缩矩阵、调大预算掩盖错误或将 partial 改成 passed。此批没有把 v1 的 `productTimingEquivalent=false` 翻成 true，没有宣称正式四路发布通过，也没有用旧 Native17 片段补签 Native18。

Bun 的 stdout fast path 与 FileSink 关系可查[固定 Bun 1.3.14 源码](https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/js/internal/fs/streams.ts)；Apple 的 interposing 调用规则见[dyld 源码](https://github.com/apple-oss-distributions/dyld/blob/main/dyld/DyldRuntimeState.h)。这些是实现参考，不替代本仓原生证据。

实验与源身份保存在 `/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/native-syscall-witness-prototype/`，同批仓库采集器及最终 check/build/字节封存使用独立 `native-writes-*` 目录。后续发布仍必须重新构建并运行完整矩阵，不能拼接不同 source epoch。

## 独立复核后的修正

冻结旧候选的只读审查确认两项遗漏：finally 内一次异常会跳过后续清理和 receipt；EOF 后的最终 datagram drain 缺少主循环同样的 deadline 与 packet 上限。已分别保存 RED：socket close 在实际关闭后抛错时，旧 scope 跳过 unlink/rmdir 和 receipt；抽取主循环、尾部共用的旧收包行为后，三个 deadline/budget 断言失败。它们是采集夹具与收包层的故障回归，不冒充产品 render 或真实无限后代进程复现。

修正后逐项尝试清理并记录错误，captureError 与 cleanupErrors 一起落盘；清理异常不能通过。主循环和 EOF drain 共用收包函数，在接收前后检查同一 deadline，追加前检查同一100000 packet 上限。容量与业务断言未放宽。旧 source `980e9d857be7365fadc796ffb5634b8884fe2aced83378f4a5b8a864ad22c484` 的17项/check/build只保留为历史；修订代码的21项回归和check已通过，最终含此说明的新source仍重新执行相关回归、check/build及真实启动/故障实验。

后续复核发现输入文件复读若抛异常，仍可能遮蔽原始失败并跳过保存。新增 RED 仅删除回归自身的 fake native 文件，实际复现 FileNotFoundError；修正后先保留原始 packet/raw，逐项记录 unchanged/changed/missing/unknown，再保存 receipt。缺失、未知或改变的输入不能通过，原 captureError 保留。它不是实际 native executable 被删除的复现，旧21项/check版本继续只保留为历史，最终22项与新构建、原生检查均使用修订后的同一版本。
