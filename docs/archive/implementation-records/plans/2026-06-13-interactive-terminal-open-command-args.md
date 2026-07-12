# InteractiveTerminal open command/args Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 InteractiveTerminal 的 `open` 动作增加显式 `command` 与 `args` 参数，让调用方可以直接选择启动程序与参数，同时保留未显式指定时的默认 shell 行为。

**Architecture:** 在 `actionSchemas.ts` 为 `open` 新增 `command?: string` 与 `args?: string[]`。`handleOpen()` 负责“显式优先，默认兼容”的命令选择，`PtySessionManager` 继续透传结构化的 `command/args/env`，`nodePtyDriver` 继续负责 PATH 解析、默认参数补充和 `pty.spawn()`。错误处理保持现状：命令无法解析时直接抛错并返回 tool error，不做任何回退。

**Tech Stack:** TypeScript, Zod, node-pty, Node.js test runner, pnpm

---

## File map

### Existing files to modify
- `src/tools/InteractiveTerminalTool/actionSchemas.ts`
  - 为 `open` action schema 和总 action schema 增加 `command` / `args` 字段。
- `src/tools/InteractiveTerminalTool/handlers/open.ts`
  - 实现 `input.command ?? resolveInteractiveTerminalCommand()` 逻辑，并把 `args` 透传到 `manager.open()`。
- `src/tools/InteractiveTerminalTool/handlers/open.test.ts`
  - 增加 default-shell、显式 command、显式 args 的行为测试。
- `src/tools/InteractiveTerminalTool/InteractiveTerminalTool.ts`
  - 修正 `action=open requires command and cwd` 这类过时提示文案，使之与新 schema 一致。
- `src/utils/pty/nodePtyDriver.integration.test.ts`
  - 增加显式 command/args、PATH 解析、命令不存在时失败的集成测试。

### Existing files likely unchanged but used as references
- `src/utils/pty/PtySessionManager.ts`
  - 当前已支持 `command?: string` 与 `args?: string[]`，计划中只验证而不改动。
- `src/utils/pty/nodePtyDriver.ts`
  - 当前已支持 `command` 和 `args`，默认参数逻辑与 PATH 解析应复用现有实现；若测试暴露问题，再做最小改动。
- `src/utils/shell/resolveDefaultShell.ts`
  - 保持默认 shell 解析逻辑，作为 `command` 缺省时的回退路径。

---

### Task 1: 扩展 open schema 接受 command 和 args

**Files:**
- Modify: `src/tools/InteractiveTerminalTool/actionSchemas.ts`
- Test: `src/tools/InteractiveTerminalTool/handlers/open.test.ts`

- [ ] **Step 1: 写一个失败测试，描述 open handler 接受显式 command**

```ts
test('handleOpen returns the explicit command when command is provided', async () => {
  const manager = new PtySessionManager({
    driver: new FakePtyDriver(),
  })

  const opened = await handleOpen(manager, {
    action: 'open',
    command: '/bin/bash',
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
  })

  assert.equal((opened as { command?: string }).command, '/bin/bash')
})
```

- [ ] **Step 2: 跑单测确认当前失败**

Run:
```bash
pnpm test -- --test-name-pattern="handleOpen returns the explicit command when command is provided" src/tools/InteractiveTerminalTool/handlers/open.test.ts
```

Expected:
- FAIL，原因是 `openActionSchema` 目前不接受 `command`
- 或 `handleOpen()` 忽略显式 command，返回默认 shell

- [ ] **Step 3: 修改 schema，为 open 增加 command 和 args**

在 `src/tools/InteractiveTerminalTool/actionSchemas.ts` 中把 `openActionSchema` 和 `actionSchema` 扩成下面这种结构：

```ts
export const openActionSchema = z.object({
  action: z.literal('open'),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
})
```

```ts
export const actionSchema = z.object({
  action: z.enum([
    'open',
    'write',
    'read',
    'send_key',
    'resize',
    'signal',
    'status',
    'close',
  ]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  sessionId: z.string().optional(),
  text: z.string().optional(),
  enter: z.boolean().optional(),
  cursor: z.number().int().min(0).optional(),
  maxBytes: z.number().int().positive().optional(),
  key: z.enum(SPECIAL_KEYS).optional(),
  signal: z.enum(['SIGINT', 'SIGTERM']).optional(),
  force: z.boolean().optional(),
}).passthrough()
```

- [ ] **Step 4: 跑单测确认 schema 改动至少让测试进入下一个失败点或通过**

Run:
```bash
pnpm test -- --test-name-pattern="handleOpen returns the explicit command when command is provided" src/tools/InteractiveTerminalTool/handlers/open.test.ts
```

Expected:
- 若 `handleOpen()` 还没改，应继续 FAIL 在返回值不符
- 若后续实现已补上，则 PASS

- [ ] **Step 5: 提交这一小步**

```bash
git add src/tools/InteractiveTerminalTool/actionSchemas.ts src/tools/InteractiveTerminalTool/handlers/open.test.ts
git commit -m "test: accept command and args for interactive terminal open"
```

### Task 2: 让 handleOpen 优先使用显式 command 并透传 args

**Files:**
- Modify: `src/tools/InteractiveTerminalTool/handlers/open.ts`
- Modify: `src/tools/InteractiveTerminalTool/handlers/open.test.ts`
- Test: `src/tools/InteractiveTerminalTool/handlers/open.test.ts`

- [ ] **Step 1: 写一个失败测试，描述 args 会被透传**

在 `src/tools/InteractiveTerminalTool/handlers/open.test.ts` 中新增一个记录 driver open 入参的 fake driver，或者直接断言 manager 打开的会话状态。建议先用自定义 capture driver：

```ts
class CaptureDriver extends FakePtyDriver {
  lastOpenOptions: Record<string, unknown> | undefined

  override open(options: Record<string, unknown>) {
    this.lastOpenOptions = options
    return super.open(options as never)
  }
}

test('handleOpen forwards explicit args to the PTY manager', async () => {
  const driver = new CaptureDriver()
  const manager = new PtySessionManager({ driver })

  await handleOpen(manager, {
    action: 'open',
    command: 'bash',
    args: ['--noprofile', '--norc'],
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
  })

  assert.deepEqual(driver.lastOpenOptions?.args, ['--noprofile', '--norc'])
  assert.equal(driver.lastOpenOptions?.command, 'bash')
})
```

- [ ] **Step 2: 跑单测确认当前失败**

Run:
```bash
pnpm test -- --test-name-pattern="handleOpen forwards explicit args to the PTY manager" src/tools/InteractiveTerminalTool/handlers/open.test.ts
```

Expected:
- FAIL，因为 `handleOpen()` 当前没有使用 `input.command` / `input.args`

- [ ] **Step 3: 最小改动实现显式优先逻辑**

将 `src/tools/InteractiveTerminalTool/handlers/open.ts` 改成下面这个结构：

```ts
export async function handleOpen(manager: PtySessionManager, input: OpenActionInput) {
  const command = input.command ?? resolveInteractiveTerminalCommand()
  const record = manager.open({
    command,
    args: input.args,
    cwd: input.cwd || process.cwd(),
    env: input.env,
    cols: input.cols,
    rows: input.rows,
  })

  await new Promise(resolve => setTimeout(resolve, 150))
  manager.read(record.sessionId, 0)
  const preview = manager.getRenderedPreview(record.sessionId)

  return {
    sessionId: record.sessionId,
    command,
    isRunning: record.state === 'running',
    cols: record.cols,
    rows: record.rows,
    pid: record.pid ?? null,
    preview,
  }
}
```

- [ ] **Step 4: 补齐默认行为测试并确认全部通过**

确保 `src/tools/InteractiveTerminalTool/handlers/open.test.ts` 至少包含下面三类测试：

```ts
test('handleOpen returns the resolved default shell when command is omitted', async () => {
  const originalShell = process.env.SHELL

  try {
    process.env.SHELL = '/bin/zsh'
    const manager = new PtySessionManager({
      driver: new FakePtyDriver(),
    })

    const opened = await handleOpen(manager, {
      action: 'open',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    })

    assert.equal((opened as { command?: string }).command, '/bin/zsh')
  } finally {
    if (originalShell === undefined) {
      delete process.env.SHELL
    } else {
      process.env.SHELL = originalShell
    }
  }
})
```

```ts
test('handleOpen returns the explicit command when command is provided', async () => {
  const manager = new PtySessionManager({
    driver: new FakePtyDriver(),
  })

  const opened = await handleOpen(manager, {
    action: 'open',
    command: '/bin/bash',
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
  })

  assert.equal((opened as { command?: string }).command, '/bin/bash')
})
```

```ts
test('handleOpen forwards explicit args to the PTY manager', async () => {
  const driver = new CaptureDriver()
  const manager = new PtySessionManager({ driver })

  await handleOpen(manager, {
    action: 'open',
    command: 'bash',
    args: ['--noprofile', '--norc'],
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
  })

  assert.deepEqual(driver.lastOpenOptions?.args, ['--noprofile', '--norc'])
  assert.equal(driver.lastOpenOptions?.command, 'bash')
})
```

Run:
```bash
pnpm test -- src/tools/InteractiveTerminalTool/handlers/open.test.ts
```

Expected:
- PASS

- [ ] **Step 5: 提交这一小步**

```bash
git add src/tools/InteractiveTerminalTool/handlers/open.ts src/tools/InteractiveTerminalTool/handlers/open.test.ts
git commit -m "feat: prefer explicit command for terminal open"
```

### Task 3: 验证 driver 的 PATH 解析、args 透传和失败行为

**Files:**
- Modify: `src/utils/pty/nodePtyDriver.integration.test.ts`
- Test: `src/utils/pty/nodePtyDriver.integration.test.ts`
- Modify only if tests fail unexpectedly: `src/utils/pty/nodePtyDriver.ts`

- [ ] **Step 1: 写一个失败测试，验证显式 args 会被传给真实 bash**

在 `src/utils/pty/nodePtyDriver.integration.test.ts` 中新增：

```ts
test('node-pty driver starts an explicit bash command with explicit args', async () => {
  const driver = createNodePtyDriver()
  const sessionId = 'term_explicit_bash'

  driver.open({
    command: 'bash',
    args: ['--noprofile', '--norc'],
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    sessionId,
  })

  let output = ''
  driver.write(sessionId, 'echo PTY_EXPLICIT_OK\r')

  await waitFor(() => {
    const chunk = driver.write(sessionId, '')
    if (chunk?.text) {
      output += chunk.text
    }
    return /PTY_EXPLICIT_OK/.test(output)
  })

  assert.match(output, /PTY_EXPLICIT_OK/)
  driver.close(sessionId)
})
```

- [ ] **Step 2: 写一个失败测试，验证命令找不到时直接失败**

继续在同文件新增：

```ts
test('node-pty driver throws when the explicit command cannot be resolved', () => {
  const driver = createNodePtyDriver()

  assert.throws(
    () => {
      driver.open({
        command: 'definitely-not-found-bin',
        args: [],
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        sessionId: 'term_missing_bin',
      })
    },
    /Unable to resolve terminal command: definitely-not-found-bin/,
  )
})
```

- [ ] **Step 3: 跑集成测试，确认当前行为与设计一致或找出最小缺口**

Run:
```bash
pnpm test -- src/utils/pty/nodePtyDriver.integration.test.ts
```

Expected:
- 如果 `nodePtyDriver.ts` 已经满足设计，则测试直接 PASS
- 如果显式 args 被默认参数覆盖或错误处理不符，则出现精确失败信息

- [ ] **Step 4: 仅在测试失败时做最小实现修复**

如果需要修改 `src/utils/pty/nodePtyDriver.ts`，目标只限于以下逻辑：

```ts
const command = options.command ?? resolveInteractiveTerminalCommand()
const resolvedCommand = resolveCommandPath(command)
const args = options.args ?? buildShellArgs(command)
```

确认不要引入任何额外 fallback，不要把整条 command line 自动拆词。

- [ ] **Step 5: 重新跑集成测试确认通过**

Run:
```bash
pnpm test -- src/utils/pty/nodePtyDriver.integration.test.ts
```

Expected:
- PASS

- [ ] **Step 6: 提交这一小步**

```bash
git add src/utils/pty/nodePtyDriver.integration.test.ts src/utils/pty/nodePtyDriver.ts
git commit -m "test: cover explicit terminal command resolution"
```

### Task 4: 更新 tool 层提示文案并验证 open action 整体行为

**Files:**
- Modify: `src/tools/InteractiveTerminalTool/InteractiveTerminalTool.ts`
- Test: `src/tools/InteractiveTerminalTool/handlers/open.test.ts`
- Test: `src/utils/pty/nodePtyDriver.integration.test.ts`

- [ ] **Step 1: 修正 open action 的过时报错文案**

在 `src/tools/InteractiveTerminalTool/InteractiveTerminalTool.ts` 中，把这段：

```ts
message: 'action=open requires command and cwd'
```

改成与新接口一致的文案，例如：

```ts
message: 'action=open accepts optional command, args and cwd'
```

或者更保守地写成：

```ts
message: 'action=open requires a valid open payload'
```

要求是不要再误导调用方认为 `command` 必填。

- [ ] **Step 2: 跑与 open 相关的测试集**

Run:
```bash
pnpm test -- src/tools/InteractiveTerminalTool/handlers/open.test.ts src/utils/pty/nodePtyDriver.integration.test.ts src/utils/pty/PtySessionManager.test.ts
```

Expected:
- PASS

- [ ] **Step 3: 跑针对 InteractiveTerminal 的更大测试面，防止回归**

Run:
```bash
pnpm test -- src/tools/InteractiveTerminalTool/InteractiveTerminalTool.test.ts src/tools/InteractiveTerminalTool/UI.test.ts src/tools/InteractiveTerminalTool/taskState.test.ts
```

Expected:
- PASS

- [ ] **Step 4: 跑构建验证类型与打包**

Run:
```bash
CLAUDE_CODE_VERSION=2.1.165-dev pnpm build
```

Expected:
- BUILD SUCCESS
- 无新的 TypeScript 错误

- [ ] **Step 5: 提交最终实现**

```bash
git add src/tools/InteractiveTerminalTool/actionSchemas.ts src/tools/InteractiveTerminalTool/handlers/open.ts src/tools/InteractiveTerminalTool/handlers/open.test.ts src/tools/InteractiveTerminalTool/InteractiveTerminalTool.ts src/utils/pty/nodePtyDriver.integration.test.ts src/utils/pty/nodePtyDriver.ts
git commit -m "feat: add explicit command args for terminal open"
```

### Task 5: 手工验证真实行为

**Files:**
- Modify: none
- Test: tool behavior via Claude Code InteractiveTerminal

- [ ] **Step 1: 启动一个显式 bash 会话**

Use tool input:
```json
{
  "action": "open",
  "command": "bash",
  "args": ["--noprofile", "--norc"],
  "cwd": "/Users/esonhugh/workspace/projects/WebStormProjects/cc/claude-code",
  "cols": 120,
  "rows": 30
}
```

Expected:
- 返回 `command: "bash"`
- session 创建成功
- preview 中不再依赖 zsh 默认 prompt 才能判定成功

- [ ] **Step 2: 在显式 bash 会话中验证命令执行**

Write:
```json
{
  "action": "write",
  "sessionId": "<session-id>",
  "text": "echo EXPLICIT_BASH_OK",
  "enter": true
}
```

Read:
```json
{
  "action": "read",
  "sessionId": "<session-id>",
  "maxBytes": 4000
}
```

Expected:
- 输出包含 `EXPLICIT_BASH_OK`

- [ ] **Step 3: 验证 env.SHELL 不再伪装成命令选择入口**

Use tool input:
```json
{
  "action": "open",
  "env": {
    "SHELL": "/bin/bash"
  },
  "cwd": "/Users/esonhugh/workspace/projects/WebStormProjects/cc/claude-code"
}
```

Expected:
- 若未显式传 `command`，返回值仍取决于默认 shell 解析，而不是 `input.env.SHELL`

- [ ] **Step 4: 验证命令不存在时直接报错**

Use tool input:
```json
{
  "action": "open",
  "command": "definitely-not-found-bin",
  "cwd": "/Users/esonhugh/workspace/projects/WebStormProjects/cc/claude-code"
}
```

Expected:
- 返回错误
- 信息包含 `Unable to resolve terminal command: definitely-not-found-bin`
- 不回退到 zsh / bash / powershell

---

## Spec coverage check

- `open` 增加 `command?: string` 与 `args?: string[]` → Task 1, Task 2
- 显式 `command` 优先于默认 shell → Task 2, Task 5
- `args` 原样透传 → Task 2, Task 3, Task 5
- PATH 解析程序名、支持绝对路径 → Task 3
- `command` 解析失败直接报错、不回退 → Task 3, Task 5
- `env.SHELL` 仍不参与命令选择 → Task 5
- 保留 command 缺省时的默认 shell 行为 → Task 2, Task 5

## Placeholder scan

已检查：
- 无 `TODO` / `TBD`
- 每个测试步骤都给了具体代码或命令
- 每个验证步骤都给了预期结果
- 没有“类似 Task N”这种跨任务省略写法

## Type consistency check

已检查：
- `command?: string` 与 `args?: string[]` 在 schema、handler、driver、manual verification 中命名一致
- `input.command ?? resolveInteractiveTerminalCommand()` 与 spec 中一致
- `options.args ?? buildShellArgs(command)` 与 driver 计划中的默认参数策略一致
