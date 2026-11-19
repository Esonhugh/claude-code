# Advisor 工具移植计划

## 1. 文档状态

- **类型**：实施计划
- **状态**：已实现（含 5.13 的对话中途开关），未对真实账号验证。2026-11-18 改为显式开关、去掉等级表，见第 10 节；第 3 至 8 节里与第 10 节冲突的内容以第 10 节为准
- **日期**：2026-11-17，2026-11-18 修订
- **对照版本**：官方 2.1.325（`~/.local/share/claude/versions/2.1.325`），参考 2.1.322。官方实现的抽取和偏移见 `/tmp/advisor-design/official.md`，核心常量和提示原文见 `/tmp/advisor-design/official/m0502-advisor-core.js`
- **其他依据**：用户文档 https://code.claude.com/docs/zh-CN/advisor ；fork 现状调研 `/tmp/advisor-design/fork-current.md`；25b0a9 的调研 `/tmp/ccs-coord/advisor-research-25b0a9.md`（下文记为 R25，以文件开头的更正记录为准）
- **证据边界**：官方行为来自静态阅读 minify 后的模块，没有用真实账号运行。fork 调用点按 dev f72df3f3 核对

## 2. 目标

本地构建默认提供和官方 2.1.325 一致的 advisor：主模型在关键节点调用服务端 `advisor` 工具，由更强的模型审查整段对话后给出建议。具体要求：

- 不读远程开关。只有设置了 `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL` 才打开，`CLAUDE_CODE_DISABLE_ADVISOR_TOOL` 优先关闭（第 10 节；最初的方案是默认开启）。
- 不按 rank 限制搭配（第 10 节）。provider、请求形状、拒绝后重发、`/advisor`、`--advisor`、启动提示、transcript 显示、计费、subagent、fork、压缩和恢复，都按官方的行为和原文实现。
- 有意的偏差写在第 7 节，每条附原因。

## 3. 官方行为摘要

细节和来源偏移见 official.md，这里只列实现要对齐的点。

| 方面 | 官方 2.1.325 |
| --- | --- |
| 请求 | beta `advisor-tool-2026-03-01`；tool `{type:'advisor_20260301', name:'advisor', model}`，不发 `max_uses`、`max_tokens`、`caching`。beta 在 `Pin() && (Lx() \|\| advisorModel !== undefined)` 时推送。请求不带 advisor 时总是剥掉历史里的 advisor 块，删空的 assistant 消息补 `[Advisor response]` |
| 挂载 `Pin()` | 未设 `CLAUDE_CODE_DISABLE_ADVISOR_TOOL`、不是 CCR 受限会话、没有记下 process/host 级拒绝；provider 为 firstParty 或 anthropicAws/anthropicGoogleCloud；允许实验 beta（`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` 未设且非 HIPAA） |
| 开关 `Lx()` | `Pin()` 且（`CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL`，或 GrowthBook `tengu_sage_compass2.enabled`，调用处默认值 `{enabled: CD(ke())}`：AWS/GCP 托管为开，firstParty 为关，靠远程下发） |
| rank | 目录字段 `advisor_rank`：haiku-4-5=1，sonnet-4-6=2，opus-4-6=3，haiku-5-5/sonnet-5=4，opus-4-7/4-8=5，sonnet-5-5=6，opus-5/5-5=7，fable-5/mythos-5=8，fable-5-1/mythos-5-1=9，fable-5-2/mythos-5-2=10；更老的模型无 rank。advisor 的 rank 至少为 2 且不低于主模型；任一方无 rank 时配对检查放行，但主模型无 rank 时整体不挂 |
| 别名 | `fable`、`opus`、`sonnet`；picker 和错误提示只列当前可用的别名；`availableModels` 排除的模型不能当 advisor |
| 提示 | 说明文字不进 system prompt，作为 `advisor_tool` attachment 注入成 meta user 消息（system-reminder 包裹）。有完整版、简短版（"The advisor tool is available; the advisor instructions announced earlier apply."）和撤销版（"The advisor tool is no longer available; disregard the earlier advisor instructions."） |
| 每轮状态 | 每次请求前算出本轮 advisor 和要不要写 announcement。主线程按配置的主模型配对，subagent 按自己的模型配对，辅助请求（compact、side question 等）只读不改。mid-conversation tool-change beta 生效时（m0506 `TQ`，见 5.13），tools 里一直放一个 `defer_loading` 的 advisor 条目，`/advisor` 的开和关通过 system 消息里的 `tool_addition`/`tool_removal` 立刻生效，只有 advisor 模型要等 `/clear` 或 `/compact` 才换。beta 不可用或被拒时走回退路径：held 一旦确定就到 `/clear` 或 `/compact` 前不变，中途开、关和换模型都只影响之后的新对话 |
| 拒绝 | 400 里带 `the advisor tool is not available`、`cannot be used as an advisor`、`tools.N.model: `、`Input tag 'advisor_N'` 或 beta header 被拒（422 只认 Input tag）时，去掉 advisor 重发一次。范围：`not available for this organization` 记到进程，Input tag 和 beta 被拒记到 host，其他只记到当前对话。`cannot be used as an advisor when the request model is` 不重发，直接报错 |
| `/advisor` | local-jsx，picker 标题 `Advisor (experimental)`，选项为可用别名、当前完整 id 和 `No advisor`；带参数直接设置；非交互模式打印 `Advisor: X` 和用法 |
| `--advisor` | 隐藏选项，始终注册，只在 `Lx()` 时校验：主模型不支持或 advisor 不可用时报错退出（后台会话只警告），配对失败只警告 |
| 提示 | 启动后 `Advisor Tool (experimental) is on and may use more tokens · /advisor`；配对失败时换成 `Advisor will not activate on the main model …` |
| transcript | Advising（转圈）、Reviewed（Ctrl+O 看全文）、Declined（`stop_reason: refusal`）、Unavailable（error_code 白名单外显示 `unknown`） |
| 计费 | 按 `usage.iterations` 里的 `advisor_message` 分模型计费 |
| fork | 非 compact 类、带上下文的 fork 保留 advisor tool 以复用缓存，并追加 meta 消息 `Never consult the advisor tool.` |
| 恢复 | 从 transcript 最后一个 `advisor_tool` attachment 恢复 held；CCR 会话另外恢复 `advisor_pick` |

## 4. fork 现状和缺口

fork 有一套早期实现，请求、计费和显示的接线都在，但开关读 GrowthBook `tengu_sage_compass`，默认 false。fork 的 GrowthBook 只在设了 `CLAUDE_CODE_ENABLE_ANTHROPIC_TELEMETRY`、firstParty、官方 base URL、没关遥测时才开（`src/services/analytics/config.ts:12-35`），多数用户拿到的是默认值，所以功能实际不可用（R25“结论”，fork-current.md 第 1 行）。

| # | 位置 | 现状 | 缺口 |
| --- | --- | --- | --- |
| 1 | `src/utils/advisor.ts:56-75` | `isAdvisorEnabled()` 读 `tengu_sage_compass`，默认 false；`canUserConfigureAdvisor()` 还要 `canUserConfigure` | 不读 GrowthBook，本地固定为开；补 `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL`、进程/host 拒绝记录 |
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

### 5.1 开关（`src/utils/advisor.ts`）

- `isAdvisorToolAllowed()`（官方 `Pin`）：未设 `CLAUDE_CODE_DISABLE_ADVISOR_TOOL`；没有进程级或当前 host 的拒绝记录；`getAPIProvider() === 'firstParty'`；未设 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`。
- `isAdvisorEnabled()`（官方 `Lx`）：等于 `isAdvisorToolAllowed()`，开了本地 advisor（第 9 节）时也为真。不读 GrowthBook：开了遥测、GrowthBook 生效、远程下发 `tengu_sage_compass2: {enabled:false}` 或没下发时，advisor 仍然开。关闭只靠 `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` 或拒绝记录。`CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL` 只用于跳过 rank 检查。
- 删掉旧的 `tengu_sage_compass`、`canUserConfigureAdvisor()` 和 `getExperimentAdvisorModels()`（官方已没有按 baseModel 下发 advisor 的实验）。
- 拒绝记录：模块级 `processRefused` 和 `refusedHosts`。host 键取 `ANTHROPIC_BASE_URL` 的 host，没设时为 `"default"`。

### 5.2 rank 与别名（`src/utils/advisor.ts`）

- `ADVISOR_RANKS` 照官方表。查表用自己的最长前缀匹配：先 `parseUserSpecifiedModel` 解析别名，去掉 `[1m]`，再在小写 id 里找最长的 key。key 前面不能是字母或数字，后面只能是结尾、`[` 或 `-` 加 8 位日期（可再接 `[`）。`claude-fable-5-3`、`claude-opus-5-1` 这类不认识的小版本没有 rank，不会落到 `fable-5`、`opus-5`。不用 `firstPartyNameToCanonical`，因为它把 `claude-fable-5-2` 归到 `claude-fable-5`。
- 函数一一对应官方：`modelSupportsAdvisor`（SQ）、`canModelAdvise`（rm，rank ≥ 2）、`isUsableAdvisorModel`（CPe，加 `isModelAllowed`）、`isAdvisorPairingAllowed`（H1e，带 rank 跳过）、`isAdvisorPairingAllowedByRank`（XBn：只比 rank，不看 ENABLE 变量，任一方无 rank 时放行；两边都要有 rank 的严格版 xXi 只给 standby 用，见 5.13）、`getAdvisorAliasOptions`（hre）、`resolveAdvisorModel`（o3e，四条 debug 日志和一次性 console.warn 原文照搬）。
- Fable 同意相关的 `n5`、`Gle` 写成恒为 false 的函数并注明原因，见第 7 节。

### 5.3 attachment 与提示文字（`src/utils/attachments.ts`、`src/utils/messages.ts`）

- `Attachment` 加 `advisor_tool`：`{available:true, model, abbreviated?}` 或 `{available:false, model?, byBase?}`。`toolChange` 字段随 5.13 一起做，5.13 确认前不写。
- `normalizeAttachmentForAPI` 渲染成 system-reminder 包裹的 meta user 消息；正文由 `getAdvisorAnnouncementText(available, abbreviated)` 选（官方 `MXi`），完整版用官方 `am` 原文，替换 fork 的 `ADVISOR_TOOL_INSTRUCTIONS`。
- `getLastAdvisorAttachment`（Oin）和 `hasFullAdvisorAnnouncement`（IXi）放在 advisor.ts。
- transcript 里不显示这个 attachment。

### 5.4 每轮解析（新文件 `src/utils/advisorQuery.ts`，`src/query.ts`）

- `resolveAdvisorForQuery(messages, {querySource, setting, configuredModel, requestModel, carrier})` 移植官方 `ggr`，5.13 确认前 `toolChangesRide` 恒为 false（即官方 beta 不可用时的回退路径）：返回 `{announcement?, advisorModel?}`。
- 请求来源分类同官方 `po`：`repl_main_thread*`、`sdk` 为 main；`agent:*`、`hook_agent` 为 subagent；其余为辅助请求，只读 held，不写 announcement。
- carrier：main 用模块级对象，按 sessionId 区分，切换会话时自然换新。按对话的重置挂在 `clearBetaHeaderLatches()`（`src/bootstrap/state.ts`）上：它发一个 signal，advisorQuery.ts 在模块加载时订阅 `resetMainAdvisorCarrier`。`/clear` 和 `/compact` 都经过 `clearSystemPromptSections()` 到这里，与官方把 advisorHeld 和 sticky betas 放在同一个按对话对象里一致。bootstrap 是 DAG 叶子，用订阅避免反向 import。副作用：EnterWorktree、ExitWorktree、setup、resume 和 subagent 的压缩也会调 `clearSystemPromptSections()`。重置后 held 先从 transcript 最后一个 `advisor_tool` attachment 恢复，所以只会丢掉对话级的拒绝记录（下一次请求会再被拒一次并重发），或在还没写过 attachment 时采用当前设置；subagent 每次进入 `query()` 新建；辅助请求用 main carrier 的副本。carrier 为空时先从 transcript 的最后一个 `advisor_tool` attachment 恢复（官方 `_gr`），所以 resume 不需要额外处理。
- query.ts 在算出 `messagesForQuery` 后、构造请求前调用它；有 announcement 时 `createAttachmentMessage` 后 yield 并追加到本轮消息；`advisorModel` 传给 `callModel`，替代 `appState.advisorModel`。

### 5.5 请求（`src/services/api/claude.ts`）

- `advisorModel` 只在 `isAgenticQuery` 或 fork 请求（见 5.8）时生效，并要求 `isAdvisorToolAllowed() && modelSupportsAdvisor(model)`（官方 `PXi`）。
- beta：`isAdvisorToolAllowed() && (isAdvisorEnabled() || advisorModel !== undefined)` 时推送。
- 本次请求不带 advisor 时总是 `stripAdvisorBlocks`；带 advisor 时只剥最后一个 `advisor_stripped` attachment 之前的 assistant 消息（官方 `pq`，见 5.6）。
- 删掉 system prompt 里的 `ADVISOR_TOOL_INSTRUCTIONS`；tool 仍放在 tools 末尾。

### 5.6 拒绝后重发（`src/services/api/advisorRefusal.ts`、`claude.ts`、`src/services/api/errors.ts`）

- `classifyAdvisorRefusal(error, betas)` 移植 `Qlt` 和 `hCn`，返回 `undefined` 或 `{scope: 'process'|'host'|'conversation', betaHeader: boolean}`。
- 请求带了 advisor tool 或 advisor beta 时，错误路径抛 `AdvisorRefusedError`。`queryModelAdvisorRetry` 照 `ToolSearchRefusedError` 的写法接住：记录范围，打官方原文日志，发 `tengu_advisor_entry_refused_retry`，调 `options.onAdvisorRefused()`（query.ts 把 carrier 的 held 置为 `{model: undefined, refused: true}`），然后带 `{advisorModel: undefined, advisorRefused: true}` 重发一次。重发再失败按普通错误处理。
- `cannot be used as an advisor when the request model is` 不重发，生成 `advisor_incompatible` 错误消息，文案按交互和非交互两种。
- 结果块无法处理（官方 `Xlt` 和 `K0o`）：400 里带 `Advisor tool result content could not be processed` 或 `found in advisor_tool_result blocks` 时，错误路径抛 `AdvisorResultUnprocessableError`，`queryModelAdvisorRetry` 接住后带 `advisorBlocksStripped` 重发一次，这次剥掉全部 advisor 块，advisor tool 本身保留。日志原文照官方：没有可剥的块时 `… nothing to remove, retrying as sent.`，否则 `… retrying with the advisor blocks removed from N message(s); recorded, so later requests leave them out too.`（或 `not recorded, …`）。发 `tengu_advisor_strip_retry {query_source, strip_recorded, stripped_message_count, thinking_also_stripped}`。剥掉了块且调用方给了 `onAdvisorBlocksStripped` 时算 recorded：query.ts 在重发的第一条流消息前 yield 一个 `advisor_stripped` attachment 并追加到本轮消息。这个 attachment 不发给 API、transcript 里不显示，之后的请求按它剥掉之前的 advisor 块。拒绝重发和剥块重发在同一个循环里，各最多一次。
- 自定义 `ANTHROPIC_BASE_URL` 与 firstParty 同样对待，只走上面这条官方路径。

### 5.7 `/advisor`（`src/commands/advisor/`）

- 照 `/model` 的结构：`index.ts` 导出 local-jsx 的 `advisor`（description `Let Claude consult a stronger model at key moments`，argumentHint `[fable|opus|sonnet|off]`，`isEnabled: isAdvisorEnabled`）和非交互版 `advisorNonInteractive`。
- 共用的写入函数 `setAdvisorFromCommand`（官方 `VDt`）：文案 `Advisor set to …`、`Advisor disabled`、`… cannot be used as an advisor. Valid options: …`、两条 Note、held 状态说明（官方 `y()`）全部照原文；写 AppState 和 `userSettings.advisorModel`；远程模式加 ` (this session only)`；发 `tengu_advisor_command`。
- picker 移植 m2819：标题 `Advisor (experimental)`、说明、主模型不支持时的警告、可用别名加当前完整 id 加 `No advisor`、推荐语和链接；发 `tengu_advisor_dialog_shown`。
- 非交互：`The advisor is not available`；无参数或 help 时 `Advisor: X` / `Advisor: off` 加 `Usage: /advisor <…|off>`；`unset` 等同 `off`。

### 5.8 fork、压缩和 subagent（`src/utils/forkedAgent.ts`、`src/services/compact/`、`src/query.ts`）

- `CacheSafeParams` 加 `advisorModel?: string`，取主线程本轮实际挂上的 advisor（query.ts 发出 cacheSafeParams 时带上）。
- `runForkedAgent` 把它固定给 fork 的 query：fork 不做每轮解析，直接用这个值；claude.ts 对 fork 请求同样允许挂 advisor（官方 `forkPointUuid` 分支）。
- 带上下文、label 不是 `compact`、`reactive-compact`、`resume_cache_warm` 的 fork，在 `isAdvisorEnabled()` 且本轮带了 advisor 时追加 meta 消息 `Never consult the advisor tool.`，tool 保留，以免破坏缓存前缀。拼写照官方 `GXr`；fork 的 forkLabel 目前只有 `compact`，后两个不存在，所以实际只排除 `compact`。
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

### 5.13 对话中途开关（mid-conversation tool-change beta）

状态：已实现（用户确认“补上 tool-change beta”）。beta 生效时中途 `/advisor` 开、关立刻生效，换模型仍等 `/clear` 或 `/compact`；beta 不可用或被拒时回到原来的回退路径，开、关、换模型都等 `/clear` 或 `/compact`。

官方机制（2.1.325 静态阅读）：


- beta `mid-conversation-tool-changes-2026-07-01`（m0175 `nE`）。getMergedBetas 在 `UVr() && F_e(model)` 时加入（m0207）；`UVr()` 是 GrowthBook `tengu_foamy_spring`，默认 true。
- 生效条件 `TQ(sticky, model)`（m0506）：`(本对话已发且未被拒 || UVr() && 本对话未拒) && !z(sticky) && F_e(model)`。`z` 为真的情况：本对话拒过 mid-conversation-system beta、host 级 `toolChangeHeaderRefused` 已记下、`nUe()` 为假（在没抽取的模块里）。sticky betas 是每个对话的 `{sent, rejected}`，`/clear`、`/compact` 清空。
- 模型条件 `F_e(model)`：`OS() && AS(model) && (CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM || 不在 toolChangeUnsupportedModels 且（目录能力 mid_conv_tool_change，或不在目录里，或是 claude-mythos-5）)`。目录里有这个能力的是 haiku-5-5、sonnet-5-5、opus-4-8、opus-5、opus-5-5、fable-5、fable-5-1、fable-5-2、mythos-5-1、mythos-5-2；`AS` 对 opus-4-8 之前的模型和 claude-3 为假。
- 工具变化的载体：advisor_tool attachment 带 `toolChange` 时，变成 api_system 消息里的 op `{op:'add'|'remove', name:'advisor'}`，线上是 `{role:"system", content:[…, {type:"tool_addition"|"tool_removal", tool:{type:"tool_reference", name:"advisor"}}]}`，最后一块带 cache_control（m0643 `Lna`）。这条消息需要另一个 beta `mid-conversation-system-2026-04-07`（`PS`），它有自己的拒绝处理（YO/SDe，被拒时连 `nE` 一起去掉）。
- 请求条目（m0643）：`Nc = advisorDeferred && advisor && betas 含 nE && 有不是 deferred 的工具`；`advisorDeferred && advisorActive === false && !Nc` 时不挂，否则挂 `{type:'advisor_20260301', name:'advisor', model, ...(Nc && {defer_loading:true})}`。
- standby（m0913 `x()`）：对话还没有 advisor 时预挂一个 deferred 条目。要求 firstParty 且是官方 base URL、`Lx()`、`SQ(model)`、能计费（API key，或 pro/max/team 订阅）；取 `hre` 里第一个能和主模型严格配对（`xXi`）的别名。
- 被拒（`TDe`）：400 带 Q7s 码为 model_unsupported，按模型记；400/422 的 Input tag `tool_(addition|removal)` 为 block_type_unknown，beta header 被拒为 header_rejected，这两种记 host 级 latch。日志 `[late-tool-additions] tool_addition rejected (…) — falling back … sticky-rejecting the beta until /clear or /compact`，去掉 `nE` 重发，之后 `MLt` 回退；fallback 模型下置 `inFallback`。
- held 带 `viaToolChange`。`y()` 在 beta 生效时的原文：`…keeps X as its advisor model until /clear or /compact, so the tool it has already declared stays unchanged; turning the advisor on or off applies right away.`

fork 的实现：

1. betas（`src/utils/advisorToolChanges.ts`、`src/utils/betas.ts`）：getMergedBetas 在 `isAdvisorToolAllowed()`、未被 host latch 挡住、`F_e(model)` 时同时加 `nE` 和 `PS`。`tengu_foamy_spring` 不读，按默认 true。`applyToolChangeBetas`（官方 `xna`）按对话的 sticky `{sent, rejected, systemRejected}` 保留或去掉两个 beta；没有对话状态的请求（side query 等）一律不带。
2. `TQ` 照官方算（`toolChangesRide`），sticky 挂在 advisor carrier 上，随 `clearBetaHeaderLatches()` 清空。
3. 消息转换（`src/utils/messages.ts`、`src/utils/advisorToolChangeWire.ts`）：带 `toolChange` 的 advisor_tool attachment 在 normalizeMessagesForAPI 里变成占位块，合并消息时保持位置；addCacheBreakpoints 之后 `splitAdvisorToolChanges` 在占位处切开 user 消息，插入 `{role:"system", content:[{type:"text"}, {type:"tool_addition"|"tool_removal", tool:{type:"tool_reference", name:"advisor"}}]}`。system 消息总跟在 user 内容之后，对话不以 system 开头。其他 attachment 仍用 system-reminder。
4. 请求条目（`src/services/api/claude.ts`）按 `Nc` 规则挂 `defer_loading`；deferred 且未激活又不能 defer 时不挂。standby 用严格配对 `isAdvisorPairingAllowedStrict`（官方 `xXi`）。
5. 每轮解析（`src/utils/advisorQuery.ts`）移植 ggr 的 viaToolChange、standby、inFallback 分支和 advisorActive/advisorDeferred；describeHeldAdvisor 补 viaToolChange 原文。
6. 拒绝：`TDe` 各类和 system turn 被拒（`YO`）都抛 `ToolChangesRejectedError`，记到 sticky 或 host/模型 latch，去掉两个 beta 重发一次，之后走回退路径（inline 条目加 system-reminder）。advisor 本身的拒绝仍按 process/host/conversation 记录，两套互不覆盖。
7. 测试：`src/services/api/claude-advisor-contract.test.ts`（中途开、关且 tools 前缀不变，beta 被拒和 system turn 被拒后回退，standby 条目形状，无对话状态不带 beta）、`src/utils/advisorToolChanges.test.ts`、`src/utils/advisorQuery.test.ts`、`src/services/api/advisorRefusal.test.ts`、`src/utils/advisor.test.ts`。

与官方的差异见第 7 节“中途开关”几行。

## 6. 测试计划

单元测试断言具体文本和请求内容，按模块放在被测文件旁边（`*.test.ts`）。

| 范围 | 用例 |
| --- | --- |
| 挂载矩阵 | 五个 provider（只有 firstParty 开）× `DISABLE_ADVISOR_TOOL` / `ENABLE_EXPERIMENTAL` / `DISABLE_EXPERIMENTAL_BETAS`；GrowthBook 返回 `{enabled:false}` 和不下发时仍然开；进程级和 host 级拒绝后 `isAdvisorToolAllowed()` 为 false，换 host 后恢复；运行中切到 OpenAI 时请求不带 beta、不带 tool、剥掉历史 advisor 块 |
| rank | 官方表每一项；`fable-5-2` 不落到 `fable-5`；`fable-5-3`、`opus-5-1`、`sonnet-5-12` 无 rank；8 位日期后缀和它的 `[1m]` 有 rank，7 位没有；别名、`[1m]` 后缀；无 rank 模型；`ENABLE_EXPERIMENTAL` 跳过；`availableModels` 排除 |
| 每轮解析 | 首次完整 announcement；已有完整版时不重复；主模型不支持时 `byBase` 撤销，切回后发简短版；held 不随设置变化；refused 后发 `{available:false}`；subagent 用自己的模型；辅助请求不写 announcement；从 transcript 恢复 |
| 请求 | tool 形状和位置、beta 推送条件、不带 advisor 时剥块、system prompt 不再含说明文字；OpenAI 和 ChatGPT 模式下 tools 和 beta 与改动前一致 |
| 拒绝 | 各类错误文本的分类和范围；只重发一次，重发请求不带 tool；host/process 范围下后续请求不带 beta；`advisor_incompatible` 文案；结果无法处理时剥块重发一次、tool 保留、事件和 recorded 判断、没有可剥的块时原样重发；`advisor_stripped` 之后的请求只剥它之前的块 |
| 命令 | `/advisor` 各分支文案、picker 选项和文本、非交互输出、回退路径下的三条 held 说明；完全关闭时两个 `/advisor` 命令不可用；`--advisor` 三种情况和 bg 降级，完全关闭时不校验（tmux 验收） |
| 显示 | 四种状态和 verbose；error_code 白名单 |
| 其他 | 计费；fork 的 advisorModel 和 `Never consult the advisor tool.`；手动压缩不带 advisor；`clearBetaHeaderLatches()` 后 carrier 重置 |
| 中途开关（5.13） | 中途开（带 beta、tools 前缀不变）、中途关、beta 被拒后回退、standby 条目形状 |

验证命令：直接相关和相邻的测试文件、`bunx tsc --noEmit --pretty false`、`bun run lint`。机器负载高，不并行跑全量单测。

交互验收：`make build` 后在 tmux 里用本地假 API（Bun 写的 HTTP 服务，按请求里的 tools 返回 `server_tool_use` 加 `advisor_tool_result` 的 SSE）检查启动提示、`/advisor` picker、一次 Reviewed 和一次 Unavailable、`--advisor` 给一个不能当 advisor 的模型时报错退出（haiku 解析到 Haiku 5.5，rank 4，可以当 advisor，所以改用 rank 不足或无 rank 的模型）。证据存到 `/tmp/advisor-design/accept/`。

## 7. 与官方的差异

| 项 | 官方 | fork | 原因 |
| --- | --- | --- | --- |
| provider | firstParty、anthropicAws、anthropicGoogleCloud | 只有 firstParty（含自定义 `ANTHROPIC_BASE_URL`） | fork 没有后两个 provider，按用户决定只放行 firstParty |
| 开关默认值 | firstParty 靠 GrowthBook `tengu_sage_compass2` 下发，默认关 | 不读 GrowthBook，本地固定为开；远程下发 false 也不关 | 按用户决定不依赖远程开关；fork 的 GrowthBook 只在开了遥测时生效 |
| 中途开关：beta 范围 | `PS` 单独按模型发，`nE` 也服务 ToolSearch | `nE`、`PS` 只为 advisor 发且总是一起发；PS 被拒时连 nE 一起去掉，反之亦然；无对话状态的请求不带 | fork 不发其他 role:"system" 消息（`src/constants/leanPrompt.ts`），ToolSearch 不走这条路径 |
| 中途开关：latch 和能力 | host latch `toolChangeHeaderRefused`；`F_e` 读模型目录；`nUe` 含 HIPAA 等判断；`UVr` 读 GrowthBook | host latch 按 base URL 的 host 记；`F_e` 用本地模型表；不判断 HIPAA；`UVr` 固定为真 | fork 没有模型目录能力字段和 HIPAA 状态，不读远程开关 |
| 中途开关：standby 计费 | `modelAccessCache` | 用 served model catalog 代替 | fork 没有 modelAccessCache |
| 中途开关：线上消息 | 一等的 `api_system` 消息类型，cache_control 可落在 system turn 上 | 占位块加请求前切分；cache breakpoint 留在前一个 user 块上 | 改动面限在 advisor；缓存前缀仍保持不变（有测试） |
| 中途开关：其他 | `Nc` 只看主工具表；inFallback 对所有 held 更新 | `Nc` 也计 extraToolSchemas；inFallback 只在 viaToolChange 时更新；forked agent 遇到未激活的 deferred 条目时不发 `Never consult the advisor tool.` | fork 的调用方式不同；未激活条目模型本来就调不到 |
| `fable` 别名 | 解析到 claude-fable-5-2 | 解析到 claude-fable-5-1（`src/utils/model/model.ts:133-140`），模型表里没有 5-2 | fork 模型表的现状。`/advisor fable` 得到 Fable 5.1；主模型用完整 id 指定 Fable 5.2 时，`fable` 会被判为能力不足 |
| fork 标签 | 排除 `compact`、`reactive-compact`、`resume_cache_warm` | 照写，但 fork 只有 `compact` 这个标签 | fork 没有另外两种 fork |
| Fable 同意 | 需要 usage credits 的 Fable 先在 `/model` 同意 | 不做，Fable 与其他模型同样对待 | fork 没有 claude.ai 订阅状态和同意流程 |
| `advisor_pick` | CCR 会话把 advisor 选择写进 internal metadata 并在恢复时还原 | 不做 | fork 的 CCR 恢复只读 external_metadata，也无法在本地验证 |
| extractMemories 跳过 | MCP 账户记忆路径在 advisor 撤不下时跳过 | 不适用 | fork 的 extractMemories 没有 MCP 模式 |
| 结果无法处理时剥块重发 | 剥掉 advisor 块重发并记录；必要时连之后的 thinking 一起剥；partial compact 和 rewind 会重新追加 `advisor_stripped`；compact 带 `advisorStripPlan` 重放 | 剥块、日志、事件、`advisor_stripped` 和后续按它剥块照官方；不剥 thinking（`thinking_also_stripped` 恒为 false）；partial compact、rewind 不重新追加；auto-compact 的摘要请求读同一批消息，按 attachment 剥块 | fork 没有 `thinking_stripped` 基础设施，也没有 partial compact |
| 按对话重置的入口 | advisorHeld 和 sticky betas 在同一个按对话对象里 | 挂在 `clearBetaHeaderLatches()` 上，worktree 切换、setup、resume 和 subagent 压缩也会触发 | 见 5.4；held 从 attachment 恢复，影响只限对话级拒绝记录 |
| `advisor_incompatible` | 不重发，显示 `advisor_incompatible` 报错 | 当作对话级拒绝，去掉服务端条目重发，由本地 advisor 回答（第 10 节） | 搭配由用户决定，不在客户端限制 |
| CCR 受限会话、HIPAA | 关闭 advisor | 不判断 | fork 没有这两个状态 |
| 只读客户端 | `/advisor` 拒绝修改 | 不判断 | fork 没有对应的 view-only 连接 |
| Fable、Mythos 的 rank | `ra()` 只在组织能用 Fable（`j0e()`）、启用了 Mythos（`V2o()`）时才给这两个系列 advisor rank；否则它们不能当顾问，`/advisor` 也不列出 | 总是给 rank（`src/utils/advisor.ts:161-180`、`:209`），`/advisor` 总是列出 `fable` | fork 没有组织级的模型可用性状态。组织用不了时服务端怎么回应没有验证过 |
| 没配 advisor 时的 beta | firstParty 的 advisor 默认关，不配就不带 advisor beta；`nE`、`PS` 由 `tengu_foamy_spring` 和模型目录决定，与 advisor 无关 | 不设开关时都不带（第 10 节）。设了开关时，Claude 模式下没配 advisor 的请求也带 `advisor-tool-2026-03-01`；主模型在 `TOOL_CHANGE_MODELS` 里，或模型名不在本地模型表里时（`modelSupportsToolChanges` 对未知模型名返回 true，`src/utils/advisorToolChanges.ts:66-82`），主对话和子代理的请求还带 `nE`、`PS`。自定义 `ANTHROPIC_BASE_URL` 也一样 | 按用户决定默认开、网关拒绝不特殊处理。tmux 加假 API 实测：网关按 Anthropic 的措辞拒绝时，去掉后重发并按 host 记住（第一轮多发两次请求）；用其他措辞拒绝（如 `unsupported beta flag`）时每一轮都是 `API Error: 400`，要设 `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`。官方 `F_e` 对目录外模型的处理只见于该文件的注释，没有单独核对 |

## 8. 风险和未决项

- OpenAI 模式不挂服务端 advisor。设了开关时由第 9 节的本地 advisor 回答。
- 5.13 的 system turn 放在 user 之后、text 块不包 system-reminder，这两点和 cache breakpoint 的位置只按官方静态阅读实现，服务端接不接受只能用真实账号验证；假 API 只检查形状。被拒时有回退。

- 设了开关时，firstParty 上没配 advisor 的请求也带 `advisor-tool-2026-03-01`。自定义网关不认识这个 beta 时，第一次 400 会走官方的“beta 被拒，按 host 记住并重发一次”路径；用户也可以去掉开关或设 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`。
- 说明文字从 system prompt 移到 attachment 后，已有会话恢复时历史里没有 attachment，第一轮会补发完整版，多一次 meta 消息。
- 官方 `ra` 按目录取 rank，目录外的模型没有 rank。fork 按 id 匹配，限定了 key 前后的字符（5.2），自定义 id 里含完整官方名字（如 `my-claude-opus-5`）时仍会被当成该模型。
- 官方行为来自静态阅读，没有真实账号对照；假 API 验收只覆盖渲染和请求形状。

## 9. 本地 advisor（官方没有）

背景：[#1388](https://github.com/Esonhugh/claude-code/issues/1388)。有的网关不运行服务端 advisor 工具，带 `advisor_20260301` 的请求被拒绝、被丢掉，或者模型发回一个普通的 `tool_use(name=advisor)`，没有人执行。本地 advisor 把 `advisor` 做成客户端执行的普通工具。设了开关（第 10 节）后服务端 advisor 优先，它用不了的请求由本地 advisor 回答。

- **服务端优先**：第 5 节的状态机照常运行。`isAdvisorToolAllowed()`（开关打开、没有进程或 host 级拒绝、firstParty、没设 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`）为真时，`resolveAdvisorModel` 给出服务端条目的模型，`canCarry` 和 `claude.ts` 挂工具条目时只再看 `availableModels`。
- **本地退避**：`toAdvisorRequest` 在请求没有声明服务端条目（`advisorModel` 为空）时，把 `getLocalAdvisorModel(setting)` 记到 `AdvisorRequest.localAdvisorModel`。没有服务端条目的情况包括：接入方式不支持、设了 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`、服务端拒绝过（`held.refused` 或进程、host 级的拒绝记录）、对话开始时没有顾问而主模型不支持中途开关。fork 沿用父请求的 `advisorPin`，其中也带这个字段。请求声明了服务端条目、模型却发回普通的 `tool_use(name=advisor)` 时，工具仍在 `toolUseContext.options.tools` 里，照常由本地执行。
- **拒绝后重发**（`claude.ts` 的 `queryModelAdvisorRetry`）：Anthropic 措辞的拒绝按 `classifyAdvisorRefusal` 分范围，包括 `cannot be used as an advisor when the request model is`（对话级）。别的措辞的 400 或 422，只要请求带着服务端条目、`isUnattributedRequestError` 为真（不是计费错误、不是 `prompt is too long`），抛 `AdvisorUnattributedError`，去掉顾问重发一次；重发得到回复才调用 `onAdvisorRefused`，重发也失败时不记录，报错照常显示。这个判断排在 tool search 的判断之前，否则后者会先去掉延迟加载的工具重发，并在重发成功后把 tool search 关掉。两种重发都用 `Options.advisorRetryTools` 作为工具列表：`query.ts` 在请求带服务端条目、不是 fork、`getLocalAdvisorModel(setting)` 有值时传入完整的工具列表（含本地 `advisor`），所以重发的那次请求就能调用本地 advisor。
- **公告**（`src/query.ts`）：由本地 advisor 回答的请求不发“advisor 不再可用”的普通公告，因为对话里仍然有 `advisor` 工具；以 tool_removal 形式发送的公告照发。`describeHeldAdvisor` 在之后的请求由本地 advisor 回答时返回空串，对话仍带着服务端顾问时照旧说明。
- **工具**（`src/tools/AdvisorTool/`）：名字 `advisor`，无参数，只读，可并发。只在开关打开时注册（`src/tools.ts`）。每次请求由 `omitLocalAdvisorTool`（`src/query.ts`）按 `localAdvisorModel` 决定带不带：请求声明了服务端条目或没选顾问时不带。工具说明用官方的使用指引（`ADVISOR_GUIDANCE`，与服务端说明共用），开头一段另写，不说顾问更强。
- **顾问收到的内容**（`transcript.ts`）：一条 user 消息里的文字记录。来源是 `normalizeMessagesForAPI(prependUserContext(context.messages, userContext))` 加上当前这次回复已经流出的 assistant 消息。后者通过 `ToolUseContext.getResponseMessages` 取得，因为 `context.messages` 不含正在进行的回复。不发真实的 tool_use 和 thinking 块：别的模型的 thinking 签名和没有工具定义的 tool_use 在网关上容易被拒。正在被回答的那次 advisor 调用不写进记录。超过 `(顾问上下文窗口 − 40,000) × 3` 个字符时去掉中间。
- **请求**（`AdvisorTool.ts`）：`queryModelWithoutStreaming`，无工具，单独的系统提示词，沿用会话的 thinking 设置，`querySource: 'advisor'`，不开 prompt cache。用量由通用管线记在顾问模型名下。请求不带 `advisor-tool-2026-03-01`。重试上限是 2 次和 `getDefaultMaxRetries()` 中较小的一个（`Options.maxRetries`）；会话默认的 10 次在网关没有这个模型时要等将近三分钟。API 报错或回复为空时抛出带模型名的错误，成为工具错误。
- **fork**：`runForkedAgent` 的 fork（上下文里有 `advisorPin`）调用时直接报不可用，不发请求。工具仍留在 fork 的工具列表里，与父对话的缓存前缀一致。
- **未做**：网关用自己的措辞拒绝、且请求没有带服务端条目（只带 beta 标识）时不重发；`'advisor'` 不在 529 重试的前台来源里；不给顾问发主模型的系统提示词；后台子代理的工具白名单里没有 `advisor`。
- **验证**：单测见 `src/utils/advisor.test.ts`、`src/utils/advisorQuery.test.ts`、`src/commands/advisor/setAdvisor.test.ts`、`src/tools/AdvisorTool/transcript.test.ts`、`src/query.localAdvisor.test.ts`、`src/services/api/claude-advisor-contract.test.ts`。真实网关上的运行见 `docs/features/advisor.md` 的说明一节。

## 10. 显式开关和去掉等级表（2026-11-18）

按用户决定修订，与前面各节冲突时以这里为准。

- **开关**：`isAdvisorEnabled()` 只在设了 `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL`、没设 `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` 时为真。不设时服务端条目、advisor beta、`nE`/`PS`、本地 `advisor` 工具和 `/advisor` 都没有。`CLAUDE_CODE_ENABLE_LOCAL_ADVISOR_TOOL` 去掉，设了也不起作用。`--advisor` 在开关关闭时向 stderr 打印警告并继续（后台会话写调试日志）。
- **没有等级表**：删掉 `ADVISOR_RANKS` 和所有配对规则。`isValidAdvisorModel` 只看 `availableModels`，任何允许的模型都可以给任何主模型或子代理当顾问。`--advisor` 只检查 `availableModels`；启动提示只有一条，不再按配对结果区分。
- **`/advisor` 的候选**：`getAdvisorModelOptions()` 取 `getModelOptions()`（`/model` 用的那份，已按 `availableModels` 过滤），去掉 Default 一行。输入的名字不区分大小写地匹配候选和别名，匹配不上时按输入保存；交互界面里不是别名、也不在候选里的名字先用 `validateModel` 确认。
- **去掉 standby**：对话开始时没有顾问时不再预先声明延迟加载的条目（官方 m0913 `x()`）。之后选上顾问时，支持中途开关的主模型用 `tool_addition` 加入服务端条目（工具列表变一次，prompt cache 重建一次），其他主模型由本地 advisor 回答。
- **搭配不兼容**：`cannot be used as an advisor when the request model is` 不再单独显示报错（`errors.ts` 里的提示删除），按对话级拒绝去掉服务端条目重发。
- **认不出的 400/422**：不再要求单独的本地开关，带服务端条目的请求都适用。
- **`modelSupportsToolChanges`**：不再依赖等级表的 key，改为不支持的模型列表 `NO_TOOL_CHANGE_MODELS`（haiku-4-5、sonnet-4-6、opus-4-6、sonnet-5、opus-4-7），已知 id 的结果与之前相同，未知模型名仍视为支持。`modelSupportsSystemTurns` 另外排除早于 claude-opus-4-8 的模型（`isModelOlderThan`，含全部 Claude 3），所以 Sonnet 4.5、Opus 4.5、Opus 4.1 等也不支持。
