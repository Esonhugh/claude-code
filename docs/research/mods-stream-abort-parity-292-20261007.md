# Mods stream 取消与官方 2.1.292 对照（2026-10-07）

本批基于提交 `5a61fb6635c6a6030a05a6ee8e73fbbbc0aaf4b7`，处理前一批记录的合法 turn.step 自取消、实际输出与资源清理差异。独立候选与含原 WIP 的完整工作区分别验证；其他 Claude 会话、shared binaries 和用户原始报告保留。

## 官方依据与实现

本轮核实 npm latest 为 2.1.292（https://registry.npmjs.org/@anthropic-ai/claude-code/latest；shasum `ecf88deee4c6b1b099d14a8571f1d5cad2ff1897`）。固定官方 binary SHA-256 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`，235017328 bytes；提取源码为 `/private/tmp/mods-declarations-292-tawjepgs/re-extract-292/all`，只读分析，不运行提取源码。

`chunk-r9hj3tk2.js` 的 KG/xpr/Fx/zt/$w/ep/Yks 表明 iterator result 不自动受 signal 拒绝，父取消传到 next.signal，stream hook 在有限收尾预算内仍可完成；undefined 只能沿已完整消费的 next result 结算。`chunk-03d0t1ag.js` 的 Fs/cs 区分真实模型错误与 API 取消、记录实际输出而不是 hook 结果的 answer。`chunk-3qgxc810.js` 的 query catch 不一律忽略已取消 turn 的真实错误。

本地修改：成功的 turn.abort 操作不用自己即将取消的查询 signal 争抢其返回；Worker 收到 cooperative stream abort 时只传信号，保留正在结算的 host RPC，显式 close 仍拒绝待完成调用。公开 stream 区分 cancellation/delivery，活动 pull 允许有限收尾，暂停或显式关闭/退出立即启动清理。next 的 return 不因 signal 已取消而拒绝清理；adapter 在所有退出路径等待 iterator.return。Worker 线上取消标记恢复原错误身份，真实 hook 失败仍诊断，缺少返回不制造空合法结果，取消后的 core 不发新请求。retained stream 的 watchdog 覆盖初始化 RPC 已结束但 pull 永不返回的情况。

调试信息仅打印 turnId/index/块数或 plugin/invocation，不包含正文、API key 或模型请求。Privacy Mode 未更改。

## L1 与调查记录

所有门禁私有 HOME/config/TMP/XDG、空环境、`bun test --no-env-file`，结束时源清单不变、自有进程组无残留。保存完整原始失败，不放宽原断言、删除用例、添加 skip 或延长原测试时限。

| 阶段 | 候选 | 工作区 |
| --- | --- | --- |
| 原 HEAD lifecycle RED | 216 pass / 1 fail / 1087 expect | — |
| 最終 12 文件回归 | 507 pass / 1 fail / 3 skip / 2426 expect | 535 pass / 1 fail / 3 skip / 2521 expect |
| 原始 runtime 整文件基线 | 89 pass / 1 fail / 1 skip / 500 expect | 91 pass / 1 fail / 1 skip / 506 expect |

最终相关组两侧 **exit1**，唯一失败都是远程 `aborted attach and detach do not commit partial roster transitions`，原 HEAD/原工作区基线同样失败。这批新增取消矩阵、所有原 query/turnStep 清理断言、Worker async finally failure、相邻工具/模型测试通过；3 个 skip 为原有 telemetry/native policy 条件，未添加。

原始不完整修改的候选第一轮达到120秒外层 timeout，保留原文件；第二/三轮暴露 pending pull 和显式 close 故障，第四轮自取消通过但剩两项清理失败。私有诊断副本发现 Bun 的待完成 rejects matcher 阻塞 Worker 消息投递：使用 matcher 约5秒后超时，直接 await 同一回执约52ms完成并保持相同取消身份及清理断言。生产测试改成普通 await 后严格核对 identity 和原消息；私有调试打印没有进入提交。

永不返回的 stream 测试新时限10秒用于覆盖官方5秒窗口，没有改任何既有时限。原候选5.9秒 exit0；原工作区10.9秒 timeout exit1，证实 retained stream watchdog 的缺口。最终该用例通过。新 regression 初次缺少 candidate 的 registeredQuery helper、模型错误文本假定 API 前缀不正确；修正为显式 publicTurn 和原始错误正文，保留失败记录。类型第一轮 candidate 的 ModContinuation 名称不在该提交定义，改用兼容的 Pick<ModNext,'signal'>；工作区已有公开/内部类型不覆盖。

相关文件：query.mods、turnStep、turnStepAbortGrace、environment、runtime、modelRuntime、toolReadOnly、toolAdapter、toolHost、runtimeTools、toolHooks、toolExecution。

## 真实终端：RED 与最终验证

同一 inline 作者 fixture 的 normal、valid-self、cooperative-self、missing-self、throw-self、normal-after 六场景。初次 helper 位置导致官方 loader 拒绝，另一顶层 helper 在本地被拒绝；这些失败保留。最终 common inline fixture 两侧接受，不把 driver/fixture 更改当作产品修复。

官方 RED 对照 `native-official-direct`：32 回执，四个 await turn.abort 都返回，next.signal 已取消且 reason.message=turn-abort；valid/missing 显示并保存 BEFORE+AFTER，cooperative/throw 只保留 BEFORE。缺少返回和真实错误分别有 hook skipped 诊断；self 主模型0，前后正常主模型各1。原候选 `native-candidate-red2`、原工作区 `native-workspace-red` 均只有28回执，await abort 未返回，completion只有BEFORE，pane/transcript显示 API error interrupt。三侧均正常退出0并完成清理。

最终新制品终端记录在本批 `native-*-final1/evidence/`；结论以该目录完整 result、原始 pane/ANSI/PTY/debug/会话 JSONL、比较器和二进制身份为准。主 query 按工具目录与最后 MAIN_CASE 标记分离，标题等旁路另计，不能声称全部 HTTP 请求为0。

## 精确提交与剩余范围

证据根 `/private/tmp/mods-stream-abort-parity-292-20261007-p6xf3xvd`。12 个原有路径通过干净 candidate patch 与原 ROOT WIP 三方投影，新增两文件逐字核对。7 个组合冲突显式保留原始 continuation 类型、caller-chain/origin、registered-turn services、catch recovery、ModClientError 与非 stream pending-request 行为；逐块 SHA/rule 及最终字节验证保存，不直接暂存 ROOT 整文件。

只暂存候选14路径、签名 commit 并验证 fingerprint、parent/blob、空 index、剩余原 WIP、未涉及文件 SHA/size/mtime、用户报告和受保护进程身份，不 push。最终 release-check/build 与精确 commit 证明另存于本批 result/proof。

本批不证明动态预算暂停、所有真实模型失败与取消竞态、answeredWithoutRequest 标记、顶层 helper loader、远程 attach/detach、全部上下文/作者 API/UI/完整官方 diff viewer、G5 六场景、旧 response 155 文件或全部 WIP 的全量验收。总目标继续。


## 最终制品与原生对照结果

两侧最终 `make release-check` 和私有 `make build` 均 exit0：候选分别41.389s/4.582s，完整工作区42.828s/4.717s。L1 到最终构建的源清单差异仅为 CHANGELOG.md 文档条目，生产与测试源码逐字相同；源清单和该核对结果见 `final-gate-proof.json`。原共享 binary 未替换。

官方/候选/工作区 `native-*-final1` 使用同一 driver SHA、作者 fixture SHA 和 stdin bytes，完整串行执行至正常 `/exit` 0；32/32/32 回执、私有 pane/tmux server/HTTP/request threads 全部退出，三份 binary 保持原样。比较器 exit0：六场 completion.answer/reason/isAborted、after-abort 的 signal/reason、真实普通/展开 pane 文本、保存的六条 assistant 文本、主 query 次数和两类 hook 诊断全部核对。主调用为 normal=1、四项 self=0、normal-after=1；每侧6个标题等旁路请求另计。这些是具体输出/流程比对，不是完整终端字符/样式/所有上下文字段一致。

| 场景 | 官方、候选、工作区实际输出 | completion | 主调用 |
| --- | --- | --- | --- |
| normal | OWNED_MAIN_DONE normal | answer / 非取消 | 1 |
| valid-self | BEFORE + AFTER | aborted / 已取消 | 0 |
| cooperative-self | BEFORE | aborted / 已取消 | 0 |
| missing-self | BEFORE + AFTER，缺少结果诊断 | aborted / 已取消 | 0 |
| throw-self | BEFORE，OWNED_REAL_ERROR 诊断 | aborted / 已取消 | 0 |
| normal-after | OWNED_MAIN_DONE normal-after | answer / 非取消 | 1 |

固定制品身份：

- candidate: SHA-256 `6f94d21a8bd50db2bc223160bcc44af590f1f5e589ec301c15ecf24bac0e0f15`, 102199778 bytes；最终源清单 SHA-256 `71d8b7031fe81902a99b1ac80c02a39aceaee5561ac2f78a248e4eff87de92f9`。
- workspace: SHA-256 `afa4243056eabcfa9ac6da680aa5458337981ae0d0377a5971d755233f5526c6`, 102067682 bytes；最终源清单 SHA-256 `196a91cc9f26aed2cef6bd7588bf79dae9ef5b374d71a5d0916dde3ca54cc997`。

完整解析和边界保存于 `native-comparison.json`。曾有一次外层清理预检查误用旧字段名而失败；正确检查实际 `requestThreadsStopped`/`httpStopped`/owned groups 字段后验证通过，官方没有与本地进程重叠。官方既有版本与本地2.1.280头部、日志文字、辅助请求和未验证的布局字段不由这批宣布相同。
