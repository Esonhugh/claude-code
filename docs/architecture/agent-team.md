# Claude Code Agent Team 架构设计文档

## 目录

1. [系统概览](#1-系统概览)
2. [核心概念与类型系统](#2-核心概念与类型系统)
3. [Agent 类型体系](#3-agent-类型体系)
4. [三层架构模型](#4-三层架构模型)
5. [Agent 启动流程](#5-agent-启动流程)
6. [Agent 停止与生命周期管理](#6-agent-停止与生命周期管理)
7. [Agent 间通信机制](#7-agent-间通信机制)
8. [Team (Swarm) 协调系统](#8-team-swarm-协调系统)
9. [Coordinator 模式](#9-coordinator-模式)
10. [Fork Subagent 机制](#10-fork-subagent-机制)
11. [权限与安全模型](#11-权限与安全模型)
12. [完整数据流图](#12-完整数据流图)

---

## 1. 系统概览

Claude Code 的 Agent Team 系统是一个多层次的、支持多种执行后端的 **多 Agent 协作框架**。它允许一个主 Agent（Team Lead / Coordinator）编排多个子 Agent（Workers / Teammates），通过文件邮箱、进程内消息队列或远程 WebSocket 进行通信。

### 设计哲学

```
┌──────────────────────────────────────────────────────────────────┐
│                     用户 (Human / SDK Client)                      │
├──────────────────────────────────────────────────────────────────┤
│                     QueryEngine (会话编排器)                        │
│  ┌────────────┐  ┌────────────┐  ┌──────────────────────────┐   │
│  │ SystemPrompt│  │ ToolSystem │  │     CompactionService    │   │
│  └────────────┘  └─────┬──────┘  └──────────────────────────┘   │
│                        │                                         │
│  ┌─────────────────────┴──────────────────────────────────────┐  │
│  │                  query() 主循环 (Generator)                  │  │
│  │  [API Request → Stream → Tool Execution → Iteration]       │  │
│  └─────────────────────┬──────────────────────────────────────┘  │
│                        │                                         │
│  ┌─────────────────────┴──────────────────────────────────────┐  │
│  │              Task / Agent 管理层 (AppState)                  │  │
│  │  ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌─────────────┐  │  │
│  │  │LocalShell│ │LocalAgent │ │RemoteAgent│ │InProcessTM  │  │  │
│  │  │  Task    │ │  Task     │ │  Task     │ │  Task       │  │  │
│  │  └──────────┘ └───────────┘ └──────────┘ └─────────────┘  │  │
│  └────────────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────┤
│               通信层 (Mailbox / Bridge / UDS)                     │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. 核心概念与类型系统

### 2.1 TaskType — 任务类型枚举

```typescript
// src/Task.ts
type TaskType =
  | 'local_bash'           // Shell 命令执行
  | 'local_agent'          // 本地子 Agent（后台运行）
  | 'remote_agent'         // 远程 Agent（CCR 云端执行）
  | 'in_process_teammate'  // 进程内队友（同进程 AsyncLocalStorage 隔离）
  | 'local_workflow'       // 本地工作流脚本
  | 'monitor_mcp'          // MCP 监控任务
  | 'dream'                // 记忆整合（自动梦境）
```

### 2.2 TaskStatus — 任务状态机

```
pending ──→ running ──→ completed
                   ├──→ failed
                   └──→ killed
```

```typescript
type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed'

// 终态判断（不可再转换）
function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}
```

### 2.3 TaskStateBase — 任务基础状态

```typescript
type TaskStateBase = {
  id: string              // 带类型前缀的唯一 ID（如 "a3kx9f2m" 表示 local_agent）
  type: TaskType
  status: TaskStatus
  description: string
  toolUseId?: string      // 触发此任务的工具调用 ID
  startTime: number
  endTime?: number
  outputFile: string      // 磁盘输出文件路径
  outputOffset: number    // 输出文件读取偏移量
  notified: boolean       // 是否已通知父级完成
}
```

### 2.4 Task ID 生成规则

```typescript
// 每种类型有固定前缀 + 8 位随机字符（36^8 ≈ 2.8 万亿组合）
const TASK_ID_PREFIXES = {
  local_bash: 'b',
  local_agent: 'a',
  remote_agent: 'r',
  in_process_teammate: 't',
  local_workflow: 'w',
  monitor_mcp: 'm',
  dream: 'd',
}
// 示例: "a5hm2kqr" → local_agent 类型
```

### 2.5 AppState — 全局状态容器

所有 Task 状态通过 Zustand store 管理，存储在 `AppState.tasks` 中：

```typescript
type AppState = {
  tasks: Record<string, TaskState>     // 所有活跃/已完成任务
  teamContext?: {                      // 当前 Team 上下文
    teamName: string
    teamFilePath: string
    leadAgentId: string
    teammates: Record<string, TeammateInfo>
  }
  // ...其他状态
}
```

---

## 3. Agent 类型体系

### 3.1 内置 Agent 定义

```typescript
// src/tools/AgentTool/builtInAgents.ts
function getBuiltInAgents(): AgentDefinition[] {
  // 基础 Agent（始终可用）
  GENERAL_PURPOSE_AGENT   // 通用 Agent，拥有全部工具
  STATUSLINE_SETUP_AGENT  // 状态栏配置 Agent

  // 可选 Agent（Feature Gate 控制）
  EXPLORE_AGENT           // 只读搜索 Agent（Haiku 模型，高速）
  PLAN_AGENT              // 规划 Agent
  VERIFICATION_AGENT      // 验证 Agent
  CLAUDE_CODE_GUIDE_AGENT // 使用指南 Agent
}
```

#### Agent 能力矩阵

| Agent | 模型 | 工具集 | 读写 | 特性 |
|-------|------|--------|------|------|
| **Explore** | Haiku (外部) / inherit (内部) | Glob, Grep, Read, Bash(只读) | 只读 | 省略 CLAUDE.md，高速搜索 |
| **General Purpose** | 默认子 Agent 模型 | `['*']` 全部工具 | 读写 | 完整能力 |
| **Plan** | 继承父级 | 规划相关工具 | 只读 | 输出实施计划 |
| **Verification** | 继承父级 | 全部工具 | 读写 | 独立验证代码变更 |
| **Fork** | 继承父级 | `['*']` + `useExactTools` | 读写 | 继承父级完整上下文+提示缓存复用 |

### 3.2 自定义 Agent

用户可以通过 `.claude/agents/*.md` 文件定义自定义 Agent，支持 frontmatter 配置：

```yaml
---
model: sonnet
tools:
  - Bash
  - FileRead
  - FileEdit
maxTurns: 50
permissionMode: auto
mcpServers:
  - slack
---
你是一个专门处理 Slack 消息的 Agent...
```

### 3.3 Coordinator Worker Agent

在 Coordinator 模式下，内置 Agent 被替换为统一的 `worker` 类型：

```typescript
// src/coordinator/workerAgent.ts
function getCoordinatorAgents(): AgentDefinition[] {
  return [WORKER_AGENT]  // 替换所有内置 Agent
}
```

---

## 4. 三层架构模型

### 4.1 Layer 1: 单 Agent 模式 (默认)

```
User ↔ QueryEngine ↔ query() loop ↔ Tools
                                      ├── AgentTool → SubAgent (LocalAgentTask)
                                      ├── BashTool
                                      ├── FileEdit/Read/Write
                                      └── ...
```

- 主会话通过 `QueryEngine.submitMessage()` 驱动
- `AgentTool` 可按需启动子 Agent，同步或异步执行

### 4.2 Layer 2: Team/Swarm 模式

```
User ↔ Team Lead (主进程)
         ├── Teammate A (tmux pane)
         ├── Teammate B (iTerm2 pane)
         └── Teammate C (in-process)
              ↕ 文件邮箱 (JSON) / AppState 队列
```

- `TeamCreateTool` 创建 Team，指定 Team Lead
- 多个 Teammate 通过 `TeammateExecutor` 接口统一管理
- 三种执行后端：`tmux` | `iterm2` | `in-process`
- Teammate 各自维护独立的对话上下文

### 4.3 Layer 3: Coordinator 模式

```
User ↔ Coordinator (特殊系统提示，不直接使用工具)
         ├── Worker A (local_agent, 异步)
         ├── Worker B (local_agent, 异步)
         └── Worker C (local_agent, 异步)
              ↕ <task-notification> XML 消息
```

- Coordinator 只使用 `AgentTool`、`SendMessageTool`、`TaskStopTool`
- Worker 结果以 `<task-notification>` XML 注入到 Coordinator 的 User 消息中
- 通过 `SendMessageTool` 可继续已完成的 Worker（复用其上下文）
- 强调并行研究 + 顺序实现

---

## 5. Agent 启动流程

### 5.1 LocalAgentTask 启动 (AgentTool)

```
AgentTool.call(input, context)
    │
    ├─ 1. 解析 Agent 定义 (built-in / custom / fork)
    │     loadAgentsDir() → AgentDefinition
    │
    ├─ 2. 创建 SubagentContext
    │     createSubagentContext() {
    │       - 克隆 FileStateCache (避免跨 Agent 污染)
    │       - 冻结 SystemPrompt (prompt cache 复用)
    │       - 生成 AgentId (branded string)
    │       - 隔离的 AppState 副本
    │     }
    │
    ├─ 3. 初始化 Agent 专属 MCP 服务器 (可选)
    │     initializeAgentMcpServers(agentDef, parentClients)
    │
    ├─ 4. 注册 LocalAgentTaskState 到 AppState.tasks
    │     registerTask(taskState, setAppState)
    │
    ├─ 5. 启动 Agent 执行循环 (Generator)
    │     runAgent() → AsyncGenerator<StreamEvent>
    │     {
    │       - 调用 query() 生成器
    │       - 流式处理工具调用和响应
    │       - 进度跟踪 (tokens, tool_uses, activities)
    │       - JSONL 磁盘写入 (transcript)
    │     }
    │
    └─ 6. 返回 ToolResult 给父级
```

**LocalAgentTask 关键状态字段：**

```typescript
type LocalAgentTaskState = TaskStateBase & {
  type: 'local_agent'
  agentId: string
  prompt: string
  agentType: string
  model?: string
  abortController?: AbortController
  progress?: {
    toolUseCount: number
    tokenCount: number
    lastActivity?: ToolActivity
    recentActivities?: ToolActivity[]
    summary?: string
  }
  messages?: Message[]        // 对话历史
  isBackgrounded: boolean     // 前台/后台切换
  pendingMessages: string[]   // SendMessage 队列（等待 Agent 空闲时注入）
  retain: boolean             // UI 是否持有（阻止驱逐）
}
```

### 5.2 InProcessTeammateTask 启动

```
InProcessBackend.spawn(config)
    │
    ├─ 1. spawnInProcessTeammate()
    │     ├─ 生成确定性 agentId: "name@teamName"
    │     ├─ 创建独立 AbortController（不关联父级 leader 的中止）
    │     ├─ 创建 TeammateContext (用于 AsyncLocalStorage 隔离)
    │     ├─ 注册 Perfetto 追踪 (可选)
    │     └─ 注册 InProcessTeammateTaskState 到 AppState
    │
    ├─ 2. startInProcessTeammate() (fire-and-forget 后台启动)
    │     ├─ runWithTeammateContext(context, fn)  // AsyncLocalStorage 隔离
    │     ├─ runWithAgentContext(agentCtx, fn)    // Agent 上下文隔离
    │     ├─ runAgent() 执行循环
    │     │   ├─ 邮箱轮询 (readMailbox)
    │     │   ├─ 权限请求/响应处理
    │     │   └─ 空闲检测 + 回调
    │     └─ 完成后更新 task status + 触发 onIdleCallbacks
    │
    └─ 3. 返回 TeammateSpawnResult { agentId, taskId, abortController }
```

**进程内隔离核心机制 — AsyncLocalStorage：**

```typescript
// 每个 in-process teammate 在独立的 async context 中执行
type TeammateContext = {
  agentId: string           // "researcher@my-team"
  agentName: string         // "researcher"
  teamName: string          // "my-team"
  color?: string            // UI 颜色
  planModeRequired: boolean
  parentSessionId: string
  abortController: AbortController
}

// 运行时隔离
runWithTeammateContext(context, async () => {
  // 在此 async 作用域内：
  //   getAgentId() → context.agentId
  //   getTeamName() → context.teamName
  //   isTeammate() → true
  await runAgent(...)
})
```

### 5.3 Tmux/iTerm2 Pane-Based Teammate 启动

```
PaneBackendExecutor.spawn(config)
    │
    ├─ 1. createTeammatePaneInSwarmView(name, color)
    │     └─ 在终端中创建新 split pane
    │
    ├─ 2. 构建 claude CLI 启动命令
    │     claude --agent-id="name@team"
    │           --team-name="team"
    │           --agent-color="blue"
    │           --print  // 非交互模式
    │           -p "初始提示"
    │
    ├─ 3. sendCommandToPane(paneId, command)
    │     └─ 在分屏 pane 中执行 claude 进程
    │
    └─ 4. 返回 { paneId, agentId }
         pane 中的 claude 进程通过 CLI args 识别自身身份
```

### 5.4 RemoteAgentTask 启动 (CCR)

```
RemoteAgentTask.spawn()
    │
    ├─ 1. POST /api/sessions → 创建远程会话
    ├─ 2. WebSocket 订阅 (SessionsWebSocket)
    │     └─ 监听 SDKMessage 事件流
    ├─ 3. 注册 RemoteAgentTaskState (含 pollStartedAt)
    └─ 4. 轮询状态 + 解析进度心跳
```

---

## 6. Agent 停止与生命周期管理

### 6.1 停止层次

```
         优雅停止 (Graceful)                强制停止 (Kill)
    ┌─────────────────────┐          ┌──────────────────────┐
    │ SendMessage           │          │ TaskStopTool          │
    │ {type:'shutdown_req'} │          │ → Task.kill(id, set)  │
    │        ↓              │          │        ↓              │
    │ Teammate 处理请求       │          │ AbortController.abort │
    │ → 完成当前工作           │          │ → 立即中止所有异步操作   │
    │ → 发送 shutdown_resp   │          │ → 状态变为 'killed'    │
    │ → 自行退出              │          │ → 清理资源              │
    └─────────────────────┘          └──────────────────────┘
```

### 6.2 各任务类型的 kill 实现

| 任务类型 | kill 方式 | 清理操作 |
|---------|----------|---------|
| **local_bash** | 向 shell 进程发送 SIGTERM/SIGKILL | 关闭 PTY，清理 output 文件 |
| **local_agent** | `abortController.abort()` | 清理 Agent MCP 连接，释放 transcript |
| **in_process_teammate** | `abortController.abort()` + 从 teamContext 移除 | 从 TeamFile 移除成员，释放 Perfetto 追踪 |
| **remote_agent** | POST 取消请求到远程 CCR | 清理 WebSocket 订阅 |
| **dream** | `abortController.abort()` + mtime 回滚 | 恢复 consolidation lock 时间戳 |

### 6.3 InProcessTeammate 完整关闭流程

```
[优雅关闭 — Graceful Shutdown]

Team Lead                    Teammate
    │                           │
    ├── terminate(agentId) ────→│
    │   (写入 shutdown_request   │
    │    到文件邮箱)              │
    │                           ├── readMailbox() 发现 shutdown_request
    │                           ├── isShutdownRequest() → true
    │                           ├── 完成当前工作（不开始新工作）
    │                           ├── writeToMailbox(shutdown_response, approve=true)
    │                           └── 自行退出 runAgent 循环
    │                           │
    │←── onIdleCallbacks 触发 ──┤
    │                           │
    ├── 从 AppState.tasks 移除   │
    └── 从 TeamFile.members 移除 │


[强制关闭 — Force Kill]

killInProcessTeammate(taskId, setAppState)
    ├── task.abortController.abort()        // 中止所有异步操作
    ├── task.unregisterCleanup()            // 调用注册的清理句柄
    ├── task.onIdleCallbacks.forEach(cb())  // 解除所有等待者
    ├── 从 teamContext.teammates 中移除
    ├── removeMemberByAgentId(team, agentId) // 更新 TeamFile
    ├── evictTaskOutput(taskId)             // 删除磁盘输出文件
    ├── emitTaskTerminatedSdk()             // SDK 事件通知
    └── setTimeout(evictTerminalTask, 5s)   // 延迟从 AppState 驱逐
```

### 6.4 Session 结束时的自动清理

```typescript
// TeamCreateTool 注册 session 级清理回调
registerTeamForSessionCleanup(teamName)

// 当 session 结束时自动：
// 1. kill 所有活跃 teammates
// 2. 删除 team 目录 (~/.claude/teams/{name}/)
// 3. 清理 task list 目录
```

---

## 7. Agent 间通信机制

### 7.1 通信方式总览

| 方式 | 适用场景 | 传输介质 | 延迟特性 |
|------|---------|---------|---------|
| **文件邮箱 (Mailbox)** | Tmux/iTerm2 + In-Process Teammates | JSON 文件 + 文件锁 | 依赖轮询间隔 |
| **AppState 消息队列** | LocalAgent (pendingMessages) | 进程内状态 | 即时（同进程） |
| **task-notification XML** | Coordinator 模式 Worker | XML 注入到 User 消息 | Agent 完成时 |
| **Bridge WebSocket** | 远程 Agent (CCR) | WebSocket | 网络延迟 |
| **UDS Socket** | 本地 Daemon/Peer | Unix Domain Socket | 低延迟 |

### 7.2 文件邮箱系统 (Mailbox)

**存储路径：** `~/.claude/teams/{team_name}/inboxes/{agent_name}.json`

```typescript
// src/utils/teammateMailbox.ts
type TeammateMessage = {
  from: string       // 发送者名称
  text: string       // 消息内容（纯文本或 JSON 结构化消息）
  timestamp: string  // ISO 时间戳
  read: boolean      // 是否已读
  color?: string     // 发送者颜色
  summary?: string   // UI 预览摘要 (5-10 words)
}
```

**读写流程：**

```
发送者                          接收者
  │                              │
  ├── writeToMailbox()           │
  │   ├── 获取文件锁 (lockfile)    │
  │   │   (10 次重试, 5-100ms 退避) │
  │   ├── 读取现有消息数组          │
  │   ├── 追加新消息               │
  │   ├── 原子写入 JSON 文件       │
  │   └── 释放文件锁               │
  │                              │
  │                              ├── readMailbox() (轮询)
  │                              ├── 过滤未读消息 (read === false)
  │                              ├── markMessageAsRead()
  │                              └── 注入为 User 消息到 Agent 对话中
```

### 7.3 SendMessageTool — 统一路由

```typescript
// src/tools/SendMessageTool/SendMessageTool.ts
SendMessageTool.call({ to, message, summary }) {
  switch (parseAddress(to)) {
    case 'teammate_name':
      // 1. 查找 in-process teammate task
      const task = findTeammateTaskByAgentId(agentId, tasks)
      if (task) {
        // → 直接向 task.pendingUserMessages 队列追加
        appendTeammateMessage(task.id, message, setAppState)
      }
      // 2. 查找 local_agent task
      const agentTask = findLocalAgentTask(agentId, tasks)
      if (agentTask) {
        queuePendingMessage(agentTask.id, message, setAppState)
      }
      // 3. 回退到文件邮箱
      writeToMailbox(agentName, message, teamName)
      break

    case '*':  // 广播给所有 teammates
      for (const teammate of activeTeammates) {
        sendMessage(teammate.agentId, message)
      }
      break

    case 'uds:<socket-path>':
      // Unix Domain Socket 发送给本地 peer
      break

    case 'bridge:<session-id>':
      // Bridge WebSocket 发送到远程 session
      sendEventToRemoteSession(sessionId, message)
      break
  }
}
```

### 7.4 结构化消息协议

除纯文本消息外，SendMessageTool 支持结构化协议消息：

```typescript
// 关闭请求 — Leader → Teammate
{ type: 'shutdown_request', reason?: string }

// 关闭响应 — Teammate → Leader
{ type: 'shutdown_response', request_id: string, approve: boolean, reason?: string }

// 计划审批响应 — Leader → Teammate (Plan Mode)
{ type: 'plan_approval_response', request_id: string, approve: boolean, feedback?: string }
```

### 7.5 task-notification (Coordinator 模式)

Worker 完成后，结果以 XML 格式注入到 Coordinator 的消息流中，呈现为 User 消息：

```xml
<task-notification>
  <task-id>agent-a1b</task-id>
  <status>completed</status>
  <summary>Agent "Investigate auth bug" completed</summary>
  <result>Found null pointer in src/auth/validate.ts:42...</result>
  <usage>
    <total_tokens>15234</total_tokens>
    <tool_uses>8</tool_uses>
    <duration_ms>45000</duration_ms>
  </usage>
</task-notification>
```

Coordinator 通过 `<task-id>` 识别 Worker，可用 `SendMessageTool({ to: "agent-a1b", ... })` 向其发送后续指令，复用已有上下文。

---

## 8. Team (Swarm) 协调系统

### 8.1 Team 完整生命周期

```
TeamCreateTool.call({ team_name, description, agent_type })
    │
    ├── 生成 Team Lead ID: "team-lead@{team_name}"
    ├── 创建 TeamFile (JSON 配置)
    │   └── ~/.claude/teams/{name}/config.json
    ├── 创建 Task List 目录
    │   └── ~/.claude/teams/{name}/tasks/
    ├── 注册 Session 结束清理
    └── 更新 AppState.teamContext
         │
    ┌────┴────┐
    │ Team    │  ←── TeamFile: config.json
    │ Active  │  ←── Inboxes: inboxes/*.json
    │         │  ←── Tasks:   tasks/
    └────┬────┘
         │
    TeammateExecutor.spawn() × N  (通过 AgentTool/TeammateTool)
         │
    ┌────┴────────────────────────────┐
    │ Teammates 执行中...               │
    │ ├── 邮箱通信 (文件/队列)            │
    │ ├── 权限请求/响应                  │
    │ ├── 进度汇报                      │
    │ └── Plan Mode 审批 (可选)          │
    └────┬────────────────────────────┘
         │
    TeamDeleteTool.call()
    │
    ├── 检查是否有活跃成员（排除 team-lead）
    ├── kill 所有 running teammates
    ├── 清理 team 目录
    ├── 清理 teammate 颜色
    └── 清除 AppState.teamContext
```

### 8.2 TeamFile 结构

```typescript
// src/utils/swarm/teamHelpers.ts
type TeamFile = {
  name: string
  description?: string
  createdAt: number
  leadAgentId: string         // "team-lead@my-team"
  leadSessionId?: string      // Leader 的 session UUID（用于跨进程发现）
  hiddenPaneIds?: string[]    // 隐藏的 pane ID 列表（UI 管理）
  teamAllowedPaths?: TeamAllowedPath[]  // 团队级编辑权限白名单
  members: Array<{
    agentId: string           // "researcher@my-team"
    name: string              // "researcher"
    agentType?: string        // 角色类型
    model?: string            // 使用的模型
    prompt?: string           // 初始提示
    color?: string            // UI 颜色
    planModeRequired?: boolean
    joinedAt: number
    tmuxPaneId: string        // Pane ID (tmux/iTerm2)
    cwd: string               // 工作目录
    worktreePath?: string     // Git worktree 隔离路径
    sessionId?: string
    subscriptions: string[]   // 事件订阅列表
    backendType?: BackendType // 'tmux' | 'iterm2' | 'in-process'
    isActive?: boolean        // false = idle
    mode?: PermissionMode
  }>
}
```

### 8.3 执行后端抽象 (TeammateExecutor)

```typescript
// src/utils/swarm/backends/types.ts
type TeammateExecutor = {
  type: BackendType                                    // 'tmux' | 'iterm2' | 'in-process'
  isAvailable(): Promise<boolean>                      // 检查后端是否可用
  spawn(config: TeammateSpawnConfig): Promise<TeammateSpawnResult>
  sendMessage(agentId: string, message: TeammateMessage): Promise<void>
  terminate(agentId: string, reason?: string): Promise<boolean>  // 优雅关闭
  kill(agentId: string): Promise<boolean>              // 强制终止
  isActive(agentId: string): Promise<boolean>          // 活跃检查
}
```

**后端选择优先级（自动检测）：**

```
detectAndGetBackend()
    ├── 在 iTerm2 内 + it2 CLI 已安装? ──→ ITermBackend
    ├── 用户偏好 tmux over iTerm2?  ──→ TmuxBackend
    ├── 在 tmux session 内?           ──→ TmuxBackend
    ├── tmux 命令可用?                 ──→ TmuxBackend (创建外部 session)
    ├── 非交互模式 (SDK/API)?          ──→ InProcessBackend
    └── 以上均不满足                    ──→ InProcessBackend (回退)
```

### 8.4 身份解析优先级

```typescript
// src/utils/teammate.ts
// 获取当前执行上下文中 Agent 身份的优先级
function getAgentId(): string | undefined {
  // 优先级 1: AsyncLocalStorage — in-process teammates
  const ctx = getTeammateContext()
  if (ctx) return ctx.agentId

  // 优先级 2: dynamicTeamContext — tmux/iTerm2 teammates (从 CLI args 设置)
  return dynamicTeamContext?.agentId
}

function isTeammate(): boolean {
  const ctx = getTeammateContext()
  if (ctx) return true
  return !!(dynamicTeamContext?.agentId && dynamicTeamContext?.teamName)
}

function isTeamLead(teamContext): boolean {
  if (!teamContext?.leadAgentId) return false
  const myId = getAgentId()
  if (myId === teamContext.leadAgentId) return true
  if (!myId) return true  // 向后兼容：无 ID 的创建者即 Lead
  return false
}
```

---

## 9. Coordinator 模式

### 9.1 模式切换

```typescript
// src/coordinator/coordinatorMode.ts
function isCoordinatorMode(): boolean {
  return feature('COORDINATOR_MODE') &&
         isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)
}

// 恢复 session 时自动匹配模式
function matchSessionMode(sessionMode: 'coordinator' | 'normal' | undefined) {
  // 如果 session 记录的模式与当前不同，自动切换 env var
}
```

### 9.2 Coordinator 与普通模式对比

| 特性 | 普通模式 | Coordinator 模式 |
|------|---------|-----------------|
| **系统提示** | 通用编程助手 | 多 Worker 编排器 (详细工作流指导) |
| **内置 Agent** | Explore, Plan, General, etc. | Worker (统一类型) |
| **可用工具** | 全部 (Bash, Edit, ...) | 仅 Agent, SendMessage, TaskStop |
| **直接工具** | ✅ 直接使用 | ❌ 全部委托给 Worker |
| **交互模式** | 同步 + 异步 | 全异步 (Worker 通知机制) |
| **并行能力** | 有限（单会话） | 核心优势（多 Worker 并发） |
| **Scratchpad** | 无 | 共享 scratchpad 目录 (跨 Worker 知识) |

### 9.3 Coordinator 系统提示核心规则

1. **角色**: 编排者 — 指导 Worker 研究、实现、验证
2. **综合**: 必须理解 Worker 研究结果后再下发实现任务（禁止"基于你的发现"式委托）
3. **并行**: 独立任务并发执行（多个 tool_call 在同一消息中）
4. **继续 vs 新建**: 根据上下文重叠度决定是 `SendMessage` 继续还是新建 Worker
5. **验证**: 独立验证 — 不只确认代码存在，而是证明代码可工作

### 9.4 Coordinator 典型工作流

```
Phase 1: Research (并行)
    Coordinator ─┬── Worker A: "调查 auth 模块中的空指针..."
                 ├── Worker B: "分析 auth 测试覆盖..."
                 └── Worker C: "检查相关依赖关系..."

Phase 2: Synthesis (Coordinator 自身)
    ← task-notification (A: 发现 validate.ts:42 的空指针)
    ← task-notification (B: 测试在 session 过期路径有空白)
    ← task-notification (C: Session 类型定义 user 可为 undefined)
    → Coordinator 综合所有发现
    → 撰写精确实施规范（含文件路径、行号、具体修改）

Phase 3: Implementation (顺序/有限并行)
    → SendMessage(Worker A): "修复 validate.ts:42，在 user.id
       访问前加 null check..." (复用 A 的文件上下文)
    或
    → 新建 Worker D: 完整自包含实施规范

Phase 4: Verification (独立 Worker)
    → 新建 Worker E: "运行测试，验证边界条件..."
       (独立视角，不继承实现者的假设)
```

---

## 10. Fork Subagent 机制

### 10.1 Fork vs 普通 Agent 对比

| 特性 | 普通 Agent | Fork Agent |
|------|-----------|------------|
| **上下文** | 全新空白上下文 | 继承父级完整对话历史 |
| **系统提示** | Agent 定义的独立提示 | 父级渲染后的系统提示（字节精确） |
| **工具集** | Agent 定义的工具 | 父级完全相同的工具池 |
| **缓存** | 独立 prompt cache | 共享 prompt cache (字节相同的前缀) |
| **递归** | 可以嵌套 Agent | 禁止递归 fork (检测 FORK_BOILERPLATE_TAG) |
| **启用条件** | 始终可用 | Feature gate + 非 Coordinator + 交互模式 |

### 10.2 Fork 消息构建 (Prompt Cache 优化)

```typescript
// src/tools/AgentTool/forkSubagent.ts
function buildForkedMessages(directive, assistantMessage) {
  // 关键设计：所有 fork 子进程生成字节相同的 API 请求前缀
  //
  // 结构:
  // [...原始历史, assistant(所有 tool_use block), user(占位 tool_results + 指令)]
  //
  // 1. 保留完整的 assistant 消息 (所有 tool_use, thinking, text blocks)
  // 2. 为每个 tool_use 生成相同的占位 tool_result
  //    "Fork started — processing in background"
  // 3. 最后追加唯一的指令文本块
  //
  // 效果: 只有最后一个 text block 不同 → 最大化 prompt cache 命中率
}
```

### 10.3 Fork 子进程工作规则

```xml
<fork-boilerplate>
1. 你是 fork worker — 不要再创建子 Agent
2. 不要提问或建议下一步
3. 直接使用工具执行任务
4. 修改文件后必须 commit (报告 commit hash)
5. 工具调用间不要输出文本
6. 严格在指令范围内 (一句话提及范围外发现)
7. 报告控制在 500 词以内
8. 响应必须以 "Scope:" 开始

输出格式:
  Scope: <回显指令范围>
  Result: <核心发现>
  Key files: <相关文件路径>
  Files changed: <修改列表 + commit hash>
  Issues: <需关注的问题>
</fork-boilerplate>
```

### 10.4 Git Worktree 隔离

Fork 可在独立 git worktree 中执行，实现文件级隔离：

```typescript
function buildWorktreeNotice(parentCwd, worktreeCwd) {
  // 告知子进程:
  // - 在隔离的 git worktree (worktreeCwd) 中操作
  // - 翻译继承上下文中的路径（来自 parentCwd）
  // - 编辑前重新读取文件（父级可能已修改）
  // - 修改不会影响父级的工作目录
}
```

---

## 11. 权限与安全模型

### 11.1 权限模式

| 模式 | 行为 | 适用场景 |
|------|------|---------|
| `default` | 每次工具调用询问用户 | 交互式终端 |
| `bypass` | 允许所有工具调用 | 受信环境 (CI/CD) |
| `auto` | ML 分类器自动决策 | 自动化流水线 |
| `bubble` | 向父级 Agent 冒泡权限请求 | 子 Agent / Fork |
| `plan` | 必须先提交计划获得批准 | 高风险 Teammate |

### 11.2 Teammate 权限决策流

```
Teammate 发起工具调用 → canUseTool() 检查
    │
    ├── teamAllowedPaths 中匹配? → ✅ 自动允许
    │
    ├── 已有 alwaysAllow 规则匹配? → ✅ 自动允许
    │
    ├── 已有 alwaysDeny 规则匹配? → ❌ 自动拒绝
    │
    └── 需要用户确认:
        ├── Leader Bridge 可用?
        │   ├── YES → ToolUseConfirm 对话框 (带 Worker 标记)
        │   │         用户在 Leader 终端审批
        │   └── NO → 邮箱权限请求
        │            ├── 写入 permissionRequest 到 Leader 邮箱
        │            ├── Leader 审批并写入 permissionResponse
        │            └── processMailboxPermissionResponse()
        │
        └── allowPermissionPrompts = false?
            └── ❌ 自动拒绝 (SDK 静默模式)
```

### 11.3 Team 级权限共享

```typescript
type TeamAllowedPath = {
  path: string        // 绝对路径 (目录级)
  toolName: string    // 适用工具 (如 "Edit", "Write")
  addedBy: string     // 添加者 agent name
  addedAt: number     // 添加时间戳
}

// 当 Leader 批准某路径的编辑权限时，
// 可将其加入 teamAllowedPaths，
// 所有 teammates 后续访问该路径时自动允许
```

---

## 12. 完整数据流图

### 12.1 单 Agent 查询流

```
User Prompt
    ↓
QueryEngine.submitMessage()
    ├── fetchSystemPromptParts()         // 系统提示组装
    ├── loadAllPluginsCacheOnly()        // 插件加载
    ├── processUserInput()               // 解析 slash 命令、附件、模型覆盖
    ↓
query() Generator Loop
    ┌──────────────────────────────────────────┐
    │ Loop:                                    │
    │  ├── API Request (streaming)             │
    │  │   └── messages + systemPrompt + tools │
    │  │       → Anthropic API                 │
    │  ├── Stream Response                     │
    │  │   ├── Text tokens → yield             │
    │  │   ├── Thinking blocks → yield         │
    │  │   └── Tool Use blocks →               │
    │  │       ├── canUseTool() 权限检查        │
    │  │       ├── runTools() 并发执行          │
    │  │       └── yield tool_result           │
    │  ├── Iteration Check                     │
    │  │   ├── end_turn → 退出循环             │
    │  │   ├── max_tokens → 恢复重试 (≤3次)    │
    │  │   └── Token 超限 → Auto-Compact       │
    │  └── Continue? (有 tool_use) → 下一轮     │
    └──────────────────────────────────────────┘
    ↓
recordTranscript()  // 磁盘持久化
    ↓
yield Result { usage, cost, duration }
```

### 12.2 多 Agent 协作全景图

```
                        ┌──────────────────────┐
                        │      AppState        │
                        │  ┌────────────────┐  │
                        │  │  tasks: {       │  │
                        │  │   "a...": Agent │  │
                        │  │   "t...": TM   │  │
                        │  │   "b...": Bash  │  │
                        │  │  }              │  │
                        │  │  teamContext: {  │  │
                        │  │   teamName      │  │
                        │  │   leadAgentId   │  │
                        │  │   teammates {}  │  │
                        │  │  }              │  │
                        │  └────────────────┘  │
                        └────────┬─────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         │                       │                       │
    ┌────┴────┐            ┌─────┴─────┐           ┌─────┴─────┐
    │  Team   │            │ Teammate  │           │ Teammate  │
    │  Lead   │◄──mailbox──│ A (tmux)  │           │ B (in-proc)│
    │         │──mailbox──►│           │           │           │
    │ Tools:  │            │ Identity: │           │ Identity: │
    │ Agent   │            │ CLI args  │           │ AsyncLocal│
    │ SendMsg │            │ --agent-id│           │  Storage  │
    │ TaskStop│            │ --team    │           │           │
    └────┬────┘            └───────────┘           └───────────┘
         │                       │                       │
         │                  ┌────┴────┐            ┌─────┴─────┐
         │                  │ Inbox A │            │ Inbox B   │
         │                  │ .json   │            │ .json     │
         │                  └─────────┘            └───────────┘
         │
    ┌────┴────────────────────────────────────────┐
    │           Team File (config.json)             │
    │  ~/.claude/teams/{name}/config.json          │
    │  ├── name, description, createdAt            │
    │  ├── leadAgentId, leadSessionId              │
    │  ├── teamAllowedPaths[]                      │
    │  └── members[] (agentId, name, backend, ...) │
    └──────────────────────────────────────────────┘
```

### 12.3 Bridge 远程通信流

```
本地 Agent                     Bridge Server              远程 Client
    │                              │                          │
    ├── 执行查询 ─────────────────→│                          │
    │   yield StreamEvent          │                          │
    │                              │── WebSocket ──────────→ │
    │                              │   SDKMessage stream      │
    │                              │                          │
    │                              │←── control_request ─────┤
    │←── Permission Request ───────│   (权限请求)              │
    │                              │                          │
    │   [用户审批]                  │                          │
    │                              │                          │
    ├── Permission Decision ──────→│                          │
    │                              │── control_response ───→ │
    │                              │                          │
    ├── 继续执行 ────────────────→ │                          │
    │   yield more events          │── WebSocket ──────────→ │
    │                              │                          │
    ├── Final Result ─────────────→│                          │
    │                              │── result message ─────→ │
    └                              └                          └
```

---

## 附录 A: 关键文件索引

| 文件 | 功能 |
|------|------|
| `src/Task.ts` | Task 基础类型定义 (TaskType, TaskStatus, TaskStateBase) |
| `src/tasks.ts` | Task 注册表 (getAllTasks, getTaskByType) |
| `src/tasks/types.ts` | TaskState 联合类型 |
| `src/tasks/LocalAgentTask/` | 本地 Agent 任务实现 |
| `src/tasks/InProcessTeammateTask/` | 进程内 Teammate 任务 |
| `src/tasks/RemoteAgentTask/` | 远程 Agent 任务 (CCR) |
| `src/tasks/LocalShellTask/` | Shell 命令任务 |
| `src/tasks/DreamTask/` | 记忆整合任务 |
| `src/tasks/stopTask.ts` | 任务停止逻辑 |
| `src/tools/AgentTool/AgentTool.tsx` | Agent 工具主入口 |
| `src/tools/AgentTool/runAgent.ts` | Agent 执行循环核心 |
| `src/tools/AgentTool/forkSubagent.ts` | Fork 子 Agent 机制 |
| `src/tools/AgentTool/builtInAgents.ts` | 内置 Agent 注册 |
| `src/tools/AgentTool/built-in/` | 各内置 Agent 定义 (Explore, Plan, etc.) |
| `src/tools/AgentTool/loadAgentsDir.ts` | 自定义 Agent 加载 |
| `src/tools/TeamCreateTool/` | Team 创建工具 |
| `src/tools/TeamDeleteTool/` | Team 删除工具 |
| `src/tools/SendMessageTool/` | Agent 间消息发送 |
| `src/tools/TaskCreateTool/` | 任务列表创建 |
| `src/tools/TaskStopTool/` | 任务停止 |
| `src/coordinator/coordinatorMode.ts` | Coordinator 模式控制 |
| `src/utils/swarm/` | Swarm 协调工具集 |
| `src/utils/swarm/backends/types.ts` | TeammateExecutor 接口 + BackendType |
| `src/utils/swarm/backends/registry.ts` | 后端检测与注册 |
| `src/utils/swarm/backends/InProcessBackend.ts` | 进程内后端实现 |
| `src/utils/swarm/backends/TmuxBackend.ts` | Tmux 后端实现 |
| `src/utils/swarm/backends/ITermBackend.ts` | iTerm2 后端实现 |
| `src/utils/swarm/teamHelpers.ts` | TeamFile 读写与管理 |
| `src/utils/swarm/spawnInProcess.ts` | 进程内 Teammate 启动 |
| `src/utils/swarm/inProcessRunner.ts` | 进程内 Teammate 执行循环 |
| `src/utils/swarm/constants.ts` | Swarm 常量 (TEAM_LEAD_NAME, etc.) |
| `src/utils/teammate.ts` | Teammate 身份工具函数 |
| `src/utils/teammateMailbox.ts` | 文件邮箱系统 |
| `src/utils/teammateContext.ts` | AsyncLocalStorage 上下文 |
| `src/QueryEngine.ts` | 查询引擎 (会话编排器) |
| `src/query.ts` | 核心查询循环 (Generator) |
| `src/Tool.ts` | 工具基础接口与类型 |
| `src/bridge/` | IPC/WebSocket Bridge 层 |
| `src/remote/` | 远程 Agent 通信 (RemoteSessionManager) |

## 附录 B: 关键环境变量

| 变量 | 功能 |
|------|------|
| `CLAUDE_CODE_COORDINATOR_MODE` | 启用 Coordinator 编排模式 |
| `CLAUDE_CODE_AGENT_ID` | Teammate 的 Agent ID (tmux/iTerm2 通过 CLI arg 设置) |
| `CLAUDE_CODE_TEAM_NAME` | 所属 Team 名称 |
| `CLAUDE_CODE_AGENT_COLOR` | Teammate 的 UI 颜色 |
| `CLAUDE_CODE_PLAN_MODE_REQUIRED` | 要求 Plan 模式审批 |
| `CLAUDE_CODE_TEAMMATE_COMMAND` | 自定义 Teammate 启动命令 (默认: 当前二进制) |
| `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS` | 禁用所有内置 Agent (SDK 模式) |
| `CLAUDE_CODE_SIMPLE` | 简化 Worker 工具集 (仅 Bash/Read/Edit) |
