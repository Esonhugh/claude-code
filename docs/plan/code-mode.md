# Code Mode 实施计划

## 1. 文档状态

- **类型**：实施计划
- **状态**：实施中。D1–D5 按建议方案执行；Phase 0–4 已完成（2026-11-16），Phase 5 未开始
- **日期**：2026-11-15
- **对照版本**：官方 2.1.325，分析见 [`research/code-mode-325-20261115.md`](../research/code-mode-325-20261115.md)，模块备份在 [`recover/claude-v2.1.325-code-mode/`](../../recover/claude-v2.1.325-code-mode/README.md)
- **证据边界**：官方行为来自静态阅读，没有用真实账号运行过 Code Mode；本地调用点按 2026-11-15 的工作树核对，实施前要重新检查

目标是让本地构建在 `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1` 时提供和官方一致的 Code Mode：模型只看到 `REPL`（必要时加 `Poll`、`StructuredOutput`），在 `REPL` 里写 JavaScript 调用其他工具，每次工具调用仍然逐项做校验、hook 和权限判定。

## 2. 现状

本地已有的部分：

| 位置 | 内容 | 与官方的差距 |
| --- | --- | --- |
| `src/tools/REPLTool/constants.ts` | `REPL_TOOL_NAME`、`isReplModeEnabled()`（ant + CLI 才开）、`REPL_ONLY_TOOLS` | 开关不读 `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE`；`REPL_ONLY_TOOLS` 含 Write、Edit、ApplyPatch、Agent，官方 `CODE_MODE_ONLY_TOOLS` 只有 Read、Glob、Grep、Bash、PowerShell、NotebookEdit |
| `src/tools/REPLTool/primitiveTools.ts` | `getReplPrimitiveTools()`，8 个工具含 Agent | 官方 primitive 是 Read、Glob、Grep、Bash、PowerShell、NotebookEdit、Write、Edit，不含 Agent |
| `src/tools.ts:19-21` | `isAnt()` 时 require `./tools/REPLTool/REPLTool.js` | 文件不存在 |
| `src/tools.ts:340-346` | REPL 开启时从工具池去掉 `REPL_ONLY_TOOLS` | 没有隐藏 MCP，没有区分“移出工具池”和“只对 API 隐藏” |
| `src/constants/prompts.ts:284`、`src/memdir/memdir.ts:374` | REPL 模式下改写 “Using your tools” 段和 memory 段 | 文案是旧版，官方另外改写了 Chrome 段 |
| `src/services/tools/toolHooks.ts:828` | `resolveHookPermissionDecision`，注释写明由主循环和 `REPLTool/toolWrappers.ts` 共用 | `toolWrappers.ts` 不存在 |
| `src/utils/sessionStorage.ts:4687-4760` | 外部 transcript 去掉 REPL 外壳，把 `isVirtual` 消息转成真实消息 | 可直接复用 |
| `src/utils/collapseReadSearch.ts:150-202` | 渲染 REPL 的虚拟消息 | 可直接复用 |
| `src/Tool.ts:188` | `ToolUseContext.innerCall` | 已被 Agent 和 mods 使用 |
| `src/services/mods/toolHost.ts` | mods 的 `tool.call`：用 `runToolUse` 跑一次完整的顶层流程，再从产出的消息里取 `tool_result` 和 `toolUseResult` | 这是本地现成的“内层调用”实现，见决策 D1 |
| `src/services/mods/worker.ts:779` | Worker 里 `vm.createContext(..., {codeGeneration: {strings: false, wasm: false}})`，删除危险全局 | 可参考，见决策 D2 |

本地 Bun 是 1.4.4（`packageManager` 写 1.4.2），`bun-types` 里有 `Transpiler` 的 `replMode` 选项。

## 3. 需要先定的决策

### D1 内层调用复用 `runToolUse`，还是照官方另写一份

官方在 `EvalTool` 的 `Fi()` 里把校验、hook、权限、`tool.call`、PostToolUse 重写了一遍。本地 mods 的 `toolHost.call` 已经证明可以直接跑 `runToolUse`，再从产出的 user 消息里取 `toolUseResult`。

| | 复用 `runToolUse` | 另写一份 |
| --- | --- | --- |
| 权限、hook、遥测与主循环一致 | 自动一致 | 要手工跟进，`toolExecution.ts` 有 2352 行，容易漂移 |
| 拿到原始结果 | 用 `toolUseResult`；大结果落盘和截断要能按调用关掉 | 直接拿 `tool.call` 返回值 |
| 官方特有参数（`fileReadingLimits` 放宽到 256 MB、`globLimits.maxResults: 25000`、拒绝 `run_in_background`） | 经 `ToolUseContext` 增加字段传入 | 直接写 |
| 工作量 | 小 | 大 |

**建议复用 `runToolUse`**。给 `ToolUseContext` 加 `replScriptCall` 一类的标记，在 `toolExecution.ts` 里少数几处按标记分支：跳过结果落盘、放宽读取上限、不生成顶层进度。`resolveHookPermissionDecision` 已经是共享的，不用改。

### D2 脚本在哪里执行

| | 进程内 `node:vm` + 步数探针（官方） | Worker 里放 `vm` context |
| --- | --- | --- |
| 死循环 | 要在源码里插 `__replStep()` 计数，才能打断 await 之后的同步循环 | `worker.terminate()` 一定能停 |
| 超时后变量 | 保留 | context 随 Worker 一起丢失，下一次调用重建并提示 |
| 工具调用 | 直接调用宿主函数，靠 sealers 防止宿主对象泄露 | 走 `postMessage`，值天然被 structured clone，不会泄露宿主对象 |
| 本地可参考的代码 | 无 | `src/services/mods/worker.ts` 已有同样的 context 创建和全局清理 |
| 与官方一致程度 | 高 | 超时语义不同 |

**建议第一版用 Worker**。官方那套探针、`Function.prototype.toString` 修补、sealers 和 engine check 加起来有上千行，Worker 用进程边界换掉了大部分。执行器对外只暴露 `run(code, options)`、`interrupt()`、`release()`，以后要换成官方方案时只改执行器内部。

### D3 开关做到什么程度

官方要过 GrowthBook gate `tengu_rustling_blossom`、两个 caveat 标记、确认对话框，同意后重启进程，并且只接受 firstParty provider 和 Opus/Sonnet 5.5 及以上的模型。

**建议**：

- 读 `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE`，在启动时一次性决定，不做重启。本地构建的工具列表和 system prompt 本来就在启动时确定。
- 不接 GrowthBook gate。
- 保留 auto mode 的确认：auto mode 的分类器只看整段脚本一次，不看脚本里的每次调用。这条行为差异要让用户知道。确认结果写 `~/.claude.json` 的 `codeModeAutoModeCaveatAcceptedV1`，和官方同名。
- provider 和模型不设硬限制，非 Anthropic provider 启动时给一条提示。
- 照官方，在 Remote Control、后台会话、teammate、非交互入口下不开启。

### D4 mods 的 tool.call hook

官方装了带 JS hook、会检查 tool call 的 mod 时直接拒绝 Code Mode。本地 mods 是主要功能之一。**建议**：内层调用走 `runToolUse` 后，mods 的 tool hook 会照常触发，所以不拒绝；在 Phase 2 加一条测试，确认 hook 收到的是内层调用。

### D5 旧的 REPL 常量

`isReplModeEnabled()` 改成读新开关，去掉 `isAnt()` 条件。`REPL_ONLY_TOOLS` 改名为 `CODE_MODE_ONLY_TOOLS` 并按官方取值，另加 `REPL_PRIMITIVE_TOOL_NAMES`。`getReplPrimitiveTools()` 去掉 Agent、加 PowerShell。引用点有 `src/tools.ts`、`src/constants/prompts.ts`、`src/memdir/memdir.ts`、`src/utils/collapseReadSearch.ts`、`src/services/extractMemories/extractMemories.ts`、`src/utils/sessionStorage.ts`。

## 4. 分阶段实施

每个阶段单独提交，阶段结束时 `bun test` 相关文件和 `make build` 都要通过。开关关闭时，任何阶段都不能改变现有行为。

### Phase 0 开关与工具列表

文件：`src/tools/REPLTool/constants.ts`（新开关和常量）、新建 `src/tools/REPLTool/codeModeGate.ts`（启动判定与拒绝原因）、`src/tools.ts`、发请求前组装工具列表的位置（实施时定位，`toolToAPISchema` 调用方之一）。

1. `isCodeModeEnabled()`：开关为 on，且入口、会话类型、`--tools`/deny 规则都允许 REPL。不满足时记录原因，用 `--debug` 可见，原因文案参照 `recover/claude-v2.1.325-code-mode/pretty/chunk-yw5xfhrq.js`。
2. 工具池：移出 `CODE_MODE_ONLY_TOOLS`。
3. 发给 API 的列表：只留 `REPL`、`Poll`、`StructuredOutput`。Write、Edit、MCP 工具留在工具池，内层调用要用。被隐藏的工具不进 ToolSearch 的 deferred 列表。
4. 模型仍然直接调用被隐藏的工具时，返回 `X is only available inside REPL. Use REPL with code: await X({...})`。

测试：开关 on/off 下的工具池和 API 列表；deny 规则去掉 REPL 时不开启；MCP 工具在池里、不在 API 列表里。

### Phase 1 内层调用

新建 `src/tools/REPLTool/toolWrappers.ts`。

1. 可调用集合：会话工具去掉 REPL，加上 primitive，再按 deny 规则、MCP `blocked`、`--tools` 过滤；平台没有对应 shell 时去掉 Bash 或 PowerShell。
2. 每次调用构造一个 `tool_use` block（id 前缀 `repl_`），用 D1 的方式跑 `runToolUse`，context 带 `innerCall: true`、`replScriptCall: true` 和子 abort controller。
3. 结果：内置工具返回 `toolUseResult`；出错时 resolve 成 `{error}`。MCP 的 text block 拼接后按 JSON 解析，失败时抛 `McpToolError`，`detail` 放解析出的内容。
4. 每次完成的调用写成一对 `isVirtual` 消息（`tool_use` + `tool_result`，真实结果在 `toolUseResult`，带 `permissionDecision`），放进 REPL 结果的 `newMessages`。
5. 进度事件 `repl_tool_call`，阶段 `start`/`executing`/`complete`/`error`。`src/types/tools.ts:37` 的 `REPLToolProgress` 按此扩展。
6. 并发：信号量，上限 `min(CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY ?? 10, 10)`。每个脚本最多 50000 次调用，脚本停止后最多再放行 20 次。

`toolExecution.ts` 按 `replScriptCall` 增加的分支：不做大结果落盘；`fileReadingLimits` 放宽为 `{maxTokens: Infinity, maxSizeBytes: 268435456}`；`globLimits.maxResults` 为 25000；async lane 下拒绝 `run_in_background`；不向 UI 发顶层工具进度。

测试：权限 deny/ask/allow；PreToolUse 改写入参和拦截；PostToolUse 替换输出；abort 传递；并发上限；虚拟消息的形状；mods tool hook 收到内层调用（D4）。

### Phase 2 执行器

新建 `src/tools/REPLTool/executor/`：`host.ts`（主线程侧）、`worker.ts`（Worker 侧），按 D2 决定的方案实现。

1. 转译：`new Bun.Transpiler({loader: "js", replMode: true})`，支持顶层 await 和最后一个表达式的值。`scanImports` 发现 import、动态 import 或 `require` 时报错，文案照官方。
2. context：`vm.createContext(Object.create(null), {codeGeneration: {strings: false, wasm: false}})`，参照 `src/services/mods/worker.ts:779` 删除多余全局，冻结内置对象。
3. 全局：每个工具一个 async 函数（真实名和脚本安全别名），`tools`、`tools.list()`、`describeTool(name)`、`searchTools(query)`、`console`（内存 ring buffer）、`setTimeout`/`setInterval`/`clear*`、`atob`/`btoa`。`$`、`preview`、`file`/`write`/`edit` 在 Phase 3 补。
4. 输出：包在 `<repl-output>` 里，`&`、`<`、`>` 转义，每段截到 30000 字符，总长 100000 字符。
5. 时间：`timeout` 默认 30000、最大 600000 ms，等待工具调用的时间不计入。需要逐次确认权限的模式下整段脚本 600000 ms 封顶，等待确认的时间计入。
6. 中止：Esc 调 `interrupt()`，停止执行、清 timer，之后的工具调用不再执行。

测试：顶层 await；import/require 被拒；`eval`/`new Function` 不可用；死循环在超时内被停止；超时后的提示；输出转义与截断；Esc 中止。

### Phase 3 REPL 工具与会话

新建 `src/tools/REPLTool/REPLTool.ts`，`src/tools.ts:19` 改为按 `isCodeModeEnabled()` 加载。

1. 工具定义：`inputSchema` 从 `recover/claude-v2.1.325-code-mode/pretty/chunk-g61t94xb.js:6731` 起逐字段对齐；`isEnabled` 跟开关；`isConcurrencySafe` 返回 false；`toAutoClassifierInput` 返回 `code`；`checkPermissions` 在 auto 模式下交给分类器，其他模式 allow。
2. prompt：照 `chunk-g61t94xb.js:1549-1618` 生成。TypeScript 声明从工具 schema 生成，不列 MCP 工具、`skill__*`、`ToolSearch` 和 REPL 本身，只列 MCP server 名。
3. 其他 prompt 段：更新 `src/constants/prompts.ts:284` 的 REPL 分支；memory 段把 "with the Write tool" 换成 `write(path, content)`；Chrome 段改成 Code Mode 下不可用的说明。
4. 会话：每个 agent 一个 context，key 是 `agentId ?? "main"`。compaction、resume、fork 之后重建，第一次结果附上官方的提示。
5. helper：`file`/`write`/`edit`（Write 因未读失败时先读再重试）、`$`、`preview`。
6. transcript：照官方 `j4e`，Code Mode 会话保留 REPL 外壳和虚拟消息，不做外部 transcript 转换；写入 `repl-mode` 元数据（last-wins），缺失时用 `<repl-output` 推断；开关关闭时 resume 注入 "Do not call REPL or Poll…" 提醒。见 `docs/research/code-mode-compat-20261115.md`。

测试：prompt 快照；变量跨调用保留；compaction 后的提示；resume 后保留 REPL 外壳和虚拟消息；auto mode 下分类器收到整段 `code`。

### Phase 4 后台执行与 Poll

只在 `auto` 和 `bypassPermissions` 模式下启用。`Poll`、async 文本、MODE_CHANGE 段、async d.ts 和去掉 `run_in_background` 看会话启动时的模式（官方 `t8t` → `ownEventsRequested`）；每次调用是否走 async lane 再看当时的模式（官方 `Xu`）。启动于其他模式的会话只有 `REPL`，切到 auto 也不变。

1. 脚本 30 s 后未结束就转后台，返回 `(dispatched #N)`，墙钟上限 7200000 ms。
2. 新建 `Poll` 工具，输入为空，返回 `<event kind="repl-eval">` 事件。
3. 后台脚本出错时补一对虚拟的 `REPL` tool_use/tool_result。
4. 内层工具进度等 REPL 回执到达后再发给 SDK 客户端。
5. 一个 context 最多同时挂 8 个未结束的 eval。

测试：转后台与回执；Poll 取回结果和错误；上限；Esc 中止后台脚本。

### Phase 5 开关的用户界面

1. auto mode 的确认对话框（D3），文案参照 `recover/claude-v2.1.325-code-mode/pretty/chunk-1f850fa5.js:581-726`。
2. 显示名 `Code Mode (experimental)`，工具在界面上显示为 `Code`。
3. 不满足条件时，在启动信息里说明原因。

## 5. 与官方对照验证

Phase 3 完成后开始，用 `./official-claude`（先 `make download-claude` 更新到对照版本）和 `./built-claude` 跑同一组脚本。两边都用独立的 HOME 和 config，在 tmux 里驱动，保存每一轮的输入和画面。

对照项：

- 发给 API 的工具列表和 REPL prompt：用本地代理抓请求体，比较 `tools` 和 system prompt 段落。
- 同一段脚本的 `<repl-output>`、虚拟消息和最终 transcript。
- 脚本内调用 Bash 时的权限确认，deny 规则拦截后的错误文本。
- 超时、Esc、import 被拒的提示文本。
- resume 后的会话内容。

官方的 GrowthBook gate 在没有资格的账号上会拒绝，这时只能比较请求体和 prompt 文本，不能比较运行结果。

Phase 3 遗留（2026-11-16 处理完）：

- 主线程 `--agent` 的脚本工具限定（`REPL.tsx`）、子 agent 结束时 `releaseReplSession`、compaction 列出脚本全局变量、`repl_working` 段、超时文案改为官方原文，都已完成。`print.ts` 的 `--agent` 路径没有改：非交互入口照官方拒绝 Code Mode。
- Remote Control 在会话中途开启时，开关仍不重新判定；bridge 在 Code Mode 下拒绝启动并报 failed。

Phase 4 已知差异（留给一致性检查）：

- 没有移植：`imagesRefused`、`imagePagesFailed`、`stripForStorage`（transcript 保留完整 base64）、后台结果带图片、`startsTurn:false`、`ranBefore`、`rerunByHook`、等待计数界面 `onStopWaitChange`。
- 自拟文案：`CONTEXT_LOST` 和 Poll schema 的 `content` 说明，官方没有对应原文。
- 脚本结束时未 await 的调用（官方 `Ze`/`Da`）：脚本出错时，仍在运行后失败的调用也用逐条文案（官方此时用合并文案，并把错误列在脚本错误下，我们的错误路径不列调用错误）。没有移植 async lane 的迟到日志文案 `Xl`、`is`；脚本结束后 timer 已清掉，只有 promise 链还能发起调用。
- 墙钟文案（官方 `ju`/`Fu`）与内层 watchdog（官方 `dc`）：没有沙箱重试和插件 hook 重跑的两句（`ranBefore`/`rerunByHook`，我们不追踪这两种重跑）；`pp()` 只看 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`。watchdog 触发后官方中止整个调用并以该错误结束脚本，我们同样中止本脚本的全部调用并结束运行，但 worker 随之重建，脚本上下文丢失（见 D2）。
- 1 小时缓存判断读配置，官方用上一次主线程请求实际用的 TTL。
- 后台脚本的进度视图和任务行（`NUe`/`Kds`）放到 Phase 5。

## 6. 风险

- **auto mode 的分类器只看一次**：脚本里的每次调用仍然走权限判定，但 auto mode 下分类器只审整段 `code`。确认对话框必须说清这一点（D3）。
- **权限确认阻塞脚本**：需要逐次确认的模式下，一个脚本可能连续弹出多次确认，等待时间计入 600 s 上限。
- **Worker 方案的超时语义与官方不同**（D2）：超时会丢掉全部变量，下一次结果要明确告诉模型。
- **`toolExecution.ts` 的分支**（D1）：`replScriptCall` 分支要有测试覆盖，否则主循环以后改动时内层调用可能悄悄变化。
- **非 Anthropic provider**：OpenAI 等 provider 的模型不一定能写好这类脚本。D3 只给提示，不拦截。

## 7. 回退

开关默认 off。任何阶段出问题时关掉 `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE`，行为回到现状。Phase 0 改动了 `REPL_ONLY_TOOLS` 的引用点，这一步要和开关一起测试 off 状态，保证工具池和 prompt 与改动前逐字一致。

## 8. 未决问题

- `$` 目前是官方 shell helper 的子集：没有 spill 文件、后台 `running` 和非沙箱重试。
- 官方 REPL 实际运行没有观察到：自定义 `ANTHROPIC_BASE_URL` 时官方以 `provider` 拒绝开启，本机连不上 firstParty（ECONNRESET）。第 5 节的对照需要能直连 Anthropic API 的环境。
- 官方主循环是否也调用 `Fi()` 里的 `ron`、`oon`、`z_t`：静态阅读还没确认，这影响 D1 中“与官方一致”的程度。
- Code Mode 下 agent/team helper（`spawnContext` 等）是否真的不安装：现有结论是推断，Phase 3 前要再核对。
