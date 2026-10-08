# 实际 CLI 的原生帧证据连接

本批把已有 Darwin shared-slot observer 接入产品 Ink，而不是只运行独立 write probe。私有 enrollment 时，renderer 在 layout 前记录身份，在原 writeDiffToTerminal 和 image/cursor 写入前后记录原生边界，随后立即序列化 frame/pool 状态并复制到 immutable native slot。原 stdout 写入参数、次数、控制流不变；不等 FIFO ACK、不 flush stream，采集错误不改用同步 ACK。缺记录、full ring、截断及多线程/交叉 syscall 仍拒收。正常运行未启用此私有 enrollment 时保留原行为。

同一真实 tmux → 私有 PTY → 新构建 CLI → `/exit` 流程首次确认缺少原生快照（`native-frame-bridge-cli-red2`），而不是把夹具初始化失败当产品 RED。接入后实际 C syscall ledger 与 immutable snapshot 建立严格 `ink-post-write-v1` 顺序：layout → begin → end → snapshot。旧 `pre-write-v1` 不接受新顺序，新协议也不放宽旧协议。`native-frame-profile-red2` 保存旧关联器的实际失败；`native-frame-profile-red1` 错选旧 binary，不计为新关联器 RED。

扩展验证确认 CLI `onFrame` 仍写旧同步 mirror（`native-frame-verified-cli1`）。本批也关闭 private journal 模式下的旧 mirror、FIFO 与 decoded-input 文件写入，保留 normal/legacy 模式。`native-frame-legacy-cli1` 的真实 CLI 同案通过；输入 parser/owner 未据此验收。

验收有效性不是只看派生帧回放。`native-frame-binding-red1` 在新文件中同时改写 output/cells，旧裸回放器错误通过。修复后的 replayer 每次重新校验独立传入的 binary/capture/PID/geometry、原 mapping header、registration/nonce、normal EOF/reap/cleanup、保存的全量 immutable packets 和原 raw；从实际成功 syscall prefix 重建每帧 bytes，再要求派生帧完全相等，最后用独立 xterm 比较 cell、样式、宽字符、cursor visibility、buffer 与 viewport。单 cell 篡改、同时改 output/cells、错误 capture ID、额外 raw bytes 均拒收。封存原件不可只改 digest 或现成 verdict 来复判通过。

`native-frame-startup-red1` 另确认实际 tmux server 创建后，client Timeout 会漏掉 kill-server；故障测试记录精确 server/child PID 并仅救援这些本轮资源。修复把唯一 private socket 的启动尝试提前登记，失败照常尝试停止该 server；未确认停止时保留 socket。wrapper 对中断保存真实 packet/raw prefix，独立 kill/wait/close，不把故障收尾冒充正常完成。

另修复 Python 的 signed dev_t 与 C uint64_t 转换：真实 CLI 初轮因设备号为负而无法初始化，此轮不算产品 RED；最小 signed-device RED 与 green 单列。已有21项 native collector 回归增加为22项。

原件均保留于 `/private/tmp/mods-remote-composer-292-20261008-rptx4ocs`。`native-frame-startup-green1` 的两个 actual 回归通过，正常原件 `/private/tmp/cc-journal-mphkwp0i/cli-0` 的9帧逐帧通过；故障原件 `cli-1` 不宣称正常完成。这些旧轮次不当最终待提交 epoch 的新制品证据。最终验证另在迁移 proof 中保留 exact source/binary/原件绑定。

此批只证明固定初始100×30、实际 CLI startup/exit 与 native frame 关联。没有接入默认 terminal driver 的完整 no-ACK backend，没有完整 termios/resize 历史、OS read/parser/唯一 owner、diff open-close-reopen/Browser Client/G5 或最新官方293完整对照。`productTimingEquivalent=false`、`fullNativeGatePassed=false`；完整 Native30 的23/29 failed 原件与manifest保持原判，不用这批9帧覆盖它。完整 release 的四路 gate 仍未通过。

独立复核还明确原9帧后的218字节只被全局 syscall/raw验证，并未进入physical终态回放。后续实现从同一原件重建尾部 bytes，继续交给同一 xterm，核对退出恢复 normal buffer/visible cursor，报告实际 cursor/baseY/viewportY；不再在末帧停止回放。这项恢复证明仍不替代 diff close/reopen 或 OS input owner。
