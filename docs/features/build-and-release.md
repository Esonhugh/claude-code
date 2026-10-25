# 构建、发布与终端验收工具

> 英文名：`build-and-release` · 领域：开发与发布 · [返回功能索引](README.md)

## 这是什么

这一页写给想改代码或自己出包的人。普通使用者装好发布版即可，不需要看。

## 快速上手：从源码构建并运行

**1. 安装依赖**（项目统一用 bun，不要用 npm）：

```bash
bun install
```

**2. 构建当前平台的 binary：**

```bash
make build
```

它执行 `CLAUDE_CODE_VERSION=$(VERSION) bun package:binary`，最后把产物移到仓库根目录的 `./built-claude`。版本号取自 `Makefile` 里的 `VERSION`：

```text
$ ./built-claude --version
2.1.294 (Claude Code)
```

产物是编译成 bytecode 的单文件，启动很快（`--version` 约 65 ms）；ripgrep 打包在里面，运行时自动解出。

**3. 本地试用：**

```bash
make test        # 等于 ./built-claude --dangerously-skip-permissions
```

`--dangerously-skip-permissions` 会跳过所有权限确认，只在你信任的目录里用。

## 和官方版本对照

很多功能要求和官方行为一致。下载同版本的官方 CLI 放在仓库根目录：

```bash
make download-claude CLAUDE_VERSION=2.1.303    # 产出 ./official-claude（已加入 .gitignore）
./official-claude --dangerously-skip-permissions
```

对照交互行为时，两边都放进 tmux，用脚本 `tmux send-keys` 输入、`tmux capture-pane` 截取画面再比较，不要凭手感。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `make build` | 构建 `./built-claude` |
| `bun run build` | 只构建 `dist/cli.js`（不打包 binary） |
| `make linux-baseline` | 构建兼容老 CPU 的 Linux x64 baseline 版本 |
| `make test` | 运行本地构建 |
| `make download-claude` | 下载官方 CLI 做对照（`CLAUDE_VERSION=` 指定版本） |
| `make release-check` | 发布前检查：版本号、CHANGELOG、类型检查、lint、构建产物能跑 `--version` / `--help` |
| `bun test <文件>` | 跑单个测试文件 |

`CHANGELOG.md` 会被打进 binary，改了它要重新构建。

## 发布流程

推送 `v*` 标签（或在 Actions 里手动运行「Release binaries」并填标签）会触发 `.github/workflows/release.yml`：

1. 校验标签和版本号；
2. 跑 `make release-check` 等源码检查；
3. 在各平台构建 binary（含 Linux baseline 和 musl 版本），逐个验证 `--version`、`--help` 和内置 ripgrep；
4. 上传到 GitHub Release，生成 `SHA256SUMS.txt`；
5. 通过 npm trusted publishing 发布：npm 上只分发 launcher 和各平台 binary 包。

## 说明

下面的「详细说明」保留了 Mods 终端验收和原生输出采集工具的原始记录，面向做兼容性验收的开发者。

## 详细说明

以下内容自原 README 迁入，保持原文。

### Mods 终端观测与验收边界

终端 Pane 的观测读取已提交的 Ink DOM，记录插件/pane、activation、lease、drawing、实际焦点、控件注册及几何；host 发布新状态不能替旧帧更换身份。关闭、隐藏、缩放和重开需要分别核对。官方 diff 的 `base` 是一个合法的 plain 空 Button：它可进入焦点环，没有像素面积；仅该明确登记的类别允许 `rect=null`，仍必须有正确的实际 plugin/key 焦点，缺失控件不能通过。上述身份是内部验收信息，不是作者 API。

相关回归可离线执行：

```bash
bun test --no-env-file ./src/components/ModsPane.evidence.test.tsx ./src/ink/terminalEvidence.viewport.test.ts
```

整体验收继续保留失败。固定官方 2.1.292 的第十七轮矩阵完成 29 项，27 通过、2 失败；diff 的 Tab、文件切换、关闭/重开业务链完成，但启动帧跨 resize epoch，且同步 ACK 采集仍不具备产品时序等价性。新异步 journal 的纯字节校验也必须拒绝未知前缀/尾部、归属歧义和不完整收尾；Bun 原生 console 的遗漏已由真实 CLI 检查检出，尚未补齐。不能用成功片段、较新的帧或候选构建替代完整通过。实现、身份和后续必验项见[终端验收有效性](../../docs/research/mods-terminal-evidence-validity-20261008.md)。作者契约见 [Anthropic Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)。

新增 DOM 测试从设置采集环境开始覆盖整个生命周期；setup、unmount、dispose 失败均尝试全部清理并恢复环境，多个错误一起保留。失败注入回归与真实 Ink 成功路径独立检查，不把异常清理成功当作终端时序通过。

本批干净源码真实入口的第十八轮结果为22通过、7失败（29项完整执行），包含首次Tab未前进及终端采集未完整收尾；它与含其他工作区变更的第十七轮是不同构建。实现提交不等于功能或发布验收通过，后续仍须补齐对应功能和证据。


### 原生输出采集有效性

Darwin 可用 `scripts/capture-native-terminal-writes.py --evidence-root <新目录> --executable ./built-claude --mode pty -- --version` 独立采集原 syscall 与 PTY 字节、EOF 和退出。脚本自动编译自身观测库，使用私有配置，无 writer ACK；记录真实别名 fd、原返回值及 errno，缺片/丢包/超限/缺少封口均失败。协议与清理回归、pipe 模式、已验证范围及尚未覆盖的逐帧/时序限制见[原生采集记录](../../docs/research/mods-native-write-capture-validity-20261008.md)。此启动检查不代表完整 UI/diff 或发布通过。


显式 nested Agent：当子 Agent 的过滤后工具池包含 `Agent` 时，`tools: Agent(child)` 正常解析为可调用工具；缺席或被禁止时只保留类型限制元数据，权限和深度检查继续生效。配置示例、固定292代码边界和同轮真实入口要求见[嵌套工具准入](../../docs/research/mods-nested-agent-availability-20261008.md)。完整 Mods/UI 与最新版 native 验收仍在进行。

内置 Mods 验收驱动自动归档证据：识别并记录本轮 FIFO/socket，核对源与副本 manifest，保留原报告及独立路径映射报告。归档失败、缺 producer EOF/reap，或删除前源/副本与原快照失配或出现新增/替换特殊端点时保留源缓存，`builtin-mods-checks.json` 的 `retained_cache` 指明路径并保持失败。回归命令、收据位置与未闭合边界见[归档有效性](../../docs/research/mods-builtin-evidence-archive-20261008.md)。文件复制成功不替代原生退出、逐帧或业务验收。


### 终端采集的退出与清理回执

`python3 scripts/test-terminal-evidence-broker.py` 验证真实 PTY 的启动、输入/resize、退出和故障清理。broker 只以实际 PTY EOF 与 waitpid 记录退出；清理错误和异常停止保持失败，资源清理后的终态 seal 防止迟到信号改写回执分类，原件删除还要求正常完成且无错误。采集命令、回执字段、有效/无效测试处置与完整验收边界见[broker 生命周期记录](../../docs/research/mods-broker-lifecycle-validity-20261008.md)。完整 Mods/UI、时序与最新版 native 验收继续进行。

`make release-check` 会运行 `bun ./scripts/check-readme-test-paths.mjs`，确认 README 引用的测试文件实际存在于当前 checkout。该检查只验证命令入口可用，不替代测试执行、官方双端、物理帧或完整发布门禁。


原生 shared-slot 采集器的局部回归（macOS、现有 Xcode clang 和 Bun；只使用私有目录及 dummy 配置）可在一次新构建后运行：`JOURNAL_TEST_BINARY=/absolute/path/to/fresh/built-claude python3 scripts/test-native-terminal-journal.py`。脚本不会自行构建、安装依赖或读取共享认证，证据保存在其输出的 `/private/tmp/cc-journal-*`。当前 37 项用例覆盖真实 CLI `--version`、原 write/writev/NOCANCEL、完整 5000 字节、实际 partial/EFAULT、不可变记录、队列饥饿拒收、两采集器独占、4 槽循环采集 44 条记录、受控异常与初始化回收、单实例线程 ownership、领取前 registration/PID 绑定，以及 signed dev_t 的准确 native identity 表示。此处“局部回归通过”只证明 native collector；完整 geometry/termios 历史、OS input/owner 和正常 diff lifecycle 仍未闭合。

实际 Ink 帧连接可在新构建后单独运行：`JOURNAL_TEST_BINARY=/absolute/path/to/fresh/built-claude python3 scripts/test-native-frame-journal.py`（macOS、既有 Bun/clang/tmux）。它用私有 HOME、配置、socket、PTY 和 dummy key 从真实 CLI 启动并输入 `/exit`，按原生 syscall prefix 关联 immutable logical frame，再独立回放；每次回放先重新校验原始 packets/raw/registration/PID 与本轮身份，篡改派生 output/cells 不会通过。包含实际 tmux 启动后 client Timeout 的 owned cleanup 回归。证据目录随输出提供；默认完整 driver 的 no-ACK、resize/termios、input owner、diff reopen 和官方完整比较仍未通过，不能作为发布或全部 Mods 兼容结论。详情见[原生帧连接与拒收规则](../../docs/research/mods-native-frame-journal-validity-20261008.md)。

默认 terminal capture 的 `prepare` 现在预编译并绑定 Darwin observer，最终 native exec 由同一个 broker 接入 shared-slot backend。运行时不写 raw/frame 证据文件、不等待 frame ACK；64 MiB 内存上限溢出会使采集失败，PTY 仍继续转发。退出后保存原生 packet/raw prefix 与实际清理结果，预存证据文件不会被登记或覆盖。上述帧测试也运行实际默认 prepare/install、launcher、CLI `/exit` 和 seal，以及启动故障清理；`BROKER_TEST_EVIDENCE_DIR=/absolute/path/to/new/evidence python3 scripts/test-terminal-evidence-broker-native.py` 检查内存溢出、预存文件保护和缺失 enrollment 的拒收。完整 seal 明确列出尚缺的 termios/resize 历史、OS input/owner 和时序证明，局部回放通过不提升为完整验收通过。见[默认无 ACK 采集记录](../../docs/research/mods-default-native-broker-validity-20261008.md)。

native replay 要求默认 backend 的独立身份及完整 IO 初始几何收据。resize 必须另有实际 `TIOCSWINSZ` 的 Mach-clock 括号、内核前后尺寸、PID/nonce/timebase 与正常生命周期绑定；没有括号或与布局/输出重叠时拒收，不能凭 broker raw read offset 推断顺序。独立 xterm 按原 syscall prefix 应用 resize，在 `native-frame-end-v1` 比较每帧；随后同步发布的 immutable snapshot 不改变该比较点。帧测试还覆盖精确 uint64 字符串、拒收篡改和默认入口故障清理。运行方法仍是上述新构建后的 `test-native-frame-journal.py`；详情见[resize 时序验收](../../docs/research/mods-native-resize-bracket-validity-20261008.md)和[历史固定几何边界](../../docs/research/mods-fixed-geometry-acceptance-validity-20261008.md)。这只覆盖 owned broker 实际执行的 resize；child-side geometry、termios、OS input ownership、时序等价及完整发布门禁仍未通过。

默认 native IO 另由 owned broker 的关闭收据固定原始JSONL摘要、记录数量、最终geometry identity及raw字节数；expected独立保留该收据，回放要求每个output区间连续覆盖全部raw，其他事件offset不跳动。截断、重新编号或同时改写IO和普通cleanup仍会拒收；这项完整性绑定不代表native resize时序或OS input ownership已得到证明。

默认 native broker 另在退出前独占写入 producer-expected-native.json，摘要来自其内存原件及实际PID/初始几何。第一次 seal 只读该producer expectation并核对prepare身份；缺失、预存、发布失败均不能通过，不会从当前IO或cleanup重算。真实入口负例在首次seal前删input、重编号并更新两份cleanup，保持producer expectation不变，仍被拒收。若prepare identity、producer expectation及所有原件都同时被替换，仍需外层可信封存；这里没有加密认证或完整native时序证明。

原生采集另记录真实 `tcsetattr` 的 Mach-clock entry/return、原始 retval/errno及内核 before/requested/after flags、speed、control chars。write重放、frame与resize prefix按已观测 mode 顺序使用实际 output flags；mode/write重叠、未知输出转换或证据缺失拒收。可继续用上述新构建后的两项 Python 脚本串行运行，包含关闭/恢复 OPOST、ECHO、失败 action和观测溢出的回归。此处只覆盖实际捕获的 tcsetattr 调用，直接 mode ioctl、完整 termios lifetime、OS input owner和时序等价仍未通过。见[终端模式观测与回归](../../docs/research/mods-native-termios-observation-validity-20261008.md)。

首封还要求producer的 `nativeClose` 内容回执：从采集器内存固定raw三alias、完整records（含mode与snapshot）、header、registration及initial的字节数/SHA256与record count。verifier先核对原件并从同一份已校验bytes解码；缺失内容回执、等长耦合改写或缩水schema拒收，sealer最终manifest也必须匹配。新构建后可串行运行上述帧脚本，其中包含实际default CLI首封负例；详情及单项命令见[内容来源闭包](../../docs/research/mods-native-payload-closure-validity-20261008.md)。这未改变完整native/Mods尚未通过的结论。

outer seal 在真实独立重放之后生成最终manifest时，也重新比较IO清单SHA与producer的 `ioClose.sha256`；`nativeContentMatched` 和 `nativeIOMatched` 均须为true才能取得bounded通过。帧脚本另覆盖重放成功后、终态摘要前删input/重编号的真实副本负例，避免沿用旧physical passed掩盖IO变动；完整native与发布结论仍独立。

默认原生 broker 现异步发布运行中的完整帧与 IO JSONL 前缀；关闭时重新绑定 held copies、实际文件身份和最终 closed 原件。可用 `PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-native-live-prefix.py` 跑协议/写入器回归，再按上述新构建命令运行完整 frame-journal 文件，含 child alive 与正常退出后 exact prefix 检查。Native40 完整30项27通过3失败；旧 FIFO schema 的 canonical/resize/退出关联、输入 owner 和时序证明仍未闭合，完整发布继续失败。使用方法、失败处置和同轮身份见[实时前缀验收](../../docs/research/mods-native-live-prefix-validity-20261009.md)。


原生验收按backend绑定本轮关闭原件，严格拒收错误JSON类型、FIFO/链接及不完整diff子测试；正常EOF/reap与bounded replay不提升为完整通过。新增guard可用`PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-native-acceptance-contracts.py`运行，实际CLI仍需上述fresh build与完整frame-journal命令。Native41 完整默认动态矩阵及原有七项追加目标共30项：27通过、3失败。完整发布继续失败；失败分类、固定子测试及独占收据用法见[原生身份验收处置](../../docs/research/mods-native-identity-validity-20261009.md)。CHANGELOG参与二进制构建，更新后必须重新生成产物。


原生证据writer按已排队prefix批处理并保留未完成snapshot；producer关闭和外层collector EOF分阶段严格检查，2秒关闭预算与64MiB上限保持。协议及退出guard运行方法、受控积压probe的IO缺失边界与后续完整门禁见[发布积压与关闭验收](../../docs/research/mods-native-publication-close-validity-20261009.md)。正常producer退出不替代完整采集或产品时序通过。


Native43完整30项仍为27通过、3失败；canonical和interaction实际normal_native_exit均true，interaction保存全部90帧/122项IO并正常关闭。完整CLI/frame文件14通过、1失败：真实resize后零输出快照仍为旧尺寸；此RED继续保留，未完成geometry handoff与完整发布。证据与首次分歧见[发布积压与关闭验收](../../docs/research/mods-native-publication-close-validity-20261009.md)。

canonical 验收新增 native span、动作窗口与 Mach geometry 关联；零输出观察只可引用同 root/几何的实际输出帧，不能补造 FIFO ACK 或证明 child input owner。回归入口：`PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-native-canonical-binding.py`，随后仍须上述 fresh build、完整 CLI/frame 文件和默认完整矩阵。实现、拒收条件及历史重算边界见[原生 canonical 绑定](../../docs/research/mods-native-canonical-binding-validity-20261009.md)。旧 resize RED 和完整发布失败继续保留。

原生 canonical 验收认证已经记录的 frame identity，并保持完整 checkpoint/action/IO/geometry 校验；输入原件使用 exclusive/no-follow 0600 创建。历史门禁和未覆盖边界见 [原生 canonical 绑定验收](../../docs/research/mods-native-canonical-binding-validity-20261009.md)，现场检查点通过不替代最终完整门禁。

原生终端报告保留独立backend，区分帧事务输出与连续replay段，并将原resize请求、真实内核ACK与后续正确尺寸的实际绘制帧一一对应。回归入口为 `scripts/test-native-report-consumers.py` 和 `scripts/native-frame-journal-replay.test.mjs`；使用方法与仍未闭合的完整门禁见[原生报告消费契约](../../docs/research/mods-native-report-contract-validity-20261009.md)。

`--debug-file /absolute/path/mods-debug.log` 可记录 `[ModsProcess]` 的实际启动、停止、终止和close。日志绑定宿主生成的operationId、owner、PID、参数摘要、预算与单调耗时，以及实际读取/保留字节、摘要和截断标志；不打印argv、stdin、env或输出内容。首次TERM与2000ms宽限后身份复验的KILL分开记录；group失败仍尝试独立PID，逐目标失败记录errno。初次ps不可用、后次恢复也允许真实仍存活的owned child handle回退；已捕获身份冲突及后代查询失败不能声称清理完成；日志保留实际查询exitCode与未闭合PID，缺行须以真实ESRCH确认退出。见[process.run生命周期与取消契约](../../docs/research/mods-process-run-lifecycle-validity-20261009.md)。

原生终端验证的 `seal` 与 `verify --bounded` 仅结算闭合身份/物理证据；默认 `verify` 和发布门禁仍要求完整覆盖。后端文件清单、资源关闭及未覆盖条件见[验收结算说明](../../docs/research/mods-native-capture-scope-validity-20261009.md)。

归档后的 builtin recheck 使用同次运行的 `builtin-cache-archive.json` 将原始 producer run 映射到 `acceptance-cache`，同时核对原始 `capture-launch.json` 的摘要。不会改写启动记录；源、归档目录、完成标志或原件摘要不符均拒收。独立重放可用 `bun scripts/recheck-builtin-terminal-evidence.mjs ACCEPTANCE_REMAPPED.json BINARY_SHA256 OUTPUT.json ARCHIVE_RECEIPT.json`，其通过只代表所声明的证据范围；完整门禁另外对照 parent 在归档完成时固定的收据摘要，拒收启动原件与收据同时改写。


#### Builtin 原生普通屏幕与归档回放

`run-builtin` 的 native broker 在现有 sandbox 内执行，启动前保存 tmux 物理状态、空白屏幕和未完成 parser 输入。当前起点证明限定新建私有 pane：Darwin 固定 tmux **3.6b**，Linux 记录并核对实际报告的 tmux 版本；未知平台、无法识别的版本、非初始模式或残留输入会拒收。普通屏幕按真实输出前缀取得物理 marker，再检查相对光标、宽字符、样式和缩短后的尾行。

```sh
make build
BUILTIN_NATIVE_TEST_BINARY="$PWD/built-claude" bun test --no-env-file ./scripts/builtin-native-launch.integration.test.mjs
bun test --no-env-file ./scripts/native-normal-root.test.mjs
python3 scripts/test-owned-evidence-copy.py
```

编译入口测试使用私有 tmux/socket/config，等待真实 prompt 后正常 `/exit`，随后在原 cache 路径暂不可用时重验归档，并保留所有原件。未设置 `BUILTIN_NATIVE_TEST_BINARY` 时该入口测试会跳过，不能计为通过。APFS 副本仅改变存储分配，逻辑字节、SHA 和原断言保持一致；其他平台使用普通复制。`boundedVerdict` 仅表示已覆盖的关闭和物理帧证据，`fullNativeGatePassed`、输入归属与产品时序不会由此升级。详见[实际失败、修复和边界](../../docs/research/mods-builtin-native-normal-root-validity-20261009.md)。

原生 child 读取证明保留所有字节，包括插入命令之间的 tmux 应答；只有原始输出 parser 已识别对应查询时才分类协议响应，随后严格核对完整预期输入。未读入、删改、额外或无查询的控制字节仍拒收，应用 tokenizer/owner 另外验收。
