# Mods 官方 2.1.292 作者声明（2026-10-07）

本批以已签名的 ui.copy 提交 e03dd764202b0a39c3007553cc939c7bfff2c193 为独立候选基准，更新声明资产和消费者，保留全部其他工作区 WIP。证据根 `/private/tmp/mods-declarations-292-tawjepgs`，不 push。完整类型体同步完成，新增运行时行为仍按功能继续验收；整体兼容目标未完成。

## 来源与原生提取

本轮 [npm latest 元数据](https://registry.npmjs.org/@anthropic-ai/claude-code/latest) 核实官方 **2.1.292**，shasum `ecf88deee4c6b1b099d14a8571f1d5cad2ff1897`。官方 native SHA-256 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`，235017328 bytes。[Anthropic Mods reference](https://code.claude.com/docs/en/plugins/mods/reference) 当前仍标注 v2.1.290，文档说明安装版生成声明用于跟踪较新的 API；本批按 native 原始资产核对，不把旧文档当作最新版完整契约。

重新解析 Mach-O arm64/darwin 的 Bun section：raw offset 68206592、size 166132814，共2517模块。声明是 module2293 `/$bunfs/root/claude-code.d.ts-5e522846.txt.zst`；136529压缩字节 SHA-256 `afd775c1de82dbb43ddbf7c6869cf2360687bf38ccab852f8e355f8260414ab4`。Zstd 解码后 **612117 bytes**、SHA-256 **ec9fb8b86b52427c134e267749aa04ca84e419735e75810f5d2e5fa23f657ab3**，完整存入 assets/mods-2.1.292.d.ts.txt，未裁剪或重写定义。extractor SHA-256 `2a45f7df253cbe506d18d8984d62f1d2d3ac36052e7104bbdbd1d274cf5ec48b`；declaration-provenance.json 与原始提取数据保留，不执行解包代码。

旧 2.1.290 资产600277字节、SHA-256 `55d3a5dd98072b125135fae6fdc037f781b3ed9ad007dcd3ea4d657404d0b11f` 保留，历史哈希测试仍直接检查它。声明生成仅改一个来源 import；本地 engine 版本未升级。

## 类型差异与消费者

- 主模块 **560→565** 导出，testing **51→51**，没有移除名称；新增 ModelCompleteInput、ModelTextBlock、PromptAutocompleteInput、PromptAutocompleteResult、PromptAutocompleteSuggestion。
- EventOf/ResultOf **139→140**，新增 prompt.autocomplete；OpEventOf/OpValueOf 仍61、EventCalls仍11，autocomplete 是事件，不能据此新增公开能力调用。
- ModelCompleteRequest 接受缓存文本块，ModelCompleteInput 的作者事件保留文本并提供 promptBlocks/systemBlocks；cache 标记只能 true 或省略。
- AgentSpawnInput 增加 workflow 的 readonly runId/agentIndex；HookFailure.kind 增加 re-entry，cause 为只读可选 lent，budget 仍必需。

declarations.test/Results 的 raw oracle 跟随当前来源；Official290 首案继续固定历史资产，其余完整体、导出/映射和作者消费者改查当前来源，保留四案与原意图。新 Official292 五案检查完整资产/生成体、全部565/51导出、正例、恰好四条且与 raw official 相同的负例诊断。author292-contract.ts.txt 严格验证模型块/readonly/cache、autocomplete/匹配、workflow与catch定义。

工作区原有 untracked declarationsCaught 一案经完整审查单独纳入此功能提交：保留 ordinary/caught next 分离、streaming、result及void负例，扩展 re-entry/cause，并将临时项目 realpath。相关声明项目原测试也 realpath；无生产 ForTesting 分支、凭据逻辑或删案。工作区 EventCalls/TestingCalls 只更换 raw oracle 的资产引用，其他 WIP 保留且本批不整体暂存它们。

## 最终门禁与源码身份

copy 功能提交后重新建立候选基准，types-rebase-proof.json 检查类型源/夹具字节原样保留，所有 copy commit 的相关路径匹配新 HEAD。正式证据使用 rebased-final2 与 rebased-isolated，以及下面原生 final2 同一 cohort；旧 final1 不拼接为新版本通过。

- candidate source manifest SHA-256 `9a528327fa894de5f6cfd7e7f641a070ce3af871ccec2433f7f30d28a677ef0d`。
- workspace source manifest SHA-256 `6113b5a531ee6486491a64ff36f7d59fa0c7fe989361c96e6bea571d8822d48a`。

源清单覆盖 src/types/vendor/scripts/assets/CHANGELOG，各项独立无开发者 key/token HOME/config/cache/真实 TMPDIR、120s 硬截止、自有 process group。完整 command/env/before/result/log 保留。最终 tests/check/build 源清单相同，均 sourceUnchanged=true，清理完成。README/报告/台账在正式源码门禁之后追加，不改变该源清单。

| 检查 | 独立候选 | 工作区 |
| --- | --- | --- |
| 相邻作者 suite | 89/0，33.625s | 127/0，70.499s |
| make release-check | exit 0，52.12s | exit 0，54.174s |
| make build | exit 0，5.831s | exit 0，6.073s |

候选9文件：Official292/Official290/declarations/Results/Project290/Migration290/Entrypoints291/Dependencies291/Caught。工作区16文件另包含 Agent、Selection、Fault、PromptEdit、SessionEvents、EventCalls、TestingCalls。两个 suite 无 skip。

| 各文件独立无凭据运行 | 独立候选 | 工作区 |
| --- | --- | --- |
| declarations.test.ts | 28/0，7.782s | 46/0，22.83s |
| declarationsResults.test.ts | 22/0，18.36s | 22/0，14.435s |
| declarationsOfficial290.test.ts | 4/0，2.82s | 4/0，2.764s |
| declarationsOfficial292.test.ts | 5/0，4.782s | 5/0，4.73s |
| declarationsCaught.test.ts | 1/0，1.308s | 1/0，1.394s |
| uiCopy.types.test.ts | 2/0，2.12s | 2/0，2.176s |
| declarationsEventCalls.test.ts | 不含其他 WIP | 7/0，8.768s |
| declarationsTestingCalls.test.ts | 不含其他 WIP | 5/0，3.517s |

## 真实加载、迁移与严格作者项目

`python3 native-declarations.py <official|candidate|workspace> final2` 三侧串行使用新 HOME/config/PTY/tmux/socket，driver SHA-256 `f090507191cfcb39ad809748df827233e3ee54393022aeb4fb384c3225613868`。每个独立插件先放入2.1.290生成文件，再由实际 CLI 加载触发写出；两个默认根 tsconfig 与生成配置必须与官方相同，严格 tsc 使用 `--skipLibCheck false --incremental false`，不靠默认 skipLibCheck 隐藏错误。native-author.ts.txt 与被提交的 author292-contract.ts.txt 字节相同（SHA-256 baf35a90258e504e1c69708edacc5bb071d761fba71d2c8ec00b5d1f3a18ea29）。

最终 `python3 compare-declarations.py` exit0：**三侧各两个生成项目**的612117字节完整声明体、配置与原作者 fixture 相同，六次严格编译 exit0；本地 header 正确保留 2.1.280，官方为2.1.292。本地既有 owned SHA footer保留，严格检查其hash，并未声称完整文件头尾字节与官方相等。官方原文件额外末尾换行；本地 marker 是已有文件管理行为，本批没有新增。头尾差异不更改完整官方类型体。

相邻实际操作继续有8回执、6操作事件和origin一致，两个OSC与自有tmux buffer字节一致，正常 /exit0、binaryUnchanged、自有服务器清理exit0，无 dropped ui.log。100s总deadline，屏障最多15s，tsc最多15s且受剩余总时间约束，未延长截止。沙箱禁网络/Keychain/用户配置，仅 dummy key；自有SSH/tmux clipboard fixture，不读写系统剪贴板。

| 最终制品 | SHA-256 | bytes / mtime ns | native 秒 |
| --- | --- | --- | --- |
| official | `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f` | 235017328 / 1791315880497388108 | 9.283 |
| candidate | `0fa2c72ba60fbef2f6aef7dccd3ba1af61d724463e09629b06d753e269a50cac` | 102133730 / 1791349694392182462 | 8.908 |
| workspace | `a43b0de7dd5e03510ef81bffb57ca027185bd6a1254cf7286216b53c6c4d91f7` | 102018146 / 1791349694744886380 | 7.506 |

## 失败证据与边界

- qualified-red292 候选/工作区均1/4：旧生成来源缺最新定义，资产已固定仍不足以生成新版；原始早期红含正例漏 budget 的夹具错误，修正夹具后才作有效 RED，完整旧日志保留。
- 原 Caught 消费者只允许 throw/timeout；workspace-final-consumers 20/1 失败。按原始定义扩展精确 union/cause，保留其他断言，不回退生产类型。旧原始文件 before-root-declarationsCaught.test.ts 保留。
- native-candidate-final1 加载失败因此前 HEAD 尚未暴露 ui.copy，不是新版声明导致。先独立提交已验证 copy 实现，再重新建立新 candidate、跑完整门禁和 final2 三侧；不移除 copy 操作以回避失败。
- 初次 compare-declarations 把整个生成文件误当作 header+canonical，忽略官方尾部换行与既有本地 owned footer。失败脚本/日志保留。修正为按两侧明确生成规则逐字节校验全文件，连 footer SHA 一起检查；未改 native fixture/driver/制品或源码，不降低完整声明体要求。

| 剩余运行时差异 | 当前证据与下一步 |
| --- | --- |
| prompt.autocomplete | 作者类型已完整；生产输入事件、加载支持、补全合并/取消/替换流程待实现与官方终端对照。不是新公开 noun。 |
| ModelTextBlock / ModelCompleteInput | 当前 modelAdapter 仍仅接受 string prompt/system；缓存块投影、文本与块重写关系、真实模型参数需实现验收。 |
| HookFailure re-entry / cause | 本地 ModNext.error 仍使用旧内部 throw/timeout契约；直接/借用重入guard、catch流程与上下文还须关闭差异。 |
| AgentSpawnInput.workflow | 类型增加身份字段；Workflow spawn生产来源、不可伪造/只读上下文与下游传递继续逐项核验。 |

全部其他 API/context、Band/Client、working取消、动态matcher、所有主题/UI/终端transaction/diff/G5及全部WIP逐文件/全量门禁仍待完成。这是作者类型及真实生成项目的独立批次，不是完整运行时或全项目 release验收。

## 提交保护

只选十二路径：一行生产import、完整资产、五个声明测试、严格作者fixture、README/CHANGELOG/mods-test/本报告。旧290资产、原response/fix-instructions/improvment、共享binaries与其他Claude工作保留；不对ROOT的已有大型WIP文件整体git add。冻结3141路径与可逆变换/最终源清单逐项检查；此前 copy的生产实现和三个测试保持原字节与mtime。其他Claude PID94223/70780仅只读观察，不发输入或信号，不push，目标保持active。
