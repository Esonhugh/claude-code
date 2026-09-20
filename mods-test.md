# Mods 收口测试方案与验收记录

第 1–7 节保留首轮修复及验收历史；后续输入链、Workflow 和 SSH 长路径修复见第 8 节；Mods UI/UX 修复与限定验收见第 9 节；可复用测试 Mod 与官方原件调试见第 10 节；输入、Pane reopen 与 builtin 让位修复见第 11 节。历史失败不会由后续成功覆盖。

## 1. 范围和判定规则

本轮只修复三个已确认问题，不扩展 Mods API、不重构 PTY、不修改依赖、CI、版本或发布制品：

1. `updateHooksConfigSnapshot()` 清除 accepted cache 后读取外部候选，绕过 ConfigChange 审核。
2. 非法 remote managed 磁盘缓存虽产生 schema error，仍抢占合法 managed 层。
3. Mods Pane 拥有 Escape 时，PromptInput legacy handler 仍记录双击，误开 Rewind。

完整测试是对当前声明能力进行多层验证，不等于所有官方 API、全部平台或所有组合 full-covered。

| 状态 | 判定 |
| --- | --- |
| qualified / passed | 前置条件、执行身份、行为断言、终态及清理证据均满足 |
| failed | 有已执行且不满足预期的产品或测试断言；不得用另一轮成功覆盖 |
| not covered | 功能前置条件或操作未送达，没有可判定的完整执行 |
| environment-blocked | 所需环境能力不可安全取得；记录限制，不伪造条件凑绿 |

三个已确认问题必须具有红→绿及新制品相关证据。新的未解释本地失败、构建失败阻止推送；官方自然 gate、未测试平台等限制可明确保留，但不得宣传为完整兼容。

## 2. 基线、身份与证据

- 起点：`feat/mods@a46ed1a38d83372938345427f3a9424a8cb3ce6c`。
- 基线 tracked 文件 2727 个；两份既有 `docs/design/cross-session-messaging*.md` untracked 草稿不修改、不暂存。
- 本轮证据根：`/private/tmp/mods-closure-20260918-dbe9mry_/`，基线见 `baseline.json`。
- 旧严格复测：`/private/tmp/mods-retest-20260918-lo2i17la/`。历史失败保留，不拼接或复制旧通过结果充当新执行。
- 真实发布基准：`/private/tmp/esonhugh-context-20260918-jkX1LF/`，记录真实 `@esonhugh/claude-code@2.1.219` wrapper、darwin-arm64 binary、包 integrity 和上下文轨迹。
- 官方原件固定 commit：`f96c3b49c4c8721685206aaab23609b2d399df4e`；目标类型来自官方 2.1.272 完整声明。原件、类型、raw 日志均保留在仓库外，不 vendor 或上传。

每轮记录 Git commit、参与构建的实际文件内容 hash、binary SHA-256/size/version、精确 argv 和隔离环境。源码内容身份不绑定 Git HEAD/index 元数据、证据目录或绝对路径。`src/utils/releaseNotes.ts:2` 实际内嵌根 `CHANGELOG.md`，因此最终回填 CHANGELOG 后必须重新构建及 smoke，不能沿用验收前制品 hash；新 hash 记录在不参与该内嵌链的本文件和 handoff 中，避免制品身份自引用。

## 3. 三项红→绿回归

### 3.1 Hooks snapshot 与审核

测试入口：`src/utils/settings/changeDetector.test.ts`、`src/utils/hooks.sourceScope.test.ts`。

- 初始化 accepted settings，外部写入不同候选。
- watcher 审核前调用 snapshot update，effective settings/hook snapshot 仍为旧值。
- ConfigChange 必须实际发生；block 保留旧值，allow 后候选才可见。
- 显式 refresh、重复候选、接受后 publication 与 source provenance 不回归。
- startup/退出 worktree 的可信 cwd 转换显式 reset 后刷新，不依赖普通 snapshot 的隐式读盘；不为测试创建真实 Git worktree。

### 3.2 Remote managed 磁盘缓存

测试入口：`src/services/mods/hostOperations.test.ts` 的隔离 managed harness。

- 从 synthetic `remote-settings.json` 真实磁盘入口读取，不能只 mock HTTP fetch。
- 合法 remote 控制组继续按 managed precedence 生效。
- 非法 `{model: 42}` 整层不参与合并；合法 MDM/file/HKCU 自然接替。
- merged settings、per-source view 与 origin 一致；schema error 仍可诊断。
- 修复缓存后恢复有效 remote；mode-only merge/first-wins 和 headless 启动不回归。
- 不向 `syncCacheState.ts` 引入 schema/validation 重依赖，不新增生产 ForTesting export。

### 3.3 Escape 所有权

测试入口：真实 PromptInput/Ink harness `src/components/tasks/BackgroundTasksDialog.test.ts`，相邻 `src/components/ModsPane.test.tsx`。

- Pane focus 投影为 overlay ownership 时连续 Escape 不触发 Rewind、不武装 composer 双击状态。
- ownership 释放后，新第一下 Escape 不打开，新第二下只打开一次。
- 保留既有全屏 dialog guard、双击窗口与正常 footer/Agent 导航，不加 sleep 或弱化断言。
- 新 binary 使用完整官方 diff 原件实际执行详情→列表→关闭，并单独验证正常双 Escape。

## 4. 自动化、静态与构建

### 4.1 执行顺序

1. 最小失败测试先记录红，生产修复后记录绿及相邻回归。
2. 定向测试、TypeScript、lint、changelog、diff 检查后，按功能正常签名提交三修复和初始文档。
3. 冻结该代码提交，从当次 tracked 文件生成测试 inventory。
4. 逐文件独立 OS 进程完整执行；再使用显式清单运行同进程 `bun test --isolate --no-orphans`。
5. 运行 `make release-check`，再 `make build`，记录新制品身份。
6. 使用该新制品执行第 5 节 scripted tmux 矩阵。
7. 更新本文件、CHANGELOG 和 handoff，签名提交结果文档；检查构建输入影响后普通推送 `origin/feat/mods`，核验远端 SHA。

### 4.2 命令与清单

以下是测试入口；正式完整运行的精确 argv、preload、环境和每项退出码以本轮证据中的 runner/manifest 为准：

```bash
bun test src/utils/settings/changeDetector.test.ts
bun test src/utils/hooks.sourceScope.test.ts
bun test src/services/mods/hostOperations.test.ts
bun test src/components/tasks/BackgroundTasksDialog.test.ts src/components/ModsPane.test.tsx
bun test src/services/mods
make release-check
make build
./built-claude --version
```

- 全量 inventory 从 `git ls-files` 生成，不使用裸 `bun test` 的自动发现作为资格门禁：ignored `dist/codex` 包含其他测试引擎的测试，生产 `src/ink/hit-test.ts` 也会被 Bun 文件名规则误匹配；记录排除及理由。
- registered tests、顶层 assertion scripts 和 child-process 结果分别计数。顶层脚本 exit 0 还要有 awaited import/完成 sentinel，不将未等待 Promise 当作通过。
- 保留 Workflow plan-mode preload、既有 isolation/mock 前置条件；`--isolate` 不代替独立 OS 进程，独立运行的成功不能覆盖同进程失败。
- 配置 `CLAUDE_CODE_OFFICIAL_MOD_TYPES` 与 `CLAUDE_CODE_OFFICIAL_MODS_FIXTURE` 为核验过的真实原件绝对路径。缺少类型时的 skip 必须单列，不能描述成契约已验证。
- `make release-check` 检查版本约束、changelog 格式与测试、TypeScript、lint、missing imports/assets 和 diff；只用现有 Bun/依赖，不安装或更新包。
- 适用 LCOV 按本轮实际输入重算；父进程覆盖率不包含 Worker/VM/child/compiled，不代表功能完整性。

### 4.3 既有失败的处理

- Peer：上一轮 sandbox 阻止 `/bin/ps` 取得进程启动身份。仅在保留秘密、写入与网络隔离前提下允许必要只读 process-info；不能伪造 `procStart`。
- PTY：上一轮同进程 `bunPtyDriver.integration.test.ts` 出现 exit code `2 !== 130`，独立与有界复放未复现，根因未定。本轮仍纳入完整清单；若失败则保存原始证据并定向诊断，不加延时、skip 或放宽断言。

## 5. 新 binary 交互矩阵

专门 runtime agent 串行驱动隔离 tmux，每场保存 exact command、session/window/pane、ready/submitted/running/terminal captures、API/debug 及行为断言。鼠标成功不代替键盘送达；raw attempts 与 unique feature assertions 分别统计。

| 分组 | 必测行为与证据 |
| --- | --- |
| 初始化与输入 | session.start barrier；active→idle；初始化期间提交只消费一次；新草稿不丢失；正常退出 |
| 排队与 public turn | Enter/queueSubmit；turnId/wait；rewrite/context 一次；drain 不重跑 hook |
| settings | 两项本轮修复 probe；native watcher、显式 reload、disable/enable；ConfigChange block/allow 与 accepted snapshot |
| 生命周期 | 成功/失败 reload、在途旧 generation、unload、cancel、Worker 故障不重放已发生副作用 |
| 默认权限 | 真实 ask/allow/deny；不以 bypass 代替；区分 Mod host process 与模型 tool 权限 |
| 官方 diff 原件 inline | 打开、滚动、焦点、选择/base、编辑刷新、prompt hunks、快速双 Escape、正常双 Escape |
| 官方 diff 原件 fullscreen | 对应布局、键盘/鼠标、滚动与输入所有权；disable 后 builtin command 恢复；键盘 ask 有界重试 |
| 状态保持 | clear/resume 不重复 activation start、reload、store 持久化、非 Git 目录边界 |
| 受影响功能 | Agent、Workflow、后台任务终态通知 smoke |
| 官方 binary | 根 `official-claude` 2.1.272 的自然 gate readiness；关闭则 not covered，不 patch binary/伪造 rollout 或账户 |
| 请求上下文 | 新制品空 Mods 无规范化增量；定向 marker 不重复注入，不重跑无关完整 benchmark |
| 清理 | 正常退出；自建 API listener/子进程回收；自有 tmux socket/session 清理，保留 evidence |

`make test` 实际是 `./built-claude --dangerously-skip-permissions` 的本地交互入口，不是 Bun tests。权限场景单独使用 default mode；其他使用 bypass 的场景明确标注，不能据此证明审批正确。

## 6. 隔离与安全边界

- 每轮独立 HOME、CLAUDE_CONFIG_DIR、XDG、TMP、cwd；`env -i`/白名单环境、synthetic auth、仅 loopback fixture API，不读取真实凭据、Keychain、私有配置或调用真实外网模型。
- sandbox 禁止秘密读取、非目标写入和非 loopback 网络；Peer 的最小进程身份能力单独审计。保留 sandbox 探针，不用一句“已隔离”代替验证。
- 只清理本轮拥有的进程、端口、目录和 socket；不 reset/clean 用户工作区，不动根 official binary 或无关草稿。
- Mods 是可信代码扩展，Worker/VM 不是 OS sandbox。工具权限测试不推导为所有宿主 fs/process 能力都需模型审批。
- 不上传原件、raw 日志、配置、凭据；仓库只保存说明和测试代码。

## 7. 当前执行记录

以下路径相对本轮证据根。三项产品修复已分别正常签名提交为 `c006eeb`、`8de982f`、`0da3f73`；初始文档提交为 `be36848`。首轮完整自动化已执行，但不能将其记为全绿。

| 项目 | 已取得证据 / 当前状态 |
| --- | --- |
| Escape 最小回归 | 红 1 fail → 绿 1 pass；相邻 UI 25 pass / 0 fail；`ui-escape/summary.json`、`precommit/ui-review.json` |
| 两项 settings 修复 | snapshot 审核前读盘及 remote 抢占各自先红后绿；四个相邻文件 117 pass / 0 fail；`settings/summary.txt` |
| 提交前静态与文档 | TypeScript、lint、changelog check、changelog tests（5 pass）、diff check 与本地文档链接通过；`precommit/` |
| `be36848` 独立 OS 进程全清单 | 261 文件，260 qualified；1565 registered pass / 3 fail；106 个 assertion scripts 完成，0 timeout；失败均为 Peer 环境项；`automated/final/summary.json` |
| `be36848` 同进程全清单 | 完整结束、exit 1；raw footer 为 1565 pass / 4 fail / 1 error；JUnit 仅记录 3 个 Peer failures，额外顶层 SSH readiness 断言确实失败；`automated/tracked-final/`、`automated/main-review.json` |
| 首轮 Mods 子集 | 22 文件 qualified，559 pass / 0 fail / 0 skip；是全清单子集，不重复相加 |
| SSH 测试同步修复 | 精确 55 文件前缀红 79 pass / 1 fail / 1 error → 绿 79 pass / 0 fail；单文件修复后 20/20 完成；主线程定向、TypeScript、lint、diff 复核通过；签名提交 `ef1f440` |
| `ef1f440` 长 TMP 完整复验 | `automated-ssh-final/` 两种完整模式均为1564 pass / 4 fail；SSH readiness 已完成且无顶层 Unhandled，但长 TMP 又触发既有 SSH ControlPath 长度断言，另3项仍为Peer；独立259/261文件qualified、106脚本完成 |
| `ef1f440` 短 TMP 完整复验 | `automated-short-final/` 同进程1553 pass / 16 fail / 1 error，独立1553 pass / 15 fail、106脚本完成；15项Peer因runner缺少既有fixture目录授权而阻塞，同进程又复现SSH readiness。ControlPath与PTY通过，不代表长TMP问题已修复 |
| SSH `act` 修复 | 受控 Scheduler 证实 callback 已安装并执行，但旧刷新未提交默认优先级 state；awaited React `act` 后红→绿。保留原61项断言、增4项 callback 断言；55前缀79/0、独立20/20及两次完整清单均有SSH完成标记、无顶层Unhandled。主线程单文件与release-check通过；签名提交 `d9a28d1` |
| `act` 两次自然完整复验 | `ssh-readiness-final/` full-a为1565 pass / 3 Peer fail；full-b为1564 pass / 4 fail，新增Workflow `runCommand` 5000ms timeout。每轮105/105既有源码sentinel，另1脚本无标记；子进程6/0另计。Peer fixture权限已恢复、ControlPath与PTY通过；full-b失败不可由full-a覆盖 |
| 首轮 release-check / build | `be36848` 上均 exit 0，构建前后 tracked 内容无变化；`build/release-check.json`、`build/build.json` |
| 首轮 binary scripted tmux | 固定cutoff审计完成：49个result场景为27 passed / 17 failed / 5 not covered；另1场UI补验13条通过。合计50场、641 raw assertions，不等于641个独立功能；12组矩阵6 passed / 3 failed / 2 not covered / 1 environment-blocked，整体failed；`runtime/summary.json` |
| 结果文档提交与新 build | `6968ad7` 已正常签名提交当前结果；内嵌CHANGELOG后重新build通过，新SHA `3fa04adb…`。CLI除CHANGELOG模块外逐字节相同，Worker/native未变；限定新制品smoke已结束，3个有效场景通过，原harness失败与未覆盖项单列（见7.3） |
| push | blocked：diff交互失败、Workflow timeout尚未解决；没有推送、tag或release |

### 7.1 首轮失败与补验边界

- **Peer，environment-blocked：** 三项真实进程身份断言未通过。sandbox 拒绝执行 setuid `/bin/ps`；字节一致、移除 setuid 的私有副本又被 OS 终止，未取得可安全使用的替代路径。没有放开凭据/网络隔离、伪造 `procStart` 或弱化断言。证据 `precommit/peer-process-identity-probe.json`、`precommit/peer-nonsetuid-ps-probe.json`、`automated/diagnostics/process-identity-analysis.json`。
- **SSH，测试同步缺陷：** 首轮 `isReady=false` 是真实顶层失败，不是footer/JUnit计数噪音。初次 `ef1f440` 使用Ink `pause()/resume()`仍在后续完整批次重现。受控Scheduler随后确认callback已安装并执行，但默认优先级state未提交；`d9a28d1` 改为awaited React `act`并显式验证callbacks，原61断言保留、增4断言，清理和环境恢复在finally。两个自然261文件批次均观察到SSH完成标记、无顶层Unhandled；这不反推原未插桩失败一定是同一分支。原证据 `ssh-readiness/` 与 `ssh-readiness-final/` 均保留。
- **Workflow command-runner，新失败未定因：** `ssh-readiness-final/runs/full-b/raw.log:1877` 的 `runCommand.test.ts:6` 在5007.93ms达到5000ms testcase timeout，full-a同例23.25ms通过。不能用前一轮成功覆盖，不能未经证据归因为系统忙或SSH改动。有界诊断完成：单文件3次各3/3、相邻10文件30/30均通过，目标耗时12–15ms，未复现但根因仍未定；未再跑全仓、延长timeout或放宽断言。compatibility的21文件自baseline未变，full-a/full-b/当前2577个源码文件一致；诊断期间主线程提交文档的HEAD/index漂移另记，不误报整个仓库静止。证据`workflow-timeout-diagnosis/summary.json`、`hash-audit.json`、`cleanup.json`；自有进程和短TMP清理完成，原full-b仍failed、推送继续阻塞。
- **SSH ControlPath，既有长 TMP 限制未修复：** `automated-ssh-final/` 的长 evidence 路径被用作 TMPDIR，生成111/112字节的ControlPath，违反现有 `<104` 断言；同进程和独立完整批次均真实失败。有界对照128/105字节失败、98字节通过，说明触发条件为路径长度。生产和测试内容与本轮起始基线完全一致，未归因于Mods，也不扩展本轮SSH开发范围。新完整批次使用独立短TMP，不能据此宣称任意长TMP已支持。证据 `automated-ssh-final/ssh-controlpath-diagnosis.json`、`controlpath-main-review.json`。
- **同进程脚本资格：** 长TMP批次有105个静态完成sentinel；`nativeInstaller/download.test.ts` 没有独立完成标记，不能仅凭其无错误认定脚本全部异步工作结束。逐文件 awaited-import sentinel 完成，只证明独立批次，不反向覆盖同进程边界；见 `automated-ssh-final/raw-junit-audit.json`。
- **PTY，历史失败本轮未重现：** 首轮独立和同进程均通过，额外有界重放9 pass / 0 fail；长TMP新完整两模式也未复现，独立文件9/0。不将“未重现”称为根因已修复。

### 7.2 首轮构建与覆盖率身份

- 构建 commit：`be36848e600d41a2cb7da9cedec9f422d47504a7`；binary 为 `2.1.219 (Claude Code)`，100102754 bytes，SHA-256 `781fa13125c9cb2da9153c38ae260a662424cb002c50e4605d3944bf8179115a`，见 `build/artifact-lock.json`。
- 后续 `ef1f440` 仅改变 SSH 测试，未改变生产代码、构建脚本或内嵌 CHANGELOG；该测试不在 CLI source map 中，见 `build/ssh-test-content-continuity.json`。这允许继续使用锁定制品验收，不意味着最终 CHANGELOG 回填也不影响 binary。
- 首轮 53 份 LCOV 的父进程源码行并集为 60345/260451（23.17%）；Mods 为 5079/5813（87.37%），19 个已插桩生产文件。`protocol.ts`、`types.ts`、`worker.ts` 未出现于父 LCOV，Worker/VM/child/compiled 不在此覆盖率内。失败运行的执行行可贡献覆盖率，不能贡献通过资格；见 `automated/final/coverage-summary.json`。

### 7.3 结果文档后的制品身份

- 构建提交 `6968ad7276df549a4b012e6f787a5a070a220e0d`；sandbox内`make build` exit0，tracked bytes前后不变。`build-final/build.json`保留精确argv/environment。
- 新binary：`2.1.219 (Claude Code)`，100102754 bytes，SHA-256 `3fa04adbb474f9bbebc95581a2c8fa829f4f42e4e27313bc9f6a81f8c7aa7e6b`；身份锁 `build-final/artifact-lock.json`。
- 对比首轮生成的CLI，仅CHANGELOG模块变化；其余CLI逐字节相同、Worker逐字节相同、sourcemap source content仅`../CHANGELOG.md`变化，三个native assets hash未变。证据`build-final/input-continuity.json`。这证明输入延续，不把旧runtime重标为新binary执行。
- 新binary限定scripted tmux smoke已结束，证据为`runtime-final-smoke/summary.json`；`--version`与`--help`通过。三个有效场景共30条限定断言通过，均在独立隔离环境、loopback API和真实tmux中运行，正常`/exit`为0。它不是第5节全矩阵重验，也不重新执行或宣称修复已确认的diff交互缺陷。
- `d9a28d1`提交字节与两次`act`完整运行逐文件hash一致；运行实际在该提交之前，不更改原执行时间或称为提交后复验。证据`precommit/ssh-act-committed-identity.json`。

| 新制品限定场景 | 实际结果 |
| --- | --- |
| `basic-a3` | 8条通过：无plugin连续两轮文本请求，每轮一个主模型请求，响应后prompt恢复；正常退出 |
| `inline-a2` | 13条通过：完整官方diff原件775文件及运行副本hash一致，真实Read/Edit各1次；间隔269.48ms的Escape完成详情→列表→关闭且无Rewind，随后新一组正常双Escape打开一次Rewind；正常退出 |
| `context` | 9条通过：当前请求marker计数`0→1→0`，不把历史上下文当重复注入；正常退出 |

三次harness失败另行保留：`basic`为sandbox地址语法错误，`inline`为manifest路径错误，均未启动CLI；`basic-a2`误将工具专属`Stopped caffeinate`作为纯文本终态谓词，cleanup中的exit0不算合格正常退出。六次attempt的自有进程、listener和tmux socket清理均通过，见`runtime-final-smoke/cleanup-audit.json`；不以清理成功覆盖行为或harness失败。

新制品的no-plugin/empty-module规范化请求对照仍为**not covered**，marker通过不能证明空Mods零增量。该smoke总体记录为not covered；首轮完整交互矩阵仍failed，Workflow timeout根因仍未定，推送继续阻塞。未借此重跑官方binary自然gate或声明官方运行时parity。

smoke agent记录的`handoff.md`、`mods-test.md`内容漂移来自主线程并发回填报告；这是主线程补充说明，不改写agent的“未归因”原始记录，也不把“全仓bytes不变”断言改标通过。HEAD/index在该smoke期间未变，锁定binary及生产构建输入未变；最终只补这两份不内嵌报告，CHANGELOG保持构建时内容。

### 7.4 交互补验：已确认结果与限制

固定审计cutoff为2026-09-18 13:03:30 +08:00，汇总`runtime/summary.json`、限定功能`runtime/final-feature-ledger.json`。使用首轮锁定binary `781fa131…`，不冒充文档回填后的新制品。

| 第5节分组 | 判定与范围 |
| --- | --- |
| 初始化与输入 | passed：barrier、active→idle、提交一次、新草稿保留 |
| 排队与public turn | passed：Enter/queueSubmit、turnId/wait、rewrite/context一次、drain不重跑hook |
| settings | environment-blocked：watcher/reload/启停、ConfigChange block/allow通过；精确审核前snapshot竞态compiled未覆盖、remote非法缓存公开入口受阻 |
| 生命周期 | passed：成功/失败reload、在途generation、unload、cancel、受控Worker故障不重放副作用 |
| 默认权限 | passed：真实default ask/allow/deny及host process边界，不以bypass代替 |
| 官方diff原件inline | failed：部分方向键焦点/分页失败；Enter、长详情滚动、快速和正常Escape有独立通过 |
| 官方diff原件fullscreen | failed：keyboard ask/action和wheel失败；mouse row/edge buttons、disable/builtin ownership分别通过 |
| 状态保持 | passed：clear/resume不重activation、同进程reload store、非Git边界；不推导跨新OS进程store通过 |
| 受影响功能 | passed：限定foreground/background Agent终态通知、Workflow双agent聚合/详情/终态；首轮harness失败保留 |
| 官方binary | not covered：2.1.272自然gate关闭，readiness不等于Mods parity |
| 请求上下文 | not covered：定向marker一次通过，但首轮未量化空Mods规范化零增量 |
| 清理 | failed（含正常退出门禁）：资源50场全部回收；正常退出45 passed / 2 failed / 3 not covered，强制cleanup不补写正常退出 |

49个result目录的628条raw assertions为522 passed / 39 failed / 67 not covered；加独立UI的13条得到641条（535/39/67）。旧44场与晚到9场有4场重叠，不能重复累加。原失败全部保留，不宣称单一全局unique功能总数。只读核验1158个已记录PID、50个历史端口及自有socket均无匹配残留，未记录逸出进程不在确认范围。1604份固定输入hash未变；49场final hash为15 source+copy、7 copy-only、27未记录，0 mismatch但缺失不等于完整身份验证。成功退出错误声明需要timeout capture等证据schema问题单列于`runtime/final-integrity-ledger.json`，不改raw记录。

- **inline passed：** 实际选中项的 Enter、长详情 Down/Up 滚动、Escape 详情→列表→关闭；关闭没有误开 Rewind。证据 `runtime/closure-inline-kb-a3/assertions.json`。
- **inline failed：** Down 不移动文件焦点、不触发五文件分页；独立场景先以 Tab 选中第二个文件，再按 Up 仍停留第二项。证据 `runtime/closure-inline-kb-a3/`、`runtime/closure-inline-up-a4/`。Tab 可用不能覆盖方向键失败。
- **fullscreen passed：** 鼠标点击 file row 展示对应 body，点击 more below/above 推进和恢复列表；`open` 偏好经 reload 保留。证据 `runtime/closure-fullscreen-mouse-a2/`。这不是 base persistence 通过。
- **fullscreen failed：** 空 composer 下 keyboard body Down、文档列表快捷键、`Ctrl+x b` base cycle 未发生预期转换；body wheel Down 和独立非顶部 wheel Up 均不移动，列表 wheel Down 也未达到预期。证据 `runtime/closure-fullscreen-kb-a1/`、`runtime/closure-fullscreen-keys-a2/`、`runtime/closure-fullscreen-mouse-a2/`、`runtime/closure-fullscreen-wheelup-a3/`。旧空 composer 八次 Tab+Enter 无法触达 ask 的独立 finding 保留。
- **not covered：** 本次 Tab/BTab 探测前已有 history draft，不能把它当新合格 focus failure；未建立 keyboard dock 入口后的 row 选择、未成功 base transition 后的存储/持久化、起点不合格的反向滚动也不计通过。store仅有`open=true`不证明base存储有缺陷。fresh Git fixture 使用 unborn HEAD→cached 的官方支持路径，没有真实 HEAD/merge-base 和多个分离 hunk 的比较证据。最终资格校正见 `runtime/remaining-evidence-audit-20260918/unique-assertion-verdicts.json`。
- **命令/UI smoke passed：** `/rename`、`/color blue`、`/agents` 打开/退出、空闲 `/tasks` 打开/退出及正常 `/exit`，13条限定断言；`runtime/ui-4y9roesv/assertions.json`。这不代替活跃 Agent、Workflow 或任务终态通知的独立验收。
- **remote managed compiled 路径 environment-blocked：** loopback 自定义 API base 自然不满足 remote-managed eligibility，外部 macOS binary 的低层 managed file 又指向固定系统目录。未伪造内部账户、rollout 或第一方 hostname，未读写共享 policy；真实磁盘自动化红绿不能冒充编译制品公开入口已通过。证据 `runtime/remote-invalid-managed-public-entry-analysis.json`。

九个 diff 补验 raw attempts 全部保留，包括错误谓词、额外 reopen 后不合格段和未正常退出的尝试；未将它们重新标绿。其自有进程、API listener 和 tmux socket 已清理；命令/UI smoke 正常退出且单独清理。上述新失败仍阻止本轮整体通过与推送，不扩展为新的 Mods API 开发。

静态解释与运行事实分开：`src/components/ModsPane.tsx:746` 将 Up/Down 交给 pane scroll，`src/ink/components/Button.tsx:72` 仅处理 Enter/Space，`src/components/ModsPane.tsx:1034` 的 ModButton 未将 `action` 转为快捷键绑定；`src/components/ModsPane.tsx:775` 的 ScrollBox 接线未显示 wheel→Mods scroll 桥接。这些支持后续定位方向，但不把未插桩运行提升为每条事件链根因均已证实。本轮未修改这些生产路径。

### 保留的已完成上下文比较

真实发布的 `@esonhugh/claude-code@2.1.219` 与修复前本地 binary，在隔离同场景五轮对话中：默认首轮内容为 81984 / 74771 bytes，差 -7213 bytes（-8.80%），主要是 Plan 工具暴露和描述差异；统一 Read-only 后六次规范化请求完全相同。四场均正常退出且资源清理完成。

这不证明功能等价优化，也不是 Claude tokenizer、实际计费或进程 RSS 测量。发布版 binary SHA-256 为 `cda2d12bfe629d3ea3b145ca8b9cd22b4f20337e1e2685b6df28445c50d333b6`，该次本地 binary 为 `7c94b14562d53b40da61cc184f7db6161b7d514d2bfe2f33c9f0a6a48cce6576`。本轮新构建仅另做必要上下文 smoke，不将旧结果标为新制品通过。

## 8. 后续修复轮：输入链、Workflow 与 SSH 长路径

### 8.1 基线与范围

- 基线：`feat/mods@690ecbac3773c98a98664c94dfab26d57065ae44`，启动时 tracked 干净；两份既有 cross-session 草稿不修改、不暂存。
- 新证据根：`/private/tmp/mods-input-repair-20260918-rw73i3qa/`，`baseline.json` 保存逐文件内容身份；首轮 evidence 保留，不覆盖旧运行。
- 只处理已确认的 Mods 输入链与 SSH 长 TMP socket 问题，以及 Workflow 原超时的有界诊断和有证据支持的修复。不扩展 Mods API、不重构 PTY、不改依赖、CI 或版本。
- 定向修复、功能提交、完整自动化与构建已完成；两种完整模式均 exit 1，不能判整体通过，结果见第 8.6–8.7 节。新 binary 交互验收单独记录，不沿用第 7 节通过数字。

### 8.2 最小红绿与相邻回归

| 模块 | 必要断言 |
| --- | --- |
| Mods focus | 空 composer 的人工 Tab/鼠标入焦；非空草稿、dialog 和其他键盘所有权不被抢占；裸 Up/Down 按可见控件顺序移动、跨五文件窗口及首尾边界；middleware 重写/拒绝/stay 后实际 DOM 落点；快速输入不依赖过时 snapshot |
| Mods action | 当前 drawing 的 Button `action` 经现有 keybinding 系统执行；modifier arrows、完整/取消 chord、用户 remap/unbind、Enter/Space 恰好一次；重复 action 目标确定、旧 drawing/隐藏/卸载清理；不解析展示用 hotkey |
| Mods wheel | 复用鼠标 parser 坐标和 hit-test，零基 body-relative pointer 传入既有 `ui.scroll`；list/body 分区、非顶部向上、边界、遮挡、pane 外 transcript；无宿主 overflow 仍可让插件虚拟分页，不抢焦或附加 transcript 加速 |
| 输入相邻回归 | Input/Select 自身按键、PromptInput Escape overlay guard、快速详情→列表→关闭、新一组正常双 Escape、builtin command 恢复 |
| SSH | 长 TMP、多字节路径、短路径保持、并发目录唯一；control 与 proxy 均满足 Unix socket 字节预算并保留 OpenSSH 临时后缀空间；本地真实 UDS bind/关闭；probe/deploy/proxy/spawn 失败与重复清理；不删除仍活跃的 master socket |
| Workflow | 透明记录 spawn/PID/exit/close、pipe 字节与 end/close/error、TERM/KILL/timer 时序及带外心跳；不记录输出正文、不提前 resolve、不放宽 testcase timeout |

Workflow 只做一次探针校准和一次原 full-b 到目标的精确前缀诊断，仓库外单轮上限 180 秒；取得失败轨迹才最多两次有信息增益的缩减。其他模块并行修改时以固定基线镜像或逐文件 manifest 保证输入身份。首轮未复现则停止，不重复此前三次单文件和十文件邻域来刷通过次数；未定因仍保留原 timeout 和推送阻塞。

### 8.3 完整验证与新制品交互

1. 先审各模块红绿证据、cleanup 和实际 diff，再运行相邻回归、TypeScript、lint、changelog 与 diff 门禁，按功能正常签名提交。
2. 冻结源码后从 tracked 文件重新生成 inventory，逐文件独立 OS 进程和显式 `bun test --isolate --no-orphans` 各一轮；保留 Workflow preload、真实官方 fixture/types、短 TMP 和既有 Peer fixture 授权。registered、顶层脚本、child summaries 分开；raw 顶层错误不能被 JUnit 漏报掩盖。
3. 执行 `make release-check`、`make build`。CHANGELOG 在构建前定稿；记录实际源码与 binary hash，不把 HEAD/index、evidence 路径和动态日志当内容身份。
4. 专门 runtime agent 串行脚本操作 tmux，使用完整未修改官方 diff 原件、具有真实 HEAD/merge-base 和多个分离 hunk 的私有 Git fixture，验证 inline 逐文件/跨页、详情/Escape、fullscreen Tab/BTab→ask→实际提交及一次 context、modifier/chord 恰好一次、base 实际切换后 store/reload、list/body wheel 正反向、pane 外 transcript、mouse 相邻路径、disable/builtin、draft/dialog 所有权，以及 Workflow 相关执行/终态 smoke。
5. 每场保存 exact argv、session/window/pane、操作前置状态、关键 captures、行为断言和正常退出；cleanup 单独审计。空 Mods 规范化请求对照只复用既有可靠方法，不重跑无关发布版 benchmark。
6. 最后只回填不内嵌的本文件与 handoff；若构建输入又变，重新构建及相关 smoke。旧失败保留，新的未解释本地失败或构建/交互失败继续阻止推送。

### 8.4 实施中评审记录（不作最终通过结论）

- SSH 实现者交接时相邻回归为 140 pass / 0 fail（10 文件，其中 session 41 项），相关 lint 通过，见 `ssh/summary.json`；主线程评审及后续修复另外记录如下，不改写交接时结果。
- 主线程另做真实 default proxy 的清理错误路径探针：目录存在合成 `pending` 资源时，`proc.emit('close', 0)` 经 `createSession` 的直接 `proxy.stop()` 将新增 directory cleanup 的 `ENOTEMPTY` 同步抛出。最小行为断言失败、exit 1；before/after 源码 hash 一致，finally 删除自有 marker 并停止 proxy。证据 `automated/ssh-review/result.json`、`output.log`。该失败不能被前述 140 项通过覆盖。交接后主线程补 close/error 两项源内回归，先 0 pass / 2 fail，再在事件回调边界记录 cleanup error、不让异常逸出；显式 `proxy.stop()` 仍保留错误和重试语义，非空/live socket 目录保护未改。定向绿 2/0，相邻 10 文件 142/0，lint 与 diff check 通过，自有目录无残留。证据 `ssh/review-red-events/`、`ssh/review-green-events/`、`ssh/review-green-adjacent/`、`ssh/review-lint/`；旧 140/0 及最初 probe 失败均保留。
- 驱动准备阶段尚未启动完整清单；`automated/preparation-checks.json` 记录 sandbox 探针和 changelog 门禁（5 pass / 0 fail）。Peer 和私有 UDS fixture 探针通过；SSH 回退目录许可按本次 exec 保留的 PID 限定，其他 PID fixture 创建被拒，不能泛化为开放 `/tmp` 写入。`/bin/ps` 仍 EPERM，环境边界未改变。

- Workflow 有界取证已结束，未修改生产代码：一次校准、一次 180 文件前缀，0 次缩减。目标三项完成，普通调用 67.568ms，有真实 spawn/pipe/exit/close 轨迹；原 5000ms 超时未复现且根因仍未定。该前缀整体 exit 1、JUnit 1244 项比原少 6 项，**不合格为完整原前缀复现**：主线程只读 raw 查明镜像漏了内嵌 `CHANGELOG.md`，`LogoV2/uiName` 和 `setup` 导入发生顶层错误。源码 hash 相同不能弥补缺失运行输入，不将其归因于产品、不额外重跑；`workflow/summary.json`、`workflow/main-review.json`。所有记录内自有进程及短 TMP 已回收；原超时继续阻止推送。

- Mods 输入链原实现者和接管审查者先后遇到 API 连接中断，保留代码与 raw，未将中断算为产品失败或验收通过。主线程最终接管；REPL 抽取测试补当前 presentation、最终 landing、canFocus 条件和 wheel pointer 断言。进一步红测复现 Escape 之后迟到 host focus 再次抢焦，以后来的人工请求使旧请求失效修复；跨 pane 转移和重新进入均覆盖。新增红测中的 snapshot 断言最初把省略字段误写为显式 undefined，邻域205/1；改为明确断言字段不存在后，最终7文件 **206 pass / 0 fail、1123 expect**。证据 `ui/takeover-host-escape-red.log`、`ui/main-final-adjacent.log`、`ui/main-final-green.log`；原失败不覆盖。
- `make release-check` exit0：changelog、TypeScript、lint、missing audit及diff全部通过，tracked内容前后无变化，见 `build/release-check.json`。SSH按功能签名提交 `1a7abc9`；后续完整清单和制品交互独立记录。

### 8.5 官方检测配置与隔离边界

本地自动化和本地 binary 回归继续使用独立 HOME/config/XDG/TMP、synthetic auth 和 loopback fixture。若需要启动根 `official-claude`，按用户指定显式传入 `--settings /Users/esonhugh/.claude/settings.mjclouds-ant.json`；已核验该路径存在，配置内容不写入报告、日志或版本控制。仅官方检测进程使用该指定配置，不读取其他真实配置或 Keychain；使用 synthetic workspace 和测试输入，不发送仓库代码、原件或 raw 日志。该配置检测与本地 loopback 场景分开记录，不宣称两者环境相同。官方自然 gate 仍关闭则记录 not covered，不 patch binary、账户或 rollout。

指定配置的首次检测已结束，但 **official 进程实际未创建，配置尚未被 official 消费**：首次 harness 缺少 synthetic Git `.git/info`，修正后又被 macOS sandbox profile 的数值 remote-ip 语法拒绝。本次只证明启动前置受阻，不能声称官方 gate 仍关闭、配置无效或认证失败。计划 argv 已包含指定 `--settings`，但不是已执行 argv；模型/API 请求为 0，无正常退出资格。binary/原件完整性及自有资源 cleanup 通过，证据 `official-configured/summary.json`、`sandbox-compile.json`、`cleanup.json`。受限重试预算已停止，未通过放宽外网或秘密隔离启动。配置内容未打印或复制；sandbox 错误曾包含解析后的服务地址，已原地脱敏，未发现凭据材料。

### 8.6 提交后完整自动化：执行结束，整体 failed

本轮按功能正常签名提交 `1a7abc9`（SSH）、`5f560fa`（Mods 输入）、`6b967f3`（README/CHANGELOG/方案），冻结提交为 `6b967f36c7135dacd5c9a29a228eaea4ffe75806`。`automated/frozen.json` 动态发现261个唯一 tracked 测试文件，排除生产模块 `src/ink/hit-test.ts` 和 ignored 第三方输出。两轮2578个源码/运行输入前后逐文件 hash 一致，包含内嵌 `CHANGELOG.md`；HEAD只作 provenance。

| 验证模式 | 实际结果 | 证据（相对本轮证据根） |
| --- | --- | --- |
| 每文件独立 OS 进程 | **260/261文件 qualified；1623 registered pass / 3 fail；106个 assertion scripts完成；0 skip/todo/timeout；exit1** | `automated/final/summary.json`、`results.json` |
| 同进程显式261清单，`bun test --isolate --no-orphans` | **完整结束，1622 pass / 4 fail；0 skip/todo/timeout；exit1** | `automated/tracked-final/result.json`、`output.log`、`junit.xml` |
| Mods 22文件子集（独立模式） | **22/22 qualified，572 pass / 0 fail**；已包含于完整清单，不累加 | `automated/main-review.json` |

父 raw footer 两种模式均为4622 expect calls，JUnit均有1626个 testcase elements、4617 assertions；分别3和4个 failure elements，无额外 error elements。保留5个断言的计数口径差异，不相加、不悄悄改成相同数字。各模式另有一个子进程摘要6 pass / 0 fail、86 expect，单列不计入父 totals。raw告警逐条审核后无顶层 Unhandled；测试名内的 error/unhandled 和末尾重复失败摘要不算新失败。

同进程确认105个脚本完成 sentinel；`nativeInstaller/download.test.ts` 无源码级完成标记，仍保留资格限制。独立模式的 awaited import+sentinel不能证明它在同进程内异步完成。交叉审计见 `automated/raw-junit-audit.json`、`automated/main-review.json`。

剩余失败与边界：

1. **Peer 3项 environment-blocked，两模式一致。** registry process-start、recycled PID discovery、stale authentication断言失败，`procStart`不可得。既有隔离探针再次记录 setuid `/bin/ps` 执行 EPERM；没有取消隔离、伪造身份、跳过或弱化断言。`automated/final/f259/output.log`、`automated/sandbox-probe.log`。
2. **历史 PTY `2 !== 130` 在同进程重现，根因未定。** `src/utils/pty/bunPtyDriver.integration.test.ts:165` 实际exitCode2，预期130；同文件独立9/0，同进程8/1。raw与JUnit一致，不能归为计数误差。当前测试open→write→signal没有shell readiness，但失败进程启动/输出轨迹不足，尚不能证明启动竞态或进程级污染。此前三次单文件和tmux有界诊断均未复现，本轮不再盲跑、不改生产退出码、不放宽断言。`automated/tracked-final/output.log:2390–2409`。
3. **Workflow本轮3项两模式均通过，但原5000ms事故仍未定因。** 新通过不覆盖旧full-b失败，也不使第8.4节遗漏CHANGELOG的前缀获得等价资格。原Workflow timeout与本轮PTY失败均继续阻止推送。

父LCOV仅来自既有90文件 Mods/相邻清单：Mods **5121/5801行（88.28%）**，19个已插桩文件；全部被导入父源码61166/260628行（23.47%），1244文件。按canonical source/line并集合并；不代表全仓覆盖率、功能完整性或官方parity，不含Worker/VM/child/compiled与直接脚本。失败执行可以贡献观察行，不能贡献验收成功。`automated/final/coverage-summary.json`。

资源复核：261独立进程及同进程runner均无额外process-group kill，记录内PID/直接子进程/process-group现已不存在；自有SSH目录残留和私有TMP socket entries均为空。私有测试数据保留在 `/private/tmp/mi-jvp9bp4n` 作为证据，不宣称已删除；此检查不证明不存在未被记录的detached descendants。见 `automated/main-review.json`。

### 8.7 构建身份与工作区边界

`make release-check` 与 `make build` 均 exit0，检查及构建前后 tracked内容无变化。构建为 **2.1.219，100119266 bytes**，SHA-256 **`13e042c2a21c2b0a3799f02832d6b357483263d9cc46db3e69a8d43deec7d31e`**。构建锁定时，仓库 `built-claude` 与 `build/artifact/built-claude` 隔离副本hash相同，见 `build/release-check.json`、`build/build.json`、`build/artifact-lock.json`。报告复核时，仓库产物已变为 `b5d6121afa250922d4ccbe395f35dba5dc3033a119a7d291dd7fc18eae84235f`；本任务未重建或覆盖它，不把该并发替换产物算作已验收。隔离副本仍为上述 `13e042c2…`，是本轮scripted tmux的唯一指定制品；最终交接与实际覆盖见第8.8节。

完整测试于本地2026-09-19 00:28:47结束，首次审计发现 `src/services/api/openai-compat.ts` 和 `openai-compat.test.ts` 出现额外未提交改动，记录mtime分别00:33:10和00:30:58，均晚于测试结束；之后还观察到 `src/utils/messages.ts` 改动与新的 `src/services/api/openai-reasoning-resume.test.ts`。后续复核时，这组并发工作已由其他任务正常签名提交为 `3b0d6ce`，另包含 `src/utils/conversationRecovery.ts`，当前HEAD因而前进。两个完整模式保留的before/after hash一致；**本轮结果对应冻结的 `6b967f3` 内容和上述binary，不覆盖后来的OpenAI提交，也不声称验证了当前HEAD的全部生产代码**。未修改、暂存或代替其他任务提交这些文件。报告回填只改本文件及`handoff.md`，不改已内嵌CHANGELOG或重建产物；两份既有cross-session草稿继续保留。

### 8.8 新制品交互：已结束，存在确认失败及未覆盖项

首个runtime任务已结束，`runtime/summary.json` 结论为 **not covered**，不能算新binary的产品通过或失败。`inline-acceptance-a1` 在适配旧driver时找不到已变更的plugin初始化代码（`ValueError: substring not found`）；一次集中修正后的 `inline-acceptance-a2` 又因 `git init --template=` 不创建 `.git/info`、写入exclude失败而停止。两次都未创建tmux session/pane、未启动loopback API或本地/官方CLI，因此全部产品矩阵与正常`/exit`均未覆盖。计划session `cc-final-inline-acceptance-a2` 不是实际创建的session；没有关键pane输出可供产品判定。

上述任务在原重试预算内停止，旧summary、raw和driver快照保留。后续有界接管已结束：先通过fixture-only preflight，再使用冻结隔离制品完成7个真实tmux场景，每场一次，未启动official或真实外部provider。交接 `runtime/continuation-summary.json`（SHA-256 `f77791c6d20668c4caa987bb28990646d5e4734629aeea04c7301cdbd7dacf70`）判为 `qualified_with_confirmed_failures_and_partial_coverage`：有合格运行证据，但**整体不通过**。主线程只读交叉审计见 `runtime/main-final-review.json`，未重跑、未覆盖raw。

以下场景目录位于 `runtime/continuation-a3/`，表内关键证据路径相对各自场景目录。exact driver命令和CLI argv在交接与场景记录内；实际session/pane均为 `cc-final-<场景名>:0.0`，私有tmux socket在各result中。

| 场景 | 实际结果与边界 | 关键证据 |
| --- | --- | --- |
| `inline-acceptance-a3` | **确认失败：** Down/Up不能连续逐文件遍历，五行窗口未持续跟随。Down落点为01、02、03、03、03、06，之后仍停在06。Enter/详情滚动断言依赖已失败的导航，不能作为独立合格失败；快速Escape中间态未满足，后续未覆盖 | `inline-down-traversal.json`、`inline-up-traversal.json`、`list-down-07-after-1-viewport.txt`、`result.json` |
| `fullscreen-acceptance-a3` | 20次有界Tab/Enter后激活ask，出现`asked`及下一prompt携带提示；API日志确认后续`REPAIR_ASKCTX`请求已发出。**不证明官方diff context恰好一次**：宿主`/bin/ps`采集5秒超时中断后续观察，下一请求未执行。单次Tab/BTab只比viewport变化，焦点谓词不足；modifier/base/reload/draft未到达 | `ask-keyboard-attempts.json`、`api-events.jsonl`、`result.json` |
| `mouse-acceptance-a3` | dock body从非顶部向上/向下、list正反wheel、file03 row与边缘点击6项通过。pane外wheel前后transcript/dock均无可见变化，不能区分忽略、clamp或终端路径限制，**pane外回归未确认通过** | `result.json`、`mouse-outside-pane-audit.json` |
| `local-fullscreen-ownership` | disable移除原件视图并恢复builtin `/diff`，限定场景通过 | `ownership.json`、`result.json` |
| `enable-ownership-a3` | enable后settings恢复且重新显示Mod风格fullscreen，观察到owner恢复；新generation显示`No changes this session`。驱动要求旧hunk/ask重现，严格断言未到达；未定义的跨generation内容保留不能据此判产品失败 | `original-restored-timeout-viewport.txt`、`result.json` |
| `context-normalization-a3` | 独立synthetic hook的当前请求marker计数**0→1→0**通过；不是官方diff ask链路，也不是no-plugin/empty-Mod完整请求等价 | `context-observation.json`、`result.json` |
| `workflow-smoke-a3` | 单Agent后台Workflow完成，child Bash经过Mods恰好一次；`/rename`、`/color`、`/tasks`、`/workflows`已操作；主REPL只有1条聚合行、无agent展开行，详情显示1阶段/1agent。限定smoke通过，**不解决旧runCommand超时**，也不代表PTY生命周期全覆盖 | `result-final.json`、`workflow-tool-evidence.json`、`workflow-aggregate-observation.json` |

真实Git fixture有16个变更文件、两个commit、有效HEAD/default-branch merge-base及多个分离hunk。三场主矩阵的raw却要求merge-base hunk数量必须严格大于HEAD；实际数量相同而patch不同，该项是错误predicate，不是fixture无效或产品失败。原raw失败全部保留，主线程未通过删除/放宽断言重跑改绿。

仍未覆盖：strict快速Escape/no-Rewind、modifier action恰好一次、`Ctrl+x b`的base实际转换及store/reload、非空草稿/弹窗/host generation编译制品路径、官方diff ask一次context链、pane外transcript有效滚动、no-plugin与empty-Mod完整wire等价，以及官方CLI parity/真实provider。

正常公开退出与资源回收分别判定：inline、disable ownership、context和Workflow **4场正常`/exit` exit0**；fullscreen keyboard、mouse和enable **3场正常退出未通过或未到达**，不能用cleanup替代。7场最终自有资源均已回收；Workflow基础cleanup遗留的remain-on-exit私有tmux server已在最终审计中清理。7个loopback端口关闭，无记录内owned process或私有tmux socket；主线程再次只读复核一致。见 `final-cleanup.json`、`final-integrity.json`、`../main-final-review.json`。

冻结隔离binary、775文件官方原件及首个失败summary内容未变。**本轮执行已结束，没有仍在运行的验收agent；inline导航残留缺陷、PTY退出码异常和Workflow原超时继续阻止推送。** 只提交这两份不内嵌报告，不重新构建、不把后续OpenAI代码或仓库替换产物计入本轮结果。

## 9. Mods UI/UX 残留修复与限定验收

### 9.1 范围、身份与方案

起点为 `feat/mods@656ecafb3696d817ac35134f6b00d8f93171f6cc`。本轮证据根 `U` = `/private/tmp/mods-uiux-20260919-4y11t_bu`，与第8节旧制品、失败日志分离。保留并发 OpenAI 提交、原有构建产物及两份 cross-session 草稿；不改官方775文件原件，不重跑261文件全量矩阵、旧 Workflow/PTY 调查或已结束的SSH修复，不修改版本、依赖或CI。本轮局部通过不解除 Workflow/PTY 推送门禁。

验证顺序：先最小红测，修复逻辑 key/DOM 注册和 host 焦点回声；补16真实文件、五行窗口、focus promise完成后异步invalidate的逐次/连续正反导航；验证控件可见焦点、diff宽度/metrics和键盘与pointer所有权；运行相邻回归、release-check与新build；锁定独立binary后执行限定scripted tmux。最终回填报告、正常签名提交，不push。

真实交互计划覆盖：inline逐文件/跨页/Enter/详情/Escape，fullscreen Tab/BTab与实际ask、context一次注入，modifier/chord与base真实patch变化/store/reload，pane内外双向wheel和Page键，160→110→109→80→160与短高度/长ASCII/CJK，draft/dialog不抢焦、disable→builtin→enable。每项先建立可观测前置；前置失败停止依赖步骤，区分产品、环境、harness、predicate，正常退出与资源清理分别判定。官方CLI不是本轮必需；若需启动，仅使用用户指定settings，且与loopback fixture分开记录。

### 9.2 最小红绿与组件回归

| 问题 | 原始失败 | 修复与验证 |
| --- | --- | --- |
| 分页DOM复用留下旧key | `focus-red.log`：a→b后keyRows仍含a；host聚焦b另发person请求，0/2 | 精确注销每个ref的旧 `(key, element)`，保留重复key其他节点；snapshot走既有focus guard。新增duplicate/plugin变更/卸载和其他owner不被blur断言 |
| Select/Input焦点提示 | `chrome-width-red.log`：Input未获焦仍inverse | focus/blur更新本地chrome；真实Tab/BTab、鼠标和activeElement断言 |
| diff固定宽度 | `render-width-qualified-red.log`：预算78实际76；`nested-width-red.log`：嵌套预算26实际76 | 内部snapshot复用drawing bodyColumns；Code按局部Yoga宽度约束，覆盖109/110、CJK和padding |
| 宽度收敛后metrics滞后 | `nested-metrics.log`：实际高度16、报告10 | 局部布局收敛通知已有metrics路径；`nested-metrics-green.log` 2/0 |
| transcript抢先消费PageDown | `scroll-red-01.log`：pane获焦时transcript offset20→25，0/1 | keyboard activation独立于wheel；`scroll-green-final-01.log` 9/0、80 expect，覆盖Page/Home/End、Ctrl边界、pane内外wheel、失焦恢复和原modal开关 |

16真实 `file:<path>` key的新增分页测试分别验证paced/continuous Down15→Up15、首尾不wrap、请求序列和DOM实际落点。此组在修复后补充，不声称每项均单独在原生产代码上取得红测。原Input测试把host聚焦回声当成功的断言已改为actual activeElement正确且person请求为空，原change/submit断言保留。

宽度测试初次缺AppStore导致 `useAppState/useSetAppState cannot be called outside of an <AppStateProvider />`，属于fixture错误；补真实AppStoreContext后才取得合格宽度红测。日志 `render-width-red.log`、`render-width-diagnose.log` 保留。首次release-check的测试记录类型漏 `bottom` 触发TS2769，修正类型后 `release-check-fixed.log` exit0；未放宽产品断言或增加timeout。

主线程最终两文件 `pane-final.log` 为 **76 pass / 0 fail / 407 expect**；较早7文件 `ui-adjacent.log` 为215/0，不把早期批次标成最终冻结源码。所有命令由 `U/run-test.sh` 保存 argv/exit，独立HOME/config/XDG/TMP、env白名单、localhost-only sandbox保持启用。源码测试不替代编译制品交互证据；正常ColorDiff路径的宽度覆盖不等于fallback完整覆盖。

### 9.3 最终相邻回归、构建与真实交互

最终8文件相邻回归 `ui-final-adjacent.log` 为 **224 pass / 0 fail / 1303 expect，exit0**，包含ModsPane、ScrollKeybindingHandler、ui、runtimeUi、defaultBindings、runtime、session、plugins；其中包含从生产源码提取的PromptInput Escape guard回归、真实Worker及REPL接线；该guard测试不是完整PromptInput挂载，也不替代compiled快速Escape验收，不累加前面重叠批次。`release-check-final.log` 为 **exit0**，changelog、TypeScript、lint、audit、diff检查通过；audit中的fixture import字符串不是生产缺模块，missing src/text/type-only均为0。

`make build` **exit0**，源码内容manifest前后无变化，见 `build/build.json`、`source-before.json`、`source-after.json`。新制品 **2.1.219，100119266 bytes**；SHA-256 **`13a70ecf1726c63a215e731aa7e5571320133ae48aa8d316bd378637d4d4fc10`**。唯一指定隔离副本为 `U/build/artifact/built-claude`，仓库产物在构建锁定时与它一致；此前仓库binary另存 `build/artifact/previous-built-claude`，没有删除旧验收制品。`build/source-identity.json` 的保守源码内容digest为 **`3f17210ff1360e6d29c97fb649dadccbe98a583b0e60a438370d910882ed41b3`**，含CHANGELOG，不含HEAD/index、动态测试输出、报告或证据绝对路径；它不声称完整hermetic依赖安装身份。HEAD `656ecaf`只是出处，实际修复包含未提交内容，不能把该HEAD本身当作制品源码身份。

runtime准备agent已结束，`runtime/preparation.json` 为 preparation passed / runtime not covered；775文件原件、fixture Git/loopback、sandbox和空tmux preflight通过。新collector最初的子进程计数语义错误保留为harness证据，修正后preflight通过；未启动旧binary或official。首轮新制品验收已结束，**failed**；旧第8节制品 `13e042c2…` 不用于本轮验收。

### 9.4 首轮新制品失败与追加修复

`13a70ecf…` 实际运行inline、fullscreen各一次；后者的共享dock前置失败后，mouse/resize/ownership/bindings未启动。证据 `runtime/summary.json`、`acceptance-integrity-final.json`，不可用源代码224/0覆盖运行失败。

- `inline-acceptance-01`：慢速Down选中01→02→03→04→04，第四次未到05；原始viewport/ANSI复核一致。后续反向、连续、详情/Escape未执行。正常`/exit`为0，cleanup通过。session/pane `cc-uiux-inline-acceptance-01:0.0`，证据 `slow-down.json`、`slow-down-05-after-viewport.txt`。
- `fullscreen-acceptance-01`：dock入口出现React #185，栈含reportMetrics/onReportMetrics；raw driver把wait timeout记not covered，人工 `reviewed-result.json`独立记录产品failed，未改raw。Tab/ask/context/base等均未到达。正常exit未覆盖，cleanup阶段exit0不算正常退出。session/pane `cc-uiux-fullscreen-acceptance-01:0.0`，证据 `failure-pane.txt`、`failure-viewport.txt`。
- inline独立observer被loader拒绝（event需literal pattern）；只在仓库外修observer并保留diff，没有重跑inline或修改官方原件。fullscreen两组ui.render可观察，不证明DOM实际焦点。两场自有进程/端口/tmux socket均清理，775文件原件与副本、binary hash、2313项source identity均保持。未启动official/外部provider。

针对fullscreen补真实 `createModUi` + `useSyncExternalStore` + 五个Code块红测，`metrics-live-red.log`复现崩溃，`metrics-live-diagnose.log`捕获contentRows/keyRows交替为46/有效行和0/空行。根因：子ModDiff的layout effect早于ScrollBox父viewport ref重挂，读取了暂时为空的ref并发布0指标；父layout effect随后发布真实值，形成订阅更新循环。局部测宽仍在layout effect，metrics通知移至commit后的effect；`metrics-live-green.log`三个宽度/嵌套/真实订阅测试3/0、27 expect。本修复改变构建输入，首轮binary保留为失败证据，不能用于后续通过判定；inline追加修复和新构建结果见下。

inline官方 `dialogFocusOf()` 返回旧窗口中目标槽位的文件key，而不是新窗口中的逻辑选择key；01–05选中03→请求04时返回03，新窗口变为02–06。旧测试把selected、snapshot和返回值合成同一个值，遗漏了该组合。新增两种受控时序（reply→redraw、redraw→reply）的红测 `window-landing-red.log`，均发现复用槽位是file04而actual activeElement不是它。保留精确注册、host guard和队列，只记录本次旧drawing的落点DOM；同owner/generation、成功返回且新树将该DOM复用为请求key并明确autoFocus时，按该槽位交接；普通key重写/deny仍走原路径。

`window-landing-green.log` 为7/0；随后两种landing协议×paced/continuous的16文件正反往返及两种reply/redraw顺序 `window-landing-matrix.log` 为6/0、108 expect。未修改官方原件、公共Ink autofocus或绕过middleware。追加8文件相邻回归 `ui-repaired-adjacent.log` 为 **229 pass / 0 fail / 1368 expect**；`release-check-repaired.log` **exit0**，`build-repaired/build.json` 中 **make build exit0、内容manifest前后无变化**。

第二制品 **2.1.219、100119266 bytes**，独立路径 `U/build-repaired/artifact/built-claude`，SHA-256 **`0a6a3716b068b9a0e3faa3113e4abc9b3baf5ae0144d838320b05ab7bfb2a705`**；构建源码digest **`279b8de553e8902c1f79208f348d5881c3fd99435e7c741d974b2c55a3714840`**。首轮build/runtime失败资料全部保留。第二制品六场已串行完成，每场一次、0 retry；结果如下。

### 9.5 第二制品限定验收：连续导航仍失败

总索引 `U/runtime/repaired-runner-index.json`，各场完整命令、环境、input与逐断言证据位于 `U/runtime/<场景>-acceptance-02/reviewed-result.json`；实际tmux target为 `cc-uiux-<场景>-acceptance-02:0.0`。本轮未修改harness或产品源码、未启动official或真实provider，不是完整parity。

| 场景 | 审核结果 | 已观察行为与缺口 |
| --- | --- | --- |
| inline | **failed，产品行为** | paced16文件正反通过；15次burst Down从01仅到10，期望16。15次person ui.focus请求重复04–09；详情、反向burst、快速Escape等依赖项停止。证据`burst-down.json`、`burst-down-viewport.txt`、`slow-down.json`、`slow-up.json` |
| fullscreen | not covered | 本场未再出现React #185；ask实际激活、当前请求context计数0→1→0、modifier恰好一次、HEAD/merge-base实际patch变化与store/reload、draft/dialog通过。中间base控件实际焦点及完整高亮证据不足，不能仅以source/base/source请求序列算通过 |
| mouse | not covered | pane内外双向wheel及pane双向Page通过；driver未操作transcript反向PageUp，raw exit0不等于整场完整通过 |
| resize | **failed，harness** | 尺寸矩阵和最终激活完成；pane仍持有输入时发送`/exit`导致超时。长ASCII/CJK文件未选中，短高度内容可达性未验证 |
| ownership | passed | disable→builtin→enable所有权恢复；不要求旧generation内容持久化 |
| bindings | not covered | 自然隔离配置日志为`user customization disabled`，未执行override/unbind/restore；未伪造gate或关闭隔离 |

正常退出5场通过，resize失败；cleanup6场通过，resize核对自有进程身份后SIGTERM不能替代normal exit。资源、隔离和证据路径审计见`repaired-runner-resource-audit.json`、`repaired-runner-isolation-audit.json`、`repaired-runner-review-audit.json`。旧runtime3840项、旧summary及官方775文件原件未变，见`repaired-runner-integrity-final.json`；主线程另核对生产构建输入无变化、仓库及隔离binary均匹配0a6a…，见`repaired-main-source-audit.json`。无仍运行的第二轮验收任务。

组件的continuous回归包含每次focus人工等待5ms，未能覆盖真实burst调度；229/0不能覆盖此次失败。下一步针对队列解析目标与异步drawing提交之间的边界补确定性红测，不通过增加sleep、修改官方插件或弱化断言规避。当前仍未提交、未推送；原Workflow/PTY门禁继续保留。

### 9.6 连续输入的绘制/提交边界修复

`burst-fast-reply-red.log`：保留旧四组合，仅新增立即focus reply、延迟drawing提交，得到02、03、04、04、05、05；4/1。`burst-commit-receipt-red.log`进一步携带明确待提交版本，旧组件仍重复目标。`focus-invalidation-red.log`确认已开始但未await的invalidate尚未完成时，host person focus已返回；`focus-receipt-wiring-red.log`确认REPL未传递当前发布版本。

修复分两层：host仅等待该pane已开始的绘制工作，跟随superseding redraw，不等待凭空出现的新重绘；内部snapshot附单调publication revision，REPL在focus完成后从同一host取实际版本，ModsPane等该版本或更新版本的layout commit后才应用最终landing、解析下一箭头。无需sleep、不改worker/plugin公开契约；无redraw直接继续，Escape、隐藏、owner替换和卸载释放组件提交等待。旧drawing-slot交接与最终middleware landing保留。

定向`burst-fence-green.log` **11/0、145 expect**，提交合并及取消五组合/替代drawing `burst-fence-cancellation.log` **6/0、16 expect**。追加真实`createModUi`/`useSyncExternalStore`的16文件burst正反闭环：最初仅等待80ms时少观察到最后两步（`burst-live-host.log`），改为等待第15次实际提交信号、不增加测试timeout后，`burst-live-host-commit.log` **1/0、6 expect**。该harness前置修正不把初始失败改标。

第一批8文件`ui-burst-adjacent.log`为237/0、1395 expect；随后release-check在新增测试`let focusedElement`的prefer-const处失败，已改const。包含live-host的`ui-burst-final-adjacent.log`为 **238/0、1401 expect**，`release-check-burst-final.log` **exit0**；该批次之后仍有下述边界修复，不得把第二制品的旧runtime结果套用新增生产代码。

独立只读审核另发现两个取消/寿命边界：已进入的旧draw等待不能被Escape或替代draw及时唤醒；旧分页handoff可能污染后续host焦点。主线程在原reply/redraw双时序测试追加“分页交接→host到file6→host回旧landing file4”，`handoff-lifetime-red.log`两项均失败；现已在应用不同landing时清除旧handoff，`handoff-lifetime-green.log` **13/0、142 expect**，保留原两时序与burst矩阵。服务等待取消由单独写入者在ui.ts/ui.test.ts补红绿；主线程追加真实host/ModsPane的“旧draw始终pending→Escape→Tab→新draw入焦”闭环，`escape-draw-tab-integration.log` **1/0、4 expect**。服务修复最终整文件`ui-focus-wakeup-final-green.31mWHE` **44/0、245 expect**。最小Escape红测`ui-focus-wakeup-escape-red.9h6HZn`为0/1，排队过期拒绝红测`ui-focus-wakeup-queued-red.o9ZJyc`为0/2；内部waiter在publish/redraw开始/person generation变化时唤醒，race后finally注销，仅有效draw错误传播到focus，原invalidate/render仍观察过期错误。只取消旧focus等待，不中止底层draw，也不取消尚未返回的middleware。主线程已复审实现；最终8文件`ui-reviewed-final-adjacent.log`为 **250 pass / 0 fail / 1476 expect**，`release-check-reviewed-final.log` **exit0**。audit仍列出10个既有测试fixture相对引用，text/type-only缺失为0；命令通过不表示所有字符串引用均可解析。

下一轮harness在仓库外完成准备（`runtime/harness-next-burst/preparation-result.json`，9项离线检查）；第三制品四场真实验收已启动，尚待结果，离线检查不计runtime覆盖。主线程核对官方`hooks/views/sidebar-pane/sidebar-pane.tsx:18,54–61`：base原本就是无文本的action chord载体；空label不应直接归因为宿主布局缺陷。实际Tab可达性、Enter回调与可见焦点分别报告，不能凭callback成功宣称visible-style通过。审核执行副本为`driver-reviewed.py`（SHA-256 `0ecb44c2922fce454b893d654ad1221ecc44b6ca2f5aacfedfb81122ba3f22b4`），仅将该空label分支保留为not covered，准备版未改，差异见`driver-review.diff`及`main-harness-review.json`。另外官方`hooks/views/pane-view.tsx:16–22,37–53`明确规定fullscreen窄于110列显示fallback，而非inline详情；80列正文不可达若复现仍不满足本轮可达性目标，但应归为插件现有设计限制，不伪称宿主宽度计算已证实错误，也不改插件来凑绿。

### 9.7 第三制品限定验收：导航通过，长路径与测试判据需收敛

`build-burst/build.json`记录第三次`make build` **exit0**、构建前后源码manifest一致。制品 **2.1.219、100119266 bytes**，独立路径 `U/build-burst/artifact/built-claude`，SHA-256 **`2889ff21cfcd281ec6b8a53c1d1d872dbf42a3b83c7c22698809318f87679fe1`**；保守构建源码digest **`2db0c2169fb3d627512566f792e27b6163040c1d24217f6b6eac0a57cb9fb020`**，详见`artifact-lock.json`、`source-identity.json`。前两制品和全部历史失败保留。

专用agent使用`driver-reviewed.py`串行执行`inline/fullscreen/mouse/resize-acceptance-03`，每场一次、0 retry，仅本地第三制品、未修改官方插件和loopback fixture；未启动official或真实provider。四场runtime和最终审计均已结束，索引`runtime/burst-runner-index.json`，各场`reviewed-result.json`与`command.json`关联tmux target `cc-uiux-<场景>-acceptance-03:0.0`及全部输入/captures。正常退出3通过、inline失败，cleanup4通过；不把强制回收算正常退出。

| 场景 | 审核结果 | 结论与剩余项 |
| --- | --- | --- |
| inline | failed | paced与burst16文件正反全部通过，四组exactly-once焦点序列均通过；Enter已显示确认的file01正文，但联合谓词还要求初始viewport出现底部`Esc to back`，故raw激活判失败。缺少footer可达性证据，后续详情滚动/Escape/Rewind依赖停止；该失败不再归因于旧导航缺陷 |
| fullscreen | failed，harness predicate | source/base/source独立Enter、ask context0→1→0、modifier等有证据；base恢复错误把absent当branch，实际初始session→uncommitted→branch，并未恢复初始有效模式。raw false-pass已在review中更正，不能以其通过证明依赖前置；空base可见性与样式仍not covered |
| mouse | passed | pane/transcript双向wheel、pane双向Page与退焦后transcript双向Page均通过，正常exit0 |
| resize | failed，host validation | 官方完整路径key（ASCII185/CJK89字符）触发宿主`key exceeds 64 characters`，保留旧file09–16绘制；两长文件激活前置失败，短高/CJK/80列可达性依赖not covered。80列fullscreen fallback仍为原件设计限制，不误称宽度算法缺陷；composer归还与正常退出通过 |

第三轮未重跑ownership/bindings；第二制品相关结果仅保留为历史，不能冒称已在第三制品重新验证。资源审计`burst-runner-resource-audit.json`确认四场私有socket/loopback及记录内owned进程已回收；完整性审计保留775原件、11156个既有受保护文件、旧raw与5965个本轮raw一致。离线审计先因旧manifest的symlink无sha256字段报错，后因仓库可变binary被并发替换而停止；仅修复离线审计/索引，不重跑runtime，修正原因单列，原错误保留。`burst-runner-concurrency-qualification.json`确认隔离制品与四运行副本均匹配2889ff21…，仓库产物已变为a2273a0d…，`all_binaries_match:false`不改标。inline正常退出失败是在详情尚持输入时发送`/exit`，属于harness前置不成立，不能据此认定composer正常退出功能失败。

构建后主线程只读复核发现并发`src/components/Settings/Settings.tsx`、`src/components/Settings/Usage.tsx`已偏离冻结源码。其余manifest既有项当时一致；本任务不改动并发工作。验收对应隔离第三制品，不等于当前工作区全量通过，也不把HEAD/index或报告变化计入源码内容身份。

### 9.8 长路径 key 与详情正文输入追加修复

长路径失败已由最小校验测试复现：`long-control-key-red.log` **0/3**，Button/Select/Input分别因key超过64字符失败。只移除三处较窄的专用上限，复用既有10000字符UI字符串与总文本预算，保留control字符限制；不截断或hash文件key，保证plugin/host精确身份一致。`long-control-key-green.log` **7/0、64 expect**，含10000/10001边界、控制字符、完整ASCII/CJK key实际focus/Enter激活；随后8文件`ui-long-keys-adjacent.log` **254/0、1508 expect**，`release-check-long-keys.log` exit0。此批尚不包含下述详情修复。

只读调查确认footer在官方render tree末尾，初始bodyRows46、offset0，内容末行未进入viewport不能等同于Enter失败，也尚不证明硬裁剪。但真实树保留source Select与ask Button；旧文件控件消失后箭头误走多控件导航，原简化“单Back按钮”测试遗漏该情况。新增原形状组件红测`detail-body-focus-red.log` **0/1**，方向键未产生任何scroll；宿主snapshot现将不存在的focusedElement落到Pane正文，该状态的方向键滚动，Tab仍进入辅助控件，Select/Input自身事件消费不变。`detail-body-focus-green.log` **19/0、170 expect**，含原paced/burst/landing/取消/焦点chrome回归。

两项追加修改已纳入CHANGELOG，旧第三制品不能证明这些修改已通过compiled验收。最终8文件`ui-detail-final-adjacent.log` **255/0、1515 expect**，`release-check-detail-final.log` **exit0**。第四次`make build` exit0、内容manifest前后无变化，隔离制品`U/build-long-keys/artifact/built-claude`为 **2.1.219、100119266 bytes**，SHA-256 **`8c8bbc623de52230f12b7a542dc4ec1a7e9b83ecca6e95994c588e8d383143ae`**，保守源码digest **`6e982937ae5c745a861b6f0499812588f0fe2e664955e4b2f274b4feed9d8f23`**。此前仓库产物已保留到该build目录的`artifact/previous-built-claude`，未删除旧隔离制品。

构建provenance HEAD已因并发instructions提交前进到`dbdb97e`，不作为内容身份；未将该并发提交及Usage/compact等修改归为本任务成果或覆盖。仓库外新harness修正详情激活/三态base恢复/正常退出前置判据，并分离80列插件fallback与长文件实际正文可达性，保留第三轮raw与review，不以离线准备算交互覆盖。

### 9.9 第四制品限定补验：执行与审计结束，整体仍 failed

`runtime/harness-long-keys/preparation-result.json`记录准备完成，15项offline断言exit0，仅AST/纯谓词和历史raw只读验证。审核后固定driver SHA-256 `4f2bb49c32d5660c10fd7862647c512b5568fad69fd5fa3e5ef430730a27709a`，完整修改理由与差异位于同目录`driver.diff`。真实执行只使用第9.8节第四制品，计划串行`inline-long-keys-04`、`fullscreen-long-keys-04`、`resize-long-keys-04`，每场一次、0 retry，330秒场景deadline不变；不重跑第三轮mouse及更早ownership/bindings。

判定保留详情精确file/唯一ui.press、真实双向ui.scroll、独立footer可达性与两级Escape；base完整session→uncommitted→branch→session逐步store恢复后才执行依赖；完整ASCII/CJK key与各自正文尾部关联必须实证。正常退出先Escape释放、无Enter composer probe、Ctrl+U，再公开`/exit`；强制cleanup不计normal exit。空base可见性、窄屏原件fallback、display-cell视觉证据不足分别not covered，前置失败停止依赖。

三场执行与最终审计均已结束，索引`U/runtime/long-keys-runner-index.json`，逐项review见各场`reviewed-result.json`，raw verdict不改标。合计 **71 passed / 2 failed / 12 not covered**，整体 **failed**；normal exit **3/3**、cleanup **3/3**，CLI强制终止0次。tmux session分别为`cc-uiux-inline-long-keys-04`、`cc-uiux-fullscreen-long-keys-04`、`cc-uiux-resize-long-keys-04`，各window `0`、pane `%0`、target `<session>:0.0`。所有输入、viewport/ANSI、命令及observer记录均在对应绝对目录`U/runtime/<场景>-long-keys-04/`。

| 场景 | pass / fail / not covered | 结果与资格 |
| --- | --- | --- |
| inline | 21 / 1 / 4 | paced/burst16文件正反及exactly-once、详情精确激活通过。8 Down/8 Up都有真实scroll，offset0→1→0、viewport移动并精确返回，End后footer可达；但contentRows47/bodyRows46只有1行overflow，36个正文marker全程可见，严格“marker集合必须变化”谓词failed，归类predicate/fixture判别力，不据此认定产品滚动失效。依赖的back/reentry、rapid Escape、Rewind停止，未补跑 |
| fullscreen | 36 / 0 / 2 | source Enter为ui.select(current)；三次base Enter逐次唯一ui.press与真实store循环session→uncommitted→branch→session。恢复后验证HEAD/merge-base实际file01 patch与Git差异一致，reload、ask0→1→0、modifier、draft/dialog通过。空base可见性与focus style仍not covered，整场not covered而非全通过 |
| resize | 14 / 1 / 6 | 完整ASCII/CJK key精确一次激活并显示各自FILE17/18正文，64字符拒绝已不再复现。ASCII在160×50六次PageDown未见FILE17_MAIN220及其tail，第二次Down已显示FILE18，保留reachability failed，后续只读归因见9.10，不改raw失败；CJK只见通用tail而缺精确关联，not covered。短高/恢复/最终focus完整矩阵与display-cell视觉未覆盖，不能凭基础尺寸变更判通过 |

最小失败证据为inline目录`inline-detail-scroll.json`、`detail-down-viewport.txt`、`detail-up-viewport.txt`及`inline-footer-reachability.json`；resize目录`resize-ascii-reachability.json`、`resize-ascii-0-160x50-down-1-after-viewport.txt`、`resize-cjk-0-160x50-up-0-after-viewport.txt`。后续只读归因见9.10，未修改官方原件或追加第四场景重试。

完整性`long-keys-runner-integrity-final.json`确认三运行副本匹配8c8bbc62…，driver及准备文件、775官方原件/副本、17171项旧证据与5161项本轮raw均未变；审计最初对旧hash-only symlink schema误判已留原错误并单列修正，不涉及runtime重跑。资源`long-keys-runner-resource-audit.json`确认记录内自有同身份存活进程0，三个私有tmux/socket移除，54417/54519/54650端口关闭。fixture API的SIGTERM只算cleanup。

`U/main-long-keys-source-review.json`确认审核当时本任务10个代码/测试/静态文档匹配第四构建快照、暂存区为空、diff-check通过；另10个并发生产输入已改变，根binary也被并发替换为`3b69052788e418fb44f3d76d40bf912e726332eaffcdc541e6462bf79f9ecb6e`。仅记录边界，不恢复他人工作，不将固定binary验收说成当前工作区全量通过。未启动official/真实provider，不重跑mouse/bindings/ownership全套；旧Workflow/PTY仍阻止push。

### 9.10 长行分页归因与宿主实际高度修复

第四场景的尾 hunk 存在于运行后真实 Git patch，也已进入 observer 捕获的绘制树；不是fixture缺失。官方插件的`hooks/views/body/plan/hunk-window-of.ts:18–31`只裁掉完整源代码行，窗口落在长行中部时，`draw-window.tsx:42–54,89–98`仍绘制整条跨顶长行。本例正文72 cells，757 cells长行的预算和实际均为11行，未发现宿主折行宽度差异；顶部多重放7行，Page按32行逻辑窗口推进，随后进入连续文件流中的FILE18，尾部未出现在既定捕获内。FILE18不是选错文件的证明；小步滚动尚未验证，不声称任何操作都无法到达。官方原件未改，第四raw failed不改绿。

另有独立宿主缺陷：50行终端中dock实际正文44行，插件收到bodyRows46。新增真实`createModUi`订阅与Yoga布局红测，`dock-body-height-red.log`得到 **0/1，Expected44/Received46**。修复以ScrollBox实际viewport高度回报metrics；高度变化才redraw，同尺寸的presentation更新保留测量值，几何/placement改变重置。异步绘制错误交回现有onError，保留旧drawing并可invalidate恢复。Pane保留基础height并在dock中flexGrow，composer增长/收缩后重新分配；不改公共FullscreenLayout或Yoga算法。中间百分比height/flexBasis方案在恢复尺寸时出现父45/子47及无约束fixture控件不可见，失败日志保留，方案已撤除。独立只读审查将前者定位到`src/native-ts/yoga-layout/index.ts:1114–1131`：容器的多条目layout cache仅恢复父宽高、不恢复子布局；本轮未修改该公共算法，也不宣称通用缓存问题已修，当前保留基础height的真实高度闭环由下述矩阵单独验证。

最小`dock-minimum-layout.log` **2/0**；服务/Worker `dock-metrics-service.log` **66/0、355 expect**，包括no-op不重绘、实际budget、focus保留、109/110 placement切换、失败drawing释放与恢复。扩充有/无title及bottom5→12→3→5→25→3双向布局回归后，`dock-height-final-adjacent.log` **259/0、1590 expect、8文件**；`release-check-dock-height.log` **exit0**。CHANGELOG/README已更新，第五`make build` exit0、构建前后manifest一致，冻结`U/build-dock-height/artifact/built-claude` **2.1.219、100135778 bytes**，SHA-256 **`dd64994b28f16cdaad4bfa497c4ecd1c6fab4129bfdb10b3e6580f6847d18a69`**，source digest **`b197d80b417723b6baa9f980a6306f5e3894f8105c1a48b8499aefa6321fa73e`**。安排的独立synthetic实际高度契约与未改官方插件smoke均已各执行一次、0retry，因harness前置失败未覆盖目标，详情见9.11；未重试第四整套，不声称修复插件长行虚拟切窗。

### 9.11 第五制品高度验收收尾：harness 前置失败，目标未覆盖

两场执行及资源/完整性审计均已结束，没有待运行的本轮实验。使用9.10冻结制品`dd64994b…`，审阅结果为 **10 pass / 2 harness fail / 22 not covered**，整体`failed-harness-prerequisites`；10项通过只覆盖启动、生命周期或身份/完整性，不是高度功能通过。原始runner exit0仅表示编排完成，不能作为验收成功。权威索引与结论为：

- `/private/tmp/mods-uiux-20260919-4y11t_bu/runtime/harness-dock-height/review-index.json`
- `/private/tmp/mods-uiux-20260919-4y11t_bu/runtime/harness-dock-height/review.json`
- `/private/tmp/mods-uiux-20260919-4y11t_bu/runtime/harness-dock-height/completion.json`

| 场景 | 实际执行与失败分类 | 正常退出 / 清理 |
| --- | --- | --- |
| `height-contract-05` | attempt1/retry0。固定CLI在私有cwd启动；synthetic fixture将`$`传给`record($, …)`，loader报`capability alias/escape of $ is unsupported; do not pass capabilities to helpers`，命令未注册，随后`Unknown skill: height-contract`。属于harness fixture失败，不是高度产品红测；observer和height-fixture输出均未生成 | 公开`/exit`为0，未强杀CLI。自有进程无残留、私有socket已移除、fixture端口59641关闭。composer probe只证明无活动Pane时编辑器可用，不证明Pane释放 |
| `official-height-smoke-05` | attempt1/retry0。复制并校验775文件官方插件后，写`.git/info/exclude`前未建立父目录，Git fixture前置失败；CLI/tmux/provider均未启动 | normal exit及运行资源cleanup均not covered，不因未创建资源计通过；已准备的fixture保留作证据 |

synthetic真实命令在`U/runtime/height-contract-05/command.json`：cwd为`U/runtime/height-contract-05/workspace`，执行`./built-claude --dangerously-skip-permissions --plugin-dir <workspace>/observer --plugin-dir <workspace>/plugin --debug --debug-file <scenario>/debug.log --model claude-sonnet-4-6`。私有tmux socket为`U/runtime/s-mr29a3i0/s`，session/window/pane为`cc-uiux-height-contract-05:0.0` / `%0`，初始160×50。关键捕获绝对路径：

- `/private/tmp/mods-uiux-20260919-4y11t_bu/runtime/height-contract-05/synthetic-open-timeout-viewport.txt`
- `/private/tmp/mods-uiux-20260919-4y11t_bu/runtime/height-contract-05/normal-exit-terminal-pane.txt`
- `/private/tmp/mods-uiux-20260919-4y11t_bu/runtime/official-height-smoke-05/failure.json`

两场均未发送resize、draft或Page输入，实际高度、短屏恢复、composer增减、绘制收敛和相关焦点检查都未覆盖；不把自动化259/0替代compiled交互证据。未启动official CLI或真实provider，未修改官方插件、生产loader、旧driver/raw或attempt claim，未修后重试。旧证据与官方原件共23125项完整性复核通过，新raw hash清单见`U/runtime/harness-dock-height/new-raw-hashes.json`。

主线程提交前`U/main-dock-height-precommit-review.json`确认本任务10个代码/测试/静态文档仍与第五构建逐字节一致，conservative source无漂移、隔离binary hash一致、当时暂存区为空。并发提交使HEAD前进至`9ba61da`，但HEAD不作为内容身份。此后只回填两份不内嵌报告，不修改CHANGELOG或生产输入，不为报告更新重新构建。文档收尾`U/docs-close-check.log`为exit0，changelog格式检查与5项测试通过，`git diff --check`通过。

后续若追加高度验收，应先离线验证fixture直接使用`$.fs.write`而不传递capability，并验证Git setup完整创建`.git/info`；不能放宽生产loader、删除旧claim或换名掩盖重试。本轮保留第四71/2/12 failed、插件长行切窗缺口、通用Yoga缓存未修以及旧Workflow/PTY门禁；代码与测试已正常签名提交`9a03f53`（`fix(mods): synchronize pane focus and measured layout`，仅本任务8文件），README/CHANGELOG及两报告另按文档目的提交。**不push，不宣称全仓或完整官方parity通过**。

### 9.12 高度验收第二 attempt：官方小文件通过，synthetic 前置仍失败

用户在9.11结果交付后要求“覆盖失败”。本次只修正已确认的harness前置并补验未覆盖的高度行为，不覆盖或改绿05原始失败。`U/runtime/harness-dock-height-06`的两个场景均执行一次、runtime retry0，原330秒deadline不变。审阅结果 **33 passed / 1 harness failed / 12 not covered**，整体`failed-harness-prerequisite-partial-coverage`；不能将官方小文件通过视为synthetic或完整交互验收通过。

离线生产loader/真实Worker注册及私有Git初始化通过，旧capability逃逸与`.git/info`错误已修正。但校准只执行load/register，没有dispatch `command.run`，未经过实际`ui.open`参数边界，因而漏掉下列新fixture错误。

| 场景 | 实际结果 | 正常退出 / 清理 |
| --- | --- | --- |
| `height-contract-06` | `$.ui.open({focus:false, …})`被生产契约拒绝：`Mod UI pane focus may only be true`。应省略focus，不应放宽生产guard。尚未进入synthetic绘制，高度、草稿增长/清空和相关焦点/Page均not covered | 公开`/exit 0`；自有PID、loopback端口、私有tmux socket回收通过，无强制CLI操作 |
| `official-height-smoke-06` | 未改官方diff在本地固定CLI上限定通过。160×50→160×18→160×50时，插件budget与实际pane容量均 **44→12→44**；短屏PageDown/Up恰好一次，`by=12/-12`，可见正文改变并恢复。source/base/file焦点及激活、resize绘制收敛通过 | 公开`/exit 0`；资源回收通过，无强制CLI操作 |

44/12/44是dock标题与Debug/footer之间的**总内容容量，包含插件控件**，不是文件正文文本行数。小文件smoke不证明第四长行尾部可达性，也不是官方CLI parity。两场私有session/window/pane为`cc-uiux-height-contract-06:0.0`与`cc-uiux-official-height-smoke-06:0.0`（各自socket的`%0`）。关键证据：

- `/private/tmp/mods-uiux-20260919-4y11t_bu/runtime/harness-dock-height-06/review-index.json`、`review.json`、`completion.json`
- `/private/tmp/mods-uiux-20260919-4y11t_bu/runtime/harness-dock-height-06/official-physical-audit.json`
- `/private/tmp/mods-uiux-20260919-4y11t_bu/runtime/official-height-smoke-06/height-short-viewport.txt`
- `/private/tmp/mods-uiux-20260919-4y11t_bu/runtime/official-height-smoke-06/workspace/ui-observer.json`

沿用第五隔离制品`U/build-dock-height/artifact/built-claude`，SHA-256 `dd64994b28f16cdaad4bfa497c4ecd1c6fab4129bfdb10b3e6580f6847d18a69`，未新建制品。`U/main-height-06-preflight-identity.json`在启动时确认本任务10文件未变，三个Usage生产文件已有并发漂移；仅限定固定制品，不覆盖当前HEAD。旧证据与775文件官方原件完整性通过，未启动official CLI或真实provider，未修改仓库生产代码，未push。

### 9.13 Synthetic 第三 attempt：精确高度通过，wrapped 输入前置失败

新`U/runtime/harness-dock-height-07`省略非法`focus:false`，保留05/06原件、失败与claim，不重跑已通过的官方小文件。真实production loader/Worker/host执行`session.start → command.run → ui.open → ui.render/resolve`、focus/press/scroll离线校准通过，并以旧06 `focus:false`做真实生产边界negative control；省略focus默认不抢焦。离线最终 **10/0**，两次离线harness失败保留（嵌套sandbox与异步invalidate绘制等待），均发生在CLI启动前，不能算runtime验收。

`height-contract-07`真实tmux仅一次、runtime retry0、330秒deadline不变；审阅 **16 passed / 3 harness failed / 6 not covered**，整体failed。原始计数17/2/6保留：`draft-wrapped`原来仅凭几何记passed，但其声明还要求建立换行草稿并缩小预算，审阅纠正为failed，而不是改绿旧失败。

| 阶段 | 物理容量 / budget | 判定 |
| --- | --- | --- |
| 160×50初始 → 160×18 → 160×50恢复 | **44/44 → 12/12 → 44/44** | HEAD/BODY/TAIL逐行连续精确匹配，title不计入，通过 |
| 未提交三行草稿 → 清空 | **42/42 → 44/44** | 草稿可见；Tab未产生person pane操作，模型请求0，清空后editor为空 |
| 900字符单逻辑行输入 | 44/44 | 几何仍一致，但输入被折叠为`[Pasted text #1]`，没有建立wrapped草稿；此目标failed，不能算高度回归 |

生产`src/components/PromptInput/PromptInput.tsx:1777–1815`正常将超过`PASTE_THRESHOLD=800`的paste折叠；阈值位于`src/utils/imagePaste.ts:30`，与冻结制品输入一致。07只校准UI调用链及Cursor，未覆盖实际PromptInput paste折叠路径。另有退出harness错误：失败路径未先清理残留pill便输入唯一probe，实际editor为`[Pasted text #1]HEIGHT07_EXIT_COMPOSER_PROBE`，严格前置拒绝正常退出；cleanup阶段interrupt/clear后`/exit 0`不算normal exit。自有进程、61312端口及私有socket回收通过。完整双草稿ownership/clear、运行时Tab/Enter/Page、全流程收敛及normal exit仍not covered；已测阶段收敛不替代完整流程。

session/window/pane为`cc-uiux-height-contract-07:0.0` / `%0`，socket为`U/runtime/s-ajyecm1t/s`；命令/cwd在`U/runtime/height-contract-07/command.json`。权威证据：

- `/private/tmp/mods-uiux-20260919-4y11t_bu/runtime/harness-dock-height-07/completion.json`、`review.json`、`review-index.json`
- `/private/tmp/mods-uiux-20260919-4y11t_bu/runtime/harness-dock-height-07/synthetic-physical-audit.json`、`failure-analysis.json`、`resource-audit.json`
- `/private/tmp/mods-uiux-20260919-4y11t_bu/runtime/height-contract-07/draft-wrapped-viewport.txt`
- `/private/tmp/mods-uiux-20260919-4y11t_bu/runtime/height-contract-07/exit-composer-probe-visible-viewport.txt`

`U/main-height-07-preflight-identity.json`确认固定`dd64994b…`未变，但当时并发`ModsPane.test.tsx`及9个生产文件（包括`FullscreenLayout.tsx`）已漂移；不触碰、不将冻结结果套当前工作区。05/06及775原件hash未变，模型请求0，没有重建、official CLI或真实provider。

### 9.14 Synthetic 第四准备 attempt：输入链源码漂移，未启动 runtime

基于07已定位的两个harness错误，追加新`harness-dock-height-08`/`height-contract-08`，不是新制品，也不掩盖第四attempt。将单逻辑长行改为约600字符：低于800折叠阈值但仍需跨多个160列物理行；必须先通过真实PromptInput输入/paste路径离线校准，不只用Cursor推算。保留完整production UI链校准，退出路径在probe前先用正常编辑键清理残留并确认editor空；不改产品paste行为、不放宽exact editor断言。

08已停止在离线门槛，**runtime0次，15项not covered**，normal exit/cleanup均not covered；没有创建CLI/tmux资源，不把未创建资源算cleanup通过。Mods完整链及driver离线 **14/0**；PromptInput身份前置 **0/1**、行为 **0/0/3**。首次错误地对全仓身份设门槛的结果保留并纠正为局部真实输入链；后续32模块中31一致，仅关键`PromptInput.tsx`从冻结`a7d212e0…`变为并发`1f3a860c…`，因此未执行真实组件import/render。嵌套sandbox、路径后缀等离线harness失败保留，均不能计为产品失败。权威结论为`U/runtime/harness-dock-height-08/completion.json`及`prompt-input-calibration.result.json`，旧05/06/07及775原件4243项完整性检查通过。

### 9.15 冻结源码镜像补验：wrapped 通过，按钮字段谓词失败

主线程已用`git show 9a03f53559bf05a2ceead7dcb61765830d1504af:src/components/PromptInput/PromptInput.tsx`核对SHA-256为冻结值`a7d212e0f1a210a76e12c6ed3894a5319b6be6d107653845aa44403ec551a50f`。新`harness-dock-height-09`通过只读Git对象建立仓库外源码镜像，真实校准链逐文件与第五build manifest比对；不恢复工作区、不创建worktree、不改冻结基线、不重建。准备attempt计为第五，若离线通过后启动`height-contract-09`，才是第四次实际synthetic runtime（05/06/07已运行，08未运行）。

09已完成一次runtime，第五准备attempt/第四实际synthetic runtime，330秒deadline及8秒stage不变，审阅 **22 passed / 1 harness failed / 2 not covered**，整体failed。校准镜像相关链1272文件符合冻结hash，归档2590文件前后字节未变；并非宣称整个Git snapshot等同build manifest。Mods/driver离线14/0，真实PromptInput为1测试/25断言、三项指定行为通过：600字符完整四行且无pill、8次Ctrl+U清空；900字符正常pill；残留清空后未提交probe再清空。原`DRAFT09_WRAP_`实际13字符，已修harness为587个x取得精确600，旧离线失败保留。

runtime通过精确 **44→12→44**、wrapped **44→41→44**、完整四行editor、非空Tab无pane操作/零API、清空及空Tab精确落点。Enter后实际一个`ui.press`、一个fixture callback、44行全`P1`；但driver误要求`event.input.origin.kind === 'person'`，而冻结`src/services/mods/ui.ts:903–922`将origin放在dispatch options，不放input。保留原failed，分类`confirmed-harness-event-payload-contract-mismatch`，不改生产payload、不事后改绿。依赖的Page双向和全场收敛未覆盖。公开`/exit 0`与cleanup均独立通过。

证据入口为`U/runtime/harness-dock-height-09/review-index.json`、`completion.json`、`synthetic-physical-audit.json`、`failure-analysis.json`、`source-snapshot.provenance.json`；session/window/pane为`cc-uiux-height-contract-09:0.0` / `%0`，命令/cwd及输入捕获位于`U/runtime/height-contract-09/command.json`与`inputs.json`。沿用固定第五制品，未重建，未启动官方CLI或真实provider，05–08原证据及775原件未变，当前HEAD不qualified。

### 9.16 按钮与 Page 最小补验（第六准备 attempt，限定通过）

10仅修正press payload谓词：以真实生产派发记录校准plugin/element/component/requestId/surface、事件和callback各一次及物理全P1；`origin`不属于press input，不能伪造该字段。focus/scroll仍严格验证其真实input.origin。增加重复事件/错误目标或request/重复callback/P2等负例；无pane输入的断言不能因press/select/input没有origin而漏检。

复用09已hash核对的只读source镜像和固定`dd64994b…`。`harness-dock-height-10`已完成唯一一次`height-contract-10`，第六准备attempt/第五实际synthetic runtime，runtime retry0，330秒deadline及8秒stage不变。离线真实生产调用链、共享predicate和负控 **50/0**；runtime与审阅计数均为 **21 passed / 0 failed / 6 not covered**，限定补验`passed`，完整高度矩阵仍`not covered`。6项是预声明not rerun：`height-short`、`height-restored`、`draft-multiline`、`draft-wrapped`、`draft-nonempty-owner`、`draft-clear-restores`；没有以删除检查项方式宣称全覆盖，也没有重跑06官方或09 PromptInput三行为。

- open后收敛到44行，HEAD/BODY/TAIL逐行匹配；空composer一次Tab精确聚焦`height-probe`，一次Enter只产生一个before-phase `ui.press`和一个fixture callback，所有物理marker均为P1。
- PageDown/PageUp各一次，真实`ui.scroll`的`by`精确为 **+44/-44**，fixture状态与物理marker offset均 **0→44→0**，保持P1。synthetic自管虚拟offset；host input.offset为0，不能替代fixture/物理位移判定。
- 十个阶段收敛，render共8次，无React #185/Maximum update depth；Escape交还composer，清空→未提交probe→清空期间无pane输入、模型请求0。
- 公开`/exit`在cleanup之前正常退出0；自有进程、53653端口、私有tmux session/socket清理独立通过，不以清理代替正常退出。独立审阅 **26/0**，旧证据与只读源码链等7720项完整性检查无变化，09原failed及官方775原件保持。

session/window/pane为`cc-uiux-height-contract-10:0.0` / `%0`，160×50；socket为`U/runtime/harness-dock-height-10/s-1uvt959y/s`，cwd为`U/runtime/height-contract-10/workspace`。启动使用该目录中固定binary的`./built-claude --dangerously-skip-permissions`及两个私有`--plugin-dir`，完整argv见`command.json`。关键绝对证据路径：

- `/private/tmp/mods-uiux-20260919-4y11t_bu/runtime/harness-dock-height-10/review-index.json`、`completion.json`、`review.json`
- `/private/tmp/mods-uiux-20260919-4y11t_bu/runtime/harness-dock-height-10/driver-contract-calibration.json`、`synthetic-physical-audit.json`、`resource-review.json`、`integrity-final.json`
- `/private/tmp/mods-uiux-20260919-4y11t_bu/runtime/height-contract-10/command.json`、`inputs.json`、`focus-activation.json`、`page-bidirectional.json`
- `/private/tmp/mods-uiux-20260919-4y11t_bu/runtime/height-contract-10/page-down-after-viewport.txt`、`page-up-after-viewport.txt`、`normal-exit-terminal-process.txt`

### 9.17 高度补验收口与仍未解除的门禁

| 本次目标 | 对应真实证据 | 范围 |
| --- | --- | --- |
| 未改官方diff小文件高度/缩放/Page | 06：pane容量与budget **44→12→44**，Page ±12、焦点、收敛通过 | 本地第五制品加载官方插件，不是官方CLI parity |
| Synthetic精确行数与多行草稿 | 07：HEAD/TAIL **44→12→44**；三行草稿 **44→42→44** | 07整场仍failed，不改原退出/折叠失败 |
| 完整wrapped草稿、输入所有权、清空恢复 | 09：600字符完整四行，**44→41→44**，非空Tab不抢焦、零API | 09整场仍failed；按钮谓词错误及依赖未覆盖保留 |
| 按钮恰好一次、Page双向、收敛与正常退出 | 10：一个press/callback，全P1，offset **0→44→0**，exit0/cleanup分别通过 | 21/0/6，6项not rerun；不替代其他场景 |

以上是**同一第五固定制品的分场景限定证据**，不相加成总体通过率，不宣称一次完整流程、全仓、官方parity或当前HEAD全量通过。05–09原判定/raw不改，08仍runtime0。主线程再次核对binary SHA-256为`dd64994b28f16cdaad4bfa497c4ecd1c6fab4129bfdb10b3e6580f6847d18a69`。并发提交`5c75cbf`已改变fullscreen dock布局，后续HEAD及dirty输入不在本次冻结制品验收范围；不恢复或暂存并发工作。

本次只修仓库外harness并回填这两份不内嵌报告，未再改生产协议、README/CHANGELOG、依赖、版本或CI，无新build，未启动官方CLI或真实provider。报告检查`U/docs-height-followup-check.log`为5 pass/0 fail、exit0；签名提交前另做最终diff检查。此前259/0、release-check与build属于第五制品冻结基线，不冒充当前HEAD重测。

**本轮限定补验已结束，不再启动runtime。整体仍未通过，不push。** 第四制品长行尾部/Page严格谓词、依赖的rapid Escape/Rewind及其他未覆盖项仍保留；公共Yoga子布局缓存未修，旧Workflow timeout/PTY退出码异常继续阻止整体推送。仅正常签名提交`mods-test.md`与`handoff.md`，不混入两份cross-session草稿、并发源码或原始证据。

## 10. 可复用测试 Mod 与官方原件调试（2026-09-19）

### 10.1 范围与输入

本轮新增可长期加载的 `examples/mods/mods-test-lab`，以及 `scripts/mods-test-lab.mjs` 下载/检查/隔离启动入口，不扩展宿主 API 或调整官方 diff 内容 pin。基线为 `b65ed5482d74d4e6f122babbb50284254213d651`，证据根 `L=/private/tmp/mods-test-lab-20260919-d2mvP8`。原工作区并发的 `/tui`、内置 diff 和两份跨 session 草稿不混入；从 HEAD archive 导出镜像并只叠加本任务文件，不建 worktree，不覆盖仓库共享 binary。

官方来源固定为 `anthropics/claude-code@bf7d404e26a5fb6167d21b46c93a2bf6c22ab274`，包含 `diff`、新增的 `agents-md`、`sec-default`、`telemetry` 四个 Mod，各 manifest 版本为 `0.1.0`。下载的完整子树与作者类型保留在仓库外，记录逐文件 SHA-256 与内容摘要；扫描、准入、activation、实际触发分别判定。

### 10.2 自动化与终端方案

1. 直接加载样例文件，通过真实 discovery → prepare → loader → Worker；启动不打开 Pane，注册 `/mods-test`。检查 Button/Input/Select/scroll/close、工具 core 恰好一次、context 只附加到下一真正 prompt、reset、20 条事件上限与敏感 canary 不进入日志。
2. 检查同内容 reload 不重复 activation，卸载后旧命令/Pane/callback 失效，重新启用建立新 activation 并保留约定的 JSON store。使用完整外部作者声明严格编译，不用内部类型替代官方契约。
3. 脚本测试覆盖缓存重复执行、损坏/中断恢复、路径与内容校验、拒绝清理活跃/非自有/封存 run。测试网络使用本地替身，不连接统计服务。
4. 对四份官方原件执行真实加载诊断；`diff` 只有生产允许覆盖 builtin 时才计功能通过，`agents-md` 缺失能力必须原样报告，`sec-default` 不伪造 managed tier，`telemetry` 不连接真实 analytics。
5. 在隔离源码上执行目标 Bun 测试、`make release-check`、`make build`。记录构建输入清单与新 binary SHA-256，不继承旧制品结果。
6. 专用 agent 驱动私有 tmux，先无插件 readiness，再 sample UI-only 与 loopback prompt → 一次只读 Read → turn.complete。sample 与可激活官方 diff 分别覆盖 inline/fullscreen、宽窄 resize、键盘/滚轮及 disable/reload/enable；未送达操作记为未覆盖。

隔离使用独立 HOME/config/XDG/TMP/cwd、白名单环境、fake key 和 loopback；真实 Keychain 与非 loopback 网络禁用。临时 PATH 前置 `security` 返回 44；`git init --template=` 后显式创建 `.git/info`，不使用会关闭插件的 `--bare`/simple/disableAllHooks。正常 `/exit` 与 forced cleanup 分别判定，异常 driver 必须非 0；未启动不能靠空 cleanup 获得通过。

### 10.3 官方原件与静态诊断

最新四个 Mod 及 `types` 共 **1002 个文件**，位于 `L/official-reviewed`（diff 785、agents-md 75、sec-default 60、telemetry 81、types 1）。原件内容清单见 `official-reviewed-inventory.json`，摘要为 `4ffdc50d53734ff67c379d6e82603caa423e1dd01e4cadad246dbcb78972e930`。下载归档 SHA-256 为 `296ee841da509853f8b0aba1181f1da15e0f318264245a78790cb4b57fe8d552`。这些原件未改写或重命名。

冻结生产 loader 诊断（`official-scan.json` / `official-scan.log`）：

| Mod | 扫描结果 | 尚不能声称的覆盖 |
| --- | --- | --- |
| diff | 拒绝：`unsupported core capability env.get` | 最新版不能激活；尚未进入 builtin 内容 pin 检查 |
| agents-md | 拒绝：`unsupported core capability session.root` | 未执行 AGENTS.md context 或 Read 注入 |
| sec-default | 扫描成功，21 模块、13 事件、`settings.read`、`next.to(..., 'append')` | 扫描不等于运行准入，更不等于 managed 组织策略 |
| telemetry | 拒绝：`unsupported core capability session.authorize` | 未建立统计 noun、未发送统计事件 |

随后通过实际 launcher 完成 discovery → prepare → loader 五目标检查，见 `L/launcher-checks.json`。**agents-md 在正常插件入口更早失败**：manifest 的 `userConfig.instructionFiles.options` 不被本地 schema 接受（`Unrecognized key: "options"`），尚未进入 loader；上表 `session.root` 是直接扫描入口的独立诊断，不能混为正常加载阶段。sample 与 sec-default 的 discovery/preparation/scan 通过，其余结果与上表一致；`check` 明确将 admission/activation/trigger 标为 not-run。

可复用官方下载缓存为 `/Users/esonhugh/Library/Caches/mods-test-lab/official/bf7d404e26a5fb6167d21b46c93a2bf6c22ab274/snapshot-d2vE20/mods/<name>`，四个名称同上，类型在 `mods/types/claude-code.d.ts`。launcher 清单摘要 `478cdc17e1fd526164b2e7f3bcf54bfa74e7af5347ae80ba0c040a00dd6c015b` 包含 path/size/sha256，和独立归档清单格式不同；`L/download-crosscheck.json` 已确认全部1002文件的路径/字节 SHA-256 相同。第二次 fetch 为 `reused:true`，未再次下载。五份 `check` 的私有 run 均加 `SEALED` 保留，不由 clean 删除。

另下载旧固定提交 `f96c3b49c4c8721685206aaab23609b2d399df4e` 到 `L/official-supported`，仅作历史支持对照，diff 775 文件（连同 sec-default 和类型共 836 文件，inventory 独立）。冻结 HEAD 的完整作者类型/Worker/loader 两文件回归为 **100 pass / 0 fail / 245 expect**，官方 fixture 和本轮完整公开类型均实际配置，未 skip。先前缺少 fake key 的批次为99/1，保存在 `supported-official.log`；补齐隔离 runner 的 fake key 与 loopback endpoint 后通过，未更改断言或产品实现，见 `supported-official-qualified.log`。新官方类型的作者契约单独1/0不与这一批重复相加。

### 10.4 执行状态

样例与入口已实现，样例/官方有界终端验证已结束，launcher独立启动验收单列；当前不构成整体通过报告。隔离前置已实测 empty-keychain exit44 与 Git `.git/info` 创建；最初 inline `bun -e` 校准被 shell 转义干扰，未启动 CLI，改用文件脚本后成功，两份日志保留。既有插件发现/UI/准入基线三文件45/0、174 expect。

样例测试直接读取仓库的 manifest/hooks/register.ts，真实 Worker 的 **7 个子测试全部通过，249 expect**；覆盖启动无 Pane、Button/Input/Select/scroll/stale callback、纯 render、工具 success/error 透传且 core 恰好一次、一次性 context、reset、事件/输入上限、canary、disable/enable 与完整官方作者声明。父包装单独1/0，不与子测试重复计数。九文件相邻回归为 **219 registered pass / 0 fail / 566 expect**，子进程7/0另列，见 `L/mods-adjacent.log`。

首次新增样例的 `make release-check` 在 `testLab.test.ts:140` 报 TS2352：测试只提供命令桥接实际读取的 `abortController/modCommand`，却直接转完整 `LocalJSXCommandContext`。原失败保留于 `L/sample-release-check.log`；修正为 `satisfies Pick<...>` 校验实际字段，再明确转换测试 double，不改生产接口或断言，复验结果单独记录。

冻结宿主构建与版本检查已完成，`make build` exit0，版本2.1.219，初始制品 `L/artifact/built-claude` SHA-256 `ca066924ce48976c590b22e97f09c73f3a816152894c1cd26d75ccf9b7fc27e3`。宿主2742文件清单为 `host-source-manifest.json`。这是未叠加新样例/脚本前的宿主制品，不能当成最终新增文件检查；不覆盖共享根目录产物。并发工作已开始调整真实工作区 `src/services/mods/runtime.ts` 的 builtin diff 冲突规则，本轮不恢复、不混入该修改；旧diff覆盖资格只对冻结基线和指定 binary 有效。

最终叠加样例、测试、launcher 及 README 后，`L/final-release-check.log` 与 `L/final-build.log` 均 exit0。`audit:missing` 报告10个既有测试字符串 fixture 相对引用，src 导入/文本资产/类型模块缺失为0，目标正常退出。`git diff --check` 通过显式 `GIT_DIR/GIT_WORK_TREE` 检查真实工作区，不把 archive 误称为 Git worktree。2746文件构建内容摘要 `aa83b3352d0529726db4cb5138d31c3512cc0a85cf4390562f684afbf6bddc0b`，构建前后未变；动态 `mods-test.md`/`handoff.md` 和运行输出不进入源码身份。最终 `L/artifact/final-built-claude` 为100432994 bytes，SHA-256仍为 `ca066924ce48976c590b22e97f09c73f3a816152894c1cd26d75ccf9b7fc27e3`，与全部本轮 runtime 使用的初始制品逐字节相同，见 `L/final-artifact.json`。

修正后的 sample 在冻结源码和实际工作区分别 **7/0、249 expect**，完整类型无 skip，见 `sample-fixed-qualified.log`、`sample-current-workspace.log`。中间一次误把完整类型路径写成 `official-reviewed/mods/types` 导致 TS6053，原 `sample-fixed.log` 保留；实际提取路径是 `official-reviewed/types`，修正参数后通过，不改声明。launcher 最终离线测试 **14/0、111 expect**，包含真实 sandbox discovery、空 security 44、真实 security EPERM 与清理边界，主线程复验见 `launcher-main-review.log`。将其并入九文件的外层sandbox时，launcher测试固定使用短 `/private/tmp/mods-lab-test-*`，不在外层只允许L写入的范围内，12项在mkdtemp处EPERM，合批结果 **221/12** 保留于 `final-mods-adjacent.log`，不能称十文件全通过。没有扩大sandbox写权限或跳过断言；九文件在原隔离内复验 **219/0**（`final-mods-nine.log`），launcher保持其独立真实sandbox测试的14/0，分别报告。

### 10.5 样例真实终端结果

证据索引 `L/runtime-sample/evidence-index.json`，限定审阅 `qualified-summary.json`，原三个 driver/result 的失败与非0退出保留。只运行本地冻结制品，不是官方 CLI parity；三个场景各240秒上限。样例通过私有 filesystem marketplace 原样加载，UI inline/fullscreen 不代表这三个场景使用 `--plugin-dir` 入口，launcher 另验。初始 Git 前置因祖先目录 metadata 被 sandbox 拒绝而未启动 CLI，最小调整 fixture 后三场实际启动。

| 场景 | 实际通过 | 失败或未覆盖 |
| --- | --- | --- |
| inline UI | Button 单次Enter计数0→1；Select切CJK；PageDown可见行变化；宽窄恢复；Close/Escape；同内容reload保留；disable/enable后activation 1→2与持久计数 | bulk literal Input 丢失：`input=0,length=0,submit=1`；wheel坐标落在Pane外，未覆盖；禁用前Pane已关，未证明活动Pane/命令撤下 |
| fullscreen UI | 同上；正常 `/exit` 0，UI请求0 | 已等待焦点及文本落地后Input仍同样失败；wheel落在dock外且Page已到尾，不定为产品滚轮缺陷 |
| loopback API | 真实prompt→恰好一次只读Read成功→turn.complete；显式context仅下一个新prompt附加；后续请求不重复注入；正常 `/exit` 0 | 不是真实provider；原谓词错误地计入辅助请求导致driver非0，限定审阅按原请求内容证明目标通过，不改原失败 |

API场共7请求：4 primary、3辅助；一次Read发出且一次成功tool_result。`api/qualified-api-analysis.json` 给出实际请求路径：`SAMPLE_CONTEXT_NEXT`的新用户context含一个marker，`SAMPLE_CONTEXT_FOLLOW`的新context无marker，旧conversation中的历史marker保留不是再次注入；system均无marker。辅助无tools的title请求被fixture误做schema检查，返回惰性文本，不等同于Read schema失败。

inline正常退出失败属于harness：过早命中旧status后在最新命令完成前发 `/exit`，变成模型输入并产生2个loopback请求；其后只强制回收自有资源，不能算正常退出通过。Fullscreen/API正常退出通过。`final-cleanup.json` 确认三个自有server/PID/socket与端口均已回收，binary/sample哈希与Git fixture不变。

关键实际标识：`sample-inline-20260919:0.0 %0`、`sample-fullscreen-20260919:0.0 %0`、`sample-api-20260919:0.0 %0`；socket均为对应场景目录的 `tmux.sock`。输入见各目录 `inputs.jsonl`/`commands.jsonl`，Input失败直接证据为 `L/runtime-sample/fullscreen/05-input-submit.pane.txt`。**样例交互整体仍failed**，不以单测通过掩盖终端Input问题；单字符输入与paste差异、Input根因、有效wheel坐标补验不在本轮追加执行。

### 10.6 官方原件真实终端结果

索引 `L/runtime-official/index.json`，逐断言 `assertions.json`，总判定 `summary.json` 为 **failed，driver exit1**。无插件readiness加三个实质场景均使用冻结宿主；没有官方CLI或真实provider。最新原件在compiled UI中重现 env.get、manifest options、session.authorize 三项诊断；sec-default显示 user scope Enabled且无准入错误，但未独立证明Worker生命周期或managed政策效果。

旧 `f96c3b4` diff 仅作冻结宿主兼容对照：

- inline：六个变更文件列表、中文文件选择、resize、disable/reload→0与enable/reload→1通过；详情持续 `Loading diff…`，hunks失败，详情Page/wheel未覆盖。
- fullscreen：dock显示与中文文件选择、长中文新增行、PageDown/PageUp、pointer wheel可见视口变化、140×38 resize、disable/reload撤dock与enable/reload恢复plugin计数通过。wheel仅证明视口变化，不宣称逐tick精确行数或完整像素布局。
- 四个实际CLI（含readiness）均正常 `/exit` 0；初次legacy-inline被fixture目录metadata拒绝，CLI未启动，独立 `legacy-inline-2` 保留修正后的证据。所有自有PID/server已结束，确认server不存在后移除残留socket，见 `cleanup-final.json`。原件1002+836文件及binary最终哈希一致，见 `integrity-final.json`。

readiness首次fixture把整个fake key放入approved，而非末20字符，导致确认提示等待；不重启CLI，完成同场prompt/exit，但原readiness无干预谓词仍failed。误输入冻结CLI不存在的 `/mods` 曾触发session-title API，closed `127.0.0.1:1` 拒绝连接；所以“零API尝试”failed，不能说完全无请求尝试。私有配置内也发生marketplace自动安装尝试，被sandbox阻止，不是用户真实配置读取或外网成功。

关键标识：`mods-readiness:0.0 %0`、`mods-latest:0.0 %0`、`mods-legacy-inline-2:0.0 %0`、`mods-legacy-fullscreen:0.0 %0`；socket为各目录 `s`。实际输入在各 `commands.jsonl`，三个加载错误见 `L/runtime-official/latest/12-errors-viewport.txt`，inline卡住见 `legacy-inline-2/07-detail-timeout-viewport.txt`，fullscreen通过的hunks/Page/wheel见17/20/22/24/26/28号viewport。并发工作区已改变builtin diff规则，这些旧diff结果不能套用到当前dirty宿主。

### 10.7 新启动入口与清理验收

通过仓库实际 `bun scripts/mods-test-lab.mjs run sample --cache <L下短目录> --binary L/artifact/built-claude` 启动，未改script或sample。首次driver误将workspace trust选择箭头当作prompt，status没有执行；原失败保留，自有进程停止且run保留 `L/re1/runs/r-df39ac3d81b1`。修正harness readiness谓词后的独立attempt2六项通过：真实prompt、`/mods-test status`返回activation1/command1/tool-prompt-turn0、active clean exit1并保留run、`/exit`正常exit0、stopped clean exit0删除run/socket、相邻53份证据哈希不变。整个两次入口实验在240秒上限内；第一场不计通过，不混入sample完整UI验收。

有效标识 `mods:0.0 %0`，socket为 `L/re2/runs/r-80444fd47fae/tmux.sock`（已清理）。输入严格为自有fixture trust确认Enter、`/mods-test status`+Enter、`/exit`+Enter。Plugin inventory SHA-256 `2fa98997e5d8400a3405ecbcddfe0c1b708c5567d0f3d094dd30b74c0d19a2b2`，launcher SHA-256 `4d0883f37fcdb64f83a1be69a9a3c13632ddcff6eb8a6c7e572494bdb293dfc8` 前后未变。完整索引 `L/run-entry-evidence/evidence-index.json`，实际summary为 `attempt2/02-status-pane.txt`，退出/清理为 `attempt2/04-exit.json`、`attempt2/05-cleanup.json`。

可复制的已验制品入口：

```bash
bun scripts/mods-test-lab.mjs run sample \
  --binary /private/tmp/mods-test-lab-20260919-d2mvP8/artifact/final-built-claude
```

按输出attach命令连接后，先确认**打印路径确为工具自己的私有fixture**，再处理workspace trust提示；`run`只创建session，不代替用户确认。宿主仍会尝试默认marketplace HTTPS/SSH自动安装，sandbox下失败并显示footer；本轮未改生产自动安装逻辑，不能声称零外部访问尝试，未观察到成功外部provider请求。正常退出后使用相同cache的clean，需保留证据时先按输出seal，SEALED目录不会删除。

本轮实现、限定验证与报告已收口，所有执行agent已结束；发现的Input/旧diff问题留待单独定位。**整体交互仍未通过**，历史 Workflow/PTY 与 Mods 未覆盖项继续保留；没有commit/push，也不解除整体门禁。

## 11. Mods 宿主输入、Pane reopen 与 builtin 让位修复（2026-09-20）

### 11.1 范围与归属

已通过 `/tmp/diff-mod-fix-message` 与 native diff session 确认分工。本节仅验收 Mods 宿主；native DiffController/DiffView、REPL、immediate 接线及其新测试由另一 session 独立负责，不用本节结果宣称其通过。

- `KeyboardEvent` 保留明确的 `text`/`isPasted`，不以 key 名长度猜测文本；ModInput 先消费文本，literal `return`/`tab` 不会当特殊键。实时 ref 保证同批输入及紧随其后的 submit 使用最新值。
- `parseMultipleKeypresses` 分开普通 bulk chunk 内的控制键与文本；bracketed paste 内的 CR/Tab 保留为字面内容，不触发提交/移焦。方向键、F-key、未知协议键和 Ctrl/Meta/Super 组合不插入 Input。
- 同 owner/id 的存活 Pane 在插件 resize/reopen 后保留 `personInitiated`；close/unload/reload/candidate-release 后不继承，也不扩大焦点权限。
- builtin 名称/alias 仍拒绝注册，文案对齐官方 `refused: it is the built-in /` 契约。移除无生产调用方的 `allowBuiltinConflict` 入口及专用状态；官方正常让位静默，真正注册异常仍可观察。
- 官方 2.1.272 制品内置 native `/diff`，公开 diff Mod 是 builtin 缺席时的替代实现。旧 `f96c3b4` Mod 的 inline Loading 根因为列表/正文加载集合不一致及 fixture baseline 时序；不改官方原件、不改名、不恢复覆盖来绕过，不把它归为 native 缺陷。

### 11.2 红绿与自动化

证据根 `F=/private/tmp/mods-host-fix-20260920-4016xq6q`。

| 检查 | 结果与边界 |
| --- | --- |
| 新增真实 stdin 首轮 | 1 pass / 8 fail：bulk/CJK/paste/literal key name 丢失或误判，同批输入后 submit 读旧值；真实 Tab 控制组通过 |
| 冻结原生产代码的最终输入红测 | `F/input-red.log`：1 pass / 34 fail，含事件契约与 backspace/empty paste；没有跳过或弱化失败断言 |
| 输入事件、ModsPane、默认键绑定 | 工作区 `F/input-tests.log` 与冻结构建源码 `F/frozen-input-tests.log` 均为 114 pass / 0 fail / 732 assertions，包含 11 条新增真实 stdin 控件场景；两次运行不相加 |
| Pane reopen、commands、runtimeHost | `F/host-tests.log`：95 pass / 0 fail / 464 assertions；官方原件及完整作者 types 显式启用，0 skip |
| 真异常可观察 | 官方原件遇到模拟 command catalog 故障仍调用 uiLog；正常 builtin 拒绝则日志为空，native core 恰好执行一次 |
| Worker UI、uiRealm、sample | `F/mods-adjacent.log`：外层 27 pass / 0 fail / 115 assertions；sample 子进程 7 pass / 249 assertions 另计，完整作者类型校验实际执行 |
| PromptInput Escape 与键绑定相邻 | `F/input-adjacent.log`：16 pass / 0 fail / 144 assertions；与默认键绑定组合有重叠，不相加宣称独立总数 |
| launcher | `F/launcher-tests.log`：14 pass / 0 fail / 111 assertions |

Pane 最小红测为 0 pass / 1 fail；builtin 契约及旧绕过参数红测为 0 pass / 2 fail；官方原件静默让位红测为 0 pass / 1 fail。修复后均转绿；另在冻结原生产代码重跑四例，`F/host-red.log` 为 0 pass / 4 fail，随后已恢复并核对镜像内容。开发中曾漏写 `React.useRef` 命名空间而导致组件挂载失败，已修正并重跑完整 114 项，不以过滤失败当通过。

官方原件入口为 `/private/tmp/mods-test-lab-20260919-d2mvP8/official-supported`，完整声明为同证据根 `official-reviewed/types/claude-code.d.ts`。本轮不扩展最新官方 Mod 所需的 `env.get`、`session.root`、`session.authorize` 等能力，第 10 节限制仍有效。

### 11.3 构建身份与终端验收

从 `303d0ce451a8e9a513c24dde34526af95b92fa1c` 的 Git archive 建独立镜像，仅叠加本节宿主修复及既有 sample/launcher；不混入并发 native/model/API/Agent 改动、不覆盖共享 `built-claude`。2758 个内容记录见 `F/source-inventory.json`，排除动态 `handoff.md`/`mods-test.md`；源码摘要 `fded438c4f7d47e748121d724fd5e78ab7d5a49e9e1cdec9af378a9f03f9c397`，构建后无漂移。

- `make release-check`：exit 0，含 TypeScript、lint、changelog、audit 与 diff 检查。
- `make build`：exit 0，制品 `F/source/built-claude`，2.1.219，100432994 bytes，SHA-256 `f5bfe62a03a6ba05666ec98195e9ad09b8a4af0bf7d47234652c865203c1df26`。
- 单独 lint 无错误，ModsPane 三条既有 React hooks warning 未扩域处理。

### 11.4 新制品真实 tmux 结果（整体未通过）

四场运行已结束。**核心 Input 修复通过，但视觉验收仍有失败，不能报全绿。** 索引为 `F/runtime/evidence-index.json`、`command-index.json`，逐项结论为 `qualified-summary.json`；最小复现为 `minimal-reproduction.txt`。本轮未启动官方 CLI，不称官方 CLI parity。

| 项目 | inline | fullscreen |
| --- | --- | --- |
| bulk `sample-input`、CJK、bracketed paste 后紧随 Enter | passed：准确非空内容及计数 | passed：准确非空内容及计数 |
| literal `return`/`tab` 与真正 Enter/Tab | passed：字面文本不提交/移焦，真正键仍提交/切换控件 | passed |
| Button exactly-once、Select CJK、关闭按钮与 Escape | passed | passed |
| `140×45 → 58×35 → 140×45` Pane/输入/计数保持 | passed | passed |
| 中间列表视口、真实 Pane 坐标 wheel | not covered：重测有行变化，但未建立中间列表前置 | passed：`(76,24)`、Row 16–59 中间视口 |
| 窄屏控件区域无重叠 | **failed**：Events/help 叠入 Count/Input；独立通用布局复现见 11.5 | not covered：窄屏时显示列表，未显示顶部控件 |
| plugin 自主同 ID reopen 保留用户状态 | not covered：本轮只有宿主自动化覆盖，样例普通 resize 不能替代 | not covered |

实际输入阶段两布局均为 `length/input/submit`：`12/1/1 → 16/2/2 → 24/3/3 → 33/5/3`；随后真正 Enter 为 `33/5/4`。文本至 Enter 约 5.8–7.5ms，中间未插入等待。原始准确文本和统计可查 `inline-a2/07-paste-submit.pane.txt`、`fullscreen-a1/07-paste-submit.pane.txt` 及相邻 `*-check.json`。

首场 inline 顶部无可见 Row，driver 未发送 wheel，保留 not covered；只修订一次 driver。其 summary 虽列出 `inline-a1/wheel-coordinates.jsonl`，该文件实际不存在，不能作为投递证据；主线程核对其余 passed/failed 断言路径均存在。重测在实际 Row04 `(6,29)` 发送后 Row1–6 变为 Row1–7，但未满足中间视口前置，不改判通过。窄屏重叠见 `inline-a1/11-narrow.pane.txt:25–27`，恢复宽屏后数据正确；不能把状态保持通过当视觉无缺陷。

旧 `f96c3b4` 官方原件共存场景通过：未改原件、未改名、无 override，未出现注册失败，`/diff` 显示 native `Uncommitted changes (git diff HEAD)` / `Working tree is clean`。见 `native-diff-a1/03-diff.pane.txt`。这仅证明该冻结宿主 builtin 接管，不算 Mod UI activation，也不外推到另一 session 的新 native 实现。

| 场次 | tmux target / pane | socket（均已回收） | CLI 正常退出 / driver |
| --- | --- | --- | --- |
| inline-a1 | `mhf-inline-20260920:0.0` / `%0` | `/private/tmp/mhf-tkfj7sk1/inline-a1.sock` | 0 / 1 |
| fullscreen-a1 | `mhf-fullscreen-20260920:0.0` / `%0` | `/private/tmp/mhf-tkfj7sk1/fullscreen-a1.sock` | 0 / 0 |
| inline-a2 | `mhf-inline-20260920:0.0` / `%0` | `/private/tmp/mhf-tkfj7sk1/inline-a2.sock` | 0 / 1 |
| native-diff-a1 | `mhf-diff-20260920:0.0` / `%0` | `/private/tmp/mhf-tkfj7sk1/native-diff-a1.sock` | 0 / 0 |

每场均通过 `/exit` 正常退出 0，未强制终止 CLI；inline driver 非零表示断言不全通过，不是 CLI 退出失败。自有 CLI/tmux/socket/loopback listener 均已回收，证据保留，见 `F/runtime/final-cleanup.json`。四场 HTTP/API 计数均为 0；默认 marketplace clone 曾因白名单 PATH 无 git 而 ENOENT，不能声称无外联意图，但没有产生该连接。

使用空 HOME/config/XDG/TMP、security exit44 stub、私有 Git fixture及非 loopback 网络隔离；不读真实凭据。`hash-comparison.json` 记录 binary、775 文件旧官方原件、sample 和 launcher 前后均未改变。无 commit/push、不覆盖共享制品，不解除历史 Workflow/PTY 或全仓门禁。

### 11.5 窄屏重叠的独立归因（本轮冻结制品未修复）

静态审阅提示 Text 测量、绘制宽度与 Yoga 几何可能不一致，但不能把推测直接当根因。主线程在仓库外增加 `F/layout-probe.test.tsx`，分别使用纯 `ScrollBox + Box + BaseText` 和 ModsPane 中等价的 Text 树，不调用 ModInput、Worker、Pane reopen 或命令注册。冻结源码运行结果 `F/layout-probe.log` / `.exit` 为 **0 pass / 2 fail、exit1**，原始失败保留；它是诊断探针，不冒充仓库正式回归通过。

实际 `140→58` 几何：summary 高度由7增至10、help高度由1增至2，说明当前 Text 高度本身已经重测；**后续兄弟 top 仍保留7/8/9**，没有随高度重新排列。直接 ScrollBox 的 help在y7，下一节点仍在y8，违反 `next.y >= help.y + 2`。因此已把故障隔离到通用布局重排，而非 Input数据、宿主注册冲突或样例的API用法；静态审阅最初“文本高度没有更新”的假设被该探针纠正。

`src/native-ts/yoga-layout/index.ts`、`src/ink/components/{ScrollBox,Text,Box}.tsx`、`src/ink/dom.ts`、`src/ink/render-node-to-output.ts` 均与 `303d0ce` 逐字节一致。故本轮三项 Mods 修复不是引入该独立复现的必要条件；至于具体 Yoga cache/重排分支，尚未验证到可安全修改的程度。保留为通用 Yoga 后续（与既有子布局缓存问题并列，不假定完全同根），本轮不改公共引擎、不删除样例 Events/help、不截断文字、不改绿终端视觉断言。

### 11.6 后续公共布局修复与提交边界

以上为本轮冻结制品的历史结论。native diff session 随后独立定位 Yoga 多条目缓存只保存宽高、在 `performLayout` 命中时跳过子节点位置更新，限定该缓存仅用于 measure。本方只读核对 `/private/tmp/diff-resize-red-green.dgCO1U/57-shared-layout-old-cache-red.log` 与 `58-shared-layout-current-green.log`：复用上述 direct ScrollBox/ModsPane 探针，旧缓存条件 0 pass / 2 fail，当前条件 2 pass / 0 fail；58 列 summary/help 高度10/2、后续兄弟 top恢复10/12/13，回140列也归位。此后续证据确认同一缓存根因，但不替代 `F` 旧制品的 Mods 终端重测，不改写第11.4节失败和未覆盖。

用户随后明确要求按功能提交并推送。本轮提交只包含 Mods 样例、launcher/README、三项宿主修复与两份报告；不夹带另一 session 尚未提交的 native/TaskV2/Yoga 代码。此前各节“未 commit/push”描述对应验收时点；本次发布代码不等同于全仓通过，也不将既有 Workflow/PTY 和官方能力缺口改判通过。

提交前再次核对16个源码/测试/样例文件与 `F/overlay.json` 全部一致，32份自动化/构建/终端证据哈希无漂移，`git diff --check` 通过。空 HOME/config、security stub与假 key 下重跑 KeyboardEvent、ModsPane、默认键绑定、ui、commands、runtimeHost、testLab、launcher 八文件：**224 pass / 0 fail、1308 assertions**，样例子进程另列；官方原件与完整作者类型显式启用。日志 `F/precommit-tests.log` / `.exit`。此补验运行于当前工作区，含并发公共布局代码，不替代上述冻结制品身份或重新宣称终端通过。
