# Agent 与后台任务

> 英文名：`agents` · 领域：Agent 与编排 · [返回功能索引](README.md)

## 作用与效果

`Agent` 工具启动子代理：交互会话默认 fork 模式（后台运行），支持 `SendMessage` 续跑、嵌套、`/subtask` 手动 fork、usage 聚合与终态通知、`isolation: "worktree"`。默认内置只读 `Explore` 与 `Plan`。运行中的子代理跟随主会话当前权限模式（显式 `mode` 为上限）；auto 下子代理用 `SubagentHandback` 交回报告。

## 配置

| 配置项 | 位置 | 可选值 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS` | 环境变量 | `1` | 开启 | 移除 `Explore` 与 `Plan` |
| `CLAUDE_CODE_FORK_SUBAGENT` | 环境变量 | `0` | 交互模式开启 | 关闭自动 fork，模型才看到 `run_in_background` |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | 环境变量 | `1` | — | 禁用后台任务 |
| `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` | 环境变量 | 正整数 | `20` | 同时运行上限 |
| `CLAUDE_CODE_SENDMESSAGE_HANDBACK` | 环境变量 | `0` | 开启 | 停用 auto 下的 SubagentHandback |
| `omitClaudeMd` / `autoCompactWindow` | agent frontmatter | `true` / `100000`–`1000000` | — | 子代理不加载 CLAUDE.md / 压缩窗口上限 |
| `worktree.baseRef` | settings | `fresh` / `head` | `fresh` | 新 worktree 分支起点 |
| Agent 输入 | 模型调用 | `{"description","prompt","subagent_type","model","effort","name","isolation"}` | — | — |

## 效果

`Explore` 子代理在后台运行并回报：

```text
❯ DO<<Agent|{"description":"scan repo","prompt":"list files","subagent_type":"Explore"}>>
● Explore(scan repo)
  ⎿  Backgrounded agent (↓ to manage · ctrl+o to expand)
● FAKE_DONE
✻ Sautéed for 0s · 1 local agent still running
● Agent "scan repo" completed
● FAKE_DONE
✻ Cooked for 0s
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ? for shortcuts · ↓ to manage                                                           ◐ medium · /effort
    ● main
    ◯ Explore  scan repo                                                                    0s · ↓ 15 tokens
```

`/agents` 的内置列表；设 `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1` 后 `Explore` 与 `Plan` 消失：

```text
    Built-in (always available):
    claude-code-guide · haiku
    Explore · haiku
    general-purpose · inherit
    Plan · inherit
    statusline-setup · sonnet
  Press ↑↓ to navigate · Enter to select · Esc to go back
```

```text
    Built-in (always available):
    claude-code-guide · haiku
    general-purpose · inherit
    statusline-setup · sonnet
  Press ↑↓ to navigate · Enter to select · Esc to go back
```

## 详细说明

以下内容自原 README 迁入，保持原文。

### Agent 与后台任务

默认内置两个只读专业 Agent：

- `Explore`：快速搜索和理解代码库；
- `Plan`：在不修改代码的前提下分析调用链并设计实施方案。

可通过以下环境变量同时关闭它们：

```bash
CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1 claude
```

Agent 还支持前台执行、后台执行、命名续跑和可选隔离。模型可使用的典型输入为：

```json
{
  "description": "检查配置映射",
  "prompt": "核对 provider effort 的当前行为并报告证据。",
  "subagent_type": "general-purpose",
  "model": "sonnet",
  "run_in_background": true,
  "name": "effort-review",
  "isolation": ""
}
```

交互会话默认启用 fork 模式，此时 Agent 默认在后台运行，schema 不暴露 `run_in_background`；只有设置 `CLAUDE_CODE_FORK_SUBAGENT=0`、在非交互模式或 coordinator 模式下，模型才能看到该参数。以下设置会在任何模式下移除该参数并禁用后台任务：

```bash
CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 claude
```

子代理权限：

- 运行中的子代理跟随主会话当前的权限模式，并在主会话切换模式后同步；Agent 调用显式传入的 `mode` 与 workflow 阶段的 `permissionMode` 作为上限。Agent 定义中的 `permissionMode` 不覆盖处于 bypassPermissions、acceptEdits 或 auto 的父会话，也不会授予 `bypassPermissions`；声明 `auto` 而自动模式不可用时沿用父会话模式。
- 交互式会话中，后台子代理需要确认的操作在主会话弹出权限对话框并标示来源（如 `from the general-purpose agent`）。
- 进程内 teammate 在 leader 处于 bypass、acceptEdits 或 auto 时改用 leader 的模式；leader 在 default 或 plan 时 teammate 保留自己的模式，界面提示 `Teammates keep their own permission mode`。

主会话处于 auto mode 时，Agent 工具启动的子代理通过 `SubagentHandback` 工具交回最终报告（由分类器审查），末尾的普通文本不会作为结果送达；被分类器 block 时报告仍送达，但附带 `SECURITY WARNING`，并以 `[Subagent hand-back]` 框架呈现。停用：

```bash
CLAUDE_CODE_SENDMESSAGE_HANDBACK=0 claude
```

自定义 Agent（`.claude/agents/<名称>.md`、插件 agents 或 `--agents` JSON）可设置 `omitClaudeMd` 与 `autoCompactWindow`：

```yaml
---
name: reviewer
description: Review the staged diff
omitClaudeMd: true        # 作为子代理运行时不加载 CLAUDE.md
autoCompactWindow: 150000 # 子代理的自动压缩窗口上限（100000 到 1000000）
---
Review the diff.
```

`autoCompactWindow` 只能把继承到的窗口调小；`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 仍优先。超出范围的值会被忽略并写入 debug 日志。

Worktree 设置 `worktree.baseRef` 决定 `--worktree`、`EnterWorktree` 和 agent `isolation: "worktree"` 新建分支的起点：`fresh`（默认）基于 `origin/<默认分支>`，`head` 基于当前工作目录（包括 linked worktree）的本地 HEAD，保留未推送提交：

```json
{ "worktree": { "baseRef": "head" } }
```

`EnterWorktree` 也可传 `path` 进入已在 `git worktree list` 中的 worktree；`.claude/worktrees/` 之外的路径会先请求确认。以 `path` 进入的 worktree 不归当前会话所有，`ExitWorktree` 只能 `keep`，不会删除它。

### Agent 启动回执与异步通知

模型通过 Agent 工具启动后台任务时，`tool_result` 是内部启动信息，不能把原始回执或 Agent ID 直接展示给用户。续接 Agent 时，使用 `SendMessage` 的 `to` 和 `summary`。收到完成通知前，启动回执不提供任务结果；可以继续其他工作或回复用户，询问进度时说明任务仍在运行。

调用者有 Read／Bash 且输出路径非空时，回执包含 `output_file`；该文件是完整子任务 JSONL，不应使用 Read 或 shell 读取／跟踪来查询进度，应等待完成通知。缺少读取工具或路径为空时，返回不含文件路径的说明。此工具回执与 `$.agent.spawn` 的身份回执分别验收，Mods 仍可通过真实工具 middleware 观察工具结果。

运行 `bun test ./src/tools/AgentTool/AgentTool.receipt292.test.ts` 核对完整文字及空路径回退。固定官方 2.1.292 的两组真实 CLI 场景中，默认启动回执文字逐字一致，仅归一化实际子 Agent ID 和对应输出路径；Messages 的缓存字段、条件共享目录提示、其他结果分支与完整生命周期仍待独立验收。异步任务的请求交错受完成时机影响；延后子任务返回时，双方都需要再次处理完成通知，不能把单次运行的请求数量作为唯一判据。

### Agent 并发限制

普通本地 Agent 与 Mod 插件各自检查同时运行数，默认上限为 20。`ultracode` effort 且已启用 Workflow 脚本、模型支持 xhigh 时，或服务端开关 `tengu_amber_kestrel` 开启时，普通 Agent 不检查全局上限。启动 CLI 前可配置：

```sh
export CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=2
```

变量支持 trim 后带可选符号的正十进制整数，无效值回退到 20。启动回执返回后，后台任务继续占用名额；前台转后台保留同一名额，恢复普通 Agent 时重新预留。同步 `context: fork` 技能本身不占普通 Agent 名额，技能内实际调用的 Agent 仍受同一全局限制。

作者应处理全局额度不足的返回值：

```js
const result = await $.agent.spawn({ prompt: 'Review the change', subagentType: 'general-purpose' })
if ('deny' in result) {
  await $.ui.log(result.deny)
} else {
  await $.ui.log(`Started ${result.agentId}`)
}
```

插件自身额度耗尽仍抛出包含插件名的异常。全局计数的预留和释放可在 --debug 日志的 `[AgentConcurrency]` 记录中核对；拒绝记录为 `Agent concurrent limit reached: running=… limit=…`。本轮验证及原生入口限制见 [全局并发记录](../../docs/research/mods-agent-concurrency-20261007.md)。

同步 fork 技能的进度、查询与启动/完成 debug 使用同一个 agent ID。运行 `bun test --no-env-file ./src/utils/processUserInput/processSlashCommand.concurrency.test.ts` 可验证 slash 与 SkillTool 的计数和身份；实际 CLI 对照见 [fork 技能专项](../../docs/research/mods-fork-capacity-20261007.md)。交互入口默认后台启动 fork 技能，初始技能工作者不占普通 Agent 名额；技能内实际 Agent 和恢复执行仍计数。`background: false`、非交互模式或禁用后台任务时使用同步执行。技能配置参考 [Anthropic 官方 skills 文档](https://code.claude.com/docs/en/skills#run-skills-in-a-subagent)。

插件可在 `skills/review/SKILL.md`（或旧 `commands/review.md`）声明 `context: fork` 和 `agent`。加载器保留这两个字段；slash 与模型的 SkillTool 调用进入已有的独立执行上下文。自定义 agent 使用完整名称，例如 `my-plugin:reviewer`，定义放在插件的 `agents/reviewer.md`。

```yaml
---
description: Review the supplied changes
context: fork
agent: my-plugin:reviewer
background: false
---
Review $ARGUMENTS and report concrete findings.
```

使用 `--plugin-dir /absolute/path/my-plugin` 加载，再运行 `/my-plugin:review <任务>`。`background: false` 使本例同步执行；省略该字段时交互入口默认后台运行。验收记录见 [插件 fork 入口专项](../../docs/research/mods-plugin-fork-20261007.md)，配置含义见 [Anthropic skills 文档](https://code.claude.com/docs/en/skills#run-skills-in-a-subagent)。

### 后台 Agent 等待子任务与续跑

普通后台 Agent 自己启动后台子任务时，完成当前一轮后会释放执行名额，并保持可接收通知的身份。Mod 使用 `await $.agent.list()` 可看到父任务从 `running` 变为 `waiting`；子任务完成通知会自动触发父任务续跑，保留原 agent ID 与实际模型。所有子任务结束且父任务完成续跑后，主会话收到最终通知。

`parentId` 仍表示上下文继承关系；运行时 `ownerAgentId` 表示通知归属。`TaskStop` 和 SDK `stop_task` 可停止等待中的父任务。`--debug --debug-file /absolute/path/debug.log` 的 `[AgentLifecycle] owner_parked/owner_wake` 日志可核对父任务 ID、待处理数量与续跑；失败会打印关联 ID 和原因。

运行 `bun test --no-env-file ./src/tools/AgentTool/backgroundOwner.test.ts ./src/tasks/LocalAgentTask/LocalAgentTask.progress.test.ts` 验证生命周期。真实终端证据、相邻入口与剩余范围见 [后台父子任务专项](../../docs/research/mods-background-owner-20261007.md)。fork 技能后台启动和权限记录恢复见下一节；所有前台/工作流/故障组合仍继续验收；子代理的通用配置见 [Anthropic subagents 文档](https://code.claude.com/docs/en/sub-agents)。


### fork 技能后台启动与权限恢复

交互模式调用 `context: fork` 技能时，slash 和 SkillTool 默认返回后台启动回执，父会话可以继续输入。`background: false` 使用同步执行；`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` 或非交互会话也保持同步。存在同名未结束任务、达到嵌套深度限制或无法保存权限记录时，回退到同步路径。

```yaml
---
name: review
description: Review the requested code
context: fork
agent: general-purpose
allowed-tools: Read, Grep, Glob
disallowed-tools: Bash, Write, Edit
---
Review $ARGUMENTS and report findings.
```

后台任务使用独立名称和 agent ID。任务的子任务未结束时，公开 `$.agent.list()` 显示 `waiting`，子任务通知可触发原 ID 续跑。名称可用于 `SendMessage`；fork 技能不能在自己的上下文中再次调用同一技能。

启动前先保存 `.forked-skill.marker.json` 和 `.forked-skill.json` 到该 agent 的 transcript 目录，记录技能身份、effort 和启动时的 command deny 规则。恢复时重新解析当前技能，替换 command allow 规则，合并保存的 deny、当前 deny 和技能 `disallowed-tools`。权限记录缺失、损坏、超限、身份不匹配或技能不再支持 fork 时拒绝恢复。

运行 `bun test --no-env-file ./src/utils/forkedSkill.test.ts ./src/tools/SkillTool/UI.test.tsx` 检查启动、权限和 UI 状态。[专项验收与剩余差异](../../docs/research/mods-fork-background-20261007.md) 区分自动化、真实终端和未覆盖结果；此批不代表所有 Mods API、Workflow 与 diff/UI 已完成对齐。配置参考 [Anthropic skills 文档](https://code.claude.com/docs/en/skills#run-skills-in-a-subagent)。

### 普通 Agent 的前后台执行

普通 Agent 调用省略 `run_in_background` 时，默认返回后台启动回执。关闭 fork 模式后，需要等待结果再继续时，显式传 `run_in_background: false`；若 agent 定义声明 `background: true`，仍会后台运行。进程内 teammate 的默认子任务保持同步；`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` 禁用后台执行。

对于普通 Agent，Mods 的 `agent.spawn` 事件中，`background` 表示已经解析的执行模式。回调可以将其改为 `false` 以请求前台执行；实际模式仍受后台禁用和已有强制路由规则约束。初始注册、执行和元数据使用相同计算，后台通知、并发计数与 `SendMessage` 恢复沿用现有生命周期。

运行 `bun test --no-env-file ./src/tools/AgentTool/backgroundRouting.test.ts` 检查默认路由及边界。真实官方/本地终端证据与剩余范围见 [专项验收](../../docs/research/mods-agent-background-default-20261007.md)，背景概念见 [Anthropic subagents 文档](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background)。显式 fork 模式及默认开启方式见下一节；命令与 UI 仍分别验收。

### 显式 fork 模式

交互会话默认启用 fork 模式。模型调用 Agent 时，省略 `subagent_type` 使用独立上下文的 `general-purpose`；显式 `subagent_type: "fork"` 才继承当前对话、系统提示、工具定义及父模型。fork 忽略 `model` 参数和 `CLAUDE_CODE_SUBAGENT_MODEL`，以保留父模型与缓存前缀。

```json
{"description":"核对映射","prompt":"核对 provider effort 映射并报告证据。","subagent_type":"fork","name":"effort-review"}
```

fork 模式强制普通 Agent 后台执行，schema 不暴露 `run_in_background`。需要普通 Agent 支持显式前台执行时，可在启动前设置：

```bash
CLAUDE_CODE_FORK_SUBAGENT=0 claude
```

`CLAUDE_CODE_FORK_SUBAGENT=1` 可为非交互会话启用该模式。模式开启的 headless 子 Agent 默认同步启动自己的子任务；Mods 的 `$.agent.spawn({subagentType: "fork", prompt: "..."})` 属于脚本入口，可在非交互会话显式 fork，但仍尊重显式关闭、协调模式、允许类型与 deny。脚本标记不会继承到子会话的模型工具调用。

自定义同名 agent 遮蔽合成 fork；`Agent(fork)` deny 阻止合成 fork，普通 Agent 的后台规则继续有效。合成 fork 拒绝再次 fork 和 remote 隔离。调试日志的 `[ForkMode]` 记录开启来源与会话 ID，Agent 启动日志记录类型、模型、后台模式和 ID。

运行 `bun test --no-env-file ./src/tools/AgentTool/forkMode.test.ts ./src/tools/AgentTool/backgroundRouting.test.ts` 检查路由。对照依据见 [Anthropic fork 模式说明](https://code.claude.com/docs/en/sub-agents#turn-fork-mode-on-or-off)，实际证据与剩余范围见 [专项验收](../../docs/research/mods-fork-mode-20261007.md)。本批完成模型 Agent 和 Mods spawn 的门禁迁移；内置 `/fork` 命令与 fork 指令折叠 UI 仍待独立实现和验收。

### 手动启动继承对话的子任务（官方 2.1.292）

在交互会话中输入 `/subtask <task>`，将当前对话交给后台 fork，同时继续使用主会话，例如：

```text
/subtask review the parser changes and report the missing test cases
```

子任务继承主对话的模型、工具定义、系统提示和历史。`CLAUDE_CODE_FORK_SUBAGENT=0` 控制模型的自动 fork 选择，不禁用用户手动的 `/subtask`。命令回执包含名称和 agent ID 后四位；`[ConversationFork]` 调试日志打印完整 ID、模型、深度和 owner。具名 fork 的结果返回后可以通过 `SendMessage` 恢复同一 ID，继续继承主对话模型。Mods 的 `$.agent.list()` 对已结束且可恢复的具名 fork 返回 `idle`；这与内部任务的 `completed` 状态不同。

fork 首条消息按官方格式显示为 `⑂ <directive>`，隐藏固定 worker 说明。只有完整匹配当前模板的消息才折叠，包含同名标签的普通文本、旧模板及被改写的说明仍正常显示。

[Anthropic 官方文档](https://code.claude.com/docs/en/sub-agents#fork-the-current-conversation) 说明：新版本默认使用 `/subtask` 启动子任务，`/fork` 则复制整个后台会话；关闭官方 agent view 时命令映射还会变化。本批实现 `/subtask` 与指令显示；`/fork` 的独立后台会话、agent view 映射和完整交互仍待后续迁移。不要把本批理解为这几项已经兼容。验证与源码依据见 [子任务专项](../../docs/research/mods-subtask-20261007.md)。

### 禁用后台任务时恢复子 Agent

以 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 claude` 启动交互会话后，向已结束的子 Agent 调用 `SendMessage` 会等待恢复执行完成，再把最终报告返回给调用者。恢复沿用原 Agent ID 和已保存的历史；fork 继承主模型，普通 Agent 保留自己的模型。恢复期间可中断父查询，子执行随之停止。

Mods 可通过 `$.tool.call({tool: 'SendMessage', to: agentId, message: 'Continue the review'})` 触发同一工具路径。结果的 `inlineHandback` 包含 `displayName`、`content`、`harnessNoteCount`、`harnessTailCount` 和 `harnessSectionHash`；这些显示与分段字段由工具格式化器处理。模型收到带来源说明的缩进报告，终端显示 `Resumed agent <name>. Result:`；原始 ID 显示前七位。该次报告不会额外产生后台完成通知。未禁用后台任务时，恢复仍返回后台回执并由完成通知交付结果。

报告默认使用官方框架；`CLAUDE_CODE_HANDBACK_PROVENANCE=0` 可使用原始 JSON 报告格式。`/subtask` 是用户手动启动的后台任务入口，这个开关不改变它的初次启动。

调试日志 `[AgentResume]` 记录 Agent ID、模型、交付方式和同步交付终态。恢复用法参考 [Anthropic 官方文档](https://code.claude.com/docs/en/sub-agents#resume-subagents)，实测与剩余差异见 [同步恢复专项](../../docs/research/mods-inline-resume-20261007.md)。报告内容扫描、web-fetch 特殊恢复入口及完整任务管理 UI 仍在整体对齐范围内。

### 停止与恢复子 Agent

按两次 `ctrl+x ctrl+k` 可确认停止后台 Agent；在 Agent 视图按 Escape、关闭运行中的任务或通过 SDK `stop_task` 停止，也属于用户取消。此时原 Agent 的 `stoppedByUser` 标记保存到元数据，`SendMessage` 会拒绝自动恢复，重启会话后仍有效。只有用户明确要求重新开始时，才应创建新的 Agent 任务。

模型调用 `TaskStop` 或系统中断不会设置用户取消标记；这些任务与已完成、失败的任务仍可通过 `SendMessage` 正常恢复。标记表示停止来源，不能只凭内部 `killed` 状态判断。`[AgentCancellation]` 日志记录停止/拒绝的完整 ID 及 live/metadata 来源，不打印消息内容。

回执沿官方分支保留措辞：内存中已取消的任务返回 `was stopped by the user and was not resumed`；从磁盘恢复被拒绝时返回 `was stopped by the user and won't be resumed`。两者都返回 `success: false`，不会启动新的模型请求。源码和测试证据见 [用户取消专项](../../docs/research/mods-user-cancellation-20261007.md)。该项不代表完整任务 UI、观察者、teammate、Workflow 或跨会话目标解析已完成兼容。

### SendMessage 的会话身份绑定

向本会话的具名子 Agent 发送普通文本时，成功回执包含 `pin: {id, name, ref}`。同一名称换绑至新的 Agent 后，继续使用裸名会返回 `success: false`，消息不投递；按回执中的 `name [ref]` 确认新目标，或用原始启动回执里的 Agent ID 继续旧任务。例如：

```js
await $.tool.call({tool: 'SendMessage', to: 'reviewer', message: 'Continue the review'})
// 名称换绑后，使用拒绝回执给出的准确 ref：
await $.tool.call({tool: 'SendMessage', to: 'reviewer [a1b2c3]', message: 'Review the new change'})
```

同步 Agent 完成后也保留名称寻址。注册名称支持官方的 Unicode 规范化规则和至少三字符的唯一前缀；前缀歧义需要完整名称和准确 ref。历史恢复只接受匹配的 SendMessage 工具调用及成功、非错误结果的 `toolUseResult` 元数据。`/clear` 清空身份绑定，恢复/分支/回退按保留的历史重建；运行中的 Agent 名称仍可使用。

公开工具回执保留 pin；模型结果省略终端专用的 `display`，默认同步恢复报告框架仍采用官方的精简 JSON 头。`[SendMessage]` 日志记录绑定名称、Agent ID 和 ref，不打印消息内容。范围与证据见 [SendMessage 身份绑定专项](../../docs/research/mods-sendmessage-pin-20261007.md)，相关接口见 [Anthropic Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)。跨会话/云目标的统一解析与完整 Mods API、UI、diff 验收继续进行。
