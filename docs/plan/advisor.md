# Advisor 工具移植计划

## 1. 文档状态

- **类型**：实施计划
- **状态**：实施中
- **日期**：2026-11-17
- **对照版本**：官方 2.1.325（`~/.local/share/claude/versions/2.1.325`），参考 2.1.322。官方实现的抽取和偏移见 `/tmp/advisor-design/official.md`，核心常量和提示原文见 `/tmp/advisor-design/official/m0502-advisor-core.js`
- **其他依据**：用户文档 https://code.claude.com/docs/zh-CN/advisor ；fork 现状调研 `/tmp/advisor-design/fork-current.md`；25b0a9 的调研 `/tmp/ccs-coord/advisor-research-25b0a9.md`（下文记为 R25，以文件开头的更正记录为准）
- **证据边界**：官方行为来自静态阅读 minify 后的模块，没有用真实账号运行。fork 调用点按 dev f72df3f3 核对

## 2. 目标

本地构建默认提供和官方 2.1.325 一致的 advisor：主模型在关键节点调用服务端 `advisor` 工具，由更强的模型审查整段对话后给出建议。具体要求：

- 不依赖远程开关，默认开启。`CLAUDE_CODE_DISABLE_ADVISOR_TOOL` 完全关闭，`CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL` 跳过 rank 检查。
- provider、rank 配对、请求形状、拒绝后重发、`/advisor`、`--advisor`、启动提示、transcript 显示、计费、subagent、fork、压缩和恢复，都按官方的行为和原文实现。
- 有意的偏差写在第 7 节，每条附原因。

## 3. 官方行为摘要

细节和来源偏移见 official.md，这里只列实现要对齐的点。

| 方面 | 官方 2.1.325 |
| --- | --- |
| 请求 | beta `advisor-tool-2026-03-01`；tool `{type:'advisor_20260301', name:'advisor', model}`，不发 `max_uses`、`max_tokens`、`caching`。beta 在 `Pin() && (Lx() \|\| advisorModel !== undefined)` 时推送。请求不带 advisor 时总是剥掉历史里的 advisor 块，删空的 assistant 消息补 `[Advisor response]` |
| 挂载 `Pin()` | 未设 `CLAUDE_CODE_DISABLE_ADVISOR_TOOL`、不是 CCR 受限会话、没有记下 process/host 级拒绝；provider 为 firstParty 或 anthropicAws/anthropicGoogleCloud；允许实验 beta（`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` 未设且非 HIPAA） |
| 开关 `Lx()` | `Pin()` 且（`CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL`，或 GrowthBook `tengu_sage_compass2.enabled`，AWS/GCP 托管默认开，firstParty 靠下发） |
| rank | 目录字段 `advisor_rank`：haiku-4-5=1，sonnet-4-6=2，opus-4-6=3，haiku-5-5/sonnet-5=4，opus-4-7/4-8=5，sonnet-5-5=6，opus-5/5-5=7，fable-5/mythos-5=8，fable-5-1/mythos-5-1=9，fable-5-2/mythos-5-2=10；更老的模型无 rank。advisor 的 rank 至少为 2 且不低于主模型；任一方无 rank 时配对检查放行，但主模型无 rank 时整体不挂 |
| 别名 | `fable`、`opus`、`sonnet`；picker 和错误提示只列当前可用的别名；`availableModels` 排除的模型不能当 advisor |
| 提示 | 说明文字不进 system prompt，作为 `advisor_tool` attachment 注入成 meta user 消息（system-reminder 包裹）。有完整版、简短版（"The advisor tool is available; the advisor instructions announced earlier apply."）和撤销版（"The advisor tool is no longer available; disregard the earlier advisor instructions."） |
| 每轮状态 | 每次请求前算出本轮 advisor 和要不要写 announcement。对话持有的 advisor（held）一旦确定，到 `/clear` 或 `/compact` 前不变；中途改 `/advisor` 只影响新对话。主线程按配置的主模型配对，subagent 按自己的模型配对，辅助请求（compact、side question 等）只读不改 |
| 拒绝 | 400 里带 `the advisor tool is not available`、`cannot be used as an advisor`、`tools.N.model: `、`Input tag 'advisor_N'` 或 beta header 被拒（422 只认 Input tag）时，去掉 advisor 重发一次。范围：`not available for this organization` 记到进程，Input tag 和 beta 被拒记到 host，其他只记到当前对话。`cannot be used as an advisor when the request model is` 不重发，直接报错 |
| `/advisor` | local-jsx，picker 标题 `Advisor (experimental)`，选项为可用别名、当前完整 id 和 `No advisor`；带参数直接设置；非交互模式打印 `Advisor: X` 和用法 |
| `--advisor` | 隐藏选项，始终注册，只在 `Lx()` 时校验：主模型不支持或 advisor 不可用时报错退出（后台会话只警告），配对失败只警告 |
| 提示 | 启动后 `Advisor Tool (experimental) is on and may use more tokens · /advisor`；配对失败时换成 `Advisor will not activate on the main model …` |
| transcript | Advising（转圈）、Reviewed（Ctrl+O 看全文）、Declined（`stop_reason: refusal`）、Unavailable（error_code 白名单外显示 `unknown`） |
| 计费 | 按 `usage.iterations` 里的 `advisor_message` 分模型计费 |
| fork | 非 compact 类、带上下文的 fork 保留 advisor tool 以复用缓存，并追加 meta 消息 `Never consult the advisor tool.` |
| 恢复 | 从 transcript 最后一个 `advisor_tool` attachment 恢复 held；CCR 会话另外恢复 `advisor_pick` |

## 4. fork 现状和缺口

fork 有一套早期实现，请求、计费和显示的接线都在，但开关读 GrowthBook `tengu_sage_compass`，而 fork 构建的 GrowthBook 总是关闭，所以功能实际不可用（R25“结论”，fork-current.md 第 1 行）。

| # | 位置 | 现状 | 缺口 |
| --- | --- | --- | --- |
| 1 | `src/utils/advisor.ts:56-75` | `isAdvisorEnabled()` 读 `tengu_sage_compass`，默认 false；`canUserConfigureAdvisor()` 还要 `canUserConfigure` | 改为 `tengu_sage_compass2` 并本地默认开；补 `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL`、进程/host 拒绝记录 |
| 2 | `src/utils/advisor.ts:89-108` | 只认 `opus-4-6`、`sonnet-4-6` 或 ant | 换成官方 rank 表和配对函数（R25 缺口 3） |
| 3 | `src/utils/advisor.ts:11-36` | `advisor_result` 没有 `stop_reason` | Declined 需要这个字段（R25 缺口 8） |
| 4 | `src/services/api/claude.ts:1281-1324` | 开关为真就推 beta；只按 #2 的字符串判断挑 advisor | 改为官方条件；advisor 的选择移到 query 循环 |
| 5 | `claude.ts:1626-1628` | 只在没带 beta 时剥 advisor 块 | 请求不带 advisor 时总是剥 |
| 6 | `claude.ts:1676` | 说明文字追加到 system prompt | 改为 `advisor_tool` attachment，正文换成官方 `am` |
| 7 | `claude.ts` 错误路径 | 没有 advisor 拒绝的识别和重发（R25 缺口 7） | 照 `ToolSearchRefusedError` 的写法补 |
| 8 | `src/query.ts:1288` | 直接把 `appState.advisorModel` 传给请求 | 每轮解析 held 和 announcement |
| 9 | `src/commands/advisor.ts` | 纯文本 local 命令，隐藏 | 改成 local-jsx picker 加非交互版本，文案照官方（R25 缺口 4） |
| 10 | `src/main.tsx:3491-3525`、`:5739-5746` | 只在可配置时注册 `--advisor`；无后台会话降级，配对失败没有提示 | 始终注册；校验照官方（R25 缺口 10） |
| 11 | 启动提示 | 没有 | 新增（R25 缺口 5） |
| 12 | `src/components/messages/AdvisorMessage.tsx` | 有 Advising、Unavailable（原样显示 error_code）、Reviewed | 补 Declined；error_code 白名单（R25 缺口 9） |
| 13 | `src/utils/forkedAgent.ts:60-73` | `CacheSafeParams` 没有 advisor | fork 固定 advisor 并追加 `Never consult the advisor tool.` |
| 14 | `src/cost-tracker.ts:362-377` | 已按 advisor 模型计费 | 无 |
| 15 | `src/utils/messages.ts:6002` | `stripAdvisorBlocks` 已有，删空补 `[Advisor response]` | 复用 |

provider：fork 的 `APIProvider`（`src/utils/model/providers.ts:6`）只有 firstParty、bedrock、vertex、foundry、openai，没有 anthropicAws、anthropicGoogleCloud。现有判断 `shouldIncludeFirstPartyOnlyBetas()`（`src/utils/betas.ts:262-267`）同时放行 Foundry（R25“给设计的两点提醒”），不能沿用。按用户决定，advisor 只在 `getAPIProvider() === 'firstParty'` 时启用；自定义 `ANTHROPIC_BASE_URL` 也算 firstParty，上游不支持时由用户设 `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` 关闭，不做网关专项处理。

## 5. 逐模块改动方案

按依赖顺序实施，每一步先写失败的测试再改代码，按功能单独 commit。

### 5.1 开关（`src/utils/advisor.ts`、`src/services/analytics/growthbook.ts`）

- `isAdvisorToolAllowed()`（官方 `Pin`）：未设 `CLAUDE_CODE_DISABLE_ADVISOR_TOOL`；没有进程级或当前 host 的拒绝记录；`getAPIProvider() === 'firstParty'`；未设 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`。
- `isAdvisorEnabled()`（官方 `Lx`）：`isAdvisorToolAllowed()` 且（`CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL`，或 `tengu_sage_compass2.enabled`）。
- `LOCAL_GA_DEFAULTS` 加 `tengu_sage_compass2: { enabled: true }`，GrowthBook 关闭时就是开；开着 GrowthBook 的构建仍听远程值。删掉旧的 `tengu_sage_compass`、`canUserConfigureAdvisor()` 和 `getExperimentAdvisorModels()`（官方已没有按 baseModel 下发 advisor 的实验）。
- 拒绝记录：模块级 `processRefused` 和 `refusedHosts`。host 键取 `ANTHROPIC_BASE_URL` 的 host，没设时为 `"default"`。

### 5.2 rank 与别名（`src/utils/advisor.ts`）

- `ADVISOR_RANKS` 照官方表。查表用自己的最长前缀匹配：先 `parseUserSpecifiedModel` 解析别名，去掉 `[1m]`，再在小写 id 里找最长的 key，key 后面必须是结尾或非数字。不用 `firstPartyNameToCanonical`，因为它把 `claude-fable-5-2` 归到 `claude-fable-5`。
- 函数一一对应官方：`modelSupportsAdvisor`（SQ）、`canModelAdvise`（rm，rank ≥ 2）、`isUsableAdvisorModel`（CPe，加 `isModelAllowed`）、`isAdvisorPairingAllowed`（H1e，带 rank 跳过）、`isAdvisorPairingAllowedStrict`（XBn）、`getAdvisorAliasOptions`（hre）、`resolveAdvisorModel`（o3e，四条 debug 日志和一次性 console.warn 原文照搬）。
- Fable 同意相关的 `n5`、`Gle` 写成恒为 false 的函数并注明原因，见第 7 节。

### 5.3 attachment 与提示文字（`src/utils/attachments.ts`、`src/utils/messages.ts`）

- `Attachment` 加 `advisor_tool`：`{available:true, model, abbreviated?}` 或 `{available:false, model?, byBase?}`。fork 没有 mid-conversation tool-change beta，所以不写 `toolChange`。
- `normalizeAttachmentForAPI` 渲染成 system-reminder 包裹的 meta user 消息；正文由 `getAdvisorAnnouncementText(available, abbreviated)` 选（官方 `MXi`），完整版用官方 `am` 原文，替换 fork 的 `ADVISOR_TOOL_INSTRUCTIONS`。
- `getLastAdvisorAttachment`（Oin）和 `hasFullAdvisorAnnouncement`（IXi）放在 advisor.ts。
- transcript 里不显示这个 attachment。

### 5.4 每轮解析（新文件 `src/utils/advisorQuery.ts`，`src/query.ts`）

- `resolveAdvisorForQuery(messages, {querySource, setting, configuredModel, requestModel, carrier})` 移植官方 `ggr`，`toolChangesRide` 恒为 false：返回 `{announcement?, advisorModel?}`。
- 请求来源分类同官方 `po`：`repl_main_thread*`、`sdk` 为 main；`agent:*`、`hook_agent` 为 subagent；其余为辅助请求，只读 held，不写 announcement。
- carrier：main 用模块级对象，`/clear`（`clearConversation`）、压缩（`runPostCompactCleanup` 的主线程分支）和切换会话时重置；subagent 每次进入 `query()` 新建；辅助请求用 main carrier 的副本。carrier 为空时先从 transcript 的最后一个 `advisor_tool` attachment 恢复（官方 `_gr`），所以 resume 不需要额外处理。
- query.ts 在算出 `messagesForQuery` 后、构造请求前调用它；有 announcement 时 `createAttachmentMessage` 后 yield 并追加到本轮消息；`advisorModel` 传给 `callModel`，替代 `appState.advisorModel`。

### 5.5 请求（`src/services/api/claude.ts`）

- `advisorModel` 只在 `isAgenticQuery` 或 fork 请求（见 5.8）时生效，并要求 `isAdvisorToolAllowed() && modelSupportsAdvisor(model)`（官方 `PXi`）。
- beta：`isAdvisorToolAllowed() && (isAdvisorEnabled() || advisorModel !== undefined)` 时推送。
- 本次请求不带 advisor 时总是 `stripAdvisorBlocks`。
- 删掉 system prompt 里的 `ADVISOR_TOOL_INSTRUCTIONS`；tool 仍放在 tools 末尾。

### 5.6 拒绝后重发（`src/services/api/advisorRefusal.ts`、`claude.ts`、`src/services/api/errors.ts`）

- `classifyAdvisorRefusal(error, betas)` 移植 `Qlt` 和 `hCn`，返回 `undefined` 或 `{scope: 'process'|'host'|'conversation', kind: 'beta'|'entry'}`。
- 请求带了 advisor tool 或 advisor beta 时，错误路径抛 `AdvisorRefusedError`。`queryModel` 照 `ToolSearchRefusedError` 的写法接住：记录范围，打官方原文日志，发 `tengu_advisor_entry_refused_retry`，调 `options.onAdvisorRefused()`（query.ts 把 carrier 的 held 置为 `{model: undefined, refused: true}`），然后带 `{advisorModel: undefined, advisorRefused: true}` 重发一次。重发再失败按普通错误处理。
- `cannot be used as an advisor when the request model is` 不重发，生成 `advisor_incompatible` 错误消息，文案按交互和非交互两种。
- 自定义 `ANTHROPIC_BASE_URL` 与 firstParty 同样对待，只走上面这条官方路径。

### 5.7 `/advisor`（`src/commands/advisor/`）

- 照 `/model` 的结构：`index.ts` 导出 local-jsx 的 `advisor`（description `Let Claude consult a stronger model at key moments`，argumentHint `[fable|opus|sonnet|off]`，`isEnabled: isAdvisorEnabled`）和非交互版 `advisorNonInteractive`。
- 共用的写入函数 `setAdvisorFromCommand`（官方 `VDt`）：文案 `Advisor set to …`、`Advisor disabled`、`… cannot be used as an advisor. Valid options: …`、两条 Note、held 状态说明（官方 `y()`）全部照原文；写 AppState 和 `userSettings.advisorModel`；远程模式加 ` (this session only)`；发 `tengu_advisor_command`。
- picker 移植 m2819：标题 `Advisor (experimental)`、说明、主模型不支持时的警告、可用别名加当前完整 id 加 `No advisor`、推荐语和链接；发 `tengu_advisor_dialog_shown`。
- 非交互：`The advisor is not available`；无参数或 help 时 `Advisor: X` / `Advisor: off` 加 `Usage: /advisor <…|off>`；`unset` 等同 `off`。

### 5.8 fork、压缩和 subagent（`src/utils/forkedAgent.ts`、`src/services/compact/`、`src/query.ts`）

- `CacheSafeParams` 加 `advisorModel?: string`，取主线程本轮实际挂上的 advisor（query.ts 发出 cacheSafeParams 时带上）。
- `runForkedAgent` 把它固定给 fork 的 query：fork 不做每轮解析，直接用这个值；claude.ts 对 fork 请求同样允许挂 advisor（官方 `forkPointUuid` 分支）。
- 带上下文、label 不是 `compact`、`reactive_compact`、`resume_cache_warm` 的 fork，在设置了 advisor 时追加 meta 消息 `Never consult the advisor tool.`，tool 保留，以免破坏缓存前缀。
- 手动 `/compact` 的摘要请求不带 advisor；自动压缩带主线程的 advisor（官方 m2703 与 autocompact 的区别）。
- subagent 继承 `appState.advisorModel`，按自己的模型配对，carrier 独立。

### 5.9 `--advisor`（`src/main.tsx`）

- 选项始终注册并 `hideHelp()`，描述 `Enable the server-side advisor tool with the specified model (alias or full ID).`。
- 校验只在 `isAdvisorEnabled()` 时执行，三条报错和警告原文照 m1030；`CLAUDE_CODE_SESSION_KIND=bg` 时只写日志不退出。配对失败只在 stderr 警告。日志 `[AdvisorTool] Advisor model: …`。
- 关闭时 `--advisor` 被接受但不生效，AppState 的 `advisorModel` 只在开启时写入。

### 5.10 启动提示（`src/hooks/notifs/useAdvisorNotification.ts`）

- 照 m2304 `NPt`：远程模式或关闭时不显示；没有 advisor 或主模型无 rank 时不显示；advisor 可用时按配对结果显示两条之一，key `advisor-experimental`，priority medium；`advisorModel`、`mainLoopModel` 变化时重新计算，状态不变不重复显示。

### 5.11 transcript（`src/components/messages/AdvisorMessage.tsx`、`src/utils/advisor.ts`）

- 块类型加 `stop_reason?`。`isAdvisorRefusal`（r3e）和 `getAdvisorRefusalText`（xin）、`getAdvisorErrorCode`（TXi，白名单 6 个）照搬。
- 显示：Advising + ` using <model>`；Declined 用 warning 色，有理由时非 verbose 加 ctrl+o 提示，verbose 显示理由；Unavailable 用白名单 code；Reviewed 非 verbose 显示勾号行加 ctrl+o 提示，verbose 显示全文；redacted 只有勾号行；未知内容不渲染并发一次 `tengu_advisor_unknown_content`。

### 5.12 计费与恢复

- 计费沿用 `cost-tracker.ts:362-377`，补测试。
- resume 依赖 5.4 的 transcript 恢复；`advisor_pick` 不做（第 7 节）。

## 6. 测试计划

单元测试断言具体文本和请求内容，按模块放在被测文件旁边（`*.test.ts`）。

| 范围 | 用例 |
| --- | --- |
| 挂载矩阵 | 五个 provider（只有 firstParty 开）× `DISABLE_ADVISOR_TOOL` / `ENABLE_EXPERIMENTAL` / `DISABLE_EXPERIMENTAL_BETAS` × gate 开关；进程级和 host 级拒绝后 `isAdvisorToolAllowed()` 为 false，换 host 后恢复 |
| rank | 官方表每一项；`fable-5-2` 不落到 `fable-5`；别名、`[1m]` 后缀；无 rank 模型；`ENABLE_EXPERIMENTAL` 跳过；`availableModels` 排除 |
| 每轮解析 | 首次完整 announcement；已有完整版时不重复；主模型不支持时 `byBase` 撤销，切回后发简短版；held 不随设置变化；refused 后发 `{available:false}`；subagent 用自己的模型；辅助请求不写 announcement；从 transcript 恢复 |
| 请求 | tool 形状和位置、beta 推送条件、不带 advisor 时剥块、system prompt 不再含说明文字；OpenAI 和 ChatGPT 模式下 tools 和 beta 与改动前一致 |
| 拒绝 | 各类错误文本的分类和范围；只重发一次，重发请求不带 tool；host/process 范围下后续请求不带 beta；`advisor_incompatible` 文案 |
| 命令 | `/advisor` 各分支文案、picker 选项和文本、非交互输出；`--advisor` 三种情况和 bg 降级 |
| 显示 | 四种状态和 verbose；error_code 白名单 |
| 其他 | 计费；fork 的 advisorModel 和 `Never consult the advisor tool.`；手动压缩不带 advisor；`/clear`、压缩后 carrier 重置 |

验证命令：直接相关和相邻的测试文件、`bunx tsc --noEmit --pretty false`、`bun run lint`。机器负载高，不并行跑全量单测。

交互验收：`make build` 后在 tmux 里用本地假 API（Bun 写的 HTTP 服务，按请求里的 tools 返回 `server_tool_use` 加 `advisor_tool_result` 的 SSE）检查启动提示、`/advisor` picker、一次 Reviewed 和一次 Unavailable、`--advisor haiku` 报错退出。证据存到 `/tmp/advisor-design/accept/`。

## 7. 与官方的差异

| 项 | 官方 | fork | 原因 |
| --- | --- | --- | --- |
| provider | firstParty、anthropicAws、anthropicGoogleCloud | 只有 firstParty（含自定义 `ANTHROPIC_BASE_URL`） | fork 没有后两个 provider，按用户决定只放行 firstParty |
| 开关默认值 | firstParty 靠 GrowthBook 下发 | `LOCAL_GA_DEFAULTS` 里默认开 | fork 构建没有 GrowthBook，按用户决定不依赖远程开关 |
| standby 和 `defer_loading` | 带 mid-conversation tool-change beta 时预挂 standby advisor | 不做，`toolChange` 字段不写 | fork 没有这个 beta，官方在没有它时也不走这条路径 |
| Fable 同意 | 需要 usage credits 的 Fable 先在 `/model` 同意 | 不做，Fable 与其他模型同样对待 | fork 没有 claude.ai 订阅状态和同意流程 |
| `advisor_pick` | CCR 会话把 advisor 选择写进 internal metadata 并在恢复时还原 | 不做 | fork 的 CCR 恢复只读 external_metadata，也无法在本地验证 |
| extractMemories 跳过 | MCP 账户记忆路径在 advisor 撤不下时跳过 | 不适用 | fork 的 extractMemories 没有 MCP 模式 |
| 结果无法处理时剥块重发 | `Advisor tool result content could not be processed` 时剥掉 advisor 块重发并记录 | 视实施进度，未做时在报告里标出 | 依赖 `advisor_stripped` attachment 和压缩重放，改动面大 |
| CCR 受限会话、HIPAA | 关闭 advisor | 不判断 | fork 没有这两个状态 |
| 只读客户端 | `/advisor` 拒绝修改 | 不判断 | fork 没有对应的 view-only 连接 |

## 8. 风险和未决项

- 默认开启后，firstParty 上没配 advisor 的请求也带 `advisor-tool-2026-03-01`，与官方一致。自定义网关不认识这个 beta 时，第一次 400 会走官方的“beta 被拒，按 host 记住并重发一次”路径；用户也可以设 `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` 关闭。
- 说明文字从 system prompt 移到 attachment 后，已有会话恢复时历史里没有 attachment，第一轮会补发完整版，多一次 meta 消息。
- 官方 `ra` 对部分自定义或未解析的模型返回无 rank，fork 按 id 匹配，自定义 id 里含官方名字时会被当成该模型。
- 官方行为来自静态阅读，没有真实账号对照；假 API 验收只覆盖渲染和请求形状。
