# Mods 收口测试方案与验收记录

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
| 新 binary scripted tmux | 补验确认部分 diff 控件失败；inline Enter、详情滚动和两级 Escape、fullscreen 鼠标 row/边缘按钮分别通过；命令/UI 补验13条限定断言通过。全矩阵仍待独立审计，不汇总为全绿 |
| 最终提交与 push | pending，只有满足上述门禁才执行 |

### 7.1 首轮失败与补验边界

- **Peer，environment-blocked：** 三项真实进程身份断言未通过。sandbox 拒绝执行 setuid `/bin/ps`；字节一致、移除 setuid 的私有副本又被 OS 终止，未取得可安全使用的替代路径。没有放开凭据/网络隔离、伪造 `procStart` 或弱化断言。证据 `precommit/peer-process-identity-probe.json`、`precommit/peer-nonsetuid-ps-probe.json`、`automated/diagnostics/process-identity-analysis.json`。
- **SSH，测试同步缺陷：** 首轮 `isReady=false` 是真实顶层失败，不是footer/JUnit计数噪音。初次 `ef1f440` 使用Ink `pause()/resume()`仍在后续完整批次重现。受控Scheduler随后确认callback已安装并执行，但默认优先级state未提交；`d9a28d1` 改为awaited React `act`并显式验证callbacks，原61断言保留、增4断言，清理和环境恢复在finally。两个自然261文件批次均观察到SSH完成标记、无顶层Unhandled；这不反推原未插桩失败一定是同一分支。原证据 `ssh-readiness/` 与 `ssh-readiness-final/` 均保留。
- **Workflow command-runner，新失败未定因：** `ssh-readiness-final/runs/full-b/raw.log:1877` 的 `runCommand.test.ts:6` 在5007.93ms达到5000ms testcase timeout，full-a同例23.25ms通过。不能用前一轮成功覆盖，不能未经证据归因为系统忙或SSH改动。限定诊断写入 `workflow-timeout-diagnosis/`，不改生产、延长timeout或放宽断言，推送继续阻塞。
- **SSH ControlPath，既有长 TMP 限制未修复：** `automated-ssh-final/` 的长 evidence 路径被用作 TMPDIR，生成111/112字节的ControlPath，违反现有 `<104` 断言；同进程和独立完整批次均真实失败。有界对照128/105字节失败、98字节通过，说明触发条件为路径长度。生产和测试内容与本轮起始基线完全一致，未归因于Mods，也不扩展本轮SSH开发范围。新完整批次使用独立短TMP，不能据此宣称任意长TMP已支持。证据 `automated-ssh-final/ssh-controlpath-diagnosis.json`、`controlpath-main-review.json`。
- **同进程脚本资格：** 长TMP批次有105个静态完成sentinel；`nativeInstaller/download.test.ts` 没有独立完成标记，不能仅凭其无错误认定脚本全部异步工作结束。逐文件 awaited-import sentinel 完成，只证明独立批次，不反向覆盖同进程边界；见 `automated-ssh-final/raw-junit-audit.json`。
- **PTY，历史失败本轮未重现：** 首轮独立和同进程均通过，额外有界重放9 pass / 0 fail；长TMP新完整两模式也未复现，独立文件9/0。不将“未重现”称为根因已修复。

### 7.2 首轮构建与覆盖率身份

- 构建 commit：`be36848e600d41a2cb7da9cedec9f422d47504a7`；binary 为 `2.1.219 (Claude Code)`，100102754 bytes，SHA-256 `781fa13125c9cb2da9153c38ae260a662424cb002c50e4605d3944bf8179115a`，见 `build/artifact-lock.json`。
- 后续 `ef1f440` 仅改变 SSH 测试，未改变生产代码、构建脚本或内嵌 CHANGELOG；该测试不在 CLI source map 中，见 `build/ssh-test-content-continuity.json`。这允许继续使用锁定制品验收，不意味着最终 CHANGELOG 回填也不影响 binary。
- 首轮 53 份 LCOV 的父进程源码行并集为 60345/260451（23.17%）；Mods 为 5079/5813（87.37%），19 个已插桩生产文件。`protocol.ts`、`types.ts`、`worker.ts` 未出现于父 LCOV，Worker/VM/child/compiled 不在此覆盖率内。失败运行的执行行可贡献覆盖率，不能贡献通过资格；见 `automated/final/coverage-summary.json`。

### 7.3 交互补验：已确认结果与限制

以下仅是已完成的限定场景，最终去重矩阵和全部清理仍待独立审计。使用首轮锁定 binary `781fa131…`，不冒充最终文档回填后的制品。

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
