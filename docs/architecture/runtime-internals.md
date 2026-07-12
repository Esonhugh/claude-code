# Claude Code 工作原理与 Agent 实现索引

本文是 recovered Claude Code 源码的内部机制索引，面向需要理解启动流程、消息循环、工具调用、Agent / Subagent 生命周期与团队协作实现的开发者。

## 阅读目标

读完本文后，应能快速定位以下问题的入口文件和深入文档：

- Claude Code CLI 如何启动并选择运行模式。
- 用户输入如何进入 REPL、消息循环和模型查询流程。
- 工具调用如何被解析、授权、执行、记录和渲染。
- `AgentTool` 如何创建前台、后台、远程或团队子代理。
- Agent 状态如何保存、恢复、汇总并回写到主会话。
- 哪些恢复源码模块仍需要结合类型 guard 和 recovery stub 谨慎阅读。

## 总体执行链路

Claude Code 的核心链路可以按以下层次阅读：

```text
CLI 入口
  -> fast-path 分发
  -> main 命令注册与运行模式选择
  -> REPL / print / server 等模式
  -> QueryEngine / query 事件流
  -> ToolUse 解析与工具执行
  -> 消息规范化、分组、渲染
  -> AgentTool 派生子代理或后台任务
```

## 入口层

| 文件 | 作用 |
| --- | --- |
| `src/entrypoints/cli.tsx` | CLI 进程入口，负责早期初始化、参数预处理、profile checkpoint 和主入口加载。 |
| `src/entrypoints/fastPathDispatch.ts` | 处理不需要完整加载 `main.tsx` 的快速路径，例如 daemon、bridge、Chrome host、模板任务和部分 feature-gated 入口。 |
| `src/main.tsx` | Commander 命令注册、运行模式选择、REPL/print/server/SDK 等主流程分发。 |

阅读建议：先从 `cli.tsx` 看启动边界，再看 `fastPathDispatch.ts` 理解哪些路径会提前返回，最后读 `main.tsx` 的命令注册和模式分支。

## REPL 与查询循环

| 文件 | 作用 |
| --- | --- |
| `src/screens/REPL.tsx` | 交互式终端 UI、输入处理、`onQuery` 调用、`ToolUseContext` 构建和消息状态更新。 |
| `src/QueryEngine.ts` | 非交互和 SDK 场景下的查询执行引擎，封装 query 事件消费与结果输出。 |
| `src/query.ts` | 模型请求、流式事件、工具调用事件和消息生成的核心查询流程。 |

REPL 不是单纯的输入框。它同时维护 UI 状态、会话状态、工具上下文、权限请求、后台任务提示和模型流式输出。理解工具和 Agent 前，应先确认 `ToolUseContext` 在当前模式下包含哪些能力。

## 消息模型

| 文件 | 作用 |
| --- | --- |
| `src/types/message.ts` | 核心消息类型、normalized message、grouped tool use、collapsed group、progress message 等类型定义。 |
| `src/utils/messages.ts` | 消息创建、规范化、工具结果 lookup、分组、压缩和渲染前处理。 |
| `src/components/Messages.tsx` | 消息列表渲染管线。 |
| `src/components/MessageRow.tsx` | 单行消息布局、选择态和折叠态处理。 |
| `src/components/Message.tsx` | 单条消息的具体渲染分发。 |

恢复源码中的消息边界会同时接触 SDK block、内部 normalized block、工具结果 block 和 UI-only progress block。新增类型时应优先使用局部 guard，不要为了一个调用点放宽全局消息 union。

## 工具体系

| 文件 | 作用 |
| --- | --- |
| `src/Tool.ts` | Tool 接口、输入 schema、调用上下文、权限、progress/result 协议的核心定义。 |
| `src/tools/*` | 各具体工具的实现、输入 schema、执行逻辑和 UI 展示。 |
| `src/utils/permissions/*` | 权限模式、权限请求和工具执行前的控制逻辑。 |

工具执行通常包含四个阶段：

1. 模型产生 `tool_use` content block。
2. 查询循环根据工具名找到 `Tool` 定义并解析输入。
3. 权限系统根据当前 permission mode 判断是否允许执行。
4. 工具返回结构化结果、progress 或错误，再进入消息渲染和会话记录。

## Agent 实现逻辑

| 文件 | 作用 |
| --- | --- |
| `src/tools/AgentTool/AgentTool.tsx` | Agent 工具入口，定义参数 schema、模式选择、前后台执行、远程执行和团队场景路由。 |
| `src/tools/AgentTool/runAgent.ts` | 本地子代理执行循环，构建子上下文并消费 query 事件。 |
| `src/tools/AgentTool/resumeAgent.ts` | 从已保存状态恢复后台 Agent。 |
| `src/tools/AgentTool/agentToolUtils.ts` | Agent 工具解析、任务描述、异步生命周期和辅助逻辑。 |
| `src/tools/AgentTool/UI.tsx` | Agent tool use / tool result 在消息列表中的展示。 |
| `src/tasks/LocalAgentTask/*` | 本地后台 Agent 任务状态、输出和生命周期管理。 |
| `src/tasks/RemoteAgentTask/*` | 远程 Agent 任务状态、轮询、日志和结果展示。 |
| `src/tasks/InProcessTeammateTask/*` | Team / swarm 场景下同进程 teammate 的任务表示。 |
| `src/tasks/LocalWorkflowTask/*` | 多 Agent workflow 的本地任务状态。 |

Agent 本质上仍是工具调用，但它的结果不是一次性 shell 输出，而是一个新的受控 query loop。主会话通过 `AgentTool` 创建子上下文，子代理在自己的消息历史、系统提示、可用工具和权限边界中执行任务，最终把摘要、状态或后台任务引用返回给主会话。

## Agent 生命周期

典型生命周期如下：

1. 主模型决定调用 `AgentTool`，输入包含任务描述、agent 类型、是否后台运行等参数。
2. `AgentTool` 解析输入，决定使用本地子代理、远程代理、后台任务或 team teammate。
3. 本地执行时，`runAgent` 构建子 `ToolUseContext` 和消息上下文，并启动新的 query 事件消费循环。
4. 执行过程中，progress message 和工具结果进入任务状态或主 UI。
5. 如果后台运行，状态进入 task framework，主会话只保留任务引用和摘要提示。
6. 如果需要恢复，`resumeAgent` 或对应 task 组件从持久化状态重建上下文。
7. Agent 完成后，结果以 tool result、summary 或 task output 的形式回写主会话。

这个设计使 Agent 既能作为普通工具同步执行，也能作为可恢复的后台任务长期存在。

## Team / Swarm 协作

Team / swarm 在 Agent 基础上增加了共享任务列表、teammate 命名、消息投递和协调者流程。深入阅读：

- [`agent-team-architecture.md`](agent-team.md) — team lifecycle、coordinator mode、inter-agent messaging、task ownership。
- `src/utils/swarm/*` — swarm/team 辅助逻辑。
- `src/components/teams/*` — team 相关 UI。
- `src/tasks/InProcessTeammateTask/*` — 同进程 teammate 任务状态。

## 插件与 Agent SDK 关系

插件系统不是 Agent 核心循环的一部分，但它决定了命令、agent、hook、skill、MCP server 等扩展如何进入运行时。深入阅读：

- [`plugin-marketplace-analysis.md`](plugin-marketplace.md) — 插件加载、安装、marketplace、策略和缓存。
- [`claude-agent-sdk-exports-analysis.md`](agent-sdk-exports.md) — Agent SDK 导出面、插件 API、hook/session API 和 unstable exports。
- `src/utils/plugins/*` — 插件发现、安装、启用和 marketplace 管理。

## 推荐深入阅读顺序

1. [`../../README.md`](../../README.md) — 项目目的、构建方式和变更规则。
2. [`BUILD_MANUAL.md`](../guides/build.md) — 构建、运行和验证流程。
3. [`SECONDARY_DEVELOPMENT_MANUAL.md`](../guides/secondary-development.md) — 二次开发和类型恢复规范。
4. 本文档 — Claude Code 主链路和 Agent 实现索引。
5. [`agent-architecture-analysis.md`](agent.md) — AgentTool 和子代理细节。
6. [`agent-team-architecture.md`](agent-team.md) — 多 Agent 协作模型。
7. [`claude-agent-sdk-exports-analysis.md`](agent-sdk-exports.md) — SDK/API 面分析。
8. [`plugin-marketplace-analysis.md`](plugin-marketplace.md) — 插件和 marketplace 扩展机制。

## 恢复源码阅读注意事项

- 部分 feature-gated 或 internal 路径是 recovery stub，只保证调用边界稳定，不代表完整行为已经恢复。
- 遇到 SDK content block、工具结果、远程日志或任务输出等外部边界时，应优先写局部类型 guard。
- 不要把局部恢复问题扩大成全局 `any` 或宽泛 index signature。
- 修改 CLI flag、工具 schema、消息 union 或任务状态时，应同步检查构建、类型、lint 和 CLI `--help` 输出。
