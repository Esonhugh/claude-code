# narration 完成消息：thinking 预览交接与 2.1.292 对照

## 改动与范围

父 HEAD 为 `b69d394ff700fd042ab849c3772101b41fc818ba`。此前已存储摘要行的 Mods 接线通过限定验收，但实际 Ctrl+O pane 中本地另有一份短时 `Thinking` 预览。本批在真实 `handleMessageFromStream` 的完成助手消息消费处，对首个非空 narration thinking 清空该预览，随后清空 streaming text 并保存原始消息。摘要仍由 Message/AssistantSummaryMessage/ModsRender 渲染，不通过隐藏其存储行解决重复显示。

沿用上一批 protobuf 显示分类；不认证或伪造 signature。非空原始摘要投影为空时也清空预览；空白 thinking、无效签名、普通私有 thinking 使用既有路径。多 thinking 消息按首个 thinking 判断。相邻 text 不清理普通私有预览；原始 thinking/signature/text、消息 UUID 和 Mods props 不被改写。stream stop 不能重建已清空的 narration 预览。

新增 debug 信息只包含完成消息 UUID：`[AssistantSummary] narration landed; cleared thinking preview message=<UUID>`。不打印 thinking 正文或 signature。公开作者接口及 Privacy Mode 不变。

## 官方依据

2026-10-07 再次检查[官方 npm 注册信息](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)，latest 仍为 2.1.292，shasum `ecf88deee4c6b1b099d14a8571f1d5cad2ff1897`。固定官方制品 SHA-256 为 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`；未使用共享 official-claude 执行本批验收。

静态解包的 chunk-pwkr374y.js 中，qJe 找到首个 thinking 后，以 eyt 判断 narration：成立时 onStreamingThinking(() => null)，否则保存普通 thinking。清空 text 和 onMessage 均发生在该判断之后。文件 SHA、字符偏移和有限摘录保存于 official-source.json。本批对齐 narration 的完成交接；普通私有 thinking 的 Mods live display 语义和最新 HKr 的 delta/metrics 尚未完整对齐，不能据此声称整个 stream consumer 相同。

## L1 / L2 / L3

新增 12 项生产 consumer 回归：三种旧预览状态、完整 delta/signature/完成/stop/text 事件序列、私有/损坏签名、Mods live display 保留、空白摘要、混合 thinking 的首块规则、普通 text 不清空私有预览、签名 delta 不能提前清理。检查清理发生在落地前，保存的是原对象和原 signature；没有为了断言导出 ForTesting 接口。

原始 RED 为 6 pass / 6 fail / 26 expect；实现后单文件为 12 pass / 0 fail / 47 expect。第一轮类型门禁发现测试直接访问 Message 联合类型的 message 字段（TS2339），补齐助手类型守卫后保留同样正文断言，两侧重新执行最终门禁。原始失败和所有尝试保留。

| 对象 | 25 文件 pass / fail | expect | 耗时 | release-check | 独立新构建 |
|---|---:|---:|---:|---|---|
| candidate | 675 / 0 | 2949 | 72.43 秒 | exit 0，42.404 秒 | exit 0，5.438 秒 |
| workspace | 717 / 0 | 3087 | 84.388 秒 | exit 0，43.616 秒 | exit 0，5.499 秒 |

每侧 source 清单在执行前后相同；候选只包含准确父 HEAD 与本批增量，工作区额外 WIP 未自动并入提交。此表是主要相关子集，不是全量通过；下面的额外 query/Worker gate 仍失败，整体更宽 runtime/发布验收不能标为 passed。

最终相关命令：

```bash
bun test --no-env-file ./src/components/messages/AssistantTextMessage.modsRender292.test.tsx \
  ./src/utils/assistantDisplayText.test.ts \
  ./src/components/Markdown.test.tsx \
  ./src/components/messages/SystemTextMessage.modsRender292.test.tsx \
  ./src/services/mods/uiRenderLifetime292.test.ts \
  ./src/components/ModsPane.test.tsx \
  ./src/components/ModsAbovePrompt.test.tsx \
  ./src/services/mods/ui.test.ts \
  ./src/services/mods/uiRealm.test.ts \
  ./src/services/mods/uiEnvironment.test.ts \
  ./src/services/mods/runtimeUi.test.ts \
  ./src/services/mods/dispatch.test.ts \
  ./src/services/mods/session.test.ts \
  ./src/screens/REPL.turnCheckpoint292.test.ts \
  ./src/ink/components/ScrollBox.test.tsx \
  ./src/services/mods/modelAbort.test.ts \
  ./src/services/mods/declarations.test.ts \
  ./src/components/messages/AssistantSummaryMessage.modsRender292.test.tsx \
  ./src/utils/assistantNarration.test.ts \
  ./src/utils/model/assistantSummaryDisplay.test.ts \
  ./src/utils/settings/maxProseWidth.test.ts \
  ./src/services/api/bootstrap-openai.test.ts \
  ./src/utils/context.test.ts \
  ./src/utils/settings/compactSettings.test.ts \
  ./src/utils/messages.streamingSummary292.test.ts
make release-check
make build CLAUDE_CODE_BUILD_DIR=<该侧私有输出目录>
```

## 额外 query/Worker 门禁：failed，保留根因证据

实际另跑 `bun test --no-env-file ./src/query.mods.test.ts`，没有筛掉失败用例：

| 对象 / 环境 | pass / fail | expect | 结论 |
|---|---:|---:|---|
| 未改动父 HEAD，干净隔离 | 113 / 7 | 580 | 与候选相同失败名称/断言 |
| 当前候选，干净隔离 | 113 / 7 | 580 | failed |
| 当前工作区，干净隔离 | 118 / 7 | 621 | failed，另有 5 项 WIP 用例通过 |
| 当前候选，仅增加占位 API key | 113 / 7 | 580 | failed，key 未解决 |
| 当前工作区，仅增加占位 API key | 118 / 7 | 621 | failed，key 未解决 |

七项为：运行工具的 turn.abort 超时；turn.step 内 abort 返回 model_error 而非 aborted_streaming；两种 drop 值下合法 JSON 的 signed thinking/tool 改写没有执行工具；两种 executor 的 author host 没有看到更新模型；Worker query 内 author tool 没有被调用。合法 signed thinking 的失败发生在 calls 断言，尚未调用本批修改的 stream consumer；工具/abort 失败同样不执行该新增分类分支。`query-neighbor-comparison.json` 保留父 HEAD、候选、工作区及 key 实验的准确失败名称和 source SHA，不能把既有失败称为关闭。

已在独立未改 HEAD 的诊断副本追查到五个工具调用失败的实际结果：`tool.isReadOnly is not a function`。对应 Tool 夹具以类型强转遗漏必需方法；原生产接口/执行器真实要求该方法。WaitForAbort 夹具也缺少同一方法，需继续验证取消用例。诊断只修改私有副本的日志捕获，原测试和断言未变，未将占位 key 实验或探针计作通过。下一批应补齐正确的工具夹具契约，再继续定位 abort 语义；本批不改工具执行生产逻辑以迁就这些测试。

## L5 / L6：新二进制的实际 stdin、pane 和 transcript

三侧各完整执行 20 模式，另各执行四组模型/entrypoint profile（每组 passthrough/prose）：Sonnet 显式隐藏、Opus 5.5 默认隐藏、Opus 显式显示、local-agent 父会话显示。插件替换、原生 next、装饰、双 next、Client、隐藏、错误树/字段、空 next、原样文本/表格/代码/prose、empty-source/private/malformed/blank 均经过真实 query → 完成消息消费 → Message/Mods 路径。

旧已验证控制记录（native-parent-control.json）中，官方 transcript 的摘要正文出现 1 次，父候选和工作区各出现 2 次并带私有 Thinking 标签。本批新的 15 次独立运行都为 1 次，普通视图及 transcript 断言均覆盖；没有等待 30 秒过期来取得成功，也没有删去重复行再比较。

| 对象 | profile | 场景 | 保存块 | 摘要 render | 全部回执 | 耗时 | 退出 / 清理 |
|---|---|---:|---:|---:|---:|---:|---|
| official | full | 20 | 40 | 266 | 626 | 18.917 秒 | exit 0 / 已清理 |
| official | mhidden | 2 | 4 | 5 | 14 | 4.292 秒 | exit 0 / 已清理 |
| official | mopus | 2 | 4 | 5 | 14 | 3.663 秒 | exit 0 / 已清理 |
| official | mopushint | 2 | 4 | 5 | 14 | 3.647 秒 | exit 0 / 已清理 |
| official | mcowork | 2 | 4 | 3 | 8 | 3.656 秒 | exit 0 / 已清理 |
| candidate | full | 20 | 40 | 321 | 735 | 20.182 秒 | exit 0 / 已清理 |
| candidate | mhidden | 2 | 4 | 9 | 20 | 4.627 秒 | exit 0 / 已清理 |
| candidate | mopus | 2 | 4 | 9 | 20 | 4.476 秒 | exit 0 / 已清理 |
| candidate | mopushint | 2 | 4 | 9 | 20 | 4.634 秒 | exit 0 / 已清理 |
| candidate | mcowork | 2 | 4 | 9 | 20 | 4.068 秒 | exit 0 / 已清理 |
| workspace | full | 20 | 40 | 319 | 729 | 22.007 秒 | exit 0 / 已清理 |
| workspace | mhidden | 2 | 4 | 9 | 20 | 5.406 秒 | exit 0 / 已清理 |
| workspace | mopus | 2 | 4 | 9 | 20 | 4.339 秒 | exit 0 / 已清理 |
| workspace | mopushint | 2 | 4 | 9 | 20 | 4.511 秒 | exit 0 / 已清理 |
| workspace | mcowork | 2 | 4 | 9 | 20 | 4.624 秒 | exit 0 / 已清理 |

同一目标的 UUID 与 transcript 对应，thinking/signature 和相邻 text 精确保持原值；每个本地完成 narration 块都有且仅有一次 clear 日志，17 个完整场景、每 profile 的 2 个场景均可对应真实存储 UUID。插件输入冻结，既有 readonly/type 错误文本一致，摘要块缩进、前导空格、NBSP/hint 和 Markdown 与官方逐行相同。transcript 动态时间/模型 metadata 独立保留，不作为正文归一化。

每目标独立 HOME/config/TMP/XDG/cwd/tmux/socket/evidence；相同夹具和 literal stdin，160×40 终端、localhost 假 SSE。sandbox 拒绝外网、真实 ~/.claude 与 Keychain，未复制真实凭据。目标串行至 /exit 正常退出、HTTP/请求线程/自有进程清理后再启动下一目标；binary 与插件文件 SHA 未改变。其他 Claude 会话没有输入或信号。

## 验收状态与剩余差异

| ID | 断言 / 门禁 | authoritative evidence | runtime | verdict |
|---|---|---|---|---|
| SH-1 | 完成 narration 先清理预览，再落原始消息 | 生产 consumer 回归、官方 qJe、新 native pane 和日志 UUID | done | passed for scope |
| SH-2 | 普通/展开摘要只有一份，不修改 signed 原文 | 15 运行的实时 pane、Ctrl+O、transcript 字节值 | done | passed for scope |
| SH-3 | 摘要 Mods props/续绘/hint 与合法 private 边界保持 | 主要 25 文件子集、20 模式和四个 profile | done | passed for scope |
| SH-4 | 制品、正常退出、清理及共享工作区保留 | SHA、result.json、preservation 与提交证明 | done | passed for scope |
| SH-5 | 更宽 query/Worker 回归 | 同一命令父 HEAD/候选/工作区及 key 实验，7 fail | done | failed |
| SH-6 | 全部 stream/API/UI/context/diff/G5 / 发布验收 | 仍缺完整匹配与门禁，已有差异保留 | partial | not covered |

本批没有关闭：live thinking delta 预览及 metrics（最新 HKr 不使用本地同样的 preview setter/length 逻辑）、普通私有完成 thinking 的 Mods 显示语义、官方 Thought for 行、绘制次数/调度、local-agent viewport/fullscreen 差异、动态桌面 attach、每模型 client-data/served capabilities、复杂 Markdown、其他原生站点和完整 UI/diff 操作流程。全部附件/上下文、G5 六会话认证场景、旧 response.md、全量及更宽 HEAD 回归门禁继续开放。版本标识按仓库现有 Makefile，不宣称整体 2.1.292 发布或完整 Mods 对齐完成。

## 制品及保留

- official: `/private/tmp/mods-summary-handoff-292-20261007-5o2ky5y0/native-official-s1`；SHA-256 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`，235017328 字节。
- candidate: `/private/tmp/mods-summary-handoff-292-20261007-5o2ky5y0/native-candidate-s2`；SHA-256 `5c5191b0e0190e703a42fd6f2729f63f10ffae6853846abcb909ae9490eef113`，102199778 字节。
- workspace: `/private/tmp/mods-summary-handoff-292-20261007-5o2ky5y0/native-workspace-s2`；SHA-256 `b33098c54055f325466d1791342f884b563a8c0279882f2d3928da029930cde7`，102067682 字节。

证据总目录：`/private/tmp/mods-summary-handoff-292-20261007-5o2ky5y0`。before.json 冻结原 HEAD/status、Git 可见文件、共享二进制及 response.md 的 SHA/size/mtime；before-source 保存本批接触文件的原 WIP。final2 gate 记录完整命令、环境与 source 清单。native-comparison.json 保留原始调用数量、private layout、viewport、metadata 和 clear 日志检查；查询失败对照及诊断副本独立保存，没有并入运行计数。

owned-diff-proof.json 使用准确候选增量三方投影到原 WIP，并要求逐字节等于当前文件。仅将本批六个路径的候选补丁写入 Git index，preservation-final.json 与 commit-proof.json 记录其他文件、原 WIP、签名和 committed blob 检查；不 push。总体目标仍 active。
