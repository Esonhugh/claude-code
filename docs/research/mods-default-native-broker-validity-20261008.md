# 默认终端采集的 native backend

`terminal-capture-driver.mjs prepare` 为默认 terminal targets 启用 `nativeJournal`，在启动前编译现有 Darwin C observer，记录 dylib SHA256，创建 owned enrollment descriptor。driver 与 launcher 显式传递 native intent，最终 launcher 的实际 native binary 仍由 `terminal-evidence-broker.py` 启动；选择依据是 intent，而不是 descriptor 是否存在。缺失 descriptor、identity 或初始化错误不退回 FIFO ACK。编译前拒绝预存 observer 路径；在专属临时目录编译，以 exclusive link 发布，不让重复 prepare 的 clang 覆盖旧 dylib。旧 builtin 双端 archive 的 legacy 路径保留原判，不能当新 backend 证据。

新增 `terminal-evidence-broker-native.py` 保留 native initial termios/geometry，以独立 slave endpoint 注册 journal，并为实际 child 设置 controlling TTY、进程组与 observer enrollment。运行期间 exclusive consumer 复制 native slot；raw、packet 与 IO 记录在同一64 MiB有界内存里保存，原来的 PTY 转发继续执行，不等待 frame ACK，也没有 raw/frame 证据文件写入。已满时停止保留后续证据、继续领取释放 slot 和转发产品 bytes；dropped bytes 及缺失 packet 使采集失败。该边界不是声称观察开销或产品时序等价。

正常退出或失败后分别 kill/wait、drain、close consumer/PTY 和恢复 outer termios，保存真实 prefix/header 与 `cleanup.json`。初始化前拒绝预存 native artifact，落盘也使用独占创建，不登记或覆盖来源不明的文件。故障路径不将 physical EOF、进程已 reap 或测试通过冒充正常业务退出。

有效 `native-default-broker-red2` 使用新构建、正确私有项目与真实 CLI，正常 `/exit` 后默认 broker 没有 native cleanup/packet；这与专项 wrapper 已通过形成明确入口缺口。`native-default-broker-red1` 是夹具启动目录导致 trust dialog 被当就绪，不计产品 RED；严格就绪要求 prompt 和 bypass permissions 同时存在。`native-default-broker-buffer-red1` 另外确认预存 raw artifact 没有被拒绝。旧失败轮次不重写，新验证每轮冻结源码。

只读复核再发现 descriptor 缺失会退回旧分支、重复 prepare 会在报 EEXIST 前先覆盖旧 dylib；`native-default-broker-intent-red1` 和 `native-default-broker-prepare-red1` 分别保存选择及编译前拒收的最小失败测试。这两项是采集初始化回归，不当作真实业务/UI RED。修复后原 raw/dylib/enrollment 原件不被覆盖，native intent 缺 descriptor 在任何 child/FIFO 启动前拒收。

实际 CLI 测试覆盖专项 wrapper 和生产 broker 两条真实路径，正常退出后重新推导 native frame、逐 cell 回放、拒收单 cell/耦合 output+cells 篡改，并验证退出尾部与 cursor/buffer 恢复。两条路径各自有实际 tmux server 启动后 client Timeout 的清理回归。另有 buffer 满与预存文件保护测试；默认 prepare 的 observer 身份有相关 Bun 回归。

最终默认入口回归执行真实 `terminal-capture-driver prepare/install`、仓库中的 `launch-built-claude.sh`、实际新构建 binary、`/exit` 和真实 `seal`，使用默认请求的200×60，保留outer pipe-pane raw，不用专项wrapper替代launcher。seal的独立回放和outer/native全量字节一致时，`boundedVerdict=passed`；同一seal仍须返回非零与完整failed，保留未覆盖项。默认启动故障在实际server创建后安装真实recorder、观察child start，再注入client Timeout；不伪造capture-ready或正常EOF。

首轮 `native-default-broker-entry-cli1` 的默认case已正常退出、逐帧通过且两份raw相等，但夹具在tmux recorder关闭前seal，等待EOF超时；这不是产品RED。最终夹具按默认driver顺序先关闭owned session/server，让真实cat收到EOF，再seal，不增加deadline或补造收据。

默认 seal 重新调用绑定原始 packet/raw 的 native replayer，再核对 outer `pty.raw` 与 native raw 完全相等。报告保留独立的 `boundedVerdict`；完整 verdict 继续失败，因为尚未建立完整 termios/resize native history、OS read/parser/唯一 owner、业务 open-close-reopen 和产品时序证明。resize IO 收据明确 `nativeClockCorrelationCovered=false`，输入转发明确 `actualOsReadCovered=false`，它们不能升级为 native proof。新的 native snapshot 条目保留原件中的 root reset、Pane 和 UI revision，不凭派生状态补造。

旧 Native30 的完整29项中23通过/6失败仍保持原判。本批没有完整默认矩阵的新完成 manifest，也没有发布四路全通过、官方完整对照、Browser Client/G5 或全部作者 API 完成结论。使用方法见 README；源码/binary/原件的最终绑定另保存在本轮迁移与验证 proof 中。
