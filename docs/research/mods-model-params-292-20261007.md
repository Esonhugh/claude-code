# Mods 模型完成参数：官方 2.1.292 对照

本批从 feat/mods@194d243c1c626c33246fe015b6928c5f6e2ff90c 创建私有干净候选，将模型完成的参数、错误和数值边界作为一次相关提交。工作区的现代 fork、取消、调用者链、UI 等既有未提交变更保留。完整 Mods/API/UI/diff/G5 目标仍开放；本报告只证明下列断言。

## 来源与实现范围

2026-10-07 查询[官方 npm latest](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)，仍为 2.1.292，包 shasum ecf88deee4c6b1b099d14a8571f1d5cad2ff1897。使用固定官方 darwin-arm64 原件：SHA256 97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f，235017328 bytes。作者接口参考[Anthropic Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)和本次实际生成的声明；网页当前说明范围不能替代固定原件的 292 运行证据。

证据根 `/private/tmp/mods-model-params-292-20261007-z9lxf0oc`。本地静态读取已提取模块，不执行或上传解包代码：`official-p5t.txt` 保存完成调用校验；`official-model-parser.json` 保存 Pt（chunk-r1spqfr8.js / 375376）、nA、Eu、Vr 的 hash/位置/窗口；两个 `*.thinking.json` 保存 ACe/nye 及 p2/Hc/qy/Wuo 的来源、能力开关和第一方 fallback。

变更：形状检查先于 maxTokens、timeoutMs、effort，之后解析模型、判断允许列表，再检查输出 cap。使用 Number.isInteger，保留实际输入值、原模型/解析模型及 HooksError；生产完成服务绑定调用插件名，分类的内部完成同样保留该名称。空字符串、空白和常用别名交给已有解析器。允许列表检查去掉 `[1m]`，没有改写全局解析器或允许列表实现。

未知第一方模型保留 2048 thinking 余量；已知允许禁用的模型优先，能力精确/前缀规则按顺序覆盖，最后采用本地已实现 provider 的 fallback。通用 VM/Worker 数值协议显式传递 NaN、Infinity、-Infinity，避免 JSON 把它们变成 null 或提前拒绝；UI props 的有限数值检查未改。各 API 自己的类型/数值检查仍执行。新回归覆盖宿主输入、guest 改写、next/host-function 的参数和回执，以及 stream chunk/终值。

## Assertions

| ID | Subject / predicate | Required / observed evidence | Runtime | Verdict |
| --- | --- | --- | --- | --- |
| MP-1 | 参数顺序、原值、整数/cap/deadline 和错误名称正确 | 原 RED + modelValidation/modelOptions + 三组原生完整回执；`validation-red`、`thinking-red`、`transport-suffix-red`、`native-comparison.json` | done | passed |
| MP-2 | 初始 shape 在 Hook 前拒绝，最终改写 shape 在核心拒绝；deny 带调用插件，不透明值保留 | Worker 回归、初始/final shape、deny、17/NaN/-Infinity 及分类 opaque value 原生回执 | done | passed |
| MP-3 | 空/空白/trim、sonnet/haiku/opus/sonnet[1m] 与允许列表使用正确请求模型 | 明确固定 default model env；formal2/allowlist2 的完整 Hook 与投影 HTTP | done | passed（仅这些模型/设置） |
| MP-4 | 未知第一方模型、能力开关和 thinking 余量正确 | Wuo/ACe 静态来源；七个能力规则回归；formal2/caps2 的实际 max_tokens/thinking | done | passed（原生为全局及精确覆盖，前缀为自动化） |
| MP-5 | 四个非有限非法模型数值先到 Hook，再由核心给出准确错误；Hook 可修复/返回非有限值 | numberTransport/modelValidation；原生 requestedNonFinite/timeoutNonFinite 及 isNonFinite 回执；三个共享 codec 窄补丁 | done | passed |
| MP-6 | 生成作者类型保持严格，JavaScript 值不扩大 typed result | 三侧实际生成声明，strict/noEmit/skipLibCheck=false；7 个拒绝正反例，`author-type-comparison-final2.json` | n/a | passed（本批接口 fixture） |
| MP-7 | 代码检查与制品来自最终源码，测试不需要真实 key | suite4/check3/build3 的共同 source SHA、无超时/exit0；八个新 HOME/config 逐文件进程 | done | passed |
| MP-8 | 原生输入/Hook/回执和比较范围的请求相等，正常退出、无会话/配置污染 | 9 场独立 tmux/HOME/config、相同 driver SHA、exit0、server/HTTP stopped、fixture/binary unchanged；`native-comparison.json` | done | passed |
| MP-9 | 关键请求诊断正确，生产新增 header 不包含正文 | 六份日志 header 与 HTTP 数量对应，模型/请求上限/cap/thinking/钳制 deadline；`debug-log-validation.json` | done | passed |
| MP-10 | 非本批文件、共享原件及其他 Claude 工作保留；仅候选补丁签名提交 | before/preimages、preservation-final、commit-plan/precommit/commit-verification；原外部文件作为资料保留 | n/a | 提交后由独立验证记录确认 |

## 验证命令与结果

所有 runner 使用新 HOME/CLAUDE_CONFIG_DIR/XDG/TMP、不继承 API key，调用 `bun test --no-env-file`；每次运行的具体环境、文件列表、命令、log、PID/PGID/source hash 保存于目录。原生只使用自有 localhost HTTP、伪造 key 和严格网络/Keychain sandbox；没有实际 provider 请求。

| Layer | Command / result | Evidence |
| --- | --- | --- |
| L0 | scoped source/diff/调用链与静态原件，候选 `git diff --check` | `official-*.json`、`*.thinking.json`、candidate.patch 和 root-own-diff-*.patch |
| L1 | candidate suite4：462 pass / 0 fail / 5 原有 skip，1875 expect，15 文件，28.185s | candidate-suite4 |
| L1 | workspace suite4：495 pass / 0 fail / 5 原有 skip，2001 expect，16 文件，30.428s | workspace-suite4（含取消 WIP 相邻测试） |
| L1 | Validation 42、Adapter 11、numberTransport 3；Runtime candidate 8 / ROOT 9；八场逐文件新配置进程均 exit0 | *-isolated-final-*/result.json、*-isolated-final-summary.json |
| L2 | 双方 `make release-check` exit0，40.237s / 42.127s；TypeScript、lint、changelog、missing audit、diff check | candidate-check3、workspace-check3 |
| L2 | `bun /private/tmp/mods-model-params-292-20261007-z9lxf0oc/check-author-types-final.mjs` exit0，三侧零诊断 | author-type-comparison-final2.json |
| L3 | 双方 `make build CLAUDE_CODE_BUILD_DIR=<各自私有目录>` exit0，3.527s / 3.59s | candidate-build3、workspace-build3 |
| L4 | 三侧 --version exit0；本地版本 2.1.280，未声明本地完整版本升级到 292 | binary-versions.json |
| L5/L6 | `python3 /private/tmp/mods-model-params-292-20261007-z9lxf0oc/run-native.py`；三侧 × formal2/caps2/allowlist2，9 场均正常 /exit 0 | native-*/evidence/result.json、literal hex/input/pane/ANSI/cursor/debug/wire |
| L6 | `python3 /private/tmp/mods-model-params-292-20261007-z9lxf0oc/compare-native.py` exit0 | native-comparison.json；完整输入、全部回执、frozen/origin Hook 和投影请求一致 |

候选 source SHA `ca19e287e7e4b2bd4be14976baa5a69717d6c9a194b76d9560fafe3c72022b6c`，binary SHA `502db380a737bd9d2aa13302c5b8ff0fe0f28d2bf4ff6e9098961296134bd371`（102150242 bytes）；ROOT source SHA `8c92bccd1761095fc480389d8a3191c3f641be642285d5dafa4191482f5bdb6f`，binary SHA `c6837f8f621cbfd27c0fcce06a7f131fa7ed9c12915e725a260aa6a57e651f43`（102034658 bytes）。各 runner 都确认源码没在运行中变化。后续修改的报告和 mods-test 是非嵌入文档，CHANGELOG 在构建前固定。二进制 mtime 与绝对路径见 binary-versions.json；两个共享根二进制没有覆盖。

三组每侧均 50 个回执、42 个 complete Hook、2 个 classify Hook；formal2/caps2 每侧 12 个 HTTP，allowlist2 每侧 6 个 HTTP。比较完整作者事件与调用 origin、所有字面 stdin 及全部回执。请求投影比较 model/max_tokens/messages/thinking/output_config/tools/tool_choice/temperature/stop_sequences 和作者 system；先验证 billing attribution 前缀再去掉此版本相关字段，metadata 也不比较，不声称全请求 body 字节相等。超长 timer 从实际请求判断仍可完成，钳制及成功清理另有聚焦自动化。

## 失败保留与限制

- 首次私有准备中的只读 ps 被 sandbox 拒绝；候选和冻结记录已建立，随后授权只读查询确认两个既有 Claude PID/启动身份，未向它们输入或发送信号。
- native-official-baseline1 的 owner 夹具把 $ 传给 helper，违反官方静态调用规则，模块未加载；正常 exit0。保存完整失败与 driver；改为 hook 内直接 switch 调用，baseline2 46 回执正常。
- 原生产 + 新参数回归：4 pass / 27 fail；参数修复后未知模型请求余量 RED：31 / 3；数值传递和上下文后缀 RED：40 / 5。保留原日志，未删除或弱化断言。
- formal1/caps1/allowlist1 均正常退出但首轮比较失败：本地四个非有限请求缺少 Hook，返回 Non-finite module value；allowlist1 还误拒绝 sonnet[1m]。修复 codec 与 scoped allowlist 后新建全部 final2 会话；原失败未回写为绿。
- check2 揭示候选旧 ModNext 与 ROOT 泛型/ModStreamNext 定义不一致。测试的正常 next 改为 async；流夹具在旧定义边界标注兼容 cast，生产类型未掺入 WIP，数值断言未变。保存原 numberTransport-type-failure.ts 和双侧 compiler 日志；check3 通过。
- 本批没有完整验证全局模型解析器的所有 aliases、重映射、重复/内部 [1m]、动态/served catalog、所有 model capability/provider/认证/API 错误类别。支持其他 provider 的 fallback 仅保留本地已实现路径，未宣称官方全部新 provider 已实现。
- 完整父取消/调用链、fork、未类型化 options/特殊对象/所有边界、其他 API/UI/官方 diff 的完整样式/焦点/窄屏/主题矩阵、G5 与全量 HEAD/工作区 release gates 仍开放。共享 numeric codec 的真实模型 Hook 已验证，其他 API 各自的非有限数值语义没有逐一进行原生对照。
- 外部 response.md / fix-instructions.md / improvment.md 保留原内容作为待办与证据，用户明确的分批提交授权优先；没有将其中的条件当作新的用户指令。

## Git 边界

初始 HEAD 194d243，ROOT index 空。验证前后 status 保存在 before.json/precommit/commit-verification；仅 14 个候选路径允许进入提交。11 个已有 owned 文件有原 ROOT preimage，另外 3140 个原文件的 SHA/大小/mtime 保持不变，包括共享原件和外部 response.md；现代 fork 实现另按完整函数体确认未改。实际暂存、签名和提交后精确 blob/路径/工作区保留由 commit-verification.json 确认，不推送。
