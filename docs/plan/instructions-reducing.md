# Claude Code 指令精简执行计划

> 状态：Proposed
>
> 范围：只规划，不实施提示词或运行时改动。
>
> 目标：降低冷启动与每轮请求中的 instruction token、减少 prompt cache churn，同时保持安全边界、工具可发现性、项目指令优先级和 Claude Code 现有行为。

## 1. 结论

当前指令成本不是由单一 system prompt 造成，而是由五层内容叠加：

1. 默认 system prompt；
2. 每个工具的 description 与 JSON Schema；
3. `CLAUDE.md`、auto memory、日期和 Git 上下文；
4. skills、agents、MCP instructions、deferred tools 等 reminder attachments；
5. skill、agent、workflow 被调用后加载的任务专用提示词。

最有效的精简策略不是压缩措辞，而是明确每条规则的唯一所有者，并把内容放到最窄的生效范围：

- 必须始终生效的跨任务规则留在 system prompt；
- 只与某个工具有关的规则只留在该工具 prompt；
- 只在 commit、PR、workflow、memory 写入等流程中需要的步骤改为按需 skill；
- 动态列表使用增量 attachment，不嵌入稳定 prompt 或工具 schema；
- 能由权限、schema、validator、hook 机械保证的约束，不再用多段自然语言重复保证；
- examples、背景解释和设计 rationale 留在测试或文档，不进入 model-visible prompt。

按当前代码和本会话实际注入内容判断，优先级应为：

1. **工具 prompt 去重与按需加载**：`Bash`、`Agent`、`Workflow`、`Task*` 是最大的仓库可控固定成本；
2. **auto memory 指令分层**：保留最小常驻策略，把模板、长示例和低频维护规则按需加载；
3. **skills/deferred tools 列表瘦身**：从“枚举全部能力”改为“相关能力 + 可搜索目录”；
4. **默认 system prompt 合并重复规则**：统一安全、最小改动、沟通风格、工具选择的所有权；
5. **项目 `CLAUDE.md` 与通用默认规则去重**：只保留本仓库特有约束，但不能让仓库安全依赖某个易变化的产品默认文案。

## 2. 范围与非目标

### 2.1 本计划覆盖

- `src/constants/prompts.ts` 生成的默认 system prompt；
- `src/tools/**/prompt.ts` 生成的工具 descriptions；
- `src/context.ts`、`src/utils/claudemd.ts`、`src/memdir/*` 注入的上下文和 memory policy；
- `src/utils/attachments.ts` 中 skills、agents、MCP、deferred tools、memory 的增量注入；
- `src/services/api/claude.ts` 和 `src/utils/api.ts` 的最终组装、cache scope 与观测；
- 本仓库 `CLAUDE.md` 中与默认产品规则重复的内容；
- 相关测试、prompt dump、token/character metrics 和交互验收。

### 2.2 本计划不覆盖

- 修改宿主平台不可由本仓库控制的最外层 system/developer instructions；
- 通过弱化权限、输入校验、sandbox、hook 或 Git 安全约束换取 token；
- 直接删除行为规则而不建立规则保留测试；
- 为了减少字符而使用难读缩写、隐式约定或模型难以遵循的高密度“电报体”；
- 本轮直接修改任何 prompt、工具、feature gate 或运行时行为。

## 3. 当前组装链路

### 3.1 默认 system prompt

`getSystemPrompt()` 将静态和动态 section 合并：

- 静态部分：身份、系统行为、任务执行、安全操作、工具使用、语气与输出效率；
- 动态部分：session guidance、auto memory、环境、语言、output style、MCP instructions、scratchpad 等；
- `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 将可全局缓存的静态前缀与用户/会话动态内容隔开。

证据：

- section 入口与边界：`src/constants/prompts.ts:107-117`、`src/constants/prompts.ts:447-579`；
- 动态 section registry：`src/constants/prompts.ts:494-558`；
- section memoization：`src/constants/systemPromptSections.ts:16-57`；
- prompt 覆盖优先级：`src/utils/systemPrompt.ts:30-124`。

### 3.2 用户和环境上下文

- `getUserContext()` 注入 `CLAUDE.md`/memory 与当前日期；
- `getSystemContext()` 注入 Git branch、main branch、Git user、status、最近五条 commit；
- `prependUserContext()` 将用户上下文包装为首条 `<system-reminder>` meta user message；
- `appendSystemContext()` 把 Git 等 system context 追加到 system prompt。

证据：

- Git context：`src/context.ts:36-103`；
- user/system context：`src/context.ts:116-188`；
- wrapper 与拼接：`src/utils/api.ts:437-473`；
- 最终 query 接入：`src/query.ts:454-466`、`src/query.ts:664-669`。

### 3.3 工具 descriptions 与 schemas

所有加载工具都会通过 `toolToAPISchema()` 生成：

- `name`；
- `description: await tool.prompt(...)`；
- `input_schema`；
- 可选 `defer_loading`、cache control 等字段。

因此工具 prompt 中重复解释 schema 字段、提供多个 examples 或嵌入完整工作流，会形成与 system prompt 同量级甚至更高的固定成本。

证据：

- Tool contract：`src/Tool.ts:383-408`、`src/Tool.ts:541-546`；
- schema materialization：`src/utils/api.ts:119-265`；
- API 请求前工具筛选和 schema 构建：`src/services/api/claude.ts:1143-1275`。

### 3.4 动态 attachments 与按需能力

仓库已经有正确的“稳定 prompt + 增量消息”方向：

- deferred tools 只在被 ToolSearch 发现后加载完整 schema；
- agent listing 可从 `AgentTool` description 移到 `agent_listing_delta`；
- MCP instructions 和 deferred tool names 可通过 delta attachment 持久化；
- relevant memories 最多选 5 个，并有单文件行数/字节限制；
- 日期变化通过尾部 attachment 通知，避免重写首轮 cached prefix。

证据：

- ToolSearch 语义：`src/tools/ToolSearchTool/prompt.ts:29-53`、`src/tools/ToolSearchTool/prompt.ts:55-123`；
- deferred tools 动态加载：`src/services/api/claude.ts:1179-1197`、`src/services/api/claude.ts:1356-1373`；
- delta attachments：`src/utils/attachments.ts:1601-1735`；
- agent list 移出 schema 的已有收益说明：`src/tools/AgentTool/prompt.ts:50-66`、`src/utils/attachments.ts:1624-1635`；
- relevant memory 限额：`src/utils/attachments.ts:2367-2405`、`src/utils/attachments.ts:2433-2485`。

## 4. 当前主要冗余与成本中心

### 4.1 默认 system prompt 内部重复

`src/constants/prompts.ts` 中以下主题存在交叉：

- “简洁直接”同时出现在 tone/style 与 output efficiency；
- “先读代码、最小改动、不要过度抽象、不要加无关功能”被拆成多条近义规则；
- “高风险操作先确认、不要用 destructive shortcut、不要跳过检查”与 Bash/Git prompt 再次重复；
- “使用 dedicated tools 而非 Bash”既在 system prompt 出现，也在 Bash tool description 中出现；
- “任务复杂时使用 task list”既在 system prompt 出现，也在 TaskCreate/TaskUpdate descriptions 中重复展开。

相关位置：

- coding behavior：`src/constants/prompts.ts:202-255`；
- risky actions：`src/constants/prompts.ts:258-269`；
- tool selection：`src/constants/prompts.ts:272-316`；
- tone/output：`src/constants/prompts.ts:405-444`。

### 4.2 Bash tool 包含完整 commit/PR 手册

外部用户路径在 Bash description 中常驻完整 Git Safety Protocol、commit 步骤、PR 步骤和 HEREDOC examples，即使绝大多数会话不执行 Git 发布流程。

- 完整工作流：`src/tools/BashTool/prompt.ts:44-163`；
- 工具选择、并行、Git、安全与 sleep 指令又在 `getSimplePrompt()` 中重复：`src/tools/BashTool/prompt.ts:277-340` 及后续 section。

应区分：

- Bash 常驻安全不变量：不跳过 hooks、不做未经授权的 destructive/remote 操作；
- commit/PR 的具体步骤：只在 `/commit`、`/commit-push-pr` 被调用时加载；
- shell 参数说明：尽量由 JSON Schema field descriptions 表达，不在 description 再逐字段复述。

### 4.3 Agent tool description 过长

`AgentTool` description 同时承载：

- agent 列表；
- when/when-not-to-use；
- foreground/background/fork 语义；
- prompt 写法教程；
- 多组正反 examples；
- concurrency、worktree、teammate 等条件分支。

位置：`src/tools/AgentTool/prompt.ts:68-289`。

已有代码证明动态 agent 列表移到 attachment 可显著降低 cache creation；下一步应把常驻 description 收敛为“语义 + 关键不变量”，把教程和 examples 移到文档/eval，把只在 fork 或 teammate 模式成立的内容保留为条件 section。

### 4.4 Task 工具重复 schema 和状态机

- TaskCreate description 重复说明何时创建、字段、状态、tips：`src/tools/TaskCreateTool/prompt.ts:16-55`；
- TaskUpdate description 重复字段定义、状态流和多个 JSON examples：`src/tools/TaskUpdateTool/prompt.ts:3-77`；
- system prompt 已要求复杂任务使用 task tool：`src/constants/prompts.ts:307-313`。

JSON Schema 已描述参数时，description 只需保留模型无法从 schema 推导的行为不变量，例如“不为简单任务创建”“开始前设为 in_progress”“只有完全完成才设为 completed”。

### 4.5 Auto memory policy 是大块常驻动态 prompt

auto memory 每个会话常驻以下内容：

- 四种 memory 类型的长 description、when/how、body structure 和多组 examples；
- what-not-to-save；
- frontmatter 模板；
- `MEMORY.md` 两步写入流程；
- recall/staleness 规则；
- memory、plan、task 的边界。

位置：

- prompt builder：`src/memdir/memdir.ts:187-266`；
- individual taxonomy：`src/memdir/memoryTypes.ts:108-178`；
- exclusions 与 recall：`src/memdir/memoryTypes.ts:180-256`；
- frontmatter：`src/memdir/memoryTypes.ts:258-271`。

其中部分 recall wording 已有 eval 依据，不能直接删除。应先把规则分为：

- 常驻决策规则：何时记、四种类型、禁止记录哪些内容、何时读取、过期信息先验证；
- 写入时才需要：完整 frontmatter 模板、index 更新步骤、文件维护细节；
- 仅用于教学/eval 的 examples：不应常驻 production prompt。

### 4.6 Environment section 注入低相关产品信息

`computeSimpleEnvInfo()` 除 cwd、Git、platform、shell、OS 和当前 model 外，还常驻：

- 最新 Claude model family 与 IDs；
- Claude Code 可用平台；
- Fast mode 说明。

位置：`src/constants/prompts.ts:650-707`。

这些信息只对“构建 AI 应用”“询问 Claude Code 产品能力”“选择模型”类任务相关，不应默认进入所有编码请求。保留实际执行环境和当前 model；将产品目录、model family 指南和 Fast mode 说明移到 Claude Code guide/docs skill 或按意图 attachment。

### 4.7 Git context 包含低频字段

`getGitStatus()` 每次会话加入 Git user 与最近五条 commit：`src/context.ts:61-103`。对普通阅读、修改、解释任务，branch + dirty status 通常足够；Git user、历史 commit style 可在真正 commit/PR 时按需查询。

### 4.8 Skills 与 deferred tool 枚举仍可能很大

当前 SkillTool 已有每条 250 字符和总计约 1% context 的预算：`src/tools/SkillTool/prompt.ts:22-52`。但本会话仍展示了大量 skills 描述和数百个 deferred MCP tool names。即使完整 schemas 已 defer，目录枚举本身仍是明显成本。

改进方向：

- 首轮只注入与当前请求相关的 top-k skills；
- 始终保留用户显式 `/skill-name` 的精确查找能力；
- 大型 MCP registry 首轮按 server/app 分组，不逐个列出全部 tool names；
- ToolSearch 在完整内部 registry 上搜索，不要求模型先看到每个名字；
- 为 names-only、grouped summary、top-k relevance 三种策略做可发现性 eval，再决定默认策略。

### 4.9 本仓库 `CLAUDE.md` 与产品默认规则重复

本会话注入的 `CLAUDE.md` 同时包含：

- 本仓库特有规则：中文、只用 bun、Makefile 入口、built/official Claude 验证、InteractiveTerminal/terminal UI、workflow parity、release 规则；
- 通用规则：先读后改、最小改动、不要过度抽象、安全输入校验、不泄露 secrets、未经授权不 commit/push、简洁沟通。

后者与默认 system/Bash prompt 高度重合。实施时应建立“项目特有规则清单”，只合并重复文案，不能删除本仓库明确加强的行为或依赖默认 prompt 的偶然措辞。

## 5. 必须保留的现有设计

以下机制是精简工作的基础，不应回退：

1. `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 及 static/dynamic cache scope；
2. `systemPromptSection()` 的会话级稳定缓存；
3. ToolSearch 的 schema defer 与 `tool_reference` 加载；
4. `deferred_tools_delta`、`mcp_instructions_delta`、`agent_listing_delta`；
5. Skill 列表的总预算与单条 description cap；
6. `MEMORY.md` 的 200 行/25KB cap：`src/memdir/memdir.ts:34-102`；
7. relevant memory 的 top-5、行数和字节 cap；
8. 权限、sandbox、schema validation、hook 和 destructive action 的运行时防线；
9. prompt/tool schema 稳定性缓存：`src/utils/api.ts:136-151`；
10. prompt cache break detection 与 dump 能力。

## 6. 规则所有权模型

实施前先为每条 model-visible instruction 指定唯一 owner：

| 规则类型 | 唯一 owner | 其他位置如何处理 |
|---|---|---|
| 跨任务安全不变量 | 精简后的 system prompt + runtime enforcement | 工具 prompt 只保留工具特有差异 |
| 文件工具选择 | system prompt 一条总则 | Bash prompt 不再逐项重复 |
| Bash 参数/输入 | JSON Schema | description 不复述字段文档 |
| Git commit/PR 流程 | `/commit`、`/commit-push-pr` skills | Bash 常驻 prompt 只保留授权与 hook 不变量 |
| Agent 调度语义 | AgentTool prompt | system prompt 只说明何时考虑 Agent |
| Agent 类型列表 | `agent_listing_delta` | 不嵌入 Tool schema |
| Task 状态不变量 | Task tool prompts | system prompt 只保留何时需要 task tracking |
| Skill 目录 | relevance attachment / DiscoverSkills | SkillTool prompt 只保留调用协议 |
| MCP/deferred tools 目录 | ToolSearch 内部 registry + delta | 首轮不枚举完整 schema/全量长列表 |
| Memory 读写决策 | 精简 auto-memory core | 写入模板按需加载 |
| Project-specific policy | `CLAUDE.md` | 不复制通用产品文案 |
| 动态环境事实 | dynamic section/attachment | 不进入 global cached static prefix |

评审规则：同一行为若需要 defense-in-depth，必须标注“模型提醒”和“机械 enforcement”的不同职责，不能用两段近义 prompt 冒充 defense-in-depth。

## 7. 分阶段实施计划

### Phase 0：建立可重复基线和行为契约

#### 目标

在改文案前得到真实 token 分布、cache 行为和必须保留的规则集。

#### 工作项

1. 新增 prompt inventory 测试/脚本，按 section 输出：
   - system static chars/tokens；
   - system dynamic chars/tokens；
   - 每个 tool description chars/tokens；
   - 每个 tool input schema chars/tokens；
   - `CLAUDE.md`、auto memory、Git context chars/tokens；
   - skills/deferred/agent/MCP attachments chars/tokens。
2. 使用现有 `dump-prompts` 捕获最终 API `init` 和 `system_update`，而不是只测 builder 返回值：`src/services/api/dumpPrompts.ts:61-129`。
3. 复用 cache break snapshot：
   - `systemCharCount`；
   - per-tool schema hash；
   - added/removed/changed tools；
   - cache control/global strategy；
   - cache read drop。
   位置：`src/services/api/promptCacheBreakDetection.ts:28-120`、`src/services/api/promptCacheBreakDetection.ts:199-248`。
4. 建立 rule-retention matrix，不依赖一份脆弱的全文 snapshot。
5. 记录当前本会话同等配置的 baseline，避免只测最小无插件环境。

#### 场景矩阵

至少覆盖：

- 基础交互会话：无 MCP、无额外 agents；
- 本仓库会话：`CLAUDE.md` + auto memory + skills；
- MCP-heavy：100+ deferred tools；
- skills-heavy：50+ skills；
- custom agents + agent listing delta；
- non-interactive/SDK；
- plan/workflow 相关工具启用；
- auto memory 开/关；
- first-party 与 third-party provider；
- compact 前后和 late MCP connect。

#### 产物

- section/token baseline；
- top 20 instruction cost report；
- critical rule matrix；
- cache fingerprint baseline；
- 后续每个 phase 的量化预算。

### Phase 1：低风险去重，不改变加载时机

#### 目标

先删除明显重复、schema 已表达和纯教学性的文本，不引入新机制。

#### 工作项

1. 合并 `getSimpleDoingTasksSection()` 中近义的最小改动/不过度设计规则；
2. 合并 tone/style 与 output efficiency 中重复的“简洁、直接、无 filler”；
3. system prompt 只保留一条 dedicated-tool 优先规则，Bash description 删除同义列表；
4. TaskCreate/TaskUpdate 删除 schema 已表达的字段列表和多数 JSON examples；
5. SkillTool 删除可由 schema 推导的 invocation examples，只保留：匹配 skill 时调用、显式 slash command、已加载标记、不可猜 built-in；
6. AgentTool 删除 greeting/prime 等教学 examples，保留一组最小的 fresh-agent briefing 规则；
7. Environment 删除平台宣传、Fast mode 和最新 model family 常驻文案，保留执行事实。

#### 安全要求

- 不动 Git 授权、不跳过 hooks、destructive/remote action 确认；
- 不动 prompt boundary 与 cache scopes；
- 不动 schema validation；
- 每删一组规则都在 rule-retention test 中确认唯一 owner 仍存在。

### Phase 2：把任务专用手册移到按需 skill

#### 目标

让普通编码会话不再为低频流程支付固定 token。

#### 工作项

1. Bash 常驻 prompt 只保留：
   - shell 调用边界；
   - sandbox/permission 语义；
   - destructive/remote Git 必须明确授权；
   - 不得绕过 hooks/signing；
   - 后台命令的通知约定。
2. commit/PR 的 status/diff/log、staging、HEREDOC、PR body 等步骤只保留在 `/commit` 与 `/commit-push-pr` skills；
3. 若某 build 没有 SkillTool 或 bundled Git skills，提供**短 fallback**，而不是恢复完整手册；
4. WorkflowTool 的长编排教程和 quality patterns 改为：
   - Tool description 保留何时适用、显式 opt-in、参数协议；
   - 完整脚本教程按调用后加载或放到专用 skill；
   - 常用 schema 示例由测试覆盖，不在每轮常驻；
5. Cron、Team、Notebook、document 类低频 built-ins 评估设置 `shouldDefer`，仅保留 turn-1 必须工具 eager loaded。

#### 验证

- 显式“commit these changes”仍选择 Git skill；
- 无 SkillTool 的配置仍不会自行 commit/push；
- 普通 shell 命令不受影响；
- Workflow 不在用户未 opt-in 时启动；
- deferred built-ins 能通过 ToolSearch 可靠发现。

### Phase 3：目录型上下文改为 relevance-first

#### 目标

避免首轮枚举所有 skills、agents、MCP/deferred tools。

#### 工作项

1. Skills：
   - 首轮只显示与用户请求相关的 top-k；
   - 显式 `/name` 始终可精确调用；
   - DiscoverSkills/Skill 内部保有全量 registry；
   - 无匹配时只显示“可搜索 skills”，不输出全量列表。
2. Deferred tools：对三种方案做 eval：
   - 全量 names-only；
   - server/app 分组 + count；
   - relevance top-k + ToolSearch 全 registry。
3. Agent list：默认启用已有 `agent_listing_delta` 路径，并确认 compact 后完整重放；
4. MCP instructions：默认使用 delta，避免 late connect 改写 system prompt；
5. 所有 delta 必须 deterministic sort、dedupe、支持 removal 和 compaction reconstruction。

#### 验证重点

- GitHub、Gmail、Chrome、Notebook、PDF 等工具在模型未见精确 tool name 时仍能通过自然语言找到；
- 新连接 MCP server 无 system/tool cache bust；
- compact 后目录不会丢失；
- 用户显式点名工具或 skill 时无额外搜索失败。

### Phase 4：Auto memory 两层化

#### 目标

保留自动记忆质量与 stale-memory 安全，同时显著减少常驻 policy。

#### 常驻 core 建议只包含

- memory 目录与“目录已存在”；
- 何时写：用户明确要求、用户纠正、稳定偏好、不可从代码/Git 推导的项目背景、外部引用；
- 四种 type 的一句话定义；
- 禁止写入的五类信息；
- topic file + `MEMORY.md` index 的最小格式约定；
- explicit recall/ignore 行为；
- stale file/function/flag 在建议前验证。

#### 按需 authoring guidance

在检测到 memory write intent 或模型首次准备写 memory 时注入：

- 完整 frontmatter 模板；
- feedback/project 的 Why/How 结构；
- index 更新步骤；
- duplicate/update/remove 流程。

#### 从 production prompt 移出

- 每个 type 的多段长 description；
- 多组 user/assistant examples；
- 对 plan/task/memory 边界的长解释，改为三条短规则；
- 仅用于说明设计动机的文字。

#### 约束

`MEMORY_DRIFT_CAVEAT` 和 `TRUSTING_RECALL_SECTION` 有已记录 eval 敏感性：`src/memdir/memoryTypes.ts:197-255`。必须逐句做 ablation eval，不能一次性重写。

### Phase 5：精简 Git/user context 与项目 CLAUDE.md

#### Git context

默认只注入：

- 当前 branch；
- main branch；
- dirty/clean status（继续保留 2KB cap）。

Git user 与最近 commits 在 commit/PR skill 中按需读取。比较删除它们后对“理解当前分支”和 commit message style 的影响。

#### `CLAUDE.md`

1. 建立“本仓库特有”清单，必须保留：
   - 中文输出；
   - bun-only；
   - Makefile/build/built-claude/official-claude；
   - terminal/InteractiveTerminal 验收；
   - workflow parity 边界；
   - release/publish 约束；
   - 用户已确认的本仓库特殊流程。
2. 将通用最小改动、安全、secrets、Git 授权、简洁沟通合并为短 section；
3. 不以“默认 system 已经有”为唯一删除依据；应在 repo instruction contract 中保留项目确实需要强化的差异；
4. 检查 auto memory 中已记录规则是否与 `CLAUDE.md` 重复，稳定项目规则优先进入 `CLAUDE.md`，个人偏好留 memory。

### Phase 6：收敛、灰度和删除旧路径

1. 每个 phase 独立 feature gate/实验，避免一次改写全部 prompt；
2. 对比 baseline 的 token、cache、tool selection、safety 和 task completion；
3. 达标后删除旧 prompt 分支，不长期保留双轨兼容文案；
4. 清理临时 telemetry、debug dump 和仅供迁移的 helper；
5. 最终更新 prompt ownership 文档，防止未来重新复制规则。

## 8. 测试与验收

### 8.1 静态/单元测试

新增或加强：

1. `getSystemPrompt()` section-level snapshot：
   - 不建议只做全文 snapshot；
   - 断言 boundary、section 顺序、critical rules、chars/token budget。
2. `splitSysPromptPrefix()`：
   - static/global 与 dynamic/null scope 不变；
   - MCP/tool-based strategy 不变。
3. Tool prompt budget：
   - 对每个 built-in 记录 description 与 schema 大小；
   - 对异常增长设置 budget gate。
4. Rule-retention tests：
   - no unauthorized commit/push/destructive action；
   - no hook bypass；
   - read before edit；
   - dedicated tools；
   - truthful verification；
   - skill opt-in 与 workflow opt-in；
   - memory save/ignore/stale verify。
5. Delta tests：
   - deferred tools、MCP instructions、agent listing 的 add/remove/dedupe/compact replay；
   - ToolSearch 返回 `tool_reference` 后 schema 可调用。
6. Context tests：
   - CLAUDE.md load order、override、conditional rules、截断；
   - auto memory index 200 行/25KB；
   - relevant memory top-5 与字节/行截断。

现有测试缺口：`src/constants/system.test.ts:1-111` 目前主要覆盖 attribution；`src/utils/attachments.codexApps.test.ts:1-14` 只覆盖 Codex app mention，不足以保护 prompt reduction。

### 8.2 行为 eval

每个候选精简需至少覆盖：

- 简单问答不滥用 task/agent/workflow；
- 修改代码前先读相关文件；
- bug fix 先定位、测试、修复、验证；
- 用户未授权时不 commit/push/创建 PR；
- 用户授权 commit 时按需加载 skill 并正确执行；
- destructive command 会停下确认；
- 工具被拒绝后不原样重试；
- skill、agent、deferred MCP tool 可发现；
- memory 显式 remember/forget、反馈记忆、ignore memory、stale claim；
- 没跑测试时不声称通过；
- 中文/project style 等用户指令仍覆盖默认行为。

### 8.3 本地端到端验证

实施阶段遵循仓库现有入口：

1. 先检查 `Makefile` 当前 `VERSION` 和目标；
2. `make build` 生成 `./built-claude`：`Makefile:14-16`；
3. 在 InteractiveTerminal 中启动 `./built-claude --dangerously-skip-permissions`，验证真实多轮请求、skills、ToolSearch、memory 和 compact；
4. 需要官方 parity 时使用仓库内 `./official-claude --dangerously-skip-permissions`；
5. 对 prompt/workflow 行为调用对应 validation skill，不把不完整或弱证据运行计为通过；
6. 执行相关 `bun test`、`bunx tsc --noEmit --pretty false`、`bun run lint`、`git diff --check`。

注意：仓库 `CLAUDE.md` 的 tmux 要求与持久 memory 中“优先 InteractiveTerminal”存在历史差异。实施前应以用户最新明确偏好为准，统一验收说明，避免双轨操作。

## 9. 量化成功标准

Phase 0 得到真实 baseline 后锁定绝对预算；在此之前使用以下相对目标：

- 基础无 MCP 场景 cold-start instruction tokens 至少下降 **20%**；
- 本仓库 + auto memory + skills 场景至少下降 **30%**；
- MCP-heavy 场景至少下降 **50%**；
- built-in tool descriptions 总 tokens 至少下降 **35%**；
- auto memory 常驻 policy 至少下降 **40%**；
- 非任务相关 skills/deferred tool 目录首轮 tokens 至少下降 **70%**；
- `system_update` 次数不增加；
- late MCP/agent/skill 变化不引起稳定 system/tool schema cache bust；
- critical rule retention 100%；
- safety、Git、memory、tool discovery eval 不允许出现统计显著回退；
- task completion/正确性无显著回退，不能只以 token 指标上线。

如果某项压缩达到 token 目标但降低可发现性或遵循率，应回退该项，不用更多重复 prompt 在其他层补救。

## 10. 建议的首批改动批次

为了降低评审和回归定位难度，建议按以下小批次实施：

1. **Observability only**：baseline、budget report、rule matrix，不改 prompt；
2. **Task + Skill prompt trim**：低风险删除 schema duplication/examples；
3. **Agent prompt trim**：保留 attachment agent list，删除教程 examples；
4. **Bash Git workflow extraction**：流程进入 skills，常驻只留不变量；
5. **Environment trim**：移除低相关产品宣传信息；
6. **Skills/deferred registry relevance-first**：需要独立 tool discovery eval；
7. **Memory core/authoring split**：单独实验，逐条跑 memory eval；
8. **CLAUDE.md cleanup**：最后执行，避免与产品 prompt 变化同时发生导致归因困难。

每批次只改变一个 cost center，并在合并前记录：before/after tokens、prompt/cache hashes、相关 eval、InteractiveTerminal 证据和未验证项。

## 11. 风险与缓解

### 风险 1：删掉重复规则后模型遵循率下降

缓解：先做 owner matrix；保留唯一、位置明确、措辞直接的规则；对安全和真实性规则做行为 eval，而非字符串存在性检查。

### 风险 2：把内容改为按需后无法发现 skill/tool

缓解：搜索 registry 仍是全量；只减少 model-visible catalog；对自然语言任务做 top-k recall、exact slash invocation 和 ToolSearch success eval。

### 风险 3：字符减少但 cache 变差

缓解：每次改动检查 static/dynamic boundary、tool schema hashes 和 `system_update`；动态内容优先 attachment，不放回 static prompt 或 tool description。

### 风险 4：memory prompt 对 wording/位置敏感

缓解：保留已 eval 的 recall/staleness section；逐段 ablation；memory stream 单独灰度，不与其他 prompt 重写同批上线。

### 风险 5：项目规则依赖产品默认 prompt

缓解：`CLAUDE.md` 只删除真正重复的表述，不删除本仓库明确差异；用 repo instruction contract 独立验证 bun、构建、终端、workflow、release 和 Git 行为。

### 风险 6：第三方 provider/build 没有同样的 skills 或 beta 能力

缓解：为无 ToolSearch、无 SkillTool、无 delta beta 的路径设计短 fallback；纳入 provider/build 矩阵；不要把完整旧 prompt 永久保留为 fallback。

## 12. 完成定义

只有同时满足以下条件，指令精简项目才算完成：

- 所有 model-visible instructions 都有明确 owner 和生效范围；
- 默认 system、tool descriptions、context、attachments 有自动大小预算；
- 大型动态目录不再进入稳定 schema 或全量首轮枚举；
- Git/workflow/memory 等低频手册按需加载；
- cache boundary 和 delta reconstruction 有测试；
- critical behavior eval 与本地真实交互通过；
- prompt dump 证明目标场景 token 降幅达标；
- 没有依靠弱化 runtime safety、测试或验证来获得数字；
- 旧路径、重复文案、临时 gate/debug code 已清理；
- 最终 diff 不含无关改动，且未经用户明确批准不创建 commit。
