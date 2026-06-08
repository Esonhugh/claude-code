# Workflow 改进计划

## 背景

Session `3571afe2` 中 `/deep-research 分析 claude 的 dynamic workflow 设计原理` 执行失败，根因是 `buildAgentPrompt` 未将用户输入（`runArgs`）注入到 scope agent 的 prompt 中，导致 scope 阶段"正常完成"但输出无效，后续所有 phases 空转。

通过逆向分析官方二进制，发现本项目与官方在 workflow 执行架构上存在根本性差距：官方使用完整的 Script VM Runtime 执行 JS 脚本，而本项目将脚本降级为声明式 spec 后走静态 phase 循环。

## 已完成修复 (Bug Fix)

### Bug 1: runArgs 未注入 root phases ✅

**文件**: `src/tools/WorkflowTool/runWorkflow.ts`

`buildAgentPrompt` 函数接收 `_runArgs` 参数但从未使用。对于所有 `dependsOn=[]` 的 root phases，用户输入永远不会传递到 agent prompt 中。

**修复**: 对 root phases 追加 `"User input:\n<runArgs>"` 到 prompt 末尾。

### Bug 2: root phase 输出无效时无 guard ✅

当 root phase agent 正常完成但输出为空/极短时（如超时、错误），后续 phases 继续空转浪费 tokens。

**修复**: 单 agent root phase 输出 <20 chars 时 throw 终止 workflow。

### Bug 3: workflow 失败时不 abort 并发 agents ✅

`catch` 块中未调用 `workflowAbortController.abort()`，导致 batch 中其他并发 agents 在 workflow 已 fail 后继续运行。

**修复**: 在 catch 块首行加入 `workflowTask.abortController?.abort()`。

## 架构改进：Script VM Runtime

### 问题描述

官方的 `deep-research` 和 `code-review` 是 **script-based** workflows，通过完整 JS 脚本执行：
- `pipeline()` 无屏障流水线
- `parallel()` 吞异常返回 null
- 条件分支 `if (!scope) return { error: ... }`
- 动态 fanout（`scope.angles.length` 决定子 agent 数）
- Schema 强制结构化输出
- 跨 agent 状态共享

本项目将这些脚本在 dry-run 阶段转为静态 spec，真正执行时走 `runWorkflowPlan` — 脚本逻辑全部丢失。

### 改进方案

在 `WorkflowFacadeTool` 和 `WorkflowTool` 的 `run` 路径中，对 `runtime.kind === 'javascript-worker'` 的 spec，不走 `runWorkflowPlan`，而是创建真实的 VM context 重新执行脚本。

#### 需要实现的模块

1. **`workflowScriptRuntime.ts`** — 真正的 script 执行器
   - 创建 VM sandbox，注入 real hooks
   - `agent()` → 调用 AgentTool 启动子 agent
   - `pipeline()` → 无屏障流水线
   - `parallel()` → Promise.all + catch→null
   - `args` → 注入用户输入
   - 返回脚本的 return 值作为 workflow 结果

2. **修改 `WorkflowFacadeTool.ts`** — 增加 script 执行分支
   - 当 spec 有 `runScriptSnapshot` + `runtime.kind === 'javascript-worker'` 时
   - 走 `runWorkflowScript()` 而非 `runWorkflowPlan()`

3. **修改 `WorkflowTool.ts`** — 同样增加分支
   - `run` action 对 script-based workflow 走 script runtime

#### API 设计

```typescript
export async function runWorkflowScript(options: {
  script: string
  args?: WorkflowArgs
  context: ToolUseContext
  canUseTool: CanUseToolFn
  assistantMessage: AssistantMessage
  workflowRunId?: string
  abortController?: AbortController
}): Promise<{ result: unknown; agentCount: number; logs: string[] }>
```

### 优先级

1. ✅ Bug fixes (已完成) — 解决 session 3571afe2 的直接问题
2. ✅ Script VM Runtime (已完成) — 彻底对齐官方行为

## 验证结果

| 测试项 | 结果 |
|--------|------|
| deep-research (spec-based, runArgs 注入) | ✅ scope agent 正确收到用户输入 |
| autopilot (spec-based, runArgs 注入) | ✅ 7/8 agents 正常完成 |
| hello-script (.js, script VM runtime) | ✅ agent() 真实调用 API，return 值正确 |
| 无 args 时 guard 防护 | ✅ output<20chars 会 abort workflow |
| workflow 失败时 abort signal | ✅ 并发 agents 收到 abort |
