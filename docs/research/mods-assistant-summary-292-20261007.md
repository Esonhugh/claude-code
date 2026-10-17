# narration 摘要：2.1.292 对照与提交边界

## 范围及原生接线

父提交为 `23df20ca021bd3c7bfb16d27ddc2e4154dd9c1db`。本批把实际 `Message → AssistantMessageBlock` 中非空 narration thinking 接入 `AssistantSummaryMessage → ModsRender`，在普通及展开模式的私有 thinking 过滤之前处理摘要。作者接口沿用已有 `AssistantMessage`：消息 UUID、清理后的 `text: string`、`isFirstOfReply: boolean` 和宿主只读的 `isSummary: true`；不创建另一套插件接口。

签名仅进行显示分类：base64 字节依次读取 protobuf 2/1/8 字段，UTF-8 值为 narration。忽略受支持的其他字段；损坏尾部使整个层级失效，重复长度字段以最后一个为准，分组 wire 类型不支持。缓存按 thinking 对象身份保存分类；未带签名的对象可在签名到达后再次分类。本实现不验证签名真伪，不伪造服务端认证。

原生行保留原始 trimmed thinking；相同显示 text 的 next 使用该原始值，改写 text 只影响本次绘制。显示投影隐藏分析内容并移除 cc-memory 标签外壳，保留其正文和前导显示空格。非空原文投影为空仍进入钩子；空白原文、普通私有 thinking、损坏签名不进入摘要钩子。保存的 thinking、signature 和相邻助手 text 不被改写。

原生 Markdown 只在最后一个适当位置附加淡色 `· summary`，可按模型规则隐藏；插件自己的树不附加标记。`maxProseWidth` 沿用官方整数、至少 40、optional/catch(undefined) 的解析，非法设置被忽略。本批在摘要中启用 prose 限宽，顶层代码/表格保留终端宽度。摘要调用显式关闭旧 Markdown 的 prompt 标签清理，因为投影已完成；保留前导显示空格，解决 40 列时 hint 换行与官方不同的问题。普通 Markdown 消费者仍沿用既有参数默认行为。

模型决定在原生行挂载时保存。支持 canonical 名称、`[1m]`、全局/精确/prefix capability override、Opus 5.5 prompt bundle 默认、Cowork 父会话例外，并读取 provider/凭据 key 匹配的现有 bootstrap clientDataCache。它尚不是官方完整每模型 capability/client-data 适配器；具体未关闭项见下节。

## 官方依据

- 2026-10-07 核对[官方 npm 注册信息](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)：latest 为 2.1.292，shasum `ecf88deee4c6b1b099d14a8571f1d5cad2ff1897`。
- 固定官方制品 SHA-256 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`，235017328 字节。共享根目录的 official-claude 未用于本批验收。
- 本地解包静态依据：chunk-se94er0s.js 的 ei/hu 与 thinking 路由；chunk-pwkr374y.js 的 ZZt/Ihe/eyt；chunk-k8tg12te.js 的 protobuf reader；chunk-03d0t1ag.js 的 y3n；chunk-91xzdn7x.js 的 E1/qe；chunk-rw5qnkv2.js 的 override scope；chunk-hx89w1md.js 的 wa/Dr Markdown；chunk-njty0xke.js 的设置 schema。`official-source.json` 保留文件 SHA、标记、字符偏移和有限片段，未执行解包代码。
- 作者参数仍以[官方 Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)和固定版本生成声明为准。本批未扩大公开类型定义。

## L1 / L2 / L3

新增 20 项实际 Message/Worker/Ink 摘要回归、24 个签名字节边界、19 个模型决定用例及 8 个设置向量；相关 gate 还包括既有 Markdown、普通助手行、TurnDuration、生命周期、Pane/AbovePrompt、ui/Realm/Environment、dispatch/session、checkpoint、ScrollBox、modelAbort、作者声明、context/compactSettings 和 bootstrap mock。这些是 24 文件相关回归，不能称为全量门禁。

| 对象 | 24 文件 L1 | expect | 耗时 | release-check | 新隔离构建 |
|---|---:|---:|---:|---|---|
| candidate | 663 pass / 0 fail | 2902 | 71.255 秒 | exit 0，42.444 秒 | exit 0，5.36 秒 |
| workspace | 705 pass / 0 fail | 3040 | 82.939 秒 | exit 0，44.188 秒 | exit 0，5.526 秒 |

两边最终运行的源码清单在执行前后相同，记录精确命令、独立 HOME/config/TMP/XDG、超时和自有进程清理。候选仅包含父 HEAD 与本批功能，不含额外 WIP。bootstrap-openai.test.ts 是顶层 assert 脚本，组合门禁确实执行它，但没有另外计作 Bun test 数量。

保留的 RED：实际路由未接摘要时为 3 pass / 11 fail / 50 expect；损坏测试字面量造成的一次 parse error 修复后为 76 pass / 0 fail / 231 expect；第一轮组合因隔离环境的非必要流量开关抑制 bootstrap mock 分别失败（候选 662 pass / 1 fail / 1 error，工作区 704 pass / 1 fail / 1 error）。独立复现同一 bootstrap 失败后，仅在 axios mock 测试范围临时移除该环境开关，并在 finally 恢复原值；生产 Privacy Mode 没有变化。

首次 native 候选功能观察完成，但摘要前导空格与 hint 换行不匹配官方，不能作为布局通过。生产回归增加确切两行断言后得到 19 pass / 1 fail / 123 expect；修复显示投影后，该文件与既有 Markdown 测试为 26 pass / 0 fail / 158 expect。最终 source 的 final3 gates 和新的 s2 native 运行替代先前本地证据；原始失败全部保留，没有删除断言或将失败改为 skip。

最终命令（在各自私有环境运行）：

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
  ./src/utils/settings/compactSettings.test.ts
make release-check
make build CLAUDE_CODE_BUILD_DIR=<该侧独立输出目录>
```

## L5 / L6：实际终端、摘要 props 与存储

每侧完整运行 20 模式：replace、decorate、multiple、Client、hide、invalid、readonly-delete/false/string、invalidtext、invalidfirst、empty-next、passthrough、table、code、prose、empty-source、private、malformed、blank。每轮真实 localhost SSE 产生一个 thinking 和一个相邻 text。两个消息均保存；摘要 requestId 指向同次 transcript 的 thinking UUID，普通行指向其 text UUID；所有摘要输入冻结，text 是准确投影、isSummary=true，普通行没有 isSummary。

四个追加 profile 各运行 passthrough/prose：Sonnet 的显式 quizzical_shore 隐藏、Opus 5.5 默认隐藏、Opus 的显式负 override 显示、local-agent 的 Opus 父会话显示。hint 的出现与消失、40 列 prose、实际 Ctrl+O transcript 开关均按源代码及 native 证据验证。每模型缓存/远程 served flags 没有真实联网验证；纯函数与 bootstrap mock 证据不冒充该覆盖。

三侧相同插件文件和 literal stdin，160×40 私有终端；每目标至 /exit 正常退出并清理后才运行下一目标。独立 HOME/config/TMP/XDG/cwd/tmux socket，sandbox 限定 localhost，拒绝真实 ~/.claude、Keychain 和外网；只清理本夹具进程，不给其他 Claude 会话输入或信号。

| 对象 | profile | 场景 | 保存块 | 摘要 render | 全部调试回执 | 耗时 | 退出 / 清理 |
|---|---|---:|---:|---:|---:|---:|---|
| official | full | 20 | 40 | 266 | 626 | 19.245 秒 | exit 0 / 已清理 |
| official | mhidden | 2 | 4 | 5 | 14 | 5.435 秒 | exit 0 / 已清理 |
| official | mopus | 2 | 4 | 5 | 14 | 3.709 秒 | exit 0 / 已清理 |
| official | mopushint | 2 | 4 | 5 | 14 | 3.547 秒 | exit 0 / 已清理 |
| official | mcowork | 2 | 4 | 3 | 8 | 3.513 秒 | exit 0 / 已清理 |
| candidate | full | 20 | 40 | 321 | 735 | 19.796 秒 | exit 0 / 已清理 |
| candidate | mhidden | 2 | 4 | 9 | 20 | 5.305 秒 | exit 0 / 已清理 |
| candidate | mopus | 2 | 4 | 9 | 20 | 4.514 秒 | exit 0 / 已清理 |
| candidate | mopushint | 2 | 4 | 9 | 20 | 5.033 秒 | exit 0 / 已清理 |
| candidate | mcowork | 2 | 4 | 9 | 20 | 4.229 秒 | exit 0 / 已清理 |
| workspace | full | 20 | 40 | 321 | 735 | 20.372 秒 | exit 0 / 已清理 |
| workspace | mhidden | 2 | 4 | 9 | 20 | 4.629 秒 | exit 0 / 已清理 |
| workspace | mopus | 2 | 4 | 9 | 20 | 4.506 秒 | exit 0 / 已清理 |
| workspace | mopushint | 2 | 4 | 9 | 20 | 4.532 秒 | exit 0 / 已清理 |
| workspace | mcowork | 2 | 4 | 9 | 20 | 4.205 秒 | exit 0 / 已清理 |

15 次运行的制品及插件哈希未变化，HTTP 请求线程、服务和自有终端/进程组全部清理。对比脚本逐字比对本批摘要块的缩进、前导空格、NBSP hint、换行、表格/代码，以及装饰、双 next、Client、隐藏与非法树回退；没有把整张 pane 或全屏几何当成一致。transcript 的时间/模型 metadata 行独立保留，不作为摘要正文。

五类字段校验的官方错误文本与候选/工作区相同。工作区 readonly-false 另有一次 `ui.render: superseded` catch，原始回执及数量单独保留；它不是字段校验错误，不能说全部错误或调度相同。官方完整运行摘要 render=266，本地=321；profile 次数也有差异，未用过滤或固定常数归一化。

## Assertions 与未关闭项

| ID | 断言 | 证据 | runtime | verdict |
|---|---|---|---|---|
| AS-1 | narration 分类、非空/损坏/private 边界 | protobuf 向量、真实路由/Worker、SSE/native debug | done | passed for scope |
| AS-2 | 真实消息身份、清理正文、只读 isSummary、首行标记 | 生产回归与 15 次同次 transcript 对应 | done | passed for scope |
| AS-3 | 替换/续绘/双 next/Client/隐藏/错误回退 | 20 模式、原生 Markdown 与错误文本 | done | passed for scope |
| AS-4 | 摘要原生块、尾部 hint、40 列 prose/顶层代码/表格 | 逐行比较、宽度断言与四组模型 profile | done | passed for scope |
| AS-5 | 原始 thinking/signature/text、退出、清理及保留 | transcript 字节值、夹具/制品 SHA、清理与保留证明 | done | passed for scope |
| AS-6 | 整张 UI、streaming preview、Cowork geometry、完整模型适配/diff | 已记录差异，无对应完整修复/矩阵 | partial | not covered |

明确保留的差异：

- 完成 narration 后，本地 Messages 仍把没有 signature 的 streamingThinking 副本作为私有 thinking 预览保留最多 30 秒；Ctrl+O 后会出现重复正文/Thinking 标签，官方没有。摘要已存储行相同不能关闭该 producer/UI 缺口。
- local-agent profile 中官方 viewport.isFullscreen=false，本地仍为 true；本批仅验证该 profile 的摘要 hint 与原生摘要块，不能称 Cowork/fullscreen 一致。
- 官方普通私有 thinking 存在 Thought for 耗时行，本地当前没有；private/malformed/blank 未进摘要钩子的断言通过，但这些私有行布局仍开放。
- 每模型 client-data slots、served capabilities、动态桌面 attach、完整旧模型/别名配置以及其他缓存刷新路径继续核对。
- 复杂嵌套 Markdown、普通文本 firstTextBlock/cache/空格、完整绘制调度、其他原生组件、TurnDuration 完成时间与后台等待、focus/resize/scroll 矩阵、官方 Mods diff viewer 的流程/效果仍开放。
- 原始 transcript 的 thinking stop_reason/usage enrichment 仍有差异；本批只证明正文和 signature 未改写，不宣称所有 API 消息元数据一致。
- 完整附件/上下文、G5（Gap 5 的 plugin-authoring 六会话认证场景）、旧 response.md 与更宽/全量/HEAD 门禁继续开放。本批不是全量发布或整体 Mods 完成声明，构建版本标识仍遵循现有仓库。

## 制品、保留和提交

- official: `/private/tmp/mods-summary-render-292-20261007-jys0joje/native-official-s1`；binary SHA-256 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`，235017328 字节。
- candidate: `/private/tmp/mods-summary-render-292-20261007-jys0joje/native-candidate-s2`；binary SHA-256 `1275b03ed12c86ea230c6387b436b6dc0b573770289075cfebd57df2f0436360`，102183266 字节。
- workspace: `/private/tmp/mods-summary-render-292-20261007-jys0joje/native-workspace-s2`；binary SHA-256 `e8588965b9904d7847d615cc00c988b034185a7a15a2355684eeccf1d2c520e8`，102067682 字节。

总证据目录：`/private/tmp/mods-summary-render-292-20261007-jys0joje`。`before.json` 冻结父 HEAD、原工作区文件、共享制品和用户 response.md 的哈希、size、mtime；`before-source` 保存原始 WIP。`native-comparison.json` 保留原始数量、额外取消、私有 thinking 布局、viewport 和重复预览差异；各侧 result.json、pane/ANSI/PTY、debug、wire、transcript、driver-used.py 保留受控运行证据。

`owned-diff-proof.json` 用候选增量三方投影到原 WIP 并要求逐字节等于当前文件。仅从干净候选的 15 个路径生成 index 补丁，保留其他已有改动，不 stage 整个共享文件。`preservation-final.json` 和 `commit-proof.json` 记录保留检查、签名及提交 blob 对应，不 push。
