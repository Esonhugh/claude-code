# Dynamic Workflow

> 英文名：`workflows` · 领域：Agent 与编排 · [返回功能索引](README.md)

## 作用与效果

`Workflow` 工具运行 JavaScript 编排脚本（`agent`、`parallel`、`pipeline`、`phase` 等 globals）、declarative plan 或保存的 workflow，支持 journal/resume、pause、skip/retry 与终态通知。`/workflows` 查看本会话的 run，并可把动态 workflow 保存成命名 workflow。

## 配置

| 配置项 | 位置 | 可选值 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `enableWorkflows` / `disableWorkflows` | settings | `false` / `true` | 开启（Pro 计划关闭） | 也可在 `/config` → Dynamic workflows 切换 |
| `CLAUDE_CODE_DISABLE_WORKFLOWS` / `CLAUDE_CODE_WORKFLOWS` | 环境变量 | `1` / `0`、`1` | — | `CLAUDE_CODE_WORKFLOWS=1` 让 Pro 也默认开启 |
| `workflowSizeGuideline` | settings | `unrestricted` `small` `medium` `large` | `medium` | 提示性规模指引；硬上限每 run 1000 次 `agent()` |
| `ultracodeKeywordTrigger` / `workflowKeywordTriggerEnabled` | settings | `true` / `false` | `true` | 关键词触发 |
| `skipWorkflowUsageWarning` | settings | `true` | — | 跳过用量警告 |
| workflow spec | 目录 | `docs/workflows/`、`.claude/workflows/` | — | saved workflow |

## 效果

运行前的确认对话框（脚本节选）：

```text
 Run a dynamic workflow?
   two parallel reviews
   This dynamic workflow will spin up multiple subagents across the following phases:
   1. Review
   · "'Review area A'"
 Dynamic workflows can use a lot of tokens quickly by running many subagents in parallel — which counts
 against your usage limit. Stop a running workflow at any time with /workflows, or disable dynamic workflows
 in /config.
 ❯ 1. Yes, run it
   2. Yes, and don't ask again for demo-review in
      ~/work
   3. View raw script
   4. No
 Esc to cancel · Tab to amend
   ctrl+g to edit script in $EDITOR
```

完成后 agent 列表里的 run 行：

```text
    ◯ demo-review  two parallel reviews                                   done  2/2 agents  0s · ↓ 30 tokens
```

`enableWorkflows: false` 时模型拿不到 Workflow 工具：

```text
❯ DO<<Workflow|{"script":"export const meta = { name: 'demo-review', description: 'two parallel reviews',
phases: [{ title: 'Review' }] }\nphase('Review')\nreturn await parallel([() => agent('Review area A'), () =>
agent('Review area B')])"}>>
● Workflow(Workflow demo-review)
  ⎿  Error: No such tool available: Workflow
● FAKE_DONE
```

## 详细说明

以下内容自原 README 迁入，保持原文。

### Workflow 配置与使用

本地 Workflow 以**与官方模式兼容（official-compatible）**为目标，兼容 official-style facade、script parser/runtime 和运行生命周期，但不宣称是 Anthropic 官方实现或与任意未来官方版本完全相同。

与官方 2.1.292 一致，Workflow 默认开启（Pro 计划默认关闭），也可在 `/config` 的 "Dynamic workflows" 中切换。关闭方式任选其一：`"enableWorkflows": false`、`"disableWorkflows": true`，或环境变量 `CLAUDE_CODE_DISABLE_WORKFLOWS=1`、`CLAUDE_CODE_WORKFLOWS=0`；`CLAUDE_CODE_WORKFLOWS=1` 让 Pro 计划也默认开启（显式关闭设置仍优先）：

```json
{
  "enableWorkflows": false
}
```

Workflow 工具提示会附带建议性的规模指引：默认 `medium`（少于 10 个 agent，Pro 计划为 `small`），可在 `/config` 的 "Dynamic workflow size" 中选择，或用 setting `workflowSizeGuideline`（`unrestricted`、`small`、`medium`、`large`）覆盖。它只是指引，不是硬上限；运行时的硬上限是每次运行 1000 次 `agent()` 调用。

关键词触发默认开启；正式 schema-backed setting `ultracodeKeywordTrigger` 可控制兼容关键词：

```json
{
  "ultracodeKeywordTrigger": false
}
```

`workflowKeywordTriggerEnabled`（优先于 `ultracodeKeywordTrigger`）和 `skipWorkflowUsageWarning` 也已进入 `SettingsSchema`，与官方 2.1.292 的同名设置对应。

Workflow spec 可放在：

```text
docs/workflows/
.claude/workflows/
```

`/workflows` 仅用于查看和管理运行状态；实际执行由 `Workflow` 工具或注册后的 workflow slash command（`Workflow({ name, args })`）发起。

脚本中的 `await agent(...)` 和 declarative plan 会等待实际 worker 的终态。普通 Agent 被 fork 模式或定义路由到后台时，Workflow 继续等待同一个任务；用户把前台 worker 切到后台也不重放执行。进度来自实际消息，取消保留原原因并只停止本次调用的 worker。无需为 Workflow 关闭 fork 模式。

运行完成、执行失败或通过 `TaskStop` 停止后，主会话会收到对应的任务通知，包含已测 token/tool 用量、持续时间和输出文件；已完成分支的结果也保留在输出中。暂停保留恢复状态，不发送终态通知；对已经结束的 run 再次执行不会重复启动或通知。Native39 完整门禁正常收尾：30项 / 27通过 / 3失败。code-review、workflow、workflow-retry-partial-failure、workflow-failure-detail 均通过最终验收；其余失败为 builtin-mods、terminal-canonical-diff、terminal-interaction。整体仍未通过。 本批完整回归、类型检查、新构建及默认验收驱动均通过；不代表完整 Mods/UI、browser/Client 或发布通过。详见[生命周期验收](../../docs/research/workflow-agent-lifecycle-validity-20261009.md)。

官方模式兼容点包括：

- facade 支持 saved workflow、inline `{ script }`、`{ scriptPath }` 和 declarative `{ plan }`；
- 输入优先级为 `scriptPath > name > script > plan`；
- inline workflow 的运行名称和持久化文件名来自 `meta.name`；
- 支持 `agent`、`pipeline`、`parallel`、`workflow`、`phase`、`log`、`args`、`budget` runtime globals；
- 支持 `resumeFromRunId`、journal/resume cache、`status`、`pause`、`resume`、skip/retry，以及 failed/killed/stopped 生命周期状态。

Official-style inline workflow 的最小结构：

```js
export const meta = {
  name: 'parallel-review',
  description: 'Review two areas concurrently.',
  phases: [{ title: 'Review' }],
}

phase('Review')
return await parallel([
  () => agent('Review area A'),
  () => agent('Review area B'),
])
```

首条语句必须是未注释的 `export const meta = { ... }`。脚本运行时提供 `agent`、`pipeline`、`parallel`、`workflow`、`phase`、`log`、`args` 和 `budget`。

兼容模式仍有明确的安全和可恢复性边界：

- workflow script 必须是 plain JavaScript，不支持 TypeScript syntax；
- `meta` 必须是 pure literal，拒绝 computed key、spread、method/accessor 和 template interpolation；
- 脚本只负责编排 Agent 或 child workflow，shell 和文件系统操作应交给 Agent；
- 不应依赖 Node filesystem/shell API、dynamic import、`Date.now()`、`Math.random()`、`eval`、`Function` 或 WebAssembly；
- child workflow 嵌套限制为一层。
