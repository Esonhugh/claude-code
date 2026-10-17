# AssistantMessage 普通文本：2.1.292 对照与提交边界

## 范围

以 `deff464` 为父提交，接通实际 `Message → AssistantMessageBlock → AssistantTextMessage` 的普通助手文本行。使用消息 UUID（不是 API message.id 或内容块下标）作为 requestId，在原生空文本和错误过滤之前进入 Worker 的 `ui.render`。现有 ModsRender 宿主负责实际 viewport、onScreen、Client、drawing 生命周期及失败回退。

官方的普通文本 `ir` 先用 `DV` 清理显示内容，再调用原生 `du`。本地同样仅在 next 文本与清理后的原始输入不同时重建 param；相同时保留原始 param 和错误标记。原生普通 Markdown 使用相同文本投影。投影删去四种隐藏分析块的正文，删去六种 cc-memory 标签外壳但保留正文，只移除前导 LF，保留空格、CRLF 和尾部换行。

作者声明已有 AssistantMessage 的 `text: string`、`isFirstOfReply: boolean`、只读 `isSummary?: true` 和 `onScreen`；本批不增加作者接口。next 保持宿主原始字段类型，isSummary 的类型与只读规则遵循官方校验。普通行不能自称摘要。

## 静态来源

- 2026-10-07 重新核对 [官方包注册信息](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)：latest 为 2.1.292，npm shasum 为 `ecf88deee4c6b1b099d14a8571f1d5cad2ff1897`。
- 固定官方制品 SHA-256 为 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`。未使用共享根目录制品执行验收。
- 本地静态解包：`chunk-se94er0s.js` 的 ir/du；`chunk-pwkr374y.js` 的 DV；`chunk-gwdy9dcv.js` 的 memory 标签处理；`chunk-r9hj3tk2.js` 的 kn/dn。文件哈希、标记、字符偏移和有限摘录保存在 `official-source.json`，不是根据类型名推断行为。

## L1 / L2 / L3

新增 14 项生产 Message + 实际 Worker/Ink 回归与 10 个文本投影向量。生产测试使用 `normalizeMessages` 的单块类型，不绕过 Message 路由类型；替换、装饰、隐藏、原生 Markdown、多次 next、输入更新、UUID、只读/类型错误、空文本/API 标记及无匹配零调用均有断言。

| 对象 | 17 文件相关 L1 | expect | L1 耗时 | release-check | 独立构建 |
|---|---:|---:|---:|---|---|
| 准确 HEAD 候选 | 557 pass / 0 fail | 2562 | 70.245 秒 | exit 0，41.982 秒 | exit 0，5.741 秒 |
| 完整工作区 | 599 pass / 0 fail | 2700 | 82.335 秒 | exit 0，44.187 秒 | exit 0，5.292 秒 |

两侧源码清单在测试、检查及构建前后相同，记录包含私有 HOME/config/TMP/XDG、精确命令、pid/pgid 和清理结果。相关测试还包含 Markdown/StreamingMarkdown、TurnDuration、生命周期、Pane/AbovePrompt、ui/Realm/Environment、runtimeUi、dispatch/session、checkpoint、ScrollBox、modelAbort 与作者声明。候选不含额外工作区 WIP；不合并两侧数字作为全量通过。

原始红回归为 1 pass / 9 fail / 33 expect。第一次接线遗漏 terminal surface，保留其失败记录；修复后曾剩一项测试使用错误的圆点字符，改用实际 BLACK_CIRCLE。第一次 release-check 发现夹具未经归一化导致数组与单块元组不兼容，改用生产 normalizeMessages 后两侧重跑通过。未删除、跳过或放宽功能断言。

最终命令：

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
  ./src/services/mods/declarations.test.ts
make release-check
make build CLAUDE_CODE_BUILD_DIR=<该侧私有输出目录>
```

## L5 / L6：真实 stdin 和存储消息

每个目标串行运行至 `/exit` 正常终止并清理自有进程后才启动下一目标。三侧使用相同插件夹具、literal stdin、160×40 全屏终端与 localhost 假 API；每个目标有独立 HOME/config/TMP/XDG、cwd、tmux socket 和证据。sandbox 禁止外网、共享 ~/.claude 和 Keychain；没有复制真实凭据，也未向用户现有 Claude 进程发送输入或信号。

13 个模式：replace、decorate、multiple、Client、hide、invalid、只读 isSummary、错误 text 类型、错误 isFirstOfReply 类型、空 next、错误标记 next、原样 next、原始只有分析块的消息。所有模式均进入真实 Message 站点。Client 实际显示自身文本；装饰及双 next 保留原生 Markdown，并分别控制圆点。非法绘制回退原生回复，三种非法 next 的消息文本三侧完全一致。

| 对象 | 场景 | 保存的原始回复 | ui.render 次数 | 全部调试回执 | 退出 / 清理 |
|---|---:|---:|---:|---:|---|
| official 2.1.292 | 13 | 13 | 160 | 212 | exit 0 / 完成 |
| candidate | 13 | 13 | 146 | 195 | exit 0 / 完成 |
| workspace | 13 | 13 | 146 | 195 | exit 0 / 完成 |

每次绘制的 requestId 都能对应同次运行 transcript 的真实助手 UUID，text 与该原始回复的显示投影相同，isFirstOfReply 为真实首行状态，普通回复没有 isSummary。Worker 输入冻结；插件改写和隐藏不进入持久化消息。隐藏分析从 pane 中消失，memory 标签外壳不显示而正文保留。制品与夹具哈希未改变，HTTP 线程与自有进程全部清理。

官方与本地绘制次数不同，未通过过滤或常数消除差异。上述证据仅证明本表场景的输入、续绘、显示和存储契约，不证明完整绘制调度或所有 UI 行为相同。

## Assertions

| ID | 主体 / 断言 | 所需证据 / 实际证据 | runtime | verdict |
|---|---|---|---|---|
| AT-1 | 生产普通助手行传真实 UUID、显示 text、首行状态 | 路由 diff + Worker/Ink 回归 + 同次 native debug/transcript UUID 对应 | done | passed |
| AT-2 | 隐藏分析删除、memory 正文保留及边界 | 10 个投影向量 + 三侧原始回复/显示文本逐项比对 + pane | done | passed |
| AT-3 | next/双 next/Client/隐藏及错误回退 | 生产回归 + 三侧 13 模式的 literal stdin、pane、debug | done | passed |
| AT-4 | 只读 isSummary、原始字段类型 | Worker 回归 + 三侧错误消息精确比对 | done | passed |
| AT-5 | 原文保存、正常退出、无共享副作用 | 原始 transcript、制品/夹具哈希、自有进程与 HTTP 清理、保留证明 | done | passed |
| AT-6 | narration 摘要、所有原生站点和完整 diff | 本批不具备对应入口、矩阵或真实流程证据 | n/a | not covered |

## 制品与本地证据

- official: `/private/tmp/mods-assistant-render-292-20261007-vdwtx1jw/native-official-o1`；binary SHA-256 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`，235017328 字节，运行 12.85 秒。
- candidate: `/private/tmp/mods-assistant-render-292-20261007-vdwtx1jw/native-candidate-c1`；binary SHA-256 `b9373566a5875fddc787fae7ab7aa300a08da0164251d60c0954b0d4b0354080`，102183266 字节，运行 13.253 秒。
- workspace: `/private/tmp/mods-assistant-render-292-20261007-vdwtx1jw/native-workspace-w1`；binary SHA-256 `55153814778fdcb93ce239a97552472b98b9891fd48448081a47cf17dbedbd19`，102051170 字节，运行 14.161 秒。

总目录：`/private/tmp/mods-assistant-render-292-20261007-vdwtx1jw`。`before.json` 冻结 Git 可见文件、共享制品和用户 response.md 的哈希与 mtime；`before-source` 保存改动前正文；`scope.json` 是本批契约；`candidate/workspace-related-final2`、`*-check-final2`、`*-build-final` 保存最终门禁。`native-comparison.json`、各侧 `evidence/result.json`、逐阶段 pane/ANSI/PTY、debug、wire、transcript 与 `driver-used.py` 保留完整受控证据。

`owned-diff-proof.json` 将准确候选增量三方投影到原始 WIP 并要求逐字节等于工作区；`preservation-final.json` 证明其他原文件和共享制品/response 未变化。提交从准确候选的 10 个路径生成补丁并仅写入 index，签名与 committed blob 检查保存在 `commit-proof.json`；不 push。

## 仍开放

narration 摘要的签名分类、正常/展开视图、模型能力及摘要 hint；first-text-block/cache 等实际生产路径；剩余原生站点、完整 UI/focus/几何与绘制调度；官方 mods diff viewer 的全流程及效果；附件/上下文、G5、旧 response.md 和更宽门禁继续开放。CONNECTOR_TEXT 接线随现有路由传递 UUID，但本批没有该 feature 的独立 binary 证据。本批不宣布整体 Mods 兼容目标或完整发布验收完成。
