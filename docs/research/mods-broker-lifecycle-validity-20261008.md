# Broker 生命周期与验收有效性 — 2026-10-08

## 实现与资格判定

`terminal-evidence-broker.py` 的资源保护覆盖部分启动，startup 的停止信号 mask 在登记完资源后及 child exec 前恢复；每项清理独立执行并保存错误。恢复外层 TTY 失败不会跳过 native child、文件描述符或 FIFO。native 的退出状态只来自实际 `waitpid(WNOHANG)`；停止信号可中断阻塞写入和 EAGAIN 内层循环；停止期限到达即进入失败清理，清理 drain 的每次读取有界。异常清理有界，`kill`、关闭 master 和事后 PID 消失均不等于 EOF 或 reap。

`native-pty-eof.json` 只在实际 PTY read 返回 EOF/EIO 且取得 native wait status 后写入。它记录 native 的退出事实，不声明产品行为通过。`broker-cleanup.json` 额外记录 `physicalEof`、`normalCompletion`、`childStatus`、`stopReason`、`failure`、`cleanupErrors` 和 `terminalOutcomeSealed`；异常停止、清理错误和非零 native 退出保持失败。所有资源清理结束后封闭终态，迟到信号不再改写回执与退出分类。替换的 FIFO 保留，其他仍匹配创建身份的 FIFO 继续清理。

内置 Mods 的源缓存删除条件同时要求正常完成、真实 EOF/reap、无清理错误、无 failure/stopReason，EOF/cleanup 的原始 childStatus 都必须为整数0（拒绝布尔、缺值或矛盾状态），及原有身份/字节/归档端点核对。旧格式或异常回执不具备删除资格，记录 retained_cache 并保留源证据；不能升级业务 verdict。

## 用法

在仓库根目录运行实际 PTY 和实际调用方回归：

```sh
python3 scripts/test-terminal-evidence-broker.py
python3 .claude/skills/release-validation/scripts/test-builtin-evidence-archive.py
```

需要保留每个 broker case 的原始记录时，指定一个私有的全新证据目录：

```sh
BROKER_TEST_EVIDENCE_DIR=/private/tmp/my-unique-broker-test-evidence python3 scripts/test-terminal-evidence-broker.py
```

在真实终端内采集一个明确指定的 binary：

```sh
capture_run=$(mktemp -d /private/tmp/claude-pty.XXXXXX)
CLAUDE_CODE_FRAME_CAPTURE_ID="$(uuidgen)" python3 scripts/terminal-evidence-broker.py --run "$capture_run" -- ./built-claude
```

这是 byte、geometry、输入及退出事实的采集接口；单独运行它不会产生完整 Mods/UI 或逐帧验收。正式门禁仍需私有 HOME/config、dummy provider、本轮 binary 与完整串行矩阵。采集目录中的原始 JSON/raw 文件不能覆写。

## 错误序列和有效性处置

证据前缀：`/private/tmp/mods-remote-composer-292-20261008-rptx4ocs/`。

- `broker-lifecycle-red1` 跑错旧 archive suite，不能作为 broker RED。
- `broker-lifecycle-red2` 有一个真实启动泄漏断言失败，两个 broker wait 超时；超时不能冒称产品 RED。原源码封存在该目录的 source/。
- `broker-lifecycle-red3` 输出读取修正后暴露两个断言失败，但字段读取/沙箱 ps 错误使完整 suite 无效。保留原日志和源码。
- `broker-lifecycle-red4` 是有效旧 broker RED：4案，1通过、3断言失败、0错误、无超时；覆盖部分启动遗留 FIFO、恢复 TTY 错误跳过清理、异常完成回执缺失。源码 SHA `b76684165f83dbada1131e947cdd08124f81e7f263e2ed585dd70280e22024ef`。
- `broker-lifecycle-green2` 执行7个真实 PTY case：正常 byte/resize/frame/input/退出与 TTY 恢复；恢复失败；真实 outer PTY 丢失后显式停止；outer EOF 自动停止；运行中非法 boundary；FIFO 替换；部分启动。7通过，原始 fixture 数据保留。其源码 epoch 是改动中间版本，正式结果须以后续冻结版重跑为准。
- `broker-closure-red1` 和 `broker-closure-green1` 的 Unix socket bind 被沙箱拒绝，不能作为完整 RED/GREEN。
- `broker-closure-red2` 在允许私有 Unix socket 的隔离环境中执行完整25案，22通过、3断言失败、0错误；原 consumer 错误删除带 cleanupErrors、异常完成、未观察 EOF 的源缓存。源码 SHA `0d750622bb60ea61b5dddca42200e93e6c9f8d52a266e09816388af6260589d5`。
- `broker-closure-green2` 同一25案通过；consumer 修复与 broker 的7案共同绑定源码 `4cee55036c906bb8e9fc9e02e07685b11cdf5e61fb8600363e3165c315d7d0b1`，无源漂移、无外层超时，测试 wrapper 进程组消失。

受控 native 是实际 fork/exec 的 Python 程序，恢复失败仅注入父进程 restore syscall。archive caller 的 controlled producer 不启动产品 CLI；这两类回归不能冒称完整 native Mods、physical frame 或时序等价证明。实际 outer EOF 自动停止 case 是新实现的正向覆盖；旧版曾超时，不能倒填成有效 RED。

## 后续预审与补充回归

只读预审指出背压内层循环、永久等 EOF、原始 childStatus 消费缺口，不能把当时局部 GREEN 当成闭合。原报告保留：mods-broker-lifecycle-readonly-9uw3awnf、broker-closure-readonly-d756c_lz，以及 broker-lifecycle-readonly-audit-r1；最后一项预审的 candidate/wrapper 五项漂移明确记为 not covered。

`broker-wait-status-red1` 完整29案，25通过、4失败、0错误；覆盖矛盾状态、signal 状态冒称 exit0、缺 childStatus、布尔 childStatus。该版 source `e0aeb11f353ed6490325a44be221550923914d4f6eb62f6311fbde8aa58d8ef4` 与 consumer 原码封存。修复后 green1 的29案与 broker-green3 的9案共同属于中间 source `faef152766d7ad2d8f6029b7f7d7fe8661197e529f2151686766dccfbbd2a063`。

`broker-stop-red1` 中的 inherited-slave 假设在 Darwin 未成立：leader 退出后内核已返回 EOF；这一 case 是 fixture 失败，不能作为产品 RED。`broker-stop-red2` 独立2案均在已验证 setup 后违反停止期限：第一项实际 native write EAGAIN 并观察到 stopped=true/stopReason=SIGTERM；第二项实际 waitpid status0 后明确注入 EOF observation failure。二者为有界停止断言失败、0 setup errors，外层 runner 未超时；与没有成功进入错误状态的启动/等待超时区别记录。源码 `327d7d88f6ad1735b816f1b111c4a6a7c8394f432861f905f7aa7dcc5ddb7878` 保留。

`broker-output-stop-red1` 的 Darwin FIONREAD=0 使 fixture 前提失败；真实 native PID 在事后唯一 argv 核对时已消失，未发信号，不补签 EOF。修正 fixture 用未被测试读取的 outer PTY readable 状态、实际 broker write 与 native raw bytes，`broker-output-stop-red2` 才达到停止期限断言：1案1失败0错误，source `8050a7787ecf0e6f3a43f2e54566a3ba8c7d3e037292aa31aaa4f507683d2e5c`。只把这些实际观察称为背压证据，不伪造 FIONREAD 数量。

最后 broker-green4 的10案全部通过，包含新增输出背压；正式冻结版仍必须重跑10案、29案和完整检查/构建/门禁。EOF observation failure 属于明确父端故障注入，不是完整产品的 physical replay 证明。

旧冻结 A/N 的最终门禁不能提交：clean-check1 因 CHANGELOG heading 格式失败，native-unit1 的 EOF 注入 case 暴露 InterruptedError 被 selectors 吞掉、实际累计期限超限；feature 预审另指出 SIGTERM 可落在 acquisition→登记之间。旧 source A `e7adc2a832117dcf974779a3f51e135d72634a0ea57276bc555f020099c526a2`、N `8dd7c97a553f5f5149e5f8814e114e87d62552b0e41a2f0eec173f0094ee97d2` 全部保留，未启动其完整 native 矩阵。

新 candidate2 的 `broker-acquisition-red1` 用实际 mkfifo 返回前发送 SIGTERM，1案1断言失败0错误、无超时，source `55afc1e61df102835a4cc3697ab5263c4c569a97c5020a7f928c86c88d2d014b`。修复 startup 停止信号的 acquisition/登记窗口，并使用专用非 OSError 的 BrokerStopped，防止 selectors 将停止异常当作 EINTR 吞掉；native exec 恢复调用方原 signal mask，正向 case 实测其一致。新增 acquisition case 与原10案一起重跑，旧 GREEN 不继承。CHANGELOG 增量按既有未发布版本格式归入 v2.1.280，完整验收作业按串行执行，先前并发 check 的自动审批拒绝保留。

candidate2 的10项严格串行验证均完成且 exit0/无漂移/PG消失，但主会话继续发现 waitpid 成功到 status 登记之间的停止窗口；不能据此提交。candidate3 的 `broker-waitpid-window-red1` 在实际 waitpid status0 返回后发送 SIGTERM，1案1失败0错误、无超时，source `25545dd0e0878849764a9436bbb9f328490188698d35d3f0c59d0b07612af69f`；旧代码实际 childReaped=false。修复以 signal mask 保护 syscall→状态登记，随后恢复原 mask 并正常处理停止原因。新增12案中间版 green1 全部通过；最终冻结后仍须全部重跑。该实际回归与原11案一起重新验收，不能用 SIGKILL 后 PID 消失替代被丢失的原 wait status。

candidate3 的两侧10项串行验证全部通过，但只读预审另发现 cleanup 完成到回执发布之间的停止信号可使 normalCompletion 与 stopReason 矛盾，不能继承其 GREEN 提交。candidate4 的 `broker-terminal-seal-red1` 在实际 EOF/reap、FIFO 移除之后的 waitstatus_to_exitcode 调用中发送实际 SIGTERM：1案1断言失败0错误、无外层超时，旧回执为 normalCompletion=true/stopReason=SIGTERM，source `4fc2166183ce3ba3f2b409d354eb6f65e2d13fcb62294442cf749aa0019f9085` 与源码原件保留。consumer 原有 stopReason=None 守卫已拒绝这种回执，未确认归档假阳性。修复定义清理结束后的 terminal outcome seal：此前信号保持异常停止，此后信号不再改写已封闭的退出分类；回执记录 terminalOutcomeSealed。新增 case 与原12案共同重跑，完整矩阵须绑定第四版冻结源码与新 binary。

## 完整门禁边界

从已提交 `3952794d815eb5ac951da84211bffa2a109b8024` 建立干净候选；不复制共享工作区中其他 Claude 的产品改动。历史来源是18个验证 overlay；当前其中 broker/test 是 A/N 共同的本批交付实现，另外16个 verification-only overlay 由 freeze.json 单独列明，不能当作已交付产品兼容性。

本批需要对最终冻结源码重跑 focused tests、release-check、build、retained driver 和 default required matrix；不能继承上述中间版本或 Native24 的 green。最终完整矩阵的事实以独立 evidence 中的 driver-final-manifest.json 为准。

Native24 原结果29完成、23通过、6失败不变。同步 frame ACK 的 productTimingEquivalent 仍为 false；本批不补签旧缺失 EOF/reap，不吞32字节尾流，不放宽 Tab、diff、Workflow 业务断言。完整 Mods、最新官方 native、浏览器 Client 及正式四独立 Agent 验收仍未完成，目标继续处理。
