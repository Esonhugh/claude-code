# 原生 journal 收据有效性

本批是验收基础设施的局部实现，尚未给产品 Ink 或现有终端 driver 接入无需 ACK 的 frame/TTY/input/owner 通路。完整 Native30 原件仍为 23/29 failed，不能用本批 standalone probe 改写。

C producer 保持原 write、writev、两种 NOCANCEL 调用、返回值及 errno，使用私有 0600/O_NOFOLLOW 固定布局 mmap；仅完整 immutable payload、syscall entry/return、PID/endpoint/sequence 可供消费。slot 满、payload 溢出、shared layout 漂移、无合法 footer、missing/reordered/foreign record 均拒收。producer 不等 collector、不写采集文件、不发送 ACK，mapping 保留到进程退出。collector 的 acquire/copy/release 在 native CAS 中完成，返回独立 bytes 后才可保存；两个 collector 不能同时取得同一 record。

v4 十项 standalone probe 的 runtime 断言曾通过，但独立审计确认其 15 个 records.bin 全为空，且异常 finally 重读 partial 控制管道、没有 wait，可能跳过收尾；这些历史结果不作为完整收据通过。保存原件和 seal，不修改历史报告。随后最小真实 RED：native-journal-saved-red1 的保存 packet 断言失败；native-journal-cleanup-red1 两个受控异常分支报错。修复后 15 项通过，包括真实 Bun CLI --version、完整 5000 字节及 buffer mutation、writev alias、NOCANCEL 6/7 bytes 和 errno、实际 65536→1024 partial write、EFAULT -1、饥饿不阻塞但 loss 拒收、payload 截断拒收、多 writer 拒收、两 collector CAS 独占、4-slot/44-record live reuse、两异常 kill/wait/FD 收尾和保存 packet 的独立复读。

partial/reuse probe 通过私有控制 pipe 保持 endpoint 到物理 drain 完成，验证 syscall prefix/slot reuse；这不是产品渲染策略，不证明输入 parser 或 owner。所有 native 原件同时包含 registration、actual PID、raw、packet、cleanup 与 library/binary hash；失败注入只有启动/清理收据，不伪造正常 footer。原件根 /private/tmp/mods-remote-composer-292-20261008-rptx4ocs；native-journal-live-tests1 source SHA 795c07106623468cec74cf94e2be6e3e91e13b613c74619e6b00c6579cfa5137，原件 /private/tmp/cc-journal-c8o6c66m。

仍需：同版实际 Ink/Worker/TTY Mod 的不可变 logical frame 与 native write 跨层关联、geometry 和 termios 完整历史、OS read/parser/唯一 consumer ownership、normal /exit/EOF/reap/close-reopen、缺 ACK/full queue/并发/resize 的完整矩阵，以及官方最新同案差异。`productTimingEquivalent` 保持 false，没有把 CPU 时间戳排序、完整 byte coverage 或最终 tmux pane 当完整逐帧证明。


随后同案 RED：native-journal-initialization-red1 两个错误（startup cleanup/foreign thread），native-journal-partial-init-red1 第二 pipe 失败泄漏首个 FD，native-journal-registration-red1 错 nonce 和实际 C consume 接受错误 registration。修复后 native-journal-registration-green1 的20/20通过，source SHA58c811e588902aee76e793873ee081aea1f3f53d9a4a7c125d37193fc067fdb8，原件 /private/tmp/cc-journal-x4y1o_eq。每个 consumer 由一个线程拥有；两个并发 collector 用各自实例。C acquire 前后同时检查原 registration、endpoint 和独立 PID；错误归属不释放真实 record。所有 FD/PTY/pipe/consumer/selector 申请均进入清理范围，每次成功申请立即登记；故障没有冒充正常 EOF。


最后再补真实 live 中途失败：native-journal-prefix-red1 已领取 4 个 packet 后抛错，slot 已释放却没有保存 prefix。修复为 finally 始终保存准确已领取 prefix、原 raw、退出码与实际发送的 owned 信号；native-journal-prefix-green1 的21/21通过（source SHA367fb163305c9a59949a2fd20b01d0ed8f9445948f2323ac36da4cd45c24a34a，原件 /private/tmp/cc-journal-ko_b25ji）。受控失败保存4个真实连续记录和原字节，保持 EOF=false，decode 仍拒收缺 close boundary，不把 prefix 当完整 capture。
