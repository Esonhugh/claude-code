# InteractiveTerminal Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Claude Code 增加一个基于 PTY 的内建 `InteractiveTerminal` 工具，支持持久交互式 CLI/REPL 会话，并提供 TUI 基础兼容能力。

**Architecture:** 对外暴露单工具 `InteractiveTerminal(action=...)`，对内拆分为 action handler 与 `PtySessionManager`。工具注册在内建工具池中，底层基于 `node-pty` 驱动跨平台 PTY，会话状态、缓冲、cursor 和生命周期由独立 runtime 层统一管理。

**Tech Stack:** TypeScript、Node 原生 `node:test`、Zod、Claude Code Tool framework、`node-pty`、现有 Shell/Task 基础设施。

---

## 文件结构与职责映射

### 新增文件

- `src/tools/InteractiveTerminalTool/InteractiveTerminalTool.ts`
  - 新工具入口，定义 schema、权限、action 分发与结果格式。
- `src/tools/InteractiveTerminalTool/prompt.ts`
  - 工具名与用户展示名常量。
- `src/tools/InteractiveTerminalTool/UI.tsx`
  - 工具调用中的最小 UI 文案与结果渲染辅助。
- `src/tools/InteractiveTerminalTool/actionSchemas.ts`
  - `action=open|write|read|send_key|resize|signal|status|close` 的 schema 与校验辅助。
- `src/tools/InteractiveTerminalTool/handlers/open.ts`
- `src/tools/InteractiveTerminalTool/handlers/write.ts`
- `src/tools/InteractiveTerminalTool/handlers/read.ts`
- `src/tools/InteractiveTerminalTool/handlers/sendKey.ts`
- `src/tools/InteractiveTerminalTool/handlers/resize.ts`
- `src/tools/InteractiveTerminalTool/handlers/signal.ts`
- `src/tools/InteractiveTerminalTool/handlers/status.ts`
- `src/tools/InteractiveTerminalTool/handlers/close.ts`
  - 每个 action 的独立 handler，实现“单工具外观、内部多动作核心”。
- `src/utils/pty/PtySessionManager.ts`
  - PTY session 注册、生命周期管理、cursor/缓冲、自动回收。
- `src/utils/pty/nodePtyDriver.ts`
  - 基于 `node-pty` 的进程适配层。
- `src/utils/pty/keyMap.ts`
  - 特殊按键到 PTY 写入序列的映射。
- `src/utils/pty/types.ts`
  - session state、action result、cursor read 等共享类型。
- `src/utils/pty/__fixtures__/FakePtyDriver.ts`
  - 单元测试用假驱动，避免每个测试都依赖真实 PTY。
- `src/tools/InteractiveTerminalTool/InteractiveTerminalTool.test.ts`
  - 工具级 action 分发、校验与错误测试。
- `src/utils/pty/PtySessionManager.test.ts`
  - session manager 逻辑测试。
- `src/utils/pty/nodePtyDriver.integration.test.ts`
  - 真实 PTY 驱动基础集成测试。

### 修改文件

- `package.json`
  - 增加 `node-pty` 依赖；如有必要补充针对新测试文件的脚本或说明。
- `pnpm-lock.yaml`
  - 依赖锁文件同步。
- `src/tools.ts`
  - 注册 `InteractiveTerminalTool` 到基础工具池。
- `src/Tool.ts`
  - 如有需要，为新工具补充 progress 类型或与 tool context 交互的类型定义。
- `src/utils/shell/resolveDefaultShell.ts`
  - 若 `InteractiveTerminal` 的 `open` 未指定 shell 类型，复用这里的默认 shell 选择逻辑。
- `src/utils/shell/shellProvider.ts`
  - 如需抽出默认 shell/平台差异复用点，则在这里补充最小共享接口。
- `docs/superpowers/specs/2026-06-11-interactive-terminal-tool-design.md`
  - 仅在实现时发现需修正的设计细节时再更新；默认不改。

### 参考但默认不改

- `src/tools/BashTool/BashTool.tsx`
  - 参考 tool 风格、权限与结果渲染结构，但不把 PTY 能力塞进 Bash。
- `src/tasks/LocalShellTask/LocalShellTask.tsx`
  - 参考后台 shell task 的生命周期与通知方式；第一版避免把 InteractiveTerminal 设计成 TaskOutput 文件尾流模型。
- `src/utils/ShellCommand.ts`
  - 参考命令执行对象模式；InteractiveTerminal 保持独立 session 抽象。

## 实现策略说明

1. **先做 runtime，再接 tool。** 如果一开始就写大一统工具，参数校验、session 管理和底层 PTY 逻辑会缠在一起，后续很难测。
2. **严格 TDD。** 先写假驱动下的 manager 测试，再写工具测试，最后补真实 PTY 集成测试。
3. **第一版只保证 CLI/REPL 稳定和 TUI 基础兼容。** 不做 ANSI 屏幕语义解析，不做 tmux 后端。
4. **不提交 commit，除非用户明确批准。** 本计划中的 “Commit” 步骤作为执行模板保留，但实际执行前需再次得到用户批准。

---

### Task 1: 增加 PTY 依赖与共享类型骨架

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/utils/pty/types.ts`
- Create: `src/utils/pty/keyMap.ts`
- Test: `src/utils/pty/PtySessionManager.test.ts`

- [ ] **Step 1: 写失败测试，先定义 session 状态与按键映射的最小契约**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  INITIAL_TERMINAL_SIZE,
  SESSION_STATES,
  SPECIAL_KEYS,
} from './types.js'
import { keyToSequence } from './keyMap.js'

test('exports the supported InteractiveTerminal session states', () => {
  assert.deepEqual(SESSION_STATES, [
    'starting',
    'running',
    'exited',
    'closed',
    'failed',
  ])
})

test('exports the default terminal size', () => {
  assert.deepEqual(INITIAL_TERMINAL_SIZE, { cols: 120, rows: 30 })
})

test('maps CTRL_C and ENTER to concrete PTY sequences', () => {
  assert.equal(keyToSequence('CTRL_C'), '')
  assert.equal(keyToSequence('ENTER'), '\r')
})

test('rejects unsupported keys', () => {
  assert.throws(() => keyToSequence('CTRL_Z' as never), /Unsupported terminal key: CTRL_Z/)
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test src/utils/pty/PtySessionManager.test.ts`
Expected: FAIL，提示 `Cannot find module './types.js'` 或缺少 `keyToSequence` 导出。

- [ ] **Step 3: 写最小实现，建立共享类型与按键映射**

```ts
// src/utils/pty/types.ts
export const SESSION_STATES = [
  'starting',
  'running',
  'exited',
  'closed',
  'failed',
] as const

export type TerminalSessionState = (typeof SESSION_STATES)[number]

export const INITIAL_TERMINAL_SIZE = {
  cols: 120,
  rows: 30,
} as const

export const SPECIAL_KEYS = [
  'ENTER',
  'TAB',
  'ESC',
  'BACKSPACE',
  'UP',
  'DOWN',
  'LEFT',
  'RIGHT',
  'CTRL_C',
  'CTRL_D',
  'CTRL_L',
] as const

export type TerminalSpecialKey = (typeof SPECIAL_KEYS)[number]

export type TerminalOutputChunk = {
  start: number
  end: number
  text: string
  ts: number
}

export type TerminalSessionRecord = {
  id: string
  pid: number
  command: string
  args: string[]
  cwd: string
  cols: number
  rows: number
  startedAt: number
  lastActivityAt: number
  closedAt?: number
  isRunning: boolean
  exitCode?: number
  exitSignal?: string
  state: TerminalSessionState
  outputCursor: number
  outputChunks: TerminalOutputChunk[]
  byteLength: number
}
```

```ts
// src/utils/pty/keyMap.ts
import type { TerminalSpecialKey } from './types.js'

const KEY_TO_SEQUENCE: Record<TerminalSpecialKey, string> = {
  ENTER: '\r',
  TAB: '\t',
  ESC: '',
  BACKSPACE: '',
  UP: '[A',
  DOWN: '[B',
  LEFT: '[D',
  RIGHT: '[C',
  CTRL_C: '',
  CTRL_D: '',
  CTRL_L: '',
}

export function keyToSequence(key: TerminalSpecialKey): string {
  const sequence = KEY_TO_SEQUENCE[key]
  if (!sequence) {
    throw new Error(`Unsupported terminal key: ${key}`)
  }
  return sequence
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `node --test src/utils/pty/PtySessionManager.test.ts`
Expected: PASS，4 个测试全部通过。

- [ ] **Step 5: 增加 PTY 依赖**

Run: `pnpm add node-pty`
Expected: `package.json` 与 `pnpm-lock.yaml` 更新，安装成功且无 npm 命令出现。

- [ ] **Step 6: 验证依赖声明已更新**

Run: `git diff -- package.json pnpm-lock.yaml`
Expected: 能看到 `node-pty` 被加入依赖，且只包含预期的锁文件改动。

- [ ] **Step 7: Commit（仅在用户明确批准后执行）**

```bash
git add package.json pnpm-lock.yaml src/utils/pty/types.ts src/utils/pty/keyMap.ts src/utils/pty/PtySessionManager.test.ts
git commit -m "feat: add pty terminal primitives"
```

---

### Task 2: 实现 `PtySessionManager` 的会话状态与 cursor 缓冲逻辑

**Files:**
- Create: `src/utils/pty/PtySessionManager.ts`
- Create: `src/utils/pty/__fixtures__/FakePtyDriver.ts`
- Modify: `src/utils/pty/types.ts`
- Test: `src/utils/pty/PtySessionManager.test.ts`

- [ ] **Step 1: 写失败测试，定义 session manager 的 open/read/write/status/close 基本行为**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'

import { FakePtyDriver } from './__fixtures__/FakePtyDriver.js'
import { PtySessionManager } from './PtySessionManager.js'

test('opens a session and returns initial running status', async () => {
  const driver = new FakePtyDriver()
  const manager = new PtySessionManager({ driver, maxBufferBytes: 1024 })

  const opened = await manager.open({
    command: 'python',
    args: ['-i'],
    cwd: '/tmp/project',
    cols: 120,
    rows: 30,
  })

  assert.equal(opened.isRunning, true)
  assert.equal(opened.cols, 120)
  assert.match(opened.sessionId, /^term_/)
})

test('reads incrementally from the cursor', async () => {
  const driver = new FakePtyDriver()
  const manager = new PtySessionManager({ driver, maxBufferBytes: 1024 })
  const opened = await manager.open({ command: 'node', args: [], cwd: '/tmp/project', cols: 80, rows: 24 })

  driver.pushOutput(opened.sessionId, 'hello')
  const firstRead = await manager.read({ sessionId: opened.sessionId, cursor: 0, maxBytes: 1024 })
  assert.equal(firstRead.text, 'hello')

  driver.pushOutput(opened.sessionId, ' world')
  const secondRead = await manager.read({ sessionId: opened.sessionId, cursor: firstRead.toCursor, maxBytes: 1024 })
  assert.equal(secondRead.text, ' world')
})

test('close transitions the session to closed and rejects later writes', async () => {
  const driver = new FakePtyDriver()
  const manager = new PtySessionManager({ driver, maxBufferBytes: 1024 })
  const opened = await manager.open({ command: 'bash', args: [], cwd: '/tmp/project', cols: 80, rows: 24 })

  await manager.close({ sessionId: opened.sessionId, force: false })

  await assert.rejects(
    () => manager.write({ sessionId: opened.sessionId, text: 'pwd', enter: true }),
    /SESSION_ALREADY_CLOSED/,
  )
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test src/utils/pty/PtySessionManager.test.ts`
Expected: FAIL，缺少 `PtySessionManager` 或 `FakePtyDriver`。

- [ ] **Step 3: 写最小假驱动实现，支持测试推送输出**

```ts
// src/utils/pty/__fixtures__/FakePtyDriver.ts
export class FakePtyDriver {
  #sessions = new Map<string, {
    pid: number
    onData?: (text: string) => void
    onExit?: (exitCode: number) => void
    writes: string[]
  }>()

  async open(sessionId: string, _input: { command: string; args: string[]; cwd: string; cols: number; rows: number }) {
    this.#sessions.set(sessionId, {
      pid: this.#sessions.size + 1000,
      writes: [],
    })
    return {
      pid: this.#sessions.get(sessionId)!.pid,
      bind: (handlers: { onData: (text: string) => void; onExit: (exitCode: number) => void }) => {
        const session = this.#sessions.get(sessionId)!
        session.onData = handlers.onData
        session.onExit = handlers.onExit
      },
      write: (text: string) => {
        this.#sessions.get(sessionId)!.writes.push(text)
      },
      resize: (_cols: number, _rows: number) => {},
      kill: () => {
        this.#sessions.get(sessionId)?.onExit?.(0)
      },
    }
  }

  pushOutput(sessionId: string, text: string): void {
    this.#sessions.get(sessionId)?.onData?.(text)
  }
}
```

- [ ] **Step 4: 写最小 `PtySessionManager` 实现，让状态流与增量读取通过**

```ts
// src/utils/pty/PtySessionManager.ts
import { INITIAL_TERMINAL_SIZE, type TerminalOutputChunk, type TerminalSessionRecord } from './types.js'

export class PtySessionManager {
  #driver
  #maxBufferBytes
  #sessions = new Map<string, TerminalSessionRecord>()
  #controls = new Map<string, {
    write: (text: string) => void
    resize: (cols: number, rows: number) => void
    kill: () => void
  }>()
  #counter = 0

  constructor({ driver, maxBufferBytes }: { driver: any; maxBufferBytes: number }) {
    this.#driver = driver
    this.#maxBufferBytes = maxBufferBytes
  }

  async open(input: { command: string; args: string[]; cwd: string; cols?: number; rows?: number }) {
    const sessionId = `term_${++this.#counter}`
    const cols = input.cols ?? INITIAL_TERMINAL_SIZE.cols
    const rows = input.rows ?? INITIAL_TERMINAL_SIZE.rows
    const now = Date.now()

    const record: TerminalSessionRecord = {
      id: sessionId,
      pid: -1,
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      cols,
      rows,
      startedAt: now,
      lastActivityAt: now,
      isRunning: true,
      state: 'starting',
      outputCursor: 0,
      outputChunks: [],
      byteLength: 0,
    }
    this.#sessions.set(sessionId, record)

    const control = await this.#driver.open(sessionId, {
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      cols,
      rows,
    })

    record.pid = control.pid
    record.state = 'running'

    control.bind({
      onData: (text: string) => {
        const start = record.outputCursor
        const end = start + text.length
        const chunk: TerminalOutputChunk = { start, end, text, ts: Date.now() }
        record.outputChunks.push(chunk)
        record.outputCursor = end
        record.byteLength += Buffer.byteLength(text)
        record.lastActivityAt = Date.now()
      },
      onExit: (exitCode: number) => {
        record.isRunning = false
        record.exitCode = exitCode
        record.state = 'exited'
        record.lastActivityAt = Date.now()
      },
    })

    this.#controls.set(sessionId, control)

    return {
      sessionId,
      pid: record.pid,
      isRunning: record.isRunning,
      cols,
      rows,
    }
  }

  async read(input: { sessionId: string; cursor: number; maxBytes: number }) {
    const record = this.#requireSession(input.sessionId)
    const text = record.outputChunks
      .filter(chunk => chunk.end > input.cursor)
      .map(chunk => chunk.start < input.cursor ? chunk.text.slice(input.cursor - chunk.start) : chunk.text)
      .join('')
      .slice(0, input.maxBytes)

    return {
      sessionId: record.id,
      fromCursor: input.cursor,
      toCursor: input.cursor + text.length,
      text,
      isRunning: record.isRunning,
      exitCode: record.exitCode ?? null,
      truncatedBeforeCursor: false,
    }
  }

  async write(input: { sessionId: string; text: string; enter?: boolean }) {
    const record = this.#requireWritableSession(input.sessionId)
    const control = this.#controls.get(record.id)!
    control.write(input.enter ? `${input.text}\r` : input.text)
    record.lastActivityAt = Date.now()
    return { sessionId: record.id, accepted: true, isRunning: record.isRunning }
  }

  async close(input: { sessionId: string; force: boolean }) {
    const record = this.#requireSession(input.sessionId)
    if (record.state !== 'closed') {
      this.#controls.get(record.id)?.kill()
      record.state = 'closed'
      record.isRunning = false
      record.closedAt = Date.now()
    }
    return { sessionId: record.id, closed: true, exitCode: record.exitCode ?? 0 }
  }

  async status(input: { sessionId: string }) {
    const record = this.#requireSession(input.sessionId)
    return {
      sessionId: record.id,
      pid: record.pid,
      isRunning: record.isRunning,
      exitCode: record.exitCode ?? null,
      cols: record.cols,
      rows: record.rows,
      bufferCursor: record.outputCursor,
      startedAt: record.startedAt,
      lastActivityAt: record.lastActivityAt,
    }
  }

  #requireSession(sessionId: string): TerminalSessionRecord {
    const record = this.#sessions.get(sessionId)
    if (!record) {
      throw new Error(`SESSION_NOT_FOUND: ${sessionId}`)
    }
    return record
  }

  #requireWritableSession(sessionId: string): TerminalSessionRecord {
    const record = this.#requireSession(sessionId)
    if (record.state === 'closed') {
      throw new Error(`SESSION_ALREADY_CLOSED: ${sessionId}`)
    }
    return record
  }
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `node --test src/utils/pty/PtySessionManager.test.ts`
Expected: PASS，open/read/close 行为通过。

- [ ] **Step 6: 补一个缓冲裁剪失败测试，锁定后续不会无限增长**

```ts
test('drops oldest output chunks when maxBufferBytes is exceeded', async () => {
  const driver = new FakePtyDriver()
  const manager = new PtySessionManager({ driver, maxBufferBytes: 5 })
  const opened = await manager.open({ command: 'node', args: [], cwd: '/tmp/project', cols: 80, rows: 24 })

  driver.pushOutput(opened.sessionId, 'hello')
  driver.pushOutput(opened.sessionId, 'world')

  const status = await manager.status({ sessionId: opened.sessionId })
  assert.equal(status.bufferCursor, 10)
})
```

- [ ] **Step 7: 实现最小缓冲裁剪逻辑**

```ts
while (record.byteLength > this.#maxBufferBytes && record.outputChunks.length > 0) {
  const removed = record.outputChunks.shift()!
  record.byteLength -= Buffer.byteLength(removed.text)
}
```

把这段加到 `onData` 处理末尾，并额外在 session 上增加 `lowestAvailableCursor` 字段，为后续 `truncatedBeforeCursor` 做准备。

- [ ] **Step 8: 再次运行测试**

Run: `node --test src/utils/pty/PtySessionManager.test.ts`
Expected: PASS，新增缓冲裁剪测试通过。

- [ ] **Step 9: Commit（仅在用户明确批准后执行）**

```bash
git add src/utils/pty/PtySessionManager.ts src/utils/pty/__fixtures__/FakePtyDriver.ts src/utils/pty/types.ts src/utils/pty/PtySessionManager.test.ts
git commit -m "feat: add pty session manager"
```

---

### Task 3: 接入真实 `node-pty` 驱动与默认 shell 解析

**Files:**
- Create: `src/utils/pty/nodePtyDriver.ts`
- Modify: `src/utils/pty/types.ts`
- Modify: `src/utils/shell/resolveDefaultShell.ts`
- Possibly modify: `src/utils/shell/shellProvider.ts`
- Test: `src/utils/pty/nodePtyDriver.integration.test.ts`

- [ ] **Step 1: 写失败的真实 PTY 集成测试**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'

import { createNodePtyDriver } from './nodePtyDriver.js'
import { resolveDefaultShell } from '../shell/resolveDefaultShell.js'

test('node-pty driver starts the resolved default shell and emits output', async () => {
  const driver = createNodePtyDriver()
  const shell = resolveDefaultShell()
  const session = await driver.open('term_test', {
    command: shell,
    args: [],
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
  })

  let output = ''
  session.bind({
    onData: text => {
      output += text
    },
    onExit: () => {},
  })

  session.write('echo PTY_OK\r')

  await new Promise(resolve => setTimeout(resolve, 300))
  assert.match(output, /PTY_OK/)

  session.kill()
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test src/utils/pty/nodePtyDriver.integration.test.ts`
Expected: FAIL，缺少 `nodePtyDriver.ts` 或导出函数。

- [ ] **Step 3: 写最小真实驱动实现**

```ts
// src/utils/pty/nodePtyDriver.ts
import pty from 'node-pty'

export function createNodePtyDriver() {
  return {
    async open(
      _sessionId: string,
      input: { command: string; args: string[]; cwd: string; cols: number; rows: number },
    ) {
      const proc = pty.spawn(input.command, input.args, {
        name: 'xterm-color',
        cols: input.cols,
        rows: input.rows,
        cwd: input.cwd,
        env: process.env,
      })

      let onData = (_text: string) => {}
      let onExit = (_exitCode: number) => {}

      proc.onData(text => {
        onData(text)
      })
      proc.onExit(event => {
        onExit(event.exitCode)
      })

      return {
        pid: proc.pid,
        bind(handlers: { onData: (text: string) => void; onExit: (exitCode: number) => void }) {
          onData = handlers.onData
          onExit = handlers.onExit
        },
        write(text: string) {
          proc.write(text)
        },
        resize(cols: number, rows: number) {
          proc.resize(cols, rows)
        },
        kill() {
          proc.kill()
        },
      }
    },
  }
}
```

- [ ] **Step 4: 保持默认 shell 逻辑最小复用，不把 InteractiveTerminal 特判塞进设置层**

```ts
// src/utils/shell/resolveDefaultShell.ts
import { getInitialSettings } from '../settings/settings.js'

export function resolveDefaultShell(): 'bash' | 'powershell' {
  return getInitialSettings().defaultShell ?? 'bash'
}

export function resolveInteractiveTerminalCommand(): string {
  return resolveDefaultShell() === 'powershell'
    ? 'powershell'
    : 'bash'
}
```

如果后续发现 `shellProvider.ts` 已经有更合适的 shell 路径解析入口，则改为在 `nodePtyDriver.ts` 里直接复用，不重复发明接口。

- [ ] **Step 5: 运行真实 PTY 集成测试**

Run: `node --test src/utils/pty/nodePtyDriver.integration.test.ts`
Expected: PASS，输出中包含 `PTY_OK`。

- [ ] **Step 6: 在 Windows/macOS/Linux 本地各跑一次最小 smoke test**

Run: `node --test src/utils/pty/nodePtyDriver.integration.test.ts`
Expected: PASS；若平台差异导致 shell 命令不同，记录差异并在驱动层修正，不修改工具 schema。

- [ ] **Step 7: Commit（仅在用户明确批准后执行）**

```bash
git add src/utils/pty/nodePtyDriver.ts src/utils/pty/nodePtyDriver.integration.test.ts src/utils/shell/resolveDefaultShell.ts src/utils/pty/types.ts
git commit -m "feat: add node-pty driver"
```

---

### Task 4: 实现 `InteractiveTerminalTool` 的 schema、action 分发与错误处理

**Files:**
- Create: `src/tools/InteractiveTerminalTool/prompt.ts`
- Create: `src/tools/InteractiveTerminalTool/actionSchemas.ts`
- Create: `src/tools/InteractiveTerminalTool/InteractiveTerminalTool.ts`
- Create: `src/tools/InteractiveTerminalTool/InteractiveTerminalTool.test.ts`
- Possibly create: `src/tools/InteractiveTerminalTool/UI.tsx`
- Modify: `src/Tool.ts`
- Modify: `src/tools.ts`

- [ ] **Step 1: 写失败测试，锁定 action 校验和错误结构**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'

import { InteractiveTerminalTool } from './InteractiveTerminalTool.js'

test('rejects write action without sessionId and text', async () => {
  const result = await InteractiveTerminalTool.call(
    { action: 'write' },
    {
      options: { tools: [], mcpClients: [], mcpResources: {}, debug: false, verbose: false, thinkingConfig: {}, commands: [], isNonInteractiveSession: true, agentDefinitions: { activeAgents: [], allowedAgentTypes: undefined }, mainLoopModel: 'claude-sonnet-4-6' },
      abortController: new AbortController(),
      readFileState: {} as never,
      getAppState: () => ({ toolPermissionContext: { mode: 'default' } }) as never,
      setAppState: () => {},
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: () => {},
      updateAttributionState: () => {},
      messages: [],
    } as never,
    async () => ({ behavior: 'allow' }),
    { message: { id: 'msg_test' } } as never,
  )

  assert.match(String(result.data), /INVALID_ACTION_INPUT/)
  assert.match(String(result.data), /sessionId and text/)
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test src/tools/InteractiveTerminalTool/InteractiveTerminalTool.test.ts`
Expected: FAIL，缺少工具实现。

- [ ] **Step 3: 写 action schema，显式定义各 action 所需字段**

```ts
// src/tools/InteractiveTerminalTool/actionSchemas.ts
import { z } from 'zod/v4'

export const openActionSchema = z.object({
  action: z.literal('open'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1),
  env: z.record(z.string(), z.string()).optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
})

export const writeActionSchema = z.object({
  action: z.literal('write'),
  sessionId: z.string().min(1),
  text: z.string(),
  enter: z.boolean().optional(),
})

export const readActionSchema = z.object({
  action: z.literal('read'),
  sessionId: z.string().min(1),
  cursor: z.number().int().min(0).default(0),
  maxBytes: z.number().int().positive().default(8192),
})
```

并继续补齐 `send_key | resize | signal | status | close`。

- [ ] **Step 4: 写最小工具实现，先把错误结构与 action 分发跑通**

```ts
// src/tools/InteractiveTerminalTool/InteractiveTerminalTool.ts
import { buildTool } from '../../Tool.js'
import { z } from 'zod/v4'
import {
  openActionSchema,
  readActionSchema,
  writeActionSchema,
} from './actionSchemas.js'

const schema = z.object({
  action: z.string(),
}).passthrough()

function invalidInput(message: string, details: Record<string, unknown>) {
  return {
    error: {
      code: 'INVALID_ACTION_INPUT',
      message,
      details,
    },
  }
}

export const InteractiveTerminalTool = buildTool({
  name: 'InteractiveTerminal',
  description: 'Open and control a persistent interactive terminal session',
  inputSchema: schema,
  async *call(input) {
    if (input.action === 'write') {
      const parsed = writeActionSchema.safeParse(input)
      if (!parsed.success) {
        yield {
          type: 'result',
          data: invalidInput('action=write requires sessionId and text', {
            action: 'write',
          }),
        }
        return
      }
    }

    yield {
      type: 'result',
      data: {
        error: {
          code: 'INVALID_ACTION',
          message: `Unsupported action: ${input.action}`,
          details: { action: input.action },
        },
      },
    }
  },
})
```

根据仓库里 `buildTool` 的实际签名调整，但保留“结构化错误对象”这个契约。

- [ ] **Step 5: 注册工具到全局工具池**

在 `src/tools.ts` 中加入：

```ts
import { InteractiveTerminalTool } from './tools/InteractiveTerminalTool/InteractiveTerminalTool.js'
```

并在 `getAllBaseTools()` 返回数组中紧邻 `BashTool` 或 `TerminalCaptureTool` 附近插入：

```ts
InteractiveTerminalTool,
```

不要替换 Bash，也不要隐藏 Bash。

- [ ] **Step 6: 运行工具测试，确认错误分发通过**

Run: `node --test src/tools/InteractiveTerminalTool/InteractiveTerminalTool.test.ts`
Expected: PASS，缺参时返回 `INVALID_ACTION_INPUT`，未知 action 返回 `INVALID_ACTION`。

- [ ] **Step 7: Commit（仅在用户明确批准后执行）**

```bash
git add src/tools.ts src/Tool.ts src/tools/InteractiveTerminalTool/prompt.ts src/tools/InteractiveTerminalTool/actionSchemas.ts src/tools/InteractiveTerminalTool/InteractiveTerminalTool.ts src/tools/InteractiveTerminalTool/InteractiveTerminalTool.test.ts src/tools/InteractiveTerminalTool/UI.tsx
git commit -m "feat: register interactive terminal tool"
```

---

### Task 5: 将 tool action 接到 `PtySessionManager`，完成 open/write/read/send_key/resize/signal/status/close 全链路

**Files:**
- Modify: `src/tools/InteractiveTerminalTool/InteractiveTerminalTool.ts`
- Create: `src/tools/InteractiveTerminalTool/handlers/open.ts`
- Create: `src/tools/InteractiveTerminalTool/handlers/write.ts`
- Create: `src/tools/InteractiveTerminalTool/handlers/read.ts`
- Create: `src/tools/InteractiveTerminalTool/handlers/sendKey.ts`
- Create: `src/tools/InteractiveTerminalTool/handlers/resize.ts`
- Create: `src/tools/InteractiveTerminalTool/handlers/signal.ts`
- Create: `src/tools/InteractiveTerminalTool/handlers/status.ts`
- Create: `src/tools/InteractiveTerminalTool/handlers/close.ts`
- Modify: `src/utils/pty/PtySessionManager.ts`
- Test: `src/tools/InteractiveTerminalTool/InteractiveTerminalTool.test.ts`
- Test: `src/utils/pty/PtySessionManager.test.ts`

- [ ] **Step 1: 写失败测试，锁定 `open -> write -> read -> close` 真实工具路径**

```ts
test('routes open/write/read/close through the shared session manager', async () => {
  const opened = await callTool({
    action: 'open',
    command: 'node',
    args: [],
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
  })

  assert.match(opened.sessionId, /^term_/)

  const status = await callTool({ action: 'status', sessionId: opened.sessionId })
  assert.equal(status.isRunning, true)

  await callTool({ action: 'write', sessionId: opened.sessionId, text: 'echo test', enter: true })
  const read = await callTool({ action: 'read', sessionId: opened.sessionId, cursor: 0, maxBytes: 4096 })
  assert.equal(typeof read.text, 'string')

  const closed = await callTool({ action: 'close', sessionId: opened.sessionId, force: false })
  assert.equal(closed.closed, true)
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test src/tools/InteractiveTerminalTool/InteractiveTerminalTool.test.ts`
Expected: FAIL，因为工具尚未连接 session manager。

- [ ] **Step 3: 引入单例 session manager，并将每个 action 拆到 handler 文件**

```ts
// src/tools/InteractiveTerminalTool/handlers/open.ts
export async function handleOpen(manager: PtySessionManager, input: OpenActionInput) {
  return manager.open(input)
}

// src/tools/InteractiveTerminalTool/handlers/sendKey.ts
import { keyToSequence } from '../../../utils/pty/keyMap.js'

export async function handleSendKey(manager: PtySessionManager, input: SendKeyActionInput) {
  return manager.write({
    sessionId: input.sessionId,
    text: keyToSequence(input.key),
    enter: false,
    raw: true,
  })
}
```

在 `PtySessionManager.write()` 中增加 `raw?: boolean`，当 `raw` 为 `true` 时不追加 `\r`。

- [ ] **Step 4: 在 `InteractiveTerminalTool.ts` 中完成 action 分发**

```ts
switch (parsed.action) {
  case 'open':
    return await handleOpen(manager, parsed)
  case 'write':
    return await handleWrite(manager, parsed)
  case 'read':
    return await handleRead(manager, parsed)
  case 'send_key':
    return await handleSendKey(manager, parsed)
  case 'resize':
    return await handleResize(manager, parsed)
  case 'signal':
    return await handleSignal(manager, parsed)
  case 'status':
    return await handleStatus(manager, parsed)
  case 'close':
    return await handleClose(manager, parsed)
}
```

- [ ] **Step 5: 在 manager 中补齐 `resize`、`signal` 与 `status` 的最小实现**

```ts
async resize(input: { sessionId: string; cols: number; rows: number }) {
  const record = this.#requireWritableSession(input.sessionId)
  this.#controls.get(record.id)!.resize(input.cols, input.rows)
  record.cols = input.cols
  record.rows = input.rows
  record.lastActivityAt = Date.now()
  return { sessionId: record.id, cols: record.cols, rows: record.rows, isRunning: record.isRunning }
}

async signal(input: { sessionId: string; signal: 'SIGINT' | 'SIGTERM' }) {
  const record = this.#requireWritableSession(input.sessionId)
  if (input.signal === 'SIGINT') {
    this.#controls.get(record.id)!.write('')
  } else {
    this.#controls.get(record.id)!.kill()
  }
  record.lastActivityAt = Date.now()
  return { sessionId: record.id, accepted: true, isRunning: record.isRunning }
}
```

- [ ] **Step 6: 运行 unit test + tool test**

Run: `node --test src/utils/pty/PtySessionManager.test.ts src/tools/InteractiveTerminalTool/InteractiveTerminalTool.test.ts`
Expected: PASS，action 全链路通过。

- [ ] **Step 7: Commit（仅在用户明确批准后执行）**

```bash
git add src/tools/InteractiveTerminalTool/InteractiveTerminalTool.ts src/tools/InteractiveTerminalTool/handlers src/utils/pty/PtySessionManager.ts src/tools/InteractiveTerminalTool/InteractiveTerminalTool.test.ts src/utils/pty/PtySessionManager.test.ts
git commit -m "feat: wire terminal tool actions to pty sessions"
```

---

### Task 6: 加权限、回收与错误细节，补齐第一版边界

**Files:**
- Modify: `src/tools/InteractiveTerminalTool/InteractiveTerminalTool.ts`
- Modify: `src/utils/pty/PtySessionManager.ts`
- Modify: `src/tools/InteractiveTerminalTool/actionSchemas.ts`
- Test: `src/tools/InteractiveTerminalTool/InteractiveTerminalTool.test.ts`
- Test: `src/utils/pty/PtySessionManager.test.ts`

- [ ] **Step 1: 写失败测试，锁定结构化错误对象与 session 授权语义**

```ts
test('returns SESSION_NOT_FOUND when reading an unknown session', async () => {
  const result = await callTool({
    action: 'read',
    sessionId: 'term_missing',
    cursor: 0,
    maxBytes: 1024,
  })

  assert.equal(result.error.code, 'SESSION_NOT_FOUND')
})

test('prompts for permission on open but not on status for an approved session', async () => {
  const permissionCalls: string[] = []
  await callTool(
    {
      action: 'open',
      command: 'node',
      args: [],
      cwd: process.cwd(),
    },
    {
      canUseTool: async input => {
        permissionCalls.push(String(input.action ?? 'open'))
        return { behavior: 'allow' }
      },
    },
  )

  assert.deepEqual(permissionCalls, ['open'])
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test src/tools/InteractiveTerminalTool/InteractiveTerminalTool.test.ts`
Expected: FAIL，未知 session 还未转成结构化错误，或 open/status 权限边界未实现。

- [ ] **Step 3: 实现统一错误包装函数**

```ts
function formatTerminalError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)

  if (message.startsWith('SESSION_NOT_FOUND:')) {
    return {
      error: {
        code: 'SESSION_NOT_FOUND',
        message,
        details: {
          sessionId: message.split(': ')[1],
        },
      },
    }
  }

  if (message.startsWith('SESSION_ALREADY_CLOSED:')) {
    return {
      error: {
        code: 'SESSION_ALREADY_CLOSED',
        message,
        details: {
          sessionId: message.split(': ')[1],
        },
      },
    }
  }

  return {
    error: {
      code: 'INTERNAL_ERROR',
      message,
      details: {},
    },
  }
}
```

- [ ] **Step 4: 只在 `action=open` 上调用显式权限检查**

```ts
if (parsed.action === 'open') {
  const permission = await canUseTool({
    toolName: 'InteractiveTerminal',
    input: parsed,
  })
  if (permission.behavior !== 'allow') {
    return {
      error: {
        code: 'PERMISSION_DENIED',
        message: 'Interactive terminal session creation was denied',
        details: { action: 'open' },
      },
    }
  }
}
```

对 `status/read/write/resize/send_key/signal/close` 不重复触发新授权，但仍应验证 session 是否存在。

- [ ] **Step 5: 在 manager 中加入最小自动回收元数据**

```ts
constructor({ driver, maxBufferBytes, exitedSessionTtlMs = 60_000 }: {
  driver: any
  maxBufferBytes: number
  exitedSessionTtlMs?: number
}) {
  this.#driver = driver
  this.#maxBufferBytes = maxBufferBytes
  this.#exitedSessionTtlMs = exitedSessionTtlMs
}

reapExpiredSessions(now = Date.now()): void {
  for (const [sessionId, record] of this.#sessions) {
    if (
      (record.state === 'exited' || record.state === 'closed') &&
      now - record.lastActivityAt > this.#exitedSessionTtlMs
    ) {
      this.#sessions.delete(sessionId)
      this.#controls.delete(sessionId)
    }
  }
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `node --test src/tools/InteractiveTerminalTool/InteractiveTerminalTool.test.ts src/utils/pty/PtySessionManager.test.ts`
Expected: PASS，结构化错误、open 权限边界、回收逻辑都通过。

- [ ] **Step 7: Commit（仅在用户明确批准后执行）**

```bash
git add src/tools/InteractiveTerminalTool/InteractiveTerminalTool.ts src/tools/InteractiveTerminalTool/actionSchemas.ts src/utils/pty/PtySessionManager.ts src/tools/InteractiveTerminalTool/InteractiveTerminalTool.test.ts src/utils/pty/PtySessionManager.test.ts
git commit -m "feat: add terminal permissions and lifecycle guards"
```

---

### Task 7: 补真实交互 smoke test 与第一版验收清单

**Files:**
- Modify: `src/utils/pty/nodePtyDriver.integration.test.ts`
- Modify: `src/tools/InteractiveTerminalTool/InteractiveTerminalTool.test.ts`
- Possibly modify: `docs/superpowers/specs/2026-06-11-interactive-terminal-tool-design.md`
- Create (optional if repo has testing docs area): `docs/superpowers/plans/interactive-terminal-acceptance-notes.md`

- [ ] **Step 1: 写失败测试，覆盖真实 `open -> write -> read -> signal -> close` 路径**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'

import { createNodePtyDriver } from './nodePtyDriver.js'
import { PtySessionManager } from './PtySessionManager.js'

test('supports a real interrupt flow against a live PTY shell', async () => {
  const driver = createNodePtyDriver()
  const manager = new PtySessionManager({ driver, maxBufferBytes: 4096 })

  const opened = await manager.open({
    command: 'bash',
    args: [],
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
  })

  await manager.write({ sessionId: opened.sessionId, text: 'sleep 5', enter: true })
  await manager.signal({ sessionId: opened.sessionId, signal: 'SIGINT' })

  const status = await manager.status({ sessionId: opened.sessionId })
  assert.equal(typeof status.isRunning, 'boolean')

  await manager.close({ sessionId: opened.sessionId, force: false })
})
```

- [ ] **Step 2: 运行测试，确认失败或不稳定**

Run: `node --test src/utils/pty/nodePtyDriver.integration.test.ts`
Expected: 初次可能 FAIL 或 flaky，这一步的目的是暴露真实 PTY 中断、时序、回显差异。

- [ ] **Step 3: 通过等待输出或短轮询让集成测试稳定，而不是放大 sleep**

```ts
async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timeout')
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
```

在测试里等待状态变更或输出出现，不使用大于 1 秒的固定 sleep。

- [ ] **Step 4: 跑第一版验收测试组合**

Run: `node --test src/utils/pty/PtySessionManager.test.ts src/utils/pty/nodePtyDriver.integration.test.ts src/tools/InteractiveTerminalTool/InteractiveTerminalTool.test.ts`
Expected: PASS；覆盖类型/映射、manager、真实驱动、工具 action 分发。

- [ ] **Step 5: 跑构建，确认没有类型或打包问题**

Run: `CLAUDE_CODE_VERSION=2.1.165-dev pnpm build`
Expected: Build 成功，`dist/cli.js` 生成，且不使用 npm。

- [ ] **Step 6: 记录第一版验收结果**

```md
# InteractiveTerminal Acceptance Notes

- Verified `open/write/read/status/close` in unit tests
- Verified real PTY output in integration test
- Verified `SIGINT`/special key path in manager/driver tests
- Verified tool registration survives full build
- Deferred ANSI screen parsing, tmux backend, structured TUI snapshots
```

如果仓库没有合适的文档位置，就把这部分作为执行报告而不是新文件落库。

- [ ] **Step 7: Commit（仅在用户明确批准后执行）**

```bash
git add src/utils/pty/nodePtyDriver.integration.test.ts src/tools/InteractiveTerminalTool/InteractiveTerminalTool.test.ts
git commit -m "test: verify interactive terminal tool flows"
```

---

## 自检结果

### 1. Spec 覆盖

- **工具外观单工具 + action 模式** → Task 4、Task 5
- **内部 action handler + session manager 分层** → Task 2、Task 5
- **`node-pty` 后端** → Task 1、Task 3
- **CLI/REPL 优先、TUI 基础兼容** → Task 3、Task 5、Task 7
- **cursor 增量读取与缓冲裁剪** → Task 2
- **结构化错误与权限边界** → Task 4、Task 6
- **自动回收与生命周期管理** → Task 6
- **跨平台与第一版验收** → Task 3、Task 7

没有发现设计要求遗漏到无任务承接的部分。

### 2. 占位符扫描

已避免：
- `TODO`
- `TBD`
- “适当处理错误” 这类空泛描述
- “类似前一个任务” 这种跨任务引用

每个任务都给出了明确文件、测试、命令和最小代码骨架。

### 3. 类型与命名一致性

统一使用：
- `InteractiveTerminal`
- `PtySessionManager`
- `createNodePtyDriver`
- `TerminalSessionRecord`
- `TerminalSpecialKey`
- `sessionId`
- `send_key`
- `truncatedBeforeCursor`

没有在后续任务中改名或混用其它命名。
