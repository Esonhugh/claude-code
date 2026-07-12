# built-claude / official-claude Request Shape Parity Report

Date: 2026-06-28

## Scope

目标是基于本地 MITM request summary 和当前源码，深入研究 `built-claude` 与 `official-claude` 在 CCH checksum 已对齐之后仍存在的 request shape 差异：

- `tools` 数组差异；
- `output_config` 差异；
- system prompt 精简与 token 节约机制差异。

本报告只记录本地授权调试证据和源码链路，不包含完整请求 body、token、cookie、Authorization header、完整私有 prompt 或证书材料。

## Evidence

### Runtime-observed MITM summary

本次使用同一 prompt、同一 inline settings、同一 loopback MITM proxy，对 `./built-claude` 与 `./official-claude` 分别捕获请求。

Artifact root:

```text
/tmp/claude-cch-parity-again-N2ww6T
```

两边 `/v1/messages?beta=true` 请求均成功捕获，进程退出状态均为 `0`。

| target | body bytes | cch existing | cch computed | cch match | tools | output_config | system text total |
|---|---:|---|---|---|---:|---|---:|
| built | `97073` | `65a19` | `65a19` | `true` | `12` | `None` | `26544` |
| official | `74276` | `647f6` | `647f6` | `true` | `8` | `{ effort: "high" }` | `6455` |

结论：CCH checksum 行为已经对齐；当时剩余差异集中在工具暴露、`output_config` 和 system prompt 大小。后续 `output_config` 已做最小实现并完成新的 built-side wire 复验。

### Source-confirmed request construction path

`src/query.ts:664` 调用 `deps.callModel()`，传入：

- `systemPrompt: fullSystemPrompt`；
- `tools: toolUseContext.options.tools`；
- `options.effortValue: appState.effortValue`；
- `options.taskBudget` 等请求上下文。

`src/services/api/claude.ts:1138` 开始判断 tool search 是否启用；`src/services/api/claude.ts:1174` 在启用时只保留 non-deferred tools、`ToolSearchTool` 以及已发现的 deferred tools。

`src/services/api/claude.ts:1259` 将过滤后的工具转成 API schema。

`src/services/api/claude.ts:1381` 组装最终 system prompt：

1. `getAttributionHeader(fingerprint)`；
2. `getCLISyspromptPrefix(...)`；
3. 原始 `systemPrompt`；
4. optional advisor/chrome instructions。

`src/services/api/claude.ts:1583` 创建 `outputConfig`，`src/services/api/claude.ts:1587` 调用 `configureEffortParams()`，`src/services/api/claude.ts:1748` 只有在 `outputConfig` 非空时才发送顶层 `output_config`。

`src/tools.ts:198` 是基础工具列表来源，`src/tools.ts:224` 在 `isTodoV2Enabled()` 为 true 时加入 `TaskCreateTool` / `TaskGetTool` / `TaskUpdateTool` / `TaskListTool`，`src/tools.ts:230` 可通过 `ENABLE_LSP_TOOL` 加入 LSP，`src/tools.ts:253` 在 optimistic tool search 开启时加入 `ToolSearchTool`。

`src/utils/toolSearch.ts:174` 定义 tool search mode，默认 `ENABLE_TOOL_SEARCH` 未设置时为 `tst`，即默认启用 deferred tool search。`src/utils/toolSearch.ts:272` 的 optimistic check 决定 `ToolSearchTool` 是否进入 base tools。`src/utils/toolSearch.ts:387` 的 definitive check 决定每次请求是否真正启用动态工具加载。

`src/constants/prompts.ts:107` 定义 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`，说明 boundary 前的静态内容可以使用 global cache，boundary 后是用户/session 动态内容。`src/services/api/claude.ts:1400` 使用 `buildSystemPromptBlocks()` 将 prompt 转为 API system blocks，并基于 cache/global scope 策略设置 cache control。

## Request differences

### 1. CCH checksum

两边都包含 billing pseudo-header，且 checksum 重算匹配：

```text
built:    cch=65a19 computed=65a19 match=true
official: cch=647f6 computed=647f6 match=true
```

这是 CCH attestation 修复后的正向证据。built 不再缺失 `cch`。

### 2. `tools` array

MITM body 摘要显示：

```text
built tools_count=12
official tools_count=8
```

built 工具名：

```text
Agent
Bash
Edit
Glob
Grep
InteractiveTerminal
Read
Skill
ToolSearch
Workflow
WorkflowTool
Write
```

official 工具名：

```text
Agent
Bash
Edit
Read
Skill
ToolSearch
Workflow
Write
```

差异：

| only in built | likely source |
|---|---|
| `Glob` | `src/tools.ts:207`：当 `hasEmbeddedSearchTools()` 为 false 时加入 `GlobTool` / `GrepTool` |
| `Grep` | 同上 |
| `InteractiveTerminal` | `src/tools.ts:203` 默认 base tool |
| `WorkflowTool` | `src/tools.ts:130` / `src/tools.ts:239` workflow tools 展开后包含多个 workflow 相关工具 |

初步判断：official 的二进制/运行配置更精简，可能满足 `hasEmbeddedSearchTools()`，因此不需要暴露 `Glob` / `Grep`；同时 official 当前运行场景没有暴露 `InteractiveTerminal` 和第二个 workflow facade/tool。built 当前项目配置则把这些工具直接带入 API schema。

更细归因：

- `Glob` / `Grep` 是 build/runtime gate 差异，不应在普通源码构建中硬删。`src/utils/embeddedTools.ts:15` 只有 `EMBEDDED_SEARCH_TOOLS` truthy 且 entrypoint 不是 `sdk-ts` / `sdk-py` / `sdk-cli` / `local-agent` 时返回 true；`src/tools.ts:204` 注释说明 ant-native build 内嵌 `bfs` / `ugrep` 后，才移除 dedicated `Glob` / `Grep`。
- `InteractiveTerminal` 当前是默认基础工具：`src/tools.ts:203` 直接加入 `InteractiveTerminalTool`，`src/tools/InteractiveTerminalTool/InteractiveTerminalTool.ts` 未提供 print-mode gate。若要对齐 official，需要先确认 official 是 release gate、settings gate 还是非交互模式 gate，而不是直接删除。
- `WorkflowTool` 与 `Workflow` 来自同一个 `workflowTools` 数组：`src/tools.ts:130` 初始化 bundled workflows 并返回 `WorkflowTool` 与 `WorkflowFacadeTool`；`src/tools.ts:239` 在默认 base tools 中展开。`src/tools.ts:293` 的 simple mode 只有 `isWorkflowScriptsFeatureEnabled()` 时才加入 workflow tools，但正常模式总是加入两个 facade。若 official 只暴露 `Workflow`，最小候选是给 inspect/status 型 `WorkflowTool` 加 runtime gate，保留 facade；仍需 official runtime 证据。

Debug log 也显示 deferred tool 规模不同：

```text
built:    Dynamic tool loading: 0/52 deferred tools included
official: Dynamic tool loading: 0/17 deferred tools included
```

这说明两边除最终发送的 inline tools 不同之外，候选 deferred tool pool 也不同。即使 deferred tools 没有 inline 进入 `tools` 数组，它们仍可能通过 `<available-deferred-tools>` 或 delta attachment 影响消息/system prompt 与 cache key。

### 3. `output_config`

MITM body 摘要显示当时的基线差异：

```text
built:    output_config=None
official: output_config={'effort': 'high'}
```

源码链路：

- `src/services/api/claude.ts:1482` 计算 `effort = resolveAppliedEffort(options.model, options.effortValue)`；
- `src/services/api/claude.ts:1587` 调用 `configureEffortParams(effort, outputConfig, ...)`；
- `src/services/api/claude.ts:453` 如果 model 不支持 effort 或 `outputConfig` 已有 effort，则返回；
- `src/services/api/claude.ts:457` 当 `effortValue === undefined` 时处理默认 effort；
- `src/services/api/claude.ts:462` 当 `effortValue` 是 string 时写 `outputConfig.effort = convertEffortValueToLevel(effortValue)`；
- `src/services/api/claude.ts:1748` 只有 `outputConfig` 非空时才发送顶层 `output_config`。

`src/utils/effort.ts:161` 的 `resolveAppliedEffort()` 会按 `CLAUDE_CODE_EFFORT_LEVEL`、`appState.effortValue`、model default 解析实际 effort；`src/utils/effort.ts:193` 则说明 UI display 会把未发送 effort 的情况显示为 `high`，但 display fallback 不等于 wire 上一定发送 `output_config.effort`。

后续已做最小 request-format parity 改动：`src/services/api/claude.ts:457` 在 first-party provider 且 `effortValue === undefined` 时显式写入 `outputConfig.effort = 'high'`，同时保留 OpenAI / Bedrock / Vertex / Foundry 的默认不写入行为。该改动由 `src/services/api/claude-effort.test.ts` 覆盖。

新的 built-side MITM 复验证据：

```text
summary: /tmp/claude-built-effort-cch-summary-config-2.json
artifact root: /var/folders/4h/pgbsmxdx3wj12mb6mkj90gmh0000gp/T/claude-mitm-cch-run-U5Tw96
request: POST /v1/messages?beta=true
output_config: { effort: "high" }
cch_existing: 6c8f2
cch_computed: 6c8f2
cch_match: true
tools_count: 12
system text total: 26845
```

该复验使用临时 `CLAUDE_CONFIG_DIR` 覆盖 `CLAUDE_CODE_ATTRIBUTION_HEADER=1` 与 `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`。原因是用户级 `~/.claude/settings.json` 当前把 `CLAUDE_CODE_ATTRIBUTION_HEADER` 设为 `0`，会覆盖 shell env 并导致 billing pseudo-header/CCH 不出现。

### 4. System prompt size and hashes

MITM body 摘要显示两边 `system_count=4`，但内容长度差异很大：

| block | built len | official len | observation |
|---:|---:|---:|---|
| 0 | `86` | `81` | billing header；sanitize 后 hash 一致 |
| 1 | `62` | `62` | SDK prefix；hash 一致 |
| 2 | `11236` | `1152` | global-cache static prompt 差异最大 |
| 3 | `15160` | `5160` | dynamic/session guidance 差异明显 |

Sanitized hash：

```text
built system_without_billing_hash:    c6b335eedc1b2314
official system_without_billing_hash: 82957f19d47aeb30
```

关键发现：

- block 0 billing pseudo-header 与 block 1 SDK prefix 已基本一致；
- 差异主要来自 block 2/3；
- built 的 block 2 约为 official 的 9.75 倍；
- built 的 block 3 约为 official 的 2.94 倍；
- built 总 system text 约为 official 的 4.11 倍。

本地摘要片段显示 official 的 block 2 是更短的安全/工程任务核心说明；built 的 block 2 保留了较完整的 Claude Code CLI 行为说明。official 的 block 3 是压缩过的工作原则；built 的 block 3 包含更长的 session-specific guidance、agent/tool 描述和本项目额外上下文。

## Token-saving mechanisms identified

### Mechanism A: Smaller inline tool set

少发 4 个 inline tools 会直接节约：

- tool name；
- tool description；
- input schema；
- potential cache churn。

当前差异中 `Glob` / `Grep` / `InteractiveTerminal` / `WorkflowTool` 是最明显的 built-only inline tools。

### Mechanism B: Dynamic tool loading / deferred tools

`src/utils/toolSearch.ts:156` 描述了三种模式：

- `tst`：始终使用 Tool Search Tool；
- `tst-auto`：达到阈值才 defer；
- `standard`：禁用 tool search，全部 inline。

`src/services/api/claude.ts:1174` 在 tool search 启用时只发送 non-deferred tools、`ToolSearchTool` 和已发现 deferred tools。这是主要 token-saving 机制之一。

但是本次证据显示 built 的 deferred pool 为 `52`，official 为 `17`。这说明 built 当前加载了更多插件/skills/MCP/工具候选，即使最终 inline tools 数量只多 4，周边 deferred list 或 instructions 仍可能放大 prompt/message 体积。

### Mechanism C: Prompt static/dynamic split and cache scope

`src/constants/prompts.ts:107` 的 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 与 `src/services/api/claude.ts:1400` 的 `buildSystemPromptBlocks()` 表明系统 prompt 被分块并标注 cache control。

本次捕获中：

- built block 2 带 `{ type: 'ephemeral', scope: 'global' }`；
- official block 2 同样带 global cache；
- official block 3 还带 `{ type: 'ephemeral' }`，built block 3 没有在摘要中显示 cache control。

这表示 official 不只是内容更短，也可能更积极地对 dynamic block 做 prompt caching 标记。

源码侧 token-saving 归因：

- `src/constants/prompts.ts:447` 的 `getSystemPrompt()` 有 `CLAUDE_CODE_SIMPLE` 极简路径，只返回官方 CLI 身份、CWD 和日期。这是源码中最明确的 compact prompt variant，但它会同时走 `src/tools.ts:277` 的 simple tool preset，默认只保留 `Bash` / `Read` / `Edit`，与本次 official 的 `Agent` / `Skill` / `ToolSearch` / `Workflow` 工具集合不完全一致。
- `src/constants/prompts.ts:469` 的 proactive/KAIROS 路径会走 `simple-proactive`，也是明显短 prompt，但依赖 internal feature 与 proactive active state。
- 正常路径在 `src/constants/prompts.ts:494` 以后把 session guidance、memory、env、language、output style、MCP instructions、scratchpad、FRC、summarize tool results 等放入 dynamic sections；这些 section 由 `src/constants/systemPromptSections.ts:43` memoize，减少 turn-to-turn 重算，但内容仍会进入本次 request。
- `src/constants/prompts.ts:516` 的 `mcp_instructions` 使用 `DANGEROUS_uncachedSystemPromptSection()`，注释明确说明 MCP connect/disconnect 会导致每 turn 变化；当 `isMcpInstructionsDeltaEnabled()` 为 true 时，说明会改走 delta attachment，减少 prompt cache churn。
- `src/services/api/claude.ts:1354` 说明 deferred tool list 如果不走 delta attachment，会以前置 synthetic user message 的方式加入 `<available-deferred-tools>`，这会随 deferred pool 变化并 bust cache。
- `src/services/api/claude.ts:1234` 到 `src/services/api/claude.ts:1248` 说明 global cache 只有在没有非 deferred MCP tool 破坏 cache marker 时才走 `system_prompt` 策略，并追加 `PROMPT_CACHING_SCOPE_BETA_HEADER`。

因此，official 的 token 节约更像是多重机制叠加：更少 inline tools、较小 deferred pool、更短 prompt variant、MCP/deferred delta attachment、以及更稳定的 global-cache boundary。当前证据不足以支持直接删除 built prompt 内容；更安全的实现方向是先减少非必要 inline/deferred tool pool 和 per-turn dynamic sections。

### Mechanism D: Official compact prompt variant

运行时证据显示 official 的 block 2/3 是明显精简版，不只是删除少数行。可能来源包括：

- official binary 内置 prompt 版本更精简；
- feature gate 或 release build gate 选择了 compact prompt；
- official settings/env 触发了 Agent SDK / non-interactive 专用短 prompt；
- built 当前源码包含更多开发态、plugin、goal、superpowers、memory、project guidance 注入。

当前源码中 `src/utils/systemPrompt.ts:47` 的 `buildEffectiveSystemPrompt()` 只决定 default/custom/agent/append 的组合，不直接压缩内容。因此真正需要继续追的是 `defaultSystemPrompt` 的构建来源、settings/memory/plugin 注入来源，以及 official binary 中对应 prompt 常量。

## Likely root causes

1. **工具差异来自基础工具集和运行时 gate 不一致。** 证据指向 `src/tools.ts:198` 的 base tools 与 `hasEmbeddedSearchTools()`、workflow tools、InteractiveTerminal 是否启用。
2. **`output_config` 差异来自 effort wire behavior 不一致。** built 当前链路没有写入 `output_config.effort`；official 对同一模型/场景发送了 `high`。
3. **system prompt 差异来自 prompt 内容源和上下文注入差异。** CCH、SDK prefix 已一致；大头在 default/system guidance 与 session-specific/plugin/memory guidance。
4. **token 节约不是单点优化。** official 同时减少 inline tools、减少 deferred pool、使用更短 prompt variant，并可能更好地标注 cache control。

## Recommended next research tasks

### Task 1: Tool diff attribution

输出每个 built-only/official-only tool 的来源：

- source file；
- feature/env gate；
- `isEnabled()` 结果；
- 是否应 inline、defer，或完全不发送。

重点验证：

- `hasEmbeddedSearchTools()` 在 official 与 built 的实际值；
- `Workflow` / `WorkflowTool` 是否双重暴露；
- `InteractiveTerminal` 是否应该在 non-interactive `--print` / Agent SDK preset 中暴露。

### Task 2: Effort/output_config parity

构造最小单元/集成检查：

- 同一 model；
- `CLAUDE_CODE_EFFORT_LEVEL` unset / `high` / `auto` / `unset`；
- first-party provider；
- non-interactive print mode。

目标是确认 official 的 `output_config.effort=high` 是默认 model effort、settings 注入、CLI option，还是 binary 内部固定行为。

### Task 3: Prompt block provenance

对 system block 2/3 做 provenance tracing：

- 在 built 侧通过 debug instrumentation 或 local script 输出每个 prompt section 的 name/length/hash；
- 在 official 侧用 MITM block hash/length 与已知源码常量或提取产物对齐；
- 区分 upstream prompt、project `CLAUDE.md`、memory、skills、plugins、session-specific guidance、goal/superpowers 注入。

### Task 4: Compact prompt/token-saving design

在确认来源后再设计实现，不直接盲目删 prompt。候选方向：

- non-interactive / SDK preset 下使用 compact system prompt；
- 对 plugin/skill/tool guidance 做 deferred loading；
- 避免把可由 tool schema 表达的信息重复写入 system prompt；
- 让 dynamic prompt block 明确 cacheable 时带 cache control；
- 将 large optional guidance 移到按需 tool/search 机制。

## Current limits

- 本报告没有打印完整 request body，无法逐字比较 prompt 内容；只使用长度、hash、工具名和短 preview。
- official binary 的 compact prompt 来源尚未反混淆/提取验证。
- 当前结论足以指导后续研究计划，但不足以直接改动 prompt parity 行为。
