# Mods 修复与兼容性验收

## 后续修复轮：输入链、Workflow 与 SSH 长路径（进行中）

本节为最新工作状态；下方各轮结果作为历史证据保留，不改写原失败。基线为 `feat/mods@690ecbac3773c98a98664c94dfab26d57065ae44`，新证据根为 `/private/tmp/mods-input-repair-20260918-rw73i3qa/`，方案见 [mods-test.md 第 8 节](mods-test.md#8-后续修复轮输入链workflow-与-ssh-长路径)。

- 已批准范围：Mods 人工入焦、方向键导航、Button action/chord 与 wheel pointer 接线；SSH control/proxy 长 TMP socket 路径；Workflow 原 5000ms 超时的透明生命周期取证，有证据支持才修复。
- SSH 长路径已取得定向红绿；主线程评审另补 close/error 清理异常逸出的 2 项红→绿，SSH 相邻10文件最终142 pass / 0 fail、自有资源清理完成，签名提交 `1a7abc9`。仅真实本地 UDS，不等于真实 SSH 集成。
- Mods 输入链实现及接管审查完成。API 连接中断未被当作产品失败；接管补齐 REPL pointer/当前 presentation/最终 landing 接线测试，并修复 Escape 后延迟 host focus 重新抢焦的竞态。最终7文件206 pass / 0 fail，包含跨 pane 迟到请求和正常重新入焦。
- 当前源码 `make release-check` 全部通过（TypeScript、lint、audit、changelog和diff），检查前后 tracked 内容未变。完整自动化、新构建或新 binary 交互结果尚未产生，不引用旧通过数字充当新执行。
- Workflow 已执行一次探针校准和一次 180 文件前缀、0 缩减；目标三项完成，普通调用 67.568ms，但原超时根因仍未定。主线程只读 raw 查明该前缀整体 exit1 来自镜像遗漏内嵌 CHANGELOG，导致 uiName/setup 导入错误，不能算输入等价的原前缀复现；不额外重跑。见新证据根 `workflow/main-review.json`，原 timeout 继续阻止推送。
- 官方检测计划使用 `--settings /Users/esonhugh/.claude/settings.mjclouds-ant.json`。一次 Git fixture 修正后仍被 macOS sandbox 数值 remote-ip 语法阻塞，official 进程未创建、配置未被 official 消费，模型请求 0；不能判断配置有效性或新的 gate 状态。资源已清理，记录 not covered，见 `official-configured/summary.json`。配置内容不打印、上传或提交，场景与本地 synthetic/loopback 回归分开。
- 后续按功能签名提交、冻结源码完整测试、release-check/build 和 scripted tmux 验收；CHANGELOG 在构建前定稿，最终结果只回填不内嵌报告。未解释本地失败仍阻止推送；两份既有草稿保持不动。

---

## 2026-09-18 三项修复收口：最新执行记录

**本节是最新状态，取代下方历史节的“当前状态”表述；历史 failed 原文不改写。** 三项已确认产品问题均已修复并取得红→绿回归。SSH测试后续以awaited React `act`修复并签名提交`d9a28d1`，两次完整同进程均通过该脚本；但第二轮新增Workflow command-runner超时，根因未定。既有SSH ControlPath长路径限制未修复，新binary交互补验又发现部分官方 diff 控件失败。当前整体不能判通过，推送继续阻塞。

本轮证据根 `C` = `/private/tmp/mods-closure-20260918-dbe9mry_`。完整测试方案、判定规则、命令和结果索引见 [mods-test.md](mods-test.md)。README 已增加 Mods 当前源码特性、使用方式和可信代码边界，CHANGELOG 已增加无版本号的未发布条目。

### 修复与签名提交

| 提交 | 变更 | 红绿与边界 |
| --- | --- | --- |
| `c006eeb` | 普通 hooks snapshot 只消费 accepted settings，不清缓存绕过 ConfigChange；可信 cwd 转换显式 reset | 审核前候选不可见，block/allow/retry 与 source scope 通过 |
| `8de982f` | remote managed 磁盘缓存先验证再参与 precedence/merge/origin；保留 schema diagnostics | 非法层让位合法 MDM/file/HKCU，修复缓存后恢复；leaf 未引入 schema 循环依赖 |
| `0da3f73` | overlay 拥有键盘时 PromptInput 不记录 Escape 双击 | 真实 PromptInput harness 红→绿；Pane 关闭后第一下不误触发、第二下正常 Rewind；相邻 UI 25/0 |
| `be36848` | README、CHANGELOG、mods-test 与研究历史范围勘误 | 文档链接、changelog check/tests、TypeScript、lint、diff 通过 |
| `ef1f440` | SSH 测试首次使用 Ink 同步刷新 | 精确前缀红→绿，但后续完整批次仍重现；不能单独视为修复充分 |
| `d9a28d1` | SSH 测试 awaited React `act`，显式callbacks和finally清理 | 受控红→绿；55前缀79/0、20独立重复、两完整批次SSH均完成；主线程单文件与release-check通过 |

两项 settings 四文件相邻回归为117 pass / 0 fail。上述均为正常签名提交，未跳过 hooks/signing，未改版本、依赖、CI，也未暂存两份既有 cross-session 设计草稿。

### 首轮完整自动化与新失败

- `be36848`：261 文件独立 OS 进程，260 qualified；1565 registered pass / 3 Peer fail，106 个 assertion scripts 完成，0 timeout。
- 同一提交的完整显式清单 `bun test --isolate --no-orphans`：完整结束、exit 1，raw footer 为1565 pass / 4 fail / 1 error；JUnit 只记录3个Peer failures。额外顶层 `useSSHSession.test.tsx:240` readiness 断言确实失败，不能视作统计噪音；首轮报告纠正见 `C/automated/main-review.json`。
- SSH readiness最初定位为ConcurrentRoot的测试提交竞争：单次`setImmediate`不保证React commit。`ef1f440` 仅在测试中使用现有Ink `pause()/resume()`，精确前缀、单文件重复及 `C/automated-ssh-final/` 两完整模式均通过；但后续短TMP完整同进程又复现，说明该修复仍不充分，不能宣称根因已完全解决。`C/ssh-readiness-final/` 的受控调度已区分callback调用和commit，后续`act`修复两次自然完整运行均有SSH sentinel；原未插桩批次的精确分支不能追溯证明。
- 最新`act`源码的两次完整261同进程为1565 pass / 3 Peer fail和1564 pass / 4 fail。第二次多出`src/tools/WorkflowTool/compatibility/runCommand.test.ts:6`的5000ms timeout，根因未定；每轮105/105既有脚本sentinel、另1脚本无标记，child6/0另计，无顶层Unhandled。Peer fixture授权恢复，ControlPath与PTY通过。有界诊断单文件3次各3/3、相邻10文件30/30通过，未复现、根因仍未定；不再盲目全仓重跑，原full-b仍failed。证据`C/workflow-timeout-diagnosis/summary.json`；源码内容身份未变、自有进程及短TMP已清理。
- `C/automated-ssh-final/` 两完整模式各1564 pass / 4 fail：除3个Peer外，长TMP令SSH ControlPath达到111/112字节，现有`<104`断言失败。生产与测试同起始baseline byte一致，有界对照128/105字节失败、98字节通过。此为既有非Mods限制，未修改产品。长TMP批次独立259/261文件qualified、106脚本完成；同进程105个完成sentinel，native download无独立完成标记，不能借独立通过补写同进程全覆盖。
- `C/automated-short-final/` 使用新独立短TMP后ControlPath与PTY通过，但同进程为1553 pass / 16 fail / 1 error，独立1553 pass / 15 fail、106脚本完成。15个Peer失败来自runner误删既有`/tmp/cc-peer-test-*`路径授权，fixture创建阶段即被拒；不是之前3个process-start断言的同一证据。同进程额外1 fail / 1 error为SSH readiness重现，不能由该轮独立或55文件前缀通过覆盖。
- 首轮 Mods 22 文件全部 qualified，559 pass / 0 fail / 0 skip；这是261清单子集，不重复累加。
- Peer 三项保留 environment-blocked：sandbox 拒绝 setuid `/bin/ps`，私有非 setuid 原样副本亦被 OS 终止；未取消安全隔离、伪造进程身份或跳过断言。
- 历史 PTY `2 !== 130` 首轮独立、同进程及额外9项重放均未重现，不声称根因已修复。
- 首轮父 LCOV：Mods 5079/5813（87.37%），19个已插桩源码文件；全部导入父源码60345/260451（23.17%）。不覆盖Worker/VM/child/compiled，不代表全仓或完整功能覆盖。

### 构建、交互结果与推送阻塞

`be36848` 上 `make release-check`、`make build` 均 exit 0，tracked 内容前后无变化。binary 为2.1.219，100102754 bytes，SHA-256 `781fa13125c9cb2da9153c38ae260a662424cb002c50e4605d3944bf8179115a`；证据 `C/build/artifact-lock.json`。后续SSH提交只改测试，未改变生产构建输入，见 `C/build/ssh-test-content-continuity.json`。

Workflow超时有界诊断已完成，未复现但根因未定；首轮runtime固定证据汇总已完成（`C/runtime/summary.json`）：含UI共50场、641 raw assertions；49个result场景27 passed / 17 failed / 5 not covered，UI另13条通过。12组矩阵6 passed / 3 failed / 2 not covered / 1 environment-blocked，整体failed。已记录资源50场回收，正常退出45/2/3分别计；身份final hash缺失与不匹配区分。文档后新制品限定smoke也已结束，结果见下表；没有仍待运行的本轮实验。已完成的 diff 控件补验出现新失败：inline 方向键文件导航、fullscreen 文档快捷键和滚轮未达到预期；Enter、inline 详情滚动、两级 Escape 及 fullscreen 鼠标 row/边缘按钮有独立通过证据。原始失败和不合格尝试全部保留，不能用鼠标成功替代键盘失败；推送继续阻塞，不扩展本轮产品开发范围。当前结果文档已签名提交`6968ad7`，其后重新`make build`通过：新binary仍为2.1.219、100102754 bytes，SHA-256 `3fa04adbb474f9bbebc95581a2c8fa829f4f42e4e27313bc9f6a81f8c7aa7e6b`。生成CLI除内嵌CHANGELOG外逐字节相同，Worker与native不变，证据`C/build-final/input-continuity.json`；新制品限定smoke写入`C/runtime-final-smoke/`，不能把首轮测试直接改标为新制品运行。官方自然 Mods gate、平台覆盖、default权限、settings编译制品路径等均按实际证据单列，不以源码或旧binary通过替代。

### 最终新制品限定 smoke 与收尾

使用上述`3fa04adb…`制品，`--version`、`--help`通过；真实scripted tmux的三个有效场景共30条限定断言通过，均正常`/exit`为0。证据`C/runtime-final-smoke/summary.json`，精确命令、session/pane、环境和captures在各场景目录。

| 场景 | 结果 |
| --- | --- |
| `basic-a3` | 8条通过：无plugin连续两轮请求和响应，每轮一个主模型请求，prompt恢复 |
| `inline-a2` | 13条通过：完整官方diff原件及运行副本775文件hash一致，真实Read/Edit各1次；快速Escape间隔269.48ms，详情→列表→关闭无Rewind，随后正常双Escape仅打开一次Rewind |
| `context` | 9条通过：当前请求marker计数`0→1→0`，不重复注入 |

三次harness失败不改标：sandbox地址语法错误、manifest路径错误各一次（均未启动CLI），另一次纯文本场景误用工具终态谓词，cleanup期间exit0不算正常退出。六次attempt资源回收均通过，见`C/runtime-final-smoke/cleanup-audit.json`。空Mods/no-plugin规范化请求对照仍not covered，因此限定smoke总体记录为not covered，不替代首轮完整矩阵failed；也未重验或修复已确认的方向键、fullscreen action/wheel及keyboard ask问题。

smoke期间agent发现的两份报告内容漂移，是主线程并发更新`handoff.md`和`mods-test.md`；此处补充归因，保留agent原始“未归因”记录及全仓内容不变断言失败。binary和生产构建输入未变，CHANGELOG不再修改，只提交这两份不内嵌报告，无须因报告hash变化再次构建。

**本轮实验已结束；整体验收仍failed，未推送。** 推送阻塞是已确认的diff交互缺陷和根因未定的Workflow timeout，不是后台任务仍在运行。两份既有cross-session草稿保持不动，不新增API或扩展UI开发，不创建tag/release/PR，不上传原件或raw日志。

---

## 2026-09-18 修复后冻结源码：严格测试已结束，整体 failed

**当前整体 failed：仍有两处settings缺陷及inline快速双Escape误开Rewind；Peer身份测试environment-blocked，官方Mods运行parity为not covered。不能宣布全量通过或 full covered。** 本节优先于后面的历史基线；分支仍为 `feat/mods`，HEAD 为 `6c7b0e0eb7a9b36d4003c3a713209449c91d1b9a`，本轮定向修复尚未追加 commit/push。源码身份由逐文件 SHA-256 固定，不能仅凭相同 HEAD 将未提交修复混同旧构建。

证据根 `T` = `/private/tmp/cmtest-o4j65cp5`。最终自动化的前后源码核验均为 `source_changed: []`，见 `T/final/source-before.json`、`T/final/summary.json`、`T/tracked-final/result.json`。本次不再沿用旧同进程超时结论，也不倒改任何历史失败记录。

### 最终自动化结果与资格

| 检查 | 本次结果 | 证据 |
| --- | --- | --- |
| 全仓 TypeScript | exit 0 | `T/final-tsc.log`、`T/final-checks.json` |
| `bun run lint` | exit 0 | `T/final-lint.log`、`T/final-checks.json` |
| `git diff --check` | exit 0 | `T/final-diff-check.log`、`T/final-checks.json` |
| 261 文件、每文件独立 OS 进程 | **259/261 文件 qualified；1562 registered pass / 3 fail；105 个 assertion scripts 完成、1 个失败；0 skip / todo / timeout** | `T/final/results.json`、`summary.json`；155 个 registered 文件、106 个顶层脚本 |
| 显式 tracked 同进程 `bun test --isolate --no-orphans` | **完整结束，exit 1；原始 footer 为1562 pass / 4 fail / 1 error** | `T/tracked-final/output.log`、`result.json`、`junit.xml`；261 文件，未超时 |
| Workflow 原有 preload 恢复后的独立补验 | **exit 0，完整脚本 sentinel 已确认** | `T/workflow-preload-recheck/result.json`、`output.log`；不替换上面原批次失败 |

两个批次失败集中在相同两个文件。同进程的第四个 fail / 1 error 来自顶层 Workflow 脚本，不是额外的 registered test；它与独立批次的3个 registered fail应分层报告。父进程共 **4338 expect calls**，子进程日志中的摘要没有重复相加，资格审计见 `T/final/qualification-audit.json`。JUnit单列1565个registered cases、3个Peer failures、4333 assertions，不包含该顶层脚本error；不将JUnit与raw footer相加或静默改写其差异。交叉审计与证据hash见 `T/final-cross-audit.json`。清单排除了误匹配的生产模块 `src/ink/hit-test.ts`；261 个测试路径均唯一。

同一独立批次中，`src/services/mods/` 的22个测试文件全部 qualified，**558 registered pass / 0 fail / 0 skip**；既有90文件 Mods/相邻清单为89文件 qualified、961 registered pass / 0 fail、34个完成脚本，唯一未完成脚本是下述漏 preload 的 Workflow。它们是261清单的子集，不重复累加。

所有测试使用私有 HOME/config/XDG/TMP、synthetic API key、OS sandbox；非 loopback 网络与真实凭据读取被拒绝。完整官方原件及完整目标 `.d.ts` 均显式配置，相关测试不是因缺 fixture 而跳过。单测、顶层脚本、compiled CLI 和官方二进制 parity 不互相替代。

### 剩余失败定位与补验边界

1. **Peer IPC，3项仍为 environment-blocked。** `src/utils/udsMessaging.test.ts` 的 registry process-start、recycled PID discovery、stale authentication 检查在 sandbox 下失败。此前已确认 `/bin/ps` 无法执行、`procStart` 不可得；本次独立批次仍为12 pass / 3 fail，见 `T/final/f259/output.log`。未取消隔离、伪造身份、跳过或弱化断言。当前结果不能证明真实进程身份路径已通过。
2. **Workflow 脚本，本次 runner 漏了既有前置条件，已补验。** `workflowScriptRuntime.test.ts:376` 的 agent 调用数1而非2，对应私有 workflow session 明确报 `Plan mode is disabled`。旧90文件清单的合格命令含 `--preload enable-plan-fixture.ts`，新 runner 重建 direct argv 时丢失此项；有界审计确认这是旧清单中唯一的 preload。恢复原 preload（只在新私有 config 写 `planModeAvailable:true`）后，完整脚本输出 `workflowScriptRuntime.test.ts passed`，exit 0、无超时、源码无变化。证据 `T/workflow-preload-recheck/preload-inventory-audit.json`、`result.json`；未修改 Workflow 生产代码、权限判断或测试断言。

Workflow 补验只证明同一脚本在正确前置配置下完成，**不能将原261文件批次改写成260/261或同进程全绿**，也不能把补验与原运行的计数重复累加。它与下方历史 `LocalWorkflowTask.test.ts` 的 fixture 修复是两个不同文件、不同问题记录。

3. **新增确认的 settings 审核前竞态，未修复。** 迟到的静态审查提示 `updateHooksConfigSnapshot()` 在 watcher review 开始前调用 `resetSettingsCache()`，会清空尚未 retain 的 accepted parse；随后重新 capture 直接接受外部 bytes。仓库外复制现有 settings harness、使用真实生产模块和原生 watcher ready 后定向对照：不刷新 snapshot 时旧 `disableAllHooks:true` 保持有效，block callback执行1次；外部写false后同步调用 `updateHooksConfigSnapshot()` 时立刻读到false，后续显式review看到相同identity而跳过callback，review次数为0。控制组 **1 pass**，目标组 **1 fail**；不是已有261清单中的测试，不混入其计数。源码未变，未弱化断言。

   - 根因位置：`src/utils/hooks/hooksConfigSnapshot.ts:117–124`、`src/utils/settings/settingsCache.ts:90–94`、`src/utils/settings/changeDetector.ts:431–449`。
   - 证据：`T/settings-pre-review-probe/resolved-results.json`、`control-resolved/output.log`、`refresh-before-review-resolved/output.log`；最初外部fixture无法解析chokidar的日志保留，改为指向既有依赖的绝对路径后才取得合格对照。
   - 边界：确认真实模块组合的审核遗漏，不等于已通过终端重现所有触发入口。当前五核心 watcher/reload通过不覆盖这一前置窗口，不能声称“所有未批准配置都不会生效”。当前源码保持冻结，本轮报告列为产品未修复项；后续修复必须补对应repo回归并重新验证源码/制品身份。

4. **损坏的远端 managed 缓存未被排除，未修复。** 对迟到审查中的第二个具体边界进行私有fixture对照：合法 `remote-settings.json` 正常胜出；非法 `{model:42}` 虽产生schema错误，却仍作为policy参与合并，最终model为42，合法managed文件中的model与`permissions.deny:['Bash']`均未采用。控制组 **1 pass**，非法缓存目标组 **1 fail**。`loadPolicySettings()` 使用原始remote对象，而 `loadSettingsFromDisk()` 只记录验证错误；`syncCacheState.loadSettings()` 的磁盘缓存路径仅做JSON对象形状检查，不能假设该缓存必然已验证。旧 `1476236` 的merged settings load在remote验证失败时会继续选MDM/file，因此这里有已确认的merged读取回退回归。

   - 根因位置：`src/services/remoteManagedSettings/syncCacheState.ts:57–64`、`src/utils/settings/settings.ts:341–359`、`:693–714`。
   - 证据：`T/settings-pre-review-probe/remote-policy-results.json`、`remote-valid/output.log`、`remote-invalid/output.log`。仅写私有合成缓存和私有managed文件，无真实账号、remote服务或共享policy访问；未修改源码。
   - 边界：HTTP获取路径在 `src/services/remoteManagedSettings/index.ts:322` 已做schema验证；本次证明磁盘缓存入口的错误配置处理问题，未证明远端服务可直接发送非法配置绕过该校验，也不据此推断任意用户可修改管理员策略。

### 最终覆盖率：仅父进程 LCOV 的源码行并集

`T/final/coverage-summary.json`、`coverage-per-file.json` 保存逐文件结果和输入 LCOV 的 SHA-256。按 canonical source/line 合并，以正数最大 hit count 计算，不重复累加同一源码多次导入。

- Mods：**5079/5813 行，87.37%，19 个已插桩源码文件**。
- 全部被导入的父进程源码：60158/260443行，23.10%，1244文件；**不是全仓覆盖率**。
- 仅既有90文件 Mods/相邻 inventory 中的父 LCOV；Worker、VM、child process/compiler、compiled CLI不在该插桩范围，直接 assertion scripts 无 LCOV。
- 失败执行所经过的代码仍贡献观察到的覆盖行，不贡献验收成功。
- `protocol.ts`、`types.ts`、`worker.ts` 不在父 LCOV；`uiRealm.ts` 为0/142，不能据此推断其真实 Worker 功能没有执行。

| Mods 源文件 | covered / instrumented | line % |
| --- | ---: | ---: |
| classicAdapter.ts | 198 / 403 | 49.13 |
| commandAdapter.ts | 177 / 203 | 87.19 |
| commands.ts | 150 / 182 | 82.42 |
| dispatch.ts | 383 / 383 | 100.00 |
| environment.ts | 329 / 330 | 99.70 |
| hostOperations.ts | 325 / 361 | 90.03 |
| loader.ts | 609 / 622 | 97.91 |
| matcher.ts | 70 / 73 | 95.89 |
| native.ts | 89 / 90 | 98.89 |
| plugins.ts | 176 / 185 | 95.14 |
| promptAdapter.ts | 145 / 145 | 100.00 |
| runtime.ts | 870 / 899 | 96.77 |
| session.ts | 301 / 337 | 89.32 |
| sessionMessages.ts | 36 / 36 | 100.00 |
| toolAdapter.ts | 273 / 324 | 84.26 |
| toolCatalog.ts | 150 / 168 | 89.29 |
| turnAdapter.ts | 103 / 133 | 77.44 |
| ui.ts | 695 / 797 | 87.20 |
| uiRealm.ts | 0 / 142 | 0.00 |

### 新构建、交互与官方对照：已结束

新证据根 `F` = `/private/tmp/mods-final-fixed-20260918-r9vsfofu`。在最终自动化完成后实际执行 `make build`，exit 0；Makefile版本仍为 **2.1.219**。排队fixture初次超时后代理遇API socket中断，用户要求retry；接续任务沿用同一证据根和制品，保留旧raw、不重复完成场景、不重新构建。

| 身份 | 本次值 |
| --- | --- |
| 源码内容SHA-256 | `4c960006dd9a27dabd6106a28de9f1d39592cd6bbee96c061219a0319a95d6db` |
| 本地binary SHA-256 | `7c94b14562d53b40da61cc184f7db6161b7d514d2bfe2f33c9f0a6a48cce6576` |
| 本地产物 | `built-claude`，100102754 bytes，实际2.1.219 |
| 官方binary SHA-256 | `195e24e8e1f9bf46f1eaee72d434a33e18f9f5796f29a6348a00d16c5f8aee75`，实际2.1.272 |
| 构建/身份证据 | `F/build.json`、`resume-identity-preflight.json`、`resume-identity-final.json` |

2575个源码/测试文件与自动化及构建快照一致，0 changed。两端使用hash一致副本、独立cwd/HOME/config/XDG、synthetic key、loopback API、sandbox和scripted tmux；160×50，pane均为`%0`。入口保留 `./built-claude --dangerously-skip-permissions` / `./official-claude --dangerously-skip-permissions`；权限实验先通过真实Shift+Tab切换到`default`，并由hook输入独立确认模式，**不是在bypass中假测ask/deny**。

#### 去重功能矩阵

| 范围 | passed / failed / not covered | 结论与边界 |
| --- | --- | --- |
| 五核心：初始化pending、清框、新草稿、reload、native watcher | 41 / 0 / 0 | 含基础设施的原始断言为66/66；接续任务只审计、不重复 |
| active-turn Enter / queueSubmit | 6 / 0 / 0 | 同一active turnId、wait=false/true、core admission先于next receipt、drain不重跑Mod/classic hooks、rewrite/context各一次、新草稿保留 |
| default工具权限与host边界 | 6 / 0 / 0 | 实际ask→Yes执行/No无副作用，配置allow/deny通过；可信Mod process capability与工具权限另行观察 |
| 官方diff原件在本地inline | 7 / 1 / 0 | open、Enter→hunks、返回、ask、单次context、独立reload、disable→builtin归属通过；快速双Escape仍失败 |
| 官方diff原件在本地fullscreen | 5 / 0 / 1 | 现有运行只审计；disable→builtin内部归属证据仍不足，不借用inline通过替代 |
| 官方2.1.272原件对照 | 0 / 0 / 9 | 自然rollout-off，后续Mods行为不可比较；builtin成功不计Mod通过 |
| **合计功能矩阵** | **65 / 1 / 10** | 共76项，范围有界，不等于完整官方API或完整插件功能覆盖 |

总计13次raw实验（中断前8次、接续5次），原始断言 **138 passed / 6 failed / 22 not covered**。根据同次证据纠正四处判定器缺陷后为 **142 / 2 / 22**：排队context实际位于nested tool_result.content；拒绝文案为aborted；diff上下文统计误纳入辅助Haiku请求；reload归属marker在关闭而非打开时出现。旧raw未改写，修正附独立audit。剩余两个raw失败分别为旧queued fixture拒载和快速Escape产品问题；功能表排除了基础设施、无效fixture首试和重复setup。没有将累计166条raw记录冒充166个独立功能。

#### inline已修项、新失败与归属证据

- **旧Enter卡住已在新binary消失**：原件文件列表→Enter→hunks通过，支持同id resize保焦点修复；未改官方源码。
- **新失败：快速双Escape误开Rewind**。detail→list→close两次Escape间隔约 **205ms**，Mod已关闭但composer未正常恢复，反而打开Rewind。现象确认；候选原因为focused Mods pane消费Escape后，PromptInput仍计入800ms double-press窗口，尚无事件路由级插桩证明完整因果链。位置 `src/components/ModsPane.tsx:746`、`src/components/PromptInput/PromptInput.tsx:2633`、`src/hooks/useDoublePress.ts:6`。证据 `F/product-findings.json`、`runtime/local-original-inline/dialog-dismiss-viewport.txt`、`diff-closed-timeout-viewport.txt`及同次`inputs.json`。后续间隔超过1.05秒可正常关闭，仅用于继续其余场景，**不算修复，不覆盖原失败**。
- ask/context在第二独立完整场景验证：两个主请求新增diff附件次数为`[1,0]`，辅助请求不混计；`runtime/local-original-inline-remaining/ask-context-audited.json`。
- 在明确关闭后单独reload，reopen后对应Mod关闭marker证明归属；disable后有同次builtin归属记录。`reload-ownership-audited.json`、`disable-ownership.json`，不以旧viewport残留判断owner。
- 所用官方diff原件固定commit `f96c3b49c4c8721685206aaab23609b2d399df4e`，该diff目录775文件哈希均一致；不是完整官方仓库文件数。

#### admission、权限及官方边界

- queued首试`module-ready`超时的直接原因是fixture将`$`传入helper而被loader拒绝；仅修仓库外harness为有效契约，未放宽loader。后续实际键盘`Enter`与`ctrl+x enter`的同次wire、classic/Mod调用和队列界面证据通过。私有enqueue函数的精确调用时间未插桩，运行证据证明public admission先于next receipt、API barrier释放前已显示入队、drain恰好一次；不将其夸大为内部时间戳证明。见 `F/resume-harness-diagnoses.json`、`runtime/queued-admission-ready-fix/wire-counts-audited.json`。
- 真实default模式ask→Yes/No通过。初次allow规则fixture夹带重定向，因此又触发路径授权；后续只重跑未完成的规则场景，避免用此harness失配指责产品。见 `runtime/default-permissions/default-mode-observed.json`、`ask-deny-audited.json`、`runtime/default-permissions-remaining/result.json`。
- **可信Mod的`$.process.run`不是模型Bash工具权限边界**：实测`deny:["Bash"]`不阻止该host capability，见 `host-boundary-observation.json`。当前工具ask/allow/deny通过不能据此承诺每个Mod进程操作都弹权限框；Mods不得作为不可信代码的隔离沙箱。
- 官方同fixture在本轮真实启动仍记录`tengu_plugin_hooks_modules`自然关闭，原因是隔离third-party loopback provider/telemetry opt-out；未伪造账户、feature flag或读取真实认证。`F/official-local-symmetry.json`、`runtime/official-original-inline/gating-markers.json`保存对照。不推断真实获授权账号的rollout状态，也不宣称官方运行parity通过。

#### 精确运行索引与清理

- 全部argv/env、session/socket/pane、输入、captures、API/debug及逐条assertions：`F/runtime-evidence-index.json`、`raw-assertion-ledger.json`。
- 最终审计汇总：`F/resume-summary.json`；原始与修正判定逐条有来源，不拼成单次全绿运行。
- 主要tmux targets：`cc-fixed-local-original-inline:0.0`、`cc-fixed-local-original-inline-remaining:0.0`、`cc-fixed-queued-admission-ready-fix:0.0`、`cc-fixed-default-permissions:0.0`、`cc-fixed-default-permissions-remaining:0.0`、`cc-fixed-official-original-inline:0.0`。
- **13次实验的所有自有CLI/API/tmux进程、端口与socket均已清理**，未触碰其他进程；见 `F/resume-cleanup-final.json`。无运行中验证代理。
- 未自动追加commit/push、未改依赖或共享设置，两份cross-session设计文档未动。后续优先修两处settings边界和Escape事件归属，均需红绿回归及新制品复验；官方gate与fullscreen归属缺证据继续保留not covered。

---

## 2026-09-18 严格测试：feat/mods 冻结基线（历史 failed，后续修复见上节）

本节优先于后面的历史状态。基线为 `feat/mods@6c7b0e0eb7a9b36d4003c3a713209449c91d1b9a`；13 个功能提交已经完成，未 push。下列自动化与 18 场 scripted tmux 均在源码冻结期间执行，前后内容身份一致。基线结束后才开始定向修复；旧制品的通过结果不覆盖后续源码。

证据根：

- `T` = `/private/tmp/cmtest-o4j65cp5`
- `E` = `/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-repair-20260916.aHC2Z1mz`
- `V` = `/private/tmp/claude-mods-final-6c7b0e0-20260917.gC6zgZbU`

### 自动化：完整运行与独立进程必须分开

| 检查 | 基线结果 | 证据及限制 |
| --- | --- | --- |
| `bun run lint` | exit 0 | `E/integration/feat-mods-lint-01.log`；仅该基线 |
| `tsc --noEmit --pretty false` | exit 2，5 处诊断 | `E/integration/feat-mods-precommit-typecheck.log`；public turn 成员缺失两处、REPL 缺类型 import、plugin tier 测试类型两处 |
| 裸 `bun test` | 600 秒超时，不完整 | `E/integration/feat-mods-full-bun-test-01.log`；自动扫入 ignored `dist/codex` 的外部 SDK 测试，且有本项目红测；旧 runner 外层 exit 0 不代表内部成功 |
| 显式 tracked 清单，`bun test --isolate --no-orphans` | 600 秒超时，最终 -9 | `T/tracked-result.json`、`tracked.log`；262 个发现项，不等于全部完成；auth-sensitive top-level Agent 脚本缺 synthetic key，错误后等待未结束 |
| Mods＋直接相邻，37 文件独立进程 | 33 文件通过；830 pass / 6 fail；1 个完成的 assertion script | `E/integration/feat-mods-isolated-20260917-final-summary.json`；完整原件和完整目标类型均配置，0 skip / timeout |
| 既有相邻 inventory，53 文件独立进程 | 53 文件通过；89 registered pass；34 个完成的 assertion scripts | 同上；未与同进程失败批次混算 |
| SSH proxy / session / PTY，3 文件独立进程 | 41 registered pass / 0 fail | `T/smoke-results.json`、`smoke0.log`–`smoke2.log`；短私有路径和所需 Unix socket / PTY 权限后通过 |
| Peer IPC 独立进程 | 12 pass / 3 fail，environment-blocked | `T/smoke3.log`；sandbox 下 `/bin/ps` exec 被拒，process-start 身份不可得；未取消凭据隔离、未伪造身份使其通过 |
| 其余 168 个发现项，逐文件独立进程 | 165 exit 0，3 exit 1，0 timeout | `T/remaining-results.json`、`remaining-summary.json`；96 个注册测试文件为545 pass / 3 fail；另68个 assertion scripts有完成标记、2个脚本失败、1个脚本当次缺标记、1个误发现的生产模块 |

三批清单已核对互不重叠，覆盖262个发现项（其中1个是上述生产模块误匹配），基线合计 **1517 registered pass / 12 fail、103 个完成的 assertion scripts**，另2个脚本失败、1个当次缺sentinel；见 `T/baseline-inventory-audit.json`。这是多个独立进程的基线汇总，不是单进程完整 `bun test` 通过，也不包含后续重试。

最后一组的两个脚本失败为 `bootstrap-openai.test.ts` 与 `LocalWorkflowTask.test.ts`；Bun 将 top-level error 打印为各 1 fail，这两条不混入 registered test 计数。`src/ink/hit-test.ts` 实为生产 hit-testing 模块，仅因命名被 Bun 匹配，不计测试通过。`nativeInstaller/download.test.ts` 原运行无完成标记，后以 `await import(...)` 后置 sentinel 独立复验完成，证据 `T/main-fix-4.log`；不倒改原批次资格。

90 文件 coverage 共53份 LCOV：Mods 父进程已插桩源码行并集 **5059/5796（87.28%）**。全部导入源码为23.05%，不是全仓覆盖率。Worker、VM、child compiler/process不在父进程LCOV内，直接执行脚本无LCOV；失败测试执行行也计入覆盖率。最终父进程 expect calls为3424，旧汇总3510错误重复计入 `print.peer` 子进程86次；修正和子摘要边界见 `E/integration/feat-mods-isolated-20260917-final-summary.json`、`feat-mods-isolated-20260917-coverage-summary.json`。不宣称 full covered。

### 新构建、交互与官方对照

实际 `make build` exit 0，版本仍为 **2.1.219**，未伪装成官方2.1.272。Bun构建成功不替代tsc通过。

- 本地 SHA-256：`1ccb1c0eb4f82feb86f63e5902eb86788f1c375eabcb014311dc2e6fdf006e42`。
- 官方2.1.272 SHA-256：`195e24e8e1f9bf46f1eaee72d434a33e18f9f5796f29a6348a00d16c5f8aee75`；指定制品与仓库 `official-claude` 一致。
- 构建/source link：`V/build.json`、`V/source-build-link.json`；18场精确argv、输入、session/socket/pane、原始结果及审计解释：`V/final-adjudication.json`、`V/runtime-summary.json`。
- 两端均以hash一致副本在仓库外隔离workspace中运行，独立HOME/config/XDG，160×50 scripted tmux，synthetic key、受控loopback API，无真实凭据或外部模型流量。

| 场景 | 原始 passed / failed / not covered | 审计结论 |
| --- | --- | --- |
| 五核心：初始化pending、清框、新草稿、reload、watcher | 66 / 0 / 0 | 本轮重新执行，passed |
| Pane 首试 | 10 / 1 / 11 | 旧harness错误期待Button事件对象；官方契约实际`onPress: () => void` |
| Pane 新session契约复测 | 19 / 0 / 3 | 标题、重绘、scroll、resize、Tab focus、关闭和prompt恢复通过；鼠标送达/关闭后鼠标/stale callback lease未覆盖 |
| 官方原件diff，本地inline | 9 / 3 / 3 | Enter后未进入hunks，真实未通过；后续专项确认同id调整高度清除焦点，详见下文；其后reload前置状态不成立，不算独立产品缺陷；builtin ownership缺证据 |
| 官方原件diff，本地fullscreen | 15 / 1 / 0 | 开关、刷新、reload等通过；disable后builtin可见，但内部ownership证据不足 |
| 官方原件diff，本地非Git | 7 / 0 / 0 | passed |
| Store | 8 / 0 / 0 | passed |
| cancel / worker fault / 不重放 | 20 / 0 / 0 | passed |
| 官方六场 | 42 / 0 / 25 | 自然rollout-off，Mods行为parity为not covered；passed仅证明基础readiness/隔离/工具/清理等 |
| 合计原始记录 | **196 / 5 / 42** | 含首试与独立复测，243条记录不是243个去重测试；整体failed |

官方非Git场因gate-off实际执行builtin `/diff`，脚本错误等待Mod文案而超时；不作为官方Mod非Git缺陷。未改官方binary、未绕过账户/组织gate，未将本地运行原件当成官方binary parity。Permission ask/allow/deny和真实provider网络尚未覆盖。所有18场自有CLI/API/tmux/socket/port清理完毕，见 `V/cleanup-audit.json`，最终制品和源码身份不变。

### 确认问题与修复边界

1. **public turn / queued admission真实缺口**：runtime未发布active public turn，提交时queue metadata漏turnId；`processUserInput`未返回settled admission，dequeue重新执行hooks。保留5条原始红测；现已接通public turn登记/释放与提交前快照，core admission后入队再返回`next`，普通dequeue、中途drain及并发onQuery回退均保留settled消息/context。定向最终 `T/pa-final-{0..4}.log` 分别为REPL69、processUserInput44、promptAdapter31、query44、runtime63 pass；另相邻query/peer/keybinding及两个完成的assertion scripts绿，类型检查通过。`T/pa-final-results.json`保留命令与环境，子进程计数不重复加入最终全仓汇总；新binary仍待复验。
2. **无hooks MCP provider fixture缺host注入**：standalone runtime未提供`pluginOrigin`。真实session跨generation测试已通过；修fixture注入相同canonical来源计算，不在runtime里偷偷读全局settings、不取消未知provider错误。
3. **managed merge-only真实缺陷**：最高层只有`managedSourcesBehavior:'merge'`时被过滤，MDM与file未合并。已在过滤内容来源前独立选择模式；仓库外红测 `T/settings-merge-file-probe.ts` / `.log`、repo红测 `T/managed-mode-fix/regression-red.log` 保留。新增边界fixture最初误写schema不接受的`replace`，整合tsc发现后纠正为合法`first-wins`，未扩展schema；最新完整hostOperations复验 `T/ui-settings-green-3.log` 为45 pass / 0 fail，包含mode-only及默认first-wins不受低层merge覆盖。
4. **SSH旧源码正则失配**：命令加载新增UDS等待分支、remote过滤迁入`useReplCommands`、mode变为提交快照。改为执行真实AST提取表达式，并增加React hook对plugin/MCP/Mod三类remote过滤断言，不仅放宽正则。中间失败保留 `T/main-fix-2.log`，定向复验 `T/ssh-behavior-recheck.log` 35/35通过，最终源码仍须重跑。
5. **bootstrap环境失配**：测试mock了axios却被runner的nonessential开关提前跳过。仅该独立复验移除该开关，仍sandbox拒外网、禁telemetry，完整脚本sentinel通过：`T/bootstrap-recheck.json` / `.log`。未改生产代码或断言。
6. **Workflow fixture缺Plan mode配置**：私有持久化session显示启动Agent前报`Plan mode is disabled`，不是未等待；测试只设置AppState，实际gate读取全局settings cache。该缺陷早于Mods基线，现按sibling tests显式设置`planModeAvailable:true`并afterAll恢复cache，未改产品权限gate；完整脚本通过：`T/workflow-fixture-fix.log`、`.json`。
7. **inline diff焦点丢失真实缺陷**：原件先以`focus:true`打开pane，再以同id、省略focus调整rows；本地`openState`错误清除已有焦点。专项真实event顺序、稳定等待对照及六场清理记录在 `/private/tmp/mods-inline-enter-20260917-l8x18ywl/diagnosis.json`；不是Enter时机不足或Button参数错误。repo新测试红测 `T/ui-focus-red-0.log` 为18 pass / 1 fail；删除三行错误清焦点逻辑后，`T/ui-settings-green-{0,1,2}.log` 分别为UI service19、runtimeUi18、ModsPane24 pass。省略focus不夺取已拒绝/释放的焦点，composer/dialog/keyboard限制仍可撤权；未改renderer抢焦点、未改官方原件。新binary的Enter→hunks及Escape仍待复验。

目前修复尚未整合结束，不能将上面定向绿测当最终全仓/新制品通过。后续必须重跑类型、lint、受影响及独立全仓清单、构建与相应终端场景，并在本节前追加最终结论；历史raw证据全部保留。

---

## 当前源码补充：宿主取消与作者契约（整合仍在进行）

本节记录指定 `4fea45f3…` 制品之后的源码验证，不将以下单测/类型结果算作新 CLI 验收。Pane 标题/滚动失败、官方 gating-off 及下方历史 raw evidence 均保留；最终构建、完整官方 diff 功能矩阵、native managed 保护链收口和最终覆盖报告尚未完成。

证据根 `E`：`/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-repair-20260916.aHC2Z1mz`。

| Assertion / 修复 | 修复前或限制 | 当前合格证据 |
| --- | --- | --- |
| FIFO read 不等待 writer | `E/host-operations/fs-boundaries-red.log`：子进程超时退出；原 createReadStream open 等待 writer | POSIX `O_NONBLOCK` + 分块读取 + finally close；`E/integration/host-operations-09.log` 37 pass / 245 expect；Windows FIFO 不适用 |
| fs.exists 不吞参数/生命周期错误 | 同一 red log；空路径额外见 `fs-empty-path-red.log` | 非字符串/空路径拒绝；NUL 等底层 stat 错误 false；abort 拒绝。官方 descriptor `$ut` 为 nonempty string，未自创 NUL TypeError |
| process timeout 为整数毫秒 | `E/integration/process-integer-red-08.log`：1000.5 被错误接受 | `Number.isInteger`，范围 1–600000；host-operations-09 包含该断言 |
| 真正 Worker 调用 fs 中断后停止继续读取 | `E/integration/fs-worker-cancel-red-10.log`：取消后读了 3 块而不是只完成在途 1 块 | runtime hostCall 合并 invocation + activation signal；`E/integration/fs-worker-cancel-qualified-11.log` 57 pass / 310 expect，含 fs/process/原件 diff。mock 只在真实 FileHandle.read 外插 barrier；证明 close、activation 继续、core 零重放，不是纯 adapter 模拟 |
| 本地作者源码按完整目标类型编译并运行 | 初次 `author-target-contract-12.log` 暴露样例误用 generic store.get 与 turn.complete.text；按实际契约修正，不改官方类型 | `E/integration/author-target-contract-14.log` 21 pass / 83 expect（runtimeHost 全文件）；同一 TSX 源码 strict 编译后走真实 loader/Worker、command、Pane callback、prompt context、turn.complete、store、rebind/reload |
| 目标类型合法但本地未支持的调用有准确诊断 | 类型通过不意味着 runtime 支持全部 API | 历史 author-target-contract-14 用 `$.tool.list` 作负向例子；接入真实目录后，当前负向改为 `$.tool.check`，仍要求编译合法、load/reload 准确报告文件/capability并保留旧 activation；`catalog-snapshot-regression-43.log` 包含该变更并通过，不把不支持能力实现为空 |
| store key 边界 | 官方 Worker 拒绝空 key，host 限 256 个 UTF-16 code units；`E/integration/store-key-contract-red-17.log`：本地空 key 错误成功 | get/set/delete 加相同边界，保留 store 原 bytes/锁/格式；`E/integration/store-worker-contract-green-18.log`：60 pass / 352 expect，含实际 Worker 六次拒绝、合法 256 字符、连续两次 dispatch 不撤 activation、core 零重放 |
| store.set 在作者 realm 中 JSON 规范化 | `E/integration/store-json-realm-red-19.log`：真实 Worker 的 Date 跨通用 wire 后成为 `{}`，仅主线程宿主测试未发现 | 只对 host-owned store.set capability 标记 JSON bridge，在 VM 中 stringify/parse 后传纯数据；Date/custom toJSON 正确，toJSON 只一次，无效值不进入另一个插件的 store.set observer。`store-json-realm-qualified-21.log`：145 pass / 870 expect，含 lifecycle/Worker/宿主/官方原件和完整类型样例 |
| store 字符容量、JSON 省略与 key 顺序 | `store-parity-red-26.log`：4 fail，覆盖错误 bytes 限额、嵌套函数拒绝、数字 key 顺序及真实 Worker | 对齐官方 4194304 UTF-16 字符的逻辑对象 JSON 上限、普通 JSON.stringify、Object.keys；保留本地 entries 文件格式/锁/atomic replacement，无数据迁移；`store-parity-qualified-31.log`：146 pass / 890 expect；`store-worker-limit-32.log` 另以真实 Worker 写入约 12 MiB UTF-8 的合法极限数据，验证 overflow 不改旧值和后续恢复（1 pass / 2 expect） |
| store 作者 wrapper 校验顺序 | `store-key-middleware-red-qualified-29.log`：空 key 错误进入三条 observer；早期 red-28 observer 动态注册未被扫描，单独保留、不作根因证明 | host-owned get/set/delete 在 VM 拒绝空 key，长 key仍进入 host；set先JSON规范化再校验key。green-30 的唯一失败是测试误期望无 observer rejection diagnostic；保留三条准确诊断断言后 qualified-31 全过 |
| store.delete absent 是幂等无写操作 | 官方 `mRr` 在 absent 时直接返回；`store-delete-red-34.log` 确认本地误替换文件 inode/mtime | 持锁 read 后用 Map.delete 结果决定是否写，不改锁边界；`store-delete-green-35.log`：64 pass / 379 expect，含完整 host/Worker 原件与作者类型 |
| command.register 描述契约 | `command-description-red-23.log`：纯空白被接受，生产代码还错误拒绝多行 | 改为 trim 后非空但保存原文；`command-description-green-24.log`：75 pass / 288 expect，覆盖 command/adapter/真实 Worker host；新增 description 专项真实 activation 后 `command-description-worker-36.log`：37 pass / 154 expect |
| command.list 作者元数据 | `command-list-red-37.log`：返回内部 name、裸 Settings source、额外 immediate，漏 plugin 身份 | 使用用户可见名字、builtin/plugin/user/mcp 四类来源及当前 activation/manifest 身份；真实 Worker 覆盖 unload→换 owner。`command-list-green-38.log`：79 pass / 298 expect；官方静态 `chunk-s5nh835p.pretty.js:228802–228838` |
| 作者真实工具目录与请求隔离 | `catalog-snapshot-red-41.log`：真实 Worker 的目录调用没有进入能力链 | `catalog-access-qualified-46.log`：2 pass / 11 expect，覆盖并发 request、reload 后旧 lease、无 host 时明确拒绝、withholding；目标 ToolInfo 的必需 `mcp:boolean` 已补，后续整合回归才覆盖最新三字段实现 |
| 描述缓存与显式失效 | `catalog-invalidation-red-48.log`：`ui.invalidate('tool.describe')` 错误拒绝 | `catalog-invalidation-green-49.log`：3 pass / 18 expect；同 generation 共享、显式失效、reload 切换、旧 lease 留旧 cache，不污染基础 API schema cache |
| 模型请求可调用作者目录 | `catalog-query-red-50.log`：缺 request host binding，query 为 model_error | `catalog-query-current-51.log`：1 pass / 7 expect，真实 query + Worker，无 turn lifecycle hooks 也持 snapshot 并恰好释放 |
| batch/streaming 作者目录入口 | `catalog-schedulers-red-52.log`：两套 scheduler 都落回 core 而非真实目录 | `catalog-schedulers-green-53.log`：14 pass / 52 expect；真实 Worker 接入当前 ToolUseContext，原分类、排队、取消、reload lease 回归通过 |
| 无 hooks 的 MCP 插件 provider | `catalog-mcp-provenance-red-54.log`：tool.describe 抛无法解析 provider | 复用准入 effective tier 计算，投影真实 LoadedPlugin，snapshot 捕获 provenance，变更轮换描述 cache；`catalog-mcp-provenance-qualified-56.log`：44 pass / 137 expect。中间 green-55 的 1 fail 是测试误期望 user hook 可改 native sec-default 保护的 managed 描述，保留原日志；qualified 断言实际 provider 为 prepend 且 managed 原描述不变 |
| query 跨迭代目录刷新 | `catalog-query-refresh-red-57.log`：第二次模型请求仍见 InitialCatalog，而非 RefreshedCatalog | `catalog-query-green-58.log` 该新断言通过；全文件仍为 **36 pass / 1 fail / 141 expect**，失败是并行 turn 公共 ID 登记新红测，不能据此宣布 query 全绿 |
| managed 工具保护链 | 红测见 `managed-tool-outer-red-20260917-01.log`、`managed-classic-recheck-red-20260917-06.log`、`managed-mcp-final-red-qualified-20260917-10.log`、`managed-review-cancel-red-20260917-16.log` | agent 交回 `managed-tool-verified-20260917-20-{0..6}.log`：179 pass / 735 expect / 0 skip；真实 Worker、官方 sec-default 原件、两套 scheduler、自然 session。只解除 managed PreToolUse guard；通用 PostToolUse updatedToolOutput、managed-only/strict 全接口保护仍未交付，保留 guard。该结果不是新 binary 或 official parity |
| 官方原件与目标类型身份 | 公开 commit 的 types 与 binary 内嵌 types 的 SHA 不同，不能混用 | `E/integration/official-source-integrity-09.json`：921 文件，0 changed；`official-target-types-08.log`：原件针对完整 binary d.ts、skipLibCheck:false，exit 0；仅类型检查，不是执行官方 tests |

`fs-worker-cancel-green-10.log` 原样保留为 **56 pass / 1 fail**：失败源于真实 slash 入口需要非交互 auth fixture。后续 qualified-11 在相同 sandbox 中只添加 synthetic、无效凭据值，禁止非 loopback 网络，57 项全过；没有读取真实 key 或跳过产品断言。所有计数属于各自运行，重复文件不相加作为 unique tests。

补充检查：`repl-submit-qualified-20.log` 为 56 pass / 197 expect；`settings-qualified-21-{1,2,3}.log` 三个独立进程合计 27 pass / 48 expect。`typecheck-integration-18.log` 保留 Pane 并发编辑时三处缺 `keyElements` 的失败；该接线完成后 `typecheck-integration-22.log` 全仓 tsc exit 0。`store-json-realm-qualified-20.log` 的 144 pass / 1 fail 源于 observer 放在调用者自身，而运行时按 caller 排除规则不回调自身；将 observer 改为独立插件、保持 `writes=1` 断言后 qualified-21 为 145 pass / 0 fail。上述运行不重复相加作为 unique tests。`commands.json` 现已确认 `lint-integration-15`、`lint-integration-21` 均 exit 0，后续定向 `store-command-lint-33` 也 exit 0；它们均非最终冻结源码 lint。`typecheck-integration-30.log` 保留 exit 2：当时新工具保护链测试缺必需的 ToolUseBlock.caller；后续 `typecheck-integration-39.log` 和 `lint-integration-39.log` 均 exit 0。它们证明各自检查时的源码状态，不覆盖旧失败，也不是最终冻结源码检查。

作者回归入口在 `src/services/mods/runtimeHost.test.ts`；环境变量 `CLAUDE_CODE_OFFICIAL_MOD_TYPES` 指向授权取得的完整目标 `.d.ts`，`CLAUDE_CODE_OFFICIAL_MODS_FIXTURE` 指向仓库外完整原件 `mods/`。未配置时相应原件/类型 test 明确 skip，不能计通过；显式配置错误路径则失败。无需安装依赖，没有把许可未确认的官方源码/类型 vendor 进仓库。具体用法和当前 API 支持边界补在 `docs/research/claude-mods.md` 第 15 节。

本轮沿既有 53 项 inventory 的独立进程相邻回归已完成：**53/53 文件通过、89 个 registered tests、34 个 assertion scripts**；证据 `E/integration/adjacent-15-summary.json`、`adjacent-15-results.json`。各脚本按原 completion sentinel 判定，不把零注册测试脚本计为 registered tests。运行期间 `src/components/ModsPane.tsx` 内容变化，故只作中间回归结果，不是最终冻结源码的完整通过证明。Mods 独立进程/LCOV 批次 `mods-16-summary.json` 已结束且 **failed**：32/33 文件通过、745 pass / 2 fail / 0 skip、2827 expect；失败为 `runtimeUi.test.ts` 的程序化 focus 和 scroll，期间 runtime.ts/ui.ts 有源码变化。当前接线以 `ui-host-qualified-25.log` 重新验证为 37 pass / 145 expect，但不重标旧批次、不等同完整 UI 或 tmux 验收。LCOV 只覆盖父进程，Worker/VM/child compiler 不在该覆盖率内；逐文件中间统计另见 `mods-16-coverage-summary.json`，包括 uiRealm 父进程 0/142（它在 Worker 执行，不能据此推断功能未测），classicAdapter 196/403。该批 failed 且源码变化，不能当最终覆盖率合格证明。后续完整批次 `mods-40-summary.json` 同样保留为 **failed**：31/33 文件通过、772 pass / 5 fail / 0 skip、2972 expect。失败分别为 `ui.test.ts` 首次绘制失败后 Pane 状态 1 项，以及 `toolHooks.test.ts` managed synthetic/transformed/denied final review 与 pre-deny short-circuit 4 项；期间 `ui.ts`、`toolHooks.ts` 内容变化。这些是真实未通过断言，不将并发变化作为通过理由；相关模块仍在修复。最终源码稳定后仍须完整重跑、typecheck/lint、新 `make build`、hash 绑定 scripted tmux 和资源收尾。无 commit/push、依赖、CI 或共享配置修改。

---

## 2026-09-17 当前轮次：指定 4fea45f3 产物 scripted tmux 复测（已结束，整体 failed）

**结论先行：旧首次打开 `UI element must be an object` 已在指定产物复测中消失；五核心场景重新执行为 66/66 passed。Pane 的键盘生命周期已走通，但发现标题覆盖/滚动残影，仍为 failed，不是完整生命周期或官方 parity 通过。** 本节是当前结果；后续章节原文保留为历史，包括旧失败、旧产物及当时“进行中/待修”描述，不能覆盖本节的新证据。

### 产物与隔离

- 仓库产物：`/Users/esonhugh/workspace/projects/WebStormProjects/cc/claude-code/built-claude`；实际 `2.1.219 (Claude Code)`；SHA-256 **`4fea45f372e4b8f7a51055d86f06824dccfdd200db63b6275ac58081382a22b4`**；**100069730 bytes**。
- 构建命令 **`make build`**，Makefile `VERSION := 2.1.219`，内部 `CLAUDE_CODE_VERSION=$(VERSION) bun package:binary`。本续验依据用户明确指定的 fresh-build 既有产物，不再次构建或覆盖该 hash；用户提供构建来源，本线程未取得该次独立 build stdout/exit，未伪造构建日志。七次实际运行副本均独立复核同一 SHA。
- 全新证据根：`/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-accept-4fea45f3-20260917.ml4fipiq`。运行文件使用 canonical 等价根 `/private/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-accept-4fea45f3-20260917.ml4fipiq`。
- 固定副本：`/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-accept-4fea45f3-20260917.ml4fipiq/runtime/artifact/built-claude`。为避免真实工作区/凭据副作用，每场在独立 `runtime/<scenario>/workspace` 运行 hash-identical 副本，而非默认仓库 cwd；独立 HOME/config/XDG、`env -i`、synthetic key、loopback API、sandbox、私有 tmux，终端 160×50。loopback 模型 fixture 只要求 Bash 执行有界 `printf CORE_*`，不是外部真实模型结果。
- 不编辑生产代码、仓库测试、依赖或共享配置；无 commit/push/worktree。仅新 evidence/harness 与本文件追加。验收期间其他任务修改了源码，结果只绑定上述产物，不能证明后续源码已被该 binary 验收。

### 场景结果与 tmux 身份

所有 target 均为 `<session>:0.0`、pane **`%0`**；逐场精确 argv、cwd、socket、时间戳、输入、capture 和日志绝对路径见 `evidence-bind.json` 与下述完整报告。

| 场景 | Session | 私有 socket | Runtime / verdict | 结果 |
| --- | --- | --- | --- | --- |
| Pane 首试 | `cc-accept-pane-pane-01` | `/tmp/cc-pane-t3topbkv/s` | stopped / not covered | 严格等待标题超时；未将 cleanup 当成功，保留全部记录 |
| Pane 独立复试 | `cc-accept-pane-pane-02` | `/tmp/cc-pane-eof4wb85/s` | done / failed | 审计后 16 passed / 1 failed / 3 not covered |
| enable pending empty | `cc-accept-pending-empty` | `/tmp/cc-mods-rr-w4omrbie/s` | done / passed | 16/16；完成初始化前清框，工具之后执行一次 |
| enable pending preserve new draft | `cc-accept-pending-draft` | `/tmp/cc-mods-rr-nrebdh40/s` | done / passed | 17/17；`NEW_DRAFT_MUST_SURVIVE` 保留至终态 |
| settings true→false + reload | `cc-accept-settings` | `/tmp/cc-mods-rr-05h6op9x/s` | done / passed | 11/11；真实 `/reload-plugins` 后恢复模块结果 |
| settings true→false native watcher | `cc-accept-watcher` | `/tmp/cc-mods-rr-mr2qxr3k/s` | done / passed | 12/12；ready 早于外部写入，同次 accepted/activation/result，未发送 reload |
| first initialization pending immediate submit | `cc-accept-initial-pending` | `/tmp/cc-mods-rr-xjdske5f/s` | done / passed | 10/10；无故障注入，pending→submit/清框→finished→tool 顺序有时间戳 |

核心五场 **66 条重新执行的 assertions**，未继承历史通过数；每场正常 `/exit=0`，fixture API exit 0。Pane 通过项只使用 `pane-02` 同次运行，不拼接 `pane-01` 的 cleanup callback。

- 完整运行报告与精确命令：`/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-accept-4fea45f3-20260917.ml4fipiq/runtime/report.txt`。
- 逐场结果/身份/绝对证据路径索引：`/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-accept-4fea45f3-20260917.ml4fipiq/runtime/runtime-summary.json`。
- 独立复核：`/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-accept-4fea45f3-20260917.ml4fipiq/independent-runtime-review.json`；七副本 SHA 一致，所有 observed evidence 文件存在。

**实际 Pane 启动命令**（cwd 为同目录 `workspace`，由隔离 `launch.sh` 包装；其他场 argv 仅替换场景路径）：

```sh
./built-claude --dangerously-skip-permissions \
  --plugin-dir /private/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-accept-4fea45f3-20260917.ml4fipiq/runtime/pane-02/workspace/plugin \
  --debug --debug-file /private/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-accept-4fea45f3-20260917.ml4fipiq/runtime/pane-02/debug.log \
  --model claude-sonnet-4-6
```

驱动以 `tmux -S <socket> send-keys -t <target> -l -- <input>` 加独立 `Enter` 提交，并用 `capture-pane` 保存 raw ANSI/history/viewport/process。Pane 精确输入顺序为 `/mods-pane-check` → Enter（increment）→ outer-client SGR mouse → PageDown → PageUp → Tab → Enter（close）→ 同坐标 mouse → literal `PANE_PROMPT_RESTORED`（不提交）→ Ctrl-U（只移除主动探针）→ `/exit`。待初始化场使用 `/plugin disable mods-slice-fixture`、`/plugin enable mods-slice-fixture` 及 `REPAIR_* Run the bounded harmless fixture once; do not read or edit project files.`；完整输入与提交时间均保存在各场 `inputs.json`。

### Pane 生命周期逐项判定

正式证据目录：`/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-accept-4fea45f3-20260917.ml4fipiq/runtime/pane-02`。下表文件名均在此目录，完整绝对引用载于同目录 `audit-verdict.json`。

| 项目 | 判定 | 同次证据与边界 |
| --- | --- | --- |
| 首次打开无 UI element error、tree/body/buttons visible | passed | `04-opened-viewport.txt`、`workspace/pane-render-0.json`、`audit-markers.json`；旧致命错误未出现 |
| Button Enter → callback | passed | `05-increment-enter-input.txt`、`workspace/pane-increment.json`；count 0→1、command 只一次 |
| invalidate/redraw | passed | `workspace/pane-updated.json`、`workspace/pane-render-1.json`、`06-updated-viewport.txt` |
| focus | passed（限定键盘路径） | 初始 increment 获焦点，Tab→Enter 命中 close；`07-focus-close-tab-ansi.txt`、`workspace/pane-closing.json` |
| scroll | passed（仅位移，不包含绘制洁净性） | PageDown 显示 ROW06..13，PageUp 返回按钮；`scroll-down-viewport.txt`、`scroll-up-viewport.txt` |
| close / prompt 恢复 / 正常退出 | passed | `09-closed-viewport.txt`、`11-prompt-editable-viewport.txt`、`15-exited-process.txt`、`exit-code.txt=0`；无强制 CLI cleanup |
| 标题和绘制完整性 | **failed** | render props 中 title 是 `PANE_FIXTURE_TITLE`，首次 viewport 却是 `PANE_BODY_COUNT_0E` 且标题缺失；PageUp 后 `PANE_BODY_COUNT_16` 残留尾字符，不应误认 callback count=16 |
| 真实 mouse click callback | **not covered（已尝试）** | outer `tmux attach` client 的真实 PTY 注入 SGR press/release，x=6,y=19；`mouse-input.json`、`outer-client.json`、`mouse-result.json`。应用 mouse flags 为 `0 0 0 0`，未产生 callback，不能认定事件成功送达应用，也不把 Enter 当鼠标成功 |
| stale callback / retired lease 拒绝与释放 | **not covered** | 无公开 TUI 路径回放序列化旧 drawing handle；源码/Worker 单测只能作单独层级 |
| close 后旧坐标点击不会触发 callback | **not covered** | 原 runner 曾计 passed；审计因关闭前 mouse 送达未成立下调，保留原始 `result.json`，以 `audit-verdict.json` 为准；不能以“没发生”证明 lease 安全 |

首试因标题缺失触发严格等待超时；复试将“tree 可见”和“标题可见”拆开，以独立失败断言保留标题缺陷，**未删除或放宽标题验收来报绿**。重试说明：`/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-accept-4fea45f3-20260917.ml4fipiq/runtime/pane-02-retry-reason.json`。

**原因分级：** 旧快照机制已由历史红态、当前原样绿色重放及本轮 CLI 首次可打开交叉支持。当前 `/Users/esonhugh/workspace/projects/WebStormProjects/cc/claude-code/src/services/mods/ui.ts:230-249` 的 `snapshotPane` 以 tree 就绪约束 visible/focused。新标题/残影缺陷的**现象确认，根因待验证**；当前 `/Users/esonhugh/workspace/projects/WebStormProjects/cc/claude-code/src/components/ModsPane.tsx:574-597` 的固定高度 Box、标题 Text 与 flexGrow ScrollBox 是相关布局位置，但该文件存在并发变更，不能据当前代码直接证明指定 binary 的精确根因。本任务未修生产代码。

### 聚焦自动化与原件/官方边界

- 九文件独立 sandbox 进程 `bun test`：**186 pass / 0 fail / 632 expect calls**，每个真实 child exit 0；包括 `ui`、`ModsPane`、`runtimeUi`、`uiRealm`、`REPL.submit`、`changeDetector`、`settingsSync`、`session`、`commandAdapter`。精确 argv/env/日志/退出码：`/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-accept-4fea45f3-20260917.ml4fipiq/automated/results.json`。
- 旧 `pane-publication-red.test.ts` 原样复制，SHA `403105ecf091dcd197898fff54ae234c10c0993860915129a6d89a58db946a49` 未变，重放为 **2 pass / 0 fail / exit 0**；两个 pending 时 `incomplete=0`，完成后才 visible/tree。日志：`/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-accept-4fea45f3-20260917.ml4fipiq/automated/publication-unchanged-green.log`。这是重复契约，不加进 unique 186 计数；隐藏→可见的独立 tmux resize 路径仍 not covered。
- 自动化期间 `hostOperations.ts`、`ModsPane.tsx`、`ModsPane.test.tsx` 被其他任务修改；`ui.ts` 与发布回归源稳定。以上为**当前源码自动化**，不是精确 build 输入映射；没有把它与 binary 成功合称整个 feature 已通过。全仓 typecheck/lint/release-check 本续验未执行。
- **static scan / 原件完整性**：本轮只重新 hash 核对旧 manifest 的 **835 个官方原件，0 missing / 0 mismatch**；未重新跑依赖扫描或模块。证据：`/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-accept-4fea45f3-20260917.ml4fipiq/original-integrity-recheck.json`。历史 local Worker 原件报告仍在原目录，不继承为本轮 CLI 结果。
- **local author fixture**：本轮 `/mods-pane-check` 和五核心使用独立作者 fixture；不是官方 diff/sec-default 原件，也不是完整作者契约穷尽验证。
- **official runtime**：仍为 **not covered**。指定 `/tmp/claude-mod-research-20260915.mxLjUo/official-2.1.272` 本轮只读复核 SHA `195e24e8e1f9bf46f1eaee72d434a33e18f9f5796f29a6348a00d16c5f8aee75`；不改用仓库旧官方产物、不运行无意义重试、不伪造身份/认证/flags。历史命令 `./official-claude --dangerously-skip-permissions`、session `cc-mods-repair-official-272-b:0.0` 的 gating-off 证据继续有效，位置 `/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-repair-20260916.aHC2Z1mz/runtime-repair/official-272-b/debug.log:101,333`。
- Makefile `download-claude` 仍含不符合命令约束的 `bunx npm` 历史用法，本轮未调用，未改目标/依赖。

### Cleanup、保留项与下一步

- 正式 Pane 和五核心均正常 `/exit=0`、API exit 0，无强制 CLI signal；Pane outer tmux client 在 server shutdown 后退出 1，仅属辅助 client，不是 CLI 失败。
- 首试 `pane-01` cleanup-only interrupt/clear/exit 未形成正常退出，随后仅对已核对身份的本轮 CLI/launcher 发 SIGTERM；不计生命周期通过。
- 七次运行的自有进程均已消失、API 端口均拒绝连接、私有 socket/短目录均移除；evidence、binary 副本、所有失败日志保留。审计：`/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-accept-4fea45f3-20260917.ml4fipiq/runtime/cleanup-audit.json`。
- 产物/并发源码/历史文件保留检查：`/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-accept-4fea45f3-20260917.ml4fipiq/final-source-audit.json`。历史 Pane 失败证据未覆盖，本节以追加方式保留旧报告原文。
- 下一步仅建议：定位 Pane 标题覆盖和滚动残影；建立可证明应用收到的 mouse transport，再测点击与 close 后行为。修复后重新 `make build` 并绑定新 hash，复跑同一 Pane + 五核心矩阵。本轮未覆盖 Escape/resize/fullscreen/Input/Select、真实 stale handle/lease 终端路径、官方模块运行与完整原件 parity，不宣称 full covered。

---

## 2026-09-17 修复轮次（集成验收进行中）

本节对应当前修复任务；下方保留的是 2026-09-16 的历史失败验收，历史通过数、提交记录与旧 binary 不计入当前轮次。当前没有 commit/push，没有修改依赖或共享配置，也没有绕过官方 gating。

- 当前证据根：`/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-repair-20260916.aHC2Z1mz`。
- REPL 提交修复使用草稿代际区分已提交内容和等待 Mods 初始化期间的新输入；settings 修复使用内容 identity 关联 internal write，并让 watcher 与显式 reload 经过同一审批/缓存发布路径。
- 已接入的契约切片包括 command/prompt/turn adapters、有序 `prompt.context`、matcher 跨 Worker 传递、session message projection、host operations；classic 来源分层和独立 Mods Pane 仍在集成验证，不先记为完成。
- `prompt.context` 当前独立进程回归为 27 pass / 0 fail / 111 assertions，证据 `integration/prompt-context-invalid-contract.log`。包含真实 Worker、模型恢复不重复 dispatch、重复 block name 拒绝后保留已完成 inner rewrite；这不是整个 CLI 的验证结果。
- 初轮全仓类型检查、command/prompt ingress 回归曾失败；原始日志保留在 `integration/`，不得用 runner 自身 exit 0 覆盖日志中的真实子命令 exit。最终检查与构建结果待填写。

### 官方 2.1.272 实测边界

使用指定 `/tmp/claude-mod-research-20260915.mxLjUo/official-2.1.272` 的 hash-identical 隔离副本，实际版本为 `2.1.272 (Claude Code)`，SHA-256 为 `195e24e8e1f9bf46f1eaee72d434a33e18f9f5796f29a6348a00d16c5f8aee75`。没有使用仓库根的旧官方 binary 顶替。

在独立 HOME/config、loopback API、synthetic key、telemetry-off 场景，启动和 `/reload-plugins` 均明确记录：

```text
hooks modules not loaded: rollout flag (tengu_plugin_hooks_modules) is off, from the default (GrowthBook is off for this session: a third-party provider, or telemetry opted out)
```

官方读取了 fixture 的 hooks.json，但 reload 为 1 plugin / 0 hooks；未产生 module start markers。因此 **官方模块运行 parity 为 not covered**，不是通过，也不推断真实账户的 rollout 状态。没有伪造员工身份、认证或 feature flag。

- Session：`cc-mods-repair-official-272-b`；target：`cc-mods-repair-official-272-b:0.0`；pane：`%0`。
- 证据：`runtime-repair/official-272-b/debug.log:101,333`、`runtime-repair/official-272-b/reload-official-ready-pane.txt`、`runtime-repair/delivery.txt`。
- 正常 `/exit` 和 fixture API 均 exit 0；私有 tmux server、进程和端口 cleanup 见 `runtime-repair/official-final-audit.json`。
- 隔离产生的 `ps EPERM`、cross-session socket 创建失败及 fresh HOME install-check 报错保留在原始日志中。

### 本地新产物与剩余验收

本轮第一次隔离 `make build` 成功，VERSION `2.1.219`、SHA-256 `1f3c9aa814a927150deabe0122ee491ddb563ebba6b6bd6a7f764a7ca8bead20`、100053218 bytes；证据 `integration/build-integration-01.json`。对应 `local-integrated-a` 三场 scripted tmux 为 **44/44 passed**（pending-empty 16、pending-draft 17、settings 11），API/tool 每轮恰好执行一次，正常 `/exit`，独立资源审计通过。详情 `runtime-repair/local-integrated-a-summary.txt`、`local-integrated-a-audit-v2.json`。

通过仅属于上述 hash-identical 副本，不能继承到后续构建。该构建后仍有生产修改（包括 tool snapshot、UI、settings host provider），最终需重新绑定源码 identity、构建、三场验证。旧 binary SHA `ec447512c2fdeced7daff9b96ce40467a7eb9455e408cbe95b8eacffb564294e` 不计当前证据。

### 2026-09-17 fresh scripted tmux 补验（整体 failed）

本轮重新执行 `make build`，VERSION `2.1.219`，exit 0；产物 `/Users/esonhugh/workspace/projects/WebStormProjects/cc/claude-code/built-claude`，SHA-256 `17e47f632fca4f41c5b6ee9092322bd962173c89ebca050958ce7129eb9d4101`，100069730 bytes。下列结果只绑定该产物，不继承前一轮成功，也不覆盖构建后的源码变更。

- 完整索引：`/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-repair-20260916.aHC2Z1mz/runtime-repair/fresh-20260917/final-summary.json`。
- 构建、精确命令、session/socket、输入、pane、API/debug、exit/cleanup 的逐场索引：`/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-repair-20260916.aHC2Z1mz/runtime-repair/fresh-20260917/report.txt`。
- 独立审计：`/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-repair-20260916.aHC2Z1mz/runtime-repair/fresh-20260917/audit.json`。

| 场景 | Runtime / verdict | 结果与边界 |
| --- | --- | --- |
| enable pending，提交后保持空框 | done / passed | 16 assertions；初始化完成前即清框，工具在完成后只执行一次 |
| enable pending，保留之后输入的新草稿 | done / passed | 17 assertions；新草稿跨初始化完成保留；清草稿退出发生在终态取证之后 |
| disableAllHooks true→false + `/reload-plugins` | done / passed | 11 assertions；真实 reload 后恢复模块包装结果 |
| disableAllHooks true→false，仅 native watcher | done / passed | 12 assertions；ready 早于外部写入，accepted marker 和新 activation 均可追踪；未发送 reload |
| 首次初始化 pending，立即提交 | done / passed | 10 assertions；无故障注入，提交前 unfinished，清框早于初始化完成 |
| 最小作者 `/mods-pane-check` | stopped / failed | 命令已注册并实际进入 `command.run`、`ui.open` 和 Worker render；TUI 抛出 `UI element must be an object` |
| 官方模块运行与官方原件完整 parity | stopped / not covered | 沿用既有 2.1.272 gating-off 证据；本轮未重跑、未等待或绕过 gating |

核心五场共 66 条 assertions passed，CLI 正常 `/exit=0`，API exit 0，无强制 CLI cleanup、遗留进程或监听端口。均由脚本经私有 tmux socket 驱动 hash-identical binary 副本，入口为 `./built-claude --dangerously-skip-permissions`（具体 plugin/debug/model flags 见各场 command.json），独立 HOME/config/XDG、`env -i`、fake key、loopback fixture，并由 sandbox 禁止读取真实 HOME/Keychain、外网连接及原仓库写入。

聚焦 7 个文件按独立进程 `bun test` 重测为 159 pass / 0 fail；另 fs/settings.read 聚焦为 9 pass / 0 fail（25 filtered out，非全文件通过）。首轮 144 pass / 15 fail 原日志保留：11 项缺 fake key，另 4 项发生于 Worker 并发修改窗口，不能全部归因于测试环境。没有将首轮失败重标为通过，也没有将单测通过等同于 Pane 集成通过。

**Pane 确认失败与待修原因：** session `cc-pane-local-pane-b`，target `cc-pane-local-pane-b:0.0`，socket `/tmp/cc-pane-gkusm6tw/s`。原始超时 runner 为 not covered，但用户可见错误明确违反可操作 Pane 断言，因此独立审计判 failed，未改写原始结果。详情 `/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-repair-20260916.aHC2Z1mz/runtime-repair/fresh-20260917/pane-verdict.json`；错误 pane `/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-repair-20260916.aHC2Z1mz/runtime-repair/fresh-20260917/pane-inline/local-pane-b/04-opened-timeout-pane.txt`。

高概率原因链（尚未以修复复测确认）：`/Users/esonhugh/workspace/projects/WebStormProjects/cc/claude-code/src/services/mods/ui.ts:445-486` 在 `await redraw(pane)` 前先发布新可见 pane；`/Users/esonhugh/workspace/projects/WebStormProjects/cc/claude-code/src/screens/REPL.tsx:2983-3003` 仅按 visible/placement 消费；`/Users/esonhugh/workspace/projects/WebStormProjects/cc/claude-code/src/components/ModsPane.tsx:441` 无条件校验尚未生成的 tree。这三个文件在本次原因审计时均与被测 build 输入一致。按钮、重绘、关闭、焦点/提示符恢复和无干预正常退出均为 not covered。两次 Pane 尝试的 interrupt/clear/exit 仅作 cleanup，不能计作正常生命周期通过。首试因 fixture 将能力 `$` 传给 helper 被拒，修正隔离 fixture 后使用全新目录/session 重试，未拼接两次证据。

补充红态已在证据目录直接导入生产 `createModUi` 复现：committed owner 新开 Pane、隐藏 Pane 变为可见，两条路径都向订阅者发布 `visible=true` 且无 tree 的快照，`bun test` 为 0 pass / 2 fail / exit 1。源码 SHA 与被测 build 一致；绘制完成后才出现有效 tree/drawing。测试 `/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-repair-20260916.aHC2Z1mz/runtime-repair/fresh-20260917/pane-publication-red.test.ts`，日志同目录 `pane-publication-red.log`，命令/源码身份同目录 `pane-publication-red.json`。因此“未就绪快照被发布”的机制已确认；其修复能否消除整个 CLI 错误仍需复测。该红态测试仅属自动化补充，隐藏→可见尚无单独 tmux 覆盖。

后续应由既有 Pane 实现任务修复这两条发布路径，补全绿色回归，再重新 `make build`，以全新证据/session 重跑 Pane 完整交互及核心五场。构建后已观察到 worker、commands、hostOperations、runtime 与相关测试的并发变更，当前成功不证明这些变更已通过 binary 验收。此验证分工未编辑生产代码或测试文件；没有 commit/push、依赖、共享配置修改或 worktree。

### 集成回归及原件边界

- `integration/regressions-integration-03.json`：31 个独立进程 test 文件，**694 pass / 0 fail**。这是中间收敛批次，后续生产变更须再验，不能和先前测试重复相加。
- `integration/tool-snapshot-pin-red.log` → `tool-snapshot-pin-green.log`：限定 fixture 为真实注册的 `tool.call` 后保留 4 个失败，生产修复将外层 snapshot 沿唯一执行链传给 classic 边界，随后 toolExecution/toolOrchestration 合跑 20 pass，未放宽 release 或调用次数断言。
- `integration/ui-events-green.log`：106 pass / 0 fail，真实 Worker、loader、environment；`ui.press/input/select` 可注册，但不作为 host noun calls。
- `classic-integration/report.txt`：来源分层和真实 PreToolUse/PostToolUse/PostToolUseFailure wrappers 已接通，managed → modules → non-managed；保留唯一权限 owner、raw/fold 一次消费、context 顺序、MCP falsy 输出。报告中的 toolExecution 5 项失败由后续上述根因修复处理。其他 classic 事件尚未接入，session managed gate 未移除。
- `original-runtime/original-integrity.json`：官方原件 835 个文件与 supplied manifest hash 一致。loader value graph 为 diff 504 modules、sec-default 21 modules；扫描成功不等于完整运行成功。
- `original-runtime/report.txt`：两个原件可在真实 Worker 同时加载。无 builtin 的 host fixture 中，diff 注册命令、session.start 后真实 Git 修改的 fullscreen/dialog hunk、dialog 文件选择与关闭均通过；有 builtin `/diff` 时正确拒绝并返回 core，不作名称 special-case。
- **真实失败**：sec-default `tool.list` 因缺失 `$.settings.read` 同步异常而跳过保护 hook，`sec-events-v3` 为 28/30 checks、exit 1；当前正在补真实只读 provider，不以空 stub 充数。
- **原件条件性失败**：session.start 前已有修改的 dialog 能列文件并选择，但 body 保持 `Loading diff…`，`diff-git-dialog-v3` exit 1。原件 dialog 列表包含 pre-session 文件，而 body loader 默认排除未展开的 pre-session 文件；poststart 对照通过支持此解释。未改原件，不能据此声称官方 binary 有同样 bug。
- **未覆盖/未实现**：telemetry.mark/log 实际 sink、load-time `ui.resolve` 元素表 middleware、REPL builtin diff stand-down、完整 classic managed 链、tool 注册/list 的自然 engine 触发及完整终端 UI parity。原件内置的 telemetry 错误吞咽不算 provider 成功。

---

# 历史报告：2026-09-16 Mods 全面测试

> 结论：本轮测试与证据审计已完成，**整体验收未通过，未达到 `full covered`，官方 parity 未验证**。自动化通过；真实编译产物保留两类异常及未覆盖项。此前验证不计入本轮通过数。
>
> 自动化：**304 registered tests + 34 assertion scripts passed**。可观测 Mods：**97.18% lines / 93.02% functions**。运行时：**14 场、38 条正式断言，24 passed / 3 failed / 11 not covered**。3 条失败对应编辑框清理、配置恢复和受编辑框残留影响的正常退出，不是三类独立缺陷。

## 1. 目标与结论口径

用户要求在提交、推送完成后进行完整测试，并将完整报告写入当前仓库的 `handoff.md`。

本轮分别评估：

1. **已实现切片的契约覆盖**：模块声明、扫描、Worker/VM、普通中间件、能力注入、activation 生命周期、工具权限管线、两个 scheduler 及 CLI 接线。
2. **当前编译产物的运行时覆盖**：真实 tmux 中的 CLI、slash commands、权限审批、嵌套 Agent/Workflow、取消及故障注入。自动化单测或 assistant-side 工具不能替代该类证据。
3. **可测量的代码覆盖率**：仅报告覆盖工具实际采集到的数据，明确 Worker/VM、多进程与编译产物的 instrumentation 边界。
4. **官方兼容性边界**：对应版本、配置与场景的双端行为；不把本地正确性等同于完整官方 parity。

`full covered` 不是预设结论。若存在失败、未执行场景、证据不足或明确未实现的能力，报告必须保留这些项目，不能通过删除分母、跳过测试或混合历史运行宣称 100%。

## 2. 提交与本轮构建

### 已完成的提交、推送

| Commit | 内容 |
| --- | --- |
| `fb7b441` | `feat: add scoped Mods lifecycle and tool middleware` |
| `54695c3` | `fix: honor inline plugin enable and disable settings` |
| `1476236` | `docs: document Mods lifecycle and compatibility validation` |

已通过普通 `git push origin master` 推送，并用 `git ls-remote --heads origin master` 确认远端为 `147623667abe10dabe06ff6850aae3235005cc55`。没有 force push、跳过 hooks 或改写历史。

### 本轮基线

- 日期：2026-09-16。
- 仓库：`/Users/esonhugh/workspace/projects/WebStormProjects/cc/claude-code`。
- 测试基线 HEAD：`147623667abe10dabe06ff6850aae3235005cc55`。
- Makefile VERSION：`2.1.219`。
- Bun：`1.3.14`。
- 构建命令：`make build`；本轮重新执行，exit 0。
- 编译产物：`/Users/esonhugh/workspace/projects/WebStormProjects/cc/claude-code/built-claude`。
- `--version`：`2.1.219 (Claude Code)`。
- SHA-256：`ec447512c2fdeced7daff9b96ce40467a7eb9455e408cbe95b8eacffb564294e`。
- 文件大小：`99954146` bytes；构建产物 `mtime_ns`：`1789524421673000647`（见 `build-metadata.json`）。
- 证据根：`/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-full-20260916.8glhrls5`。

除非另有明确说明，下文证据相对路径均相对此根目录。

基线文件：`baseline.json`、`before-build-status.txt`、`after-build-status.txt`、`build.log`、`build-exit.txt`、`build-metadata.json`、`source-manifest.json`。

`source-manifest.json` 保存三个已提交变更涉及的文件及两份既有设计文档的内容 hash。构建时间、报告和测试输出不作为生产源码 identity 的替代。

## 3. 执行与判定规则

- 自动化和运行时使用各自的新日志；历史 `203 pass`、`41 pass` 及旧 tmux 结果只作背景，不计入本轮统计。
- 运行时各场景串行；每次使用独立配置、HOME/XDG、输入、日志及 tmux 标识，保留终态 pane。
- 使用 loopback 可控 API 与 fake key，不读取或复制真实凭据，不修改系统 managed 配置或共享认证。
- 权限审批场景必须使用受限模式；不能用 `--dangerously-skip-permissions` 下的成功证明 ask/deny。
- 故障注入单独标识；驱动错误与产品失败分别记录，不拼接不同运行的成功片段。
- runtime state：`running | done | failed | stopped`；validation verdict：`passed | running | failed | stopped | not covered`。
- 不支持的功能保留在兼容范围表中；负例拒绝测试通过只证明正确拒绝，不证明该功能已支持。
- 本轮新增测试及本报告不自动再次提交、推送。

## 4. 覆盖矩阵

下表保留执行前定义的全部目标。自动化 ID 对应 `automated/contract-matrix.json`；RT/NC ID 对应 `runtime/assertions.json`。`n/a` 表示该目标仅要求自动化/静态证据，不是 runtime state。**复合目标缺少任何必要部分即保留 `not covered`；已有失败则列 `failed`，同时注明其余缺口。** 单项 passed 只适用于下列明确层级，不升级为整个 CLI 或官方契约通过。

| ID | Subject / predicate | Required evidence | Observed evidence / remaining gap | Runtime / verdict |
| --- | --- | --- | --- | --- |
| M01 | hooks-only、modules-only、共存及配置路径传递 | 自动化 | DECL-01–05，§5.1 | n/a / passed |
| M02 | TS/JS 静态相对导入、源码快照、路径与大小限制 | 自动化、编译产物 | LOAD-01–09 覆盖边界；RT01/03/12/26 证明脱离源码目录加载及拒绝切片 | done / passed |
| M03 | async register 等待、返回值丢弃、每 activation 固定 options | 自动化、编译产物 | ENV-01–02、LIFE-08；RT03/06/13 正常 activation/options；严格 prompt 因果另列 M07/08 | done / passed |
| M04 | 独立 VM、跨环境 callable 与卸载资源归属 | 真实 Worker 自动化 | ENV-03–05、CAP-03–07、CLOCK-02–04；不包括私有 map 全量枚举 | n/a / passed |
| M05 | engine.create add/withhold、禁止 replace、失败恢复 | 自动化 | CAP-01–02、CAP-08 | n/a / passed |
| M06 | plugin.register 准入、能力宿主复核 | 自动化 | CAP-04–08、LIFE-09–10、POL-03 | n/a / passed |
| M07 | 首次 prompt 在 start pending 时提交的因果 barrier | 自动化、真实 CLI | LIFE-02 passed；RT04 缺无故障直接 pending 前置证据 | done / not covered |
| M08 | disable/enable、新 activation 及启用重叠输入 barrier | 自动化、真实 CLI | DECL-05、LIFE-03/05/08；RT05/06 passed、RT08 受控 barrier passed；RT07 无故障证据缺失，RT09 输入未清理 | done / failed |
| M09 | clear 不重新 register/start、conversation binding 更新 | 自动化、真实 CLI | LIFE-02/12/17；RT11 的 clear 前后 starts=1、activation 不变 | done / passed |
| M10 | 源码、依赖、options 热更及手动 reload | 自动化、真实 CLI | LIFE-05–08/11；RT12–14，refresh-a 同场完整切片 | done / passed |
| M11 | 技术失败保旧、拒绝/移除卸旧 | 自动化、真实 CLI | CAP-02、LIFE-05/09；RT14/26 保旧通过；CLI policy refusal/uninstall 尚缺 | done / not covered |
| M12 | 在途 pinned generation、retire、timer/能力资源释放 | 自动化、真实 CLI | CAP-05–07、CLOCK-02–04、LIFE-13–16、SCHED-02/07；RT19 pinned generation passed，NC04 精确退休缺失，GAP-01 保留 | done / not covered |
| M13 | 普通 next、主动两次 next、失败回退不重放 | 自动化、真实工具副作用 | DISP-01–02、TOOL-10；RT15/16 实际追加分别 2/1 次 | done / passed |
| M14 | catch、预算暂停、parent abort、late continuation | 自动化、受控取消 | DISP-02–05、LIFE-14、SCHED-05；RT17/18 catch/取消 passed；完整 CLI budget/late continuation 未执行 | done / not covered |
| M15 | tier、next.to、matcher、origin 与简化 trace | 自动化 | DISP-06–10；不是 full official trace | n/a / passed |
| M16 | 工具输入改写后重新 schema/validate/hooks/permission | 自动化、真实 ask/deny | TOOL-01–05；RT27 classic hooks passed，NC01 真实受限权限审批未执行 | stopped / not covered |
| M17 | 合成/转换/执行后 deny、schema/mapper/消息/持久化 | 自动化、可控 API | TOOL-06–10；CLI 返回转换通过，NC06 完整组合未覆盖 | done / not covered |
| M18 | progress、UUID、contextModifier 与结果归属 | 自动化 | TOOL-06–09 | n/a / passed |
| M19 | 两个 scheduler admission、无 Mods 正常路径 | 自动化 | SCHED-01–07 | n/a / passed |
| M20 | Agent/Workflow 嵌套无死锁、上下文及 generation | 自动化、binary-side 入口 | AGENT-01、SCHED-06；RT21–23 单 Agent/Workflow 到终态 passed；NC05 并发及嵌套换代组合缺失 | done / not covered |
| M21 | Worker 卡死/崩溃、一次恢复、手动恢复、不重放工具 | 自动化、故障注入 | LIFE-18–19；RT20 一次 watchdog 恢复 passed；其他 CLI 崩溃/失败后手动恢复组合未执行 | done / not covered |
| M22 | 信任、disableAllHooks、managed 不支持组合限制 | 自动化、可安全构造的 CLI 负例 | LIFE-01/07、OPT-01–02、POL-01–03；RT24 gate passed、RT25 恢复 failed；NC02/03 managed/trust 未覆盖 | done / failed |
| M23 | shutdown 幂等、watcher 不复活、进程/端口清理 | 自动化、真实 CLI | LIFE-15–17；RT28 全部进程停止 passed；RT29 正常退出 failed，lifecycle-b exit143 | stopped / failed |
| M24 | plugins/tools/hooks/query/shutdown 等回归 | 自动化 | 53 文件清单及 qualified logs，§5.1–5.2 | n/a / passed |
| M25 | 类型、lint、build、diff 及文件身份 | 静态检查、构建与 hash | §2、§5、§8；`automated-evidence-review.json`、`final-delivery-audit.json` | n/a / passed |
| M26 | 官方 2.1.272 对照及差异解释 | 对应版本双端运行 | NC07 本轮没有启动官方；不计历史对照，不声称 gating 实测失败 | stopped / not covered |

M01–M26 为预定义复合目标，不与 95 行自动化契约或 38 条运行时断言相加，也不据此输出一个掩盖不同证据层级的总覆盖率。

## 5. 自动化测试与代码覆盖率

**自动化约定范围：passed。不是全仓、全部 Mods 或官方 parity 的完整通过声明。** 所有计数来自本轮新进程；原失败尝试单独保留，不重标为通过。

### 5.1 合格终态及计数

| 范围 | 最终结果 | Exit | 证据 |
| --- | --- | --- | --- |
| 聚焦 Mods + tool executor/schedulers + plugins | 215 pass / 0 fail / 0 reported skip；483 `expect()` calls，11 files | 0 | `automated/focused-complete.log` |
| 相邻 19 registered suites | 89 pass / 0 fail / 0 reported skip；166 reported `expect()` calls | 各 0 | `automated/regression-inventory.json` |
| 相邻 34 top-level assertion scripts | 34 scripts passed，必须完整 sentinel + exit 0 | 各 0 | 同上逐文件日志 |
| 独立 inline child | 4 pass / 0 fail，36 assertions | 0 | `automated/inline-child.log` |
| 独立 refresh child | 7 pass / 0 fail，57 assertions | 0 | `automated/refresh-child.log` |
| 独立 install-update child | 4 pass / 0 fail，47 assertions | 0 | `automated/install-update-child.log` |
| 独立 SubagentStop child | 11 pass / 0 fail，21 assertions | 0 | `automated/subagent-stop-child.log` |
| 全仓 TypeScript | `bun node_modules/typescript/bin/tsc --noEmit --pretty false` | 0 | `automated/typecheck-complete.log` |
| 全仓 lint，不 fix | `bun run lint` | 0 | `automated/lint-complete.log` |
| non-quiet Mods + 相关生产集成 lint | 0 errors / 16 warnings | 0 | `automated/lint-mods-integration.log` |
| 四个补测文件 lint | 0 errors / 0 warnings | 0 | `automated/supplemental-lint.log` |
| 差异空白检查 | `git diff --check` | 0 | `automated/diff-check.log` |

可直接报告 **304 registered parent-side tests passed（215 + 89），另 34 assertion scripts passed**。独立重跑 child 的 26 passed 不再加入 unique denominator：wrapper 已经证明相关 child 成功。脚本内部没有运行时计数，不将静态 `assert` 调用数冒充执行数。`0 reported skip` 指无 skip 输出且所选测试无 skip 声明；未选套件不是 skip。

全仓 lint 脚本使用 `--quiet`，因此另行 non-quiet 检查。16 个 warnings 全来自与 HEAD 字节一致的既有生产文件：`src/cli/print.ts`（1）、`src/main.tsx`（1）、`src/screens/REPL.tsx`（14）。其中包括 unused vars/args 和 React Hook dependencies；未通过修改生产文件压制。证明见 `automated/lint-warning-provenance.json`。

### 5.2 精确运行入口与隔离

CWD：`/Users/esonhugh/workspace/projects/WebStormProjects/cc/claude-code`。Bun executable：`/opt/homebrew/bin/bun`。最终聚焦命令由 `/usr/bin/sandbox-exec -f <automated/sandbox.sb>` 包装执行：

```sh
bun test src/services/mods \
  src/services/tools/toolExecution.test.ts \
  src/services/tools/toolOrchestration.test.ts \
  src/utils/plugins/pluginModules.test.ts \
  src/utils/plugins/refresh.test.ts \
  --coverage --coverage-reporter=text --coverage-reporter=lcov \
  --coverage-dir=/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-full-20260916.8glhrls5/automated/coverage
```

该命令上限 240 秒，实际 11.638 秒，exit 0。`automated/commands.json` 保存全部 86 次命令的 exact argv、wrapped argv、CWD、allowlisted env、bound、elapsed、真实 exit、timeout 和日志路径；不需从上述示例猜测环境。合格 sandbox SHA-256：`d1f8387a3b2f907db436a6a852d20f5e039a049316f286d12b3cdaedbac0befe`。

每条自动化命令使用新的 HOME/config/XDG/TMPDIR；任务输出测试另指定 `CLAUDE_CODE_TMPDIR` 至该次隔离目录。禁止非 loopback 网络、真实 `/usr/bin/security` 执行和证据根外写入，不继承真实凭据。使用过的 synthetic API key 仅满足已 mock Agent 的 presence 检查，不是实际 provider 认证。修正后的隔离探针见 `automated/sandbox-probe-qualified.log`。其中 46 个最终选定相邻命令使用较早 runner，记录了同一 sandbox 的 wrapped argv，但尚无逐命令 `sandbox_sha256`；不追补或伪造这些历史 hash。独立证据复核见 `automated-evidence-review.json`。

53 个相邻文件覆盖 `services/plugins/pluginOperations`、AgentTool 顶层测试、WorkflowTool 顶层/bundled/compatibility、query、queryContext.customPrompt、execPromptHook、gracefulShutdown.sshResume。每文件新进程，防止 mock/settings/singleton 污染。4 个混合脚本虽使用 `bun test` 却没有注册 cases，仅按 sentinel + exit 计脚本。完整逐文件选择、runner 和最终日志见 `automated/regression-inventory.json`；排除理由见 `automated/regression-exclusions.txt`。

### 5.3 可测代码覆盖率

来源：Bun 1.3.14 text + LCOV，`automated/coverage/lcov.info`；按 LCOV hit/found 计算，不取被动导入的全仓 1209 文件合计作为 Mods 覆盖率。

| 文件（`src/services/mods/`） | Lines hit/found | Lines | Functions hit/found | Functions |
| --- | --- | --- | --- | --- |
| `dispatch.ts` | 342/342 | 100.00% | 34/35 | 97.14% |
| `environment.ts` | 279/280 | 99.64% | 49/55 | 89.09% |
| `loader.ts` | 426/443 | 96.16% | 31/32 | 96.88% |
| `plugins.ts` | 142/142 | 100.00% | 10/10 | 100.00% |
| `runtime.ts` | 371/375 | 98.93% | 100/105 | 95.24% |
| `session.ts` | 255/286 | 89.16% | 39/44 | 88.64% |
| `toolAdapter.ts` | 215/221 | 97.29% | 17/20 | 85.00% |
| **可观测 Mods 合计** | **2030/2089** | **97.18%** | **280/301** | **93.02%** |

- `worker.ts` 在独立 Worker/VM instrumentation 边界外。真实 Worker 行为有测试，但数值不可得，不能写成 0% 或 100%。
- `protocol.ts`、`types.ts` 为 type-only，没有 runtime 分母。
- LCOV 无 `BRDA` 或 `FNDA`，因此 branch coverage 和未调用函数名称不可得；functions 只有 FNF/FNH aggregate，发现分母会受运行中的闭包实例影响。
- child Bun processes 没有与主进程合并；compiled binary 也不在这份 coverage 内。
- line/function coverage 不是契约完成率，更不是全官方兼容率。

逐文件未覆盖行和分析见 `automated/coverage-summary.json`、`automated/coverage-review.txt`。

### 5.4 契约矩阵及最小补测

`automated/contract-matrix.json` 共 95 rows：**84 passed、6 residual gap rows not covered、5 explicit unsupported rows not covered**。每项有 ID、requirement、evidence level、test source/line/name、日志、verdict/reason；区分 scanner、真实 Worker/VM RPC、runtime/session API、完整工具执行器但 controlled permission、真实 scheduler/context factory 和 static source assertion。

矩阵中 `DECL-05.reason` 尚残留一次旧中间计数文字 `213`；这只是说明文本笔误，最终聚焦分母以 `focused-complete.log` 和 `test-summary.json` 的 **215** 为准，不影响 child 单列规则。此处显式勘误，不改写原日志。

新增 12 cases，4 个既有测试文件共 **242 added lines**，未删除或弱化既有断言：

| 文件 | 新增 cases | 内容 |
| --- | --- | --- |
| `src/services/mods/session.test.ts` | 3 | enable 与真实 Worker start 重叠的因果 barrier；声明加载异常可见且显式 retry；managed strict customization 在 Worker 创建前阻止 |
| `src/services/mods/runtime.test.ts` | 5 | reload 中 parent abort 不重放 core 且新版可用；单 options 变化不重启 peer；noun deny/scalar 不进入 provider；initial refusal 清理 candidate nouns/hooks；真实 clock now/after.cancel 跨 reload |
| `src/services/tools/toolExecution.test.ts` | 1 | Mod 改写后 controlled ask 不能伪装成功、不能 Tool.call，最终只有一份 error result |
| `src/services/tools/toolOrchestration.test.ts` | 3 | batch/streaming 取消跳过 queued effects 并释放 snapshot；真实 createSubagentContext 共享 runtime、不继承父 snapshot、独立 abort ownership 且父取消传播 |

可审查补丁：`automated/supplemental-tests.diff`；测试内容身份：`automated/test-source-identity.json`。新增测试未自动提交。

### 5.5 自动化失败与恢复记录

15 次非零退出（含 2 次 bounded timeout，exit -15）全部保留；不是 15 个产品缺陷，亦不将原失败重标为 passed。

| Finding | 原失败/根因 | 合格重跑及边界 |
| --- | --- | --- |
| HARNESS-01 | 初始 `allow network*` 的 local-ip 条件过宽，非 loopback 探针未被拒绝 | 改成 direction-specific outbound remote localhost、inbound/bind local localhost；最终 focus 和 53 回归使用修正规则，原探针失效证据保留 |
| HARNESS-02 | 补测用了不存在的 cache factory、不支持的 inline await spread、把 after handle 当 function | 只修测试表达为既有 factory、`const built = await next(e)`、`timer.cancel()`，并增强 diagnostics 断言 |
| TEST-PREREQ-01 | 4 个 top-level scripts 直接/间接调用 afterAll，`bun FILE` 不满足 runner 要求 | 新进程 `bun test FILE`，仍按完整脚本而非虚构 registered tests 计数 |
| TEST-PREREQ-02 | Claude task output 不遵循普通 TMPDIR；mocked Agent 需要 NODE_ENV=test 和 auth presence，原 gate 等待导致超时 | 仅隔离环境加 CLAUDE_CODE_TMPDIR 与明显 synthetic key，未访问真实账户/网络 |
| TEST-PREREQ-03 | `workflowScriptRuntime.test.ts:376` 在空 settings 下 actual 1 / expected 2：plan 不可用，调用在 permission mode 检查时被拒绝 | 独立 preload 仅写 fresh config `planModeAvailable=true`，不改断言或生产；完整 3818 行脚本 sentinel + exit 0 |

细节和原始失败入口：`automated/discovered-defects.json`、`automated/test-summary.json.failed_attempts_preserved`、`automated/commands.json`。自动化执行断言范围内未确认 Mods 或相邻生产缺陷；这不证明不存在缺陷。

## 6. 当前编译产物运行时验收

**运行时专项已结束，结论为 failed，并保留 not covered。** 正式审计共 38 条断言：**24 passed、3 failed、11 not covered**；14 次场景不是 14 次全部通过。`runtime/runtime-delivery.json` 锁定专项报告及审计文件 hash，`runtime/audit-summary.json` 给出汇总。以下 passed 仅适用于该行命名断言，不把局部成功拼成一条从未完成的整轮流程。

### 全部运行及终态

每行均为一次独立运行。场景根为证据根下 `runtime/<scenario>/`；完整绝对路径、输入、debug/API 和原始 verdict 见 `runtime/scenario-summary.json`。每个 session 为 `cc-full-<scenario>`、target 为 `cc-full-<scenario>:0.0`、pane `%0`，tmux socket name 为 `full-<scenario>`；每个 `audit-cleanup.json` 保存实际 socket 绝对路径。

| Scenario | Runtime state | Audited verdict | CLI / API exit | 范围与资格 |
| --- | --- | --- | --- | --- |
| lifecycle-a | stopped | not covered | 0 / 0 | console 观测准备错误，不能证明初次 pending |
| lifecycle-b | stopped | failed | 143 / 0 | baseline/disable 通过；enable 文本残留，后续序列未执行 |
| faults-a | done | not covered | 0 / 0 | fixture 字段错误，故障分支未触发 |
| nested-a | done | not covered | 0 / 0 | fixture 错误及 Workflow opt-in 缺失 |
| faults-b | stopped | stopped | 0 / 0 | twice/afterthrow/caught 通过；取消后 API 分流错误 |
| recovery-a | done | passed | 0 / 0 | 在途换代、一次 Worker watchdog 独立切片 |
| refresh-a | done | passed | 0 / 0 | clear、helper/options 热更、技术失败保旧、显式 reload |
| nested-b | done | passed | 0 / 0 | binary Agent、单 Agent Workflow 及其终态/UI |
| gates-a | stopped | failed | 0 / 0 | disableAllHooks true 有效，false 未恢复 |
| cancel-api-fix | done | passed | 0 / 0 | 修正 API fixture 后的独立取消切片 |
| reject-a | done | passed | 0 / 0 | unsupported 扫描拒绝并保旧 |
| gates-b | stopped | failed | 0 / 0 | 等 3 秒后仍未恢复，不继续盲重试 |
| hooks-a | done | passed | 0 / 0 | 同场原始记录结构化审计通过；原计数器 failed 保留 |
| overlap-injected | done | failed | 0 / 0 | 受控因果 barrier 通过，编辑框未清；Ctrl-U 后正常退出 |

### 正式 assertion 索引

`runtime/assertions.json` 为正式分母，每行完整记录 `assertion_id/subject/predicate/required_evidence/observed_evidence_paths/runtime_state/validation_verdict/reason_if_not_passed`。下表为便于导航的索引；不能把各场景原始 passed 数相加当作覆盖率。

| IDs | Predicate / evidence boundary | Runtime state | Verdict |
| --- | --- | --- | --- |
| RT01–03 | 本轮 binary/hash、隔离探针、正常 activation | done | passed |
| RT04 | 首 prompt 无异常直接 pending 前置证据 | done | not covered |
| RT05–06 | disable、enable 新 activation | done | passed |
| RT07 | enable 无异常直接 pending 前置证据 | done | not covered |
| RT08 | timer callback 故障诊断下的 enable 因果 barrier | done | passed |
| RT09 | 已执行输入从编辑框清除 | done | failed |
| RT10–14 | Ctrl-U 恢复、clear、源码/options 热更、技术失败保旧 | done | passed |
| RT15–20 | 两次 next、throw 后不重放、catch、Ctrl-C、pinned generation、一次 watchdog | done | passed |
| RT21–23 | 真实 Agent、单 Agent Workflow 到终态及限定 UI | done | passed |
| RT24 | 启动 disableAllHooks=true 阻止 Mods | done | passed |
| RT25 | false + 3 秒 + reload 后恢复 | done | failed |
| RT26–28 | unsupported 拒绝保旧、classic hook 顺序、全部进程/端口收尾 | done | passed |
| RT29 | 每次 CLI 都正常 /exit 0 | stopped | failed |
| NC01–03 | 真实权限 ask/allow/deny、managed、untrusted CLI | stopped | not covered |
| NC04–06 | 精确资源退休、多 Agent/UI、工具结果完整组合 | stopped | not covered |
| NC07–09 | 本轮官方对照、真实 provider、全部 Mods surface | stopped | not covered |

### 6.1 产物、隔离和驱动

runtime 专项线程已在本轮实际调用 `claude-agent-workflow-validation`（2026-09-16T02:08:38.439Z），不是只在报告中提及；使用主线程本轮已构建产物，不重复 build。

各场景复制第 2 节当前 binary 到独立 `runtime/<scenario>/workspace/built-claude`，本轮 SHA-256 一致。`command.json` 保存 CWD/argv、tmux private socket name、session/target 和 160×50 terminal；`environment.json` 保存该自建 fixture 的隔离环境，`script-lock.json` 绑定当次驱动脚本，`snapshot-*.py` 保留历史脚本版本。

已落盘场景的启动 argv 为：

```text
./built-claude --dangerously-skip-permissions --plugin-dir <scenario>/workspace/plugin --debug --debug-file <scenario>/debug.log --model claude-sonnet-4-6
```

这些场景**不能证明真实 ask/deny 审批**。使用 `env -i`、独立 HOME/config/XDG、synthetic key 和 loopback API。每个 `sandbox-probe.json` 实测拒读仓库、拒非 loopback、允许本次 loopback API；`security-stub.json` 对应空 Keychain 桩，未读真实凭据。Worker 的存在由无源码可读的 compiled CLI 真正加载自写 TS/helper fixture 证明，不依赖 parent-side Agent。

**隔离边界不同于自动化**：runtime sandbox 是 `allow default` 加保护路径拒读/拒写，而非全局 evidence-root-only 写入。被测 Workflow 实际创建了场景专属 `/private/tmp/claude-502/-private-var-folders-4h-pgbsmxdx3wj12mb6mkj90gmh0000gp-T-claude-mods-full-20260916-8glhrls5-runtime-nested-b-workspace/workflow-runs/wf_a86fe76a-db3/journal.jsonl`；这是本次 fixture 输出，不应声称所有运行时写入均在证据根内。未因此放宽自动化 sandbox，亦未清理用户其他临时状态。

精确 stdin 与按键见每场景 `inputs.json`、`*-input.txt`；阶段性 pane/process、`api-events.jsonl`、`debug.log` 和 `*-tool-evidence.json` 共同关联唯一 tool ID、结果、end_turn、prompt/exit。场景 wrapper 有 240 秒上限，各 readiness/tool 等待另有较短上限。注意脚本 `run-scenario.py` 对 nonfatal assertion failure 仍可能 exit 0：**只看 driver exit 会漏报失败，必须读取 `result-final.json.validation_verdict` 和所有 assertions。**

### 6.2 已核对的局部合格流程

证据列相对此轮证据根。每行的全量断言与绝对 evidence paths 都在对应 `result-final.json`。

| Flow / consumer | Trigger / binary-side ID | Runtime / verdict | Side-effect checks | Evidence |
| --- | --- | --- | --- | --- |
| clear、helper/options 热更、无效 watcher/显式 reload | `/clear`、编辑自写 helper/options、`/reload-plugins`；`toolu_full_refresh-a_{initial,cleared,source,options,invalid,explicit}` | done / passed，17 条限定断言 | clear activation 不变且 starts=1；helper V2/options O2；无效代码保旧；正常 exit 0 | `runtime/refresh-a/result-final.json`、各 tool-evidence、`cleanup.json` |
| 在途换代及 Worker 无响应恢复 | `RUNTIME_INFLIGHT` / `RUNTIME_DEAD` 等；`toolu_full_recovery-a_{inflight,newgen,dead,recovered}` | done / passed，12 条限定断言 | 旧调用 MOD_V1、新调用 MOD_V2；marker-inflight 和 marker-dead 均一次；同步死循环为故障注入，watchdog 后恢复 | `runtime/recovery-a/result-final.json`、`inflight-side-effects.json`、`dead-side-effects.json`、`debug.log` |
| 父取消后继续下一条工具 | `RUNTIME_CANCEL` → C-c → `RUNTIME_AFTERCANCEL` | done / passed，8 条限定断言 | 取消前已进入 core 的副作用一次；后续工具 MOD_V1；不宣称撤回已执行副作用 | `runtime/cancel-api-fix/result-final.json`、`cancel-side-effects.json`、`aftercancel-tool-evidence.json` |
| 直接 Agent 与 Workflow 内 Agent 工具经过 Mods | `RUNTIME_AGENT` / `RUNTIME_WORKFLOW`；Agent `a436c89d907ff5a5b`；Workflow task `wgad0yb6f` / run `wf_a86fe76a-db3` | done / passed，RT21–23 | 每个 child Bash 结果恰一份 MOD_V1；worker/phase/journal completed，终态 pane、prompt 和 /workflows done 一致；仅该有界单 Agent 流程 | `runtime/nested-b/agent-children.json`、`workflow-children.json`、`audit-debug-markers.json`、`audit-workflow-journal.jsonl`、`terminal-pane.txt`、`workflows-ui-viewport.txt` |
| unsupported capability reload 保旧 | 先正常调用，再将自写 fixture 改为 `$.fs.read` | done / passed，10 条限定断言 | scanner 显式诊断 unsupported core capability，旧 MOD_V1 仍可用；不是 fs 支持 | `runtime/reject-a/result-final.json`、`unsupported-tool-evidence.json`、`debug.log` |

独立查看 nested-b 的真实 Workflow journal：一个 `started` 后一个 `status: completed` result，`toolUseCount: 1`，结果含 MOD_V1 child；`tasks-ui-pane.txt:70–79` 有完成通知及 No tasks currently running，`workflows-ui-pane.txt:82` 有 1/1 agents done。直接 Agent child tool ID 为 `toolu_full_nested-b_child_agent`；Workflow 的 phase 为 `Probe`、agent 为 `agent-1`、child tool ID 为 `toolu_full_nested-b_child_workflow`。这证明该 bounded flow 到终态，不是仅成功启动；但不覆盖全 lifecycle、continuation、clear/reload ownership 或重复通知全部边界。原 journal 的 SHA-256 与记录在根目录 `runtime-workflow-evidence-review.json`。

`/rename mods-nested-fixture`、`/color blue` 成功；`/workflows` 显示 `mods-bounded / Offline bounded probe / 1/1 agent / done / Probe 1/1`，footer 为单条聚合。160 tok、1 tool、0s 来自受控 API，不是实际模型性能；单 agent 不能证明多 agent 聚合不膨胀。独立 `/agents`、运行中 background 列表、并发多 workflow、`/deep-research`、`/code-review` 未覆盖。

上述 5 个 session 均为 `cc-full-<scenario>:0.0`，pane `%0`，由 `/opt/homebrew/bin/tmux -L full-<scenario>` 访问；退出后保留 dead pane。对应 CLI PID 分别为 refresh 64174、recovery 63132、cancel 71238、nested 66789、reject 71799。`cleanup.json` 记录 CLI exit 0 后才停止 API，API exit 0，原端口无 listener；不是靠 kill CLI 才取得成功。各自 `git-hash-comparison.json` 当次全部为 true。

### 6.3 仍未通过或不能扩大结论的尝试

| Attempt | 原 verdict / 观察 | 诊断资格及处理 |
| --- | --- | --- |
| `lifecycle-a` | stopped / failed；等待 `baseline-pending` 超时 | 正常 VM console 不向外报告该 marker，pending 前提未建立，不能算首次 barrier 通过 |
| `lifecycle-b` | stopped / failed；`enabled-terminal` 超时；baseline-barrier not covered | baseline/disable 各自有真实结果，但整轮 enable/clear 序列未取得要求的空 prompt 终态，不能拼接其他场景修饰为整轮成功 |
| `overlap-injected` | done / failed；enable 因果 barrier passed，empty prompt failed | 使用 clock callback 故意抛出 START_PENDING 诊断以观察 pending；输入确在 finished=false 时提交，工具在 start 完成后签发。已执行输入仍留在编辑框，driver 用 C-u 清理后才退出；结合无注入 lifecycle-b 已确认 UI 现象，源码根因仍未确认 |
| `gates-a`、`gates-b` | stopped / failed；disable-all gate 有效，改回 false 后仍 CORE_ALLON | debug 仍显示 disabled/restricted，尚缺 settings change 已被真实消费者接收的证明；不得仅据写入磁盘就确认 Mods 产品缺陷，也不能标恢复 passed |
| `hooks-a` | done / failed；classic-hook-order | 已确认 harness 计数错误：`text.count('PreToolUse') == 1` 会重复统计同一个 JSON record 的 stage/hook_event_name。结构复核为一条 Pre、一条 Post、一个独立 core marker，唯一 tool ID，最终 `POST_MOD REWRITTEN_ORDER`。复核见根目录 `runtime-hooks-evidence-review.json`；不改写原 verdict，也不冒称新合格重跑 |
| `faults-a` | done / failed；twice、cancel、inflight、Worker death 计数失败 | `fixture-original.ts:5` 误用 `e.input.command`，实际契约是顶层 `e.command`；debug:267–268 明确报 undefined。故障分支未按预期执行，是 fixture 错误；后续限定重跑分别保存，不能将整个 faults-a 标 passed |
| `faults-b` | stopped / failed；aftercancel 超时及 Git snapshot 不同 | API 将包含旧 cancel tool_result 和新 aftercancel prompt 的请求优先判为终答，未签发 aftercancel；修正 API 后 cancel-api-fix 才通过。twice/afterthrow/caught 计数局部通过。同期授权测试修改导致 Git snapshot 不同，原 unchanged assertion 仍失败，binary identity 没变 |
| `nested-a` | done / failed；child 存在但无 Mod 输出 | 同样 `e.input.command` fixture 错误，debug:289–290 可见；不是 Agent 没有启动。新独立 nested-b 才取得 MOD_V1 child 结果，原失败保留 |

首次 prompt 及 enable 的无异常直接 pending 前置证明、真实 CLI ask/deny、background/continuation、nested Agent 深层组合、Workflow 全部 task/notification 边界、`/deep-research`、`/code-review`、shutdown 异常路径及本轮 official 2.1.272 对照均未取得完整证据，保留 `not covered`。单 Agent Workflow 的这次 completed 已证明，不把上述组合缺口误写为所有 Workflow 都未完成。

其他准备/审计错误：初始 options 未声明 userConfig 而被过滤，修正仅自写 manifest；首次只读审计误将 duplicate-refused 事件当真实工具签发，后续审计分开实际签发和拒绝事件，原 `audit-driver.log` 保留。默认 marketplace 的外网 clone 被隔离阻断，inline fixture 仍正常加载；该通知不是 Mods 注册失败，但真实 disabled 诊断不可隐藏。

## 7. 失败、未覆盖与兼容限制

**整体验收 failed；`full covered` 未达成。** 自动化通过不能抹去 runtime 失败。以下两类异常未改生产实现，失败仍有效；第三条失败 RT29 是第一类问题的退出影响，不再另算一类根因。

### 7.1 UI：enable 重叠提交后编辑框残留（RT09、RT29）

**复现与观察**：启用自写 plugin，`session.start` 等待约 4 秒；在 enable 仍处理时用 literal + Enter 提交 prompt。API 最终收到真实工具成功结果，但 pane 的编辑框仍保留已执行文本。普通 `lifecycle-b` 和受控 `overlap-injected` 两场均复现。

普通无注入场景的时间记录（epoch ms）：start `1789525211980`，literal `1789525212044.866`，tool issued `1789525216000.077`，result `1789525216039.510`；返回 `starts=1 / finished=true / elapsed=4001 / CORE_ENABLED`。这些事后数据证明处理完成并支持时间重叠，不替代提交前的直接 pending 观测。

- 证据：`runtime/lifecycle-b/audit-enabled-result.json`、`failure-pane.txt`、`cleanup.json`。
- cleanup 的 `/exit` 拼接到残留输入，引发同 scenario 的再次请求；fixture 拒绝二次签发。实际工具签发一次，不能把 `duplicate=true` 记录算作第二次执行，也不能说产品本身保证了不重复提交。该 CLI 最终 SIGTERM/143。
- 受控场景：start `1789526244700` → 直接观测 `finished=false` 于 `1789526244916.163` → literal `1789526244916.810` → Enter `1789526244934.101` → start 完成 `1789526248702` → tool issued `1789526248720.175` → result `1789526248748.640`。RT08 因果排序通过，RT09 空编辑框失败。
- 受控观测由 `clock.after` callback throw 提供，并非 `session.start` 自身抛错；不能替代无异常 barrier 用例。证据：`runtime/overlap-injected/enable-causal-evidence.json`、`enabled-api-completed-pane.txt`。
- **已验证临时恢复**：受控场景用 Ctrl-U 清空编辑框，再 `/exit`，exit 0；不是修复，也不能据此将原断言改为通过。

**根因置信度**：UI 现象确认，具体源码原因未确认。已读 `src/screens/REPL.tsx:4783–4824` 中按提交时 `isLoading` 决定的 `submitsNow` 清理，以及 `:4973–5019` 的异步等待/提交/stash 恢复；`src/utils/handlePromptSubmit.ts:325–399` 在 active 分支 enqueue + clear，非 active 分支直接执行。值得验证“提交快照为 loading、await 后 queryGuard 已 inactive，两个清理路径均未覆盖”的假设，但不能仅凭源码断言 race。下一步应先记录提交与 await 前后 queryGuard/isLoading/input 状态，再建立最小失败回归、修复和重跑。

### 7.2 配置：disableAllHooks false 后未恢复（RT25）

**复现与观察**：以隔离 settings 的 `disableAllHooks=true` 启动，工具仅返回 core；将同一 settings 文件改为 false，等待 3 秒，输入 `/reload-plugins`，再调用工具。`gates-a` 和有额外等待的 `gates-b` 均未恢复；后一场返回 `CORE_ALLON`，debug 仍有 `Mods are disabled by disableAllHooks`。文件确为 false，不等于消费者已收到变更。

- 证据：`runtime/gates-b/config/settings.json`、`driver-events.jsonl`、`allon-tool-evidence.json`、`audit-debug-markers.json`。
- 同时出现的 `Hooks modules are restricted to managed plugins` 不是 managed policy 已被构造或测试通过的证据。
- **根因置信度**：隔离条件下现象确认；native watcher、session cache、路径别名与 OS sandbox 因素尚未区分，没有证明一定是 Mods gate 实现错误。
- 源码定位：`src/main.tsx:3574–3592` 的 gate 读取 `getInitialSettings()`；`src/utils/settings/settings.ts:800–869` 的 session cache/fresh read；`src/utils/settings/changeDetector.ts:103–145` 的 native watch；`src/services/mods/session.ts:208–273` 的 disabled 分支与 refresh 队列。
- 恢复措施尚未取得合格证据。优先观察 settings change 是否发出、cache 是否 invalidated、消费者读到什么；不能仅增加等待或直接绕过生产 gate 来使测试通过。

### 7.3 必需但尚未覆盖的运行时证据

1. **无异常 pending 前置观测**（RT04/07）：需要非故障、只读、提交前的 `finished=false` 证据；现有事后时间或 callback throw 不足。
2. **真实受限权限 ask/allow/deny**（NC01）：本轮全部 CLI 使用 bypass，未执行受限启动。这是本轮执行缺口，不是用户拒绝授权，也不是已实测受限模式不可用。专项报告称其默认 bypass 启动约束冲突；该解释不能替代权限测试。下轮需独立受限 fixture 和真实审批 pane/marker。
3. **managed/trust**（NC02/03）：未完成安全隔离的 compiled CLI 场景；未修改共享组织策略。自动化 gate 通过不证明实际 managed adapter 或不信任 UI。
4. **精确退休及复杂组合**（NC04–06）：timer/capability lease 精确释放，budget pause/late continuation，合成/deny/schema/progress/UUID/persistence 全组合，多 Agent/多 Workflow/嵌套 generation 与运行中列表尚缺。
5. **本轮官方 2.1.272 对照**（NC07）：未启动官方。目标现有制品 `/tmp/claude-mod-research-20260915.mxLjUo/official-2.1.272`，已记录 hash `195e24e8e1f9bf46f1eaee72d434a33e18f9f5796f29a6348a00d16c5f8aee75`；项目根旧 official 是另一版本。专项 agent 因项目根 official 默认路径与目标路径不一致而未执行，没有替换旧 binary。**这不是官方账户/gating 的本轮实测失败，也不是用户禁止目标制品。** 后续需统一允许的目标启动入口，再做同 fixture/配置/终端双端对照；不得用旧版本或历史成功补齐。
6. **真实 provider**（NC08）：本轮只使用 fake key/loopback API，不证明实际认证、外网或模型推理。
7. **完整 Mods surface**（NC09）：属于下列明确 unsupported，不通过“补测试”变成已实现。

本轮停止扩展随机组合与重复尝试，交付确定的失败、证据和缺口；不为制造 100% 而擅自修改生产、降低断言、读取真实凭据或改变共享策略。

### 7.4 自动化残余

- `session.ts:65–76` 默认真实 settings reader、`:85–96` Plugins Errors AppState 发布/清空、`:198–203` watcher error、`:282` 无 declarations refresh callback 未全动态覆盖；session 是数值覆盖最弱文件。
- `runtime.ts:199–200,356–357`、scanner 部分 lexical grammar/解构/default/switch/label、unknown-wire clock 和部分 RPC transport/timeout/observer 单行替代分支仍有遗漏。
- `toolAdapter.ts:141–142,162–165` 的额外 metadata 复核及非 string text block extraction 未覆盖。`dispatch.ts` 的 100% lines 不证明所有 branches。
- `automated/coverage-review.txt:18` 的 `runtime.ts:380–381` 属旧审查注记；最终未覆盖行以 `coverage-summary.json` / LCOV 的 `199,200,356,357` 为准，不把旧注记重复算成未覆盖源码。
- teardown 通过公开行为断言，未枚举所有私有 timer/wait/handle/RPC map 归零；未添加 ForTesting 生产接口。
- controlled permission ask 不是真实 CLI 审批；mocked Agent/Workflow 回归不是模型或 task/runtime parity。runtime 的补充证据必须单列，不改写自动化原矩阵的 scope。
- Worker/VM、child process 和 compiled binary coverage 未合并；精确官方 timer retirement/lease parity 未由自动化证明。

### Explicit unsupported（不是遗漏的已支持功能）

| ID | 当前不支持或不宣称 parity | 测试含义 |
| --- | --- | --- |
| UNSUP-01 | UI/render、turn.step/模型流、remote surfaces | 不计入支持契约完成率 |
| UNSUP-02 | `$.tool.call/register`、动态 command、fs/http/process/env host capabilities | 明确拒绝只证明 gate 正确 |
| UNSUP-03 | dynamic/npm/native imports、任意 globals、glob/复杂 matcher、通用 capability alias | 不能由拒绝用例声称具备执行能力 |
| UNSUP-04 | scalar/多参数 noun、敏感 userConfig、完整官方 trace、registration reentry parity | 当前受限 object 参数及 trace 切片不代表完整协议 |
| UNSUP-05 | full managed Pre/Post adapter、全部官方 Mods、完整官方 developer CLI | 当前保护方式是 gate 不支持的外部 Mod 组合，而非实现全部 managed adapter |

### 明确排除的验证

没有运行 blanket 全仓 `bun test`、真实账户/外网模型、OAuth/browser、真实组织 managed 配置、SSH/remote、live git marketplaces 或未经审查的网络集成。理由是混合 runner、mock 污染和真实副作用风险，不对这些套件的通过率做任何推断。真实账户或组织配置不使用未经授权的凭据或共享环境补齐。当前全部 Mods、全仓和完整官方 parity 的 `full covered` 结论均不成立。

## 8. 工作区及收尾审计

### Git 状态对照（最终复核）

构建前/后均仅有两份既有 untracked 文档，见 `before-build-status.txt` / `after-build-status.txt`：

```text
?? docs/design/cross-session-messaging-implementation.md
?? docs/design/cross-session-messaging.md
```

本轮补测和报告交付时：

```text
 M src/services/mods/runtime.test.ts
 M src/services/mods/session.test.ts
 M src/services/tools/toolExecution.test.ts
 M src/services/tools/toolOrchestration.test.ts
?? docs/design/cross-session-messaging-implementation.md
?? docs/design/cross-session-messaging.md
?? handoff.md
```

`automated-evidence-review.json` 已独立核对 `source-manifest.json` 全部文件：只有上述四份授权测试的内容 hash 变化；生产实现、构建脚本、研究文档、两份既有 design 文档保持一致。补测的最终 hash 与 `automated/test-source-identity.json` 完全一致。当前 binary 仍为 `ec447512…6294e`，与本轮构建一致；修改测试不改变 runtime production source identity。

新增补测及 `handoff.md` 未再次 commit/push；没有新增依赖、修改 CI/shared 配置、创建 worktree，亦未改动原有 design 文档。不检查或宣称所有 ignored 文件完全不变，也不删除用户状态。

### 清理和证据保存

已核对的每个 runtime `cleanup.json` 均把 CLI 终态、API 停止和原端口 listener 状态单列。正常完成和失败后收尾不同：失败场景可能额外提交 `/exit` 或清空残留输入，不能把这些动作隐去写成无中断成功。保留 dead tmux pane、旧失败日志及自写 fixtures 供审计；不清理其他会话进程。

最终独立审计 `final-audit.py` / `final-delivery-audit.json` 已完成：

- 重新核算 304 registered tests、34 scripts、95 行契约、38 条 runtime assertions 和 LCOV aggregate；检查正式断言 evidence 路径、53 个相邻最终日志/sentinel 和全部命令日志存在。
- 核对 `runtime/runtime-delivery.json` 的交付 hash，以及 `runtime/audit-raw-manifest.json` 中 **2379 个原始证据文件**，没有变更。原始 failed 记录未覆盖。
- 14 份场景 binary copy 与源 binary 均为第 2 节 hash；source-manifest 只有四个补测文件改变，测试源码与合格运行时锁定 hash 一致。
- 主线程重新对 14 场的原 CLI/API PID 执行 `/bin/ps`，均已不存在；原 14 个 loopback 端口均拒绝连接；14 个 tmux pane 均 dead 且保留。
- 历史记录确认每个 API 在其 CLI 退出后才停止，场景串行无重叠。13 CLI exit 0，lifecycle-b exit 143；14 API exit 0。**清理成功不是 14 CLI 正常退出通过。**
- `git diff --check` 通过，HEAD 未变；只有四个测试文件的 242 行新增及本报告是本轮仓库改动。原有两份 untracked design 文档保持内容不变。
- 自动化 agent 最终交付消息已结束（`2026-09-16T03:16:17.296Z`）；运行时专项已交付终态。没有待完成的测试进程；遗留的是本文明示的产品失败与覆盖缺口。

`final-delivery-audit.json` 的 `integrity_audit_passed` 仅表示证据、计数和交付完整性检查通过；其 `product_validation_verdict` 仍明确为 failed。该文件锁定本报告最终 hash，不把报告/测试输出纳入 production identity。

## 9. 可审计证据入口

以下绝对根路径均为本机证据；`/var/folders/...` 与 JSON 中部分 `/private/var/folders/...` 是 macOS 同一位置。临时目录不会自动成为 Git 历史的一部分，OS 清理后日志可能丢失；本报告不声称已长期归档或上传。

- **本报告**：`/Users/esonhugh/workspace/projects/WebStormProjects/cc/claude-code/handoff.md`。
- **证据根**：`/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-full-20260916.8glhrls5`。
- **自动化报告**：`/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-full-20260916.8glhrls5/automated/report.txt`。
- **精确命令/计数**：上述 `automated/commands.json`、`automated/test-summary.json`、`automated/regression-inventory.json`；每次失败和每个最终选定文件都有日志链接。
- **契约/覆盖率**：上述 `automated/contract-matrix.json`、`automated/coverage-summary.json`、`automated/coverage/lcov.info`、`automated/coverage-review.txt`。
- **失败分类/排除**：上述 `automated/discovered-defects.json`、`automated/regression-exclusions.txt`。
- **补测及检查**：上述 `automated/supplemental-tests.diff`、`automated/test-source-identity.json`、`automated/lint-warning-provenance.json`、`automated/diff-check.log`。
- **独立审计**：上述根目录 `automated-evidence-review.json`，包含 exact 计数、证据存在性、LCOV aggregate、source/binary hash 检查及两处原报告文字勘误。
- **运行时原始证据**：`/var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mods-full-20260916.8glhrls5/runtime`；按§6场景进入 `result-final.json`、`assertions.json`、`inputs.json`、`command.json`、pane/process、tool evidence、API/debug 与 cleanup。
- **运行时正式总报告/分母**：上述 `runtime/runtime-report.txt`、`runtime/assertions.json`、`runtime/scenario-summary.json`、`runtime/audit-summary.json`、`runtime/runtime-delivery.json`。不得拿各场景原始通过条数替代正式分母。
- **运行时清理/原始身份**：上述 `runtime/cleanup-summary.json`、各场景 `audit-cleanup.json`、`runtime/audit-raw-manifest.json`、`runtime/git-final-audit.json`。
- **主线程最终审计**：上述根目录 `final-audit.py`、`final-delivery-audit.json`；记录审计脚本和本报告 hash、检查结论及每个原 PID/端口/pane 的再次核对。

### 建议的后续验收顺序（本轮未执行）

1. 为 UI 残留补最小回归与异步状态证据，确认根因后修复；正常及重叠提交均须空编辑框、只执行预期次数并正常退出。
2. 建立 settings change → cache invalidation → Mods refresh 的可观测链，区分 sandbox/native watcher 与生产缓存问题，再验证 true → false 恢复。
3. 补无故障 pending 前置证据及受限模式 ask/allow/deny；不能用 bypass 或 callback throw 替代。
4. 统一官方 2.1.272 启动入口后做双端同场景对照；若 gating 不可用，保留实际错误，不绕过。
5. 按精确 timer/lease 退休、Worker 失败后手动恢复、多 Agent/Workflow 换代及 UI 聚合逐项建立有界场景，不用单一 Bash slice 推断所有组合。

结论必须按本文的 scope 和具体 assertion 读取；任何单独的 exit 0、coverage 百分比或 `runtime_state: done` 均不能替代 feature 验收。当前交付是完整测试记录、失败诊断和未覆盖清单，**不是 `100% covered` 或全部通过证明**。
