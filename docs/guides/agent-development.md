# Claude Code Agent 开发学习指南

> 面向初学者的完整学习路径
> 通过阅读 Claude Code v2.1.88 源码 + Claude Agent SDK，从零学会构建 AI Agent

---

## 目录

1. [前置知识与环境准备](#1-前置知识与环境准备)
2. [学习路线图总览](#2-学习路线图总览)
3. [Phase 1：理解 AI Agent 核心概念](#3-phase-1理解-ai-agent-核心概念)
4. [Phase 2：从最简单的 Tool 开始](#4-phase-2从最简单的-tool-开始)
5. [Phase 3：理解消息流与对话循环](#5-phase-3理解消息流与对话循环)
6. [Phase 4：系统提示词工程](#6-phase-4系统提示词工程)
7. [Phase 5：权限系统与安全设计](#7-phase-5权限系统与安全设计)
8. [Phase 6：使用 Agent SDK 构建你的第一个 Agent](#8-phase-6使用-agent-sdk-构建你的第一个-agent)
9. [Phase 7：进阶 — 子代理、Hook、Plugin](#9-phase-7进阶--子代理hookplugin)
10. [Phase 8：生产级 Agent 设计模式](#10-phase-8生产级-agent-设计模式)
11. [源码阅读顺序清单](#11-源码阅读顺序清单)
12. [动手练习项目](#12-动手练习项目)
13. [参考资源](#13-参考资源)

---

## 1. 前置知识与环境准备

### 1.1 你需要知道的

| 知识领域 | 要求级别 | 说明 |
|----------|---------|------|
| TypeScript / JavaScript | 基础 | 能读懂类型定义、async/await、Generator |
| Node.js | 基础 | 理解 npm、package.json、模块系统 |
| REST API | 基础 | 理解 HTTP 请求/响应 |
| AI / LLM 概念 | 了解 | 知道什么是 prompt、token、completion |
| Zod (校验库) | 可选 | 项目大量使用，边学边看即可 |

### 1.2 环境搭建

```bash
# 1. 安装 Node.js (推荐 v20+)
nvm install 20
nvm use 20

# 2. 克隆本项目
git clone <this-repo>
cd claude-code_evil

# 3. 安装依赖
pnpm install

# 4. 构建
pnpm build

# 5. 获取 Anthropic API Key（用于自己的 Agent 开发）
# 前往 https://console.anthropic.com/ 创建 API key
export ANTHROPIC_API_KEY="sk-ant-..."
```

### 1.3 推荐阅读工具

- **VS Code / WebStorm** — 支持 TypeScript 类型跳转
- **"Go to Definition"** — 最常用的代码导航方式（Cmd+Click）
- 建议在 IDE 中打开 `src/` 目录，随时跳转查看类型

---

## 2. 学习路线图总览

```
Phase 1: AI Agent 核心概念 (1-2h)
  "什么是 Agent？Tool-use 循环是什么？"
    |
    v
Phase 2: 最简单的 Tool (2-3h)
  阅读 GlobTool (198行) — 理解 Tool 如何定义和运行
    |
    v
Phase 3: 消息流与对话循环 (3-4h)
  阅读 query.ts — 理解 Agent 的"大脑循环"
    |
    v
Phase 4: 系统提示词 (2h)
  理解如何构建 system prompt
    |
    v
Phase 5: 权限与安全 (2h)
  理解 Agent 如何被约束
    |
    v
Phase 6: 用 SDK 构建第一个 Agent (4-6h)   <-- 里程碑！
  使用 @anthropic-ai/claude-agent-sdk 写一个能用的 Agent
    |
    v
Phase 7: 进阶 — 子代理/Hook/Plugin (4-6h)
  理解多代理协作和扩展机制
    |
    v
Phase 8: 生产级设计模式 (4-6h)
  学习本项目的高级架构模式
```

**总时间估计**: 20-30 小时（按自己节奏调整）

---

## 3. Phase 1：理解 AI Agent 核心概念

### 3.1 什么是 AI Agent？

AI Agent = **LLM + Tool-use + 循环**

普通的 LLM 对话是单轮的：你问一个问题，它回答。
Agent 在此基础上增加了两个关键能力：

1. **Tool-use（工具调用）**：LLM 可以"决定"调用外部工具（读文件、执行命令等）
2. **循环**：工具的执行结果会反馈给 LLM，LLM 根据结果继续思考和行动

### 3.2 Agent 循环图解

```
用户输入 prompt
    |
    v
+-----------------------------------+
|          Agent 循环                |
|                                   |
|  1. 发送 messages 给 Claude API   |
|                                   |
|  2. Claude 返回:                  |
|     - 纯文本回复？ --> 结束循环    |
|     - tool_use 调用？ --> 继续 v   |
|                                   |
|  3. 执行 tool（如读文件）          |
|                                   |
|  4. 将 tool_result 追加到 messages |
|                                   |
|  5. 回到步骤 1                    |
+-----------------------------------+
    |
    v
最终回复返回给用户
```

### 3.3 在本项目中的对应

这个循环在 `src/query.ts` 中实现（约 1729 行）。核心是一个 `while(true)` 循环：

```typescript
// src/query.ts 约 L310
while (true) {
  // 1. 调用 Claude API
  const response = yield* callModel(messages, tools, systemPrompt);

  // 2. 检查是否有 tool_use
  if (response.stop_reason === 'end_turn') break;  // 纯文本，结束

  // 3. 执行所有 tool calls
  const toolResults = await executeTools(response.tool_use_blocks);

  // 4. 追加结果到 messages
  messages.push(assistantMessage, ...toolResults);

  // 5. 继续循环（回到步骤 1）
}
```

**你的第一个目标**：理解上面这 10 行伪代码。后面所有内容都是在这个基础上添加细节。

### 3.4 关键概念对照表

| 概念 | 在 Anthropic API 中 | 在本项目中 |
|------|---------------------|-----------|
| 对话历史 | `messages` 数组 | `State.messages` (query.ts) |
| 工具定义 | `tools` 参数 | `Tool` 类型 (Tool.ts) |
| 工具调用 | `tool_use` content block | `ToolUseBlock` |
| 工具结果 | `tool_result` content block | `ToolResultBlockParam` |
| 系统提示 | `system` 参数 | `SystemPrompt` (systemPrompt.ts) |
| 停止原因 | `stop_reason` | `"end_turn"` / `"tool_use"` |

---

## 4. Phase 2：从最简单的 Tool 开始

### 4.1 为什么从 Tool 开始？

Tool 是 Agent 中最独立、最容易理解的模块。一个 Tool 就是：
- 一个**名字**（如 "Glob"）
- 一个**输入 schema**（你接受什么参数）
- 一个**执行函数**（你做什么）
- 一个**输出**（你返回什么）

### 4.2 必读文件：GlobTool（198 行）

**文件**: `src/tools/GlobTool/GlobTool.ts`

这是本项目中**最简单**的 Tool 实现。完整阅读它只需 15 分钟。

#### 结构拆解

```typescript
// ===== 第一部分：输入 Schema（约 L26-50）=====
// 用 Zod 定义工具接受什么参数
const inputSchema = lazySchema(() =>
  z.strictObject({
    pattern: z.string().describe('The glob pattern to match files against'),
    path: z.string().optional().describe('The directory to search in...'),
  }),
)

// ===== 第二部分：输出 Schema（约 L43-55）=====
const outputSchema = lazySchema(() =>
  z.object({
    durationMs: z.number(),
    numFiles: z.number(),
    filenames: z.array(z.string()),
    truncated: z.boolean(),
  }),
)

// ===== 第三部分：Tool 定义（约 L57-198）=====
export const GlobTool = buildTool({
  // 元信息
  name: GLOB_TOOL_NAME,              // 工具名称
  searchHint: 'find files by name',  // 搜索提示

  // Schema 绑定
  get inputSchema() { return inputSchema() },
  get outputSchema() { return outputSchema() },

  // 属性声明
  isReadOnly() { return true },           // 不修改文件
  isConcurrencySafe() { return true },    // 可以并行执行

  // 权限检查
  async checkPermissions(input, context) {
    return checkReadPermissionForTool(GlobTool, input, ...)
  },

  // ===== 核心：执行函数 =====
  async call(input, { abortController, getAppState, globLimits }) {
    const start = Date.now()
    const { files, truncated } = await glob(
      input.pattern,
      GlobTool.getPath(input),
      { limit: globLimits?.maxResults ?? 100, offset: 0 },
      abortController.signal,
    )
    return {
      data: {
        filenames: files.map(toRelativePath),
        durationMs: Date.now() - start,
        numFiles: files.length,
        truncated,
      },
    }
  },
})
```

### 4.3 buildTool 函数

**文件**: `src/Tool.ts:783-800`

`buildTool` 是一个工厂函数，它：
1. 接收你的 Tool 定义（部分实现）
2. 填入安全默认值（fail-closed）
3. 返回一个完整的 `Tool` 对象

```typescript
// src/Tool.ts L783
export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
  return {
    ...TOOL_DEFAULTS,          // 安全默认值
    userFacingName: () => def.name,
    ...def,                    // 你的实现覆盖默认值
  }
}
```

默认值包括（L756-781）：
- `isEnabled` -> `true`
- `isConcurrencySafe` -> `false`（默认不安全）
- `isReadOnly` -> `false`（默认假设写操作）
- `isDestructive` -> `false`
- `checkPermissions` -> `allow`（默认允许）

### 4.4 Tool 接口完整类型

**文件**: `src/Tool.ts:362-500`

核心方法一览：

| 方法 | 说明 | 必须实现？ |
|------|------|-----------|
| `name` | 工具名称 | 是 |
| `inputSchema` | Zod 输入 schema | 是 |
| `description()` | 动态描述（发给 LLM） | 是 |
| `call()` | **核心执行函数** | 是 |
| `isReadOnly()` | 是否只读 | 是 |
| `isConcurrencySafe()` | 是否可并行 | 是 |
| `checkPermissions()` | 权限检查 | 否（有默认值） |
| `validateInput()` | 输入校验 | 否 |
| `outputSchema` | 输出 schema | 否 |
| `isDestructive()` | 是否不可逆 | 否 |

### 4.5 练习：比较两个 Tool

阅读完 GlobTool 后，再阅读 `src/tools/GrepTool/GrepTool.ts`（577 行）。

比较两者：
- GrepTool 的 inputSchema 有更多字段
- GrepTool 的 call() 处理更复杂的逻辑
- 但**结构完全相同**：都是 `buildTool({ name, schema, call, ... })`

---

## 5. Phase 3：理解消息流与对话循环

### 5.1 消息类型

**文件**: `src/types/message.ts`

Claude API 使用以下消息格式：

```typescript
// 用户消息
type UserMessage = {
  type: 'user'
  uuid: string
  content: ContentBlock[]   // 文本、图片等
}

// 助手消息（Claude 的回复）
type AssistantMessage = {
  type: 'assistant'
  uuid: string
  content: ContentBlock[]   // 可能包含 text + tool_use
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens'
}

// 系统消息
type SystemMessage = {
  type: 'system'
  content: string
}
```

### 5.2 核心循环详解

**文件**: `src/query.ts`

```
queryLoop() 的完整流程:
|
+- 初始化 State（L275-290）
|   messages: 对话历史
|   toolUseContext: 工具集 + 权限 + 模型配置
|   turnCount: 循环计数器
|
+- while(true) 循环（L310+）
    |
    +- 1. 构建 API 请求参数
    |     systemPrompt + messages + tools
    |
    +- 2. 调用 deps.callModel()
    |     -> services/api/claude.ts 中的 queryModelWithStreaming()
    |     -> 实际调用 anthropic.beta.messages.create()
    |
    +- 3. 流式接收响应
    |     StreamingToolExecutor 边接收边执行工具
    |
    +- 4. 判断是否继续
    |     stop_reason === 'tool_use' -> 继续循环
    |     stop_reason === 'end_turn' -> 退出循环
    |
    +- 5. 如果继续：
    |     收集所有 tool_result
    |     追加到 messages
    |     turnCount++
    |     如果 turnCount >= maxTurns -> 退出
    |
    +- 6. Auto-compact（可选）
          如果 messages 太长，自动压缩历史
```

### 5.3 API 调用实际代码

**文件**: `src/services/api/claude.ts`

```typescript
// 核心 API 调用（约 L860）
const response = await anthropic.beta.messages.create({
  model: normalizeModelStringForAPI(params.model),
  max_tokens: params.max_tokens,
  system: systemPrompt,
  messages: normalizeMessagesForAPI(messages),
  tools: toolSchemas,
  // ... 更多参数
}, {
  signal: abortSignal,
  timeout: timeoutMs,
})
```

这就是"发送给 Claude"的那一行代码。所有 Agent 的智能都来自这个 API 调用。

### 5.4 工具执行

**文件**: `src/services/tools/StreamingToolExecutor.ts`

工具在流式接收过程中就开始执行（不需要等整个响应完成）：

```
Claude 响应流:
  [text: "让我搜索一下..."]
  [tool_use: { name: "Glob", input: { pattern: "*.ts" } }]
                  |
                  v  立即开始执行
          GlobTool.call({ pattern: "*.ts" })
                  |
                  v
          tool_result: { filenames: [...] }
```

---

## 6. Phase 4：系统提示词工程

### 6.1 系统提示的作用

系统提示（System Prompt）定义了 Agent 的"身份"和"行为规则"。它告诉 Claude：
- 你是谁（角色定义）
- 你能做什么（工具说明）
- 你应该怎么做（行为准则）
- 你不能做什么（安全限制）

### 6.2 系统提示构建

**文件**: `src/utils/systemPrompt.ts`

```typescript
// L41 - 构建有效的系统提示
export function buildEffectiveSystemPrompt({
  mainThreadAgentDefinition,   // Agent 定义（可选）
  toolUseContext,              // 工具上下文
  customSystemPrompt,          // 自定义提示
  defaultSystemPrompt,         // 默认提示（多段）
  appendSystemPrompt,          // 追加提示
  overrideSystemPrompt,        // 覆盖提示
}): SystemPrompt
```

**优先级顺序**：
1. `overrideSystemPrompt` — 完全替换（最高优先级）
2. Agent 的 `prompt` 字段 — 如果指定了 agent
3. `customSystemPrompt` — 用户自定义
4. `defaultSystemPrompt` — Claude Code 默认提示
5. `appendSystemPrompt` — 始终追加在最后

### 6.3 实践要点

对于你自己的 Agent，系统提示应该包含：

```
1. 角色定义
   "你是一个专门做 X 的 AI 助手。"

2. 能力说明
   "你可以使用以下工具：..."

3. 行为准则
   "当用户问 Y 时，你应该先做 Z。"

4. 限制条件
   "永远不要执行删除操作。"

5. 输出格式
   "回复使用中文，代码使用英文注释。"
```

---

## 7. Phase 5：权限系统与安全设计

### 7.1 为什么需要权限系统？

Agent 可以执行命令、编辑文件、访问网络。没有权限控制 = 安全灾难。

### 7.2 权限模式

**文件**: `src/types/permissions.ts`

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| `default` | 危险操作前询问用户 | 交互式使用 |
| `acceptEdits` | 自动批准文件编辑 | 信任的编码任务 |
| `bypassPermissions` | 跳过所有检查 | CI/CD（需显式确认） |
| `plan` | 只允许只读操作 | 规划模式 |
| `dontAsk` | 不询问，直接拒绝 | 后台代理 |

### 7.3 权限检查流程

```
Tool.call() 被调用
    |
    v
Tool.checkPermissions(input, context)
    |
    v
+-- 检查 PermissionMode --+
|                          |
|  bypassPermissions?      |
|  -> 直接允许             |
|                          |
|  plan?                   |
|  -> 只允许只读工具       |
|                          |
|  default?                |
|  -> 检查规则:            |
|     allow rules 匹配?    |
|     deny rules 匹配?     |
|     -> 'ask' 用户确认    |
+--------------------------+
    |
    v
PermissionResult: { behavior: 'allow' | 'deny' | 'ask' }
```

### 7.4 权限规则

```typescript
// settings.json 中的权限配置
{
  "permissions": {
    "allow": [
      "Read(*)",           // 允许读取任何文件
      "Glob(*)",           // 允许搜索
      "Bash(npm test)"     // 只允许运行 npm test
    ],
    "deny": [
      "Bash(rm -rf *)"    // 禁止删除
    ]
  }
}
```

---

## 8. Phase 6：使用 Agent SDK 构建你的第一个 Agent

### 8.1 安装 SDK

```bash
mkdir my-first-agent && cd my-first-agent
npm init -y
npm install @anthropic-ai/claude-agent-sdk
```

### 8.2 最简 Agent（10 行代码）

```typescript
// my-agent.ts
import { query } from '@anthropic-ai/claude-agent-sdk';

const result = query({
  prompt: "列出当前目录下所有的 TypeScript 文件",
  options: {
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  }
});

for await (const message of result) {
  if (message.type === 'assistant') {
    for (const block of message.content) {
      if (block.type === 'text') {
        process.stdout.write(block.text);
      }
    }
  }
}
```

运行：
```bash
ANTHROPIC_API_KEY=sk-ant-... npx tsx my-agent.ts
```

### 8.3 带自定义工具的 Agent

```typescript
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';

// 定义一个自定义工具
const weatherTool = tool(
  'get_weather',
  'Get current weather for a city',
  { city: z.string().describe('City name') },
  async ({ city }) => ({
    content: [{ type: 'text', text: `Weather in ${city}: Sunny, 25C` }]
  })
);

// 创建 MCP 服务器承载自定义工具
const mcpServer = createSdkMcpServer({
  name: 'weather-server',
  tools: [weatherTool],
});

// 运行 Agent
const result = query({
  prompt: "What's the weather in Tokyo?",
  options: {
    mcpServers: { 'weather': mcpServer },
    tools: ['Read', 'Bash', 'Glob'],   // 内置工具子集
  }
});

for await (const msg of result) {
  if (msg.type === 'assistant') {
    console.log(msg.content.filter(b => b.type === 'text').map(b => b.text).join(''));
  }
}
```

### 8.4 带 Agent 定义的多代理系统

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

const result = query({
  prompt: "Review the code in src/ and then run the tests",
  options: {
    agent: 'coordinator',
    agents: {
      'coordinator': {
        description: 'Coordinates code review and testing',
        prompt: 'You coordinate between the reviewer and tester agents.',
        tools: ['Read', 'Agent'],   // 可以调用子代理
      },
      'reviewer': {
        description: 'Reviews code for best practices',
        prompt: 'You are a code reviewer. Read files and report issues.',
        tools: ['Read', 'Grep', 'Glob'],
        model: 'haiku',   // 使用更便宜的模型
      },
      'tester': {
        description: 'Runs tests and reports results',
        prompt: 'You run tests and analyze results.',
        tools: ['Read', 'Bash'],
        background: true,  // 后台执行
      },
    },
  }
});
```

### 8.5 SDK 五个入口回顾

| 入口 | 导入路径 | 用途 |
|------|----------|------|
| 主入口 | `@anthropic-ai/claude-agent-sdk` | Node.js Agent 开发 |
| Browser | `.../browser` | 浏览器 WebSocket Agent |
| Bridge | `.../bridge` | CCR Worker 桥接 |
| Embed | `.../embed` | 获取 CLI 路径 |
| SDK Tools | `.../sdk-tools` | 工具类型定义（纯类型） |

> 详细的 SDK 导出分析见 `docs/architecture/agent-sdk-exports.md`

---

## 9. Phase 7：进阶 -- 子代理、Hook、Plugin

### 9.1 子代理 (Sub-agents)

**源码参考**: `src/tools/AgentTool/AgentTool.tsx`

子代理是 Agent 内部的"专家"。主 Agent 可以委派任务给子代理：

```
主 Agent（coordinator）
  |
  +-- 调用 AgentTool({ prompt: "review code", agent: "reviewer" })
  |     |
  |     +-- reviewer 子代理执行
  |     +-- 返回结果
  |
  +-- 调用 AgentTool({ prompt: "run tests", agent: "tester" })
        |
        +-- tester 子代理执行
        +-- 返回结果
```

**四种模式**（见 `AgentTool.call()` 的策略路由）：
1. **Normal** — 标准子代理
2. **Teammate** — 独立 worktree 的协作代理
3. **Fork** — 共享上下文前缀的分支执行
4. **Resume** — 恢复中断的代理

> 详细分析见 `docs/architecture/agent.md`

### 9.2 Hook 系统

**源码参考**: `src/utils/hooks/`

Hook 让你在 Agent 执行的关键节点注入自定义逻辑：

```typescript
// SDK 中使用 Hook
const result = query({
  prompt: "...",
  options: {
    hooks: {
      // 工具执行前 — 可以拦截/修改/拒绝
      PreToolUse: [{
        hooks: [async (input) => {
          if (input.tool_name === 'Bash' && input.tool_input.command.includes('rm')) {
            return {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: 'Delete commands not allowed'
            };
          }
          return { hookEventName: 'PreToolUse' };
        }]
      }],

      // 工具执行后 — 可以添加上下文
      PostToolUse: [{
        hooks: [async (input) => {
          console.log(`Tool ${input.tool_name} completed`);
          return { hookEventName: 'PostToolUse' };
        }]
      }],
    }
  }
});
```

**27 种 Hook 事件**（见 SDK 类型）：
- `PreToolUse` / `PostToolUse` — 工具执行前后
- `SessionStart` / `SessionEnd` — 会话生命周期
- `UserPromptSubmit` — 用户提交提示时
- `PermissionRequest` / `PermissionDenied` — 权限事件
- `SubagentStart` / `SubagentStop` — 子代理生命周期
- 等等...

### 9.3 Plugin 系统

**源码参考**: `src/utils/plugins/`

Plugin 是打包好的扩展单元，可以包含：
- **Agents** — 自定义子代理定义
- **Hooks** — 钩子脚本
- **Skills** — 技能/Slash 命令
- **MCP Servers** — MCP 工具服务器

一个 Plugin 的目录结构：

```
my-plugin/
  .claude-plugin/
    marketplace.json       # 插件元数据
  agents/
    reviewer.md            # Agent 定义（Markdown + frontmatter）
  hooks/
    pre-tool-use.sh        # Shell Hook 脚本
  skills/
    format-code/
      SKILL.md             # 技能定义
```

> 详细分析见 `docs/architecture/plugin-marketplace.md`

---

## 10. Phase 8：生产级 Agent 设计模式

以下模式来自本项目的实际实现，是经过生产验证的：

### 10.1 前台/后台热切换

**源码**: `src/tools/AgentTool/AgentTool.tsx:868-1126`

```typescript
// 用 Promise.race 实现用户可随时将前台任务转为后台
const result = await Promise.race([
  runAgentPromise,      // Agent 正常执行
  backgroundSignal,     // 用户选择"转入后台"
]);
// 如果 backgroundSignal 先触发 -> 返回 async_launched
// 但 runAgentPromise 继续在后台执行
```

**你可以学到**: 如何让长时间运行的 Agent 任务不阻塞用户交互。

### 10.2 Prompt Cache 优化

**源码**: `src/tools/AgentTool/forkSubagent.ts:91-169`

Fork 子代理使用相同的消息前缀来命中 Claude 的 prompt cache，显著降低 API 成本。

**你可以学到**: 如何在多代理场景中优化 token 使用。

### 10.3 Fail-Closed 安全模型

**源码**: `src/utils/plugins/pluginLoader.ts:1922-2000`

```
不可验证的来源 + 激活的策略 = 阻断（而非放行）
```

**你可以学到**: Agent 安全设计应该默认拒绝，而非默认允许。

### 10.4 原子状态管理

**源码**: `src/tools/AgentTool/agentToolUtils.ts:508-686`

后台 Agent 生命周期管理中，先设置终端状态再执行慢操作（乐观锁模式）。

**你可以学到**: 如何防止 Agent 在中间状态卡死。

### 10.5 只增不删 Reconciler

**源码**: `src/utils/plugins/reconciler.ts:50-83`

远程更新只添加新内容，永远不删除本地已安装的插件。

**你可以学到**: 分布式系统中的安全同步策略。

---

## 11. 源码阅读顺序清单

按照推荐顺序阅读，每个文件标注了难度和预计时间：

### 入门级

| # | 文件 | 行数 | 难度 | 时间 | 学到什么 |
|---|------|------|------|------|----------|
| 1 | `src/tools/GlobTool/GlobTool.ts` | 198 | ★☆☆ | 15m | Tool 的基本结构 |
| 2 | `src/tools/GlobTool/prompt.ts` | ~30 | ★☆☆ | 5m | Tool 描述如何写 |
| 3 | `src/tools/GlobTool/UI.tsx` | ~50 | ★☆☆ | 10m | Tool 结果如何展示 |
| 4 | `src/Tool.ts` L700-800 | 100 | ★★☆ | 20m | buildTool + ToolDef |

### 进阶级

| # | 文件 | 行数 | 难度 | 时间 | 学到什么 |
|---|------|------|------|------|----------|
| 5 | `src/tools/GrepTool/GrepTool.ts` | 577 | ★★☆ | 30m | 更复杂的 Tool |
| 6 | `src/Tool.ts` L362-500 | 140 | ★★☆ | 20m | 完整 Tool 接口 |
| 7 | `src/types/message.ts` | ~200 | ★★☆ | 15m | 消息类型 |
| 8 | `src/utils/systemPrompt.ts` | 123 | ★★☆ | 15m | 系统提示构建 |
| 9 | `src/types/permissions.ts` | ~80 | ★★☆ | 10m | 权限模型 |

### 核心级

| # | 文件 | 行数 | 难度 | 时间 | 学到什么 |
|---|------|------|------|------|----------|
| 10 | `src/query.ts` | 1729 | ★★★ | 60m | Agent 循环核心 |
| 11 | `src/services/api/claude.ts` L700-900 | 200 | ★★★ | 30m | API 调用细节 |
| 12 | `src/utils/processUserInput/processUserInput.ts` | 605 | ★★★ | 30m | 输入处理管线 |

### 高级架构

| # | 文件 | 行数 | 难度 | 时间 | 学到什么 |
|---|------|------|------|------|----------|
| 13 | `src/tools/AgentTool/AgentTool.tsx` | 1397 | ★★★ | 60m | 子代理系统 |
| 14 | `src/tools/AgentTool/runAgent.ts` | 973 | ★★★ | 45m | Agent 执行引擎 |
| 15 | `src/utils/plugins/pluginLoader.ts` | 3302 | ★★★ | 90m | 插件系统 |

---

## 12. 动手练习项目

### 练习 1：Hello World Agent（难度 ★☆☆）

用 SDK 创建一个最简单的 Agent，能回答问题：

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
// 目标：让它回答 "你好，你能做什么？"
```

### 练习 2：文件搜索 Agent（难度 ★★☆）

创建一个 Agent，只配备 Read + Glob + Grep 工具，用来搜索代码：

```typescript
const result = query({
  prompt: "找出所有包含 TODO 注释的文件",
  options: { tools: ['Read', 'Glob', 'Grep'] }
});
```

### 练习 3：自定义 MCP 工具（难度 ★★☆）

使用 `createSdkMcpServer` 和 `tool` 函数创建一个自定义数据库查询工具。

### 练习 4：双代理协作（难度 ★★★）

创建两个子代理：
- `analyzer` — 分析代码结构
- `reporter` — 生成报告

主代理协调两者完成"代码分析报告"任务。

### 练习 5：带 Hook 的安全 Agent（难度 ★★★）

实现 PreToolUse hook，禁止执行包含 `rm`、`delete`、`drop` 的 Bash 命令。

### 练习 6：参考本项目写一个 Tool（难度 ★★★）

模仿 `GlobTool.ts` 的模式，为本项目添加一个新的 Tool：
- 定义 inputSchema / outputSchema
- 实现 call() 方法
- 实现 checkPermissions()
- 在 `src/tools.ts` 中注册

---

## 13. 参考资源

### 官方文档

| 资源 | 链接 |
|------|------|
| Claude Agent SDK 文档 | https://platform.claude.com/docs/en/agent-sdk/overview |
| Claude Agent SDK 迁移指南 | https://platform.claude.com/docs/en/agent-sdk/migration-guide |
| Anthropic API 文档 | https://docs.anthropic.com/en/api |
| Tool Use 文档 | https://docs.anthropic.com/en/docs/build-with-claude/tool-use |
| MCP 协议 | https://modelcontextprotocol.io |

### 本项目文档

| 文档 | 内容 |
|------|------|
| `docs/architecture/agent.md` | Agent 子系统 10 种设计模式详解 |
| `docs/architecture/plugin-marketplace.md` | Plugin 三层架构 13 种设计模式详解 |
| `docs/architecture/agent-sdk-exports.md` | SDK 5 个入口完整导出分析 |
| `docs/design/private-plugin-marketplace.md` | 企业私有 Plugin 市场设计方案 |
| `docs/guides/build.md` | 项目构建指南 |
| `docs/guides/secondary-development.md` | 二次开发手册 |

### 社区资源

| 资源 | 说明 |
|------|------|
| [Claude Developers Discord](https://anthropic.com/discord) | 官方开发者社区 |
| [GitHub Issues](https://github.com/anthropics/claude-agent-sdk-typescript/issues) | SDK Bug 反馈 |
| NPM: `@anthropic-ai/claude-agent-sdk` | SDK 包（当前 v0.2.92） |

---

## 快速参考卡

### Agent 循环伪代码

```
messages = [{ role: "user", content: prompt }]
while true:
    response = claude.messages.create(system, messages, tools)
    if response.stop_reason == "end_turn":
        break
    for tool_call in response.tool_use_blocks:
        result = execute(tool_call)
        messages.append(tool_result(result))
return response.text
```

### SDK 最小用法

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
for await (const msg of query({ prompt: "Hello" })) {
  if (msg.type === 'result') console.log(msg);
}
```

### 自定义 Tool 最小模板

```typescript
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';

const myTool = tool(
  'tool_name',
  'What this tool does',
  { param: z.string() },
  async ({ param }) => ({
    content: [{ type: 'text', text: `Result: ${param}` }]
  })
);
```

### 从源码学一个 Tool 的模板

```typescript
// 参考 src/tools/GlobTool/GlobTool.ts
import { buildTool } from '../../Tool.js';
import { z } from 'zod/v4';

export const MyTool = buildTool({
  name: 'MyTool',
  get inputSchema() { return z.strictObject({ ... }) },
  isReadOnly() { return true },
  isConcurrencySafe() { return true },
  async description() { return '...' },
  async call(input, context) {
    // 你的逻辑
    return { data: result };
  },
});
```
