# Prompt 与上下文占用优化

## 1. 背景与目标

Claude Code 的每次模型请求不仅包含用户消息，还包含系统提示词、工具 schema、Agent 列表、Skill 提醒、MCP deferred-tool 列表、项目指令、环境信息和历史工具结果。固定提示词过大，会增加冷缓存请求的输入 token、prompt cache 创建成本和首轮延迟；长会话中累积的工具结果还会提前触发自动压缩。

本轮优化目标：

1. 找出主会话和 Agent 请求中的高频提示词及拼装路径。
2. 在不削弱授权、安全、只读和输出契约的前提下压缩重复说明。
3. 使用本地会话与 debug log 量化当前上下文占用。
4. 建立长度测试，防止提示词再次无界膨胀。
5. 给出代码层和运行配置层的后续压缩路线。

## 2. 运行时提示词拼装路径

### 2.1 主会话

主会话的默认系统提示词按以下路径进入请求：

1. `src/main.tsx` 读取自定义或追加 system prompt 参数。
2. `src/utils/queryContext.ts` 获取默认提示词部分。
3. `src/constants/prompts.ts:getSystemPrompt()` 拼装静态规则、动态环境、工具使用和会话指导。
4. `src/utils/systemPrompt.ts` 处理默认提示词、自定义覆盖、追加提示词和 coordinator/agent 模式。
5. `src/query.ts` 将 system context 送入查询循环。
6. `src/services/api/claude.ts` 追加 attribution、CLI/SDK、Advisor、Chrome 和 deferred-tool 信息。
7. `src/utils/api.ts` 切分 system blocks 并设置 prompt cache 边界。

高频主体位于：

- `src/constants/prompts.ts`
- `src/tools/BashTool/prompt.ts`
- `src/tools/AgentTool/prompt.ts`
- `src/services/api/claude.ts`

### 2.2 Agent 请求

Agent 请求沿用主查询和 API 请求路径，但 system prompt 来自 Agent 定义：

1. `src/tools/AgentTool/AgentTool.tsx` 解析 Agent 类型和覆盖提示词。
2. `src/tools/AgentTool/runAgent.ts` 解析工具、模型、MCP、Skills 和环境。
3. `src/tools/AgentTool/built-in/*.ts` 或用户 Agent 文件提供主体提示词。
4. `src/constants/prompts.ts:enhanceSystemPromptWithEnvDetails()` 追加环境信息。
5. `src/query.ts` 和 `src/services/api/claude.ts` 发起模型请求。

## 3. 当前上下文占用

### 3.1 数据来源

测量依据包括：

- 本地项目会话 JSONL 中 API 返回的 `message.usage.input_tokens`。
- `.claude-test-evidence/**/debug.raw.log` 中的 autocompact 和 dynamic tool loading 记录。
- 实际运行时提示词字符串长度。

字符到 token 的估算统一使用 `字符数 ÷ 4`。这是面向英文提示词和代码/schema 的近似值；最终计费以服务端 tokenizer 和 `usage` 为准。

### 3.2 实测结果

| 场景 | Input tokens |
|---|---:|
| 当前主会话较早请求 | 28,317 |
| 当前主会话后续请求 | 31,235 |
| 研究 Agent 首次请求 | 19,599 |
| 研究 Agent 累积后 | 81,952 |
| 历史长会话近期请求 | 约 105,823–106,249 |
| 已观察最大请求 | 166,906 |

Debug log 显示：

- 有效上下文窗口约为 180,000 tokens。
- 自动压缩阈值约为 167,000 tokens。
- ToolSearch 工作时曾延迟加载 121–150 个 MCP 工具。
- ToolSearch 不可用或被禁用时，完整工具 schema 可能重新进入请求。

由此可得：

- 当前工具和插件较多的主会话，初始固定成本约为 28k–40k tokens。
- 长会话在积累工具结果后通常超过 100k tokens。
- 大型研究任务可能接近 167k 自动压缩阈值。

### 3.3 固定成本估算

| 组成 | 每次请求估算 |
|---|---:|
| 核心 system/developer 指令及内置工具 schema | 10k–16k tokens |
| 其中 Agent 类型目录 | 5k–9k tokens |
| Skill 清单 | 3k–6k tokens |
| deferred-tool 名单 | 1.5k–3k tokens |
| Memory、环境和仓库状态 | 1.4k–2.7k tokens |
| 会话与工具结果 | 随会话增长，后期成为主要成本 |

这些区间存在重叠，例如 Agent 目录通常嵌入 Agent 工具 schema，因此不能直接全部相加。

## 4. 已实施优化

### 4.1 主会话操作安全提示词

位置：`src/constants/prompts.ts:getActionsSection()`

原提示词用多个段落和大量示例解释可逆性、共享状态、外部可见操作和故障处理。新版本保留以下不变量：

- 本地可逆操作可以直接执行。
- 破坏性、难恢复、外部可见或共享状态操作需要确认。
- 单次授权不会自动延伸到后续操作。
- 不得通过跳过安全检查或破坏性命令绕过问题。
- 遇到异常文件、冲突或锁时优先保护用户工作。

### 4.2 Bash Git/PR 提示词

位置：`src/tools/BashTool/prompt.ts:getCommitAndPRInstructions()`

删除逐命令教程和重复示例，将规则压缩为安全契约及三步流程。保留：

- 未经明确要求不得 commit、push 或创建 PR。
- 不得修改 git config、泄露 secrets、跳过 hooks/signing。
- 不得 force-push main/master。
- 默认创建新 commit，只有明确要求才 amend。
- 精确 stage 文件，不使用 `git add .` 或 `git add -A`。
- commit 和 PR body 使用 heredoc。
- PR 必须检查完整分支历史并返回 URL。

### 4.3 Explore Agent

位置：`src/tools/AgentTool/built-in/exploreAgent.ts`

将重复的只读禁止列表合并为一条完整约束，同时保留：

- 不得创建、修改、删除、移动或复制文件。
- 不得写临时文件、重定向输出、安装依赖或改变 git 状态。
- Bash 只允许只读命令。
- 根据调用方指定的 thoroughness 调整搜索深度。
- 独立搜索并行执行，最终直接返回报告。

### 4.4 Plan Agent

位置：`src/tools/AgentTool/built-in/planAgent.ts`

压缩只读约束和规划教程，保留：

- 全程只读。
- 先理解需求，再追踪架构、惯例和类似实现。
- 说明关键权衡。
- 输出有顺序、有依赖关系的实施计划。
- 结尾必须包含 `### Critical Files for Implementation` 和 3–5 个关键路径。

## 5. 优化结果

| 提示词 | 优化前字符 | 优化后字符 | 节省字符 | 降幅 | 估算 token 节省 |
|---|---:|---:|---:|---:|---:|
| 主会话操作安全 | 2,832 | 884 | 1,948 | 68.8% | 约 487 |
| Bash Git/PR | 6,307 | 1,394 | 4,913 | 77.9% | 约 1,229 |
| Explore Agent | 1,959 | 656 | 1,303 | 66.5% | 约 326 |
| Plan Agent | 2,341 | 899 | 1,442 | 61.6% | 约 360 |
| **合计** | **13,439** | **3,833** | **9,606** | **71.5%** | **约 2,402** |

普通主会话同时携带操作安全和 Bash schema 时，冷缓存请求约减少：

- 6,861 字符
- 约 1,715 tokens

Explore 和 Plan 请求会在此基础上分别额外减少约 326 和 360 tokens。静态提示词命中 prompt cache 时，主要收益体现在首次 cache creation、缓存失效后的重建以及总上下文容量，而不是每个 cache-read token 的直接减少。

## 6. 回归保护与验证

新增或扩展测试：

- `src/tools/BashTool/prompt.test.ts`
  - 确认显式授权、force-push、hooks/signing 和 heredoc 规则仍存在。
  - 限制 Bash prompt 长度。
- `src/tools/AgentTool/builtInAgents.test.ts`
  - 确认 Explore/Plan 仍包含只读约束。
  - 确认 Plan 仍包含关键文件输出契约。
  - 限制两个 Agent prompt 的长度。

已通过：

- `bun test src/constants/prompts.test.ts src/tools/AgentTool/prompt.test.ts src/tools/AgentTool/builtInAgents.test.ts src/tools/BashTool/prompt.test.ts`
  - 8 pass，0 fail。
- `bunx tsc --noEmit --pretty false`
- `bun run lint`
- `bun run build`
- `node dist/cli.js --version`
  - 输出 `0.0.0-dev (Claude Code)`。

Binary 交互验证说明：

- 正常环境启动时，开发版本按预期触发最低版本保护。
- `NODE_ENV=test` 下 binary 能启动并响应 Ctrl+C。
- Print 模式在等待远端响应时被主动终止，因此本轮没有取得真实模型回复；这不影响本地 prompt 拼装、测试、类型检查和构建结论。

## 7. 后续优化建议

### P0：按场景裁剪插件、MCP 和 Skill

当前编码会话同时注册了 finance、IBKR、TradingView、Gmail、Sites、Skysight、Detective、Chrome 等大量命名空间。即使 ToolSearch 延迟加载 schema，工具名称、Skill 清单和 Agent 定义仍会形成固定成本。

建议建立独立的 minimal coding profile：

- 默认仅启用代码、Git、IDE 和必要浏览器工具。
- 调查、交易、文档、邮件等插件按任务显式启用。
- 预计降低 2k–8k+ tokens 的初始上下文。

### P0：默认将 Agent 列表放入 attachment

`src/tools/AgentTool/prompt.ts:shouldInjectAgentListInMessages()` 已支持 `CLAUDE_CODE_AGENT_LIST_IN_MESSAGES` 和 `tengu_agent_list_attach`。

建议完成 A/B 验证后默认启用：

- Agent 工具 schema 保持静态。
- MCP 异步连接、插件 reload 和权限变化不再使整个 tools block 缓存失效。
- 优先改善 cache creation，而不仅是字符串总长度。

### P1：Skill top-K 与 namespace 发现

不要在每个回合列出全部 Skill：

- 默认只注入与当前任务匹配的 top-K Skill。
- 其他 Skill 通过 DiscoverSkills 或 namespace 查询加载。
- 已加载 Skill 不重复出现在发现提醒中。
- 预计减少 2k–5k tokens。

### P1：压缩 deferred-tool 名单

当前 `<available-deferred-tools>` 可能包含约 150 个完整工具名。可以先按 namespace 汇总：

```text
mcp__codex_apps__gmail__* (18 tools)
mcp__plugin_skysight-pro__* (42 tools)
```

模型选择 namespace 后再返回具体工具名。预计减少 0.5k–1.5k tokens。

### P1：请求构造层增加分项观测

建议在 `src/services/api/claude.ts` 构建最终请求时记录脱敏指标：

- system chars / estimated tokens
- tools schema chars / estimated tokens
- Agent listing chars
- Skill reminder chars
- deferred-tool listing chars
- memory / CLAUDE.md chars
- repo status chars
- conversation message chars
- cache breakpoint 数量及位置

只记录长度、hash 和类别，不记录完整 prompt、用户内容或 secrets。这样可以在 CI 或 debug log 中持续检测 prompt 膨胀。

### P2：继续压缩高频工具 schema

下一批候选：

- Bash sandbox 说明：保留决策树，缩短错误示例枚举。
- Agent Tool usage notes：合并 background、foreground、fresh-context 和 briefing 的重复说明。
- 主会话 Doing tasks：合并范围控制、不过度抽象和不添加防御性代码的重叠表达。
- Advisor：仅在启用时注入，并压缩触发时机的解释。

每次修改都应添加关键语义断言和长度上限，而不是使用完整文案 snapshot。

### P2：控制历史工具结果

长会话的主要增长来自工具输出，而非静态 system prompt。建议：

- Read 使用精确 offset/limit。
- Grep 设置合理 `head_limit`。
- 开放式搜索交给 Agent，使原始工具噪声留在子上下文。
- 大型构建或测试输出只保留失败摘要和关键上下文。
- 在进入重型验证前主动 compact 或开始新会话。

这一项在长研究会话中通常比继续削减几百个静态 token 更有效，可能减少 10k–50k tokens 的上下文累积。

## 8. 维护原则

后续新增或修改提示词时应遵循：

1. 先定义必须保持的行为不变量，再写最短表达。
2. 优先写规则和决策边界，不写完整操作教程。
3. 同一规则只保留一个权威位置；工具 schema、system prompt 和 Skill 不重复描述。
4. 动态列表优先使用 attachment、delta 或按需发现，避免污染静态 cache prefix。
5. 安全约束不能仅依赖提示词；工具权限和运行时校验仍是最终边界。
6. 对高频提示词建立字符上限和关键语义测试。
7. 使用真实 API `usage` 验证收益；字符数只用于本地快速回归。
