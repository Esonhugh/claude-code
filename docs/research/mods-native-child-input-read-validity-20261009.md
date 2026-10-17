# Child 实际读入证据与覆盖边界

Darwin 私有 native journal 记录实际 child 调用的 read/readv 和两种 NOCANCEL 入口。原始 record 的 kind 3 表示输入读取，mask 4 表示注册主 PTY 的输入方向；解码后 inputMask=4、outputMask=0。它不是公开 Mods API，不在未启用私有 journal 的普通运行中采集输入。

每次原调用仍只执行一次，返回值与 errno 原样交付调用者。只复制实际成功返回的前缀；readv 按保存的矢量顺序展平成功部分。请求长度超过 payload capacity 而实际短读可完整保存时仍有效；实际返回超出容量、不可读取的矢量元数据、丢失或截断必须拒收。空读与失败不复制用户缓冲区。观察失败不会跳过或重试原调用。

记录槽在原 read 返回后分配，使阻塞输入不占用早期 ticket 阻挡并发输出采集。entry/return 是原调用的 Mach 括号；ticket 是记录分配顺序，不能充当跨线程 syscall、输入、owner 或 frame 的内核全序。已有跨线程及重叠输出拒收保持不变。

## 验证入口

先在隔离候选中运行 `make build`，并明确提供该轮新生成的 binary：

```sh
JOURNAL_TEST_BINARY=/absolute/path/to/fresh-built-claude python3 scripts/test-native-terminal-journal.py
JOURNAL_TEST_BINARY=/absolute/path/to/fresh-built-claude python3 scripts/test-native-frame-journal.py
```

两条命令执行完整文件；不要用 test-name filter 作为完整验收。使用私有 HOME/config/TMP、dummy credential 和仅 loopback provider。probe 由本机 clang 生成，CLI 文件通过脚本驱动独立 tmux。输出的 `/private/tmp/cc-journal-*` 保存原始 syscall packets、raw PTY、capture identity、实际退出和资源关闭证据。

实际 CLI 正常路径从原始 records 解码子进程读入，要求成功前缀中 `/exit\r` 恰好一次；另输出 `child-input-read-proof.json`，包含 capture/binary/PID、operation/fd/thread、原 errno 与 bytes hex。Mach uint64 时间、threadId 和 requested 使用十进制字符串，不经过浮点转换；errno 按 C signed int 校验并准确解码，包括成功调用保留的负值。证明标记 actualInputOwnerCovered=false、productTimingEquivalent=false，不能以 JSON 存在或读取成功推导消费归属。

## 失败与剩余链

初始真实 PTY RED：原调用成功收到10字节，旧 observer 的 kind 3 数量为0。新增零iov fixture 初次错误地把 Darwin readv(fd,NULL,0) 当作成功空读；实际返回 EINVAL 已保留并纠正该新 oracle，不改原回归。独立负errno RED证明原调用成功且保留-7，旧decoder却显示18446744073709551609；修复以C int的符号扩展范围解码，拒收非canonical表示。一次完整CLI和第一次errno重现因ENOSPC失败，缺失结束收据不补造、原件与日志保持失败；回收已结束派生文件的相同存储后重新运行，不升级旧结论。原始失败文件及完成后的实际 exit code 始终保留。

底层已读取的字节和 App 的 decoded string 之间仍可能存在 UTF-8 缓冲、read 合并/拆分、Tokenizer partial、paste timeout 或早期 REPL 输入。接下来必须记录这些来源到稳定事件 identity 的关系，实际消费 owner 和 focus/context generation，再关联异步效果及 React/Yoga/frame。仅记录哪些 listener 被调用、stopPropagation 或最终 pane 文本不能替代实际消费证明。

七类 compiled builtin 原启动仍使用 legacy ACK；需要在 sandbox 内最后的 native exec 前准入 observer，并由 parent 在释放启动前独立持有 capture/binary/run/pane/driver identity。完整终端时序、diff/Client 生命周期及官方所有功能的发布门禁仍独立验收。旧 Native54 的30项27通过/3失败以及历史几何失败不因本批改成通过。
