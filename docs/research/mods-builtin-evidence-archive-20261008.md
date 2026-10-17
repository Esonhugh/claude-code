# 内置 Mods 验收证据归档

Native20 的 `builtin-mods` 因缓存中的真实 `frame-request.fifo` / `frame-response.fifo` 被 `shutil.copytree` 当作文件读取而归档失败。它没有形成有效的七侧验收报告；不能从 partial archive 或 Native19 拼出通过结论。Native20 保持 29 项完成、23 通过、6 失败，退出 1；source `17e10bbd9ecff64c75b9e1a72a3593a5c4fae44ff239e7c3f18fd34228964b3c`、binary `d6c059f858b98c98f3ad46626c44554780128cd6101c244e9693d211ebc9f1e7`、manifest `9afea0b8b3968b1dae90a8af982104225707f5180d1e524c8085b31be3b8a707`。原件封存，不覆写失败。

本批从提交 `795f43d` 的干净副本处理验证驱动，不带入共享工作区的产品 WIP。归档仅在 `runs/r-<12位小写十六进制>/` 下排除经 `lstat` 确认为 FIFO 的两个 frame 通道和确认为 socket 的 `tmux.sock`；记录路径、类型、设备、inode 与 mode。相同名称的普通文件必须复制，未知 FIFO/socket 仍导致归档失败。排除 IPC 端点不表示它们所属进程已退出。

普通证据、原始 PTY 字节与原报告完整复制，symlink 保持为 link，不解引用读入外部目标。复制前后的源文件 manifest 和目标 manifest 必须相同；源漂移或目标字节不符都失败。`builtin-cache-archive.json` 使用独占创建，保存源 manifest、排除记录和完成状态；不会覆盖上一轮收据。

原 `acceptance.json` 保留原字节，归档 manifest 不因路径重写失效。供后续独立校验使用的路径映射报告另存 `acceptance-remapped.json`。归档收据及原报告也加入本轮断言证据。归档成功仅证明文件保存，业务断言、当前 binary 身份、七个独立 capture、逐帧回放、时序、原生 EOF/reap 和清理继续各自验证。

调用方仅在 producer 的匹配 EOF/reap/通道移除收据完成、删除前源目录和归档仍与初次复制的 manifest 完全一致时删除源缓存。初次 manifest 和排除的 IPC 身份留在调用方内存中，最终核对原归档收据的路径、完成状态、manifest 和排除记录；不能拿晚到数据重建基线。收据必须对应初始 capture、PID、binary 和 raw 长度。源漂移、坏副本、未知端点、缺报告、未完成复制或 producer 尚未闭合时，实际源缓存保留，`builtin-mods-checks.json` 的 `retained_cache` 指明路径，`cache_cleanup=false` 继续使目标失败；`cache_producers_closed` 记录 producer 收据闭合，`cache_archive_current` 记录最终双目录与原快照一致；两者不能互相代替。保留路径属于本次 `mkdtemp` 自有缓存，不是可借用的其它 run 证据；不能为了清理计数而删除未保存的原始字节。这道文件收据检查也不替代独立的原生退出验收。

## 验证与使用

验证驱动自动执行归档，无需手动删除 FIFO。归档回归可独立运行：

```bash
PYTHONDONTWRITEBYTECODE=1 python3 .claude/skills/release-validation/scripts/test-builtin-evidence-archive.py
PYTHONDONTWRITEBYTECODE=1 python3 .claude/skills/release-validation/scripts/test-release-driver.py
make release-check
make build
```

文件系统回归使用真实本地 FIFO/socket，并检查同名普通文件、未知端点、link、源漂移、坏副本、收据防覆盖及失败报告不被升级。另有十二个经过真实 `builtin_mods` 调用方的保存/删除检查；外部 acceptance producer、其文件回执与复制故障受控，helper 与调用方实际执行。这是 harness 验证，不是产品原生验收。

独立只读审查曾发现 F01：helper 拒收后，调用方仍无条件删除源缓存。`fifo-archive-caller-red1` 的正常成功控制访问了旧版缺省字段，出现一个读取错误，不计为产品 RED；修正控制字段读取后的 `fifo-archive-caller-red2` 执行14案，10通过、4失败、0错误，四种失败保存路径实际得到 `cache_cleanup=true`。修复只限制源缓存删除条件并记录保留路径，原错误收据与旧候选不覆写；修复后的同轮结果须重新结算。

第一版 F01 修复的14案通过仍未覆盖复制后的 producer 写入窗口。Native21 留下实际孤儿 broker，证明“复制时文件稳定”不能替代 producer 已退出。`fifo-archive-open-producer-red1` 在归档核对后实际追加源字节，执行15案，14通过、1失败、0错误；缓存仍被删除。新增 EOF/reap 资格检查后，未闭合 producer 的源缓存必须保留，包括复制后到达的字节。受控文件回执不冒称真实 CLI；完整 Native22 用新产物另行验证。

Native22 的只读审查继续发现 F02：复制完成后 producer 追加 raw 并写出对应的新 EOF/reap，闭合检查会成功，但副本还没有这些字节和回执；副本自身复制后损坏也有相同误删除路径。`fifo-archive23-closed-producer-red1` 实际执行17案，15通过、2失败、0错误，两种情形均在真实 `builtin_mods` 调用方错误得到 `cache_cleanup=true`。新增删除前最终源/副本/原收据检查，失配保留源，旧22不提交、不修改失败证据；新23重新绑定全部门禁。这些外部 producer 回执受控，不是原生产品成功证明。

Native22 setup 的旧 `producerGateSHA256` 没有声明可复现提取范围，不能据此验证函数源码；这一元数据缺口记为 M01，不能冒称 source 漂移或补写旧收据。Native23 setup 逐函数记录 AST 的 `lineno..end_lineno` 原始 UTF-8 完整行（包含末行换行）、范围和 SHA；完整源码仍独立由本轮 manifest 绑定。

Native23 的 F03 阻止该候选提交：普通 manifest 不包含特殊文件，复制后新建未知 FIFO/socket 仍可绕过核对。`fifo-archive24-late-endpoints-red1` 实际执行21案，17通过、4失败、0错误；源新增未知 FIFO/socket、晚到同名 `tmux.sock` 和副本新增未知 FIFO 四条真实调用方路径均错误删除源。最终删除前还以 `lstat` 扫描源与副本：副本不得含特殊端点，源只允许初次排除且路径、类型、设备、inode、mode 全部相同的 IPC；原端点被移除可接受，新增或替换的端点必须拒收并保留源。十个直接文件系统回归与十二个真实调用方检查合计22案；实际绑定的原端点是允许保留的正向控制，已排除 socket 被替换后必须失败。新24从头结算，不继承23或旧失败的成功片段。

完整原生矩阵必须绑定最终冻结源码和本轮新 binary，按 default required targets 全部执行；附加 target 不缩减范围。本批 native 候选的 18 个既有验证 overlay 独立列出，不把它们当作已提交产品实现，也不继承旧 binary 或 Native20 的通过片段。所有修复都会形成新 epoch，相关测试、检查、构建和完整矩阵均须重新结算。

## 未闭合项

Native20 的 FIFO 归档失败与孤儿 broker 善后是两种问题。主会话后来核对归属并清理了自己创建的 broker/child；事后 PID 消失不补签历史缺少的 EOF/reap。此归档修复不改变 broker 的同步 ACK、退出和排空实现；完整终端时序、首次 Tab 焦点、resize 几何、diff close 日志、Workflow 结果契约仍须修复并实测。

未完成、缺证据、源漂移或业务失败保持失败。三个只读子 Agent 与主会话不等于四个独立 Agent 的正式发布门禁；完整 Mods、最新官方 native 和浏览器生命周期验收继续进行。

Native21 的归档阶段已保存原报告、独立映射和9886项普通文件/目录/link manifest，两项真实 FIFO 独立记录；完整矩阵仍29完成、23通过、6失败，退出1。source `78f6e2643d0fc2fd582441231f4d14ac38b34be0bcf6099f16c1d6d6b52c4cee`、binary `6094456651c8d161b0c1a12ef6036e8f8e11003f3116030bd94d5c91a576c625`、manifest `944b07fb58117c243e9414cd118df926fa16c0900137606a7b10f6ab12cdc658`。本轮归档异常已消除不代表业务通过，F01使该候选不提交。调用方修复形成新epoch与Native22，不继承Native21的任何局部 green。
