# Mods model.fork 与父轮次取消：官方 2.1.292 对照（2026-10-07）

## 范围与证据来源

本批以官方 2.1.292 原生制品为固定基线。官方 SHA-256 为 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`；本地 Makefile 版本仍为 2.1.280。验证并不改变共享 built-claude、官方制品、用户配置或其他 Claude 进程。

本地证据根：`/private/tmp/mods-model-parent-292-20261007-n6ii9a84`。脚本、隔离 HOME/config、原始 stdin、tmux ANSI/文本 capture、debug、HTTP 请求及清理记录均保留在该目录。没有上传解包源码、完整请求体或日志。

Source-confirmed：静态提取的 `chunk-pwkr374y.js` 中 b5t/S5t/g5t/rN：fork 使用主会话快照，先判断 nothing-to-fork；裁剪连续尾部 assistant 的 tool_use，保留其他历史；采用 hook_prompt、plugin_model_fork、maxTurns=2、skipTranscript/skipCacheWrite 与工具拒绝回调；文本块换行连接并 trim，按取消、非空回复、最后一条 API 错误、空回复的顺序结算。提取窗口位于 `official-fork-core.json`、`official-model-functions.json`。作者 facade 的 fork 为直接 host 调用，没有公开的局部 signal options。

Runtime-observed：`native-parent-final2.py` 以同一 160×40 终端、假 API key、本机 HTTP、两枚自有插件和隔离配置串行运行 official o6、candidate c4、workspace w3。12 个场景包括三种正常调用、三种 HTTP 中取消、三种 hook 中取消，以及 fork 空回复、529 和真实 Bash tool_use 拒绝。受控 API 是协议测试夹具，不代表线上账户/真实模型回答；[Anthropic Streaming 文档](https://platform.claude.com/docs/en/build-with-claude/streaming) 允许 message_delta 只携带 output_tokens。本批保持原始部分字段，不修改夹具让数字看起来一致。

## 实现与类型

- 内部 ModModelForkResult 对齐作者声明中的判别联合，去掉旧 null/text-only 结果；AssistantMessage 和 NormalizedAssistantMessage 增加 apiErrorStatus。错误转换保留 HTTP 状态，并将未分类的 5xx 标为 server_error，fork 不返回私有错误正文。
- 模型 Worker 桥接区分 complete/fork/classify：父流取消时保留 pending 模型调用以等待核心结算；普通 complete/fork 回执及 usage 可修改。局部 complete.signal 仍由已有作者 wrapper 使用共享冻结取消回执。
- 模型分发保留原始父取消原因、提供 5 秒有界结算并传播核心分类错误；不把 hook 取消转成成功回执。turn.step 的字符串原因在边界成为 HooksError；finally 可记录日志，关闭流时先观察被打断的 pull。
- 未改写 turn.step usage 时保留原始 message_delta 字段。候选提交沿用 HEAD forkedAgent 的 delta 累加；工作区在其既有累加实现之上仅为 plugin_model_fork 选用该官方口径，其他 WIP 消费者保留原路径。这项工作区集成，以及两个既有 WIP 测试适配，保留在未暂存改动中；提交严格来自私有 HEAD 候选。
- 新 debug 仅记录 fork 耗时、回复数、取消状态和 HTTP 状态，不增加 prompt、私有错误正文或取消原因的输出。

## Assertions

| ID | Subject / predicate | 必要及实际证据 | Runtime | Verdict |
|---|---|---|---|---|
| PF-1 | 冷结果、尾部裁剪、两轮与权限回调、结果顺序匹配官方 | 静态窗口；modelFork292、modelAdapter/modelRuntime；原生 fork 成功/空/529/tool | done | passed |
| PF-2 | complete/fork 核心取消返回可修改 aborted；classify 抛出准确插件诊断 | modelParent292 官方夹具；三侧 HTTP 取消回执及 usage/frozen 字段 | done | passed |
| PF-3 | hook 取消拒绝为 HooksError user-cancel，保留 next.signal.reason 和 finally 日志 | 三种模型 hook 各一场；原始 debug 与精确回执比较 | done | passed |
| PF-4 | 工具尝试被拒绝且两轮正确结算，无实际文件写入 | 三侧 side-fork-tool-done 均两次 API 调用；请求内 tool_result；deniedToolFileAbsent | done | passed |
| PF-5 | 取消后恢复输入，正常退出，无日志丢弃和自有进程/HTTP 线程遗留 | 6 个取消后的恢复、/exit 0、清理记录、droppedWarnings=[] | done | passed |
| PF-6 | 原始部分 delta usage 保留；改写计数仍生效 | turnStepUsage292 两分支；原生 fork usage 与官方相同 | done | passed |
| PF-7 | 作者类型与三侧实际生成声明匹配 | strict/noEmit/no skipLibCheck；6 个预期类型错误，零诊断 | n/a | passed |
| PF-8 | 相邻 Worker/runtime/UI/分发用例通过；新源码构建和仓库检查成功 | candidate 645 pass / 0 fail / 5 skip / 24 文件；ROOT 681 / 0 / 5 / 25 文件；下表 | done | passed |
| PF-9a | 完整上下文 messageCount 一致 | 原始 parent-enter 存在计数差异 | done | failed / 继续处理 |
| PF-9b | 完整请求体、全部 API/UI/diff/G5 对齐 | 完整矩阵尚未覆盖 | n/a | not covered |

## 本轮检查与制品

| 源码 | 证据目录 / 精确命令见 start.json | 结果 | source SHA-256 |
|---|---|---|---|
| candidate | `candidate-suite3` | exit 0，63.736 秒 | `5c8770f1bdfec81d3b3764f95c2ee6a771bde0369efb80910f0e086c2c71978f` |
| candidate | `candidate-check5` | exit 0，44.48 秒 | `5c8770f1bdfec81d3b3764f95c2ee6a771bde0369efb80910f0e086c2c71978f` |
| candidate | `candidate-build7` | exit 0，5.337 秒 | `5c8770f1bdfec81d3b3764f95c2ee6a771bde0369efb80910f0e086c2c71978f` |
| workspace | `workspace-suite3` | exit 0，65.939 秒 | `6bbf93ef6880926637897200f8ea501a673f5ba4e78a4f7949dd00a7086d660d` |
| workspace | `workspace-check5` | exit 0，45.318 秒 | `6bbf93ef6880926637897200f8ea501a673f5ba4e78a4f7949dd00a7086d660d` |
| workspace | `workspace-build6` | exit 0，5.519 秒 | `6bbf93ef6880926637897200f8ea501a673f5ba4e78a4f7949dd00a7086d660d` |

`run-suite.py` 从 suite-files.json 显式选择相关文件；ROOT 额外包含既有 modelCancellation.test。5 个已有 skip 不计通过。`run.py` 使用 bun test --no-env-file、make release-check 和 make build CLAUDE_CODE_BUILD_DIR=<私有目录>，保存前后源码 manifest，检查执行退出及自有进程组清理。

三侧原始插件夹具文件均未变；每侧仅新增12个预期作者声明/tsconfig产物（比较器验证精确路径集合）。三侧模型结果、hook 输入/来源、冻结标志、错误、finally 和取消原因的 55 条回执全部相同；每侧共 67 条日志（额外 12 条 parent-enter）。native-comparison.json 保留具体统计、制品 hash、相同 stdin/插件文件和 messageCount 的原始差异。每侧工具验证文件均不存在，正常 /exit 0；自有 tmux server、HTTP 和请求线程都已停止。

## 保留的失败与修正依据

- 基线 candidate c1/ROOT w1 原生执行完成，但取消结果、冻结标志和原因不匹配官方；不是通过证据。
- candidate-red1 为 0 pass / 7 fail；初期测试的日志服务名与流关闭问题在 green1/green2 保留。后续 stream 回归通过，没有删除现有断言。
- 初期 check1/check2 分别发现缺失 apiErrorStatus 定义、HttpResponseError 导入、生成器 lint 与测试类型；原日志保留。
- candidate c2 的恢复 barrier 失败：实际请求中含取消前和恢复后的两段 user 文本，模拟服务错误地取第一段。o4/o5 的 Escape 尝试分别触发换行及清空输入，作为失败证据保留；正式 final2 驱动保留原始输入，仅在模拟服务按最后一个标记选择响应，并提供 Enter 的解析间隔。没有将不同重试的成功片段拼接。
- candidate c3/ROOT w2 12 场景退出正常，但 fork 529 分类仍为 unknown；最终分类修复后仅 o6/c4/w3 用于完整回执通过判定。
- ROOT suite1 三条旧 fork 测试使用空对象假快照和不观察信号的永不结算 runner。修正为合法快照、协作取消及实际 API 错误消息；文本/用量/冷结果断言保留，最终 suite3 全部通过。

## 仍未关闭

完整 HTTP 请求体未宣称相同；parent-enter 的 messageCount 存在实际差异，表明会话上下文映射仍需对齐。所有原始请求保留，不能通过忽略该字段来判完整兼容。

本批没有重跑全量变更门禁、线上模型、所有任意 hook 返回值/请求边界、所有 Agent/Workflow 入口、完整 UI/diff 最新资产迁移或 G5 的 logical/physical 帧矩阵。旧 response.md 的 146/155 与九项失败是历史快照，不能被本批相关套件替代；improvment.md、fix-instructions.md 中的剩余要求继续处理。Privacy Mode 保持用户指定差异，总目标保持 active。

## Git 与共用环境

从 HEAD 9deeca0 的独立归档候选形成明确的 20 文件批次，仅将候选 patch 应用于 ROOT index。ROOT 原有未提交改动保留；提交前保存全部原始文件 byte/mtime、所有自有改动 preimage 和差分，提交后核对实际树、每个 blob、签名、空 index 及未变工作文件。最终具体提交身份与保护数量见本地 commit-verification.json；不 push。签名校验失败不得宣称完成提交。
