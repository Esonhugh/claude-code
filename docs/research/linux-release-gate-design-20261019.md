# Linux 发布门禁：macOS-only target 的独立实现设计（2026-10-19）

状态：已确认按此实施（门禁做完再发版；同意在采集阶段修改 `src/ink/nativeTerminalJournal.ts` 的平台判断）。实施顺序见第 4 节。


结论：四个目标归结为两套底层机制。
- **A. 进程隔离**（builtin-mods、mods-process-spawn）：替代 `sandbox-exec`，用 user+mount+net 命名空间 + Landlock，必要时再加 seccomp。
- **B. 原生终端写入采集**（terminal-interaction、terminal-canonical-diff、builtin-mods）：替代 Darwin 的 `__interpose` 共享槽观察器，用 seccomp `RET_TRACE` + ptrace 的旁路追踪器，写入**同一种**共享槽日志格式。

两套机制都在不可用时 fail closed（明确报错），不做无隔离回退，也不降低任何断言。

---

## 0. 实测结论（会改变方案的事实）

**1. 仅靠 LD_PRELOAD 采集不到 Linux 上的写入。**
- `strace -k` 实测 bun 1.3.14 的 `process.stdout.write`、`console.log`、`fs.writeSync` 三条路径：`write(2)` 的栈顶帧都在 bun 自身代码里，不经过 libc。
- `objdump` 显示 `built-claude` 里有 103 处内联 `mov $1,%eax; syscall`（write）和 11 处 pwrite64。它虽然也导入了 libc 的 `write`/`writev`，但实际用的是裸 syscall。
- 由此，Darwin 那种"拦截 libc 符号"的思路在 Linux 上会漏掉写入。不过现有的"原始字节完全相等"检查最终会报失败，所以不会误判为通过，只是这条路走不通。

**2. 其他相关调用的路径。**
- `tcsetattr` 走 libc，实测发出 `ioctl(TCSETSW)` 后再 `TCGETS` 校验。
- stdin 读取走 libc `syscall()` 发出的 `preadv2(0,…,-1,RWF_NOWAIT)`。

**3. 内核和工具条件（本机实测）。**
- Landlock ABI=7，可用。
- seccomp 支持 `trace` 和 `user_notif`。
- user/mount/net 命名空间可用：tmpfs、bind、ro remount 都实测通过。
- ptrace 可用（strace 能跑）。
- Python 3.13 自带 `os.unshare`；util-linux 2.39 支持 `--map-current-user`。
- 没有 `ip` 命令，所以把 lo 拉起来要在辅助程序里用 ioctl 自己做。

**4. 产品代码有一处硬性限制。**
- `src/ink/nativeTerminalJournal.ts:31` 写死了 `process.platform !== 'darwin'` 就不 dlopen 标记库。
- 结果是 Linux 上没有 kind 10–13 的帧边界记录，`ink_frame_entries` 必然失败。
- 必须改成 darwin‖linux 并**重建 built-claude**（binary sha 会变）。这一点需要你拍板。不改的话，两个 terminal 目标和 builtin-mods 在 Linux 上只能 fail closed。

**5. root 下的启动拦截。**
- `src/setup.ts:88-103`：uid=0 且没有 `IS_SANDBOX=1` 时，`--dangerously-skip-permissions` 会直接退出。
- 沙箱应保持 uid 原样映射（`uid uid 1`），不要用 `--map-root-user`。
- 宿主本身就是 root 时（例如本容器），沿用 `run-binary-gate.py:5107` 的做法注入 `IS_SANDBOX=1`，并写进 receipt。

---

## 1. 隔离机制（builtin-mods / mods-process-spawn）

### 1.1 macOS profile 实际保证了什么

**mods-test-lab**（`scripts/mods-test-lab.mjs:191-195`，在 `sandboxCommand` `:227-232` 里使用）：
- 写：在 `(allow default)` 基础上拒绝 run 目录和 `/dev` 以外的所有 `file-write*`。
- 网络：拒绝 `network*`；只放行 localhost 的出站、入站、bind，以及全部 unix socket。
- 执行：只拒绝执行 `/usr/bin/security`。
- 读：
  - 拒绝读 `$HOME` 下的文件内容，例外是 run 目录，`inspect` 模式下再加上 REPO；
  - 完全拒绝读 Keychains 目录、`/Library/Application Support/ClaudeCode`、`/etc/claude-code`、`REPO/.claude`、`REPO/.env`。
- IPC：拒绝对 `securityd` 的 `mach-lookup`。

**process-spawn**（`scripts/validate-mods-process-spawn.py:112`，在 `:204` 包裹 tmux server）：
- 写：只允许 root、socketRoot、`/dev/null`、`/dev/ptmx`、`/dev/ttys*`。
- 网络：拒绝**全部**网络，包括 localhost TCP；只放行 unix socket。
- 执行：拒绝 `/usr/bin/security`。
- 读：拒绝 `securityd`、Keychains、`~/.claude`。

### 1.2 Linux 对应机制：新增 `scripts/linux-sandbox-exec.py`

纯 Python + ctypes 实现，读取一个 JSON policy（相当于 `sandbox.sb`），在 run 目录里以 `wx`/0600 写入 `sandbox.json`。按以下顺序执行：

1. **建命名空间**：`os.unshare(CLONE_NEWUSER|CLONE_NEWNS|CLONE_NEWNET)`，写 `setgroups=deny`，uid/gid 原样映射。
   - **不用** PID 命名空间。`validate-mods-process-spawn.py:200,259` 和 `release_owned_terminal_socket` 都用外部看到的 pid 去 kill，换了 PID 命名空间这些 pid 就对不上。
   - **不用** time 命名空间，保证 CLOCK_MONOTONIC 和外部一致。
2. **挂载**：先 `mount --make-rprivate /`。
   - **隐藏读**：用空 tmpfs（mode 000，只读）盖住当前用户 `pw_dir`、`/home/*/.claude`、`/etc/claude-code`（Linux managed settings 也在这个路径）、`REPO/.claude`、`/run/user/<uid>`（D-Bus session bus / keyring）。
   - **隐藏单个文件**：`REPO/.env` 用 bind `/dev/null` 盖住。
   - **放回例外**：run 目录 RW 放回；`inspect` 时 REPO 只读放回，然后在上面再盖一次 `.claude`/`.env`；bun 安装根目录只读放回（本机 bun 在 `/root/.bun`，位于 home 内，必须显式写进 policy 的例外清单）。
3. **网络**：在新 netns 里用 ioctl `SIOCSIFFLAGS` 把 lo 拉起来。
   - mods-test-lab 用 `network.mode=loopback`：等价于"只有 localhost"，而且比 macOS 更严，宿主的其他本地服务也够不到。
   - process-spawn 额外加 seccomp：`socket(AF_INET|AF_INET6|AF_PACKET)` 直接返回 EPERM，对齐"连 localhost TCP 也拒绝"，错误码也对齐 macOS 的 EPERM。
4. **写范围**：`PR_SET_NO_NEW_PRIVS`，然后 Landlock。
   - 受控的是写相关权限：`WRITE_FILE`、`REMOVE_*`、`MAKE_*`、`REFER`、`TRUNCATE`。
   - **不**管 `IOCTL_DEV`，否则 PTY 的 ioctl 会受影响。
   - 允许写的范围：run 目录（全权限）；mods-test-lab 放行 `/dev`；process-spawn 放行 `/dev/null`、`/dev/ptmx`、`/dev/pts/` 和 socketRoot（含 `MAKE_SOCK`）。
   - 要求 ABI ≥ 3，否则 fail closed。
5. **`/usr/bin/security` 和 `mach-lookup securityd` 的对应物**：
   - 用 bind `/dev/null` 盖住 `secret-tool`、`gnome-keyring-daemon`、`kwallet-query` 等存在的可执行文件，执行时返回 EACCES。
   - 宿主的 abstract unix socket（D-Bus 等）在新 netns 里天然不可达。
   - 这是"类比"，不是逐字等价，要在文档里写清楚。
6. **执行前自检**：fork 一个子进程，在全部限制生效后尝试一组逃逸动作：写 run 外文件、写 `/tmp`、在允许目录外 bind socket、连外网 IP、连宿主 loopback 端口、读隐藏标记、读 `.env`、执行被盖住的工具。
   - 每一项都必须失败，结果写入 `sandbox-probe.json`（0600，`wx`）。
   - 任何一项意外成功就退出非零，不再 exec 目标程序。
7. 最后 `execve(argv)`。

**accept-builtin 的 provider 桥接**：
- 问题：`startAcceptanceProvider`（`mods-test-lab.mjs:315`）在宿主 127.0.0.1 上监听，新 netns 里访问不到。
- 做法：仅 Linux 上，provider 用同一个 handler 额外监听 `root/provider.sock`；沙箱辅助程序 fork 一个转发进程，在 netns 内监听 `127.0.0.1:<同端口>` 并转发到这个 unix socket。
- 请求账本 `requests.jsonl` 不变。

**Fail closed 条件**：
- 平台不是 linux；
- `unshare` 返回 EPERM（例如 Ubuntu 的 apparmor `restrict_unprivileged_userns`）；
- uid_map 写入失败；
- Landlock ABI < 3；
- lo 拉不起来；
- 任一自检项意外成功。

以上情况一律报 "Linux isolation unavailable: <原因>; no unisolated fallback"。

### 1.3 需要改的位置（Darwin 分支保持字节级不变）

**`scripts/mods-test-lab.mjs`**
- `:228` 的 `sandboxCommand` 改为按平台分发：darwin 原样；linux 生成 policy，把辅助脚本 pin 进 run 目录（复用 `createBuiltinNativeLauncher` 那种"复制 + sha 校验"模式），返回 `[/usr/bin/python3, helper, '--policy', p, '--', ...argv]`。
- `:30` 默认 cache 目录在 Linux 上改为 `/tmp/mods-test-lab`（socket 路径必须 < 100 字节）；`:254`、`:281` 的 `/private/tmp` 提示改为按平台显示。
- `:315` provider 增加 unix 监听（仅 Linux）。

**`scripts/validate-mods-process-spawn.py`**
- `:105` 的前置条件按平台判断。
- `:107` 的 `/private/tmp` 改为 HOST_TMP_ROOT。
- `:110` 的 PATH 加上 `dirname(bun)`。
- `:112` 的 profile 改为 linux policy。
- `:204` 的 server argv 改为走 linux 辅助程序。
- 报告和检查项不变；`sandbox.json`/`sandbox-probe.json` 会被 `:285` 的 `rglob` 自动纳入 `artifactsSHA256`。

**`scripts/terminal-evidence-broker.py:51`**：除了 `argv[0]=='/usr/bin/sandbox-exec'`，也要识别 linux 辅助程序的 argv 布局。

**`.claude/skills/release-validation/scripts/run-binary-gate.py`**：
- `:6150` 的 builtin_mods 已经按平台选 tmp 目录，无需改。
- `:6087` 的 process-spawn driver 不变。
- 可以仅在 Linux 上新增 `sandbox_probes_passed` 检查；Darwin 上没有这个 key，不影响现有结果。

---

## 2. 原生终端采集

### 2.1 Darwin 采集器实际保证了什么

依据 `scripts/native-terminal-journal.c` 和 `scripts/native-terminal-journal.py`：

- **拦截范围**：通过 `__interpose`（`.c:325-333`）拦截 `write`/`writev`/`write$NOCANCEL`/`writev$NOCANCEL`、`read` 系列 4 个和 `tcsetattr`。产品通过 bun:ffi 调用 `cc_terminal_journal_mark` 写入 kind 10–13 的帧边界记录。
- **共享内存布局**：MAP_SHARED 共享文件，32 字的 header + 若干 20 字的 slot。
  - 槽状态机：0 → 1（预留）→ 2（发布）→ 3（消费中）→ 0；
  - 序号来自对 `header[9]` 的原子 fetch_add；
  - 生产者从不等待消费者，没有 ACK。
- **每次调用记录的字段**：序号、kind、pid、tid（`pthread_threadid_np`）、调用前后的 mach 时间戳、fd、端点掩码、op（1–4，区分 NOCANCEL）、请求长度、返回值、原始 errno、truncated 标志、payload 长度、span。
  - 写入：调用**前**预留槽并复制 payload（`.c:186-203`）。
  - 读取：调用**返回后**才预留（`.c:233`），避免阻塞读留下序号空洞。
- **来源身份**：
  - 构造函数要求 fd 1/2 的端点（dev/ino/rdev/mode）等于登记的端点，然后用 CAS 把 `header[8]` 写成自己的 pid；
  - 子孙进程如果连在同一端点上，CAS 会失败，计入 `lose()`；
  - 不在该端点上的进程直接不记录（`.c:153-162`）。
- **丢失 / 截断检测**：
  - 槽忙或 header 被篡改 → `header[10]++`；
  - 超出 payload 容量或复制不全 → `slot[13]=1`；
  - 解码器（`.py:89-160`）要求：header 与登记一致、pid 正确、`[10]==0`、关闭标志 `[11]==1`、序号连续、时间戳落在生命周期内、op 和返回值合法、失败时必有 errno。
- **顺序**：`verify_raw` 要求只有一个写线程、相邻调用时间区间不重叠（`.py:196-212`）。
- **完整性兜底**：所有观测到的写入字节拼起来，必须等于 PTY master 收到的原始字节。

### 2.2 Linux 对应机制：seccomp RET_TRACE + ptrace 旁路追踪器

**进程拓扑（保持 `childPid == 产品 pid == header[8] == pgid`，见校验 `builtin-terminal-evidence.mjs:695-718`）**：

1. broker 先设 `PR_SET_CHILD_SUBREAPER`，再 Popen `run/observer-exec --journal … --binary run/bin/claude -- <产品 argv>`。这一步保留 `start_new_session` 和 `TIOCSCTTY`，`launch.json` 的 command 不变。
2. observer-exec（记为 P）：
   - 校验登记信息；
   - 设 `prctl(PR_SET_PTRACER, …)`；
   - 双 fork 出追踪器 T2；T2 被重新挂到 broker 这个 subreaper 下，由 broker 回收，避免产品 waitpid 到它。
3. T2 执行 `PTRACE_SEIZE(P, EXITKILL|TRACESECCOMP|TRACECLONE|TRACEFORK|TRACEVFORK|TRACEEXEC|TRACEEXIT|TRACESYSGOOD)`，然后通过管道通知 P。
4. P 校验 `/proc/self/status` 里的 TracerPid 等于 T2，然后设 `NO_NEW_PRIVS`，安装 seccomp 过滤器，最后 `execve` 产品。**pid 不变。**
   - 过滤器对以下调用返回 `RET_TRACE`：`write`、`writev`、`pwrite64`、`pwritev`、`pwritev2`、`read`、`readv`、`pread64`、`preadv`、`preadv2`；
   - `ioctl` 只在 `TCSETS`/`TCSETSW`/`TCSETSF` 及其 `*2`/`TCSETA*` 变体时返回 `RET_TRACE`；
   - `sendfile`、`splice`、`tee`、`vmsplice`、`copy_file_range`、`io_uring_setup`、`io_uring_enter` 也返回 `RET_TRACE`；
   - 其余一律 ALLOW。
5. T2 收到 `PTRACE_EVENT_EXEC` 时，校验 `/proc/P/exe` 的 dev/ino 等于 `bin/claude`，然后 CAS `header[8]=P`，写 `[12]=[13]=1`（纳秒）、`[19]=CLOCK_MONOTONIC`。

**每次系统调用的处理**：
- **入口**：用 `PTRACE_GET_SYSCALL_INFO` 取参数。用 `pidfd_getfd` + `fstat` 比对端点身份（行为同 Darwin 的 `same_endpoint`）。用 `process_vm_readv` 复制 payload/iovec（相当于 `mach_vm_read_overwrite`，复制不全就置 `slot[13]=1`）。记下入口时间戳，然后 `PTRACE_SYSCALL`。
- **出口**：取返回值和 errno。如果是 `-ERESTART*`，丢弃这条（内核会重启该调用，并再触发一次 seccomp 事件）。否则**在这时才**预留槽（同 Darwin 读路径，不留序号空洞），填字段、发布，然后 `PTRACE_CONT`。
- 字段：`slot[3]`=tgid，`slot[4]`=tid。
- 槽忙 → `header[10]++`，与 `lose()` 相同，不等待消费者。

**termios（kind 2）**：
- 入口时对 dup 出来的 fd 做 `TCGETS` 得到 before；从产品内存读出 requested；出口时再 `TCGETS` 得到 after。
- op 映射：`TCSETS/W/F` 对应 0/1/2，与 TCSANOW/DRAIN/FLUSH 同义。

**来源与丢失**：
- 产品以外的子孙进程写主端点 → `header[22]++`（foreign）。
- `sendfile`/`splice`/`io_uring` 等写到端点 → `header[23]++`（unsupported）。
- 追踪器死亡 → `EXITKILL` 杀掉产品，没有关闭边界，校验失败。
- 必须跟踪全部子孙。原因：`RET_TRACE` 在没有追踪器时会返回 ENOSYS，会改变子进程行为。

**关闭边界**：产品线程组最后一个线程在 `EVENT_EXIT` 且属于正常退出（`WIFEXITED`）时，写 `[21]=now` 并置 `[11]=1`。

**`observer.so`**（新文件 `scripts/native-terminal-journal-linux.c`，Darwin 的 `.c` 不动）：
- `cc_terminal_journal_mark`：在产品进程内写入，要求 `header[8]==getpid()`、fd 1/2 在登记端点上，时钟用 CLOCK_MONOTONIC。
- `cc_terminal_journal_consume`：逻辑与 Darwin 相同，可变 header 字额外加上 22/23/24/25（header[20] 是登记的不可变字段）。
- `cc_terminal_native_resize`：用 CLOCK_MONOTONIC，`receipt[10..11]=1,1`。
  - TIOCSWINSZ 在返回前就向产品发出 SIGWINCH；宿主繁忙时 broker 会被唤醒的产品抢占，产品对 resize 的反应写入（如 `ink.tsx` 重发鼠标模式）落进 broker 的 `[entry, return]` 区间，校验器判 "overlaps an output syscall"。
  - 因此 broker 在共享 header[24] 发布区间（打开时为奇数，CAS 打开、关闭时 +1）；追踪器在区间打开期间扣住产品的 SIGWINCH 信号投递停止和新的端点写入，区间关闭后才放行并记 entry。区间遗留打开（broker 死亡）超过 1 秒计为丢失，此后不再等待。
  - 产品写入已返回、字节已可读，但追踪器可能稍后才处理该 syscall-exit 停止并记下返回时间；此时打开区间会让该写入的 return 晚于区间 entry。因此追踪器在检查区间之前先把放行的端点写入计入 header[25]，记下返回时间后减一；broker CAS 打开区间后若 header[25] 非零，先撤回区间（恢复原值，不计入 resize 次数），等其归零后重试，等待超过 1 秒返回 `EBUSY`。
- 追踪器和 observer-exec 用同一份源码以 `-DCC_OBSERVER_EXEC` 编译。

**日志格式兼容策略**：
- `backend` 保持 `native-shared-slot-v1`。这是如实的：Linux 也是同一个共享槽环。
- `header[20]` 写入固定的 `LINUX_V1` 魔数。它属于登记的不可变字段；Darwin 那里该字恒为 0，所以字节完全不变。
- 校验器按 `header[20]` 选择**唯一一套**方法集，平台混用一律拒绝：

| 项目 | Darwin | Linux |
|---|---|---|
| 写 op 集合 | {1,2,3,4} | {1,2,5,6,7} |
| termios 记录格式 | `<6Q20B`，前缀 (1,20) | `<6Q19B`，前缀 (2,19) |
| resize 方法名 | `native-mach-ioctl-resize-v1` | `native-linux-ioctl-resize-v1` |
| 帧边界方法名 | `native-mach-frame-span-v1` | `native-linux-frame-span-v1` |
| 驱动时钟方法名 | `driver-mach-absolute-time-v1` | `driver-linux-monotonic-v1` |
| 几何方法名 | `native-driver-mach-frame-geometry-v2` | `native-driver-linux-frame-geometry-v2` |
| Linux 额外要求 | — | `header[22]==header[23]==0`；关闭时 `header[24]` 为偶数且等于 2×resize ACK 数；`header[25]` 为可变的在途写入计数 |

- `native-observer.json` 在 Linux 上增加字段：`observer:'linux-seccomp-ptrace-v1'`、`observer.so`/`observer-exec` 的路径和 sha、内核版本。
- broker 的 cleanup 记录 tracer pid 和退出码，Linux 校验要求退出码为 0。

### 2.3 需要改的文件和函数

**`scripts/builtin-terminal-evidence.mjs`**
- `:80` 允许 linux。
- `:91`、`:121-139` 增加 linux 编译分支：`/usr/bin/cc -std=c11 -Wall -Wextra -Werror -O2 -fPIC -shared`，外加 exec 变体。
- 运行 `observer-exec --probe`（在 PTY 上跑 `/bin/true` 自测），失败就抛错。
- `:609`、`:661-718` 的文件名单和 backend 校验按平台区分。

**`scripts/terminal-evidence-broker-native.py`**
- `:52-58` 校验 observer 登记信息（按平台）。
- `:178-186`：Linux 下不设 `DYLD_INSERT_LIBRARIES`，argv 前面加 observer-exec，broker 设 subreaper。
- `finally` 里回收 tracer。

**`scripts/native-terminal-journal.py`**
- `:18`、`:20`、`:32`、`:122-136`、`:319`、`:464` 按平台分支。

**驱动时钟**
- `scripts/native-driver-clock.mjs:8-33`：Linux 用 libc `clock_gettime` 和 `gettid`。
- `scripts/native-driver-clock.py:15-48`：Linux 用 `time.clock_gettime_ns(CLOCK_MONOTONIC)` 和 `threading.get_native_id()`。

**方法名校验**
- `scripts/verify-native-frame-journal.py:65,155,255`
- `scripts/native-frame-journal-replay.mjs:20,35,76,107`
- `run-binary-gate.py:738`、`:1385`（`NATIVE_TERMINAL_CAPTURE_FILES` / `terminal_capture_required_files` 改为从 `launch.capture` 推导平台）、`:1883`、`:1905`、`:2367`
- 平台常量**内联**在各文件里，不新增共享文件。这样 Darwin 的 `helpers.json`（5 个文件 / 7 个 pin）保持不变。

**产品**：`src/ink/nativeTerminalJournal.ts:31`（见 §0 第 4 条）。

**terminal 目标本身不使用沙箱**：`run-binary-gate.py:5113-5141` 只走采集机制，所以接上 B 就能跑。

### 2.4 评估过但不采用的方案

- **LD_PRELOAD**：实测漏掉 Bun 的裸 syscall，上面已说明。
- **seccomp-unotify**：拿不到原调用的返回值，除非让监督进程代替产品执行写入，这会破坏"原调用只执行一次、由产品自己执行"。
- **Syscall User Dispatch**：每个 syscall 都要进 SIGSYS 处理函数，还要在信号处理函数里处理 clone/vfork，与 JSC 的信号交互风险太高。
- **eBPF**：需要特权，payload 大小受限。
- **strace**：外部二进制无法 pin，而且要解析文本、会截断。

---

## 3. 自测

**新增 `scripts/test-native-terminal-journal-linux.py`**：对照 `scripts/test-native-terminal-journal.py:183-873` 的全部用例，另加：
- 内联汇编 `syscall` 的写入、libc 写入、`preadv2(RWF_NOWAIT)` 读取都能被采集；
- 用 bun 1.3.14 和 1.4.2 跑 `--version`，加上 `env -i` 下跑 built-claude，覆盖率为 100%；
- SA_RESTART 被打断时只产生一条记录；不带 SA_RESTART 时产生一条 EINTR 记录。

**Linux 负向用例**：
- 消费者饥饿 → 丢失、校验失败，但原写入不受阻；
- payload 截断；
- foreign pid / 外来 header；
- 多线程写入、调用区间重叠；
- 子孙进程写主端点 → 计入 foreign；子孙写管道 → 忽略；
- 用 sendfile/splice/io_uring 写端点 → 计入 unsupported；
- exec 的不是登记的二进制；
- 中途 kill 追踪器 → 产品被 SIGKILL，没有关闭边界；
- 模拟 ptrace EPERM → prepare 阶段直接抛错；
- 用 Darwin 方法名配 Linux 魔数（或反过来）→ 拒绝。

**新增 `scripts/test-linux-sandbox-exec.py`**：
- 逐项尝试逃逸：写 run 外、写 `/tmp`、在 socketRoot 外 bind、连外网、连宿主 loopback、DNS、读 `~/.claude`/`.env`/`/etc/claude-code`、执行 secret-tool、abstract socket、setuid 提权（被 no_new_privs 阻止）。
- 正向：沙箱内外 uid 一致；外部 tmux client 通过路径 socket 连到沙箱内的 server；只有转发的那个 provider 端口可达。
- 模拟 Landlock ABI 不足、unshare 返回 EPERM → fail closed。

**调整现有测试**：
- `scripts/mods-test-lab.test.mjs`：linux argv/policy 快照；非 darwin、非 linux 平台仍然抛 "no unisolated fallback"。
- `scripts/builtin-terminal-evidence.test.mjs`、`scripts/builtin-native-launch.test.mjs`、`scripts/builtin-native-launch.integration.test.mjs`：Linux 产物、平台错误信息。
- `scripts/native-driver-clock.test.mjs:31-32`、`scripts/test-native-driver-clock.py:42`：错误信息按平台断言。
- `scripts/native-normal-root.test.mjs`、`scripts/native-frame-journal-replay.test.mjs`：Linux fixture 和平台混用负例。
- `test-release-driver.py`：Linux 下 builtin_mods / process-spawn 的 mock 路径。

---

## 4. 工作量、风险和建议顺序

| 步骤 | 内容 | 工作量 | 风险 |
|---|---|---|---|
| 0 | 产品 `:31` 改动 + 重建（需要你决策） | 0.5 天 | 发布流程 |
| 1 | linux-sandbox-exec + 自检 + process-spawn 接入 → **mods-process-spawn 通过** | 3–4 天 | 中：宿主是否允许 userns、tmux 的 uid 校验 |
| 2 | Linux 追踪器 + `observer.so` + 不依赖产品的单元测试 | 6–9 天 | 高：group-stop、信号重注入、vfork/exec、线程退出竞态、性能 |
| 3 | broker/capture/时钟/校验器平台分支 → **terminal-interaction**，再 **canonical-diff** | 3–4 天 | 中：校验器重复多，必须杜绝平台混用 |
| 4 | builtin-mods = 1 + 3 + provider 桥接 | 2–3 天 | 中：DNS/连接错误文案与 macOS 不同 |

合计约 15–20 人日。

**确实做不到逐字等价的地方（处理方式：如实记录，不能满足就 fail closed，绝不判为通过）**：

1. **ptrace 会让产品线程停下等追踪器处理**，所以 Darwin 那种"观察器从不阻塞生产者"的性质做不到。
   - 消费者那一侧仍然不 ACK：环满就计丢失。
   - 记录 `observerBlocksProducer:true`；`productTimingEquivalent` 本来就是 false。
   - 如果哪条断言要求"不暂停产品"，Linux 上只能 fail closed。
2. **macOS 专有对象没有逐字对应**：`securityd`、`/usr/bin/security`、Keychains 只能用 D-Bus/keyring/secret-tool 类比；错误码也不同（隐藏的读得到 ENOENT 而不是 EPERM；网络失败表现为 DNS 失败而不是 connect EPERM）。
3. **v1 不逐字节采集** io_uring、sendfile、splice 写到端点的输出，遇到即 fail closed。
4. **宿主条件不满足就 fail closed**：没有非特权 userns、Landlock < 3、ptrace 被禁止。
5. **retained 模式不在本次范围内**：S7/G5（`run-binary-gate.py:12226`、`:12623`）仍然只支持 macOS，之后可以复用同一个沙箱辅助程序。

---

### 实现关键文件
- `/home/user/claude-code/scripts/builtin-terminal-evidence.mjs`
- `/home/user/claude-code/scripts/terminal-evidence-broker-native.py`
- `/home/user/claude-code/scripts/native-terminal-journal.py`（另新增 `/home/user/claude-code/scripts/native-terminal-journal-linux.c`）
- `/home/user/claude-code/scripts/mods-test-lab.mjs`（另新增 `/home/user/claude-code/scripts/linux-sandbox-exec.py`）
- `/home/user/claude-code/scripts/validate-mods-process-spawn.py`
- `/home/user/claude-code/.claude/skills/release-validation/scripts/run-binary-gate.py`
- `/home/user/claude-code/src/ink/nativeTerminalJournal.ts`