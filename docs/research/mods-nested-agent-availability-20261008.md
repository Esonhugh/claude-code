# 显式 nested Agent 工具准入

本批修复显式 `tools: Agent(...)` 在子 Agent 中被标为合法却没有加入可执行工具池的问题。Native18 的真实 CLI 入口曾返回 `No such tool available: Agent`；本批从已提交 `b97589c` 创建干净副本，仅修改解析分支和新增回归，未带入共享工作区的其他 Agent/Workflow 实现。

## 官方边界与实现

固定官方 2.1.292 解包模块 `chunk-03d0t1ag.js`（SHA-256 `36e6eff455873c63bf69f27b635bdc3aa35e73dc3607e15755400786674a9248`）中的 `MA`，在子线程且过滤后工具映射不含 Agent 时，保留合法工具声明与 `allowedAgentTypes`，跳过工具授予；Agent 存在时继续普通解析。深度限制由相邻的 `xl` 独立处理。

本地 `resolveAgentTools` 使用同一可用性条件。缺失或被 `disallowedTools` 禁止的 Agent 继续只携带类型元数据；工具去重、通配符、主线程解析和相邻主线程工具限制继续有效。没有修改权限判定、深度限制、Fork 默认后台行为或 Workflow 的调用结果契约。

本批不声称整个 resolver 已与官方等价：官方的多条类型限制合并、alias/family、unavailable 分类和深度移除字段仍需继续逐项核对。固定 292 的代码证据不能替代最新版 293 的真实运行验收。

## 使用

项目的 `.claude/agents/parent.md` 可以显式声明可用的子 Agent，例如：

```markdown
---
name: parent
description: Delegate a read-only check to child
tools: Agent(child), Read
---
Use child for the delegated check, then return its result.
```

同时定义名为 `child` 的 Agent。实际可执行工具仍受宿主工具池、权限、禁止列表和嵌套深度检查约束；声明不创造不存在的工具。当前 [Anthropic subagents](https://code.claude.com/docs/en/sub-agents) 文档说明，括号类型 allowlist 只作用于 `claude --agent` 主线程，子 Agent 中列出 Agent 可允许嵌套，括号类型会被忽略。保留 resolver 元数据不等于证明子线程施加 allowlist；下游消费边界与可配置深度仍须单独核对。Mods 作者接口见 [Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)。

## 验收有效性

`nested-agent-red1` 因依赖循环未进入断言，不能算有效产品 RED。改为先导入实际 `AgentTool` 的 `nested-agent-red2` 执行 17 个测试，9 通过、8 失败、19 次 expect 调用；失败测试的后续 expect 不计为已到达。失败为实际可用 Agent 未被解析。源输入与进程组终态均保存。最小修复后的 `nested-agent-green1` 包含 resolver、深度、Agent 嵌套、目标权限、Fork、前后台 continuation、并发与 background owner 共八个文件，37 通过、0 失败。它只证明该代码 epoch 的测试，不是完整验收。

最终文档与新增 bare Agent 控制测试会形成新 epoch，必须重新执行上述相关测试、`make release-check` 和 `make build`。真实入口必须用该轮产物，由仓库 `run-binary-gate.py` 执行独立 readiness 与默认完整串行矩阵；追加 target 不能缩减必验范围。nested 场景必须证明 parent/child 各一次实际 Agent 调用、稳定 parentage、结果、无重复通知、prompt 恢复及退出清理。原始请求、回执、debug、pane 与最终 manifest 共同构成证据。

验证使用隔离 HOME/config/cwd 和 dummy 本地 provider。18 份额外脚本仅用于绑定与加强原生证据，单独记录 overlay，不作为产品源修复；不复用旧 binary 或 Native17/18 的成功片段。本批失败的其他 target 仍是整体验收失败，必须继续修复。源漂移、缺少 EOF、尚在运行、同轮证据不完整或未执行的必验层均不能计为通过。三个只读子 Agent 加主会话检查也不能冒充 skill 要求的四个独立 Agent 发布结论。

## Native19 封存记录与后续轮次

文案计数修正前的完整矩阵 Native19 已完成 29 项，23 通过、6 失败，退出 1；nested-agent 的实际父子调用、parentage、结果、零通知、prompt 恢复及清理通过，仅覆盖该轮 custom foreground / fork0 场景。失败为 builtin-mods、code-review、terminal-canonical-diff、terminal-interaction、workflow、workflow-retry-partial-failure。源码 `16bae3dde797d3f79fa81494284373972038a67d177d539a00a05ef538080eb3`，binary `52be014f679bf8dc2c2b42c1c1e0886429c8de3f028156a26ab0d339a0549950`，最终 manifest `4c85bddd5c70f0add1ab3d37cb1c0ad0ce39e1ac576ec5b68b3f5eba98fbf2b5`。原候选与证据封存，未修改原结果。

计数修正与本记录形成新文档 epoch；新副本须重新执行相关测试、检查、构建、driver 回归与默认完整 Native20 矩阵，不将 Native19 的局部成功继承为新轮通过。当前已消失的进程组不补签历史缺少 EOF/reap 的失败。整体兼容验收继续进行。
