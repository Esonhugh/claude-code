# Mods 收口测试方案与验收记录

> **历史验收账本：** 本文冻结各轮当时的源码、官方版本、binary hash、证据路径、失败和未覆盖结论，不是当前能力矩阵。当前用法与支持范围见 `README.md`；当前 compiled builtin 专项以 release gate 的 `builtin-mods` target 及其本轮 evidence 为准，后续成功不会改写这里的历史结果。

第 1–7 节保留首轮修复及验收历史；后续输入链、Workflow 和 SSH 长路径修复见第 8 节；Mods UI/UX 修复与限定验收见第 9 节；可复用测试 Mod 与官方原件调试见第 10 节；输入、Pane reopen 与 builtin 让位修复见第 11 节；2.1.287 作者 API 的检查测试方案见第 12 节。历史失败不会由后续成功覆盖。

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

smoke agent记录的当时交接报告与本账本内容漂移来自主线程并发回填报告；这是主线程补充说明，不改写agent的“未归因”原始记录，也不把“全仓bytes不变”断言改标通过。HEAD/index在该smoke期间未变，锁定binary及生产构建输入未变；最终只补这两份不内嵌报告，CHANGELOG保持构建时内容。

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

完整测试于本地2026-09-19 00:28:47结束，首次审计发现 `src/services/api/openai-compat.ts` 和 `openai-compat.test.ts` 出现额外未提交改动，记录mtime分别00:33:10和00:30:58，均晚于测试结束；之后还观察到 `src/utils/messages.ts` 改动与新的 `src/services/api/openai-reasoning-resume.test.ts`。后续复核时，这组并发工作已由其他任务正常签名提交为 `3b0d6ce`，另包含 `src/utils/conversationRecovery.ts`，当前HEAD因而前进。两个完整模式保留的before/after hash一致；**本轮结果对应冻结的 `6b967f3` 内容和上述binary，不覆盖后来的OpenAI提交，也不声称验证了当前HEAD的全部生产代码**。未修改、暂存或代替其他任务提交这些文件。报告回填只改本账本及当时的交接报告，不改已内嵌CHANGELOG或重建产物；两份既有cross-session草稿继续保留。

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

**本轮限定补验已结束，不再启动runtime。整体仍未通过，不push。** 第四制品长行尾部/Page严格谓词、依赖的rapid Escape/Rewind及其他未覆盖项仍保留；公共Yoga子布局缓存未修，旧Workflow timeout/PTY退出码异常继续阻止整体推送。仅正常签名提交本账本与当时的交接报告，不混入两份cross-session草稿、并发源码或原始证据。

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

最终叠加样例、测试、launcher 及 README 后，`L/final-release-check.log` 与 `L/final-build.log` 均 exit0。`audit:missing` 报告10个既有测试字符串 fixture 相对引用，src 导入/文本资产/类型模块缺失为0，目标正常退出。`git diff --check` 通过显式 `GIT_DIR/GIT_WORK_TREE` 检查真实工作区，不把 archive 误称为 Git worktree。2746文件构建内容摘要 `aa83b3352d0529726db4cb5138d31c3512cc0a85cf4390562f684afbf6bddc0b`，构建前后未变；动态验收报告和运行输出不进入源码身份。最终 `L/artifact/final-built-claude` 为100432994 bytes，SHA-256仍为 `ca066924ce48976c590b22e97f09c73f3a816152894c1cd26d75ccf9b7fc27e3`，与全部本轮 runtime 使用的初始制品逐字节相同，见 `L/final-artifact.json`。

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

从 `303d0ce451a8e9a513c24dde34526af95b92fa1c` 的 Git archive 建独立镜像，仅叠加本节宿主修复及既有 sample/launcher；不混入并发 native/model/API/Agent 改动、不覆盖共享 `built-claude`。2758 个内容记录见 `F/source-inventory.json`，排除动态验收报告；源码摘要 `fded438c4f7d47e748121d724fd5e78ab7d5a49e9e1cdec9af378a9f03f9c397`，构建后无漂移。

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

## 12. 2.1.287 Mods 作者 API 验收账本（2026-10-02 起；局部实现与专项已通过，整体 blocked）

### 12.1 范围、契约来源与状态

本节检查工作区中尚未提交的 2.1.287 作者 API 实现，HEAD 基线为 `fea087b`。涉及的文件有：

- 新增：`src/services/mods/{state,toast,declarations,typeContract}.ts` 及各自的测试、`compatibility287.test.ts`、`testing/runner.ts`。
- 修改：`loader`、`runtime`、`worker`、`environment`、`protocol`、`types`、`ui`。
- 界面与命令：`src/components/ModsAbovePrompt.tsx`、`src/utils/plugins/{schemas,validatePlugin}.ts`、`src/cli/handlers/plugins.ts`、`src/main.tsx`、`src/screens/REPL.tsx`。

验收契约有三种来源，每条断言都标明出处，不混用：

- **文档**：官方博客 *Getting started with Claude Code mods*（2026-10-01）。原文用 `curl https://claude.dev/blog/getting-started-with-claude-code-mods.md` 取得，存于 `/private/tmp/cc-mods-blog/`，SHA-256 为 `2ea08f4e…`。原文本身不进仓库。
- **官方**：官方 2.1.287 binary 的实际行为，以及它写出的类型声明（见 12.3）。
- **实现**：本地实现自己定的、博客没有提到的约束。这类约束只能拿官方行为或内部一致性来判定，不能当成文档要求。

证据根记为 `O=/private/tmp/mods287-official`。

当前进度按证据层次分别记录，后续成功不改写 12.3–12.5 的历史红灯：
- **实现/源码 tests：** G1–G4、G6–G7、P1、P3、P9 的 runner、声明、validate/schema、state/CAS、targeted invalidation 与 AbovePrompt 焦点/continuation 已有实现和定向回归；P7 的 builtin/ZIP contract-only discovery 已完成限定源码与 native CLI 验证。精确轮次见 12.11 续记。
- **历史 native binary：** 三个官方原样示例曾取得 validate 全部成功、test 1/4/3 pass，旧声明迁移和 P7 冷入口矩阵也有合格历史制品证据；这些制品早于后续源码/文档变化，不能作为当前工作区产物。
- **最新 G5 dynamic：** 单一 retained run 中 not-now、enable/clear-cancel、cancel、turn-end-load、same-session-resume、fork-session 六场景均 passed；manifest 仍为 `overall_verdict=blocked`、`matrix_complete=false`。
- **physical/full gate：** logical/physical frames、独立 child command、其余 M287/S1–S9 和完整 required-target release matrix 未覆盖，整体仍 blocked。

本轮不覆盖：桌面端、远程/SSH 界面、Windows/Linux、与全部官方 API 的完全对等、`claude.ai/directory` 的提交流程。

### 12.2 决定

| # | 结论 |
| --- | --- |
| D3 TypeScript | 官方没有把 TypeScript 编译器打进 binary（证据见 12.3）。结论：与官方对齐，本地去掉 `typescript` 这项运行时依赖。契约的语法检查改用 `Bun.Transpiler`，`PluginState` 改用词法扫描提取，记为修复项 F1，由实现作者处理 |
| D4 下载官方 | 已允许，已完成（见 12.3） |
| D5 示例位置 | 放在 `examples/mods/`。要求是：符合官方 mods 定义、可以直接运行、可以在官方和本地之间互换，并以官方 2.1.287 的通过结果为准（见 12.4） |
| D1 冻结时点 | 待定：需要并发修改的作者确认。本节编写期间，`Makefile`、`scripts/build.mjs`、`runner.ts` 等文件仍在变化 |
| D2 `VERSION` | 待定：是否从 2.1.280 升到 2.1.287。生成的声明会写入这个版本号；博客要求 2.1.287 或更高 |
| D6 修复范围 | 待定：12.6 列出的 G/F 项是否全部纳入本轮 |

### 12.3 官方 2.1.287 基准（已执行）

**Binary 身份**

- 来源：npm 包 `@anthropic-ai/claude-code-darwin-arm64@2.1.287`（下载时 npm `latest` 指向 2.1.287，`stable` 指向 2.1.285）。
- 位置与校验：`O/official-claude-2.1.287`，227,827,120 bytes，SHA-256 `6eab8333fe2121553100d8f40bfada384a3e989b94f947e18ba6677a6fcb41ea`。
- 根目录的 `official-claude`（2.1.272，`195e24e8…`）没有改动。

**TypeScript 是否打包（Binary-observed）**

- 官方 binary 是分块打包的：入口文件只有 23 KB，另有 2400 个模块。我用 `native-extra.mjs` 的一份临时改写（`/tmp/native-extra-all.mjs`，原脚本未动）把所有模块导出到 `O/extract/official-all/all`。
- 在官方全部 JS 模块里搜索 `createSourceFile`、`versionMajorMinor`、`isInterfaceDeclaration`、`isModuleDeclaration`，命中 0 次。
- 只有两个内置 skill 附带的资源 `package-validate.mjs` 和 `dts.mjs` 引用了 TypeScript。它们是独立的 Node 脚本，运行时从用户环境 import `typescript` 或 `ts-morph`，不属于 binary 内的编译器。
- 官方解析类型契约分两步：
  - 语法检查用 `GSn`，即 `new Bun.Transpiler({loader}).transformSync`（位于 `chunk-sthe7p0e.js`），失败时报 `does not parse as TypeScript`；
  - `PluginState` 用手写的 token 扫描提取（位于 `chunk-hseyexgv.js`）。
- 本地 `built-claude` 则打包了完整的 TypeScript 编译器：`createSourceFile` 出现 6 次，`isInterfaceDeclaration` 4 次，`isModuleDeclaration` 3 次。

**声明的写入（Runtime-observed）**

- 只有在会话中加载 mod 时才写；`plugin validate` 和 `plugin test` 不写。本次是用 `-p --plugin-dir` 加载触发的。
- 官方写出的文件：`.claude-plugin/types/` 下 `claude-code/`、`claude-code-tools/`、`claude-code-mcp/` 三个目录各一个 `index.d.ts`，外加 `.gitignore`（内容为 `*`）和 `tsconfig.json`。
- `tsconfig.json` 的 `types` 指向上述三个目录，`include` 为 `../../hooks`、`../../types`、`../../tests`。
- 存档在 `O/official-decl`。

**测试套件**

来源是官方声明，以及 `anthropics/claude-code@52c76441` 的 `mods/README.md`（存于 `O/official-src`）：

- 导出：`describe`、`test(name, [options], ($, on) => …)`、`expect`、`tier`、`mock.env/store/clock`。test 的 options 有 `plugins`、`timeoutMs`、`options`；`mock.clock` 提供 `advance` 和 `settle`。
- 挂载结果的方法：`drawn`、`find(ElementQuery)`、`findAll`、`press({key})`、`input`、`select`、`redraw(props)`、`unmount`。
  - `ElementQuery` 为 `{type, key, text: string|RegExp, in}`；
  - `find` 异步返回元素，找不到时返回 `undefined`。
- 底层没人应答的调用会直接抛错，并指明事件名。
- `turn.start` 的桩必须返回 `{ turnId }`。
- 挂载一个 mod 会让出的组件时，测试必须在底层应答 `ui.render`。

**Pane 的放置规则**

- 用户主动发起的打开（命令、prompt 或按键）在任何宽度下都会放置；
- 不是用户发起的，终端宽 144 列起才放置，曾经被用户打开过的降到 110 列；
- `-p` 模式下全部放置；
- 渲染时用 `{component: "Pane", requestId: id}` 匹配。

**CLI 输出**

- `validate`：输出与博客 Step 5 一致，只多了一行 `declares on $`。
- 未声明 state 的报错原文：`…is not declared: the manifest's types contract must name it in interface PluginState { token-weather: { readings: ... } }`。
- `hooks.json` 写两个 module 时，报 `names one hooks module per plugin; a second entry is refused`，退出码 1。
- `plugin test` 的输出格式类似 bun：`(pass) …`、` N pass`、` M fail`、`Ran …`；帮助文本是 "Exits 1 when a test fails"。

**热重载与编写指南**

官方有热重载确认（"Enable hot reloading for this session?"，对应工具 `mod_hot_reload`）和 `cc-plugin-mods-guide`，分别位于 `chunk-5xa9nbn4.js` 和 `chunk-41nk7e7j.js`。

**官方源码仓库**

官方源码仓库 `mods/` 目录下只有 agents-md、diff、sec-default、telemetry。其中的 `types/claude-code.d.ts` 比 binary 旧，没有 `PluginState`。因此本节以 binary 写出的声明为准。

### 12.4 示例 mods（`examples/mods`，已执行）

三个 mod 都遵循官方定义：
- `.claude-plugin/plugin.json`，带 `types` 契约；
- `hooks/hooks.json`，只有一个 module；
- `hooks/<mod>.mjs`；
- `types/index.d.ts`；
- `tests/<mod>.test.ts`，使用 `claude-code/testing`。

| Mod | 来源 | 官方 validate | 官方 test | `tsc -p`（官方声明） | 官方 `-p` 加载 |
| --- | --- | --- | --- | --- | --- |
| `token-weather` | 博客原文逐字照搬：模块和测试是从原文 markdown 的代码块中程序化提取的，manifest 按 Step 3 加上了 `types` | 通过，6 条 notes | 1/1 | 0 错误 | 已加载；`session.start` 正常完成 |
| `blast-radius` | 用了原文的核心片段（挂起循环、`isPlaced` 退回渲染区、按钮快捷键）；`classify`、`measure`、`card` 按官方声明的形状补全 | 通过 | 4/4 | 0 错误 | 已加载 |
| `replay-theater` | 用了原文的片段；`stepsFor`、`openReplay`、diff 和 `$.state`（`replay`、`step`）按官方声明补全 | 通过 | 3/3 | 0 错误 | 已加载；`session.start` 正常完成 |

**市场分发**：新增 `examples/mods/.claude-plugin/marketplace.json`（名为 `mods-examples`）。在官方上依次执行：
- `claude plugin marketplace add ./mods`；
- 对三个 mod 分别执行 `claude plugin install <mod>@mods-examples --scope user`，全部成功；
- `claude plugin list` 显示三者都是 enabled。

**测试写法要点**：
- Blast Radius 的 `sleep` 桩由测试控制放行，以免挂起循环在微任务里空转。第一版没有这样做，官方运行 600 秒后超时，失败已保留在证据中。
- 各测试都在底层补了 `ui.render` 应答，`turn.start` 的桩返回 `{turnId}`。

**仓库改动**：`.gitignore` 新增 `examples/mods/*/.claude-plugin/types/`。官方会自己写 `types/.gitignore`，但本地实现不会。

**证据**：
- 16 个示例文件的 hash 存于 `O/examples.sha256`；
- 最终的官方运行结果在 `O/runs/final-official-*`；
- 加载记录在 `O/runs/load-official-*`；
- 市场分发记录在 `O/runs/marketplace-official`。

**未覆盖**：没有在官方交互式 TUI 下运行这三个 mod（`not covered`），留到 12.9 的 S1–S3。

### 12.5 本地实现对照（工作区未冻结，结果只作为发现）

**使用的两个 binary**：
- 共享的 `built-claude`：2.1.280，`aaac92b2…`，11:08 构建，早于 `plugin test` 命令加入的时间。
- 工作区快照 `O/built-wt/claude`：`a8c94ee1…`，构建时 `git diff` 的 hash 为 `09b6d745…`；用 `bun package:binary` 构建，没有覆盖 `built-claude`。

| 检查 | 结果 |
| --- | --- |
| `built-claude` validate / test | validate 只校验 manifest；`plugin test` 报 `unknown command 'test'` |
| `built-wt` validate（三个 mod） | 只输出 manifest 部分，完全没有进入 `hooks/hooks.json` 的校验，也没有 notes（G3） |
| `built-wt` plugin test（三个 mod） | 全部报 `unknown option '--child'`，确认 P2 |
| 绕过 P2，直接调用 runner（`O/run-local-runner.ts`） | 三个 mod 全部失败：<br>• token-weather：用对象调用 `find` 时找不到元素（G1）；<br>• blast-radius：测试注册的 hook 里调用 `$.ui.resolve`，报 `UI resolve requires an admitted terminal hook`；<br>• replay-theater：报 `Unhandled plugin test event: command.run` 和 `Mod UI panes are unavailable without an interactive terminal host`（G7）。<br>注意：运行期间 `runner.ts` 正被并发修改 |
| `built-wt` `-p` 加载 | 已激活（写出了声明），但只写了 `claude-code/` 和 `tsconfig.json`，没有 tools/mcp 两个目录，也没有 `.gitignore`；debug 日志里没有加载记录 |
| 用本地声明跑 `tsc -p` | 本地的 `tsconfig.json` 没有 `include`，`tsc -p` 只检查声明文件本身，结果没有意义。改成官方式的 `include` 之后，token-weather 的测试报 7 个错误：缺少 `describe`、`expect`、`test` 的导出（G4） |

### 12.6 不符项与修复项

| # | 内容 | 状态 |
| --- | --- | --- |
| G1 | 测试套件的 `find` 接受 `ElementQuery`、异步返回、未命中为 `undefined`，并支持 `press({key})` | 已实现并有 runner integration tests；历史 native 三例通过 |
| G2 | `plugin test` 使用 bun 风格逐文件/case 与汇总输出 | 已实现并有 reporter tests；历史 native stdout/失败 exit1 已验证 |
| G3 | `validate` 校验 `hooks/hooks.json` 并报告 types、hooks、calls、state writes/reads | 已实现并有 handler/validator tests；历史 native 三例通过 |
| G4 | 自动生成 tool/MCP/testing 声明、`.gitignore` 与完整 `tsconfig`，并安全迁移精确旧布局 | 已实现并有 declarations/typeContract tests；历史 native 三例和迁移通过 |
| G5 | session authoring consent、turn-end load、取消 fencing、same-session resume、clear/fork 不继承及 `/plugin-authoring` 指南 | 源码 tests 通过；最新同轮六场景 passed，但 logical/physical 未覆盖，整体 blocked |
| G6 | 第二个 module 应当被拒绝；官方会拒绝 | schema 最多一个 module 且有测试；官方拒绝已确认。当前文档修改后未重建复验 |
| G7 | 未应答底层调用抛错，测试 hook 可用 UI resolve，command/Pane 与 `mock.*` 可用于作者测试 | 已实现并有 runner/runtime tests；历史 native 三例通过 |
| F1 | 去掉 `typescript` 运行时依赖（D3） | 当前生产 src 无直接 TypeScript import/require，typeContract 使用 Bun.Transpiler；原生契约解析有历史验证。产物依赖全量审计、体积/冷启动对比仍待完成 |
| P1 | 声明写入内置 Mods 缓存，可能导致每次启动重新解压 | runtime 已让 native/builtin 跳过作者声明安装并有 tier/reconcile 回归；完整 builtin cache 重启 physical 未覆盖 |
| P2 | 编译后 binary 中 `plugin test` 的子进程参数错误 | 已修复；历史原生三例 test 1/4/3 通过，真实失败 exit1 已验证 |
| P3 | 渲染区停止绘制或卸载时释放焦点 | `ModsAbovePrompt` focus/unmount 与 continuation 已有源码回归；真实逐帧 physical 未覆盖 |
| P7 | 独立 validate 的跨插件 state 只读契约发现、完整性与 owner-only write | builtin/ZIP/本地发现已实现；历史原生 cold matched/missing/write-denied/损坏 ZIP 已验证；完整官方差异及 EACCES 矩阵未闭环 |
| P8 | Node 版 `dist/cli.js` 下 validate 报 `Bun is not defined`（`loader.ts:878`） | Node bundle 不是当前 native 作者 CLI 验收目标；若声明支持仍需单独定义和验证 |
| P9 | toast 限长、runner 排除目录、声明目录竞态 | 已实现 4096 UTF-16 限长、排除 `node_modules`/`.claude-test-environment`、串行/原子声明写入及 symlink/目录 tests；跨平台文件系统 physical 未覆盖 |
| P10 | `README.md:612` 的说法已过期；`VERSION` 的问题见 D2 | README 已更新当前作者工具链和边界；版本保持不变 |

### 12.7 验证分层与命令

- **L1**：
  ```bash
  bun test src/services/mods/{compatibility287,state,toast,declarations,typeContract,loader,ui,uiEnvironment}.test.ts \
    src/utils/plugins/validatePlugin.test.ts src/components/ModsAbovePrompt.test.tsx
  bun test src/services/mods src/components/ModsPane.test.tsx src/components/tasks/BackgroundTasksDialog.test.ts
  ```
  完整清单按 4.2 的做法执行。注意：`examples/mods/*/tests/*.test.ts` 依赖 `claude-code/testing`，只能用 `claude plugin test` 运行，不能纳入 bun 的测试清单；裸 `bun test` 的自动发现会把它们也收进来。`CLAUDE_CODE_OFFICIAL_MOD_TYPES` 指向 `O/official-decl`。先为 G1–G7、P1、P2、P3 补失败测试，再处理 REPL 接线和热重载时 `session.start` 的触发次数。
- **L2**：`make release-check`。
- **L3**：`make build`。另用 HEAD 镜像构建一份基准，对比体积和冷启动时间，用来量化 F1 的收益。
- **L4**：执行 `O/check.sh <制品> <标签> examples/mods/token-weather examples/mods/blast-radius examples/mods/replay-theater`。脚本隔离 HOME、配置和 TMP，把 mod 复制出仓库再运行，`plugin test` 带 180 秒超时。
  - 以官方结果为准：`validate` 退出码为 0 且 notes 一致；`test` 结果为 1/1、4/4、3/3。
  - 违规夹具：多个 module、未声明的 state（官方的报错原文见 12.3）、写入他人 state、动态 key、`types` 越界、非 `.ts` 文件。
  - 用 `O/official-decl` 的 tsconfig 写法跑 `tsc -p`。
- **L5**：按 `claude-agent-workflow-validation` 执行，由专门的 subagent 串行驱动隔离的 tmux。使用本地回环的假 API，不调用真实模型。场景见 12.9。
- **L6**：官方部分已完成（12.3、12.4）。剩下的是交互式对照：两侧在相同条件下运行 S1–S3，官方开关如果没有自然打开，就记为 `not covered`。

### 12.8 断言

“当前”按证据层次标注：`源码 tests` 只证明当前实现的确定性回归，`历史 native` 只证明对应冻结制品，`最新 G5` 指末尾同轮 retained manifest，`physical 未覆盖` 不得由前三者推定。官方结果写在 `/` 左边，本地结果写在右边。`—` 表示还没有执行。

| ID | 来源 | 断言 | 层级 | 当前 |
| --- | --- | --- | --- | --- |
| M287-01 | 文档 | 每次加载都把声明写入 `.claude-plugin/types/`；重复加载内容不变，不触发连续重载；类型目录是符号链接时拒绝写入 | L1+L5 | 源码 tests passed；历史 native 迁移/幂等 passed；会话 physical 未覆盖 |
| M287-02 | 文档 | 不需要额外步骤，`tsc -p` 就能检查 hooks、types 和 tests，包括 `claude-code/testing` | L1+L4 | 官方通过 / 历史 native 三例通过；当前文档修改后未重建 |
| M287-03 | 官方 | 本地生成的声明与 `O/official-decl` 在布局、`EngineInterface`、`PluginState`、`StateRef`、`UiOpenResult`、`SessionUsage`、测试套件上一致 | L4+L6 | 声明/typeContract 源码 tests passed；未宣称逐字全面 parity |
| M287-04 | 风险 | 内置缓存不会因为写入声明而在每次启动时重新解压（P1） | L1+L5 | 源码 tier/reconcile tests passed；完整重启 physical 未覆盖 |
| M287-05 | 文档 | `$.state.get(ref)` 返回 `{value}`，`$.state.set(ref, value)`；ref 为模块级 const，能通过扫描和 validate | L1+L4 | 官方通过 / 源码 tests 与历史 native validate passed |
| M287-06 | 文档 | 未声明的 state 会报错，报错原文与官方一致 | L4 | 官方原文已取得 / 历史 native missing case exit1 |
| M287-07 | 实现 | state 规则：只有所属插件能写、`ifVersion`、只接受 JSON、4Mi 上限、渲染期间禁止写入、中间件不能改写引用字段 | L1（+L6） | state/validator 源码 tests passed；physical 未覆盖 |
| M287-08 | 文档 | 热重载时 `register` 重新执行，`session.start` 恰好再触发一次，模块变量归零，`$.state` 保留 | L1+L5 | 生命周期源码 tests 部分覆盖；完整 state-preserving physical 未覆盖 |
| M287-09 | 实现/官方 | 会话结束和 `/clear` 后 state 重置；`--resume` 的行为以官方为准 | L5+L6 | state reset 源码 tests passed；state 的官方 resume 对照未覆盖 |
| M287-10 | 文档 | 渲染期间的 `$.state.get` 会订阅这次绘制，之后的 `set` 自动重绘，只重绘订阅了的实例 | L1+L5 | 官方示例覆盖 / 本地 targeted invalidation 源码 tests passed；physical 未覆盖 |
| M287-11 | 文档 | `ui.render` 顶层字段、`e.props`、`hasSurvey` 时让出、`bodyColumns` 受 Pane 停靠影响、没有 hook 绘制时宿主不画任何东西 | L1+L5 | AbovePrompt/UI 源码 tests passed；physical 未覆盖 |
| M287-12 | 风险 | 渲染区的焦点进入、按键屏蔽、焦点释放（P3） | L1+L5 | 源码 focus/unmount tests passed；逐帧 physical 未覆盖 |
| M287-13 | 文档/官方 | `$.ui.open` 返回 `isPlaced`；放置规则符合 12.3；`isPlaced: false` 时退回渲染区 | L1+L5+L6 | 官方与作者 runner 有覆盖；完整本地放置 physical 未覆盖 |
| M287-14 | 文档 | Button 可以通过点击、Tab+Enter、快捷键触发 | L5 | 源码 UI tests 部分覆盖；作者场景逐帧 physical 未覆盖 |
| M287-15 | 文档/实现 | `$.ui.toast` 显示在通知区；同一插件 2 秒内只显示一条 | L1+L5 | toast 源码 tests passed；physical 未覆盖 |
| M287-16 | 文档 | 每次 dispatch 的 10 秒时限不计入等待 `$` 调用的时间；挂起循环；按 Esc 使 `next.signal` 中止；Proceed 和 Cancel 的语义 | L1+L5 | runner/runtime 源码 tests 与官方示例覆盖；完整 physical 未覆盖 |
| M287-17 | 文档 | `$.process.run` 按 argv 执行；挂起期间的轮询不弹权限框 | L1+L5 | 宿主源码 tests 有覆盖；作者 physical 未覆盖 |
| M287-18 | 文档 | `agentId` 把 subagent 的轮次排除在分组之外；`tool.call` 能看到全部调用；对 Write 而言，`$.fs.read` 读到写入前的旧内容 | L5 | 官方测试已覆盖 / 本地完整动态未覆盖 |
| M287-19 | 文档 | `/replay` 的注册与执行；按 `r` 打开回放 | L5 | 官方测试与历史 native plugin test 覆盖命令；TUI hotkey physical 未覆盖 |
| M287-20 | 文档 | `$.session.usage()` 与状态栏一致；不带 `breakdown` 时不发 token 计数请求 | L1+L5 | 源码 tests 部分覆盖；状态栏动态对照未覆盖 |
| M287-21 | 文档 | `--debug` 下出现"树未通过校验"的日志行，界面不崩溃 | L4/L5 | 未覆盖 |
| M287-22 | 文档 | 原文 Token Weather 测试在 `plugin test` 下通过，输出与原文一致 | L4 | 官方 1/1 / 历史 native 1/1 passed；当前未重建 |
| M287-23 | 实现/风险 | 编译后 binary 中 `plugin test` 能起子进程、失败时退出码为 1、遗留定时器或挂载时判失败 | L4+L6 | 源码 safety tests passed；历史 native 子进程与失败 exit1 passed |
| M287-24 | 文档 | `validate` 输出与原文 Step 5 一致 | L4+L6 | 官方通过 / 历史 native 三例 passed；不宣称逐字全面 parity |
| M287-25 | 官方 | 第二个 module 被拒绝 | L4+L6 | 官方拒绝；本地 schema/tests 拒绝，当前未重建复验 |
| M287-26 | 实现 | 违规夹具 validate 报错，退出码与官方一致 | L1+L4+L6 | 多项源码/native 夹具 passed；完整违规矩阵未闭环 |
| M287-27 | 风险 | 跨插件读取 state 与官方一致（P7） | L6 | 源码 discovery tests 与历史 native cold 四项 passed；官方差异/EACCES 未闭环 |
| M287-28 | 文档 | 默认开启：全新配置、不做任何设置时 mod 加载 | L5 | 官方 `-p` 已加载 / 本地历史 `-p` 已激活 |
| M287-29 | 文档 | 市场分发的 CLI 路径和会话内斜杠命令路径都可用，安装副本中生成声明 | L4+L5 | 官方 CLI 路径通过 / 本地会话内完整路径未覆盖 |
| M287-30 | 文档/官方 | 热重载确认与编写指南（G5） | L0→L5 | `/plugin-authoring` 与 consent 已实现；最新同轮六场景 passed，physical frames 未覆盖 |
| M287-31 | 实现 | 隔离不退化：`stateMethod` 不可伪造、两侧 JSON 化、`session.authorize` 返回空授权 | L1 | 源码 tests passed；生产授权恒空另有回归 |
| M287-32 | 官方 | 不打包 TypeScript；编译后的 binary 能解析契约（F1） | L3+L4 | 生产源码使用 Bun.Transpiler；历史 native 解析 passed；完整产物依赖审计未完成 |
| M287-33 | 回归 | 已有 Mods：`mods-test-lab check/accept-builtin` 通过；`bun test src/services/mods` 通过 | L1+L4+L5 | 有分项历史记录；当前工作区未执行完整回归 |
| M287-34 | 回归 | 提交 prompt、Agent、Workflow、后台任务通知正常；两次 Escape 不误开 Rewind | L5 | 未执行完整回归 |
| M287-35 | 文档化 | README、CHANGELOG 和本节同步；`.claude-test-evidence/` 与 `examples/mods/*/.claude-plugin/types/` 被忽略；博客原文不进仓库 | L0 | 文档已同步；需新 build 后按新制品身份验收 |

### 12.9 交互场景

夹具统一使用 `examples/mods`，运行时复制到证据根，不在仓库内运行。

#### G5 专项的含义与覆盖范围

这里的 **G5 是第 5 个兼容性缺口（Gap 5），不是第 5 个发布 gate**。它检查 `/plugin-authoring` 打开插件作者模式后，授权是否严格绑定当前 session，以及延迟加载、取消、恢复和 fork 时是否保持正确的生命周期语义。正式测试使用隔离的 HOME/config/TMP、本地回环假 API、真实编译 binary 和 tmux 键盘输入；它验证终端语义状态，但不等同于逐帧 logical/physical 渲染验收。

| G5 场景 | 核心断言 | 当前同轮结果 |
| --- | --- | --- |
| `not-now` | 用户拒绝授权后不创建 authoring root、不写授权记录、不加载开发 mod | passed（4 条断言） |
| `enable` + `clear-cancel` | 接受后只为当前 session 建立 authoring root；`/clear` 不继承授权，再次询问时取消应保留命令草稿且不产生副作用 | passed（9 条断言） |
| `cancel` | 首次授权对话框取消后恢复 `/plugin-authoring` 草稿，不创建 root、记录或模型请求 | passed（4 条断言） |
| `turn-end-load` | 活跃 turn 内接受授权时不提前加载；turn 结束后才加载开发 mod 并出现 marker | passed（7 条断言） |
| `same-session-resume` | 正常退出后用同一 session ID `--resume`，沿用该 session 的授权和 authoring root，启动即重新加载 marker | passed（12 条断言） |
| `fork-session` | `--fork-session` 取得新 session ID，不继承原 session 的授权、root 或 marker；重新询问授权，取消仍恢复草稿且无新增副作用 | passed（16 条断言） |

最新同轮证据为 `/private/tmp/g5-release-1d09defdff/evidence/driver-final-manifest.json`，六场景共 52 条断言通过，`first_divergence=null`。该 manifest 同时明确记录 `logical_frames=not covered`、`physical_frames=not covered`、`matrix_complete=false` 和 `overall_verdict=blocked`；因此 G5 的会话语义专项可以判 passed，但不能据此宣称完整 Mods 或发布门禁通过。

| 场景 | 流程 | 断言 |
| --- | --- | --- |
| S1 Token Weather | 用全新配置执行 `--plugin-dir`；假模型跑三轮，读数从 Clear 依次变到 Showers、Storm；终端从 120 列缩到 80 列，再停靠 Pane；保存文件触发热重载，计数 `session.start` 的触发次数；最后执行 `/clear` | 01, 08–11, 28 |
| S2 Blast Radius | 默认权限模式下，假模型发出 `rm -rf build`；先在 144 列以上放置 Pane，再在 120 列下退回渲染区；分别用 `2`、Tab+Enter、`1`、点击操作；挂起超过 10 秒；按 Esc 中止；同时记录 Mod 拒绝与 Bash 删除强制确认谁先触发 | 13, 14, 16, 17 |
| S3 Replay Theater | 跨三个文件的重命名，中间穿插一次 subagent 轮次；按 `r` 打开，再执行 `/replay`；fullscreen 下停靠，80 列下 inline 显示 | 13, 18, 19 |
| S4 焦点 | 按 Tab 进入渲染区，然后让渲染区消失，继续输入时文字应进入输入框 | 12 |
| S5 Toast | 一次连发 3 条，只显示 1 条，之后自动消失 | 15 |
| S6 非法 UI 树 | 在 `--debug` 下检查日志行，并确认界面可以继续使用 | 21 |
| S7 重启 | 用同一个 HOME 连续启动两次，比较内置缓存的摘要 | 04 |
| S8 市场分发 | 在会话内执行 `/plugin marketplace add <本地路径>`、`/plugin install`、`/reload-plugins` | 01, 29 |
| S9 冒烟与清理 | Agent、Workflow、后台通知；结束后检查进程、socket、端口都已回收，没有多余写入 | 33, 34 |

### 12.10 判定、隔离与执行顺序

**判定**：
- 只有 L1 和 L5 都通过、每条断言都有证据，整体才算 passed。
- 来源为"文档"或"官方"的断言如果不满足，一律判 failed，除非你明确接受这个偏差，并在本节记录。
- G、F 和已确认的 P 项，都按"先写失败测试、再修复、构建新制品后重新验证"处理；历史失败保留，不被后来的成功覆盖。

**隔离**：沿用第 6 节，即独立的 HOME、CLAUDE_CONFIG_DIR、XDG 和 TMP，环境变量走白名单，只用本地回环的假 API，不读取真实凭据，只清理本轮自己创建的东西。

**执行顺序**：
1. 冻结（D1）；
2. 补齐失败测试，修复 G、F、P 项，直到 L1 全部通过；
3. 依次执行 L2、L3、L4（官方结果作为对照基准）；
4. L5 由 subagent 执行；
5. L6 交互部分；
6. 回填 12.11，更新 README 和 CHANGELOG。

### 12.11 执行记录

**本轮已完成（2026-10-02）**：
- 下载并核对官方 2.1.287（12.3）；
- 二进制分析：确认官方没有打包 TypeScript，并找到契约的解析方式（12.3）；
- 采集官方写出的声明和测试套件的约定；
- 编写三个示例 mod 和 marketplace，并在官方上全部通过 validate、test、`tsc -p`、`-p` 加载和 CLI 市场安装（12.4）；
- 对本地 binary 做非冻结对照，确认了 G1–G4、G7 和 P2（12.5）。

**尚未执行**：本地实现冻结后的 L1–L5、官方交互对照（S1–S3）、违规夹具的完整矩阵、P1/P3/P7/P8/P9 的验证。

**仓库改动**：`examples/mods/{token-weather,blast-radius,replay-theater}/`、`examples/mods/.claude-plugin/marketplace.json`、`.gitignore` 新增一行，以及本节。没有改动并发作者的实现文件，也没有提交。

#### 本地修复续记（2026-10-02；不覆盖上述历史结果）

按后续授权改为串行、仓库内独立 HOME/config/TMP/XDG，保留全部证据；不执行递归清理、不覆盖旧产物、不 commit/push。第 12.9 的仓库外运行与清理步骤不用于此次执行。

- P2 已在编译制品复现 `unknown option '--child'`：子进程错误携带 Bun 内嵌入口。改用现有 bundled-mode 判断后消除；红证据 `.mods-author-check-0odn1n_c/results.json`。
- 原样 token-weather 暴露 state invalidation 后查询旧树；新增最小失败回归后，查询等待实际 pending drawing。
- 原样 blast-radius/replay-theater 暴露测试 host hook 的同步 `ui.resolve` 和 placement stubs 路由缺口；分别补失败回归与最小修复。
- `drawn()` 只等待首帧不足以推动跨 worker 调用。依据官方 settle 协议补事件驱动进度屏障；不加 sleep、扩大示例循环或强制 redraw。红绿与完整 runner 记录：`.claude-test-evidence/worker-settle-20261002/`。
- 新隔离 `make build` 成功：`.validation-build-9ef1bh2e/output/built-claude`，SHA-256 `9bd0dc4fa7e2bad68430083ba7a3ac87c032d41491dc5bcc99f3327f059ed3a4`。
- 该制品中三个示例均原样执行 `plugin validate <dir>` 成功；`plugin test <dir>` 分别为 token-weather **1/1**、blast-radius **4/4**、replay-theater **3/3**。完整命令与输出：`.mods-author-check-24jzqg_x/results.json`。
- `tsc --noEmit --incremental false` 通过。runner 完整回归有 **49/49**，同时保留一轮 **48/49** 的 late-registration 间歇失败，尚未解释完成；不能用后续成功覆盖。
- 本记录仅确认上述作者 CLI 子集，不代表 G3 诊断信息、声明类型检查、F1、违规夹具、屏障 abort/dispose/并发 hold 或 L5/L6 TUI 已通过。当前整体仍未闭环。

#### 未等待的 UI invalidation 修复（2026-10-03）

- 保留后续制品的失败记录 `.mods-author-check-7zyjbv77/results.json`：Blast Radius Cancel 用例报告 `async: Module capability failed`。
- 最小回归连续 8 个正常 command-return/unmount case 均失败；在测试 body 结束加 `runtime.settle()` 仍失败。根因是 `ui.invalidate('ui.render')` 继承 hook invocation signal，hook 正常返回的 abort 取消了尚未完成的刷新。
- 最小修复仅使该 UI invalidation 不继承 hook invocation signal；不改变其他 capability 的取消行为或 runtime 全局生命周期。原失败回归通过；新增回归确认 `before` 消失且 `after` 真正发布，而非仅消除错误。
- `bun test src/services/mods/testing/runner.integration.test.ts` 为 **52 pass / 0 fail**；随后新增发布回归，`-t 'fire-and-forget'` 为 **2 pass / 0 fail**。`tsc --noEmit --incremental false --pretty false` 与 `git diff --check` 通过。
- 新隔离产物 `.validation-build-k0mbovtm/output/built-claude`，SHA-256 `07a7ca112001e98d46eece4f5fec3bfe8038fb4a7f044e4066d7eb2758ad9e71`。构建日志显示 make 完成产物生成，但外层 zsh 记录脚本误用只读变量 `status`，包装命令 exit 1；此异常保留于 `build-result.json`，不将外层命令标为成功。
- 原样作者文件副本散列一致，三个示例 validate 均 exit 0，test 分别 **1/1、4/4、3/3**，stderr 均空。证据 `.mods-author-check-dfdx84e5/{author-files,results,summary,side-effects}.json`。
- 根 `built-claude` 散列、mtime、size 未变；全部证据保留，无删除、仓库外配置写入或 commit/push。上述仅为作者 CLI 验证，不代表完整 release gate 或 L5/L6 TUI 通过。
- 后续撤去无效的 body 尾部 `runtime.settle()` 实验，runner integration+safety **67 pass / 0 fail**。另以先红后绿回归修复 discovery 误收集 `node_modules` 与 `.claude-test-environment` 中测试的问题；safety **15 pass / 0 fail**，TypeScript 和 diff 检查通过。
- 此阶段重建 `.validation-build-jyc7yyll/output/built-claude`，`make build` exit **0**，SHA-256 `d37dda30e713efcaa9628f22f1706e95429f7e88e55d7a5455bbefb82b131bcf`。`.mods-author-check-7m8fdwsm/results.json` 记录三原样示例 validate 成功及 test **1/1、4/4、3/3**；向新 Token Weather fixture 的两类排除目录放入必抛错的 `foreign.test.ts` 后，真实 CLI 仍为 **1 passed, 0 failed**。根产物保持不变，所有新增证据保留。
- 随后 P1 新增回归确认 builtin tier 生成声明污染发行树（预期不存在，实际存在）；修复仅让 native/builtin 跳过作者声明安装，保留完整 archive 摘要。重复 reconcile 的 builtin/user/prepend/append 四项回归 **1 pass / 8 assertions**，TypeScript/diff 检查通过。此后源码已变化，上述 binary 不能作为该修复的验收证据。完整 builtin cache 重启验证仍未执行：既有 `builtinMods.test.ts` 和 acceptance harness 含递归清理，与当前约束冲突。
- G2 已按保存的官方 stdout 实现逐文件标题、逐 case 名称和观测耗时、pass/fail 与 Ran 汇总。单 case 多条失败聚合计数，文件加载错误单列；保留非零 child exit、deadline、隔离环境约束。先红后绿，runner safety/integration 与 reporter **78 pass / 0 fail**；主线程另纠正加载失败文案并验证 reporter **7 pass / 0 fail**。
- 包含 P1/G2 的隔离构建 `.validation-build-20261002T170808.477475Z/output/built-claude`，make exit **0**，SHA-256 `bfeb38cbd2f5e1a7cc314d5ba6746698e9484de34ca8c745cee39726e7e50acb`。构建与 CLI 均以 `sandbox-exec` 禁止网络，repo-local 独立环境；根 binary 和 tracked Git 状态前后不变。
- `.mods-author-check-20261002T170808.477475Z/` 保存原样 15 文件散列、逐命令环境及结果：三个 validate 成功，test **1/1、4/4、3/3**，逐 case 名称/耗时及官方风格汇总出现，stderr 空。另在新副本注入 `throw Error('load-probe')`，真实 CLI exit **1**，输出 `(fail) the file did not load`、**0 pass / 1 fail**、`Ran 0 tests`，无假通过。此轮未覆盖真实 builtin 缓存重启或 TUI，不代表总体门禁通过。
- P9 toast 限长按官方 `text.length > 4096` 拒绝（UTF-16 units、原文计长、不截断），边界/Unicode/节流回归 **3 pass / 22 assertions**。
- P7 接入现有 cached enabled plugin contracts，保留 unavailable 与完整空集区别；foreign contract 不得补 owner 自身声明，任一读取失败明确 warning + unchecked，不调用会物化缓存的 loader。validator/真实 handler 测试 **29 pass**。独立 CLI 通常无预热 cache，foreign references 仍 unchecked，此限制未解决。
- G5 `/plugin-authoring` 通过现有 bundled skills 注册，附当前生成声明和本地真实功能说明，不承诺未实现的 session authoring consent。skill/declarations/handler focused **39 pass**，TypeScript/ESLint/diff 通过。官方 consent 是会话专属目录启用授权，不是每次 save 提示，也不能套到所有普通插件。
- 最新隔离 build `.validation-build-1otk8noh/output/built-claude` exit **0**，SHA-256 `8124f4fd66285959f0be567e0bb34927b6ccaf833ff2113d10ef6adae15c5e17`。`.mods-author-check-u353vikn/results.json` 三例 validate/test **6/6 命令成功、8 pass / 0 fail**；源码副本散列一致，sandbox 禁网，根产物/tracked diff 不变。
- 保留 `.mods-author-check-grvgjowa` 失败：复制整个示例目录带入旧 `.claude-plugin/types`，因缺 ownership footer 而拒绝更新。新鲜作者文件副本成功不能消除此迁移缺陷，旧声明恢复策略仍待解决。
- 新 binary 含 plugin-authoring 注册和指南字符串；没有安全非 TUI 的真实 discovery 入口验证，因此 **skill binary discovery: not covered**。真实 builtin 重启、consent、TUI/physical 与完整门禁仍未完成。

#### 当前交接与执行边界（2026-10-03）

本节作为 Mods 实现与验收的持续记录；历史结果不等于当前工作区通过。用户最新授权覆盖上面的临时 repo-local 限制：测试 fixture、隔离 HOME/config、缓存和证据统一在 `/tmp` 新建私有目录（macOS 实路径为 `/private/tmp`）；文档维护在代码目录。只允许清理本轮新建且归属明确的测试目录，不触及旧证据、用户 HOME 或共享配置；不 commit/push/worktree。

- G5 已实现窄 `requestModAuthoringConsent`（不依赖 `HOOK_PROMPTS`）、可取消 prompt queue、session 专属 root、turn-end 延后加载、managed/disabled plugin 合并、dev-mods transcript 及初始/交互 resume；clear/fork 不继承。迟到授权、dispose/session 切换、withdrawn 重问均有 fencing；重问不阻塞 query finally。历史局部证据为 session+REPL **172 pass**、query **120 pass**、邻接 **284 pass / 2 既有 skip**；不代表 L5 已通过。
- 指南附件仍否认 consent 的冲突已先红后绿修复，skill **7 pass / 24 assertions**。最新隔离 build 曾在 `.validation-build-3z7y9po9` 成功（SHA `ff6e4b1afeb8ce310a2c0c5cb6168315903f369979f1721cdd907b4b81f6673f`），TypeScript/diff 检查通过；后续检查该路径已不存在，原因未确认，不能作为可重用验收制品，须重新构建并捕获身份。
- 正式 retained driver 已增加真实 builtin archive 与 ripgrep cache 预置，不绕过产品校验。旧 `.r-b75` 真实 readiness 在 ripgrep 临时释放处失败；缓存修复后的真实 readiness 尚未通过。完整目标矩阵不能因 readiness 或 focused 测试成功而省略。
- 正式 capture/gate 已支持 `/tmp` 私有 root；路径、policy、CLI、readiness contract、builtin/ripgrep cache focused **6/6**，证据 `/private/tmp/retained-checks-8ucmm5aw/{tests.log,results.json}`。这不是 binary 交互证据；该轮因指定 binary 缺失未启动正式 gate。
- 下一步按产品缺口推进：旧生成声明迁移（不得覆盖作者文件）、P7 独立进程 foreign contracts、G5 真正入口及取消/turn-end/resume，随后按 M287/S 矩阵完成新产物作者 CLI 和 TUI/physical。README/CHANGELOG 与最终状态待同步，整体仍未闭环。

#### 旧生成声明迁移修复（2026-10-03；限定源码验证）

- 根因：`installDeclarations` 只接受目标字节相同或有效 ownership footer。历史 `claude-code/index.d.ts` 和旧 `tsconfig.json` 都没有 footer，且与当前输出不同，因此正常升级被作为 unowned 拒绝；runtime reconcile 捕获为 `stage: types`，并非作者副本本身无效。
- 证据调查：三个 `examples/mods/{token-weather,blast-radius,replay-theater}/.claude-plugin/types/` 的两文件逐字相同。声明全文 SHA-256 为 `2abb2722d131f2c15736cea8d8403f8446b54c3b5cb11f4cc0137af846dec0b0`（38631 bytes），配置为 `943f1d1ec27a8c6f6be329b460b815da840641bb31fceb15b5b1c86b26ccb33d`（386 bytes）。旧布局只有这两文件，配置 `types: []` 且无 `include`。内容固定保存在 `src/services/mods/fixtures/legacy280-declarations.json`，不依赖被忽略的 example 生成目录参与今后测试。旧生成器当时是未跟踪实现，不能引用不存在的 committed revision；`.mods-author-check-grvgjowa` 原目录现已不可用，仅保留本节历史失败记录，不能声称重新执行过该旧目录。
- 实现仅增加上述 **相对目标路径 + 完整内容 SHA-256** 白名单；不裁剪版本头、不规范化正文、不凭 generated header 放行。逐文件沿用既有原子替换、目录及 symlink 检查；无需整目录布局匹配，所以中断后已升级声明、尚未升级配置的混合状态可重试。无目录删除、无 TypeScript runtime 依赖，也不读取测试快照作为生产依赖。
- 测试副作用先审查：`declarations.test.ts` 原 fixture 硬编码仓库 evidence 路径，现改为 `os.tmpdir()` + `mkdtemp`；保留原断言，不增加 cleanup。所有本轮运行目录、HOME/config/XDG/cache/temp 都在 `E=/private/tmp/mods-declaration-migration-hbiu3rm_`，白名单环境启动，不继承凭据变量。只读旧声明来源，未修改旧证据及用户 HOME。新增回归覆盖旧内容升级、附带作者文件不变、声明及配置被修改时拒绝并保留字节、恢复原文后的重试、hash 不得跨目标路径使用、幂等；原 runtime 工具刷新测试及三个示例 `tsc -p` 测试也先安装旧快照再验证，非新鲜副本替代迁移。
- 精确执行命令（仓库根 cwd；`red` 在生产修复前执行，日志均保留）：
  ```sh
  E=/private/tmp/mods-declaration-migration-hbiu3rm_
  # 下列 bun 命令统一使用此环境前缀
  env -i PATH=/opt/homebrew/bin:/usr/bin:/bin HOME="$E/home" \
    CLAUDE_CONFIG_DIR="$E/config" XDG_CONFIG_HOME="$E/xdg-config" \
    XDG_CACHE_HOME="$E/cache" XDG_DATA_HOME="$E/data" XDG_STATE_HOME="$E/state" \
    TMPDIR="$E/tmp" BUN_INSTALL_CACHE_DIR="$E/cache/bun" \
    bun test src/services/mods/declarations.test.ts -t 'legacy declaration migration|runtime tools service'
  # 同一环境前缀，移除 -t，分别保存 green.log 和 green-final.log
  bun test src/services/mods/declarations.test.ts
  # 同一环境前缀；tsc.log
  bun node_modules/typescript/bin/tsc --noEmit --incremental false --pretty false
  # lint.log（只使用 PATH/HOME/TMPDIR 的 env -i）
  env -i PATH=/opt/homebrew/bin:/usr/bin:/bin HOME="$E/home" TMPDIR="$E/tmp" \
    bun node_modules/eslint/bin/eslint.js src/services/mods/declarations.ts src/services/mods/declarations.test.ts
  git diff --check
  ```
- 红：`red.log` **1 pass / 4 fail / 23 filtered，exit 1**，包括真实 runtime reconcile 的 `types` diagnostic。绿：`green.log` 及最终 `green-final.log` 均 **28 pass / 0 fail / 101 assertions，exit 0**；最终轮包含三个原样示例带旧布局迁移后 `tsc -p`，runtime 测试也覆盖迁移后 MCP 再刷新。`tsc.log`、`lint.log` 空且 exit 0；diff 检查通过。`source-sha256.json` 保存实现、测试和历史快照身份；本轮目录全部保留。
- 限制：仅白名单中的本地 2.1.280 精确内容获得自动升级。调查还看到 `/private/tmp/mods287-official/runs/{load-wt-token-weather,src-token-weather}/token-weather/.claude-plugin/types/` 的其他旧变体及 `official-decl` 官方 2.1.287 布局；本轮未纳入白名单或宣称这些变体可迁移。未知/作者修改文件仍保留并明确拒绝；恢复需先备份、人工核对差异并将需保留的作者声明移入作者 `types/`，然后只移动确认冲突的文件到备份路径后重试，不删除整个生成目录。当前生成 `tsconfig.json` 仍无 footer，未来配置格式变化需另加已验证的完整内容身份，不自动猜测 ownership。
- 本轮没有构建或执行 compiled binary，也未运行全量测试、TUI/physical 或正式 release gate；源码 runtime 与 `tsc` 通过不等于真实 binary 验收。历史失败不被抹除，G4 迁移缺陷的上述精确变体已源码修复，其他 M287/G/P 项和总体门禁仍未闭环。无 worktree、commit、push；保留所有先前工作区改动。

#### P7 独立 validate context 只读调查（2026-10-03；设计阻塞，未实现）

- 本轮按“根本需较大架构改动先返回具体只读设计及阻塞”的授权分支停止生产改动；只读检查指定 handler、validator、type contract、加载器及 settings/installed/builtin 读取链。未运行测试、构建、binary 或 TUI，也没有新增红绿通过证据。此前 cached-context 的结果不代表独立进程已修复。
- 已确认边界：`src/cli/handlers/plugins.ts:137` 仅查 memoize；`pluginLoader.ts:3146` 的 cache-only 函数不是纯只读（SYNC_PLUGIN_INSTALL 可转 full loader，`:2149` 会解压 ZIP，`:3213` 会发布 plugin settings）。不能直接用它替换 memoize lookup。
- 完整性阻塞：`plugins/builtinPlugins.ts:21` 是进程内 registry；普通会话的 `plugins/bundled/index.ts:38` 初始化经过 `builtinMods.ts:159` 的物化/注册流程。独立 validate 未走该初始化，空 registry 无法证明 builtin 集合为空。`installedPluginsManager.ts:315` 把读取/解析失败降级为成功空集；错误导致丢失 recorded installPath 时，marketplace loader 还可能改读本地 catalog source，不再是已安装版本。不能把这种 partial context 传作严格 `[]`。
- 建议的共享只读设计（待实施，不新增第二套 policy）：
  1. 在既有 `loadPluginsFromMarketplaces` 中增加明确的 contract-discovery 读取分支，沿用 settings/add-dir 合并、marketplace policy、catalog lookup 及 recorded installPath 优先级；将路径解析与 ZIP 物化分开。只读分支不调用 download/copy/extract、模块执行、声明安装或 cachePluginSettings，也不受 SYNC_PLUGIN_INSTALL 切换影响。
  2. 为 installed-state 和 catalog 的底层读取保留“确实不存在”与“损坏/不可读”的状态及来源；运行时原有降级调用者可以继续降级，validation 调用者必须得到完整性诊断。复用 settings 的有效配置合并与错误结果，不自己读取一份 settings 来重新实现 managed precedence。manifest 的 marketplace fallback/strict 合并规则也须保持共用，不能另写简化版本。
  3. builtin 需要共享的、无需注册/落盘的定义读取能力：从同一 archive 选择与身份/provenance 校验入口读取内存条目及 types contract；复用默认 enabled/availability 规则。磁盘插件与 archive contract 的读取边界要显式区分，不能制造虚假文件路径供现有 realpath loader 使用。Marketplace ZIP 同理；若暂不支持读取，必须返回“context unavailable + 具体 archive/source”，不能跳过并返回完整空集。
  4. 三类来源完成发现后，复用 `mergePluginSources` 与 `verifyAndDemote`，保留 disabled 项参与遮蔽和 managed 禁止覆盖；最后只读取有效 enabled contracts。不新增 manifest dependency。无法证明完整性的失败返回 `declarations: undefined` 和具体来源诊断，丢弃 partial declarations；仅真正完整时返回数组（包括 `[]`）。owner 自身声明排除及 owner-only write 继续由现有 validator 执行。
- 下一步先红后绿矩阵：独立无预热进程的合法/缺失 foreign key、完整空集、disabled/session 遮蔽、managed force-enabled/force-disabled、installed recorded version 与 catalog 不同版本、损坏 settings/installed/catalog/manifest/types、中途失败不得泄露 partial context、builtin 未物化、ZIP 未物化、SYNC_PLUGIN_INSTALL 开启仍无下载。必须断言退出码、诊断及目录前后内容不变，并使用禁网/禁止插件执行探针。现有两份目标测试的 fixture root 仍指向仓库 `.claude-test-evidence`，正式执行前须改为本轮 `/tmp` 私有 TMPDIR；本轮未执行它们，未创建 fixture/HOME/cache，未清理任何目录。
- 结论：P7 独立进程完整 context **仍未实现、未验证**。阻塞不是缺少 manifest dependency，而是现有 discovery 的完整性信息与物化副作用尚未分离；跨 shared loader、installed/catalog reader、builtin archive reader 的改动需作为后续明确范围实施。本轮仅追加本记录，保留用户所有既有改动，无 worktree/commit/push。

#### P7 contract-only discovery 实现续记（2026-10-03；本地基础，非全来源闭环）

- 本轮在原仓库实现 P7，不涉及 TUI、依赖升级、worktree、commit 或 push。保留既有未提交改动；测试 fixture 改用 `os.tmpdir()` + `mkdtemp`，仅使用本轮 `/tmp` 隔离 HOME/config/temp 与白名单环境，不继承用户凭据变量，不读取真实用户凭据，不联网。
- Handler 新增独立发现入口：没有预热 cache 时调用 `loadPluginsForContractValidation`，而不是运行 full/cache-only runtime loader；必须同时满足 `complete` 且无 loader errors 才解析 foreign declarations。不完整空集、含有效插件的 partial、抛出异常或任何 foreign types 读取失败均保持 `declarations: undefined`，输出具体 warning；完整空集仍严格报 missing foreign key。owner 排除与 owner-only write 沿用原 validator。
- Handler 先红证据 `/private/tmp/p7-handler-t7vkLf/red-behavior.log`：**11 pass / 6 fail**，六个新增案例均因独立 discovery 调用次数为 0（期望 1）失败。更早 `red.log` 是测试提取 exported function 的语法错误，不作为产品红证据；修正 harness 后才获得上述行为红。Validator 独立回归 `/private/tmp/p7-handler-t7vkLf/validator-green.log`：**17 pass / 0 fail / 38 assertions**，含 foreign-write 拒绝、owner 排除和中途失败丢弃 partial。Handler 测试使用源码函数注入禁止 materializing loader，不能替代真实 loader 或 compiled CLI 验证。
- Handler + validator 绿：`/private/tmp/p7-handler-t7vkLf/handler-validator-green.log` **36 pass / 0 fail / 122 assertions**；补充完整但 foreign key 不存在、不完整且无 error 的空集分支。`handler-validator-final.log` **37 pass / 0 fail / 128 assertions**，额外运行真实冷 handler + 真实 discovery，确认 builtin incomplete warning、foreign unchecked 及 full/cache-only loader 均未调用。最终 `handler-validator-managed-green.log` **39 pass / 0 fail / 136 assertions**，补测共享 `mergePluginSources` 的 managed force-enabled / force-disabled 均阻止 inline 覆盖（纯合并测试，不冒充真实 managed 配置端到端验证）。构建：审查 Makefile（VERSION=2.1.280）发现当前 `prepareBuildDirectory` 仍仅允许 repo 内路径，为遵守本轮所有产物位于 `/tmp`，直接复用导出的 `buildCli({outputDir: '/tmp/p7-handler-t7vkLf/build'})`，`CLAUDE_CODE_VERSION=2.1.280 bun -e ...` 构建成功，日志 `build.log`。这是 JS bundle + worker 构建，不是 `make build` 原生 binary 打包，也未执行真实 compiled CLI / TUI；没有修改构建脚本或覆盖原有产物。
- 共享发现实现：`loadPluginsFromMarketplaces` 使用相同 settings/add-dir merge、marketplace policy、catalog lookup、recorded installPath 与 cache-only 路径解析；在 ZIP extraction 与组件读取之前建立 contract-only 边界，复用 `finishLoadingPluginFromPath` 的 manifest fallback/strict conflict，跳过 hooks/MCP/settings 组件、插件执行及物化。聚合仍调用 `mergePluginSources` 和 `verifyAndDemote`，跳过 `cachePluginSettings`。installed strict reader 复用 raw reader/schema/V1 内存转换，绕开错误降级空集缓存；catalog 复用原 `readCachedMarketplace`，settings/add-dir 原 reader 传递损坏及 I/O diagnostics，而不是复制 settings policy。
- 当前 builtin 无安全纯内存全量发现入口：不调用 registry availability callback，不注册/物化 builtin，明确产生 `source: builtin` 的 incomplete error。因此**当前真实 cold 全局入口总是 incomplete，返回 `enabled: []`，handler 不发布任何 partial foreign declarations**。本地 installed/inline 的路径与 manifest 发现基础可验证，但这不等于独立 validate 已能严格检查全部 foreign key，也不能宣称 P7 完成。ZIP contract 内存读取、builtin archive/availability 的共享纯读取和完整全来源冷进程成功路径仍待后续实现。
- Loader 先红 `/private/tmp/p7-loader-T8IFdJ/red.log` **0 pass / 5 fail**：新增 discovery/strict reader 尚不存在，且 inline contract 模式仍读出 hookModules（期望 undefined），随后才实现生产边界。此 red 是新增 API/副作用边界红，不冒充完整 cold CLI 的 foreign-key 行为红。
- 定向真实 loader 复验 `/private/tmp/p7-handler-t7vkLf/loader-green.log`：隔离 child **9 pass / 0 fail / 32 assertions**，外层进程退出断言 **1 pass**。最终 `loader-final.log` **9 pass / 0 fail / 33 assertions**，增加 plugin settings base 引用不变断言，确认不发布插件 settings。含 recorded version 优先于损坏 catalog-source、本地 fallback/strict、disabled inline 遮蔽与 dependency demotion、installed 缺失/损坏/I/O 失败恢复、catalog/settings/add-dir 损坏或不可读、SYNC_PLUGIN_INSTALL=1 下 ZIP 拒绝、inline 执行探针及目录字节快照不变。该证据中的 I/O 失败使用目录代替文件（EISDIR），不等价于操作系统 EACCES 权限矩阵。
- 静态检查：`/private/tmp/p7-handler-t7vkLf/tsc-final.log` 全仓 `bun node_modules/typescript/bin/tsc --noEmit --incremental false --pretty false` exit 0；`handler-lint.log` 本轮 handler/validator tests 定向 ESLint exit 0，`p7-lint.log` 覆盖本轮全部九个 TS 文件 exit 0；`git diff --check` 通过。最终隔离构建 `build-final.log` exit 0，产物位于 `/private/tmp/p7-handler-t7vkLf/build-final/dist/`；`source-sha256.txt` 记录本轮源码身份，所有证据保留。过程中 `tsc-integration.log` 曾报告正在整合的 fetch 禁网探针类型转换不匹配，最终类型检查已通过，不隐去中间失败记录。
#### P7 builtin / ZIP 内存发现续记（2026-10-03；CLI 产物验证仍阻塞）

- 本轮由单个 implementation subagent 在原仓库串行修改，主线程等待后复核；无 worktree/commit/push，保留此前改动和证据。新证据根 `/tmp/p7-memory-PfR7Am`，测试子进程另以 mkdtemp 创建本轮 `/tmp/p7-contract-process-*` 与 `/tmp/p7-contract-loader-*`（精确路径见日志）。白名单 HOME/config 环境不继承凭据；loader child 禁止 fetch 和 subprocess。没有新增依赖。
- 已消除上一节“cold 无条件 builtin incomplete”：直接读取真实 assets ZIP，共享官方 SHA-256 / provenance schema、archive entry/collision 校验及 builtin enabled settings/default 逻辑，不物化或注册 builtin。注册表 availability callback 不能纯读取判定时明确 incomplete，且不执行 callback。ZIP installed path 现在复用 manifest fallback/strict conflict，内存字节传入 foreign contract parser，保留 owner namespace filter、owner 排除、owner-only write 与失败丢弃 partial。runtime extraction 路径不变。
- 行为红 `red.log`：child **8 pass / 1 fail / 29 assertions**，完整本地+真实builtin context 仍返回空集；改动前获得。绿 `green-final.log`：child **12 pass / 0 fail / 59 assertions**，外层 **1 pass / 1 assertion**。覆盖完整context、ZIP内存types/owner namespace过滤、types越界与缺失、坏/越界ZIP、builtin缺失/损坏/EISDIR、availability callback不执行、settings base不发布及目录快照不变。EISDIR不等于EACCES；未执行操作系统权限矩阵。
- Handler + validator `focused.log`：**39 pass / 0 fail / 135 assertions**，cold真实handler现在严格报告缺失foreign key而非builtin incomplete；foreign-write拒绝用既有测试验证。`tsc-final.log` 全仓非增量 tsc exit 0；八个修改TS文件 `eslint-final.log` exit 0；diff --check通过。
- 构建审查发现当前 `prepareBuildDirectory` 仍限制repo内新目录，因此未运行会违背本轮/tmp约束的 `make build`，而复用 `buildCli({outputDir:'/tmp/p7-memory-PfR7Am/build'})`，`build.log` 成功产出JS bundle+worker。**这不是原生binary打包通过。**
- 实际CLI入口矩阵已尝试，但**不合格，不记为通过**：四个新隔离fixture位于 `cli-{matched,missing,write-denied,bad-archive}`，本地marketplace+foreign types+owner hooks，运行构建的 `dist/cli.js plugin validate <owner>`。Bun因bundle含CommonJS-only features拒绝ESM入口（各output.log）；Node补齐只读node_modules链接、ESM package与experimental-vm-modules后均exit 0且无输出（output-cold.log / output-keepalive.log），不能证明handler执行，不能证明missing/write-denied正确拒绝。中间参数/运行时诊断日志全部保留，没有把空输出exit 0当成功。CLI启动在隔离config产生自身.config/backups文件；loader单测目录快照才是发现不物化的有效证据。
- 剩余边界：需解决构建CLI运行时入口问题后重做真实cold四项矩阵及原生binary验证；未宣称TUI、全门禁、全来源端到端或P7完整验收通过。ZIP symlink/CRC等超出现有共享unzip校验能力的专门矩阵未新增。本轮没有修改构建脚本以掩盖入口问题。

#### /tmp 正式 native 构建与作者 CLI / P7 / 声明迁移验收（2026-10-03；限定 L1/L3/L4）

- 由单个 subagent 在原仓库串行实施，主线程等待后复核；无 worktree、并行验收、commit/push、normal release gate 或 TUI。仅修改 `scripts/build-isolated.test.mjs`、`scripts/build.mjs` 并追加本记录；原有大量用户 diff 保留。证据根 `E=/tmp/mods-native-lvqehl3p`（实路径 `/private/tmp/mods-native-lvqehl3p`，0700），旧 `/tmp/p7-memory-PfR7Am` 仅读取明确的 owner/foreign 作者文件，不复制 HOME/config/凭据。
- 构建修复先红：`build-red.{stdout,stderr,json}` exit 1，原实现拒绝 /tmp。最终 `build-green-final.*` exit 0，检查新目录0700、现存目录/有效及悬空symlink拒绝、HOME与非授权路径拒绝、父symlink越界拒绝、macOS canonical /private/tmp 和 repo 新路径兼容。repo兼容用 mkdir double，不在仓库创建fixture。`build-green.*` 保留中间失败：隔离HOME本身在/tmp，最初实现未拒绝其子目录；增加真实HOME边界后通过。实现仅对真实父路径做允许根判断并独占0700创建，不改包装流程。
- HEAD `b66311c5338ab28871ce122014b2f84d7cff6530`。源码身份算法在 `source-before.json` / `source-after.json`：tracked+untracked 非忽略的 src/scripts/examples/mods/assets/vendor、Makefile/package/lock 按文件内容SHA组成排序JSON再SHA；排除动态证据与本结果文档。前 `40276bce8bfa2ec97fec43c8bd521d26bed5a995b0e8b4e1611a18f49f3973af`，后 `861e7c32fad79ff0588e0536f789d4d82b331d93454fd27fce5970d5a06cffbb`；仅本轮两个构建文件内容变化。另保存完整 tracked diff（排除结果文档）的SHA，前 `13d79ff132c98d8369ea517ac53fc6cdf545366e7b401853c96ed071330093e9`，后 `eeb1274a059b4b7b6fd71cb7db73f9904eff6a0ad3f6b700d0d59eb74080f538`。未发现其他源码漂移。
- 正式 qualified 构建 `native-build-qualified.*` exit 0，产物 `/tmp/mods-native-lvqehl3p/output-qualified/built-claude`，版本 `2.1.280 (Claude Code)`，101027426 bytes，mtime_ns `1791007554364562538`，SHA-256 `7ce43a3c5662cf8554b17f898ae6539527f6a4bb2343330f5c8bd6920a44a052`。Makefile VERSION 未擅自升级。根 built 前后SHA `34adf2f3009c879ff11bf305fc0a90efc9d069cba806bf99c6241ed30d54aa0f`、size及mtime_ns完全相同（`root-before.json` / `root-after.json`）。
- 中间 `native-build-final` 已输出产物，但外层记录器在 wait 后用 killpg 探测遇到 EPERM，缺完整结果记录，不作为合格构建；修正证据脚本用 ps 查看进程组，在全新 output-qualified 重跑正式 make。qualified 构建刚退出时短暂观察到 esbuild exiting child；最终 `process-final.json` 确认全部记录组及本轮命令均已消失。所有中间产物及日志保留。

**精确环境与命令**（cwd 仓库根；逐命令 JSON 记录完整 argv/env/cwd/timeout/exit/processState；stdout/stderr 分文件）：

```sh
E=/tmp/mods-native-lvqehl3p
env -i PATH=/opt/homebrew/bin:/usr/bin:/bin HOME="$E/home" \
  CLAUDE_CONFIG_DIR="$E/config" XDG_CONFIG_HOME="$E/xdg-config" \
  XDG_CACHE_HOME="$E/cache" XDG_DATA_HOME="$E/data" XDG_STATE_HOME="$E/state" \
  TMPDIR="$E/tmp" BUN_INSTALL_CACHE_DIR="$E/cache/bun" \
  BUN_RUNTIME_TRANSPILER_CACHE_PATH="$E/cache/transpiler" \
  /usr/bin/sandbox-exec -f "$E/sandbox.sb" \
  make build CLAUDE_CODE_BUILD_DIR=/tmp/mods-native-lvqehl3p/output-qualified
# 同一环境及sandbox前缀，先红后绿各执行
bun scripts/build-isolated.test.mjs
# 聚焦L1，独立串行进程
bun test src/cli/handlers/plugins.validate.test.ts src/utils/plugins/validatePlugin.test.ts
# 此项另加 P7_CONTRACT_TEST_CHILD=1，cwd=$E，直接执行既有child矩阵，
# 避免其外层driver舍弃TMPDIR后在本轮根外创建fixture；不改变产品路径
bun test /Users/esonhugh/workspace/projects/WebStormProjects/cc/claude-code/src/utils/plugins/pluginLoader.contract.test.ts
bun test src/services/mods/declarations.test.ts
# 全部CLI实际argv/env及cwd见各同名json；HOME/config/cache/tmp为每case新目录
"$E/output-qualified/built-claude" --version
"$E/output-qualified/built-claude" plugin validate "$E/author-token-weather/token-weather"
"$E/output-qualified/built-claude" plugin test "$E/author-token-weather/token-weather"
"$E/output-qualified/built-claude" plugin validate "$E/author-blast-radius/blast-radius"
"$E/output-qualified/built-claude" plugin test "$E/author-blast-radius/blast-radius"
"$E/output-qualified/built-claude" plugin validate "$E/author-replay-theater/replay-theater"
"$E/output-qualified/built-claude" plugin test "$E/author-replay-theater/replay-theater"
# case依次matched / missing / write-denied / bad-archive
"$E/output-qualified/built-claude" plugin validate "$E/p7-$case/owner"
# name依次token-weather / blast-radius / replay-theater，各运行两次（upgrade/idempotent）
"$E/output-qualified/built-claude" plugin test "$E/migration-$name/$name"
```

- `run.py` 仅为日志/超时/环境/sandbox执行器，不是替代build脚本；构建timeout480秒，L1与CLI180秒，路径回归480秒。`cli.py`、`migration.py` 保存fixture重建步骤。sandbox规则为 `(allow default)`、`(deny network*)`、`(deny file-write*)`，仅允许本轮实路径及 `/dev/null` 写入。白名单无真实网络凭据，无产品绕过。审查 embedded sharp/ripgrep 与runner后执行；TMP/HOME/Bun缓存均隔离，runner子进程自身创建的临时HOME位于当前作者fixture内，继承OS sandbox。

| 断言/层级 | 实际结果 | 证据 |
| --- | --- | --- |
| L1 handler+validator | 39 pass / 0 fail / 135 assertions | `l1-handler-validator.*` |
| L1 真实contract loader child | 12 pass / 0 fail / 59 assertions；完整builtin+local、ZIP内存、异常丢弃partial及不物化 | `l1-loader.*` |
| L1 声明与旧布局迁移 | 28 pass / 0 fail / 101 assertions，含runtime及三个示例tsc | `l1-declarations.*` |
| L4 三例原样作者 | 每例仅复制5个作者文件，15个SHA一致；validate均exit0，test依次1/4/3 pass，0 fail，逐case与Ran汇总存在 | `author-*-hashes.json`、`*-validate.*`、`*-test.*`、`cli-assertions-final.json` |
| P7 matched 冷入口 | exit0；reads other.value，无unchecked；builtin内嵌包原样参与完整发现 | `p7-matched.*` |
| P7 missing 冷入口 | exit1；other.value is not declared in any available plugin types contract | `p7-missing.*` |
| P7 foreign write 冷入口 | exit1；only a value's owner may write it | `p7-write-denied.*` |
| P7 bad installed ZIP | exit0且明确warning：incomplete / left unchecked / installed.zip: invalid zip data；不发布partial | `p7-bad-archive.*` |
| native声明迁移 | 三例分别预置legacy280-declarations.json两文件再plugin test，1/4/3 pass；author sentinel和5个作者文件不变；第二次生成内容SHA不变 | `migration-results.json`及六组`migration-*-upgrade/idempotent.*` |

**判据与副作用边界**：初版harness对Blast Radius误要求state notes，记录为false保留于 `cli-results.json`；该作者文件根本没有state调用，实际输出types/hooks/calls正确，按读取的契约修正判据，最终断言见 `cli-assertions-final.json`，不是放宽产品失败。三例validate notes均检查实际内容，不只看exit。P7四项前后全文件hash快照均无原文件改写，新增仅CLI自身 `config/.claude.json` 与对应backup；无builtin/plugin cache、解压文件、声明生成或模块执行（owner/foreign顶层throw探针均未触发）。正常plugin test和迁移入口会生成声明、`.claude-test-environment`内配置及backup，这是已审查的预期写入，不声称零写入。证据 `*-effects.json`。Bad archive使用本地installed_plugins.json记录的坏ZIP，**没有替换内嵌builtin**；builtin损坏只有L1覆盖，不冒充native损坏builtin覆盖。write-denied是state所有权拒绝，不是OS EACCES矩阵。

**结论**：本轮限定L1/L3/L4上述断言通过，历史失败不被覆盖。迁移native入口是产品 `plugin test` 的真实runtime.reconcile，不是绕开CLI直接调用helper；不代表会话启动/resume/TUI迁移已覆盖。没有验证TUI/physical、完整feature、全部M287、热重载/consent/resume、完整builtin会话重启、全部来源policy或正常release gate，均为 **not covered**。记录器早期异常及修复前产物不能替代最终qualified证据。用户HOME、旧证据、根binary未作为写入目标，原有diff保护；本轮目录不清理。

#### 指定 qualified binary 正式 retained gate（2026-10-03；blocked）

- 原仓库串行执行；没有 worktree、产品修改、产品重建、复制回根 binary、commit/push 或发布。本轮仅修改 `capture-release-baseline.py`、`run-binary-gate.py`、`test-release-driver.py` 三份现有 harness，并追加本文；launcher、Makefile 仅审查，既有 diff 保留。所有新 fixture/HOME/config/证据在私有根 `/private/tmp/mods-retained-l57ie8ki`，旧目录不清理。
- 指定真实文件 `/private/tmp/mods-native-lvqehl3p/output-qualified/built-claude`：SHA-256 `7ce43a3c5662cf8554b17f898ae6539527f6a4bb2343330f5c8bd6920a44a052`，size `101027426`，mtime_ns `1791007554364562538`；与 qualified 记录一致，见 `identity.json` 及每轮 baseline/final manifest。HEAD `b66311c5338ab28871ce122014b2f84d7cff6530`。没有把既有制品冒称本轮 build。
- 外部 binary 最小回归先红 `path-red.log`（1 fail，`binary.relative_to(repo)` 拒绝真实 /tmp 文件），再支持 /tmp 中现存普通文件，保留 symlink、用户 HOME、run-output 和根 built 保护；身份仍按真实字节/size/mtime 比较。测试 fixture 去掉硬编码 `/tmp`，遵循本轮私有 TMPDIR。`path-green.log` 为 6 pass / 0 fail。
- 执行预算先审查：legacy workflow 的 1200/1800 秒不适用于 retained 分支；retained 不构造有广泛 cleanup/共享 lease 的 `BinaryGate`。当前只执行 readiness，然后保留完整 required 清单并报告未适配 handler 阻塞。readiness 缓存 30 秒、socket 启动 10 秒、四个状态各 45 秒、tmux 每命令 10 秒和退出清理，使用 600 秒前台工具预算；三轮均 driver 自行退出（exit 2）并产生 final manifest，无后台/提前超时终止。仓库全量哈希扫描没有严格硬 deadline，不能将此预算结论推广到未来完整 handler 矩阵。

**正式 commands**（cwd `/Users/esonhugh/workspace/projects/WebStormProjects/cc/claude-code`）：

```sh
E=/private/tmp/mods-retained-l57ie8ki
B=/tmp/mods-native-lvqehl3p/output-qualified/built-claude
S=.claude/skills/release-validation/scripts
# n=1,2,3；每次 run$n 原先不存在，由 capture 独占创建0700
# 以下两命令均加同一白名单前缀
# env -i PATH=/opt/homebrew/bin:/usr/bin:/bin HOME="$E/home" \
#   CLAUDE_CONFIG_DIR="$E/config" TMPDIR="$E/tmp" PYTHONDONTWRITEBYTECODE=1 \
#   GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
python3 "$S/capture-release-baseline.py" --repo "$PWD" --binary "$B" \
  --run-root "$E/run$n" --retain-artifacts --output "$E/run$n/baseline.json"
python3 "$S/run-binary-gate.py" --repo "$PWD" --binary "$B" \
  --run-root "$E/run$n" --retain-artifacts --baseline "$E/run$n/baseline.json" \
  --evidence-root "$E/run$n/evidence"
# 不传 --targets 或 --base-ref，不缩矩阵；日志 capture$n.log、driver$n.{stdout,stderr,exit}
```

- 首轮另外用 `$E/gate.sb` 包裹上述命令；首错 `run1/evidence/tmux-server.log` 为 `sandbox-exec: sandbox_apply: Operation not permitted`，macOS 拒绝嵌套 sandbox，产品未启动。完整首轮 final：`/private/tmp/mods-retained-l57ie8ki/run1/evidence/driver-final-manifest.json`。第二、三轮使用正式 driver 自带 OS sandbox 隔离 tmux/产品，父 Python 仅本地哈希/缓存及 loopback mock；不叠加第二层 sandbox。launcher env-i 和 dummy credential 不变，无真实 HOME 凭据读取；旧 `.r-a72/.r-a73/.r-a74/.r-b75` auth 只经 baseline 哈希，不输出内容。
- 第二轮 `run2/evidence/submitted.txt` 已展示 `RELEASE_RETAINED_INPUT` 和 `RELEASE_RETAINED_RESPONSE`，但正式 `submitted` 判据失败；同时 `debug.log` 最先出现 config rename/unlink/rmdir EPERM 与残留 lock。先加真实 OS sandbox 回归 `test_retained_owned_atomic_config`，`atomic-red.log` 1 fail；只放行本轮 `config/.claude.json`、`.claude.json.lock`、精确 `.claude.json.tmp.<digits>.<digits>`，不放行 config 整目录删除。Seatbelt regex 转义中间失败保留 `atomic-green.log`，修正后 `atomic-green-final.log` 1 pass，断言无关 evidence 仍不能删除。
- 最终回归 `final-tests.log` **7 pass / 0 fail**：external binary、external root、policy、readiness contract、CLI/launcher contract、真实 builtin cache、不扩大删除权限的 atomic/lock OS 测试。六项在 `$E/test.sb` 禁网及仅本轮 root 写入下执行，atomic 测试子进程用正式 sandbox（避免嵌套）；没有执行会编译 probe 的 ripgrep 测试，也没有运行产品测试/build/release-check。测试命令为白名单 Python `runpy.run_path(".claude/skills/release-validation/scripts/test-release-driver.py")[test_name]()`，七项精确名称见日志。`git diff --check` 通过。

**最终正式结果**：`/private/tmp/mods-retained-l57ie8ki/run3/evidence/driver-final-manifest.json`，`overall_verdict=blocked`，`matrix_complete=false`；readiness **failed**，仅 startup/input 两个状态断言通过。`submitted state not observed`，证据 `/private/tmp/mods-retained-l57ie8ki/run3/evidence/submitted.txt`、`mock-openai-requests.json`、`readiness-result.json`、`debug.log`。实际回复已显示，但 `submitted_input_visible` 检查最后输入框内容，完成后清空输入框使判据不成立；本轮未获授权修改该状态观测契约，保留阻塞，不修改产品、不放宽断言、不称 readiness passed。最终日志已无 config atomic/lock errors。

完整默认计划为 **26 项（readiness + 25 required）**；required 均未执行：`agent-fg-bg`, `builtin-mods`, `code-review`, `coordinator-selector`, `deferred-tool-discovery`, `effort-openai-responses-wire`, `fast-openai-responses-wire`, `first-party-bootstrap-picker`, `model-discovery-empty-picker`, `model-discovery-picker`, `nested-agent`, `openai-image-input-wire`, `openai-remote-compaction`, `openai-responses-usage-error`, `openai-stats`, `plugins-reload`, `prompt-modes-cache-prefix`, `ssh-remote-session-lifecycle`, `subagent-stop-failure-lifecycle`, `team-concurrency`, `terminal-interaction`, `transcript-retention`, `workflow`, `workflow-failure-detail`, `workflow-retry-partial-failure`。未适配 handler 的原因原样见 final `blocked_targets`，即使 readiness 修复，也不能宣称完整矩阵可执行/通过。

**副作用和下一入口**：三轮 `repository_state_unchanged=true`（每轮 baseline 至 final）；根 binary SHA `34adf2f3009c879ff11bf305fc0a90efc9d069cba806bf99c6241ed30d54aa0f`、size/mtime 未变。`final-effects.json` 核查 server/pane PID `10411,26807,26811,52091,52094` 及直接子进程均不在，最终 mock port `61104` 不监听，私有 `run3/t` 不存在，server exit0/kill-server exit0。仅 driver 清理本轮 socket 和已允许 owned atomic/lock 临时状态，所有证据目录保留，没有旧目录删除或 legacy lease。G5 真正 consent/cancel/turn-end/resume 入口、Mods feature/physical 仍 **not covered**；下一真实 G5 验收首先需明确授权修 readiness 提交状态观测，并为 retained builtin/相邻 handlers 适配本轮 owned 生命周期与真实 G5 场景，不能用现有普通回复 smoke 替代。

#### Retained submitted 语义观测修复（2026-10-03；readiness passed，整体仍 blocked）

- 读取上轮 run3 的 `readiness-result.json`、`submitted.txt` 和 mock request，确认回复已经完成，旧 `submitted_input_visible` 只检查最后 composer，因此清空后 false。本轮只修改正式 `run-binary-gate.py`、`test-release-driver.py` 与本文，不改产品、launcher、sandbox 权限或 baseline 脚本，不重建、不替换根 binary，无 worktree/commit/push。
- 新私有证据根 `/private/tmp/mods-submitted-f5_urlzu`；HOME/config/TMPDIR 和测试 fixture 全在该根下。纯测试先红：`submitted-red-final.log` 明确失败于 completed transcript + matching request；更早的 `submitted-red.log` 是测试表达式换行解析错误，不能当作产品/harness 的有效红灯。修复后 `submitted-green.log` **7 pass / 0 fail**，覆盖 submitted 语义、readiness request、完整 target policy、CLI、external binary/root 和真实 OS atomic config 回归。未运行全量产品测试/build/release-check。
- submitted 断言保留，使用同次 pane 中精确 user transcript → assistant response 顺序、ready composer，以及同次 provider snapshot 的 `POST /v1/responses`、`matches_dummy=true`、`response_kind=retained-readiness`、user input 精确匹配联合判定。request 不再通过 JSON 子串误识别 assistant 文本/错误输入。未提交 draft、只有 response、无 request、错误 method/path/response-kind/auth、缺失或空 input、assistant role 和相似但错误 input 均拒绝。共享 `submitted_input_visible` 不改，避免影响 legacy handlers；没有删除 submitted 断言、增加 sleep 或放宽身份。
- 正式执行命令与白名单环境见 `capture-command.txt`、`gate-command.txt`；使用新 `run1`，命令结构同上节，不传 `--targets` 或 `--base-ref`。capture exit0；driver 前台执行并自行 exit2，返回前 final manifest 已生成，stdout/stderr/exit 均保留。指定 binary SHA-256 仍为 `7ce43a3c5662cf8554b17f898ae6539527f6a4bb2343330f5c8bd6920a44a052`；HEAD `b66311c5338ab28871ce122014b2f84d7cff6530`，不是本轮新 build。
- 最终证据 `/private/tmp/mods-submitted-f5_urlzu/run1/evidence/driver-final-manifest.json`：readiness **passed**，startup/input/submitted/response 四项通过；`overall_verdict=blocked`、`matrix_complete=false`。仍保留上节完整 **26 planned / 25 required**，只执行 readiness。首个后续阻塞 `agent-fg-bg: runtime cleanup and child environment not adapted`，其余具体阻塞见 `blocked_targets`，不能称完整门禁通过。
- 精确副作用审计 `/private/tmp/mods-submitted-f5_urlzu/run1/effects.json`：server PID `20384`、pane `$0 @0 %0 20387` 均退出，server/kill-server exit0，本轮 `/run1/t` 已释放，mock port `62788` 不监听，未发现本轮残留进程或打开句柄。repository baseline→final 不变，protected 根 binary SHA `34adf2f3009c879ff11bf305fc0a90efc9d069cba806bf99c6241ed30d54aa0f` 不变。配置路径及权限/stat 清单已保存，不打印配置内容。
- **真实余项/非零副作用**：`config/history.jsonl.lock`、`config/plugins/marketplaces/Esonhugh-Marketplace/.git/config.lock`、`t.lock` 保留且无打开持有者；debug 审计有25行关键词匹配，包括 sandbox 拒绝外部 `/tmp/cc-socks` listener、concurrent-session atomic rename、marketplace config/clone/清理，以及可选目录缺失。不是25个独立产品bug，也不能称零错误或零残留；本轮没有为此扩大权限、修改产品或清理旧目录。`.claude.json` 精确 atomic/lock OS 回归通过，不等于所有 config atomic 生命周期都已通过。
- 仅本轮源代码增量 `/private/tmp/mods-submitted-f5_urlzu/source-diffs.patch`，既有 diff 保留；`git diff --check` 通过。新旧证据均保留，无主动目录删除。覆盖结论：submitted **unit covered** 与真实 readiness **binary smoke covered**；完整 retained handlers、G5 consent/cancel/turn-end/resume、Mods feature、fault injection 和 frame/physical 仍 **not covered**。下一入口是 retained handler owned 生命周期/真实 G5 场景适配及上述副作用审查，不再是本次 submitted 假阴性。

#### G5 真实 slash 入口专项（2026-10-03；部分通过，整体 blocked）

- 正式 harness 增加 feature-specific G5 场景；未改产品或重建，使用 SHA `7ce43a3c5662cf8554b17f898ae6539527f6a4bb2343330f5c8bd6920a44a052`。纯回归先红后绿，最终 **5 pass / 0 fail**；首次运行的 consent subtitle 截断假阴性另补回归，改为 dialog ID 与三个选项联合观测，不依赖完整长句。
- 两轮均前台执行到 final manifest；最终 `/private/tmp/mods-g5-WXL73ru4/run2/evidence/driver-final-manifest.json` 为 **blocked**、`matrix_complete=false`，保留 **26 planned / 25 required / 25 blocked**。readiness passed；terminal-interaction 仅执行 G5 子矩阵，不等于完整 target 通过。
- `G5-not-now` **passed**：真实 slash/consent/Not now；模型收到未启用说明，无 authoring root、无 consent 记录。`G5-cancel` **passed**：真实 consent/Ctrl-C，无 POST/root/consent 记录。
- `G5-enable` **failed（部分断言通过）**：创建精确 session root，模型收到同一 root，同 session dev-mods JSONL 已持久化；8 项状态断言通过，后续 clear-cancel 判据失败。`/clear` 后再次调用确实重新询问；Ctrl-C 后 composer 恢复 `/plugin-authoring`，而 harness 要求空 ready prompt。主线程已读取 `run2/g5-enable/evidence/clear-cancel.txt` 确认该画面；尚未判断恢复 draft 是否为预期产品行为，不据此改产品或放宽断言。
- exact argv/env 见 `/private/tmp/mods-g5-WXL73ru4/commands{,2}.json`；回归日志 `red.log`、`consent-red.log`、`regression2.log`。场景保留 raw input hex、pane、mock requests、debug、语义状态和退出结果。副作用 `effects.json`：四个 server/pane 均退出，四个 socket 释放，仓库及根 binary 不变；仍有 **12 个 lock 路径**保留，不能声称零残留。
- **未覆盖**：turn-end plugin load、resume、逐帧 logical/physical。持久化落盘不等于 resume，通过普通 smoke 不等于 Mods 验收通过。用户反馈卡顿后暂停追加重型验证；下一步先对照取消时 draft 恢复的真实契约，再决定补回归修 harness 或产品。

#### G5 clear-cancel harness 契约修复（2026-10-03；仅纯测试，binary 未重跑）

- 只读核对源码链：`src/skills/bundled/pluginAuthoring.ts` 等待 `requestModAuthoringConsent`；`src/screens/REPL.tsx` 的 consent dismiss 通过 `ModAuthoringPromptDismissedError` 抛出，而 slash submission 尚未调用 `onPromptAdmitted`，因此 `restoreOnError` 在 draft generation 未变化时恢复原始 `/plugin-authoring`。`src/screens/REPL.submit.test.ts` 已覆盖未 admit error 恢复 snapshot 且不覆盖并发新编辑。故 run2 `clear-cancel.txt` 中恢复该 draft 是产品契约，原先要求空 composer 的 `input_prompt_ready` 是 harness 假阴性；未修改产品。
- 新增最小纯 harness 测试，先红于缺少 `retained_g5_clear_cancelled`（`AttributeError`），修复后单测 **1 pass**。新判据联合要求 consent dialog 消失、最后 composer 精确恢复 `/plugin-authoring`、最后 prompt 后无 `esc to interrupt`，且相对取消前没有新增 `POST`、authoring root 或 `dev-mods` consent。负例覆盖错误 draft、残留 dialog、仍执行中，以及三类新增副作用；不接受空或任意 draft。
- 只运行上述 Python 内存单测；未启动 build、tmux、完整 gate 或其他 suite。历史 `/private/tmp/mods-g5-WXL73ru4/run2` 结果仍保持 **failed/blocked**，binary 未重跑，不能把本次 harness unit green 记为真实 G5 passed。
- 后续轻量核查更新 12.6 的 P2/P7/F1 状态，避免表格继续把已实现项目标为未实现。完整读取纯数据 `typeContract.test.ts` 后，在 `/tmp` 私有 HOME/config/cache 下运行 `bun test src/services/mods/typeContract.test.ts`：**32 pass / 0 fail / 33 assertions**，证据 `/tmp/mods-contract-suite-lf816yny/{result.json,test.log}`。覆盖无运行时 import、三原样契约、词法诱饵、非法引用与 foreign write；不替代 F1 全产物依赖审计或 G5 动态验收。
- 同轮完整审查 `state.ts/state.test.ts` 的副作用（仅内存与 AsyncLocalStorage）后，在独立 `/tmp` 环境运行 `bun test src/services/mods/state.test.ts`：**15 pass / 0 fail / 40 assertions**，证据 `/tmp/mods-state-light-_hclfdum/{result.json,test.log}`。涵盖 16 写者 CAS、dispatch snapshot、自写可见、冲突单 key 刷新、owner/render purity、reset 后迟到写拒绝、旧 render/forget/reset 订阅 fencing；仍不能替代真实 UI reload/reset 及 physical 验收。

#### G5 续验前置：首个分歧停止边界（2026-10-03；纯 harness，整体 blocked）

- 重新核验指定 `/tmp/mods-native-lvqehl3p/output-qualified/built-claude`，SHA256 为 `7ce43a3c5662cf8554b17f898ae6539527f6a4bb2343330f5c8bd6920a44a052`。只读取 binary 做哈希，没有执行或重建。
- 读取上一轮 `/private/tmp/mods-g5-WXL73ru4/run2/evidence/driver-final-manifest.json`：`overall_verdict=blocked`、`matrix_complete=false`、25 required targets、`repository_state_unchanged=true`；三个 G5 场景 server exit 均为 0、socket 均释放。旧 enable 仍是 clear-cancel harness 失败，不据此认定产品分歧。
- 审查正式 G5 handler 发现：失败场景后仍会调用下一场景。新增 `test_retained_g5_stops_at_first_divergence`，mock 正式 readiness 调用，分别覆盖三个失败位置并检查落盘结果与 blocked verdict。先红（exit 1，首场失败仍调用 `['not-now', 'enable', 'cancel']`），再为正式 handler 加失败即停止；新测试及既有 G5 semantics、clear-cancel 三项纯测试 **3 pass / 0 fail**（exit 0）。未缩减 target planning，也未改产品代码。
- 证据 `/tmp/mods-g5-stop-WtuwCCuW/{red.log,red.exit,green.log,green.exit}`；测试通过 `nice -n 10 env -i ... python3 -B -` 导入正式测试文件并逐个调用上述三个测试；HOME/config/cache/TMPDIR 全部指向该根，新增测试只使用其 TMPDIR 内的自有 TemporaryDirectory 并自动清理。无 mock server、tmux、外网请求或真实凭据访问；未生成本轮 binary driver manifest。
- 本步骤仅完成续验前的停止边界回归。**未实现/未执行**新增 turn-end、same-session resume、fork 不继承场景；clear-cancel 的真实重验仍未执行，逐帧 logical/physical **not covered**。不能将本步骤的 unit green 计为 G5 binary 通过，整体仍 **blocked**。
- 最终 `git diff --check` 通过；`git status --short` 相比本轮开始新增 `src/hooks/useVirtualScroll.test.tsx` modified，非本轮修改，来源未知，未读取或回退，也未操作其他进程。因此暂停启动真实 gate，等待确认工作区变化来源；不能声称本轮仓库整体无额外变化。

#### G5 turn-end 单场续验（2026-10-03；harness gap，整体 blocked）

- 用户确认 `src/hooks/useVirtualScroll.test.tsx` 为外部既有变化，本轮不读取内容、不修改或回退。正式 retained baseline 新增显式 `CC_VALIDATION_STATE_CONTENT_EXCLUDE`，本轮仅排除此路径的内容摘要；仍记录其 Git 状态且保留 required-target 推导。该排除不等于验证此文件无内容变化，最终 diff 检查也排除此路径。
- 原仓库仅扩展正式 `run-binary-gate.py`、`test-release-driver.py`、上述 baseline 脚本与本文；无子 agent/worktree/build/full suite/产品修改/commit/push。新增 `--g5-scenario turn-end-load` 只限定 retained 诊断子场景，完整计划仍 **26 planned / 25 required**、整体 blocked。正式 handler 保留首失败停止。
- 新证据根 `/tmp/mods-g5-turn-0lgbfOs6`。turn-end 最小回归先红：`red.log`/`red.exit` 为不支持场景参数的 `TypeError`、exit1；内容排除回归 `exclusion-red.log`/`.exit` 为缺少排除字段的 `KeyError`、exit1。最小实现后 `green-final.log`/`.exit` **5 pass / 0 fail、exit0**：turn-end 单场路由、held provider 与 active-state 正反例、原停止边界、G5 semantics、clear-cancel，以及内容排除（合计五个测试函数）。命令为 `nice -n 10 env -i PATH=/opt/homebrew/bin:/usr/bin:/bin HOME=$E/home CLAUDE_CONFIG_DIR=$E/config XDG_CACHE_HOME=$E/cache TMPDIR=$E/tmp python3 -B -`，`runpy.run_path` 导入正式测试并仅调用这五项；未运行全 suite。
- 正式 capture/driver exact argv 与白名单环境在 `commands.json`；driver 参数为 `--repo <repo> --binary /tmp/mods-native-lvqehl3p/output-qualified/built-claude --run-root $E/run1 --retain-artifacts --baseline $E/run1/baseline.json --evidence-root $E/run1/evidence --g5-scenario turn-end-load`，无 `--targets` 缩减。前台等待自然返回：capture exit0、driver exit2，final manifest 已生成。进程继承 nice10；HOME/config/cache/fixture 在新根，dummy loopback，沿用 OS sandbox 禁止外网、keychain 与根外写入。
- 重新记录 binary SHA256 `7ce43a3c5662cf8554b17f898ae6539527f6a4bb2343330f5c8bd6920a44a052`、size101027426、mtime_ns1791007554364562538；不是本轮构建。`run1/evidence/driver-final-manifest.json`：readiness **passed**，`overall_verdict=blocked`、`matrix_complete=false`。只运行 readiness 与 **G5-turn-end-load**，未执行 resume/fork/clear/Not now/cancel。
- **首个阻塞为 harness gap，不是已证明产品分歧**：真实 `/plugin-authoring` → Enable 后，provider 的 request 已进入 hold、pane 有 `esc to interrupt`，`turn-active-before-write` 通过；精确 authoring root 为 `run1/g5-turn-end-load/config/dev-mods/d60f8a82-2d37-46f7-a7f3-38e83c2b1d1c`，但同刻 snapshot 的 JSONL `dev-mods` entries 为空。handler 报 `harness gap: exact consent session root not observed` 并在创建 child fixture 前停止；没有写 child、没有证明 turn 内不提前加载或 turn 后 UI marker 激活。不能将该 failed execution 计为产品失败或 G5 covered，也未追加重跑。下一步应先补“held request 中精确 root/session identity 与异步持久化”的最小 harness 回归；目前无依据提出或实施产品修复。
- raw input hex、pane、identity、server/debug/mock request 与语义状态保留于 `run1/g5-turn-end-load/evidence/`，失败结果 `readiness-result.json`；场景 tmux target `readiness:0.0`，identity `$0 @0 %0 4280`、server4277。`effects.json` 核查 readiness server/pane3791/3819 和场景4277/4280 均退出，端口54232/54266不监听，两 socket释放，kill-server/server exit均0。CLI 由 kill-server 清理，未观测独立 CLI 正常退出码，不声称 CLI exit0。
- `repository_state_unchanged=true` 仅针对明确排除后的内容范围及完整路径状态；binary/root binary 在 baseline→final 未变。保留6个 lock路径，无主动删除旧证据或 user HOME。debug有24行 error相关匹配，含隔离外 `/tmp/cc-socks` listener被拒、concurrent-session rename EPERM、marketplace clone/config/cleanup失败和可选目录不存在；不是24个独立bug，不能称零副作用。外网受sandbox禁止，但存在marketplace外联意图。
- **覆盖**：spec exists；上述聚焦 harness unit covered；turn-end真实加载、fault injection、逐帧 logical/physical **not covered**。整个 G5 与 release 仍 **blocked**。最终执行排除禁止读取路径的 `git diff --check -- . ':!src/hooks/useVirtualScroll.test.tsx'` 与完整 `git status --short`，证据保留。

#### G5 held identity harness 修复与 turn-end 单场复验（2026-10-03；单场 passed，整体 blocked）

- 仅修改正式 `run-binary-gate.py`、`test-release-driver.py` 和本文；未改产品、未启动 agent/worktree、未 build/全 suite/commit/push。执行均 nice10 串行；readiness 与唯一 turn-end 场景的 terminal 先后启动，未执行 resume/fork/clear。未读取、修改或回退 `src/hooks/useVirtualScroll.test.tsx`；沿用内容摘要排除且保留完整状态与 required targets。
- 最小回归先红：`/tmp/mods-g5-identity-c0zr9rip/red.log`、`red.exit`，缺少 `retained_g5_held_identity` 的 AttributeError，exit1。最小实现后 `green.log`、`green.exit` 为 **6 pass / 0 fail、exit0**（identity/延迟持久化、turn-end、semantics、失败停止、clear-cancel 纯契约、内容排除）；只通过 runpy 调用六个聚焦测试，不是全 suite。红测试最初在系统临时目录生成，本轮自有证据随后移动至上述 `/tmp` 根；真实运行全部在新 `/tmp` HOME/config/cache/fixtures/evidence 内。
- held identity 必须由唯一未返回的主 POST、dummy auth、三个一致 session headers、user payload 中完整 authoring root 声明、已存在的同名 root 和隔离 config 路径共同确定；拒绝错误/缺失 headers、非 user 内容、其他路径、重复请求与 symlink。不猜目录，也不以任意 session consent 代替。写 fixture 前保存 `held-identity.json`；release 后在原有 bounded terminal 观测中要求持久化的 `type/sessionId/folder` 精确匹配此 identity。单测覆盖 entries 先空后匹配；本次真实运行 entries 在 hold 时已落盘，**没有真实重现延迟落盘时序**。
- 使用指定 `/tmp/mods-native-lvqehl3p/output-qualified/built-claude`，执行前 SHA256 核验为 `7ce43a3c5662cf8554b17f898ae6539527f6a4bb2343330f5c8bd6920a44a052`；不是本轮构建。`binary.json` 保存 metadata；`commands.json` 保存正式 capture/driver argv 和白名单环境；无临时 driver、无 `--targets` 缩减。审查 retained launcher/sandbox：dummy loopback、根内写入、禁止外网/keychain，正式 cleanup 仅本轮 socket/server。
- capture exit0、driver exit2，已前台等待 `/tmp/mods-g5-identity-c0zr9rip/run1/evidence/driver-final-manifest.json`。readiness 与 **G5-turn-end-load passed**；`overall_verdict=blocked`、`matrix_complete=false`、25 required targets 保留，`repository_state_unchanged=true` 仅适用于排除后的内容范围及完整状态，binary/root binary 未变。
- 真实 `/plugin-authoring` → Enable 后，held request sequence2 的 session 为 `893bc1be-aaac-416d-8122-37c90dc6d4a1`，只在其精确 `config/dev-mods/<session>/g5-turn-marker` 写三文件合法最小 child。`turn-observations.json` 的20个 held samples 均显示 waiting=true、released=false、无 types、无 UI marker、仍有 esc to interrupt；release 后 exact dev-mods 持久化匹配，`turn-end-ui-active.txt:18-22` 同屏显示 response、`G5_TURN_END_ACTIVE` 与 ready prompt。debug:240-241、252-253 有 child hook/inline plugin 加载记录。此证据证明采样范围内不提前激活及 release 后 UI 实际激活；未另测 command，未宣称逐帧覆盖。
- 场景 raw input、identity、pane、mock requests、debug、server log、result 均保留于 `/tmp/mods-g5-identity-c0zr9rip/run1/g5-turn-end-load/evidence/`；target `readiness:0.0`，identity `$0 @0 %0 90890`、server90887。`effects.json` 确认 readiness server/pane90431/90452、场景90887/90890 均退出，端口57624/57645不监听，两 socket释放，kill-server与server exit均0；CLI 由正式 kill-server 清理，**未观测独立 CLI 正常退出码**。
- 保留14个含 lock 名路径；未删除旧证据或 user HOME。debug仍见 concurrentSessions rename EPERM、可选目录不存在、marketplace clone/config被拒，存在外联意图但 sandbox 不允许外网；不声称零副作用。用户报告卡顿时 driver 已结束，未追加真实运行；正式 baseline/final 的大范围 manifest/hash I/O 是可能原因，未做性能归因测量。
- 上轮 identity harness gap 已修复，本场未观测新的产品分歧或 harness gap，无产品修复建议。resume/fork/clear、fault injection、逐帧 logical/physical **not covered**；G5/release 整体仍 **blocked**。

#### G5 same-session resume 单场验收（2026-10-03；恢复后 marker 缺失，整体 blocked）

- 唯一 agent、原仓库，无 worktree/build/full suite/并行/产品修改/commit/push；所有执行 nice10。仅扩展正式 retained handler、聚焦测试、正式 launcher 的 retained 参数透传以及本文。未读取、修改或回退 `src/hooks/useVirtualScroll.test.tsx`；baseline 内容排除保留，Git 路径状态与 required targets 未缩减。未重跑 turn-end、fork/clear。
- 证据根 `/tmp/mods-g5-resume-eqzso9wi`。严格先红：`red.log` / `red.exit` exit1，same-session 路由没有更新 resume verdict，`assert result['resume'] == 'passed'` 失败。最小实现后 `green.log` / `green.exit` **5 pass / 0 fail、exit0**：same-session identity/marker 正反例、原 held identity、首失败停止、semantics、内容排除。通过隔离环境 `python3 -B -c` + runpy 逐一调用正式测试，不是全 suite，也未运行 turn-end/clear 测试。拒绝新 session header、任意 dev-mod entry、无请求、无 marker、非 dummy auth；launcher retained 分支真实透传 `"$@"`。
- 已读取原 `/tmp/mods-g5-identity-c0zr9rip` 成功证据。指定 binary `/tmp/mods-native-lvqehl3p/output-qualified/built-claude` SHA256 再核验为 `7ce43a3c5662cf8554b17f898ae6539527f6a4bb2343330f5c8bd6920a44a052`，不是本轮构建。`commands.json` 保存正式 capture/driver exact argv、白名单隔离环境及 inherited nice10；`--g5-scenario same-session-resume`，无临时 driver、无 `--targets`。
- 前台等待 capture exit0、driver exit2 与 `run1/evidence/driver-final-manifest.json`；readiness passed，G5 same-session **failed**，`overall_verdict=blocked`、`matrix_complete=false`、26 planned。`repository_state_unchanged=true` 只针对排除后的内容范围和完整状态；binary/root binary 未变。
- 原 session 为 `0289a112-124e-497b-91d5-c09386490599`。真实 `/plugin-authoring` → Down → Enter（Enable）后，唯一主 POST 的三个 session headers、user payload 精确 authoring root 与 `dev-mods` entry 一致。`original-identity.json`、`authorization-after-exit.json` 保存关联证据。仅在其 root 写 `g5-resume-marker` 三文件 child，原 CLI `original-ui-active.txt` 真实出现 `G5_SAME_SESSION_ACTIVE`；debug:249-266 有其加载记录。
- 产品支持的 `/exit` 正常退出，`original-exit.json` 的 tmux `pane_dead/pane_dead_status` 为 `1 0`，没有以 kill-server 代替原 session 退出。随后同一 socket/同一 pane 串行 `respawn-pane`，正式 launcher 启动 binary `--dangerously-skip-permissions --debug --debug-file <evidence>/debug.log --resume 0289a112-124e-497b-91d5-c09386490599`；`resume-launch.json` 保存完整 argv/命令，`input.json` 保存原始输入 hex。
- **首个可见分歧：原 session identity 已恢复，但 child UI marker 未恢复。** 恢复后的 `G5_RESUME_IDENTITY_PROBE` 得到真实 dummy provider response，sequence4 三个 headers 均仍为原 ID，精确授权持久记录仍存在（`resumed-identity.json`）；`resumed-exact-identity-ui.txt:8-19` 显示恢复的原对话、新 probe/response 和 ready prompt，却没有 marker。45秒 bounded wait 到期后 handler 停止，没有重试、没有进入其他场景，也没有修改产品。不能把 JSON 留存当作进程内授权恢复成功；本场不能判 passed。
- 最小产品回归建议：覆盖 Enable → child 激活 → 正常退出 → CLI `--resume <same ID>` 的 session authoring root 恢复与 plugin/UI 注册初始化顺序，断言恢复后无需重新 Enable 就出现 child marker。现有证据确定用户可见恢复失败，但尚未定位内部根因；sandbox 的 rename/unlink 限制仍是环境影响边界，不能直接断定某个产品函数有错。本轮未发现可确认的 identity/argv harness 假阳性，也未以改 harness 绕过缺失 marker。
- 场景全部证据在 `run1/g5-same-session-resume/evidence/`，包含 raw input、original/resumed identity、exit、pane、mock requests、debug、tmux-server.log 与 readiness-result。target `readiness:0.0`，原 pane `$0 @0 %0 42155`、恢复 pane `$0 @0 %0 42773`、server42151。失败后仅正式 cleanup 清理本轮 socket/server；恢复后的 CLI 未执行第二次正常 `/exit`，由 kill-server 停止，不声称其 exit0。
- `effects.json` 核实 readiness41944/41948、场景42151/42155/42773 均不存活，59801/59810不监听、两 socket 均释放、kill-server/server exit均0。fixture/config/cache/log/lock 保留；未删除旧证据或 user HOME。sandbox 限制根外写入、外网和 keychain，dummy loopback；debug 仍有 concurrentSessions rename EPERM、marketplace clone/config/cleanup失败及可选目录缺失，存在被阻止的外联意图，不声称零副作用。
- same-session 正向恢复已执行但未通过；child command 未另测。fork/clear 不继承、fault injection、逐帧 logical/physical **not covered**。上一轮 turn-end passed 不变，G5/release 整体仍 **blocked**。最终执行排除禁止路径内容的 `git diff --check` 与完整 `git status --short`，保留证据。

#### G5 same-session resume 产品修复（2026-10-03；源码 focused 红绿，binary 未重跑）

- 先核验上一节原始证据而非盲信 harness：原进程 `/exit` 为 exit0；恢复 argv 确实是 `--resume 0289a112-124e-497b-91d5-c09386490599`；恢复请求三个 session headers 与原 ID 一致；同 ID 的 `dev-mods` transcript 记录仍存在；恢复 UI 有原对话及新 response，但没有 `G5_SAME_SESSION_ACTIVE`。因此 identity、授权持久记录与恢复输入均成立，首个产品分歧是恢复后的 child 未被重新发现。
- 代码链确认 `processResumedConversation()` 在非 fork 时保留 `devModsFolder`，`main.tsx` 传入 `initialDevModsFolder`，`REPL.tsx` 在首次 host bind 前调用 `restoreAuthoringConsent()`；根因位于已初始化的 `createModsSession`：恢复只在 `bind()` 设置 `authoringEnabled/root`，但原逻辑只有首次初始化或 timer 存在时才 `refresh()`，同 ID 恢复落入单纯 `runtime.bind()`，不会扫描 authoring root。不是 `main` 初始 resume 字段或 `sessionStorage` 丢失。
- 最小行为红测使用新建 `/tmp` authoring root、真实 child `register.ts` 和真实 Mods runtime：预先初始化 host 后，对同一 session 恢复授权并再次 bind，期望 child `command.run` marker 可用。修复前 `authoringLoads` 为 0，**0 pass / 1 fail**；证据 `/tmp/mods-g5-red-Odqyzn/red.log`（首次记录命令的 shell 状态变量只读导致外围命令也 exit1，但 Bun 失败正文完整）。
- 最小修复在 `src/services/mods/session.ts` 显式记录一次待消费 restore；下一次 `bind()` 无论同 ID 还是不同 ID 都消费它并走既有 `refresh()`。`refresh()` 继续经过 `deferAuthoringRefresh()`，因此 active public turn 下仍延迟到 `finishTurn()`；session 切换继续执行原 cancellation/generation fencing。恢复 `undefined` 也执行一次 reconcile，确保 clear/fork 移除旧 authoring child；runtime activation 未重建，配置插件的 `session.start` 计数保持 1。
- 新回归覆盖：已初始化 runtime 的同 ID restore、turn barrier 前不加载/结束后加载、真实 child marker、clear/fork 不继承、配置插件不重复 `session.start`；并将初始 CLI restore 与 fork 测试从仅 source 字符串升级为可执行 AST 提取行为，验证 restore 先于首 bind，且 `processResumedConversation` 仅非 fork 返回 authoring root。focused 结果：`src/services/mods/session.test.ts` **59 pass / 0 fail**；REPL resume 相关 **4 pass / 0 fail**。最终证据 `/tmp/mods-g5-focused-7U1ZYi/`；更小绿测另见 `/tmp/mods-g5-barrier-ZIBIuw/`、`/tmp/mods-g5-repl-mk5j3m/`。
- 所有本轮 test HOME、`CLAUDE_CONFIG_DIR`、XDG cache 与 TMPDIR 都在各自新建 `/tmp` 根；fixtures 由测试 `mkdtemp` 创建并在 `afterEach` 清理，测试 mock secure storage 并禁止意外写入。未读取/修改用户 HOME，未修改或删除旧 evidence，未使用 agent/worktree，未 build、tmux、全 suite、commit 或 push。
- **剩余动态步骤：** 当前只证明源码行为红绿，上一节旧 binary 失败事实不变；尚未构建新 binary，也未重跑同 ID `--resume` 真实 marker、fork/clear 动态场景、fault injection 或 logical/physical 帧，因此 G5/release 仍 **blocked**。

#### G5 resume 最终验证尝试（2026-10-03；隔离构建首错停止，未进入 gate）

- 按用户要求仅在原仓库串行执行，未启动 agent/worktree、未跑全 suite、未改产品、未 commit/push，也未删除旧证据。先审查 `session.ts` 最新 `authoringRestorePending` 消费路径、`Makefile`、`build.mjs`、`package-binary.mjs` 与正式 retained capture/driver；确认 retained runtime sandbox 的 unlink 白名单仅包含本轮 tmux socket、`.claude.json`、其 lock 与精确 atomic 临时文件，正式 retained preflight 不构造带旧清理行为的 `BinaryGate`。
- 新私有根为 `/tmp/mods-g5-final-sCsbO8kl`，权限 0700；HOME/config/cache/tmp/evidence 均位于该根。构建命令使用 `nice -n 10`、`env -i` 与 macOS `sandbox-exec`，禁止外网和用户 keychain/`~/.claude` 读取，目标为新的 `/tmp/mods-g5-final-sCsbO8kl/output`，没有覆盖仓库根 `built-claude`。精确命令、stdout/stderr、exit 与构建前 source identity 分别保存在 `evidence/build-command.txt`、`build.stdout.log`、`build.stderr.log`、`build.exit`、`source-identity-before.json`。
- **首个错误：隔离构建 exit 2。** `prepareBuildDirectory()` 将 `/tmp` canonicalize 为 `/private/tmp` 后尝试 `mkdir '/private/tmp/mods-g5-final-sCsbO8kl/output'`，但本轮 build sandbox 的写白名单使用了未 canonicalize 的 `/tmp/...` literal/subpath，因而返回 `EPERM: operation not permitted`（`scripts/build.mjs:238`）。这是本轮 sandbox 配置路径别名不一致，不是 G5 resume 产品结果；遵循首错停止，没有放宽 sandbox、没有重试构建，也未启动 capture/retained gate。
- 失败后副作用记录为 `/tmp/mods-g5-final-sCsbO8kl/evidence/post-failure-effects.json`：output 不存在；HEAD 仍为 `b66311c5338ab28871ce122014b2f84d7cff6530`；排除本文追加前记录的 status/unstaged/staged 身份在失败后均一致；受保护根 binary 仍为 SHA-256 `34adf2f3009c879ff11bf305fc0a90efc9d069cba806bf99c6241ed30d54aa0f`、size `101010914`。本轮没有新 binary SHA，未生成 final manifest。
- **未覆盖：** same-session resume、真实 fork/clear、既有 turn-end/not-now/cancel 复跑、完整 required targets、fault injection、logical/physical 帧。上一轮 turn-end 与源码 focused 结果不变，但不得据此称本轮 binary 或完整门禁通过；G5/release 仍 **blocked**。

#### 指定新 binary G5 正式复验（2026-10-03；resume 首错停止，整体 blocked）

- 本轮只执行正式新 binary，不 build、不改产品或 harness、不运行源码测试/全 suite、不启动 agent/worktree、不 commit/push。指定产物 `/private/tmp/mods-g5-build-v99qwqx0/output/built-claude` 与 `evidence/build-result.json` 一致：build exit **0**，SHA-256 `3df0e1eb47789ac680296fde3b66d2bcc8a337d95038cb85adaf0e0a5a3dd931`，size `101027426`，mtime_ns `1791017584006968029`；build argv 见同根 `evidence/build-command.json`。HEAD 为 `b66311c5338ab28871ce122014b2f84d7cff6530`。本轮未把该既有产物冒称为本轮构建。
- 新 canonical 私有根 `/private/tmp/g5v99-rBXZMJ`（0700）；所有正式命令均 `nice -n 10`、`env -i`、dummy loopback，HOME/config/cache/TMPDIR/fixture/evidence 均在该根。正式 capture exit **0**，gate 自行 exit **2** 且已生成 final manifest；exact argv/env 见 `resume-{capture,gate}-command.txt` 及 final manifest。没有 `--targets` 或 `--base-ref`，完整 **26 planned / 25 required / 25 blocked** 清单保留。
- 正式结果 `/private/tmp/g5v99-rBXZMJ/resume-run/evidence/driver-final-manifest.json`：readiness **passed**，G5 `same-session-resume` **failed**，`overall_verdict=blocked`、`matrix_complete=false`、`repository_state_unchanged=true`。按“首个分歧停止”没有再运行 default G5 矩阵，因此本轮 `turn-end-load`、`not-now`、`enable+clear-cancel`、`cancel` 均 **not covered**；fork 没有正式 handler，保持 **not covered**，不编造覆盖。既有历史通过不算作本轮新 binary 复验结果。
- 原 session `560c2a53-d915-4909-a6bc-d2bfcce7d277`：真实 `/plugin-authoring` 授权、模型响应、精确 dev-mods entry、child fixture 与 `G5_SAME_SESSION_ACTIVE` 均成功；`original-ui-active.txt:16-24` 显示 marker，随后正式 `/exit` 的 pane dead/status 为 `1 0`。恢复使用同一 socket/pane 串行 `respawn-pane`，argv 为 `--resume 560c2a53-d915-4909-a6bc-d2bfcce7d277`。
- **首个可见分歧仍是恢复后 marker 缺失。** `resumed-identity.json` 证明恢复请求 sequence4 的 `session-id`、`thread-id`、`x-claude-code-session-id` 均为原 ID，dummy auth 匹配，精确 `dev-mods` entry 仍存在；`resumed-exact-identity-ui.txt:8-19` 显示恢复的原对话、新 probe/response 与 ready prompt，但没有 `G5_SAME_SESSION_ACTIVE`，45 秒 bounded wait 到期。debug `:248-269` 的 marker load 均发生在原进程；恢复启动后 `:309-323` 只发现标准插件并记录 `Registered 0 hooks from 2 plugins`。因此新 binary 未证明 `authoringRestorePending` 在实际 same-session resume 中重新加载 marker；未通过重试或修改判据掩盖失败。
- 终态 `/private/tmp/g5v99-rBXZMJ/final-effects.json`：readiness/G5 server PID `15777/15960` 均退出，loopback port `62476/62485` 不监听，两条 tmux socket 均释放；binary SHA/size/mtime 与执行前一致，HEAD 未变。证据与 fixture/lock 保留，没有清理旧证据或 user HOME。恢复后的 CLI 由正式 kill-server 停止，不能声称其独立正常 exit0。
- physical/logical frame、fault injection、完整 required handlers 仍 **not covered**；本轮只记录正式 resume 分歧，不以 readiness 或原进程 marker 成功宣称 G5/release 通过。

#### G5 cold `--resume` 首分歧修复（2026-10-03；真实读取链 focused 红绿，新 binary 待重跑）

- 只读取本节新证据 `/private/tmp/g5v99-rBXZMJ/resume-run/` 与实际源码链；未触碰用户 HOME、旧证据或 retained fixture，未启动 agent/worktree、未 build/tmux/full suite、未 commit/push。所有测试使用新的 canonical `/private/tmp/mods-cold-resume-*` 0700 根，HOME/config/cache/TMP 均隔离，`env -i`、`nice -n 10`。
- 新 binary SHA-256 `3df0e1eb47789ac680296fde3b66d2bcc8a337d95038cb85adaf0e0a5a3dd931` 的失败事实保持不变：原 session Enable、child marker、`/exit` exit0 均成立；恢复 sequence4 的三个 session headers 与原 ID 相同，精确 `dev-mods` JSONL entry 仍在，但恢复进程 debug 只报 `Registered 0 hooks from 2 plugins`，没有 child marker。未再把 `session.bind` 当作全部根因。
- **更早的首个字段分歧：** direct UUID `--resume` 在 `main.tsx` 调用 `loadConversationForResume(sessionId)`，其 string 分支调用 `getLastSessionLog()`。`loadSessionFile()`/`loadTranscriptFile()` 已正确解析并返回 `devModsFolders`，`getLastSessionLog()` 也解构了该 map，却遗漏把 `devModsFolders.get(sessionId)` 写入返回 `LogOption.devModsFolder`。所以后续 `loadConversationForResume → processResumedConversation → main initialDevModsFolder → REPL restoreAuthoringConsent → first bind` 接到的是 `undefined`；REPL 的 restore/bind 顺序及 `authoringRestorePending` 修复实际没有得到授权 root。cwd、session ID、transcript adoption 路径未见先于此处的分歧。
- 新回归不是 source 字符串或单独 slice：独立子进程在隔离 config 下走真实 transcript persistence，写入真实 `dev-mods` entry 后调用实际 `loadConversationForResume(sessionId, undefined)`，再把返回字段交给真实 `createModsSession.restoreAuthoringConsent()` 与首次 `bind()`，断言 authoring root 的真实 child 被扫描。修复前 `/private/tmp/mods-cold-resume-red-yjVojM` 为 **8 pass / 1 fail**，关键断言 expected 精确 session root、received `undefined`。
- 最小修复仅在 `src/utils/sessionStorage.ts` 的 `getLastSessionLog()` 返回值补上 `devModsFolder: devModsFolders.get(sessionId)`，与同文件 `loadFullLog()`、`loadTranscriptFromFile()` 已有 metadata 映射一致；没有新增 fallback、放宽 root/session 校验，也保留上次 `authoringRestorePending` 修复。两者作用不同：本次修复确保 cold UUID resume 把 persisted root 送达 REPL；上次修复确保送达后即使 Mods host 已初始化，下一次 bind 也会 reconcile/扫描 child。
- 最终 focused `/private/tmp/mods-cold-resume-bind-green-iYGZwt`：`src/utils/sessionStorage.restart.test.ts` **9 pass / 0 fail / 9 assertions**。仅证明源码真实读取到首次 bind 链路；指定新 binary 尚未包含本次修复且没有重跑，same-session marker、完整 G5/release、fork/clear 动态、fault injection、logical/physical frame 仍 **blocked/not covered**。

#### G5 cold resume 新 binary 复验尝试（2026-10-03；canonical root preflight 首错停止）

- 按要求先读取本节上一记录、正式 `Makefile`、retained `capture-release-baseline.py`、`run-binary-gate.py`、launcher，以及成功构建证据 `/private/tmp/mods-g5-build-v99qwqx0/evidence/{build-command.json,build.sb}`。确认 `make build CLAUDE_CODE_BUILD_DIR=<new output>` 不覆盖根 binary；正式 retained driver 支持先单独执行 `--g5-scenario same-session-resume`，默认余项顺序为 `not-now → enable(clear-cancel) → cancel → turn-end-load`，fork 没有正式 handler。计划保留默认 26 planned / 25 required 与整体 blocked，不运行全 suite、并行或嵌套 agent。
- 本轮唯一新根最初由 `mktemp -d /tmp/mods-g5-cold-resume-XXXXXXXX` 创建为 `/tmp/mods-g5-cold-resume-MMxz2CgN`，实路径 `/private/tmp/mods-g5-cold-resume-MMxz2CgN`，权限 0700。预定构建命令复用已审查模式：`/usr/bin/nice -n 10 /usr/bin/sandbox-exec -f <canonical-root>/build.sb /usr/bin/env -i ... make -C <repo> build CLAUDE_CODE_BUILD_DIR=<canonical-root>/output`；白名单仅包含隔离 HOME/config/cache/tmp、固定 PATH、禁 telemetry/updater，Seatbelt 禁外网并只允许本轮 canonical root 写入。
- **首个失败发生在构建启动前的本轮 shell preflight，exit 1。** `mktemp` 返回 `/tmp/...` 字符串，而 guard 使用 `[ "$ROOT" = "$CANON" ]` 要求它与 `realpath` 的 `/private/tmp/...` 字面相等，输出 `non-canonical root: /tmp/mods-g5-cold-resume-MMxz2CgN -> /private/tmp/mods-g5-cold-resume-MMxz2CgN`。这正是路径 alias 检查写反造成的本轮执行环境错误，不是产品、build 或 resume 分歧；遵循“首个失败停止”，没有以 canonical 值重试，没有执行 `make build`、capture、gate 或任何 binary。
- 终态证据保留于 `/private/tmp/mods-g5-cold-resume-MMxz2CgN/evidence/`：`preflight-failure-final.json`、`failed-command.txt`、`git-status-final.txt`、`git-diff-check-final.txt`、`process-socket-final.json`。没有新 binary 或 SHA；根 `built-claude` 仍为 SHA-256 `34adf2f3009c879ff11bf305fc0a90efc9d069cba806bf99c6241ed30d54aa0f`、size `101010914`、mtime_ns `1790956136193023479`。HEAD `b66311c5338ab28871ce122014b2f84d7cff6530`，branch `feat/mods`；`git diff --check` exit 0，完整 dirty status 已保存。最终无本轮 owned process、无 socket；未创建 tmux server/pane，因此没有 process target 或 final manifest。
- 本轮仅追加本文记录，不修改产品或 harness，不清理本轮失败证据、旧证据、用户 HOME，不 commit/push/worktree。same-session resume、clear-cancel、turn-end、not-now、cancel、fork、fault injection、logical/physical frame 与完整 required targets全部 **not covered**；整体仍 **blocked**，不得宣称 physical/full gate 通过。

#### G5 cold resume 修复后原生产物重验（2026-10-03）

- 统一使用 canonical `/private/tmp` 后，正式隔离 `make build` exit **0**；产物 `/private/tmp/mods-cold-fixed-3hb46b5r/output/built-claude`，SHA-256 `a36360e4b4ea5a349ada38c9c390c257de306c2d28a51f76b414a5b2e78070b6`。包含 `authoringRestorePending` 与 `getLastSessionLog.devModsFolder` 两处修复；构建 argv/result/log 在同根 `evidence/`，没有覆盖仓库根 binary。
- 单终端、低优先级正式 retained 重验：`/private/tmp/g5sr-20261003T092215Z-83602/evidence/driver-final-manifest.json`。readiness **passed**，`same-session-resume` **passed**，首分歧为 null；driver exit **2**，完整 required-target 策略继续保持 `overall_verdict=blocked`、`matrix_complete=false`，并非 release 通过。
- 原 session `f8f124e9-4acf-473b-aa81-8c6cf7281596` 的 authoring root 为该 run 下 `g5-same-session-resume/config/dev-mods/<session-id>`。原进程与真实 `--resume` 新进程均显示 `G5_SAME_SESSION_ACTIVE`；恢复请求的 `session-id`、`thread-id`、`x-claude-code-session-id` 与原 ID 一致，persisted entry/root 一致。两个 CLI 均正常退出，pane dead/status 为 `1/0`。
- tmux server exit 0，私有 socket 已释放，无本轮残留进程；`repository_state_unchanged=true`。全部证据保留，未清理旧文件、用户 HOME 或共享配置，未 commit/push。
- 本次仅闭环 cold same-session resume 专项。修复后其余 G5 场景仍需同产物重验；fork、fault injection、逐帧 logical/physical 和完整 required-target 门禁仍未覆盖，不能由该专项通过推定完成。

#### G5 同产物默认场景复验（2026-10-03；非完整门禁）

- 使用上述 SHA-256 `a36360e4b4ea5a349ada38c9c390c257de306c2d28a51f76b414a5b2e78070b6` 原生产物，正式 retained 默认场景，不传 `--g5-scenario`，新根 `/private/tmp/g5r-20261003T093015Z-5667`。`evidence/driver-final-manifest.json` 与 `evidence/g5-result.json` 记录 `not-now`、`enable`（含 `/clear` 后 `clear-cancel`）、`cancel`、`turn-end-load` 全部 **passed**，首分歧 null。turn-end 包含 held 阶段不提前加载与结束后 UI marker 断言。
- driver exit **2**，`overall_verdict=blocked`、`matrix_complete=false`、`recorded_run_count=2 / expected_run_count=26`；25 required targets 仍 missing，没有缩减矩阵。此 run 的 resume 为 **not covered**；上一独立 run 的 resume 专项通过不得拼接为完整同轮门禁。logical/physical、fork 和独立 child command 仍未验收。
- readiness 与四个场景的 server 均 exit 0，私有 socket 均释放，无本轮残留进程/socket。binary hash 前后不变，`repository_state_unchanged=true`，Git status/staged/unstaged 前后哈希一致，HEAD `b66311c5338ab28871ce122014b2f84d7cff6530`。全部证据保留，没有删除旧证据、修改共享配置或执行 commit/push。

#### G5 fork 前置发现 AbovePrompt continuation 缺陷（2026-10-03）

- 正式 retained driver 新增 `fork-session`，默认 G5 同轮矩阵纳入 same-session resume 与 fork：验证新 session headers、原授权保留、fork 不继承 marker/root、重新 consent 与取消无新增副作用。harness focused 红绿完成，但真实 fork 尚未执行到，不能计为通过。
- 第一轮 `/private/tmp/g5f-20261003T095005Z-59179/evidence/driver-final-manifest.json` 在原 session 双 marker 前置失败：两个同级 plugin 各直接返回 Text，使 middleware 首个 handler 短路；仅 CHILD 出现。这是 fixture 错误。保持双 marker 断言，将 fixture 改为 `async next` 后用 Box 保留下游树；实际生成 handler 的可执行回归红绿证据 `/private/tmp/g5-marker-regression-{red,green}/test.log`。
- 第二轮 `/private/tmp/g5-F4xTu4/evidence/driver-final-manifest.json` 暴露产品缺陷：合法 `await next(e)` 返回嵌套 `{type:'engine', ref}`，`ModsAbovePrompt` 忽略 consumer 的 `resolveEngine`，直接交给不持有 ref 集合的 `ModsPane`，导致 `Unknown Mod UI engine ref`。原 session 已渲染崩溃，fork 尚未执行；没有放宽判据或改回直接 Text 绕开问题。
- 最小产品修复位于 `src/components/ModsAbovePrompt.tsx`：通过本次 consumer 的 resolver 验证 engine continuation，再在 AbovePrompt 空 host 呈现位置物化为空 Box；递归普通 children、保留 callback/owner/clientBindings，不跨 Client 边界，不放宽共享 renderer 校验。顶层 engine 同样先验证再保持空呈现。
- 真实 mount/dispatch/Ink 双 middleware 回归与未知 ref 错误路径：`/private/tmp/mods-above-prompt-fix.xTGU5R/red.txt` 为 **7 pass / 1 fail**，稳定复现错误；`green-final.txt` 为 **9 pass / 0 fail / 39 assertions**，scoped lint 与 diff check 通过。未 build 或运行修复后 binary。
- **产品修复使此前 binary 验收过期。** 需新隔离构建并重放错误序列及 G5 默认同轮矩阵；fork、完整 required targets 与 logical/physical 仍未验收。上述失败 run 的本轮进程/socket 均释放，证据保留，不触及旧文件或共享 HOME，不 commit/push。

#### G5 启动 binding 与取消传播修复（2026-10-03；新产物待验）

- continuation 修复产物 `/private/tmp/tmp84k7ekhx/output/built-claude`，SHA `05e9edf27b4302f977774c07c2521bbd7ac4edd15a68273b4903403e8ff49317` 构建成功。正式默认六场景 `/private/tmp/g5n-dc59fc/evidence/driver-final-manifest.json` 前四通过；same-session 原进程双 marker 正常，恢复启动却缺失。debug `455-458` 证明两个插件已扫描并调用 `ui.render`，但均报 `Module capability ui.resolve was withdrawn`。不是旧字段遗漏、fixture 或 continuation 渲染错误，不放宽启动即 marker 判据。
- 根因是 `session.ts` 新 runtime 先 publication/reconcile 再 bind terminal。修复为局部创建 runtime、先 bind、确认未 stopped 后再暴露并 reconcile，dispose 期间未发布 runtime 会释放，既有 runtime clear 路径不重放旧 binding。确定性 publication barrier 红 `/private/tmp/mods-cold-resume-red.LwbQ2l/test.log` **0/1**，绿 `/private/tmp/mods-cold-resume-green.KFkPZX/test.log` **1/0**；完整 session 文件 `/private/tmp/mods-session-final.RGXmDP/test.log` **60 pass / 0 fail / 270 assertions**，包括 session.start 恰一次。
- 一次构建 harness 误预建 exclusive output，`/private/tmp/mods-bind-fixed-antnzg5g` 因 EEXIST 停止，无产物；保留失败。随后新根 `/private/tmp/mods-bind-build-wtnxs1g4` 不预建 output，正式 build exit0，产物 SHA `75633c227a84df3ef78326a2f1e8f938a50de99c2b98a65f6eccd77c56fa5e2e`，根 binary 与 Git 状态不变。
- 该产物正式同轮默认 G5：`/private/tmp/g5b-185548-36f7/evidence/driver-final-manifest.json` 前五 **passed**，same-session 恢复启动即双 marker、identity、两个正常 exit 都通过。fork 新 ID 与不继承原 root/marker、重新 consent 通过，但 Ctrl-C 后 draft 为空，`fork-consent-cancel` **failed**。无新增 POST/root/entry；未将局部 fork 通过冒称整个场景通过。进程/socket 全部释放，证据保留，整体仍 blocked。
- 真实取消恢复链断点：`processSlashCommand.tsx` 将 `ModAuthoringPromptDismissedError` 吞为正常 `shouldQuery:false`，REPL 未 admitted 的 `restoreOnError` 得不到 rejection。修复仅对专用 dismissal 异常重新抛出；普通错误 stderr 与 AbortError Interrupted 保持原行为。catch 内动态加载异常类，未引入顶层 session 依赖或普遍恢复所有 local command。
- 真实 slash-command 到 REPL 恢复回归 `/private/tmp/g5-dismissal-fix-redgreen/logs/red.log` 为 **115 pass / 2 fail**；修复后 `green.log` 两个相关测试文件 **116 pass / 0 fail / 486 assertions**，diff check 通过。**本次产品修复再次使旧 binary 验收过期**，尚未构建或真实重放；G5、fork、logical/physical、完整发布门禁均不可宣称完成。

#### G5 取消根因与同轮六场景通过（2026-10-03；完整发布仍 blocked）

- 单独修复 dismissal 传播及随后 abort-first 语义统一（`requestPrompt` 的 abort listener 优先 `item.dismissError`，普通 prompt 保留 signal.reason）后，真实 fork 取消仍失败。失败记录分别保留 `/private/tmp/g5d-9cb5e22b6ba0`、`/private/tmp/g5a-c35b6a5ac5`。两种取消顺序的真实 requestPrompt/session/slash/submit 组合测试虽通过，不能代替 binary 结果。
- 临时无内容诊断产物 `9180565db00a75f7733b7686f7b650a3c920f051610f582eded0342a8c1686f9` 的 run `/private/tmp/g5e.NdWmjK` 首次给出决定性观测：debug `514-518` 显示 dialog-dismiss、slashCatch dismissal、restoreOnError 已进入且未 admitted，但 submittedGeneration=22/currentGeneration=23，来源 `set-pasted-contents`，故 canRestore=false。不能再把该现场归因于异常未传播。
- 真正剩余根因：`PromptInput` orphan-prune effect 在提交清空 input 后调用 paste updater，即使返回同一个 previous 对象，REPL wrapper 仍无条件增加 draft generation。最小修复先计算 next，对 `Object.is(next, previous)` 的 no-op 不增 generation；真实新增/删除/替换仍增加 generation，保持防覆盖。取消两顺序回归红 `/private/tmp/g5-regression-red.kGIgP5/red.log` **2 fail**，绿 `/private/tmp/g5-regression-green.SMEe15/green.log` **3 pass**；文件级 `/private/tmp/g5-regression-suite.8pfMtA/suite.log` **117 pass / 0 fail / 496 assertions**。临时 diagnostic markers 与 generation source 元数据已移除。
- 正式隔离 build `/private/tmp/mods-draft-build-h0ol8ve1/evidence/build-result.json` exit0；产物 SHA-256 `4157c065c477fe9440e92e8e36612be86ccdea533dde4115ed4331a7fbd3d9ab`。根 binary、Git 状态不变。
- 随后两处 harness 旧假设已按红绿修正，未放宽产品契约：初次 cancel 原本只接受空 composer，现精确要求恢复 `/plugin-authoring` 且无 busy/dialog/POST/root/entry（旧现场 `/private/tmp/g5-final-14b332afbd`）；fork cancel 验证通过后退出原先 append `/exit` 形成 `/plugin-authoring/exit`（旧现场 `/private/tmp/g5-ok-0d71b64af8`），现先真实 `C-u` hex15、确认空 composer 再 `/exit`。取消恢复断言仍先执行。
- **同轮正式 G5 六场景全部 passed**：`/private/tmp/g5-complete-fe17e9d0-591d-4a34-ac28-e056d2d8f32c/evidence/driver-final-manifest.json`。not-now、enable/clear-cancel、cancel、turn-end-load、same-session-resume、fork-session 均通过，first_divergence=null。resume 启动双 marker、同 ID、两个 exit=1/0；fork 新 ID、不继承授权/marker、重新 consent、取消精确 draft 与无新增副作用、C-u 清空和最终 exit=1/0 均通过。
- 本轮 binary 身份前后不变、repository_state_unchanged=true；所有 readiness/G5 server exit0、socket 释放、无本轮残留 runtime。证据全部保留，未 commit/push/worktree，未触及共享 HOME 或根 built。
- **证据身份边界：** manifest 中的 SHA-256 `4157c065c477fe9440e92e8e36612be86ccdea533dde4115ed4331a7fbd3d9ab` 只标识该轮冻结 binary。CHANGELOG 会内嵌进 binary，本次 README/CHANGELOG/mods-test 更新后必须重新 build 才能验收当前产物；不得沿用 `4157…` 声称当前工作区 binary 已通过。
- **覆盖边界不变：** 这是 G5 语义与生命周期专项，不是完整 feature/release 门禁。logical/physical frames、独立 child command、其余 M287/S1–S9 与完整 required targets 尚未闭环；driver exit2、overall blocked、required_target_coverage.passed=false。不得跨 run 拼接或将六场景通过扩张为整体通过。当前总判定仍为 **blocked**。

#### 文档同步后当前制品验证（2026-10-03）

- `make -j1 release-check` 首次发现 `scripts/build-isolated.test.mjs` 的六个 URL no-undef；显式从 node:url 导入 URL 后 focused ESLint 通过。全量 release-check 复验 `/private/tmp/claude-release-check.sQ3ej4/release-check.log` exit0：版本 guard、CHANGELOG 5/0、TypeScript、ESLint、missing imports/assets audit、diff check 全通过。此为静态检查，不等于四路完整发布通过。
- 正式隔离 build `/private/tmp/claude-isolated-build.B4Wd05/evidence/build-result.json` exit0，版本2.1.280，产物 `/private/tmp/claude-isolated-build.B4Wd05/output/built-claude` SHA-256 `294a328ee70d0a68a28d42727f28203fa8d1827aa30281f4ec5d122d3d27db73`，size101027426。根 built 与 repo Git 状态保持不变。
- 当前产物作者 CLI `/private/tmp/mods-native-author-w6Wu7R/results.json`：三个原样示例逐文件复制哈希一致，validate 3/3、plugin test 1/4/3、生成声明后 tsc 3/3 通过。G6 双 module 的 .ts/.mjs 两个负例均 exit1，明确 at most one module，四个 entry 顶层写探针均未执行。共11/11预期结果，网络禁止、仅本轮root可写；repo/binary前后身份一致，证据保留。
- 当前产物正式默认 G5 六场景同 run 全通过：`/private/tmp/g5-release-1d09defdff/evidence/driver-final-manifest.json`。assertions 分别4/9/4/7/12/16；same-session启动双marker与identity、两个正常exit；fork新identity、不继承、取消后精确保留draft、随后C-u清空和正常exit。first_divergence=null；repository_state_unchanged=true；readiness+六场景server exit0/socket释放，无本轮残留进程。
- **仍未完成：** logical/physical、独立child command、其余M287/S1–S9和完整required targets；正式retained overall仍blocked/exit2。上述独立静态、作者CLI与G5运行不拼接成四路同轮release结论。未commit/push/tag/release，保留全部/tmp证据。

#### 功能批次提交与源码复验（2026-10-03；不代表发布通过）

本次以 `b66311c` 为起点，按功能依赖拆分为 17 个本地签名提交。原有暂存的流清理改动纳入对应批次；用独立 index 和累积源码快照验证，每批只更新相关文件的暂存记录。其他 Claude 继续工作，S7 的函数、调用分支、测试和上一节账本记录保留未提交。跨功能的官方兼容性回归在依赖就绪后独立提交。

| 批次 | 提交 | 功能及相关验证 |
| --- | --- | --- |
| 1 | `cdf5d2d` | sticky 滚动范围；10 项通过 |
| 2 | `0e28bfc` | Keychain 预取失败的同步回退；8 个独立子进程场景通过 |
| 3 | `3a39625` | 宿主/Worker 流取消、异步 finally 和异常传播；122 项通过 |
| 4 | `d8b7f4d` | 隔离 native 构建输出；脚本断言通过 |
| 5 | `c338b65` | 三个官方作者示例、marketplace 和生成目录忽略规则 |
| 6 | `3052707` | 类型契约、静态 hook/call/state 发现与诊断；274 项通过、3 个未提供的官方图夹具跳过 |
| 7 | `216bae9` | 版本化 state、CAS、JSON 边界和绘制订阅；113 项通过、1 个外部 telemetry 夹具跳过 |
| 8 | `a572970` | AbovePrompt、Client 交互及焦点；260 项先通过，旧焦点断言修正后该项单独通过 |
| 9 | `6e14c8b` | ui.toast 的载荷验证与按插件限流；16 项通过 |
| 10 | `59c6bbb` | 自动作者声明及旧布局安全迁移；118 项通过、1 个外部夹具跳过 |
| 11 | `d80acea` | 隔离作者 runner、mock、宿主 hook 和 CLI 报告；111 项通过 |
| 12 | `d076088` | 无 runtime 副作用的冷入口与缓存契约发现；23 项通过 |
| 13 | `0698071` | session consent、resume/clear/fork、取消草稿恢复及 finishTurn；session 60、restart 9、作者指南 7、REPL 117 与 finalizer 1 项通过，slash-command 断言脚本通过 |
| 14 | `246ea3d` | 每次实际模型请求、fallback/retry 的 prompt.compose；运行时 5、prompt 7、query 6 与 API 子进程 54 项通过 |
| 15 | `707391b` | 官方 2.1.287 的跨功能兼容回归；37 项通过 |
| 16 | `b11ca91` | retained 证据基础设施与 G5 六场景验证器；19 项新增检查、原有 driver 回归及 launcher 语法通过 |
| 17 | 本节所在提交 | README、CHANGELOG 与验收边界同步 |

- 拆分及测试证据保留在 `/private/tmp/mods-split-nooahjr6`：原始 staged/worktree patch、119 个源码/文档文件快照、各批精确文件版本、提交清单和测试日志。14 个示例测试生成的本地配置文件未纳入提交。测试计数按批次记录，存在交叠，不相加作为总覆盖率。
- 本轮修正了三个测试问题：隔离构建测试使用真实 `/tmp`，焦点断言同时考虑 AbovePrompt 与 responsive diff dialog，取消测试有截止时间并让出事件循环，避免微任务循环阻塞动态导入。两种取消顺序的 focused 复验均通过。
- REPL 取消及真实 prompt 生成测试使用无实际用途的 `ANTHROPIC_API_KEY=mods-test-unused` 满足命令目录初始化，不作为真实 provider 验收。19 项 retained 检查中，配置原子写入和 ripgrep 缓存探针因外层沙箱拒绝 `sandbox_apply`，在隔离临时目录重跑后通过；原有 driver 的 loopback mock 回归也通过。
- **验收边界：** 本次为源码、测试及提交拆分，未推送、发布、改版本或生成新的 native binary。历史 `294a328e…` 的作者 CLI 与 G5 六场景证据仍只属于该冻结产物；文档和 CHANGELOG 改动后必须重新构建。S7、logical/physical、独立 child command 及完整 required targets 继续按各自证据判定，完整发布仍 **blocked**。
- 最终 `make -j1 release-check` exit 0：版本 guard、CHANGELOG 检查与测试、TypeScript、ESLint、missing imports/assets audit、diff check 全通过，日志为 `/private/tmp/mods-split-nooahjr6/release-check.log`。这是静态门禁，不等于 native 或完整发布验收。


## 2026-10-06 — 官方 290 完整作者声明的独立提交批次

- 对照原生官方 `2.1.290`，binary SHA256 `b8412a3826b2dc8ecb1c0605970c28dea28355de5faa740407dd881acdd40237`；完整声明 600277 bytes，SHA256 `55d3a5dd98072b125135fae6fdc037f781b3ed9ad007dcd3ea4d657404d0b11f`。固定声明体包含 560 个公开名称及完整事件、操作、testing 和全局定义；引擎版本保持 `2.1.280`。
- 从 clean HEAD `d03d3be` 准备独立提交副本，只加入声明、tool 结果生成、旧生成布局迁移、默认作者项目、必要测试和说明；原有21个声明测试保留，工作区额外的类型覆盖继续留在后续批次。副本 core SHA256 `5fee685a6fd1a2556abe3f2e3d62df853b636f8fbbe0f883d1ee0382671a7165`；5文件 `61 pass / 0 fail`，`make release-check` 和隔离构建均 exit 0。
- 精确批次新制品 SHA256 `1209eaf6118ef2caab47134acff1888e01922b315cf07e1e87408e021d8a3f43`，101935586 bytes；官方与本地在自有 tmux、相同 160×40 终端、隔离 HOME 和无 TCP/Keychain 沙箱中加载相同两个作者插件，运行相同作者命令并正常 `/exit`。命令回执、完整声明体与默认根/内部 tsconfig 字节一致；同一 authored fixture 的默认根项目 `--skipLibCheck false --incremental false` 在双方均 exit 0。此项不验证复制、diff 或全 UI 帧。
- 实际 ROOT 在 e2 core 上完整运行 `bun test src scripts`：4052 pass、25 skip、241 fail、58 errors，483文件；全量没有全绿。对101个失败/error文件逐个与 clean HEAD `d03d3be` 的同一 authored test 比较：86个当前独立通过，14个两侧非零，1个 claudeMd 旧夹具回归。官方290和本地原生都拒绝两个无 matcher 的 `prompt.context`，都接受第二个注册加 `{}`；工作区已修正并增加加载诊断断言，原六组 provider/request 断言保留，该测试修正在后续测试批次提交。
- 修正后实际 ROOT core SHA256 `44ef72f7fa21729499b48af4a971cbc31da7680abcb3f68936b75c1419f2f8e4`，生产源码与 e2 相同，仅该夹具变化；166个变更文件在同一冻结源码上逐个独立完成，全部 exit 0。23个条件用例仍 skip，未计入官方兼容性通过。claudeMd 原始18个子测试直接复跑18/0，固定夹具在 HEAD 包装器2/0；原 `/tmp/claude-502/response.md` 保留，其9项已有当前源码成功证据。
- 14个共同失败文件在隔离外层环境中再次成对复跑：9个双方通过；另5个（query、REPL.retainedTeammates.render、workflowScriptRuntime、systemPrompt.customPrompt、systemPromptType）仍是双方同样失败。bootstrap 只移除阻断其 mock Axios 调用的外加环境 flag；socket、watcher及自有 sandbox 测试在允许实际验证设施的环境中执行。没有新增当前单文件回归；这不等于全量测试或完整 Mods/UI/diff 已通过。
- 证据：`/private/tmp/mods-align-m1scugg4/changed-test-gate-e2-r1/isolated-summary.md`、`summary-with-retry.json`、`canonical-batch/native-pair.json`；原生原始 pane、PTY、debug 和驱动分别在 `/private/tmp/mc290-o-batch1/evidence`、`/private/tmp/mc290-l-batch1/evidence`。
- 当前门禁：`/private/tmp/mods-align-m1scugg4/changed-test-gate-e3-r1/isolated-summary.md`、`conditional-skips.json`、`outside-comparison/summary.json`；全量原始对比表为 `/private/tmp/mods-align-m1scugg4/changed-test-gate-e2-r1/full-isolated-comparison/report.md`。缺失生产方法、传递依赖和目录外入口项目、完整官方 UI/diff 与 release 目标继续开放。

## 2026-10-06 — claudeMd Worker 夹具独立修正

- 旧 fixture 在 clean HEAD 包装器2/0、当前 e2 下1/1；捕获实际加载诊断为第二个无 matcher 的 `prompt.context` 重复注册。没有修改 query/runtime 的生产行为。
- 使用原 fixture 逐字生成旧/新插件，仅给第二个 hook 加 `{}`；原生官方 `2.1.290` 与已验证 ROOT 本地制品均旧 exit1、新 exit0，公开 hook 输出包含 `prompt.context, prompt.context{}`。本地 source reconcile 的旧 load diagnostic、新空 diagnostic 同时保留。
- 测试增加加载后的空 diagnostic 断言，保留末尾原检查及六组 Anthropic/OpenAI 请求断言；实际 ROOT 包装器2/0、直接子测试18/0，同一更新 fixture 在私有 clean HEAD 包装器2/0。源码 core 仅该测试从 e2 变化到 `44ef72f7fa21729499b48af4a971cbc31da7680abcb3f68936b75c1419f2f8e4`。
- 全部166个变更测试文件在同一e3源码上逐个完成、exit0；23个条件用例仍skip。全量及共同失败复验边界见上一节，未宣称全量或完整 Mods parity。
- 原生旧/新验证与 source diagnostic：`/private/tmp/mods-align-m1scugg4/changed-test-gate-e2-r1/claudemd-registration-probe/`；直接子测试日志：`/private/tmp/mods-align-m1scugg4/changed-test-gate-e3-r1/outside-comparison/016-current-child/log.txt`。原始 response/fix-instructions/improvment 文本未覆盖。

## 2026-10-06 — 官方 291 目录外入口的作者项目

- 官方最新公开 CHANGELOG 为 `2.1.291`；已校验平台包 integrity，原生制品 SHA256 `9a1d2ed6bb4421e8fc80c892c0413f293be3ee50ae3d7dda1a7622197a056690`。完整声明体与 `2.1.290` 字节一致，继续使用已固定的600277字节声明，不重复新增资产或更改本地 `2.1.280` 版本。
- Source-confirmed：291 的 `DQo` 对 `hooks/` 外的 `modulePath` 追加确切文件的相对路径，默认 hooks/types/tests 三项保留。本地 runtime 将已验证的 entrypoints 交给生成器；多入口按原顺序去重，拒绝逃逸路径，链接形式的插件根使用同一目录边界判定。
- 新增回归测试初始6/6失败，修复后通过，并追加摘要篡改保护用例。独立 HEAD `fc344fb` 副本仅加入本批代码；原有5个声明文件及新入口文件均通过。生成 JSON 保持原生格式；动态配置摘要绑定到主声明校验页尾，配置冲突先行检查，作者改写保持原样，恢复后可继续更新。
- Runtime-observed：原生官方与修改前本地产物加载同一可信插件，stdin 执行 `/owned-project outside`、`/reload-plugins`、`/owned-project inside`、`/exit`。官方包含确切 `code/register.ts`；修改前本地遗漏该文件，其 tsc 虽然exit0也未检查入口，因此此断言为failed。双方都正常退出；错误不靠编译exit0掩盖。
- 当前ROOT隔离构建通过，并在 `/private/tmp/mc291-entry-r-green3` 运行相同流程；两阶段严格项目检查exit0，入口移入hooks后旧include移除，无关 `code/unrelated.ts` 未纳入，根配置字节保持，mtime保持由自动化测试覆盖；完整声明体、内部和根配置已与官方原始快照逐项比对且一致。本轮仅验证作者入口项目，不代表全UI/diff或全部生产API通过。
- 首轮当前ROOT复验完成167文件，166 exit0，`PromptInput.modsEdit` 出现一次50ms Worker超时；源码和保护文件不变。相同原测试在修改前生产副本及当前ROOT串行重跑均17/0；并发类型/lint负载是待验证解释，不把它写成已确认根因。首轮失败日志保留，最终门禁另列。
- 证据根：`/private/tmp/mods-align-m1scugg4/author-contract-project-291-r1/`；真实CLI的pane、PTY、debug、驱动和两个独立tsconfig快照保留在各自 `mc291-entry-*/evidence/`。较早驱动把两个tsconfig保存为同名文件，已修正并用新独立session重跑，旧证据保留。
- 边界：传递依赖类型根、缺失生产方法、远程clipboard、官方完整UI/diff、G5及全量套件仍待处理；历史response/fix-instructions/improvment不覆盖，其他Claude进程不干预。
- 独立提交批次core SHA256 `d9dc50a78ada722752f15be4dd1b673b17227792d7b2b918809163bd447c37c6`，6个相关声明测试文件合计68 pass、0 fail；`make release-check` 与隔离构建均exit0。批次制品SHA256 `31d1941d0573743030d17042c298398196d988f02a3bbe50bd5c0c2c182afd24`；当前ROOT制品SHA256 `e2cc0c4d351c90fd2b6cf36877a5f792f61d8e3e6d775ef2601c320b8e3fcfde`，源码core `3599279d3873dc8de1ff865bafe1e47627a5569fdc51497a479b40342c4163da`。两制品各自在相同官方驱动下完成两阶段，配置及声明体比较均通过。
- 最终第二轮在同一ROOT源码上逐文件串行完成167/167、全部exit0；23个条件用例仍skip，未计作官方兼容性通过。本轮不同时运行其他自有build/tsc/lint；首轮失败、修改前/当前的17/0串行对照和未确认的超时归因均保留。原response的9项在第二轮均通过，原文SHA256保持 `2ef2250d26c206e40c52bc35a900c0115d9820360b26d0d90fb491d73ff2f001`。
- 最终门禁：`/private/tmp/mods-align-m1scugg4/changed-test-gate-e4-r2/summary.json`、`conditional-skips.json`；原生比较：`author-contract-project-291-r1/ROOT-native-project-comparison.json`、`entrypoints-commit/native-comparison.json`；debug关键字段检查为 `ROOT-author-project-debug-validation.json`。最近完整全量运行尚未通过，本轮未重跑全量；此批次不代表完整Mods/UI/diff设计已验收。

## 2026-10-06：官方 291 依赖类型根、生成目录刷新和旧报告复验

- 范围：直接与间接依赖的作者类型投影、生成目录恢复和退役；源码核对官方 `2.1.291`，原始主声明仍与 `2.1.290` 的完整声明体一致。当前引擎版本保持 `2.1.280`。
- `response.md` 原件仍是 00:31 的历史报告（SHA-256 `2ef2250d26c206e40c52bc35a900c0115d9820360b26d0d90fb491d73ff2f001`），没有改写。其9个失败文件全部在本轮相同源码、真实工作区路径和无凭据环境中独立通过，逐文件记录：`/private/tmp/mods-align-m1scugg4/author-dependencies-project-291-r1/response-report-recheck.json`。
- `improvment.md` CLI-6 的生成文件不恢复问题已按官方实测修复：截断主声明和改写的内部配置重新生成；首次写入及替换使用临时文件加原子 rename，真实路径串行化解决同一根目录的两种路径写法。原报告正文保持不变。
- Source-confirmed：官方依赖闭包按加载顺序进行广度遍历并按名称去重，经过无 hooks、无自身契约的中间插件，循环不无限递归。qualified 依赖接受同名 `inline` 覆盖（并非 `builtin`）；三类虚拟来源的裸名称不继承 marketplace。契约物理路径必须在插件真实目录内，保留类型名称和生成目录保留项的边界。
- Runtime-observed RED：官方 `/private/tmp/mc291-deps-o-red1/evidence` 加入 bridge/leaf 类型根并严格检查成功；本地新建基线 `/private/tmp/mc291-deps-b-red1/evidence` 缺少类型根，strict tsc exit 2，生成文件改写后也未恢复。两侧实际作者命令执行、正常 `/exit` 都完成，失败针对作者项目断言。
- Runtime-observed GREEN：官方 `/private/tmp/mc291-deps-o-qualified1/evidence` 与 ROOT `/private/tmp/mc291-deps-r-green1/evidence` 的 fixture、输入、160×40终端、两次命令回执和两阶段生成/根配置字节一致，strict tsc 均 exit 0，正常退出均 exit 0。先以真实目录冲突触发链接 rename 失败，观察普通声明复制和 BOM 去除；再移除依赖，索引删除、空目录删除、作者同目录文件保留、改写的生成主声明及配置恢复、自定义根配置字节/mtime 保留。`/private/tmp/mods-align-m1scugg4/author-dependencies-project-291-r1/ROOT-native-comparison.json` 记录精确比较。
- 实际 ROOT：core SHA-256 `b7e6060ab277338265115e980128b53ed189382b01f46c4e7f93d89ea7532118`，2882文件；`make release-check`、`make build` exit 0，新制品 SHA-256 `d7d32c7257a669aecea7dccef218c8e0bd74cb1ca4a917ffdb0aeb3c8976b35d`。构建写入独立输出目录，根目录原 binary 保持原样。
- 本轮完整变更文件门禁：**168/168 文件 exit 0**，源码和受保护原件哈希保持一致。其中作者声明与插件准备的16个文件 **160 pass / 0 fail**，新增依赖用例15/0；条件 skip 共 **23**，不计作对应分支的 parity。完整清单和输出位于 `/private/tmp/mods-align-m1scugg4/changed-test-gate-e5-r1/{inventory,results,summary,conditional-skips}.json`。没有删除或跳过业务测试，也未提高 Worker 或测试预算；既有生成文件保护断言按官方实际刷新语义更新，作者根配置、外部链接目标和旧非生成辅助文件保护断言仍保留。
- 独立提交副本：clean HEAD `595ba69` 加本批精确差异，core `22f073f36d6153e4da30480a4ffbc1bce29bf40ba7e773da3f8ade1de2b3bbed`；119/0，检查与构建 exit 0，制品 `ff1c3d698bf70bc547af495260e524a80747f89c0bc74a39823bcf525c9074c4`。同一真实 tmux 流程 `/private/tmp/mc291-deps-c-commitgreen1/evidence` 通过，比较 `/private/tmp/mods-align-m1scugg4/author-dependencies-project-291-r1/dependencies-commit/native-comparison.json`；不依赖其他未提交的 runtime/UI 差异。
- 关键 debug：`/private/tmp/mods-align-m1scugg4/author-dependencies-project-291-r1/ROOT-debug-projection.json` 的 owner 初次加载包含基础3根和 bridge/leaf，reload 仅基础3根，并正确记录退役索引、主声明和配置；不序列化契约正文。
- 未关闭：native held-directory/tree-anchor 文件系统实现、完整生产 API/UI/diff 和跨平台验收。本轮没有重新宣称全量 suite 通过，前述全量失败及基线对照仍保留；不能把独立文件门禁当作全量 suite 通过。已静态定位291 diff 原始模块 `chunk-fbpekckc.js`（SHA-256 `05350cb490432c50c1e4227a6097112c4063d710385c937e29a73cf79adddba8`），尚未证明其与仓库289归档完整行为一致。README/CHANGELOG 已更新作者项目规则；本批验证不代表总体目标完成。

## 2026-10-06：官方 diff 高亮依赖的实际回归

- Source-confirmed：已安装的 highlight.js 11.11.1 的 `HighlightResult` 和实际返回值使用 `_emitter`。旧代码读取 `emitter`，首次颜色绘制在 `Object.keys(undefined)` 抛错，此后可静默产生普通代码颜色；修复后对未知 token tree 形状安全记录结果字段并保留文本。没有修改官方 diff 注册闭包。
- RED：`shipped-diff-291-r1/syntax-red1/log.txt` 保存真实 TypeScript diff 抛错；首轮 GREEN 的空白行补齐预期错误和 lint 的控制字符正则错误也保留，分别修正测试预期和表达方式，没有关闭 lint 规则。三项最终回归覆盖准确文本、行号、语法/词级颜色、暗色和浅色代码以及未知语言。完整当前 ROOT Pane 测试180/0。
- Runtime-observed：官方 `/private/tmp/mc291-diff-o-flow1/evidence`、候选 `/private/tmp/mc291-diff-c-flow1/evidence` 和本轮实际 ROOT `/private/tmp/mc291-diff-r-syntaxflow1/evidence` 均运行独立160×40 tmux，以同一 Git 样例执行 `/diff`、160→140→160 resize、鼠标 ask/取消、关闭重开及正常 `/exit 0`；literal 输入、mouse bytes、resize、fixture 和观察步骤相同。断网及钥匙串隔离，仅清理自有进程。
- 精确比较 `shipped-diff-291-r1/ROOT-syntax-native-comparison.json`：四个稳定画面各7行代码的前景色逐字符一致，其中6行变更代码的 ANSI 完全相同；未改行/空白行和分隔线背景仍有差异，本地退出时还有 `Module capability failed` 诊断。没有把整个画面标为相同。
- ROOT 隔离新制品 SHA-256 `27707e4378e33ec3baf522349cf675c8b3d1f2e28557402ade8e4ac27dc6e26c`，原根目录 binary 未替换。本批先只迁入高亮源码和测试；ROOT 仍使用289 diff归档。291 原始包已在私有候选校验并通过启动与接管测试，包升级尚未迁入或提交。
- 独立提交副本为 clean HEAD `3c70417` 仅加高亮源码、测试及本节文档，TypeScript/lint/仓库检查通过；不依赖其他未提交的 runtime/UI 工作。证据根 `/private/tmp/mods-align-m1scugg4/shipped-diff-291-r1/`。历史 response/fix-instructions/improvment 和旧官方资产保留。完整生产 API、UI、diff 与全量 suite 仍未关闭。
- 最终冻结 ROOT 门禁 `changed-test-gate-e6-r2`：169 个文件串行完成，168 通过、1 失败、23 个条件跳过；核心源码 SHA-256 `2bbbbe2848cab398adf5f059fb12398f9a339cf2f0abe50213f129267ed25e76`。唯一失败为 `PromptInput.modsEdit.test.tsx` 的六调色板 Worker 回归，16/1，诊断 `Mod paint-probe timed out for prompt.edit`（50ms）。旧 e4 门禁也记录过相同失败。保留其日志和原预算，尚未证明超时根因，不能称整轮全绿。
- 同一失败文件的受控 A/B 复验：修改前 e5 冻结核心 `b7e6060ab277338265115e980128b53ed189382b01f46c4e7f93d89ea7532118` 与当前 e6 核心分别独立运行，均17/0；复验不计入原门禁结果。历史 `response.md` 的九项中，本轮8个文件通过，剩余该文件有间歇超时；报告原文未改。
- 独立提交副本（仅 clean HEAD 加本功能）再次构建后运行真实 `/diff` 并正常 `/exit 0`，证据 `/private/tmp/mc291-diff-i-syntax1/evidence/result.json`，制品 SHA-256 `c3bc2bf6d13f3205a376e416cfc722510d8a26b693d749ef2f6f24c225e481ab`。这证明本功能可以独立提交；该副本使用已有 diff 入口，不作为完整 Mods 接管或291兼容证明。

## 2026-10-06：diff 正文背景、边框和缓存的回归

- 官方291源码：`chunk-047zrb4c.js` 的 `Is` 在 Raw ANSI 分支调用 `MC`，背景参与 blit 条件及节点缓存，边框接收继承背景；`chunk-4hd2jsyd.js` 的 `V3o` 在完整重置、默认背景重置和换行后恢复容器背景（该 chunk SHA-256 `3556a024c1878010e5d4317f617ceeeeadd3e4a0068c09f2dab35efd91d38631`）。这解释了上轮样例的上下文/空白/分隔线颜色差异。
- 本地沿用 Output 的 tokenizer、结构化颜色及屏幕单元格路径合成默认背景，不手写新的 ANSI 样式；显式背景和前景保持，字符缓存键及节点 blit 条件包含背景。实现方式与官方字符串重写不同，本节只报告实际验证的行为。
- 失败回归 `background-owned/background-red1/log.txt`：1通过/4失败。第一次修复后4/1，移除背景时仍复用旧节点缓存；补齐背景缓存条件后5/0。没有跳过或放宽断言。当前 ROOT 与 clean HEAD `6bea3a1` 加本批补丁的独立副本均5/0；独立副本 `make release-check`、构建均 exit0。
- Runtime-observed：候选 `/private/tmp/mc291-diff-b-bgflow1/evidence`、实际 ROOT `/private/tmp/mc291-diff-r-bgflow1/evidence` 对照官方 `/private/tmp/mc291-diff-o-flow1/evidence`，literal 输入、鼠标 bytes、resize、fixture相同，均正常退出。四个稳定画面各7行代码的文字及所有颜色/样式单元格一致；共同35行右侧内容一致，官方另有第36行。完整面板并未标为一致。比较脚本及结果在 `shipped-diff-291-r1/background-owned/ROOT-native-comparison.json`。
- 背景真实终端验收时 ROOT 核心 SHA-256 `047aa893c424fbe72946ff42c8a637d7ed2c828293ef6fecc97eaafc3f5d2605`，隔离新制品 `141d8abf2823ba058db880a05d084cf28e10b247f6cdf8f4a7f4ad94ea0524b6`。独立提交制品另在 `/private/tmp/mc291-diff-i-bg1/evidence` 打开实际 `/diff` 并正常退出；该独立副本使用已有入口，不充当完整 Mods 接管证明。原 binary、历史报告和289归档未改。
- 未关闭：面板底部少一行、正常退出的 `Module capability failed`、完整 ANSI/主题/交互矩阵与生产 API/UI 兼容。291包仍只在私有候选，ROOT仍289。上轮169文件门禁168通过/1间歇 Worker 超时/23跳过的结果保持；本批相关验证不构成新的全部变更门禁或全量 suite 通过。
- 追加相关回归：log-update、selectionFollow289 通过；DiffView 最初失败完整保留并由独立测试辅助方法提交修复，修复后通过；最终 ROOT ModsPane 180/0。当前含辅助方法的核心为 `db1c902db97aed828bc7f152ec54e5fde6154e7a6ff1505236ec7307a8c2556d`；相关文件验证仍与旧全变更门禁分开记录。

## 2026-10-06：高亮恢复后 DiffView 测试的文本读取

- 扩展验收发现未改的 DiffView 测试不在旧169文件清单中：ROOT 的 `background-owned/root-related-3` 内层24/12、3 errors；高亮修复独立基线 `syntax-commit/pre-background-diffview1` 同样24/12、3 errors。失败文本如 `body-0` 被正常语法颜色码隔开，Raw ANSI 的 DOM 文本辅助方法未去除样式，等待随后超时。不是背景修复特有回归。
- 仅在 `DiffView.test.tsx` 的 Raw ANSI 文本分支调用已有 strip-ansi，原断言与所有预算保留，物理屏幕预览和样式检查没有替换或关闭。工作区 `background-owned/root-diffview-normalized1` 与只含本测试修改的独立副本 `background-owned/normalization-commit/normalized-diffview1` 均 exit0，仍运行原内层36项及外层进程检查。失败日志完整保留。
- 本节属于验证脚本修复，单独提交，不改变任何生产渲染代码，也不将旧169文件门禁改写为全绿。完整 suite 和 Mods API/UI 目标继续保留。

## 2026-10-06：Debug 状态栏及通知分层

- Source-confirmed：官方2.1.291 `chunk-scapxbwa.js` 的 `LK` 在状态行渲染 warning 色 `Debug`，`Pae` 将通知置于状态行上方。切片、chunk SHA 与验证契约保存于 `/private/tmp/mods-align-m1scugg4/shipped-diff-291-r1/debug-footer-owned`。本地 Notifications 移除 debug 属性；PromptInput 保留向 Footer 传递 debug；状态行保留 Goal、undercover 和 Bridge。
- 最小失败证据：`root-red1` 复现普通/全屏旧的 `Debug mode`；普通模式真实官方对照补充后，`root-inline-red1` 复现通知与标记并排的两项失败。类型检查中测试夹具的只读状态、Goal 完整字段和渲染器私有属性问题已修正；不扩宽生产类型，不读取私有凭证。
- 最终 ROOT 核心 SHA `5c11a3d46e447cc91c97207cafad9599eb1982f09d634cd85e9c79bed37fcacc`。`root-final-green2` 4/0，`root-notifications1` 3/0，`root-prompt-edit1` 17/0，`root-prompt-keys1` 4/0；各文件串行、独立配置执行。原50ms Worker 预算和断言未改变；这次17/0不抹去上轮间歇失败。`root-final-check2` release-check 与 `root-final-build1` 构建退出0，源码不变。
- Runtime-observed：官方及实际 ROOT 的普通/全屏、debug 开/关八场均正常退出；证据 `/private/tmp/mc291-diff-{o,r}-footerflow2/evidence`、`footerinlineon2`、`footerinlineoff2`、`footerfullscreenoff2`。`footer-matrix-final.json` 比较标准宽度的 Debug，文字、5个字符颜色、右侧位置一致。启动日志横幅未当作底栏标记。
- ROOT 新制品 SHA `c03612339928e430332c8a82716bd3367cd6db2c4990c3ec5d9c7009ceae98e8`；官方仍为233211568字节、SHA `9a1d2ed6bb4421e8fc80c892c0413f293be3ee50ae3d7dda1a7622197a056690`。`footerflow2` 两侧使用相同 literal 输入、鼠标 bytes、160→140→160 resize 和 Git fixture；开/关、ask/取消、重开保持通过，4帧各7行代码单元格相同。
- 仍 failed：Debug 移动后，第35行是空白，而官方仍有面板边框；`ROOT-final-native-comparison.json` 记录本地35行/官方36行。最初将少一行归因于 Debug 覆盖并不完整，未硬编码增加行数。退出时 ROOT 仍报告 `Module capability failed`。整体画面、窄终端/主题矩阵、最新291包生产迁移及完整 API/UI 兼容未关闭。
- `/tmp/claude-502/response.md` 重新读取后 SHA仍为 `2ef2250d26c206e40c52bc35a900c0115d9820360b26d0d90fb491d73ff2f001`；报告的146/155及9失败保留为历史结果，不能代替当前源码验收。上轮169文件门禁168通过/1间歇失败/23跳过仍保留；本轮聚焦验证不是新的全部变更或全量 suite 通过。独立提交副本只包含本批 UI/测试/文档，验证结果保存于同目录 `commit`。
- 最终独立提交副本 `independent-final-test2` 4/0、`independent-final-check2` release-check 和 `independent-final-build1` 构建退出0，核心SHA `1ec51a7713408f49f1d0afa6b2dcb95b7f0bb661bb25f18f27c21879374eb0bd`；普通/全屏两场 `footerindependent{inline,fullscreen}on1` 验证标准状态栏位置及正常退出。这仅验证独立提交的状态栏，不替代实际 ROOT 的官方 Mods diff 流程。新测试移除对尚未提交类型名的引用后，ROOT最终核心SHA `1ae3108d56b8d853cea81b4e8d04d211db8a5f6de846f621dd2031011b1ca402`（2885文件）；生产代码不变。

## 2026-10-06：跨 Worker 的原生错误消息

- Source-confirmed：私有诊断候选记录 diff 退出时的 timer wait，原对象为 DOMException `AbortError`，原生 message 为 `The operation was aborted.`；原错误转换只读取自身的数据属性，导致日志成为 `Module capability failed`。私有 instrumentation 仅在临时副本，未进入 ROOT 或提交。证据 `/private/tmp/mods-align-m1scugg4/shipped-diff-291-r1/capability-diagnostic-owned`，`/private/tmp/mc291-diff-b-capabilitydiag1/evidence/debug.log`。
- 修复仅在已有消息转换中调用捕获的原生 message getter，保留 ordinary Error 与 errorRef 身份传播，不读任意自定义 getter/原型、不执行 Proxy trap，不吞掉取消或其他异常。未改变公开函数、类型和 wire DTO。
- RED `native-message-red2`：1通过/2失败，原生消息为通用字符串；首轮夹具对代理使用 instanceof 的问题在 `red1` 单独保留。GREEN `native-message-green1` 3/0；ROOT environment 63/0，runtime 92/0及1原有条件跳过。核心 SHA `c08627afce6577a5eeff88c79c86a106e7aef7ace5cf916141a64eed47818b2d`，各案串行且源码不变。ROOT `native-message-root-check1` release-check 和 `native-message-root-build1` 新构建均exit0。
- 独立提交副本由 clean HEAD `fb59cdd` 加本批 helper/test 构成，核心 SHA `c617cadec16d6bfd12f4c0bc31789472714b04870b761bbceaba86e2307e24b6`；三项测试、release-check和构建退出0。隔离真实插件在 session.start 调用 clock.every，通过原生 binary stdin `/exit` 触发取消；证据 `/private/tmp/mc291-native-error-i-nativeerr2/evidence`，timer debug marker、原生消息与退出0均存在，通用消息不存在。首场脚本错误地等待屏幕上的 ui.log 标记，在 `nativeerr1` 保留failed；修正为验证生产debug目标后才使用新场次。
- Runtime-observed：实际 ROOT 新制品 SHA `49e410e3bd3395f254749a5a91d171627cf22c048c46553027c4884da22e8d39`，`/private/tmp/mc291-diff-r-nativeerrroot1/evidence` 完成160→140→160、ask/取消、关闭重开，正常 `/exit 0`。日志明确为 `[Mods] cc-plugin-diff (async): The operation was aborted.`，不再使用通用消息。独立制品 SHA `be41fde0d7e02cfe0c1770fcf5f55a940ad2ae7c891cd42c9e7ec3374d621433`。无凭证复制，临时配置及 tmux 分别隔离，仅清理本场所拥有的进程。
- 本批结论限于错误信息。取消仍产生异步诊断，官方诊断时机/完整生命周期仍未关闭；真实 diff 的高度差、291生产迁移、完整 UI/API 矩阵及全变更门禁继续保留。旧response的146/155与9失败不变；最新169文件门禁168通过/1间歇失败/23跳过未改写。原制品、报告与289归档保留。

## 2026-10-06：官方 291 dock 尾部、通知宽度与绝对定位缓存

- Source-confirmed：固定官方 `2.1.291` 原生制品 SHA256 `9a1d2ed6bb4421e8fc80c892c0413f293be3ee50ae3d7dda1a7622197a056690`。`chunk-03vmca9k.js` 的 `Git/or/_c` 将共享 composer 放在 main row 之后；只有 anchor 到 bottom 的 top 等于 anchor 的实际 top margin 时，才按量测值绘制 dock tail。`chunk-scapxbwa.js` 的 PromptInput anchor 和 NK 通知使用 dock 列宽上下文；六主题背景逐项核对。源码片段哈希、字符及实际UTF-8字节偏移保留在 `/private/tmp/mods-align-m1scugg4/shipped-diff-291-r1/dock-tail-owned/official-source.json`，未执行解包的 JavaScript。
- 实现：新增明确类型的 `getComputedMargin(LayoutEdge)`，复用完成布局后的订阅；输入框注册真实 anchor，tail 使用结构化 Box 的背景和左边框。通知限制在 dock 左侧。正文 bodyRows 保持34，35行主 dock 加1行 margin tail 形成36行；没有将正文预算硬加1。绝对定位区域更新前将原缓存范围加入 pending clear，防止 clean sibling 的旧屏幕 blit 恢复已缩短的尾部。
- 最小回归：有效RED2为1 pass/1 fail，缺少 margin 的边框；后续有效失败还定位到通知被覆盖及 margin2→1留下旧边框。ROOT最终3 pass/0 fail/54 expect；独立 HEAD `fa859be` 加本批及最小依赖同样3/0/54。未删除断言、跳过用例或提高预算；早期夹具和中间方案失败记录完整保留。证据根 `/private/tmp/mods-align-m1scugg4/shipped-diff-291-r1/dock-tail-owned/`。
- ROOT相邻回归：Pane180/0/1096 expect、logUpdate3/0、Debug/footer4/0、Notifications3/0、selectionFollow7/0/42 expect、prompt.edit17/0/153 expect；均为同一core `a7bed54dda3d15a7375b83cffd05e9633009f88627583c1951f28a984425712b`。ROOT和独立副本的 `make release-check`、独立输出 `make build` 均exit0，源码未漂移；ROOT新制品 SHA256 `d5d64f402a6a6bda14894ab2fe4ae32aa99e6044475792fd6adb033c3bfd9f45`，独立制品 `d0a22ab568def79a8ed5fbfe3a939113456278c0bafcea90e88fcab5c5a0e6f1`。独立core `b877c177f66bda1dba2fcb92b0d4be17847c06a3c22c331ce1d896adbce2770c` 包含所需订阅、共享 composer 及 typed 六主题背景，不带其他ROOT WIP。
- Runtime-observed：ROOT `/private/tmp/mc291-diff-r-docktailroot1/evidence` 使用真实 `/diff` stdin、160×40终端，同场完成160→140→160、ask/取消、关闭重开、正常 `/exit 0`。与已固定的官方同场证据 `/private/tmp/mc291-diff-o-footerflow2/evidence` 比较，输入、resize和Git文件改动一致；四个稳定stage的右侧36行全部字符和样式一致，各包含7行代码。精确比较 `dock-tail-owned/native-comparison.json`，未拼接重试的成功片段，也不将右侧样例比较称为全屏/全API parity。
- 独立提交native：`/private/tmp/mc291-dock-tail-i-docktail3/evidence` 通过真实注册的 `/owned-dock` 命令打开 pane，完成两次resize、草稿输入/Ctrl+U清空、全终端宽度composer边框及5个margin尾部检查，正常exit0。先前 `docktail1` 用自动打开的pane在140列不满足144列可见条件；`docktail2` 驱动误将历史命令行当作当前composer。两次失败及exit0保留；第三次改用真实用户命令和最后一个prompt定位，仍要求边框精确等于终端列数。
- 边界：官方 AbovePrompt 位于 dock 旁的左列，ROOT对应布局仍待处理；尾部/主grip的焦点和hover样式、窄屏inline、建议层偏移和完整交互矩阵尚未关闭。退出仍出现 `[Mods] cc-plugin-diff (async): The operation was aborted.`，原生消息已正确保留，诊断时机/取消流程不因本批画面一致而计为对齐。官方291 builtin资产仍为私有候选，ROOT保留289原资产，不能以本批代替迁移和生产API验收。
- 门禁边界：历史 `response.md` 仍为146/155及9失败的原报告，原文SHA256保持 `2ef2250d26c206e40c52bc35a900c0115d9820360b26d0d90fb491d73ff2f001`。最新完整变更门禁G6为168/169文件通过、23条件skip、prompt.edit一次50ms超时；本轮17/0相邻结果不抹掉该失败。当前本批完成后需要新完整门禁，全量套件也未确认通过。原 binary、fix-instructions、improvment、response和其他Claude进程均保留。

## 2026-10-06：当前 ROOT 完整变更门禁 E7 与旧 response 复核

- 门禁在签名提交 `048faeb6231d432b5db4baa07196061eb191fdea` 后，以实际ROOT路径、每文件独立无凭据 HOME/config/XDG、原120秒期限逐文件串行执行；未同时运行其他自有 build/tsc/lint。覆盖169个历史文件及新增的dock tail、Debug/footer、DiffView、Raw背景和原生错误回归，共 **174/174文件 passed，0 failed，0 needs-evidence**；Bun各文件外层footer合计2616 pass、0 fail，另有23条件skip（8文件）和独立脚本回执。逐文件进程组回收通过，源码core `a7bed54dda3d15a7375b83cffd05e9633009f88627583c1951f28a984425712b`（2887文件）全过程保持一致。
- 历史 `response.md` 的9个失败文件本轮全部通过：prompt.edit、openai兼容、同批Worker按键、teammateResume、toolAdapter、自动压缩、模型契约、隔离构建和SendMessage。原报告仍为146/155、9失败，未覆盖原文；本轮逐项回执和源码/测试哈希为 `/private/tmp/mods-align-m1scugg4/changed-test-gate-e7-r1/response-report-recheck.json`。G6的一次50ms prompt.edit失败仍保留，不将这次成功写作超时根因已修复。
- 完整证据根 `/private/tmp/mods-align-m1scugg4/changed-test-gate-e7-r1/`：`inventory.json`、逐文件start/result/log、`results.json`、`summary.json`、`counts.json`、`conditional-skips.json`。23个条件skip不计为对应官方分支已通过，其中13个原样diff接管用例仍缺外部夹具；私有291候选的测试通过不替代当前门禁中的skip。
- dock tail 的独立签名提交含9个代码/测试文件和3份文档，提交blob与独立候选一致，301个不相关文件字节未变；其余310项WIP保留。原ROOT binary、fix-instructions、improvment、response与289资产的字节/mtime保持；暂存区已清空，无push，其他Claude进程未干预。
- 边界：本轮没有重跑同进程全量套件，也没有重跑G5。G5是 `/plugin-authoring` 会话授权及生命周期的六场景，上一场2026-10-04的52断言通过、logical/physical帧和完整矩阵仍未覆盖。完整生产API、最新版声明映射、AbovePrompt/grip/inline/建议层、291包迁移、取消流程及全部官方UI/diff效果继续处理；174个文件通过不代表总体兼容目标完成。

## 2026-10-06：内置 Mods 缓存的进程间发布锁

- Source-confirmed：两个发布者可同时搬走损坏目标并替换它，原实现没有进程间锁。本批只为内容寻址缓存的发布/恢复段接入既有 lockfile helper，取得锁后再次检查完整树；保持校验、回滚和finally清理。opaque插件身份、官方291加载及UI改动不包含在该代码提交中。
- RED：干净HEAD `85b7b9d` 加持锁回归，`cache-red2` 为26 pass/1 fail：另一发布者持锁时 operation 已提前完成。原十二进程测试的 `cache-red1` 为26/0，不将未复现写成RED。GREEN：独立副本 `cache-green1` 与实际ROOT `cache-workspace-test1` 均为27/0、56 expect；默认测试期限未增加，未删改断言或加入production测试分支。
- 两侧 `make release-check` 与本轮独立输出 `make build` 均exit0、源码不变；独立core `8cf70cdbfe4ca05ebe490de01384a4cd7934216e498e156e6623e4e1c9b7aa2a`，ROOT core `9972162689dc18324ce73ddef5a30ace7c66b1f40ec817e93bb23e7046eaac1e`。独立binary SHA256 `8845729a67156048c75087136cb9510628a8910fa1e8cfcb411aa836e0c0ee8f`，ROOT binary `ba396853aa11c91b2b977d2c829051450ffefae9c5cb7a8db37c254e9d3ace04`，版本仍为Makefile指定的2.1.280。
- Runtime-observed：证据根 `/private/tmp/mods-cache-commit-20261006-mc34adhm`；独立场 `native-candidate-c3/evidence`，ROOT场 `native-workspace-r1/evidence`。通过真实CLI启动入口，外部持有同一归档digest的发布锁；两个CLI均已完成临时树且原损坏目标不变，释放锁后均出现交互prompt。两者各输入草稿/Ctrl+U清空及stdin `/exit`，第三次启动确认归档逐文件字节、completion marker与整个缓存文件mtime/摘要保持不变，全部正常exit0。缓存中无tmp/stale/lock，所有自有进程组已退出。并发场专门共享私有HOME/cache，各CLI配置和证据独立；dummy key、禁止网络及用户凭据访问的sandbox，不复制个人认证。
- 失败记录保留：`native-candidate-c1` 被外层沙箱禁止sandbox_apply，未启动CLI；`c2` 的缓存锁和两侧readiness通过，但驱动未将prompt的NBSP规范为空格，草稿断言失败。`c3`只修正字符读取和增加进程残留核对，未放宽缓存或交互断言及期限。独立场不是官方binary对照，不推导官方缓存内部实现相同。
- 边界：只关闭本批缓存修复。E7的174/174是添加本次回归前的历史源码门禁，本轮未重跑完整变更或同进程全量suite，也未重跑G5；完整生产API、最新声明映射、291包迁移、AbovePrompt/grip/inline/建议层和取消流程继续保留。原ROOT制品、fix-instructions、improvment、response、289资产和其他Claude进程未修改。

## 2026-10-06：作者测试的原生 Error 和完整诊断

- Source-confirmed：instanceof 无法识别跨VM原生 Error，而宿主 Error 的 stack 也可能没有具体 message。只为已有 failure formatter 接入 isNativeError：保留原stack，必要时补充name/message。登记、catch、stream、期限和临时目录清理未随本批改动；相对路径修复另行提交。
- 独立HEAD `86858ce` 加原有诊断回归：`diagnostic-red1` 0/1，具体消息虽在但原frame丢失；GREEN `diagnostic-green1` 1/0、4 expect，ROOT `diagnostic-workspace-test1` 同样1/0。独立 `diagnostic-adjacent1` 为53/0、184 expect；此前路径候选的 `child-root-adjacent1` 为缺少证据父目录的53次ENOENT，补齐环境后的 `adjacent2` 为52/1并定位到缺少错误message。原失败保留，不删断言或提高期限。
- 独立核心SHA `e069dc72782315aadd7d57d345e4015a1336c17ff3c59b4d9ddd3fddbaf25186`；ROOT核心 `1c8d51992dd5b6a0cee0789548edb7a360ccaaf65d54d2a48951f8d1a17c8e30`。两侧release-check和本轮独立输出make build均exit0且源码保持。独立binary SHA256 `2bf8cac1a95b973c534f796e5080ed7f9c6beec3c7e22bd76221d200acd234e7`，ROOT `70a2088fd09b2982cfbf1fa38a792b18c05e87406174a784398a02dc880057ee`；版本仍为2.1.280。
- Runtime-observed：证据 `/private/tmp/mods-relative-root-20261006-cuurdfyq/native-diagnostics-d1/evidence` 与 `native-workspace-r1/evidence`。通过真正compiled CLI `plugin test` 执行作者VM，成功用例exit0；带有意保留frame的TypeError失败用例exit1，同时显示 `TypeError: intentional author failure` 和 `at retained-native-author-frame:1:2`。同场相邻interactive启动、草稿输入/Ctrl+U与stdin `/exit 0`通过；无自有进程残留。纯内部formatter没有执行上游解包JS；使用假key、私有配置和禁止网络/凭据访问的sandbox。
- 边界：本批只关闭诊断问题。独立候选保留旧runner的测试HOME残留，实际scratch清单保留在result.json；目录回收、kit注册/catch/stream语义和路径迁移按独立批次处理。原ROOT制品、289资产、response、improvment和fix-instructions保留；E7/全量suite/G5与完整官方API/UI验收不因该回归通过而更新。

## 2026-10-06：plugin test 的真实插件根目录传递

- Source-confirmed：父runner已解析realpath且把child cwd设置为该root，CLI callback却仍用原始directory，导致相对路径从新cwd再次解析。本批仅将canonical root传给childCommand并用于CLI argv；相邻诊断修复依赖已独立签名提交 `118b28547258724f128fc12a37a6dc74307fa478`，其余kit注册/catch/stream和清理WIP未纳入。
- RED `child-root-red1` 为0 pass/3 fail：回调root为undefined；独立最终GREEN `child-root-green2` 与实际ROOT `child-root-workspace-test1` 均3/0、18 expect，覆盖absolute、relative和含空格symlink，并启动真实Bun作者子进程。独立core `24f67ef9521b3bb28d5944745efd5255ac3a535fafde58529d9a89f2e773c564`；ROOT core `1c8d51992dd5b6a0cee0789548edb7a360ccaaf65d54d2a48951f8d1a17c8e30`。期限未增，未删改断言。
- 两侧release-check和本轮独立输出make build均exit0，源码绑定不变。独立binary SHA256 `4eac9f8d495807be05fb881b0d8e81aff72f2a5fa814a0c19067fb9c4e48d723`，ROOT `70a2088fd09b2982cfbf1fa38a792b18c05e87406174a784398a02dc880057ee`，版本仍为2.1.280。证据根 `/private/tmp/mods-relative-root-20261006-cuurdfyq`，独立native场 `native-candidate-c1/evidence`，ROOT场 `native-workspace-r1/evidence`。
- Runtime-observed：真实compiled CLI `plugin test` 的绝对路径、`./mod with space` 和 `./linked mod` 均输出实际作者测试1 pass/0 fail并exit0；通过相对路径执行故意失败的作者VM输出0 pass/1 fail、具体TypeError和原frame并exit1。随后同场相邻interactive启动、草稿输入/Ctrl+U和stdin `/exit 0`通过；私有HOME/config、dummy key及禁止网络/个人凭据访问的sandbox，所有自有进程组已退出。
- 边界：独立候选仍保留旧runner的临时HOME行为，native result保存scratch清单；目录回收另行提交。相邻集成测试的环境准备失败和52/1诊断失败保留，诊断候选53/0结果见上一节。新路径回归不构成重新执行E7或同进程全量suite，也未覆盖G5、最新291包迁移及完整官方API/UI/diff。原制品、报告、289资产及其他Claude进程保持。


## 2026-10-06：官方 291 diff 归档的独立打包批次

- 变更契约：离线 producer、runtime asset copy 和 standalone file import；runtime 激活与完整官方 API/UI/diff 不纳入该独立提交。ROOT 的版本依赖 WIP 同步到291以验证构建消费者，未将其混入打包提交。证据根 `/private/tmp/mods-diff-package-291-20261006-im4g_8so`，基线 HEAD `109e83ee6e12edfa14e1dc0e0f69fb56a7be6832`。
- Source-confirmed / Binary-observed：静态读取已核验官方291的2493个Bun模块，归档两个完整模块与官方二进制逐字节相同；没有单独执行提取JS。官方binary SHA256 `9a1d2ed6bb4421e8fc80c892c0413f293be3ee50ae3d7dda1a7622197a056690`，diff完整module `05350cb490432c50c1e4227a6097112c4063d710385c937e29a73cf79adddba8`，identity `2400a87c0ea3f28b88133436e8816c76a183460eced1ff8accd5d2bd5ad555c6`，archive `a055c383e182c50f5cd804a25e6587871cad065804d35082292fe9acb2d6d424`（46075字节）。
- HEAD RED `red-package1`：1/2，runtime copy和binary embed缺失。首次GREEN `green-package1`：producer3/0但相邻build脚本旧289正则断言报错；保留原记录，按新版本修正精确断言。最终独立 `green-package2` 与ROOT `workspace-package1`：producer3/0、21 expect，两个现有构建脚本全部assert通过。producer还覆盖完整module和identity损坏、identity缺失、拒绝覆盖，以及错误时不产生新输出或改写已生成归档。
- ROOT dependent WIP `workspace-startup1` 为23/0、72 expect，`workspace-debug1` 为2/0、16 expect；只是当前工作区的加载相邻证据，不计作独立提交实现了运行时接管。
- 两侧最终 release-check 与新 make build 均exit0；build绑定的core加CHANGELOG SHA256：独立 `8fcdbecb35c4d321d418c67bc04aeffcb8c31c5099aa2d620ccf4f3541275f27`，ROOT `da108c16cdf574448270a15f3443ff6771ece71b914e40d8a08707785d65d004`。最终binary分别为 `6de5cc09c2ef25e9b88805fd6575c385968a9cf5a25aea6a8da804009f35c66e` 和 `384dc2c324c5bd6ca376bbc51eef4d3c4b1cc691909691224a96a298c9b279b3`，本地版本保持2.1.280。`candidate-final-embedded.json` 与 `workspace-final-embedded.json` 静态确认各只有一份完整的46075字节最新归档，loader=file，entry设置内嵌路径；不存在从新二进制退回旧制品的情况。
- Runtime-observed：最终独立 `native-candidate-c2/evidence` 与实际ROOT `native-workspace-r2/evidence`，只复制二进制到私有cold目录，三种作者路径成功exit0、故意的TypeError失败exit1，interactive草稿/Ctrl+U及stdin `/exit 0`通过，无自有进程组残留。ROOT同场debug打印正确version/archive/module SHA；真正Worker的 `/diff` 打开显示会话内alpha.ts修改并关闭。该ROOT消费者含四个同步版本依赖WIP，不能据此把运行时实现计入本次提交。
- 失败证据保留：ROOT首次 `native-workspace-r1` 的 `/diff` 已打开，但author夹具留下的未跟踪符号链接抢占列表且预先编辑的alpha折叠于before-session，导致原断言失败；新r2忽略author目录并在ready后编辑alpha，原显示/关闭断言和90秒期限保持。第一次最终static输出因既有证据目录EEXIST停止，新建final目录后完成，旧证据未覆盖。
- 边界：这一独立批次关闭归档及打包缺口；G5、最新完整变更门禁、同进程全量suite、取消诊断时机及完整官方API/UI/diff矩阵仍未关闭。原ROOT制品、289归档和原response/improvment/fix-instructions的bytes与mtime保持；未push，未操作其他Claude进程。

## 2026-10-06 官方 diff 2.1.291 生产加载与接管独立提交

- 范围：从 HEAD `90c0a41d29d9c66ac6600e9262c87dfb476d6cfc` 的独立副本准备官方包加载、可信身份传递、命令接管、原生控制器暂停及偏好迁移；除完成本批所需的宿主后台等待和新会话 `session.usage.startedAt` 依赖，其余工作区WIP保留。基线完整hash以证据 `ROOT-before.json` 为准。
- Source-confirmed：原始291模块、身份模块、register闭包与compiled scan分别校验；扫描hooks、calls、env、runCommands逐项核对。提取JS仅静态读取；原始注册闭包由真实Worker运行。只读发现、复制对象、伪造字段或损坏模块不能获得运行时身份。`runCommands`为保留的静态元数据，不能据此声称 `$.command.run` 已实现。
- RED与修复：版本回归复现未加载291；后台等待回归复现hook返回后宿主过早移除尚未完成的调用；时间回归复现 `startedAt` 缺失及校验缺失。未来after/every等待独立于当前工作，已启动调用仍等其结果；失败、取消、卸载和退出的断言保留。所有早期失败与错误准备记录均保留，未提高超时限制。
- 最终独立 `candidate-final-tests2`：665pass、0fail、5skip，22个文件/3082expect；实际ROOT `workspace-final-tests1`：701pass、0fail、5skip，22个文件/3207expect。5skip来自原有外部fixture用例，不计为通过；本批14个diff接管用例直接读取仓库内的官方291归档，无条件运行。
- 两侧本轮release-check及make build均exit0。独立源清单（含CHANGELOG）SHA256 `3890c572b010293a9724382b89de6c4df8f80c3e4c5c989af57dc9f3c771a6fd`，ROOT `d15100ec3c5d7d19b1d96a2d3383d80db14e8054754ee3ba8aea0f0657349b69`；独立binary `1d368453b23ccc54c97f7a7a287aad70175c3485bb12a18eeca870b1c6643549`，ROOT `6d7c50a8884f3e40aa7aeacb10c642a06e2ec7ce48c281ef2d930e1e721d0068`，本地版本仍2.1.280。
- Runtime-observed：独立c2及ROOT r1的私有tmux在冷复制standalone后，经stdin `/diff`显示readiness之后的alpha.ts变更，160→140→160列缩放、关闭、草稿/Ctrl+U和 `/exit` exit0通过。正确291包来源与 `ownership=plugin` 已打印，期间无原生diff抓取；独立c3及ROOT r2禁用 `cc-plugin-diff@builtin` 后同场显示/缩放/关闭通过，原生抓取恢复且未取得插件接管。各场作者绝对/相对/带空格符号链接成功exit0，故意错误exit1；自有进程组清理后无残留。
- 官方对照：已核验官方291binary SHA256 `9a1d2ed6bb4421e8fc80c892c0413f293be3ee50ae3d7dda1a7622197a056690` 的独立o3场通过相同diff操作流程、终端尺寸、显示夹具及退出；此处对照行为流程，不新增字符/样式完全一致结论。o1暴露作者夹具缺少官方必需hooks module，修正两侧夹具后o2的作者错误栈诊断断言失败（官方没有输出要求的完整消息）；两次证据保留，作者诊断不计为官方parity通过，o3明确只验diff流程。
- 边界：关闭生产加载与接管缺口，不宣称完整API/UI/diff兼容已完成。逻辑会话启动时间的持久化/恢复、完整G5、同进程全量suite、最新全部变更门禁、取消诊断时机和完整交互矩阵仍待独立验收。ROOT现有逻辑启动时间WIP没有折入本批bootstrap；独立提交的读取器采样既有CLI成本启动时钟，历史恢复等价性未覆盖。
- 证据根：`/private/tmp/mods-diff-runtime-291-20261006-bt_p4ef_`。原ROOT二进制、289归档和response/improvment/fix-instructions的bytes及mtime保持；未push，未操作其他Claude进程。

## 2026-10-06 Mods 会话启动时间保存与恢复独立提交

- 范围：基于 HEAD `404ebdf1cc9d0a162881cf2491d238b782a43d03` 的独立候选，提交逻辑启动时间、JSONL 元数据保存/加载、匹配项目 lastStartTime、完整有效 cost-state 的启动时间读取，以及 branch/fork/clear/恢复入口的必要调用链。其余工作区 WIP 保留。
- Source-confirmed：官方 2.1.291 的 costLedger 区分活动时钟与逻辑启动时间；restore/anchor 将后者限制到活动时钟。原始 h7 schema 检查完整 cost-state、有限非负数、1e15 上限、1e9 成本上限、模型名称及四类 token 总量；有效 cost-state 使用最后一条记录。提取 JS 仅静态读取。
- RED：`candidate-red1` 3pass/10fail，复现成本时钟改变启动时间、clear 及持久化缺失；`candidate-cost-red1` 6pass/1fail，复现首条 cost-state 取代最后有效记录；`candidate-zero-red1` 7pass/1fail，复现零时长未重置时钟；`candidate-metadata-red1` 9pass/1fail，复现未来启动时间未受活动时钟约束；`candidate-fork-red1` 3pass/1fail，复现官方 --fork-session 的原始时间未保留。修复后原身份、时长、边界及无效记录断言保留；旧 fork 预期依据官方实测改为保留源时间，新 ID 的断言仍保留。
- 最终独立 `candidate-final-tests2` 与实际 ROOT `workspace-final-tests2` 均为98pass、0fail、0skip，10个文件/336expect。包含生产写入器、两个独立 Bun 进程之间的恢复、continue、JSONL 路径加载器、fork，以及 branch、压缩前扫描、持久化禁用和真实官方 diff Worker 相邻回归。
- 两侧 `*-check4` 的 release-check 与 `*-build2` 的本轮 make build 均 exit0，源码未被命令改写且自有进程组无残留。独立源码清单（含CHANGELOG）SHA256 `faf87f2f2adb2411edce63a5e1b19f981c30a2ea94b785fe044436fd98eff874`，ROOT `a02bb821e11da4e9c0a42696eb90e7d641d675d29dc56ee2463f1e2c6b6748f6`。独立binary `61aef7a099ec196d1d97e6222fcf1f4b6edfd2ce9b4fd0a14ad875b5d7895f14`，ROOT `1d7ed4f14bf7e28480bf2f55c7c2711f0b13a28d419da1d159af181f19c511ae`，本地版本仍2.1.280。
- Runtime-observed：最终候选 `native-candidate-c5`、ROOT `native-workspace-r1` 和官方 `native-official-o3` 使用独立私有 tmux/config、相同160×40终端与本地确定性响应夹具串行验证。生产 JSONL 保存源时间；continue、ID 恢复和交互式 /resume 保留它；--fork-session 保留源时间但生成新ID；/branch、/clear 生成新ID和新时间。退出均exit0，冷复制binary未改变，无自有进程组残留。实际模型网络兼容性不在此夹具证据范围内。
- diff 时间边界：在源会话退出后、恢复进程启动前修改 alpha.ts；恢复后显示1 file changed +2 -1、两处补丁，且没有 edited before this session 折叠，关闭后正文消失。此处证明 epoch/ID/时间分类及操作流程，不能据此声称完整字符、样式、焦点或 inline/narrow 矩阵已对齐。
- 失败与准备记录保留：首次schema类型检查因UUID transform推断可选字段失败，改为先校验wire string再返回UUID；两次错误测试路径准备在严格文件存在检查处停止，未计为测试通过。c1的驱动误将项目成本保存当作会话ID来源，改用公共 $.session.id()，原失败保留。c2/o1要求默认diff打印 this session 标签失败；原始un()和同场官方画面证实普通session模式不打印该标签，最终改用准确文件/行数/补丁且保留禁止会话前折叠的断言。c3的JSONL-path CLI进入搜索选择器；o2暴露 --fork-session 时间语义错误，真实实现及回归均已修正。期限保持90秒，未跳过生产回归。
- 未关闭：普通交互CLI的直接JSONL文件启动受内部模式限制；文件加载器由自动化测试覆盖，未声称该CLI路径恢复通过。在线远程会话ID分配仅完成必要参数传递和状态单测，未在线验收。此次实测本地CLI退出没有像官方一样保存项目成本记录，已列入成本账本/退出保存后续对齐；JSONL时间保存与恢复独立通过。完整cost-state成本恢复、G5、最新全部变更门禁、全量同进程suite及完整API/UI/diff矩阵仍需后续工作，不宣称完整兼容完成。
- 证据根：`/private/tmp/mods-session-epoch-20261006-5fm7g4br`，具体输入、pane、ANSI、原始PTY、API夹具请求、调试日志、源码清单、binary hash、session/PGID和失败原因保存在各场目录。原ROOT二进制、289归档及response/improvment/fix-instructions的bytes与mtime保持；未push，未操作其他Claude进程。
