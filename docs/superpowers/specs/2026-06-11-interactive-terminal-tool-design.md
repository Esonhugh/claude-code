# Interactive Terminal Tool 设计文档

- 日期：2026-06-11
- 状态：已确认设计，待进入实现计划
- 主题：为 Claude Code 增加基于 PTY 的通用交互式终端内建工具

## 1. 背景与目标

当前 Bash 工具更适合一次性命令执行与输出回收，不适合承载持续性的交互式终端语义。对于 CLI / REPL / TUI 场景，AI 需要的是：

- 持续存在的会话
- 分步写入输入
- 增量读取输出
- 发送特殊按键与信号
- 调整终端尺寸
- 获取会话状态并进行资源清理

本设计的目标是在 Claude Code 中新增一个内建交互式终端工具，优先服务通用 CLI / REPL 交互，并提供对 TUI 程序的基础兼容能力。

## 2. 设计约束

已确认的约束如下：

- 可以接受少量稳定依赖
- 跨平台优先（macOS / Linux / Windows）
- 第一阶段优先保证 CLI / REPL 的稳定交互
- TUI 支持作为增强能力，但第一版不做复杂屏幕语义解析
- 接入形态为 Claude Code 内建 tool
- 对外可以使用单工具 `action=` 形态
- 对内保持按 action 分 handler 的清晰实现结构
- 不污染现有 Bash 工具的一次性执行语义

## 3. 推荐方案概述

推荐方案为：

- 新增一个内建 `InteractiveTerminal` 工具
- 对外暴露为单工具 `InteractiveTerminal(action=...)`
- 对内以 `PtySessionManager` 管理基于 `node-pty` 的持久 PTY 会话
- 内部使用分 action handler 的结构，而不是将所有逻辑堆叠在一个大 switch 中

该方案兼顾：

- 内建 tool 的权限与产品集成能力
- `node-pty` 提供的少量稳定依赖与跨平台 PTY 能力
- session 型能力在模型侧的统一调用体验
- 后续向 TUI、workflow、可观测性增强的可扩展性

## 4. 非目标

第一版明确不做以下内容：

- 将 tmux 作为核心后端
- 复杂 ANSI / VT100 / screen buffer 语义解析
- pane / window 多路复用
- 终端画面结构化理解
- 会话持久化到磁盘后的恢复
- 远程 terminal / browser terminal
- workflow 专用可视化面板

tmux 仍可继续作为测试、调试、workflow parity 验证工具使用，但不作为产品核心抽象。

## 5. 总体架构

### 5.1 对外工具形态

对外采用单工具：

- `InteractiveTerminal`

并以 `action` 区分操作：

- `open`
- `write`
- `read`
- `send_key`
- `resize`
- `signal`
- `status`
- `close`

这样可以避免工具簇导致的工具列表膨胀、权限零碎化与日志碎片化问题，同时保持 session 型能力的统一语义。

### 5.2 对内分层

#### Tool 层：`InteractiveTerminalTool`

职责：

- 暴露工具 schema
- 做参数校验与规范化
- 执行权限检查
- 路由到对应 action handler
- 统一格式化结果与错误

#### Runtime 层：`PtySessionManager`

职责：

- 创建、查询、关闭、销毁 PTY session
- 维护 session 注册表
- 维护输出缓冲区与 cursor
- 跟踪退出码、运行状态、尺寸、活动时间
- 提供 `open / write / read / sendKey / resize / signal / status / close`

#### Driver 层：`node-pty` 适配器

职责：

- 基于 `node-pty` 创建 PTY 进程
- 处理平台差异（macOS / Linux / Windows）
- 向 Runtime 层提供统一的 PTY 行为接口

#### 可选可观测层

第一版至少保留轻量审计能力，后续可扩展为：

- session 状态查看
- transcript 导出
- workflow / agent 联动展示

## 6. 为何不扩展 Bash 语义

Bash 工具的核心模型是：

- 一次性执行命令
- 回收命令结果
- 偏向 job runner

Interactive Terminal 的核心模型是：

- 持续存在的会话
- 逐步读写
- 偏向 stateful session

两者语义不同。如果将 PTY 交互式会话能力直接塞入 Bash，会导致：

- 工具契约混乱
- 权限语义冲突
- 模型误用概率增加
- UI 与日志表达不清晰

因此必须将其作为独立工具引入。

## 7. 核心组件与数据模型

### 7.1 `PtySessionManager`

内部维护：

- `Map<string, TerminalSession>`

负责 session 生命周期与统一调度。

### 7.2 `TerminalSession`

建议至少包含以下字段：

```ts
type TerminalSession = {
  id: string
  pid: number
  command: string
  args: string[]
  cwd: string
  envWhitelistSummary?: string[]
  shell?: string

  cols: number
  rows: number

  startedAt: number
  lastActivityAt: number
  closedAt?: number

  isRunning: boolean
  exitCode?: number
  exitSignal?: string
  state: 'starting' | 'running' | 'exited' | 'closed' | 'failed'

  outputCursor: number
  outputBuffer: string
  outputChunks: Array<{
    start: number
    end: number
    text: string
    ts: number
  }>

  byteLength: number
}
```

### 7.3 Cursor 模型

每个 session 维护一个连续递增的 `outputCursor`。`read` 调用携带调用方已读取到的位置，只返回增量内容。

这样可以避免：

- 每次返回全量输出造成 token 浪费
- 只取最近 N 行导致上下文丢失

推荐 `read` 返回示例：

```json
{
  "sessionId": "term_1",
  "fromCursor": 120,
  "toCursor": 168,
  "text": ">>> print('hi')\r\nhi\r\n>>> ",
  "isRunning": true,
  "exitCode": null,
  "truncatedBeforeCursor": false
}
```

### 7.4 输出缓冲策略

建议采用：

- 逻辑上全局 cursor
- 物理上按 chunk 存储输出
- 达到上限后裁剪旧 chunk
- 返回 `truncatedBeforeCursor` 显式告知是否发生前文裁剪

第一版可设置单 session 缓冲上限为约 1MB ~ 4MB。

## 8. 对外工具接口

### 8.1 `action=open`

输入示例：

```json
{
  "action": "open",
  "command": "python",
  "args": ["-i"],
  "cwd": "/workspace/project",
  "env": {
    "PYTHONUNBUFFERED": "1"
  },
  "cols": 120,
  "rows": 30
}
```

返回示例：

```json
{
  "sessionId": "term_1",
  "pid": 12345,
  "isRunning": true,
  "cols": 120,
  "rows": 30
}
```

### 8.2 `action=write`

输入示例：

```json
{
  "action": "write",
  "sessionId": "term_1",
  "text": "print('hi')",
  "enter": true
}
```

返回示例：

```json
{
  "sessionId": "term_1",
  "accepted": true,
  "isRunning": true
}
```

### 8.3 `action=send_key`

输入示例：

```json
{
  "action": "send_key",
  "sessionId": "term_1",
  "key": "CTRL_C"
}
```

第一版建议支持：

- `ENTER`
- `TAB`
- `ESC`
- `BACKSPACE`
- `UP`
- `DOWN`
- `LEFT`
- `RIGHT`
- `CTRL_C`
- `CTRL_D`
- `CTRL_L`

返回示例：

```json
{
  "sessionId": "term_1",
  "accepted": true,
  "isRunning": true
}
```

### 8.4 `action=read`

输入示例：

```json
{
  "action": "read",
  "sessionId": "term_1",
  "cursor": 120,
  "maxBytes": 8192
}
```

返回示例：

```json
{
  "sessionId": "term_1",
  "fromCursor": 120,
  "toCursor": 168,
  "text": "hi\r\n>>> ",
  "isRunning": true,
  "exitCode": null,
  "truncatedBeforeCursor": false
}
```

### 8.5 `action=resize`

输入示例：

```json
{
  "action": "resize",
  "sessionId": "term_1",
  "cols": 140,
  "rows": 40
}
```

返回示例：

```json
{
  "sessionId": "term_1",
  "cols": 140,
  "rows": 40,
  "isRunning": true
}
```

### 8.6 `action=signal`

输入示例：

```json
{
  "action": "signal",
  "sessionId": "term_1",
  "signal": "SIGINT"
}
```

返回示例：

```json
{
  "sessionId": "term_1",
  "accepted": true,
  "isRunning": true
}
```

### 8.7 `action=status`

输入示例：

```json
{
  "action": "status",
  "sessionId": "term_1"
}
```

返回示例：

```json
{
  "sessionId": "term_1",
  "pid": 12345,
  "isRunning": true,
  "exitCode": null,
  "cols": 120,
  "rows": 30,
  "bufferCursor": 168,
  "startedAt": 1760000000000,
  "lastActivityAt": 1760000009000
}
```

### 8.8 `action=close`

输入示例：

```json
{
  "action": "close",
  "sessionId": "term_1",
  "force": false
}
```

返回示例：

```json
{
  "sessionId": "term_1",
  "closed": true,
  "exitCode": 0
}
```

## 9. 内部实现结构建议

虽然对外使用单工具 `action=`，但内部必须拆成独立 action handler：

- `handleOpen`
- `handleWrite`
- `handleRead`
- `handleSendKey`
- `handleResize`
- `handleSignal`
- `handleStatus`
- `handleClose`

推荐文件组织方向：

- `InteractiveTerminalTool.ts`
- `terminalActions/open.ts`
- `terminalActions/write.ts`
- `terminalActions/read.ts`
- `terminalActions/sendKey.ts`
- `terminalActions/resize.ts`
- `terminalActions/signal.ts`
- `terminalActions/status.ts`
- `terminalActions/close.ts`
- `pty/PtySessionManager.ts`
- `pty/nodePtyDriver.ts`

这样既满足单工具产品形态，也保证实现与测试层面的清晰边界。

## 10. 错误处理

建议错误码至少包括：

- `INVALID_ACTION`
- `INVALID_ACTION_INPUT`
- `SESSION_NOT_FOUND`
- `SESSION_NOT_RUNNING`
- `SESSION_ALREADY_CLOSED`
- `READ_CURSOR_INVALID`
- `PTY_START_FAILED`
- `PTY_WRITE_FAILED`
- `PTY_SIGNAL_FAILED`
- `PERMISSION_DENIED`
- `INTERNAL_ERROR`

统一错误返回结构建议为：

```json
{
  "error": {
    "code": "INVALID_ACTION_INPUT",
    "message": "action=write requires sessionId and text",
    "details": {
      "action": "write",
      "missing": ["sessionId", "text"]
    }
  }
}
```

错误信息必须能够直接指导模型修正下一次调用，而不是只返回模糊的失败描述。

## 11. 权限模型

建议以 session 为授权单位。

### 11.1 `open`

`action=open` 需要显式授权，因为它表示：

- 启动一个交互式进程
- 允许后续持续控制
- 会话可以跨多个工具调用持续存在

### 11.2 session 内后续动作

对于同一已授权 session 的以下动作：

- `write`
- `read`
- `send_key`
- `resize`
- `status`
- `signal`
- `close`

可以复用该 session 的授权上下文，避免每次按键都弹权限提示。

### 11.3 可选限制

建议预留以下限制策略：

- 限制可执行命令
- 限制 cwd 范围
- 限制 env 透传
- 限制最大 session 数
- 限制空闲超时
- 限制单 session 最大缓冲

## 12. 生命周期与资源回收

### 12.1 状态机

建议 session 至少具有以下状态：

- `starting`
- `running`
- `exited`
- `closed`
- `failed`

### 12.2 退出后保留期

进程自然退出后，不应立即删除 session，而应短暂保留以支持：

- 读取最后输出
- 查询退出码
- 执行显式 `close`

例如保留 60 秒或直到显式 `close`。

### 12.3 自动回收

建议加入：

- 长时间无活动 session 自动关闭
- 长时间已退出 session 自动清理
- 超出最大 session 数时拒绝新建

## 13. 标准交互流

### 13.1 CLI / REPL happy path

```text
open
→ read
→ write
→ read
→ write
→ read
→ close
```

### 13.2 长任务中断流

```text
open
→ write
→ read
→ signal(SIGINT) / send_key(CTRL_C)
→ read
→ status
→ close
```

### 13.3 TUI 基础兼容流

```text
open(cols, rows)
→ read
→ send_key(方向键 / Enter / Esc)
→ read
→ resize
→ read
→ close
```

第一版只保证“能驱动”，不保证“能理解布局”。

## 14. 测试策略

### 14.1 单元测试

覆盖：

- action 分发
- 参数校验
- session 状态流转
- cursor 增量读取逻辑
- buffer 截断逻辑
- close / signal / exited 语义

### 14.2 CLI / REPL 集成测试

至少覆盖：

- shell + `echo hello`
- Python / Node REPL 多轮输入输出
- 长任务中断（如 sleep / ping / loop）

### 14.3 TUI 基础集成测试

使用简单稳定样本，如：

- 最小 Ink demo
- 简单 curses / blessed 示例

验证：

- 启动不崩
- resize 可工作
- 方向键可发送
- read 能收到输出

### 14.4 平台测试矩阵

至少覆盖：

- macOS
- Linux
- Windows

重点关注：

- `CTRL_C`
- resize
- shell 默认值
- 换行差异
- `node-pty` 平台行为差异

## 15. 第一版范围

### 15.1 第一版必须完成

- 单工具 `InteractiveTerminal(action=...)`
- `node-pty` 后端
- `PtySessionManager`
- `open / write / read / send_key / resize / signal / status / close`
- cursor 增量读取
- 轻量审计日志
- 基础跨平台测试

### 15.2 第一版明确不做

- 复杂 ANSI 解析
- 结构化 screen buffer
- 多 session UI 面板
- tmux backend 替代
- 会话持久化恢复
- workflow 专用可视化联动

### 15.3 后续增强方向

- `wait_for` / `expect` 风格动作
- 可见屏幕快照抽象
- ANSI / vt buffer 解析
- 更丰富 key map
- workflow / agent UI 联动
- transcript 导出

## 16. 结论

本设计建议为 Claude Code 引入一个专门的交互式终端内建工具，以 PTY 为核心抽象，优先稳定支持 CLI / REPL 交互，并为 TUI 提供基础兼容。该工具在产品层面以单工具 `action=` 形式暴露，在实现层面保持分 action handler 与独立 `PtySessionManager` 的清晰结构。

这样既能解决现有 Bash 工具不适合承载交互式终端语义的问题，也为未来的可观测性、workflow 集成与更深层终端能力增强预留了空间。
